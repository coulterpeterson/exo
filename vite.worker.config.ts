import { isAbsolute, resolve } from 'path'
import { defineConfig } from 'vite'

/**
 * Separate build config for the agent-worker utility process.
 *
 * The agent-worker runs in an Electron utility process and must be
 * a standalone CJS file — it can't be merged into the main bundle
 * because rollup would fold shared modules between entry points.
 *
 * Build order:
 *   1. electron-vite builds main/preload/renderer into out/
 *   2. This config builds agent-worker.js into out/main/ (emptyOutDir: false)
 */
export default defineConfig({
  build: {
    outDir: 'out/worker',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/main/agents/agent-worker.ts'),
      formats: ['cjs'],
      fileName: () => 'agent-worker.cjs',
    },
    rollupOptions: {
      /**
       * Externalize bare imports (node_modules) and bundle everything of ours.
       *
       * This was a `/^[^./]/` regex — "doesn't start with . or /" — which reads
       * as "is a bare specifier" only on POSIX. On Windows the entry resolves to
       * `D:\a\exo\...`, which starts with `D`, so the entry module matched and
       * externalized itself: "Entry module cannot be external". Ask the path
       * module instead of pattern-matching separators.
       */
      external: (id: string) => {
        if (id === 'electron' || id === 'better-sqlite3') return true
        return !id.startsWith('.') && !isAbsolute(id)
      },
    },
    target: 'node20',
    minify: false,
    sourcemap: true,
  },
  resolve: {
    conditions: ['node'],
  },
})
