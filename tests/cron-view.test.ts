import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, markRaw, nextTick, reactive } from 'vue'
import CronView from '../src/CronView.vue'
import type { CronApi, CronJob } from '../src/hermes/cron'

const modalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal')
const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close')
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterAll(() => {
  if (modalDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', modalDescriptor)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
  if (closeDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'close', closeDescriptor)
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
})
let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })
function mount() {
  const job: CronJob = { id: 'job', name: 'Briefing', prompt: 'Summarize news', schedule: '0 9 * * *', enabled: false }
  const api = { profile: vi.fn(async (name: string) => name), jobs: vi.fn(async () => [job]),
    runs: vi.fn(async () => ({ runs: [{ id: 'run', started_at: 123, ended_at: 124, title: 'Briefing result' }], limit: 20 })),
    update: vi.fn().mockResolvedValue(job), create: vi.fn().mockResolvedValue(job), action: vi.fn().mockResolvedValue({ ok: true }),
    history: vi.fn().mockResolvedValue({ messages: [{ id: 1, role: 'assistant', content: 'Run result' }], pagination: { offset: 0, returned: 1, limit: 50 } }),
  }
  const props = reactive({ active: false, connected: true, profile: 'work', api: markRaw(api as unknown as CronApi) })
  const host = document.createElement('div'); document.body.append(host)
  const app = createApp({ render: () => h(CronView, { ...props, api: api as unknown as CronApi }) }); app.mount(host); cleanup = () => app.unmount()
  const click = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click()
  return { props, host, api, click }
}
describe('cron workspace', () => {
  it('loads only while open, confirms manual execution, and reads history on demand', async () => {
    const { props, host, api, click } = mount()
    expect(api.jobs).not.toHaveBeenCalled()
    props.active = true
    await vi.waitFor(() => expect(host.textContent).toContain('Briefing result'))
    expect(api.runs).toHaveBeenCalledWith('work', 'job', 20)
    expect(api.history).not.toHaveBeenCalled()
    click('Run now'); await nextTick()
    expect(host.textContent).toContain('also resumes a paused job')
    expect(api.action).not.toHaveBeenCalled()
    click('Run job')
    await vi.waitFor(() => expect(api.action).toHaveBeenCalledExactlyOnceWith('work', 'job', 'trigger'))
    await vi.waitFor(() => expect(host.textContent).toContain('Run requested'))
    click('View conversation')
    await vi.waitFor(() => expect(document.querySelector('dialog[open]')?.textContent).toContain('Run result'))
    expect(api.history).toHaveBeenCalledExactlyOnceWith('work', 'run', 0)
    document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
    await nextTick()
    expect(document.querySelector('dialog')).toBeNull()
  })
  it('retains failed edits without retrying and confirms deletion', async () => {
    const { props, host, api, click } = mount()
    props.active = true
    await vi.waitFor(() => expect(host.textContent).toContain('Briefing result'))
    click('Edit'); await nextTick()
    const input = host.querySelector('input')!
    input.value = 'New title'; input.dispatchEvent(new Event('input')); await nextTick()
    api.update.mockRejectedValueOnce(new Error('Timed out'))
    host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('has not been retried'))
    expect(input.value).toBe('New title')
    expect(api.update).toHaveBeenCalledTimes(1)
    click('Cancel'); await nextTick(); click('Delete'); await nextTick()
    expect(api.action).not.toHaveBeenCalled()
    click('Delete job')
    await vi.waitFor(() => expect(api.action).toHaveBeenCalledExactlyOnceWith('work', 'job', 'delete'))
  })
  it('creates a paused job with its profile and execution settings', async () => {
    const { props, host, api, click } = mount()
    api.jobs.mockResolvedValueOnce([])
    props.active = true
    await vi.waitFor(() => {
      expect(api.jobs).toHaveBeenCalledTimes(1)
      expect(host.querySelector<HTMLButtonElement>('.cron-empty button')?.disabled).toBe(false)
    })
    click('New job'); await nextTick()
    const inputs = host.querySelectorAll('input')
    inputs[0]!.value = 'New briefing'; inputs[0]!.dispatchEvent(new Event('input'))
    inputs[1]!.value = 'every 30m'; inputs[1]!.dispatchEvent(new Event('input'))
    const paused = host.querySelector<HTMLInputElement>('input[type=checkbox]')!
    paused.checked = true; paused.dispatchEvent(new Event('change'))
    await nextTick()
    host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    expect(api.create.mock.calls[0]).toEqual(['work', expect.objectContaining({ name: 'New briefing', schedule: 'every 30m', paused: true })])
  })
  it('does not show an old mutation result in a new profile', async () => {
    const { props, host, api, click } = mount()
    props.active = true
    await vi.waitFor(() => expect(host.textContent).toContain('Briefing result'))
    let finish!: () => void
    api.action.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true }) }))
    click('Resume'); await nextTick()
    props.profile = 'personal'; await nextTick()
    finish()
    await vi.waitFor(() => expect(host.textContent).toContain('Profile: personal'))
    expect(host.textContent).not.toContain('Job resumed.')
    expect(api.action).toHaveBeenCalledExactlyOnceWith('work', 'job', 'resume')
  })
  it('discards history returned after switching profiles', async () => {
    const { props, host, api, click } = mount()
    props.active = true
    await vi.waitFor(() => expect(host.textContent).toContain('Briefing result'))
    let finish!: (value: unknown) => void
    api.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    click('View conversation'); await nextTick()
    props.profile = 'personal'
    await vi.waitFor(() => expect(host.textContent).toContain('Profile: personal'))
    finish({ messages: [{ id: 1, role: 'assistant', content: 'Stale secret' }], pagination: { offset: 0, returned: 1, limit: 50 } })
    await nextTick()
    expect(document.body.textContent).not.toContain('Stale secret')
  })
})
