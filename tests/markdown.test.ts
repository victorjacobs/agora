import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/markdown'

describe('Markdown rendering', () => {
  it('renders emphasis, lists, code, links and line breaks', () => {
    const text = '**Important** and *emphasis* with `inline code`.\n\n- First item\n- Second item\n\n[Reference](https://example.com)\n\n```ts\nconst answer = 42\n<script>alert(1)</script>\n```\n\nFirst line\nSecond line'
    const message = document.createElement('div')
    message.innerHTML = renderMarkdown(text)
    expect(message.querySelector('strong')?.textContent).toBe('Important')
    expect(message.querySelector('em')?.textContent).toBe('emphasis')
    expect(message.querySelector('p code')?.textContent).toBe('inline code')
    expect([...message.querySelectorAll('li')].map(item => item.textContent)).toEqual(['First item', 'Second item'])
    expect(message.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(message.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(message.querySelector('pre code')?.textContent).toBe('const answer = 42\n<script>alert(1)</script>\n')
    expect(message.querySelector('p:last-child')?.innerHTML).toContain('First line<br>\nSecond line')
  })

  it.each([
    '[Website](https://example.com/page?q=one&other=two)',
    '<https://example.com/page>',
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
