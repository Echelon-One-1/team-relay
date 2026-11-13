// Where the background answerer's programs are (locate.ts): claude, including the copy the Claude
// desktop app keeps for itself (its folder changes with every app update), and the node its
// LaunchAgent runs (the pinned private copy, read from bin/node-pins.sh, else a PATH entry by its
// PATH name). Every home and PATH here is a temporary folder.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_PINS_FILE, RUN_NODE_FILE, answererNode, answererNodeObtainable, desktopClaude, ensureAnswererNode, findClaude, newEnoughNode, pinnedNodePath, pinnedNodeVersion, versionedNodePath } from '../src/locate.js';
import { PLUGIN_ROOT } from './helpers/mcp.js';

let tmp: string;
let home: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tr-locate-')));
  home = join(tmp, 'home');
  mkdirSync(home);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function exe(path: string, body = '#!/bin/sh\nexit 0\n'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

const APP = () => join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
/** One build of the desktop app's claude; `verifiedAt` (seconds) sets when it was marked verified. */
function build(version: string, hash: string, o: { verifiedAt?: number; executable?: boolean } = {}): string {
  const dir = join(APP(), version, hash);
  const path = join(dir, 'claude.app', 'Contents', 'MacOS', 'claude');
  if (o.executable === false) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '');
  } else exe(path);
  if (o.verifiedAt !== undefined) {
    writeFileSync(join(dir, '.verified'), 'x');
    utimesSync(join(dir, '.verified'), o.verifiedAt, o.verifiedAt);
  }
  return path;
}

describe("the Claude desktop app's claude", () => {
  it('the newest version that has a verified, executable build; of several builds the latest verified', () => {
    build('2.1.9', 'a1', { verifiedAt: 1000 });
    const older = build('2.1.10', 'b1', { verifiedAt: 1000 });
    const newer = build('2.1.10', 'b2', { verifiedAt: 2000 });
    build('2.1.11', 'c1');  // not verified
    build('2.1.12', 'd1', { verifiedAt: 3000, executable: false });
    mkdirSync(join(APP(), 'not-a-version', 'x'), { recursive: true });
    expect(desktopClaude(home)).toBe(newer);
    rmSync(join(APP(), '2.1.10', 'b2'), { recursive: true });
    expect(desktopClaude(home)).toBe(older);
    // Versions compare as numbers, not text: 2.1.10 is newer than 2.1.9.
    rmSync(join(APP(), '2.1.10'), { recursive: true });
    expect(desktopClaude(home)).toBe(join(APP(), '2.1.9', 'a1', 'claude.app', 'Contents', 'MacOS', 'claude'));
  });

  it('none: null', () => {
    expect(desktopClaude(home)).toBeNull();
    build('2.1.9', 'a1');
    expect(desktopClaude(home)).toBeNull();
  });

  it('findClaude: PATH first, then ~/.local/bin, ~/.claude/local, and the desktop app last', () => {
    const env = { HOME: home, PATH: `relative:${join(tmp, 'bin')}` };
    expect(findClaude(env)).toBeNull();
    const desktop = build('2.1.9', 'a1', { verifiedAt: 1000 });
    expect(findClaude(env)).toBe(desktop);
    const local = exe(join(home, '.claude', 'local', 'claude'));
    expect(findClaude(env)).toBe(local);
    const dotLocal = exe(join(home, '.local', 'bin', 'claude'));
    expect(findClaude(env)).toBe(dotLocal);
    const onPath = exe(join(tmp, 'bin', 'claude'));
    expect(findClaude(env)).toBe(onPath);
  });
});

describe("the background answerer's node", () => {
  const pins = () => {
    const f = join(tmp, 'node-pins.sh');
    writeFileSync(f, "# shellcheck shell=sh\nNODE_VERSION='v22.23.4'\nNODE_SHA256_ARM64='00'\n");
    return f;
  };
  /** A version reader that runs nothing: the stub's first line says its version. */
  const version = (p: string): string | null => {
    try {
      return /^#(v\d+\.\d+\.\d+)$/m.exec(readFileSync(p, 'utf8'))?.[1] ?? null;
    } catch {
      return null;
    }
  };
  const node = (path: string, v: string) => exe(path, `#!/bin/sh\n#${v}\n`);

  it('the pinned private copy when it is there and runs', () => {
    const pinned = node(pinnedNodePath(home, 'v22.23.4', 'arm64'), 'v22.23.4');
    node(join(tmp, 'bin', 'node'), 'v24.0.0');
    expect(pinned).toBe(join(home, '.local', 'share', 'team-relay', 'node-v22.23.4-darwin-arm64', 'bin', 'node'));
    expect(answererNode({ env: { HOME: home, PATH: join(tmp, 'bin') }, arch: 'arm64', pinsFile: pins(), version })).toBe(pinned);
    // Another processor: its own copy, which is not there.
    expect(answererNode({ env: { HOME: home, PATH: join(tmp, 'bin') }, arch: 'x64', pinsFile: pins(), version })).toBe(join(tmp, 'bin', 'node'));
  });

  it('else the first new-enough node on PATH whose name is not under a version folder (a symlink is not resolved)', () => {
    node(pinnedNodePath(home, 'v22.23.4', 'arm64'), 'broken');  // does not say a version: does not run
    node(join(tmp, 'old', 'node'), 'v20.1.0');
    const versioned = [
      join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin'),
      join(home, '.local', 'state', 'fnm_multishells', '123_456', 'bin'),
      join(home, '.asdf', 'installs', 'nodejs', '24.1.0', 'bin'),
      join(home, '.volta', 'tools', 'image', 'node', '24.1.0', 'bin'),
      join(tmp, 'opt', 'homebrew', 'Cellar', 'node', '24.1.0', 'bin'),
      join(tmp, 'opt', 'homebrew', 'opt', 'node@24', 'bin'),
    ];
    for (const d of versioned) node(join(d, 'node'), 'v24.1.0');
    const real = join(tmp, 'opt', 'homebrew', 'Cellar', 'node', '24.1.0', 'bin', 'node');
    mkdirSync(join(tmp, 'brew'));
    symlinkSync(real, join(tmp, 'brew', 'node'));
    const env = { HOME: home, PATH: ['relative', join(tmp, 'old'), ...versioned, join(tmp, 'brew')].join(':') };
    expect(answererNode({ env, arch: 'arm64', pinsFile: pins(), version })).toBe(join(tmp, 'brew', 'node'));
    expect(answererNode({ env: { ...env, PATH: versioned.join(':') }, arch: 'arm64', pinsFile: pins(), version })).toBeNull();
    for (const d of versioned) expect(versionedNodePath(join(d, 'node')), d).toBe(true);
    for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', join(home, '.volta', 'bin', 'node'), join(home, '.asdf', 'shims', 'node')]) expect(versionedNodePath(p), p).toBe(false);
  });

  it('none: null (never this process\'s own node)', () => {
    expect(answererNode({ env: { HOME: home, PATH: '' }, arch: 'arm64', pinsFile: join(tmp, 'missing.sh'), version })).toBeNull();
  });

  it('a missing pinned copy is got first (run-node --fetch-only), then used; when that fails, a stable PATH node; else none', async () => {
    const env = { HOME: home, PATH: join(tmp, 'bin') };
    const fetched: NodeJS.ProcessEnv[] = [];
    const fetch = async (e: NodeJS.ProcessEnv) => {
      fetched.push(e);
      node(pinnedNodePath(home, 'v22.23.4', 'arm64'), 'v22.23.4');
    };
    node(join(tmp, 'bin', 'node'), 'v24.0.0');
    expect(await ensureAnswererNode({ env, arch: 'arm64', pinsFile: pins(), version, fetch })).toBe(pinnedNodePath(home, 'v22.23.4', 'arm64'));
    expect(fetched).toEqual([env]);
    // There now: not fetched again.
    expect(await ensureAnswererNode({ env, arch: 'arm64', pinsFile: pins(), version, fetch })).toBe(pinnedNodePath(home, 'v22.23.4', 'arm64'));
    expect(fetched).toHaveLength(1);
    // A fetch that fails: the PATH node; none there either: null.
    rmSync(join(home, '.local'), { recursive: true });
    expect(await ensureAnswererNode({ env, arch: 'arm64', pinsFile: pins(), version, fetch: async () => {} })).toBe(join(tmp, 'bin', 'node'));
    expect(await ensureAnswererNode({ env: { HOME: home, PATH: '' }, arch: 'arm64', pinsFile: pins(), version, fetch: async () => {} })).toBeNull();
    // A processor nodejs.org has no pinned build for: nothing fetched.
    expect(await ensureAnswererNode({ env, arch: 'ia32', pinsFile: pins(), version, fetch: async () => void fetched.push(env) })).toBe(join(tmp, 'bin', 'node'));
    expect(fetched).toHaveLength(1);
  });

  it('obtainable: a node now, or a pinned build run-node can fetch for this processor', () => {
    const env = { HOME: home, PATH: '' };
    const runNode = exe(join(tmp, 'run-node'));
    expect(answererNodeObtainable({ env, arch: 'arm64', pinsFile: pins(), version, runNode })).toBe(true);
    expect(answererNodeObtainable({ env, arch: 'arm64', pinsFile: pins(), version, runNode: join(tmp, 'none') })).toBe(false);
    expect(answererNodeObtainable({ env, arch: 'ia32', pinsFile: pins(), version, runNode })).toBe(false);
    node(join(tmp, 'bin', 'node'), 'v24.0.0');
    expect(answererNodeObtainable({ env: { HOME: home, PATH: join(tmp, 'bin') }, arch: 'ia32', pinsFile: pins(), version, runNode: join(tmp, 'none') })).toBe(true);
  });

  it('the real run-node --fetch-only is what fetches (it exists beside the pins)', () => {
    expect(RUN_NODE_FILE).toBe(join(PLUGIN_ROOT, 'bin', 'run-node'));
    expect(readFileSync(RUN_NODE_FILE, 'utf8')).toContain('--fetch-only');
  });

  it('22.12 or newer', () => {
    expect(['v22.12.0', 'v22.23.4', 'v23.0.0'].map(newEnoughNode)).toEqual([true, true, true]);
    expect(['v22.11.9', 'v20.19.0', '22.12.0', null, 'v22.12'].map(newEnoughNode)).toEqual([false, false, false, false, false]);
  });

  it('the pin is read from bin/node-pins.sh, the file bin/run-node sources, and names the folder run-node installs into', () => {
    const file = join(PLUGIN_ROOT, 'bin', 'node-pins.sh');
    expect(NODE_PINS_FILE).toBe(file);
    const v = pinnedNodeVersion();
    expect(v).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(readFileSync(file, 'utf8')).toContain(`NODE_VERSION='${v}'`);
    const runNode = readFileSync(join(PLUGIN_ROOT, 'bin', 'run-node'), 'utf8');
    expect(runNode).toContain('PRIVATE_DIR=$HOME/.local/share/team-relay\n');
    expect(runNode).toContain('PINNED_DIR=$PRIVATE_DIR/node-$NODE_VERSION-darwin-$NODE_ARCH\n');
    expect(runNode).toContain('PINNED_NODE=$PINNED_DIR/bin/node\n');
    expect(pinnedNodePath('/h', v!, 'x64')).toBe(`/h/.local/share/team-relay/node-${v}-darwin-x64/bin/node`);
    // A second assignment makes the pin unreadable rather than ambiguous.
    const twice = join(tmp, 'twice.sh');
    writeFileSync(twice, `${readFileSync(file, 'utf8')}\nNODE_VERSION='v1.2.3'\n`);
    expect(pinnedNodeVersion(twice)).toBeNull();
  });
});
