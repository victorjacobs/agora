// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, sessionOwner } from '../server/session-store.ts'
import { HermesBridge } from '../server/bridge.ts'
import webpush from 'web-push'

const close: Array<() => void> = []
afterEach(() => { close.reverse().forEach(action => action()); close.length = 0; vi.restoreAllMocks() })
function fixture(revoked = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agora-push-lifetime-'))
  close.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'sessions.sqlite')
  const store = new SessionStore(path, JSON.stringify(['http://127.0.0.1:9/', '']))
  close.push(() => store.close())
  const used = Date.now() - 1000
  store.save('cookie', { access_token: 'old', refresh_token: 'rotate', expires_at: Date.now() / 1000 - 1, provider: 'fixture' }, used)
  const owner = sessionOwner('cookie')
  store.saveSubscription(owner, { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', keys: { p256dh: 'fixture', auth: 'fixture' } })
  const fetcher = vi.fn(async (input: any) => {
    const path = new URL(String(input)).pathname
    if (path === '/auth/native/refresh') return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rotated', expires_at: Date.now() / 1000 + 3600, provider: 'fixture' }), { status: revoked ? 401 : 200 })
    if (path === '/api/auth/me') return new Response('{}', { status: 200 })
    if (path === '/api/auth/ws-ticket') return new Response('{}', { status: 503 })
    throw new Error('Unexpected observer HTTP call')
  })
  const bridge = new HermesBridge('http://127.0.0.1:9', fetcher as typeof fetch, { sessionDb: path, sessionIdleSeconds: 60, push: { ...webpush.generateVAPIDKeys(), subject: 'mailto:fixture@example.test' } })
  close.push(() => bridge.dispose())
  return { store, owner, used, fetcher }
}
it('restored background owner refresh persists rotated tokens without renewing user activity', async () => {
  const { store, owner, used, fetcher } = fixture()
  await vi.waitFor(() => expect(store.getOwner(owner)?.tokens.access_token).toBe('new'))
  expect(store.getOwner(owner)?.lastUsed).toBe(used)
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/auth/native/refresh'))).toHaveLength(1)
  store.prune(used + 1)
  expect(store.getOwner(owner)).toBeUndefined()
  expect(store.subscriptions(owner)).toEqual([])
})
it('definitive background refresh revocation cascades subscriptions without browser activity', async () => {
  const { store, owner } = fixture(true)
  await vi.waitFor(() => expect(store.getOwner(owner)).toBeUndefined())
  expect(store.subscriptions(owner)).toEqual([])
  expect(store.pushOwners()).toEqual([])
})
