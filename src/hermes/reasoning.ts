import type { Message } from './types'

export function excludeReplyFromReasoning(text: string, reply: string): string {
  const trace = text.trim()
  const answer = reply.trim()
  if (!answer || !trace.endsWith(answer)) return text
  const prefix = trace.slice(0, -answer.length)
  // Only remove a complete duplicated reply, never a matching phrase inside a thought.
  return !prefix.trim() || /\n\s*$/.test(prefix) ? prefix.trimEnd() : text
}

export function reasoningText(row: { reasoning?: unknown; reasoning_content?: unknown; reasoning_details?: unknown; codex_reasoning_items?: unknown }, reply = ''): string {
  for (const value of [row.reasoning_content, row.reasoning]) {
    if (typeof value === 'string' && value.trim()) return excludeReplyFromReasoning(value, reply)
  }
  const details = Array.isArray(row.reasoning_details) ? row.reasoning_details : []
  const text = details.flatMap(part => {
    if (!part || typeof part !== 'object') return []
    const value = part.type === 'reasoning.text' ? part.text : part.type === 'reasoning.summary' ? part.summary : undefined
    return typeof value === 'string' ? [value] : []
  }).join('\n\n')
  if (text) return excludeReplyFromReasoning(text, reply)
  const items = Array.isArray(row.codex_reasoning_items) ? row.codex_reasoning_items : []
  return excludeReplyFromReasoning(items.filter(item => item?.type === 'reasoning').flatMap(item =>
    Array.isArray(item.summary) ? item.summary.flatMap((part: { type?: string; text?: unknown }) =>
      part?.type === 'summary_text' && typeof part.text === 'string' ? [part.text] : []) : [],
  ).join('\n\n'), reply)
}

export function finishReasoning(messages: Message[]) {
  for (const message of messages) if (message.reasoning) message.reasoning.active = false
}

export function restoreReasoning(messages: Message[], previous: Message[]): Message[] {
  const result = [...messages]
  for (const [index, old] of previous.entries()) {
    if (!old.reasoning?.text) continue
    const userIndex = previous.slice(0, index).findLastIndex(row => row.role === 'user')
    const user = previous[userIndex]
    if (!user) continue
    let anchor = result.findIndex(row => row.key === user.key || user.rowId !== undefined && row.rowId === user.rowId)
    if (anchor < 0) {
      const candidates = result.flatMap((row, position) => row.role === 'user' && row.text === user.text ? [position] : [])
      if (candidates.length !== 1) continue
      anchor = candidates[0]!
    }
    const nextUser = result.findIndex((row, position) => position > anchor && row.role === 'user')
    const end = nextUser < 0 ? result.length : nextUser
    const assistants = result.slice(anchor + 1, end).filter(row => row.role === 'assistant')
    const ordinal = previous.slice(userIndex + 1, index).filter(row => row.role === 'assistant').length
    const match = assistants.find(row => old.text.trim() && row.text === old.text) || assistants[ordinal]
    if (match) {
      if (!match.reasoning?.text) {
        const text = excludeReplyFromReasoning(old.reasoning.text, match.text || old.text)
        if (text) match.reasoning = { text, active: false }
      }
    } else {
      const text = excludeReplyFromReasoning(old.reasoning.text, old.text)
      if (text) result.splice(end, 0, { ...old, text: '', reasoning: { text, active: false } })
    }
  }
  return result
}

export function appendReasoning(previous: string, text: string, complete: boolean): string {
  if (!complete) return previous + text
  if (text.startsWith(previous)) return text
  if (previous.endsWith(text)) return previous
  return [previous, text].filter(Boolean).join('\n\n')
}
