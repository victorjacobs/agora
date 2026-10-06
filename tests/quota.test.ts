import { describe, expect, it, vi } from 'vitest'
import { Gateway, RpcError } from '../src/hermes/gateway'
import { providerQuota, quotaError } from '../src/hermes/quota'

function fixture(output: unknown, code = 0) {
  const gateway = new Gateway()
  const request = vi.spyOn(gateway, 'request').mockResolvedValue({ blocked: false, code, output: JSON.stringify(output) })
  return { gateway, request }
}

describe('provider quota', () => {
  it('queries the selected provider in its profile without creating or changing a session', async () => {
    const { gateway, request } = fixture({ provider: 'openai-codex', plan: 'Plus', windows: [{ label: 'Session', used_percent: 25, resets_at: '2026-10-06T12:00:00Z' }, { label: 'Weekly', used_percent: 90 }], details: [] })
    const result = await providerQuota(gateway, 'openai-codex', 'work')
    expect(request).toHaveBeenCalledExactlyOnceWith('cli.exec', { argv: ['usage', '--provider', 'openai-codex', '--json', '--profile=work'], profile: 'work', timeout: 20 }, 25_000)
    expect(result.windows.map(window => window.remaining)).toEqual([75, 10])
    expect(result.windows[0]?.resetsAt).toBe('2026-10-06T12:00:00Z')
    expect(result.plan).toBe('Plus')
  })

  it('accepts quota JSON surrounded by CLI warnings and ignores unrelated log objects', async () => {
    const gateway = new Gateway()
    vi.spyOn(gateway, 'request').mockResolvedValue({ blocked: false, code: 0, output: 'Warning: {not JSON}\n{"log":"startup"}\n' + JSON.stringify({ provider: 'openai-codex', windows: [{ label: 'Session', used_percent: 25 }], details: ['Text containing {braces} and "quotes"'] }, null, 2) + '\nWarning: optional integration unavailable' })
    expect(await providerQuota(gateway, 'openai-codex')).toMatchObject({ windows: [{ remaining: 75 }], details: ['Text containing {braces} and "quotes"'] })
    expect(quotaError(new RpcError(-32601, 'unknown method'))).toContain('does not support')
    expect(quotaError(new RpcError(5016, 'cli.exec: timeout'))).toContain('timed out')
    expect(quotaError(new RpcError(5017, 'Executable not found'))).toContain('Executable not found')
  })

  it('preserves credit balances without inventing percentages', async () => {
    const { gateway } = fixture({ windows: [], details: ['Credits remaining: $24.50'] })
    expect(await providerQuota(gateway, 'openrouter')).toMatchObject({ windows: [], details: ['Credits remaining: $24.50'], unavailable: undefined })
  })

  it('distinguishes missing quota from zero remaining and ignores malformed windows', async () => {
    const { gateway } = fixture({ windows: [null, { label: 'Session', used_percent: 100 }, { label: 'Weekly', used_percent: null, resets_at: 'invalid' }, { label: 'Overflow', used_percent: 110 }] })
    const result = await providerQuota(gateway, 'anthropic')
    expect(result.windows.map(window => window.remaining)).toEqual([0, undefined, 0])
    expect(result.windows[1]?.resetsAt).toBeUndefined()
    const unsupported = fixture({}, 1)
    expect((await providerQuota(unsupported.gateway, 'custom')).unavailable).toContain('unavailable')
    const invalid = fixture('invalid')
    await expect(providerQuota(invalid.gateway, 'custom')).rejects.toThrow('no readable quota')
  })
})
