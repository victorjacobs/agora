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
  { id: 2, role: 'assistant', reasoning_content: 'Check the project commands first, then verify the release steps against the recent changes.', content: 'I’ll check the project commands and recent changes.' },
  { id: 3, role: 'tool', tool_name: 'read_file', content: 'Read package.json and README.md.' },
  { id: 4, role: 'tool', tool_name: 'terminal', content: 'Type checking, tests, and production build passed.' },
  { id: 5, role: 'assistant', content: 'The project checks pass. Here’s the release checklist:\n\n- Review the changes and update the release notes.\n- Verify login and a chat against your Hermes server.\n- Build the application and tag the release.\n\nRun the checks again before publishing:\n\n```sh\nagora-check\n```\n\nI’m checking the changelog in the background.' },
]
const server = await createServer({
  configFile: false, plugins: [vue()], base: '/',
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
})
let browser
let liveSocket
let changelogFinished = false
const memoryAnswers = []
const commandDecisions = []
const memoryReads = []
const memoryMutations = []
const imageUploads = []
const imagePrompts = []
let editedMemory = ''
let memoryDeleted = false
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
    else if (url.pathname === '/api/profiles/active') result = { active: 'other', current: 'default' }
    else if (url.pathname === '/api/memory') result = { active: '', builtin_files: { memory: 840, user: 215 }, providers: [{ name: 'honcho', description: 'External memory provider', status: 'not_configured', available: true, configured: false }] }
    else if (url.pathname === '/api/learning/graph') result = { nodes: [{ id: 'memory:memory:0:abcdef', kind: 'memory', memorySource: 'memory', label: 'Project release process' }, { id: 'memory:profile:1:123abc', kind: 'memory', memorySource: 'profile', label: 'Communication preferences' }], memory: [{ source: 'memory', fingerprint: 'abcdef', body: 'Run the project checks before publishing a release.' }, { source: 'profile', fingerprint: '123abc', body: 'Prefers concise answers and clear verification results.' }] }
    else if (url.pathname === '/api/learning/node' && route.request().method() !== 'GET') {
      const value = route.request().postDataJSON()
      memoryMutations.push({ method: route.request().method(), ...value })
      if (route.request().method() === 'PUT') editedMemory = value.content
      else memoryDeleted = true
      result = { ok: true }
    }
    else if (url.pathname === '/api/learning/node') { memoryReads.push(url.searchParams.get('id')); result = { ok: true, kind: 'memory', id: url.searchParams.get('id'), content: editedMemory || 'Run the project checks before publishing a release.\n\nRecord the result of each check, then verify login and a chat against the real Hermes server.' } }
    else if (url.pathname === '/api/fs/read-data-url') result = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ5sAAAAASUVORK5CYII=' }
    else if (url.pathname === '/api/status') result = { auth_required: true }
    else if (url.pathname === '/api/auth/me') result = { display_name: 'Demo operator' }
    else if (url.pathname === '/api/sessions') result = { sessions, total: sessions.length }
    else if (url.pathname === '/api/sessions/search') result = { results: [] }
    else if (url.pathname === '/api/sessions/release/messages') result = { session_id: 'release', profile: 'default', messages, pagination: { returned: messages.length, offset: 0, limit: 50 } }
    else if (url.pathname === '/api/auth/ws-ticket') result = { ticket: 'demo-ticket' }
    else throw new Error(`Unmocked screenshot API: ${url.pathname}`)
    if (url.pathname === '/api/learning/graph' && (editedMemory || memoryDeleted)) {
      if (memoryDeleted) {
        result.nodes = result.nodes.filter(node => node.memorySource !== 'memory')
        result.memory = result.memory.filter(card => card.source !== 'memory')
      } else {
        result.nodes[0] = { ...result.nodes[0], label: editedMemory }
        result.memory[0] = { ...result.memory[0], body: editedMemory }
      }
    }
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
      else if (request.method === 'commands.catalog') result = { pairs: [['/help', 'Show available commands'], ['/context', 'Show context usage'], ['/memory', 'Review memory writes'], ['/plan', 'Plan a task']] }
      else if (request.method === 'image.attach_bytes') { imageUploads.push(request.params); result = { attached: true, path: '/uploads/screenshot.png' } }
      else if (request.method === 'prompt.submit') { imagePrompts.push(request.params); result = { status: 'streaming' } }
      else if (request.method === 'slash.exec') result = { output: 'Available commands:\n/help — Show available commands\n/context — Show context usage' }
      else if (request.method === 'command.dispatch') result = { type: 'exec', output: 'Pending memory writes (1):\n  abcdef01 [auto]  add to memory: Prefers concise release notes…\n\nApply: /memory approve <id>   Reject: /memory reject <id>' }
      else if (request.method === 'approval.respond') { commandDecisions.push(request.params); result = { resolved: 1 } }
      else if (request.method === 'request.answer') { memoryAnswers.push(request.params.result); result = { status: 'ok' } }
      else if (request.method === 'profiles.describe') result = { name: request.params.name, description: 'Personal Hermes profile', soul: '# Hermes\n\nBe direct and practical. Explain choices when they matter.\n\nKeep replies concise, and use tools to verify uncertain details.' }
      else if (request.method === 'config.get') result = request.params.key === 'personality' ? { value: 'none' } : request.params.key === 'prompt' ? { prompt: 'Ask before publishing changes or sending messages to other people.' } : { value: 'medium' }
      else if (request.method === 'session.active_list') result = { sessions: [{ id: 'runtime-interface', session_key: 'interface', status: 'working' }] }
      else if (request.method === 'session.resume') result = { session_id: 'runtime-release', stored_session_id: 'release', info: { title: 'Release checklist', profile_name: 'default', running: false } }
      else if (request.method === 'approval.pending') result = { approvals: [] }
      else if (request.method === 'subagent.list') result = { subagents: [{ subagent_id: 'changelog', goal: 'Review the changelog and check that the release notes cover the recent changes.', status: changelogFinished ? 'completed' : 'running', tool_count: 4, last_tool: 'read_file' }] }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  await page.goto(`${origin}/?session=release`)
  const manifestUrl = await page.locator('link[rel="manifest"]').evaluate(link => link.href)
  assert.equal(new URL(manifestUrl).pathname, '/manifest.webmanifest')
  const manifestResponse = await page.request.get(manifestUrl)
  assert.ok(manifestResponse.ok())
  const manifest = await manifestResponse.json()
  assert.equal(manifest.display, 'standalone')
  assert.equal(new URL(manifest.start_url, manifestUrl).pathname, '/')
  const iconUrls = await page.locator('link[rel="icon"], link[rel="apple-touch-icon"]').evaluateAll(links => links.map(link => link.href))
  assert.equal(iconUrls.length, 4)
  for (const url of iconUrls) {
    assert.match(new URL(url).pathname, /^\/[^/]+\.(png|ico)$/)
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
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'status.update', session_id: 'runtime-release', payload: { kind: 'compacting', text: 'Compacting context — summarizing earlier conversation' } } }))
  const compression = page.locator('.compression-status')
  await compression.waitFor()
  assert.equal(await compression.innerText(), 'Compressing context…')
  assert.equal(await compression.locator('.session-indicator').count(), 1)
  const compressionTop = await compression.evaluate(element => element.getBoundingClientRect().top)
  await page.locator('.transcript').evaluate(element => { element.scrollTop = 0 })
  assert.equal(await compression.evaluate(element => element.getBoundingClientRect().top), compressionTop, 'Compression status must stay pinned while scrolling.')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: '/tmp/agora-compression-mobile-dark.png' })
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'status.update', session_id: 'runtime-release', payload: { kind: 'compacted', text: 'Context compaction complete' } } }))
  await compression.waitFor({ state: 'detached' })
  await page.emulateMedia({ colorScheme: 'light' })
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
  await page.setViewportSize({ width: 1280, height: 960 })
  await composer.fill('/')
  await page.getByRole('option', { name: '/help Show available commands' }).waitFor()
  await page.screenshot({ path: '/tmp/agora-commands-light.png' })
  await page.keyboard.press('Enter')
  assert.equal(await composer.inputValue(), '/help ')
  await page.keyboard.press('Enter')
  await page.locator('.command-output').waitFor()
  assert.equal(await composer.inputValue(), '')
  await page.emulateMedia({ colorScheme: 'dark' })
  await composer.fill('/c')
  await page.getByRole('option', { name: '/context Show context usage' }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: '/tmp/agora-commands-mobile-dark.png' })
  assert.ok(await page.locator('.slash-picker').evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0
  }), 'Slash commands must fit on mobile.')
  await page.keyboard.press('Escape')
  await page.locator('.slash-picker').waitFor({ state: 'detached' })
  await composer.fill('')
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', id: 'command-review', method: 'approval', params: { request_id: 'command-one', session_id: 'runtime-release', description: 'Remove generated build output before rebuilding.', command: 'rm -rf dist\n npm run build', choices: ['once', 'session', 'always', 'deny'] } }))
  const commandCard = page.getByRole('region', { name: 'Command approval', exact: true })
  await commandCard.waitFor()
  await page.screenshot({ path: '/tmp/agora-command-approval-mobile-dark.png' })
  assert.deepEqual(memoryAnswers, [{ choice: 'deny' }], 'Showing a command approval must never answer it.')
  assert.ok(await commandCard.evaluate(element => element.scrollWidth <= element.clientWidth), 'Command approval must fit on mobile.')
  await commandCard.getByRole('button', { name: 'Allow once', exact: true }).click()
  await commandCard.waitFor({ state: 'detached' })
  assert.deepEqual(memoryAnswers.at(-1), { choice: 'once' })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.emulateMedia({ colorScheme: 'light' })
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'approval.request', session_id: 'runtime-release', payload: { request_id: 'command-two', command: 'rm -rf dist', description: 'Remove generated build output.', choices: ['once', 'deny'] } } }))
  await commandCard.waitFor()
  await page.screenshot({ path: '/tmp/agora-command-approval-light.png' })
  assert.deepEqual(commandDecisions, [])
  await commandCard.getByRole('button', { name: 'Reject', exact: true }).click()
  await commandCard.waitFor({ state: 'detached' })
  assert.deepEqual(commandDecisions, [{ session_id: 'runtime-release', profile: 'default', request_id: 'command-two', choice: 'deny' }])
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', session_id: 'runtime-release', payload: {} } }))
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'reasoning.delta', session_id: 'runtime-release', payload: { text: 'Review the release steps' } } }))
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'reasoning.delta', session_id: 'runtime-release', payload: { text: ' before publishing. <script>Plain text only</script>' } } }))
  const thinking = page.locator('.thinking-trace').last()
  await thinking.locator('.session-indicator').waitFor()
  assert.equal(await thinking.evaluate(element => element.open), false, 'Thinking traces must start collapsed.')
  await thinking.locator('summary').click()
  await thinking.getByText('Review the release steps before publishing. <script>Plain text only</script>', { exact: true }).waitFor()
  assert.equal(await thinking.locator('script').count(), 0)
  await page.screenshot({ path: '/tmp/agora-thinking-light.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await thinking.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/tmp/agora-thinking-mobile-dark.png' })
  assert.ok(await thinking.evaluate(element => element.scrollWidth <= element.clientWidth), 'Thinking traces must fit on mobile.')
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 'runtime-release', payload: { text: 'Ready for review.' } } }))
  await thinking.locator('.session-indicator').waitFor({ state: 'detached' })
  assert.equal(await thinking.evaluate(element => element.open), true, 'Reply streaming must not collapse a trace the user opened.')
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: 'runtime-release', payload: {} } }))
  await page.locator('select[aria-label="Model"]:not([disabled])').waitFor()
  assert.ok(await page.locator('.thinking-trace').count() >= 2, 'Live traces must survive completion recovery when history omits them.')
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByRole('button', { name: 'Memory', exact: true }).click()
  const memoryNavigation = page.getByRole('navigation', { name: 'Memory sections', exact: true })
  await memoryNavigation.getByRole('button', { name: 'Saved memory', exact: true }).click()
  const savedMemory = page.getByRole('region', { name: 'Saved memory', exact: true })
  await savedMemory.getByText('Project release process', { exact: true }).waitFor()
  assert.deepEqual(memoryReads, [], 'Full memory entries must load only on explicit request.')
  await savedMemory.getByRole('button', { name: 'Read full entry' }).click()
  await savedMemory.getByText('Record the result of each check, then verify login and a chat against the real Hermes server.', { exact: false }).waitFor()
  assert.deepEqual(memoryReads, ['memory:memory:0:abcdef'])
  await page.screenshot({ path: '/tmp/agora-saved-memory-light.png' })
  await savedMemory.getByRole('button', { name: 'Edit', exact: true }).click()
  await savedMemory.getByRole('textbox', { name: 'Memory text' }).fill('Verify login and chat before each release.')
  await page.screenshot({ path: '/tmp/agora-memory-edit-light.png' })
  await savedMemory.getByRole('button', { name: 'Save changes', exact: true }).click()
  await savedMemory.getByText('Memory updated.', { exact: true }).waitFor()
  assert.deepEqual(memoryMutations, [{ method: 'PUT', id: 'memory:memory:0:abcdef', profile: 'default', content: 'Verify login and chat before each release.' }])
  await savedMemory.getByRole('button', { name: 'Read full entry' }).click()
  await savedMemory.getByRole('button', { name: 'Delete', exact: true }).click()
  await savedMemory.getByText('Delete this memory from saved memory?', { exact: true }).waitFor()
  assert.equal(memoryMutations.length, 1, 'Opening deletion must not delete an entry.')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/tmp/agora-memory-delete-mobile-dark.png' })
  assert.ok(await savedMemory.evaluate(element => element.scrollWidth <= element.clientWidth), 'Memory controls must fit on mobile.')
  await savedMemory.getByRole('button', { name: 'Delete memory', exact: true }).click()
  await savedMemory.getByText('Memory deleted.', { exact: true }).waitFor()
  await savedMemory.getByText('Hermes returned no saved entries.', { exact: true }).waitFor()
  assert.deepEqual(memoryMutations.at(-1), { method: 'DELETE', id: 'memory:memory:0:abcdef', profile: 'default' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1280, height: 960 })
  await memoryNavigation.getByRole('button', { name: 'User profile', exact: true }).click()
  await page.getByRole('region', { name: 'User profile', exact: true }).getByText('Communication preferences', { exact: true }).waitFor()
  assert.equal(await page.getByRole('region', { name: 'User profile', exact: true }).getByText('Project release process', { exact: true }).count(), 0)
  await memoryNavigation.getByRole('button', { name: 'Memory providers', exact: true }).click()
  await page.getByRole('region', { name: 'Memory providers', exact: true }).getByText('Built-in memory', { exact: true }).waitFor()
  await memoryNavigation.getByRole('button', { name: 'Soul & instructions', exact: true }).click()
  const soulView = page.getByRole('region', { name: 'Soul & instructions', exact: true })
  await soulView.getByText('Be direct and practical. Explain choices when they matter.', { exact: false }).waitFor()
  await page.screenshot({ path: '/tmp/agora-soul-light.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.screenshot({ path: '/tmp/agora-soul-mobile-dark.png' })
  assert.ok(await soulView.evaluate(element => element.scrollWidth <= element.clientWidth), 'Soul inspection must fit on mobile.')
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.emulateMedia({ colorScheme: 'light' })
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ5sAAAAASUVORK5CYII=', 'base64')
  const uploadInput = page.getByLabel('Choose images')
  await uploadInput.setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: imageBytes })
  await page.locator('.attachment-preview img').waitFor()
  assert.equal(imageUploads.length, 0, 'Selecting an image must not upload before Send.')
  await page.getByRole('button', { name: 'Remove screenshot.png' }).click()
  await page.locator('.attachment-preview').waitFor({ state: 'detached' })
  await uploadInput.setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: imageBytes })
  await page.locator('.attachment-preview img').waitFor()
  await composer.fill('What is in this image?')
  await page.screenshot({ path: '/tmp/agora-image-attachment-light.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: '/tmp/agora-image-attachment-mobile-dark.png' })
  await page.getByRole('button', { name: 'Send ↑', exact: true }).click()
  await page.locator('.user-images img').waitFor()
  assert.equal(imageUploads.length, 1)
  assert.equal(imageUploads[0].content_base64, imageBytes.toString('base64'))
  assert.equal(imageUploads[0].session_id, 'runtime-release')
  assert.equal(imagePrompts.at(-1).text, 'What is in this image?')
  await page.locator('.attachment-preview').waitFor({ state: 'detached' })
  messages.push({ id: 6, role: 'user', content: 'What is in this image?\n@image:/uploads/screenshot.png\n[screenshot]' })
  liveSocket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', session_id: 'runtime-release', payload: {} } }))
  await page.locator('select[aria-label="Model"]:not([disabled])').waitFor()
  await page.locator('.user-images img').waitFor()
  const recoveredBubble = page.locator('.message.user').last()
  assert.ok((await recoveredBubble.innerText()).includes('What is in this image?'))
  assert.ok(!(await recoveredBubble.innerText()).includes('@image:'))
  assert.ok(!(await recoveredBubble.innerText()).includes('[screenshot]'))
  await page.screenshot({ path: '/tmp/agora-recovered-image-mobile-dark.png' })
  const thumbnail = page.locator('.user-images img').last()
  await thumbnail.click()
  const imageViewer = page.getByRole('dialog', { name: 'Enlarged image' })
  await imageViewer.waitFor()
  assert.equal(await imageViewer.locator('img').getAttribute('src'), await thumbnail.getAttribute('src'))
  assert.ok(await imageViewer.getByRole('button', { name: 'Close image' }).evaluate(element => element === document.activeElement), 'Image viewer must receive focus.')
  await imageViewer.locator('img').click()
  assert.equal(await imageViewer.count(), 1, 'Clicking the enlarged image must not dismiss it.')
  assert.ok(await imageViewer.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
  }), 'Image viewer must fit the mobile viewport.')
  await page.screenshot({ path: '/tmp/agora-image-viewer-mobile-dark.png' })
  await page.keyboard.press('Escape')
  await imageViewer.waitFor({ state: 'detached' })
  assert.ok(await thumbnail.evaluate(element => element === document.activeElement), 'Closing the viewer must restore focus to the thumbnail.')
  await thumbnail.press('Enter')
  await imageViewer.waitFor()
  await imageViewer.getByRole('button', { name: 'Close image' }).click()
  await imageViewer.waitFor({ state: 'detached' })
  await thumbnail.click()
  await imageViewer.waitFor()
  await page.mouse.click(1, 1)
  await imageViewer.waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.emulateMedia({ colorScheme: 'light' })
  await thumbnail.press('Space')
  await imageViewer.waitFor()
  await page.screenshot({ path: '/tmp/agora-image-viewer-light.png' })
  await imageViewer.getByRole('button', { name: 'Close image' }).click()
  await imageViewer.waitFor({ state: 'detached' })

  if (errors.length) throw new Error(errors.join('\n'))
  console.info('Saved docs/screenshots/chat-light.png and chat-dark.png (sample data).')
} finally {
  await browser?.close()
  await server.close()
}
