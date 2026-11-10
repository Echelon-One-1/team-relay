// M3-SPEC §3: the hosted console. IAP assertions are checked against a locally generated
// ES256 key set served by a fake JWKS server (standing in for gstatic), the relay is a fake
// that records what it was sent, and the service account's ID token comes from a fake
// metadata server.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createConsoleServer, joinInfo, relayBackend, type ConsoleServer, type JoinInfo } from '../src/console-app.js';
import {
  CLOCK_SKEW_S,
  IAP_ISSUER,
  IapKeySet,
  UNKNOWN_KID_REFETCH_MS,
  checkIapAudience,
  iapVerifier,
  keysTtlMs,
} from '../src/iap.js';
import { RelayClient, credentialsFromEnv, metadataTokenProvider } from '../src/relay-client.js';
import { DIST } from './helpers/mcp.js';

const AUDIENCE = '/projects/123456789012/locations/europe-west3/services/team-relay-console';
const PUBLIC_HOST = 'team-relay-console-abc123-ey.a.run.app';
const SALT = 'salt-for-tests-only-0123456789abcdef';

// ---------------------------------------------------------------------------------------
// Fixtures: keys, tokens, servers.

type Signer = { kid: string; privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']; jwk: JWK };

async function makeSigner(kid: string): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  return { kid, privateKey, jwk };
}

type Claims = Record<string, unknown>;

function baseClaims(overrides: Claims = {}): Claims {
  const now = Math.floor(Date.now() / 1000);
  return { iss: IAP_ISSUER, aud: AUDIENCE, iat: now - 5, exp: now + 600, sub: 'accounts.google.com:1234', email: 'Alice@Example.Com', ...overrides };
}

async function sign(signer: Signer, claims: Claims = baseClaims(), header: Record<string, unknown> = {}): Promise<string> {
  const payload = { ...claims };
  // SignJWT validates the standard claims' types, so they are set on the payload directly.
  return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid: signer.kid, typ: 'JWT', ...header }).sign(signer.privateKey);
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** A token with the given header and payload and a junk signature (alg none and friends). */
function forged(header: Record<string, unknown>, claims: Claims, signature = 'c2ln'): string {
  return `${b64(header)}.${b64(claims)}.${signature}`;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Stands in for https://www.gstatic.com/iap/verify/public_key-jwk. */
class FakeJwks {
  keys: JWK[] = [];
  cacheControl: string | null = 'public, max-age=3600';
  status = 200;
  fetches = 0;
  delayMs = 0;
  url = '';
  private server = createServer((req, res) => {
    this.fetches++;
    setTimeout(() => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.cacheControl !== null) headers['Cache-Control'] = this.cacheControl;
      res.writeHead(this.status, headers);
      res.end(JSON.stringify({ keys: this.keys }));
    }, this.delayMs);
    req.resume();
  });
  async start() {
    this.url = `${await listen(this.server)}/iap/verify/public_key-jwk`;
    return this;
  }
  close() {
    return closeServer(this.server);
  }
}

function fakeJwt(claims: Claims): string {
  return `${b64({ alg: 'RS256', typ: 'JWT', kid: 'meta' })}.${b64(claims)}.${Buffer.from('signature-bytes-here').toString('base64url')}`;
}

/** Stands in for the metadata server's identity endpoint. */
class FakeMetadata {
  seen: Array<{ path: string; query: URLSearchParams; flavor: string | undefined }> = [];
  issued: string[] = [];
  lifetimeS = 3600;
  status = 200;
  base = '';
  private server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const flavor = req.headers['metadata-flavor'] as string | undefined;
    this.seen.push({ path: u.pathname, query: u.searchParams, flavor });
    req.resume();
    if (flavor !== 'Google') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Missing Metadata-Flavor:Google header.');
    }
    if (u.pathname !== '/computeMetadata/v1/instance/service-accounts/default/identity') {
      res.writeHead(404);
      return res.end();
    }
    if (this.status !== 200) {
      res.writeHead(this.status, { 'Content-Type': 'text/plain' });
      return res.end('no');
    }
    const token = fakeJwt({ aud: u.searchParams.get('audience'), exp: Math.floor(Date.now() / 1000) + this.lifetimeS, n: this.issued.length });
    this.issued.push(token);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Metadata-Flavor': 'Google' });
    res.end(token);
  });
  async start() {
    this.base = await listen(this.server);
    return this;
  }
  close() {
    return closeServer(this.server);
  }
}

type Seen = { method: string; path: string; headers: IncomingMessage['headers'] };

/** A relay that answers the four reads for whoever the delegate names, and records them. */
class FakeDelegateRelay {
  seen: Seen[] = [];
  /** How many of the next requests answer 401. */
  refuse = 0;
  /** Viewers on no roster of the team: 403 not_a_member, as the relay answers them. */
  nonMembers = new Set<string>();
  url = '';
  private server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    this.seen.push({ method: req.method ?? '', path, headers: req.headers });
    req.resume();
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (this.refuse > 0) {
      this.refuse--;
      return json(401, { error: 'unauthenticated' });
    }
    const viewer = req.headers['x-relay-on-behalf-of'];
    if (path === '/v1/me/teams') {
      // M9-SPEC §2: the viewer's teams (none for a stranger).
      const on = typeof viewer === 'string' && !this.nonMembers.has(viewer);
      const member = viewer === 'alice@example.com' ? 'alice' : 'someone';
      return json(200, { teams: on ? [{ team: 'demo', name: 'Demo', member, role: 'member' }] : [], invitations: [], admin: false, teams_created: 0, max_teams_created: 3 });
    }
    if (typeof viewer === 'string' && this.nonMembers.has(viewer)) return json(403, { error: 'not_a_member', detail: 'not on this team' });
    if (path === '/v1/teams/demo/me') return json(200, { team: 'demo', member: viewer === 'alice@example.com' ? 'alice' : 'someone', teammates: ['bob'] });
    if (path === '/v1/teams/demo/directory') return json(200, { members: [], stats_complete: true });
    if (path === '/v1/teams/demo/activity') return json(200, { requests: [], next_since: null, server_time: new Date().toISOString() });
    if (path === '/v1/teams/demo/inbox/summary') return json(200, { pending: 2, more: false, oldest_at: null, from: ['bob'], answering: { last_seen: null } });
    return json(404, { error: 'not_found' });
  });
  async start() {
    this.url = await listen(this.server);
    return this;
  }
  close() {
    return closeServer(this.server);
  }
}

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

function get(port: number, path: string, opts: { host?: string; assertion?: string | null; method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? PUBLIC_HOST, ...(opts.headers ?? {}) };
    if (opts.assertion) headers['x-goog-iap-jwt-assertion'] = opts.assertion;
    const r = httpRequest({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

function staticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-relay-hosted-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>console</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  return dir;
}

// ---------------------------------------------------------------------------------------

describe('hosted console server (M3-SPEC §3)', () => {
  let signer: Signer;
  let other: Signer;
  let jwks: FakeJwks;
  let relay: FakeDelegateRelay;
  let metadata: FakeMetadata;
  let app: ConsoleServer | null = null;
  let logs: string[] = [];

  beforeAll(async () => {
    signer = await makeSigner('key-one');
    other = await makeSigner('key-rotated');
  });

  afterEach(async () => {
    await app?.close();
    app = null;
    await jwks?.close();
    await relay?.close();
    await metadata?.close();
  });

  async function hostedApp(join?: JoinInfo): Promise<number> {
    jwks = await new FakeJwks().start();
    jwks.keys = [signer.jwk];
    relay = await new FakeDelegateRelay().start();
    metadata = await new FakeMetadata().start();
    logs = [];
    const log = (l: string) => logs.push(l);
    const client = new RelayClient({
      url: relay.url,
      team: 'demo',
      token: metadataTokenProvider({ audience: relay.url, base: metadata.base }),
      attempts: 1,
    });
    const keys = new IapKeySet({ url: jwks.url, log });
    app = createConsoleServer({
      backend: relayBackend(client),
      hosted: { publicHost: PUBLIC_HOST, verify: iapVerifier({ audience: AUDIENCE, keys, log }), ipHashSalt: SALT },
      staticDir: staticDir(),
      ...(join ? { join } : {}),
      log,
    });
    return app.listen(0);
  }

  it('binds 0.0.0.0', async () => {
    await hostedApp();
    expect((app!.server.address() as AddressInfo).address).toBe('0.0.0.0');
  });

  it('a valid assertion reads through, as the lower-cased viewer, with the service account token and no key', async () => {
    const port = await hostedApp();
    const res = await get(port, '/api/me', { assertion: await sign(signer) });
    expect(res.status).toBe(200);
    // The viewer's own verified email is added for the join panel; the relay never sent it.
    expect(JSON.parse(res.body)).toEqual({ team: 'demo', member: 'alice', teammates: ['bob'], email: 'alice@example.com' });
    // M9-SPEC §5: the viewer's teams first (then kept for a while), then the read itself.
    expect(relay.seen.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/me/teams', 'GET /v1/teams/demo/me']);
    expect(relay.seen[0]!.headers['x-relay-on-behalf-of']).toBe('alice@example.com');
    const sent = relay.seen[1]!;
    expect(sent.method).toBe('GET');
    expect(sent.path).toBe('/v1/teams/demo/me');
    expect(sent.headers['x-relay-on-behalf-of']).toBe('alice@example.com');
    expect(sent.headers.authorization).toBe(`Bearer ${metadata.issued[0]}`);
    // The IAP assertion itself never goes on to the relay.
    expect(sent.headers['x-goog-iap-jwt-assertion']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['access-control-allow-origin']).toBeUndefined();

    for (const path of ['/api/directory', '/api/activity?limit=5', '/api/inbox/summary']) {
      expect((await get(port, path, { assertion: await sign(signer) })).status).toBe(200);
    }
    // M7-SPEC §3: the viewer's own summary, read on their behalf.
    const summary = await get(port, '/api/inbox/summary', { assertion: await sign(signer) });
    expect(JSON.parse(summary.body)).toMatchObject({ pending: 2, from: ['bob'] });
    expect(relay.seen.filter((s) => s.path === '/v1/teams/demo/inbox/summary')).toHaveLength(2);
    expect(relay.seen.every((s) => s.headers['x-relay-on-behalf-of'] === 'alice@example.com')).toBe(true);
    // A key, if a browser sent one, is irrelevant.
    expect((await get(port, '/api/me', { assertion: await sign(signer), headers: { 'X-Console-Key': 'nonsense' } })).status).toBe(200);
  });

  it('refuses a missing assertion with a bare 401, on the API and on static files alike', async () => {
    const port = await hostedApp();
    for (const path of ['/api/me', '/', '/index.html', '/assets/app-abc123.js', '/some/route', '/favicon.svg']) {
      const res = await get(port, path);
      expect(res.status, path).toBe(401);
      expect(res.body).toBe('unauthorized\n');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.headers['www-authenticate']).toBeUndefined();
    }
    expect(relay.seen).toHaveLength(0);
    // With one, the static files are served (assets privately cached).
    const index = await get(port, '/', { assertion: await sign(signer) });
    expect(index.status).toBe(200);
    expect(index.body).toContain('<title>console</title>');
    const asset = await get(port, '/assets/app-abc123.js', { assertion: await sign(signer) });
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('private, max-age=31536000, immutable');
  });

  it('refuses a wrong audience, issuer, expiry, issue time, missing email or a second audience', async () => {
    const port = await hostedApp();
    const now = Math.floor(Date.now() / 1000);
    const bad: Record<string, Claims> = {
      'wrong aud': baseClaims({ aud: '/projects/123456789012/locations/europe-west3/services/other' }),
      'aud as array': baseClaims({ aud: [AUDIENCE, 'x'] }),
      'wrong iss': baseClaims({ iss: 'https://accounts.google.com' }),
      'no iss': baseClaims({ iss: undefined }),
      expired: baseClaims({ iat: now - 700, exp: now - CLOCK_SKEW_S - 5 }),
      'no exp': baseClaims({ exp: undefined }),
      'iat in the future': baseClaims({ iat: now + CLOCK_SKEW_S + 30 }),
      'no iat': baseClaims({ iat: undefined }),
      'missing email': baseClaims({ email: undefined }),
      'email not a string': baseClaims({ email: ['alice@example.com'] }),
      'email not an address': baseClaims({ email: 'alice' }),
    };
    for (const [name, claims] of Object.entries(bad)) {
      const clean = Object.fromEntries(Object.entries(claims).filter(([, v]) => v !== undefined));
      const res = await get(port, '/api/me', { assertion: await sign(signer, clean) });
      expect(res.status, name).toBe(401);
      expect(res.body, name).toBe('unauthorized\n');
    }
    expect(relay.seen).toHaveLength(0);
    // Inside the 30 s skew both ways is accepted.
    const edge = baseClaims({ iat: now + CLOCK_SKEW_S - 10, exp: now - CLOCK_SKEW_S + 10 });
    expect((await get(port, '/api/me', { assertion: await sign(signer, edge) })).status).toBe(200);
  });

  it('refuses alg none, HS256, RS256, a signature by another key, a tampered payload and junk', async () => {
    const port = await hostedApp();
    const claims = baseClaims();
    const { privateKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const hsSecret = new TextEncoder().encode('x'.repeat(32));
    const [h, , sig] = (await sign(signer, claims)).split('.');
    const tampered = `${h}.${b64({ ...claims, email: 'mallory@example.com' })}.${sig}`;
    const tokens: Record<string, string> = {
      'alg none': forged({ alg: 'none', kid: signer.kid }, claims, ''),
      'alg none with signature': forged({ alg: 'none', kid: signer.kid }, claims),
      HS256: await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: signer.kid }).sign(hsSecret),
      RS256: await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: signer.kid }).sign(rsa),
      'ES256 header, junk signature': forged({ alg: 'ES256', kid: signer.kid }, claims),
      'signed by an unpublished key under a published kid': await sign({ ...other, kid: signer.kid }),
      'tampered payload': tampered,
      'no kid': await new SignJWT(claims).setProtectedHeader({ alg: 'ES256' }).sign(signer.privateKey),
      junk: 'not-a-jwt',
      'two parts': 'a.b',
      huge: `${'a'.repeat(9000)}.b.c`,
    };
    for (const [name, token] of Object.entries(tokens)) {
      const res = await get(port, '/api/me', { assertion: token });
      expect(res.status, name).toBe(401);
    }
    expect(relay.seen).toHaveLength(0);
  });

  it('answers /api/join itself, behind the same IAP gate, only to a member of the team (M6-SPEC §7 item 6)', async () => {
    const join = joinInfo('https://team-relay-xyz.a.run.app', 'demo', 'https://github.com/example/multiagent.git');
    const port = await hostedApp(join);
    const refused = await get(port, '/api/join');
    expect(refused.status).toBe(401);
    expect(refused.body).toBe('unauthorized\n');
    expect((await get(port, '/api/join', { assertion: await sign(other) })).status).toBe(401);
    expect(relay.seen).toHaveLength(0);
    const ok = await get(port, '/api/join', { assertion: await sign(signer) });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^application\/json/);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(ok.body)).toEqual({
      relay_url: 'https://team-relay-xyz.a.run.app',
      team: 'demo',
      repo_url: 'https://github.com/example/multiagent.git',
      marketplace_source: 'example/multiagent',
      marketplace: 'team-relay-dev',
      plugin: 'team-relay',
      default_relay: false,
    });
    // The relay was asked only which teams the viewer is on, on the viewer's behalf; the join
    // details themselves come from the server's own configuration.
    expect(relay.seen.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /v1/me/teams']);
    expect(relay.seen[0]!.headers['x-relay-on-behalf-of']).toBe('alice@example.com');
    expect((await get(port, '/api/join', { assertion: await sign(signer), method: 'POST' })).status).toBe(405);
    expect((await get(port, '/api/join?x=1', { assertion: await sign(signer) })).status).toBe(400);
    expect((await get(port, '/api/join', { assertion: await sign(signer), host: 'evil.example' })).status).toBe(403);
    expect(relay.seen).toHaveLength(1);
  });

  it('gives a signed-in account on no roster of the team the not-on-team response on /api/join, and no join details', async () => {
    const join = joinInfo('https://team-relay-xyz.a.run.app', 'demo', 'https://github.com/example/multiagent.git');
    const port = await hostedApp(join);
    relay.nonMembers.add('mallory@example.com');
    const res = await get(port, '/api/join', { assertion: await sign(signer, baseClaims({ email: 'mallory@example.com' })) });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_on_team', email: 'mallory@example.com', team: 'demo' });
    expect(res.body).not.toContain('team-relay-xyz');
    expect(res.body).not.toContain('multiagent');
    // The relay's own sign-in failing (a plain 401) is passed on as such, still with no details.
    relay.refuse = 5;
    const broken = await get(port, '/api/join', { assertion: await sign(signer) });
    expect(broken.status).toBe(502);
    expect(JSON.parse(broken.body)).toMatchObject({ error: 'relay_refused', relay_status: 401 });
    expect(broken.body).not.toContain('team-relay-xyz');
    relay.refuse = 0;
    // Without a join configuration, a member gets 404 and a non-member still only not_on_team.
    await app!.close();
    await jwks.close();
    await relay.close();
    await metadata.close();
    const bare = await hostedApp();
    relay.nonMembers.add('mallory@example.com');
    expect((await get(bare, '/api/join', { assertion: await sign(signer) })).status).toBe(404);
    expect((await get(bare, '/api/join', { assertion: await sign(signer, baseClaims({ email: 'mallory@example.com' })) })).status).toBe(403);
  });

  it('refuses a Host other than CONSOLE_PUBLIC_HOST, even with a valid assertion', async () => {
    const port = await hostedApp();
    const assertion = await sign(signer);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `${PUBLIC_HOST}.evil.example`, `evil.${PUBLIC_HOST}`, `${PUBLIC_HOST}:443`, 'other.a.run.app']) {
      const res = await get(port, '/api/me', { host, assertion });
      expect(res.status, host).toBe(403);
    }
    // The Host is compared case-insensitively, as HTTP says.
    expect((await get(port, '/api/me', { host: PUBLIC_HOST.toUpperCase(), assertion })).status).toBe(200);
  });

  it('stays read-only: no other method, no other path, no cross-site read', async () => {
    const port = await hostedApp();
    const assertion = await sign(signer);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await get(port, '/api/me', { assertion, method })).status, method).toBe(405);
    }
    expect((await get(port, '/api/streams/inbox', { assertion })).status).toBe(404);
    expect((await get(port, '/api/me', { assertion, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect(relay.seen).toHaveLength(0);
  });

  it('fetches the key set once for concurrent requests, and never logs a token or an email', async () => {
    const port = await hostedApp();
    jwks.delayMs = 50;
    const assertions = await Promise.all(Array.from({ length: 8 }, () => sign(signer)));
    const results = await Promise.all(assertions.map((a) => get(port, '/api/directory', { assertion: a })));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(jwks.fetches).toBe(1);
    await get(port, '/api/me', { assertion: await sign(signer, baseClaims({ aud: 'nope' })) });
    const joined = logs.join('\n');
    expect(joined).toMatch(/iap: refused/);
    for (const a of assertions) expect(joined).not.toContain(a.split('.')[2]);
    for (const t of metadata.issued) expect(joined).not.toContain(t);
    expect(joined.toLowerCase()).not.toContain('alice@example.com');
  });
});

// ---------------------------------------------------------------------------------------

describe('IAP key set: caching and rotation', () => {
  let signer: Signer;
  let rotated: Signer;
  let jwks: FakeJwks;

  beforeAll(async () => {
    signer = await makeSigner('key-one');
    rotated = await makeSigner('key-two');
  });

  afterEach(async () => {
    await jwks?.close();
  });

  async function setup() {
    jwks = await new FakeJwks().start();
    jwks.keys = [signer.jwk];
    let now = Date.now();
    const clock = { now: () => now, advance: (ms: number) => (now += ms) };
    const keys = new IapKeySet({ url: jwks.url, now: clock.now });
    const verify = iapVerifier({ audience: AUDIENCE, keys, now: clock.now });
    return { clock, keys, verify };
  }

  const claimsAt = (nowMs: number, extra: Claims = {}) => {
    const s = Math.floor(nowMs / 1000);
    return baseClaims({ iat: s - 5, exp: s + 600, ...extra });
  };

  it('an unknown kid triggers one refetch, then at most one every 5 minutes', async () => {
    const { clock, verify } = await setup();
    expect(await verify(await sign(signer, claimsAt(clock.now())))).toEqual({ email: 'alice@example.com' });
    expect(jwks.fetches).toBe(1);

    // Google rotates: a new key appears. The first token signed with it refetches once.
    jwks.keys = [signer.jwk, rotated.jwk];
    clock.advance(UNKNOWN_KID_REFETCH_MS);
    expect(await verify(await sign(rotated, claimsAt(clock.now())))).toEqual({ email: 'alice@example.com' });
    expect(jwks.fetches).toBe(2);

    // A kid nobody published: one refetch is already spent within the window, so none now.
    const stranger = await makeSigner('key-unknown');
    expect(await verify(await sign(stranger, claimsAt(clock.now())))).toBeNull();
    expect(await verify(await sign(stranger, claimsAt(clock.now())))).toBeNull();
    expect(jwks.fetches).toBe(2);
    clock.advance(UNKNOWN_KID_REFETCH_MS - 1000);
    expect(await verify(await sign(stranger, claimsAt(clock.now())))).toBeNull();
    expect(jwks.fetches).toBe(2);
    clock.advance(1000);
    expect(await verify(await sign(stranger, claimsAt(clock.now())))).toBeNull();
    expect(jwks.fetches).toBe(3);
  });

  it('an unknown kid right after a fetch does not refetch', async () => {
    const { clock, verify } = await setup();
    await verify(await sign(signer, claimsAt(clock.now())));
    jwks.keys = [signer.jwk, rotated.jwk];
    clock.advance(60_000);
    expect(await verify(await sign(rotated, claimsAt(clock.now())))).toBeNull();
    expect(jwks.fetches).toBe(1);
  });

  it('keeps the set for Cache-Control max-age, then revalidates', async () => {
    const { clock, verify } = await setup();
    jwks.cacheControl = 'public, max-age=600';
    await verify(await sign(signer, claimsAt(clock.now())));
    clock.advance(599_000);
    await verify(await sign(signer, claimsAt(clock.now())));
    expect(jwks.fetches).toBe(1);
    clock.advance(2_000);
    // A key removed from the set is no longer accepted once the set is refetched.
    jwks.keys = [rotated.jwk];
    expect(await verify(await sign(signer, claimsAt(clock.now())))).toBeNull();
    expect(jwks.fetches).toBe(2);
  });

  it('keeps a usable set through a failed refresh, and retries after a pause', async () => {
    const { clock, verify } = await setup();
    jwks.cacheControl = 'max-age=60';
    await verify(await sign(signer, claimsAt(clock.now())));
    jwks.status = 503;
    clock.advance(61_000);
    expect(await verify(await sign(signer, claimsAt(clock.now())))).toEqual({ email: 'alice@example.com' });
    expect(jwks.fetches).toBe(2);
    expect(await verify(await sign(signer, claimsAt(clock.now())))).not.toBeNull();
    expect(jwks.fetches).toBe(2);
    clock.advance(31_000);
    await verify(await sign(signer, claimsAt(clock.now())));
    expect(jwks.fetches).toBe(3);
    // Not forever: an hour past its freshness the old set is dropped.
    clock.advance(60 * 60_000);
    expect(await verify(await sign(signer, claimsAt(clock.now())))).toBeNull();
  });

  it('ignores keys that are not ES256 signing keys', async () => {
    const { clock, verify } = await setup();
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaJwk = { ...(publicKey.export({ format: 'jwk' }) as JWK), kid: 'key-one', alg: 'RS256' };
    jwks.keys = [rsaJwk, { ...rotated.jwk, alg: 'ES384' }];
    expect(await verify(await sign(signer, claimsAt(clock.now())))).toBeNull();
    expect(await verify(await sign(rotated, claimsAt(clock.now())))).toBeNull();
  });

  it('reads Cache-Control within bounds', () => {
    expect(keysTtlMs('public, max-age=3600', null)).toBe(3_600_000);
    expect(keysTtlMs('public, max-age=3600', '600')).toBe(3_000_000);
    expect(keysTtlMs('no-store', null)).toBe(60_000);
    expect(keysTtlMs('max-age=1', null)).toBe(60_000);
    expect(keysTtlMs('max-age=9999999', null)).toBe(24 * 3_600_000);
    expect(keysTtlMs(null, null)).toBe(5 * 60_000);
  });

  it('checks IAP_AUDIENCE', () => {
    expect(checkIapAudience(AUDIENCE)).toBe(AUDIENCE);
    expect(checkIapAudience('/projects/1/apps/my-project')).toBe('/projects/1/apps/my-project');
    for (const bad of [undefined, '', 'team-relay-console', 'https://x.run.app', '/projects/abc/locations/x/services/y', '/projects/1//x', '/projects/1/../x']) {
      expect(() => checkIapAudience(bad)).toThrow(/IAP_AUDIENCE/);
    }
  });
});

// ---------------------------------------------------------------------------------------

describe('RELAY_AUTH=metadata: the service account ID token', () => {
  let metadata: FakeMetadata;
  let relay: FakeDelegateRelay;

  afterEach(async () => {
    await metadata?.close();
    await relay?.close();
  });

  it('asks for audience=RELAY_URL&format=full with Metadata-Flavor: Google, and caches the token', async () => {
    metadata = await new FakeMetadata().start();
    const provider = metadataTokenProvider({ audience: 'https://team-relay-xyz.a.run.app', base: metadata.base });
    const [a, b] = await Promise.all([provider(), provider()]);
    expect(a).toBe(b);
    expect(await provider()).toBe(a);
    expect(metadata.seen).toHaveLength(1);
    const seen = metadata.seen[0]!;
    expect(seen.flavor).toBe('Google');
    expect(seen.path).toBe('/computeMetadata/v1/instance/service-accounts/default/identity');
    expect(seen.query.get('audience')).toBe('https://team-relay-xyz.a.run.app');
    expect(seen.query.get('format')).toBe('full');
  });

  it('refreshes 5 minutes before exp, and after invalidate', async () => {
    metadata = await new FakeMetadata().start();
    let now = Date.now();
    const provider = metadataTokenProvider({ audience: 'https://relay.example', base: metadata.base, now: () => now });
    const first = await provider();
    now += 54 * 60_000;
    expect(await provider()).toBe(first);
    now += 2 * 60_000;
    const second = await provider();
    expect(second).not.toBe(first);
    expect(metadata.seen).toHaveLength(2);
    provider.invalidate();
    expect(await provider()).not.toBe(second);
    expect(metadata.seen).toHaveLength(3);
  });

  it('a relay 401 drops the token and retries once with a fresh one', async () => {
    metadata = await new FakeMetadata().start();
    relay = await new FakeDelegateRelay().start();
    const client = new RelayClient({ url: relay.url, team: 'demo', token: metadataTokenProvider({ audience: relay.url, base: metadata.base }), attempts: 1 });
    relay.refuse = 1;
    await client.me({ onBehalfOf: 'alice@example.com' });
    expect(metadata.issued).toHaveLength(2);
    expect(relay.seen.map((s) => s.headers.authorization)).toEqual(metadata.issued.map((t) => `Bearer ${t}`));
    // Twice refused is final, and the error carries no token.
    relay.refuse = 2;
    const err = await client.me({ onBehalfOf: 'alice@example.com' }).catch((e: unknown) => e as Error);
    expect(String(err)).toMatch(/401/);
    expect(metadata.issued).toHaveLength(3);
    for (const t of metadata.issued) expect(String(err)).not.toContain(t);
  });

  it('fails without the token in the error when the metadata server refuses or is absent', async () => {
    metadata = await new FakeMetadata().start();
    metadata.status = 500;
    const provider = metadataTokenProvider({ audience: 'https://relay.example', base: metadata.base });
    await expect(provider()).rejects.toThrow(/metadata server refused an identity token \(500\)/);
    const absent = metadataTokenProvider({ audience: 'https://relay.example', base: 'http://127.0.0.1:1' });
    await expect(absent()).rejects.toThrow(/metadata server did not answer/);
  });

  it('refuses an on-behalf-of value that is not a lower-case email, and sends none by default', async () => {
    metadata = await new FakeMetadata().start();
    relay = await new FakeDelegateRelay().start();
    const client = new RelayClient({ url: relay.url, team: 'demo', token: metadataTokenProvider({ audience: relay.url, base: metadata.base }), attempts: 1 });
    await expect(client.me({ onBehalfOf: 'Alice@Example.Com' })).rejects.toThrow(/lower-case email/);
    await expect(client.me({ onBehalfOf: 'a@b.c\r\nX-Evil: 1' })).rejects.toThrow(/lower-case email/);
    await client.me();
    expect(relay.seen).toHaveLength(1);
    expect(relay.seen[0]!.headers['x-relay-on-behalf-of']).toBeUndefined();
  });

  it('RELAY_AUTH accepts metadata, with RELAY_URL as the audience', () => {
    expect(typeof credentialsFromEnv({ RELAY_AUTH: 'metadata', RELAY_URL: 'https://relay.example' })).toBe('function');
    expect(() => credentialsFromEnv({ RELAY_AUTH: 'metadata' })).toThrow(/RELAY_URL/);
  });
});

// ---------------------------------------------------------------------------------------

describe('dist/console-server.js with CONSOLE_MODE=hosted', () => {
  function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
  }

  function start(env: Record<string, string>, args: string[] = []) {
    const child = spawn(process.execPath, [join(DIST, 'console-server.js'), ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '', CONSOLE_MODE: 'hosted', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const exited = new Promise<number | null>((r) => child.on('close', r));
    return { child, out: () => stdout, err: () => stderr, exited };
  }

  const GOOD = {
    CONSOLE_PUBLIC_HOST: PUBLIC_HOST,
    IAP_AUDIENCE: AUDIENCE,
    RELAY_URL: 'https://team-relay-xyz.a.run.app',
    RELAY_TEAM: 'demo',
    RELAY_AUTH: 'metadata',
    CONSOLE_IP_HASH_SALT: SALT,
  };

  it('starts on $PORT, prints no URL or key, and refuses a request without the IAP header', async () => {
    const port = await freePort();
    const p = start({ ...GOOD, PORT: String(port) });
    try {
      const deadline = Date.now() + 10_000;
      while (!p.err().includes('hosted: serving') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(p.err()).toContain(`hosted: serving the viewer's teams (default demo) for ${PUBLIC_HOST} on 0.0.0.0:${port}`);
      expect(p.out()).toBe('');
      const res = await get(port, '/');
      expect(res.status).toBe(401);
      expect((await get(port, '/api/me')).status).toBe(401);
      expect((await get(port, '/', { host: 'evil.example' })).status).toBe(403);
    } finally {
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
    }
  });

  it('behind the load balancer (a public host not on run.app) starts with CONSOLE_PROXY_HOPS=2', async () => {
    const port = await freePort();
    const p = start({ ...GOOD, CONSOLE_PUBLIC_HOST: 'relay.example.com', CONSOLE_PROXY_HOPS: '2', PORT: String(port) });
    try {
      const deadline = Date.now() + 10_000;
      while (!p.err().includes('hosted: serving') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(p.err()).toContain('for relay.example.com on 0.0.0.0:');
      expect(p.err()).toContain('behind IAP on the load balancer');
    } finally {
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
    }
  });

  it('refuses a missing or wrong configuration, and any argument', async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ ...GOOD, CONSOLE_PUBLIC_HOST: '' }, /CONSOLE_PUBLIC_HOST/],
      [{ ...GOOD, CONSOLE_PUBLIC_HOST: 'https://x.run.app/' }, /CONSOLE_PUBLIC_HOST/],
      [{ ...GOOD, IAP_AUDIENCE: '' }, /IAP_AUDIENCE/],
      [{ ...GOOD, IAP_AUDIENCE: '123456' }, /IAP_AUDIENCE/],
      [{ ...GOOD, RELAY_AUTH: 'token', RELAY_TOKEN: 'x' }, /RELAY_AUTH=metadata/],
      [{ ...GOOD, RELAY_AUTH: '' }, /RELAY_AUTH=metadata/],
      [{ ...GOOD, RELAY_TEAM: '' }, /RELAY_TEAM/],
      [{ ...GOOD, RELAY_URL: 'http://relay.example' }, /RELAY_URL/],
      [{ ...GOOD, PORT: '0' }, /PORT/],
      // M9-SPEC §7.6: the salt for the viewer's address is required, and long enough.
      [{ ...GOOD, CONSOLE_IP_HASH_SALT: '' }, /CONSOLE_IP_HASH_SALT/],
      [{ ...GOOD, CONSOLE_IP_HASH_SALT: 'x'.repeat(31) }, /CONSOLE_IP_HASH_SALT/],
      [{ ...GOOD, JOIN_REPO_URL: 'http://github.com/example/multiagent' }, /JOIN_REPO_URL/],
      [{ ...GOOD, JOIN_REPO_URL: 'git@github.com:example/multiagent.git' }, /JOIN_REPO_URL/],
      // M10-SPEC §7.7: a public host that is not run.app is behind the load balancer, so the
      // hop count must be said; unset, every viewer would share the balancer's address.
      [{ ...GOOD, CONSOLE_PUBLIC_HOST: 'relay.example.com' }, /CONSOLE_PROXY_HOPS/],
      [{ ...GOOD, CONSOLE_PUBLIC_HOST: 'relay.example.com', CONSOLE_PROXY_HOPS: ' ' }, /CONSOLE_PROXY_HOPS/],
      [{ ...GOOD, CONSOLE_PUBLIC_HOST: 'evil-run.app.example.com' }, /CONSOLE_PROXY_HOPS/],
      [{ ...GOOD, CONSOLE_PROXY_HOPS: '3' }, /CONSOLE_PROXY_HOPS/],
    ];
    for (const [env, pattern] of cases) {
      const p = start(env);
      expect(await p.exited, JSON.stringify(env)).toBe(1);
      expect(p.err()).toMatch(pattern);
    }
    const withArg = start(GOOD, ['--demo']);
    expect(await withArg.exited).toBe(2);
    const badMode = start({ ...GOOD, CONSOLE_MODE: 'cloud' });
    expect(await badMode.exited).toBe(2);
  });
});
