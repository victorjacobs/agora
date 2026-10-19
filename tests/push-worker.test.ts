// @vitest-environment node
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

function worker() {
  const handlers: Record<string, Function> = {}
  const showNotification = vi.fn(async () => {})
  const openWindow = vi.fn(async () => {})
  const client = { url: 'https://agora.test/', navigate: vi.fn(async () => client), focus: vi.fn(async () => client) }
  const clients = { matchAll: vi.fn(async () => [client]), openWindow, claim: vi.fn(async () => {}) }
  const self = { location: { origin: 'https://agora.test' }, registration: { showNotification }, clients, skipWaiting: vi.fn(), addEventListener: (name: string, callback: Function) => { handlers[name] = callback } }
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL })
  const dispatch = async (name: string, event: object) => { let result: Promise<unknown> | undefined; handlers[name]!({ ...event, waitUntil: (value: Promise<unknown>) => { result = value } }); await result }
  return { handlers, showNotification, clients, client, dispatch }
}
it('always displays push and restricts warm and cold notification clicks to safe conversation URLs', async () => {
  const w = worker()
  expect(w.handlers.fetch).toBeUndefined()
  await w.dispatch('push', { data: { json: () => ({ title: 'Fictional project', body: 'Ready', url: '/?session=s&profile=work', tag: 'tag' }) } })
  expect(w.showNotification).toHaveBeenCalledWith('Fictional project', expect.objectContaining({ body: 'Ready', data: { url: '/?session=s&profile=work' } }))
  const close = vi.fn()
  await w.dispatch('notificationclick', { notification: { close, data: { url: '/?session=s&profile=work' } } })
  expect(w.client.navigate).toHaveBeenCalledWith('https://agora.test/?session=s&profile=work')
  expect(w.client.focus).toHaveBeenCalledOnce()
  w.clients.matchAll.mockResolvedValue([])
  await w.dispatch('notificationclick', { notification: { close, data: { url: '/?session=s&profile=work' } } })
  expect(w.clients.openWindow).toHaveBeenCalledWith('https://agora.test/?session=s&profile=work')
  for (const url of ['https://evil.test/', 'javascript:alert(1)', '//evil.test/', '/auth/logout', '/?session=s&next=evil']) {
    await w.dispatch('notificationclick', { notification: { close, data: { url } } })
  }
  expect(w.clients.openWindow).toHaveBeenCalledTimes(1)
  await w.dispatch('push', { data: { json: () => { throw new Error() } } })
  expect(w.showNotification).toHaveBeenCalledTimes(2)
})
