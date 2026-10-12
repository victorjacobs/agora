import { describe, expect, it } from 'vitest'
import { anchorFinishedTasks, reconcileTasks, taskCoveredByNotice, taskEvent, taskRunning } from '../src/hermes/tasks'

describe('delegated background tasks', () => {
  it.each([
    ['context', 'Context you provided: quoted notice\n--- RESULT ---\nUnique result\nRole: leaf   Model: ?\n--- RESULT ---\nActual result omitted'],
    ['goal', 'Original goal: quoted notice\n--- RESULT ---\nUnique result\nRole: leaf   Model: ?\n--- RESULT ---\nActual result omitted'],
    ['output', 'Role: leaf   Model: ?\n--- RESULT ---\nActual result with quoted notice\n--- RESULT ---\nUnique result'],
    ['adjacent delimiters', '--- RESULT ---\n--- RESULT ---\nUnique result'],
    ['malformed extra delimiter', '--- RESULT ---\nUnique result\n---  RESULT ----'],
    ['missing delimiter', 'Unique result'],
    ['malformed only delimiter', '--- RESULT ----\nUnique result'],
    ['delimiter at EOF', 'Unique result\n--- RESULT ---'],
  ])('retains single-task evidence with %s', (_case, body) => {
    const notice = { kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1 }, text: `[ASYNC DELEGATION COMPLETE — batch]\n${body}` }
    for (const summary of ['Unique result', undefined]) {
      expect(taskCoveredByNotice({ key: 'child', delegationId: 'batch', goal: 'Check', status: 'completed', summary }, notice)).toBe(false)
    }
  })
  it.each([
    ['context header', 'Context you provided: quoted notice\n--- ✓ TASK 2/2: Second  (status=completed) ---\nUnique result\nRole: leaf   Model: ?\n\n--- ✓ TASK 1/2: First  (status=completed) ---\nActual first result', 1],
    ['output header', '\n--- ✓ TASK 1/2: First  (status=completed) ---\nQuoted output\n--- ✓ TASK 2/2: Second  (status=completed) ---\nUnique result', 1],
    ['fake goal header', '\n--- ✓ TASK 1/2: Goal containing\n--- ✓ TASK 2/2: Second  (status=completed) ---\nUnique result  (status=completed) ---\nActual first result', 1],
    ['apparently complete header sequence', '\n--- ✓ TASK 1/2: First  (status=completed) ---\nFirst result\n\n--- ✓ TASK 2/2: Second  (status=completed) ---\nUnique result', 2],
    ['duplicate header', '\n--- ✓ TASK 2/2: Second  (status=completed) ---\nUnique result\n\n--- ✓ TASK 2/2: Second  (status=completed) ---\nOther result', 2],
    ['wrong denominator', '\n--- ✓ TASK 2/4: Second  (status=completed) ---\nUnique result', 2],
    ['malformed extra marker', '\n--- ✓ TASK 2/2: Second  (status=completed) ---\nUnique result\n--- ✓ TASK garbage', 1],
    ['multiline goal', '\n--- ✓ TASK 2/2: Second\ncontinued goal  (status=completed) ---\nUnique result', 1],
    ['recovery tail', 'Last persisted unit status: unknown\n--- last lines of task 0 transcript ---\n--- ✓ TASK 2/2: Second  (status=completed) ---\nUnique result\n--- end ---', 1],
  ])('retains batch child evidence with %s', (_case, body, task_count) => {
    const notice = { kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count }, text: `[ASYNC DELEGATION BATCH COMPLETE — batch]\n${body}` }
    for (const summary of ['Unique result', undefined]) {
      expect(taskCoveredByNotice({ key: 'child', delegationKey: 'batch:1', goal: 'Second', status: 'completed', summary }, notice)).toBe(false)
    }
  })
  it('deduplicates a single result only with one exact formatter delimiter and a matching result body', () => {
    const task = { key: 'child', delegationId: 'batch', goal: 'Check', status: 'completed', summary: 'Unique result' }
    const notice = { kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1 }, text: '[ASYNC DELEGATION COMPLETE — batch]\nOriginal goal: Check\nRole: leaf   Model: ?\nStatus: completed   API calls: 1   Duration: 1s\n--- RESULT ---\nUnique result' }
    expect(taskCoveredByNotice(task, notice)).toBe(true)
    expect(taskCoveredByNotice({ ...task, summary: undefined }, notice)).toBe(true)
    expect(taskCoveredByNotice({ ...task, summary: 'Unsaved result' }, notice)).toBe(false)
    expect(taskCoveredByNotice(task, { ...notice, metadata: { delegation_id: 'other' } })).toBe(false)
    expect(taskCoveredByNotice(task, { ...notice, text: `Quoted notice\n${notice.text}` })).toBe(false)
  })
  it('rejects an additional malformed result delimiter in single-task output', () => {
    const text = '[ASYNC DELEGATION COMPLETE — batch]\n--- RESULT ---\nClient-only result\n--- RESULT ----\nQuoted malformed delimiter'
    const task = { key: 'child', delegationId: 'batch', goal: 'Check', status: 'completed', summary: 'Client-only result' }
    expect(taskCoveredByNotice(task, { kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1 }, text })).toBe(false)
  })
  it('uses the final batch envelope for placement without claiming child coverage', () => {
    const notice = { key: 'final', role: 'user', kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 2 }, text: '[ASYNC DELEGATION BATCH COMPLETE — batch]\nContext you provided: quoted headers only' }
    const task = { key: 'second', delegationKey: 'batch:1', goal: 'Second', status: 'completed', summary: 'Client-only result' }
    const anchored = anchorFinishedTasks([task], [notice, { key: 'tail', role: 'assistant', text: 'Unrelated reply' }])
    expect(anchored[0]?.completedAfter?.key).toBe('final')
    expect(taskCoveredByNotice(task, notice)).toBe(false)
    expect(anchorFinishedTasks(anchored, [])[0]?.completedAfter?.key).toBe('final')
  })
  it('rejects a quoted result delimiter in single-task context when the actual result omits the summary', () => {
    const text = '[ASYNC DELEGATION COMPLETE — batch]\nContext you provided: Quoted notice\n--- RESULT ---\nClient-only result\nRole: leaf   Model: ?\nStatus: unknown\n--- RESULT ---\nThe subagent did not complete successfully (status=unknown).'
    const task = { key: 'child', delegationKey: 'batch:0', goal: 'Check', status: 'completed', summary: 'Client-only result' }
    expect(taskCoveredByNotice(task, { kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1 }, text })).toBe(false)
  })
  it('retains a child when another child quotes its task header in output', () => {
    const text = '[ASYNC DELEGATION BATCH COMPLETE — batch]\nConsolidated results\n\n--- ✓ TASK 1/2: First  (status=completed) ---\nQuoted output:\n--- ✓ TASK 2/2: Second  (status=completed) ---\nClient-only second result'
    const task = { key: 'second', delegationKey: 'batch:1', goal: 'Second', status: 'completed', summary: 'Client-only second result' }
    expect(taskCoveredByNotice(task, { kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1 }, text })).toBe(false)
  })
  it.each([
    '[ASYNC DELEGATION COMPLETE — batch]\nContext you provided: Unique result\n--- RESULT ---\n(no summary — status=unknown)',
    '[ASYNC DELEGATION BATCH COMPLETE — batch]\nConsolidated results\n\n--- ✓ TASK 1/1: Unique result  (status=completed) ---\n(no summary — status=completed)',
  ])('does not confuse a saved goal or context with a client-only result', text => {
    const task = { key: 'child', delegationKey: 'batch:0', goal: 'Unique result', status: 'completed', summary: 'Unique result' }
    expect(taskCoveredByNotice(task, { kind: 'async_delegation_complete', metadata: { delegation_id: 'batch' }, text })).toBe(false)
  })
  it('anchors matching terminal children at the final unit without discarding unmatched live results', () => {
    const observed = { key: 'observed', role: 'assistant', text: 'Live observation' }
    const final = { key: 'final', role: 'user', kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 2, completed_count: 1, failed_count: 1 }, text: '[ASYNC DELEGATION BATCH COMPLETE — batch]\nConsolidated results\n\n--- ✗ TASK 1/4: Failed  (status=failed) ---\nError\n\n--- ✓ TASK 2/4: Success  (status=completed) ---\nUnique result' }
    const tasks = [
      { key: 'success', delegationKey: 'batch:1', goal: 'Success', status: 'completed', summary: 'Unique result', completedAfter: observed },
      { key: 'missing', delegationKey: 'batch:2', goal: 'Missing', status: 'unknown', completedAfter: observed },
      { key: 'unindexed', delegationId: 'batch', goal: 'Unindexed', status: 'completed', completedAfter: observed },
      { key: 'unique', delegationKey: 'batch:1', goal: 'Unique', status: 'completed', summary: 'Result absent from saved body', completedAfter: observed },
    ]
    for (const anchored of [anchorFinishedTasks(tasks, [final, observed]), anchorFinishedTasks(tasks.map(task => ({ ...task, completedAfter: undefined })), [final, observed])]) {
      expect(anchored.map(task => task.completedAfter?.key)).toEqual(['final', 'final', 'final', 'final'])
      expect(anchored.map(task => task.summary)).toEqual(tasks.map(task => task.summary))
      expect(anchored.every(task => !taskCoveredByNotice(task, final))).toBe(true)
    }
  })

  it('clears a cached warning anchor without treating a cold roster as a live observation', () => {
    const warning = { key: 'warning', role: 'system', text: '[ASYNC DELEGATION TASK FAILED — batch, task 1/4]\nEarly warning', kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1, failed_count: 1 } }
    const task = { key: 'child', delegationKey: 'batch:1', goal: 'Success', status: 'completed', completedAfter: warning }
    expect(anchorFinishedTasks([task], [warning, { key: 'tail', role: 'assistant', text: 'Unrelated tail' }])[0]?.completedAfter).toBeNull()
  })
  it('does not move successful or unknown siblings to an early warning with the same batch ID', () => {
    const observed = { key: 'observed', role: 'assistant', text: 'Observed success' }
    const warning = { key: 'warning', role: 'user', text: '[ASYNC DELEGATION TASK FAILED — batch, task 1/4]\nOne subagent failed while its siblings are still running.', kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1, completed_count: 0, failed_count: 1 } }
    const tasks = [
      { key: 'success', delegationId: 'batch', delegationKey: 'batch:1', goal: 'Success', status: 'completed', summary: 'Unique success result', completedAfter: observed },
      { key: 'missing', delegationId: 'batch', delegationKey: 'batch:2', goal: 'Missing', status: 'unknown' },
      { key: 'working', delegationId: 'batch', goal: 'Working', status: 'running' },
    ]
    const anchored = anchorFinishedTasks(tasks, [observed, warning])
    expect(anchored[0]?.completedAfter?.key).toBe('observed')
    expect(anchored[1]?.completedAfter).toBeNull()
    expect(anchored[2]?.completedAfter).toBeUndefined()
    expect(anchored[0]?.summary).toBe('Unique success result')
  })
  it('repairs terminal roster and cached placements using each matching historical completion', () => {
    const notices = ['a', 'b'].map(id => ({ key: `notice-${id}`, role: 'system', text: `[ASYNC DELEGATION COMPLETE — ${id}]\nResults ${id}`, kind: 'async_delegation_complete', metadata: { delegation_id: id } }))
    const latest = { key: 'latest', role: 'assistant', text: 'Unrelated latest reply' }
    const recovered = reconcileTasks([], { subagents: [
      { subagent_id: 'child-a', delegation_id: 'a', status: 'completed' },
      { subagent_id: 'child-b', delegation_id: 'b', status: 'failed' },
    ] })
    for (const tasks of [recovered, recovered.map(task => ({ ...task, completedAfter: latest }))]) {
      expect(anchorFinishedTasks(tasks, [notices[0]!, { key: 'middle', role: 'assistant', text: 'Interspersed reply' }, notices[1]!, latest]).map(task => task.completedAfter?.key)).toEqual(['notice-a', 'notice-b'])
    }
  })

  it('does not invent a child index when a legacy event supplies only the delegation ID', () => {
    const tasks = taskEvent([], { type: 'subagent.complete', payload: { subagent_id: 'legacy', delegation_id: 'batch' } })
    expect(tasks[0]?.delegationId).toBe('batch')
    expect(tasks[0]?.delegationKey).toBeUndefined()
  })

  it('leaves cold terminal roster entries before history unless a completion was observed live', () => {
    const messages = [{ key: 'latest', role: 'assistant', text: 'Unrelated reply' }]
    const cold = reconcileTasks([], { subagents: [{ subagent_id: 'old', status: 'completed' }] })
    expect(anchorFinishedTasks(cold, messages)[0]?.completedAfter).toBeNull()
    const observed = anchorFinishedTasks(taskEvent([], { type: 'subagent.complete', payload: { subagent_id: 'live' } }), messages, true)
    expect(observed[0]?.completedAfter?.key).toBe('latest')
    expect(anchorFinishedTasks(observed, [...messages, { key: 'later', role: 'user', text: 'Later question' }])[0]?.completedAfter?.key).toBe('latest')
  })

  it('anchors a finished task once, including when its completion is first found in the roster', () => {
    const messages = [{ key: 'reply', role: 'assistant', text: 'Reply' }]
    const running = taskEvent([], { type: 'subagent.start', payload: { subagent_id: 'child' } })
    expect(anchorFinishedTasks(running, messages)[0]?.completedAfter).toBeUndefined()
    const finished = anchorFinishedTasks(reconcileTasks(running, { subagents: [{ subagent_id: 'child', status: 'completed' }] }), messages, true)
    expect(finished[0]?.completedAfter?.key).toBe('reply')
    messages.push({ key: 'question', role: 'user', text: 'Another question' })
    expect(anchorFinishedTasks(finished, messages)[0]?.completedAfter?.key).toBe('reply')
  })
  it('places a roster-recovered missing child at its stored delegation notice without inferring its outcome', () => {
    const live = reconcileTasks([], { subagents: [{ subagent_id: 'child', delegation_id: 'batch', goal: 'Check logs' }] })
    const messages = [
      { key: 'notice', role: 'system', text: '[ASYNC DELEGATION COMPLETE — batch]\nDelegation failed after restart', kind: 'async_delegation_complete', metadata: { delegation_id: 'batch', task_count: 1, failed_count: 1 } },
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
      const missing = anchorFinishedTasks(reconcileTasks(recovered, { subagents: [] }), [{ key: 'new', role: 'assistant', text: 'New reply' }])
      expect(missing[0]?.completedAfter).toBeNull()
      const finished = anchorFinishedTasks(taskEvent(recovered, { type: 'subagent.complete', payload: { subagent_id: 'child' } }), [{ key: 'new', role: 'assistant', text: 'New reply' }], true)
      expect(finished[0]?.completedAfter?.key).toBe('new')
    }
  })
  it.each([null, { key: 'notice', role: 'system', text: 'Historical notice', kind: 'async_delegation_complete', metadata: { delegation_id: 'batch' } }])('anchors an authoritative completion of an unknown child at its new observation', completedAfter => {
    const orphan = [{ key: 'child', goal: 'Check logs', status: 'unknown', completedAfter }]
    const event = taskEvent(orphan, { type: 'subagent.complete', payload: { subagent_id: 'child', status: 'failed' } })
    const roster = reconcileTasks(orphan, { subagents: [{ subagent_id: 'child', status: 'completed' }] })
    for (const completed of [event, roster]) {
      expect(anchorFinishedTasks(completed, [{ key: 'new', role: 'assistant', text: 'Current reply' }], true)[0]?.completedAfter?.key).toBe('new')
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

  it('preserves durable failed-delegation identity even without a cached child', () => {
    const failed = reconcileTasks([], { subagents: [], delegations: [{ delegation_id: 'failed-batch', task_index: 1, status: 'failed', error: 'No logs found' }] })
    expect(failed[0]).toMatchObject({ delegationId: 'failed-batch', delegationKey: 'failed-batch:1', status: 'failed', summary: 'No logs found' })
    expect(anchorFinishedTasks(failed, [{ key: 'notice', role: 'user', text: '[ASYNC DELEGATION BATCH COMPLETE — failed-batch]\nConsolidated results\n\n--- ✗ TASK 2/2: Check logs  (status=failed) ---\nNo logs found', kind: 'async_delegation_complete', metadata: { delegation_id: 'failed-batch' } }])[0]?.completedAfter?.key).toBe('notice')
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
