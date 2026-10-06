import { ConnectionLost, RpcError, type Gateway } from './gateway'

export interface QuotaWindow {
  label: string
  remaining?: number
  resetsAt?: string
  detail?: string
}

export interface ProviderQuota {
  plan?: string
  windows: QuotaWindow[]
  details: string[]
  unavailable?: string
}

export async function providerQuota(gateway: Gateway, provider: string, profile?: string): Promise<ProviderQuota> {
  const result = await gateway.request<{ blocked: boolean; code: number; output: string }>('cli.exec', {
    argv: ['usage', '--provider', provider, '--json', ...(profile ? [`--profile=${profile}`] : [])], profile, timeout: 20,
  }, 25_000)
  if (result.blocked || result.code !== 0) return { windows: [], details: [], unavailable: 'Quota unavailable from this Hermes server or provider.' }
  const snapshot = quotaDocument(result.output)
  const windows: QuotaWindow[] = Array.isArray(snapshot.windows) ? snapshot.windows.flatMap(window => {
    if (!window || typeof window.label !== 'string') return []
    const used = window.used_percent
    return [{
      label: window.label,
      remaining: typeof used === 'number' && Number.isFinite(used) ? Math.max(0, Math.min(100, 100 - used)) : undefined,
      resetsAt: typeof window.resets_at === 'string' && Number.isFinite(Date.parse(window.resets_at)) ? window.resets_at : undefined,
      detail: typeof window.detail === 'string' ? window.detail : undefined,
    }]
  }) : []
  const details = Array.isArray(snapshot.details) ? snapshot.details.filter((line): line is string => typeof line === 'string') : []
  return {
    plan: typeof snapshot.plan === 'string' ? snapshot.plan : undefined,
    windows, details,
    unavailable: typeof snapshot.unavailable_reason === 'string' && snapshot.unavailable_reason
      ? snapshot.unavailable_reason : !windows.length && !details.length ? 'This provider does not report quota.' : undefined,
  }
}

function quotaDocument(output: string): Record<string, unknown> {
  // cli.exec joins stdout and stderr, so startup warnings can surround the JSON.
  for (let start = output.indexOf('{'); start >= 0; start = output.indexOf('{', start + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = start; index < output.length; index++) {
      const character = output[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') quoted = true
      else if (character === '{') depth++
      else if (character === '}' && --depth === 0) {
        try {
          const value = JSON.parse(output.slice(start, index + 1))
          if (value && typeof value === 'object' && (Array.isArray(value.windows) || Array.isArray(value.details))) return value
        } catch { /* A startup log can contain braces without being JSON. */ }
        break
      }
    }
  }
  throw new Error('Hermes returned no readable quota data.')
}

export function quotaError(error: unknown): string {
  if (error instanceof RpcError) {
    if (error.code === -32601) return 'This Hermes version does not support quota requests (cli.exec).'
    if (error.code === 5016) return 'Hermes timed out while checking provider quota. Try refreshing.'
    return `Hermes rejected the quota request (RPC ${error.code}): ${error.message}`
  }
  if (error instanceof ConnectionLost) return 'Connection lost while checking quota. Reconnect and refresh.'
  return error instanceof Error ? error.message : 'Could not load provider quota.'
}
