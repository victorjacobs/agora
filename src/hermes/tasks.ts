import type { GatewayEvent, Message } from './types'

export interface BackgroundTask {
  key: string
  goal: string
  status: string
  model?: string
  delegationKey?: string
  parentId?: string
  toolCount?: number
  tool?: string
  summary?: string
  completedAfter?: Pick<Message, 'key' | 'rowId' | 'role' | 'text'> | null
}

export interface SubagentRoster {
  subagents: Array<{
    subagent_id: string; goal?: string; status?: string; model?: string
    parent_id?: string; delegation_id?: string; tool_count?: number; last_tool?: string
  }>
  delegations?: Array<{ delegation_id: string; task_index: number; goal?: string; status: string; error?: string }>
}

export function taskRunning(task: BackgroundTask) {
  return ['running', 'queued', 'working', 'starting'].includes(task.status)
}

export function anchorFinishedTasks(tasks: BackgroundTask[], messages: Message[]): BackgroundTask[] {
  const message = messages.findLast(message => message.text.trim())
  return tasks.map(task => taskRunning(task) || task.completedAfter !== undefined ? task : {
    ...task,
    completedAfter: message ? { key: message.key, rowId: message.rowId, role: message.role, text: message.text } : null,
  })
}

export function taskEvent(tasks: BackgroundTask[], event: GatewayEvent): BackgroundTask[] {
  const p = event.payload || {}
  if (event.type === 'background.complete' && typeof p.task_id === 'string') {
    const key = `background:${p.task_id}`
    return [...tasks.filter(task => task.key !== key), {
      ...tasks.find(task => task.key === key),
      key, goal: 'Background task', status: 'completed', summary: typeof p.text === 'string' ? p.text : undefined,
    }]
  }
  if (!event.type.startsWith('subagent.') || event.type === 'subagent.thinking') return tasks
  const key = typeof p.subagent_id === 'string' ? p.subagent_id
    : typeof p.delegation_id === 'string' ? `${p.delegation_id}:${p.task_index ?? 0}`
    : typeof p.goal === 'string' ? `legacy:${p.task_index ?? 0}:${p.goal}` : undefined
  if (!key) return tasks
  const existing = tasks.find(task => task.key === key)
  const complete = event.type === 'subagent.complete'
  // Late progress must not revive a completed child.
  if (existing && !taskRunning(existing) && existing.status !== 'unknown' && !complete) return tasks
  const task: BackgroundTask = {
    ...existing, key, goal: typeof p.goal === 'string' && p.goal ? p.goal : existing?.goal || 'Background task',
    status: complete ? typeof p.status === 'string' ? p.status : 'completed'
      : event.type === 'subagent.spawn_requested' ? 'queued' : 'running',
  }
  if (typeof p.delegation_id === 'string') task.delegationKey = `${p.delegation_id}:${p.task_index ?? 0}`
  if (typeof p.model === 'string') task.model = p.model
  if (typeof p.parent_id === 'string') task.parentId = p.parent_id
  if (typeof p.tool_count === 'number') task.toolCount = p.tool_count
  if (typeof p.tool_name === 'string' && event.type !== 'subagent.complete') task.tool = p.tool_name
  if (complete && typeof p.summary === 'string') task.summary = p.summary
  else if (complete && typeof p.text === 'string') task.summary = p.text
  return existing ? tasks.map(row => row.key === key ? task : row) : [...tasks, task]
}

export function reconcileTasks(tasks: BackgroundTask[], roster: SubagentRoster): BackgroundTask[] {
  const live = roster.subagents.map(row => ({
    ...tasks.find(task => task.key === row.subagent_id),
    key: row.subagent_id, goal: row.goal || 'Background task', status: row.status || 'running',
    model: row.model, parentId: row.parent_id, toolCount: typeof row.tool_count === 'number' ? row.tool_count : undefined, tool: row.last_tool,
  }))
  const retained = tasks.filter(task => !live.some(row => row.key === task.key)).map(task =>
    taskRunning(task) ? { ...task, status: 'unknown' } : task)
  const failed = (roster.delegations || []).map(row => ({
    ...tasks.find(task => task.key === `${row.delegation_id}:${row.task_index}` || task.delegationKey === `${row.delegation_id}:${row.task_index}`),
    key: tasks.find(task => task.delegationKey === `${row.delegation_id}:${row.task_index}`)?.key || `${row.delegation_id}:${row.task_index}`, goal: row.goal || 'Background task',
    status: row.status, summary: row.error,
  }))
  return [...retained.filter(task => !failed.some(row => row.key === task.key)), ...live.filter(task => !failed.some(row => row.key === task.key)), ...failed]
}
