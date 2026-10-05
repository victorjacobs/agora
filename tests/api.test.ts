import { afterEach, describe, expect, it, vi } from 'vitest'
import { HermesApi } from '../src/hermes/api'

afterEach(() => vi.unstubAllGlobals())

describe('browser HTTP transport', () => {
  it('searches stored conversations through Hermes with the profile and cron exclusion', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] })))
    const api = new HermesApi(fetcher)
    await api.searchSessions('a phrase & more', 'work')
    const url = new URL(fetcher.mock.calls[0]![0], 'https://agora.test')
    expect(url.pathname).toBe('/api/sessions/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'a phrase & more', profile: 'work', limit: '100', exclude_sources: 'cron' })
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin' })
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
