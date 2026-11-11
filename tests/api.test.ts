import { afterEach, describe, expect, it, vi } from 'vitest'
import { HermesApi } from '../src/hermes/api'

afterEach(() => vi.unstubAllGlobals())

describe('browser HTTP transport', () => {
  it('searches stored chats with the profile and excludes cron and subagent sessions', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] })))
    const api = new HermesApi(fetcher)
    await api.searchSessions('a phrase & more', 'work')
    const url = new URL(fetcher.mock.calls[0]![0], 'https://agora.test')
    expect(url.pathname).toBe('/api/sessions/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'a phrase & more', profile: 'work', limit: '100', exclude_sources: 'cron,subagent' })
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' })
  })

  it('excludes cron and subagent sessions from paginated recent chats', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [], total: 0 })))
    const api = new HermesApi(fetcher)
    await api.sessions('work', 20)
    const url = new URL(fetcher.mock.calls[0]![0], 'https://agora.test')
    expect(url.pathname).toBe('/api/sessions')
    expect(Object.fromEntries(url.searchParams)).toEqual({ profile: 'work', offset: '20', limit: '20', order: 'recent', exclude_sources: 'cron,subagent' })
  })

  it('checks delegation metadata for search hits inheriting desktop source, including orphaned children', async () => {
    const rows = [
      { id: 'child', profile: 'work', source: 'desktop', title: 'Internal worker', parent_session_id: 'parent' },
      { id: 'orphan', profile: 'work', source: 'desktop', title: 'Old worker' },
      { id: 'branch', profile: 'work', source: 'desktop', title: 'Human branch', parent_session_id: 'parent' },
      { id: 'human', profile: 'work', source: 'desktop', title: 'Subagent: a human-chosen title' },
    ]
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://agora.test')
      if (url.pathname === '/api/sessions/search') return new Response(JSON.stringify({ results: rows }))
      const id = url.pathname.split('/').at(-1)
      expect(url.searchParams.get('profile')).toBe('work')
      return new Response(JSON.stringify({ id, model_config: JSON.stringify(id === 'child' || id === 'orphan' ? { _delegate_from: 'parent' } : id === 'branch' ? { _branched_from: 'parent' } : {}) }))
    })
    const api = new HermesApi(fetcher)
    const result = await api.searchSessions('shared phrase', 'work')
    expect(result.results.map(row => [row.id, row.delegated])).toEqual([['child', true], ['orphan', true], ['branch', false], ['human', false]])
    await api.searchSessions('another phrase', 'work')
    expect(fetcher.mock.calls.filter(([input]) => !String(input).includes('/search?'))).toHaveLength(4)
  })

  it('keeps metadata checks bounded and profile-scoped without publishing unverifiable hits', async () => {
    let active = 0
    let peak = 0
    let failed = true
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://agora.test')
      if (url.pathname === '/api/sessions/search') return new Response(JSON.stringify({ results: Array.from({ length: 8 }, (_, index) => ({ id: String(index), profile: url.searchParams.get('profile') })) }))
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      if (failed) return new Response('{}', { status: 503 })
      return new Response(JSON.stringify({ model_config: url.searchParams.get('profile') === 'work' ? { _delegate_from: 'parent' } : null }))
    })
    const api = new HermesApi(fetcher)
    await expect(api.searchSessions('test', 'work')).rejects.toMatchObject({ status: 503 })
    await vi.waitFor(() => expect(active).toBe(0))
    failed = false
    expect((await api.searchSessions('test', 'work')).results.every(row => row.delegated)).toBe(true)
    expect((await api.searchSessions('test', 'personal')).results.every(row => !row.delegated)).toBe(true)
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('preserves the browser global receiver and sends the local session cookie', async () => {
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response(JSON.stringify({ display_name: 'Synthetic operator' })))
    })
    vi.stubGlobal('fetch', browserFetch)
    const api = new HermesApi()
    await expect(api.request('/api/auth/me')).resolves.toEqual({ display_name: 'Synthetic operator' })
    expect(browserFetch).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ credentials: 'same-origin' }))
  })
})
