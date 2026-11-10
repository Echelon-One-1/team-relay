// M11-SPEC §1, §5: the background answerer's LaunchAgent and launcher, written into a temporary
// home with a fake launchctl (nothing here touches the real ~/Library or launchctl).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_LABEL,
  AgentError,
  LAUNCHCTL,
  PLUGIN_KEY_ENV,
  agentPlistPath,
  installAgent,
  launcherPath,
  pickPluginEntry,
  plistXml,
  readInstalledPlugin,
  uninstallAgent,
  xmlEscape,
  type Exec,
  type InstallInput,
} from '../src/daemon-launch.js';

let tmp: string;
let home: string;
let cfg: string;
let claude: string;
let calls: Array<{ file: string; args: string[] }>;

const KEY = 'team-relay@market';

/**
 * A launchctl that records its calls. `print` says the agent is still loaded `loadedFor` times
 * after a bootout, then that it is gone (113); bootstrap fails `bootstrapFails` times with `code`.
 */
function fakeExec(o: { code?: number; bootstrapFails?: number; loadedFor?: number } = {}): Exec {
  let loaded = o.loadedFor ?? 0;
  let fails = o.bootstrapFails ?? (o.code ? Number.POSITIVE_INFINITY : 0);
  return async (file, args) => {
    calls.push({ file, args });
    if (args[0] === 'bootout') return { code: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' };
    if (args[0] === 'print') {
      if (loaded > 0) {
        loaded--;
        return { code: 0, stdout: 'state = running', stderr: '' };
      }
      return { code: 113, stdout: '', stderr: 'Could not find service' };
    }
    if (fails > 0) {
      fails--;
      return { code: o.code ?? 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

let sleeps: number[];
const sleep = async (ms: number) => void sleeps.push(ms);

/** Writes installed_plugins.json with `plugins` (key -> entries). */
function writeInstalled(plugins: Record<string, unknown[]>): void {
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
}

/** A plugin folder whose dist/daemon.js prints `says` (and the key it was given). */
function fakePlugin(name: string, says: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'daemon.js'), `process.stdout.write(${JSON.stringify(says)} + ' ' + process.env.${'TEAM_RELAY_PLUGIN_KEY'});\n`);
  return dir;
}

const userEntry = (installPath: string, lastUpdated = '2026-11-05T00:00:00.000Z') => ({ scope: 'user', installPath, version: '1', lastUpdated, gitCommitSha: 'c'.repeat(40) });

/** The install input for this temp home, with the plugin installed under KEY. */
function input(extra: Partial<InstallInput> = {}): InstallInput {
  return { home, configDir: cfg, node: process.execPath, claude, uid: 501, pluginKey: KEY, exec: fakeExec(), sleep, ...extra };
}

const mode = (p: string) => lstatSync(p).mode & 0o777;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tr-agent-')));
  home = join(tmp, 'home');
  mkdirSync(home);
  cfg = join(home, '.config', 'team-relay');
  claude = join(tmp, 'bin', 'claude');
  mkdirSync(join(tmp, 'bin'));
  writeFileSync(claude, '#!/bin/sh\nexit 0\n');
  chmodSync(claude, 0o755);
  calls = [];
  sleeps = [];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('the installed plugin (installed_plugins.json)', () => {
  const entry = (installPath: string, lastUpdated: string, extra: Record<string, unknown> = {}) => ({
    scope: 'user',
    installPath,
    version: '0.11.0',
    installedAt: '2026-11-01T00:00:00.000Z',
    lastUpdated,
    gitCommitSha: 'a'.repeat(40),
    ...extra,
  });

  it('picks the first user-scope install under exactly the key setup installed, never another marketplace\'s', () => {
    const json = {
      version: 2,
      plugins: {
        'other-plugin@m1': [entry('/p/other', '2026-11-09T00:00:00.000Z')],
        'team-relay@m1': [entry('/p/project', '2026-11-09T00:00:00.000Z', { scope: 'project' }), entry('/p/m1', '2026-11-01T00:00:00.000Z'), entry('/p/m1b', '2026-11-08T00:00:00.000Z')],
        'team-relay@m2': [entry('/p/m2-newer', '2026-11-09T00:00:00.000Z')],
      },
    };
    const e = pickPluginEntry(json, 'team-relay@m1')!;
    expect(e.key).toBe('team-relay@m1');
    expect(e.installPath).toBe('/p/m1');
    expect(e.identity).toBe(['/p/m1', 'a'.repeat(40), '2026-11-01T00:00:00.000Z', '0.11.0'].join('\n'));
    expect(pickPluginEntry(json, 'team-relay@m2')!.installPath).toBe('/p/m2-newer');
    expect(pickPluginEntry(json, 'team-relay@m3')).toBeNull();
  });

  it('a key that is not team-relay@<marketplace name> finds nothing', () => {
    const json = { plugins: { 'other-plugin@m1': [entry('/p/other', 'x')], 'team-relay@m 1': [entry('/p/a', 'x')], 'team-relay@': [entry('/p/b', 'x')] } };
    for (const key of ['other-plugin@m1', 'team-relay@m 1', 'team-relay@', 'team-relay', '__proto__', 'team-relay@' + 'm'.repeat(101)]) expect(pickPluginEntry(json, key)).toBeNull();
  });

  it('the identity changes when the install path, commit or update time changes', () => {
    const base = { plugins: { 'team-relay@m': [entry('/p/a', '2026-11-05T00:00:00.000Z')] } };
    const id = pickPluginEntry(base, 'team-relay@m')!.identity;
    expect(pickPluginEntry({ plugins: { 'team-relay@m': [entry('/p/b', '2026-11-05T00:00:00.000Z')] } }, 'team-relay@m')!.identity).not.toBe(id);
    expect(pickPluginEntry({ plugins: { 'team-relay@m': [entry('/p/a', '2026-11-05T00:00:00.000Z', { gitCommitSha: 'b'.repeat(40) })] } }, 'team-relay@m')!.identity).not.toBe(id);
    expect(pickPluginEntry({ plugins: { 'team-relay@m': [entry('/p/a', '2026-11-06T00:00:00.000Z')] } }, 'team-relay@m')!.identity).not.toBe(id);
  });

  it('none: not installed, only project scope, a relative path, or a file that is not the shape', () => {
    const k = 'team-relay@m';
    expect(pickPluginEntry(null, k)).toBeNull();
    expect(pickPluginEntry({ plugins: [] }, k)).toBeNull();
    expect(pickPluginEntry({ plugins: { 'team-relay-x@m': [entry('/p/a', 'x')] } }, k)).toBeNull();
    expect(pickPluginEntry({ plugins: { 'team-relay@m': [entry('/p/a', 'x', { scope: 'project' })] } }, k)).toBeNull();
    expect(pickPluginEntry({ plugins: { 'team-relay@m': [entry('relative/path', 'x')] } }, k)).toBeNull();
    expect(pickPluginEntry({ plugins: { 'team-relay@m': entry('/p/a', 'x') } }, k)).toBeNull();
    expect(readInstalledPlugin(home, k)).toBeNull();
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), '{not json');
    expect(readInstalledPlugin(home, k)).toBeNull();
  });
});

describe('the plist (M11-SPEC §5)', () => {
  it('runs node with the launcher, at load, kept alive, throttled to 30 s, output to /dev/null, with the fixed environment', () => {
    const xml = plistXml({ node: '/opt/node/bin/node', launcher: '/h/.config/team-relay/daemon-launch.mjs', claude: '/opt/claude/bin/claude', home: '/h' });
    expect(xml).toContain(`<key>Label</key><string>${AGENT_LABEL}</string>`);
    expect(xml).toContain('<key>ProgramArguments</key><array><string>/opt/node/bin/node</string><string>/h/.config/team-relay/daemon-launch.mjs</string></array>');
    expect(xml).toContain('<key>RunAtLoad</key><true/>');
    expect(xml).toContain('<key>KeepAlive</key><true/>');
    expect(xml).toContain('<key>ThrottleInterval</key><integer>30</integer>');
    expect(xml).toContain('<key>StandardOutPath</key><string>/dev/null</string>');
    expect(xml).toContain('<key>StandardErrorPath</key><string>/dev/null</string>');
    expect(xml).toContain('<key>HOME</key><string>/h</string>');
    expect(xml).toContain('<key>TEAM_RELAY_CLAUDE_BIN</key><string>/opt/claude/bin/claude</string>');
    expect(xml).toContain('<key>PATH</key><string>/opt/node/bin:/opt/claude/bin:/usr/bin:/bin</string>');
    expect(xml).not.toContain('XDG_CONFIG_HOME');
  });

  it('escapes every value: a path cannot add keys or close the document', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    const evil = '/h/x</string><key>Evil</key><string>y';
    const xml = plistXml({ node: '/n/node', launcher: '/l.mjs', claude: '/c/claude', home: evil });
    expect(xml).not.toContain('<key>Evil</key>');
    expect(xml).toContain('<key>HOME</key><string>/h/x&lt;/string&gt;&lt;key&gt;Evil&lt;/key&gt;&lt;string&gt;y</string>');
  });
});

describe('daemon install and uninstall (M11-SPEC §5)', () => {
  beforeEach(() => writeInstalled({ [KEY]: [userEntry(fakePlugin('installed', 'daemon'))] }));
  const BOOTOUT = { file: LAUNCHCTL, args: ['bootout', `gui/501/${AGENT_LABEL}`] };
  const PRINT = { file: LAUNCHCTL, args: ['print', `gui/501/${AGENT_LABEL}`] };
  const bootstrap = (plist: string) => ({ file: LAUNCHCTL, args: ['bootstrap', 'gui/501', plist] });

  it('writes the launcher and the plist (mode 600, new folders 700), then bootout, waits until it is gone, and bootstrap in the user domain', async () => {
    const r = await installAgent(input());
    expect(r.plist).toBe(agentPlistPath(home));
    expect(r.plist).toBe(join(home, 'Library', 'LaunchAgents', 'com.team-relay.answerer.plist'));
    expect(r.launcher).toBe(launcherPath(cfg));
    expect(r.launcher).toBe(join(cfg, 'daemon-launch.mjs'));
    expect(mode(r.plist)).toBe(0o600);
    expect(mode(r.launcher)).toBe(0o600);
    expect(mode(join(home, 'Library', 'LaunchAgents'))).toBe(0o700);
    expect(mode(cfg)).toBe(0o700);
    const xml = readFileSync(r.plist, 'utf8');
    expect(xml).toContain(`<string>${process.execPath}</string><string>${r.launcher}</string>`);
    expect(xml).toContain(`<key>TEAM_RELAY_CLAUDE_BIN</key><string>${claude}</string>`);
    expect(calls).toEqual([BOOTOUT, PRINT, bootstrap(r.plist)]);
    expect(sleeps).toEqual([]);
  });

  it('after bootout it waits for launchd to let the old agent go before bootstrap', async () => {
    const r = await installAgent(input({ exec: fakeExec({ loadedFor: 3 }) }));
    expect(calls).toEqual([BOOTOUT, PRINT, PRINT, PRINT, PRINT, bootstrap(r.plist)]);
    expect(sleeps).toEqual([500, 500, 500]);
  });

  it('it waits about 20 s at most, then tries bootstrap anyway', async () => {
    const r = await installAgent(input({ exec: fakeExec({ loadedFor: 1000 }) }));
    expect(calls.filter((c) => c.args[0] === 'print')).toHaveLength(41);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(20_000);
    expect(calls.at(-1)).toEqual(bootstrap(r.plist));
  });

  it('a failed bootstrap is tried again, up to 3 more times, with a short wait between', async () => {
    const r = await installAgent(input({ exec: fakeExec({ bootstrapFails: 2 }) }));
    expect(calls.filter((c) => c.args[0] === 'bootstrap')).toEqual([bootstrap(r.plist), bootstrap(r.plist), bootstrap(r.plist)]);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('a bootstrap that keeps failing is an error that says so, after 4 tries', async () => {
    await expect(installAgent(input({ exec: fakeExec({ code: 5 }) }))).rejects.toThrow(/launchctl bootstrap failed \(exit 5\)/);
    expect(calls.filter((c) => c.args[0] === 'bootstrap')).toHaveLength(4);
    expect(sleeps).toEqual([2000, 2000, 2000]);
  });

  it('a second install replaces both files in place', async () => {
    await installAgent(input());
    const other = join(tmp, 'bin', 'claude2');
    writeFileSync(other, '#!/bin/sh\n');
    chmodSync(other, 0o755);
    await installAgent(input({ claude: other }));
    expect(readFileSync(agentPlistPath(home), 'utf8')).toContain(`<string>${other}</string>`);
    expect(mode(agentPlistPath(home))).toBe(0o600);
  });

  it('refuses a claude that is relative, missing or not executable, before writing anything', async () => {
    const noexec = join(tmp, 'bin', 'plain');
    writeFileSync(noexec, 'x');
    for (const bad of ['claude', join(tmp, 'bin', 'missing'), noexec, join(tmp, 'bin')]) {
      await expect(installAgent(input({ claude: bad }))).rejects.toBeInstanceOf(AgentError);
    }
    expect(existsSync(agentPlistPath(home))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses, before writing anything, when the launcher would find nothing to run for that key', async () => {
    await expect(installAgent(input({ pluginKey: 'team-relay@elsewhere' }))).rejects.toThrow('team-relay@elsewhere is not installed for this user');
    await expect(installAgent(input({ pluginKey: 'other@market' }))).rejects.toThrow('--plugin other@market cannot be used: it must be team-relay@<marketplace name>');
    writeInstalled({ [KEY]: [{ ...userEntry(fakePlugin('installed', 'daemon')), scope: 'project' }] });
    await expect(installAgent(input())).rejects.toThrow(`${KEY} is not installed for this user`);
    const empty = join(tmp, 'empty-plugin');
    mkdirSync(empty);
    writeInstalled({ [KEY]: [userEntry(empty)] });
    await expect(installAgent(input())).rejects.toThrow(`${KEY} is installed, but without dist/daemon.js`);
    expect(existsSync(agentPlistPath(home))).toBe(false);
    expect(existsSync(launcherPath(cfg))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('never writes through a symlink', async () => {
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    const target = join(tmp, 'elsewhere.plist');
    writeFileSync(target, 'original');
    symlinkSync(target, agentPlistPath(home));
    await expect(installAgent(input())).rejects.toThrow(/not a regular file/);
    expect(readFileSync(target, 'utf8')).toBe('original');
  });

  it('uninstall boots the agent out and removes both files; a second uninstall finds nothing', async () => {
    await installAgent(input());
    calls = [];
    expect(await uninstallAgent({ home, configDir: cfg, uid: 501, exec: fakeExec() })).toBe(true);
    expect(calls).toEqual([BOOTOUT]);
    expect(existsSync(agentPlistPath(home))).toBe(false);
    expect(existsSync(launcherPath(cfg))).toBe(false);
    expect(await uninstallAgent({ home, configDir: cfg, uid: 501, exec: fakeExec() })).toBe(false);
  });
});

describe('the launcher (M11-SPEC §1)', () => {
  const run = (path: string) => spawnSync(process.execPath, [path], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });

  it('runs dist/daemon.js of the plugin installed now under its key, and tells it the key (an update is picked up at the next start)', async () => {
    writeInstalled({ [KEY]: [userEntry(fakePlugin('v1', 'daemon v1'))] });
    const path = (await installAgent(input())).launcher;
    let r = run(path);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`daemon v1 ${KEY}`);
    expect(PLUGIN_KEY_ENV).toBe('TEAM_RELAY_PLUGIN_KEY');
    writeInstalled({ [KEY]: [userEntry(fakePlugin('v2', 'daemon v2'), '2026-11-06T00:00:00.000Z')] });
    r = run(path);
    expect(r.stdout).toBe(`daemon v2 ${KEY}`);
  });

  it('never runs another marketplace\'s copy, even a newer one', async () => {
    writeInstalled({ [KEY]: [userEntry(fakePlugin('mine', 'mine'))] });
    const path = (await installAgent(input())).launcher;
    writeInstalled({ [KEY]: [userEntry(fakePlugin('mine', 'mine'))], 'team-relay@zzz': [userEntry(fakePlugin('theirs', 'theirs'), '2026-11-09T00:00:00.000Z')] });
    expect(run(path).stdout).toBe(`mine ${KEY}`);
  });

  it('exits 1 when the plugin is no longer installed under its key for this user', async () => {
    writeInstalled({ [KEY]: [userEntry(fakePlugin('v1', 'daemon v1'))] });
    const path = (await installAgent(input())).launcher;
    writeInstalled({ 'team-relay@zzz': [userEntry(fakePlugin('theirs', 'theirs'))] });
    const r = run(path);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the plugin is not installed for this user');
  });
});
