import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import { HermesApi, HttpError } from '../src/hermes/api'
import { conversationKey, readPins, usePinnedConversations, writePins } from '../src/pinned-conversations'
import type { SessionRow } from '../src/hermes/types'

let cleanup = () => {}
afterEach(() => { cleanup(); localStorage.clear(); document.body.innerHTML = ''; vi.restoreAllMocks() })
function mount(endpoint = 'https://one.test') {
  const scope = ref(endpoint)
  const connected = ref(true)
  const sessions = ref<SessionRow[]>([])
  const api = new HermesApi()
  const detail = vi.spyOn(api, 'session').mockResolvedValue({ id: 'old', title: 'Older pinned chat', profile: 'work' })
  let pins!: ReturnType<typeof usePinnedConversations>
  const app = createApp({ setup() { pins = usePinnedConversations(scope, connected, sessions, api); return () => h('div') } })
  const host = document.createElement('div'); document.body.append(host); app.mount(host)
  cleanup = () => app.unmount()
  return { pins, scope, connected, sessions, detail }
}

describe('local conversation pins', () => {
  it('stores only references, preserves other endpoints, and distinguishes profiles', () => {
    writePins(localStorage, 'https://one.test/', [{ id: 'same', profile: 'work' }, { id: 'same', profile: 'personal' }])
    writePins(localStorage, 'https://two.test', [{ id: 'other', profile: 'work' }])
    expect(readPins(localStorage, 'https://one.test')).toHaveLength(2)
    expect(readPins(localStorage, 'https://two.test/')).toEqual([{ id: 'other', profile: 'work' }])
    expect(conversationKey({ id: 'same', profile: 'work' })).not.toBe(conversationKey({ id: 'same', profile: 'personal' }))
    expect(localStorage.getItem('agora.pinned-conversations')).not.toContain('title')
    localStorage.setItem('agora.pinned-conversations', 'broken')
    expect(readPins(localStorage, 'https://one.test')).toEqual([])
  })
  it('loads older pins without history, orders pins first, and filters them during search', async () => {
    writePins(localStorage, 'https://one.test', [{ id: 'old', profile: 'work' }])
    const { pins, sessions, detail } = mount()
    sessions.value = [{ id: 'recent', title: 'Recent chat', profile: 'work' }]
    await vi.waitFor(() => expect(pins.ordered(sessions.value, '')[0]?.title).toBe('Older pinned chat'))
    expect(detail).toHaveBeenCalledExactlyOnceWith('old', 'work')
    expect(pins.ordered(sessions.value, '').map(session => session.id)).toEqual(['old', 'recent'])
    expect(pins.ordered([], 'older').map(session => session.id)).toEqual(['old'])
    expect(pins.ordered([], 'unrelated')).toEqual([])
    pins.toggle({ id: 'old', profile: 'work' })
    expect(pins.ordered(sessions.value, '').map(session => session.id)).toEqual(['recent'])
    expect(readPins(localStorage, 'https://one.test')).toEqual([])
  })
  it('keeps a pin local when loaded and reports a storage failure without pretending it was saved', () => {
    const { pins, sessions, detail } = mount()
    sessions.value = [{ id: 'recent', title: 'Recent chat', profile: 'work' }]
    pins.toggle(sessions.value[0]!)
    expect(pins.isPinned(sessions.value[0]!)).toBe(true)
    expect(detail).not.toHaveBeenCalled()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
    pins.toggle(sessions.value[0]!)
    expect(pins.isPinned(sessions.value[0]!)).toBe(true)
    expect(pins.error.value).toContain('Could not save pins')
  })
  it('retains old pinned metadata through session recovery without extra requests', async () => {
    writePins(localStorage, 'https://one.test', [{ id: 'old', profile: 'work' }])
    const { pins, connected, detail } = mount()
    await vi.waitFor(() => expect(pins.ordered([], '')[0]?.title).toBe('Older pinned chat'))
    connected.value = false
    await nextTick()
    expect(pins.ordered([], '')[0]?.title).toBe('Older pinned chat')
    expect(pins.isPinned({ id: 'old', profile: 'work' })).toBe(true)
    connected.value = true
    await nextTick()
    expect(pins.ordered([], '')[0]?.title).toBe('Older pinned chat')
    expect(detail).toHaveBeenCalledTimes(1)
  })
  it('removes confirmed deleted pins but keeps them on temporary failures', async () => {
    const { pins, detail } = mount()
    detail.mockRejectedValueOnce(new HttpError(404, 'Not found'))
    pins.toggle({ id: 'deleted', profile: 'work' })
    await vi.waitFor(() => expect(readPins(localStorage, 'https://one.test')).toEqual([]))
    detail.mockRejectedValueOnce(new HttpError(503, 'Unavailable'))
    pins.toggle({ id: 'unavailable', profile: 'work' })
    await vi.waitFor(() => expect(detail).toHaveBeenCalledTimes(2))
    expect(pins.isPinned({ id: 'unavailable', profile: 'work' })).toBe(true)
    expect(readPins(localStorage, 'https://one.test')).toEqual([{ id: 'unavailable', profile: 'work' }])
  })
  it('discards metadata from a previous endpoint', async () => {
    const { pins, scope, detail } = mount()
    let finish!: (session: SessionRow) => void
    detail.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    pins.toggle({ id: 'old', profile: 'work' })
    await vi.waitFor(() => expect(detail).toHaveBeenCalledTimes(1))
    scope.value = 'https://two.test'
    await vi.waitFor(() => expect(pins.pins.value).toEqual([]))
    finish({ id: 'old', title: 'Wrong server', profile: 'work' })
    await Promise.resolve()
    expect(pins.ordered([], '')).toEqual([])
    expect(readPins(localStorage, 'https://one.test')).toEqual([{ id: 'old', profile: 'work' }])
  })
})
