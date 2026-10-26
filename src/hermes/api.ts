import type { HistoryPage, SessionRow } from './types'

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export class HermesApi {
  private delegatedSessions = new Map<string, { expires: number; result: Promise<boolean> }>()

  constructor(private fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(path, {
      ...options,
      credentials: 'same-origin',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    })

    if (!response.ok) {
      let detail = `Hermes returned HTTP ${response.status}`
      try {
        const body = await response.json()
        if (typeof body.detail === 'string') detail = body.detail
      } catch { /* Proxies may return an HTML error page. */ }
      throw new HttpError(response.status, detail)
    }

    return response.json() as Promise<T>
  }

  query(values: Record<string, string | number | undefined>): string {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    return params.toString()
  }

  async sessions(profile: string | undefined, offset = 0) {
    const page = await this.request<{ sessions: SessionRow[]; total: number; storage?: Record<string, string> }>(
      `/api/sessions?${this.query({ profile, offset, limit: 20, order: 'recent', exclude_sources: 'cron,subagent' })}`,
    )
    return { ...page, sessions: await this.classifySessions(page.sessions, profile) }
  }

  async searchSessions(query: string, profile?: string) {
    const page = await this.request<{ results: SessionRow[] }>(`/api/sessions/search?${this.query({
      q: query, profile, limit: 100, exclude_sources: 'cron,subagent',
    })}`)
    return { ...page, results: await this.classifySessions(page.results, profile) }
  }

  private async classifySessions(rows: SessionRow[], profile?: string): Promise<SessionRow[]> {
    const classified = new Array<SessionRow>(rows.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (next < rows.length) {
        const index = next++
        const row = rows[index]!
        classified[index] = { ...row, delegated: await this.isDelegatedSession(row, profile) }
      }
    }))
    return classified
  }

  private isDelegatedSession(row: SessionRow, profile?: string): Promise<boolean> {
    if (row.source === 'subagent') return Promise.resolve(true)
    const owner = row.profile || profile
    const key = JSON.stringify([owner, row.id])
    const cached = this.delegatedSessions.get(key)
    if (cached && cached.expires > Date.now()) return cached.result
    // Search omits model_config; source alone misses children inheriting their parent's platform.
    const result = this.session(row.id, owner).then(detail => detail.delegated === true).catch(error => {
      this.delegatedSessions.delete(key)
      if (error instanceof HttpError && error.status === 404) return true
      throw error
    })
    this.delegatedSessions.delete(key)
    this.delegatedSessions.set(key, { expires: Date.now() + 60_000, result })
    if (this.delegatedSessions.size > 256) this.delegatedSessions.delete(this.delegatedSessions.keys().next().value!)
    return result
  }

  async session(id: string, profile?: string): Promise<SessionRow> {
    const detail = await this.request<SessionRow & { model_config?: unknown }>(`/api/sessions/${encodeURIComponent(id)}?${this.query({ profile })}`)
    const raw = detail.model_config
    const config: unknown = typeof raw === 'string' ? raw.trim() ? JSON.parse(raw) : null : raw
    const delegated = detail.source === 'subagent' || Boolean(config && typeof config === 'object' && '_delegate_from' in config && config._delegate_from != null)
    return { ...detail, delegated }
  }

  history(id: string, profile: string | undefined, offset = 0) {
    return this.request<HistoryPage>(`/api/sessions/${encodeURIComponent(id)}/messages?${this.query({
      profile, offset, limit: 50, order: 'latest', inline_images: 'true',
    })}`)
  }

  rename(id: string, title: string, profile?: string) {
    return this.request<{ title: string }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ title, profile }),
    })
  }

  delete(id: string, profile?: string) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}?${this.query({ profile })}`, { method: 'DELETE' })
  }
}
