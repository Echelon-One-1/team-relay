// M2-SPEC §4.4: the console server. Loopback only, Host check, per-launch key, strict CSP,
// a proxy of its reads (the roster changes are in console-roster.test.ts), static files or a placeholder, and --demo, whose
// synthetic stream must match the relay's §3.5 /activity and §3.1/§3.6 /directory shapes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import _Ajv from 'ajv';
import { CONTENT_SECURITY_POLICY, createConsoleServer, demoBackend, keyMatches, relayBackend, type ConsoleServer } from '../src/console-app.js';
import { DEMO_CYCLE_MS, DemoAccount, DemoTeam, SWEEP_LAG_MS, median3, stillOpen } from '../src/console-demo.js';
import { REDIRECT_TTL_MS, openInBrowser, redirectHtml, type Run } from '../src/console-open.js';
import { validateManifest } from '../src/manifest.js';
import { RelayClient, staticTokenProvider } from '../src/relay-client.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST } from './helpers/mcp.js';

const KEY = 'k'.repeat(43);

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any };

/** A raw HTTP request, so the Host header and method are exactly what the test says. */
function req(port: number, path: string, opts: { method?: string; host?: string | null; key?: string | null; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.host !== null) headers.Host = opts.host ?? `127.0.0.1:${port}`;
    if (opts.key !== null && opts.key !== undefined) headers['X-Console-Key'] = opts.key;
    const r = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

const api = (port: number, path: string, extra: Parameters<typeof req>[2] = {}) => req(port, path, { key: KEY, ...extra });

// ---------------------------------------------------------------------------------------
// The spec shapes (M2-SPEC §3.5, §3.1, §3.6 on M1-SPEC §3.4), strict: every field required,
// nothing extra.

const TIME = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$' };
const TIME_OR_NULL = { anyOf: [TIME, { type: 'null' }] };
const MEMBER = { type: 'string', pattern: '^[a-z][a-z0-9_]{1,31}$' };
const RECIPIENT = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'delivered_at', 'acked_at', 'answered_at', 'answer_delivered_at', 'tools', 'progress_count', 'last_progress_pct', 'answer_preview'],
  properties: {
    status: { enum: ['pending', 'acked', 'answered', 'no_response', 'timed_out'] },
    delivered_at: TIME_OR_NULL,
    acked_at: TIME_OR_NULL,
    answered_at: TIME_OR_NULL,
    answer_delivered_at: TIME_OR_NULL,
    tools: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tool', 'status', 'at', 'duration_ms'],
        properties: {
          tool: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,64}$' },
          // M4-SPEC §2: `waiting` while the member is asked to allow the tool.
          status: { enum: ['ok', 'error', 'waiting'] },
          at: TIME,
          duration_ms: { anyOf: [{ type: 'integer', minimum: 0, maximum: 3600000 }, { type: 'null' }] },
        },
      },
    },
    progress_count: { type: 'integer', minimum: 0 },
    last_progress_pct: { anyOf: [{ type: 'number', minimum: 0, maximum: 100 }, { type: 'null' }] },
    answer_preview: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }] },
  },
};
const ACTIVITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requests', 'next_since', 'server_time'],
  properties: {
    next_since: TIME,
    server_time: TIME,
    requests: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['request_id', 'kind', 'asker', 'broadcast', 'created_at', 'updated_at', 'ack_deadline', 'answer_deadline', 'expire_at', 'capability', 'question', 'recipients', 'participant'],
        properties: {
          request_id: { type: 'string', pattern: '^rq_[0-9a-f]{32}$' },
          kind: { enum: ['question', 'capability'] },
          asker: MEMBER,
          broadcast: { type: 'boolean' },
          created_at: TIME,
          updated_at: TIME,
          ack_deadline: TIME,
          answer_deadline: TIME,
          expire_at: TIME,
          capability: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'environment', 'params'],
                properties: {
                  name: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,62}$' },
                  environment: { enum: ['staging', 'production'] },
                  params: { anyOf: [{ type: 'object' }, { type: 'null' }] },
                },
              },
            ],
          },
          question: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          recipients: { type: 'object', minProperties: 1, propertyNames: MEMBER, additionalProperties: RECIPIENT },
          participant: { type: 'boolean' },
        },
      },
    },
  },
};
const DIRECTORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['members', 'stats_complete'],
  properties: {
    stats_complete: { type: 'boolean' },
    members: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['member', 'last_seen', 'manifest', 'published_at', 'sessions', 'stats', 'inbox_waiting'],
        properties: {
          member: MEMBER,
          last_seen: TIME_OR_NULL,
          manifest: { anyOf: [{ type: 'object', required: ['version', 'capabilities'] }, { type: 'null' }] },
          published_at: TIME_OR_NULL,
          sessions: {
            type: 'object',
            additionalProperties: false,
            required: ['working', 'answering'],
            properties: {
              working: { type: 'object', additionalProperties: false, required: ['last_seen'], properties: { last_seen: TIME_OR_NULL } },
              answering: { type: 'object', additionalProperties: false, required: ['last_seen'], properties: { last_seen: TIME_OR_NULL } },
            },
          },
          stats: {
            type: 'object',
            additionalProperties: false,
            required: ['asked', 'answered', 'open', 'median_answer_seconds'],
            properties: {
              asked: { type: 'integer', minimum: 0 },
              answered: { type: 'integer', minimum: 0 },
              open: { type: 'integer', minimum: 0 },
              median_answer_seconds: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
            },
          },
          inbox_waiting: { type: 'integer', minimum: 0, maximum: 50 },
        },
      },
    },
  },
};
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pending', 'more', 'oldest_at', 'from', 'answering'],
  properties: {
    pending: { type: 'integer', minimum: 0, maximum: 50 },
    more: { type: 'boolean' },
    oldest_at: TIME_OR_NULL,
    from: { type: 'array', maxItems: 5, items: MEMBER },
    answering: { type: 'object', additionalProperties: false, required: ['last_seen'], properties: { last_seen: TIME_OR_NULL } },
  },
};
const ME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['team', 'member', 'teammates'],
  // M6-SPEC §2 and M9-SPEC §2: the relay also says the viewer's role and the team's name.
  properties: {
    team: { type: 'string' },
    name: { type: 'string', minLength: 1, maxLength: 60 },
    member: MEMBER,
    role: { enum: ['owner', 'member'] },
    teammates: { type: 'array', items: MEMBER },
  },
};

// ajv ships CommonJS; under NodeNext the default import may be the module object.
type AjvCtor = typeof _Ajv.default;
const Ajv: AjvCtor = (_Ajv as unknown as { default?: AjvCtor }).default ?? (_Ajv as unknown as AjvCtor);
const ajv = new Ajv({ allErrors: true, strict: false });
const validActivity = ajv.compile(ACTIVITY_SCHEMA);
const validDirectory = ajv.compile(DIRECTORY_SCHEMA);
const validMe = ajv.compile(ME_SCHEMA);
const validSummary = ajv.compile(SUMMARY_SCHEMA);

function expectValid(validate: ReturnType<typeof ajv.compile>, value: unknown) {
  const ok = validate(value);
  expect(ok, ajv.errorsText(validate.errors)).toBe(true);
}

// ---------------------------------------------------------------------------------------

describe('console server: the gate', () => {
  let app: ConsoleServer;
  let port: number;
  let relay: FakeRelay;

  beforeEach(async () => {
    relay = await new FakeRelay().start();
    const client = new RelayClient({ url: relay.url, team: 'demo', token: staticTokenProvider(TOKEN_OF.alice!), attempts: 1 });
    app = createConsoleServer({ backend: relayBackend(client), key: KEY, staticDir: join(tmpdir(), 'team-relay-no-such-console') });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
    await relay.stop();
  });

  it('binds 127.0.0.1 only', () => {
    expect(app.server.address()).toMatchObject({ address: '127.0.0.1', port });
  });

  it('refuses any Host but 127.0.0.1:<port> and localhost:<port> (DNS rebinding)', async () => {
    for (const host of ['evil.example:' + port, `127.0.0.1:${port + 1}`, '127.0.0.1', `localhost.evil.example:${port}`, `[::1]:${port}`]) {
      for (const path of ['/', '/api/me']) {
        const r = await req(port, path, { host, key: KEY });
        expect(r.status, `${host} ${path}`).toBe(403);
      }
    }
    // No Host at all: Node's server refuses it itself (400) before the console sees it.
    expect([400, 403]).toContain((await req(port, '/api/me', { host: null, key: KEY })).status);
    expect((await api(port, '/api/me', { host: `localhost:${port}` })).status).toBe(200);
    expect((await api(port, '/api/me', { host: `LOCALHOST:${port}` })).status).toBe(200);
    expect((await api(port, '/api/me')).status).toBe(200);
    // Refused before anything reached the relay.
    expect(relay.requests.map((r) => r.path)).toEqual(['/v1/teams/demo/me', '/v1/teams/demo/me', '/v1/teams/demo/me']);
  });

  it('needs the key on /api: missing is 401, wrong is 403', async () => {
    expect((await req(port, '/api/me', { key: null })).status).toBe(401);
    expect((await req(port, '/api/me', { key: '' })).status).toBe(401);
    expect((await req(port, '/api/me', { key: 'x' })).status).toBe(403);
    expect((await req(port, '/api/me', { key: KEY.slice(1) })).status).toBe(403);
    expect((await req(port, '/api/me', { key: KEY + 'k' })).status).toBe(403);
    expect(relay.requests).toHaveLength(0);
    expect(keyMatches(KEY, KEY)).toBe(true);
    expect(keyMatches('', KEY)).toBe(false);
  });

  it('proxies exactly the read GETs, to the right relay paths', async () => {
    const id = relay.addRequest({ kind: 'question', asker: 'alice', question: 'q' });
    relay.enqueue('alice', 'inbox', { from: 'bob' });
    expect((await api(port, '/api/me')).json()).toEqual({ team: 'demo', member: 'alice', teammates: ['bob', 'carol'] });
    expect((await api(port, '/api/directory')).status).toBe(200);
    expect((await api(port, '/api/activity?since=2026-09-23T10:00:00Z&limit=50')).status).toBe(200);
    expect((await api(port, `/api/requests/${id}`)).json().request_id).toBe(id);
    // M7-SPEC §3: the viewer's own inbox summary, a peek that moves nothing.
    const summary = (await api(port, '/api/inbox/summary')).json();
    expect(summary).toMatchObject({ pending: 1, more: false, from: ['bob'], answering: { last_seen: null } });
    expect(relay.stream('alice', 'inbox').cursor).toBe(0);
    expect(relay.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/teams/demo/me',
      'GET /v1/teams/demo/directory',
      'GET /v1/teams/demo/activity',
      `GET /v1/teams/demo/requests/${id}`,
      'GET /v1/teams/demo/inbox/summary',
    ]);
    expect(Object.fromEntries(relay.requests[2]!.query)).toEqual({ since: '2026-09-23T10:00:00Z', limit: '50' });
    expect(relay.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN_OF.alice}`)).toBe(true);
  });

  it('proxies nothing else, and no method but GET', async () => {
    const id = relay.addRequest({ kind: 'question', asker: 'alice', question: 'q' });
    for (const path of [
      '/api',
      '/api/',
      '/api/streams/inbox',
      '/api/streams/replies',
      '/api/requests',
      `/api/requests/${id}/ack`,
      `/api/requests/${id}/reply`,
      `/api/requests/${id}/progress`,
      '/api/requests/../me',
      '/api/requests/rq_XYZ',
      '/api/members/alice/manifest',
      '/api/healthz',
      '/api/v1/teams/demo/me',
      '/api/inbox',
      '/api/inbox/summary/x',
      '/api/streams/inbox/cursor',
    ]) {
      expect([400, 404], path).toContain((await api(port, path)).status);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      for (const path of ['/api/me', `/api/requests/${id}`, `/api/requests/${id}/reply`, '/api/requests', '/api/inbox/summary']) {
        const r = await api(port, path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'HEAD' || method === 'OPTIONS' ? undefined : '{"text":"hi"}' }).catch((e: Error) => {
          throw new Error(`${method} ${path}: ${e.message}`);
        });
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.allow).toBe('GET');
      }
    }
    expect(relay.requests).toHaveLength(0);
    expect(relay.replies).toHaveLength(0);
  });

  it('checks the activity query before calling the relay', async () => {
    for (const q of ['?since=yesterday', '?limit=0', '?limit=201', '?limit=abc', '?foo=1', '?since=2026-09-23T10:00:00Z&since=2026-09-23T11:00:00Z']) {
      expect((await api(port, '/api/activity' + q)).status, q).toBe(400);
    }
    expect((await api(port, '/api/me?x=1')).status).toBe(400);
    expect((await api(port, '/api/inbox/summary?member=bob')).status).toBe(400);
    expect(relay.requests).toHaveLength(0);
  });

  it('refuses a cross-site fetch even with the key', async () => {
    expect((await api(port, '/api/me', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await api(port, '/api/me', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status).toBe(403);
    expect((await api(port, '/api/me', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
  });

  it('sets a strict CSP and no CORS headers on every response', async () => {
    const responses = [
      await req(port, '/'),
      await api(port, '/api/me'),
      await req(port, '/api/me', { key: null }),
      await api(port, '/api/nothing'),
      await api(port, '/api/me', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } }),
      await api(port, '/api/me', { headers: { Origin: 'https://evil.example' } }),
    ];
    for (const r of responses) {
      expect(r.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      for (const h of Object.keys(r.headers)) expect(h).not.toMatch(/^access-control-/);
    }
    expect(CONTENT_SECURITY_POLICY).toMatch(/^default-src 'self'; /);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe|http:|https:|\*/);
    expect(responses[1]!.headers['cache-control']).toBe('no-store');
  });

  it('maps relay failures without leaking anything', async () => {
    relay.fail((r) => r.path.endsWith('/directory'), 401, 1);
    // The relay's own code and detail (M6-SPEC §4: the Members panel shows why a change was refused).
    expect((await api(port, '/api/directory')).json()).toEqual({ error: 'relay_refused', relay_status: 401, relay_error: 'unauthenticated', detail: 'injected' });
    expect((await api(port, `/api/requests/rq_${'0'.repeat(32)}`)).status).toBe(404);
    await relay.stop();
    const down = await api(port, '/api/me');
    expect(down.status).toBe(502);
    expect(down.json().error).toBe('relay_unreachable');
    relay = await new FakeRelay().start();
  });

  it('serves a placeholder page when dist/console/ is missing', async () => {
    for (const path of ['/', '/index.html', '/anything']) {
      const r = await req(port, path);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/^text\/html/);
      expect(r.body).toMatch(/has not been built yet/);
      expect(r.body).not.toMatch(/<script|<style|style=|https?:\/\//);
    }
  });
});

describe('console server: static files', () => {
  let app: ConsoleServer;
  let port: number;
  let root: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-console-')));
    const site = join(root, 'console');
    mkdirSync(join(site, 'assets'), { recursive: true });
    writeFileSync(join(site, 'index.html'), '<!doctype html><title>console</title><script type="module" src="/assets/app.js"></script>');
    writeFileSync(join(site, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(site, 'assets', 'app.css'), 'body{}');
    writeFileSync(join(root, 'secret.txt'), 'outside the console directory');
    symlinkSync(join(root, 'secret.txt'), join(site, 'assets', 'link.txt'));
    app = createConsoleServer({ backend: demoBackend(new DemoAccount()), key: KEY, staticDir: site });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
  });

  it('serves the built console with types, and the app for client routes', async () => {
    const index = await req(port, '/');
    expect(index.body).toContain('<title>console</title>');
    expect(index.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    const js = await req(port, '/assets/app.js');
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    expect(js.headers['cache-control']).toMatch(/immutable/);
    expect((await req(port, '/assets/app.css')).headers['content-type']).toMatch(/^text\/css/);
    expect((await req(port, '/requests/abc')).body).toContain('<title>console</title>');
    // The console's own views (docs/SIGNIN-PAGE.md: /team, and /start where the sign-in page leads).
    for (const path of ['/team', '/start', '/join', '/ask', '/admin']) {
      const page = await req(port, path);
      expect(page.status, path).toBe(200);
      expect(page.body, path).toContain('<title>console</title>');
    }
    expect((await req(port, '/assets/missing.js')).status).toBe(404);
    const head = await req(port, '/assets/app.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect((await req(port, '/', { method: 'POST' })).status).toBe(405);
  });

  it('never serves anything outside dist/console/', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/%00', '/assets/%5c..%5csecret.txt']) {
      const r = await req(port, path);
      expect(r.body, path).not.toContain('outside the console directory');
      expect([400, 404], path).toContain(r.status);
    }
    const link = await req(port, '/assets/link.txt');
    expect(link.status).toBe(404);
    expect(link.body).not.toContain('outside');
  });
});

describe('console --demo backend', () => {
  it('serves /me, /directory and /activity in the spec shapes, all the way through a cycle', () => {
    let now = Date.parse('2026-09-23T10:00:30.000Z');
    const team = new DemoTeam(() => now);
    expectValid(validMe, team.me());
    expect(team.me()).toEqual({ team: 'demo', name: 'Demo', member: 'alice', role: 'owner', teammates: ['bob', 'carol'] });
    for (let step = 0; step < 130; step++) {
      expectValid(validActivity, team.activity({ limit: 200 }));
      expectValid(validDirectory, team.directory());
      now += 1000;
    }
  });

  it('produces the whole story: questions, a broadcast with a no_response, a capability call with tools and progress, a timed_out', () => {
    let now = Date.parse('2026-09-23T10:00:30.000Z');
    const team = new DemoTeam(() => now);
    now += 2 * DEMO_CYCLE_MS;
    const { requests } = team.activity({ limit: 200 });
    const statuses = requests.flatMap((r) => Object.values(r.recipients).map((x) => x.status));
    for (const s of ['answered', 'no_response', 'timed_out'] as const) expect(statuses).toContain(s);
    const broadcast = requests.find((r) => r.broadcast && Object.values(r.recipients).some((x) => x.status === 'no_response'));
    expect(broadcast?.kind).toBe('question');
    const cap = requests.find((r) => r.kind === 'capability' && r.participant);
    expect(cap?.capability).toMatchObject({ name: 'staging_db_query', environment: 'staging' });
    const bob = cap!.recipients.bob!;
    expect(bob.tools.map((t) => t.tool)).toContain('staging_db_query');
    expect(bob.progress_count).toBeGreaterThan(0);
    expect(bob.last_progress_pct).not.toBeNull();
    expect(bob.delivered_at && bob.acked_at && bob.answered_at && bob.answer_delivered_at).toBeTruthy();
    // Times move forward along each hop.
    expect(Date.parse(bob.delivered_at!)).toBeLessThan(Date.parse(bob.acked_at!));
    expect(Date.parse(bob.acked_at!)).toBeLessThan(Date.parse(bob.answered_at!));
    expect(Date.parse(bob.answered_at!)).toBeLessThan(Date.parse(bob.answer_delivered_at!));
    expect(requests.some((r) => Object.values(r.recipients).some((x) => x.tools.some((t) => t.status === 'error')))).toBe(true);
  });

  it('shows a waiting grant (M4-SPEC §2) that the next event for that tool clears, and shares by name (§3)', () => {
    const start = Date.parse('2026-09-23T10:00:30.000Z');
    let now = start;
    const team = new DemoTeam(() => now);
    const cycleStart = Math.floor(start / DEMO_CYCLE_MS) * DEMO_CYCLE_MS + DEMO_CYCLE_MS;
    const directedToBob = () =>
      team
        .activity({ since: new Date(cycleStart - 1).toISOString(), limit: 200 })
        .requests.find((r) => r.kind === 'question' && r.asker === 'alice' && Object.keys(r.recipients).join() === 'bob');
    now = cycleStart + 8000;
    const waiting = directedToBob()!;
    const bob = waiting.recipients.bob!;
    expect(bob.status).toBe('acked');
    expect(bob.tools.at(-1)).toEqual({ tool: 'Read', status: 'waiting', at: new Date(cycleStart + 5200).toISOString(), duration_ms: null });
    // The side surface lists it as a tool event with no duration, and never a path.
    const detail = team.request(waiting.request_id);
    expect(detail.progress.at(-1)).toMatchObject({ kind: 'tool', tool: 'Read', status: 'waiting', duration_ms: null });
    now = cycleStart + 17_000;
    const cleared = directedToBob()!.recipients.bob!;
    expect(cleared.tools.map((t) => [t.tool, t.status])).toEqual([
      ['Grep', 'ok'],
      ['Read', 'waiting'],
      ['Read', 'ok'],
    ]);
    const members = team.directory().members;
    for (const m of members) expect(() => validateManifest(m.manifest)).not.toThrow();
    expect(members.find((m) => m.member === 'bob')!.manifest!.shares).toEqual([{ name: 'orders-service' }, { name: 'runbooks' }]);
    expect(members.find((m) => m.member === 'carol')!.manifest!.shares).toEqual([]);
  });

  it('masks text and params for requests alice is not part of, and keeps name and environment', () => {
    let now = Date.parse('2026-09-23T10:00:30.000Z');
    const team = new DemoTeam(() => now);
    now += DEMO_CYCLE_MS;
    const { requests } = team.activity({ limit: 200 });
    const others = requests.filter((r) => !r.participant);
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) {
      expect(r.asker).not.toBe('alice');
      expect(Object.keys(r.recipients)).not.toContain('alice');
      expect(r.question).toBeNull();
      if (r.capability) {
        expect(r.capability.params).toBeNull();
        expect(r.capability.name).toMatch(/^[a-z_]+$/);
        expect(r.capability.environment).toBe('staging');
      }
      for (const x of Object.values(r.recipients)) expect(x.answer_preview).toBeNull();
    }
    const mine = requests.filter((r) => r.participant);
    // A recipient sees its own answer preview only; the asker sees them all.
    for (const r of mine.filter((x) => x.asker !== 'alice')) {
      for (const [m, x] of Object.entries(r.recipients)) if (m !== 'alice') expect(x.answer_preview).toBeNull();
    }
    expect(mine.some((r) => r.question !== null)).toBe(true);
    expect(mine.some((r) => r.capability?.params !== null && r.capability !== null)).toBe(true);
    expect(mine.some((r) => Object.values(r.recipients).some((x) => x.answer_preview !== null))).toBe(true);
    // A non-participant request cannot be read in detail either.
    expect(() => team.request(others[0]!.request_id)).toThrow(/not_found/);
  });

  it('pages the feed by updated_at: ascending, since-exclusive, next_since, and loops forever', () => {
    let now = Date.parse('2026-09-23T10:00:30.000Z');
    const team = new DemoTeam(() => now);
    const first = team.activity({ limit: 5 });
    expect(first.requests).toHaveLength(5);
    const times = first.requests.map((r) => Date.parse(r.updated_at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const second = team.activity({ since: first.next_since, limit: 200 });
    for (const r of second.requests) expect(Date.parse(r.updated_at)).toBeGreaterThan(Date.parse(first.next_since));
    // Nothing new without time passing; new activity once it does.
    const caughtUp = team.activity({ since: second.next_since });
    expect(caughtUp.requests).toEqual([]);
    expect(caughtUp.next_since).toBe(second.next_since);
    now += 5000;
    expect(team.activity({ since: second.next_since }).requests.length).toBeGreaterThan(0);
    now += 10 * DEMO_CYCLE_MS;
    const later = team.activity({ since: new Date(now - DEMO_CYCLE_MS).toISOString(), limit: 200 });
    expect(later.requests.length).toBeGreaterThanOrEqual(6);
    expect(() => team.activity({ since: 'nope' })).toThrow();
    expect(() => team.activity({ limit: 0 })).toThrow();
  });

  it('shows session presence and 24 h stats per teammate', () => {
    let now = Date.parse('2026-09-23T10:00:30.000Z');
    const team = new DemoTeam(() => now);
    now += 2 * DEMO_CYCLE_MS;
    const { members } = team.directory();
    expect(members.map((m) => m.member)).toEqual(['bob', 'carol']);
    const bob = members[0]!;
    expect(bob.manifest?.capabilities.map((c) => c.name)).toEqual(['staging_db_query']);
    expect(now - Date.parse(bob.sessions.answering.last_seen!)).toBeLessThan(45_000);
    expect(bob.last_seen).toBe([bob.sessions.working.last_seen!, bob.sessions.answering.last_seen!].sort().at(-1));
    expect(bob.stats.answered).toBeGreaterThan(0);
    expect(bob.stats.median_answer_seconds).toBeGreaterThan(0);
    const carol = members[1]!;
    expect(carol.manifest?.capabilities.map((c) => [c.name, c.environment])).toEqual([
      ['service_health', 'staging'],
      ['production_db_count', 'production'],
    ]);
    expect(carol.stats.asked).toBeGreaterThan(0);
  });

  it('serves request details as the asker (all recipients) and as a recipient (only itself)', () => {
    let now = Date.parse('2026-09-23T10:00:30.000Z');
    const team = new DemoTeam(() => now);
    now += DEMO_CYCLE_MS;
    const { requests } = team.activity({ limit: 200 });
    const asked = requests.find((r) => r.asker === 'alice' && r.kind === 'capability')!;
    const detail = team.request(asked.request_id) as Record<string, any>;
    expect(detail.recipients).toHaveProperty('bob');
    // M11-SPEC §4: the asker reads each recipient's full answer next to its preview.
    expect(Object.keys(detail.recipients.bob).sort()).toEqual(['acked_at', 'answer', 'answer_preview', 'answered_at', 'status']);
    for (const p of detail.progress) {
      expect(Object.keys(p).sort()).toEqual(['duration_ms', 'kind', 'member', 'pct', 'seq', 'status', 'text', 'time', 'tool']);
    }
    expect(detail.progress.map((p: { kind: string }) => p.kind).sort()).toEqual(['progress', 'progress', 'tool']);
    const broadcast = requests.find((r) => r.broadcast)!;
    const asRecipient = team.request(broadcast.request_id) as Record<string, any>;
    expect(Object.keys(asRecipient.recipients)).toEqual(['alice']);
    // A recipient reads its own state only, never the answer text.
    expect(Object.keys(asRecipient.recipients.alice).sort()).toEqual(['acked_at', 'answered_at', 'status']);
    expect(asRecipient.progress.every((p: { member: string }) => p.member === 'alice')).toBe(true);
  });

  it('stamps updated_at strictly increasing per request, on every change and only then (§7.1)', () => {
    let now = Date.parse('2026-09-23T10:00:30.000Z');
    const team = new DemoTeam(() => now);
    const seen = new Map<string, { updated: number; body: string }>();
    for (let step = 0; step < 1300; step++) {
      for (const r of team.activity({ since: new Date(now - 300_000).toISOString(), limit: 200 }).requests) {
        const { updated_at, ...rest } = r;
        const body = JSON.stringify(rest);
        const t = Date.parse(updated_at);
        const prev = seen.get(r.request_id);
        if (prev) {
          if (prev.body === body) expect(t).toBe(prev.updated);
          else expect(t).toBeGreaterThan(prev.updated);
        }
        seen.set(r.request_id, { updated: t, body });
      }
      now += 100;
    }
  });

  it('never splits a group of requests with the same updated_at across pages (§7.10)', () => {
    const start = Date.parse('2026-09-23T10:00:30.000Z');
    let now = start;
    const team = new DemoTeam(() => now);
    // Inside the moment carol's broadcast is created as her capability answer is returned.
    const cycleStart = Math.floor(start / DEMO_CYCLE_MS) * DEMO_CYCLE_MS + DEMO_CYCLE_MS;
    now = cycleStart + 48_400;
    const groupAt = new Date(cycleStart + 48_000).toISOString();
    const all = team.activity({ since: new Date(cycleStart).toISOString(), limit: 200 }).requests;
    const group = all.filter((r) => r.updated_at === groupAt);
    expect(group).toHaveLength(2);
    // A page of one that would end inside the group returns the whole group instead.
    const whole = team.activity({ since: new Date(cycleStart + 47_999).toISOString(), limit: 1 });
    expect(whole.requests.map((r) => r.request_id).sort()).toEqual(group.map((r) => r.request_id).sort());
    expect(whole.next_since).toBe(groupAt);
    // A page that reaches into the group is cut before it.
    const before = all.filter((r) => Date.parse(r.updated_at) < Date.parse(groupAt));
    const cut = team.activity({ since: new Date(cycleStart).toISOString(), limit: before.length + 1 });
    expect(cut.requests.map((r) => r.request_id)).toEqual(before.map((r) => r.request_id));
    expect(cut.next_since).toBe(before.at(-1)!.updated_at);
    const next = team.activity({ since: cut.next_since, limit: 1 });
    expect(next.requests.map((r) => r.updated_at)).toEqual([groupAt, groupAt]);
    // Paging with the smallest limit still visits every request exactly once.
    let since = new Date(cycleStart).toISOString();
    const visited: string[] = [];
    for (let i = 0; i < 100; i++) {
      const page = team.activity({ since, limit: 1 });
      if (page.requests.length === 0) break;
      visited.push(...page.requests.map((r) => r.request_id));
      since = page.next_since;
    }
    expect(visited).toEqual(all.map((r) => r.request_id));
    // Two changes to one request in the same millisecond: the second is stamped 1 ms later.
    now = cycleStart + 48_900;
    const fanned = team.activity({ since: groupAt, limit: 200 }).requests.find((r) => r.request_id === group.find((g) => g.asker === 'carol' && g.broadcast)!.request_id)!;
    expect(fanned.recipients.alice!.delivered_at).toBe(fanned.recipients.bob!.delivered_at);
    expect(Date.parse(fanned.updated_at)).toBe(Date.parse(fanned.recipients.bob!.delivered_at!) + 1);
  });

  it('computes the directory stats by the relay rules: stats_complete, effective open, answered_at, 3 decimals (§7.2, §7.10)', () => {
    const start = Date.parse('2026-09-23T10:00:30.000Z');
    let now = start;
    const team = new DemoTeam(() => now);
    const cycleStart = Math.floor(start / DEMO_CYCLE_MS) * DEMO_CYCLE_MS + DEMO_CYCLE_MS;
    // bob's broadcast (created at 15 s) has carol's ack deadline at 35 s; the sweep records
    // no_response a moment later, so at 36 s she is still stored as pending, but not open.
    now = cycleStart + 35_000 + SWEEP_LAG_MS / 2;
    const feed = team.activity({ limit: 200 }).requests;
    const stalePending = feed.filter((r) => Object.values(r.recipients).some((x) => x.status === 'pending' && now >= Date.parse(r.ack_deadline)));
    expect(stalePending.length).toBeGreaterThan(0);
    const dir = team.directory();
    expect(dir.stats_complete).toBe(true);
    expectValid(validDirectory, dir);
    const day = now - 86_400_000;
    for (const m of dir.members) {
      const mine = feed.filter((r) => r.recipients[m.member]);
      expect(m.stats.open).toBe(mine.filter((r) => stillOpen(r, r.recipients[m.member]!, now)).length);
      const answered = mine.filter((r) => r.recipients[m.member]!.answered_at !== null && Date.parse(r.recipients[m.member]!.answered_at!) >= day);
      expect(m.stats.answered).toBe(answered.length);
      expect(m.stats.median_answer_seconds).toBe(
        median3(answered.map((r) => (Date.parse(r.recipients[m.member]!.answered_at!) - Date.parse(r.created_at)) / 1000)),
      );
      expect(m.stats.asked).toBe(feed.filter((r) => r.asker === m.member).length);
    }
    // And after the sweep, the stored status says so too.
    now = cycleStart + 35_000 + SWEEP_LAG_MS + 1;
    const swept = team.activity({ limit: 200 }).requests.find((r) => r.request_id === stalePending[0]!.request_id)!;
    expect(Object.values(swept.recipients).map((x) => x.status)).toContain('no_response');
  });

  it('rounds the median to 3 decimals', () => {
    expect(median3([])).toBeNull();
    expect(median3([2.5])).toBe(2.5);
    expect(median3([1.0004, 1.0006, 9])).toBe(1.001);
    expect(median3([3, 1, 2, 4.1234])).toBe(2.5);
    expect(median3([1.23456])).toBe(1.235);
  });

  it("shows a recipient of a broadcast only its own answer preview, and the asker's other recipients' status", () => {
    const start = Date.parse('2026-09-23T10:00:30.000Z');
    let now = start;
    const team = new DemoTeam(() => now);
    now += 2 * DEMO_CYCLE_MS;
    const toAlice = team
      .activity({ limit: 200 })
      .requests.filter((r) => r.broadcast && r.asker === 'carol' && r.recipients.alice?.status === 'answered' && r.recipients.bob?.status === 'answered');
    expect(toAlice.length).toBeGreaterThan(0);
    for (const r of toAlice) {
      expect(r.participant).toBe(true);
      expect(r.question).not.toBeNull();
      expect(r.recipients.alice!.answer_preview).toMatch(/warm-up/);
      expect(r.recipients.bob!.answer_preview).toBeNull();
      expect(r.recipients.bob!.answered_at).not.toBeNull();
    }
  });

  it('through the server with --demo semantics: the same shapes over HTTP', async () => {
    const app = createConsoleServer({ backend: demoBackend(new DemoAccount()), key: KEY, staticDir: join(tmpdir(), 'none') });
    const port = await app.listen(0);
    try {
      expectValid(validActivity, (await api(port, '/api/activity')).json());
      expectValid(validDirectory, (await api(port, '/api/directory')).json());
      expectValid(validMe, (await api(port, '/api/me')).json());
      expectValid(validSummary, (await api(port, '/api/inbox/summary')).json());
      expect((await api(port, `/api/requests/rq_${'0'.repeat(32)}`)).status).toBe(404);
      expect((await api(port, '/api/activity?since=2026-01-01T00:00:00Z')).status).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/approvals/summary (M8-SPEC §5)', () => {
  it('the local console answers the count itself, behind the key; without a count source it is 404', async () => {
    let pending = 2;
    const app = createConsoleServer({ backend: demoBackend(new DemoAccount()), key: KEY, staticDir: join(tmpdir(), 'none'), approvals: () => ({ pending }) });
    const port = await app.listen(0);
    try {
      expect((await req(port, '/api/approvals/summary', { key: null })).status).toBe(401);
      expect((await api(port, '/api/approvals/summary')).json()).toEqual({ pending: 2 });
      pending = 0;
      expect((await api(port, '/api/approvals/summary')).json()).toEqual({ pending: 0 });
      expect((await api(port, '/api/approvals/summary?x=1')).status).toBe(400);
      expect((await api(port, '/api/approvals/summary', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status).toBe(405);
    } finally {
      await app.close();
    }
    const plain = createConsoleServer({ backend: demoBackend(new DemoAccount()), key: KEY, staticDir: join(tmpdir(), 'none') });
    const p2 = await plain.listen(0);
    try {
      expect((await api(p2, '/api/approvals/summary')).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe('dist/console-server.js', () => {
  function start(args: string[], env: Record<string, string> = {}) {
    const child = spawn(process.execPath, [join(DIST, 'console-server.js'), ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '', CONSOLE_PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const exited = new Promise<number | null>((r) => child.on('close', r));
    return { child, out: () => stdout, err: () => stderr, exited };
  }

  it('--demo prints http://127.0.0.1:<port>/#k=<32-byte key>, and the key opens the API', async () => {
    const p = start(['--demo']);
    try {
      const deadline = Date.now() + 10_000;
      while (!p.out().includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      const url = p.out().trim();
      const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#k=([A-Za-z0-9_-]{43})$/.exec(url);
      expect(m, url).not.toBeNull();
      const port = Number(m![1]);
      const key = m![2]!;
      expect(Buffer.from(key, 'base64url')).toHaveLength(32);
      const ok = await req(port, '/api/directory', { key });
      expect(ok.status).toBe(200);
      expectValid(validDirectory, ok.json());
      expect((await req(port, '/api/directory', { key: KEY })).status).toBe(403);
      expect(p.err()).not.toContain(key);
    } finally {
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
    }
  });

  it('makes a new key per launch', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      const p = start(['--demo']);
      const deadline = Date.now() + 10_000;
      while (!p.out().includes('\n') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      keys.push(p.out().trim().split('#k=')[1]!);
      p.child.kill('SIGTERM');
      await p.exited;
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('refuses an unknown argument, a bad port, and a missing relay configuration', async () => {
    const bad = start(['--send']);
    expect(await bad.exited).toBe(2);
    const port = start(['--demo'], { CONSOLE_PORT: '70000' });
    expect(await port.exited).toBe(1);
    expect(port.err()).toMatch(/CONSOLE_PORT/);
    const unconfigured = start([], { RELAY_AUTH: 'token' });
    expect(await unconfigured.exited).toBe(1);
    expect(unconfigured.err()).toMatch(/configuration error/);
  });
});

describe('--open (M2-SPEC §7.7): the key never appears in a process argument', () => {
  const URL_WITH_KEY = `http://127.0.0.1:4317/#k=${'Kx_-'.repeat(10)}abc`;
  const KEY_PART = URL_WITH_KEY.split('#k=')[1]!;

  function stubRun() {
    const calls: Array<{ command: string; args: string[]; content: string; fileMode: number; dirMode: number }> = [];
    const run: Run = (command, args, done) => {
      const file = args[0]!;
      calls.push({
        command,
        args,
        content: readFileSync(file, 'utf8'),
        fileMode: statSync(file).mode & 0o777,
        dirMode: statSync(join(file, '..')).mode & 0o777,
      });
      done(null);
    };
    return { run, calls };
  }

  it('hands the opener a mode-600 redirect file in a private mode-700 directory, never the URL', () => {
    const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-open-')));
    const { run, calls } = stubRun();
    const logs: string[] = [];
    const file = openInBrowser(URL_WITH_KEY, { log: (m) => logs.push(m), platform: 'darwin', tmpRoot, run });
    expect(file).not.toBeNull();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('open');
    expect(call.args).toEqual([file]);
    expect(call.args.join(' ')).not.toContain(KEY_PART);
    expect(call.args.join(' ')).not.toContain('#k=');
    expect(file!.startsWith(tmpRoot + '/team-relay-console-')).toBe(true);
    expect(call.fileMode).toBe(0o600);
    expect(call.dirMode).toBe(0o700);
    expect(call.content).toContain(`<meta http-equiv="refresh" content="0;url=${URL_WITH_KEY}">`);
    expect(call.content).not.toMatch(/<script|https?:\/\/(?!127\.0\.0\.1)/);
    expect(logs.join('\n')).not.toContain(KEY_PART);
  });

  it('uses xdg-open on Linux, and opens nothing where there is no opener', () => {
    const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-open-')));
    const { run, calls } = stubRun();
    openInBrowser(URL_WITH_KEY, { log: () => {}, platform: 'linux', tmpRoot, run });
    expect(calls.map((c) => c.command)).toEqual(['xdg-open']);
    const logs: string[] = [];
    expect(openInBrowser(URL_WITH_KEY, { log: (m) => logs.push(m), platform: 'win32', tmpRoot, run })).toBeNull();
    expect(calls).toHaveLength(1);
    expect(logs.join('')).toMatch(/no browser opener on this platform/);
  });

  it('deletes the file and its directory after 10 s', async () => {
    expect(REDIRECT_TTL_MS).toBe(10_000);
    const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-open-')));
    const { run } = stubRun();
    const file = openInBrowser(URL_WITH_KEY, { log: () => {}, platform: 'darwin', tmpRoot, run, deleteAfterMs: 50 })!;
    expect(existsSync(file)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(file, '..'))).toBe(false);
  });

  it('escapes the URL in the page', () => {
    expect(redirectHtml('http://127.0.0.1:1/#k="><x')).toContain('url=http://127.0.0.1:1/#k=&#34;&#62;&#60;x');
  });

  it('dist/console-server.js --open runs the opener with the redirect file only', async () => {
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-opener-')));
    const record = join(bin, 'record');
    mkdirSync(record);
    // A stand-in for open / xdg-open: records its arguments and what the file says.
    const stub = `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}/args"\ncat "$1" > "${record}/content"\nls -ld "$(dirname "$1")" > "${record}/dir"\n: > "${record}/done"\n`;
    for (const name of ['open', 'xdg-open']) {
      writeFileSync(join(bin, name), stub);
      chmodSync(join(bin, name), 0o755);
    }
    const child = spawn(process.execPath, [join(DIST, 'console-server.js'), '--demo', '--open'], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '/tmp', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '', CONSOLE_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    let closed = false;
    const exited = new Promise<number | null>((r) =>
      child.on('close', (code) => {
        closed = true;
        r(code);
      }),
    );
    try {
      // Both have to have happened: the URL line reached this test's end of the pipe (it may
      // come after the opener ran) and the opener finished. No deadline here: the test's own
      // timeout bounds the wait; a server that exited instead ends it at once.
      while (!(existsSync(join(record, 'done')) && out.includes('\n'))) {
        if (closed) throw new Error(`the console server exited early: ${out}`);
        await new Promise((r) => setTimeout(r, 25));
      }
      const url = out.trim();
      const key = url.split('#k=')[1]!;
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const args = readFileSync(join(record, 'args'), 'utf8').trim().split('\n');
      expect(args).toHaveLength(1);
      expect(args[0]).toMatch(/\/team-relay-console-[^/]+\/console\.html$/);
      expect(args[0]).not.toContain(key);
      expect(readFileSync(join(record, 'content'), 'utf8')).toContain(`url=${url}"`);
      expect(readFileSync(join(record, 'dir'), 'utf8')).toMatch(/^drwx------/);
    } finally {
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
    }
    // Gone once the server exits, even before the 10 s are up.
    const file = readFileSync(join(record, 'args'), 'utf8').trim();
    expect(existsSync(file)).toBe(false);
  });
});
