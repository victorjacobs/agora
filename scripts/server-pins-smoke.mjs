import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright-core'

const executablePath = process.env.AGORA_BROWSER_PATH
const output = process.env.AGORA_EVIDENCE_DIR
if (!executablePath || !output) throw new Error('Set AGORA_BROWSER_PATH and AGORA_EVIDENCE_DIR to scratch paths.')
const endpoint = 'https://fictional-hermes.invalid'
const rows = new Map([
  ['recent', { id: 'recent', profile: 'work', title: 'Fictional recent chat', pinned: false }],
  ['old', { id: 'old', profile: 'work', title: 'Fictional older favourite', pinned: false }],
  ['remote', { id: 'remote', profile: 'work', title: 'Pinned on another device', pinned: true }],
  ['retained', { id: 'retained', profile: 'work', title: 'Fictional offline favourite', pinned: false }],
])
const writes = [], errors = [], checks = []
let unavailable = false
const server = await createServer({ configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
try {
  await mkdir(output, { recursive: true })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath, headless: true })
  const device = async (legacy = []) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    if (legacy.length) await context.addInitScript(({ endpoint, legacy }) => {
      if (sessionStorage.getItem('fixture-seeded')) return
      localStorage.setItem('agora.pinned-conversations', JSON.stringify({ [endpoint]: legacy }))
      sessionStorage.setItem('fixture-seeded', 'yes')
    }, { endpoint, legacy })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname
      let json
      if (path === '/api/agora/connection') json = { mode: 'local', endpoint }
      else if (path === '/api/status') json = { auth_required: true }
      else if (path === '/api/auth/me') json = { display_name: 'Fictional operator' }
      else if (path === '/api/agora/push') json = { configured: false }
      else if (path === '/api/profiles/active') json = { current: 'work' }
      else if (path === '/api/sessions') json = { sessions: [...rows.values()].filter(row => row.id === 'recent' || row.pinned), total: 1, offset: Number(url.searchParams.get('offset')), limit: 20 }
      else if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) {
        const id = path.split('/')[3]
        json = { session_id: id, profile: 'work', messages: [{ id: 1, role: 'user', content: 'Fictional migration acceptance.' }], pagination: { returned: 1, offset: 0, limit: 50 } }
      } else if (/^\/api\/sessions\/[^/]+$/.test(path)) {
        const id = path.split('/')[3], row = rows.get(id)
        if (id === 'retained' && unavailable) return route.fulfill({ status: 503, json: { detail: 'Fictional temporary failure' } })
        if (!row) return route.fulfill({ status: 404, json: { detail: 'Missing' } })
        if (request.method() === 'PATCH') {
          const body = request.postDataJSON()
          assert.deepEqual(Object.keys(body).sort(), ['pinned', 'profile'])
          assert.equal(body.profile, 'work')
          assert.equal(typeof body.pinned, 'boolean')
          writes.push({ id, ...body }); row.pinned = body.pinned
          json = { ok: true, title: row.title, pinned: row.pinned }
        } else json = { ...row, pinned: row.pinned ? 1 : 0 }
      } else throw new Error(`Unexpected fixture API ${request.method()} ${path}`)
      await route.fulfill({ json })
    })
    await page.routeWebSocket('**/api/ws', ws => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat: false } } }))
      ws.onMessage(raw => {
        const request = JSON.parse(String(raw))
        const results = { 'client.capabilities': {}, 'session.active_list': { sessions: [] }, 'approval.pending': { approvals: [] }, 'subagent.list': { subagents: [] }, 'process.list': { processes: [] }, 'model.options': { providers: [] }, 'config.get': { value: 'medium' }, 'session.resume': { session_id: `runtime-${request.params?.session_id}`, stored_session_id: request.params?.session_id, info: { running: false, profile_name: 'work' } } }
        assert.ok(request.method in results, `Unexpected RPC ${request.method}`)
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }))
      })
    })
    await page.goto(`${origin}/?session=recent`)
    await page.getByRole('heading', { name: 'Fictional recent chat', exact: true }).waitFor()
    return page
  }
  const main = await device([{ id: 'old', profile: 'work' }])
  await main.waitForFunction(endpoint => JSON.parse(localStorage.getItem('agora.pinned-conversations'))[endpoint].length === 0, endpoint)
  assert.deepEqual(writes, [{ id: 'old', pinned: true, profile: 'work' }])
  await main.locator('[aria-label="Pinned"] .session-title').filter({ hasText: 'Fictional older favourite' }).waitFor()
  await main.reload()
  await main.locator('[aria-label="Pinned"] .session-title').filter({ hasText: 'Fictional older favourite' }).waitFor()
  assert.equal(writes.length, 1)
  checks.push('Automatic additive migration, reference acknowledgement, old/native pin union, reload without reimport')
  const second = await device()
  const oldRow = second.locator('.session-row').filter({ hasText: 'Fictional older favourite' })
  await oldRow.hover()
  await oldRow.getByRole('button', { name: 'Unpin chat', exact: true }).click()
  await second.waitForFunction(() => !document.querySelector('[aria-label="Pinned"]')?.textContent.includes('Fictional older favourite'))
  await main.evaluate(() => window.dispatchEvent(new Event('focus')))
  await main.waitForFunction(() => !document.querySelector('[aria-label="Pinned"]')?.textContent.includes('Fictional older favourite'))
  await main.reload()
  await main.getByRole('heading', { name: 'Fictional recent chat', exact: true }).waitFor()
  assert.equal(rows.get('old').pinned, false)
  assert.deepEqual(writes.filter(write => write.id === 'old').map(write => write.pinned), [true, false])
  checks.push('Second isolated browser context sees native pins; its unpin arrives on focus/reload without stale local repinning')
  rows.get('remote').pinned = false
  rows.get('old').pinned = true
  await main.evaluate(() => window.dispatchEvent(new Event('focus')))
  await main.locator('[aria-label="Pinned"] .session-title').filter({ hasText: 'Fictional older favourite' }).waitFor()
  await main.waitForFunction(() => !document.querySelector('[aria-label="Pinned"]')?.textContent.includes('Pinned on another device'))
  checks.push('Server-side flag changes refresh additively without client writes')
  unavailable = true
  const failure = await device([{ id: 'retained', profile: 'work' }])
  await failure.getByRole('button', { name: 'Retry pins', exact: true }).waitFor()
  await failure.locator('[aria-label="Pinned"] .session-title').filter({ hasText: 'Pinned chat' }).waitFor()
  assert.deepEqual(await failure.evaluate(endpoint => JSON.parse(localStorage.getItem('agora.pinned-conversations'))[endpoint], endpoint), [{ id: 'retained', profile: 'work' }])
  await failure.reload()
  await failure.getByRole('button', { name: 'Retry pins', exact: true }).waitFor()
  assert.equal(rows.get('retained').pinned, false)
  await failure.screenshot({ path: resolve(output, 'pending-old-pin.png') })
  unavailable = false
  await failure.getByRole('button', { name: 'Retry pins', exact: true }).click()
  await failure.waitForFunction(endpoint => JSON.parse(localStorage.getItem('agora.pinned-conversations'))[endpoint].length === 0, endpoint)
  await failure.locator('[aria-label="Pinned"] .session-title').filter({ hasText: 'Fictional offline favourite' }).waitFor()
  checks.push('503 retains the older local pin visibly and across reload; explicit retry confirms native import and removes only its reference')
  rows.get('retained').pinned = false
  const uncertain = await device([{ id: 'retained', profile: 'work', migrationAttempted: true }])
  const importButton = uncertain.getByRole('button', { name: 'Import old pins', exact: true })
  await importButton.waitFor()
  const beforeRetry = writes.length
  await Promise.all([
    uncertain.waitForResponse(response => response.url().includes('/api/sessions/retained?')),
    uncertain.getByRole('button', { name: 'Retry pins', exact: true }).click(),
  ])
  assert.equal(writes.length, beforeRetry)
  assert.equal(rows.get('retained').pinned, false)
  uncertain.once('dialog', dialog => dialog.dismiss())
  await importButton.click()
  assert.equal(writes.length, beforeRetry)
  uncertain.once('dialog', dialog => dialog.accept())
  await importButton.click()
  await uncertain.waitForFunction(endpoint => JSON.parse(localStorage.getItem('agora.pinned-conversations'))[endpoint].length === 0, endpoint)
  assert.equal(rows.get('retained').pinned, true)
  checks.push('Generic retry preserves another client’s unpin after an ambiguous import; explicit Import old pins requires confirmation, and cancellation sends no write')
  assert.deepEqual(errors, [])
  const report = { browser: browser.version(), data: 'Actual Vue App with fictional HTTP/WebSocket fixtures; no live Hermes or private database access.', checks, writes, errors }
  await writeFile(resolve(output, 'server-pins-smoke.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
