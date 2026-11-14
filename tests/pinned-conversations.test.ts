import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import { deferred } from './helpers/deferred'
import { HermesApi } from '../src/hermes/api'
import { readPins, usePinnedConversations, writePins } from '../src/pinned-conversations'
import type { SessionRow } from '../src/hermes/types'

let cleanup = () => {}
afterEach(() => { cleanup(); localStorage.clear(); document.body.innerHTML = ''; vi.restoreAllMocks() })
const old = { id: 'old', profile: 'work' }
function mount(endpoint = 'https://one.test', ready = true) {
  const scope = ref(endpoint), connected = ref(ready), profile = ref<string | undefined>('work')
  const sessions = ref<SessionRow[]>([])
  const selected = ref<{ id: string; profile?: string }>({ id: '' })
  const backend = new Map<string, SessionRow>([['old', { ...old, title: 'Older pinned chat', pinned: false }], ['remote', { id: 'remote', profile: 'work', title: 'Other device', pinned: true }]])
  const writes: Array<{ id: string; pinned: boolean; profile: string }> = []
  const api = new HermesApi(vi.fn(async (input, options) => {
    const url = new URL(String(input), 'https://one.test')
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!)
    if (options?.method === 'PATCH') {
      const body = JSON.parse(String(options.body))
      writes.push({ id, ...body })
      backend.set(id, { ...backend.get(id), id, ...body })
      return Response.json({ ok: true, pinned: body.pinned })
    }
    if (url.pathname === '/api/sessions') return Response.json({ sessions: [...backend.values()], total: backend.size, offset: 0, limit: 20 })
    if (url.pathname === '/api/profiles/active') return Response.json({ current: 'work' })
    return Response.json(backend.get(id) || { detail: 'Missing' }, { status: backend.has(id) ? 200 : 404 })
  }) as typeof fetch)
  let pins!: ReturnType<typeof usePinnedConversations>
  const app = createApp({ setup() { pins = usePinnedConversations(scope, connected, sessions, api, profile, selected); return () => h('div') } })
  const host = document.createElement('div'); document.body.append(host); app.mount(host)
  cleanup = () => app.unmount()
  return { pins, scope, connected, profile, sessions, api, writes, backend, selected }
}

describe('server conversation pins', () => {
  it('automatically imports references additively and acknowledges only the selected endpoint/profile', async () => {
    writePins(localStorage, 'https://one.test/', [old, { id: 'other-profile', profile: 'personal' }])
    writePins(localStorage, 'https://two.test', [{ id: 'untouched', profile: 'work' }])
    const { pins, writes, backend } = mount()
    await vi.waitFor(() => expect(readPins(localStorage, 'https://one.test')).toEqual([{ id: 'other-profile', profile: 'personal' }]))
    expect(writes).toEqual([{ ...old, pinned: true }])
    expect(backend.get('remote')?.pinned).toBe(true)
    expect(pins.ordered([], '').map(row => row.id).sort()).toEqual(['old', 'remote'])
    expect(pins.ordered([], 'older').map(row => row.id)).toEqual(['old'])
    expect(readPins(localStorage, 'https://two.test')).toEqual([{ id: 'untouched', profile: 'work' }])
    expect(localStorage.getItem('agora.pinned-conversations')).not.toContain('title')
  })

  it('unpins a failed local import instead of accidentally retrying true', async () => {
    writePins(localStorage, 'https://one.test', [old])
    const { pins, connected, api, writes } = mount('https://one.test', false)
    vi.spyOn(api, 'setPinned').mockRejectedValueOnce(new Error('Offline'))
    connected.value = true
    await vi.waitFor(() => expect(pins.error.value).toContain('waiting to sync'))
    vi.mocked(api.setPinned).mockRestore()
    await pins.toggle(old)
    expect(writes).toEqual([{ ...old, pinned: false }])
    expect(pins.isPinned(old)).toBe(false)
  })

  it('shows a compressed legacy root once at the server-projected tip and locks both identities during import', async () => {
    writePins(localStorage, 'https://one.test', [old])
    const { pins, connected, api, backend } = mount('https://one.test', false)
    backend.set('tip', { id: 'tip', profile: 'work', title: 'Live tip', pinned: false, _lineage_ids: ['old', 'middle', 'tip'] })
    const waiting = deferred<SessionRow>()
    vi.spyOn(api, 'session').mockReturnValueOnce(waiting.promise)
    connected.value = true
    await vi.waitFor(() => expect(pins.isBusy(old)).toBe(true))
    expect(pins.isBusy({ id: 'tip', profile: 'work' })).toBe(true)
    expect(pins.isPinned({ id: 'tip', profile: 'work' })).toBe(true)
    waiting.resolve({ ...old, pinned: 1 })
    backend.get('old')!.pinned = 1
    await vi.waitFor(() => expect(pins.pendingCount.value).toBe(0))
    expect(pins.ordered([], '').map(row => row.id).sort()).toEqual(['remote', 'tip'])
  })

  it('keeps failed imports visible, retries independently, and never repins acknowledged entries', async () => {
    writePins(localStorage, 'https://one.test', [old, { id: 'remote', profile: 'work' }])
    const { pins, connected, api, writes, backend } = mount('https://one.test', false)
    vi.spyOn(api, 'setPinned').mockRejectedValueOnce(new Error('Offline'))
    connected.value = true
    await vi.waitFor(() => expect(pins.pendingCount.value).toBe(1))
    expect(pins.isPinned(old)).toBe(true)
    expect(pins.error.value).toContain('waiting to sync')
    expect(readPins(localStorage, 'https://one.test')).toEqual([old])
    backend.get('remote')!.pinned = false
    vi.mocked(api.setPinned).mockRestore()
    await pins.retry()
    expect(writes).toEqual([])
    await pins.reimport()
    expect(readPins(localStorage, 'https://one.test')).toEqual([])
    expect(writes).toEqual([{ ...old, pinned: true }])
    expect(pins.isPinned({ id: 'remote', profile: 'work' })).toBe(false)
  })
  it('does not reimport after an acknowledgement write fails and blocks unsafe unpin until storage recovers', async () => {
    writePins(localStorage, 'https://one.test', [old])
    const { pins, connected, api, writes, backend } = mount('https://one.test', false)
    const original = api.setPinned.bind(api)
    vi.spyOn(api, 'setPinned').mockImplementation(async (...args) => {
      await original(...args)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Full') })
    })
    connected.value = true
    await vi.waitFor(() => expect(pins.error.value).toContain('Allow browser storage'))
    await pins.toggle(old)
    expect(writes).toHaveLength(1)
    backend.get('old')!.pinned = false
    await pins.retry()
    expect(writes).toHaveLength(1)
    expect(readPins(localStorage, 'https://one.test')).toEqual([old])
    vi.restoreAllMocks()
    await pins.retry()
    expect(readPins(localStorage, 'https://one.test')).toEqual([])
    expect(pins.isPinned(old)).toBe(false)
  })
  it('keeps an unconfirmed readback pending and exposes backend-only changes on focus', async () => {
    writePins(localStorage, 'https://one.test', [old])
    const { pins, connected, api, backend } = mount('https://one.test', false)
    vi.spyOn(api, 'setPinned').mockResolvedValue()
    connected.value = true
    await vi.waitFor(() => expect(pins.error.value).toContain('waiting to sync'))
    expect(readPins(localStorage, 'https://one.test')).toEqual([old])
    backend.get('remote')!.pinned = false
    backend.set('second', { id: 'second', profile: 'work', pinned: true })
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(pins.isPinned({ id: 'second', profile: 'work' })).toBe(true))
    expect(pins.isPinned({ id: 'remote', profile: 'work' })).toBe(false)
    expect(pins.isPinned(old)).toBe(true)
  })
  it('locks an importing pin and ignores late results after an endpoint switch', async () => {
    writePins(localStorage, 'https://one.test', [old])
    const { pins, connected, api, scope, writes } = mount('https://one.test', false)
    const wait = deferred<SessionRow>()
    vi.spyOn(api, 'session').mockReturnValueOnce(wait.promise)
    connected.value = true
    await vi.waitFor(() => expect(pins.isBusy(old)).toBe(true))
    await pins.toggle(old)
    expect(writes).toEqual([])
    scope.value = 'https://two.test'
    await nextTick()
    wait.resolve({ ...old, pinned: false })
    await nextTick()
    expect(writes).toEqual([])
    expect(readPins(localStorage, 'https://one.test')).toEqual([old])
  })
  it('waits for a resolved endpoint and authenticated readiness, then respects profile replacement', async () => {
    writePins(localStorage, 'https://one.test', [old])
    const { pins, scope, connected, profile, writes, api } = mount('', false)
    await nextTick()
    expect(writes).toEqual([])
    scope.value = 'https://one.test'
    await nextTick()
    expect(pins.isPinned(old)).toBe(true)
    expect(writes).toEqual([])
    const wait = deferred<SessionRow>()
    vi.spyOn(api, 'session').mockReturnValueOnce(wait.promise)
    connected.value = true
    await vi.waitFor(() => expect(pins.isBusy(old)).toBe(true))
    profile.value = 'personal'
    wait.resolve({ ...old, pinned: false })
    await nextTick()
    expect(writes).toEqual([])
    expect(pins.isPinned(old)).toBe(false)
    expect(readPins(localStorage, 'https://one.test')).toEqual([old])
  })
  it('prunes only confirmed missing entries and keeps storage failures intact', async () => {
    writePins(localStorage, 'https://one.test', [old, { id: 'deleted', profile: 'work' }])
    const { pins, connected, writes } = mount('https://one.test', false)
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
    connected.value = true
    await vi.waitFor(() => expect(pins.error.value).toContain('Allow browser storage'))
    expect(writes).toEqual([])
    expect(readPins(localStorage, 'https://one.test')).toHaveLength(2)
    storage.mockRestore()
    await pins.retry()
    expect(readPins(localStorage, 'https://one.test')).toEqual([])
    expect(writes).toEqual([{ ...old, pinned: true }])
  })
  it('rolls back rejected native changes without writing new local pins', async () => {
    const { pins, api } = mount()
    await vi.waitFor(() => expect(pins.isPinned({ id: 'remote', profile: 'work' })).toBe(true))
    vi.spyOn(api, 'setPinned').mockRejectedValueOnce(new Error('Denied'))
    await pins.toggle({ id: 'remote', profile: 'work' })
    expect(pins.isPinned({ id: 'remote', profile: 'work' })).toBe(true)
    expect(pins.error.value).toContain('Could not confirm')
    expect(readPins(localStorage, 'https://one.test')).toEqual([])
  })

  it('does not let a stale selected-detail response overwrite a newer native change', async () => {
    const { pins, api, selected } = mount()
    await vi.waitFor(() => expect(pins.isPinned({ id: 'remote', profile: 'work' })).toBe(true))
    const wait = deferred<SessionRow>()
    vi.spyOn(api, 'session').mockReturnValueOnce(wait.promise)
    selected.value = { id: 'off-page', profile: 'work' }
    await nextTick()
    await pins.toggle(selected.value)
    expect(pins.isPinned(selected.value)).toBe(true)
    wait.resolve({ id: 'off-page', profile: 'work', pinned: false })
    await nextTick()
    expect(pins.isPinned(selected.value)).toBe(true)
  })

  it('resolves the launch profile for a header without a configured profile', async () => {
    const { pins, profile, connected } = mount('https://one.test', false)
    profile.value = undefined
    connected.value = true
    await vi.waitFor(() => expect(pins.isPinned({ id: 'remote', profile: 'work' })).toBe(true))
    expect(pins.isPinned({ id: 'remote' })).toBe(true)
  })

  it('does not lose automatic migration when focus refresh overtakes the initial list', async () => {
    writePins(localStorage, 'https://one.test', [old])
    const { pins, connected, api } = mount('https://one.test', false)
    const waiting = deferred<{ sessions: SessionRow[]; total: number }>()
    vi.spyOn(api, 'sessions').mockReturnValueOnce(waiting.promise)
    connected.value = true
    await nextTick()
    await pins.refresh()
    waiting.resolve({ sessions: [], total: 0 })
    await vi.waitFor(() => expect(readPins(localStorage, 'https://one.test')).toEqual([]))
  })

  it('does not import a queued legacy pin after the user unpins it while another import is slow', async () => {
    writePins(localStorage, 'https://one.test', [old, { id: 'remote', profile: 'work' }])
    const { pins, connected, api, writes, backend } = mount('https://one.test', false)
    const waiting = deferred<SessionRow>()
    vi.spyOn(api, 'session').mockReturnValueOnce(waiting.promise)
    connected.value = true
    await vi.waitFor(() => expect(pins.isBusy(old)).toBe(true))
    await pins.toggle({ id: 'remote', profile: 'work' })
    expect(backend.get('remote')!.pinned).toBe(false)
    waiting.resolve({ ...old, pinned: false })
    await vi.waitFor(() => expect(pins.pendingCount.value).toBe(0))
    expect(writes.filter(write => write.id === 'remote').map(write => write.pinned)).toEqual([false])
  })

  it('does not repin after reload if a previously attempted import could not acknowledge its backup', async () => {
    writePins(localStorage, 'https://one.test', [old])
    const first = mount('https://one.test', false)
    const update = first.api.setPinned.bind(first.api)
    vi.spyOn(first.api, 'setPinned').mockImplementation(async (...args) => {
      await update(...args)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Full') })
    })
    first.connected.value = true
    await vi.waitFor(() => expect(first.pins.error.value).toContain('Allow browser storage'))
    cleanup(); vi.restoreAllMocks()
    // A second client has since unpinned the server row; the browser reloads.
    const second = mount()
    await vi.waitFor(() => expect(second.pins.error.value).not.toBe(''))
    expect(second.writes).toEqual([])
    expect(readPins(localStorage, 'https://one.test')).toEqual([old])
    await second.pins.retry()
    expect(second.writes).toEqual([])
    expect(readPins(localStorage, 'https://one.test')).toEqual([old])
  })

  it('resumes automatic migration after reconnect overtakes a pending pre-write read', async () => {
    writePins(localStorage, 'https://one.test', [old])
    const { pins, connected, api, writes } = mount('https://one.test', false)
    const waiting = deferred<SessionRow>()
    vi.spyOn(api, 'session').mockReturnValueOnce(waiting.promise)
    connected.value = true
    await vi.waitFor(() => expect(pins.isBusy(old)).toBe(true))
    connected.value = false
    await nextTick()
    connected.value = true
    await nextTick()
    await pins.refresh()
    waiting.resolve({ ...old, pinned: false })
    await vi.waitFor(() => expect(pins.pendingCount.value).toBe(0))
    expect(writes).toEqual([{ ...old, pinned: true }])
    expect(readPins(localStorage, 'https://one.test')).toEqual([])
  })

  it('does not mutate the raw recent-list rows when refreshing its pin cache', async () => {
    const { pins, sessions } = mount()
    await vi.waitFor(() => expect(pins.isPinned({ id: 'remote', profile: 'work' })).toBe(true))
    sessions.value = [{ id: 'external', profile: 'work', pinned: true }]
    await nextTick()
    await pins.refresh()
    expect(pins.isPinned(sessions.value[0]!)).toBe(false)
    expect(sessions.value[0]!.pinned).toBe(true)
  })
})
