// `node dist/setup-cli.js <command>`: the steps of the one-command setup (M11-SPEC §5) that need
// the plugin. The setup script runs them in order; a member can run any of them again.
//
//   login [--relay <url>]               the browser sign-in of M5 (skipped when signed in to that relay)
//   folders                             choose the folders that hold your clones (asks on the terminal)
//   drive                               connect Google Drive when the team has drives (M10 §2a)
//   daemon install --claude <path> --plugin team-relay@<marketplace>
//                                       write and load the background answerer's LaunchAgent, for
//                                       the plugin installed under exactly that key
//   daemon uninstall                    stop and remove it
//   status                              your setup checklist, as the relay sees it (M11 §6)
//
// Nothing here prints a credential or token. Exit 0: done (or nothing to do); 1: it did not
// work (the line says why); 2: usage.

import { createReadStream, openSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { configDir } from './answering-lock.js';
import { SELF_TEST_PENDING, type MemberStatusEntry, type TeamBoundaries } from './boundaries-types.js';
import { homeDir, validBoundaries } from './boundary-set.js';
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
  '  status                           show your setup checklist',
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
  clones?: (raw: string, orgs: string[]) => Promise<number>;
};

const NOT_SIGNED_IN = 'Not signed in to the team relay: run `node setup-cli.js login` first.';

// macOS privacy protection: a LaunchAgent's node may be refused (or macOS may ask the member)
// for folders under these, and for the Drive mount (~/Library/CloudStorage).
const PROTECTED_DIRS = ['Documents', 'Desktop', 'Downloads', join('Library', 'Mobile Documents')];
export const PRIVACY_FOLDERS_NOTE =
  'macOS protects Documents, Desktop, Downloads and iCloud Drive, so the first time the background answerer reads a folder there, macOS may ask whether "node" may access it: click Allow.';
export const PRIVACY_DRIVE_NOTE = 'The first time the background answerer reads Google Drive, macOS may ask whether "node" may access it: click Allow.';

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
  if (a.kind === 'refused') return { error: 'The relay refused your sign-in (signed out, expired, or no longer on the team): run `node setup-cli.js login` again.' };
  return { error: `Could not reach the team relay: ${a.problem}.` };
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
  io.print('Sign in with your work Google account in the browser tab that opened, and choose your team.');
  io.print('If no tab opened, open this link yourself (it is for you only; do not share it):');
  io.print(flow.url);
  try {
    const r = await flow.done;
    const change = identityChange(r.stored, r.replaced);
    io.print(`${connectedAs(r.stored)}.${change ? ` ${change}` : ''}`);
    return 0;
  } catch (err) {
    io.print(`The sign-in did not complete: ${describeError(err)}`);
    return 1;
  }
}

// -- folders ---------------------------------------------------------------------------------------

async function chooseList(
  d: SetupDeps,
  what: { name: string; current: string[]; intro: string; count: ((raw: string) => Promise<number>) | null },
): Promise<string[]> {
  const { io, env } = d;
  const describe = async (raw: string) => {
    const resolved = expandPath(raw, env);
    const shown = resolved && resolved !== raw ? `${raw} (${resolved})` : raw;
    const { reason } = memberFolderProblem(raw, env);
    if (reason) return `${shown}: not used (${reason})`;
    if (!what.count) return shown;
    const n = await what.count(raw);
    return `${shown}: ${n} ${n === 1 ? 'clone' : 'clones'} found`;
  };
  if (what.current.length > 0) {
    io.print(`Your ${what.name} now:`);
    for (const raw of what.current) io.print(`  ${await describe(raw)}`);
    if (yes(await io.ask(`Keep these ${what.name}? [Y/n] `), true)) return what.current;
  }
  io.print(what.intro);
  const out: string[] = [];
  for (;;) {
    const line = await io.ask('> ');
    if (line === null || line.trim() === '') break;
    const raw = line.trim();
    const { reason } = memberFolderProblem(raw, env);
    if (reason) {
      io.print(`  Not used: ${raw} ${reason === 'it is not an absolute path or one starting with ~/' ? 'is not an absolute path or one starting with ~/' : `cannot be used: ${reason}`}.`);
      continue;
    }
    const target = expandPath(raw, env);
    if (out.some((e) => e === raw || expandPath(e, env) === target)) {
      io.print('  Already in the list.');
      continue;
    }
    if (out.length >= MAX_FOLDERS) {
      io.print(`  At most ${MAX_FOLDERS}; that one is not added.`);
      continue;
    }
    out.push(raw);
    io.print(`  ${await describe(raw)}`);
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
    io.print("Your team's boundaries could not be read from the relay; try again later.");
    return 1;
  }
  if (!tb.boundaries) {
    io.print(`Your team has no boundaries yet, so there is nothing to choose: an owner sets them in the console (${url}). Run this again after.`);
    return 0;
  }
  const file = memberFoldersPath(env);
  let all;
  try {
    all = readMemberSettings(file, env);
  } catch (err) {
    io.print(`Your folders file cannot be used (${describeError(err)}): fix or remove ${file}.`);
    return 1;
  }
  const current = teamSettings(all, c.team);
  const orgs = tb.boundaries.github_orgs;
  const count = d.clones ?? ((raw: string, o: string[]) => clonesUnder(raw, o, env));
  let roots = current.repo_roots;
  if (orgs.length > 0) {
    io.print(`Your team's GitHub organisations: ${orgs.join(', ')}.`);
    roots = await chooseList(d, {
      name: 'repo roots',
      current: current.repo_roots,
      intro:
        'Type the folders that hold your clones of these organisations\' repositories, one per line (~ is allowed; each is searched 3 levels deep). An empty line ends the list.',
      count: (raw) => count(raw, orgs),
    });
  } else {
    io.print('Your team has no GitHub organisations in its boundaries, so no repo roots are needed.');
  }
  let extra = current.extra_folders;
  if (tb.boundaries.member_folders) {
    extra = await chooseList(d, {
      name: 'own folders',
      current: current.extra_folders,
      intro: 'Your team allows folders of your own. Type any you want answers to come from, one per line (only files git tracks are read in a repository). An empty line ends the list.',
      count: null,
    });
  } else if (current.extra_folders.length > 0) {
    io.print('Your team does not allow folders of your own, so the ones you set earlier are not used.');
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
  io.print(`Saved: ${roots.length} repo ${roots.length === 1 ? 'root' : 'roots'}${tb.boundaries.member_folders ? `, ${extra.length} own ${extra.length === 1 ? 'folder' : 'folders'}` : ''}. Your background answerer uses them from its next answer.`);
  const used = tb.boundaries.member_folders ? [...roots, ...extra] : roots;
  if (used.some((raw) => privacyProtected(raw, env))) io.print(PRIVACY_FOLDERS_NOTE);
  return 0;
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
    io.print("Your team's boundaries could not be read from the relay; try again later.");
    return 1;
  }
  if (!tb.boundaries || tb.boundaries.drives.length === 0) {
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
  io.print('Connecting Google Drive (read-only): sign in with your work Google account in the browser tab that opens.');
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
      io.print(found ? 'The background answerer is stopped and removed.' : 'The background answerer was not installed; nothing to do.');
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
    const r = await installAgent({
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
    io.print(`The background answerer is installed and started (${r.plist}). It answers teammates while this Mac is on, without a Claude Code window.`);
    return 0;
  } catch (err) {
    io.print(err instanceof AgentError ? err.message : `That did not work: ${describeError(err)}`);
    return 1;
  }
}

// -- status ----------------------------------------------------------------------------------------

export type Step = { done: boolean; title: string; todo: string };

export const SELF_TEST_RUNNING = 'Running the self-test now; this takes about a minute.';
/** While the self-test has not run yet, status looks again this often, for at most this long. */
const PENDING_POLL_MS = 5000;
const PENDING_WAIT_MS = 90_000;

const NOT_KNOWN = "Not known: your team's boundaries could not be read from the relay just now; run status again in a minute.";

/**
 * M11-SPEC §6: the seven steps, from the relay's view of this member. `orgs` and `drives`: how
 * many the team's boundaries hold (0 also when none are set), null when they could not be read;
 * "Folders chosen" and "Google Drive connected" need nothing only when that count is 0.
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
  return [
    { done: s !== null, title: 'Run the setup command', todo: 'Run the setup command from the console on this Mac.' },
    {
      done: s?.claude?.found === true && s.claude.signed_in === true,
      title: 'Claude Code found and signed in',
      todo: 'Install Claude Code and sign in to it (claude auth login), then run the setup command again.',
    },
    { done: p.answering, title: 'Answering in the background', todo: 'Run the setup command again to start the background answerer, and keep this Mac on.' },
    {
      done: p.orgs !== null && (p.orgs === 0 || (typeof s?.folders?.repo_roots === 'number' && s.folders.repo_roots > 0)),
      title: 'Folders chosen',
      todo: p.orgs === null ? NOT_KNOWN : 'Choose the folders that hold your clones: node setup-cli.js folders.',
    },
    {
      done: p.drives !== null && (p.drives === 0 || s?.drive?.connected === true),
      title: 'Google Drive connected',
      todo: p.drives === null ? NOT_KNOWN : 'Connect Google Drive: node setup-cli.js drive.',
    },
    {
      done: p.boundariesVersion > 0 && p.acceptedVersion === p.boundariesVersion,
      title: 'Boundaries accepted',
      todo: p.boundariesVersion > 0 ? `Open ${p.console} and press Accept.` : `Your team has no boundaries yet: an owner sets them in the console (${p.console}).`,
    },
    {
      done: s?.self_test?.ok === true,
      title: 'Self-test passed',
      todo: pending ? SELF_TEST_RUNNING : reason ? `The self-test failed: ${reason}.` : 'Wait a minute for the background answerer to run its self-test.',
    },
  ];
}

async function status(d: SetupDeps): Promise<number> {
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
    io.print(`The relay did not give your status (${describeError(err)}); try again later.`);
    return 1;
  }
  const mine = (list: { members: MemberStatusEntry[] }) => list.members.find((m) => m.member === c.member);
  const pending = (e: MemberStatusEntry | undefined) => e?.status?.self_test.ok === false && e.status.self_test.reason === SELF_TEST_PENDING;
  // Just after setup the background answerer is still running its first self-test: wait for it.
  if (pending(mine(ms))) {
    io.print(SELF_TEST_RUNNING);
    const sleep = d.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
    for (let waited = 0; waited < PENDING_WAIT_MS && pending(mine(ms)); ) {
      await sleep(PENDING_POLL_MS);
      waited += PENDING_POLL_MS;
      try {
        ms = await c.client.membersStatus({ attempts: 2, timeoutMs: 15_000 });
      } catch {
        // the last answer stands; looked at again next time
      }
    }
  }
  const tb = await teamBoundaries(c.client);
  const entry = mine(ms);
  const steps = checklist({
    status: entry?.status ?? null,
    answering: entry?.answering === true,
    acceptedVersion: typeof acc.version === 'number' ? acc.version : 0,
    boundariesVersion: typeof ms.boundaries_version === 'number' ? ms.boundaries_version : 0,
    // Not read: not known. Read with none set: nothing to choose.
    orgs: tb ? (tb.boundaries?.github_orgs.length ?? 0) : null,
    drives: tb ? (tb.boundaries?.drives.length ?? 0) : null,
    console: consoleUrl(c.client.url),
  });
  const done = steps.filter((s) => s.done).length;
  io.print(`Setup for ${c.member} on team ${c.team}: ${done} of ${steps.length} done.`);
  for (const s of steps) io.print(s.done ? `  [x] ${s.title}` : `  [ ] ${s.title} - ${s.todo}`);
  if (done === steps.length) io.print(`You're set up. Ask the team in the console: ${consoleUrl(c.client.url)}`);
  return 0;
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
      if (rest.length > 0) break;
      return status(d);
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
