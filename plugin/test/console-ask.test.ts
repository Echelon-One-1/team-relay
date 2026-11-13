// M11-SPEC §2, §3, §4, §6: what the console server adds for guided joining and asking from the
// browser. Reads: GET /api/acceptance (the viewer's own acceptance of the boundaries), GET
// /api/members-status (every member's setup progress) and GET /api/my-requests (the viewer's
// last 20 questions). Changes: PUT /api/acceptance {version} (the viewer accepts the current
// boundaries for themselves) and POST /api/ask {to, question} (a question, never a capability
// call), under the write rules every other change follows: the method, Sec-Fetch-Site:
// same-origin, a JSON content type, no query but `team`, a body cap and a strict body check
// before anything reaches the relay. Hosted, every one is sent as the delegate on behalf of the
// IAP-verified viewer; nothing from the browser names who the call is for.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASK_BODY_LIMIT,
  BodyError,
  checkAcceptance,
  checkAsk,
  createConsoleServer,
  demoBackend,
  joinInfo,
  relayBackend,
  type ConsoleServer,
} from '../src/console-app.js';
import { DemoAccount } from '../src/console-demo.js';
import { RelayClient } from '../src/relay-client.js';

const KEY = 'k'.repeat(43);
const NO_UI = join(tmpdir(), 'team-relay-no-ui-here');
const PUBLIC_HOST = 'team.example.com';
const SALT = 'a-salt-of-at-least-32-characters-0123';
const SAME_ORIGIN = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

type Res = { status: number; body: string; headers: IncomingMessage['headers']; json: () => any };

function call(port: number, path: string, opts: { method?: string; host?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (payload !== undefined) headers['Content-Length'] = String(Buffer.byteLength(payload));
    const r = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers, json: () => JSON.parse(body) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

describe('checkAcceptance (M11-SPEC §2)', () => {
  it('takes exactly {"version": <whole number>}', () => {
    expect(checkAcceptance({ version: 3 })).toBe(3);
    expect(checkAcceptance({ version: 0 })).toBe(0);
  });
  const bad: Array<[string, unknown]> = [
    ['not an object', [3]],
    ['null', null],
    ['no version', {}],
    ['a string version', { version: '3' }],
    ['a fractional version', { version: 1.5 }],
    ['a negative version', { version: -1 }],
    ['a version over 2^31-1', { version: 2 ** 31 }],
    ['an unknown field', { version: 1, member: 'bob' }],
    ['a member named for someone else', { version: 1, on_behalf_of: 'bob@example.com' }],
  ];
  it.each(bad)('refuses %s', (_why, raw) => {
    expect(() => checkAcceptance(raw)).toThrow(BodyError);
  });
});

describe('checkAsk (M11-SPEC §4)', () => {
  it('takes {to: "*" | members, question} and keeps the question as typed', () => {
    expect(checkAsk({ to: '*', question: 'Where is the runbook?' })).toEqual({ to: '*', question: 'Where is the runbook?' });
    expect(checkAsk({ to: ['bob', 'carol'], question: '  two\nlines  ' })).toEqual({ to: ['bob', 'carol'], question: '  two\nlines  ' });
    // Counted in characters, not UTF-16 units: 8000 emoji pass.
    expect(checkAsk({ to: ['bob'], question: '\u{1F600}'.repeat(8000) }).question).toHaveLength(16000);
    expect(checkAsk({ to: Array.from({ length: 64 }, (_, i) => `m${i}`), question: 'q' }).to).toHaveLength(64);
  });
  const bad: Array<[string, unknown]> = [
    ['not an object', 'hi'],
    ['no question', { to: '*' }],
    ['an empty question', { to: '*', question: '' }],
    ['a blank question', { to: '*', question: ' \n\t ' }],
    ['a question of 8001 characters', { to: '*', question: 'x'.repeat(8001) }],
    ['a question that is not text', { to: '*', question: 42 }],
    ['a lone surrogate', { to: '*', question: 'a\ud800b' }],
    ['no to', { question: 'q' }],
    ['to as one member, not a list', { to: 'bob', question: 'q' }],
    ['an empty list', { to: [], question: 'q' }],
    ['65 members', { to: Array.from({ length: 65 }, (_, i) => `m${i}`), question: 'q' }],
    ['a member named twice', { to: ['bob', 'bob'], question: 'q' }],
    ['a bad member id', { to: ['Bob'], question: 'q' }],
    ['a member id that is not text', { to: [7], question: 'q' }],
    ['a capability call', { to: ['bob'], question: 'q', capability: { name: 'x', params: {} } }],
    ['a kind', { to: ['bob'], question: 'q', kind: 'capability' }],
    ['a sender', { to: ['bob'], question: 'q', from: 'carol' }],
    ['an idempotency key from the page', { to: ['bob'], question: 'q', idempotency_key: 'abcdefgh' }],
    ['timeouts', { to: ['bob'], question: 'q', answer_timeout_seconds: 60 }],
  ];
  it.each(bad)('refuses %s', (_why, raw) => {
    expect(() => checkAsk(JSON.parse(JSON.stringify(raw)) as unknown)).toThrow(BodyError);
  });
  it('refuses a lone surrogate sent as a JSON escape', () => {
    expect(() => checkAsk(JSON.parse('{"to":"*","question":"a\\ud800"}'))).toThrow(BodyError);
  });
  it('the cap fits the largest valid body, every character escaped', () => {
    const widest = { to: Array.from({ length: 64 }, (_, i) => `${'m'.repeat(29)}${String(i).padStart(3, '0')}`), question: '\u{1F600}'.repeat(8000) };
    const text = JSON.stringify(widest).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    expect(() => checkAsk(JSON.parse(text))).not.toThrow();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(ASK_BODY_LIMIT);
  });
});

describe('local console: acceptance, members status, asking (demo account)', () => {
  let app: ConsoleServer;
  let port: number;
  let t = Date.parse('2026-11-10T09:00:00.000Z');
  const local = (path: string, opts: Parameters<typeof call>[2] = {}) =>
    call(port, path, { ...opts, headers: { 'X-Console-Key': KEY, ...(opts.headers ?? {}) } });
  const send = (method: string, path: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN) => local(path, { method, headers, body });

  beforeEach(async () => {
    t = Date.parse('2026-11-10T09:00:00.000Z');
    app = createConsoleServer({ backend: demoBackend(new DemoAccount(() => t)), key: KEY, staticDir: NO_UI, join: joinInfo('https://relay.example', 'demo', null) });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET /api/acceptance: the version the viewer accepted; PUT accepts the current one for the viewer', async () => {
    const before = await local('/api/acceptance');
    expect(before.status).toBe(200);
    const bounds = (await local('/api/boundaries')).json();
    expect(before.json().version).toBeLessThan(bounds.version);
    const put = await send('PUT', '/api/acceptance', { version: bounds.version });
    expect(put.status).toBe(200);
    expect(put.json()).toEqual({ version: bounds.version, accepted_at: new Date(t).toISOString() });
    expect((await local('/api/acceptance')).json().version).toBe(bounds.version);
    // members-status shows it too.
    const st = (await local('/api/members-status')).json();
    expect(st.members.find((m: { member: string }) => m.member === 'alice').accepted_version).toBe(bounds.version);
  });

  it('PUT /api/acceptance: a version other than the current one is a conflict; a team without boundaries is not_set', async () => {
    const stale = await send('PUT', '/api/acceptance', { version: 1 });
    expect(stale.status).toBe(502);
    expect(stale.json()).toMatchObject({ error: 'relay_refused', relay_status: 409, relay_error: 'version_conflict' });
    const none = await send('PUT', '/api/acceptance?team=research', { version: 0 });
    expect(none.json()).toMatchObject({ relay_status: 409, relay_error: 'not_set' });
    expect((await local('/api/acceptance?team=research')).json()).toEqual({ version: 0, accepted_at: null });
  });

  it('PUT /api/acceptance follows every write rule before anything is sent', async () => {
    const body = { version: 2 };
    const post = await send('POST', '/api/acceptance', body);
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, PUT');
    expect((await send('PUT', '/api/acceptance', body, { 'Content-Type': 'application/json' })).status).toBe(403);
    expect((await send('PUT', '/api/acceptance', body, { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await send('PUT', '/api/acceptance', body, { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(415);
    expect((await call(port, '/api/acceptance', { method: 'PUT', headers: SAME_ORIGIN, body })).status).toBe(401);
    expect((await send('PUT', '/api/acceptance?member=bob', body)).status).toBe(400);
    expect((await send('PUT', '/api/acceptance', { version: 2, member: 'bob' })).status).toBe(400);
    expect((await send('PUT', '/api/acceptance', '{nope')).status).toBe(400);
    expect((await send('PUT', '/api/acceptance', JSON.stringify({ version: 2, pad: 'x'.repeat(5000) }))).status).toBe(413);
    const other = await send('PUT', '/api/acceptance?team=ops', body);
    expect(other.status).toBe(403);
    expect(other.json()).toMatchObject({ error: 'not_on_team', team: 'ops' });
    // Nothing was accepted.
    expect((await local('/api/acceptance')).json().version).toBe(1);
  });

  it("GET /api/members-status: every active member's status, whether they answer now, and the boundaries version", async () => {
    const r = await local('/api/members-status');
    expect(r.status).toBe(200);
    const b = r.json();
    expect(b.boundaries_version).toBe((await local('/api/boundaries')).json().version);
    expect(b.members.map((m: { member: string }) => m.member)).toEqual(['alice', 'bob', 'carol']);
    for (const m of b.members) {
      expect(typeof m.answering).toBe('boolean');
      expect(Number.isInteger(m.accepted_version)).toBe(true);
      expect(Object.keys(m).sort()).toEqual(['accepted_version', 'answering', 'folder_count', 'member', 'status']);
      expect(m.folder_count === null || Number.isInteger(m.folder_count)).toBe(true);
      if (m.status !== null) {
        // The status never carries folder counts or paths.
        expect(Object.keys(m.status).sort()).toEqual(['claude', 'daemon', 'seen_at', 'self_test']);
      }
    }
    // A quiet team: nobody has run the setup yet.
    const quiet = (await local('/api/members-status?team=research')).json();
    expect(quiet.members.every((m: { status: unknown; answering: boolean; folder_count: unknown }) => m.status === null && !m.answering && m.folder_count === null)).toBe(true);
    expect((await local('/api/members-status?x=1')).status).toBe(400);
    expect((await local('/api/members-status?team=ops')).status).toBe(403);
  });

  it('POST /api/ask: a question to teammates; it is listed first in my-requests and answered over time', async () => {
    const r = await send('POST', '/api/ask', { to: ['bob', 'carol'], question: 'Who owns the <b>invoice</b> export?\nAnd its retries?' });
    expect(r.status).toBe(201);
    const { request_id, recipients } = r.json();
    expect(request_id).toMatch(/^rq_[0-9a-f]{32}$/);
    expect(recipients).toEqual(['bob', 'carol']);
    const mine = (await local('/api/my-requests')).json();
    expect(mine.requests[0]).toEqual({
      id: request_id,
      to: ['bob', 'carol'],
      created_at: new Date(t).toISOString(),
      question_preview: 'Who owns the <b>invoice</b> export?\nAnd its retries?',
    });
    expect(mine.requests.length).toBeLessThanOrEqual(20);
    const first = (await local(`/api/requests/${request_id}`)).json();
    expect(first.question).toBe('Who owns the <b>invoice</b> export?\nAnd its retries?');
    expect(first.recipients.bob.status).toBe('pending');
    t += 60_000;
    const later = (await local(`/api/requests/${request_id}`)).json();
    expect(later.recipients.bob).toMatchObject({ status: 'answered' });
    expect(typeof later.recipients.bob.answer).toBe('string');
    expect(later.recipients.bob.answer.length).toBeGreaterThan(0);
    expect(later.recipients.bob.answer_preview).toBe(later.recipients.bob.answer.slice(0, 2000));
    // Everyone: the relay names the recipients.
    const all = (await send('POST', '/api/ask', { to: '*', question: 'Anyone?' })).json();
    expect(all.recipients).toEqual(['bob', 'carol']);
    expect((await local('/api/my-requests')).json().requests[0]).toMatchObject({ id: all.request_id, to: '*' });
  });

  it("POST /api/ask: the relay's refusal of someone not on the team is passed on", async () => {
    const r = await send('POST', '/api/ask', { to: ['zed'], question: 'q' });
    expect(r.status).toBe(502);
    expect(r.json()).toMatchObject({ error: 'relay_refused', relay_status: 400, relay_error: 'bad_recipients' });
  });

  it('POST /api/ask follows every write rule before anything is sent', async () => {
    const body = { to: ['bob'], question: 'q' };
    const get = await send('PUT', '/api/ask', body);
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await send('POST', '/api/ask', body, { 'Content-Type': 'application/json' })).status).toBe(403);
    expect((await send('POST', '/api/ask', body, { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(415);
    expect((await call(port, '/api/ask', { method: 'POST', headers: SAME_ORIGIN, body })).status).toBe(401);
    expect((await send('POST', '/api/ask?to=bob', body)).status).toBe(400);
    const cap = await send('POST', '/api/ask', { ...body, capability: { name: 'staging_db_query', params: {} } });
    expect(cap.status).toBe(400);
    expect(cap.json().detail).toMatch(/unknown field/);
    expect((await send('POST', '/api/ask', JSON.stringify({ ...body, question: 'x'.repeat(ASK_BODY_LIMIT) }))).status).toBe(413);
    expect((await send('POST', '/api/ask?team=ops', body)).status).toBe(403);
    // Nothing was asked.
    expect((await local('/api/my-requests')).json().requests.some((q: { question_preview: string }) => q.question_preview === 'q')).toBe(false);
  });
});

/** A relay that records what the console sends, for the hosted (delegate) path. */
class FakeRelay {
  seen: Array<{ method: string; path: string; search: string; headers: IncomingMessage['headers']; body: unknown }> = [];
  url = '';
  next: { status: number; body: unknown } | null = null;
  private server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      this.seen.push({ method: req.method ?? '', path: url.pathname, search: url.search, headers: req.headers, body: text ? (JSON.parse(text) as unknown) : undefined });
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (url.pathname === '/v1/me/teams') {
        return json(200, { teams: [{ team: 'research', name: 'Research', member: 'alice', role: 'member' }], invitations: [], admin: false });
      }
      if (this.next) {
        const n = this.next;
        this.next = null;
        return json(n.status, n.body);
      }
      const p = url.pathname;
      if (p === '/v1/teams/research/me/acceptance' && req.method === 'GET') return json(200, { version: 1, accepted_at: '2026-11-09T10:00:00Z' });
      if (p === '/v1/teams/research/me/acceptance' && req.method === 'PUT') {
        return json(200, { version: (JSON.parse(text) as { version: number }).version, accepted_at: '2026-11-10T10:00:00Z' });
      }
      if (p === '/v1/teams/research/members/status') return json(200, { members: [{ member: 'alice', status: null, answering: false, accepted_version: 1 }], boundaries_version: 2 });
      if (p === '/v1/teams/research/me/requests') return json(200, { requests: [] });
      if (p === '/v1/teams/research/requests' && req.method === 'POST') {
        return json(201, { request_id: `rq_${'a'.repeat(32)}`, recipients: ['bob'], created: true });
      }
      if (p === `/v1/teams/research/requests/rq_${'a'.repeat(32)}`) {
        return json(200, {
          request_id: `rq_${'a'.repeat(32)}`,
          kind: 'question',
          asker: 'alice',
          question: 'q',
          recipients: { bob: { status: 'answered', acked_at: 'x', answered_at: 'y', answer_preview: 'short', answer: 'short and then the whole answer' } },
          progress: [],
        });
      }
      return json(404, { error: 'not_found' });
    });
  });
  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  close() {
    return new Promise<void>((r) => {
      this.server.closeAllConnections();
      this.server.close(() => r());
    });
  }
}

describe('hosted console: the M11 routes go to the relay as the delegate, for the IAP viewer', () => {
  let relay: FakeRelay;
  let app: ConsoleServer;
  let port: number;
  const as = (who: string, path: string, opts: Parameters<typeof call>[2] = {}) =>
    call(port, path, { ...opts, host: PUBLIC_HOST, headers: { 'x-goog-iap-jwt-assertion': `iap:${who}`, ...(opts.headers ?? {}) } });
  const sent = (method: string, path: string) => relay.seen.filter((s) => s.method === method && s.path === path);

  beforeEach(async () => {
    relay = await new FakeRelay().start();
    const client = new RelayClient({ url: relay.url, team: 'research', token: () => 'service-account-id-token', attempts: 1 });
    app = createConsoleServer({
      backend: relayBackend(client),
      staticDir: NO_UI,
      join: joinInfo('https://relay.example', 'research', null),
      hosted: { publicHost: PUBLIC_HOST, verify: async (a) => (a?.startsWith('iap:') ? { email: a.slice(4) } : null), ipHashSalt: SALT },
    });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
    await relay.close();
  });

  it('the reads: acceptance, members status and my requests (the last 20)', async () => {
    expect((await as('alice@example.com', '/api/acceptance')).json()).toEqual({ version: 1, accepted_at: '2026-11-09T10:00:00Z' });
    expect((await as('alice@example.com', '/api/members-status')).json()).toMatchObject({ boundaries_version: 2 });
    expect((await as('alice@example.com', '/api/my-requests')).json()).toEqual({ requests: [] });
    for (const [path, search] of [
      ['/v1/teams/research/me/acceptance', ''],
      ['/v1/teams/research/members/status', ''],
      ['/v1/teams/research/me/requests', '?limit=20'],
    ] as const) {
      const s = sent('GET', path);
      expect(s).toHaveLength(1);
      expect(s[0]!.search).toBe(search);
      expect(s[0]!.headers['x-relay-on-behalf-of']).toBe('alice@example.com');
    }
    // Without IAP: nothing.
    expect((await call(port, '/api/acceptance', { host: PUBLIC_HOST })).status).toBe(401);
  });

  it('PUT /api/acceptance sends {version} only, on behalf of the viewer', async () => {
    const r = await as('alice@example.com', '/api/acceptance', { method: 'PUT', headers: SAME_ORIGIN, body: { version: 2 } });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ version: 2, accepted_at: '2026-11-10T10:00:00Z' });
    const s = sent('PUT', '/v1/teams/research/me/acceptance');
    expect(s).toHaveLength(1);
    expect(s[0]!.body).toEqual({ version: 2 });
    expect(s[0]!.headers['x-relay-on-behalf-of']).toBe('alice@example.com');
  });

  it('POST /api/ask becomes a question to the relay with a fresh idempotency key; nothing else is sent', async () => {
    const r = await as('alice@example.com', '/api/ask', { method: 'POST', headers: SAME_ORIGIN, body: { to: ['bob'], question: 'Where is it?' } });
    expect(r.status).toBe(201);
    expect(r.json()).toMatchObject({ request_id: `rq_${'a'.repeat(32)}`, recipients: ['bob'] });
    await as('alice@example.com', '/api/ask', { method: 'POST', headers: SAME_ORIGIN, body: { to: '*', question: 'Again?' } });
    const s = sent('POST', '/v1/teams/research/requests');
    expect(s).toHaveLength(2);
    const [a, b] = s.map((x) => x.body as Record<string, unknown>);
    expect(Object.keys(a!).sort()).toEqual(['idempotency_key', 'kind', 'question', 'to']);
    expect(a).toMatchObject({ kind: 'question', to: ['bob'], question: 'Where is it?' });
    expect(b).toMatchObject({ kind: 'question', to: '*', question: 'Again?' });
    expect(a!.idempotency_key).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(a!.idempotency_key).not.toBe(b!.idempotency_key);
    expect(s[0]!.headers['x-relay-on-behalf-of']).toBe('alice@example.com');
  });

  it('GET /api/requests/{id} passes the full answer through to the asker', async () => {
    const r = await as('alice@example.com', `/api/requests/rq_${'a'.repeat(32)}`);
    expect(r.json().recipients.bob).toMatchObject({ answer_preview: 'short', answer: 'short and then the whole answer' });
  });

  it("passes the relay's refusals on, in the console's shape", async () => {
    relay.next = { status: 409, body: { error: 'version_conflict', detail: 'The boundaries changed.' } };
    const conflict = await as('alice@example.com', '/api/acceptance', { method: 'PUT', headers: SAME_ORIGIN, body: { version: 1 } });
    expect(conflict.status).toBe(502);
    expect(conflict.json()).toMatchObject({ error: 'relay_refused', relay_status: 409, relay_error: 'version_conflict' });
    relay.next = { status: 403, body: { error: 'forbidden', detail: 'The console may not ask for members here.' } };
    const scope = await as('alice@example.com', '/api/ask', { method: 'POST', headers: SAME_ORIGIN, body: { to: '*', question: 'q' } });
    expect(scope.json()).toMatchObject({ error: 'relay_refused', relay_status: 403 });
    relay.next = { status: 429, body: { error: 'rate_limited' } };
    expect((await as('alice@example.com', '/api/ask', { method: 'POST', headers: SAME_ORIGIN, body: { to: '*', question: 'q' } })).json()).toMatchObject({
      relay_status: 429,
    });
    relay.next = { status: 403, body: { error: 'not_a_member' } };
    const gone = await as('alice@example.com', '/api/members-status');
    expect(gone.status).toBe(403);
    expect(gone.json()).toMatchObject({ error: 'not_on_team' });
  });

  it("a relay without the routes (404 on a read) reads as not found, not as 'not on the team'", async () => {
    for (const path of ['/api/acceptance', '/api/members-status', '/api/my-requests']) {
      relay.next = { status: 404, body: { detail: 'Not Found' } };
      const r = await as('alice@example.com', path);
      expect(r.status).toBe(404);
      expect(r.json()).toEqual({ error: 'not_found' });
    }
  });
});
