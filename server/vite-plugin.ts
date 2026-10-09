import { Server } from 'node:http'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { HermesBridge } from './bridge.ts'
import { sessionStorageOptions } from './session-store.ts'

export function localHermesPlugin(endpoint: string, environment: NodeJS.ProcessEnv = process.env): Plugin {
  function configure(server: ViteDevServer | PreviewServer, host: string | boolean | undefined) {
    if (host !== '127.0.0.1') {
      throw new Error('Local Agora must listen on 127.0.0.1 for the Hermes loopback callback.')
    }
    const bridge = new HermesBridge(endpoint, fetch, sessionStorageOptions(environment))
    server.middlewares.use(bridge.middleware)
    if (!(server.httpServer instanceof Server)) throw new Error('Local Agora requires a plain HTTP loopback server.')
    bridge.attach(server.httpServer)
  }
  return {
    name: 'agora-local-hermes',
    configureServer: server => configure(server, server.config.server.host),
    configurePreviewServer: server => configure(server, server.config.preview.host),
  }
}
