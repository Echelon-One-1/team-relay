import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// The console is served by the plugin's local console server (plugin/src/console-server.ts)
// from plugin/dist/console under a strict CSP (default-src 'self'). So: relative asset
// paths (it works from any mount path), CSS in files (never injected at runtime), no
// external requests, and the build empties only its own output directory. The one exception
// is the Google Drive picker page (pick-drive.html), which loads Google's scripts under its own
// headers on the hosted console only (PICKERS-SPEC §5.4).
const outDir = path.resolve(import.meta.dirname, '../plugin/dist/console')

/**
 * PICKERS-SPEC §5.4: the Google Drive picker page is built as pick-drive.html beside index.html
 * but served at /pick/drive (hosted only), one level down; so its own references to the built
 * assets point one level up (`../assets/…`), which still works from any mount path.
 */
export function pickerPageAssets(): Plugin {
  return {
    name: 'team-relay-picker-page-assets',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) => (path.basename(ctx.filename) === 'pick-drive.html' ? html.replace(/(\s(?:src|href)=")\.\/assets\//g, '$1../assets/') : html),
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), pickerPageAssets()],
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
    // The console, and the Google Drive picker page (PICKERS-SPEC §5.4) with its own entry, so
    // Google's code is never part of the console's own pages.
    rolldownOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        'pick-drive': path.resolve(import.meta.dirname, 'pick-drive.html'),
      },
    },
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
