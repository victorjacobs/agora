import type { CronRun } from './cron'
import type { HistoryPage } from './types'
import { historyMessages } from './transcript'

export function resultOutput(page: HistoryPage): string {
  const messages = historyMessages({ ...page, messages: page.messages
    .filter(row => !row.tool_calls?.length)
    .map(row => row.role === 'assistant' && Array.isArray(row.content)
      ? { ...row, content: row.content.filter(part => ['text', 'output_text', 'image_url'].includes(part?.type)) } : row) })
  const latestTurn = messages.slice(messages.findLastIndex(message => message.role === 'user') + 1)
  return latestTurn.findLast(message => message.role === 'assistant' && !message.kind && message.text.trim())?.text || ''
}

export function createResultReadQueue(concurrency = 3) {
  let active = 0
  const waiting: Array<() => void> = []
  return async function read<T>(current: () => boolean, task: () => Promise<T>): Promise<T | undefined> {
    await new Promise<void>(resolve => {
      const start = () => { active++; resolve() }
      if (active < concurrency) start()
      else waiting.push(start)
    })
    try { return current() ? await task() : undefined }
    finally { active--; waiting.shift()?.() }
  }
}

export type ResultStatus = 'Running' | 'Finished' | 'Unknown'
export function resultStatus(run: CronRun): ResultStatus {
  if (run.ended_at != null) return 'Finished'
  if (run.scheduler_owned ?? run.is_active) return 'Running'
  return 'Unknown'
}
