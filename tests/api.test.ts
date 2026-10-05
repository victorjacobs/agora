import { afterEach, describe, expect, it, vi } from 'vitest'
import { HermesApi } from '../src/hermes/api'

afterEach(() => vi.unstubAllGlobals())

describe('browser HTTP transport', () => {
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
