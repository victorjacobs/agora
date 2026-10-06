import { HermesApi } from './api'
import type { SessionRow } from './types'

export interface CronJob {
  id: string; name?: string; profile?: string; prompt?: string; enabled?: boolean; state?: string
  schedule?: string | { kind?: string; display?: string; expr?: string; run_at?: string; minutes?: number }
  schedule_display?: string; next_run_at?: string; last_run_at?: string; last_status?: string; last_error?: string
  deliver?: string; model?: string | null; provider?: string | null; script?: string | null
  no_agent?: boolean; skills?: string[]; workdir?: string | null
}
export interface CronRun extends SessionRow {
  source?: string; started_at?: number; ended_at?: number | null; is_active?: boolean
  scheduler_owned?: boolean; message_count?: number; input_tokens?: number; output_tokens?: number
}
export interface CronDraft {
  name: string; schedule: string; prompt: string; deliver: string; model: string; provider: string
  script: string; no_agent: boolean; skills: string; workdir: string; paused: boolean
}
export function cronDraft(job?: CronJob): CronDraft {
  const schedule = job?.schedule
  const expression = typeof schedule === 'string' ? schedule : schedule?.kind === 'interval' && typeof schedule.minutes === 'number'
    ? `every ${schedule.minutes}m` : schedule?.expr || schedule?.run_at || schedule?.display || job?.schedule_display || ''
  return { name: job?.name || '', schedule: expression, prompt: job?.prompt || '', deliver: job?.deliver || 'local',
    model: job?.model || '', provider: job?.provider || '', script: job?.script || '', no_agent: job?.no_agent || false,
    skills: job?.skills?.join('\n') || '', workdir: job?.workdir || '', paused: false }
}
export function cronPayload(draft: CronDraft, job?: CronJob): Record<string, unknown> {
  const original = cronDraft(job)
  const payload: Record<string, unknown> = {}
  for (const key of ['name', 'schedule', 'prompt', 'deliver', 'model', 'provider', 'script', 'no_agent', 'skills', 'workdir'] as const) {
    if (job && draft[key] === original[key]) continue
    const value = draft[key]
    payload[key] = key === 'skills' ? String(value).split('\n').map(value => value.trim()).filter(Boolean)
      : ['model', 'provider', 'script', 'workdir'].includes(key) ? value || null : value
  }
  if (!job) payload.paused = draft.paused
  return payload
}
export class CronApi {
  constructor(private api = new HermesApi()) {}
  async profile(name?: string): Promise<string> {
    if (name) return name
    const result = await this.api.request<{ current?: string }>('/api/profiles/active')
    if (!result.current || result.current === 'custom') throw new Error('Hermes cannot identify the current profile.')
    return result.current
  }
  private path(profile: string, id?: string, action = '') {
    return `/api/cron/jobs${id ? '/' + encodeURIComponent(id) : ''}${action}?${this.api.query({ profile })}`
  }
  async jobs(profile: string) {
    const jobs = await this.api.request<CronJob[]>(this.path(profile))
    if (!Array.isArray(jobs) || jobs.some(job => !job || typeof job.id !== 'string' || job.id === 'unknown')) throw new Error('Hermes returned unsupported cron job data.')
    return jobs
  }
  async runs(profile: string, id: string, limit = 20) {
    const result = await this.api.request<{ runs: CronRun[]; limit: number }>(this.path(profile, id, '/runs') + `&limit=${Math.min(100, Math.max(1, limit))}`)
    if (!Array.isArray(result.runs) || result.runs.some(run => !run || typeof run.id !== 'string')) throw new Error('Hermes returned unsupported cron run data.')
    return result
  }
  create(profile: string, draft: CronDraft) {
    return this.api.request<CronJob>(this.path(profile), { method: 'POST', body: JSON.stringify(cronPayload(draft)) })
  }
  update(profile: string, job: CronJob, draft: CronDraft) {
    return this.api.request<CronJob>(this.path(profile, job.id), { method: 'PUT', body: JSON.stringify({ updates: cronPayload(draft, job) }) })
  }
  action(profile: string, id: string, action: 'pause' | 'resume' | 'trigger' | 'delete') {
    return this.api.request(this.path(profile, id, action === 'delete' ? '' : '/' + action), { method: action === 'delete' ? 'DELETE' : 'POST' })
  }
  history(profile: string, id: string, offset = 0) { return this.api.history(id, profile, offset) }
}
