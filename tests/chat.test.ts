import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatClient, initialState } from '../src/hermes/chat'
import { HermesApi, HttpError } from '../src/hermes/api'
import { ConnectionLost, Gateway, RpcError } from '../src/hermes/gateway'
import type { HistoryPage, Snapshot } from '../src/hermes/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function history(id: string, count = 1): HistoryPage {
  return {
    session_id: id, profile: 'work', pagination: { returned: count, offset: 0, limit: 50 },
    messages: [{ id: 1, role: 'user', content: `question-${id}` }],
  }
}
function snapshot(id: string): Snapshot {
  return { session_id: `runtime-${id}`, stored_session_id: id, info: { running: false, title: id } }
}
function setup(selected = '') {
  const state = initialState()
  const api = new HermesApi()
  const gateway = new Gateway()
  const navigations: string[] = []
  vi.spyOn(api, 'request').mockResolvedValue({ auth_required: false })
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [{ id: 'a', profile: 'work' }, { id: 'b', profile: 'work' }], total: 2 })
  vi.spyOn(api, 'history').mockImplementation(async id => history(id))
  vi.spyOn(gateway, 'connect').mockResolvedValue()
  vi.spyOn(gateway, 'request').mockImplementation(async (method, params) => {
    if (method === 'session.resume') return snapshot(String(params?.session_id))
    if (method === 'approval.pending') return { approvals: [] }
    if (method === 'session.create') return snapshot('new')
    if (method === 'request.answer') return { status: 'ok' }
    return { status: 'streaming' }
  })
  const chat = new ChatClient(state, api, gateway, {
    origin: 'https://hermes.test', selected: () => selected, select: id => navigations.push(id),
  })
  return { state, api, gateway, chat, navigations }
}

afterEach(() => vi.useRealTimers())

describe('chat recovery and session ownership', () => {
  it('shows request failures while retrying instead of leaving an unexplained empty UI', async () => {
    vi.useFakeTimers()
    const { state, api, chat } = setup()
    vi.mocked(api.request).mockRejectedValue(new TypeError('Failed to fetch'))
    await chat.start()
    expect(state.connection).toBe('reconnecting')
    expect(state.error).toBe('Failed to fetch')
    vi.mocked(api.request).mockResolvedValue({ auth_required: false })
    await chat.connect()
    expect(state.connection).toBe('ready')
    expect(state.error).toBe('')
    expect(state.activity).toBe('')
    chat.dispose()
  })

  it('uses the local service for remote authentication and ticket renewal', async () => {
    const { state, api, gateway, chat } = setup()
    vi.mocked(api.request).mockImplementation(async path => {
      if (path === '/api/agora/connection') return { mode: 'local', endpoint: 'https://remote-hermes.test' }
      if (path === '/api/status') return { auth_required: true }
      if (path === '/api/auth/me') return { display_name: 'Operator' }
      throw new Error(`Unexpected browser request: ${path}`)
    })
    await chat.start('work')
    expect(state.connection).toBe('ready')
    expect(state.localMode).toBe(true)
    expect(state.endpoint).toBe('https://remote-hermes.test')
    expect(gateway.connect).toHaveBeenCalledWith('wss://hermes.test/api/ws', undefined)
    await chat.connect()
    expect(gateway.connect).toHaveBeenCalledTimes(2)
    expect(api.request).not.toHaveBeenCalledWith('/api/auth/ws-ticket', expect.anything())
    chat.dispose()
  })

  it('uses REST stored IDs and profile for resume, runtime IDs for actions', async () => {
    const { state, api, gateway, chat } = setup('a')
    await chat.start('work')
    expect(state.connection).toBe('ready')
    expect(state.selected).toBe('a')
    expect(state.runtime).toBe('runtime-a')
    expect(api.history).toHaveBeenCalledWith('a', 'work')
    expect(gateway.request).toHaveBeenCalledWith('session.resume', expect.objectContaining({ session_id: 'a', profile: 'work', omit_messages: true, close_on_disconnect: false }))
    state.draft = 'new synthetic prompt'
    await chat.send()
    expect(gateway.request).toHaveBeenCalledWith('prompt.submit', { session_id: 'runtime-a', profile: 'work', text: 'new synthetic prompt' })
    expect(state.draft).toBe('')
    chat.dispose()
  })


  it('resumes an exact unpersisted draft after a history 404 without creating a replacement', async () => {
    const { state, api, gateway, chat } = setup('draft')
    vi.mocked(api.history).mockRejectedValue(new HttpError(404, 'Session not found'))
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation(async (method, params, timeout) => method === 'session.resume'
      ? { ...snapshot('draft'), message_count: 0, info: { lazy: true } } : ordinaryRequest(method, params, timeout))
    await chat.start('work')
    expect(state.connection).toBe('ready')
    expect(state.selected).toBe('draft')
    expect(state.runtime).toBe('runtime-draft')
    expect(state.messages).toHaveLength(0)
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'session.create')).toBe(false)
    chat.dispose()
  })

  it('does not let a late history response replace a newly selected session', async () => {
    const { state, api, chat } = setup()
    await chat.start('work')
    const slow = deferred<HistoryPage>()
    vi.mocked(api.history).mockImplementation(id => id === 'a' ? slow.promise : Promise.resolve(history(id)))
    const old = chat.open('a', 'work')
    await chat.open('b', 'work')
    slow.resolve(history('a'))
    await old
    expect(state.selected).toBe('b')
    expect(state.messages[0].text).toBe('question-b')
    expect(state.connection).toBe('ready')
    chat.dispose()
  })


  it('does not apply a stale resume snapshot or its pending requests', async () => {
    const { state, gateway, chat } = setup()
    await chat.start('work')
    const slow = deferred<Snapshot>()
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'session.resume' && params?.session_id === 'a'
      ? slow.promise : ordinaryRequest(method, params, timeout))
    const opening = chat.open('a', 'work')
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledWith('session.resume', expect.objectContaining({ session_id: 'a' })))
    await chat.open('b', 'work')
    slow.resolve({ ...snapshot('a'), running: true, open_requests: [{ id: 'old', method: 'clarify', params: { session_id: 'runtime-a' } }] })
    await opening
    expect(state.selected).toBe('b')
    expect(state.running).toBe(false)
    expect(state.requests).toHaveLength(0)
    chat.dispose()
  })

  it('interrupts the selected runtime and retains upstream failure details', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    state.running = true
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'session.interrupt'
      ? Promise.reject(new RpcError(4091, 'Interrupt refused')) : ordinaryRequest(method, params, timeout))
    await chat.stop()
    expect(gateway.request).toHaveBeenCalledWith('session.interrupt', { session_id: 'runtime-a', profile: 'work' }, 300_000)
    expect(state.error).toBe('Interrupt refused')
    expect(state.running).toBe(true)
    chat.dispose()
  })

  it('renews the ticket and resumes after reconnect without resending an ambiguous prompt', async () => {
    vi.useFakeTimers()
    const { state, api, gateway, chat } = setup('a')
    let tickets = 0
    vi.mocked(api.request).mockImplementation(async path => {
      if (path === '/api/agora/connection') return {}
      if (path === '/api/status') return { auth_required: true }
      if (path === '/api/auth/me') return { display_name: 'Operator' }
      return { ticket: `ticket-${++tickets}` }
    })
    await chat.start('work')
    const submit = deferred<unknown>()
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'prompt.submit' ? submit.promise : ordinaryRequest(method, params, timeout))
    state.draft = 'synthetic draft'
    const sending = chat.send()
    gateway.onDisconnect(1006)
    submit.reject(new ConnectionLost())
    await sending
    expect(state.connection).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.connection).toBe('ready')
    expect(state.draft).toBe('synthetic draft')
    expect(state.uncertain).toBe(true)
    expect(chat.canSend()).toBe(false)
    expect(gateway.connect).toHaveBeenNthCalledWith(1, 'wss://hermes.test/api/ws', 'ticket-1')
    expect(gateway.connect).toHaveBeenNthCalledWith(2, 'wss://hermes.test/api/ws', 'ticket-2')
    expect(vi.mocked(gateway.request).mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(1)
    chat.acknowledgeUncertain()
    expect(chat.canSend()).toBe(true)
    chat.dispose()
  })

  it('restores running state, pending approvals, and clarification IDs', async () => {
    const { state, gateway, chat } = setup('a')
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation(async (method, params, timeout) => {
      if (method === 'session.resume') return {
        ...snapshot('a'), running: true,
        inflight: { user: 'question-a', assistant: 'partial answer' },
        open_requests: [{ id: 'clarify-1', method: 'clarify', params: { session_id: 'runtime-a', questions: [{ qid: 'q1', question: 'Which?' }] } }],
      }
      if (method === 'approval.pending') return { approvals: [{ request_id: 'approval-1', choices: ['once', 'deny'] }] }
      return ordinaryRequest(method, params, timeout)
    })
    await chat.start('work')
    expect(state.running).toBe(true)
    expect(state.messages.map(message => message.text)).toEqual(['question-a', 'partial answer'])
    expect(state.approvals[0].request_id).toBe('approval-1')
    expect(state.requests[0].id).toBe('clarify-1')
    await chat.answer(state.requests[0], { answers: { q1: 'one' } })
    expect(gateway.request).toHaveBeenCalledWith('request.answer', { session_id: 'runtime-a', profile: 'work', id: 'clarify-1', result: { answers: { q1: 'one' } } }, 300_000)
    expect(state.requests).toHaveLength(0)
    chat.dispose()
  })

  it('keeps post-snapshot events and suppresses duplicate sequence numbers', async () => {
    const { state, gateway, chat } = setup('a')
    const pending = deferred<{ approvals: [] }>()
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'approval.pending' ? pending.promise : ordinaryRequest(method, params, timeout))
    const starting = chat.start('work')
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledWith('approval.pending', expect.anything()))
    const event = { type: 'message.delta', session_id: 'runtime-a', seq: 9, payload: { text: 'live tail' } }
    gateway.onEvent(event)
    pending.resolve({ approvals: [] })
    await starting
    expect(state.messages.at(-1)?.text).toBe('live tail')
    gateway.onEvent(event)
    expect(state.messages.at(-1)?.text).toBe('live tail')
    gateway.onEvent({ ...event, session_id: 'runtime-b', seq: 10 })
    expect(state.messages.at(-1)?.text).toBe('live tail')
    chat.dispose()
  })

  it('rereads history when a turn completes during the recovery window', async () => {
    const { state, api, gateway, chat } = setup('a')
    let resumes = 0
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation(async (method, params, timeout) => {
      if (method === 'session.resume' && resumes++ === 0) {
        gateway.onEvent({ type: 'message.complete', session_id: 'runtime-a', payload: { text: 'completed' } })
        vi.mocked(api.history).mockResolvedValue({ ...history('a'), messages: [
          { id: 1, role: 'user', content: 'question-a' }, { id: 2, role: 'assistant', content: 'completed' },
        ] })
      }
      return ordinaryRequest(method, params, timeout)
    })
    await chat.start('work')
    expect(api.history).toHaveBeenCalledTimes(2)
    expect(state.messages.at(-1)?.text).toBe('completed')
    expect(state.running).toBe(false)
    chat.dispose()
  })

  it('pauses on auth expiry, but reports a forbidden response separately', async () => {
    const expired = setup('a')
    vi.mocked(expired.api.request).mockRejectedValue(new HttpError(401, 'Unauthorized'))
    await expired.chat.start()
    expect(expired.state.connection).toBe('expired')
    expect(expired.gateway.connect).not.toHaveBeenCalled()
    expired.chat.dispose()
    const forbidden = setup('a')
    vi.mocked(forbidden.api.request).mockRejectedValue(new HttpError(403, 'Forbidden'))
    await forbidden.chat.start()
    expect(forbidden.state.connection).toBe('failed')
    expect(forbidden.state.error).toBe('Forbidden')
    forbidden.chat.dispose()
  })

  it('shows resume and deletion failures instead of replacing the conversation', async () => {
    const { state, api, gateway, chat } = setup('a')
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'session.resume'
      ? Promise.reject(new RpcError(4007, 'Session not found')) : ordinaryRequest(method, params, timeout))
    await chat.start()
    expect(state.selected).toBe('a')
    expect(state.error).toBe('Session not found')
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'session.create')).toBe(false)
    vi.spyOn(api, 'delete').mockRejectedValue(new HttpError(409, 'Session is writing'))
    await chat.deleteSelected()
    expect(state.selected).toBe('a')
    expect(state.error).toBe('Session is writing')
    chat.dispose()
  })

  it('carries a compression descendant into the URL and retains drafts per session', async () => {
    const { state, api, chat, navigations } = setup('a')
    vi.mocked(api.history).mockImplementation(async id => history(id === 'a' ? 'descendant' : id))
    await chat.start('work')
    expect(state.selected).toBe('descendant')
    expect(navigations.at(-1)).toBe('descendant')
    state.draft = 'unsent draft'
    await chat.open('b', 'work')
    state.draft = 'another draft'
    await chat.open('descendant', 'work')
    expect(state.draft).toBe('unsent draft')
    await chat.open('a', 'work')
    expect(state.selected).toBe('descendant')
    expect(state.draft).toBe('unsent draft')
    chat.dispose()
  })
})
