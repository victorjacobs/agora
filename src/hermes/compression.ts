export function compressionStatus(payload: Record<string, unknown>): boolean | undefined {
  if (payload.kind === 'compacting' || payload.kind === 'compressing') return true
  if (payload.kind === 'compacted' || payload.kind === 'ready') return false
  if (payload.kind !== 'lifecycle' || typeof payload.text !== 'string') return undefined
  const text = payload.text.toLowerCase()
  if (/compaction complete|compression complete|compression is currently blocked/.test(text)) return false
  // Older gateways leave these verified compression notices tagged as lifecycle.
  if (/compacting context|pre-api compression:|preflight compression:|resumed after .*compact|context too large .*compressing|compressed .*retrying|context reduced to .*retrying/.test(text)) return true
  return undefined
}
