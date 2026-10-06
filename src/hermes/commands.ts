import { RpcError, type Gateway } from './gateway'

export interface SlashCommand { name: string; arg: string }
export interface CommandChoice { name: string; description: string }
export type CommandResult =
  | { type: 'exec' | 'plugin'; output: string }
  | { type: 'alias'; target: string }
  | { type: 'send' | 'skill' | 'prefill'; message: string; notice?: string; display?: string }

export function slashCommand(text: string): SlashCommand | undefined {
  const match = /^\/([^\s/]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { name: match[1]!.toLowerCase(), arg: (match[2] || '').trim() } : undefined
}

export async function commandCatalog(gateway: Gateway, runtime?: string, profile?: string): Promise<CommandChoice[]> {
  const result = await gateway.request<{ pairs?: unknown }>('commands.catalog', { session_id: runtime || undefined, profile })
  if (!Array.isArray(result.pairs)) throw new Error('Command suggestions are unavailable from this Hermes server.')
  return result.pairs.flatMap(row => Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string'
    ? [{ name: row[0], description: row[1] }] : [])
}

export async function executeCommand(gateway: Gateway, text: string, runtime: string, profile?: string, current = () => true): Promise<CommandResult> {
  const visited = new Set<string>()
  let invocation = text
  for (let depth = 0; depth < 8; depth++) {
    if (!current()) throw new Error('The selected conversation changed.')
    const command = slashCommand(invocation)
    if (!command?.name) throw new Error('Choose a slash command first.')
    if (visited.has(invocation)) throw new Error('Hermes returned a circular command alias.')
    visited.add(invocation)
    let raw: unknown
    try {
      raw = await gateway.request('slash.exec', { session_id: runtime, profile, command: `${command.name}${command.arg ? ` ${command.arg}` : ''}` }, 300_000)
    } catch (error) {
      // Only a routing refusal guarantees the first call did not execute the command.
      if (!(error instanceof RpcError) || error.code !== 4018 || !error.message.includes('command.dispatch')) throw error
      if (!current()) throw new Error('The selected conversation changed.')
      raw = await gateway.request('command.dispatch', { session_id: runtime, profile, ...command }, 300_000)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Hermes returned an invalid command response.')
    const result = raw as Record<string, unknown>
    if (result.type === 'alias' && typeof result.target === 'string') {
      invocation = `/${result.target.replace(/^\/+/, '')}${command.arg ? ` ${command.arg}` : ''}`
      continue
    }
    if ((result.type === undefined && typeof result.output === 'string' || result.type === 'exec' || result.type === 'plugin') && (result.output === undefined || typeof result.output === 'string')) {
      const warning = typeof result.warning === 'string' ? result.warning : ''
      return { type: result.type === 'plugin' ? 'plugin' : 'exec', output: [warning, result.output || '(No output)'].filter(Boolean).join('\n') }
    }
    if (['send', 'skill', 'prefill'].includes(String(result.type)) && typeof result.message === 'string') {
      return { type: result.type as 'send' | 'skill' | 'prefill', message: result.message,
        notice: typeof result.notice === 'string' ? result.notice : undefined,
        display: typeof result.display === 'string' ? result.display : undefined }
    }
    throw new Error('Hermes returned an unsupported command response.')
  }
  throw new Error('Hermes returned too many command aliases.')
}
