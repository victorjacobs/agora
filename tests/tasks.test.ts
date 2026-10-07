import { describe, expect, it } from 'vitest'
import { anchorFinishedTasks, reconcileTasks, taskEvent, taskRunning } from '../src/hermes/tasks'

describe('delegated background tasks', () => {
  it('anchors a finished task once, including when its completion is first found in the roster', () => {
    const messages = [{ key: 'reply', role: 'assistant', text: 'Reply' }]
    const running = taskEvent([], { type: 'subagent.start', payload: { subagent_id: 'child' } })
    expect(anchorFinishedTasks(running, messages)[0]?.completedAfter).toBeUndefined()
    const finished = anchorFinishedTasks(reconcileTasks(running, { subagents: [{ subagent_id: 'child', status: 'completed' }] }), messages)
    expect(finished[0]?.completedAfter?.key).toBe('reply')
    messages.push({ key: 'question', role: 'user', text: 'Another question' })
    expect(anchorFinishedTasks(finished, messages)[0]?.completedAfter?.key).toBe('reply')
  })
  it('places a roster-recovered missing child at its stored delegation notice without inferring its outcome', () => {
    const live = reconcileTasks([], { subagents: [{ subagent_id: 'child', delegation_id: 'batch', goal: 'Check logs' }] })
    const messages = [
      { key: 'notice', role: 'system', text: 'Delegation failed after restart', kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1, failed_count: 1 } },
      { key: 'later', role: 'user', text: 'Later question' },
    ]
    const missing = anchorFinishedTasks(reconcileTasks(live, { subagents: [] }), messages)
    expect(missing[0]).toMatchObject({ status: 'unknown', completedAfter: { key: 'notice' } })
    expect(missing[0]?.summary).toBeUndefined()
    expect(anchorFinishedTasks(missing, [...messages, { key: 'new', role: 'assistant', text: 'New reply' }])[0]?.completedAfter?.key).toBe('notice')
  })
  it('clears an orphan anchor when authoritative live activity recovers the child', () => {
    const orphan = [{ key: 'child', goal: 'Check logs', status: 'unknown', completedAfter: { key: 'old', role: 'user', text: 'Old question' } }]
    const roster = reconcileTasks(orphan, { subagents: [{ subagent_id: 'child', status: 'running' }] })
    const event = taskEvent(orphan, { type: 'subagent.progress', payload: { subagent_id: 'child' } })
    for (const recovered of [roster, event]) {
      expect(taskRunning(recovered[0]!)).toBe(true)
      expect(recovered[0]?.completedAfter).toBeUndefined()
      const finished = anchorFinishedTasks(reconcileTasks(recovered, { subagents: [] }), [{ key: 'new', role: 'assistant', text: 'New reply' }])
      expect(finished[0]?.completedAfter?.key).toBe('new')
    }
  })
  it('tracks lifecycle without exposing reasoning or reviving finished tasks', () => {
    let tasks = taskEvent([], { type: 'subagent.spawn_requested', payload: { subagent_id: 'child', goal: 'Check the logs' } })
    expect(tasks[0]?.status).toBe('queued')
    tasks = taskEvent(tasks, { type: 'subagent.tool', payload: { subagent_id: 'child', tool_name: 'terminal', tool_count: 2, model: 'model' } })
    expect(tasks[0]).toMatchObject({ goal: 'Check the logs', status: 'running', tool: 'terminal', toolCount: 2 })
    expect(taskEvent(tasks, { type: 'subagent.thinking', payload: { subagent_id: 'child', text: 'private reasoning' } })).toBe(tasks)
    tasks = taskEvent(tasks, { type: 'subagent.complete', payload: { subagent_id: 'child', status: 'failed', summary: 'No logs found' } })
    expect(taskRunning(tasks[0]!)).toBe(false)
    expect(taskEvent(tasks, { type: 'subagent.progress', payload: { subagent_id: 'child' } })).toBe(tasks)
    expect(tasks[0]?.summary).toBe('No logs found')
  })

  it('exposes detached side-agent results without changing the main turn', () => {
    const tasks = taskEvent([], { type: 'background.complete', payload: { task_id: 'side', text: 'Done' } })
    expect(tasks[0]).toMatchObject({ key: 'background:side', status: 'completed', summary: 'Done' })
  })

  it('recovers live children and failures without inventing completion for a missing child', () => {
    const tasks = taskEvent([], { type: 'subagent.start', payload: { subagent_id: 'child', delegation_id: 'batch', task_index: 0, goal: 'Check logs' } })
    expect(reconcileTasks(tasks, { subagents: [] })[0]?.status).toBe('unknown')
    const recovered = reconcileTasks(tasks, {
      subagents: [{ subagent_id: 'other', goal: 'Search', status: 'running', tool_count: 3, last_tool: 'search' }],
      delegations: [{ delegation_id: 'batch', task_index: 0, goal: 'Check logs', status: 'timeout', error: 'Deadline reached' }],
    })
    expect(recovered).toHaveLength(2)
    expect(recovered.find(task => task.key === 'child')).toMatchObject({ status: 'timeout', summary: 'Deadline reached' })
    expect(recovered.find(task => task.key === 'other')).toMatchObject({ status: 'running', toolCount: 3 })
  })
})
