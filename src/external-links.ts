export function openIosFirefoxLink(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches === true
  if (!ios || !standalone) return

  const target = event.target
  const container = event.currentTarget
  if (!(target instanceof Element) || !(container instanceof Element)) return
  const link = target.closest('a')
  if (!(link instanceof HTMLAnchorElement) || !container.contains(link) || link.hasAttribute('download')) return

  const href = link.getAttribute('href') || ''
  if (!/^https:\/\//i.test(href)) return
  let url: URL
  try { url = new URL(href) } catch { return }
  if (url.username || url.password) return

  window.open(`firefox://open-url?url=${encodeURIComponent(href)}`, '_blank', 'noopener,noreferrer')
  event.preventDefault()
}
