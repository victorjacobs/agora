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
  const assertLayout = async () => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.locator('.shell > main').evaluate(el => el.scrollWidth <= el.clientWidth), true)
    assert.equal(await page.locator('.shell > main').evaluate(el => el.getBoundingClientRect().left), 0)
    assert.ok((await rail.boundingBox()).y > 700)
    assert.equal(await rail.evaluate(el => Math.round(el.getBoundingClientRect().bottom)), 844)
    assert.equal(await rail.evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)), 40)
    assert.equal(await rail.locator('button').evaluateAll(buttons => buttons.every(button => button.getBoundingClientRect().bottom <= 810)), true)
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
  // A synthetic viewport shrink exercises keyboard layout, not a physical keyboard.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 500 })
    document.querySelector('#prompt').focus()
    window.visualViewport.dispatchEvent(new Event('resize'))
  })
  await page.waitForFunction(() => document.querySelector('.shell').classList.contains('keyboard-open'))
  assert.equal(await rail.isVisible(), false)
  assert.ok((await page.locator('.composer').boundingBox()).y + (await page.locator('.composer').boundingBox()).height <= 500)
  await page.locator('#prompt').blur()
  await page.waitForFunction(() => !document.querySelector('.shell').classList.contains('keyboard-open'))
  await page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')) })
  await page.evaluate(() => document.documentElement.style.removeProperty('--app-safe-bottom'))
  assert.equal(await rail.evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)), 6)
  checks.push('34px bottom safe area: bar and sheet backgrounds reach the viewport edge, controls remain above the inset, and removing the inset restores normal spacing')
  checks.push('390x844: four labelled tabs; all result/Memory/job selections; modal focus containment/restoration, Escape, backdrop, selection closure; draft preserved; simulated visualViewport keyboard hide/blur restore; no horizontal overflow; composer above tabs')
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
  const manifest = { branch: git('branch', '--show-current'), base: git('merge-base', 'HEAD', 'origin/main'), changedFiles: git('status', '--short'), command: `AGORA_BROWSER_PATH=${executablePath} nix develop path:. --command node scripts/mobile-navigation-smoke.mjs`, result: 'PASS', images, checks, pageErrors: errors, limitations: ['Chromium emulation, not physical iOS', 'Bottom safe area simulated as 34px; physical home-indicator confirmation remains outstanding', 'Keyboard visibility simulated through visualViewport height; no physical virtual-keyboard evidence', 'Fictional fixtures, not live authenticated Hermes acceptance'] }
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest, null, 2))
  await context.close()
} finally {
  await browser?.close()
  await server.close()
}
