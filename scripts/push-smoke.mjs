import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright-core'
import webpush from 'web-push'

const output = resolve(process.env.AGORA_EVIDENCE_DIR || process.env.TMPDIR + '/agora-pwa-push')
const executablePath = process.env.AGORA_BROWSER_PATH
if (!executablePath) throw new Error('Set AGORA_BROWSER_PATH to installed Chromium.')
const server = await createServer({ configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
const errors = [], calls = [], checks = []
let browser
try {
  await mkdir(output, { recursive: true }); await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', permissions: ['notifications'] })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const registrations = []
  cdp.on('ServiceWorker.workerRegistrationUpdated', event => { for (const registration of event.registrations) if (!registration.isDeleted) registrations.push(registration) })
  await cdp.send('ServiceWorker.enable')
  page.on('pageerror', error => errors.push(error.message))
  const endpoint = 'https://fcm.googleapis.com/fcm/send/synthetic-browser-device'
  let subscribed = false
  const key = webpush.generateVAPIDKeys().publicKey
  await page.addInitScript(({ endpoint }) => {
    let subscription = null
    window.__pushFixture = { gesture: false, unsubscribed: 0 }
    const create = () => ({ endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'synthetic-browser-key', auth: 'synthetic-browser-auth' } }), unsubscribe: async () => { subscription = null; window.__pushFixture.unsubscribed++; return true } })
    // Only the browser push-service subscription adapter is synthetic. SW registration and CDP push use Chromium itself.
    PushManager.prototype.getSubscription = async () => subscription
    PushManager.prototype.subscribe = async options => { if (!options.userVisibleOnly) throw new Error('Must be user-visible'); subscription = create(); return subscription }
    const request = Notification.requestPermission.bind(Notification)
    let permission = 'default'
    Object.defineProperty(Notification, 'permission', { get: () => permission })
    Notification.requestPermission = async () => { window.__pushFixture.gesture = navigator.userActivation.isActive; permission = await request(); return permission }
  }, { endpoint })
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method()
    let value
    if (path === '/api/agora/push') {
      calls.push(method)
      if (method === 'POST') { assert.equal(route.request().postDataJSON().subscription.endpoint, endpoint); subscribed = true; value = { enabled: true } }
      else if (method === 'DELETE') { assert.equal(route.request().postDataJSON().endpoint, endpoint); subscribed = false; value = { enabled: false } }
      else value = { configured: true, publicKey: key, devices: subscribed ? [createHash('sha256').update(endpoint).digest('hex')] : [], observer: 'watching', watched: 1 }
    } else if (path === '/api/agora/connection') value = { mode: 'local', endpoint: 'https://fictional.invalid' }
    else if (path === '/api/status') value = { auth_required: false }
    else if (path === '/api/sessions') value = { sessions: [{ id: 'fictional', title: 'Fictional project', profile: 'work' }], total: 1 }
    else if (path === '/api/sessions/fictional/messages') { assert.equal(url.searchParams.get('profile'), 'work'); value = { session_id: 'fictional', profile: 'work', messages: [{ role: 'assistant', content: 'Your fictional report is ready.' }], pagination: { returned: 1, offset: 0, limit: 50 } } }
    else throw new Error(`Unexpected fixture API ${path}`)
    await route.fulfill({ json: value })
  })
  await context.routeWebSocket('**/api/ws', socket => {
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }))
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw)); let result
      if (frame.method === 'session.resume') { assert.equal(frame.params.profile, 'work'); result = { session_id: 'runtime-fictional', session_key: 'fictional', resumed: 'fictional', messages: [], info: { profile_name: 'work', title: 'Fictional project' } } }
      else if (frame.method === 'client.capabilities') result = {}
      else if (frame.method === 'session.active_list') result = { sessions: [] }
      else if (frame.method === 'approval.pending') result = { approvals: [] }
      else if (frame.method === 'subagent.list') result = { subagents: [] }
      else if (frame.method === 'process.list') result = { processes: [] }
      else if (frame.method === 'model.options') result = { providers: [] }
      else if (frame.method === 'config.get') result = { value: 'medium' }
      else throw new Error(`Unexpected browser RPC ${frame.method}`)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
    })
  })
  await page.goto(origin + '/?session=fictional&profile=work')
  await page.getByText('Your fictional report is ready.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'More', exact: true }).click()
  await page.locator('.more-sheet').getByRole('button', { name: 'Settings', exact: true }).click()
  const toggle = page.getByRole('button', { name: 'Enable response notifications', exact: true })
  await toggle.waitFor(); await toggle.click()
  await page.getByText('Background notifications on', { exact: true }).waitFor()
  assert.equal(await page.locator('.settings-view details').evaluate(el => el.open), false)
  assert.equal(await page.locator('.settings-view details p').first().isVisible(), false)
  assert.equal(await page.evaluate(() => window.__pushFixture.gesture), true)
  assert.equal(subscribed, true)
  checks.push('Original tap reaches native permission request; actual SW registered; synthetic PushManager subscription linked through authenticated-adapter fixture')
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: resolve(output, 'mobile-notifications-on.png') })
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  const registration = registrations.find(entry => entry.scopeURL === origin + '/')
  assert.ok(registration, JSON.stringify(registrations))
  await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: registration.registrationId, data: JSON.stringify({ title: 'Fictional project', body: 'Your report is ready.', url: '/?session=fictional&profile=work', tag: 'fixture-ready' }) })
  let notifications = []
  for (let attempt = 0; attempt < 100; attempt++) {
    notifications = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(notification => ({ title: notification.title, body: notification.body, tag: notification.tag, data: notification.data })))
    if (notifications.some(notification => notification.tag === 'fixture-ready')) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.deepEqual(notifications, [{ title: 'Fictional project', body: 'Your report is ready.', tag: 'fixture-ready', data: { url: '/?session=fictional&profile=work' } }])
  checks.push('Chromium CDP delivers an actual push event to real SW; native showNotification and getNotifications verify visible title/body/link')
  await page.getByRole('button', { name: 'Disable response notifications', exact: true }).click()
  await page.getByText('Notifications off', { exact: true }).waitFor()
  assert.equal(subscribed, false)
  assert.equal(await page.evaluate(() => window.__pushFixture.unsubscribed), 1)
  assert.equal(await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length), 0)
  assert.ok(calls.includes('POST') && calls.includes('DELETE'))
  checks.push('Disable deletes server registration, unsubscribes device, closes already-displayed notifications')
  await page.screenshot({ path: resolve(output, 'mobile-notifications-off.png') })
  const iosPage = await context.newPage()
  iosPage.on('pageerror', error => errors.push(error.message))
  await iosPage.addInitScript(() => { Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }); Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' }) })
  await iosPage.goto(origin + '/?session=fictional&profile=work')
  await iosPage.getByRole('button', { name: 'More', exact: true }).click()
  await iosPage.locator('.more-sheet').getByRole('button', { name: 'Settings', exact: true }).click()
  await iosPage.getByText(/On iPhone or iPad, use Share/).waitFor()
  assert.equal(await iosPage.getByRole('button', { name: 'Enable response notifications', exact: true }).isDisabled(), true)
  await iosPage.screenshot({ path: resolve(output, 'mobile-install-help.png') })
  checks.push('Simulated iOS browser outside standalone mode shows Home Screen installation help and cannot request unsupported desktop permission')
  assert.deepEqual(errors, [])
  await writeFile(resolve(output, 'browser-evidence.json'), JSON.stringify({ checks, errors, calls, notifications, browser: browser.version(), viewport: { width: 390, height: 844 }, limits: ['Fictional data only; no real Hermes access', 'PushManager subscription is an explicit fixture, not a live FCM registration', 'CDP push is native worker delivery injection, not Apple/APNs acceptance', 'Warm/cold click logic exercised separately in VM tests; no OS-level click automation'] }, null, 2))
  console.info(JSON.stringify({ checks, output, errors }, null, 2))
} finally { await browser?.close(); await server.close() }
