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
import {
  CHOOSE_FOLDER_SCRIPT,
  HELP,
  NOT_SIGNED_IN,
  PRIVACY_DRIVE_NOTE,
  PRIVACY_FOLDERS_NOTE,
  SELF_TEST_RUNNING,
  checklist,
  chosenPaths,
  osascriptChooser,
  runSetup,
  type ChooseResult,
  type ExecFileLike,
  type SetupDeps,
} from '../src/setup-cli.js';
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
// No folder chooser unless a test brings one (the members then type the folders): nothing here
// ever opens a real window.
const NO_CHOOSER = async (): Promise<ChooseResult> => ({ kind: 'unavailable' });
const deps = (t: ReturnType<typeof term>, extra: Partial<SetupDeps> = {}): SetupDeps => ({ env, io: t.io, connect: async () => bob(), chooseFolders: NO_CHOOSER, ...extra });
/** A chooser that gives each answer in turn (and records its prompts). */
function chooser(...answers: ChooseResult[]) {
  const prompts: string[] = [];
  return {
    prompts,
    choose: async (prompt: string): Promise<ChooseResult> => {
      prompts.push(prompt);
      return answers.shift() ?? { kind: 'cancelled' };
    },
  };
}

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
    expect(t.text()).toBe(NOT_SIGNED_IN);
    expect(NOT_SIGNED_IN).toBe('You are not signed in to your team on this Mac yet. Run the setup line again.');
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
    expect(t.out.at(-1)).toBe('The sign-in did not finish (the sign-in timed out).');
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
    expect(t.text()).toContain('Your team has not chosen what to share yet, so there are no folders to pick.');
    expect(t.text()).toContain(relay.url);
    expect(existsSync(memberFoldersPath(env))).toBe(false);
  });

  it("opens the Mac's folder chooser naming the team's orgs, says what it found in each folder, and saves the lists", async () => {
    relay.setBoundaries(ORGS);
    const c = chooser({ kind: 'chosen', paths: [code1, home, code1] }, { kind: 'chosen', paths: [code2] });
    const counted: Array<[string, string[]]> = [];
    const t = term();
    const code = await runSetup(['folders'], deps(t, { chooseFolders: c.choose, clones: async (raw, orgs) => (counted.push([raw, orgs]), 7) }));
    expect(code).toBe(0);
    expect(c.prompts).toEqual([
      'Pick the folders that hold your example-org projects. Hold Cmd to pick more than one.',
      'Pick any folders of your own that answers may use. Hold Cmd to pick more than one, or click Cancel to skip.',
    ]);
    expect(t.out).toContain('Your team shares projects from GitHub: example-org.');
    expect(t.out).toContain('  Found 7 project folders in org.');
    expect(t.out.some((l) => l.startsWith(`  Not used: ${home} (`))).toBe(true);
    expect(t.out).toContain('  org is already in the list.');
    expect(t.out).toContain(`  notes (${code2})`);
    expect(counted).toEqual([[code1, ['example-org']]]);
    expect(t.asked).toEqual([]);
    expect(settings()).toMatchObject({ repo_roots: [code1], extra_folders: [code2] });
    expect(t.out.at(-1)).toBe('Saved: 1 folder for projects and 1 folder of your own.');
  });

  it('Cancel in the chooser keeps the current list (or none)', async () => {
    relay.setBoundaries(ORGS);
    const first = term();
    expect(await runSetup(['folders'], deps(first, { chooseFolders: chooser({ kind: 'cancelled' }, { kind: 'cancelled' }).choose }))).toBe(0);
    expect(first.out).toContain('Nothing picked.');
    expect(first.asked).toEqual([]);
    expect(settings()).toMatchObject({ repo_roots: [], extra_folders: [] });
    expect(first.out.at(-1)).toBe('Saved: no folders for projects and no folders of your own.');
    await runSetup(['folders'], deps(term(), { chooseFolders: chooser({ kind: 'chosen', paths: [code1] }, { kind: 'cancelled' }).choose, clones: async () => 1 }));
    // Asked to replace, then Cancel: the list stays.
    const again = term(['n', '']);
    expect(await runSetup(['folders'], deps(again, { chooseFolders: chooser({ kind: 'cancelled' }).choose, clones: async () => 1 }))).toBe(0);
    expect(again.out).toContain('Nothing picked, so your folders stay as they were.');
    expect(settings()).toMatchObject({ repo_roots: [code1] });
  });

  it('after a No, a Cancel asks whether to stop using the folders: y saves none, anything else keeps them', async () => {
    relay.setBoundaries(ORGS);
    await runSetup(['folders'], deps(term(['~/code/org', '', code2, '']), { clones: async () => 1 }));
    const cancels = () => chooser({ kind: 'cancelled' }, { kind: 'cancelled' }).choose;
    const keep = term(['n', '', 'n', 'no']);
    expect(await runSetup(['folders'], deps(keep, { chooseFolders: cancels(), clones: async () => 1 }))).toBe(0);
    expect(keep.asked).toEqual([
      'Keep these folders? [Y/n] ',
      'Stop using project folders? [y/N] ',
      'Keep these folders of your own? [Y/n] ',
      'Stop using folders of your own? [y/N] ',
    ]);
    expect(keep.out.filter((l) => l === 'Nothing picked, so your folders stay as they were.')).toHaveLength(2);
    expect(settings()).toMatchObject({ repo_roots: ['~/code/org'], extra_folders: [code2] });
    // Only the folders of your own stopped.
    const own = term(['n', 'n', 'n', 'y']);
    expect(await runSetup(['folders'], deps(own, { chooseFolders: cancels(), clones: async () => 1 }))).toBe(0);
    expect(settings()).toMatchObject({ repo_roots: ['~/code/org'], extra_folders: [] });
    expect(own.out.at(-1)).toBe('Saved: 1 folder for projects and no folders of your own.');
    // Then the project folders.
    const projects = term(['n', 'y']);
    expect(await runSetup(['folders'], deps(projects, { chooseFolders: cancels(), clones: async () => 1 }))).toBe(0);
    expect(projects.asked).toEqual(['Keep these folders? [Y/n] ', 'Stop using project folders? [y/N] ']);
    expect(settings()).toMatchObject({ repo_roots: [], extra_folders: [] });
    expect(projects.out.at(-1)).toBe('Saved: no folders for projects and no folders of your own.');
  });

  it('only folders that cannot be used: the list stays as it was', async () => {
    relay.setBoundaries({ ...ORGS, member_folders: false });
    await runSetup(['folders'], deps(term(), { chooseFolders: chooser({ kind: 'chosen', paths: [code1] }).choose, clones: async () => 1 }));
    const t = term(['n']);
    expect(await runSetup(['folders'], deps(t, { chooseFolders: chooser({ kind: 'chosen', paths: ['/'] }).choose, clones: async () => 1 }))).toBe(0);
    expect(t.out).toContain('None of those can be used, so your folders stay as they were.');
    expect(settings()).toMatchObject({ repo_roots: [code1] });
  });

  it('without a chooser (no screen, no osascript) the member types the folders: each checked, counted and saved', async () => {
    relay.setBoundaries(ORGS);
    const t = term(['code', '~/code/org', '~/code/org', '', join(tmp, 'notes-missing'), code2, '']);
    const counted: Array<[string, string[]]> = [];
    const code = await runSetup(['folders'], deps(t, { clones: async (raw, orgs) => (counted.push([raw, orgs]), raw === '~/code/org' ? 3 : 0) }));
    expect(code).toBe(0);
    expect(t.out).toContain(
      'Type the full path of each folder that holds your example-org projects, one per line (~ means your home folder). Press Enter on an empty line to finish.',
    );
    expect(t.out).toContain('  Not used: code (it is not an absolute path or one starting with ~/).');
    expect(t.out).toContain('  Found 3 project folders in org.');
    expect(t.out).toContain('  org is already in the list.');
    expect(t.text()).toContain('Your team also lets you share folders of your own.');
    expect(t.out.some((l) => l.startsWith(`  Not used: ${join(tmp, 'notes-missing')} (`))).toBe(true);
    expect(counted).toEqual([['~/code/org', ['example-org']]]);
    expect(settings()).toMatchObject({ repo_roots: ['~/code/org'], extra_folders: [code2] });
    expect(t.out.at(-1)).toBe('Saved: 1 folder for projects and 1 folder of your own.');
  });

  it('a second run shows the current lists; keep leaves them, no opens the chooser again', async () => {
    relay.setBoundaries(ORGS);
    await runSetup(['folders'], deps(term(['~/code/org', '', code2, '']), { clones: async () => 1 }));
    const keep = term(['', 'y']);
    expect(await runSetup(['folders'], deps(keep, { clones: async () => 1 }))).toBe(0);
    expect(keep.out).toContain('The folders you picked for these projects:');
    expect(keep.out).toContain('  Found 1 project folder in org.');
    expect(keep.asked).toEqual(['Keep these folders? [Y/n] ', 'Keep these folders of your own? [Y/n] ']);
    expect(settings()).toMatchObject({ repo_roots: ['~/code/org'], extra_folders: [code2] });
    const c = chooser({ kind: 'chosen', paths: [code2] }, { kind: 'chosen', paths: [] });
    const replace = term(['n', 'n']);
    expect(await runSetup(['folders'], deps(replace, { chooseFolders: c.choose, clones: async () => 0 }))).toBe(0);
    expect(replace.out).toContain('  Found no project folders in notes.');
    expect(settings()).toMatchObject({ repo_roots: [code2], extra_folders: [] });
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
    const c = chooser({ kind: 'chosen', paths: [code1] });
    const t = term();
    expect(await runSetup(['folders'], deps(t, { chooseFolders: c.choose, clones: async () => 0 }))).toBe(0);
    expect(c.prompts).toHaveLength(1);
    expect(t.text()).not.toContain('folders of your own');
    expect(t.out.at(-1)).toBe('Saved: 1 folder for projects.');
  });
});

describe("the Mac's folder chooser (osascript)", () => {
  it('runs osascript directly with the prompt as an argument, never inside the script', async () => {
    const calls: Array<{ file: string; args: string[]; timeout: number | undefined }> = [];
    const run: ExecFileLike = (file, args, opts, cb) => {
      calls.push({ file, args, timeout: opts.timeout });
      cb(null, '/Users/someone/DEV/\0/Users/someone/My "quoted" folder/\0\n', '');  // e1-guard: allow (synthetic macOS home path in a test)
    };
    const prompt = 'Pick the folders that hold your example-org projects. "end run" -- do shell script "x"';
    expect(await osascriptChooser(run)(prompt)).toEqual({ kind: 'chosen', paths: ['/Users/someone/DEV', '/Users/someone/My "quoted" folder'] });  // e1-guard: allow (synthetic macOS home path in a test)
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('/usr/bin/osascript');
    expect(calls[0]!.args).toEqual([...CHOOSE_FOLDER_SCRIPT.flatMap((l) => ['-e', l]), prompt]);
    expect(CHOOSE_FOLDER_SCRIPT.join('\n')).toContain('choose folder with prompt (item 1 of argv) with multiple selections allowed');
    expect(CHOOSE_FOLDER_SCRIPT.join('\n')).toContain('POSIX path of (f as alias)');
  });

  it('brings its window to the front, and separates folders with NUL (a folder name may hold a new line)', () => {
    expect(CHOOSE_FOLDER_SCRIPT.slice(0, 2)).toEqual(['on run argv', 'activate']);
    expect(CHOOSE_FOLDER_SCRIPT.join('\n')).toContain('(character id 0)');
    expect(CHOOSE_FOLDER_SCRIPT.join('\n')).not.toContain('linefeed');
  });

  it('gives up after 10 minutes: the window closes and the member types the folders', async () => {
    let timeout: number | undefined;
    const killed: ExecFileLike = (_f, _a, opts, cb) => {
      timeout = opts.timeout;
      cb(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }), '', '');
    };
    expect(await osascriptChooser(killed)('p')).toEqual({ kind: 'unavailable' });
    expect(timeout).toBe(10 * 60 * 1000);
  });

  it('Cancel (-128) is a Cancel; any other failure means the member types the folders', async () => {
    const fail = (stderr: string): ExecFileLike => (_f, _a, _o, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), '', stderr);
    expect(await osascriptChooser(fail('execution error: User canceled. (-128)'))('p')).toEqual({ kind: 'cancelled' });
    expect(await osascriptChooser(fail('execution error: No user interaction allowed. (-1713)'))('p')).toEqual({ kind: 'unavailable' });
    const throws: ExecFileLike = () => {
      throw new Error('ENOENT');
    };
    expect(await osascriptChooser(throws)('p')).toEqual({ kind: 'unavailable' });
  });

  it('one path per NUL, trailing slashes dropped, the final new line and empty pieces ignored', () => {
    expect(chosenPaths('/a/b/\0\0/c\0\n')).toEqual(['/a/b', '/c']);
    expect(chosenPaths('/a/two\nlines/\0/\0\n')).toEqual(['/a/two\nlines', '/']);
    expect(chosenPaths('')).toEqual([]);
    expect(chosenPaths('\n')).toEqual([]);
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
    expect(t.text()).toBe('Your Mac now answers your team in the background whenever it is on. Claude Code does not need to be open.');
    const u = term();
    expect(await runSetup(['daemon', 'uninstall'], deps(u, { platform: 'darwin', uid: 501, exec }))).toBe(0);
    expect(u.text()).toBe('Your Mac no longer answers your team in the background.');
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

describe('status: two plain steps, then Ask the team (M11-SPEC "Simpler joining")', () => {
  const full = {
    claude: { found: true, signed_in: true },
    folders: { repo_roots: 1, clones: 2, extra_folders: 0 },
    drive: { connected: true },
    self_test: { ok: true, at: '2026-11-10T10:00:00.000Z', reason: null },
  };
  const base = { answering: true, acceptedVersion: 1, boundariesVersion: 1, orgs: 1, drives: 1, console: 'https://relay.example.com' };
  const open = (steps: ReturnType<typeof checklist>) => steps[0]!.checks.filter((c) => !c.done).map((c) => c.id);
  const seen = (extra: Record<string, unknown> = {}) => ({ daemon: { version: '1', started_at: '2026-11-10T10:00:00.000Z' }, ...full, seen_at: new Date().toISOString(), ...extra });

  it("Set up your Mac and Accept what the team shares, from the relay's view of this member", () => {
    const steps = checklist({ ...base, status: full });
    expect(steps.map((s) => [s.id, s.title, s.done])).toEqual([
      ['mac', 'Set up your Mac', true],
      ['accept', 'Accept what the team shares', true],
    ]);
    // Nothing reported yet: one thing to do, run the setup line; nothing else is listed.
    const none = checklist({ ...base, status: null, answering: false, acceptedVersion: 1, boundariesVersion: 2 });
    expect(none.map((s) => s.done)).toEqual([false, false]);
    expect(none[0]!.checks).toEqual([{ id: 'setup', done: false, todo: 'Paste the setup line into Terminal on this Mac.' }]);
    expect(none[1]!.todo).toBe('Open https://relay.example.com and click Accept.');
    // Every old check still counts for the Mac step.
    expect(open(checklist({ ...base, status: { ...full, claude: { found: true, signed_in: false } } }))).toEqual(['claude']);
    expect(open(checklist({ ...base, status: full, answering: false }))).toEqual(['answering']);
    expect(open(checklist({ ...base, status: { ...full, folders: { repo_roots: 0 } } }))).toEqual(['folders']);
    expect(open(checklist({ ...base, status: { ...full, drive: { connected: false } } }))).toEqual(['drive']);
    expect(open(checklist({ ...base, status: { ...full, self_test: { ok: false, reason: 'x' } } }))).toEqual(['self_test']);
    // No orgs and no drives: those need nothing.
    const bare = checklist({ ...base, status: { ...full, folders: { repo_roots: 0 }, drive: { connected: false } }, orgs: 0, drives: 0 });
    expect(bare[0]!.done).toBe(true);
    // Boundaries that could not be read: folders and Drive are not known, so never done.
    const unknown = checklist({ ...base, status: full, orgs: null, drives: null });
    expect(unknown[0]!.done).toBe(false);
    expect(open(unknown)).toEqual(['folders', 'drive']);
    // Boundaries never set: nothing to accept yet.
    expect(checklist({ ...base, status: full, boundariesVersion: 0, acceptedVersion: 0 })[1]).toMatchObject({ done: false, todo: 'Your team has not chosen what to share yet. A team owner does that on https://relay.example.com.' });
  });

  it('each open check is one plain sentence of what to do', () => {
    const todo = (st: Parameters<typeof checklist>[0]) => checklist(st)[0]!.checks.filter((c) => !c.done).map((c) => c.todo);
    expect(todo({ ...base, status: full, answering: false })).toEqual(["Your Mac isn't answering right now. Make sure it's switched on; if this stays, run the setup line again."]);
    expect(todo({ ...base, status: { ...full, claude: { found: false, signed_in: false } } })).toEqual([
      'Claude Code is not on this Mac. Run the setup line again and say yes when it offers to install it.',
    ]);
    // Not run yet is not a failure.
    expect(todo({ ...base, status: { ...full, self_test: { ok: false, reason: SELF_TEST_PENDING } } })).toEqual([SELF_TEST_RUNNING]);
    expect(SELF_TEST_RUNNING).toBe('Your Mac is checking that everything works. This takes about a minute.');
    expect(todo({ ...base, status: { ...full, self_test: { ok: false, reason: 'Claude Code is not signed in' } } })).toEqual([
      "Your Mac's last check did not pass. Run the setup line again. If it still does not pass, show this to a team owner: Claude Code is not signed in.",
    ]);
    for (const t of todo({ ...base, status: { claude: { found: true, signed_in: false }, folders: { repo_roots: 0 }, drive: { connected: false }, self_test: { ok: false, reason: null } }, answering: false })) {
      expect(t).not.toMatch(/daemon|LaunchAgent|plugin|channel|\bCLI\b|\bnode\b|boundaries|repo root|self-test/i);
    }
  });

  it('prints the two steps, only the open checks of the Mac step, then where to ask the team (always)', async () => {
    relay.setBoundaries({ topic: 'T', github_orgs: ['example-org'], drives: [], member_folders: false });
    relay.memberStatus.set('bob', seen({ folders: { repo_roots: 0, clones: 0, extra_folders: 0 } }));
    const t = term();
    expect(await runSetup(['status'], deps(t))).toBe(0);
    expect(t.out).toEqual([
      'Your setup (bob, team demo): 0 of 2 done.',
      '  [ ] Set up your Mac',
      '      - Your project folders are not picked yet. Run the setup line again and pick them.',
      `  [ ] Accept what the team shares - Open ${relay.url} and click Accept.`,
      `Ask the team: ${relay.url}/ask`,
    ]);
    relay.acceptances.set('bob', 1);
    relay.memberStatus.set('bob', seen());
    const t2 = term();
    await runSetup(['status'], deps(t2));
    expect(t2.out).toEqual([
      'Your setup (bob, team demo): 2 of 2 done.',
      '  [x] Set up your Mac',
      '  [x] Accept what the team shares',
      `Ask the team: ${relay.url}/ask`,
    ]);
    // Whether the member has asked is not looked up (it is not a step).
    expect(relay.requests.some((r) => r.path.includes('/me/requests'))).toBe(false);
  });

  it('while the self-test has not run yet it waits for it (every 5 s, up to 90 s), then prints the steps', async () => {
    relay.setBoundaries({ topic: 'T', github_orgs: [], drives: [], member_folders: false });
    relay.acceptances.set('bob', 1);
    const pendingStatus = () => seen({ self_test: { ok: false, at: '2026-11-10T10:00:00.000Z', reason: SELF_TEST_PENDING } });
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
    expect(t.out[0]).toBe(SELF_TEST_RUNNING);
    expect(t.out).toContain('Your setup (bob, team demo): 2 of 2 done.');
    expect(t.out).toContain('  [x] Set up your Mac');

    // Still not run after 90 s: it prints the steps as they are, saying it is running, not failed.
    relay.memberStatus.set('bob', pendingStatus());
    const waits2: number[] = [];
    const t2 = term();
    expect(await runSetup(['status'], deps(t2, { sleep: async (ms) => void waits2.push(ms) }))).toBe(0);
    expect(waits2.reduce((a, b) => a + b, 0)).toBe(90_000);
    expect(t2.out).toContain(`      - ${SELF_TEST_RUNNING}`);
    expect(t2.text()).not.toContain('did not pass');
  });

  it('--after-setup also waits for the Mac to check in (said once), then for its check, within the same 90 s', async () => {
    relay.setBoundaries({ topic: 'T', github_orgs: [], drives: [], member_folders: false });
    relay.acceptances.set('bob', 1);
    const waits: number[] = [];
    // Checks in during the second wait, still checking; the check ends during the fourth.
    const sleep = async (ms: number) => {
      waits.push(ms);
      if (waits.length === 2) relay.memberStatus.set('bob', seen({ self_test: { ok: false, at: null, reason: SELF_TEST_PENDING } }));
      if (waits.length === 4) relay.memberStatus.set('bob', seen());
    };
    const t = term();
    expect(await runSetup(['status', '--after-setup'], deps(t, { sleep }))).toBe(0);
    expect(waits).toEqual([5000, 5000, 5000, 5000]);
    expect(t.out.slice(0, 2)).toEqual(['Waiting for your Mac to check in…', SELF_TEST_RUNNING]);
    expect(t.out).toContain('Your setup (bob, team demo): 2 of 2 done.');

    // Never checks in: 90 s in all, said once, then the steps as they are.
    relay.memberStatus.delete('bob');
    const waits2: number[] = [];
    const t2 = term();
    expect(await runSetup(['status', '--after-setup'], deps(t2, { sleep: async (ms) => void waits2.push(ms) }))).toBe(0);
    expect(waits2.reduce((a, b) => a + b, 0)).toBe(90_000);
    expect(t2.out.filter((l) => l === 'Waiting for your Mac to check in…')).toHaveLength(1);
    expect(t2.out).toContain('      - Paste the setup line into Terminal on this Mac.');

    // Plain status does not wait for a check-in.
    const waits3: number[] = [];
    const t3 = term();
    expect(await runSetup(['status'], deps(t3, { sleep: async (ms) => void waits3.push(ms) }))).toBe(0);
    expect(waits3).toEqual([]);
    expect(t3.out).not.toContain('Waiting for your Mac to check in…');
  });

  it('--after-setup ends with the closing line: "and click Accept" only when something is not accepted yet', async () => {
    relay.memberStatus.set('bob', seen());
    const closing = async () => {
      const t = term();
      expect(await runSetup(['status', '--after-setup'], deps(t))).toBe(0);
      expect(t.out.at(-3)).toBe(`Ask the team: ${relay.url}/ask`);
      expect(t.out.at(-2)).toBe('');
      return t.out.at(-1);
    };
    // Nothing to accept yet (the team has not chosen what to share).
    expect(await closing()).toBe('Done. Go back to the team page in your browser.');
    relay.setBoundaries({ topic: 'T', github_orgs: [], drives: [], member_folders: false });
    expect(await closing()).toBe('Done. Go back to the team page in your browser and click Accept.');
    relay.acceptances.set('bob', 1);
    expect(await closing()).toBe('Done. Go back to the team page in your browser.');
    // A newer version to accept.
    relay.setBoundaries({ topic: 'T2', github_orgs: [], drives: [], member_folders: false });
    expect(await closing()).toBe('Done. Go back to the team page in your browser and click Accept.');
  });

  it('when the boundaries cannot be read, folders and Drive are not known, never done', async () => {
    relay.memberStatus.set('bob', seen({ folders: { repo_roots: 0, clones: 0, extra_folders: 0 }, drive: { connected: false } }));
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
    expect(t.out[0]).toBe('Your setup (bob, team demo): 1 of 2 done.');
    expect(t.out.filter((l) => l.startsWith('      - Could not check this just now'))).toHaveLength(2);
  });

  it('status takes no other argument', async () => {
    const t = term();
    expect(await runSetup(['status', '--later'], deps(t))).toBe(2);
    expect(t.text()).toContain('status [--after-setup]');
  });
});
