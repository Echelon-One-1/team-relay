// A team's boundaries in the console (schema v3, 13 Nov 2026: the topic alone). GET
// /api/boundaries reads them (any member); PUT /api/boundaries replaces them (owners) under
// every write rule the other changes follow: the method, Sec-Fetch-Site: same-origin, a JSON
// content type, no query but `team`, a body cap and a strict per-route body check
// (checkSetBoundaries) before anything reaches the relay. A body holding a field of the earlier
// schemas is refused naming it. The team comes from `team` or X-Relay-Team, checked against the
// viewer's teams. Also: the viewer's address behind Google's load balancer (M10-SPEC §5), which
// adds one hop to X-Forwarded-For. Every case of schema/boundaries-vectors.json is checked
// against checkSetBoundaries in boundaries-rule.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOUNDARIES_BODY_LIMIT,
  BodyError,
  checkProxyHops,
  checkSetBoundaries,
  clientAddress,
  createConsoleServer,
  demoBackend,
  joinInfo,
  relayBackend,
  type ConsoleServer,
} from '../src/console-app.js';
import { REMOVED_BOUNDARIES_FIELDS, removedFieldDetail } from '../src/boundaries-rule.js';
import type { Boundaries } from '../src/boundaries-types.js';
import { DEMO_BOUNDARIES, DemoAccount } from '../src/console-demo.js';
import { RelayClient } from '../src/relay-client.js';

const KEY = 'k'.repeat(43);
const NO_UI = join(tmpdir(), 'team-relay-no-ui-here');
const PUBLIC_HOST = 'team.example.com';
const SALT = 'a-salt-of-at-least-32-characters-0123';
const SAME_ORIGIN = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

const GOOD: Boundaries = { topic: 'Example Co: our clients and their delivery, our products and tools.' };
/** A field of each earlier schema, as an older console UI would send it. */
const OLD_FIELDS: Record<string, unknown> = { github_orgs: ['example-org'], github_repos: [], drive_folders: [], drives: [], member_folders: true };

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

describe('checkSetBoundaries', () => {
  it('accepts the topic and sends it on as the relay stores it (trimmed)', () => {
    expect(checkSetBoundaries({ version: 3, boundaries: { topic: '  Example Co: delivery.\nAnd tools.  ' } })).toEqual({
      version: 3,
      boundaries: { topic: 'Example Co: delivery.\nAnd tools.' },
    });
  });

  it.each(REMOVED_BOUNDARIES_FIELDS.map((k) => [k] as const))('refuses a body holding %s, naming it', (k) => {
    expect(() => checkSetBoundaries({ version: 0, boundaries: { ...GOOD, [k]: OLD_FIELDS[k] } })).toThrow(removedFieldDetail(k));
  });

  it('several fields of the earlier schemas: the first in the relay\'s order is named', () => {
    expect(() => checkSetBoundaries({ version: 0, boundaries: { ...GOOD, ...OLD_FIELDS } })).toThrow(removedFieldDetail('github_orgs'));
  });

  const bad: Array<[string, unknown]> = [
    ['not an object', []],
    ['null', null],
    ['an unknown top-level field', { version: 0, boundaries: GOOD, extra: 1 }],
    ['no version', { boundaries: GOOD }],
    ['a negative version', { version: -1, boundaries: GOOD }],
    ['a fractional version', { version: 1.5, boundaries: GOOD }],
    ['a string version', { version: '1', boundaries: GOOD }],
    ['a boolean version', { version: true, boundaries: GOOD }],
    ['a version over 2^31-1', { version: 2 ** 31, boundaries: GOOD }],
    ['no boundaries', { version: 0 }],
    ['null boundaries', { version: 0, boundaries: null }],
    ['boundaries a list', { version: 0, boundaries: [GOOD] }],
    ['an unknown boundaries field', { version: 0, boundaries: { ...GOOD, extra: true } }],
    ['no topic', { version: 0, boundaries: {} }],
    ['an empty topic', { version: 0, boundaries: { topic: '   ' } }],
    ['a topic of 501 characters', { version: 0, boundaries: { topic: 'x'.repeat(501) } }],
    ['a topic with a control character', { version: 0, boundaries: { topic: 'a\u0007b' } }],
    ['a topic with a bidi override', { version: 0, boundaries: { topic: 'a‮b' } }],
    ['a topic with a lone surrogate', { version: 0, boundaries: { topic: 'a\ud800b' } }],
    ['a topic that is not a string', { version: 0, boundaries: { topic: 7 } }],
  ];
  it.each(bad)('refuses %s', (_why, raw) => {
    const body = JSON.parse(JSON.stringify(raw ?? null)) as unknown;
    expect(() => checkSetBoundaries(body)).toThrow(BodyError);
  });

  it('accepts the largest version, 2^31-1', () => {
    expect(checkSetBoundaries({ version: 2 ** 31 - 1, boundaries: GOOD }).version).toBe(2 ** 31 - 1);
  });

  it('counts the topic in characters, not bytes (500 non-ASCII characters pass)', () => {
    expect(checkSetBoundaries({ version: 0, boundaries: { topic: 'é'.repeat(500) } }).boundaries.topic).toHaveLength(500);
    expect(checkSetBoundaries({ version: 0, boundaries: { topic: '\u{1F600}'.repeat(500) } }).boundaries.topic).toHaveLength(1000);
  });
});

describe('local console: /api/boundaries on the demo account', () => {
  let app: ConsoleServer;
  let port: number;
  const local = (path: string, opts: Parameters<typeof call>[2] = {}) =>
    call(port, path, { ...opts, headers: { 'X-Console-Key': KEY, ...(opts.headers ?? {}) } });
  const put = (path: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN) => local(path, { method: 'PUT', headers, body });

  beforeEach(async () => {
    app = createConsoleServer({ backend: demoBackend(new DemoAccount()), key: KEY, staticDir: NO_UI, join: joinInfo('https://relay.example', 'demo', null) });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET: the demo team has boundaries (the topic alone); a team never set reads version 0 and null', async () => {
    const r = await local('/api/boundaries');
    expect(r.status).toBe(200);
    const b = r.json();
    expect(b.team).toBe('demo');
    expect(b.version).toBeGreaterThanOrEqual(1);
    expect(b.boundaries).toEqual(DEMO_BOUNDARIES);
    expect(Object.keys(b.boundaries)).toEqual(['topic']);
    expect(b).not.toHaveProperty('since');
    const research = await local('/api/boundaries?team=research');
    expect(research.json()).toEqual({ team: 'research', version: 0, boundaries: null, updated_at: null, updated_by: null });
    expect((await local('/api/boundaries', { headers: { 'X-Relay-Team': 'research' } })).json()).toMatchObject({ team: 'research', version: 0 });
    // A team the viewer is not on, and an unknown query parameter.
    expect((await local('/api/boundaries?team=ops')).status).toBe(403);
    expect((await local('/api/boundaries?x=1')).status).toBe(400);
  });

  it('PUT: an owner sets them at the current version; the answer carries version + 1', async () => {
    const r = await put('/api/boundaries?team=research', { version: 0, boundaries: GOOD });
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ team: 'research', version: 1, boundaries: GOOD, updated_by: 'alice' });
    expect(r.json()).not.toHaveProperty('since');
    expect((await local('/api/boundaries?team=research')).json()).toMatchObject({ version: 1, boundaries: GOOD });
    // A second change from the same (now stale) version is a conflict, not a silent overwrite.
    const stale = await put('/api/boundaries?team=research', { version: 0, boundaries: { topic: 'Another topic.' } });
    expect(stale.status).toBe(502);
    expect(stale.json()).toMatchObject({ error: 'relay_refused', relay_status: 409, relay_error: 'version_conflict' });
    expect((await local('/api/boundaries?team=research')).json()).toMatchObject({ version: 1, boundaries: GOOD });
  });

  it('PUT: a body holding a field of the earlier schemas is refused naming it, and nothing changes', async () => {
    const before = (await local('/api/boundaries')).json();
    for (const k of REMOVED_BOUNDARIES_FIELDS) {
      const r = await put('/api/boundaries', { version: before.version, boundaries: { ...GOOD, [k]: OLD_FIELDS[k] } });
      expect(r.status, k).toBe(400);
      expect(r.json()).toEqual({ error: 'bad_request', detail: removedFieldDetail(k) });
    }
    expect((await local('/api/boundaries')).json()).toEqual(before);
    // The demo relay refuses it too, as the relay does (400 invalid_body naming the field).
    const demo = new DemoAccount();
    expect(() => demo.team().setBoundaries({ version: 1, boundaries: { ...GOOD, member_folders: true } as unknown as Boundaries })).toThrow(removedFieldDetail('member_folders'));
  });

  it('PUT: a member (not an owner) is refused as the relay refuses (403)', async () => {
    // alice joins ops (olga owns it) as a member.
    expect((await local('/api/invitations/ops', { method: 'POST', headers: SAME_ORIGIN, body: { accept: true } })).status).toBe(200);
    const read = await local('/api/boundaries?team=ops');
    expect(read.status).toBe(200);
    expect(read.json().boundaries).not.toBeNull();
    expect(Object.keys(read.json().boundaries)).toEqual(['topic']);
    const r = await put('/api/boundaries?team=ops', { version: read.json().version, boundaries: GOOD });
    expect(r.status).toBe(502);
    expect(r.json()).toMatchObject({ error: 'relay_refused', relay_status: 403 });
    expect((await local('/api/boundaries?team=ops')).json().version).toBe(read.json().version);
  });

  it('PUT follows every write rule before anything is read or sent', async () => {
    const body = { version: 0, boundaries: GOOD };
    const post = await local('/api/boundaries', { method: 'POST', headers: SAME_ORIGIN, body });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, PUT');
    expect((await local('/api/boundaries', { method: 'PATCH', headers: SAME_ORIGIN, body })).status).toBe(405);
    expect((await local('/api/boundaries', { method: 'DELETE', headers: SAME_ORIGIN })).status).toBe(405);
    // From another site, or a plain form post: refused.
    expect((await put('/api/boundaries', body, { 'Content-Type': 'application/json' })).status).toBe(403);
    expect((await put('/api/boundaries', body, { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await put('/api/boundaries', body, { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'same-origin' })).status).toBe(415);
    // No key, a wrong key.
    expect((await call(port, '/api/boundaries', { method: 'PUT', headers: SAME_ORIGIN, body })).status).toBe(401);
    expect((await call(port, '/api/boundaries', { method: 'PUT', headers: { ...SAME_ORIGIN, 'X-Console-Key': 'wrong' }, body })).status).toBe(403);
    // Only `team` in the query.
    expect((await put('/api/boundaries?force=1', body)).status).toBe(400);
    expect((await put('/api/boundaries?team=research&team=demo', body)).status).toBe(400);
    expect((await put('/api/boundaries?team=Bad!', body)).status).toBe(400);
    // Not JSON, a body that fails the check, a body over the cap.
    expect((await put('/api/boundaries', '{nope')).status).toBe(400);
    const unknown = await put('/api/boundaries', { version: 0, boundaries: { ...GOOD, extra: 1 } });
    expect(unknown.status).toBe(400);
    expect(unknown.json().detail).toMatch(/unknown field/);
    expect((await put('/api/boundaries', '')).status).toBe(400);
    const huge = await put('/api/boundaries', JSON.stringify({ version: 0, boundaries: { topic: 'x'.repeat(BOUNDARIES_BODY_LIMIT) } }));
    expect(huge.status).toBe(413);
    // A team the viewer is not on: not_on_team, and nothing changed.
    const other = await put('/api/boundaries?team=ops', body);
    expect(other.status).toBe(403);
    expect(other.json()).toMatchObject({ error: 'not_on_team', team: 'ops' });
  });

  it('the cap fits the largest valid document, every character that is not ASCII escaped', () => {
    const widest = { version: 2 ** 31 - 1, boundaries: { topic: '\u{1F600}'.repeat(500) } };
    // Escaped as a browser's JSON.stringify would not, every non-ASCII character as \\uXXXX.
    const text = JSON.stringify(widest).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    expect(() => checkSetBoundaries(JSON.parse(text))).not.toThrow();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(BOUNDARIES_BODY_LIMIT);
  });

  it('a body over the cap is 413 and never reaches the relay', async () => {
    const over = JSON.stringify({ version: 0, boundaries: { topic: 'x'.repeat(BOUNDARIES_BODY_LIMIT) } });
    const before = (await local('/api/boundaries')).json().version;
    const r = await put('/api/boundaries', over);
    expect(r.status).toBe(413);
    expect(r.json()).toEqual({ error: 'too_large', detail: `at most ${BOUNDARIES_BODY_LIMIT} bytes` });
    expect((await local('/api/boundaries')).json().version).toBe(before);
  });
});

/** The relay's boundaries routes, recording what it was sent. */
class FakeBoundariesRelay {
  seen: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: unknown }> = [];
  url = '';
  next: { status: number; body: unknown } | null = null;
  private server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      this.seen.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body: text ? (JSON.parse(text) as unknown) : undefined });
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (url.pathname === '/v1/me/teams') {
        return json(200, { teams: [{ team: 'research', name: 'Research', member: 'alice', role: 'owner' }], invitations: [], admin: false });
      }
      if (this.next) {
        const n = this.next;
        this.next = null;
        return json(n.status, n.body);
      }
      const m = /^\/v1\/teams\/([^/]+)\/boundaries$/.exec(url.pathname);
      if (m && req.method === 'GET') return json(200, { team: m[1], version: 0, boundaries: null, updated_at: null, updated_by: null });
      if (m && req.method === 'PUT') {
        const b = JSON.parse(text) as { version: number; boundaries: unknown };
        return json(200, { team: m[1], version: b.version + 1, boundaries: b.boundaries, updated_at: '2026-11-10T00:00:00Z', updated_by: 'alice' });
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

describe('hosted console: /api/boundaries through the relay', () => {
  let relay: FakeBoundariesRelay;
  let app: ConsoleServer;
  let port: number;
  const as = (who: string, path: string, opts: Parameters<typeof call>[2] = {}) =>
    call(port, path, { ...opts, host: PUBLIC_HOST, headers: { 'x-goog-iap-jwt-assertion': `iap:${who}`, ...(opts.headers ?? {}) } });

  beforeEach(async () => {
    relay = await new FakeBoundariesRelay().start();
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

  it('GET and PUT reach the relay for the viewer, with the checked body only', async () => {
    const g = await as('alice@example.com', '/api/boundaries?team=research');
    expect(g.status).toBe(200);
    expect(g.json()).toMatchObject({ team: 'research', version: 0, boundaries: null });
    const p = await as('alice@example.com', '/api/boundaries?team=research', {
      method: 'PUT',
      headers: SAME_ORIGIN,
      body: { version: 0, boundaries: { topic: `  ${GOOD.topic}  ` } },
    });
    expect(p.status).toBe(200);
    expect(p.json()).toMatchObject({ version: 1 });
    const sent = relay.seen.find((s) => s.method === 'PUT')!;
    expect(sent.path).toBe('/v1/teams/research/boundaries');
    expect(sent.headers['x-relay-on-behalf-of']).toBe('alice@example.com');
    expect(sent.body).toEqual({ version: 0, boundaries: GOOD });
    // Without IAP: nothing.
    expect((await call(port, '/api/boundaries', { host: PUBLIC_HOST })).status).toBe(401);
  });

  it('a body holding a field of the earlier schemas never reaches the relay', async () => {
    const r = await as('alice@example.com', '/api/boundaries?team=research', { method: 'PUT', headers: SAME_ORIGIN, body: { version: 0, boundaries: { ...GOOD, drives: [] } } });
    expect(r.status).toBe(400);
    expect(r.json()).toEqual({ error: 'bad_request', detail: removedFieldDetail('drives') });
    expect(relay.seen.filter((x) => x.method === 'PUT')).toEqual([]);
  });

  it("passes the relay's refusals on: a stale version, a non-owner, and a non-member", async () => {
    const put = () => as('alice@example.com', '/api/boundaries?team=research', { method: 'PUT', headers: SAME_ORIGIN, body: { version: 4, boundaries: GOOD } });
    relay.next = { status: 409, body: { error: 'version_conflict', detail: 'The boundaries changed; read them again.' } };
    expect((await put()).json()).toMatchObject({ error: 'relay_refused', relay_status: 409, relay_error: 'version_conflict' });
    relay.next = { status: 403, body: { error: 'forbidden' } };
    expect((await put()).json()).toMatchObject({ error: 'relay_refused', relay_status: 403 });
    relay.next = { status: 404, body: { error: 'not_found' } };
    const gone = await put();
    expect(gone.status).toBe(403);
    expect(gone.json()).toMatchObject({ error: 'not_on_team', team: 'research' });
  });

  it("a relay without the route (404 on GET) reads as not found, not as 'not on the team'", async () => {
    relay.next = { status: 404, body: { detail: 'Not Found' } };
    const r = await as('alice@example.com', '/api/boundaries?team=research');
    expect(r.status).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found' });
  });
});

describe("the viewer's address behind Google's load balancer (M10-SPEC §5)", () => {
  const reqWith = (xff: string | undefined, remote = '127.0.0.1') =>
    ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

  it('takes the entry the load balancer wrote (second from the right), never a client-written one', () => {
    // <what the client sent>, <client address the LB saw>, <the LB's own address>
    expect(clientAddress(reqWith('6.6.6.6, 203.0.113.7, 34.1.2.3'), 2)).toBe('203.0.113.7');
    expect(clientAddress(reqWith('203.0.113.7,34.1.2.3'), 2)).toBe('203.0.113.7');
    // Fewer entries than the load balancer writes: not through it; one shared bucket.
    expect(clientAddress(reqWith('203.0.113.7'), 2)).toBe('');
    expect(clientAddress(reqWith(undefined, '10.1.2.3'), 2)).toBe('');
    // Direct Cloud Run (one hop) is unchanged.
    expect(clientAddress(reqWith('6.6.6.6, 203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientAddress(reqWith(undefined, '10.1.2.3'))).toBe('10.1.2.3');
  });

  it('CONSOLE_PROXY_HOPS is 1 (Cloud Run) or 2 (the load balancer); unset is 1 only on a run.app host', () => {
    const RUN_APP = 'team-relay-console-abc123-ey.a.run.app';
    expect(checkProxyHops(undefined, RUN_APP)).toBe(1);
    expect(checkProxyHops('', RUN_APP)).toBe(1);
    expect(checkProxyHops('1', RUN_APP)).toBe(1);
    expect(checkProxyHops(' 2 ', RUN_APP)).toBe(2);
    expect(checkProxyHops('2', PUBLIC_HOST)).toBe(2);
    expect(checkProxyHops('1', PUBLIC_HOST)).toBe(1);
    expect(() => checkProxyHops('0', RUN_APP)).toThrow();
    expect(() => checkProxyHops('3', RUN_APP)).toThrow();
    expect(() => checkProxyHops('two', RUN_APP)).toThrow();
  });

  it('M10-SPEC §7.7: unset on a public host that is not run.app is refused (the console would not start)', () => {
    expect(() => checkProxyHops(undefined, PUBLIC_HOST)).toThrow(/CONSOLE_PROXY_HOPS/);
    expect(() => checkProxyHops('', 'relay.example.com')).toThrow(/CONSOLE_PROXY_HOPS/);
    expect(() => checkProxyHops(' ', 'relay.example.com:8443')).toThrow(/CONSOLE_PROXY_HOPS/);
    // Only a host under run.app counts, not one that merely contains it.
    expect(() => checkProxyHops(undefined, 'run.app.example.com')).toThrow(/CONSOLE_PROXY_HOPS/);
    expect(() => checkProxyHops(undefined, 'evilrun.app')).toThrow(/CONSOLE_PROXY_HOPS/);
    expect(checkProxyHops(undefined, 'x.a.run.app:443')).toBe(1);
  });
});
