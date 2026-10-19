// @vitest-environment node
import { expect, it } from 'vitest'
import { SessionStore, sessionOwner } from '../server/session-store.ts'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

it('trims legacy watches per login before the store can restore observers, without touching another scope', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agora-watch-limit-'))
  const path = join(directory, 'sessions.sqlite')
  try {
    const fixtures = [['fixture', 'first', 64], ['fixture', 'second', 6], ['other-scope', 'first', 6]] as const
    for (const [scope, cookie] of fixtures) {
      const store = new SessionStore(path, scope)
      store.save(cookie, { access_token: 'a', refresh_token: 'r', provider: 'fixture', expires_at: 9999999999 }, 1)
      store.saveSubscription(sessionOwner(cookie), { endpoint: `https://fcm.googleapis.com/fcm/send/${cookie}`, keys: { auth: 'auth', p256dh: 'key' } })
      store.close()
    }
    const legacy = new DatabaseSync(path)
    for (const [scope, cookie, count] of fixtures) {
      for (let index = 0; index < count; index++) {
        const watch = { runtime: String(index), stored: `stored-${index}`, profile: 'work', epoch: 'epoch', seq: index, seen: [`dedupe-${index}`] }
        legacy.prepare('INSERT INTO push_watches VALUES (?, ?, ?, ?)').run(scope, sessionOwner(cookie), watch.runtime, JSON.stringify(watch))
      }
    }
    legacy.close()
    const restored = new SessionStore(path, 'fixture')
    try {
      expect(restored.watches(sessionOwner('first')).map(row => row.runtime).sort()).toEqual(['59', '60', '61', '62', '63'])
      expect(restored.watches(sessionOwner('second')).map(row => row.runtime).sort()).toEqual(['1', '2', '3', '4', '5'])
      expect(restored.watches(sessionOwner('first')).find(row => row.runtime === '63')).toEqual({ runtime: '63', stored: 'stored-63', profile: 'work', epoch: 'epoch', seq: 63, seen: ['dedupe-63'] })
      const inspect = new DatabaseSync(path)
      expect(inspect.prepare('SELECT COUNT(*) AS count FROM push_watches WHERE scope = ?').get('other-scope')?.count).toBe(6)
      inspect.close()
      restored.saveWatch(sessionOwner('first'), { runtime: '64', stored: 'stored-64', profile: 'work', epoch: '', seq: 0, seen: [] })
      expect(restored.watches(sessionOwner('first')).map(row => row.runtime).sort()).toEqual(['60', '61', '62', '63', '64'])
    } finally { restored.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('keeps five watches per login in insertion order without cursor updates changing eviction', () => {
  const store = new SessionStore(':memory:', 'fixture')
  try {
    for (const cookie of ['first', 'second']) {
      store.save(cookie, { access_token: 'a', refresh_token: 'r', provider: 'fixture', expires_at: 9999999999 }, 1)
      store.saveSubscription(sessionOwner(cookie), { endpoint: `https://fcm.googleapis.com/fcm/send/${cookie}`, keys: { auth: 'auth', p256dh: 'key' } })
    }
    const watch = (runtime: string, seq = 0) => ({ runtime, stored: runtime + '-stored', profile: 'work', epoch: 'epoch', seq, seen: [] })
    const owner = sessionOwner('first')
    for (let index = 0; index < 5; index++) store.saveWatch(owner, watch(String(index)))
    store.saveWatch(sessionOwner('second'), watch('separate'))
    store.saveWatch(owner, watch('0', 42))
    expect(store.watches(owner)).toHaveLength(5)
    expect(store.watches(owner).find(row => row.runtime === '0')?.seq).toBe(42)
    store.saveWatch(owner, watch('5'))
    expect(store.watches(owner).map(row => row.runtime).sort()).toEqual(['1', '2', '3', '4', '5'])
    expect(store.watches(sessionOwner('second')).map(row => row.runtime)).toEqual(['separate'])
  } finally { store.close() }
})

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
