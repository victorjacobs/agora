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
const sessions = [{ id: 'notes', title: 'Deployment notes', profile: 'default', last_active: now }]
const jobs = ['Daily brief', 'Backup check', 'Weather summary'].map((name, index) => ({ id: `job-${index}`, name, prompt: `Prepare the fictional ${name.toLowerCase()}.`, enabled: true, state: 'scheduled', schedule: { kind: 'cron', expr: `0 ${8 + index} * * *` }, schedule_display: `Every day at ${8 + index}:00`, next_run_at: new Date(Date.now() + 86400000).toISOString(), deliver: 'local' }))
const answers = ['Three priorities are ready for your review. No urgent follow-ups today.', 'All systems are healthy. The fictional backup completed without issues.', 'Mild conditions today with light cloud. A pleasant afternoon ahead.']
const approvals = ['Keep replies concise', 'Use European date formats'].map((text, index) => ({ request_id: `memory-${index}`, description: 'Save to memory: add to user profile', command: text, choices: ['once', 'deny'] }))
const errors = [], images = [], checks = []
const server = await createServer({ configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
try {
  await mkdir(output, { recursive: true })
  await server.listen()
  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    let result
    if (path === '/api/agora/connection') result = { mode: 'local', endpoint: 'https://fixture.invalid' }
    else if (path === '/api/status') result = { auth_required: false }
    else if (path === '/api/sessions') result = { sessions, total: 1 }
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
      let result = {}
      if (request.method === 'session.active_list') result = { sessions: [] }
      else if (request.method === 'session.resume') result = { session_id: 'runtime-notes', stored_session_id: 'notes', info: { running: false, title: 'Deployment notes', profile_name: 'default' } }
      else if (request.method === 'approval.pending') result = { approvals }
      else if (request.method === 'approval.respond') { const index = approvals.findIndex(approval => approval.request_id === request.params.request_id); if (index >= 0) approvals.splice(index, 1); result = { resolved: index >= 0 ? 1 : 0 } }
      else if (request.method === 'subagent.list') result = { subagents: [] }
      else if (request.method === 'process.list') result = { processes: [] }
      else if (request.method === 'model.options') result = { providers: [] }
      else if (request.method === 'config.get') result = { value: request.params.key === 'prompt' ? 'Ask before publishing.' : 'medium' }
      else if (request.method === 'profiles.describe') result = { name: 'default', soul: 'Be direct and practical.' }
      else if (request.method === 'command.dispatch') result = { type: 'exec', output: 'No pending memory writes.' }
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?session=notes`)
  await page.getByText('The checks passed. Two follow-ups are ready to review.', { exact: true }).waitFor()
  assert.match(await page.locator('meta[name="viewport"]').getAttribute('content'), /viewport-fit=cover/)
  await page.evaluate(() => document.documentElement.style.setProperty('--app-safe-bottom', '34px'))
  const rail = page.locator('.app-rail'), sheet = page.locator('.navigation-sheet'), selector = page.locator('.mobile-selector')
  const tab = name => rail.getByRole('button', { name, exact: true })
  const assertLayout = async (safeBottom = 34) => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.locator('.shell > main').evaluate(el => el.scrollWidth <= el.clientWidth), true)
    assert.equal(await page.locator('.shell > main').evaluate(el => el.getBoundingClientRect().left), 0)
    assert.ok((await rail.boundingBox()).y > 700)
    assert.equal(await rail.evaluate(el => Math.round(el.getBoundingClientRect().bottom)), 844)
    assert.equal(await rail.evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)), 6 + safeBottom)
    assert.equal(await rail.locator('button').evaluateAll((buttons, bottom) => buttons.every(button => button.getBoundingClientRect().bottom <= bottom), 844 - safeBottom), true)
    if (await selector.isVisible()) {
      const box = await selector.boundingBox()
      assert.equal(box.x, 16)
      assert.equal(box.width, 358)
      assert.ok(box.y < 100)
    }
  }
  const capture = async (name, view) => { await assertLayout(); const path = resolve(output, `${name}.png`); await page.screenshot({ path }); images.push({ path, view, viewport: page.viewportSize(), browser: browser.version(), simulatedSafeAreaBottom: 34, data: 'Fictional HTTP and WebSocket fixtures; actual full Vue App, normal / route; no private Hermes data.' }) }
  await page.locator('#prompt').fill('Keep this unsent draft')
  await page.locator('#prompt').blur()
  await page.locator('.transcript').evaluate(el => { el.scrollTop = 0 })
  const headerInspection = await page.evaluate(() => {
    const ancestors = []
    for (let el = document.querySelector('.mobile-menu'); el; el = el.parentElement) {
      const style = getComputedStyle(el)
      ancestors.push({ tag: el.tagName, class: el.className, filter: style.filter, backdropFilter: style.backdropFilter, backgroundImage: style.backgroundImage, opacity: style.opacity })
    }
    return { ancestors, dialogs: [...document.querySelectorAll('dialog')].map(el => ({ class: el.className, open: el.open, modal: el.matches(':modal'), display: getComputedStyle(el).display })) }
  })
  assert.equal(headerInspection.dialogs.every(dialog => !dialog.open && !dialog.modal && dialog.display === 'none'), true)
  assert.equal(headerInspection.ancestors.every(el => el.filter === 'none' && el.backdropFilter === 'none' && el.backgroundImage === 'none' && el.opacity === '1'), true)
  await capture('mobile-chat', 'Chat')
  assert.ok((await page.locator('.composer').boundingBox()).y < (await rail.boundingBox()).y)
  await page.getByRole('button', { name: 'Open conversations', exact: true }).click()
  assert.equal(await sheet.evaluate(el => el.open), true)
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.closest('.navigation-sheet') !== null), true)
  await page.keyboard.press('Escape')
  await sheet.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: 'Open conversations', exact: true }).evaluate(el => el === document.activeElement), true)
  await tab('Results').click()
  await page.locator('.result-card').first().waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.result-body .markdown').length === 3)
  assert.match(await selector.innerText(), /All results/)
  await capture('mobile-results', 'Results / All results')
  await selector.click()
  await sheet.getByRole('button', { name: 'Backup check', exact: true }).click()
  await sheet.waitFor({ state: 'hidden' })
  assert.match(await selector.innerText(), /Backup check/)
  assert.equal(await page.locator('.result-card').count(), 1)
  await selector.click()
  await sheet.getByRole('button', { name: 'All results', exact: true }).click()
  await sheet.waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.result-card').count(), 3)
  await tab('Memory').click()
  await page.locator('.memory-view .memory-approval').first().waitFor()
  await capture('mobile-memory', 'Memory / Pending updates')
  for (const section of ['Saved memory', 'User profile', 'Soul & instructions', 'Memory providers', 'Pending updates']) {
    await selector.click()
    await sheet.getByRole('button', { name: section, exact: section !== 'Pending updates' }).click()
    await sheet.waitFor({ state: 'hidden' })
    assert.match(await selector.innerText(), new RegExp(section))
  }
  await tab('Jobs').click()
  await page.locator('.cron-job-heading').waitFor()
  assert.match(await selector.innerText(), /Daily brief/)
  await capture('mobile-jobs', 'Jobs / Daily brief')
  await selector.click()
  await capture('mobile-job-selector', 'Jobs / Choose a job sheet')
  assert.equal(await sheet.evaluate(el => Math.round(el.getBoundingClientRect().bottom)), 844)
  assert.equal(await sheet.evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)), 34)
  assert.ok((await sheet.getByRole('button', { name: 'New job' }).boundingBox()).y + (await sheet.getByRole('button', { name: 'New job' }).boundingBox()).height <= 810)
  await sheet.getByRole('button', { name: /^Weather summary/ }).click()
  await sheet.waitFor({ state: 'hidden' })
  assert.match(await selector.innerText(), /Weather summary/)
  assert.match(await page.locator('.cron-job-heading').innerText(), /Weather summary/)
  await selector.click()
  await page.mouse.click(10, 100)
  await sheet.waitFor({ state: 'hidden' })
  assert.equal(await selector.evaluate(el => el === document.activeElement), true)
  await selector.click()
  await sheet.getByRole('button', { name: 'New job' }).click()
  await sheet.waitFor({ state: 'hidden' })
  await page.locator('.cron-editor').waitFor()
  assert.match(await selector.innerText(), /Choose a job/)
  await selector.click()
  await sheet.getByRole('button', { name: /^Weather summary/ }).click()
  await sheet.waitFor({ state: 'hidden' })
  await tab('Chat').click()
  assert.equal(await page.locator('#prompt').inputValue(), 'Keep this unsent draft')
  // Resolve the fictional approvals so Send is enabled for its reachability check.
  for (const remaining of [1, 0]) {
    await page.locator('.transcript').getByRole('button', { name: 'Reject', exact: true }).first().click()
    await page.waitForFunction(count => document.querySelectorAll('.transcript .memory-approval').length === count, remaining)
  }
  const prompt = page.locator('#prompt')
  const attachment = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 240; canvas.height = 160
    const context = canvas.getContext('2d')
    context.fillStyle = '#445b8c'; context.fillRect(0, 0, 240, 160)
    context.fillStyle = '#fff'; context.font = '18px sans-serif'
    context.fillText('Fictional checklist', 20, 45)
    context.fillText('✓ Review   ✓ Verify', 20, 90)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.getByLabel('Choose images').setInputFiles({ name: 'fictional-checklist.png', mimeType: 'image/png', buffer: Buffer.from(attachment, 'base64') })
  await page.locator('.attachment-preview img').waitFor()
  let longDraft = Array(7).fill('Review the fictional release checklist before publishing.').join('\n')
  await prompt.fill(longDraft)
  await page.keyboard.press('Enter')
  longDraft += '\n'
  assert.equal(await prompt.inputValue(), longDraft)
  await prompt.blur()
  for (const safeBottom of [34, 0]) {
    await page.evaluate(inset => document.documentElement.style.setProperty('--app-safe-bottom', `${inset}px`), safeBottom)
    await prompt.focus()
    assert.equal(await rail.isVisible(), true)
    // Simulate WebKit shrinking both viewports, not an actual soft keyboard.
    await page.evaluate(() => {
      window.fixtureInnerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight')
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 500 })
      window.dispatchEvent(new Event('resize'))
      window.visualViewport.dispatchEvent(new Event('resize'))
    })
    await page.waitForFunction(() => document.querySelector('.shell').classList.contains('keyboard-open'))
    assert.deepEqual(await page.evaluate(() => [innerHeight, visualViewport.height]), [500, 500])
    assert.equal(await rail.isVisible(), false)
    const composer = await page.locator('.composer').boundingBox()
    assert.ok(composer.y >= 60 && composer.y + composer.height <= 500)
    await page.locator('.send').click({ trial: true })
    await page.getByRole('button', { name: 'Remove fictional-checklist.png' }).click({ trial: true })
    assert.equal(await prompt.inputValue(), longDraft)
    const keyboardPath = resolve(output, `mobile-keyboard-inset-${safeBottom}.png`)
    await page.screenshot({ path: keyboardPath, clip: { x: 0, y: 0, width: 390, height: 500 } })
    images.push({ path: keyboardPath, view: 'Chat / focused long multiline draft and fictional attachment; tabs hidden', viewport: page.viewportSize(), screenshotClip: { width: 390, height: 500 }, simulatedInnerHeight: 500, simulatedVisualViewportHeight: 500, simulatedSafeAreaBottom: safeBottom, composer, browser: browser.version(), data: 'Actual full Vue App with fictional fixtures; no physical keyboard or private screenshots.' })
    await prompt.blur()
    await page.waitForFunction(() => !document.querySelector('.shell').classList.contains('keyboard-open'))
    assert.equal(await rail.isVisible(), true)
    await page.evaluate(() => {
      Object.defineProperty(window, 'innerHeight', window.fixtureInnerHeightDescriptor)
      delete window.fixtureInnerHeightDescriptor
      delete window.visualViewport.height
      window.dispatchEvent(new Event('resize'))
      window.visualViewport.dispatchEvent(new Event('resize'))
    })
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--app-height') === '844px')
    await assertLayout(safeBottom)
    assert.equal(await prompt.inputValue(), longDraft)
    assert.equal(await page.locator('.attachment-preview img').count(), 1)
    assert.ok((await page.locator('.composer').boundingBox()).y + (await page.locator('.composer').boundingBox()).height <= (await rail.boundingBox()).y)
    const restoredPath = resolve(output, `mobile-keyboard-restored-inset-${safeBottom}.png`)
    await page.screenshot({ path: restoredPath })
    images.push({ path: restoredPath, view: 'Chat / blur and full viewport restored; draft and attachment retained', viewport: page.viewportSize(), simulatedSafeAreaBottom: safeBottom, browser: browser.version(), data: 'Same fictional full-App HTTP/WS fixture' })
  }
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-safe-bottom'))
  checks.push('34px and 0px bottom insets: both innerHeight and visualViewport shrink to 500; tabs hidden; long multiline draft and attached fictional image retained; Send/remove trial clicks reachable; blur restores tabs; full viewport restores composer above tabs and correct inset spacing')
  checks.push('390x844: four labelled tabs; all result/Memory/job selections; modal focus containment/restoration, Escape, backdrop, selection closure; draft preserved; mobile Enter inserts a native newline; no horizontal overflow')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.app-rail')).flexDirection === 'column')
  await page.locator('.sidebar').waitFor({ state: 'visible' })
  assert.equal(await selector.count(), 0)
  assert.equal(await page.locator('.sidebar').isVisible(), true)
  assert.equal(await page.locator('.app-rail').evaluate(el => el.getBoundingClientRect().width), 54)
  const path = resolve(output, 'desktop-chat.png')
  await page.screenshot({ path })
  images.push({ path, view: 'Desktop Chat / unchanged rail and sidebar', viewport: page.viewportSize(), browser: browser.version(), data: 'Same fictional full-App HTTP/WS fixture' })
  checks.push('1280x900: desktop 54px vertical rail and permanent sidebar; mobile labels/selectors hidden')
  assert.deepEqual(errors, [])
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const manifest = { branch: git('branch', '--show-current'), base: git('merge-base', 'HEAD', 'origin/main'), changedFiles: git('status', '--short'), command: `AGORA_BROWSER_PATH=${executablePath} nix develop path:. --command node scripts/mobile-navigation-smoke.mjs`, result: 'PASS', images, checks, headerInspection, pageErrors: errors, limitations: ['Chromium emulation, not physical iOS', 'Bottom safe area simulated as 34px and 0px; physical home-indicator confirmation remains outstanding', 'Keyboard visibility simulated with BOTH innerHeight and visualViewport height at 500; cropped screenshots show actual app layout, not a physical virtual keyboard', 'Header computed styles and closed-dialog checks in Chromium do not prove iOS compositor behavior', 'Fictional fixtures, not live authenticated Hermes acceptance'] }
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest, null, 2))
  await context.close()
} finally {
  await browser?.close()
  await server.close()
}
