import { describe, expect, it } from 'vitest'
import { historyMessages, mergeHistory, restoreInflight } from '../src/hermes/transcript'
import { renderMarkdown } from '../src/markdown'

describe('transcripts', () => {
  it('uses durable row IDs, respects projections, and merges overlapping pages', () => {
    const page = historyMessages({ session_id: 'stored', pagination: { returned: 4, offset: 0, limit: 50 }, messages: [
      { id: 1, role: 'user', content: 'private scaffolding', display_kind: 'hidden' },
      { id: 2, role: 'user', content: 'model wrapper', display_content: 'actual question' },
      { id: 3, role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ] })
    expect(page.map(message => message.text)).toEqual(['actual question', 'answer'])
    expect(mergeHistory(page, page)).toHaveLength(2)
  })

  it('restores the active assistant without duplicating the persisted user', () => {
    const messages = [{ key: 'row-1', rowId: 1, role: 'user', text: 'question' }]
    const recovered = restoreInflight(messages, { session_id: 'runtime', info: {}, running: true, inflight: { user: 'question', assistant: 'partial' } })
    expect(recovered.map(message => message.text)).toEqual(['question', 'partial'])
    expect(restoreInflight(recovered, { session_id: 'runtime', info: {}, running: true, inflight: { user: 'question', assistant: 'partial' } })).toEqual(recovered)
  })

  it('renders Markdown and code without executing HTML or loading remote images', () => {
    const rendered = renderMarkdown('**bold**\n\n```html\n<script>alert(1)</script>\n```\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n![tracking](https://example.test/image.png)')
    expect(rendered).toContain('<strong>bold</strong>')
    expect(rendered).toContain('&lt;script&gt;')
    expect(rendered).not.toMatch(/<script|<img|href="javascript:/)
  })
})
