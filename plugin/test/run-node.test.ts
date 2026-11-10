// bin/run-node (M11-SPEC "Simpler joining"): the plugin's processes start through it, so they
// never depend on `node` from Claude Code's PATH. It uses node on PATH when it is 22.12 or newer,
// else the newest Node.js the setup line installed privately (~/.local/share/team-relay/
// node-v<x.y.z>-*/bin/node) that runs, else says in one plain line what to do and exits 1.
// Here: a PATH and a HOME of fakes that say their version and which one ran.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers/mcp.js';

const LAUNCHER = join(PLUGIN_ROOT, 'bin', 'run-node');
let tmp: string;
let bin: string;
let home: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tr-run-node-')));
  bin = join(tmp, 'bin');
  home = join(tmp, 'home');
  mkdirSync(bin);
  mkdirSync(home);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A fake node at `path` that says `version` and, run with a script, which one it is and its args. */
function fakeNode(path: string, version: string, name: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\necho "${name} $*"\n`);
  chmodSync(path, 0o755);
}
const privateNode = (folder: string) => join(home, '.local', 'share', 'team-relay', folder, 'bin', 'node');

function launch(args: string[] = ['/plugin/dist/channel.js', '--flag'], o: { path?: string; cwd?: string } = {}) {
  // Only the fakes on PATH: the launcher uses shell builtins alone.
  const r = spawnSync('/bin/sh', [LAUNCHER, ...args], { env: { PATH: o.path ?? bin, HOME: home }, cwd: o.cwd ?? tmp, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe('bin/run-node', () => {
  it('is a POSIX sh script, run with /bin/sh (no executable bit needed), and executable too', () => {
    expect(statSync(LAUNCHER).mode & 0o111).not.toBe(0);
    expect(spawnSync('/bin/sh', ['-n', LAUNCHER]).status).toBe(0);
  });

  it('uses node on PATH when it is 22.12 or newer, with every argument', () => {
    fakeNode(join(bin, 'node'), 'v22.12.0', 'path-node');
    fakeNode(privateNode('node-v22.23.4-darwin-arm64'), 'v22.23.4', 'private-node');
    expect(launch()).toEqual({ code: 0, out: 'path-node /plugin/dist/channel.js --flag', err: '' });
    fakeNode(join(bin, 'node'), 'v24.1.0', 'path-node-24');
    expect(launch().out).toBe('path-node-24 /plugin/dist/channel.js --flag');
  });

  it('skips an older node on PATH (22.11, 20) for the newest private one that runs', () => {
    fakeNode(privateNode('node-v22.12.0-darwin-arm64'), 'v22.12.0', 'private-22.12');
    fakeNode(privateNode('node-v22.23.4-darwin-arm64'), 'v22.23.4', 'private-22.23');
    fakeNode(privateNode('node-v22.9.0-darwin-arm64'), 'v22.9.0', 'private-too-old');
    // A folder whose node does not run is passed over.
    mkdirSync(join(home, '.local', 'share', 'team-relay', 'node-v23.0.0-darwin-arm64', 'bin'), { recursive: true });
    writeFileSync(privateNode('node-v23.0.0-darwin-arm64'), '#!/bin/sh\nexit 1\n');
    chmodSync(privateNode('node-v23.0.0-darwin-arm64'), 0o755);
    for (const old of ['v22.11.0', 'v20.19.0']) {
      fakeNode(join(bin, 'node'), old, 'path-node');
      expect(launch()).toEqual({ code: 0, out: 'private-22.23 /plugin/dist/channel.js --flag', err: '' });
    }
    // No node on PATH at all: the same.
    rmSync(join(bin, 'node'));
    expect(launch().out).toBe('private-22.23 /plugin/dist/channel.js --flag');
  });

  it('never runs a node from the current folder: empty or relative PATH entries are skipped', () => {
    const project = join(tmp, 'project');
    fakeNode(join(project, 'node'), 'v24.0.0', 'project-node');
    fakeNode(privateNode('node-v22.23.4-darwin-arm64'), 'v22.23.4', 'private-node');
    for (const path of ['.', `:${bin}`, `${bin}:`, `${bin}::/usr/bin`, 'project', `./:${bin}`]) {
      expect(launch(undefined, { path, cwd: path === 'project' ? tmp : project }).out, path).toBe('private-node /plugin/dist/channel.js --flag');
    }
    // An absolute entry after them still counts.
    fakeNode(join(bin, 'node'), 'v22.12.0', 'path-node');
    expect(launch(undefined, { path: `.::${bin}`, cwd: project }).out).toBe('path-node /plugin/dist/channel.js --flag');
  });

  it('refuses a version that is not major.minor.patch, or numbers too large to compare', () => {
    fakeNode(privateNode('node-v22.23.4-darwin-arm64'), 'v22.23.4', 'private-node');
    for (const bad of ['v22', 'v22.12', 'v99999999999999999999.1.0', 'v24.99999999999999999999.0', 'vx.y.z', '']) {
      fakeNode(join(bin, 'node'), bad, 'path-node');
      expect(launch().out, bad).toBe('private-node /plugin/dist/channel.js --flag');
      expect(launch().err, bad).toBe('');
    }
  });

  it('with no new-enough node anywhere: one plain line, exit 1', () => {
    fakeNode(join(bin, 'node'), 'v20.19.0', 'path-node');
    fakeNode(privateNode('node-v22.9.0-darwin-arm64'), 'v22.9.0', 'private-too-old');
    expect(launch()).toEqual({
      code: 1,
      out: '',
      err: 'Team relay needs its helper: paste the setup line from your team page into Terminal again.',
    });
    rmSync(join(bin, 'node'));
    rmSync(join(home, '.local'), { recursive: true });
    expect(launch().code).toBe(1);
  });
});
