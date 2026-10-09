// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionStore, sessionStorageOptions } from '../server/session-store'

const tokens = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', provider: 'synthetic-provider', expires_at: 12345 }
let cleanup: Array<() => void> = []
afterEach(() => { for (const close of cleanup.reverse()) close(); cleanup = [] })
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'agora-store-test-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'private', 'sessions.sqlite')
}
function store(path: string, scope: string) {
  const value = new SessionStore(path, scope)
  cleanup.push(() => value.close())
  return value
}

describe('session storage configuration', () => {
  it('uses persistent per-user storage and a 30-day idle lifetime by default', () => {
    expect(sessionStorageOptions({})).toEqual({ sessionDb: join(homedir(), '.local', 'state', 'agora', 'sessions.sqlite'), sessionIdleSeconds: 2592000 })
    expect(sessionStorageOptions({ XDG_STATE_HOME: '/custom/state' }).sessionDb).toBe('/custom/state/agora/sessions.sqlite')
  })

  it('allows an explicit database path, memory-only mode, and custom idle lifetime', () => {
    expect(sessionStorageOptions({ AGORA_SESSION_DB: ':memory:', AGORA_SESSION_IDLE_SECONDS: '120' })).toEqual({ sessionDb: ':memory:', sessionIdleSeconds: 120 })
    expect(sessionStorageOptions({ AGORA_SESSION_DB: '/private/logins.sqlite' }).sessionDb).toBe('/private/logins.sqlite')
  })

  it.each(['0', '-1', '1.5', 'invalid', '', 'Infinity'])('rejects an invalid idle lifetime %j', value => {
    expect(() => sessionStorageOptions({ AGORA_SESSION_IDLE_SECONDS: value })).toThrow('AGORA_SESSION_IDLE_SECONDS')
  })
})

describe('SQLite session cache', () => {
  it('creates private storage and hashes browser session identifiers', () => {
    const path = databasePath()
    const value = store(path, 'endpoint-and-origin')
    value.save('opaque-browser-id', tokens, 1000)
    expect(value.get('opaque-browser-id')).toEqual({ tokens, lastUsed: 1000 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    const inspection = new DatabaseSync(path, { readOnly: true })
    cleanup.push(() => inspection.close())
    const row = inspection.prepare('SELECT id_hash FROM sessions').get()!
    expect(row.id_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(row.id_hash).not.toBe('opaque-browser-id')
  })

  it('isolates records by Hermes endpoint and Agora public origin', () => {
    const path = databasePath()
    const first = store(path, JSON.stringify(['https://hermes.test/', 'https://first-agora.test']))
    first.save('same-browser-id', tokens, 1000)
    const otherOrigin = store(path, JSON.stringify(['https://hermes.test/', 'https://second-agora.test']))
    const otherEndpoint = store(path, JSON.stringify(['https://other-hermes.test/', 'https://first-agora.test']))
    expect(otherOrigin.get('same-browser-id')).toBeUndefined()
    expect(otherEndpoint.get('same-browser-id')).toBeUndefined()
    otherOrigin.delete('same-browser-id')
    otherEndpoint.prune(2000)
    expect(first.get('same-browser-id')?.tokens).toEqual(tokens)
  })

  it('prunes idle records without deleting recently touched sessions', () => {
    const value = store(databasePath(), 'scope')
    value.save('old', tokens, 1000)
    value.save('active', tokens, 1000)
    value.touch('active', 3000)
    value.prune(2000)
    expect(value.get('old')).toBeUndefined()
    expect(value.get('active')?.lastUsed).toBe(3000)
  })
})
