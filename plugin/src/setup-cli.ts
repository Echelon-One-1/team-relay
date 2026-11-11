// `node dist/setup-cli.js <command>`: the steps of the one-command setup (M11-SPEC §5) that need
// the plugin. The setup script runs them in order; a member can run any of them again.
//
//   login [--relay <url>]               the browser sign-in of M5 (skipped when signed in to that relay)
//   folders                             choose the folders that hold your clones of the team's whole
//                                       orgs and repositories (asks on the terminal)
//   drive                               connect Google Drive when the team shares Drive folders or
//                                       drives (M10 §2a)
//   daemon install --claude <path> --plugin team-relay@<marketplace>
//                                       write and load the background answerer's LaunchAgent, for
//                                       the plugin installed under exactly that key
//   daemon uninstall                    stop and remove it
//   status [--after-setup]              your setup checklist, as the relay sees it (M11 §6), and what
//                                       your Mac cannot find of what the team shares (PICKERS-SPEC §7.4)
//
// Nothing here prints a credential or token. Exit 0: done (or nothing to do); 1: it did not
// work (the line says why); 2: usage.
//
// What it prints is read by members who have never used Terminal (M11-SPEC "Simpler joining"):
// plain, short sentences that say what to do, never the names of tools or files.

import { execFile } from 'node:child_process';
import { createReadStream, existsSync, openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { configDir } from './answering-lock.js';
import { boundaryItems, itemKey, sinceByKey } from './boundaries-rule.js';
import { SELF_TEST_PENDING, type Boundaries, type MemberSources, type MemberStatusEntry, type TeamBoundaries } from './boundaries-types.js';
import { homeDir, validBoundaries, type GithubSources } from './boundary-set.js';
import { clonesUnder } from './clones.js';
import { consoleUrl } from './console-url.js';
import { CredentialFileError, credentialsPath, normaliseRelayUrl, readCredential } from './credentials.js';
import { AgentError, installAgent, uninstallAgent, type Exec } from './daemon-launch.js';
import { runDriveCli, type DriveCliOutcome } from './drive-cli.js';
import { MAC_ONLY } from './drive-login.js';
import { defaultKeychain, type Keychain } from './google-drive.js';
import { LoginError, connectedAs, identityChange, startLogin, type LoginFlow, type LoginOptions } from './login.js';
import {
  MAX_FOLDERS,
  MemberFoldersError,
  expandPath,
  memberFolderProblem,
  memberFoldersPath,
  readMemberSettings,
  teamSettings,
  withTeam,
  writeMemberSettings,
} from './member-folders.js';
import { configValue, parseRelayUrl, type RelayClient } from './relay-client.js';
import { defaultRelayUrl } from './relay-default.js';
import { connectOnce } from './relay-connect.js';
import { describeError } from './tool-util.js';

export const HELP = [
  'usage: node setup-cli.js <command>',
  '',
  '  login [--relay <url>]            sign in to the team relay in your browser',
  '  folders                          choose the folders that hold your clones of the team\'s repositories',
  '  drive                            connect Google Drive, when your team has shared drives',
  '  daemon install --claude <path> --plugin team-relay@<marketplace>',
  '                                   start answering teammates in the background (macOS)',
  '  daemon uninstall                 stop answering in the background',
  '  status [--after-setup]          show your setup checklist (--after-setup: as the setup line\'s last step)',
].join('\n');

export type SetupIO = {
  print: (line: string) => void;
  /** One line typed by the member (without its newline); null when input has ended. */
  ask: (prompt: string) => Promise<string | null>;
};

export type SetupDeps = {
  env: NodeJS.ProcessEnv;
  io: SetupIO;
  platform?: NodeJS.Platform;
  uid?: number;
  /** The absolute path of node, for the LaunchAgent (default: this process's). */
  node?: string;
  /** Runs launchctl (tests: a fake). */
  exec?: Exec;
  /** Waits between launchctl calls (tests: a fake). */
  sleep?: (ms: number) => Promise<void>;
  startLogin?: (o: LoginOptions) => Promise<LoginFlow>;
  /** The relay client for the signed-in member (default: connectOnce). */
  connect?: () => Promise<{ client: RelayClient; member: string; team: string } | { error: string }>;
  keychain?: Keychain | null;
  drive?: (argv: string[], client: RelayClient, keychain: Keychain) => Promise<DriveCliOutcome>;
  clones?: (raw: string, sources: GithubSources) => Promise<number>;
  /** The Mac's folder chooser (default: osascript's `choose folder`; tests: a fake). */
  chooseFolders?: FolderChooser;
};

export const NOT_SIGNED_IN = 'You are not signed in to your team on this Mac yet. Run the setup line again.';
const UNREACHABLE_BOUNDARIES = 'Could not reach your team just now. Run the setup line again in a minute.';

// macOS privacy protection: a LaunchAgent's node may be refused (or macOS may ask the member)
// for folders under these, and for the Drive mount (~/Library/CloudStorage).
const PROTECTED_DIRS = ['Documents', 'Desktop', 'Downloads', join('Library', 'Mobile Documents')];
export const PRIVACY_FOLDERS_NOTE =
  'The first time your Mac answers from a folder in Documents, Desktop, Downloads or iCloud Drive, macOS may ask whether "node" may open it: click Allow.';
export const PRIVACY_DRIVE_NOTE = 'The first time your Mac answers from Google Drive, macOS may ask whether "node" may open it: click Allow.';

/** Whether `raw` (as the member wrote it) resolves to a folder macOS protects. */
function privacyProtected(raw: string, env: NodeJS.ProcessEnv): boolean {
  const path = memberFolderProblem(raw, env).path ?? expandPath(raw, env);
  if (!path) return false;
  const home = homeDir(env);
  const p = path.toLowerCase();
  return PROTECTED_DIRS.some((d) => {
    const dir = join(home, d).toLowerCase();
    return p === dir || p.startsWith(`${dir}/`);
  });
}

async function defaultConnect(env: NodeJS.ProcessEnv): Promise<{ client: RelayClient; member: string; team: string } | { error: string }> {
  const a = await connectOnce(env);
  if (a.kind === 'connected') return { client: a.client, member: a.me.member, team: a.me.team };
  if (a.kind === 'not_signed_in') return { error: NOT_SIGNED_IN };
  if (a.kind === 'refused') return { error: 'Your sign-in to the team has ended (or you are no longer on the team). Run the setup line again to sign in.' };
  return { error: `Could not reach your team just now (${a.problem}). Check your internet connection, then run the setup line again.` };
}

async function teamBoundaries(client: RelayClient): Promise<TeamBoundaries | null> {
  try {
    const tb = await client.boundaries({ attempts: 2, timeoutMs: 15_000 });
    return validBoundaries(tb) && tb.team === client.team ? tb : null;
  } catch {
    return null;
  }
}

const yes = (answer: string | null, byDefault: boolean) => {
  const a = (answer ?? '').trim().toLowerCase();
  if (a === '') return byDefault;
  return a === 'y' || a === 'yes';
};

// -- login -----------------------------------------------------------------------------------------

async function login(argv: string[], d: SetupDeps): Promise<number> {
  const { io, env } = d;
  let relayArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay' && argv[i + 1] !== undefined) relayArg = argv[++i];
    else {
      io.print(HELP);
      return 2;
    }
  }
  const path = credentialsPath(env);
  let stored;
  try {
    stored = readCredential(path);
  } catch (err) {
    io.print(`The stored sign-in on this computer cannot be used (${err instanceof CredentialFileError ? err.message : 'it cannot be read'}).`);
    return 1;
  }
  const relayUrl = relayArg ?? stored?.relay_url ?? configValue(env.RELAY_URL) ?? defaultRelayUrl() ?? undefined;
  if (!relayUrl) {
    io.print('No relay is configured: run `node setup-cli.js login --relay <url>`.');
    return 1;
  }
  let relayNorm: string;
  try {
    parseRelayUrl(relayUrl);
    relayNorm = normaliseRelayUrl(relayUrl);
  } catch (err) {
    io.print(`That relay URL cannot be used: ${describeError(err)}.`);
    return 1;
  }
  if (stored && stored.relay_url === relayNorm) {
    const a = await (d.connect ?? (() => defaultConnect(env)))();
    if ('client' in a) {
      io.print(`Already signed in. ${connectedAs({ member: a.member, team: a.team, email: stored.email })}.`);
      return 0;
    }
    // A refused or expired sign-in is replaced below; an unreachable relay is said as it is.
    if (!a.error.startsWith('The relay refused')) {
      io.print(a.error);
      return 1;
    }
  }
  let flow: LoginFlow;
  try {
    flow = await (d.startLogin ?? startLogin)({ relayUrl, credentialsFile: path, log: (line) => io.print(`  ${line}`) });
  } catch (err) {
    io.print(err instanceof LoginError ? `Not signed in: ${err.message}` : `Could not start the sign-in: ${describeError(err)}`);
    return 1;
  }
  io.print('Sign in with your work Google account in the browser window that opened, and choose your team.');
  io.print('If no window opened, open this link yourself (it is for you only; do not share it):');
  io.print(flow.url);
  try {
    const r = await flow.done;
    const change = identityChange(r.stored, r.replaced);
    io.print(`${connectedAs(r.stored)}.${change ? ` ${change}` : ''}`);
    return 0;
  } catch (err) {
    io.print(`The sign-in did not finish (${describeError(err)}).`);
    return 1;
  }
}

// -- folders ---------------------------------------------------------------------------------------

/** What the Mac's folder chooser gave: folders, a Cancel, or no chooser here (then the member types). */
export type ChooseResult = { kind: 'chosen'; paths: string[] } | { kind: 'cancelled' } | { kind: 'unavailable' };
export type FolderChooser = (prompt: string) => Promise<ChooseResult>;

/**
 * The AppleScript of the chooser. It brings its window to the front first (Terminal may be behind
 * the browser). The prompt is the run handler's argument, never part of the script text; each
 * chosen folder is turned into a POSIX path here, each followed by a NUL (a folder name may hold a
 * new line, never a NUL).
 */
export const CHOOSE_FOLDER_SCRIPT = [
  'on run argv',
  'activate',
  'set chosen to choose folder with prompt (item 1 of argv) with multiple selections allowed',
  'set out to ""',
  'repeat with f in chosen',
  'set out to out & (POSIX path of (f as alias)) & (character id 0)',
  'end repeat',
  'return out',
  'end run',
];
const OSASCRIPT = '/usr/bin/osascript';
/** A chooser left open this long closes, and the member types the folders instead. */
export const CHOOSER_TIMEOUT_MS = 10 * 60 * 1000;

export type ExecFileLike = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
  cb: (err: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => void;

/**
 * The folders in osascript's output: NUL-separated, with the one new line osascript adds at the
 * end dropped; a trailing slash dropped (but never from "/").
 */
export function chosenPaths(stdout: string): string[] {
  return stdout
    .replace(/\n$/, '')
    .split('\0')
    .filter((p) => p !== '')
    .map((p) => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p));
}

const runExecFile: ExecFileLike = (f, a, o, cb) => void execFile(f, a, o, (e, out, err) => cb(e, String(out), String(err)));

/**
 * The Mac's own folder chooser: osascript, run directly (no shell), with the prompt as an
 * argument. Cancel (AppleScript error -128) is a Cancel; any other failure (no osascript, no
 * screen to show it on, left open past CHOOSER_TIMEOUT_MS) means the member types the folders.
 */
export function osascriptChooser(run: ExecFileLike = runExecFile): FolderChooser {
  return (prompt) =>
    new Promise((resolve) => {
      const args = CHOOSE_FOLDER_SCRIPT.flatMap((line) => ['-e', line]);
      args.push(prompt);
      try {
        run(OSASCRIPT, args, { timeout: CHOOSER_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (!err) resolve({ kind: 'chosen', paths: chosenPaths(stdout) });
          else if (/\(-128\)/.test(stderr)) resolve({ kind: 'cancelled' });
          else resolve({ kind: 'unavailable' });
        });
      } catch {
        resolve({ kind: 'unavailable' });
      }
    });
}

function defaultChooser(platform: NodeJS.Platform): FolderChooser {
  if (platform !== 'darwin' || !existsSync(OSASCRIPT)) return async () => ({ kind: 'unavailable' });
  return osascriptChooser();
}

type ListSpec = {
  /** "Your folders for projects now:" */
  nowTitle: string;
  keepPrompt: string;
  /** Asked when the member said No to keepPrompt and then cancelled the chooser. */
  stopPrompt: string;
  /** Said before the chooser opens. */
  pickIntro: string;
  /** The chooser's own prompt. */
  prompt: string;
  /** Said when there is no chooser and the member types the folders. */
  typeIntro: string;
  current: string[];
  count: ((raw: string) => Promise<number>) | null;
};

const plural = (n: number, one: string, many: string) => `${n === 0 ? 'no' : n} ${n === 1 ? one : many}`;

async function chooseList(d: SetupDeps, spec: ListSpec): Promise<string[]> {
  const { io, env } = d;
  const name = (raw: string) => {
    const resolved = expandPath(raw, env) ?? raw;
    return basename(resolved) || resolved;
  };
  const describe = async (raw: string) => {
    const { reason } = memberFolderProblem(raw, env);
    if (reason) return `Not used: ${raw} (${reason}).`;
    if (!spec.count) return `${name(raw)} (${expandPath(raw, env) ?? raw})`;
    const n = await spec.count(raw);
    return `Found ${plural(n, 'project folder', 'project folders')} in ${name(raw)}.`;
  };
  /** Adds `raw` to `out` when it can be used; says what happened. */
  const add = async (raw: string, out: string[]) => {
    const { reason } = memberFolderProblem(raw, env);
    if (reason) {
      io.print(`  Not used: ${raw} (${reason}).`);
      return;
    }
    const target = expandPath(raw, env);
    if (out.some((e) => e === raw || expandPath(e, env) === target)) {
      io.print(`  ${name(raw)} is already in the list.`);
      return;
    }
    if (out.length >= MAX_FOLDERS) {
      io.print(`  At most ${MAX_FOLDERS} folders; ${name(raw)} is not added.`);
      return;
    }
    out.push(raw);
    io.print(`  ${await describe(raw)}`);
  };

  let saidNo = false;
  if (spec.current.length > 0) {
    io.print(spec.nowTitle);
    for (const raw of spec.current) io.print(`  ${await describe(raw)}`);
    if (yes(await io.ask(`${spec.keepPrompt} [Y/n] `), true)) return spec.current;
    saidNo = true;
  }

  const chooser = d.chooseFolders ?? defaultChooser(d.platform ?? process.platform);
  io.print(spec.pickIntro);
  const r = await chooser(spec.prompt);
  if (r.kind === 'cancelled') {
    // After a No, a Cancel may mean "none at all": asked, never assumed.
    if (saidNo && yes(await io.ask(`${spec.stopPrompt} [y/N] `), false)) return [];
    io.print(spec.current.length > 0 ? 'Nothing picked, so your folders stay as they were.' : 'Nothing picked.');
    return spec.current;
  }
  if (r.kind === 'chosen') {
    const out: string[] = [];
    for (const raw of r.paths) await add(raw, out);
    if (out.length === 0 && r.paths.length > 0) {
      io.print(spec.current.length > 0 ? 'None of those can be used, so your folders stay as they were.' : 'None of those can be used.');
      return spec.current;
    }
    return out;
  }

  // No chooser here (no screen, or no osascript): the member types the folders.
  io.print(spec.typeIntro);
  const out: string[] = [];
  for (;;) {
    const line = await io.ask('> ');
    if (line === null || line.trim() === '') break;
    await add(line.trim(), out);
  }
  return out;
}

async function folders(d: SetupDeps): Promise<number> {
  const { io, env } = d;
  const c = await (d.connect ?? (() => defaultConnect(env)))();
  if ('error' in c) {
    io.print(c.error);
    return 1;
  }
  const tb = await teamBoundaries(c.client);
  const url = consoleUrl(c.client.url);
  if (!tb) {
    io.print(UNREACHABLE_BOUNDARIES);
    return 1;
  }
  if (!tb.boundaries) {
    io.print(`Your team has not chosen what to share yet, so there are no folders to pick. Run the setup line again once a team owner has done that (on ${url}).`);
    return 0;
  }
  const file = memberFoldersPath(env);
  let all;
  try {
    all = readMemberSettings(file, env);
  } catch (err) {
    io.print(`Your saved folders cannot be read (${describeError(err)}). Ask a team owner for help.`);
    return 1;
  }
  const current = teamSettings(all, c.team);
  // PICKERS-SPEC §6.1: whole orgs and single repositories, as the team listed them.
  const github: GithubSources = { github_orgs: tb.boundaries.github_orgs, github_repos: tb.boundaries.github_repos };
  const count = d.clones ?? ((raw: string, g: GithubSources) => clonesUnder(raw, g, env));
  let roots = current.repo_roots;
  if (github.github_orgs.length + github.github_repos.length > 0) {
    const names = listWords([...github.github_orgs, ...github.github_repos.map((x) => `${x.org}/${x.repo}`)], 12);
    io.print(`Your team shares projects from GitHub: ${names}.`);
    roots = await chooseList(d, {
      nowTitle: 'The folders you picked for these projects:',
      keepPrompt: 'Keep these folders?',
      stopPrompt: 'Stop using project folders?',
      pickIntro: `A window opens: pick the folders that hold your ${names} projects (hold Cmd to pick more than one), then click Choose.`,
      prompt: `Pick the folders that hold your ${names} projects. Hold Cmd to pick more than one.`,
      typeIntro: `Type the full path of each folder that holds your ${names} projects, one per line (~ means your home folder). Press Enter on an empty line to finish.`,
      current: current.repo_roots,
      count: (raw) => count(raw, github),
    });
  } else {
    io.print('Your team shares no GitHub projects, so there are no project folders to pick.');
  }
  let extra = current.extra_folders;
  if (tb.boundaries.member_folders) {
    io.print('Your team also lets you share folders of your own.');
    extra = await chooseList(d, {
      nowTitle: 'The folders of your own you picked:',
      keepPrompt: 'Keep these folders of your own?',
      stopPrompt: 'Stop using folders of your own?',
      pickIntro: 'A window opens: pick any folders of your own that answers may use, or click Cancel to skip.',
      prompt: 'Pick any folders of your own that answers may use. Hold Cmd to pick more than one, or click Cancel to skip.',
      typeIntro: 'Type the full path of any folder of your own that answers may use, one per line. Press Enter on an empty line to finish.',
      current: current.extra_folders,
      count: null,
    });
  } else if (current.extra_folders.length > 0) {
    io.print('Your team no longer allows folders of your own, so the ones you picked earlier are not used.');
  }
  try {
    // Read again: the file may have changed while the questions were open.
    const fresh = readMemberSettings(file, env);
    const mine = teamSettings(fresh, c.team);
    writeMemberSettings(file, withTeam(fresh, c.team, { repo_roots: roots, extra_folders: extra, accepted: mine.accepted }), env);
  } catch (err) {
    io.print(`Nothing was saved (${err instanceof MemberFoldersError ? err.message : describeError(err)}).`);
    return 1;
  }
  const own = tb.boundaries.member_folders ? ` and ${plural(extra.length, 'folder', 'folders')} of your own` : '';
  io.print(`Saved: ${plural(roots.length, 'folder', 'folders')} for projects${own}.`);
  const used = tb.boundaries.member_folders ? [...roots, ...extra] : roots;
  if (used.some((raw) => privacyProtected(raw, env))) io.print(PRIVACY_FOLDERS_NOTE);
  return 0;
}

/** "a", "a and b", "a, b and c"; past `max` items, "a, b and 3 more". */
function listWords(items: string[], max = Number.POSITIVE_INFINITY): string {
  if (items.length > max) return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// -- drive -----------------------------------------------------------------------------------------

async function drive(d: SetupDeps): Promise<number> {
  const { io, env } = d;
  const c = await (d.connect ?? (() => defaultConnect(env)))();
  if ('error' in c) {
    io.print(c.error);
    return 1;
  }
  const tb = await teamBoundaries(c.client);
  if (!tb) {
    io.print(UNREACHABLE_BOUNDARIES);
    return 1;
  }
  if (!tb.boundaries || tb.boundaries.drives.length + tb.boundaries.drive_folders.length === 0) {
    io.print('Your team has no shared Google Drives, so there is nothing to connect.');
    return 0;
  }
  const platform = d.platform ?? process.platform;
  const keychain = d.keychain === undefined ? defaultKeychain(platform) : d.keychain;
  if (platform !== 'darwin' || !keychain) {
    io.print(MAC_ONLY);
    return 1;
  }
  let account: string | null;
  try {
    account = await keychain.account();
  } catch (err) {
    io.print(`Google Drive: ${describeError(err)}`);
    return 1;
  }
  if (account) {
    io.print(`Google Drive is already connected as ${account}.`);
    io.print(PRIVACY_DRIVE_NOTE);
    return 0;
  }
  io.print('Connecting Google Drive (read only): sign in with your work Google account in the browser window that opens.');
  const run =
    d.drive ??
    ((argv: string[], client: RelayClient, kc: Keychain) =>
      runDriveCli(argv, { platform, keychain: kc, relay: () => ({ driveClient: () => client.driveClient(), boundaries: () => client.boundaries() }), log: (l) => io.print(`  ${l}`) }));
  const r = await run(['connect'], c.client, keychain);
  io.print(r.line);
  if (r.exitCode === 0) io.print(PRIVACY_DRIVE_NOTE);
  return r.exitCode;
}

// -- daemon ----------------------------------------------------------------------------------------

async function daemon(argv: string[], d: SetupDeps): Promise<number> {
  const { io, env } = d;
  const platform = d.platform ?? process.platform;
  const sub = argv[0];
  if (sub !== 'install' && sub !== 'uninstall') {
    io.print(HELP);
    return 2;
  }
  let claude: string | undefined;
  let plugin: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (sub === 'install' && argv[i] === '--claude' && argv[i + 1] !== undefined && claude === undefined) claude = argv[++i];
    else if (sub === 'install' && argv[i] === '--plugin' && argv[i + 1] !== undefined && plugin === undefined) plugin = argv[++i];
    else {
      io.print(HELP);
      return 2;
    }
  }
  if (platform !== 'darwin') {
    io.print('The background answerer runs on macOS only.');
    return 1;
  }
  const uid = d.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  const home = homeDir(env);
  const cfg = configDir(env);
  try {
    if (sub === 'uninstall') {
      const found = await uninstallAgent({ home, configDir: cfg, uid, ...(d.exec ? { exec: d.exec } : {}) });
      io.print(found ? 'Your Mac no longer answers your team in the background.' : 'Your Mac was not answering your team in the background; nothing to do.');
      return 0;
    }
    if (!claude) {
      io.print('daemon install needs --claude <the absolute path of claude>.');
      return 2;
    }
    if (!plugin) {
      io.print('daemon install needs --plugin team-relay@<marketplace name>, the plugin as the setup command installed it.');
      return 2;
    }
    const xdg = env.XDG_CONFIG_HOME?.trim();
    await installAgent({
      home,
      configDir: cfg,
      node: d.node ?? process.execPath,
      claude,
      uid,
      pluginKey: plugin,
      ...(d.exec ? { exec: d.exec } : {}),
      ...(d.sleep ? { sleep: d.sleep } : {}),
      ...(xdg && xdg.startsWith('/') ? { xdgConfigHome: xdg } : {}),
    });
    io.print('Your Mac now answers your team in the background whenever it is on. Claude Code does not need to be open.');
    return 0;
  } catch (err) {
    io.print(err instanceof AgentError ? err.message : `That did not work: ${describeError(err)}`);
    return 1;
  }
}

// -- status ----------------------------------------------------------------------------------------

/** One thing the Mac must have for "Set up your Mac": done, or one plain sentence of what to do. */
export type Check = { id: 'setup' | 'claude' | 'answering' | 'folders' | 'drive' | 'self_test'; done: boolean; todo: string };
/** M11-SPEC "Simpler joining": the two steps; `checks` are the Mac's, shown only while one is not done. */
export type Step = { id: 'mac' | 'accept'; done: boolean; title: string; todo: string; checks: Check[] };

export const SELF_TEST_RUNNING = 'Your Mac is checking that everything works. This takes about a minute.';
export const WAITING_FOR_CHECK_IN = 'Waiting for your Mac to check in…';
/**
 * While the self-test has not run yet (or, with --after-setup, the Mac has not reported in yet),
 * status looks again this often, for at most this long in all.
 */
const PENDING_POLL_MS = 5000;
const PENDING_WAIT_MS = 90_000;

const NOT_KNOWN = "Could not check this just now, because your team's settings did not load. Run the setup line again in a minute.";

/**
 * The two steps, from the relay's view of this member (the console's Setup page shows the
 * same; "Ask the team" is not a step, it is always there below them). "Set up your Mac" is done when every check is: the Mac has reported in, Claude Code is
 * there and signed in, the Mac answers now, folders and Google Drive (when the team's
 * boundaries ask for them) and the self-test. `orgs` and `drives`: how many the team's
 * boundaries hold (0 also when none are set), null when they could not be read, which never
 * counts as done.
 */
export function checklist(p: {
  status: { claude?: { found?: unknown; signed_in?: unknown }; folders?: { repo_roots?: unknown }; drive?: { connected?: unknown }; self_test?: { ok?: unknown; reason?: unknown } } | null;
  answering: boolean;
  acceptedVersion: number;
  boundariesVersion: number;
  orgs: number | null;
  drives: number | null;
  console: string;
}): Step[] {
  const s = p.status;
  const reason = typeof s?.self_test?.reason === 'string' && s.self_test.reason ? s.self_test.reason : null;
  const pending = s?.self_test?.ok !== true && reason === SELF_TEST_PENDING;
  const checks: Check[] =
    s === null
      ? [{ id: 'setup', done: false, todo: 'Paste the setup line into Terminal on this Mac.' }]
      : [
          { id: 'setup', done: true, todo: '' },
          {
            id: 'claude',
            done: s.claude?.found === true && s.claude.signed_in === true,
            todo:
              s.claude?.found === true
                ? 'Claude Code is not signed in on this Mac. Run the setup line again and sign in when it asks.'
                : 'Claude Code is not on this Mac. Run the setup line again and say yes when it offers to install it.',
          },
          { id: 'answering', done: p.answering, todo: "Your Mac isn't answering right now. Make sure it's switched on; if this stays, run the setup line again." },
          {
            id: 'folders',
            done: p.orgs !== null && (p.orgs === 0 || (typeof s.folders?.repo_roots === 'number' && s.folders.repo_roots > 0)),
            todo: p.orgs === null ? NOT_KNOWN : 'Your project folders are not picked yet. Run the setup line again and pick them.',
          },
          {
            id: 'drive',
            done: p.drives !== null && (p.drives === 0 || s.drive?.connected === true),
            todo: p.drives === null ? NOT_KNOWN : 'Google Drive is not connected yet. Run the setup line again and sign in to Google when it asks.',
          },
          {
            id: 'self_test',
            done: s.self_test?.ok === true,
            todo: pending
              ? SELF_TEST_RUNNING
              : reason
                ? `Your Mac's last check did not pass. Run the setup line again. If it still does not pass, show this to a team owner: ${reason}.`
                : 'Your Mac has not checked that everything works yet. Wait a minute.',
          },
        ];
  const open = checks.filter((c) => !c.done);
  return [
    { id: 'mac', title: 'Set up your Mac', done: open.length === 0, todo: open[0]?.todo ?? '', checks },
    {
      id: 'accept',
      title: 'Accept what the team shares',
      done: p.boundariesVersion > 0 && p.acceptedVersion === p.boundariesVersion,
      todo: p.boundariesVersion > 0 ? `Open ${p.console} and click Accept.` : `Your team has not chosen what to share yet. A team owner does that on ${p.console}.`,
      checks: [],
    },
  ];
}

async function status(d: SetupDeps, afterSetup: boolean): Promise<number> {
  const { io, env } = d;
  const c = await (d.connect ?? (() => defaultConnect(env)))();
  if ('error' in c) {
    io.print(c.error);
    return 1;
  }
  let ms, acc;
  try {
    [ms, acc] = await Promise.all([c.client.membersStatus({ attempts: 2, timeoutMs: 15_000 }), c.client.acceptance({ attempts: 2, timeoutMs: 15_000 })]);
  } catch (err) {
    io.print(`Could not check with your team just now (${describeError(err)}). Run the setup line again in a minute.`);
    return 1;
  }
  const mine = (list: { members: MemberStatusEntry[] }) => list.members.find((m) => m.member === c.member);
  const pending = (e: MemberStatusEntry | undefined) => e?.status?.self_test.ok === false && e.status.self_test.reason === SELF_TEST_PENDING;
  // Just after the setup line installed the background answerer, it has not reported in yet.
  const notIn = (e: MemberStatusEntry | undefined) => afterSetup && !e?.status;
  // Just after setup the background answerer is still running its first self-test: wait for it
  // (and, after the setup line, for its first report), saying each once.
  const said = new Set<string>();
  const sayOnce = (line: string) => {
    if (!said.has(line)) io.print(line);
    said.add(line);
  };
  const sleep = d.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
  for (let waited = 0; ; ) {
    const e = mine(ms);
    if (notIn(e)) sayOnce(WAITING_FOR_CHECK_IN);
    else if (pending(e)) sayOnce(SELF_TEST_RUNNING);
    else break;
    if (waited >= PENDING_WAIT_MS) break;
    await sleep(PENDING_POLL_MS);
    waited += PENDING_POLL_MS;
    try {
      ms = await c.client.membersStatus({ attempts: 2, timeoutMs: 15_000 });
    } catch {
      // the last answer stands; looked at again next time
    }
  }
  const tb = await teamBoundaries(c.client);
  const entry = mine(ms);
  const url = consoleUrl(c.client.url);
  const acceptedVersion = typeof acc.version === 'number' ? acc.version : 0;
  const boundariesVersion = typeof ms.boundaries_version === 'number' ? ms.boundaries_version : 0;
  const steps = checklist({
    status: entry?.status ?? null,
    answering: entry?.answering === true,
    acceptedVersion,
    boundariesVersion,
    // Not read: not known. Read with none set: nothing to choose.
    orgs: tb ? (tb.boundaries ? tb.boundaries.github_orgs.length + tb.boundaries.github_repos.length : 0) : null,
    drives: tb ? (tb.boundaries ? tb.boundaries.drives.length + tb.boundaries.drive_folders.length : 0) : null,
    console: url,
  });
  const done = steps.filter((s) => s.done).length;
  io.print(`Your setup (${c.member}, team ${c.team}): ${done} of ${steps.length} done.`);
  for (const s of steps) {
    if (s.done) {
      io.print(`  [x] ${s.title}`);
    } else if (s.checks.length > 0) {
      io.print(`  [ ] ${s.title}`);
      for (const ch of s.checks) if (!ch.done) io.print(`      - ${ch.todo}`);
    } else {
      io.print(`  [ ] ${s.title} - ${s.todo}`);
    }
  }
  // PICKERS-SPEC §7.4: what this Mac cannot find (never makes "Set up your Mac" undone).
  if (tb?.boundaries) for (const line of missingLines(tb, entry?.sources ?? null)) io.print(line);
  // Always there, never a step: asking is what the setup is for.
  io.print(`Ask the team: ${url}/ask`);
  if (afterSetup) {
    // The setup line's last words: back to the browser, and Accept when there is something to accept.
    const toAccept = boundariesVersion > 0 && acceptedVersion !== boundariesVersion;
    io.print('');
    io.print(`Done. Go back to the team page in your browser${toAccept ? ' and click Accept' : ''}.`);
  }
  return 0;
}

/**
 * PICKERS-SPEC §7.4: the lines for what the member's Mac reported it cannot find (`sources`,
 * the relay's view), named from the team's current boundaries: a `git clone` line for a
 * repository, plain words for a whole org and for Drive. Keys that are no item of the current
 * boundaries are left out; items added after the version the Mac looked at are "still checking".
 */
export function missingLines(tb: TeamBoundaries, sources: MemberSources | null): string[] {
  const b: Boundaries | null = tb.boundaries;
  if (!b || !sources) return [];
  const items = boundaryItems(b);
  const reported = new Set(sources.missing);
  const lines: string[] = [];
  const since = sinceByKey(b, tb.since ?? null, tb.version);
  const missing = items.filter((i) => reported.has(itemKey(i)));
  if (missing.length > 0) {
    lines.push(`Your Mac can't find ${missing.length} of the things your team shares. It answers from the rest.`);
    for (const i of missing) {
      if (i.kind === 'repo') {
        lines.push(`  - git clone https://github.com/${i.org}/${i.repo}.git`);
        lines.push('    Run it in Terminal inside the folder you picked for projects.');
      } else if (i.kind === 'org') {
        lines.push(`  - No ${i.org} projects found. Clone the ones you work on into the folder you picked for projects: https://github.com/orgs/${i.org}/repositories`);
      } else {
        const name =
          i.kind === 'drive'
            ? i.shared_drive
            : i.drive_id !== null && i.folder_id === i.drive_id
              ? i.folder_name
              : `${i.folder_name} (${i.drive_name !== null ? `in ${i.drive_name}` : 'in a shared drive'})`;
        lines.push(
          `  - ${name} isn't on this Mac. Make sure Google Drive for desktop is signed in with your work account; if it still doesn't show, ask a team owner for access to the shared drive.`,
        );
      }
    }
  }
  const checking = sources.boundaries_version < tb.version ? items.filter((i) => (since.get(itemKey(i)) ?? tb.version) > sources.boundaries_version).length : 0;
  if (checking > 0) lines.push(`Your Mac is still checking ${checking === 1 ? '1 new thing' : `${checking} new things`} your team shares.`);
  return lines;
}

// -- main ------------------------------------------------------------------------------------------

export async function runSetup(argv: string[], d: SetupDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      d.io.print(HELP);
      return 0;
    case 'login':
      return login(rest, d);
    case 'folders':
      if (rest.length > 0) break;
      return folders(d);
    case 'drive':
      if (rest.length > 0) break;
      return drive(d);
    case 'daemon':
      return daemon(rest, d);
    case 'status':
      if (rest.length === 0) return status(d, false);
      if (rest.length === 1 && rest[0] === '--after-setup') return status(d, true);
      break;
  }
  d.io.print(HELP);
  return 2;
}

/**
 * The terminal: stdin, or the controlling terminal when stdin is not one (the setup script is
 * piped into bash, so its stdin is the script itself).
 */
function terminalIO(): { io: SetupIO; close: () => void } {
  let input: NodeJS.ReadableStream = process.stdin;
  if (!process.stdin.isTTY) {
    try {
      input = createReadStream('', { fd: openSync('/dev/tty', 'r') });
    } catch {
      input = process.stdin;
    }
  }
  const rl = createInterface({ input, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  return {
    io: {
      print: (line) => process.stdout.write(`${line}\n`),
      ask: async (prompt) => {
        process.stdout.write(prompt);
        const r = await it.next();
        return r.done ? null : String(r.value);
      },
    },
    close: () => {
      rl.close();
      if (input !== process.stdin) (input as unknown as { destroy?: () => void }).destroy?.();
    },
  };
}

if (process.argv[1] && /setup-cli\.[jt]s$/.test(process.argv[1])) {
  const t = terminalIO();
  void runSetup(process.argv.slice(2), { env: process.env, io: t.io }).then(
    (code) => {
      t.close();
      process.exit(code);
    },
    (err: unknown) => {
      process.stdout.write(`team-relay setup: ${describeError(err)}\n`);
      t.close();
      process.exit(1);
    },
  );
}
