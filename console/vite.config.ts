import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The console is served by the plugin's local console server (plugin/src/console-server.ts)
// from plugin/dist/console under a strict CSP (default-src 'self'). So: relative asset
// paths (it works from any mount path), CSS in files (never injected at runtime), no
// external requests, and the build empties only its own output directory.
const outDir = path.resolve(import.meta.dirname, '../plugin/dist/console')

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5317,
    strictPort: false,
    // With a local console server running (plugin/bin/console, default port 4317), the dev
    // server forwards /api to it; the key still travels in X-Console-Key from the fragment.
    proxy: {
      '/api': process.env.CONSOLE_API ?? 'http://127.0.0.1:4317',
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    // The form tests type and click through whole pages: about 2 s each on a laptop and 4.5 times
    // that on GitHub's runner, past vitest's 5 s default. A cap about ten times above, as the
    // answerer's suite has.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
