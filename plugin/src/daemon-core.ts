// The background answerer (M11-SPEC §1, §3): the answer host of M8-M10 without a Claude session
// around it, run by a per-user LaunchAgent (daemon-launch.ts) through dist/daemon.js.
//
// - Signing in: it connects as the stored sign-in says (relay-connect.ts, as the channel server
//   does) and waits while there is none. A refused device credential (401) is not retried: it
//   waits until the credential file changes (a new sign-in). A sign-out or a new sign-in ends the
//   connection and starts again.
// - Answering: an AnswerHost with `background` (answer-host.ts): the answering lock as `daemon`
//   (retried every 30 s while a channel session or a manual answerer holds it), boundary mode only,
//   no capability and no approval ever. `claude` is TEAM_RELAY_CLAUDE_BIN, an absolute path to an
//   executable file, looked up again (locate.ts) when that path no longer runs (an update of the
//   Claude desktop app moves its claude); without one nothing is answered and the status says
//   claude.found=false.
// - Status: every 60 s, PUT me/status with counts and booleans only (no path, folder name,
//   question or answer): among them how many folders the member chose for the team
//   (`folder_count`, 0..20, member-folders.ts) and whether its folders file can be used
//   (`folders_ok`); a 429 is only logged.
// - Self-test at start and every 6 h: `claude auth status` succeeds, and the M10 boundary-mode
//   child starts with the real flags against a local host that denies every tool, offline, with
//   a relay address that leads nowhere (answer-dry-run.ts): no relay traffic, no question. The
//   first one runs beside connecting, so the first status goes out at once ("has not run yet").
// - Updates: once a minute it reads where the plugin is installed; when that changed it lets the
//   current answer finish, releases the lock and returns 'updated' (dist/daemon.js exits 0 and
//   launchd starts the new version).
// - macOS privacy protection: each time the facts are recounted it lists each chosen folder; one
//   that macOS refuses (EPERM) is logged with its folder name only and how often so far. The status says nothing
//   of it (the relay takes the status schema exactly).
// - The log (DaemonLog) holds ids, counts and reasons, never a question, answer or file content.

import { execFile } from 'node:child_process';
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { AnswerHost, type HostOptions } from './answer-host.js';
import { NOWHERE_RELAY, disposeDryRun, executeDryRun, prepareDryRun } from './answer-dry-run.js';
import { FOLDER_COUNT_MAX, SELF_TEST_PENDING, type MemberStatusBody } from './boundaries-types.js';
import { credentialFingerprint, credentialsPath } from './credentials.js';
import { resolveClaudeBin } from './locate.js';
import { expandPath, memberFoldersPath, readTeamSettings } from './member-folders.js';
import { backoffDelay, RelayError, type RelayClient } from './relay-client.js';
import { connectOnce, hostConnection, type ConnectAttempt } from './relay-connect.js';
import { describeError } from './tool-util.js';

export { SELF_TEST_PENDING };

export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_LINE_LIMIT = 1000;
const REASON_LIMIT = 200;

export type Intervals = {
  /** Status PUT (M11-SPEC §3: 60 s). */
  statusMs: number;
  /** Self-test (6 h). */
  selfTestMs: number;
  /** Plugin path check (1 min). */
  pluginCheckMs: number;
  /** Claude sign-in and the folders' readability (10 min, or at once when the folders change). */
  factsMs: number;
  /** How often the sign-in and the session are looked at. */
  tickMs: number;
  /** After the answering host ended on its own, before connecting again. */
  restartMs: number;
  /** Lock retry (M11-SPEC §1: 30 s). */
  lockRetryMs: number;
};

export const DEFAULT_INTERVALS: Intervals = {
  statusMs: 60_000,
  selfTestMs: 6 * 3_600_000,
  pluginCheckMs: 60_000,
  factsMs: 10 * 60_000,
  tickMs: 2000,
  restartMs: 30_000,
  lockRetryMs: 30_000,
};

// -- the log -------------------------------------------------------------------------------------

/** ~/Library/Logs/team-relay/daemon.log. */
export function daemonLogPath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME?.trim() || homedir(), 'Library', 'Logs', 'team-relay', 'daemon.log');
}

/**
 * The daemon's own log: mode 600 in a mode-700 folder, rotated at 5 MB with one old file kept
 * (`daemon.log.1`). A line is one line, clipped. Never given content: callers pass ids, counts
 * and reasons only. A log that cannot be written is skipped, never fatal.
 */
export class DaemonLog {
  constructor(
    readonly path: string,
    private readonly maxBytes = DAEMON_LOG_MAX_BYTES,
    private readonly now: () => number = Date.now,
  ) {}

  line(text: string): void {
    const flat = text.replace(/[\r\n\t]+/g, ' ').slice(0, LOG_LINE_LIMIT);
    const entry = `${new Date(this.now()).toISOString()} ${flat}\n`;
    try {
      const dir = dirname(this.path);
      try {
        lstatSync(dir);
      } catch {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
      }
      let size = 0;
      try {
        const st = lstatSync(this.path);
        if (st.isSymbolicLink() || !st.isFile()) return;
        size = st.size;
      } catch {
        size = 0;
      }
      if (size > 0 && size + Buffer.byteLength(entry) > this.maxBytes) renameSync(this.path, `${this.path}.1`);
      appendFileSync(this.path, entry, { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch {
      // the log is a side surface
    }
  }
}

// -- Claude Code and the self-test ----------------------------------------------------------------

/**
 * The claude to run: TEAM_RELAY_CLAUDE_BIN while it is an absolute path to an executable file;
 * when it was set but no longer runs (the Claude desktop app keeps its claude in a folder named
 * after its version, which an update replaces), claude is looked up again as setup found it
 * (locate.ts). Null when it is not set or nothing is found. Asked afresh at each use: the
 * status, the self-test, and the answer host before each answer it starts (its claudeBin is a
 * function calling this), so an update while the answerer runs needs no new install.
 */
export function claudeBinFrom(env: NodeJS.ProcessEnv): string | null {
  return resolveClaudeBin(env);
}

export type RunResult = { code: number | null };
/** Runs a program with arguments only (never a shell); its output is never kept. */
export type Run = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<RunResult>;

export const defaultRun: Run = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0 });
    });
  });

/** `claude auth status` succeeds (exit 0): Claude Code is signed in. Nothing it prints is kept. */
export async function claudeSignedIn(bin: string, env: NodeJS.ProcessEnv, run: Run = defaultRun): Promise<boolean> {
  return (await run(bin, ['auth', 'status'], { env, timeoutMs: 30_000 })).code === 0;
}

/**
 * `reason` goes to the relay, where teammates see it (M11-SPEC §3, §8): a fixed sentence, never
 * error text (which can carry paths). `detail` is the error text, for the local log only.
 */
export type SelfTestResult = { ok: boolean; at: string; reason: string | null; detail?: string };

const SELF_TEST_QUESTION = 'Self-test of the background answerer: reply with the single word ok.';

function reason(text: string): string {
  return text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1)}…`;
}

/**
 * M11-SPEC §3: Claude Code is found and signed in, and the boundary-mode child starts with the
 * real flags against a host that denies every tool, offline. Started means Claude Code got as far
 * as its first model request and reported the result as JSON; a flag, settings or MCP problem
 * shows no such result. Nothing reaches a relay and no question is asked.
 */
export async function selfTest(o: {
  env: NodeJS.ProcessEnv;
  dist: string;
  now?: () => number;
  run?: Run;
  signal?: AbortSignal;
  limitMs?: number;
  /** The dry run's two halves (tests: fakes). */
  prepare?: typeof prepareDryRun;
  execute?: typeof executeDryRun;
}): Promise<SelfTestResult> {
  const at = new Date((o.now ?? Date.now)()).toISOString();
  const bin = claudeBinFrom(o.env);
  if (!bin) return { ok: false, at, reason: 'Claude Code was not found: TEAM_RELAY_CLAUDE_BIN is not an executable file' };
  if (!(await claudeSignedIn(bin, o.env, o.run))) return { ok: false, at, reason: 'Claude Code is not signed in (claude auth status failed)' };
  let prepared;
  try {
    prepared = (o.prepare ?? prepareDryRun)({
      env: o.env,
      question: SELF_TEST_QUESTION,
      cwd: o.env.HOME?.trim() || homedir(),
      connection: NOWHERE_RELAY,
      member: 'member',
      claudeBin: bin,
      dist: o.dist,
      boundaries: { teamName: 'Self-test', topic: 'A self-test of the background answerer.' },
      capabilities: false,
    });
  } catch (err) {
    return { ok: false, at, reason: 'the answerer could not be prepared', detail: describeError(err) };
  }
  try {
    const { result } = await (o.execute ?? executeDryRun)(prepared, { offline: true, limitMs: o.limitMs ?? 120_000, ...(o.signal ? { signal: o.signal } : {}) });
    if (result.result && result.result.type === 'result') return { ok: true, at, reason: null };
    if (result.timedOut) return { ok: false, at, reason: 'the answerer did not finish starting in time' };
    if (result.code === null && result.signal === null) return { ok: false, at, reason: 'the answerer could not be started' };
    return { ok: false, at, reason: `the answerer did not start (exit ${result.code ?? result.signal}; no result)` };
  } catch (err) {
    return { ok: false, at, reason: 'the self-test failed', detail: describeError(err) };
  } finally {
    await disposeDryRun(prepared);
  }
}

// -- the daemon ---------------------------------------------------------------------------------

/** What the daemon needs of an answer host. */
export type HostLike = { start(): Promise<void>; stop(): Promise<void>; finishAndStop(): Promise<void>; readonly stopped: boolean };

export type Facts = {
  claudeSignedIn: (bin: string) => Promise<boolean>;
  /** Lists a folder (resolves when it can be read); a refusal by macOS throws EPERM. */
  canRead: (path: string) => Promise<unknown>;
};

export type DaemonOptions = {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Where the bundles are (dist/). */
  dist: string;
  version: string;
  /** SIGTERM: stop. */
  signal: AbortSignal;
  /** Where the plugin is installed now (null: unknown, no update check). */
  installedIdentity?: () => string | null;
  makeHost?: (o: HostOptions) => HostLike;
  selfTest?: (signal: AbortSignal) => Promise<SelfTestResult>;
  facts?: Partial<Facts>;
  intervals?: Partial<Intervals>;
  now?: () => number;
};

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Math.floor(n)));

export async function runDaemon(o: DaemonOptions): Promise<'stopped' | 'updated'> {
  const { env, log, signal } = o;
  const iv = { ...DEFAULT_INTERVALS, ...o.intervals };
  const now = o.now ?? Date.now;
  const credFile = credentialsPath(env);
  const startedAt = new Date(now()).toISOString();
  const facts: Facts = {
    claudeSignedIn: (bin) => claudeSignedIn(bin, env),
    canRead: (path) => readdir(path),
    ...o.facts,
  };
  const makeHost = o.makeHost ?? ((h: HostOptions) => new AnswerHost(h));
  const runSelfTest = o.selfTest ?? ((s: AbortSignal) => selfTest({ env, dist: o.dist, signal: s, now }));

  // Woken early by SIGTERM and by an update.
  const wakers = new Set<() => void>();
  const wake = () => {
    for (const w of [...wakers]) w();
  };
  signal.addEventListener('abort', wake);
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (signal.aborted || updated) return resolve();
      const done = () => {
        clearTimeout(t);
        wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, Math.max(0, ms));
      wakers.add(done);
    });

  // -- M11-SPEC §1: the plugin path, once a minute.
  const identity0 = o.installedIdentity?.() ?? null;
  let updated = false;
  const pluginTimer = setInterval(() => {
    if (identity0 === null || updated) return;
    let current: string | null;
    try {
      current = o.installedIdentity!();
    } catch {
      current = null;
    }
    if (current !== identity0) {
      updated = true;
      log('the plugin was updated (or removed): finishing the current answer, then exiting for the new version');
      wake();
    }
  }, iv.pluginCheckMs);

  // -- M11-SPEC §3: the self-test, at start and every 6 h.
  let test: SelfTestResult = { ok: false, at: startedAt, reason: SELF_TEST_PENDING };
  let testing: Promise<void> | null = null;
  const doSelfTest = (): Promise<void> => {
    testing ??= (async () => {
      try {
        test = await runSelfTest(signal);
      } catch (err) {
        test = { ok: false, at: new Date(now()).toISOString(), reason: 'the self-test could not run', detail: describeError(err) };
      }
      test = { ...test, reason: test.reason === null ? null : reason(test.reason) };
      log(test.ok ? 'self-test passed' : `self-test failed: ${test.reason ?? 'no reason'}${test.detail ? ` (${test.detail.slice(0, 500)})` : ''}`);
    })().finally(() => {
      testing = null;
    });
    return testing;
  };
  const selfTimer = setInterval(() => void doSelfTest(), iv.selfTestMs);

  // -- the slower facts in the status: Claude's sign-in, and whether macOS lets the folders be read.
  let signedIn = false;
  let factsAt = Number.NEGATIVE_INFINITY;
  let factsKey = '';
  // macOS privacy refusals so far, by what was refused (for the log only).
  const refusals = new Map<string, number>();
  const checkReadable = async (targets: Array<{ what: string; path: string }>) => {
    for (const t of targets) {
      try {
        await facts.canRead(t.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException | null)?.code !== 'EPERM') continue;
        const n = (refusals.get(t.what) ?? 0) + 1;
        refusals.set(t.what, n);
        log(`macOS refused the background answerer access to ${t.what} (EPERM, ${n} ${n === 1 ? 'time' : 'times'} so far): allow "node" when macOS asks, or in System Settings > Privacy & Security`);
      }
    }
  };
  const refreshFacts = async (folders: string[]) => {
    const bin = claudeBinFrom(env);
    const key = JSON.stringify(folders);
    if (now() - factsAt < iv.factsMs && key === factsKey) return;
    factsAt = now();
    factsKey = key;
    signedIn = bin ? await facts.claudeSignedIn(bin).catch(() => false) : false;
    // Only the folder's own name is ever logged, never the path to it.
    await checkReadable(
      folders.flatMap((raw) => {
        const path = expandPath(raw, env);
        return path ? [{ what: `a chosen folder ${JSON.stringify(basename(path).slice(0, 80))}`, path }] : [];
      }),
    );
  };

  /** The member's folders for the team; none, and ok false, when the file cannot be used. */
  const folders = (team: string): { list: string[]; ok: boolean } => {
    try {
      return { list: readTeamSettings(memberFoldersPath(env), env, team).folders, ok: true };
    } catch {
      return { list: [], ok: false };
    }
  };

  /** One status PUT; 'refused' on a 401. */
  const sendStatus = async (client: RelayClient, team: string): Promise<'ok' | 'refused'> => {
    const { list: f, ok: foldersOk } = folders(team);
    // Recounted every 10 minutes, or at once when the folders changed.
    await refreshFacts(f);
    const body: MemberStatusBody = {
      daemon: { version: o.version.slice(0, 32), started_at: startedAt },
      claude: { found: claudeBinFrom(env) !== null, signed_in: signedIn },
      folder_count: clamp(f.length, FOLDER_COUNT_MAX),
      folders_ok: foldersOk,
      self_test: { ok: test.ok, at: test.at, reason: test.reason },
    };
    try {
      await client.putStatus(body, { attempts: 1, timeoutMs: 15_000, signal });
      return 'ok';
    } catch (err) {
      if (err instanceof RelayError && err.status === 401) return 'refused';
      if (err instanceof RelayError && err.status === 429) log('status not sent: the relay asked to slow down (429)');
      else if (!signal.aborted) log(`status not sent (${describeError(err)})`);
      return 'ok';
    }
  };

  type Outcome = 'reconnect' | 'refused' | 'stop' | 'updated';

  /** Answer while connected; returns why it ended. */
  const session = async (a: Extract<ConnectAttempt, { kind: 'connected' }>, fp: string | null): Promise<Outcome> => {
    const { client, me, connection } = a;
    let host: HostLike | null = null;
    let hostEnded = false;
    let saidNoClaude = false;
    const startHost = () => {
      const bin = claudeBinFrom(env);
      if (!bin) {
        if (!saidNoClaude) log('Claude Code was not found (TEAM_RELAY_CLAUDE_BIN is not an executable file): not answering');
        saidNoClaude = true;
        return;
      }
      const h = makeHost({
        client,
        me,
        env,
        connection: hostConnection(connection, env, credFile),
        // No session to push to: what the host says there it also logs (ids and names only).
        push: () => {},
        log,
        background: true,
        // Asked again before every answer: a claude the desktop app replaced while the host runs
        // is found anew, never started from its old path.
        claudeBin: () => claudeBinFrom(env),
        distDir: o.dist,
        lockRetryMs: iv.lockRetryMs,
        // M8: a desktop notification, unless TEAM_RELAY_DESKTOP_NOTIFY=0.
        ...(env.TEAM_RELAY_DESKTOP_NOTIFY === '0' ? { notify: () => {} } : {}),
      });
      host = h;
      void h.start().then(
        () => {
          if (!h.stopped) {
            hostEnded = true;
            wake();
          }
        },
        (err: unknown) => {
          log(`answering ended: ${describeError(err)}`);
          hostEnded = true;
          wake();
        },
      );
    };
    const stopHost = async (finish: boolean) => {
      const h = host as HostLike | null;
      host = null;
      if (h) await (finish ? h.finishAndStop() : h.stop()).catch(() => {});
    };
    startHost();
    let nextStatus = now();
    for (;;) {
      if (signal.aborted) {
        await stopHost(false);
        return 'stop';
      }
      if (updated) {
        await stopHost(true);
        return 'updated';
      }
      if (connection.mode === 'credential' && credentialFingerprint(credFile) !== fp) {
        await stopHost(false);
        log('signed out, or signed in again: reconnecting');
        return 'reconnect';
      }
      if (hostEnded) {
        await stopHost(false);
        log(`answering stopped; connecting again in ${Math.round(iv.restartMs / 1000)} s`);
        await sleep(iv.restartMs);
        return 'reconnect';
      }
      if (!host && claudeBinFrom(env)) {
        saidNoClaude = false;
        startHost();
      }
      if (now() >= nextStatus) {
        nextStatus = now() + iv.statusMs;
        if ((await sendStatus(client, me.team)) === 'refused' && connection.mode === 'credential') {
          await stopHost(false);
          log('the relay refused the sign-in (401): waiting for a new sign-in');
          return 'refused';
        }
        continue;
      }
      await sleep(Math.min(iv.tickMs, Math.max(0, nextStatus - now())));
    }
  };

  try {
    // The first self-test runs beside connecting (it can take a while): until it ends the status
    // says it has not run yet.
    void doSelfTest();
    let refusedAt: string | null | undefined;
    let failures = 0;
    let said = '';
    const note = (line: string) => {
      if (line !== said) log(line);
      said = line;
    };
    while (!signal.aborted && !updated) {
      const fp = credentialFingerprint(credFile);
      if (refusedAt !== undefined && fp === refusedAt) {
        await sleep(iv.tickMs);
        continue;
      }
      refusedAt = undefined;
      const a = await connectOnce(env);
      if (signal.aborted || updated) break;
      // Compared from now on: the file the attempt read, not the one looked at before it.
      const read = a.fingerprint;
      if (a.kind !== 'connected') {
        if (a.kind === 'not_signed_in') {
          note('not signed in: waiting for a sign-in (setup-cli.js login)');
          await sleep(iv.tickMs);
        } else if (a.kind === 'refused') {
          refusedAt = read;
          note('the relay refused the stored sign-in (401): waiting for a new sign-in');
        } else if (a.kind === 'unreachable') {
          note(`not connected yet: ${a.problem}; trying again`);
          await sleep(backoffDelay(failures++, { baseMs: 2000, maxMs: 60_000 }));
        } else {
          note(`not connected: ${a.problem}`);
          await sleep(a.kind === 'wrong_team' ? 60_000 : iv.tickMs);
        }
        continue;
      }
      failures = 0;
      said = '';
      log(`connected as ${a.me.member} in team ${a.me.team}`);
      const out = await session(a, read);
      if (out === 'refused') refusedAt = read;
    }
  } finally {
    clearInterval(pluginTimer);
    clearInterval(selfTimer);
    signal.removeEventListener('abort', wake);
    const pending = testing as Promise<void> | null;
    if (pending) await pending.catch(() => {});
  }
  return updated ? 'updated' : 'stopped';
}

/** The plugin's version (plugin.json beside dist/), for the status. */
export function pluginVersion(dist: string): string {
  try {
    const v = (JSON.parse(readFileSync(join(dist, '..', '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version;
    if (typeof v === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(v)) return v;
  } catch {
    // unknown
  }
  return '0.0.0';
}
