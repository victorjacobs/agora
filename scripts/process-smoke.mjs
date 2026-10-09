import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium, firefox } from 'playwright-core'

const engine = process.env.AGORA_BROWSER_ENGINE === 'firefox' ? firefox : chromium
const executablePath = process.env.AGORA_BROWSER_PATH
if (!executablePath) throw new Error('Set AGORA_BROWSER_PATH to an installed browser; optionally set AGORA_BROWSER_ENGINE=firefox.')
const rows = new Map([
  ['runtime-work-a', [{ session_id: 'p-a', command: 'npm run slow-build -- ' + 'long-argument-'.repeat(25), status: 'running', uptime_seconds: 12, output_tail: 'ready\n' }]],
  ['runtime-work-b', [{ session_id: 'p-b', command: 'sleep 100', status: 'running', uptime_seconds: 65, output_tail: 'offscreen\n' }]],
])
const calls = []
const errors = []
const server = await createServer({ configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser, socket
let sequence = 0
const event = (type, session_id, payload) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id, seq: ++sequence, payload } }))
try {
  await server.listen()
  browser = await engine.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let result
    if (path === '/api/agora/connection') result = { mode: 'local', endpoint: 'https://fixture.invalid' }
    else if (path === '/api/status') result = { auth_required: false }
    else if (path === '/api/sessions') result = { sessions: [{ id: 'a', title: 'Build chat', profile: 'work' }, { id: 'b', title: 'Other chat', profile: 'work' }], total: 2 }
    else if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) result = { session_id: path.split('/')[3], profile: 'work', messages: [{ id: 1, role: 'user', content: 'A fixture request.' }, { id: 2, role: 'assistant', content: 'Assistant already finished.' }], pagination: { returned: 2, offset: 0, limit: 50 } }
    else throw new Error(`Unexpected API: ${path}`)
    await route.fulfill({ json: result })
  })
  await page.routeWebSocket('**/api/ws', ws => {
    socket = ws
    event('gateway.ready', undefined, { heartbeat: false })
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw))
      calls.push(request)
      let result = {}
      if (request.method === 'session.active_list') result = { sessions: [{ id: 'runtime-work-a', session_key: 'a', status: 'idle' }, { id: 'runtime-work-b', session_key: 'b', status: 'idle' }] }
      else if (request.method === 'session.resume') result = { session_id: `runtime-work-${request.params.session_id}`, stored_session_id: request.params.session_id, info: { running: false } }
      else if (request.method === 'process.list') {
        assert.deepEqual(Object.keys(request.params).sort(), ['profile', 'session_id'])
        result = { processes: rows.get(request.params.session_id) || [] }
      } else if (request.method === 'process.kill') {
        assert.deepEqual(Object.keys(request.params).sort(), ['process_id', 'profile', 'session_id'])
        assert.equal(request.params.session_id, 'runtime-work-a')
        assert.equal(request.params.profile, 'work')
        assert.equal(request.params.process_id, 'p-a')
        const row = rows.get(request.params.session_id)[0]
        Object.assign(row, { status: 'exited', exit_code: -15, completion_reason: 'killed', output_tail: 'Stopped build output' })
        result = { status: 'killed', exit_code: -15, output: row.output_tail, completion_reason: 'killed' }
      } else if (request.method === 'subagent.list') result = { subagents: [{ subagent_id: 'child', goal: 'Pinned background task', status: 'running' }] }
      else if (request.method === 'model.options') result = { providers: [] }
      else if (request.method === 'approval.pending') result = { approvals: [] }
      else if (request.method === 'config.get') result = { value: 'medium' }
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  await page.goto(`${origin}/?session=a`)
  const panel = page.locator('.chat-processes')
  await panel.waitFor()
  assert.equal(await panel.evaluate(node => node.open), false)
  assert.equal(await page.locator('.composer .stop').count(), 0)
  await page.locator('.session-row').filter({ hasText: 'Other chat' }).locator('.session-indicator').waitFor()
  await panel.locator(':scope > summary').click()
  await panel.locator('.process-output > summary').click()
  event('agent.terminal.output', 'runtime-work-a', { process_id: 'p-a', chunk: 'x'.repeat(6000) })
  await page.waitForFunction(() => document.querySelector('.process-output pre')?.textContent === 'x'.repeat(4000))
  const output = resolve(process.env.AGORA_PROCESS_SCREENSHOT_DIR || `${process.env.TMPDIR}/agora-process-smoke`)
  await mkdir(output, { recursive: true })
  await page.screenshot({ path: `${output}/desktop.png` })
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    await page.locator('textarea').fill(Array.from({ length: 35 }, () => 'A long draft').join('\n'))
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Process commands/output must not overflow the viewport')
    assert.equal(await page.locator('.composer-footer').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), true, 'Process panel must not push composer below viewport')
    assert.equal(await page.locator('.conversation-header').evaluate(node => node.getBoundingClientRect().top >= 0), true, 'Process panel must not push header above viewport')
    await page.screenshot({ path: `${output}/${viewport.width === 390 ? 'mobile' : 'landscape'}.png` })
  }
  await page.locator('textarea').fill('')
  await page.setViewportSize({ width: 1280, height: 900 })
  rows.get('runtime-work-b')[0].status = 'exited'
  rows.get('runtime-work-b')[0].exit_code = 0
  rows.get('runtime-work-b')[0].output_tail = 'Offscreen result'
  event('terminal.close', 'runtime-work-b', { process_id: 'p-b' })
  await page.waitForFunction(() => ![...document.querySelectorAll('.session-row')].find(row => row.textContent.includes('Other chat'))?.querySelector('.session-indicator'))
  await page.locator('.session-row').filter({ hasText: 'Other chat' }).locator('button.session').click()
  await page.getByText('Offscreen result', { exact: true }).waitFor({ state: 'attached' })
  assert.equal(await page.locator('.composer-footer .chat-processes').count(), 0)
  await page.locator('.session-row').filter({ hasText: 'Build chat' }).locator('button.session').click()
  await panel.locator(':scope > summary').click()
  await panel.getByRole('button', { name: /^Stop process / }).click()
  await panel.waitFor({ state: 'detached' })
  await page.getByText('Stopped build output', { exact: true }).waitFor({ state: 'attached' })
  assert.equal(calls.filter(call => call.method === 'process.kill').length, 1)
  assert.equal(calls.some(call => ['process.stop', 'session.interrupt'].includes(call.method)), false)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ browser: engine.name(), viewports: ['1280x900', '390x844', '844x390'], outputLimit: 4000, individualStops: 1, globalOrAssistantStops: 0, pageErrors: errors, screenshots: output }))
} finally {
  await browser?.close()
  await server.close()
}
