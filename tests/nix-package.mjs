import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const packagePath = resolve(process.argv[2] || 'result')
const publicOrigin = process.argv[3]
const directory = await mkdtemp(join(tmpdir(), 'agora-package-'))
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
await writeFile(join(directory, '.env.local'), 'HERMES_ENDPOINT=invalid\nAGORA_PORT=invalid\n')

const child = spawn(join(packagePath, 'bin/agora'), [], {
  cwd: directory,
  env: { ...process.env, HERMES_ENDPOINT: 'http://127.0.0.1:9', AGORA_PORT: String(port), AGORA_PUBLIC_ORIGIN: publicOrigin || '', AGORA_SESSION_DB: join(directory, 'sessions.sqlite') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
const exited = once(child, 'exit')
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Package did not start: ${output}`)), 10_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Package exited before startup: ${output}`)) })
    child.stderr.on('data', data => { output += data })
    child.stdout.on('data', data => {
      output += data
      if (output.includes('Agora: ')) { clearTimeout(timer); resolve() }
    })
  })
  const origin = `http://127.0.0.1:${port}`
  const request = path => {
    if (!publicOrigin) return fetch(origin + path, { redirect: 'manual' })
    return new Promise((resolve, reject) => {
      const request = httpRequest(origin + path, { headers: { Host: new URL(publicOrigin).host } }, response => {
        const parts = []
        response.on('data', part => parts.push(part))
        response.on('error', reject)
        response.on('end', () => resolve(new Response(Buffer.concat(parts), {
          status: response.statusCode, headers: response.headers,
        })))
      })
      request.on('error', reject)
      request.end()
    })
  }
  if (publicOrigin) assert.equal((await fetch(origin)).status, 403)
  const root = await request('/')
  assert.equal(root.status, 200)
  assert.equal(root.headers.get('location'), null)
  const page = await request('/?session=test')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /href="\/favicon\.ico"/)
  for (const icon of ['favicon.ico', 'favicon-32.png', 'favicon-192.png', 'apple-touch-icon.png']) {
    const response = await request(`/${icon}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^image\//)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(packagePath, 'share/agora/dist', icon)))
  }
  const manifest = await request('/manifest.webmanifest')
  assert.equal(manifest.status, 200)
  const application = await manifest.json()
  assert.equal(new URL(application.start_url, origin + '/manifest.webmanifest').pathname, '/')
  assert.equal(application.display, 'standalone')
  const pageHtml = await (await request('/')).text()
  const asset = pageHtml.match(/src="([^"]+\.js)"/)?.[1]
  assert.ok(asset?.startsWith('/assets/'))
  const assetResponse = await request(asset)
  assert.equal(assetResponse.status, 200)
  assert.match(assetResponse.headers.get('content-type'), /javascript/)
  const connection = await request('/api/agora/connection')
  assert.equal(connection.status, 200)
  assert.equal((await connection.json()).mode, publicOrigin ? 'hosted' : 'local')
  assert.equal(existsSync(join(packagePath, 'share/agora/node_modules/vite')), false)
  child.kill('SIGTERM')
  const [code] = await exited
  assert.equal(code, 0)
  console.info('Packaged server, static assets, isolated configuration, and shutdown passed.')
} finally {
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited }
  await rm(directory, { recursive: true, force: true })
}
