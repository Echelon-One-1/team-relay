// Manifest-driven plugin files (M1-SPEC §8.4, as changed by M5-SPEC §6):
//
// - .claude-plugin/plugin.json: no `userConfig` at all (M5-SPEC §6: joining asks no install
//   questions; the relay URL defaults, and capabilities are enabled where they run, in the
//   answering session's environment), and `"license": "MIT"` (the repository's LICENSE).
//   Every other key is left as it is.
// - ../.claude-plugin/marketplace.json (the repository's marketplace, when the plugin sits in
//   the repository): this plugin's entry says `"license": "MIT"` too; nothing else changes.
// - .mcp.json: the relay channel in asker role; it signs in with the stored credential.
// - commands/answering.md: /team-relay:answering, which names each capability of
//   manifest.yaml with the environment variables that offer it.
//
//   pnpm generate           write the files
//   pnpm generate --check   exit 1 when the committed files differ from what would be written

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, type Manifest } from '../src/manifest.js';

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function buildMcpJson(): Record<string, unknown> {
  return {
    mcpServers: {
      relay: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/dist/channel.js'],
        env: {
          RELAY_ROLE: 'asker',
        },
      },
    },
  };
}

/** The environment lines that offer each capability, from the manifest. */
export function capabilityLines(manifest: Manifest): string[] {
  return manifest.capabilities.map((cap) => {
    const key = cap.name.toUpperCase();
    const prod = cap.environment === 'production' ? ' Production data: also needs `ALLOW_PRODUCTION=true`.' : '';
    return `- ${cap.title} (\`${cap.name}\`, ${cap.environment}): \`CAP_${key}_ENABLED=true\` and \`CAP_${key}_RUNNER=/absolute/path/to/program\`.${prod}`;
  });
}

export function buildAnsweringCommand(manifest: Manifest): string {
  return [
    '---',
    'description: Show the command that starts a manual team relay answering session (optional)',
    'disable-model-invocation: true',
    '---',
    '',
    '<!-- Generated from manifest.yaml by scripts/generate.ts (pnpm generate); do not edit. -->',
    '',
    'You do not need this to answer teammates: a session started with the team-relay channel answers them on its own,',
    'from its folder (reads inside the folder and ordinary answers ship automatically; anything else waits for',
    '`/team-relay:approvals`). This command is the optional manual answering session instead.',
    '',
    'Show me, in one code block I can copy, the command that starts my team relay answering session in a',
    'second terminal. Do not run it yourself, and do not change it:',
    '',
    '```',
    '"${CLAUDE_PLUGIN_ROOT}/bin/answerer"',
    '```',
    '',
    'Then tell me, briefly:',
    '',
    '- It signs in with the same sign-in as `/team-relay:login`; no settings are needed. If I have not signed',
    '  in yet, I should run `/team-relay:login` first.',
    '- Only one answerer runs per computer: while a channel working session or the background answerer answers it refuses',
    '  to start (start that session with `TEAM_RELAY_AUTO_ANSWER=0` to use this one instead).',
    '- It reads none of my files by default. To let it read folders without asking, I start it with',
    '  `ANSWERER_READ_DIRS=~/src/app:~/notes` in front of the command (teammates see only the folder names).',
    '  For anything else it asks me in that terminal; credentials are never readable.',
    '- To offer a capability to teammates, I put its two settings in front of the command:',
    '',
    ...capabilityLines(manifest).map((l) => `  ${l}`),
    '',
  ].join('\n');
}

export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The project's license (LICENSE at the repository root). */
export const LICENSE = 'MIT';

/** `obj` with `license` set: where it already is, else right after `after` (else at the end). */
export function withLicense(obj: Record<string, unknown>, after: string): Record<string, unknown> {
  if ('license' in obj) return { ...obj, license: LICENSE };
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v;
    if (k === after) {
      out.license = LICENSE;
      placed = true;
    }
  }
  if (!placed) out.license = LICENSE;
  return out;
}

export type Rendered = { path: string; content: string };

/** What the generator would write, for a plugin rooted at `root`. */
export function render(root: string = PLUGIN_ROOT): Rendered[] {
  const manifest = loadManifest(join(root, 'manifest.yaml'));
  const pluginPath = join(root, '.claude-plugin', 'plugin.json');
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8')) as Record<string, unknown>;
  // M5-SPEC §6: no install questions. Every other key is untouched, in its order.
  const { userConfig: _dropped, ...next } = plugin;
  const out: Rendered[] = [
    { path: pluginPath, content: renderJson(withLicense(next, 'author')) },
    { path: join(root, '.mcp.json'), content: renderJson(buildMcpJson()) },
    { path: join(root, 'commands', 'answering.md'), content: buildAnsweringCommand(manifest) },
  ];
  const marketplacePath = join(root, '..', '.claude-plugin', 'marketplace.json');
  if (existsSync(marketplacePath)) {
    const market = JSON.parse(readFileSync(marketplacePath, 'utf8')) as Record<string, unknown>;
    const plugins = Array.isArray(market.plugins) ? market.plugins : [];
    const name = typeof plugin.name === 'string' ? plugin.name : '';
    market.plugins = plugins.map((p: unknown) =>
      p && typeof p === 'object' && (p as { name?: unknown }).name === name ? withLicense(p as Record<string, unknown>, 'description') : p,
    );
    out.push({ path: marketplacePath, content: renderJson(market) });
  }
  return out;
}

export function run(opts: { root?: string; check: boolean }): { drifted: string[] } {
  const root = opts.root ?? PLUGIN_ROOT;
  const drifted: string[] = [];
  for (const file of render(root)) {
    const current = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null;
    if (current === file.content) continue;
    drifted.push(file.path);
    if (!opts.check) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
    }
  }
  return { drifted };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown.join(' ')}`);
    process.exit(2);
  }
  const check = args.includes('--check');
  try {
    const { drifted } = run({ check });
    if (check && drifted.length > 0) {
      console.error(`out of date (run pnpm generate): ${drifted.map((p) => p.slice(PLUGIN_ROOT.length + 1)).join(', ')}`);
      process.exit(1);
    }
    console.error(check ? 'generated files are up to date' : drifted.length ? `wrote ${drifted.length} file(s)` : 'nothing to change');
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
