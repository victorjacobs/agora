/* Push-only worker: intentionally no fetch handler or offline application cache. */
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()) })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })

function conversationURL(value) {
  if (typeof value !== 'string' || !value.startsWith('/?') || value.startsWith('//') || value.includes('\\')) return null
  const url = new URL(value, self.location.origin)
  if (url.origin !== self.location.origin || url.pathname !== '/' || url.hash) return null
  if ([...url.searchParams.keys()].some(key => !['session', 'profile'].includes(key))) return null
  if (['session', 'profile'].some(key => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key) || url.searchParams.get(key).length > 256)) return null
  return url
}

self.addEventListener('push', event => {
  let payload = {}
  try { payload = event.data?.json() || {} } catch { /* Malformed pushes must still be user-visible. */ }
  const url = conversationURL(payload.url)
  const title = typeof payload.title === 'string' ? Array.from(payload.title).slice(0, 80).join('') : 'Hermes'
  const body = typeof payload.body === 'string' ? Array.from(payload.body).slice(0, 160).join('') : 'Open Agora for an update.'
  event.waitUntil(self.registration.showNotification(title || 'Hermes', {
    body, icon: '/favicon-192.png', badge: '/favicon-192.png',
    tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 600) : 'agora-update',
    data: { url: url ? url.pathname + url.search : '/' },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const value = event.notification.data?.url
  const url = value === '/' ? new URL('/', self.location.origin) : conversationURL(value)
  if (!url) return
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const client = clients.find(candidate => new URL(candidate.url).origin === self.location.origin)
    if (client) { const navigated = await client.navigate(url.href); await (navigated || client).focus() }
    else await self.clients.openWindow(url.href)
  })())
})
