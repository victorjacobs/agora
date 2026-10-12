import assert from 'node:assert/strict'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright-core'

const executablePath = process.env.AGORA_BROWSER_PATH
if (!executablePath) throw new Error('Set AGORA_BROWSER_PATH to an installed Chromium browser.')
const server = await createServer({ configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
const devices = [
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: 'phone-landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true },
  { name: 'tablet-landscape', viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true },
  { name: 'desktop', viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false },
  { name: 'narrow-desktop', viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: false },
]
let browser
try {
  await server.listen()
  browser = await chromium.launch({ executablePath, headless: true })
  for (const { name, ...device } of devices) {
    const context = await browser.newContext(device)
    const page = await context.newPage()
    const calls = []
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      let result
      if (path === '/api/agora/connection') result = { mode: 'local', endpoint: 'https://fixture.invalid' }
      else if (path === '/api/status') result = { auth_required: false }
      else if (path === '/api/sessions') result = { sessions: [{ id: 'composer', title: 'Fictional composer chat', profile: 'work' }], total: 1 }
      else if (path === '/api/sessions/composer/messages') result = { session_id: 'composer', profile: 'work', messages: [], pagination: { returned: 0, offset: 0, limit: 50 } }
      else throw new Error(`Unexpected fixture API: ${path}`)
      await route.fulfill({ json: result })
    })
    await page.routeWebSocket('**/api/ws', ws => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat: false } } }))
      ws.onMessage(raw => {
        const request = JSON.parse(String(raw))
        calls.push(request)
        let result = {}
        if (request.method === 'session.active_list') result = { sessions: [] }
        else if (request.method === 'session.resume') result = { session_id: 'runtime-composer', stored_session_id: 'composer', info: { running: false } }
        else if (request.method === 'approval.pending') result = { approvals: [] }
        else if (request.method === 'subagent.list') result = { subagents: [] }
        else if (request.method === 'process.list') result = { processes: [] }
        else if (request.method === 'model.options') result = { providers: [] }
        else if (request.method === 'config.get') result = { value: 'medium' }
        else if (request.method === 'prompt.submit') result = { status: 'accepted' }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      })
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?session=composer`)
    const input = page.locator('#prompt')
    const send = page.locator('.composer .send')
    await input.fill('First line')
    await send.waitFor()
    await page.waitForFunction(() => !document.querySelector('.composer .send').disabled)
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), device.hasTouch)
    const prompts = () => calls.filter(call => call.method === 'prompt.submit')
    await input.press(device.hasTouch ? 'Enter' : 'Shift+Enter')
    assert.equal(await input.inputValue(), 'First line\n', `${name}: Enter must insert a native newline`)
    await page.keyboard.type('Second line')
    await page.waitForTimeout(100)
    assert.equal(prompts().length, 0, `${name}: no prompt before explicit submission`)
    if (device.hasTouch) {
      assert.equal(await input.getAttribute('enterkeyhint'), 'enter')
      await send.tap()
    } else await input.press('Enter')
    await page.waitForFunction(() => document.querySelector('#prompt').value === '')
    assert.equal(prompts().length, 1)
    assert.deepEqual(prompts()[0].params, { session_id: 'runtime-composer', profile: 'work', text: 'First line\nSecond line' })
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ device: name, ...device, nativeNewline: true, promptsBeforeSubmission: 0, exactMultilinePrompt: true, pageErrors: errors }))
    await context.close()
  }
} finally {
  await browser?.close()
  await server.close()
}
