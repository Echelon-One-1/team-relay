// M11-SPEC §1, §3: the background answerer: its log, the self-test with a fake `claude`, the
// daemon loop (status reports, the plugin update check, SIGTERM) against the fake relay with a
// fake host, and the real answer host in background mode (boundary mode only, no capabilities,
// the lock held as `daemon`). Everything lives in temporary folders; nothing touches the real
// ~/Library, ~/.config or launchctl.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnswerHost, NOT_SET_UP_REPLY, NO_CAPABILITY_REPLY, type HostOptions } from '../src/answer-host.js';
import { NOWHERE_RELAY, disposeDryRun, executeDryRun, prepareDryRun } from '../src/answer-dry-run.js';
import { DaemonLog, SELF_TEST_PENDING, claudeBinFrom, daemonLogPath, pluginVersion, runDaemon, selfTest, type HostLike, type SelfTestResult } from '../src/daemon-core.js';
import { memberFoldersPath, writeMemberSettings } from '../src/member-folders.js';
import { RelayClient } from '../src/relay-client.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST, FIXTURES, sleep, waitFor } from './helpers/mcp.js';

const STUB = join(FIXTURES, 'stub-claude.mjs');
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const mode = (p: string) => lstatSync(p).mode & 0o777;

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tr-daemon-')));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** An executable script at `name` in the temp folder. */
function script(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, `#!${process.execPath}\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('the daemon log (M11-SPEC §1)', () => {
  it('lives at ~/Library/Logs/team-relay/daemon.log', () => {
    expect(daemonLogPath({ HOME: '/Users/someone' })).toBe('/Users/someone/Library/Logs/team-relay/daemon.log');  // e1-guard: allow (synthetic macOS home path in a test)
  });

  it('is mode 600 in a mode-700 folder; a line is one line, with a time', () => {
    const path = join(tmp, 'Logs', 'team-relay', 'daemon.log');
    const log = new DaemonLog(path, 1000, () => Date.parse('2026-11-10T10:00:00.000Z'));
    log.line('first\nsecond\tthird');
    expect(mode(path)).toBe(0o600);
    expect(mode(join(tmp, 'Logs', 'team-relay'))).toBe(0o700);
    expect(readFileSync(path, 'utf8')).toBe('2026-11-10T10:00:00.000Z first second third\n');
  });

  it('rotates at the size limit, keeping one older file', () => {
    const path = join(tmp, 'daemon.log');
    const log = new DaemonLog(path, 200);
    for (let i = 0; i < 20; i++) log.line(`line ${i} ${'x'.repeat(30)}`);
    expect(statSync(path).size).toBeLessThanOrEqual(200);
    expect(statSync(`${path}.1`).size).toBeLessThanOrEqual(200);
    expect(existsSync(`${path}.2`)).toBe(false);
    expect(readFileSync(path, 'utf8')).toContain('line 19');
    expect(mode(`${path}.1`)).toBe(0o600);
  });

  it('a log that cannot be written is skipped, never an error', () => {
    writeFileSync(join(tmp, 'file'), '');
    expect(() => new DaemonLog(join(tmp, 'file', 'daemon.log')).line('x')).not.toThrow();
  });
});

describe('Claude Code and the self-test (M11-SPEC §1, §3)', () => {
  it('TEAM_RELAY_CLAUDE_BIN must be an absolute path to an executable file', () => {
    const ok = script('claude', 'process.exit(0)');
    expect(claudeBinFrom({ TEAM_RELAY_CLAUDE_BIN: ok })).toBe(ok);
    expect(claudeBinFrom({ TEAM_RELAY_CLAUDE_BIN: 'claude' })).toBeNull();
    expect(claudeBinFrom({ TEAM_RELAY_CLAUDE_BIN: join(tmp, 'missing') })).toBeNull();
    expect(claudeBinFrom({ TEAM_RELAY_CLAUDE_BIN: tmp })).toBeNull();
    expect(claudeBinFrom({})).toBeNull();
  });

  const env = (bin: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, TMPDIR: tmp, TEAM_RELAY_CLAUDE_BIN: bin });
  const now = () => Date.parse('2026-11-10T10:00:00.000Z');

  it('passes when Claude Code is signed in and the answerer starts and reports a result (offline: an error result)', async () => {
    // What claude does offline: a JSON result that is an error, exit 1.
    const bin = script('claude', `if (process.argv[2] === 'auth') process.exit(0);
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: Connection error.' }));
process.exit(1);`);
    expect(await selfTest({ env: env(bin), dist: DIST, now, limitMs: 30_000 })).toEqual({ ok: true, at: '2026-11-10T10:00:00.000Z', reason: null });
  });

  it('the offline child gets no retries and a 5 s API timeout, so a refused connection ends in seconds, not minutes', async () => {
    // As Claude Code does: with retries left it keeps retrying the closed port (here: no result).
    const bin = script('claude-retries', `if (process.argv[2] === 'auth') process.exit(0);
const e = process.env;
if (e.CLAUDE_CODE_MAX_RETRIES !== '0' || e.API_TIMEOUT_MS !== '5000' || !/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(e.ANTHROPIC_BASE_URL ?? '')) process.exit(7);
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: Connection error.' }));
process.exit(1);`);
    expect(await selfTest({ env: env(bin), dist: DIST, now, limitMs: 30_000 })).toEqual({ ok: true, at: '2026-11-10T10:00:00.000Z', reason: null });
  });

  it('a run that is not offline keeps the API settings as they are', async () => {
    const seen = join(tmp, 'seen.json');
    const bin = script('claude-env', `const e = process.env;
require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify([e.CLAUDE_CODE_MAX_RETRIES ?? null, e.API_TIMEOUT_MS ?? null, e.ANTHROPIC_BASE_URL ?? null]));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));`);
    const prepared = prepareDryRun({ env: env(bin), question: 'q', cwd: tmp, connection: NOWHERE_RELAY, member: 'member', claudeBin: bin, dist: DIST, boundaries: { teamName: 'T', topic: 'T.' }, capabilities: false });
    try {
      await executeDryRun(prepared, { offline: false, limitMs: 30_000 });
    } finally {
      await disposeDryRun(prepared);
    }
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual([null, null, null]);
  });

  it('fails, saying why: not found, not signed in, or the answerer did not start', async () => {
    expect(await selfTest({ env: env(join(tmp, 'missing')), dist: DIST, now })).toMatchObject({ ok: false, reason: expect.stringContaining('Claude Code was not found') });
    const out = script('claude-out', `process.exit(process.argv[2] === 'auth' ? 1 : 0)`);
    expect(await selfTest({ env: env(out), dist: DIST, now })).toMatchObject({ ok: false, reason: 'Claude Code is not signed in (claude auth status failed)' });
    const broken = script('claude-broken', `if (process.argv[2] === 'auth') process.exit(0);
process.stderr.write('error: unknown option');
process.exit(2);`);
    const r = await selfTest({ env: env(broken), dist: DIST, now, limitMs: 30_000 });
    expect(r).toEqual({ ok: false, at: '2026-11-10T10:00:00.000Z', reason: 'the answerer did not start (exit 2; no result)' });
  });

  it('a reason sent to the relay is a fixed sentence: error text (which can hold paths) stays in detail, for the local log', async () => {
    const bin = script('claude-ok', `process.exit(0)`);
    const leak = () => new Error(`EACCES: permission denied, mkdtemp '${tmp}/private/run-XXXXXX'`);
    const prep = await selfTest({ env: env(bin), dist: DIST, now, prepare: () => { throw leak(); } });
    expect(prep).toMatchObject({ ok: false, reason: 'the answerer could not be prepared' });
    expect(prep.detail).toContain(tmp);
    const exec = await selfTest({ env: env(bin), dist: DIST, now, execute: async () => { throw leak(); } });
    expect(exec).toMatchObject({ ok: false, reason: 'the self-test failed' });
    expect(exec.detail).toContain(tmp);
  });

  it('the plugin version comes from plugin.json beside dist/', () => {
    expect(pluginVersion(DIST)).toMatch(/^\d+\.\d+\.\d+/);
    expect(pluginVersion(join(tmp, 'dist'))).toBe('0.0.0');
  });
});

// -- the daemon loop -------------------------------------------------------------------------------

describe('the daemon loop (M11-SPEC §1, §3)', () => {
  let relay: FakeRelay;
  let logs: string[];
  let claude: string;
  beforeEach(async () => {
    relay = await new FakeRelay().start();
    logs = [];
    claude = script('claude', 'process.exit(0)');
  });
  afterEach(async () => {
    await relay.stop();
  });

  type Fake = HostLike & { opts: HostOptions; started: number; finished: number; stoppedCalls: number };
  function fakeHosts(): { hosts: Fake[]; make: (o: HostOptions) => HostLike } {
    const hosts: Fake[] = [];
    return {
      hosts,
      make: (opts) => {
        let stopped = false;
        let release!: () => void;
        const running = new Promise<void>((r) => (release = r));
        const h: Fake = {
          opts,
          started: 0,
          finished: 0,
          stoppedCalls: 0,
          get stopped() {
            return stopped;
          },
          start: async () => {
            h.started++;
            await running;
          },
          stop: async () => {
            h.stoppedCalls++;
            stopped = true;
            release();
          },
          finishAndStop: async () => {
            h.finished++;
            stopped = true;
            release();
          },
        };
        hosts.push(h);
        return h;
      },
    };
  }

  const PASSED: SelfTestResult = { ok: true, at: '2026-11-10T10:00:00.000Z', reason: null };
  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const xdg = join(tmp, 'xdg');
    mkdirSync(xdg, { recursive: true, mode: 0o700 });
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tmp,
      XDG_CONFIG_HOME: xdg,
      RELAY_AUTH: 'token',
      RELAY_URL: relay.url,
      RELAY_TEAM: 'demo',
      RELAY_TOKEN: TOKEN_OF.bob!,
      TEAM_RELAY_CLAUDE_BIN: claude,
      ...extra,
    };
  }
  const intervals = { statusMs: 150, tickMs: 20, pluginCheckMs: 30, factsMs: 60_000, restartMs: 50, lockRetryMs: 50, selfTestMs: 3_600_000 };
  const facts = { claudeSignedIn: async () => true, driveConnected: async () => false, clones: async () => 0 };

  it('answers in background mode and reports only counts and yes/no facts, every interval', async () => {
    const { hosts, make } = fakeHosts();
    const ac = new AbortController();
    const done = runDaemon({ env: env(), log: (l) => logs.push(l), dist: DIST, version: '0.11.0', signal: ac.signal, makeHost: make, selfTest: async () => PASSED, facts, intervals });
    await waitFor(() => relay.memberStatus.get('bob'), 10_000, 'the first status');
    const o = hosts[0]!.opts;
    expect(o.background).toBe(true);
    expect(o.claudeBin).toBe(claude);
    expect(o.me.member).toBe('bob');
    expect(o.lockRetryMs).toBe(50);
    const st = relay.memberStatus.get('bob')!;
    expect(Object.keys(st).sort()).toEqual(['claude', 'daemon', 'drive', 'folders', 'seen_at', 'self_test']);
    expect(st).toMatchObject({
      daemon: { version: '0.11.0', started_at: expect.any(String) },
      claude: { found: true, signed_in: true },
      folders: { repo_roots: 0, clones: 0, extra_folders: 0 },
      drive: { connected: false },
      self_test: PASSED,
    });
    const puts = () => relay.requests.filter((r) => r.member === 'bob' && r.method === 'PUT' && r.path.endsWith('/me/status')).length;
    await waitFor(() => puts() >= 3, 10_000, 'more status writes');
    ac.abort();
    expect(await done).toBe('stopped');
    expect(hosts[0]!.stoppedCalls).toBe(1);
    expect(logs).toContain('connected as bob in team demo');
  });

  it('a 429 from the relay is logged and the daemon carries on', async () => {
    relay.statusGapMs = 60_000;
    const { make } = fakeHosts();
    const ac = new AbortController();
    const done = runDaemon({ env: env(), log: (l) => logs.push(l), dist: DIST, version: '1', signal: ac.signal, makeHost: make, selfTest: async () => PASSED, facts, intervals });
    await waitFor(() => logs.includes('status not sent: the relay asked to slow down (429)'), 10_000, 'the 429 note');
    expect(relay.memberStatus.has('bob')).toBe(true);
    ac.abort();
    expect(await done).toBe('stopped');
  });

  it('without an executable Claude Code it does not answer and reports found: false', async () => {
    const { hosts, make } = fakeHosts();
    const ac = new AbortController();
    const done = runDaemon({
      env: env({ TEAM_RELAY_CLAUDE_BIN: 'claude' }),
      log: (l) => logs.push(l),
      dist: DIST,
      version: '1',
      signal: ac.signal,
      makeHost: make,
      selfTest: async () => ({ ok: false, at: PASSED.at, reason: 'Claude Code was not found' }),
      facts,
      intervals,
    });
    await waitFor(() => relay.memberStatus.get('bob'), 10_000, 'the status');
    expect(hosts).toEqual([]);
    expect(relay.memberStatus.get('bob')).toMatchObject({ claude: { found: false, signed_in: false }, self_test: { ok: false, reason: 'Claude Code was not found' } });
    expect(logs.some((l) => l.startsWith('Claude Code was not found'))).toBe(true);
    ac.abort();
    await done;
  });

  it('when the installed plugin changes it finishes the current answer, stops answering and returns "updated"', async () => {
    const { hosts, make } = fakeHosts();
    let identity = 'v1';
    const ac = new AbortController();
    const done = runDaemon({
      env: env(),
      log: (l) => logs.push(l),
      dist: DIST,
      version: '1',
      signal: ac.signal,
      installedIdentity: () => identity,
      makeHost: make,
      selfTest: async () => PASSED,
      facts,
      intervals,
    });
    await waitFor(() => hosts[0]?.started, 10_000, 'the host');
    await sleep(100);
    expect(hosts[0]!.finished).toBe(0);
    identity = 'v2';
    expect(await done).toBe('updated');
    expect(hosts[0]!.finished).toBe(1);
    expect(hosts[0]!.stoppedCalls).toBe(0);
  });

  it('SIGTERM (the abort) stops it quickly even while waiting for the relay', async () => {
    const ac = new AbortController();
    const done = runDaemon({
      env: env({ RELAY_URL: 'http://127.0.0.1:9' }),
      log: (l) => logs.push(l),
      dist: DIST,
      version: '1',
      signal: ac.signal,
      selfTest: async () => PASSED,
      facts,
      intervals,
    });
    await waitFor(() => logs.some((l) => l.startsWith('not connected yet')), 10_000, 'the first failed connection');
    const t = Date.now();
    ac.abort();
    expect(await done).toBe('stopped');
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('connects and reports while the first self-test is still running ("has not run yet"), then reports its result', async () => {
    const { hosts, make } = fakeHosts();
    let finish!: (r: SelfTestResult) => void;
    const ac = new AbortController();
    const done = runDaemon({
      env: env(),
      log: (l) => logs.push(l),
      dist: DIST,
      version: '1',
      signal: ac.signal,
      makeHost: make,
      selfTest: () => new Promise<SelfTestResult>((r) => (finish = r)),
      facts,
      intervals,
    });
    await waitFor(() => relay.memberStatus.get('bob'), 5_000, 'a status before the self-test ends');
    expect(relay.memberStatus.get('bob')).toMatchObject({ self_test: { ok: false, reason: SELF_TEST_PENDING } });
    expect(SELF_TEST_PENDING).toBe('the self-test has not run yet');
    expect(hosts[0]?.started).toBe(1);
    finish(PASSED);
    await waitFor(() => (relay.memberStatus.get('bob') as { self_test?: { ok?: boolean } }).self_test?.ok === true, 10_000, 'the self-test result in the status');
    ac.abort();
    expect(await done).toBe('stopped');
  });

  it('a folder macOS refuses (EPERM) is logged by kind and folder name only, and counted; other errors are not', async () => {
    relay.setBoundaries({ topic: 'T', github_orgs: ['example-org'], drives: [{ domain: 'example.com', shared_drive: 'Team Drive' }], member_folders: true });
    for (const d of ['Documents/code', 'work/repos', 'Desktop/notes']) mkdirSync(join(tmp, d), { recursive: true });
    const e = env();
    writeMemberSettings(memberFoldersPath(e), { teams: { demo: { repo_roots: ['~/Documents/code', '~/work/repos'], extra_folders: ['~/Desktop/notes'], accepted: null } } }, e);
    const probed: string[] = [];
    const refuse = (code: string, p: string) => Object.assign(new Error(`${code}: operation not permitted, scandir '${p}'`), { code });
    const canRead = async (p: string) => {
      probed.push(p);
      if (p.endsWith('code') || p.endsWith('CloudStorage') || p.endsWith('notes')) throw refuse('EPERM', p);
      throw refuse('ENOENT', p);
    };
    const { make } = fakeHosts();
    const ac = new AbortController();
    const done = runDaemon({ env: e, log: (l) => logs.push(l), dist: DIST, version: '1', signal: ac.signal, makeHost: make, selfTest: async () => PASSED, facts: { ...facts, canRead }, intervals: { ...intervals, factsMs: 100 } });
    await waitFor(() => logs.filter((l) => l.includes('repo root "code"')).length >= 2, 10_000, 'two refusals of the same root');
    ac.abort();
    await done;
    const refused = logs.filter((l) => l.startsWith('macOS refused'));
    expect(refused).toContain('macOS refused the background answerer access to a repo root "code" (EPERM, 1 time so far): allow "node" when macOS asks, or in System Settings > Privacy & Security');
    expect(refused.some((l) => l.includes('repo root "code" (EPERM, 2 times so far)'))).toBe(true);
    expect(refused.some((l) => l.startsWith('macOS refused the background answerer access to the Google Drive folder (EPERM, 1 time'))).toBe(true);
    expect(refused.some((l) => l.startsWith('macOS refused the background answerer access to a folder of your own "notes" (EPERM, 1 time'))).toBe(true);
    expect(refused.some((l) => l.includes('repos'))).toBe(false);
    for (const l of logs) expect(l).not.toContain(tmp);
    expect(probed).toContain(join(tmp, 'Library', 'CloudStorage'));
  });

  it('a self-test error reaches the local log with its detail; the status sent to the relay carries only the fixed reason', async () => {
    const e = env();
    const { make } = fakeHosts();
    const ac = new AbortController();
    const done = runDaemon({
      env: e,
      log: (l) => logs.push(l),
      dist: DIST,
      version: '1',
      signal: ac.signal,
      makeHost: make,
      selfTest: (sig) => selfTest({ env: e, dist: DIST, signal: sig, prepare: () => { throw new Error(`EACCES: permission denied, mkdtemp '${tmp}/private/run-XXXXXX'`); } }),
      facts,
      intervals,
    });
    await waitFor(() => (relay.memberStatus.get('bob') as { self_test?: { reason?: string } } | undefined)?.self_test?.reason === 'the answerer could not be prepared', 10_000, 'the failed self-test in the status');
    ac.abort();
    await done;
    expect(JSON.stringify(relay.memberStatus.get('bob'))).not.toContain(tmp);
    expect(logs.some((l) => l.startsWith('self-test failed: the answerer could not be prepared (') && l.includes(`${tmp}/private/run-XXXXXX`))).toBe(true);
  });

  it('Drive is checked again for every status (a Drive connected after start shows at once, not 10 minutes later)', async () => {
    let connected = false;
    const { make } = fakeHosts();
    const ac = new AbortController();
    const done = runDaemon({
      env: env(),
      log: (l) => logs.push(l),
      dist: DIST,
      version: '1',
      signal: ac.signal,
      makeHost: make,
      selfTest: async () => PASSED,
      facts: { ...facts, driveConnected: async () => connected },
      intervals: { ...intervals, factsMs: 3_600_000 },
    });
    await waitFor(() => relay.memberStatus.get('bob'), 10_000, 'the first status');
    expect(relay.memberStatus.get('bob')).toMatchObject({ drive: { connected: false } });
    connected = true;
    await waitFor(() => (relay.memberStatus.get('bob') as { drive?: { connected?: boolean } }).drive?.connected === true, 5_000, 'Drive connected in the status');
    ac.abort();
    await done;
  });

  it('the self-test runs at start, then on its interval', async () => {
    const { make } = fakeHosts();
    let runs = 0;
    const ac = new AbortController();
    const done = runDaemon({
      env: env(),
      log: (l) => logs.push(l),
      dist: DIST,
      version: '1',
      signal: ac.signal,
      makeHost: make,
      selfTest: async () => {
        runs++;
        return PASSED;
      },
      facts,
      intervals: { ...intervals, selfTestMs: 100 },
    });
    await waitFor(() => runs >= 3, 10_000, 'three self-tests');
    expect(logs.filter((l) => l === 'self-test passed').length).toBeGreaterThanOrEqual(2);
    ac.abort();
    await done;
  });
});

// -- the real host in background mode ----------------------------------------------------------------

describe('the answer host in background mode (M11-SPEC §1)', () => {
  let relay: FakeRelay;
  let xdg: string;
  const hosts: AnswerHost[] = [];
  const savedTmp = process.env.TMPDIR;
  beforeEach(async () => {
    relay = await new FakeRelay().start();
    process.env.TMPDIR = tmp;
    xdg = join(tmp, 'xdg');
    mkdirSync(xdg, { mode: 0o700 });
  });
  afterEach(async () => {
    while (hosts.length) await hosts.pop()!.stop();
    await relay.stop();
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  });

  function startHost(): { host: AnswerHost; logs: string[] } {
    const logs: string[] = [];
    const host = new AnswerHost({
      client: new RelayClient({ url: relay.url, team: 'demo', token: () => TOKEN_OF.bob!, attempts: 1 }),
      me: { team: 'demo', member: 'bob', teammates: ['alice', 'carol'] },
      env: { PATH: process.env.PATH ?? '', HOME: tmp, TMPDIR: tmp, XDG_CONFIG_HOME: xdg, CAP_SERVICE_HEALTH_ENABLED: 'true', CAP_SERVICE_HEALTH_RUNNER: join(FIXTURES, 'fake-runner.mjs') },
      connection: { mode: 'token', url: relay.url, team: 'demo', token: TOKEN_OF.bob! },
      push: () => {},
      log: (l) => void logs.push(l),
      distDir: DIST,
      claudeBin: STUB,
      notify: () => {},
      background: true,
    });
    hosts.push(host);
    void host.start();
    return { host, logs };
  }
  const reading = () => waitFor(() => relay.requests.some((r) => r.path.endsWith('/streams/inbox') && r.member === 'bob'), 10_000, 'the host to read the inbox');
  const replyTo = (id: string) => relay.replies.find((r) => r.request_id === id);

  it('holds the answering lock as daemon', async () => {
    startHost();
    await reading();
    const lock = JSON.parse(readFileSync(join(xdg, 'team-relay', 'answering.lock'), 'utf8')) as { role: string; pid: number };
    expect(lock).toMatchObject({ role: 'daemon', pid: process.pid });
  });

  it('a team without boundaries gets "not set up yet": it never answers from a folder, and publishes no capabilities', async () => {
    startHost();
    await reading();
    const id = relay.addRequest({ kind: 'question', asker: 'alice', question: 'Where is the staging bucket?', recipients: { bob: { status: 'pending' } }, answer_deadline: iso(600_000) });
    relay.enqueue('bob', 'inbox', { type: 'question', from: 'alice', request_id: id, data: { question: 'Where is the staging bucket?', ack_deadline: iso(60_000), answer_deadline: iso(600_000) } });
    await waitFor(() => replyTo(id), 15_000, 'the reply');
    expect(replyTo(id)!.body.text).toBe(NOT_SET_UP_REPLY('bob'));
    expect(existsSync(join(tmp, 'stub-claude', `${id}.json`))).toBe(false);
    const manifest = relay.manifests.get('bob') as { capabilities?: unknown[] } | undefined;
    expect(manifest?.capabilities ?? []).toEqual([]);
  });

  it('a capability call is declined with the fixed line and runs nothing', async () => {
    startHost();
    await reading();
    const params = { service: 'api' };
    const id = relay.addRequest({ kind: 'capability', asker: 'alice', capability: { name: 'service_health', params }, recipients: { bob: { status: 'pending' } } });
    relay.enqueue('bob', 'inbox', { type: 'capability_call', from: 'alice', request_id: id, data: { capability: 'service_health', params, ack_deadline: iso(60_000), answer_deadline: iso(600_000) } });
    await waitFor(() => replyTo(id), 15_000, 'the reply');
    expect(replyTo(id)!.body.text).toBe(NO_CAPABILITY_REPLY('bob'));
    expect(NO_CAPABILITY_REPLY('bob')).toBe("bob's background answerer does not run capabilities; ask bob directly.");
    expect(existsSync(join(tmp, 'stub-claude', `${id}.json`))).toBe(false);
    expect(relay.progress.filter((p) => p.request_id === id)).toEqual([]);
  });
});
