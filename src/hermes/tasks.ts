import type { GatewayEvent, Message } from './types'

export interface BackgroundTask {
  key: string
  goal: string
  status: string
  model?: string
  delegationKey?: string
  delegationId?: string
  parentId?: string
  toolCount?: number
  tool?: string
  summary?: string
  completedAfter?: Pick<Message, 'key' | 'rowId' | 'role' | 'text' | 'kind' | 'metadata'> | null
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

export function taskMatchesNotice(task: BackgroundTask, message: Pick<Message, 'kind' | 'metadata'>): boolean {
  const id = message.metadata?.delegation_id
  return message.kind === 'async_delegation_complete' && typeof id === 'string' && id.length > 0
    && (task.delegationId === id || Boolean(task.delegationKey?.startsWith(`${id}:`)))
}

export function taskCoveredByNotice(task: BackgroundTask, message: Pick<Message, 'kind' | 'metadata' | 'text'>): boolean {
  if (!taskMatchesNotice(task, message)) return false
  const id = message.metadata!.delegation_id as string
  // The single formatter always emits one RESULT delimiter. Verbatim source/output
  // can add more; only a unique delimiter can identify the actual result boundary.
  if (message.text.startsWith(`[ASYNC DELEGATION COMPLETE — ${id}]\n`)) {
    const resultMarker = '\n--- RESULT ---\n'
    const resultStart = message.text.indexOf(resultMarker)
    return resultStart >= 0 && [...message.text.matchAll(/---[ \t]*RESULT\b/g)].length === 1
      && (!task.summary || message.text.slice(resultStart + resultMarker.length).includes(task.summary))
  }
  // Batch goals, context, summaries and recovery tails are verbatim and unescaped.
  // Even matching section counts cannot authenticate a child boundary.
  return false
}

function taskMatchesFinalNotice(task: BackgroundTask, message: Pick<Message, 'kind' | 'metadata' | 'text'>): boolean {
  if (!taskMatchesNotice(task, message)) return false
  const id = message.metadata!.delegation_id as string
  // The formatter owns the first line; verbatim child evidence comes after it.
  return message.text.startsWith(`[ASYNC DELEGATION COMPLETE — ${id}]\n`)
    || message.text.startsWith(`[ASYNC DELEGATION BATCH COMPLETE — ${id}]\n`)
}

export function anchorFinishedTasks(tasks: BackgroundTask[], messages: Message[], observed = false): BackgroundTask[] {
  return tasks.map(task => {
    if (taskRunning(task)) return task
    const notice = messages.findLast(message => taskMatchesFinalNotice(task, message))
    const cached = task.completedAfter
    if (!notice && cached !== undefined && (!cached || cached.kind !== 'async_delegation_complete' || taskMatchesFinalNotice(task, cached))) return task
    const message = observed && task.status !== 'unknown'
      ? messages.findLast(message => message.text.trim() && message.kind !== 'async_delegation_complete') : undefined
    const anchor = notice || message
    return {
      ...task,
      completedAfter: anchor ? { key: anchor.key, rowId: anchor.rowId, role: anchor.role, text: anchor.text, kind: anchor.kind, metadata: anchor.metadata } : null,
    }
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
  if (typeof p.delegation_id === 'string') {
    task.delegationId = p.delegation_id
    if (typeof p.task_index === 'number' && Number.isSafeInteger(p.task_index) && p.task_index >= 0) {
      task.delegationKey = `${p.delegation_id}:${p.task_index}`
    } else if (existing?.delegationId !== p.delegation_id) task.delegationKey = undefined
  }
  if (typeof p.model === 'string') task.model = p.model
  if (typeof p.parent_id === 'string') task.parentId = p.parent_id
  if (typeof p.tool_count === 'number') task.toolCount = p.tool_count
  if (typeof p.tool_name === 'string' && event.type !== 'subagent.complete') task.tool = p.tool_name
  if (complete && typeof p.summary === 'string') task.summary = p.summary
  else if (complete && typeof p.text === 'string') task.summary = p.text
  if (taskRunning(task) || existing?.status === 'unknown' && task.status !== 'unknown') task.completedAfter = undefined
  return existing ? tasks.map(row => row.key === key ? task : row) : [...tasks, task]
}

export function reconcileTasks(tasks: BackgroundTask[], roster: SubagentRoster): BackgroundTask[] {
  const live = roster.subagents.map(row => {
    const existing = tasks.find(task => task.key === row.subagent_id)
    const task: BackgroundTask = {
      ...existing,
      key: row.subagent_id, goal: row.goal || 'Background task', status: row.status || 'running',
      delegationId: row.delegation_id || existing?.delegationId,
      model: row.model, parentId: row.parent_id, toolCount: typeof row.tool_count === 'number' ? row.tool_count : undefined, tool: row.last_tool,
    }
    if (taskRunning(task) || existing?.status === 'unknown' && task.status !== 'unknown') task.completedAfter = undefined
    return task
  })
  const retained = tasks.filter(task => !live.some(row => row.key === task.key)).map(task =>
    taskRunning(task) ? { ...task, status: 'unknown' } : task)
  const failed = (roster.delegations || []).map(row => {
    const delegationKey = `${row.delegation_id}:${row.task_index}`
    const existing = tasks.find(task => task.key === delegationKey || task.delegationKey === delegationKey)
    return {
      ...existing,
      key: existing?.key || delegationKey, goal: row.goal || 'Background task',
      delegationId: row.delegation_id, delegationKey,
      status: row.status, summary: row.error,
      completedAfter: existing && (taskRunning(existing) || existing.status === 'unknown') ? undefined : existing?.completedAfter,
    }
  })
  return [...retained.filter(task => !failed.some(row => row.key === task.key)), ...live.filter(task => !failed.some(row => row.key === task.key)), ...failed]
}
