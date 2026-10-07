import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/markdown'

describe('Markdown links', () => {
  it.each([
    '[Website](https://example.com/page?q=one&other=two)',
    '<https://example.com/page>',
    '[Artifact](/artifacts/report.html)',
    '[Contact](mailto:hello@example.com)',
  ])('opens content links in a separate context: %s', text => {
    const container = document.createElement('div')
    container.innerHTML = renderMarkdown(text)
    const link = container.querySelector('a')!

    expect(link).not.toBeNull()
    expect(link.target).toBe('_blank')
    expect(link.relList.contains('noopener')).toBe(true)
    expect(link.relList.contains('noreferrer')).toBe(true)
  })
})
