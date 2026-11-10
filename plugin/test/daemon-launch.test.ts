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
  agentPlistPath,
  installAgent,
  launcherPath,
  pickPluginEntry,
  plistXml,
  readInstalledPlugin,
  uninstallAgent,
  xmlEscape,
  type Exec,
} from '../src/daemon-launch.js';

let tmp: string;
let home: string;
let cfg: string;
let claude: string;
let calls: Array<{ file: string; args: string[] }>;

/** A launchctl that records its calls; bootstrap answers `code`. */
function fakeExec(bootstrapCode = 0): Exec {
  return async (file, args) => {
    calls.push({ file, args });
    if (args[0] === 'bootout') return { code: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' };
    return { code: bootstrapCode, stdout: '', stderr: bootstrapCode ? 'Bootstrap failed: 5: Input/output error' : '' };
  };
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

  it('picks the user-scope team-relay install, the most recently updated across marketplaces', () => {
    const json = {
      version: 2,
      plugins: {
        'other-plugin@m1': [entry('/p/other', '2026-11-09T00:00:00.000Z')],
        'team-relay@m1': [entry('/p/old', '2026-11-01T00:00:00.000Z'), entry('/p/project', '2026-11-09T00:00:00.000Z', { scope: 'project' })],
        'team-relay@m2': [entry('/p/new', '2026-11-05T00:00:00.000Z')],
      },
    };
    const e = pickPluginEntry(json)!;
    expect(e.key).toBe('team-relay@m2');
    expect(e.installPath).toBe('/p/new');
    expect(e.identity).toBe(['/p/new', 'a'.repeat(40), '2026-11-05T00:00:00.000Z', '0.11.0'].join('\n'));
  });

  it('the identity changes when the install path, commit or update time changes', () => {
    const base = { plugins: { 'team-relay@m': [entry('/p/a', '2026-11-05T00:00:00.000Z')] } };
    const id = pickPluginEntry(base)!.identity;
    expect(pickPluginEntry({ plugins: { 'team-relay@m': [entry('/p/b', '2026-11-05T00:00:00.000Z')] } })!.identity).not.toBe(id);
    expect(pickPluginEntry({ plugins: { 'team-relay@m': [entry('/p/a', '2026-11-05T00:00:00.000Z', { gitCommitSha: 'b'.repeat(40) })] } })!.identity).not.toBe(id);
    expect(pickPluginEntry({ plugins: { 'team-relay@m': [entry('/p/a', '2026-11-06T00:00:00.000Z')] } })!.identity).not.toBe(id);
  });

  it('none: not installed, only project scope, a relative path, or a file that is not the shape', () => {
    expect(pickPluginEntry(null)).toBeNull();
    expect(pickPluginEntry({ plugins: [] })).toBeNull();
    expect(pickPluginEntry({ plugins: { 'team-relay-x@m': [entry('/p/a', 'x')] } })).toBeNull();
    expect(pickPluginEntry({ plugins: { 'team-relay@m': [entry('/p/a', 'x', { scope: 'project' })] } })).toBeNull();
    expect(pickPluginEntry({ plugins: { 'team-relay@m': [entry('relative/path', 'x')] } })).toBeNull();
    expect(readInstalledPlugin(home)).toBeNull();
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), '{not json');
    expect(readInstalledPlugin(home)).toBeNull();
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
  it('writes the launcher and the plist (mode 600, new folders 700), then bootout and bootstrap in the user domain', async () => {
    const r = await installAgent({ home, configDir: cfg, node: process.execPath, claude, uid: 501, exec: fakeExec() });
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
    expect(calls).toEqual([
      { file: LAUNCHCTL, args: ['bootout', `gui/501/${AGENT_LABEL}`] },
      { file: LAUNCHCTL, args: ['bootstrap', 'gui/501', r.plist] },
    ]);
  });

  it('a second install replaces both files in place', async () => {
    await installAgent({ home, configDir: cfg, node: process.execPath, claude, uid: 501, exec: fakeExec() });
    const other = join(tmp, 'bin', 'claude2');
    writeFileSync(other, '#!/bin/sh\n');
    chmodSync(other, 0o755);
    await installAgent({ home, configDir: cfg, node: process.execPath, claude: other, uid: 501, exec: fakeExec() });
    expect(readFileSync(agentPlistPath(home), 'utf8')).toContain(`<string>${other}</string>`);
    expect(mode(agentPlistPath(home))).toBe(0o600);
  });

  it('refuses a claude that is relative, missing or not executable, before writing anything', async () => {
    const noexec = join(tmp, 'bin', 'plain');
    writeFileSync(noexec, 'x');
    for (const bad of ['claude', join(tmp, 'bin', 'missing'), noexec, join(tmp, 'bin')]) {
      await expect(installAgent({ home, configDir: cfg, node: process.execPath, claude: bad, uid: 501, exec: fakeExec() })).rejects.toBeInstanceOf(AgentError);
    }
    expect(existsSync(agentPlistPath(home))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('never writes through a symlink', async () => {
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    const target = join(tmp, 'elsewhere.plist');
    writeFileSync(target, 'original');
    symlinkSync(target, agentPlistPath(home));
    await expect(installAgent({ home, configDir: cfg, node: process.execPath, claude, uid: 501, exec: fakeExec() })).rejects.toThrow(/not a regular file/);
    expect(readFileSync(target, 'utf8')).toBe('original');
  });

  it('a failed bootstrap is an error that says so', async () => {
    await expect(installAgent({ home, configDir: cfg, node: process.execPath, claude, uid: 501, exec: fakeExec(5) })).rejects.toThrow(/launchctl bootstrap failed \(exit 5\)/);
  });

  it('uninstall boots the agent out and removes both files; a second uninstall finds nothing', async () => {
    await installAgent({ home, configDir: cfg, node: process.execPath, claude, uid: 501, exec: fakeExec() });
    calls = [];
    expect(await uninstallAgent({ home, configDir: cfg, uid: 501, exec: fakeExec() })).toBe(true);
    expect(calls).toEqual([{ file: LAUNCHCTL, args: ['bootout', `gui/501/${AGENT_LABEL}`] }]);
    expect(existsSync(agentPlistPath(home))).toBe(false);
    expect(existsSync(launcherPath(cfg))).toBe(false);
    expect(await uninstallAgent({ home, configDir: cfg, uid: 501, exec: fakeExec() })).toBe(false);
  });
});

describe('the launcher (M11-SPEC §1)', () => {
  async function launcher(): Promise<string> {
    return (await installAgent({ home, configDir: cfg, node: process.execPath, claude, uid: 501, exec: fakeExec() })).launcher;
  }
  function install(installPath: string, lastUpdated = '2026-11-05T00:00:00.000Z'): void {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'team-relay@market': [{ scope: 'user', installPath, version: '1', lastUpdated, gitCommitSha: 'c'.repeat(40) }] } }),
    );
  }
  function fakePlugin(name: string, says: string): string {
    const dir = join(tmp, name);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'daemon.js'), `process.stdout.write(${JSON.stringify(says)});\n`);
    return dir;
  }
  const run = (path: string) => spawnSync(process.execPath, [path], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });

  it('runs dist/daemon.js of the plugin installed now (an update is picked up at the next start)', async () => {
    const path = await launcher();
    install(fakePlugin('v1', 'daemon v1'));
    let r = run(path);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('daemon v1');
    install(fakePlugin('v2', 'daemon v2'), '2026-11-06T00:00:00.000Z');
    r = run(path);
    expect(r.stdout).toBe('daemon v2');
  });

  it('exits 1 when the plugin is not installed for this user', async () => {
    const path = await launcher();
    const r = run(path);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the plugin is not installed for this user');
  });
});
