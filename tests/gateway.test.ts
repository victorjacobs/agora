import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionLost, Gateway, RpcError } from '../src/hermes/gateway'
import type { Socket } from '../src/hermes/gateway'

class FakeSocket implements Socket {
  readyState = 1
  sent: Array<{ id: string; method: string; params: Record<string, unknown> }> = []
  onmessage: WebSocket['onmessage'] = null
  onclose: WebSocket['onclose'] = null
  onerror: WebSocket['onerror'] = null
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close(code = 1006) {
    this.readyState = 3
    this.onclose?.call(this as unknown as WebSocket, new CloseEvent('close', { code }))
  }
  receive(...frames: unknown[]) {
    this.onmessage?.call(this as unknown as WebSocket, new MessageEvent('message', { data: frames.map(frame => JSON.stringify(frame)).join('\n') + '\n' }))
  }
  ready(heartbeat = false) {
    this.receive({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat } } })
  }
}

afterEach(() => vi.useRealTimers())

describe('Hermes gateway', () => {
  it('waits for readiness, correlates out-of-order replies, and handles coalesced events', async () => {
    const socket = new FakeSocket()
    const gateway = new Gateway(() => socket)
    const events = vi.fn()
    gateway.onEvent = events
    const connecting = gateway.connect('ws://localhost/api/ws')
    await expect(gateway.request('session.create')).rejects.toBeInstanceOf(ConnectionLost)
    socket.ready()
    await connecting
    const first = gateway.request('first')
    const second = gateway.request('second')
    socket.receive(
      { jsonrpc: '2.0', id: socket.sent[1].id, result: 'two' },
      { jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 'runtime', payload: { text: 'hello' } } },
      { jsonrpc: '2.0', id: socket.sent[0].id, result: 'one' },
    )
    await expect(first).resolves.toBe('one')
    await expect(second).resolves.toBe('two')
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.delta' }))
    gateway.close()
  })

  it('uses ticket subprotocols and rejects outstanding submits when disconnected', async () => {
    const socket = new FakeSocket()
    const factory = vi.fn(() => socket)
    const gateway = new Gateway(factory)
    const connecting = gateway.connect('wss://example.test/api/ws', 'ticket-1')
    expect(factory).toHaveBeenCalledWith('wss://example.test/api/ws', ['hermes-gateway-v1', 'hermes-gateway-ticket.ticket-1'])
    socket.ready()
    await connecting
    const submit = gateway.request('prompt.submit', { text: 'synthetic' })
    socket.close()
    await expect(submit).rejects.toBeInstanceOf(ConnectionLost)
    expect(socket.sent.filter(frame => frame.method === 'prompt.submit')).toHaveLength(1)
    gateway.close()
  })

  it('keeps server request IDs and surfaces RPC failures', async () => {
    const socket = new FakeSocket()
    const gateway = new Gateway(() => socket)
    const request = vi.fn()
    gateway.onRequest = request
    const connecting = gateway.connect('ws://localhost/api/ws')
    socket.ready()
    await connecting
    socket.receive({ jsonrpc: '2.0', id: 'approval-7', method: 'approval', params: { session_id: 'runtime', request_id: 'tool-3' } })
    expect(request).toHaveBeenCalledWith({ id: 'approval-7', method: 'approval', params: { session_id: 'runtime', request_id: 'tool-3' } })
    const operation = gateway.request('session.resume')
    socket.receive({ jsonrpc: '2.0', id: socket.sent[0].id, error: { code: 4007, message: 'Session not found' } })
    await expect(operation).rejects.toEqual(new RpcError(4007, 'Session not found'))
    gateway.close()
  })

  it('heartbeats only when advertised and expires a dead connection', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const gateway = new Gateway(() => socket)
    const disconnected = vi.fn()
    gateway.onDisconnect = disconnected
    const connecting = gateway.connect('ws://localhost/api/ws')
    socket.ready(true)
    await connecting
    await vi.advanceTimersByTimeAsync(15_000)
    expect(socket.sent[0].method).toBe('gateway.ping')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(disconnected).toHaveBeenCalledOnce()
    gateway.close()
  })

  it('ignores retired sockets and reports malformed protocol frames', async () => {
    const sockets = [new FakeSocket(), new FakeSocket()]
    let index = 0
    const gateway = new Gateway(() => sockets[index++])
    const events = vi.fn()
    gateway.onEvent = events
    const first = gateway.connect('ws://localhost/api/ws')
    sockets[0].ready()
    await first
    const second = gateway.connect('ws://localhost/api/ws')
    sockets[0].receive({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta' } })
    sockets[1].ready()
    await second
    expect(events).toHaveBeenCalledTimes(2)
    sockets[1].receive({ method: 'unsupported' })
    expect(sockets[1].readyState).toBe(3)
    gateway.close()
  })
})
