// PICKERS-SPEC §3.7: the console server's part of owner-picked sources. GET /api/sources/config
// and GET /api/sources/github are proxied owners' reads (team as the other team routes, shaped
// before the page sees them; locally `google_picker` is always null), and the hosted console
// serves the Google Drive picker page at /pick/drive under its own headers (§5.4), never under
// the console's, while every other page keeps the console's headers. The demo relay plays the
// new routes and the members' missing sources (§3.4).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTENT_SECURITY_POLICY,
  GITHUB_REPOS_MAX,
  PICKER_CONTENT_SECURITY_POLICY,
  createConsoleServer,
  demoBackend,
  githubListingView,
  relayBackend,
  sourcesConfigView,
  type ConsoleServer,
} from '../src/console-app.js';
import { DEMO_BOUNDARIES, DEMO_FOLDER_ID, DemoAccount } from '../src/console-demo.js';
import { RelayClient, RelayError, parseRetryAfter } from '../src/relay-client.js';

const KEY = 'k'.repeat(43);
const PUBLIC_HOST = 'team.example.com';
const SALT = 'a-salt-of-at-least-32-characters-0123';
const SAME_ORIGIN = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
const PICKER_HTML = '<!doctype html><title>Choose folders</title><div id="pick-drive"></div><script type="module" src="../assets/pick-drive-abc.js"></script>';
const INSTALL_URL = 'https://github.com/apps/example-relay-sources/installations/new';
const PICKER = { client_id: '123-abc.apps.googleusercontent.com', api_key: `AIza${'A'.repeat(35)}`, app_id: '123456789012' };

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

/** A built console: the app, an asset and the picker page. */
function site(withPicker = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-relay-pickers-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>console</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'pick-drive-abc.js'), 'console.log(1)');
  if (withPicker) writeFileSync(join(dir, 'pick-drive.html'), PICKER_HTML);
  return dir;
}

/** What a relay answers on the sources routes; set per test. */
type Answer = { status: number; body: unknown; headers?: Record<string, string> };

/** The relay's sources routes for team `research`, recording what it was sent. */
class FakeSourcesRelay {
  seen: Array<{ method: string; path: string; headers: IncomingMessage['headers'] }> = [];
  url = '';
  config: Answer = { status: 200, body: { github: { configured: true, install_url: INSTALL_URL }, google_picker: PICKER } };
  github: Answer = { status: 200, body: { installations: [], fetched_at: '2026-11-11T10:00:00.000Z' } };
  private server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    this.seen.push({ method: req.method ?? '', path, headers: req.headers });
    req.resume();
    const send = (a: Answer) => {
      res.writeHead(a.status, { 'Content-Type': 'application/json', ...(a.headers ?? {}) });
      res.end(JSON.stringify(a.body));
    };
    if (path === '/v1/me/teams') {
      return send({ status: 200, body: { teams: [{ team: 'research', name: 'Research', member: 'alice', role: 'owner' }], invitations: [], admin: false } });
    }
    if (path === '/v1/teams/research/sources/config') return send(this.config);
    if (path === '/v1/teams/research/sources/github') return send(this.github);
    return send({ status: 404, body: { error: 'not_found' } });
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

describe('local console: /api/sources/* on the demo account', () => {
  let app: ConsoleServer;
  let port: number;
  const local = (path: string, opts: Parameters<typeof call>[2] = {}) =>
    call(port, path, { ...opts, headers: { 'X-Console-Key': KEY, ...(opts.headers ?? {}) } });

  beforeEach(async () => {
    app = createConsoleServer({ backend: demoBackend(new DemoAccount()), key: KEY, staticDir: site() });
    port = await app.listen(0);
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET /api/sources/config: the owner gets the GitHub App link and no picker (the Picker never runs locally)', async () => {
    const r = await local('/api/sources/config');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toEqual({ github: { configured: true, install_url: INSTALL_URL }, google_picker: null });
    expect((await local('/api/sources/config?team=research')).status).toBe(200);
  });

  it('GET /api/sources/github: the fake listing, sorted, a suspended installation listing nothing', async () => {
    const r = await local('/api/sources/github');
    expect(r.status).toBe(200);
    const listing = r.json();
    expect(listing.installations.map((i: { account: string }) => i.account)).toEqual(['example-labs', 'example-org', 'example-sandbox']);
    expect(listing.installations[1].repos.map((x: { name: string }) => x.name)).toEqual(['old-site', 'orders-service', 'payments', 'runbooks']);
    expect(listing.installations[2]).toMatchObject({ state: 'suspended', repos: [] });
    expect(Number.isNaN(Date.parse(listing.fetched_at))).toBe(false);
  });

  it("both are owners only (the relay refuses anyone else) and follow the team routes' rules", async () => {
    // alice joins ops (olga owns it) as a member.
    expect((await local('/api/invitations/ops', { method: 'POST', headers: SAME_ORIGIN, body: { accept: true } })).status).toBe(200);
    for (const path of ['/api/sources/config', '/api/sources/github']) {
      const member = await local(`${path}?team=ops`);
      expect(member.status, path).toBe(502);
      expect(member.json(), path).toMatchObject({ error: 'relay_refused', relay_status: 403, relay_error: 'forbidden' });
      expect((await local(`${path}?team=design-guild`)).json(), path).toMatchObject({ error: 'not_on_team', team: 'design-guild' });
      expect((await local(`${path}?x=1`)).status, path).toBe(400);
      expect((await local(`${path}?team=Bad!`)).status, path).toBe(400);
      expect((await call(port, path)).status, path).toBe(401);
      expect((await local(path, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, path).toBe(403);
      for (const method of ['POST', 'PUT', 'DELETE']) expect((await local(path, { method, headers: SAME_ORIGIN, body: {} })).status, `${method} ${path}`).toBe(405);
    }
    expect((await local('/api/sources')).status).toBe(404);
    expect((await local('/api/sources/drive')).status).toBe(404);
  });

  it("GET /api/members-status: the owner sees each member's missing sources (keys of the current boundaries); a member only their own", async () => {
    const st = (await local('/api/members-status')).json();
    const by = (m: string) => st.members.find((x: { member: string }) => x.member === m);
    const version = (await local('/api/boundaries')).json().version;
    expect(by('alice').sources).toEqual({ boundaries_version: version, missing: [`folder:${DEMO_FOLDER_ID}`] });
    expect(by('bob').sources).toEqual({ boundaries_version: version, missing: [] });
    expect(by('carol').sources).toEqual({ boundaries_version: version - 1, missing: ['org:example-org', 'repo:example-labs/api'] });
    // An item removed from the boundaries disappears from every list.
    const without = { ...DEMO_BOUNDARIES, github_orgs: [], drive_folders: DEMO_BOUNDARIES.drive_folders.filter((f) => f.folder_id !== DEMO_FOLDER_ID) };
    expect((await local('/api/boundaries', { method: 'PUT', headers: SAME_ORIGIN, body: { version, boundaries: without } })).status).toBe(200);
    const after = (await local('/api/members-status')).json();
    expect(after.members.find((x: { member: string }) => x.member === 'alice').sources.missing).toEqual([]);
    expect(after.members.find((x: { member: string }) => x.member === 'carol').sources.missing).toEqual(['repo:example-labs/api']);
    // A quiet team: nothing reported.
    expect((await local('/api/members-status?team=research')).json().members.every((m: { sources: unknown }) => m.sources === null)).toBe(true);
    // Once alice is no longer an owner (bob is), she sees only her own entry's.
    expect((await local('/api/roster/bob', { method: 'PATCH', headers: SAME_ORIGIN, body: { role: 'owner' } })).status).toBe(200);
    expect((await local('/api/roster/alice', { method: 'PATCH', headers: SAME_ORIGIN, body: { role: 'member' } })).status).toBe(200);
    const member = (await local('/api/members-status')).json();
    for (const m of member.members) expect(m.sources === null, m.member).toBe(m.member !== 'alice');
    expect(member.members.find((x: { member: string }) => x.member === 'alice').sources).toEqual({ boundaries_version: version + 1, missing: [] });
    // And the sources settings are an owner's: refused now.
    expect((await local('/api/sources/config')).json()).toMatchObject({ error: 'relay_refused', relay_status: 403 });
  });
});

describe('/api/sources/* through the relay', () => {
  let relay: FakeSourcesRelay;
  let local: ConsoleServer;
  let hosted: ConsoleServer;
  let localPort: number;
  let hostedPort: number;
  const as = (who: string, path: string, opts: Parameters<typeof call>[2] = {}) =>
    call(hostedPort, path, { ...opts, host: PUBLIC_HOST, headers: { 'x-goog-iap-jwt-assertion': `iap:${who}`, ...(opts.headers ?? {}) } });

  beforeEach(async () => {
    relay = await new FakeSourcesRelay().start();
    const client = new RelayClient({ url: relay.url, team: 'research', token: () => 'service-account-id-token', attempts: 1 });
    hosted = createConsoleServer({
      backend: relayBackend(client),
      staticDir: site(),
      hosted: { publicHost: PUBLIC_HOST, verify: async (a) => (a?.startsWith('iap:') ? { email: a.slice(4) } : null), ipHashSalt: SALT },
    });
    hostedPort = await hosted.listen(0);
    local = createConsoleServer({ backend: relayBackend(new RelayClient({ url: relay.url, team: 'research', token: () => 'google-id-token', attempts: 1 })), key: KEY, staticDir: site() });
    localPort = await local.listen(0);
  });
  afterEach(async () => {
    await hosted.close();
    await local.close();
    await relay.close();
  });

  it('config: hosted passes the picker settings on for the viewer; locally google_picker is null whatever the relay holds', async () => {
    const h = await as('alice@example.com', '/api/sources/config?team=research');
    expect(h.status).toBe(200);
    // The viewer's own IAP-verified email rides along for Google's sign-in (§5.2).
    expect(h.json()).toEqual({ github: { configured: true, install_url: INSTALL_URL }, google_picker: { ...PICKER, login_hint: 'alice@example.com' } });
    const sent = relay.seen.find((s) => s.path === '/v1/teams/research/sources/config')!;
    expect(sent.method).toBe('GET');
    expect(sent.headers['x-relay-on-behalf-of']).toBe('alice@example.com');
    const l = await call(localPort, '/api/sources/config', { headers: { 'X-Console-Key': KEY } });
    expect(l.status).toBe(200);
    expect(l.json()).toEqual({ github: { configured: true, install_url: INSTALL_URL }, google_picker: null });
  });

  it('config: only well-formed fields reach the page, and nothing else the relay sends', async () => {
    relay.config.body = {
      github: { configured: true, install_url: INSTALL_URL, private_key: '-----BEGIN PRIVATE KEY-----' },
      google_picker: { ...PICKER, token: 'ya29.secret' },
      installation_token: 'ghs_secret',
    };
    const r = await as('alice@example.com', '/api/sources/config');
    expect(r.json()).toEqual({ github: { configured: true, install_url: INSTALL_URL }, google_picker: { ...PICKER, login_hint: 'alice@example.com' } });
    expect(r.body).not.toMatch(/secret|PRIVATE/);
    for (const [github, picker, expected] of [
      [{ configured: true, install_url: 'https://evil.example/apps/x/installations/new' }, PICKER, { configured: true, install_url: null }],
      [{ configured: true, install_url: 'javascript:alert(1)' }, PICKER, { configured: true, install_url: null }],
      [{ configured: 'yes', install_url: INSTALL_URL }, PICKER, { configured: false, install_url: null }],
      [{ configured: false, install_url: null }, null, { configured: false, install_url: null }],
    ] as const) {
      relay.config.body = { github, google_picker: picker };
      expect((await as('alice@example.com', '/api/sources/config')).json().github).toEqual(expected);
    }
    for (const bad of [{ ...PICKER, api_key: 'AIzaTooShort' }, { ...PICKER, client_id: 'evil.example.com' }, { ...PICKER, app_id: '12' }, { ...PICKER, app_id: 123456789012 }, 'x', null]) {
      relay.config.body = { github: { configured: false, install_url: null }, google_picker: bad };
      expect((await as('alice@example.com', '/api/sources/config')).json().google_picker).toBeNull();
    }
  });

  it('github: proxied for the viewer and shaped (malformed entries dropped, sorted, at most 1000 per installation)', async () => {
    const many = Array.from({ length: GITHUB_REPOS_MAX + 5 }, (_, i) => ({ name: `r${String(i).padStart(4, '0')}`, id: i + 1, private: false, archived: false }));
    relay.github.body = {
      installations: [
        {
          account: 'example-org',
          state: 'ok',
          repository_selection: 'all',
          repos: [
            { name: 'Web', id: 2, private: true, archived: false, html_url: 'https://github.com/example-org/web' },
            { name: 'api', id: 1, private: 'yes', archived: 1 },
            { name: '..', id: 3 },
            { name: 'bad/name', id: 4 },
            { name: 'zero', id: 0 },
            { name: 'float', id: 1.5 },
            'junk',
          ],
          truncated: false,
          token: 'ghs_secret',
        },
        { account: 'big-org', state: 'ok', repository_selection: 'selected', repos: many, truncated: false },
        { account: 'paused-org', state: 'suspended', repository_selection: 'all', repos: [{ name: 'hidden', id: 9 }], truncated: false },
        { account: '-bad', state: 'ok', repos: [] },
        null,
      ],
      fetched_at: '2026-11-11T10:00:00.000Z',
    };
    const r = await as('alice@example.com', '/api/sources/github?team=research');
    expect(r.status).toBe(200);
    expect(relay.seen.find((s) => s.path === '/v1/teams/research/sources/github')!.headers['x-relay-on-behalf-of']).toBe('alice@example.com');
    const listing = r.json();
    expect(r.body).not.toContain('secret');
    expect(listing.fetched_at).toBe('2026-11-11T10:00:00.000Z');
    expect(listing.installations.map((i: { account: string }) => i.account)).toEqual(['example-org', 'big-org', 'paused-org']);
    expect(listing.installations[0]).toEqual({
      account: 'example-org',
      state: 'ok',
      repository_selection: 'all',
      repos: [
        { name: 'api', id: 1, private: false, archived: false },
        { name: 'Web', id: 2, private: true, archived: false },
      ],
      truncated: false,
    });
    expect(listing.installations[1].repos).toHaveLength(GITHUB_REPOS_MAX);
    expect(listing.installations[1]).toMatchObject({ repository_selection: 'selected', truncated: true });
    expect(listing.installations[2]).toEqual({ account: 'paused-org', state: 'suspended', repository_selection: 'all', repos: [], truncated: false });
    expect(githubListingView('nonsense').installations).toEqual([]);
  });

  it("github: the relay's refusals as the page reads them (not configured, GitHub down, rate limited with Retry-After, non-owner)", async () => {
    const get = () => as('alice@example.com', '/api/sources/github');
    relay.github = { status: 404, body: { error: 'github_not_configured', detail: 'The relay has no GitHub App.' } };
    const none = await get();
    expect(none.status).toBe(404);
    expect(none.json()).toEqual({ error: 'not_found' });
    // A relay before this change (no route) reads the same: never "not on this team".
    relay.github = { status: 404, body: { detail: 'Not Found' } };
    expect((await get()).json()).toEqual({ error: 'not_found' });
    relay.config = { status: 404, body: { detail: 'Not Found' } };
    expect((await as('alice@example.com', '/api/sources/config')).json()).toEqual({ error: 'not_found' });

    relay.github = { status: 502, body: { error: 'github_unavailable', detail: 'GitHub did not answer.' } };
    expect((await get()).json()).toEqual({ error: 'relay_refused', relay_status: 502, relay_error: 'github_unavailable', detail: 'GitHub did not answer.' });
    relay.github = { status: 502, body: { error: 'github_app_misconfigured', detail: 'GitHub refused the app.' } };
    expect((await get()).json()).toMatchObject({ relay_status: 502, relay_error: 'github_app_misconfigured' });

    relay.github = { status: 503, body: { error: 'github_rate_limited', detail: 'Try again later.' }, headers: { 'Retry-After': '120' } };
    const slow = await get();
    expect(slow.status).toBe(502);
    expect(slow.headers['retry-after']).toBe('120');
    expect(slow.json()).toEqual({ error: 'relay_refused', relay_status: 503, relay_error: 'github_rate_limited', detail: 'Try again later.', retry_after: 120 });
    relay.github = { status: 503, body: { error: 'github_rate_limited' }, headers: { 'Retry-After': '999999' } };
    expect((await get()).headers['retry-after']).toBe('3600');
    relay.github = { status: 503, body: { error: 'github_rate_limited' }, headers: { 'Retry-After': 'Wed, 11 Nov 2026 10:00:00 GMT' } };
    const dated = await get();
    expect(dated.headers['retry-after']).toBeUndefined();
    expect(dated.json().retry_after).toBeUndefined();

    relay.github = { status: 403, body: { error: 'forbidden', detail: 'Only team owners can do this.' } };
    expect((await get()).json()).toMatchObject({ error: 'relay_refused', relay_status: 403, relay_error: 'forbidden' });
    relay.github = { status: 403, body: { error: 'not_a_member' } };
    const gone = await get();
    expect(gone.status).toBe(403);
    expect(gone.json()).toEqual({ error: 'not_on_team', email: 'alice@example.com', team: 'research' });
  });

  it('parseRetryAfter keeps whole seconds only, capped at an hour', () => {
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter(' 30 ')).toBe(30);
    expect(parseRetryAfter('3601')).toBe(3600);
    for (const v of [null, '', '-1', '1.5', 'soon', 'Wed, 11 Nov 2026 10:00:00 GMT', '12345678901']) expect(parseRetryAfter(v)).toBeUndefined();
    expect(new RelayError(503, 'github_rate_limited', '', 5).retryAfter).toBe(5);
    expect(new RelayError(503, 'x', '').retryAfter).toBeUndefined();
  });

  it("sourcesConfigView adds the viewer's own email as login_hint, hosted only and only when it is an email", () => {
    const raw = { github: { configured: false, install_url: null }, google_picker: PICKER };
    expect(sourcesConfigView(raw, false, 'owner@example.com').google_picker).toEqual({ ...PICKER, login_hint: 'owner@example.com' });
    expect(sourcesConfigView(raw, false).google_picker).toEqual(PICKER);
    expect(sourcesConfigView(raw, true, 'owner@example.com').google_picker).toBeNull();
    for (const bad of ['', 'owner', 'Owner@Example.com', `${'x'.repeat(250)}@example.com`]) {
      expect(sourcesConfigView(raw, false, bad).google_picker, bad).toEqual(PICKER);
    }
    // A relay that sends its own login_hint is not believed: only the viewer's verified email.
    expect(sourcesConfigView({ ...raw, google_picker: { ...PICKER, login_hint: 'someone@example.com' } }, false).google_picker).toEqual(PICKER);
  });

  it('sourcesConfigView is null-safe and drops the picker locally', () => {
    expect(sourcesConfigView(undefined, false)).toEqual({ github: { configured: false, install_url: null }, google_picker: null });
    expect(sourcesConfigView({ github: { configured: true, install_url: INSTALL_URL }, google_picker: PICKER }, true).google_picker).toBeNull();
    expect(sourcesConfigView({ github: { configured: false, install_url: INSTALL_URL } }, false).github).toEqual({ configured: false, install_url: null });
  });
});

describe('the picker page, /pick/drive (PICKERS-SPEC §3.7, §5.4)', () => {
  const servers: ConsoleServer[] = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });
  async function hostedOn(dir: string): Promise<number> {
    const app = createConsoleServer({
      backend: demoBackend(new DemoAccount()),
      staticDir: dir,
      hosted: { publicHost: PUBLIC_HOST, verify: async (a) => (a?.startsWith('iap:') ? { email: a.slice(4) } : null), ipHashSalt: SALT },
    });
    servers.push(app);
    return app.listen(0);
  }
  async function localOn(dir: string): Promise<number> {
    const app = createConsoleServer({ backend: demoBackend(new DemoAccount()), key: KEY, staticDir: dir });
    servers.push(app);
    return app.listen(0);
  }
  const signedIn = (port: number, path: string, method = 'GET') =>
    call(port, path, { method, host: PUBLIC_HOST, headers: { 'x-goog-iap-jwt-assertion': 'iap:alice@example.com' } });

  it('hosted: serves pick-drive.html under the picker headers, on GET and HEAD only', async () => {
    const port = await hostedOn(site());
    const r = await signedIn(port, '/pick/drive');
    expect(r.status).toBe(200);
    expect(r.body).toBe(PICKER_HTML);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['content-security-policy']).toBe(PICKER_CONTENT_SECURITY_POLICY);
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(r.headers['cache-control']).toBe('no-store');
    const head = await signedIn(port, '/pick/drive', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(PICKER_HTML)));
    expect(head.headers['content-security-policy']).toBe(PICKER_CONTENT_SECURITY_POLICY);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const refused = await signedIn(port, '/pick/drive', method);
      expect(refused.status, method).toBe(405);
      expect(refused.headers.allow).toBe('GET, HEAD');
      expect(refused.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    }
  });

  it('hosted: nothing else is the picker page, and the page never loads under other headers', async () => {
    const port = await hostedOn(site());
    // Without IAP: the bare 401, as every hosted path.
    const anon = await call(port, '/pick/drive', { host: PUBLIC_HOST });
    expect(anon.status).toBe(401);
    expect(anon.body).toBe('unauthorized\n');
    // The built file itself, however it is spelt: 404.
    for (const path of ['/pick-drive.html', '/PICK-DRIVE.HTML', '/pick-drive%2Ehtml', '/pick-drive%2ehtml', '/pick/drive?n=1', '/pick/drive?team=demo']) {
      const r = await signedIn(port, path);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toContain('Choose folders');
    }
    // Other paths near it are the console's own pages, under the console's own headers.
    for (const path of ['/pick/drive/', '/pick', '/pick/github', '/', '/assets/pick-drive-abc.js']) {
      const r = await signedIn(port, path);
      expect(r.status, path).toBe(200);
      expect(r.headers['content-security-policy'], path).toBe(CONTENT_SECURITY_POLICY);
      expect(r.headers['cross-origin-opener-policy'], path).toBe('same-origin');
      expect(r.headers['referrer-policy'], path).toBe('no-referrer');
      expect(r.body, path).not.toContain('Choose folders');
    }
    // A path the URL parser would resolve is refused before routing.
    expect((await signedIn(port, '/pick/./drive')).status).toBe(400);
    expect((await signedIn(port, '/x/../pick/drive')).status).toBe(400);
  });

  it('hosted: 404 when the picker page was not built (or the console was not built at all)', async () => {
    expect((await signedIn(await hostedOn(site(false)), '/pick/drive')).status).toBe(404);
    expect((await signedIn(await hostedOn(join(tmpdir(), 'team-relay-no-such-console')), '/pick/drive')).status).toBe(404);
  });

  it('local: /pick/drive and /pick-drive.html are 404 (the Picker runs only on the hosted console)', async () => {
    const port = await localOn(site());
    for (const path of ['/pick/drive', '/pick-drive.html']) {
      for (const method of ['GET', 'HEAD']) {
        const r = await call(port, path, { method });
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(r.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
        expect(r.body).not.toContain('Choose folders');
      }
    }
    expect((await call(port, '/')).status).toBe(200);
  });

  // console/vite.config.ts builds pick-drive.html beside index.html; served at /pick/drive, its
  // assets are one level up. Checked on the built console when it has been built.
  const built = new URL('../dist/console/pick-drive.html', import.meta.url);
  it.skipIf(!existsSync(built))('the built picker page refers to its assets one level up, and to nothing outside our origin', () => {
    const html = readFileSync(built, 'utf8');
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref, ref).toMatch(/^\.\.\/assets\/[A-Za-z0-9._-]+\.(js|css)$/);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toMatch(/style=|<style/);
    const index = readFileSync(new URL('../dist/console/index.html', import.meta.url), 'utf8');
    expect(index).not.toContain('pick-drive');
  });

  it('the picker CSP allows Google only where §5.4 says, and nothing inline', () => {
    expect(PICKER_CONTENT_SECURITY_POLICY).not.toMatch(/unsafe|\*|http:/);
    expect(PICKER_CONTENT_SECURITY_POLICY.split('; ').map((d) => d.split(' ')[0])).toEqual([
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'font-src',
      'connect-src',
      'frame-src',
      'object-src',
      'base-uri',
      'form-action',
      'frame-ancestors',
    ]);
  });
});
