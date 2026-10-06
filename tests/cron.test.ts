import { describe, expect, it, vi } from 'vitest'
import { HermesApi } from '../src/hermes/api'
import { CronApi, cronDraft, cronPayload } from '../src/hermes/cron'

describe('cron transport', () => {
  it('preserves unchanged schedules and settings outside the editor', () => {
    const job = { id: 'job', name: 'Briefing', schedule: { kind: 'interval', minutes: 60 }, base_url: 'https://provider.test', enabled: false }
    const draft = cronDraft(job)
    expect(draft.schedule).toBe('every 60m')
    expect(cronPayload(draft, job)).toEqual({})
    draft.name = 'Renamed'
    draft.model = 'custom'
    expect(cronPayload(draft, job)).toEqual({ name: 'Renamed', model: 'custom' })
    draft.model = ''
    expect(cronPayload(draft, { ...job, model: 'previous' })).toEqual({ name: 'Renamed', model: null })
  })
  it('scopes every action to the explicit profile and uses the upstream update envelope', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ id: 'job', runs: [], limit: 100 }))))
    const api = new CronApi(new HermesApi(fetcher))
    const job = { id: 'job', prompt: 'Old', schedule: 'every 1h' }
    await api.update('work & personal', job, { ...cronDraft(job), prompt: 'New' })
    expect(fetcher.mock.calls[0]![0]).toBe('/api/cron/jobs/job?profile=work+%26+personal')
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ updates: { prompt: 'New' } })
    await api.action('work', 'job', 'trigger')
    expect(fetcher.mock.calls[1]![0]).toBe('/api/cron/jobs/job/trigger?profile=work')
    expect(fetcher.mock.calls[1]![1].method).toBe('POST')
    await api.action('work', 'job', 'delete')
    expect(fetcher.mock.calls[2]![1].method).toBe('DELETE')
    await api.runs('work', 'job', 200)
    expect(fetcher.mock.calls[3]![0]).toBe('/api/cron/jobs/job/runs?profile=work&limit=100')
    await api.history('work', 'run', 50)
    expect(fetcher.mock.calls[4]![0]).toContain('/api/sessions/run/messages?profile=work&offset=50&limit=50&order=latest&inline_images=true')
  })
  it('resolves the active profile and rejects unsupported responses', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"current":"work"}')).mockResolvedValueOnce(new Response('{}'))
    const api = new CronApi(new HermesApi(fetcher))
    expect(await api.profile()).toBe('work')
    await expect(api.jobs('work')).rejects.toThrow('unsupported cron job data')
  })
})
