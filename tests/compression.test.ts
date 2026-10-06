import { describe, expect, it } from 'vitest'
import { compressionStatus } from '../src/hermes/compression'

describe('Hermes compression notices', () => {
  it('recognizes explicit progress and terminal states', () => {
    for (const kind of ['compacting', 'compressing']) expect(compressionStatus({ kind })).toBe(true)
    for (const kind of ['compacted', 'ready']) expect(compressionStatus({ kind })).toBe(false)
  })

  it('recognizes legacy lifecycle notices without treating unrelated compression text as progress', () => {
    for (const text of [
      '🗜️ Compacting context — still summarizing earlier conversation',
      '📦 Pre-API compression: ~12000 tokens near the context/output limit.',
      '📦 Preflight compression: ~12000 >=10000.',
      '💤 Resumed after 30s idle — compacting ~12000 before continuing.',
      '🗜️ Context too large (~12000) — compressing (1/3)...',
      '🗜️ Compressed 40 → 20 messages, retrying...',
      '🗜️ Context reduced to 10000 tokens (was 12000), retrying...',
    ]) expect(compressionStatus({ kind: 'lifecycle', text })).toBe(true)
    for (const text of ['Context compaction complete — continuing turn...', 'compression is currently blocked']) {
      expect(compressionStatus({ kind: 'lifecycle', text })).toBe(false)
    }
    expect(compressionStatus({ kind: 'heartbeat', text: 'Compacting context' })).toBeUndefined()
    expect(compressionStatus({ kind: 'lifecycle', text: 'Running compression tests' })).toBeUndefined()
  })
})
