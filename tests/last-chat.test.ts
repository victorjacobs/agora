import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatClient, initialState } from '../src/hermes/chat'
import { HermesApi, HttpError } from '../src/hermes/api'
import { Gateway } from '../src/hermes/gateway'
import { deferred } from './helpers/deferred'

const clients: ChatClient[] = []
function setup({ selected = '', endpoint = 'https://fixture.invalid/hermes', profile = 'work', user = '' } = {}) {
  const state = initialState()
  const api = new HermesApi()
  const gateway = new Gateway()
  vi.spyOn(api, 'request').mockImplementation(async path => {
    if (path === '/api/agora/connection') return { mode: 'local', endpoint }
    if (path === '/api/status') return { auth_required: Boolean(user) }
    if (path === '/api/auth/me') return { user_id: user, provider: 'fixture', org_id: 'org', display_name: 'Operator' }
    if (path === '/api/profiles/active') return { current: profile }
    throw new Error(`Unexpected fixture API: ${path}`)
  })
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [], total: 0 })
  vi.spyOn(api, 'session').mockImplementation(async id => ({ id, profile }))
  vi.spyOn(api, 'history').mockImplementation(async id => ({ session_id: id, profile, messages: [], pagination: { returned: 0, offset: 0, limit: 50 } }))
  vi.spyOn(gateway, 'connect').mockResolvedValue()
  vi.spyOn(gateway, 'request').mockImplementation(async (method, params) => {
    if (method === 'session.resume' || method === 'session.create') {
      const id = method === 'session.create' ? 'new' : String(params?.session_id)
      return { session_id: `runtime-${id}`, stored_session_id: id, info: { profile_name: profile, title: id } }
    }
    if (method === 'approval.pending') return { approvals: [] }
    if (method === 'session.active_list') return { sessions: [] }
    if (method === 'model.options') return { providers: [] }
    if (method === 'config.get') return { value: 'medium' }
    if (method === 'subagent.list') return { subagents: [] }
    if (method === 'process.list') return { processes: [] }
    return {}
  })
  const navigations: string[] = []
  const chat = new ChatClient(state, api, gateway, { origin: 'https://agora.invalid', selected: () => selected, select: id => navigations.push(id) })
  clients.push(chat)
  return { chat, state, api, gateway, navigations }
}
afterEach(() => { clients.splice(0).forEach(chat => chat.dispose()); localStorage.clear() })

async function remember() {
  const first = setup()
  await first.chat.start('work')
  await first.chat.open('saved', 'work')
  first.chat.dispose()
}

describe('last opened chat', () => {
  it('clears on logout even while the launch profile is still being discovered', async () => {
    await remember()
    const next = setup()
    const profile = deferred<{ current: string }>()
    const original = vi.mocked(next.api.request).getMockImplementation()!
    vi.mocked(next.api.request).mockImplementation(async (path, options) => path === '/api/profiles/active' ? profile.promise : original(path, options))
    const starting = next.chat.start()
    await vi.waitFor(() => expect(next.api.request).toHaveBeenCalledWith('/api/profiles/active'))
    next.chat.forgetLastChat()
    next.chat.dispose()
    profile.resolve({ current: 'work' })
    await starting
    const reload = setup()
    await reload.chat.start('work')
    expect(reload.state.selected).toBe('')
  })
  it.each(['corrupt', 'blocked', 'missing-principal'])('keeps startup usable with %s browser recovery state', async failure => {
    await remember()
    if (failure === 'corrupt') {
      const key = Object.keys(localStorage).find(key => key.startsWith('agora.last-chat:'))!
      localStorage.setItem(key, '{broken')
    }
    if (failure === 'blocked') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked') })
    const next = setup({ user: failure === 'missing-principal' ? 'alice' : '' })
    if (failure === 'missing-principal') {
      const original = vi.mocked(next.api.request).getMockImplementation()!
      vi.mocked(next.api.request).mockImplementation(async (path, options) => path === '/api/auth/me' ? { display_name: 'Operator' } : original(path, options))
    }
    await next.chat.start('work')
    expect(next.state.connection).toBe('ready')
    expect(next.state.selected).toBe('')
    await next.chat.open('manual', 'work')
    expect(next.state.selected).toBe('manual')
    expect(next.state.connection).toBe('ready')
  })
  it('removes the old deep link as soon as New chat is requested', async () => {
    const next = setup({ selected: 'old' })
    await next.chat.start('work')
    const creation = deferred<unknown>()
    const original = vi.mocked(next.gateway.request).getMockImplementation()!
    vi.mocked(next.gateway.request).mockImplementation((method, params, timeout) => method === 'session.create' ? creation.promise : original(method, params, timeout))
    const creating = next.chat.newChat()
    expect(next.navigations.at(-1)).toBe('')
    creation.resolve({ session_id: 'runtime-new', stored_session_id: 'new', info: { profile_name: 'work' } })
    await creating
  })
  it('gives an explicit URL priority over the remembered reference', async () => {
    await remember()
    const next = setup({ selected: 'deep-link' })
    await next.chat.start('work')
    expect(next.state.selected).toBe('deep-link')
    expect(next.api.session).not.toHaveBeenCalled()
  })
  it('ignores a late restore transcript after a manual selection, including its persistence', async () => {
    await remember()
    const next = setup()
    const transcript = deferred<Awaited<ReturnType<HermesApi['history']>>>()
    vi.mocked(next.api.history).mockReturnValueOnce(transcript.promise)
    const starting = next.chat.start('work')
    await vi.waitFor(() => expect(next.api.history).toHaveBeenCalled())
    await next.chat.open('manual', 'work')
    transcript.resolve({ session_id: 'saved', profile: 'work', messages: [], pagination: { returned: 0, offset: 0, limit: 50 } })
    await starting
    expect(next.state.selected).toBe('manual')
    const reload = setup()
    await reload.chat.start('work')
    expect(reload.state.selected).toBe('manual')
  })
  it.each(['/api/agora/connection', '/api/profiles/active'])('does not guess an unresolved scope after %s fails, and retries discovery on reconnect', async path => {
    await remember()
    const next = setup()
    const original = vi.mocked(next.api.request).getMockImplementation()!
    vi.mocked(next.api.request).mockImplementation(async (request, options) => {
      if (request === path) throw new HttpError(503, 'Temporary discovery failure')
      return original(request, options)
    })
    await next.chat.start()
    expect(next.state.selected).toBe('')
    expect(next.api.session).not.toHaveBeenCalled()
    vi.mocked(next.api.request).mockImplementation(original)
    await next.chat.connect()
    expect(next.state.selected).toBe('saved')
  })
  it('waits for authentication and retains the reference across expiration rather than treating it as logout', async () => {
    const first = setup({ selected: 'saved', user: 'alice' })
    await first.chat.start('work')
    first.chat.dispose()
    const next = setup({ user: 'alice' })
    const original = vi.mocked(next.api.request).getMockImplementation()!
    vi.mocked(next.api.request).mockImplementation(async (path, options) => {
      if (path === '/api/auth/me') throw new HttpError(401, 'Expired')
      return original(path, options)
    })
    await next.chat.start('work')
    expect(next.state.connection).toBe('expired')
    expect(next.api.history).not.toHaveBeenCalled()
    vi.mocked(next.api.request).mockImplementation(original)
    await next.chat.connect()
    expect(next.state.selected).toBe('saved')
  })
  it('clears the reference after deleting the selected chat', async () => {
    await remember()
    const next = setup()
    await next.chat.start('work')
    vi.spyOn(next.api, 'delete').mockResolvedValue({})
    await next.chat.deleteSelected()
    const reload = setup()
    await reload.chat.start('work')
    expect(reload.state.selected).toBe('')
  })
  it('clears on explicit logout and fences an in-flight restored transcript', async () => {
    await remember()
    const next = setup()
    const transcript = deferred<Awaited<ReturnType<HermesApi['history']>>>()
    vi.mocked(next.api.history).mockReturnValue(transcript.promise)
    const starting = next.chat.start('work')
    await vi.waitFor(() => expect(next.api.history).toHaveBeenCalled())
    next.chat.forgetLastChat()
    next.chat.dispose()
    transcript.resolve({ session_id: 'saved', profile: 'work', messages: [], pagination: { returned: 0, offset: 0, limit: 50 } })
    await starting
    const reload = setup()
    await reload.chat.start('work')
    expect(reload.state.selected).toBe('')
  })
  it('does not override New chat while the automatic lookup is pending', async () => {
    await remember()
    const next = setup()
    const lookup = deferred<{ id: string; profile: string }>()
    vi.mocked(next.api.session).mockReturnValue(lookup.promise)
    const starting = next.chat.start('work')
    await vi.waitFor(() => expect(next.api.session).toHaveBeenCalled())
    await next.chat.newChat()
    lookup.resolve({ id: 'saved', profile: 'work' })
    await starting
    expect(next.state.selected).toBe('new')
    expect(next.api.history).not.toHaveBeenCalled()
    const reload = setup()
    await reload.chat.start('work')
    expect(reload.state.selected).toBe('')
  })
  it('leaves a failed automatic restore usable and retains its reference for a later reload', async () => {
    await remember()
    const next = setup()
    vi.mocked(next.api.history).mockRejectedValue(new HttpError(503, 'Temporarily unavailable'))
    await next.chat.start('work')
    expect(next.state.connection).toBe('ready')
    expect(next.state.selected).toBe('')
    expect(next.state.error).toContain('reopen')
    const reload = setup()
    await reload.chat.start('work')
    expect(reload.state.selected).toBe('saved')
  })
  it('drops a deleted remembered target without blocking startup or creating/resuming another chat', async () => {
    await remember()
    const next = setup()
    vi.mocked(next.api.session).mockRejectedValue(new HttpError(404, 'Session not found'))
    vi.mocked(next.api.history).mockRejectedValue(new HttpError(404, 'Session not found'))
    await next.chat.start('work')
    expect(next.state.connection).toBe('ready')
    expect(next.state.selected).toBe('')
    expect(next.gateway.request).not.toHaveBeenCalledWith('session.resume', expect.anything())
    expect(next.gateway.request).not.toHaveBeenCalledWith('session.create', expect.anything())
    const reload = setup()
    await reload.chat.start('work')
    expect(reload.state.selected).toBe('')
  })
  it('clears the remembered chat on New chat and only remembers the replacement after sending', async () => {
    await remember()
    const next = setup()
    await next.chat.start('work')
    await next.chat.newChat()
    expect(next.state.selected).toBe('new')
    const emptyReload = setup()
    await emptyReload.chat.start('work')
    expect(emptyReload.state.selected).toBe('')
    next.state.draft = 'Fictional new message'
    await next.chat.send()
    const sentReload = setup()
    await sentReload.chat.start('work')
    expect(sentReload.state.selected).toBe('new')
  })
  it('resolves the launch profile before restoring and isolates endpoints, profiles and authenticated principals', async () => {
    const first = setup({ user: 'alice' })
    await first.chat.start()
    await first.chat.open('alice-chat', 'work')
    first.chat.dispose()
    for (const options of [{ user: 'bob' }, { user: 'alice', endpoint: 'https://other.invalid' }, { user: 'alice', profile: 'other' }, {}]) {
      const other = setup(options)
      await other.chat.start()
      expect(other.state.selected).toBe('')
      other.chat.dispose()
    }
    const reload = setup({ user: 'alice' })
    await reload.chat.start()
    expect(reload.state.selected).toBe('alice-chat')
    expect(reload.api.request).toHaveBeenCalledWith('/api/profiles/active')
    expect(reload.api.history).toHaveBeenCalledWith('alice-chat', 'work')
    expect(JSON.stringify(localStorage)).not.toContain('Operator')
  })
  it('restores authoritative stored identity after a cold start without a URL selection', async () => {
    const first = setup({ selected: 'ancestor' })
    vi.mocked(first.api.history).mockResolvedValue({ session_id: 'descendant', profile: 'work', messages: [], pagination: { returned: 0, offset: 0, limit: 50 } })
    await first.chat.start('work')
    first.chat.dispose()
    const reload = setup()
    await reload.chat.start('work')
    expect(reload.state.selected).toBe('descendant')
    expect(reload.state.runtime).toBe('runtime-descendant')
    expect(reload.navigations.at(-1)).toBe('descendant')
    expect(JSON.stringify(localStorage)).not.toContain('runtime-')
  })
})
