import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const packagePath = resolve(process.argv[2] || 'result')
const directory = await mkdtemp(join(tmpdir(), 'agora-package-'))
const probe = createServer()
probe.listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
await writeFile(join(directory, '.env.local'), 'HERMES_ENDPOINT=invalid\nAGORA_PORT=invalid\n')

const child = spawn(join(packagePath, 'bin/agora'), [], {
  cwd: directory,
  env: { ...process.env, HERMES_ENDPOINT: 'http://127.0.0.1:9', AGORA_PORT: String(port) },
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
      if (output.includes('Agora: http://')) { clearTimeout(timer); resolve() }
    })
  })
  const origin = `http://127.0.0.1:${port}`
  const root = await fetch(origin, { redirect: 'manual' })
  assert.equal(root.status, 302)
  assert.equal(root.headers.get('location'), '/agora/')
  const page = await fetch(`${origin}/agora/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /href="\/agora\/favicon\.ico"/)
  for (const icon of ['favicon.ico', 'favicon-32.png', 'favicon-192.png', 'apple-touch-icon.png']) {
    const response = await fetch(`${origin}/agora/${icon}`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^image\//)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(packagePath, 'share/agora/dist', icon)))
  }
  const connection = await fetch(`${origin}/api/agora/connection`)
  assert.equal(connection.status, 200)
  assert.equal((await connection.json()).mode, 'local')
  assert.equal(existsSync(join(packagePath, 'share/agora/node_modules/vite')), false)
  child.kill('SIGTERM')
  const [code] = await exited
  assert.equal(code, 0)
  console.info('Packaged server, static assets, isolated configuration, and shutdown passed.')
} finally {
  if (child.exitCode === null) { child.kill('SIGKILL'); await exited }
  await rm(directory, { recursive: true, force: true })
}
