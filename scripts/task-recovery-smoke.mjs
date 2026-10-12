import assert from 'node:assert/strict'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright-core'

const executablePath = process.env.AGORA_BROWSER_PATH
if (!executablePath) throw new Error('Set AGORA_BROWSER_PATH to an installed Chromium browser.')
const messages = [
  { id: 1, role: 'user', content: 'Old delegation question' },
  { id: 2, role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — batch-a]\nConsolidated results\n\n--- ✓ TASK 1/2: Roster child A  (status=completed) ---\nSuccessful check A.\n\n--- ✗ TASK 2/2: Other child  (status=failed) ---\nError', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'batch-a', task_count: 2, completed_count: 1, failed_count: 1, display_text: 'Batch A finished with issues' } },
  { id: 3, role: 'assistant', content: 'Reply between completed delegations' },
  { id: 4, role: 'system', content: '[ASYNC DELEGATION COMPLETE — batch-b]\n--- RESULT ---\nSuccessful check B.', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'batch-b', task_count: 1, completed_count: 1, failed_count: 0, display_text: 'Batch B completed' } },
  { id: 5, role: 'user', content: 'Latest unrelated question' },
  { id: 6, role: 'assistant', content: 'Latest unrelated reply' },
]
let bounded = true
let roster = [
  { subagent_id: 'child-a', delegation_id: 'batch-a', status: 'completed', goal: 'Roster child A' },
  { subagent_id: 'child-b', delegation_id: 'batch-b', status: 'failed', goal: 'Roster child B' },
]
let sequence = 0
let socket
const calls = [], errors = [], historyReads = []
const server = await createServer({ configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
const event = (type, payload) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: 'runtime-work-a', seq: ++sequence, payload } }))
let browser
try {
  await server.listen()
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    let result
    if (url.pathname === '/api/agora/connection') result = { mode: 'local', endpoint: 'https://fixture.invalid' }
    else if (url.pathname === '/api/status') result = { auth_required: false }
    else if (url.pathname === '/api/sessions') result = { sessions: [{ id: 'a', title: 'Delegation chat', profile: 'work' }, { id: 'b', title: 'Other chat', profile: 'work' }], total: 2 }
    else if (/^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3]
      const offset = Number(url.searchParams.get('offset') || 0)
      historyReads.push({ id, offset })
      const rows = id === 'b' ? [{ id: 10, role: 'user', content: 'Other chat only' }] : bounded ? offset ? messages.slice(0, 4) : messages.slice(4) : messages
      result = { session_id: id, profile: 'work', messages: rows, pagination: { returned: rows.length, offset, limit: bounded && id === 'a' && !offset ? 2 : 50 } }
    } else throw new Error(`Unexpected API: ${url.pathname}`)
    await route.fulfill({ json: result })
  })
  await page.routeWebSocket('**/api/ws', ws => {
    socket = ws
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { heartbeat: false } } }))
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw))
      calls.push(request)
      let result = {}
      if (request.method === 'session.active_list') result = { sessions: [] }
      else if (request.method === 'session.resume') result = { session_id: `runtime-work-${request.params.session_id}`, stored_session_id: request.params.session_id, info: { running: false } }
      else if (request.method === 'subagent.list') result = { subagents: request.params.session_id === 'runtime-work-a' ? roster : [] }
      else if (request.method === 'process.list') result = { processes: [] }
      else if (request.method === 'approval.pending') result = { approvals: [] }
      else if (request.method === 'model.options') result = { providers: [] }
      else if (request.method === 'config.get') result = { value: 'medium' }
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  await page.goto(`${origin}/?session=a`)
  const transcript = page.locator('.transcript .conversation-width')
  await transcript.getByText('Roster child A', { exact: true }).waitFor()
  assert.equal(await transcript.evaluate(node => node.querySelector('.background-tasks').compareDocumentPosition(node.querySelector('.message')) & Node.DOCUMENT_POSITION_FOLLOWING), 4, 'Missing history must leave roster cards before the loaded transcript, not at the latest reply')
  await page.getByRole('button', { name: '↑ Load older messages' }).click()
  const expected = ['Old delegation question', 'Batch A finished with issues', 'Reply between completed delegations', 'Batch B completed', 'Latest unrelated question', 'Latest unrelated reply']
  const readOrder = () => transcript.locator(':scope > .message').evaluateAll(nodes => nodes.map(node => node.querySelector('.task-result-title')?.textContent || node.querySelector('.markdown')?.textContent?.trim() || node.textContent.trim()))
  await page.waitForFunction(() => document.querySelectorAll('.completion-notice').length === 2)
  assert.deepEqual(await readOrder(), expected, 'Pagination must restore each saved batch between its own neighboring replies')
  assert.equal(await transcript.locator('.background-tasks').count(), 1, 'An unindexed cold batch child must remain visible: aggregate metadata cannot prove coverage')
  event('subagent.complete', { subagent_id: 'child-a', delegation_id: 'batch-a', task_index: 0, goal: 'Roster child A', status: 'completed', summary: 'Successful check A.' })
  const indexed = transcript.locator('.background-tasks li').filter({ has: page.getByText('Roster child A', { exact: true }) })
  await indexed.getByText('Result', { exact: true }).click()
  assert.equal(await indexed.locator('pre').textContent(), 'Successful check A.')
  assert.equal(await transcript.locator('.background-tasks').count(), 1, 'Even indexed batch children remain: unescaped text cannot authenticate result boundaries')
  assert.equal(historyReads.some(read => read.offset === 2), true)
  await transcript.locator('.task-result > summary').first().click()
  assert.match(await transcript.locator('.task-result').first().innerText(), /2 tasks · 1 completed · 1 failed/)
  assert.equal(await transcript.locator('.task-result pre').first().textContent(), messages[1].content)

  bounded = false
  roster = []
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.completion-notice').length === 2)
  assert.deepEqual(await readOrder(), expected, 'Cold refresh must recover stored cards with an empty roster and no runtime cache')
  assert.equal(await transcript.locator('.background-tasks').count(), 0)
  await page.locator('.session-row').filter({ hasText: 'Other chat' }).locator('button.session').click()
  await page.getByText('Other chat only', { exact: true }).waitFor()
  assert.equal(await transcript.locator('.completion-notice').count(), 0)
  await page.locator('.session-row').filter({ hasText: 'Delegation chat' }).locator('button.session').click()
  await page.waitForFunction(() => document.querySelectorAll('.completion-notice').length === 2)
  assert.deepEqual(await readOrder(), expected)

  const resumes = calls.filter(call => call.method === 'session.resume').length
  socket.close({ code: 1001, reason: 'Fixture reconnect' })
  await page.waitForFunction(() => !document.querySelector('.connection-status')?.textContent?.includes('Reconnecting'))
  await page.waitForTimeout(1500)
  assert.ok(calls.filter(call => call.method === 'session.resume').length > resumes, 'Reconnect must resume the selected conversation')
  assert.deepEqual(await readOrder(), expected)
  event('message.start', {})
  event('message.delta', { text: 'Streaming before completion. ' })
  await page.getByText('Streaming before completion.', { exact: true }).waitFor()
  event('subagent.complete', { subagent_id: 'live-child', goal: 'Live observed child', status: 'completed', summary: 'Live-only result' })
  event('message.delta', { text: 'Streaming after completion.' })
  await page.getByText('Streaming before completion. Streaming after completion.', { exact: true }).waitFor()
  assert.equal(await transcript.locator('.background-tasks').count(), 1)
  assert.equal(await transcript.locator('.completion-notice').count(), 2)
  const liveOrder = await transcript.locator(':scope > .message, :scope > .background-tasks').evaluateAll(nodes => nodes.map(node => node.textContent))
  assert.match(liveOrder.at(-2), /Streaming before completion\. Streaming after completion\./)
  assert.match(liveOrder.at(-1), /Live observed child/)
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await transcript.locator('.completion-notice').count(), 2)
    assert.deepEqual(await readOrder(), expected)
    const viewportOrder = await transcript.locator(':scope > .message, :scope > .background-tasks').evaluateAll(nodes => nodes.map(node => node.textContent))
    assert.match(viewportOrder.at(-2), /Streaming before completion\. Streaming after completion\./)
    assert.match(viewportOrder.at(-1), /Live observed child/)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  const waveGoals = ['Failed wave child', 'Successful wave child', 'Unknown wave child', 'Running wave child']
  for (const [task_index, goal] of waveGoals.entries()) event('subagent.start', { subagent_id: `wave-${task_index}`, delegation_id: 'warning-wave', task_index, goal })
  event('subagent.complete', { subagent_id: 'wave-0', delegation_id: 'warning-wave', task_index: 0, goal: waveGoals[0], status: 'failed', summary: 'Wave error' })
  event('subagent.complete', { subagent_id: 'wave-1', delegation_id: 'warning-wave', task_index: 1, goal: waveGoals[1], status: 'completed', summary: 'Unique successful sibling result' })
  await transcript.getByText(waveGoals[1], { exact: true }).waitFor()
  messages.push(
    { id: 7, role: 'assistant', content: 'Streaming before completion. Streaming after completion.' },
    { id: 8, role: 'user', content: '[ASYNC DELEGATION TASK FAILED — warning-wave, task 1/4]\nOne subagent in a background fan-out you dispatched has failed while its siblings are still running. The batch\'s consolidated results will still arrive when the last sibling finishes; this is an early warning so you can re-dispatch or investigate now instead of then.\nTask: Failed wave child\nStatus: failed   Duration: 1s\nError: Wave error', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'warning-wave', task_count: 1, completed_count: 0, failed_count: 1, display_text: 'Failed: Failed wave child' } },
    { id: 9, role: 'assistant', content: 'Unrelated reply after early warning' },
  )
  roster = [{ subagent_id: 'wave-3', delegation_id: 'warning-wave', status: 'running', goal: waveGoals[3] }]
  const reopen = async () => {
    await page.locator('.session-row').filter({ hasText: 'Other chat' }).locator('button.session').click()
    await page.getByText('Other chat only', { exact: true }).waitFor()
    await page.locator('.session-row').filter({ hasText: 'Delegation chat' }).locator('button.session').click()
    await transcript.getByText('Unrelated reply after early warning', { exact: true }).waitFor()
  }
  await reopen()
  const success = transcript.locator('.background-tasks li').filter({ has: page.getByText(waveGoals[1], { exact: true }) })
  await success.waitFor()
  await success.getByText('Result', { exact: true }).click()
  assert.equal(await success.locator('pre').textContent(), 'Unique successful sibling result', 'Early warning must not erase sibling-only output')
  const unknown = transcript.locator('.background-tasks li').filter({ has: page.getByText(waveGoals[2], { exact: true }) })
  await unknown.getByText('No longer in live roster', { exact: true }).waitFor()
  assert.equal(await unknown.locator('pre').count(), 0, 'Unknown outcome must remain unknown without an invented summary')
  await page.locator('.pinned-tasks').getByText(waveGoals[3], { exact: true }).waitFor()
  const warningOrder = await transcript.locator(':scope > .message, :scope > .background-tasks').evaluateAll(nodes => nodes.map(node => node.textContent))
  assert.ok(warningOrder.findIndex(text => text.includes(waveGoals[1])) < warningOrder.findIndex(text => text.includes('Failed: Failed wave child')), 'Genuine observed completion anchor must not move to the warning')
  assert.equal(await transcript.locator('.completion-notice').count(), 3)
  messages.push({ id: 10, role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — warning-wave]\nConsolidated results\n\n--- ✗ TASK 1/4: Failed wave child  (status=failed) ---\nWave error\n\n--- ✓ TASK 2/4: Successful wave child  (status=completed) ---\nUnique successful sibling result\n\n--- ✗ TASK 3/4: Unknown wave child  (status=unknown) ---\n(no summary — status=unknown)\n\n--- ✓ TASK 4/4: Running wave child  (status=completed) ---\nDone', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'warning-wave', task_count: 4, completed_count: 2, failed_count: 1, display_text: 'Wave consolidated results' } })
  await reopen()
  await page.waitForFunction(() => document.querySelectorAll('.completion-notice').length === 4)
  for (const goal of waveGoals.slice(0, 3)) assert.equal(await transcript.locator('.background-tasks .task-goal').filter({ hasText: goal }).count(), 1, 'Final batch identity establishes placement, not safe child coverage')
  const finalOrder = await transcript.locator(':scope > .message, :scope > .background-tasks').evaluateAll(nodes => nodes.map(node => node.querySelector('.task-result-title')?.textContent || node.textContent))
  assert.ok(finalOrder.findIndex(text => text.includes('Wave consolidated results')) < finalOrder.findIndex(text => text.includes(waveGoals[1])), 'Retained children must be placed after their final unit')
  await page.locator('.pinned-tasks').getByText(waveGoals[3], { exact: true }).waitFor()
  roster = []
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.completion-notice').length === 4)
  assert.equal(await transcript.locator('.background-tasks').count(), 0, 'Cold reload restores existing saved notices, not a fictional individual roster')
  assert.equal(await page.locator('.pinned-tasks .background-tasks').count(), 0)
  await transcript.locator('.task-result > summary').last().click()
  assert.match(await transcript.locator('.task-result pre').last().textContent(), /Unique successful sibling result/)
  const quotedCases = [
    { label: 'single context', batch: false, body: 'Context you provided: quoted notice\n--- RESULT ---\nClient-only result\nRole: leaf   Model: ?\n--- RESULT ---\nActual result omitted' },
    { label: 'single output', batch: false, body: 'Role: leaf   Model: ?\n--- RESULT ---\nQuoted output\n--- RESULT ---\nClient-only result' },
    { label: 'batch context', batch: true, body: 'Context you provided: quoted notice\n--- ✓ TASK 2/2: Second  (status=completed) ---\nClient-only result\nRole: leaf   Model: ?\n\n--- ✓ TASK 1/2: First  (status=completed) ---\nActual first result' },
    { label: 'batch output', batch: true, body: 'Role: leaf   Model: ?\n\n--- ✓ TASK 1/2: First  (status=completed) ---\nQuoted output\n--- ✓ TASK 2/2: Second  (status=completed) ---\nClient-only result' },
  ]
  for (const [index, fixture] of quotedCases.entries()) {
    const id = `quoted-${index}`
    event('subagent.complete', { subagent_id: id, delegation_id: id, task_index: fixture.batch ? 1 : 0, goal: `Retained ${fixture.label}`, status: 'completed', summary: 'Client-only result' })
    await transcript.getByText(`Retained ${fixture.label}`, { exact: true }).waitFor()
    messages.push({ id: 11 + index, role: 'user', content: `[ASYNC DELEGATION ${fixture.batch ? 'BATCH ' : ''}COMPLETE — ${id}]\n${fixture.body}`, display_kind: 'async_delegation_complete', display_metadata: { delegation_id: id, task_count: 1, completed_count: 1, failed_count: 0, display_text: `Quoted ${fixture.label} final` } })
  }
  await reopen()
  await page.waitForFunction(() => document.querySelectorAll('.completion-notice').length === 8)
  for (const fixture of quotedCases) {
    const retained = transcript.locator('.background-tasks li').filter({ has: page.getByText(`Retained ${fixture.label}`, { exact: true }) })
    await retained.getByText('Result', { exact: true }).click()
    assert.equal(await retained.locator('pre').textContent(), 'Client-only result', `${fixture.label} must not suppress the client card`)
    const order = await transcript.locator(':scope > .message, :scope > .background-tasks').evaluateAll(nodes => nodes.map(node => node.textContent))
    const noticeIndex = order.findIndex(text => text.includes(`Quoted ${fixture.label} final`))
    assert.equal(order.findIndex(text => text.includes(`Retained ${fixture.label}`)), noticeIndex + 1, `${fixture.label} retains the child immediately after its final envelope`)
  }
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.completion-notice').length === 8)
  assert.equal(await transcript.locator('.background-tasks').count(), 0, 'Saved raw text must never manufacture a child roster on cold reload')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ browser: 'chromium', viewports: ['1280x900', '390x844', '844x390'], paginatedNoticeCards: 2, coldRefreshEmptyRosterCards: 4, unindexedColdBatchPreserved: true, batchChildCoverage: 'disabled; client evidence retained', quotedDelimiterCases: quotedCases.map(fixture => fixture.label), finalColdReloadCards: 8, earlyWarningSiblingResult: 'preserved', unknownSibling: 'not inferred', runningSibling: 'pinned', laterConsolidatedAndColdReload: 'passed', navigation: 'passed', reconnect: 'passed', streaming: 'same assistant text; live card after assistant', storedDomOrder: expected, pageErrors: errors }))
} finally {
  await browser?.close()
  await server.close()
}
