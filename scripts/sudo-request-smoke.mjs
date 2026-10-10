import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright-core'

const executablePath = process.env.AGORA_BROWSER_PATH
if (!executablePath) throw new Error('Set AGORA_BROWSER_PATH to an installed Chromium.')
const server = await createServer({ configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
const calls = [], errors = [], consoleErrors = []
const pending = new Map()
const fictionalPassword = '  fictional-sudo-password with spaces  '
const command = 'sudo echo [REDACTED]\n<img src=x onerror=alert(1)>\n' + 'long-command-'.repeat(30)
let browser, socket, heldAnswer
let holdAnswer = false, sequence = 0
const event = (type, session_id, payload) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id, seq: ++sequence, payload } }))
function request(id, runtime = 'runtime-a') {
  const frame = { jsonrpc: '2.0', id, method: 'sudo', params: { session_id: runtime, command } }
  pending.set(id, frame)
  socket.send(JSON.stringify(frame))
}
function withdraw(id, runtime = 'runtime-a') {
  pending.delete(id)
  event('request.cancel', runtime, { id, reason: 'expired' })
}
try {
  await server.listen()
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let result
    if (path === '/api/agora/connection') result = { mode: 'local', endpoint: 'https://fixture.invalid' }
    else if (path === '/api/status') result = { auth_required: false }
    else if (path === '/api/sessions') result = { sessions: [{ id: 'a', title: 'Sudo fixture', profile: 'work' }, { id: 'b', title: 'Other fixture', profile: 'work' }], total: 2 }
    else if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) result = { session_id: path.split('/')[3], profile: 'work', messages: [{ id: 1, role: 'user', content: 'Fictional terminal task.' }, { id: 2, role: 'assistant', content: 'Fictional existing reply.' }], pagination: { returned: 2, offset: 0, limit: 50 } }
    else throw new Error(`Unexpected fixture API: ${path}`)
    await route.fulfill({ json: result })
  })
  await page.routeWebSocket('**/api/ws', ws => {
    socket = ws
    event('gateway.ready', undefined, { heartbeat: false })
    ws.onMessage(raw => {
      const call = JSON.parse(String(raw))
      calls.push(call)
      let result = {}
      if (call.method === 'session.active_list') result = { sessions: [{ id: 'runtime-a', session_key: 'a', status: 'idle' }, { id: 'runtime-b', session_key: 'b', status: 'idle' }] }
      else if (call.method === 'session.resume') result = { session_id: `runtime-${call.params.session_id}`, stored_session_id: call.params.session_id, info: { running: false }, open_requests: [...pending.values()].filter(entry => entry.params.session_id === `runtime-${call.params.session_id}`) }
      else if (call.method === 'process.list') result = { processes: [] }
      else if (call.method === 'subagent.list') result = { subagents: [] }
      else if (call.method === 'model.options') result = { providers: [] }
      else if (call.method === 'approval.pending') result = { approvals: [] }
      else if (call.method === 'config.get') result = { value: 'medium' }
      else if (call.method === 'client.capabilities') result = {}
      else if (call.method === 'request.answer') {
        assert.deepEqual(Object.keys(call.params).sort(), ['id', 'profile', 'result'])
        assert.equal(call.params.profile, 'work')
        assert.deepEqual(Object.keys(call.params.result), ['value'])
        pending.delete(call.params.id)
        if (holdAnswer) { heldAnswer = call; return }
        result = { status: 'ok' }
      } else throw new Error(`Unexpected fixture RPC: ${call.method}`)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
    })
  })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  await page.goto(`${origin}/?session=a`)
  await page.evaluate(() => document.fonts.ready)
  await page.getByRole('button', { name: 'Rename', exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('.header-actions button:nth-child(2)')?.disabled)
  const card = page.getByRole('region', { name: 'Sudo password request' })

  request('submit-1')
  await card.waitFor()
  assert.equal(await card.locator('pre').textContent(), command)
  assert.equal(await card.locator('img').count(), 0)
  assert.equal(await card.getByRole('button', { name: 'Submit', exact: true }).isDisabled(), true)
  const output = resolve(process.env.AGORA_SUDO_SCREENSHOT_DIR || `${process.env.TMPDIR}/agora-sudo-smoke`)
  await mkdir(output, { recursive: true })
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(100)
    await card.getByRole('button', { name: 'Cancel', exact: true }).scrollIntoViewIfNeeded()
    await card.getByRole('button', { name: 'Cancel', exact: true }).click({ trial: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await card.getByRole('button', { name: 'Cancel', exact: true }).evaluate(node => {
      const button = node.getBoundingClientRect(), transcript = document.querySelector('.transcript').getBoundingClientRect()
      return button.top >= transcript.top && button.bottom <= transcript.bottom
    }), true, 'Sudo actions must be reachable in the scrollable transcript')
    await page.waitForTimeout(100)
    await page.screenshot({ animations: 'disabled', path: `${output}/${viewport.width === 1280 ? 'desktop' : viewport.width === 390 ? 'mobile' : 'landscape'}.png` })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  const input = card.locator('input[type=password]')
  await input.fill(fictionalPassword)
  const submittedInput = await input.elementHandle()
  holdAnswer = true
  await card.getByRole('button', { name: 'Submit', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.request-card button')].every(button => button.disabled))
  assert.equal(await submittedInput.evaluate(node => node.value), '')
  await card.locator('form').evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(calls.filter(call => call.method === 'request.answer').length, 1)
  assert.deepEqual(heldAnswer.params, { id: 'submit-1', profile: 'work', result: { value: fictionalPassword } })
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: heldAnswer.id, result: { status: 'ok' } }))
  holdAnswer = false
  await card.waitFor({ state: 'detached' })

  request('cancel-1')
  await input.fill('fictional-cancelled-value')
  const cancelledInput = await input.elementHandle()
  await card.getByRole('button', { name: 'Cancel', exact: true }).click()
  await card.waitFor({ state: 'detached' })
  assert.equal(await cancelledInput.evaluate(node => node.value), '')
  assert.deepEqual(calls.filter(call => call.method === 'request.answer')[1].params, { id: 'cancel-1', profile: 'work', result: { value: '' } })

  request('expired-1')
  await input.fill('fictional-expiring-value')
  const expiredInput = await input.elementHandle()
  withdraw('expired-1')
  await card.waitFor({ state: 'detached' })
  assert.equal(await expiredInput.evaluate(node => node.value), '')
  request('offscreen-1', 'runtime-b')
  await page.waitForTimeout(50)
  assert.equal(await card.count(), 0)
  withdraw('offscreen-1', 'runtime-b')

  request('replay-1')
  await input.fill('fictional-replaced-value')
  const replacedInput = await input.elementHandle()
  request('replay-1')
  await page.waitForFunction(() => document.querySelector('.request-card input')?.value === '')
  assert.equal(await replacedInput.evaluate(node => node.value), '')
  await input.fill('fictional-disconnected-value')
  const disconnectedInput = await input.elementHandle()
  await socket.close({ code: 1002 })
  await page.getByRole('button', { name: 'Retry connection', exact: true }).waitFor()
  assert.equal(await disconnectedInput.evaluate(node => node.value), '')
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click()
  await input.waitFor()
  await page.waitForFunction(() => !document.querySelector('.request-card input')?.disabled)
  assert.equal(await input.inputValue(), '')
  assert.equal(calls.filter(call => call.method === 'request.answer').length, 2)
  withdraw('replay-1')
  await card.waitFor({ state: 'detached' })

  request('navigation-1')
  await input.fill('fictional-navigation-value')
  const navigatedInput = await input.elementHandle()
  await page.locator('.session-row').filter({ hasText: 'Other fixture' }).locator('button.session').click()
  await card.waitFor({ state: 'detached' })
  assert.equal(await navigatedInput.evaluate(node => node.value), '')
  await page.locator('.session-row').filter({ hasText: 'Sudo fixture' }).locator('button.session').click()
  await input.waitFor()
  assert.equal(await input.inputValue(), '')
  withdraw('navigation-1')
  await card.waitFor({ state: 'detached' })
  assert.equal(calls.filter(call => call.method === 'request.answer').length, 2)

  const storage = await page.evaluate(async () => ({ local: { ...localStorage }, session: { ...sessionStorage }, databases: await indexedDB.databases() }))
  assert.equal(JSON.stringify(storage).includes('fictional-'), false)
  assert.deepEqual(storage.databases, [])
  assert.equal(await page.locator('.transcript').innerText().then(text => text.includes('fictional-')), false)
  assert.equal(await page.locator('textarea').inputValue(), '')
  assert.equal(calls.some(call => ['prompt.submit', 'session.steer'].includes(call.method)), false)
  assert.deepEqual(errors, [])
  assert.deepEqual(consoleErrors, [])
  console.log(JSON.stringify({ browser: 'chromium', viewports: ['1280x900', '390x844', '844x390'], exactSubmit: true, emptyCancel: true, responses: 2, expiry: true, replay: true, reconnectCleared: true, navigationCleared: true, noChatOrStorageSecrets: true, pageErrors: errors, screenshots: output }))
} finally {
  await browser?.close()
  await server.close()
}
