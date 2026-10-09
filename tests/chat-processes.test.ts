import { afterEach, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { ChatClient, initialState } from '../src/hermes/chat'
import { HermesApi } from '../src/hermes/api'
import { ConnectionLost, Gateway } from '../src/hermes/gateway'
import { reconcileProcesses } from '../src/hermes/processes'

it.each([{ status: ['running'] }, { status: { toString: () => 'running' } }, { status: ['exited'] }, { status: { toString: () => 'exited' } }])('rejects a coerced process roster status $status', ({ status }) => {
  expect(reconcileProcesses([], [{ session_id: 'invalid', status }])).toEqual([])
})

const clients: ChatClient[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); vi.useRealTimers() })
const process = (id = 'p', status = 'running') => ({ session_id: id, command: 'sleep 100', status, uptime_seconds: 12, output_tail: 'ready\n' })
function setup() {
  const state = reactive(initialState())
  const api = new HermesApi(), gateway = new Gateway()
  let rows: Array<ReturnType<typeof process> & { exit_code?: number }> = [process()]
  vi.spyOn(api, 'request').mockResolvedValue({ auth_required: false })
  vi.spyOn(api, 'sessions').mockResolvedValue({ sessions: [{ id: 'a', profile: 'work' }, { id: 'b', profile: 'work' }], total: 2 })
  vi.spyOn(api, 'history').mockImplementation(async (id, profile) => ({ session_id: id, profile, pagination: { returned: 1, offset: 0, limit: 50 }, messages: [{ id: 1, role: 'user', content: `question-${id}` }] }))
  vi.spyOn(gateway, 'connect').mockResolvedValue()
  const request = vi.spyOn(gateway, 'request').mockImplementation(async (method, params) => {
    if (method === 'session.resume') return { session_id: `runtime-${params?.profile}-${params?.session_id}`, stored_session_id: params?.session_id, info: { running: false } }
    if (method === 'process.list') return { processes: params?.session_id === 'runtime-work-a' ? rows : [] }
    if (method === 'session.active_list') return { sessions: [] }
    if (method === 'subagent.list') return { subagents: [] }
    if (method === 'approval.pending') return { approvals: [] }
    if (method === 'model.options') return { providers: [] }
    return {}
  })
  const chat = new ChatClient(state, api, gateway, { origin: 'https://hermes.test', selected: () => 'a', select: () => {} })
  clients.push(chat)
  return { chat, state, gateway, request, api, rows: (value: typeof rows) => { rows = value } }
}

it('keeps the streaming assistant tail intact when a process completes midstream', async () => {
  const { chat, state, gateway, rows } = setup()
  await chat.start('work')
  gateway.onEvent({ type: 'message.start', session_id: state.runtime, seq: 1, payload: {} })
  gateway.onEvent({ type: 'reasoning.delta', session_id: state.runtime, seq: 2, payload: { text: 'Thinking' } })
  const assistant = state.messages.at(-1)!
  rows([{ ...process('p', 'exited'), output_tail: 'Process finished' }])
  await chat.refreshProcesses()
  expect(state.messages.at(-1)).toBe(assistant)
  gateway.onEvent({ type: 'reasoning.delta', session_id: state.runtime, seq: 3, payload: { text: ' more' } })
  gateway.onEvent({ type: 'message.delta', session_id: state.runtime, seq: 4, payload: { text: 'First' } })
  await chat.refreshProcesses()
  gateway.onEvent({ type: 'message.delta', session_id: state.runtime, seq: 5, payload: { text: ' second' } })
  gateway.onEvent({ type: 'reasoning.available', session_id: state.runtime, seq: 6, payload: { text: 'Thinking more' } })
  expect(state.messages.filter(row => row.role === 'assistant')).toEqual([assistant])
  expect(assistant).toMatchObject({ text: 'First second', reasoning: { text: 'Thinking more' } })
  expect(state.messages.filter(row => row.kind === 'process_complete')).toHaveLength(1)
})

it.each(['message.delta', 'reasoning.available'])('preserves the recovered assistant while replaying buffered %s before a stalled process poll', async first => {
  const { chat, state, gateway, request, rows } = setup()
  await chat.start('work')
  gateway.onEvent({ type: 'message.start', session_id: state.runtime, seq: 1, payload: {} })
  gateway.onEvent({ type: 'reasoning.delta', session_id: state.runtime, seq: 2, payload: { text: 'Thinking' } })
  gateway.onEvent({ type: 'message.delta', session_id: state.runtime, seq: 3, payload: { text: 'partial' } })
  rows([{ ...process('p', 'exited'), output_tail: 'Process finished' }])
  await chat.refreshProcesses()
  const completionKey = state.messages.find(row => row.kind === 'process_complete')!.key
  await chat.open('b', 'work')
  expect(state.running).toBe(false)

  const approvals = deferred<{ approvals: [] }>(), poll = deferred<unknown>()
  const ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => {
    if (method === 'session.resume' && params?.session_id === 'a') return Promise.resolve({
      session_id: 'runtime-work-a', stored_session_id: 'a', info: { running: true },
      inflight: { user: 'question-a', assistant: 'partial' },
    })
    if (method === 'approval.pending' && params?.session_id === 'runtime-work-a') return approvals.promise
    if (method === 'process.list' && params?.session_id === 'runtime-work-a') return poll.promise
    return ordinary(method, params, timeout)
  })
  request.mockClear()
  const opening = chat.open('a', 'work')
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith('approval.pending', { session_id: 'runtime-work-a', profile: 'work' }))
  const assistant = state.messages.find(row => row.role === 'assistant')!
  expect(assistant).toMatchObject({ key: 'inflight-assistant', text: 'partial', reasoning: { text: 'Thinking' } })
  const events = first === 'message.delta' ? ['message.delta', 'reasoning.available'] : ['reasoning.available', 'message.delta']
  events.forEach((type, index) => gateway.onEvent({
    type, session_id: 'runtime-work-a', seq: 4 + index,
    payload: { text: type === 'message.delta' ? ' continued' : 'Thinking more' },
  }))
  expect(assistant.text).toBe('partial')
  expect(assistant.reasoning?.text).toBe('Thinking')
  approvals.resolve({ approvals: [] })
  await opening
  expect(request).toHaveBeenCalledWith('process.list', { session_id: 'runtime-work-a', profile: 'work' })
  expect(state.messages.filter(row => row.role === 'assistant')).toEqual([assistant])
  expect(state.messages.at(-1)).toBe(assistant)
  expect(assistant).toMatchObject({ key: 'inflight-assistant', text: 'partial continued', reasoning: { text: 'Thinking more' } })
  expect(state.messages.filter(row => row.kind === 'process_complete').map(row => row.key)).toEqual([completionKey])
  poll.resolve({ processes: [{ ...process('p', 'exited'), output_tail: 'Final process output' }] })
  await vi.waitFor(() => expect(state.messages.find(row => row.key === completionKey)?.text).toBe('Final process output'))
  expect(state.messages.filter(row => row.role === 'assistant')).toEqual([assistant])
  expect(state.messages.at(-1)).toBe(assistant)
})

it('recovers owned processes and keeps activity separate from foreground execution', async () => {
  const { chat, state, request } = setup()
  await chat.start('work')
  await vi.waitFor(() => expect(state.processes).toHaveLength(1))
  expect(request).toHaveBeenCalledWith('process.list', { session_id: 'runtime-work-a', profile: 'work' })
  expect(state.processes[0]).toMatchObject({ id: 'p', command: 'sleep 100', status: 'running', output: 'ready\n' })
  expect(state.running).toBe(false)
  expect(chat.sessionStatus({ id: 'a', profile: 'work' })).toBe('working')
  state.draft = 'Next question'
  expect(chat.canSend()).toBe(true)
})

it('appends bounded live output offscreen, rejects duplicate events, and recovers missing events by polling', async () => {
  const { chat, state, gateway, rows } = setup()
  await chat.start('work')
  await chat.open('b', 'work')
  const event = { type: 'agent.terminal.output', session_id: 'runtime-work-a', seq: 1, payload: { process_id: 'p', chunk: 'x'.repeat(5000) } }
  gateway.onEvent(event)
  expect(state.processesBySession.get(JSON.stringify(['work', 'a']))?.[0].output).toBe('x'.repeat(4000))
  gateway.onEvent({ ...event, payload: { process_id: 'p', chunk: 'duplicate' } })
  expect(state.processes).toEqual([])
  expect(state.running).toBe(false)
  rows([{ ...process(), output_tail: 'polled output' }])
  await chat.refreshProcesses()
  await chat.open('a', 'work')
  expect(state.processes[0].output).toBe('polled output')
})

it('records an offscreen exit once at a stable transcript position without touching the selected chat', async () => {
  const { chat, state, rows, gateway } = setup()
  await chat.start('work')
  await chat.open('b', 'work')
  rows([{ ...process('p', 'exited'), exit_code: 7, output_tail: 'failed output' }])
  await chat.refreshProcesses()
  expect(chat.sessionStatus({ id: 'a', profile: 'work' })).toBeUndefined()
  expect(state.messages.some(message => message.kind === 'process_complete')).toBe(false)
  expect(state.running).toBe(false)
  await chat.open('a', 'work')
  expect(state.messages[0]).toMatchObject({ kind: 'process_complete', text: 'failed output', metadata: { process_id: 'p', exit_code: 7 } })
  state.messages.push({ key: 'new', role: 'user', text: 'New unrelated question' })
  await chat.refreshProcesses()
  gateway.onEvent({ type: 'agent.terminal.output', session_id: 'runtime-work-a', seq: 1, payload: { process_id: 'p', chunk: 'late' } })
  expect(state.processes[0].status).toBe('exited')
  expect(state.messages.filter(message => message.kind === 'process_complete')).toHaveLength(1)
  expect(state.messages[0].text).toBe('failed output')
})

it('treats disappearance and terminal-tab closure as unknown, never fabricated successful completion', async () => {
  const { chat, state, rows, gateway } = setup()
  await chat.start('work')
  gateway.onEvent({ type: 'terminal.close', session_id: 'runtime-work-a', seq: 1, payload: { process_id: 'p' } })
  await vi.waitFor(() => expect(state.processes[0].status).toBe('running'))
  rows([])
  await chat.refreshProcesses()
  expect(state.processes[0].status).toBe('unknown')
  expect(chat.sessionStatus({ id: 'a', profile: 'work' })).toBeUndefined()
  expect(state.messages.some(message => message.kind === 'process_complete')).toBe(false)
  state.messages.push({ key: 'later', role: 'user', text: 'Unrelated' })
  rows([process()])
  await chat.refreshProcesses()
  expect(state.processes[0].status).toBe('running')
})

it('stops only one owned process, retains its bounded exit result, and leaves assistant Stop independent', async () => {
  const { chat, state, request, rows } = setup()
  await chat.start('work')
  const ordinary = request.getMockImplementation()!
  request.mockImplementation(async (method, params, timeout) => {
    if (method === 'process.kill') {
      expect(Object.keys(params || {}).sort()).toEqual(['process_id', 'profile', 'session_id'])
      rows([{ ...process('p', 'exited'), exit_code: -15, output_tail: 'last output' }])
      return { status: 'killed', exit_code: -15, output: 'last output', completion_reason: 'killed' }
    }
    return ordinary(method, params, timeout)
  })
  state.running = true
  await chat.stopProcess('p')
  expect(request).toHaveBeenCalledWith('process.kill', { session_id: 'runtime-work-a', process_id: 'p', profile: 'work' })
  expect(request.mock.calls.some(([method]) => ['process.stop', 'session.interrupt'].includes(method))).toBe(false)
  expect(state.running).toBe(true)
  expect(state.messages.at(-1)).toMatchObject({ kind: 'process_complete', text: 'last output' })
  await chat.stopProcess('foreign')
  await chat.stopProcess('p')
  expect(request.mock.calls.filter(([method]) => method === 'process.kill')).toHaveLength(1)
  await chat.stop()
  expect(request).toHaveBeenCalledWith('session.interrupt', { session_id: 'runtime-work-a', profile: 'work' }, 300_000)
})

it.each([
  { output: {}, exit_code: '0', completion_reason: {} },
  { output: 123, exit_code: NaN, completion_reason: 123 },
  { output: null, exit_code: Infinity, completion_reason: ['killed'] },
])('validates malformed optional process kill fields without losing the confirmed exit ($exit_code)', async fields => {
  const { chat, state, request, rows } = setup()
  await chat.start('work')
  const ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => {
    if (method === 'process.kill') { rows([]); return Promise.resolve({ status: 'killed', ...fields }) }
    return ordinary(method, params, timeout)
  })
  await chat.stopProcess('p')
  expect(state.processError).toBe('')
  expect(state.processes[0]).toMatchObject({ status: 'exited', output: 'ready\n', reason: 'killed' })
  expect(state.processes[0].exitCode).toBeUndefined()
  expect(state.messages.at(-1)).toMatchObject({ kind: 'process_complete', text: 'ready\n', metadata: { exit_code: undefined, display_text: 'sleep 100 · killed' } })
})

it('uses a safe fallback for a malformed process kill error', async () => {
  const { chat, state, request } = setup()
  await chat.start('work')
  request.mockResolvedValueOnce({ status: ['killed'], error: { private: 'not a message' } })
  await chat.stopProcess('p')
  expect(state.processError).toBe('Hermes did not confirm the process stopped. Check its status before retrying.')
  expect(state.processes[0].status).toBe('running')
})

it.each(['error', 'not_found', 'invalid'])('keeps the process and reports a failed %s stop acknowledgement', async status => {
  const { chat, state, request } = setup()
  await chat.start('work')
  const ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => method === 'process.kill' ? Promise.resolve({ status, error: 'Cannot stop process' }) : ordinary(method, params, timeout))
  await chat.stopProcess('p')
  expect(state.processError).toContain('Cannot stop process')
  expect(state.processes[0].status).toBe('running')
  expect(state.messages.some(message => message.kind === 'process_complete')).toBe(false)
})

it.each(['running', 'exited', 'missing'])('applies roster discovery and %s lifecycle despite a noisy sibling process', async status => {
  const { chat, state, request, gateway, rows } = setup()
  rows([process(), process('quiet')])
  await chat.start('work')
  const slow = deferred<unknown>(), ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => method === 'process.list' ? slow.promise : ordinary(method, params, timeout))
  const polling = chat.refreshProcesses()
  gateway.onEvent({ type: 'agent.terminal.output', session_id: state.runtime, seq: 1, payload: { process_id: 'p', chunk: 'fresh' } })
  slow.resolve({ processes: [process(), process('new'), ...(status === 'missing' ? [] : [{ ...process('quiet', status), output_tail: 'quiet snapshot' }])] })
  await polling
  expect(state.processes.find(row => row.id === 'new')?.status).toBe('running')
  expect(state.processes.find(row => row.id === 'quiet')).toMatchObject({ status: status === 'missing' ? 'unknown' : status, output: status === 'missing' ? 'ready\n' : 'quiet snapshot' })
  expect(state.processes.find(row => row.id === 'p')?.output).toBe('ready\nfresh')
})

it('applies an authoritative exit for the noisy process while preserving output received during the poll', async () => {
  const { chat, state, request, gateway } = setup()
  await chat.start('work')
  const slow = deferred<unknown>()
  request.mockImplementationOnce(() => slow.promise)
  const polling = chat.refreshProcesses()
  gateway.onEvent({ type: 'agent.terminal.output', session_id: state.runtime, seq: 1, payload: { process_id: 'p', chunk: 'fresh' } })
  slow.resolve({ processes: [{ ...process('p', 'exited'), exit_code: 7 }] })
  await polling
  expect(state.processes[0]).toMatchObject({ status: 'exited', output: 'ready\nfresh', exitCode: 7 })
  expect(state.messages.at(-1)).toMatchObject({ kind: 'process_complete', text: 'ready\nfresh' })
})

it('rejects a poll snapshot overtaken by live output and coalesces overlapping polls', async () => {
  const { chat, state, request, gateway } = setup()
  await chat.start('work')
  const slow = deferred<unknown>(), ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => method === 'process.list' ? slow.promise : ordinary(method, params, timeout))
  request.mockClear()
  const polling = chat.refreshProcesses()
  await chat.refreshProcesses()
  expect(request.mock.calls.filter(([method]) => method === 'process.list')).toHaveLength(1)
  gateway.onEvent({ type: 'agent.terminal.output', session_id: 'runtime-work-a', seq: 1, payload: { process_id: 'p', chunk: 'fresh' } })
  slow.resolve({ processes: [process()] })
  await polling
  expect(state.processes[0].output).toBe('ready\nfresh')
})

it('recovers after disconnect without allowing a pre-disconnect poll to overwrite the new roster', async () => {
  const { chat, state, request, gateway, rows } = setup()
  await chat.start('work')
  const slow = deferred<unknown>(), ordinary = request.getMockImplementation()!
  request.mockImplementationOnce(() => slow.promise)
  const old = chat.refreshProcesses()
  gateway.onDisconnect(1006)
  rows([{ ...process(), output_tail: 'reconnected' }])
  request.mockImplementation(ordinary)
  await chat.connect()
  await vi.waitFor(() => expect(state.processes[0].output).toBe('reconnected'))
  slow.resolve({ processes: [{ ...process(), output_tail: 'stale' }] })
  await old
  expect(state.processes[0].output).toBe('reconnected')
})

it('isolates a delayed process stop and completion from another profile with the same stored chat ID', async () => {
  const { chat, state, request } = setup()
  await chat.start('work')
  const slow = deferred<unknown>(), ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => method === 'process.kill' ? slow.promise : ordinary(method, params, timeout))
  const stopping = chat.stopProcess('p')
  await chat.open('a', 'personal')
  slow.resolve({ status: 'already_exited', exit_code: 0, output: 'Work output' })
  await stopping
  expect(state.processes).toEqual([])
  expect(state.messages.map(message => message.text)).toEqual(['question-a'])
  expect(state.processError).toBe('')
  expect(state.processStops.size).toBe(0)
  expect(chat.sessionStatus({ id: 'a', profile: 'personal' })).toBeUndefined()
  await chat.open('a', 'work')
  expect(state.messages[0]).toMatchObject({ kind: 'process_complete', text: 'Work output' })
})

it.each(['replacement', 'deletion'])('ignores a failed process stop after same-chat %s', async transition => {
  const { chat, state, request, api } = setup()
  await chat.start('work')
  const slow = deferred<unknown>(), ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => {
    if (method === 'process.kill') return slow.promise
    if (method === 'session.resume') return Promise.resolve({ session_id: 'replacement-runtime', stored_session_id: 'a', info: { running: false } })
    return ordinary(method, params, timeout)
  })
  const stopping = chat.stopProcess('p')
  if (transition === 'replacement') await chat.open('a', 'work')
  else { vi.spyOn(api, 'delete').mockResolvedValue({}); await chat.deleteSelected() }
  slow.reject(new Error('Old runtime failure'))
  await stopping
  expect(state.processError).toBe('')
  expect(state.processErrorsBySession.has(JSON.stringify(['work', 'a']))).toBe(transition === 'replacement')
  expect(state.processStops.size).toBe(0)
})

it.each(['killed', 'error'])('ignores a %s stop settlement after deleting and recreating the same runtime scope', async status => {
  const { chat, state, request, api } = setup()
  await chat.start('work')
  const slow = deferred<unknown>(), ordinary = request.getMockImplementation()!
  let kills = 0
  request.mockImplementation((method, params, timeout) => method === 'process.kill' && ++kills === 1 ? slow.promise : ordinary(method, params, timeout))
  const stopping = chat.stopProcess('p')
  vi.spyOn(api, 'delete').mockResolvedValue({})
  await chat.deleteSelected()
  await chat.open('a', 'work')
  const newStop = deferred<unknown>()
  request.mockImplementation((method, params, timeout) => method === 'process.kill' ? newStop.promise : ordinary(method, params, timeout))
  const replacementStop = chat.stopProcess('p')
  slow.resolve({ status, error: 'Obsolete failure', output: 'Obsolete output' })
  await stopping
  expect(state.processes[0].status).toBe('running')
  expect(state.processError).toBe('')
  expect(state.processStops.size).toBe(1)
  newStop.resolve({ status: 'error', error: 'Current failure' })
  await replacementStop
  expect(state.processError).toBe('Current failure')
  expect(state.processStops.size).toBe(0)
})

it('rejects the old runtime roster after remapping the same chat to a replacement runtime', async () => {
  const { chat, state, request } = setup()
  await chat.start('work')
  const slow = deferred<unknown>(), ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => {
    if (method === 'process.list' && params?.session_id === 'runtime-work-a') return slow.promise
    if (method === 'process.list') return Promise.resolve({ processes: [{ ...process('replacement'), output_tail: 'new runtime' }] })
    if (method === 'session.resume') return Promise.resolve({ session_id: 'replacement-runtime', stored_session_id: 'a', info: { running: false } })
    return ordinary(method, params, timeout)
  })
  const old = chat.refreshProcesses()
  await chat.open('a', 'work')
  await vi.waitFor(() => expect(state.processes.find(row => row.id === 'replacement')?.output).toBe('new runtime'))
  slow.resolve({ processes: [{ ...process('old'), output_tail: 'stale runtime' }] })
  await old
  expect(state.processes.some(row => row.id === 'old')).toBe(false)
})

it('does not append a recovered old exit to a recent unrelated answer after reconnect', async () => {
  const { chat, state, gateway, rows } = setup()
  await chat.start('work')
  gateway.onDisconnect(1006)
  rows([{ ...process('p', 'exited'), exit_code: 0, output_tail: 'old output' }])
  await chat.connect()
  await vi.waitFor(() => expect(state.messages.some(message => message.kind === 'process_complete')).toBe(true))
  expect(state.messages[0].kind).toBe('process_complete')
  expect(state.messages.at(-1)?.text).toBe('question-a')
})

it('polls the selected chat even while another chat’s status request is stalled', async () => {
  const { chat, state, request } = setup()
  await chat.start('work')
  await chat.open('b', 'work')
  const slow = deferred<unknown>(), ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => {
    if (method === 'process.list') return params?.session_id === 'runtime-work-a' ? slow.promise : Promise.resolve({ processes: [process('b-process')] })
    return ordinary(method, params, timeout)
  })
  const polling = chat.refreshProcesses()
  await vi.waitFor(() => expect(state.processes[0]?.id).toBe('b-process'))
  slow.resolve({ processes: [] })
  await polling
})

it('rejects queued polling and process event callbacks after disposal', async () => {
  const { chat, state, request, gateway } = setup()
  await chat.start('work')
  const slow = deferred<unknown>()
  request.mockImplementationOnce(() => slow.promise)
  const pending = chat.refreshProcesses()
  chat.dispose()
  slow.resolve({ processes: [process('late', 'exited')] })
  await pending
  gateway.onEvent({ type: 'agent.terminal.output', session_id: 'runtime-work-a', seq: 1, payload: { process_id: 'p', chunk: 'late' } })
  expect(state.processes).toHaveLength(1)
  expect(state.processes[0].output).toBe('ready\n')
})

it('preserves an uncertain individual stop on disconnect without automatically retrying it', async () => {
  const { chat, state, request, gateway } = setup()
  await chat.start('work')
  const slow = deferred<unknown>(), ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => method === 'process.kill' ? slow.promise : ordinary(method, params, timeout))
  const stopping = chat.stopProcess('p')
  gateway.onDisconnect(1006)
  expect(state.processError).toContain('may have reached Hermes')
  expect(state.processes[0].status).toBe('unknown')
  slow.resolve({ status: 'killed', output: 'stale acknowledgement' })
  await stopping
  expect(state.messages.some(message => message.kind === 'process_complete')).toBe(false)
  await chat.connect()
  expect(state.processes[0].status).toBe('running')
  expect(request.mock.calls.filter(([method]) => method === 'process.kill')).toHaveLength(1)
  request.mockImplementation((method, params, timeout) => method === 'process.kill' ? Promise.reject(new ConnectionLost()) : ordinary(method, params, timeout))
  await chat.stopProcess('p')
  expect(state.processError).toContain('will not be retried automatically')
})

it('runs scoped polling on the live timer after the assistant is idle and clears it on disposal', async () => {
  vi.useFakeTimers()
  const { chat, state, request, rows } = setup()
  await chat.start('work')
  request.mockClear()
  rows([{ ...process('p', 'exited'), exit_code: 0, output_tail: 'timer result' }])
  await vi.advanceTimersByTimeAsync(5000)
  expect(request).toHaveBeenCalledWith('process.list', { session_id: 'runtime-work-a', profile: 'work' })
  expect(state.running).toBe(false)
  expect(state.processes[0].status).toBe('exited')
  expect(state.messages.at(-1)?.text).toBe('timer result')
  chat.dispose()
  request.mockClear()
  await vi.advanceTimersByTimeAsync(10000)
  expect(request).not.toHaveBeenCalled()
})

it('recovers offscreen process activity from the active-session roster without visiting that chat', async () => {
  const { chat, state, request } = setup()
  const ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => {
    if (method === 'session.active_list') return Promise.resolve({ sessions: [{ id: 'runtime-work-b', session_key: 'b', status: 'idle' }] })
    if (method === 'process.list' && params?.session_id === 'runtime-work-b') return Promise.resolve({ processes: [process('offscreen')] })
    return ordinary(method, params, timeout)
  })
  await chat.start('work')
  await vi.waitFor(() => expect(chat.sessionStatus({ id: 'b', profile: 'work' })).toBe('working'))
  expect(state.processes.map(row => row.id)).toEqual(['p'])
  expect(state.running).toBe(false)
})

it('retains valid process output across unavailable or malformed roster replies', async () => {
  const { chat, state, request } = setup()
  await chat.start('work')
  request.mockImplementationOnce(async () => { throw new Error('Unavailable') })
  await chat.refreshProcesses()
  expect(state.processError).toContain('status unavailable')
  expect(state.processes[0].output).toBe('ready\n')
  request.mockResolvedValueOnce({ processes: null })
  await chat.refreshProcesses()
  expect(state.processes[0].status).toBe('running')
  expect(state.processError).toContain('status unavailable')
})

it('clears the selected process UI and invalidates its pending roster when the chat is deleted', async () => {
  const { chat, state, api, request } = setup()
  await chat.start('work')
  vi.spyOn(api, 'delete').mockResolvedValue({})
  const slow = deferred<unknown>()
  request.mockImplementationOnce(() => slow.promise)
  const polling = chat.refreshProcesses()
  await chat.deleteSelected()
  expect(state.processes).toEqual([])
  expect(state.processError).toBe('')
  slow.resolve({ processes: [process('deleted-late')] })
  await polling
  expect(state.processesBySession.has(JSON.stringify(['work', 'a']))).toBe(false)
})

it('updates a retained exit with the authoritative final output without letting a stale running roster revive it', async () => {
  const { chat, state, rows } = setup()
  await chat.start('work')
  rows([{ ...process('p', 'exited'), output_tail: 'early output' }])
  await chat.refreshProcesses()
  const key = state.messages.at(-1)?.key
  rows([{ ...process('p', 'exited'), output_tail: 'final output', exit_code: 7 }])
  await chat.refreshProcesses()
  expect(state.messages.at(-1)).toMatchObject({ key, text: 'final output', metadata: { exit_code: 7 } })
  expect(state.processes[0]).toMatchObject({ status: 'exited', output: 'final output', exitCode: 7 })
  rows([process()])
  await chat.refreshProcesses()
  expect(state.processes[0].status).toBe('exited')
  expect(state.messages.filter(message => message.kind === 'process_complete')).toHaveLength(1)
})

it('keeps an unanchored recovered exit before loaded history and replaces it with a durable matching notice', async () => {
  const { chat, state, rows, api } = setup()
  rows([{ ...process('p', 'exited'), exit_code: 0, output_tail: 'historical output' }])
  await chat.start('work')
  expect(state.messages[0].kind).toBe('process_complete')
  state.hasOlder = true
  vi.mocked(api.history).mockResolvedValueOnce({ session_id: 'a', profile: 'work', messages: [{ id: 0, role: 'user', content: 'Older question' }], pagination: { returned: 1, offset: 1, limit: 50 } })
  await chat.older()
  expect(state.messages[0].kind).toBe('process_complete')
  state.hasOlder = true
  vi.mocked(api.history).mockResolvedValueOnce({ session_id: 'a', profile: 'work', messages: [{ id: -1, role: 'system', display_kind: 'process_complete', display_content: 'Durable output', display_metadata: { process_id: 'p', display_text: 'Stored completion' } }], pagination: { returned: 1, offset: 2, limit: 50 } })
  await chat.older()
  expect(state.messages.filter(message => message.kind === 'process_complete')).toHaveLength(1)
  expect(state.messages[0]).toMatchObject({ rowId: -1, text: 'Durable output' })
})

it('does not attach a delayed exit observation from before navigation to a newer selected-chat answer', async () => {
  const { chat, state, request } = setup()
  await chat.start('work')
  const slow = deferred<unknown>(), ordinary = request.getMockImplementation()!
  request.mockImplementation((method, params, timeout) => method === 'process.list' && params?.session_id === 'runtime-work-a' ? slow.promise : ordinary(method, params, timeout))
  const polling = chat.refreshProcesses()
  await chat.open('b', 'work')
  await chat.open('a', 'work')
  state.messages.push({ key: 'new-answer', role: 'assistant', text: 'An unrelated newer answer' })
  slow.resolve({ processes: [{ ...process('p', 'exited'), output_tail: 'Older exit' }] })
  await polling
  expect(state.messages[0].kind).toBe('process_complete')
  expect(state.messages.at(-1)?.text).toBe('An unrelated newer answer')
})
