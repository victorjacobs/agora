import { describe, expect, it } from 'vitest'
import { previewParts, renderMarkdown } from '../src/markdown'

describe('preview directives', () => {
  it('splits standalone complete local HTML directives, retaining surrounding Markdown', () => {
    expect(previewParts('Before\n\n::preview{file="~/charts/a.html"}\n\nAfter')).toEqual([
      { kind: 'markdown', text: 'Before\n\n', key: 'text-0' },
      { kind: 'preview', path: '~/charts/a.html', key: 'preview-2' },
      { kind: 'markdown', text: '\nAfter', key: 'text-3' },
    ])
  })
  it.each([
    '`::preview{file="/a.html"}`', '`multiline\n::preview{file="/a.html"}\ncode`', '```html\n::preview{file="/a.html"}\n```',
    '    ::preview{file="/a.html"}', 'prefix ::preview{file="/a.html"}',
    '::preview{file="/a.html"', '> ::preview{file="/a.html"}',
    '::preview{file="https://example.com/a.html"}', '::preview{file="//host/a.html"}',
    '::preview{file="/a/../b.html"}', '::preview{file="/a/%2e%2e/b.html"}',
    '::preview{file="/a.txt"}', '::preview{file="/a.html?x"}',
    '::preview{file="/a\\b.html"}', '::preview{file="/a\u007f.html"}',
    '::preview{file="/a\u0085.html"}',
  ])('keeps unsafe, quoted, code or incomplete input literal: %s', text => {
    expect(previewParts(text).some(part => part.kind === 'preview')).toBe(false)
  })
  it('does not allow arbitrary iframe HTML in ordinary Markdown', () => {
    expect(renderMarkdown('<iframe srcdoc="<script>alert(1)</script>"></iframe>')).not.toContain('<iframe')
  })
  it('bounds previews per message and keeps excess directives visible', () => {
    const text = Array.from({ length: 8 }, (_, index) => `::preview{file="/chart-${index}.html"}`).join('\n\n')
    const parts = previewParts(text)
    expect(parts.filter(part => part.kind === 'preview')).toHaveLength(4)
    expect(parts.some(part => part.kind === 'markdown' && part.text.includes('/chart-7.html'))).toBe(true)
  })
  it('recognizes CRLF directives and .htm files with spaces', () => {
    expect(previewParts('Before\r\n\r\n::preview{file="/charts/example one.htm"}\r\n\r\nAfter').some(part => part.kind === 'preview' && part.path === '/charts/example one.htm')).toBe(true)
  })
})