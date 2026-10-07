import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, type Component } from 'vue'
import MarkdownMessage from '../src/MarkdownMessage.vue'
import ThinkingTrace from '../src/ThinkingTrace.vue'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mountLink(component: Component, href: string) {
  const host = document.createElement('div')
  const app = createApp(component, { text: `[**Website**](${href})`, ...(component === ThinkingTrace ? { active: false } : {}) })
  app.mount(host)
  cleanup = () => app.unmount()
  return host.querySelector('a')!
}

function setBrowser(userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', standalone = true, maxTouchPoints = 5) {
  vi.stubGlobal('navigator', { userAgent, standalone, maxTouchPoints })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
}

describe('installed iOS PWA links', () => {
  it.each([MarkdownMessage, ThinkingTrace])('opens an HTTPS link in Safari without rewriting its href (%s)', component => {
    setBrowser()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const href = 'https://example.com/report?next=https://other.test/a&value=%2F#part'
    const link = mountLink(component, href)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })

    link.querySelector('strong')!.dispatchEvent(event)

    expect(open).toHaveBeenCalledWith(`x-safari-https://${href.slice('https://'.length)}`, '_blank', 'noopener,noreferrer')
    expect(event.defaultPrevented).toBe(true)
    expect(link.getAttribute('href')).toBe(href)
  })

  it('recognizes desktop-class iPadOS in standalone display mode', () => {
    setBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', false)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    mountLink(MarkdownMessage, 'https://example.com').click()
    expect(open).toHaveBeenCalledWith('x-safari-https://example.com', '_blank', 'noopener,noreferrer')
  })

  it.each([
    ['iPhone Safari tab', 'iPhone', false, 5],
    ['Android PWA', 'Android', true, 5],
    ['desktop PWA', 'Macintosh', true, 0],
  ] as const)('leaves %s unchanged', (_name, userAgent, standalone, maxTouchPoints) => {
    setBrowser(userAgent, standalone, maxTouchPoints)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const link = mountLink(MarkdownMessage, 'https://example.com')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    expect(open).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it.each(['http://example.com', 'mailto:hello@example.com', '/report', '#section', 'https://user:pass@example.com'])('does not intercept %s', href => {
    setBrowser()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    mountLink(MarkdownMessage, href).dispatchEvent(event)
    expect(open).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])('preserves modified clicks: %o', options => {
    setBrowser()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...options })
    mountLink(MarkdownMessage, 'https://example.com').dispatchEvent(event)
    expect(open).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves downloads and already-handled events alone', () => {
    setBrowser()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const link = mountLink(MarkdownMessage, 'https://example.com/report')
    link.setAttribute('download', 'report')
    link.click()
    link.removeAttribute('download')
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    event.preventDefault()
    link.dispatchEvent(event)
    expect(open).not.toHaveBeenCalled()
  })

  it('ignores malformed HTTPS URLs without a component error', () => {
    setBrowser()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const link = mountLink(MarkdownMessage, 'https://example.com')
    link.setAttribute('href', 'https://%')
    link.click()
    expect(open).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
