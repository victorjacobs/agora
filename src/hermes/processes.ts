export interface ChatProcess {
  id: string
  command: string
  status: 'running' | 'exited' | 'unknown'
  output: string
  uptime: number
  exitCode?: number
  reason?: string
}

export const processOutputLimit = 4000

export function reconcileProcesses(previous: ChatProcess[], rows: unknown[], preserveOutput = new Set<string>()): ChatProcess[] {
  const processes = new Map<string, ChatProcess>(previous.map(process => [process.id, { ...process, status: process.status === 'running' ? 'unknown' : process.status }]))
  for (const value of rows) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    if (typeof row.session_id !== 'string' || !row.session_id || row.status !== 'running' && row.status !== 'exited') continue
    const old = processes.get(row.session_id)
    if (old?.status === 'exited' && row.status === 'running') continue
    processes.set(row.session_id, {
      ...old,
      id: row.session_id,
      command: typeof row.command === 'string' ? row.command : old?.command || row.session_id,
      status: row.status as 'running' | 'exited',
      output: (preserveOutput.has(row.session_id) ? old?.output || '' : typeof row.output_tail === 'string' ? row.output_tail : typeof row.output_preview === 'string' ? row.output_preview : old?.output || '').slice(-processOutputLimit),
      uptime: typeof row.uptime_seconds === 'number' && Number.isFinite(row.uptime_seconds) ? Math.max(0, row.uptime_seconds) : old?.uptime || 0,
      ...(typeof row.exit_code === 'number' && Number.isFinite(row.exit_code) ? { exitCode: row.exit_code } : {}),
      ...(typeof row.completion_reason === 'string' ? { reason: row.completion_reason } : {}),
    })
  }
  return [...processes.values()]
}
