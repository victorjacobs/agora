import type { CronRun } from './cron'
import type { HistoryPage } from './types'
import { historyMessages } from './transcript'

function runDate(timestamp?: number): Date | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return
  const date = new Date(timestamp * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayDescription(date: Date, now: Date) {
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const relative = dayKey(date) === dayKey(now) ? 'Today' : dayKey(date) === dayKey(yesterday) ? 'Yesterday' : ''
  const calendar = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  return { relative, calendar }
}

export function groupResultDays<T extends { run: CronRun }>(results: T[], now = new Date()) {
  const groups = new Map<string, { key: string; label: string; results: T[] }>()
  for (const result of results) {
    const date = runDate(result.run.started_at)
    const key = date ? dayKey(date) : 'undated'
    let group = groups.get(key)
    if (!group) {
      const description = date ? dayDescription(date, now) : undefined
      const label = description ? [description.relative, description.calendar].filter(Boolean).join(', ') : 'Date unavailable'
      group = { key, label, results: [] }
      groups.set(key, group)
    }
    group.results.push(result)
  }
  return [...groups.values()]
}

export function resultTime(timestamp?: number, now = new Date()): string {
  const date = runDate(timestamp)
  if (!date) return 'Date unavailable'
  const { relative, calendar } = dayDescription(date, now)
  return `${relative || calendar} at ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

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
