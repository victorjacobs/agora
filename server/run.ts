import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import sirv from 'sirv'
import { LocalBridge } from './bridge.ts'

for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file)
}
const endpoint = process.env.HERMES_ENDPOINT
if (!endpoint) throw new Error('Set HERMES_ENDPOINT in .env.local before running Agora locally.')
const dist = resolve('dist')
if (!existsSync(resolve(dist, 'index.html'))) throw new Error('Run npm run build before npm start.')
const port = Number(process.env.AGORA_PORT || 5173)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AGORA_PORT must be a valid TCP port.')
const bridge = new LocalBridge(endpoint)
const files = sirv(dist, { single: true, dev: true })
const server = createServer((request, response) => {
  bridge.middleware(request, response, () => {
    if (request.url === '/' || request.url === '/agora') {
      response.writeHead(302, { Location: '/agora/' })
      response.end()
    } else if (request.url?.startsWith('/agora/')) {
      request.url = request.url.slice('/agora'.length)
      files(request, response)
    } else {
      response.writeHead(404)
      response.end('Not found')
    }
  })
})
bridge.attach(server)
server.listen(port, '127.0.0.1', () => console.info(`Agora: http://127.0.0.1:${port}/agora/`))
server.on('error', error => { console.error(error.message); process.exitCode = 1; bridge.dispose() })
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { bridge.dispose(); server.close(); server.closeAllConnections() })
}
