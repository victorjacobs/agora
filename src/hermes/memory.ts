import type { Gateway } from './gateway'
import type { Approval, ServerRequest } from './types'

export function isMemoryApproval(approval: Approval): boolean {
  return approval.tool_name === 'memory' || /^Save to memory:/i.test(approval.description || '')
}

export interface MemoryApproval extends Approval { key: string; request?: ServerRequest }

export function memoryApprovals(approvals: Approval[], requests: ServerRequest[]): MemoryApproval[] {
  const pending = requests.filter(request => request.method === 'approval' && isMemoryApproval(request.params as Approval))
  return [
    ...pending.map(request => ({ ...request.params as Approval, key: request.id, request })),
    ...approvals.filter(approval => isMemoryApproval(approval) && !pending.some(request => approval.request_id && request.params.request_id === approval.request_id))
      .map((approval, index) => ({ ...approval, key: approval.request_id || `memory-${index}` })),
  ]
}

export interface MemoryPreview { id: string; summary: string; background: boolean; targetDetails: string }
export interface MemoryPending { previews: MemoryPreview[] }

export function parseMemoryPending(output: string): MemoryPending {
  if (output.trim() === 'No pending memory writes.') return { previews: [] }
  const header = output.match(/^Pending memory writes \((\d+)\):\r?\n/)
  if (!header) throw new Error('This Hermes version does not expose pending memory previews in a supported format.')
  const previews: MemoryPreview[] = []
  for (const line of output.slice(header[0].length).split(/\r?\n/)) {
    const match = line.match(/^  ([a-f\d]{8})( \[auto\])?  (.*)$/)
    if (match) previews.push({ id: match[1]!, background: Boolean(match[2]), summary: match[3]!, targetDetails: '' })
    else if (line.startsWith('Apply: /memory approve')) break
    else if (line.startsWith('      ') && previews.length) {
      const preview = previews.at(-1)!
      preview.targetDetails += `${preview.targetDetails ? '\n' : ''}${line.slice(6)}`
    } else if (previews.length && line) {
      const preview = previews.at(-1)!
      if (preview.targetDetails) preview.targetDetails += `\n${line}`
      else preview.summary += `\n${line}`
    }
  }
  if (previews.length !== Number(header[1])) throw new Error('Hermes returned incomplete memory previews. Refresh to try again.')
  return { previews }
}

export async function pendingMemory(gateway: Gateway, runtime: string, profile?: string): Promise<MemoryPending> {
  const response = await gateway.request<{ type: string; output?: string }>('command.dispatch', {
    name: 'memory', arg: 'pending', session_id: runtime, profile,
  })
  if (response.type !== 'exec' || typeof response.output !== 'string') throw new Error('Memory review is unavailable from this Hermes server.')
  return parseMemoryPending(response.output)
}
