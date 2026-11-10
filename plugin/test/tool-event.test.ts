// M2-SPEC §4.3: the answering session's open requests (active.json, written by the answerer
// channel) and the PostToolUse / PostToolUseFailure hook script (dist/tool-event.js), which
// is also the PermissionRequest hook (M4-SPEC §2: a `waiting` event).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVE_FILE, ActiveRequests, mostRecentOpen, readActive, writeActiveAtomic } from '../src/active.js';
import { parseToolEventConfig, splitToolName, toolEventFromPayload } from '../src/tool-event-core.js';
import { FakeRelay, TOKEN_OF, rqId } from './helpers/fake-relay.js';
import { DIST, PLUGIN_ROOT, spawnServer, textOf, waitFor } from './helpers/mcp.js';

const HOOK = join(DIST, 'tool-event.js');
const SECRET_INPUT = 'SECRET-INPUT-/Users/bob/.ssh/id_ed25519';
const SECRET_OUTPUT = 'SECRET-OUTPUT-row-contents-4242';
const SECRET_ERROR = 'SECRET-ERROR-permission denied reading /etc/shadow';
/** An answer deadline well ahead (M2-SPEC §7.6). */
const LATER = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

let relay: FakeRelay;
let stateDir: string;
let configPath: string;

beforeEach(async () => {
  relay = await new FakeRelay().start();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-hook-')));
  stateDir = join(dir, 'state');
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${TOKEN_OF.bob}\n`, { mode: 0o600 });
  configPath = join(dir, 'tool-event.json');
  writeConfig({});
  function writeConfig(extra: Record<string, unknown>) {
    writeFileSync(
      configPath,
      JSON.stringify({ relay_url: relay.url, relay_team: 'demo', relay_auth: 'token', token_file: tokenFile, state_dir: stateDir, ...extra }),
    );
  }
  new ActiveRequests(stateDir); // creates the state directory
});
afterEach(async () => {
  await relay.stop();
});

type Run = { code: number | null; stdout: string; stderr: string; ms: number };

/** Run the hook as Claude Code would: exec form, the hook input on stdin. */
function runHook(payload: unknown, opts: { args?: string[]; closeStdin?: boolean; raw?: string } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, ...(opts.args ?? ['--config', configPath])], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
    if (opts.closeStdin === false) child.stdin.write(opts.raw ?? JSON.stringify(payload).slice(0, 10));
    else child.stdin.end(opts.raw ?? JSON.stringify(payload));
  });
}

/** A request bob has acknowledged (bob is its recipient at the fake relay). */
function openRequest(): string {
  const id = relay.addRequest({ kind: 'question', question: 'q?', recipients: { bob: { status: 'acked' } } });
  return id;
}

const post = (tool_name: string, extra: Record<string, unknown> = {}) => ({
  session_id: 's1',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/tmp/work',
  hook_event_name: 'PostToolUse',
  tool_name,
  tool_input: { file_path: SECRET_INPUT, pattern: SECRET_INPUT },
  tool_response: SECRET_OUTPUT,
  tool_use_id: 'toolu_01',
  duration_ms: 1234.4,
  ...extra,
});
const failure = (tool_name: string, extra: Record<string, unknown> = {}) => ({
  session_id: 's1',
  hook_event_name: 'PostToolUseFailure',
  tool_name,
  tool_input: { file_path: SECRET_INPUT },
  error: SECRET_ERROR,
  is_interrupt: false,
  tool_use_id: 'toolu_02',
  duration_ms: 7,
  ...extra,
});

/** Claude Code's PermissionRequest hook input (code.claude.com/docs/en/hooks, 24 Sep 2026). */
const permission = (tool_name: string, extra: Record<string, unknown> = {}) => ({
  session_id: 's1',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/tmp/work',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name,
  tool_input: { file_path: SECRET_INPUT },
  permission_suggestions: [
    { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: `/${SECRET_INPUT}/**` }], behavior: 'allow', destination: 'session' },
  ],
  ...extra,
});

describe('tool event from a hook payload', () => {
  it('turns a PermissionRequest into a waiting event: the name only, no duration (M4-SPEC §2)', () => {
    expect(toolEventFromPayload(permission('Read'))).toEqual({ tool: 'Read', status: 'waiting', duration_ms: null });
    expect(toolEventFromPayload(permission('Grep', { duration_ms: 50 }))).toEqual({ tool: 'Grep', status: 'waiting', duration_ms: null });
    expect(toolEventFromPayload(permission('mcp__capabilities__staging_db_query'))).toMatchObject({ tool: 'staging_db_query', status: 'waiting' });
    expect(toolEventFromPayload(permission('mcp__relay__reply'))).toBeNull();
    expect(JSON.stringify(toolEventFromPayload(permission('Read')))).not.toMatch(/SECRET/);
  });

  it('strips mcp__<server>__ prefixes, keeps built-in names', () => {
    expect(splitToolName('mcp__capabilities__staging_db_query')).toEqual({ server: 'capabilities', tool: 'staging_db_query' });
    expect(splitToolName('mcp__plugin_team-relay_relay__reply')).toEqual({ server: 'plugin_team-relay_relay', tool: 'reply' });
    expect(splitToolName('Read')).toEqual({ server: null, tool: 'Read' });
    expect(toolEventFromPayload(post('mcp__capabilities__staging_db_query'))).toEqual({ tool: 'staging_db_query', status: 'ok', duration_ms: 1234 });
    expect(toolEventFromPayload(failure('Grep'))).toEqual({ tool: 'Grep', status: 'error', duration_ms: 7 });
  });

  it("ignores the relay's own tools, other events and malformed payloads", () => {
    for (const name of ['mcp__relay__ack_question', 'mcp__relay__reply', 'mcp__plugin_team-relay_relay__ack_question', 'ack_question', 'reply']) {
      expect(toolEventFromPayload(post(name))).toBeNull();
    }
    // A capability that happens to be called reply is still a tool used to answer.
    expect(toolEventFromPayload(post('mcp__capabilities__reply'))).toMatchObject({ tool: 'reply' });
    expect(toolEventFromPayload({ ...post('Read'), hook_event_name: 'PreToolUse' })).toBeNull();
    expect(toolEventFromPayload({ hook_event_name: 'PostToolUse' })).toBeNull();
    expect(toolEventFromPayload(post('mcp__x__' + 'a'.repeat(65)))).toBeNull();
    expect(toolEventFromPayload(post('Bad Name'))).toBeNull();
    expect(toolEventFromPayload(null)).toBeNull();
    expect(toolEventFromPayload([post('Read')])).toBeNull();
  });

  it('sends duration_ms only when the payload carries a usable one', () => {
    expect(toolEventFromPayload(post('Read', { duration_ms: undefined }))).toEqual({ tool: 'Read', status: 'ok', duration_ms: null });
    expect(toolEventFromPayload(post('Read', { duration_ms: '12' }))).toMatchObject({ duration_ms: null });
    expect(toolEventFromPayload(post('Read', { duration_ms: -1 }))).toMatchObject({ duration_ms: null });
    expect(toolEventFromPayload(post('Read', { duration_ms: 3_600_001 }))).toMatchObject({ duration_ms: null });
    expect(toolEventFromPayload(post('Read', { duration_ms: 3_600_000 }))).toMatchObject({ duration_ms: 3_600_000 });
    expect(toolEventFromPayload(post('Read', { duration_ms: 0 }))).toMatchObject({ duration_ms: 0 });
  });

  it('builds the event from name, outcome and duration alone', () => {
    const event = toolEventFromPayload(post('Read', { extra: SECRET_OUTPUT }));
    expect(Object.keys(event!).sort()).toEqual(['duration_ms', 'status', 'tool']);
    expect(JSON.stringify(event)).not.toMatch(/SECRET/);
  });
});

describe('active.json', () => {
  it('keeps open requests in acknowledgement order, atomically, mode 600', async () => {
    const a = new ActiveRequests(stateDir);
    const [r1, r2] = [rqId(), rqId()];
    await a.add(r1, LATER);
    await a.add(r2, LATER);
    expect(mostRecentOpen(stateDir)).toBe(r2);
    await a.add(r1, LATER); // acknowledged again: most recent again
    expect(readActive(stateDir).map((e) => e.request_id)).toEqual([r2, r1]);
    await a.remove(r1);
    expect(mostRecentOpen(stateDir)).toBe(r2);
    await a.remove(r2);
    expect(mostRecentOpen(stateDir)).toBeNull();
    expect(statSync(join(stateDir, ACTIVE_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(stateDir)).toEqual([ACTIVE_FILE]);
  });

  it('reads a missing, malformed or hostile file as nothing open', () => {
    expect(readActive(stateDir)).toEqual([]);
    writeFileSync(join(stateDir, ACTIVE_FILE), '{not json');
    expect(mostRecentOpen(stateDir)).toBeNull();
    writeFileSync(join(stateDir, ACTIVE_FILE), JSON.stringify({ open: [{ request_id: '../../me', acked_at: 'x' }, 'x'] }));
    expect(mostRecentOpen(stateDir)).toBeNull();
    writeActiveAtomic(stateDir, Array.from({ length: 60 }, () => ({ request_id: rqId(), acked_at: 'x', answer_deadline: LATER })));
    expect(readActive(stateDir)).toHaveLength(50);
  });

  it('records each answer deadline and drops entries past it when read (§7.6)', async () => {
    const a = new ActiveRequests(stateDir);
    const [r1, r2, r3] = [rqId(), rqId(), rqId()];
    const now = Date.now();
    const soon = new Date(now + 60_000).toISOString();
    await a.add(r1, LATER);
    await a.add(r2, soon);
    expect(readActive(stateDir)).toEqual([
      { request_id: r1, acked_at: expect.any(String), answer_deadline: LATER },
      { request_id: r2, acked_at: expect.any(String), answer_deadline: soon },
    ]);
    // Past r2's deadline the older request is the most recent one still open.
    expect(mostRecentOpen(stateDir, now + 60_000)).toBe(r1);
    expect(mostRecentOpen(stateDir, now + 59_000)).toBe(r2);
    expect(readActive(stateDir, Date.parse(LATER))).toEqual([]);
    // Acknowledged already past its deadline: never open.
    await a.add(r3, PAST);
    expect(readActive(stateDir).map((e) => e.request_id)).toEqual([r1, r2]);
    // The next write drops what is past too, so the file does not grow with stale entries.
    const raw = JSON.parse(readFileSync(join(stateDir, ACTIVE_FILE), 'utf8'));
    expect(raw.open.map((e: { request_id: string }) => e.request_id)).toEqual([r1, r2, r3]);
    await a.remove(r1);
    expect(JSON.parse(readFileSync(join(stateDir, ACTIVE_FILE), 'utf8')).open.map((e: { request_id: string }) => e.request_id)).toEqual([r2]);
    // An entry without a usable deadline (an M2 file before §7.6, or a hand edit) is not open.
    writeFileSync(
      join(stateDir, ACTIVE_FILE),
      JSON.stringify({ version: 1, open: [{ request_id: r1, acked_at: 'x' }, { request_id: r2, acked_at: 'x', answer_deadline: 'tomorrow' }] }),
    );
    expect(readActive(stateDir)).toEqual([]);
    await expect(a.add(r1, 'tomorrow')).rejects.toThrow(/RFC 3339/);
  });

  it('clears to nothing open', async () => {
    const a = new ActiveRequests(stateDir);
    await a.add(rqId(), LATER);
    await a.clear();
    expect(readActive(stateDir)).toEqual([]);
    expect(JSON.parse(readFileSync(join(stateDir, ACTIVE_FILE), 'utf8'))).toEqual({ version: 1, open: [] });
  });

  it('refuses a relative state directory', () => {
    expect(() => new ActiveRequests('state')).toThrow(/absolute/);
  });

  it('the answerer channel adds on ack_question and removes on reply', async () => {
    const s = await spawnServer('channel.js', {
      RELAY_URL: relay.url,
      RELAY_TEAM: 'demo',
      RELAY_TOKEN: TOKEN_OF.bob!,
      RELAY_ROLE: 'answerer',
      ANSWERER_STATE_DIR: stateDir,
    });
    try {
      const [r1, r2] = [openRequest(), openRequest()];
      for (const [id, st] of [[r1, 'pending'], [r2, 'pending']] as const) relay.requestDocs.get(id)!.recipients.bob!.status = st;
      expect(JSON.parse(textOf(await s.client.callTool({ name: 'ack_question', arguments: { request_id: r1 } })))).toEqual({ status: 'acked' });
      expect(mostRecentOpen(stateDir)).toBe(r1);
      await s.client.callTool({ name: 'ack_question', arguments: { request_id: r2 } });
      expect(readActive(stateDir).map((e) => e.request_id)).toEqual([r1, r2]);
      await s.client.callTool({ name: 'reply', arguments: { request_id: r2, text: 'done' } });
      expect(readActive(stateDir).map((e) => e.request_id)).toEqual([r1]);
      // A reply the relay refuses as already answered also closes it.
      relay.fail((r) => r.path.endsWith('/reply'), 409, 1, { error: 'already_answered', detail: 'x' });
      const res = await s.client.callTool({ name: 'reply', arguments: { request_id: r1, text: 'again' } });
      expect(res.isError).toBe(true);
      expect(readActive(stateDir)).toEqual([]);
      // A failed ack records nothing.
      relay.fail((r) => r.path.endsWith('/ack'), 410, 1, { error: 'expired', detail: 'x' });
      const r3 = openRequest();
      expect((await s.client.callTool({ name: 'ack_question', arguments: { request_id: r3 } })).isError).toBe(true);
      expect(readActive(stateDir)).toEqual([]);
      // Only ids and times are stored.
      const raw = readFileSync(join(stateDir, ACTIVE_FILE), 'utf8');
      expect(raw).not.toMatch(/q\?|done|again/);
    } finally {
      await s.close();
    }
  });

  it('the answerer channel clears the file at start, and takes each deadline from the envelope, the relay, or a bound', async () => {
    // A previous session left requests open: none of them is open in this one.
    await new ActiveRequests(stateDir).add(openRequest(), LATER);
    // A question pushed to this session: its envelope carries the answer deadline.
    const pushedDeadline = new Date(Date.now() + 600_000).toISOString();
    const pushed = openRequest();
    relay.requestDocs.get(pushed)!.recipients.bob!.status = 'pending';
    relay.enqueue('bob', 'inbox', {
      type: 'question',
      request_id: pushed,
      data: { question: 'q?', ack_deadline: LATER, answer_deadline: pushedDeadline },
    });
    const s = await spawnServer('channel.js', {
      RELAY_URL: relay.url,
      RELAY_TEAM: 'demo',
      RELAY_TOKEN: TOKEN_OF.bob!,
      RELAY_ROLE: 'answerer',
      ANSWERER_STATE_DIR: stateDir,
    });
    try {
      await waitFor(() => s.notifications.find((n) => n.meta.request_id === pushed), 5000, 'the pushed question');
      expect(readActive(stateDir)).toEqual([]);
      const getsBefore = relay.requests.filter((r) => r.method === 'GET' && r.path.endsWith(pushed)).length;
      await s.client.callTool({ name: 'ack_question', arguments: { request_id: pushed } });
      expect(readActive(stateDir)).toEqual([{ request_id: pushed, acked_at: expect.any(String), answer_deadline: pushedDeadline }]);
      // Known from the envelope: no extra read.
      expect(relay.requests.filter((r) => r.method === 'GET' && r.path.endsWith(pushed)).length).toBe(getsBefore);

      // Not pushed by this process: read from GET /requests/{id}.
      const unseen = openRequest();
      await s.client.callTool({ name: 'ack_question', arguments: { request_id: unseen } });
      expect(readActive(stateDir).at(-1)).toEqual({
        request_id: unseen,
        acked_at: expect.any(String),
        answer_deadline: relay.requestDocs.get(unseen)!.answer_deadline,
      });

      // The relay does not say: bounded by the longest answer window (24 h).
      const unknown = openRequest();
      relay.fail((r) => r.method === 'GET' && r.path.endsWith(unknown), 503, 1);
      const before = Date.now();
      await s.client.callTool({ name: 'ack_question', arguments: { request_id: unknown } });
      const entry = readActive(stateDir).at(-1)!;
      expect(entry.request_id).toBe(unknown);
      expect(Date.parse(entry.answer_deadline)).toBeGreaterThanOrEqual(before + 86_400_000);
      expect(Date.parse(entry.answer_deadline)).toBeLessThanOrEqual(Date.now() + 86_400_000);
    } finally {
      await s.close();
    }
  });

  it('the asker channel records nothing, whatever the environment says', async () => {
    const s = await spawnServer('channel.js', {
      RELAY_URL: relay.url,
      RELAY_TEAM: 'demo',
      RELAY_TOKEN: TOKEN_OF.alice!,
      RELAY_ROLE: 'asker',
      ANSWERER_STATE_DIR: stateDir,
    });
    await s.close();
    expect(existsSync(join(stateDir, ACTIVE_FILE))).toBe(false);
  });
});

describe('dist/tool-event.js', () => {
  it('posts name, outcome and duration to the most recently acknowledged open request, and nothing else', async () => {
    const older = openRequest();
    const newer = openRequest();
    const a = new ActiveRequests(stateDir);
    await a.add(older, LATER);
    await a.add(newer, LATER);
    const run = await runHook(post('mcp__capabilities__staging_db_query'));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(relay.toolEvents).toHaveLength(1);
    const ev = relay.toolEvents[0]!;
    expect(ev.request_id).toBe(newer);
    expect(ev.member).toBe('bob');
    expect(ev.body).toEqual({ tool: 'staging_db_query', status: 'ok', duration_ms: 1234 });
    const req = relay.requests.at(-1)!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe(`/v1/teams/demo/requests/${newer}/events`);
    // Never the tool's input, output or error, even though the payload carried them.
    for (const r of relay.requests) {
      expect(r.raw + r.path + JSON.stringify([...r.query])).not.toMatch(/SECRET/);
    }
    expect(run.stderr).not.toMatch(/SECRET/);
  });

  it('posts waiting for a permission request, without the path or the suggested rule (M4-SPEC §2)', async () => {
    const id = openRequest();
    await new ActiveRequests(stateDir).add(id, LATER);
    const run = await runHook(permission('Read'));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(relay.toolEvents.map((e) => [e.request_id, e.body])).toEqual([[id, { tool: 'Read', status: 'waiting', duration_ms: null }]]);
    for (const r of relay.requests) expect(r.raw + r.path).not.toMatch(/SECRET/);
    expect(run.stderr).not.toMatch(/SECRET/);
  });

  it('sends nothing for a permission request outside any open request', async () => {
    const run = await runHook(permission('Read'));
    expect(run.code).toBe(0);
    expect(relay.requests).toHaveLength(0);
  });

  it('reports a failure as status error, without the error text', async () => {
    const id = openRequest();
    await new ActiveRequests(stateDir).add(id, LATER);
    const run = await runHook(failure('Read'));
    expect(run.code).toBe(0);
    expect(relay.toolEvents.map((e) => e.body)).toEqual([{ tool: 'Read', status: 'error', duration_ms: 7 }]);
    expect(relay.requests.map((r) => r.raw).join('')).not.toMatch(/SECRET/);
  });

  it("ignores the relay's own ack_question and reply", async () => {
    await new ActiveRequests(stateDir).add(openRequest(), LATER);
    for (const name of ['mcp__relay__ack_question', 'mcp__relay__reply']) {
      const run = await runHook(post(name));
      expect(run.code).toBe(0);
    }
    expect(relay.requests).toHaveLength(0);
  });

  it('sends nothing when no request is open', async () => {
    const run = await runHook(post('Read'));
    expect(run.code).toBe(0);
    expect(relay.requests).toHaveLength(0);
  });

  it('sends nothing for a request past its answer deadline (§7.6)', async () => {
    const stale = openRequest();
    await new ActiveRequests(stateDir).add(stale, PAST);
    const run = await runHook(post('Read'));
    expect(run.code).toBe(0);
    expect(relay.requests).toHaveLength(0);
  });

  it('exits 0 when the relay refuses or is down', async () => {
    const id = openRequest();
    await new ActiveRequests(stateDir).add(id, LATER);
    relay.fail((r) => r.path.endsWith('/events'), 500, 5);
    const refused = await runHook(post('Read'));
    expect(refused.code).toBe(0);
    expect(relay.requests.filter((r) => r.path.endsWith('/events'))).toHaveLength(1); // not retried: it appends
    await relay.stop();
    const down = await runHook(post('Read'));
    expect(down.code).toBe(0);
    expect(down.stdout).toBe('');
    relay = await new FakeRelay().start();
  });

  it('gives up after 3 s when the relay hangs, exit 0', async () => {
    const hung: Server = createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...cfg, relay_url: `http://127.0.0.1:${(hung.address() as AddressInfo).port}` }));
    await new ActiveRequests(stateDir).add(rqId(), LATER);
    try {
      const run = await runHook(post('Read'));
      expect(run.code).toBe(0);
      expect(run.ms).toBeGreaterThanOrEqual(2500);
      expect(run.ms).toBeLessThan(4500);
    } finally {
      hung.closeAllConnections();
      await new Promise<void>((r) => hung.close(() => r()));
    }
  });

  it('gives up after 3 s when stdin never closes, exit 0', async () => {
    await new ActiveRequests(stateDir).add(openRequest(), LATER);
    const run = await runHook(null, { closeStdin: false, raw: '{"hook_event_name":' });
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(4500);
    expect(relay.requests).toHaveLength(0);
  });

  it('exits 0 on bad input and a bad command line', async () => {
    await new ActiveRequests(stateDir).add(openRequest(), LATER);
    expect((await runHook(null, { raw: 'not json' })).code).toBe(0);
    expect((await runHook(post('Read'), { args: [] })).code).toBe(0);
    expect((await runHook(post('Read'), { args: ['--config', join(stateDir, 'missing.json')] })).code).toBe(0);
    expect(relay.requests).toHaveLength(0);
  });

  it('runs from the hook bin/answerer writes into settings.json', async () => {
    const home = join(realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-ans-'))), 'home');
    const r = spawnSync(join(PLUGIN_ROOT, 'bin', 'answerer'), ['--print-command'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        // The private XDG_CONFIG_HOME from test/helpers/isolate.ts: never this computer's answering lock.
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!,
        TMPDIR: mkdtempSync(join(tmpdir(), 'team-relay-ans-tmp-')),
        ANSWERER_HOME: home,
        RELAY_URL: relay.url,
        RELAY_TEAM: 'demo',
        RELAY_AUTH: 'token',
        RELAY_TOKEN: TOKEN_OF.bob!,
      },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    const id = openRequest();
    await new ActiveRequests(join(home, 'state')).add(id, LATER);
    for (const event of ['PermissionRequest', 'PostToolUse', 'PostToolUseFailure'] as const) {
      const hook = settings.hooks[event][0].hooks[0];
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(hook.command, hook.args, { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('close', resolve);
        const payload = event === 'PostToolUse' ? post('Glob') : event === 'PostToolUseFailure' ? failure('Glob') : permission('Glob');
        child.stdin.end(JSON.stringify(payload));
      });
      expect(code).toBe(0);
    }
    expect(relay.toolEvents.map((e) => [e.request_id, e.body])).toEqual([
      [id, { tool: 'Glob', status: 'waiting', duration_ms: null }],
      [id, { tool: 'Glob', status: 'ok', duration_ms: 1234 }],
      [id, { tool: 'Glob', status: 'error', duration_ms: 7 }],
    ]);
  });
});

describe('dist/tool-event.js with the stored sign-in (M5-SPEC §6)', () => {
  it('posts with the device credential named in its config', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-hook-cred-')));
    const credDir = join(dir, 'team-relay');
    mkdirSync(credDir, { mode: 0o700 });
    const credentials = join(credDir, 'credentials.json');
    const token = relay.mintCredential('bob');
    writeFileSync(credentials, JSON.stringify({ relay_url: relay.url, team: 'demo', member: 'bob', credential: token, expires_at: null }), { mode: 0o600 });
    writeFileSync(
      configPath,
      JSON.stringify({ relay_url: relay.url, relay_team: 'demo', relay_auth: 'credential', credentials_file: credentials, state_dir: stateDir }),
    );
    const id = openRequest();
    await new ActiveRequests(stateDir).add(id, LATER);
    const run = await runHook(post('Read'));
    expect(run.code).toBe(0);
    expect(relay.toolEvents.map((e) => [e.request_id, e.member])).toEqual([[id, 'bob']]);
    expect(relay.requests.at(-1)!.headers.authorization).toBe(`Bearer ${token}`);
    expect(run.stderr).not.toContain(token);
  });

  it('refuses a config without credentials_file for relay_auth credential', () => {
    expect(() => parseToolEventConfig({ relay_url: 'https://r.example.com', relay_team: 'demo', relay_auth: 'credential', state_dir: '/s' })).toThrow(
      /credentials_file/,
    );
  });
});
