import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { PushNotifications } from '../src/push-notifications'
import { notificationState } from '../src/reply-notifications'

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true)
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  vi.stubGlobal('PushManager', class {})
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(async () => 'granted') })
  localStorage.clear()
})

afterEach(() => vi.unstubAllGlobals())

it('keeps the enable gesture disabled while asynchronous capability setup is in flight', async () => {
  let release!: (value: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  const state = notificationState(), push = new PushNotifications(state, vi.fn(() => pending) as typeof fetch)
  const refreshing = push.refresh()
  expect(state.busy).toBe(true)
  await push.toggle()
  expect(Notification.requestPermission).not.toHaveBeenCalled()
  release(new Response(JSON.stringify({ configured: false, devices: [], observer: 'off' })))
  await refreshing
  expect(state.busy).toBe(false)
  push.dispose()
})

it('rolls back a newly-created browser subscription if server linking fails', async () => {
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/device', toJSON: () => ({ endpoint: 'endpoint', keys: {} }), unsubscribe: vi.fn(async () => true) }
  const registration = { active: {}, pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => subscription) } }
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: vi.fn(async () => registration), ready: Promise.resolve(registration) } })
  const fetcher = vi.fn(async (_url, options?: RequestInit) => options?.method === 'POST' ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ configured: true, publicKey: 'B'.repeat(87), devices: [], observer: 'off' })))
  const state = notificationState(), push = new PushNotifications(state, fetcher as typeof fetch)
  await push.refresh(); await push.toggle()
  expect(state.pushEnabled).toBe(false)
  expect(state.error).toMatch(/Could not update Web Push/)
  expect(subscription.unsubscribe).toHaveBeenCalledOnce()
  expect(localStorage.getItem('agora.web-push-enabled')).not.toBe('true')
  push.dispose()
})

it('requests permission in the enable gesture and links the actual subscription, then deletes before unsubscribing', async () => {
  const calls: string[] = []
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/device', toJSON: () => ({ endpoint: 'endpoint', keys: {} }), unsubscribe: vi.fn(async () => { calls.push('unsubscribe'); return true }) }
  const registration = { active: {}, pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => subscription) }, getNotifications: async () => [] }
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: vi.fn(async () => registration), ready: Promise.resolve(registration), getRegistration: async () => registration } })
  const fetcher = vi.fn(async (_url, options?: RequestInit) => {
    calls.push(options?.method || 'GET')
    return new Response(JSON.stringify(options?.method && options.method !== 'GET' ? { enabled: options.method === 'POST' } : { configured: true, publicKey: 'B'.repeat(87), devices: [], observer: 'watching' }))
  })
  const state = notificationState()
  const push = new PushNotifications(state, fetcher as typeof fetch)
  await push.refresh()
  expect(state.pushConfigured, JSON.stringify(state)).toBe(true)
  expect(state.pushSupported, JSON.stringify(state)).toBe(true)
  const enabling = push.toggle()
  expect(Notification.requestPermission).toHaveBeenCalledOnce()
  await enabling
  expect(state.pushEnabled).toBe(true)
  expect(registration.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }))
  registration.pushManager.getSubscription.mockResolvedValue(subscription as never)
  await push.toggle()
  expect(state.pushEnabled).toBe(false)
  expect(calls.slice(-2)).toEqual(['DELETE', 'unsubscribe'])
  vi.mocked(Notification.requestPermission).mockImplementation(() => { throw new Error('Permission is unavailable.') })
  await push.toggle()
  expect(state.error).toBe('Permission is unavailable.')
  expect(state.busy).toBe(false)
  push.dispose()
})
