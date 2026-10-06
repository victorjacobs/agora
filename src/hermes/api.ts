import type { HistoryPage, SessionRow } from './types'

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export class HermesApi {
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

  sessions(profile: string | undefined, offset = 0) {
    return this.request<{ sessions: SessionRow[]; total: number; storage?: Record<string, string> }>(
      `/api/sessions?${this.query({ profile, offset, limit: 20, order: 'recent', exclude_sources: 'cron' })}`,
    )
  }

  searchSessions(query: string, profile?: string) {
    return this.request<{ results: SessionRow[] }>(`/api/sessions/search?${this.query({
      q: query, profile, limit: 100, exclude_sources: 'cron',
    })}`)
  }

  session(id: string, profile: string) {
    return this.request<SessionRow>(`/api/sessions/${encodeURIComponent(id)}?${this.query({ profile })}`)
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
