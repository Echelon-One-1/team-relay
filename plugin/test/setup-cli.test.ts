// M11-SPEC §5, §6: `node dist/setup-cli.js <command>`, run in this process with a scripted
// terminal, the fake relay, a temporary home and a fake launchctl (nothing here touches the real
// ~/.config, ~/Library or launchctl).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsPath, writeCredential } from '../src/credentials.js';
import { SELF_TEST_PENDING } from '../src/daemon-core.js';
import type { Exec } from '../src/daemon-launch.js';
import type { Keychain } from '../src/google-drive.js';
import type { LoginOptions } from '../src/login.js';
import { memberFoldersPath, readTeamSettings } from '../src/member-folders.js';
import { RelayClient } from '../src/relay-client.js';
import { HELP, PRIVACY_DRIVE_NOTE, PRIVACY_FOLDERS_NOTE, checklist, runSetup, type SetupDeps } from '../src/setup-cli.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';

let relay: FakeRelay;
let tmp: string;
let home: string;
let xdg: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  relay = await new FakeRelay().start();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tr-setup-')));
  home = join(tmp, 'home');
  xdg = join(tmp, 'xdg');
  mkdirSync(home);
  mkdirSync(xdg, { mode: 0o700 });
  env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: xdg };
});
afterEach(async () => {
  await relay.stop();
  rmSync(tmp, { recursive: true, force: true });
});

/** A terminal that answers with `answers` in order (then end of input) and records what was printed. */
function term(answers: string[] = []) {
  const out: string[] = [];
  const asked: string[] = [];
  return {
    out,
    asked,
    text: () => out.join('\n'),
    io: {
      print: (l: string) => void out.push(l),
      ask: async (p: string) => {
        asked.push(p);
        return answers.length ? answers.shift()! : null;
      },
    },
  };
}

const bob = () => ({ client: new RelayClient({ url: relay.url, team: 'demo', token: () => TOKEN_OF.bob!, attempts: 1 }), member: 'bob', team: 'demo' });
const deps = (t: ReturnType<typeof term>, extra: Partial<SetupDeps> = {}): SetupDeps => ({ env, io: t.io, connect: async () => bob(), ...extra });

describe('commands and usage', () => {
  it('no command, or help, prints the commands; anything else prints them with exit 2', async () => {
    for (const argv of [[], ['help']]) {
      const t = term();
      expect(await runSetup(argv, deps(t))).toBe(0);
      expect(t.text()).toBe(HELP);
    }
    for (const argv of [['nope'], ['folders', 'extra'], ['daemon'], ['daemon', 'start'], ['login', '--other']]) {
      const t = term();
      expect(await runSetup(argv, deps(t))).toBe(2);
      expect(t.text()).toBe(HELP);
    }
    for (const cmd of ['login', 'folders', 'drive', 'daemon install --claude', 'daemon uninstall', 'status']) expect(HELP).toContain(cmd);
  });

  it('a command that needs the relay says how to sign in when this computer is not signed in', async () => {
    const t = term();
    expect(await runSetup(['status'], { env, io: t.io })).toBe(1);
    expect(t.text()).toBe('Not signed in to the team relay: run `node setup-cli.js login` first.');
  });
});

describe('login (M11-SPEC §5)', () => {
  it('is skipped when this computer is already signed in to that relay', async () => {
    writeCredential(credentialsPath(env), { relay_url: relay.url, team: 'demo', member: 'bob', credential: relay.mintCredential('bob'), expires_at: null });
    const t = term();
    let started = false;
    const code = await runSetup(['login', '--relay', relay.url], {
      env,
      io: t.io,
      startLogin: async () => {
        started = true;
        throw new Error('not expected');
      },
    });
    expect(code).toBe(0);
    expect(started).toBe(false);
    expect(t.text()).toBe('Already signed in. Connected as bob on team demo.');
  });

  it('otherwise runs the browser sign-in for that relay and says who this computer is now', async () => {
    const t = term();
    let opts: LoginOptions | null = null;
    const code = await runSetup(['login', '--relay', relay.url], {
      env,
      io: t.io,
      startLogin: async (o) => {
        opts = o;
        return {
          url: 'http://127.0.0.1:5555/start',
          port: 5555,
          cancel: () => {},
          done: Promise.resolve({ stored: { relay_url: relay.url, team: 'demo', member: 'bob', credential: 'trc_x', expires_at: null }, replaced: null }),
        };
      },
    });
    expect(code).toBe(0);
    expect(opts).toMatchObject({ relayUrl: relay.url, credentialsFile: credentialsPath(env) });
    expect(t.out).toContain('http://127.0.0.1:5555/start');
    expect(t.out.at(-1)).toBe('Connected as bob on team demo.');
    expect(t.text()).not.toContain('trc_x');
  });

  it('a sign-in that does not complete exits 1', async () => {
    const t = term();
    const code = await runSetup(['login', '--relay', relay.url], {
      env,
      io: t.io,
      startLogin: async () => ({ url: 'http://127.0.0.1:1/x', port: 1, cancel: () => {}, done: Promise.reject(new Error('the sign-in timed out')) }),
    });
    expect(code).toBe(1);
    expect(t.out.at(-1)).toBe('The sign-in did not complete: the sign-in timed out');
  });
});

describe('folders (M11-SPEC §5)', () => {
  const ORGS = { topic: 'Example Org: engineering.', github_orgs: ['example-org'], drives: [], member_folders: true };
  let code1: string;
  let code2: string;
  beforeEach(() => {
    // Not directly in the home folder (scope.ts folderSafety).
    code1 = join(home, 'code', 'org');
    code2 = join(home, 'work', 'notes');
    mkdirSync(code1, { recursive: true });
    mkdirSync(code2, { recursive: true });
  });
  const settings = () => readTeamSettings(memberFoldersPath(env), env, 'demo');

  it('with no boundaries there is nothing to choose; it says where an owner sets them', async () => {
    const t = term();
    expect(await runSetup(['folders'], deps(t))).toBe(0);
    expect(t.text()).toContain('Your team has no boundaries yet');
    expect(t.text()).toContain(relay.url);
    expect(existsSync(memberFoldersPath(env))).toBe(false);
  });

  it("shows the team's orgs, checks each folder, reports the clones found, and saves the lists for this team", async () => {
    relay.setBoundaries(ORGS);
    const t = term(['code', '~/code/org', '~/code/org', '', join(tmp, 'notes-missing'), code2, '']);
    const counted: Array<[string, string[]]> = [];
    const code = await runSetup(['folders'], deps(t, { clones: async (raw, orgs) => (counted.push([raw, orgs]), raw === '~/code/org' ? 3 : 0) }));
    expect(code).toBe(0);
    expect(t.out).toContain("Your team's GitHub organisations: example-org.");
    expect(t.out).toContain('  Not used: code is not an absolute path or one starting with ~/.');
    expect(t.out).toContain(`  ~/code/org (${code1}): 3 clones found`);
    expect(t.out).toContain('  Already in the list.');
    expect(t.text()).toContain('Your team allows folders of your own.');
    expect(t.out.some((l) => l.startsWith(`  Not used: ${join(tmp, 'notes-missing')} cannot be used:`))).toBe(true);
    expect(counted).toEqual([['~/code/org', ['example-org']]]);
    expect(settings()).toMatchObject({ repo_roots: ['~/code/org'], extra_folders: [code2] });
    expect(t.out.at(-1)).toBe('Saved: 1 repo root, 1 own folder. Your background answerer uses them from its next answer.');
  });

  it('a second run shows the current lists; keep leaves them, no replaces them', async () => {
    relay.setBoundaries(ORGS);
    await runSetup(['folders'], deps(term(['~/code/org', '', code2, '']), { clones: async () => 1 }));
    const keep = term(['', 'y']);
    expect(await runSetup(['folders'], deps(keep, { clones: async () => 1 }))).toBe(0);
    expect(keep.out).toContain('Your repo roots now:');
    expect(keep.out).toContain(`  ~/code/org (${code1}): 1 clone found`);
    expect(keep.asked).toEqual(['Keep these repo roots? [Y/n] ', 'Keep these own folders? [Y/n] ']);
    expect(settings()).toMatchObject({ repo_roots: ['~/code/org'], extra_folders: [code2] });
    const replace = term(['n', '~/work/notes', '', 'n', '']);
    expect(await runSetup(['folders'], deps(replace, { clones: async () => 0 }))).toBe(0);
    expect(settings()).toMatchObject({ repo_roots: ['~/work/notes'], extra_folders: [] });
  });

  it('a folder in Documents, Desktop, Downloads or iCloud Drive: it says macOS may ask to allow "node", once', async () => {
    relay.setBoundaries(ORGS);
    for (const d of ['Documents/code', 'Library/Mobile Documents/notes']) mkdirSync(join(home, d), { recursive: true });
    const t = term(['~/Documents/code', '', join(home, 'Library', 'Mobile Documents', 'notes'), '']);
    expect(await runSetup(['folders'], deps(t, { clones: async () => 1 }))).toBe(0);
    const note = PRIVACY_FOLDERS_NOTE;
    expect(note).toContain('"node"');
    expect(note).toContain('click Allow');
    expect(t.out.filter((l) => l === note)).toHaveLength(1);
    // Elsewhere: not said.
    const t2 = term(['n', '~/code/org', '', 'n', '']);
    expect(await runSetup(['folders'], deps(t2, { clones: async () => 1 }))).toBe(0);
    expect(t2.out).not.toContain(note);
  });

  it('own folders are asked for only when the team allows them', async () => {
    relay.setBoundaries({ ...ORGS, member_folders: false });
    const t = term(['~/code/org', '']);
    expect(await runSetup(['folders'], deps(t, { clones: async () => 0 }))).toBe(0);
    expect(t.text()).not.toContain('folders of your own');
    expect(t.out.at(-1)).toBe('Saved: 1 repo root. Your background answerer uses them from its next answer.');
  });
});

describe('drive (M11-SPEC §5)', () => {
  const keychain = (account: string | null): Keychain => ({ account: async () => account, read: async () => null, write: async () => {}, removeAll: async () => 0 });

  it('nothing to do when the team has no drives', async () => {
    relay.setBoundaries({ topic: 'T', github_orgs: ['example-org'], drives: [], member_folders: false });
    const t = term();
    expect(await runSetup(['drive'], deps(t, { platform: 'darwin', keychain: keychain(null) }))).toBe(0);
    expect(t.text()).toBe('Your team has no shared Google Drives, so there is nothing to connect.');
  });

  it('already connected: nothing to do; not connected: the Drive sign-in runs', async () => {
    relay.setBoundaries({ topic: 'T', github_orgs: [], drives: [{ domain: 'example.com', shared_drive: 'Team Drive' }], member_folders: false });
    const t1 = term();
    let ran: string[] | null = null;
    const drive = async (argv: string[]) => ((ran = argv), { exitCode: 0, line: 'Google Drive connected as someone@example.com (read-only).' });
    expect(await runSetup(['drive'], deps(t1, { platform: 'darwin', keychain: keychain('someone@example.com'), drive }))).toBe(0);
    expect(t1.out).toEqual(['Google Drive is already connected as someone@example.com.', PRIVACY_DRIVE_NOTE]);
    expect(ran).toBeNull();
    const t2 = term();
    expect(await runSetup(['drive'], deps(t2, { platform: 'darwin', keychain: keychain(null), drive }))).toBe(0);
    expect(ran).toEqual(['connect']);
    expect(t2.out.slice(-2)).toEqual(['Google Drive connected as someone@example.com (read-only).', PRIVACY_DRIVE_NOTE]);
    expect(PRIVACY_DRIVE_NOTE).toMatch(/Google Drive.*"node".*click Allow\.$/);
  });
});

describe('daemon install and uninstall (M11-SPEC §5)', () => {
  const KEY = 'team-relay@market';
  let claude: string;
  let calls: string[][];
  // launchctl: bootout says not loaded, print says gone (113), bootstrap works.
  const exec: Exec = async (_file, args) => (calls.push(args), { code: args[0] === 'bootout' ? 3 : args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' });
  const sleep = async () => {};
  beforeEach(() => {
    claude = join(tmp, 'claude');
    writeFileSync(claude, '#!/bin/sh\n');
    chmodSync(claude, 0o755);
    calls = [];
    const plugin = join(tmp, 'plugin');
    mkdirSync(join(plugin, 'dist'), { recursive: true });
    writeFileSync(join(plugin, 'dist', 'daemon.js'), '');
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [KEY]: [{ scope: 'user', installPath: plugin }] } }));
  });

  it('installs the LaunchAgent for this user, for the plugin installed under the key given, and starts it', async () => {
    const t = term();
    expect(await runSetup(['daemon', 'install', '--claude', claude, '--plugin', KEY], deps(t, { platform: 'darwin', uid: 501, exec, sleep, node: process.execPath }))).toBe(0);
    const plist = join(home, 'Library', 'LaunchAgents', 'com.team-relay.answerer.plist');
    expect(readFileSync(plist, 'utf8')).toContain(`<key>TEAM_RELAY_CLAUDE_BIN</key><string>${claude}</string>`);
    expect(readFileSync(plist, 'utf8')).toContain(`<key>XDG_CONFIG_HOME</key><string>${xdg}</string>`);
    expect(readFileSync(join(xdg, 'team-relay', 'daemon-launch.mjs'), 'utf8')).toContain(`const KEY = "${KEY}";`);
    expect(calls).toEqual([
      ['bootout', 'gui/501/com.team-relay.answerer'],
      ['print', 'gui/501/com.team-relay.answerer'],
      ['bootstrap', 'gui/501', plist],
    ]);
    expect(t.text()).toContain('The background answerer is installed and started');
    const u = term();
    expect(await runSetup(['daemon', 'uninstall'], deps(u, { platform: 'darwin', uid: 501, exec }))).toBe(0);
    expect(u.text()).toBe('The background answerer is stopped and removed.');
    expect(existsSync(plist)).toBe(false);
  });

  it('needs --claude with an executable absolute path, --plugin with a key that is installed, and macOS', async () => {
    const t1 = term();
    expect(await runSetup(['daemon', 'install', '--plugin', KEY], deps(t1, { platform: 'darwin', uid: 501, exec, sleep }))).toBe(2);
    expect(t1.text()).toBe('daemon install needs --claude <the absolute path of claude>.');
    const t1b = term();
    expect(await runSetup(['daemon', 'install', '--claude', claude], deps(t1b, { platform: 'darwin', uid: 501, exec, sleep }))).toBe(2);
    expect(t1b.text()).toBe('daemon install needs --plugin team-relay@<marketplace name>, the plugin as the setup command installed it.');
    const t2 = term();
    expect(await runSetup(['daemon', 'install', '--claude', 'claude', '--plugin', KEY], deps(t2, { platform: 'darwin', uid: 501, exec, sleep }))).toBe(1);
    expect(t2.text()).toBe('--claude claude cannot be used: it is not an absolute path');
    const t3 = term();
    expect(await runSetup(['daemon', 'install', '--claude', claude, '--plugin', KEY], deps(t3, { platform: 'linux', uid: 501, exec, sleep }))).toBe(1);
    expect(t3.text()).toBe('The background answerer runs on macOS only.');
    const t4 = term();
    expect(await runSetup(['daemon', 'install', '--claude', claude, '--plugin', 'team-relay@other'], deps(t4, { platform: 'darwin', uid: 501, exec, sleep }))).toBe(1);
    expect(t4.text()).toContain('team-relay@other is not installed for this user');
    expect(calls).toEqual([]);
  });
});

describe('status: the Join checklist (M11-SPEC §6)', () => {
  const full = {
    claude: { found: true, signed_in: true },
    folders: { repo_roots: 1, clones: 2, extra_folders: 0 },
    drive: { connected: true },
    self_test: { ok: true, at: '2026-11-10T10:00:00.000Z', reason: null },
  };

  it("the seven steps from the relay's view of this member", () => {
    const steps = checklist({ status: full, answering: true, acceptedVersion: 2, boundariesVersion: 2, orgs: 1, drives: 1, console: 'https://relay.example.com' });
    expect(steps.map((s) => s.done)).toEqual([true, true, true, true, true, true, true]);
    const none = checklist({ status: null, answering: false, acceptedVersion: 1, boundariesVersion: 2, orgs: 1, drives: 1, console: 'https://relay.example.com' });
    expect(none.map((s) => s.done)).toEqual([false, false, false, false, false, false, false]);
    expect(none[5]!.todo).toBe('Open https://relay.example.com and press Accept.');
    // No orgs and no drives: those steps need nothing.
    const bare = checklist({ status: { ...full, folders: { repo_roots: 0 }, drive: { connected: false } }, answering: true, acceptedVersion: 1, boundariesVersion: 1, orgs: 0, drives: 0, console: 'x' });
    expect(bare.map((s) => s.done)).toEqual([true, true, true, true, true, true, true]);
    // Boundaries that could not be read: those two steps are not known, so never ticked.
    const unknown = checklist({ status: { ...full, folders: { repo_roots: 0 }, drive: { connected: false } }, answering: true, acceptedVersion: 1, boundariesVersion: 1, orgs: null, drives: null, console: 'x' });
    expect(unknown.map((s) => s.done)).toEqual([true, true, true, false, false, true, true]);
    expect(unknown[3]!.todo).toBe("Not known: your team's boundaries could not be read from the relay just now; run status again in a minute.");
    expect(unknown[4]!.todo).toBe(unknown[3]!.todo);
    // Not run yet is not a failure.
    const pending = checklist({ status: { ...full, self_test: { ok: false, reason: SELF_TEST_PENDING } }, answering: true, acceptedVersion: 1, boundariesVersion: 1, orgs: 0, drives: 0, console: 'x' });
    expect(pending[6]).toMatchObject({ done: false, todo: 'Running the self-test now; this takes about a minute.' });
    const failed = checklist({ status: { ...full, self_test: { ok: false, reason: 'Claude Code is not signed in' } }, answering: true, acceptedVersion: 1, boundariesVersion: 1, orgs: 0, drives: 0, console: 'x' });
    expect(failed[6]).toMatchObject({ done: false, todo: 'The self-test failed: Claude Code is not signed in.' });
  });

  it('prints the checklist in plain words from the relay', async () => {
    relay.setBoundaries({ topic: 'T', github_orgs: ['example-org'], drives: [], member_folders: false });
    relay.memberStatus.set('bob', { daemon: { version: '1', started_at: '2026-11-10T10:00:00.000Z' }, ...full, folders: { repo_roots: 0, clones: 0, extra_folders: 0 }, seen_at: new Date().toISOString() });
    const t = term();
    expect(await runSetup(['status'], deps(t))).toBe(0);
    expect(t.out).toEqual([
      'Setup for bob on team demo: 5 of 7 done.',
      '  [x] Run the setup command',
      '  [x] Claude Code found and signed in',
      '  [x] Answering in the background',
      '  [ ] Folders chosen - Choose the folders that hold your clones: node setup-cli.js folders.',
      '  [x] Google Drive connected',
      `  [ ] Boundaries accepted - Open ${relay.url} and press Accept.`,
      '  [x] Self-test passed',
    ]);
    relay.acceptances.set('bob', 1);
    relay.memberStatus.set('bob', { daemon: { version: '1', started_at: '2026-11-10T10:00:00.000Z' }, ...full, seen_at: new Date().toISOString() });
    const t2 = term();
    await runSetup(['status'], deps(t2));
    expect(t2.out[0]).toBe('Setup for bob on team demo: 7 of 7 done.');
    expect(t2.out.at(-1)).toBe(`You're set up. Ask the team in the console: ${relay.url}`);
  });

  it('while the self-test has not run yet it waits for it (every 5 s, up to 90 s), then prints the checklist', async () => {
    relay.setBoundaries({ topic: 'T', github_orgs: [], drives: [], member_folders: false });
    relay.acceptances.set('bob', 1);
    const pendingStatus = () => ({ daemon: { version: '1', started_at: '2026-11-10T10:00:00.000Z' }, ...full, self_test: { ok: false, at: '2026-11-10T10:00:00.000Z', reason: SELF_TEST_PENDING }, seen_at: new Date().toISOString() });
    relay.memberStatus.set('bob', pendingStatus());
    const waits: number[] = [];
    // The self-test ends during the second wait.
    const sleep = async (ms: number) => {
      waits.push(ms);
      if (waits.length === 2) relay.memberStatus.set('bob', { ...pendingStatus(), self_test: full.self_test });
    };
    const t = term();
    expect(await runSetup(['status'], deps(t, { sleep }))).toBe(0);
    expect(waits).toEqual([5000, 5000]);
    expect(t.out[0]).toBe('Running the self-test now; this takes about a minute.');
    expect(t.out).toContain('Setup for bob on team demo: 7 of 7 done.');
    expect(t.out).toContain('  [x] Self-test passed');

    // Still not run after 90 s: it prints the checklist as it is, saying it is running, not failed.
    relay.memberStatus.set('bob', pendingStatus());
    const waits2: number[] = [];
    const t2 = term();
    expect(await runSetup(['status'], deps(t2, { sleep: async (ms) => void waits2.push(ms) }))).toBe(0);
    expect(waits2.reduce((a, b) => a + b, 0)).toBe(90_000);
    expect(t2.out.at(-1)).toBe('  [ ] Self-test passed - Running the self-test now; this takes about a minute.');
    expect(t2.text()).not.toContain('failed');
  });

  it('when the boundaries cannot be read, folders and Drive are shown as not known, never ticked', async () => {
    relay.memberStatus.set('bob', { daemon: { version: '1', started_at: '2026-11-10T10:00:00.000Z' }, ...full, folders: { repo_roots: 0, clones: 0, extra_folders: 0 }, drive: { connected: false }, seen_at: new Date().toISOString() });
    relay.acceptances.set('bob', 1);
    relay.setBoundaries({ topic: 'T', github_orgs: [], drives: [], member_folders: false });
    const unreadable = (): ReturnType<typeof bob> => {
      const b = bob();
      b.client.boundaries = async () => {
        throw new Error('relay down');
      };
      return b;
    };
    const t = term();
    expect(await runSetup(['status'], deps(t, { connect: async () => unreadable() }))).toBe(0);
    expect(t.out[0]).toBe('Setup for bob on team demo: 5 of 7 done.');
    expect(t.out[4]).toMatch(/^ {2}\[ \] Folders chosen - Not known: /);
    expect(t.out[5]).toMatch(/^ {2}\[ \] Google Drive connected - Not known: /);
  });
});
