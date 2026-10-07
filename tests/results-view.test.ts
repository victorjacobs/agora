import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, markRaw, nextTick, reactive } from 'vue'
import ResultsView from '../src/ResultsView.vue'
import type { CronApi } from '../src/hermes/cron'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.restoreAllMocks() })
const history = (text: string, offset = 0, returned = 1) => ({ session_id: 'run', messages: [{ id: offset + 1, role: 'assistant', content: text }], pagination: { offset, returned, limit: 50 } })
function mount() {
  const api = {
    profile: vi.fn(async (name?: string) => name || 'work'),
    jobs: vi.fn().mockResolvedValue([{ id: 'a', name: 'Briefing', last_status: 'failed' }, { id: 'b', name: 'Digest' }]),
    runs: vi.fn(async (_profile: string, id: string) => ({ runs: id === 'a' ? [{ id: 'old', started_at: 100, ended_at: 110 }] : [{ id: 'new', started_at: 200, ended_at: 210 }], limit: 20 })),
    history: vi.fn(async (_profile: string, id: string) => history(id === 'old' ? 'Older **answer**' : 'Newest **answer**')),
  }
  const props = reactive({ active: false, connected: true, profile: 'work' as string | undefined, jobId: '', api: markRaw(api as unknown as CronApi) })
  const jobs = vi.fn(), manage = vi.fn()
  const host = document.createElement('div'); document.body.append(host)
  const app = createApp({ render: () => h(ResultsView, { ...props, onJobs: jobs, onManage: manage }) }); app.mount(host); cleanup = () => app.unmount()
  const click = (text: string, target: ParentNode = host) => [...target.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!.click()
  return { api, props, host, jobs, manage, click }
}
describe('Results feed', () => {
  it('shows day dividers and decorative icons without empty groups after filtering', async () => {
    const { api, props, host } = mount()
    const today = new Date(); today.setHours(8, 0, 0, 0)
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
    api.runs.mockImplementation(async (_owner, id) => ({ runs: [{ id, started_at: (id === 'a' ? today : yesterday).getTime() / 1000, ended_at: Date.now() / 1000 }], limit: 20 }))
    props.active = true
    await vi.waitFor(() => expect(host.querySelectorAll('.result-card')).toHaveLength(2))
    expect([...host.querySelectorAll('.result-day-heading')].map(heading => heading.textContent)).toEqual([
      expect.stringContaining('Today,'), expect.stringContaining('Yesterday,'),
    ])
    expect(host.querySelector('.result-card time')?.textContent).toBe('Today at 08:00')
    expect(host.querySelector('.result-card header svg[aria-hidden="true"]')).not.toBeNull()
    expect(host.querySelectorAll('.result-card footer svg[aria-hidden="true"]')).toHaveLength(4)
    props.jobId = 'b'; await nextTick()
    expect(host.querySelectorAll('.result-day-heading')).toHaveLength(1)
    expect(host.querySelector('.result-day-heading')?.textContent).toContain('Yesterday,')
  })
  it('never reuses finished output when the resolved launch profile changes', async () => {
    const { api, props, host, click } = mount()
    props.profile = undefined; props.active = true
    await vi.waitFor(() => expect(host.textContent).toContain('Newest answer'))
    api.profile.mockResolvedValueOnce('personal')
    api.history.mockResolvedValue(history('Personal profile answer'))
    click('Refresh')
    await vi.waitFor(() => expect(host.textContent).toContain('Profile: personal'))
    await vi.waitFor(() => expect(host.textContent).toContain('Personal profile answer'))
    expect(host.textContent).not.toContain('Newest answer')
    expect(api.history).toHaveBeenCalledWith('personal', 'new', 0)
  })
  it('does not strand a visible output when refresh replaces a pending page', async () => {
    const { api, props, host, click } = mount()
    api.runs.mockImplementation(async (_owner, id) => ({ runs: id === 'a' ? Array.from({ length: 20 }, (_, i) => ({ id: `run-${i}`, started_at: 1000 - i, ended_at: 1100 - i })) : [], limit: 20 }))
    props.active = true
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledTimes(10))
    let resolve!: (value: ReturnType<typeof history>) => void
    api.history.mockImplementationOnce(() => new Promise(finish => { resolve = finish }))
    click('Load more results')
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledTimes(20))
    click('Refresh')
    await vi.waitFor(() => expect(api.jobs).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(host.textContent).not.toContain('Loading results…'))
    resolve(history('Obsolete pending answer'))
    await vi.waitFor(() => expect(host.textContent).not.toContain('Loading output…'))
    expect(host.textContent).not.toContain('Obsolete pending answer')
  })
  it('opens a read-only run dialog on demand, pages older history and emits exact job management', async () => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
    HTMLDialogElement.prototype.close = function () { this.open = false }
    const { api, props, host, click, manage } = mount()
    props.active = true
    await vi.waitFor(() => expect(host.textContent).toContain('Newest answer'))
    expect(document.querySelector('dialog')).toBeNull()
    api.history.mockResolvedValueOnce(history('Latest detail answer', 0, 50))
    click('View conversation')
    await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain('Latest detail answer'))
    expect(document.querySelector('dialog .message.assistant strong')).toBeNull()
    api.history.mockResolvedValueOnce(history('Older detail answer', 50, 1))
    click('Load older messages', document)
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledWith('work', 'new', 50))
    await vi.waitFor(() => expect(document.querySelector('dialog')?.textContent).toContain('Older detail answer'))
    expect(document.querySelector('dialog')?.textContent).toContain('Latest detail answer')
    click('Close', document); await nextTick()
    click('Manage job')
    expect(manage).toHaveBeenCalledExactlyOnceWith('b')
    expect(document.querySelector('dialog')).toBeNull()
  })
  it('discards dialog history after changing profiles', async () => {
    const { api, props, host, click } = mount()
    props.active = true
    await vi.waitFor(() => expect(host.textContent).toContain('Newest answer'))
    let resolve!: (value: ReturnType<typeof history>) => void
    api.history.mockImplementationOnce(() => new Promise(finish => { resolve = finish }))
    click('View conversation'); await nextTick(); await nextTick()
    props.profile = 'personal'; await nextTick()
    resolve(history('Stale detail'))
    await nextTick(); await nextTick()
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.body.textContent).not.toContain('Stale detail')
  })
  it('clears cached output immediately on profile change and surfaces catalog errors', async () => {
    const { api, props, host } = mount()
    props.active = true
    await vi.waitFor(() => expect(host.textContent).toContain('Newest answer'))
    api.jobs.mockRejectedValueOnce(new Error('Profile forbidden'))
    props.profile = 'personal'; await nextTick()
    expect(host.textContent).not.toContain('Newest answer')
    await vi.waitFor(() => expect(host.textContent).toContain('Profile forbidden'))
  })
  it('polls only while active, connected and visible without repeating finished output reads', async () => {
    vi.useFakeTimers()
    try {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      const { api, props, host } = mount()
      props.active = true
      await vi.waitFor(() => expect(host.textContent).toContain('Older answer'))
      await vi.advanceTimersByTimeAsync(15000)
      expect(api.jobs).toHaveBeenCalledTimes(2)
      expect(api.history).toHaveBeenCalledTimes(2)
      visibility.mockReturnValue('hidden')
      await vi.advanceTimersByTimeAsync(15000)
      expect(api.jobs).toHaveBeenCalledTimes(2)
      visibility.mockReturnValue('visible')
      props.active = false; await nextTick()
      await vi.advanceTimersByTimeAsync(15000)
      expect(api.jobs).toHaveBeenCalledTimes(2)
      props.active = true; await nextTick()
      await vi.waitFor(() => expect(api.jobs).toHaveBeenCalledTimes(3))
      expect(api.history).toHaveBeenCalledTimes(2)
      props.connected = false; await nextTick()
      await vi.advanceTimersByTimeAsync(15000)
      expect(api.jobs).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })
  it('discards profile races without fetching jobs for a stale resolved profile', async () => {
    const { api, props, host } = mount()
    let resolve!: (value: string) => void
    api.profile.mockImplementationOnce(() => new Promise<string>(finish => { resolve = finish }))
    props.active = true; await nextTick()
    props.profile = 'personal'; await nextTick()
    await vi.waitFor(() => expect(host.textContent).toContain('Newest answer'))
    resolve('work'); await nextTick(); await nextTick()
    expect(api.jobs).not.toHaveBeenCalledWith('work')
    expect(host.textContent).toContain('Profile: personal')
  })
  it('limits concurrent reads across rapid filters and discards history after disconnect', async () => {
    const { api, props, host } = mount()
    api.runs.mockImplementation(async (_owner, id) => ({ runs: Array.from({ length: 20 }, (_, i) => ({ id: `${id}-${i}`, started_at: 1000 - i, ended_at: 1100 - i })), limit: 20 }))
    const pending: Array<() => void> = []
    let active = 0, peak = 0
    api.history.mockImplementation(() => { active++; peak = Math.max(peak, active); return new Promise(resolve => pending.push(() => { active--; resolve(history('Stale output')) })) })
    props.active = true
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledTimes(3))
    props.jobId = 'a'; await nextTick(); props.jobId = 'b'; await nextTick(); props.jobId = ''; await nextTick()
    expect(peak).toBeLessThanOrEqual(3)
    props.connected = false; await nextTick()
    pending.splice(0).forEach(resolve => resolve()); await nextTick(); await nextTick()
    expect(api.history).toHaveBeenCalledTimes(3)
    expect(host.textContent).not.toContain('Stale output')
  })
  it('loads only ten outputs at a time and reuses unchanged finished history on refresh', async () => {
    const { api, props, host, click } = mount()
    api.runs.mockImplementation(async (_owner, id) => ({ runs: id === 'a' ? Array.from({ length: 20 }, (_, i) => ({ id: `run-${i}`, started_at: 1000 - i, ended_at: 1100 - i })) : [], limit: 20 }))
    props.active = true
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledTimes(10))
    await vi.waitFor(() => expect(host.textContent).not.toContain('Loading results…'))
    expect(host.querySelectorAll('.result-card')).toHaveLength(10)
    click('Refresh')
    await vi.waitFor(() => expect(api.jobs).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(host.textContent).not.toContain('Loading results…'))
    expect(api.history).toHaveBeenCalledTimes(10)
    click('Load more results')
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledTimes(20))
    expect(host.querySelectorAll('.result-card')).toHaveLength(20)
    click('Show up to 100 runs per job')
    await vi.waitFor(() => expect(api.runs).toHaveBeenCalledWith('work', 'a', 100))
  })
  it('retains other jobs when one run listing fails and allows explicit retries of output errors', async () => {
    const { api, props, host, click } = mount()
    api.runs.mockRejectedValueOnce(new Error('Briefing runs unavailable'))
    api.history.mockRejectedValueOnce(new Error('History unavailable'))
    props.active = true
    await vi.waitFor(() => expect(host.textContent).toContain('History unavailable'))
    expect(host.textContent).toContain('Briefing runs unavailable')
    expect(host.querySelectorAll('.result-card')).toHaveLength(1)
    click('Retry output')
    await vi.waitFor(() => expect(host.textContent).toContain('Newest answer'))
  })
  it('filters by sidebar job and run status while labeling script output as preview only', async () => {
    const { api, props, host } = mount()
    api.runs.mockImplementation(async (_owner, id) => ({ runs: id === 'a' ? [
      { id: 'owned', started_at: 300, scheduler_owned: true, is_active: false },
      { id: 'stale', started_at: 250, scheduler_owned: false, is_active: true },
    ] : [{ id: 'cron_output:b:latest', source: 'cron_output', started_at: 200, ended_at: 210, preview: 'Short script preview' }], limit: 20 }) as never)
    props.active = true
    await vi.waitFor(() => expect(host.textContent).toContain('Short script preview'))
    expect(host.textContent).toContain('Full output unavailable through the Hermes API')
    expect(api.history.mock.calls.map(call => call[1])).not.toContain('cron_output:b:latest')
    const filter = host.querySelector('select')!
    filter.value = 'Running'; filter.dispatchEvent(new Event('change')); await nextTick()
    expect(host.querySelectorAll('.result-card')).toHaveLength(1)
    expect(host.textContent).not.toContain('Short script preview')
    filter.value = 'Unknown'; filter.dispatchEvent(new Event('change')); await nextTick()
    expect(host.querySelectorAll('.result-card')).toHaveLength(1)
    props.jobId = 'b'; await nextTick()
    expect(host.querySelectorAll('.result-card')).toHaveLength(0)
    filter.value = 'All runs'; filter.dispatchEvent(new Event('change')); await nextTick()
    expect(host.querySelectorAll('.result-card')).toHaveLength(1)
  })
  it('loads on activation and shows actual chronological assistant answers with safe Markdown', async () => {
    const { api, props, host, jobs } = mount()
    expect(api.jobs).not.toHaveBeenCalled()
    props.active = true
    await vi.waitFor(() => expect(host.querySelectorAll('.result-card strong')).toHaveLength(2))
    const cards = [...host.querySelectorAll('.result-card')]
    expect(cards[0]?.textContent).toContain('Newest answer')
    expect(cards[1]?.textContent).toContain('Older answer')
    expect(cards[0]?.textContent).toContain('Finished')
    expect(host.textContent).not.toContain('Failed')
    expect(jobs).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'a' })]))
    expect(host.textContent).toContain('20 recent runs per job')
    expect(host.querySelectorAll('select')).toHaveLength(1)
  })
})
