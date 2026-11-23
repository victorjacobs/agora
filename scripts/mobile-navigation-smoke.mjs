import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright-core'

const executablePath = process.env.AGORA_BROWSER_PATH
if (!executablePath) throw new Error('Set AGORA_BROWSER_PATH to an installed Chromium browser.')
const output = resolve(process.env.AGORA_EVIDENCE_DIR || resolve(tmpdir(), 'agora-mobile-navigation-evidence'))
const now = Date.now() / 1000
const sessions = [{ id: 'notes', title: 'Deployment notes', profile: 'default', pinned: false, last_active: now }]
const jobs = ['Daily brief', 'Backup check', 'Weather summary'].map((name, index) => ({ id: `job-${index}`, name, prompt: `Prepare the fictional ${name.toLowerCase()}.`, enabled: true, state: 'scheduled', schedule: { kind: 'cron', expr: `0 ${8 + index} * * *` }, schedule_display: `Every day at ${8 + index}:00`, next_run_at: new Date(Date.now() + 86400000).toISOString(), deliver: 'local' }))
const answers = ['Three priorities are ready for your review. No urgent follow-ups today.', 'All systems are healthy. The fictional backup completed without issues.', 'Mild conditions today with light cloud. A pleasant afternoon ahead.']
const approvals = ['Keep replies concise', 'Use European date formats'].map((text, index) => ({ request_id: `memory-${index}`, description: 'Save to memory: add to user profile', command: text, choices: ['once', 'deny'] }))
const errors = [], images = [], checks = []
let quotaCalls = 0, signedOut = false
const rpcCalls = []
const server = await createServer({ configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
try {
  await mkdir(output, { recursive: true })
  await server.listen()
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-features=OverscrollHistoryNavigation'] })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/auth/logout', async route => { signedOut = true; await route.fulfill({ json: {} }) })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    let result
    if (path === '/api/agora/connection') result = { mode: 'local', endpoint: 'https://fixture.invalid' }
    else if (path === '/api/status') result = { auth_required: true }
    else if (path === '/api/auth/me') { if (signedOut) return route.fulfill({ status: 401, json: {} }); result = { display_name: 'Fictional operator' } }
    else if (path === '/api/agora/push') result = { configured: false }
    else if (path === '/api/profiles/active') result = { current: 'default' }
    else if (path === '/api/sessions/notes') result = sessions[0]
    else if (path === '/api/sessions/new') result = { id: 'new', title: 'New chat', profile: 'default', pinned: false }
    else if (path === '/api/sessions') result = { sessions, total: 1, offset: Number(url.searchParams.get('offset')), limit: 20 }
    else if (path === '/api/cron/jobs') result = jobs
    else if (/^\/api\/cron\/jobs\/[^/]+\/runs$/.test(path)) { const id = path.split('/')[4]; result = { runs: [{ id: `run-${id}`, title: jobs.find(job => job.id === id).name, started_at: now - 3600, ended_at: now - 3500 }], limit: Number(url.searchParams.get('limit')) } }
    else if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) {
      const id = path.split('/')[3]
      const messages = id === 'notes' ? [{ id: 1, role: 'user', content: 'Summarise the latest run.' }, { id: 2, role: 'assistant', content: 'The checks passed. Two follow-ups are ready to review.' }] : [{ id: 1, role: 'assistant', content: answers[Number(id.at(-1))] }]
      result = { session_id: id, profile: 'default', messages, pagination: { returned: messages.length, offset: 0, limit: 50 } }
    } else if (path === '/api/memory') result = { active: '', builtin_files: { memory: 120, user: 60 }, providers: [] }
    else if (path === '/api/learning/graph') result = { nodes: [{ id: 'memory:memory:0:abcdef', kind: 'memory', memorySource: 'memory', label: 'Fictional release checklist' }, { id: 'memory:profile:1:123abc', kind: 'memory', memorySource: 'profile', label: 'Communication preferences' }], memory: [{ source: 'memory', fingerprint: 'abcdef', body: 'Verify checks before publishing.' }, { source: 'profile', fingerprint: '123abc', body: 'Prefers concise replies.' }] }
    else throw new Error(`Unexpected fixture API: ${path}`)
    await route.fulfill({ json: result })
  })
  await page.routeWebSocket('**/api/ws', ws => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat: false } } }))
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw))
      rpcCalls.push(request)
      let result = {}
      if (request.method === 'session.active_list') result = { sessions: [] }
      else if (request.method === 'session.resume') result = { session_id: 'runtime-notes', stored_session_id: 'notes', info: { running: false, title: 'Deployment notes', profile_name: 'default' } }
      else if (request.method === 'session.create') result = { session_id: 'runtime-new', stored_session_id: 'new', info: { running: false, title: 'New chat', profile_name: 'default' } }
      else if (request.method === 'approval.pending') result = { approvals }
      else if (request.method === 'approval.respond') { const index = approvals.findIndex(approval => approval.request_id === request.params.request_id); if (index >= 0) approvals.splice(index, 1); result = { resolved: index >= 0 ? 1 : 0 } }
      else if (request.method === 'subagent.list') result = { subagents: [] }
      else if (request.method === 'process.list') result = { processes: [] }
      else if (request.method === 'model.options') result = { provider: 'fixture', providers: [{ slug: 'fixture', name: 'Fictional provider', models: ['fictional'] }] }
      else if (request.method === 'cli.exec') { quotaCalls++; assert.deepEqual(request.params.argv, ['usage', '--provider', 'fixture', '--json', '--profile=default']); result = { blocked: false, code: 0, output: JSON.stringify({ windows: [], details: [] }) } }
      else if (request.method === 'config.get') result = { value: request.params.key === 'prompt' ? 'Ask before publishing.' : 'medium' }
      else if (request.method === 'profiles.describe') result = { name: 'default', soul: 'Be direct and practical.' }
      else if (request.method === 'command.dispatch') result = { type: 'exec', output: 'No pending memory writes.' }
      else if (request.method === 'client.capabilities') result = {}
      else throw new Error(`Unexpected fixture RPC: ${request.method}`)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?session=notes`)
  await page.getByText('The checks passed. Two follow-ups are ready to review.', { exact: true }).waitFor()
  assert.match(await page.locator('meta[name="viewport"]').getAttribute('content'), /viewport-fit=cover/)
  await page.evaluate(() => document.documentElement.style.setProperty('--app-safe-bottom', '34px'))
  const sheet = page.locator('.navigation-sheet'), menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  const open = async () => { await menu.click(); await sheet.waitFor({ state: 'visible' }); assert.equal(await sheet.evaluate(el => el.matches(':modal')), true) }
  const closed = async () => { await sheet.waitFor({ state: 'hidden' }); assert.equal(await menu.evaluate(el => el === document.activeElement), true) }
  const destination = async name => { await open(); await sheet.getByRole('button', { name, exact: true }).click(); await closed() }
  const select = async (navigation, name) => { await open(); await sheet.getByRole('navigation', { name: navigation, exact: true }).getByRole('button', { name, exact: false }).click(); await closed() }
  const assertLayout = async (safeBottom = 34) => {
    assert.equal(await page.evaluate(() => innerWidth), 390)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.locator('.shell > main').evaluate(el => el.scrollWidth <= el.clientWidth), true)
    assert.equal(await page.locator('.shell > main').evaluate(el => el.getBoundingClientRect().left), 0)
    assert.equal(await page.locator('.app-rail, .more-sheet, .mobile-selector').count(), 0)
    assert.equal(await page.locator('.shell').evaluate(el => Math.round(el.getBoundingClientRect().bottom)), 844 - safeBottom)
    assert.ok((await menu.boundingBox()).y < 60)
  }
  const capture = async (name, view) => { await page.evaluate(() => document.fonts.ready); await assertLayout(); const path = resolve(output, `${name}.png`); await page.screenshot({ path }); images.push({ path, view, viewport: page.viewportSize(), browser: browser.version(), simulatedSafeAreaBottom: 34, data: 'Fictional HTTP and WebSocket fixtures; actual full Vue App, normal / route; no private Hermes data.' }) }
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
  await page.getByRole('heading', { name: 'What are we getting into?', exact: true }).waitFor()
  await page.evaluate(() => document.documentElement.style.setProperty('--app-safe-bottom', '34px'))
  await capture('mobile-new-chat', 'New chat / empty state')
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?session=notes`)
  await page.getByText('The checks passed. Two follow-ups are ready to review.', { exact: true }).waitFor()
  await page.evaluate(() => document.documentElement.style.setProperty('--app-safe-bottom', '34px'))
  await page.locator('#prompt').fill('Keep this unsent draft')
  await page.locator('#prompt').blur()
  await page.locator('.transcript').evaluate(el => { el.scrollTop = 0 })
  const headerInspection = await page.evaluate(() => ({ dialogs: [...document.querySelectorAll('dialog')].map(el => ({ open: el.open, modal: el.matches(':modal'), display: getComputedStyle(el).display })) }))
  assert.equal(headerInspection.dialogs.every(dialog => !dialog.open && !dialog.modal && dialog.display === 'none'), true)
  await capture('mobile-chat', 'Chat / compact menu and title, no bottom tabs or body navigation')
  const composerBottom = await page.locator('.composer').evaluate(el => el.getBoundingClientRect().bottom)
  assert.equal(Math.round(composerBottom), 800)
  await open()
  assert.equal(await sheet.getByLabel('Search chats', { exact: true }).isVisible(), true)
  assert.equal(await sheet.getByRole('navigation', { name: 'Session history' }).isVisible(), true)
  assert.equal(await sheet.getByRole('button', { name: 'New chat', exact: true }).isVisible(), true)
  assert.equal(await sheet.locator('.notification-control, .provider-quota').count(), 0)
  assert.equal(await sheet.getByLabel('2 pending memory updates', { exact: true }).innerText(), '2')
  assert.equal(await sheet.locator('.drawer-account').innerText(), 'Fictional operator\nSign out')
  await capture('mobile-sidebar', 'Open shared left drawer / history, workspaces, account footer')
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.closest('.navigation-sheet') !== null), true)
  await page.locator('#prompt').evaluate(el => el.focus())
  assert.equal(await page.locator('#prompt').evaluate(el => el === document.activeElement), false)
  await page.keyboard.press('Escape'); await closed()
  await open(); await page.mouse.click(380, 100); await closed()
  // Selecting the already active destination is also a terminal close action.
  await destination('Chat')
  const resumesBeforeRoundTrip = rpcCalls.filter(call => call.method === 'session.resume').length
  await destination('Settings')
  assert.equal(quotaCalls, 0)
  assert.equal(await page.locator('.settings-view details').evaluate(el => el.open), false)
  assert.equal(await page.locator('.quota-toggle').getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator('.notification-control').count(), 1)
  await capture('mobile-settings', 'Settings / existing notifications, lazy quota and account controller')
  await page.locator('.quota-toggle').click()
  await page.waitForFunction(() => !document.querySelector('.quota-panel').textContent.includes('Checking quota'))
  assert.equal(quotaCalls, 1)
  await destination('Results')
  await page.waitForFunction(() => document.querySelectorAll('.result-body .markdown').length === 3)
  await capture('mobile-results', 'Results / All results, sidebar-only navigation')
  await select('Result jobs', 'Backup check')
  assert.equal(await page.locator('.result-card').count(), 1)
  await select('Result jobs', 'All results')
  assert.equal(await page.locator('.result-card').count(), 3)
  await destination('Memory')
  await page.locator('.memory-view .memory-approval').first().waitFor()
  await capture('mobile-memory', 'Memory / Pending updates')
  for (const section of ['Saved memory', 'User profile', 'Soul & instructions', 'Memory providers', 'Pending updates']) {
    await select('Memory sections', section)
    await open()
    assert.match(await sheet.getByRole('navigation', { name: 'Memory sections' }).locator('[aria-current="page"]').innerText(), new RegExp(section))
    await page.keyboard.press('Escape'); await closed()
  }
  await destination('Jobs')
  await page.locator('.cron-job-heading').waitFor()
  await capture('mobile-jobs', 'Jobs / Daily brief')
  await open()
  await capture('mobile-job-selector', 'Shared drawer / Jobs catalog and chat history')
  await sheet.getByRole('navigation', { name: 'Scheduled jobs' }).getByRole('button', { name: /^Weather summary/ }).click(); await closed()
  assert.match(await page.locator('.cron-job-heading').innerText(), /Weather summary/)
  await open(); await sheet.getByRole('button', { name: 'New job', exact: true }).click(); await closed()
  await page.locator('.cron-editor').waitFor()
  await select('Scheduled jobs', 'Weather summary')
  await destination('Chat')
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this unsent draft')
  assert.equal(new URL(page.url()).searchParams.get('session'), 'notes')
  assert.equal(rpcCalls.filter(call => call.method === 'session.resume').length, resumesBeforeRoundTrip)
  for (const remaining of [1, 0]) {
    await page.locator('.transcript').getByRole('button', { name: 'Reject', exact: true }).first().click()
    await page.waitForFunction(count => document.querySelectorAll('.transcript .memory-approval').length === count, remaining)
  }
  const prompt = page.locator('#prompt')
  const attachment = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160
    const context = canvas.getContext('2d'); context.fillStyle = '#445b8c'; context.fillRect(0, 0, 240, 160)
    context.fillStyle = '#fff'; context.font = '18px sans-serif'; context.fillText('Fictional checklist', 20, 45)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.getByLabel('Choose images').setInputFiles({ name: 'fictional-checklist.png', mimeType: 'image/png', buffer: Buffer.from(attachment, 'base64') })
  await page.locator('.attachment-preview img').waitFor()
  let longDraft = Array(7).fill('Review the fictional release checklist before publishing.').join('\n')
  await prompt.fill(longDraft); await page.keyboard.press('Enter'); longDraft += '\n'
  assert.equal(await prompt.inputValue(), longDraft)
  await prompt.blur()
  await destination('Settings'); await destination('Chat')
  assert.equal(await prompt.inputValue(), longDraft)
  assert.equal(await page.locator('.attachment-preview img').count(), 1)
  const cdp = await context.newCDPSession(page)
  for (const safeBottom of [34, 0]) {
    await page.evaluate(() => document.documentElement.style.removeProperty('--app-safe-bottom'))
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: safeBottom } })
    assert.equal(await page.locator('#app').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)), safeBottom)
    await open()
    assert.equal(await sheet.locator('.sidebar').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)), 16 + safeBottom)
    const footer = await sheet.locator('.drawer-account').boundingBox()
    assert.ok(footer.y + footer.height <= 844 - safeBottom)
    await page.keyboard.press('Escape'); await closed()
    await prompt.focus()
    await page.evaluate(() => {
      window.fixtureInnerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight')
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 500 })
      window.dispatchEvent(new Event('resize')); window.visualViewport.dispatchEvent(new Event('resize'))
    })
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--app-height') === '500px')
    const composer = await page.locator('.composer').boundingBox()
    assert.ok(composer.y >= 56 && composer.y + composer.height <= 500 - safeBottom)
    await page.locator('.send').click({ trial: true })
    await page.getByRole('button', { name: 'Remove fictional-checklist.png' }).click({ trial: true })
    assert.equal(await prompt.inputValue(), longDraft)
    const path = resolve(output, `mobile-keyboard-inset-${safeBottom}.png`)
    await page.screenshot({ path, clip: { x: 0, y: 0, width: 390, height: 500 } })
    images.push({ path, view: 'Chat / simulated keyboard, multiline draft and attachment', viewport: page.viewportSize(), simulatedSafeAreaBottom: safeBottom, simulatedInnerHeight: 500, simulatedVisualViewportHeight: 500, composer, browser: browser.version(), data: 'Fictional full-App fixtures; CDP env safe-area override; no physical keyboard.' })
    await prompt.blur()
    await page.evaluate(() => {
      Object.defineProperty(window, 'innerHeight', window.fixtureInnerHeightDescriptor); delete window.fixtureInnerHeightDescriptor; delete window.visualViewport.height
      window.dispatchEvent(new Event('resize')); window.visualViewport.dispatchEvent(new Event('resize'))
    })
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--app-height') === '844px')
    await assertLayout(safeBottom)
    assert.equal(await prompt.inputValue(), longDraft)
    assert.equal(await page.locator('.attachment-preview img').count(), 1)
  }
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 0 } })
  // Application gesture isolation, not WebKit/native edge-history acceptance.
  const touch = async (type, x = 2, y = 200) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }] })
  await touch('touchStart'); await touch('touchMove', 38); await touch('touchEnd')
  await sheet.waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('.conversation-drawer').style.getPropertyValue('--drawer-progress') === '1')
  await page.keyboard.press('Escape'); await closed()
  await touch('touchStart'); await touch('touchMove', 38); await touch('touchCancel')
  await sheet.waitFor({ state: 'hidden' })
  await touch('touchStart'); await touch('touchMove', 3, 260); await touch('touchEnd')
  assert.equal(await sheet.isVisible(), false)
  await page.setViewportSize({ width: 700, height: 390 })
  await open()
  await sheet.getByRole('navigation', { name: 'Session history' }).getByRole('button', { name: 'Deployment notes', exact: true }).click({ trial: true })
  await sheet.getByRole('button', { name: 'Sign out', exact: true }).click({ trial: true })
  const shortPath = resolve(output, 'mobile-short-drawer.png')
  await page.screenshot({ path: shortPath })
  images.push({ path: shortPath, view: 'Short mobile drawer / scroll access to history and account footer', viewport: page.viewportSize(), browser: browser.version(), data: 'Fictional actual Vue fixture; landscape-sized Chromium, not iOS' })
  await page.keyboard.press('Escape'); await closed()
  await page.setViewportSize({ width: 390, height: 844 })
  checks.push('Actual CDP touch: short admitted edge release completes opening; cancellation and vertical-scroll intent leave drawer closed; 700x390 short drawer scrolls history/footer into reachable hit-tested controls')
  checks.push('390x844: no tabs, More sheet, body selectors or reserved tab space; shared drawer opens from EVERY workspace; all Results/Memory/Jobs selections and Settings; native focus containment/restoration, Escape, backdrop and same-destination closure; lazy quota; draft/runtime URL and attachment retained; native touch Enter newline')
  checks.push('CDP env bottom inset 34px and 0px: wrapper and drawer safe-area ownership; simulated BOTH viewports shrink to 500px; long draft/image retained; Send/remove hit tested; full-height restoration')
  await open()
  await page.setViewportSize({ width: 1280, height: 900 })
  await sheet.waitFor({ state: 'hidden' })
  await page.locator('.app-rail').waitFor()
  assert.equal(await page.locator('.sidebar').isVisible(), true)
  assert.equal(await page.locator('.app-rail').evaluate(el => el.getBoundingClientRect().width), 54)
  assert.equal(await page.locator('.shell > main').evaluate(el => el.getBoundingClientRect().left), 340)
  let path = resolve(output, 'desktop-chat.png'); await page.screenshot({ path })
  images.push({ path, view: 'Desktop Chat / unchanged rail and permanent sidebar', viewport: page.viewportSize(), browser: browser.version(), data: 'Same fictional full-App fixture' })
  const cog = page.locator('.rail-settings'), cogBox = await cog.boundingBox()
  assert.ok(cogBox.y > 830 && cogBox.y + cogBox.height <= 900)
  await cog.click(); await page.locator('.settings-view').waitFor()
  assert.equal(await page.locator('.sidebar').isVisible(), false)
  assert.equal(await page.locator('.shell > main').evaluate(el => el.getBoundingClientRect().left), 54)
  await page.locator('.settings-content').evaluate(el => { el.style.minHeight = '1500px' })
  await page.locator('.settings-view').evaluate(el => { el.scrollTop = el.scrollHeight })
  assert.deepEqual(await cog.boundingBox(), cogBox); await cog.click({ trial: true })
  await page.locator('.settings-content').evaluate(el => { el.style.removeProperty('min-height') })
  await page.locator('.settings-view').evaluate(el => { el.scrollTop = 0 })
  path = resolve(output, 'desktop-settings.png'); await page.screenshot({ path })
  images.push({ path, view: 'Desktop Settings / unchanged workspace and fixed cog', viewport: page.viewportSize(), browser: browser.version(), data: 'Same fictional full-App fixture' })
  checks.push('1280x900: desktop 54px rail, 286px permanent sidebar, Settings full-width and cog bottom-pinned independently of scrolling; breakpoint closes modal')
  await page.setViewportSize({ width: 390, height: 844 })
  await open(); await sheet.getByRole('button', { name: 'New chat', exact: true }).click(); await closed()
  await page.waitForURL(url => url.searchParams.get('session') === 'new')
  assert.equal(rpcCalls.filter(call => call.method === 'session.create').length, 1)
  await open(); await sheet.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('link', { name: 'Sign in with Hermes', exact: true }).waitFor()
  assert.equal(await page.locator('dialog[open], .conversation-edge').count(), 0)
  assert.equal(signedOut, true)
  checks.push('New chat from non-chat workspace closes drawer and creates once; drawer sign-out reaches fixture endpoint and leaves no modal, inert workspace or edge target')
  assert.deepEqual(errors, [])
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const manifest = { branch: git('branch', '--show-current'), base: git('merge-base', 'HEAD', 'origin/main'), changedFiles: git('status', '--short'), command: `AGORA_BROWSER_PATH=${executablePath} nix develop path:. --command node scripts/mobile-navigation-smoke.mjs`, result: 'PASS', images, checks, headerInspection, pageErrors: errors, limitations: ['Chromium emulation, not physical iOS; OverscrollHistoryNavigation disabled for application gesture isolation', 'Bottom safe area simulated as 34px and 0px; physical home-indicator confirmation remains outstanding', 'Keyboard visibility simulated with BOTH innerHeight and visualViewport height at 500; cropped screenshots show actual app layout, not a physical virtual keyboard', 'Header computed styles and closed-dialog checks in Chromium do not prove iOS compositor behavior', 'Fictional fixtures, not live authenticated Hermes acceptance'] }
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest, null, 2))
  await context.close()
} finally {
  await browser?.close()
  await server.close()
}
