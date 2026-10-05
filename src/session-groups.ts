import type { SessionRow } from './hermes/types'

export function groupSessions(sessions: SessionRow[], now = new Date()) {
  const dayStart = (daysAgo: number) => {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - daysAgo)
    return date.getTime() / 1000
  }
  const boundaries = [
    { label: 'Today', since: dayStart(0) },
    { label: 'Yesterday', since: dayStart(1) },
    { label: 'Previous 7 days', since: dayStart(7) },
    { label: 'Previous 30 days', since: dayStart(30) },
    { label: 'Older', since: -Infinity },
    { label: 'Undated', since: -Infinity },
  ]
  const groups = boundaries.map(group => ({ label: group.label, sessions: [] as SessionRow[] }))
  for (const session of sessions) {
    const timestamp = session.last_active
    const index = typeof timestamp === 'number' && Number.isFinite(timestamp)
      ? boundaries.findIndex(group => timestamp >= group.since) : groups.length - 1
    groups[index]!.sessions.push(session)
  }
  return groups.filter(group => group.sessions.length)
}
