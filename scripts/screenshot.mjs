import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright-core'

const executablePath = process.env.AGORA_BROWSER_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(path => existsSync(path))
if (!executablePath) throw new Error('Set AGORA_BROWSER_PATH to an installed Chromium or Chrome executable.')

const now = Date.now() / 1000
const sessions = [
  { id: 'release', title: 'Release checklist', last_active: now, profile: 'default' },
  { id: 'interface', title: 'Chat interface improvements', last_active: now - 3600, profile: 'default' },
  { id: 'notes', title: 'Project notes', last_active: now - 86400, profile: 'default' },
  { id: 'weekend', title: 'Weekend plans', last_active: now - 86400 * 3, profile: 'default' },
  { id: 'ideas', title: 'A few ideas for the garden', last_active: now - 86400 * 10, profile: 'default' },
]
const messages = [
  { id: 1, role: 'user', content: 'Help me prepare the next release. Check the project and put together a short checklist.' },
  { id: 2, role: 'assistant', content: 'I’ll check the project commands and recent changes.' },
  { id: 3, role: 'tool', tool_name: 'read_file', content: 'Read package.json and README.md.' },
  { id: 4, role: 'tool', tool_name: 'terminal', content: 'Type checking, tests, and production build passed.' },
  { id: 5, role: 'assistant', content: 'The project checks pass. Here’s the release checklist:\n\n- Review the changes and update the release notes.\n- Verify login and a chat against your Hermes server.\n- Build the application and tag the release.\n\nRun the checks again before publishing:\n\n```sh\nagora-check\n```\n\nI’m checking the changelog in the background.' },
]
const server = await createServer({
  configFile: false, plugins: [vue()], base: '/agora/',
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
})
let browser
let liveSocket
let changelogFinished = false
const memoryAnswers = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    let result
    if (url.pathname === '/api/agora/connection') result = { mode: 'local', endpoint: 'https://hermes.example.com' }
    else if (url.pathname === '/api/status') result = { auth_required: true }
    else if (url.pathname === '/api/auth/me') result = { display_name: 'Demo operator' }
    else if (url.pathname === '/api/sessions') result = { sessions, total: sessions.length }
    else if (url.pathname === '/api/sessions/search') result = { results: [] }
    else if (url.pathname === '/api/sessions/release/messages') result = { session_id: 'release', profile: 'default', messages, pagination: { returned: messages.length, offset: 0, limit: 50 } }
    else if (url.pathname === '/api/auth/ws-ticket') result = { ticket: 'demo-ticket' }
    else throw new Error(`Unmocked screenshot API: ${url.pathname}`)
    await route.fulfill({ json: result })
  })
  await page.routeWebSocket('**/api/ws', socket => {
    liveSocket = socket
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat: false } } }))
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw))
      let result = {}
      if (request.method === 'model.options') result = { model: 'gpt-6.1-sol', provider: 'openai-codex', providers: [{ slug: 'openai-codex', name: 'OpenAI Codex', models: ['gpt-6.1-sol'], capabilities: { 'gpt-6.1-sol': { reasoning: true } } }, { slug: 'anthropic', name: 'Anthropic', models: ['claude-sonnet'] }] }
      else if (request.method === 'cli.exec') result = { blocked: false, code: 0, output: JSON.stringify({ provider: 'openai-codex', plan: 'Plus', windows: [{ label: 'Session', used_percent: request.params.argv.includes('anthropic') ? 40 : 24 }, { label: 'Weekly', used_percent: 39 }], details: [] }) }
      else if (request.method === 'command.dispatch') result = { type: 'exec', output: 'Pending memory writes (1):\n  abcdef01 [auto]  add to memory: Prefers concise release notes…\n\nApply: /memory approve <id>   Reject: /memory reject <id>' }
      else if (request.method === 'request.answer') { memoryAnswers.push(request.params.result); result = { status: 'ok' } }
      else if (request.method === 'config.get') result = { value: 'medium' }
      else if (request.method === 'session.active_list') result = { sessions: [{ id: 'runtime-interface', session_key: 'interface', status: 'working' }] }
      else if (request.method === 'session.resume') result = { session_id: 'runtime-release', stored_session_id: 'release', info: { title: 'Release checklist', profile_name: 'default', running: false } }
      else if (request.method === 'approval.pending') result = { approvals: [] }
      else if (request.method === 'subagent.list') result = { subagents: [{ subagent_id: 'changelog', goal: 'Review the changelog and check that the release notes cover the recent changes.', status: changelogFinished ? 'completed' : 'running', tool_count: 4, last_tool: 'read_file' }] }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  await page.goto(`${origin}/agora/?session=release`)
  const iconUrls = await page.locator('link[rel="icon"], link[rel="apple-touch-icon"]').evaluateAll(links => links.map(link => link.href))
  assert.equal(iconUrls.length, 4)
  for (const url of iconUrls) {
    assert.match(new URL(url).pathname, /^\/agora\/[^/]+\.(png|ico)$/)
    const response = await page.request.get(url)
    assert.ok(response.ok(), `Icon failed to load: ${url}`)
    assert.match(response.headers()['content-type'], /^image\//, `Icon URL did not serve an image: ${url}`)
  }
  await page.getByRole('heading', { name: 'Release checklist', exact: true }).waitFor()
  await page.getByText('Review the changelog and check that the release notes cover the recent changes.', { exact: true }).waitFor()
  await page.locator('textarea:not([disabled])').waitFor()
  await page.locator('select[aria-label="Model"]:not([disabled])').waitFor()
  const composer = page.locator('textarea')
  const emptyHeight = await composer.evaluate(element => element.clientHeight)
  await composer.fill(Array.from({ length: 10 }, () => 'A longer message line.').join('\n'))
  await page.waitForFunction(height => document.querySelector('textarea').clientHeight > height, emptyHeight)
  await composer.fill(Array.from({ length: 40 }, () => 'A longer message line.').join('\n'))
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea')
    return input.clientHeight <= 240 && input.scrollHeight > input.clientHeight
  })
  assert.equal(await composer.evaluate(element => getComputedStyle(element).resize), 'none')
  await composer.fill('')
  await page.waitForFunction(height => document.querySelector('textarea').clientHeight === height, emptyHeight)
  await composer.blur()
  await page.evaluate(() => document.fonts.ready)
  if (errors.length) throw new Error(errors.join('\n'))
  await page.getByRole('button', { name: 'Provider quota' }).click()
  await page.getByText('76% left', { exact: true }).waitFor()
  await page.getByRole('combobox', { name: 'Quota provider' }).selectOption('anthropic')
  await page.getByText('60% left', { exact: true }).waitFor()
  await page.getByRole('combobox', { name: 'Quota provider' }).selectOption('openai-codex')
  await page.getByText('76% left', { exact: true }).waitFor()
  const output = resolve('docs/screenshots')
  await mkdir(output, { recursive: true })
  await page.screenshot({ path: `${output}/chat-light.png` })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `${output}/chat-dark.png` })
  await composer.focus()
  await page.keyboard.press('Meta+k')
  const switcher = page.getByRole('dialog', { name: 'Switch conversation' })
  await switcher.waitFor()
  const switcherInput = page.getByRole('combobox', { name: 'Find a conversation' })
  assert.ok(await switcherInput.evaluate(element => element === document.activeElement))
  await page.keyboard.press('ArrowDown')
  assert.equal(await switcherInput.getAttribute('aria-activedescendant'), 'switcher-option-1')
  await switcherInput.fill('Release')
  await page.waitForFunction(() => document.querySelectorAll('.conversation-switcher [role="option"]').length === 1)
  await page.keyboard.press('Enter')
  await switcher.waitFor({ state: 'hidden' })
  await page.keyboard.press('Control+k')
  await switcher.waitFor()
  await page.keyboard.press('Escape')
  await switcher.waitFor({ state: 'hidden' })
  assert.ok(await composer.evaluate(element => element === document.activeElement))
  await page.locator('select[aria-label="Model"]:not([disabled])').waitFor()
  const pinned = page.locator('.pinned-tasks')
  const pinnedTop = await pinned.evaluate(element => element.getBoundingClientRect().top)
  await page.locator('.transcript').evaluate(element => { element.scrollTop = 0 })
  assert.equal(await pinned.evaluate(element => element.getBoundingClientRect().top), pinnedTop, 'Running tasks must stay pinned while scrolling.')
  await page.setViewportSize({ width: 390, height: 844 })
  const controlsFit = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('.setting-control, .composer-bottom > button')]
    return controls.every(element => {
      const bounds = element.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth
    })
  })
  assert.ok(controlsFit, 'Composer controls must fit a narrow screen.')
  changelogFinished = true
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'subagent.complete', session_id: 'runtime-release', payload: { subagent_id: 'changelog', status: 'completed', summary: 'Changelog checked.' } } }))
  await pinned.waitFor({ state: 'detached' })
  await page.locator('.transcript .background-tasks').waitFor()
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.interim', session_id: 'runtime-release', payload: { text: 'A follow-up reply.' } } }))
  await page.getByText('A follow-up reply.', { exact: true }).waitFor()
  assert.ok(await page.evaluate(() => {
    const task = document.querySelector('.transcript .background-tasks')
    const reply = [...document.querySelectorAll('.message')].find(element => element.textContent.includes('A follow-up reply.'))
    return Boolean(task.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING)
  }), 'Completed tasks must stay before later replies.')
  if (errors.length) throw new Error(errors.join('\n'))
  await page.setViewportSize({ width: 1280, height: 960 })
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', id: 'memory-review', method: 'approval', params: { request_id: 'memory-one', session_id: 'runtime-release', description: 'Save to memory: add to user profile', command: 'Prefers concise release notes, with the changes and verification results listed separately.', choices: ['once', 'deny'] } }))
  await page.locator('.app-rail .rail-badge').waitFor()
  await page.getByRole('button', { name: 'Memory', exact: true }).click()
  const memoryView = page.getByRole('region', { name: 'Memory review', exact: true })
  await memoryView.getByText('Preview only', { exact: true }).waitFor()
  await memoryView.getByText('Prefers concise release notes, with the changes and verification results listed separately.', { exact: true }).waitFor()
  assert.equal(memoryAnswers.length, 0, 'Opening memory must never approve a write.')
  await page.screenshot({ path: '/tmp/agora-memory-dark.png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: '/tmp/agora-memory-light.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: '/tmp/agora-memory-mobile.png' })
  assert.ok(await memoryView.evaluate(element => element.scrollWidth <= element.clientWidth), 'Memory review must fit on mobile.')
  await memoryView.getByRole('button', { name: 'Reject', exact: true }).click()
  await page.locator('.app-rail .rail-badge').waitFor({ state: 'detached' })
  assert.deepEqual(memoryAnswers, [{ choice: 'deny' }])
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await composer.waitFor({ state: 'visible' })
  if (errors.length) throw new Error(errors.join('\n'))
  console.info('Saved docs/screenshots/chat-light.png and chat-dark.png (sample data).')
} finally {
  await browser?.close()
  await server.close()
}
