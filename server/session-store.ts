import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Tokens } from './native-session.ts'
import type { Subscription } from './push.ts'

export const sessionOwner = (id: string) => createHash('sha256').update(id).digest('hex')
export interface PushWatch { runtime: string; stored: string; profile: string; epoch: string; seq: number; seen: string[] }

export const MAX_PUSH_WATCHES = 5
export const DEFAULT_SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60

export function sessionStorageOptions(environment: NodeJS.ProcessEnv = process.env) {
  const sessionDb = environment.AGORA_SESSION_DB ?? join(environment.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agora', 'sessions.sqlite')
  if (!sessionDb) throw new Error('AGORA_SESSION_DB must be a database path or :memory:.')
  const sessionIdleSeconds = environment.AGORA_SESSION_IDLE_SECONDS === undefined
    ? DEFAULT_SESSION_IDLE_SECONDS : Number(environment.AGORA_SESSION_IDLE_SECONDS)
  if (!Number.isSafeInteger(sessionIdleSeconds) || sessionIdleSeconds <= 0 || !Number.isSafeInteger(sessionIdleSeconds * 1000)) {
    throw new Error('AGORA_SESSION_IDLE_SECONDS must be a positive integer number of seconds.')
  }
  return { sessionDb, sessionIdleSeconds }
}

export interface StoredSession {
  tokens: Tokens
  lastUsed: number
}

export class SessionStore {
  private database: DatabaseSync
  private scope: string

  constructor(path: string, scope: string) {
    this.scope = scope
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      closeSync(openSync(path, 'a', 0o600))
      chmodSync(path, 0o600)
    }
    this.database = new DatabaseSync(path)
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        scope TEXT NOT NULL,
        id_hash TEXT NOT NULL,
        tokens TEXT NOT NULL,
        last_used INTEGER NOT NULL,
        PRIMARY KEY (scope, id_hash)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        scope TEXT NOT NULL, owner TEXT NOT NULL, endpoint_hash TEXT NOT NULL, subscription TEXT NOT NULL,
        PRIMARY KEY (scope, endpoint_hash),
        FOREIGN KEY (scope, owner) REFERENCES sessions(scope, id_hash) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS push_watches (
        scope TEXT NOT NULL, owner TEXT NOT NULL, runtime TEXT NOT NULL, metadata TEXT NOT NULL,
        PRIMARY KEY (scope, owner, runtime),
        FOREIGN KEY (scope, owner) REFERENCES sessions(scope, id_hash) ON DELETE CASCADE
      ) STRICT;
    `)
    this.database.prepare(`
      DELETE FROM push_watches WHERE scope = ? AND rowid NOT IN (
        SELECT kept.rowid FROM push_watches AS kept
        WHERE kept.scope = push_watches.scope AND kept.owner = push_watches.owner
        ORDER BY kept.rowid DESC LIMIT ?
      )
    `).run(this.scope, MAX_PUSH_WATCHES)
  }

  private key(id: string) { return sessionOwner(id) }

  get(id: string): StoredSession | undefined { return this.getOwner(this.key(id)) }

  getOwner(owner: string): StoredSession | undefined {
    const row = this.database.prepare('SELECT tokens, last_used FROM sessions WHERE scope = ? AND id_hash = ?').get(this.scope, owner)
    if (!row) return undefined
    return { tokens: JSON.parse(String(row.tokens)) as Tokens, lastUsed: Number(row.last_used) }
  }

  save(id: string, tokens: Tokens, lastUsed: number) { this.saveOwner(this.key(id), tokens, lastUsed) }

  saveOwner(owner: string, tokens: Tokens, lastUsed: number) {
    this.database.prepare(`
      INSERT INTO sessions (scope, id_hash, tokens, last_used) VALUES (?, ?, ?, ?)
      ON CONFLICT (scope, id_hash) DO UPDATE SET tokens = excluded.tokens, last_used = excluded.last_used
    `).run(this.scope, owner, JSON.stringify(tokens), lastUsed)
  }

  touch(id: string, lastUsed: number) { this.touchOwner(this.key(id), lastUsed) }
  touchOwner(owner: string, lastUsed: number) {
    this.database.prepare('UPDATE sessions SET last_used = ? WHERE scope = ? AND id_hash = ?').run(lastUsed, this.scope, owner)
  }

  delete(id: string) { this.deleteOwner(this.key(id)) }
  deleteOwner(owner: string) {
    this.database.prepare('DELETE FROM sessions WHERE scope = ? AND id_hash = ?').run(this.scope, owner)
  }

  pushOwners(): string[] {
    return this.database.prepare('SELECT DISTINCT owner FROM push_subscriptions WHERE scope = ?').all(this.scope).map(row => String(row.owner))
  }
  subscriptions(owner: string): Subscription[] {
    return this.database.prepare('SELECT subscription FROM push_subscriptions WHERE scope = ? AND owner = ?').all(this.scope, owner).map(row => JSON.parse(String(row.subscription)) as Subscription)
  }
  saveSubscription(owner: string, subscription: Subscription) {
    const hash = this.key(subscription.endpoint)
    const existing = this.database.prepare('SELECT owner FROM push_subscriptions WHERE scope = ? AND endpoint_hash = ?').get(this.scope, hash)
    if (existing && existing.owner !== owner) throw new Error('Subscription already belongs to a different login. Unsubscribe this device first.')
    if (!existing && this.subscriptions(owner).length >= 8) throw new Error('At most eight devices can use this login.')
    this.database.prepare('INSERT OR REPLACE INTO push_subscriptions VALUES (?, ?, ?, ?)').run(this.scope, owner, hash, JSON.stringify(subscription))
  }
  deleteSubscription(owner: string, endpoint: string) {
    this.database.prepare('DELETE FROM push_subscriptions WHERE scope = ? AND owner = ? AND endpoint_hash = ?').run(this.scope, owner, this.key(endpoint))
    if (!this.subscriptions(owner).length) this.database.prepare('DELETE FROM push_watches WHERE scope = ? AND owner = ?').run(this.scope, owner)
  }
  watches(owner: string): PushWatch[] {
    return this.database.prepare('SELECT metadata FROM push_watches WHERE scope = ? AND owner = ?').all(this.scope, owner).map(row => JSON.parse(String(row.metadata)) as PushWatch)
  }
  hasWatch(owner: string, runtime: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM push_watches WHERE scope = ? AND owner = ? AND runtime = ?').get(this.scope, owner, runtime))
  }
  updateWatch(owner: string, watch: PushWatch): boolean {
    return this.database.prepare('UPDATE push_watches SET metadata = ? WHERE scope = ? AND owner = ? AND runtime = ?').run(JSON.stringify(watch), this.scope, owner, watch.runtime).changes > 0
  }
  saveWatch(owner: string, watch: PushWatch) {
    if (!this.subscriptions(owner).length) return
    const watches = this.watches(owner)
    if (!watches.some(row => row.runtime === watch.runtime) && watches.length >= MAX_PUSH_WATCHES) {
      const oldest = this.database.prepare('SELECT runtime FROM push_watches WHERE scope = ? AND owner = ? ORDER BY rowid LIMIT 1').get(this.scope, owner)
      if (oldest) this.database.prepare('DELETE FROM push_watches WHERE scope = ? AND owner = ? AND runtime = ?').run(this.scope, owner, oldest.runtime!)
    }
    this.database.prepare(`
      INSERT INTO push_watches (scope, owner, runtime, metadata) VALUES (?, ?, ?, ?)
      ON CONFLICT (scope, owner, runtime) DO UPDATE SET metadata = excluded.metadata
    `).run(this.scope, owner, watch.runtime, JSON.stringify(watch))
  }

  prune(before: number) {
    this.database.prepare('DELETE FROM sessions WHERE scope = ? AND last_used <= ?').run(this.scope, before)
  }

  close() { this.database.close() }
}
