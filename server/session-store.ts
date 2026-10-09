import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Tokens } from './native-session.ts'

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
      CREATE TABLE IF NOT EXISTS sessions (
        scope TEXT NOT NULL,
        id_hash TEXT NOT NULL,
        tokens TEXT NOT NULL,
        last_used INTEGER NOT NULL,
        PRIMARY KEY (scope, id_hash)
      ) STRICT;
    `)
  }

  private key(id: string) { return createHash('sha256').update(id).digest('hex') }

  get(id: string): StoredSession | undefined {
    const row = this.database.prepare('SELECT tokens, last_used FROM sessions WHERE scope = ? AND id_hash = ?').get(this.scope, this.key(id))
    if (!row) return undefined
    return { tokens: JSON.parse(String(row.tokens)) as Tokens, lastUsed: Number(row.last_used) }
  }

  save(id: string, tokens: Tokens, lastUsed: number) {
    this.database.prepare(`
      INSERT INTO sessions (scope, id_hash, tokens, last_used) VALUES (?, ?, ?, ?)
      ON CONFLICT (scope, id_hash) DO UPDATE SET tokens = excluded.tokens, last_used = excluded.last_used
    `).run(this.scope, this.key(id), JSON.stringify(tokens), lastUsed)
  }

  touch(id: string, lastUsed: number) {
    this.database.prepare('UPDATE sessions SET last_used = ? WHERE scope = ? AND id_hash = ?').run(lastUsed, this.scope, this.key(id))
  }

  delete(id: string) {
    this.database.prepare('DELETE FROM sessions WHERE scope = ? AND id_hash = ?').run(this.scope, this.key(id))
  }

  prune(before: number) {
    this.database.prepare('DELETE FROM sessions WHERE scope = ? AND last_used <= ?').run(this.scope, before)
  }

  close() { this.database.close() }
}
