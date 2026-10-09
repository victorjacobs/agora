import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { localHermesPlugin } from './server/vite-plugin'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const endpoint = env.HERMES_ENDPOINT
  const target = env.HERMES_TARGET || 'http://127.0.0.1:8080'

  return {
    base: '/',
    plugins: [vue(), ...(endpoint && mode !== 'test' ? [localHermesPlugin(endpoint, env)] : [])],
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true,
      proxy: endpoint ? undefined : {
        '/api': { target, ws: true, changeOrigin: false },
        '/auth': { target, changeOrigin: false },
        '/login': { target, changeOrigin: false },
      },
    },
    preview: { host: '127.0.0.1', port: 5173, strictPort: true },
    test: {
      include: ['tests/**/*.test.ts'], environment: 'jsdom', restoreMocks: true,
      // Panzoom's main points to UMD despite type: module; use Vite's ESM resolution.
      server: { deps: { inline: ['@panzoom/panzoom'] } },
    },
  }
})
