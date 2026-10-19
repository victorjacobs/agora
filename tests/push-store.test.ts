// @vitest-environment node
import { expect, it } from 'vitest'
import { SessionStore } from '../server/session-store.ts'
import { createHash } from 'node:crypto'

it('cannot reassign a device endpoint to another login', () => {
  const store = new SessionStore(':memory:', 'fixture')
  const tokens = { access_token: 'a', refresh_token: 'r', provider: 'fixture', expires_at: 9999999999 }
  store.save('first-cookie', tokens, 1); store.save('second-cookie', tokens, 1)
  const first = createHash('sha256').update('first-cookie').digest('hex'), second = createHash('sha256').update('second-cookie').digest('hex')
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', keys: { auth: 'auth', p256dh: 'key' } }
  store.saveSubscription(first, subscription)
  expect(() => store.saveSubscription(second, subscription)).toThrow(/different login/)
  expect(store.subscriptions(second)).toEqual([])
  expect(store.subscriptions(first)).toEqual([subscription])
  store.close()
})

it('persists only push metadata for a linked hashed login and cascades logout', () => {
  const store = new SessionStore(':memory:', 'fixture')
  const owner = createHash('sha256').update('cookie').digest('hex')
  store.save('cookie', { access_token: 'a', refresh_token: 'r', provider: 'fixture', expires_at: 9999999999 }, 123)
  store.saveSubscription(owner, { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', keys: { auth: 'auth', p256dh: 'key' } })
  store.saveWatch(owner, { runtime: 'runtime', stored: 'stored', profile: 'work', epoch: '', seq: 0, seen: [] })
  expect(store.pushOwners()).toEqual([owner])
  expect(store.watches(owner)[0]?.stored).toBe('stored')
  expect(store.getOwner(owner)?.lastUsed).toBe(123)
  store.delete('cookie')
  expect(store.subscriptions(owner)).toEqual([])
  expect(store.watches(owner)).toEqual([])
  store.close()
})
