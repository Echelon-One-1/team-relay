// `node dist/setup-cli.js <command>`: the steps of the one-command setup (M11-SPEC §5) that need
// the plugin. The setup script runs them in order; a member can run any of them again.
//
//   login [--relay <url>]               the browser sign-in of M5 (skipped when signed in to that relay)
//   folders                             choose the folders on this Mac your Claude may answer your
//                                       team from (one list, at most 20; the Mac's chooser, or asks
//                                       on the terminal)
//   daemon install --claude <path> --plugin team-relay@<marketplace>
//                                       write and load the background answerer's LaunchAgent, for
//                                       the plugin installed under exactly that key
//   daemon uninstall                    stop and remove it
//   status [--after-setup]              your setup checklist, as the relay sees it (M11 §6)
//
// Nothing here prints a credential or token. Exit 0: done (or nothing to do); 1: it did not
// work (the line says why); 2: usage.
//
// What it prints is read by members who have never used Terminal (M11-SPEC "Simpler joining"):
// plain, short sentences that say what to do, never the names of tools or files.

import { createReadStream, openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { SELF_TEST_PENDING, type MemberStatusEntry } from './boundaries-types.js';
import { homeDir } from './boundary-set.js';
import { consoleUrl } from './console-url.js';
import { CredentialFileError, credentialsPath, normaliseRelayUrl, readCredential } from './credentials.js';
import { AgentError, type Exec } from './daemon-launch.js';
import type { FetchPinnedNode } from './locate.js';
import { LoginError, connectedAs, identityChange, startLogin, type LoginFlow, type LoginOptions } from './login.js';
import { MAX_FOLDERS, MemberFoldersError, expandPath, hasAccepted, memberFolderProblem, memberFoldersPath, readMemberSettings, previousSentence, teamSettings } from './member-folders.js';
import { configValue, parseRelayUrl, type RelayClient } from './relay-client.js';
import { defaultRelayUrl } from './relay-default.js';
import { connectOnce } from './relay-connect.js';
import {
  addFolder,
  currentUid,
  defaultChooser,
  backgroundNode,
  installBackground,
  saveTeamFolders,
  uninstallBackground,
  type FolderChooser,
} from './setup-steps.js';
import { describeError } from './tool-util.js';

// The Mac's folder chooser lives in setup-steps.ts (the setup page uses it too).
export { CHOOSE_FOLDER_SCRIPT, CHOOSER_TIMEOUT_MS, chosenPaths, osascriptChooser, type ChooseResult, type ExecFileLike, type FolderChooser } from './setup-steps.js';

export const HELP = [
  'usage: node setup-cli.js <command>',
  '',
  '  login [--relay <url>]            sign in to the team relay in your browser',
  '  folders                          choose the folders your Claude may answer your team from',
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
  /**
   * The absolute path of node, for the LaunchAgent (default: the pinned private copy, got first
   * when missing, else a stable PATH node: setup-steps.ts backgroundNode, as the setup page does).
   */
  node?: string;
  /** Tests: what gets the pinned node (default: bin/run-node --fetch-only). */
  fetchNode?: FetchPinnedNode;
  /** Runs launchctl (tests: a fake). */
  exec?: Exec;
  /** Waits between launchctl calls (tests: a fake). */
  sleep?: (ms: number) => Promise<void>;
  startLogin?: (o: LoginOptions) => Promise<LoginFlow>;
  /** The relay client for the signed-in member (default: connectOnce). */
  connect?: () => Promise<{ client: RelayClient; member: string; team: string } | { error: string }>;
  /** The Mac's folder chooser (default: osascript's `choose folder`; tests: a fake). */
  chooseFolders?: FolderChooser;
};

export const NOT_SIGNED_IN = 'You are not signed in to your team on this Mac yet. Run the setup line again.';

// macOS privacy protection: a LaunchAgent's node may be refused (or macOS may ask the member)
// for folders under these.
const PROTECTED_DIRS = ['Documents', 'Desktop', 'Downloads', join('Library', 'Mobile Documents')];
export const PRIVACY_FOLDERS_NOTE =
  'The first time your Mac answers from a folder in Documents, Desktop, Downloads or iCloud Drive, macOS may ask whether "node" may open it: click Allow.';

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

/** The chooser's own prompt (the setup page's says the same, local-setup.ts). */
export const FOLDERS_PROMPT = 'Pick the folders your Claude may answer your team from. Hold Cmd to pick more than one.';

const plural = (n: number, one: string, many: string) => `${n === 0 ? 'no' : n} ${n === 1 ? one : many}`;

/** The member's folders, kept, re-picked in the Mac's chooser or typed (asked once). */
async function chooseFolders(d: SetupDeps, current: string[]): Promise<string[]> {
  const { io, env } = d;
  const name = (raw: string) => {
    const resolved = expandPath(raw, env) ?? raw;
    return basename(resolved) || resolved;
  };
  const describe = (raw: string) => {
    const { reason } = memberFolderProblem(raw, env);
    return reason ? `Not used: ${raw} (${reason}).` : `${name(raw)} (${expandPath(raw, env) ?? raw})`;
  };
  /** Adds `raw` to `out` when it can be used; says what happened. */
  const add = (raw: string, out: string[]) => {
    const r = addFolder(out, raw, env);
    if (r.kind === 'refused') io.print(`  Not used: ${raw} (${r.reason}).`);
    else if (r.kind === 'duplicate') io.print(`  ${name(raw)} is already in the list.`);
    else if (r.kind === 'full') io.print(`  At most ${MAX_FOLDERS} folders; ${name(raw)} is not added.`);
    else io.print(`  ${describe(raw)}`);
  };

  let saidNo = false;
  if (current.length > 0) {
    io.print('The folders your Claude answers your team from:');
    for (const raw of current) io.print(`  ${describe(raw)}`);
    if (yes(await io.ask('Keep these folders? [Y/n] '), true)) return current;
    saidNo = true;
  }

  const chooser = d.chooseFolders ?? defaultChooser(d.platform ?? process.platform);
  io.print('A window opens: pick the folders your Claude may answer your team from (hold Cmd to pick more than one), then click Choose.');
  const r = await chooser(FOLDERS_PROMPT);
  if (r.kind === 'cancelled') {
    // After a No, a Cancel may mean "none at all": asked, never assumed.
    if (saidNo && yes(await io.ask('Stop using any folders? [y/N] '), false)) return [];
    io.print(current.length > 0 ? 'Nothing picked, so your folders stay as they were.' : 'Nothing picked.');
    return current;
  }
  if (r.kind === 'chosen') {
    const out: string[] = [];
    for (const raw of r.paths) add(raw, out);
    if (out.length === 0 && r.paths.length > 0) {
      io.print(current.length > 0 ? 'None of those can be used, so your folders stay as they were.' : 'None of those can be used.');
      return current;
    }
    return out;
  }

  // No chooser here (no screen, or no osascript): the member types the folders.
  io.print('Type the full path of each folder your Claude may answer your team from, one per line (~ means your home folder). Press Enter on an empty line to finish.');
  const out: string[] = [];
  for (;;) {
    const line = await io.ask('> ');
    if (line === null || line.trim() === '') break;
    add(line.trim(), out);
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
  const file = memberFoldersPath(env);
  let all;
  try {
    all = readMemberSettings(file, env);
  } catch (err) {
    io.print(`Your saved folders cannot be read (${describeError(err)}). Ask a team owner for help.`);
    return 1;
  }
  const current = teamSettings(all, c.team);
  io.print('Your Claude answers your team from folders you choose on this Mac. In a folder that is a git repository, only the files git tracks are used.');
  // An earlier plugin's folders are never used: named, so the member can pick again the ones they want.
  const previous = previousSentence(current.previous);
  if (previous) io.print(previous);
  const chosen = await chooseFolders(d, current.folders);
  let saved: string[];
  try {
    // Read again: the file may have changed while the questions were open. Saved as `folders`
    // alone: an earlier plugin's lists leave the file.
    saved = saveTeamFolders(env, c.team, () => chosen);
  } catch (err) {
    io.print(`Nothing was saved (${err instanceof MemberFoldersError ? err.message : describeError(err)}).`);
    return 1;
  }
  io.print(`Saved: ${plural(saved.length, 'folder', 'folders')}.`);
  if (saved.some((raw) => privacyProtected(raw, env))) io.print(PRIVACY_FOLDERS_NOTE);
  return 0;
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
  const uid = d.uid ?? currentUid();
  try {
    if (sub === 'uninstall') {
      const found = await uninstallBackground({ env, uid, ...(d.exec ? { exec: d.exec } : {}) });
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
    await installBackground({
      env,
      uid,
      node: d.node ?? (await backgroundNode(env, d.fetchNode)),
      claude,
      pluginKey: plugin,
      ...(d.exec ? { exec: d.exec } : {}),
      ...(d.sleep ? { sleep: d.sleep } : {}),
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
export type Check = { id: 'setup' | 'claude' | 'answering' | 'folders' | 'self_test'; done: boolean; todo: string };
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

/**
 * The two steps, from the relay's view of this member (the console's Setup page shows the
 * same; "Ask the team" is not a step, it is always there below them). "Set up your Mac" is done
 * when every check is: the Mac has reported in, Claude Code is there and signed in, the Mac
 * answers now, at least one folder is chosen (`folderCount`, the member's own entry's
 * folder_count; null, not reported, never counts as done; when `foldersOk` is false the folders
 * file cannot be used, which is said as such) and the self-test.
 */
export function checklist(p: {
  status: { claude?: { found?: unknown; signed_in?: unknown }; self_test?: { ok?: unknown; reason?: unknown } } | null;
  folderCount: number | null;
  foldersOk: boolean | null;
  answering: boolean;
  acceptedVersion: number;
  boundariesVersion: number;
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
            done: p.foldersOk !== false && typeof p.folderCount === 'number' && p.folderCount > 0,
            todo:
              p.foldersOk === false
                ? 'Your saved folders file cannot be used on this Mac. In Claude Code, run /team-relay:folders to see why.'
                : 'You have not chosen the folders your Claude answers from yet. Run the setup line again and pick them.',
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
      done: p.boundariesVersion > 0 && hasAccepted(p.acceptedVersion, p.boundariesVersion),
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
  const entry = mine(ms);
  const url = consoleUrl(c.client.url);
  const acceptedVersion = typeof acc.version === 'number' ? acc.version : 0;
  const boundariesVersion = typeof ms.boundaries_version === 'number' ? ms.boundaries_version : 0;
  const steps = checklist({
    status: entry?.status ?? null,
    folderCount: typeof entry?.folder_count === 'number' ? entry.folder_count : null,
    foldersOk: typeof entry?.folders_ok === 'boolean' ? entry.folders_ok : null,
    answering: entry?.answering === true,
    acceptedVersion,
    boundariesVersion,
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
  // Always there, never a step: asking is what the setup is for.
  io.print(`Ask the team: ${url}/ask`);
  if (afterSetup) {
    // The setup line's last words: back to the browser, and Accept when there is something to accept.
    const toAccept = boundariesVersion > 0 && !hasAccepted(acceptedVersion, boundariesVersion);
    io.print('');
    io.print(`Done. Go back to the team page in your browser${toAccept ? ' and click Accept' : ''}.`);
  }
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
