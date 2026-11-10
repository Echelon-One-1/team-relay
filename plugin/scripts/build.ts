// Bundle each server to one ESM file in dist/ (run with `node dist/<name>.js`).
// Dependencies and the manifest schema are inlined, so the installed plugin needs no
// node_modules and no build step.
//
// dist/console/ belongs to the console's own build (console/, M2-SPEC §5): this script
// never deletes, rewrites or reads anything under it. It replaces only its own bundles.

import { build as esbuild } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRIES = [
  'channel',
  'capabilities',
  'session-start',
  'tool-event',
  'notify-desktop',
  'console-server',
  'credential-info',
  'logout',
  'answer-tools',
  'answering-lock-info',
  'answer-dry-run',
  'read-trail',
  'drive-cli',
  'daemon',
  'setup-cli',
] as const;

export async function build(outdir = join(root, 'dist')): Promise<void> {
  mkdirSync(outdir, { recursive: true });
  // Only this build's own outputs are removed first (never the directory, never console/).
  for (const e of ENTRIES) rmSync(join(outdir, `${e}.js`), { force: true });
  await esbuild({
    absWorkingDir: root,
    entryPoints: ENTRIES.map((e) => ({ in: `src/${e}.ts`, out: e })),
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    splitting: false,
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'warning',
    // CommonJS dependencies (ajv) call require() for Node built-ins; give the ESM bundle one.
    banner: {
      js: "import { createRequire as __teamRelayCreateRequire } from 'node:module'; const require = __teamRelayCreateRequire(import.meta.url);",
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
