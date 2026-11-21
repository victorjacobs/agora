import assert from 'node:assert/strict'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright-core'

const executablePath = process.env.AGORA_BROWSER_PATH
if (!executablePath) throw new Error('Set AGORA_BROWSER_PATH to an installed Chromium browser.')
const server = await createServer({ configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  const calls = []
  let missing = false
  let unavailable = false
  let signedOut = false
  let releaseLookup
  let lookupStarted = false
  let lookupPath = ''
  page.on('pageerror', error => errors.push(error.message))
  const rows = ['a', 'b'].map(id => ({ id, title: `Fictional chat ${id}`, profile: 'work' }))
  await page.route('**/auth/logout', async route => {
    signedOut = true
    await route.fulfill({ json: {} })
  })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let result
    if (path === '/api/agora/connection') result = { mode: 'local', endpoint: 'https://fixture.invalid/hermes' }
    else if (path === '/api/status') result = { auth_required: true }
    else if (path === '/api/auth/me') {
      if (signedOut) return route.fulfill({ status: 401, json: { detail: 'Signed out' } })
      result = { user_id: 'fictional-operator', provider: 'fixture', display_name: 'Fictional operator' }
    } else if (path === '/api/profiles/active') result = { current: 'work' }
    else if (path === '/api/agora/push') result = { configured: false }
    else if (path === '/api/sessions') result = { sessions: rows, total: rows.length }
    else if (/^\/api\/sessions\/[^/]+$/.test(path)) {
      if (releaseLookup) { lookupStarted = true; lookupPath = path; await new Promise(resolve => { releaseLookup = resolve }) }
      if (missing || unavailable) return route.fulfill({ status: missing ? 404 : 503, json: { detail: 'Fictional unavailable chat' } })
      result = rows.find(row => row.id === path.split('/').at(-1))
    } else if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) {
      const id = path.split('/').at(-2)
      result = { session_id: id, profile: 'work', messages: [{ id: 1, role: 'user', content: `Fictional message ${id}` }], pagination: { returned: 1, offset: 0, limit: 50 } }
    } else {
      errors.push(`Unexpected fixture API: ${path}`)
      return route.abort()
    }
    await route.fulfill({ json: result })
  })
  await page.routeWebSocket('**/api/ws', ws => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat: false } } }))
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw))
      calls.push(request)
      let result = {}
      if (request.method === 'session.active_list') result = { sessions: [] }
      else if (request.method === 'session.resume' || request.method === 'session.create') {
        const id = request.method === 'session.create' ? 'new' : request.params.session_id
        result = { session_id: `runtime-${id}`, stored_session_id: id, info: { profile_name: 'work', title: `Fictional chat ${id}`, running: false } }
      } else if (request.method === 'approval.pending') result = { approvals: [] }
      else if (request.method === 'subagent.list') result = { subagents: [] }
      else if (request.method === 'process.list') result = { processes: [] }
      else if (request.method === 'model.options') result = { providers: [] }
      else if (request.method === 'config.get') result = { value: 'medium' }
      else if (request.method !== 'client.capabilities') errors.push(`Unexpected fixture RPC: ${request.method}`)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  const root = `http://127.0.0.1:${server.httpServer.address().port}/`
  const selected = id => page.waitForURL(url => url.searchParams.get('session') === id)
  const ready = () => page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="New chat"]')
    return button && !button.disabled
  })
  const bareReload = async () => { await page.evaluate(() => history.replaceState(null, '', '/')); await page.reload() }
  await page.goto(root)
  await ready()
  await page.getByRole('button', { name: 'Fictional chat a', exact: true }).click()
  await selected('a'); await ready()
  await bareReload()
  await selected('a'); await ready()
  await page.getByText('Fictional message a', { exact: true }).waitFor()
  const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('agora.last-chat:'))))
  assert.deepEqual(Object.values(stored).map(value => JSON.parse(value)), [{ id: 'a', profile: 'work' }])
  assert.ok(!JSON.stringify(stored).includes('runtime-') && !JSON.stringify(stored).includes('Fictional message'))
  await page.goto(`${root}?session=b`)
  await selected('b'); await ready()
  unavailable = true
  await bareReload(); await ready()
  await page.getByText('Could not reopen the last chat. Select a chat or reconnect to retry.', { exact: true }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('session'), null)
  unavailable = false
  await page.reload(); await selected('b'); await ready()
  releaseLookup = () => {}
  await bareReload()
  await ready()
  await new Promise(resolve => {
    const timer = setInterval(() => { if (lookupStarted) { clearInterval(timer); resolve() } }, 10)
  })
  await page.getByRole('button', { name: 'Fictional chat a', exact: true }).click()
  await selected('a'); await ready()
  const lookupSettled = page.waitForResponse(response => new URL(response.url()).pathname === lookupPath)
  releaseLookup(); releaseLookup = undefined
  await (await lookupSettled).finished()
  await bareReload(); await selected('a'); await ready()
  missing = true
  const resumes = calls.filter(call => call.method === 'session.resume').length
  await bareReload(); await ready()
  await page.waitForFunction(() => !Object.keys(localStorage).some(key => key.startsWith('agora.last-chat:')))
  assert.equal(new URL(page.url()).searchParams.get('session'), null)
  assert.equal(calls.filter(call => call.method === 'session.resume').length, resumes)
  missing = false
  await page.getByRole('button', { name: 'Fictional chat b', exact: true }).click()
  await selected('b'); await ready()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await selected('new'); await ready()
  await bareReload(); await ready()
  assert.equal(new URL(page.url()).searchParams.get('session'), null)
  await page.getByRole('button', { name: 'Fictional chat a', exact: true }).click()
  await selected('a'); await ready()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('link', { name: 'Sign in with Hermes', exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('agora.last-chat:'))), [])
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ reloadRestore: true, storedIdentityOnly: true, deepLinkPriority: true, temporaryFailureRetained: true, manualSelectionWins: true, missingTargetSkipped: true, newChatClears: true, logoutClears: true, pageErrors: errors }))
} finally {
  await browser?.close()
  await server.close()
}
