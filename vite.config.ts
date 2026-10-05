import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const target = env.HERMES_TARGET || 'http://127.0.0.1:8080'

  return {
    base: '/agora/',
    plugins: [vue()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target, ws: true, changeOrigin: false },
        '/auth': { target, changeOrigin: false },
        '/login': { target, changeOrigin: false },
      },
    },
    test: { environment: 'jsdom', restoreMocks: true },
  }
})
