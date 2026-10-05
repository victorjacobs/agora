import type { HistoryPage, Message, Snapshot } from './types'

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part?.text === 'string' ? part.text : part?.type === 'image_url' ? '[image]' : '').join('\n')
}

export function historyMessages(page: HistoryPage): Message[] {
  return page.messages.filter(row => row.display_kind !== 'hidden').map((row, index) => {
    const rowId = row.id ?? row.row_id
    return {
      key: rowId === undefined ? `history-${page.pagination.offset}-${index}` : `row-${rowId}`,
      rowId,
      role: row.role,
      text: row.display_content ?? row.text ?? contentText(row.content),
      kind: row.display_kind,
    }
  })
}

export function mergeHistory(older: Message[], newer: Message[]): Message[] {
  const seen = new Set<string>()
  return [...older, ...newer].filter(message => {
    if (seen.has(message.key)) return false
    seen.add(message.key)
    return true
  })
}

export function restoreInflight(messages: Message[], snapshot: Snapshot): Message[] {
  const result = [...messages]
  const inflight = snapshot.inflight
  if (!inflight || !(snapshot.running ?? snapshot.info.running) && !inflight.error) return result
  const lastUserIndex = result.findLastIndex(message => message.role === 'user')
  if (inflight.user && (lastUserIndex < 0 || result[lastUserIndex].text !== inflight.user)) {
    result.push({ key: 'inflight-user', role: 'user', text: inflight.user })
  }
  if (inflight.assistant) {
    // The inflight body replaces only the current turn's assistant suffix.
    const turnUserIndex = result.findLastIndex(message => message.role === 'user')
    const tail = result.slice(turnUserIndex + 1)
    if (!tail.some(message => message.role === 'assistant' && message.text === inflight.assistant)) {
      result.push({ key: 'inflight-assistant', role: 'assistant', text: inflight.assistant })
    }
  }
  return result
}
