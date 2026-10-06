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
    if (method === 'session.active_list') return { sessions: [] }
    if (method === 'subagent.list') return { subagents: [] }
    if (method === 'model.options') return { providers: [], model: '', provider: '' }
    if (method === 'config.get') return { value: 'medium' }
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
  it('uploads image bytes before submitting an image-only prompt and shows the image in the user message', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'image.attach_bytes'
      ? Promise.resolve({ attached: true, path: '/uploads/one.png' }) : ordinary(method, params, timeout))
    state.images = [{ id: 'one', name: 'one.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }]
    expect(chat.canSend()).toBe(true)
    await chat.send()
    expect(gateway.request).toHaveBeenCalledWith('image.attach_bytes', { session_id: 'runtime-a', profile: 'work', filename: 'one.png', content_base64: 'aGVsbG8=' }, 60_000)
    expect(gateway.request).toHaveBeenCalledWith('prompt.submit', { session_id: 'runtime-a', profile: 'work', text: '' })
    const calls = vi.mocked(gateway.request).mock.calls.map(([method]) => method)
    expect(calls.indexOf('image.attach_bytes')).toBeLessThan(calls.indexOf('prompt.submit'))
    expect(state.messages.at(-1)?.images).toEqual(['data:image/png;base64,aGVsbG8='])
    expect(state.images).toEqual([])
    chat.dispose()
  })

  it('cleans up partially uploaded images after a known failure without sending the prompt', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    let uploads = 0
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => {
      if (method === 'image.attach_bytes') return ++uploads === 1 ? Promise.resolve({ attached: true, path: '/uploads/one.png' }) : Promise.reject(new RpcError(4016, 'Unsupported image'))
      return ordinary(method, params, timeout)
    })
    state.images = ['one', 'two'].map(id => ({ id, name: id + '.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }))
    state.draft = 'Inspect these'
    await chat.send()
    expect(gateway.request).toHaveBeenCalledWith('image.detach', { session_id: 'runtime-a', profile: 'work', path: '/uploads/one.png' })
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false)
    expect(state.images).toHaveLength(2)
    expect(state.draft).toBe('Inspect these')
    expect(state.error).toBe('Unsupported image')
    expect(state.sending).toBe(false)
    chat.dispose()
  })

  it('does not send an uploaded image after switching chats and keeps local image drafts separate', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const slow = deferred<unknown>()
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'image.attach_bytes' ? slow.promise : ordinary(method, params, timeout))
    state.images = [{ id: 'one', name: 'one.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }]
    const sending = chat.send()
    await chat.open('b', 'work')
    expect(state.images).toEqual([])
    slow.resolve({ attached: true, path: '/uploads/one.png' })
    await sending
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false)
    expect(gateway.request).toHaveBeenCalledWith('image.detach', { session_id: 'runtime-a', profile: 'work', path: '/uploads/one.png' })
    await chat.open('a', 'work')
    expect(state.images).toHaveLength(1)
    chat.dispose()
  })

  it('blocks sending when an image upload response cannot identify its queued path', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'image.attach_bytes' ? Promise.resolve({ attached: true }) : ordinary(method, params, timeout))
    state.images = [{ id: 'one', name: 'one.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }]
    await chat.send()
    expect(state.uncertain).toBe(true)
    expect(chat.canSend()).toBe(false)
    expect(state.error).toContain('did not confirm')
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false)
    chat.dispose()
  })

  it('blocks resending after an ambiguous image upload and never submits a prompt silently', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'image.attach_bytes' ? Promise.reject(new ConnectionLost()) : ordinary(method, params, timeout))
    state.images = [{ id: 'one', name: 'one.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }]
    await chat.send()
    expect(state.uncertain).toBe(true)
    expect(chat.canSend()).toBe(false)
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false)
    chat.dispose()
  })

  it('streams reasoning separately from replies and keeps it through completion recovery and session switches', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const emit = (type: string, payload: Record<string, unknown>, session_id = 'runtime-a') => gateway.onEvent({ type, payload, session_id })
    emit('reasoning.delta', { text: 'Wrong chat' }, 'runtime-b')
    expect(state.messages.some(message => message.reasoning)).toBe(false)
    emit('message.start', {})
    emit('reasoning.delta', { text: 'Check' })
    emit('reasoning.delta', { text: ' ' })
    emit('reasoning.delta', { text: 'the files.' })
    expect(state.messages.at(-1)?.reasoning).toEqual({ text: 'Check the files.', active: true })
    expect(state.messages.at(-1)?.text).toBe('')
    emit('message.delta', { text: 'The answer' })
    expect(state.messages.at(-1)?.reasoning?.active).toBe(false)
    expect(state.messages.at(-1)?.text).toBe('The answer')
    emit('message.complete', {})
    await vi.waitFor(() => expect(state.connection).toBe('ready'))
    expect(state.messages.some(message => message.reasoning?.text === 'Check the files.')).toBe(true)
    await chat.open('b', 'work')
    expect(state.messages.some(message => message.reasoning)).toBe(false)
    await chat.open('a', 'work')
    expect(state.messages.find(message => message.reasoning)?.reasoning).toEqual({ text: 'Check the files.', active: false })
    chat.dispose()
  })

  it('keeps a completed reasoning notice separate when it arrives after reply streaming', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const emit = (type: string, text: string) => gateway.onEvent({ type, session_id: 'runtime-a', payload: { text } })
    emit('reasoning.delta', 'Consider the options.')
    emit('message.delta', 'Final answer.')
    emit('reasoning.available', 'Consider the options.\n\nFinal answer.')
    expect(state.messages.at(-1)?.text).toBe('Final answer.')
    expect(state.messages.at(-1)?.reasoning).toEqual({ text: 'Consider the options.', active: false })
    expect(state.messages.filter(message => message.reasoning)).toHaveLength(1)
    emit('reasoning.available', 'Final answer.')
    expect(state.messages.at(-1)?.reasoning?.text).toBe('Consider the options.')
    chat.dispose()
  })

  it('handles completed reasoning blocks and stops their spinner on tools, errors, or disconnect', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const emit = (type: string, payload: Record<string, unknown>) => gateway.onEvent({ type, payload, session_id: 'runtime-a' })
    emit('reasoning.delta', { text: 'Consider options' })
    emit('reasoning.available', { text: 'Consider options carefully' })
    expect(state.messages.at(-1)?.reasoning).toEqual({ text: 'Consider options carefully', active: false })
    emit('reasoning.available', { text: 'Consider options carefully' })
    expect(state.messages.at(-1)?.reasoning?.text).toBe('Consider options carefully')
    emit('thinking.delta', { text: 'Waiting for the provider' })
    expect(state.activity).toBe('Waiting for the provider')
    expect(state.messages.at(-1)?.reasoning?.text).not.toContain('Waiting')
    emit('reasoning.delta', { text: '.' })
    emit('tool.start', { tool_id: 'one', name: 'terminal' })
    expect(state.messages.find(message => message.reasoning)?.reasoning?.active).toBe(false)
    emit('reasoning.delta', { text: 'Next step' })
    emit('error', { message: 'Provider failed' })
    expect(state.messages.at(-1)?.reasoning?.active).toBe(false)
    emit('reasoning.delta', { text: 'More' })
    gateway.onDisconnect(1006)
    expect(state.messages.at(-1)?.reasoning?.active).toBe(false)
    chat.dispose()
  })

  it('tracks compression for the selected runtime through heartbeats and completion', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const emit = (kind: string, text: string, session_id = 'runtime-a') => gateway.onEvent({ type: 'status.update', session_id, payload: { kind, text } })
    emit('compacting', 'Compacting another chat', 'runtime-b')
    expect(state.compressing).toBe(false)
    emit('compacting', 'Compacting context')
    expect(state.compressing).toBe(true)
    expect(state.running).toBe(false)
    expect(chat.canSend()).toBe(false)
    emit('heartbeat', 'Still working')
    expect(state.compressionDetail).toBe('Compacting context')
    emit('compacted', 'Context compaction complete')
    expect(state.compressing).toBe(false)
    state.draft = 'Next question'
    expect(chat.canSend()).toBe(true)
    emit('compressing', 'Compressing messages')
    gateway.onEvent({ type: 'message.delta', session_id: 'runtime-a', payload: { text: 'Continuing' } })
    expect(state.compressing).toBe(false)
    emit('compacting', 'Compacting context')
    await chat.open('b', 'work')
    expect(state.compressing).toBe(false)
    emit('compacting', 'Late status for A')
    expect(state.compressing).toBe(false)
    chat.dispose()
  })

  it('shows manual compression while awaiting the RPC and keeps pending work until ready', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const slow = deferred<unknown>()
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'slash.exec' ? slow.promise : ordinary(method, params, timeout))
    state.draft = '/compress'
    const sending = chat.send()
    expect(state.compressing).toBe(true)
    slow.resolve({ type: 'exec', status: 'pending', output: 'Compression running on compute host' })
    await sending
    expect(state.compressing).toBe(true)
    expect(state.sending).toBe(false)
    gateway.onEvent({ type: 'status.update', session_id: 'runtime-a', payload: { kind: 'ready', text: '' } })
    expect(state.compressing).toBe(false)
    state.draft = 'Next question'
    expect(chat.canSend()).toBe(true)
    chat.dispose()
  })

  it('does not resurrect compression when completion arrives before a pending RPC result', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const slow = deferred<unknown>()
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'slash.exec' ? slow.promise : ordinary(method, params, timeout))
    state.draft = '/compress'
    const sending = chat.send()
    gateway.onEvent({ type: 'status.update', session_id: 'runtime-a', payload: { kind: 'compacted', text: 'Complete' } })
    slow.resolve({ type: 'exec', status: 'pending', output: 'Started' })
    await sending
    expect(state.compressing).toBe(false)
    chat.dispose()
  })

  it('clears compression after a failed command or connection loss', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'slash.exec' ? Promise.reject(new RpcError(5030, 'Compression failed')) : ordinary(method, params, timeout))
    state.draft = '/compress'
    await chat.send()
    expect(state.compressing).toBe(false)
    expect(state.error).toBe('Compression failed')
    gateway.onEvent({ type: 'status.update', session_id: 'runtime-a', payload: { kind: 'compacting', text: 'Compacting context' } })
    gateway.onDisconnect(1006)
    expect(state.compressing).toBe(false)
    chat.dispose()
  })

  it('runs commands without an agent turn and shows escaped output in the transcript', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'slash.exec'
      ? Promise.resolve({ output: '<img src=x> Help text' }) : ordinary(method, params, timeout))
    state.draft = '/help'
    await chat.send()
    expect(gateway.request).toHaveBeenCalledWith('slash.exec', { session_id: 'runtime-a', profile: 'work', command: 'help' }, 300_000)
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false)
    expect(state.messages.at(-1)).toMatchObject({ kind: 'slash_command', name: '/help', text: '<img src=x> Help text' })
    expect(state.draft).toBe('')
    expect(state.running).toBe(false)
    await chat.open('b', 'work')
    expect(state.messages.some(row => row.kind === 'slash_command')).toBe(false)
    await chat.open('a', 'work')
    expect(state.messages.at(-1)?.kind).toBe('slash_command')
    chat.dispose()
  })

  it('submits command prompts once, hides expanded scaffolding, and prefills undo without submitting', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    let result = { type: 'skill', message: 'Private expanded skill instructions' }
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'slash.exec'
      ? Promise.resolve(result) : ordinary(method, params, timeout))
    state.draft = '/my-skill fix things'
    await chat.send()
    expect(gateway.request).toHaveBeenCalledWith('prompt.submit', { session_id: 'runtime-a', profile: 'work', text: 'Private expanded skill instructions' })
    expect(state.messages.at(-1)?.text).toBe('/my-skill fix things')
    expect(state.draft).toBe('')
    state.running = false
    result = { type: 'prefill', message: 'Previous editable prompt' }
    state.draft = '/undo'
    await chat.send()
    expect(state.draft).toBe('Previous editable prompt')
    expect(vi.mocked(gateway.request).mock.calls.filter(([method]) => method === 'prompt.submit')).toHaveLength(1)
    chat.dispose()
  })

  it('keeps failed commands out of ordinary prompts and blocks retries after an ambiguous failure', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    let error: Error = new RpcError(4011, 'Unknown command')
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'slash.exec'
      ? Promise.reject(error) : ordinary(method, params, timeout))
    state.draft = '/missing'
    await chat.send()
    expect(state.error).toBe('Unknown command')
    expect(state.draft).toBe('/missing')
    expect(state.running).toBe(false)
    error = new ConnectionLost()
    await chat.send()
    expect(state.uncertain).toBe(true)
    expect(chat.canSend()).toBe(false)
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'command.dispatch' || method === 'prompt.submit')).toBe(false)
    chat.dispose()
  })

  it('does not apply a delayed command directive to a different conversation', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const slow = deferred<unknown>()
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'slash.exec' ? slow.promise : ordinary(method, params, timeout))
    state.draft = '/plan changes'
    const sending = chat.send()
    await chat.open('b', 'work')
    state.draft = 'Draft in B'
    slow.resolve({ type: 'send', message: 'Wrong conversation' })
    await sending
    expect(state.draft).toBe('Draft in B')
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'prompt.submit')).toBe(false)
    chat.dispose()
  })

  it('keeps a newer draft when a prefill response arrives', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const slow = deferred<unknown>()
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'slash.exec' ? slow.promise : ordinary(method, params, timeout))
    state.draft = '/undo'
    const sending = chat.send()
    state.draft = 'Newer draft'
    slow.resolve({ type: 'prefill', message: 'Old text to edit' })
    await sending
    expect(state.draft).toBe('Newer draft')
    expect(state.messages.at(-1)?.text).toContain('Old text to edit')
    chat.dispose()
  })

  it('receives live approval events, isolates sessions, and answers the exact queue entry', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const approval = { request_id: 'command-one', command: 'rm -rf build', description: 'Deletes files', choices: ['once', 'deny'] }
    gateway.onEvent({ type: 'approval.request', session_id: 'runtime-b', payload: approval })
    expect(state.approvals).toEqual([])
    gateway.onEvent({ type: 'approval.request', session_id: 'runtime-a', payload: approval })
    gateway.onEvent({ type: 'approval.request', session_id: 'runtime-a', payload: approval })
    expect(state.approvals).toHaveLength(1)
    state.draft = 'Another question'
    expect(chat.canSend()).toBe(false)
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'approval.respond')).toBe(false)
    await chat.approve(state.approvals[0]!, 'always')
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'approval.respond')).toBe(false)
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'approval.respond' ? Promise.resolve({ resolved: 1 }) : ordinary(method, params, timeout))
    await chat.approve(state.approvals[0]!, 'once')
    expect(gateway.request).toHaveBeenCalledWith('approval.respond', { session_id: 'runtime-a', profile: 'work', request_id: 'command-one', choice: 'once' }, 300_000)
    expect(state.approvals).toEqual([])
    chat.dispose()
  })

  it('withdraws duplicate queue cards on request cancellation and preserves unrelated approvals', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const first = { request_id: 'one', command: 'First', choices: ['once', 'deny'] }
    const second = { request_id: 'two', command: 'Second', choices: ['once', 'deny'] }
    state.approvals = [first, second]
    gateway.onRequest({ id: 'server-one', method: 'approval', params: { ...first, session_id: 'runtime-a' } })
    gateway.onRequest({ id: 'server-two', method: 'approval', params: { ...second, session_id: 'runtime-a' } })
    gateway.onEvent({ type: 'request.cancel', session_id: 'runtime-a', payload: { id: 'server-one', reason: 'resolved' } })
    expect(state.approvals.map(entry => entry.request_id)).toEqual(['two'])
    expect(state.requests.map(entry => entry.id)).toEqual(['server-two'])
    await chat.approve(first, 'once')
    await chat.answer({ id: 'server-one', method: 'approval', params: first }, { choice: 'once' })
    expect(vi.mocked(gateway.request).mock.calls.some(([method]) => method === 'approval.respond' || method === 'request.answer')).toBe(false)
    gateway.onEvent({ type: 'approval.cancelled', session_id: 'runtime-a', payload: { request_ids: ['one'] } })
    expect(state.approvals).toHaveLength(1)
    gateway.onEvent({ type: 'approval.cancelled', session_id: 'runtime-a', payload: { request_ids: ['two'] } })
    expect(state.approvals).toEqual([])
    expect(state.requests).toEqual([])
    chat.dispose()
  })

  it('keeps an approval card after a failed decision and removes it only after a successful answer', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const request = { id: 'command-request', method: 'approval', params: { session_id: 'runtime-a', request_id: 'command', command: 'Command text', choices: ['once', 'deny'] } }
    gateway.onRequest(request)
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    let failed = true
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'request.answer' && failed ? Promise.reject(new RpcError(5030, 'Decision failed')) : ordinary(method, params, timeout))
    await chat.answer(request, { choice: 'deny' })
    expect(state.error).toBe('Decision failed')
    expect(state.requests).toHaveLength(1)
    expect(state.actionPending).toBe(false)
    failed = false
    await chat.answer(request, { choice: 'deny' })
    expect(gateway.request).toHaveBeenCalledWith('request.answer', { session_id: 'runtime-a', profile: 'work', id: 'command-request', result: { choice: 'deny' } }, 300_000)
    expect(state.requests).toEqual([])
    chat.dispose()
  })

  it('keeps concurrent live tool calls in the transcript and matches completions by ID', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    const emit = (type: string, payload: Record<string, unknown>, seq: number, session_id = 'runtime-a') => gateway.onEvent?.({ type, payload, seq, session_id })
    emit('message.start', {}, 1)
    emit('tool.start', { tool_id: 'one', name: 'terminal', context: 'npm test', args: { command: 'npm test' } }, 2)
    emit('tool.start', { tool_id: 'two', name: 'read_file', context: 'README.md', args: { path: 'README.md' } }, 3)
    expect(state.running).toBe(true)
    expect(state.activity).toBe('')
    expect(state.messages.filter(message => message.role === 'tool').map(message => message.tool?.status)).toEqual(['running', 'running'])
    emit('tool.complete', { tool_id: 'two', name: 'read_file', result: { content: 'File contents' }, summary: 'Read file', duration_s: 1.2 }, 4)
    expect(state.messages.find(message => message.tool?.id === 'one')?.tool?.status).toBe('running')
    const second = state.messages.find(message => message.tool?.id === 'two')!
    expect(second.tool).toMatchObject({ status: 'completed', args: '{\n  "path": "README.md"\n}', context: 'README.md', summary: 'Read file', duration: 1.2 })
    expect(JSON.parse(second.text)).toEqual({ content: 'File contents' })
    emit('tool.complete', { tool_id: 'one', name: 'terminal', result: 'Tests passed' }, 5)
    emit('tool.complete', { tool_id: 'one', result: 'Duplicate' }, 5)
    emit('tool.start', { tool_id: 'one', name: 'terminal' }, 6)
    emit('tool.start', { tool_id: 'other', name: 'terminal' }, 7, 'runtime-b')
    expect(state.messages.filter(message => message.role === 'tool')).toHaveLength(2)
    expect(state.messages.find(message => message.tool?.id === 'one')).toMatchObject({ text: 'Tests passed', tool: { status: 'completed' } })
    emit('message.delta', { text: 'The result.' }, 8)
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'The result.' })
    chat.dispose()
  })

  it('accepts a tool completion without its start and replaces live rows with durable history', async () => {
    const { state, api, gateway, chat } = setup('a')
    await chat.start('work')
    gateway.onEvent?.({ type: 'tool.complete', session_id: 'runtime-a', payload: { tool_id: 'one', name: 'terminal', result: 'Tests passed' } })
    expect(state.messages.at(-1)).toMatchObject({ role: 'tool', text: 'Tests passed', tool: { status: 'completed' } })
    vi.mocked(api.history).mockResolvedValue({ ...history('a'), messages: [{ id: 1, role: 'user', content: 'question-a' }, { id: 2, role: 'tool', tool_name: 'terminal', content: 'Tests passed' }, { id: 3, role: 'assistant', content: 'Done' }] })
    gateway.onEvent?.({ type: 'message.complete', session_id: 'runtime-a', payload: { status: 'completed' } })
    await vi.waitFor(() => expect(state.connection).toBe('ready'))
    expect(state.messages.filter(message => message.role === 'tool')).toEqual([{ key: 'row-2', rowId: 2, role: 'tool', name: 'terminal', text: 'Tests passed', kind: undefined, metadata: undefined }])
    chat.dispose()
  })

  it('loads session model choices and applies reasoning only to the current runtime', async () => {
    const { state, gateway, chat } = setup('a')
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    let effort = 'medium'
    vi.mocked(gateway.request).mockImplementation(async (method, params, timeout) => {
      if (method === 'model.options') return { model: 'first', provider: 'configured', providers: [{ slug: 'configured', name: 'Configured', models: ['first', 'second'], authenticated: true }] }
      if (method === 'config.get') return { value: effort }
      if (method === 'config.set') { effort = String(params?.value); return { value: effort } }
      return ordinary(method, params, timeout)
    })
    await chat.start('work')
    await chat.refreshSettings()
    expect(state.model).toBe('first')
    expect(state.reasoning).toBe('medium')
    await chat.chooseReasoning('high')
    expect(gateway.request).toHaveBeenCalledWith('config.set', { key: 'reasoning', value: 'high', scope: 'session', session_id: 'runtime-a', profile: 'work' })
    expect(state.reasoning).toBe('high')
    state.running = true
    await chat.chooseReasoning('ultra')
    expect(effort).toBe('high')
    chat.dispose()
  })

  it('uses the accepted model info and refuses picks outside the configured inventory', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    await chat.refreshSettings()
    const providers = [{ slug: 'configured', name: 'Configured', models: ['first', 'second'] }]
    state.modelProviders = providers
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    let selected = 'first'
    vi.mocked(gateway.request).mockImplementation(async (method, params, timeout) => {
      if (method === 'model.options') return { providers, model: selected, provider: 'configured' }
      if (method === 'config.get') return { value: 'high' }
      if (method === 'config.set') {
        selected = 'second'
        return { info: { model: 'second', provider: 'configured', reasoning_effort: 'high', reasoning_effort_wire: 'medium' }, warning: 'Hermes warning' }
      }
      return ordinary(method, params, timeout)
    })
    await chat.chooseModel({ model: 'unknown', provider: 'configured' })
    expect(vi.mocked(gateway.request).mock.calls.filter(call => call[0] === 'config.set')).toHaveLength(0)
    await chat.chooseModel({ model: 'second', provider: 'configured' })
    expect(state.model).toBe('second')
    expect(state.provider).toBe('configured')
    expect(state.reasoning).toBe('high')
    expect(state.reasoningWire).toBe('medium')
    expect(state.settingsNotice).toBe('Hermes warning')
    chat.dispose()
  })

  it('requires explicit confirmation and does not claim a deferred model is already active', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    await chat.refreshSettings()
    state.modelProviders = [{ slug: 'configured', name: 'Configured', models: ['first', 'second'] }]
    state.model = 'first'
    state.provider = 'configured'
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation(async (method, params, timeout) => {
      if (method === 'config.set') return params?.confirm_expensive_model
        ? { deferred: true, warning: 'Next turn uses the new model.' }
        : { confirm_required: true, confirm_message: 'This model costs more. Continue?' }
      return ordinary(method, params, timeout)
    })
    const choice = { model: 'second', provider: 'configured' }
    await chat.chooseModel(choice)
    expect(state.model).toBe('first')
    expect(state.modelConfirmation?.message).toContain('costs more')
    expect(vi.mocked(gateway.request).mock.calls.filter(call => call[0] === 'config.set')).toHaveLength(1)
    state.draft = 'Question'
    expect(chat.canSend()).toBe(false)
    await chat.chooseModel(choice, true)
    expect(state.modelConfirmation).toBeUndefined()
    expect(state.model).toBe('first')
    expect(state.settingsNotice).toContain('queued for the next turn')
    expect(gateway.request).toHaveBeenLastCalledWith('config.get', expect.anything())
    expect(vi.mocked(gateway.request).mock.calls.filter(call => call[0] === 'config.set').at(-1)?.[1]).toMatchObject({ value: "'second' --provider 'configured' --session", session_id: 'runtime-a', scope: 'session', confirm_expensive_model: true })
    chat.dispose()
  })

  it('creates a session before changing settings and preserves the unsent draft', async () => {
    const { state, gateway, chat } = setup()
    await chat.start('work')
    await chat.refreshSettings()
    state.draft = 'Keep this unsent message'
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation(async (method, params, timeout) => method === 'config.set' ? { value: params?.value } : ordinary(method, params, timeout))
    await chat.chooseReasoning('low')
    expect(state.draft).toBe('Keep this unsent message')
    expect(gateway.request).toHaveBeenCalledWith('session.create', expect.objectContaining({ source: 'desktop', profile: 'work' }))
    expect(gateway.request).toHaveBeenCalledWith('config.set', { key: 'reasoning', value: 'low', scope: 'session', session_id: 'runtime-new', profile: 'work' })
    chat.dispose()
  })

  it('ignores stale inventories and setting replies after switching conversations', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    await chat.refreshSettings()
    const oldInventory = deferred<unknown>()
    const oldSetting = deferred<unknown>()
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => {
      if (method === 'model.options' && params?.session_id === 'runtime-a') return oldInventory.promise
      if (method === 'config.set') return oldSetting.promise
      if (method === 'model.options') return Promise.resolve({ providers: [], model: 'model-b', provider: 'provider-b' })
      return ordinary(method, params, timeout)
    })
    const read = chat.refreshSettings()
    const change = chat.chooseReasoning('high')
    await Promise.resolve()
    await chat.open('b', 'work')
    oldInventory.resolve({ providers: [], model: 'wrong-a', provider: 'provider-a' })
    oldSetting.resolve({ value: 'ultra' })
    await Promise.all([read, change])
    await chat.refreshSettings()
    expect(state.model).toBe('model-b')
    expect(state.reasoning).toBe('medium')
    expect(state.settingsPending).toBe(false)
    chat.dispose()
  })

  it('preserves newer session info and never retries an ambiguous setting mutation', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    await chat.refreshSettings()
    const delayed = deferred<unknown>()
    const ordinary = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'config.set' ? delayed.promise : ordinary(method, params, timeout))
    const change = chat.chooseReasoning('ultra')
    await Promise.resolve()
    gateway.onEvent?.({ type: 'session.info', session_id: 'runtime-a', payload: { reasoning_effort: 'ultra', reasoning_effort_wire: 'max' } })
    delayed.resolve({ value: 'high' })
    await change
    expect(state.reasoning).toBe('ultra')
    expect(state.reasoningWire).toBe('max')
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'config.set' ? Promise.reject(new ConnectionLost()) : ordinary(method, params, timeout))
    const before = vi.mocked(gateway.request).mock.calls.filter(call => call[0] === 'config.set').length
    await chat.chooseReasoning('low')
    expect(state.settingsError).toContain('may have reached Hermes')
    expect(vi.mocked(gateway.request).mock.calls.filter(call => call[0] === 'config.set')).toHaveLength(before + 1)
    chat.dispose()
  })

  it('debounces search, combines title and server matches, and preserves the current chat', async () => {
    vi.useFakeTimers()
    const { state, api, chat } = setup('a')
    await chat.start('work')
    state.sessions = [{ id: 'a', title: 'Local title', profile: 'work' }]
    const search = vi.spyOn(api, 'searchSessions').mockResolvedValue({ results: [
      { id: 'a', title: 'Local title', profile: 'work' }, { id: 'old', title: 'Older chat', profile: 'work' },
    ] })
    chat.searchConversations('loc')
    chat.searchConversations('local')
    expect(state.searchLoading).toBe(true)
    expect(chat.visibleSessions().map(session => session.id)).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(250)
    expect(search).toHaveBeenCalledExactlyOnceWith('local', 'work')
    expect(chat.visibleSessions().map(session => session.id)).toEqual(['a', 'old'])
    expect(state.selected).toBe('a')
    expect(state.runtime).toBe('runtime-a')
    chat.searchConversations('')
    expect(chat.visibleSessions()).toBe(state.sessions)
    expect(state.searchResults).toEqual([])
    expect(state.searchLoading).toBe(false)
    chat.dispose()
  })

  it('discards obsolete search responses after a newer query, clearing, or disposal', async () => {
    vi.useFakeTimers()
    const { state, api, chat } = setup()
    const first = deferred<{ results: [] }>()
    const second = deferred<{ results: [] }>()
    vi.spyOn(api, 'searchSessions').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    chat.searchConversations('first')
    await vi.advanceTimersByTimeAsync(250)
    chat.searchConversations('second')
    await vi.advanceTimersByTimeAsync(250)
    first.resolve({ results: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.searchLoading).toBe(true)
    chat.searchConversations('')
    second.resolve({ results: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.searchQuery).toBe('')
    expect(state.searchResults).toEqual([])
    chat.searchConversations('third')
    chat.dispose()
    await vi.advanceTimersByTimeAsync(250)
    expect(api.searchSessions).toHaveBeenCalledTimes(2)
  })

  it('reports search failures and handles expired login without changing the regular list', async () => {
    vi.useFakeTimers()
    const { state, api, chat } = setup('a')
    await chat.start('work')
    const sessions = state.sessions
    vi.spyOn(api, 'searchSessions').mockRejectedValueOnce(new HttpError(503, 'Search unavailable')).mockRejectedValueOnce(new HttpError(401, 'Session expired'))
    chat.searchConversations('logs')
    await vi.advanceTimersByTimeAsync(250)
    expect(state.searchError).toBe('Search unavailable')
    expect(state.searchLoading).toBe(false)
    expect(state.sessions).toBe(sessions)
    chat.searchConversations('logs')
    await vi.advanceTimersByTimeAsync(250)
    expect(state.connection).toBe('expired')
    chat.dispose()
  })

  it('marks offscreen completed replies unread and clears them after successful recovery', async () => {
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    gateway.onEvent?.({ type: 'message.complete', session_id: 'runtime-b', seq: 1 })
    expect(state.unreadReplies).toEqual([])
    await chat.open('b', 'work')
    gateway.onEvent?.({ type: 'message.complete', session_id: 'runtime-a', seq: 2, payload: { status: 'completed' } })
    expect(chat.hasUnreadReply({ id: 'a', profile: 'work' })).toBe(true)
    expect(chat.hasUnreadReply({ id: 'a', profile: 'other' })).toBe(false)
    expect(state.selected).toBe('b')
    expect(state.messages[0]?.text).toBe('question-b')
    await chat.open('a', 'work')
    expect(chat.hasUnreadReply({ id: 'a', profile: 'work' })).toBe(false)
    await chat.open('b', 'work')
    gateway.onEvent?.({ type: 'message.complete', session_id: 'runtime-a', seq: 2 })
    expect(state.unreadReplies).toEqual([])
    gateway.onEvent?.({ type: 'message.complete', session_id: 'runtime-a', seq: 3, payload: { status: 'interrupted' } })
    expect(state.unreadReplies).toEqual([])
    gateway.onEvent?.({ type: 'background.complete', session_id: 'runtime-a', seq: 4, payload: { task_id: 'side', text: 'Done' } })
    expect(chat.hasUnreadReply({ id: 'a', profile: 'work' })).toBe(true)
    chat.dispose()
  })

  it('recovers background tasks independently of the main turn and scopes them to each conversation', async () => {
    const { state, gateway, chat } = setup('a')
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation(async (method, params, timeout) => method === 'subagent.list'
      ? { subagents: params?.session_id === 'runtime-a' ? [{ subagent_id: 'child', goal: 'Check logs', status: 'running' }] : [] }
      : ordinaryRequest(method, params, timeout))
    await chat.start('work')
    await vi.waitFor(() => expect(state.tasks[0]?.key).toBe('child'))
    expect(state.running).toBe(false)
    expect(chat.sessionStatus({ id: 'a', profile: 'work' })).toBe('working')
    gateway.onEvent?.({ type: 'subagent.complete', session_id: 'runtime-b', payload: { subagent_id: 'child', status: 'failed' } })
    expect(state.tasks[0]?.status).toBe('running')
    gateway.onEvent?.({ type: 'subagent.complete', session_id: 'runtime-a', payload: { subagent_id: 'child', status: 'completed', summary: 'Logs checked' } })
    expect(state.tasks[0]).toMatchObject({ status: 'completed', summary: 'Logs checked' })
    await chat.open('b', 'work')
    expect(state.tasks).toEqual([])
    await chat.open('a', 'work')
    expect(state.tasks[0]?.summary).toBe('Logs checked')
    chat.dispose()
  })

  it('does not let a delayed roster overwrite a completion event or a different conversation', async () => {
    const { state, gateway, chat } = setup('a')
    const delayed = deferred<unknown>()
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'subagent.list' && params?.session_id === 'runtime-a'
      ? delayed.promise : ordinaryRequest(method, params, timeout))
    await chat.start('work')
    gateway.onEvent?.({ type: 'subagent.complete', session_id: 'runtime-a', payload: { subagent_id: 'child', goal: 'Check logs', status: 'completed' } })
    delayed.resolve({ subagents: [{ subagent_id: 'child', status: 'running' }] })
    await Promise.resolve()
    expect(state.tasks[0]?.status).toBe('completed')
    await chat.open('b', 'work')
    expect(state.tasks).toEqual([])
    chat.dispose()
  })

  it('polls idle-session tasks, rejects replies after switching, and stops polling on disposal', async () => {
    vi.useFakeTimers()
    const { state, gateway, chat } = setup('a')
    const delayed = deferred<unknown>()
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    let calls = 0
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'subagent.list' && ++calls === 2
      ? delayed.promise : ordinaryRequest(method, params, timeout))
    await chat.start('work')
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)
    await chat.open('b', 'work')
    delayed.resolve({ subagents: [{ subagent_id: 'a-child', goal: 'Wrong conversation', status: 'running' }] })
    await vi.advanceTimersByTimeAsync(0)
    expect(state.tasks).toEqual([])
    chat.dispose()
    const disposedCalls = calls
    await vi.advanceTimersByTimeAsync(10000)
    expect(calls).toBe(disposedCalls)
  })

  it('keeps chat usable when the task roster is unsupported', async () => {
    const { state, gateway, chat } = setup('a')
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'subagent.list'
      ? Promise.reject(new RpcError(-32601, 'Method not found')) : ordinaryRequest(method, params, timeout))
    await chat.start('work')
    expect(state.connection).toBe('ready')
    await vi.waitFor(() => expect(state.taskError).toBe('Background task status unavailable.'))
    gateway.onEvent?.({ type: 'subagent.start', session_id: 'runtime-a', payload: { subagent_id: 'child', goal: 'Check logs' } })
    expect(state.tasks[0]?.goal).toBe('Check logs')
    chat.dispose()
  })

  it('does not delay chat startup for an optional running-status request', async () => {
    const { state, gateway, chat } = setup('a')
    const delayed = deferred<unknown>()
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'session.active_list'
      ? delayed.promise : ordinaryRequest(method, params, timeout))
    await chat.start('work')
    expect(state.connection).toBe('ready')
    expect(state.runtime).toBe('runtime-a')
    delayed.resolve({ sessions: [] })
    chat.dispose()
  })

  it('uses stored IDs and profile-scoped runtime status for background conversations', async () => {
    vi.useFakeTimers()
    const { state, gateway, chat } = setup('a')
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    let active = [
      { id: 'runtime-b', session_key: 'b', status: 'working' },
      { id: 'runtime-c', session_key: 'c', status: 'starting' },
    ]
    vi.mocked(gateway.request).mockImplementation(async (method, params, timeout) => method === 'session.active_list'
      ? { sessions: active } : ordinaryRequest(method, params, timeout))
    await chat.start('work')
    expect(gateway.request).toHaveBeenCalledWith('session.active_list', { profile: 'work' })
    expect(chat.sessionStatus({ id: 'b', profile: 'work' })).toBe('working')
    expect(chat.sessionStatus({ id: 'b', profile: 'other' })).toBeUndefined()
    expect(chat.sessionStatus({ id: 'c', profile: 'work' })).toBeUndefined()
    active = [{ id: 'runtime-b', session_key: 'b', status: 'waiting' }]
    await vi.advanceTimersByTimeAsync(5000)
    expect(chat.sessionStatus({ id: 'b', profile: 'work' })).toBe('waiting')
    active = []
    await vi.advanceTimersByTimeAsync(5000)
    expect(chat.sessionStatus({ id: 'b', profile: 'work' })).toBeUndefined()
    chat.dispose()
    const calls = vi.mocked(gateway.request).mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(gateway.request).toHaveBeenCalledTimes(calls)
    expect(state.running).toBe(false)
  })

  it('keeps a newly running conversation marked when switching away despite a delayed status response', async () => {
    vi.useFakeTimers()
    const { state, gateway, chat } = setup('a')
    await chat.start('work')
    gateway.onEvent({ type: 'message.start', session_id: 'runtime-a', seq: 1, payload: {} })
    expect(chat.sessionStatus({ id: 'a', profile: 'work' })).toBe('working')
    const delayed = deferred<unknown>()
    const ordinaryRequest = vi.mocked(gateway.request).getMockImplementation()!
    vi.mocked(gateway.request).mockImplementation((method, params, timeout) => method === 'session.active_list'
      ? delayed.promise : ordinaryRequest(method, params, timeout))
    await vi.advanceTimersByTimeAsync(5000)
    await chat.open('b', 'work')
    delayed.resolve({ sessions: [] })
    await Promise.resolve()
    expect(state.selected).toBe('b')
    expect(chat.sessionStatus({ id: 'a', profile: 'work' })).toBe('working')
    expect(chat.sessionStatus({ id: 'b', profile: 'work' })).toBeUndefined()
    chat.dispose()
  })

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
    expect(gateway.request).toHaveBeenCalledWith('session.resume', expect.objectContaining({ source: 'desktop', session_id: 'a', profile: 'work', omit_messages: true, close_on_disconnect: false }))
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
    const resumeCalls = vi.mocked(gateway.request).mock.calls.filter(([method]) => method === 'session.resume')
    expect(resumeCalls).toHaveLength(2)
    expect(resumeCalls.every(([, params]) => params?.source === 'desktop')).toBe(true)
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
