// M10-SPEC §2a: /team-relay:drive. Google's endpoints are a fake fetch, the Keychain is a fake,
// and the browser is this test calling the loopback listener. Nothing here talks to Google or
// touches the real Keychain. All names and ids are synthetic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { DRIVE_SCOPE, GOOGLE_HOSTS, clearDriveTokenCache, type Keychain } from '../src/google-drive.js';
import { DRIVE_CONNECT_SCOPE, MAC_ONLY, checkIdToken, driveDisconnect, driveStatus, startDriveConnect, teamDriveDomain } from '../src/drive-login.js';
import { USAGE, parseDriveArgs, runDriveCli } from '../src/drive-cli.js';

const DOMAIN = 'example.com';
const CLIENT = { client_id: '1234-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-clientsecret' };
const REFRESH = '1//0gNEW-refresh_secret.abcdefXYZ';
const OLD_REFRESH = '1//0gOLD-refresh_secret.abcdefXYZ';
const ACCESS = 'ya29.ACCESS-secret-connect';
const CODE = '4/0AbCdEf-authcode_secret';

function fakeKeychain(initial: Record<string, string> = {}): Keychain & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    async account() {
      return items.keys().next().value ?? null;
    },
    async read(a) {
      return items.get(a) ?? null;
    },
    async write(a, t) {
      items.set(a, t);
    },
    async removeAll() {
      const n = items.size;
      items.clear();
      return n;
    },
  };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', kid: 'k' })}.${b64(claims)}.c2ln`;

type Seen = { url: URL; body: URLSearchParams; redirect: RequestInit['redirect'] };

class FakeGoogleAuth {
  seen: Seen[] = [];
  revoked: string[] = [];
  /** Set by the test after reading the auth URL. */
  challenge = '';
  redirectUri = '';
  nonce = '';
  claims: Record<string, unknown> = {};
  scope = `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE_SCOPE}`;
  tokenStatus = 200;
  omitRefresh = false;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    this.seen.push({ url, body, redirect: init?.redirect });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      this.revoked.push(body.get('token') ?? '');
      return json(200, {});
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      // Google checks PKCE: the verifier must hash to the challenge sent with the auth request.
      const verifier = body.get('code_verifier') ?? '';
      const s256 = createHash('sha256').update(verifier, 'ascii').digest('base64url');
      if (s256 !== this.challenge || body.get('code') !== CODE || body.get('redirect_uri') !== this.redirectUri) {
        return json(400, { error: 'invalid_grant', error_description: `Bad ${verifier}` });
      }
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe(CLIENT.client_id);
      if (this.tokenStatus !== 200) return json(this.tokenStatus, { error: 'invalid_request' });
      return json(200, {
        access_token: ACCESS,
        expires_in: 3599,
        scope: this.scope,
        token_type: 'Bearer',
        id_token: idToken({ ...this.baseClaims(), ...this.claims }),
        ...(this.omitRefresh ? {} : { refresh_token: REFRESH }),
      });
    }
    throw new Error(`unexpected request to ${url.toString()}`);
  };

  baseClaims() {
    return {
      iss: 'https://accounts.google.com',
      aud: CLIENT.client_id,
      azp: CLIENT.client_id,
      sub: '1000001',
      email: `alice@${DOMAIN}`,
      email_verified: true,
      hd: DOMAIN,
      nonce: this.nonce,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  }
}

/** A browser request to the listener, with any Host header. */
function hit(port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let google: FakeGoogleAuth;
let keychain: ReturnType<typeof fakeKeychain>;
let logs: string[];

beforeEach(() => {
  google = new FakeGoogleAuth();
  keychain = fakeKeychain();
  logs = [];
  clearDriveTokenCache();
});

async function start(extra: Partial<Parameters<typeof startDriveConnect>[0]> = {}) {
  let opened = '';
  const flow = await startDriveConnect({
    domain: DOMAIN,
    client: CLIENT,
    keychain,
    fetch: google.fetch as typeof fetch,
    open: (u) => (opened = u),
    log: (l) => logs.push(l),
    timeoutMs: 10_000,
    ...extra,
  });
  const auth = new URL(opened);
  google.challenge = auth.searchParams.get('code_challenge') ?? '';
  google.redirectUri = auth.searchParams.get('redirect_uri') ?? '';
  google.nonce = auth.searchParams.get('nonce') ?? '';
  return { flow, auth, state: auth.searchParams.get('state') ?? '' };
}

/** Nothing secret in any log line, result or error; every request to a fixed Google host, no redirects. */
function assertClean(...values: unknown[]) {
  const s = JSON.stringify([values, logs, String(values.map((v) => (v instanceof Error ? v.message : '')))]);
  for (const secret of [REFRESH, OLD_REFRESH, ACCESS, CODE, CLIENT.client_secret]) expect(s).not.toContain(secret);
  for (const c of google.seen) {
    expect(c.url.protocol).toBe('https:');
    expect(GOOGLE_HOSTS.has(c.url.hostname)).toBe(true);
    expect(c.redirect).toBe('error');
    expect(c.url.search).toBe('');
  }
}

describe('connect', () => {
  let flows: Array<{ cancel(): void }> = [];
  afterEach(() => {
    for (const f of flows) f.cancel();
    flows = [];
  });

  it('asks Google for drive.readonly offline access with PKCE, state, nonce and hd; stores the token only in the Keychain', async () => {
    const { flow, auth, state } = await start({ loginHint: `alice@${DOMAIN}` });
    flows.push(flow);
    expect(`${auth.origin}${auth.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = auth.searchParams;
    expect(p.get('scope')).toBe(DRIVE_CONNECT_SCOPE);
    expect(p.get('scope')!.split(' ')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly']);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('hd')).toBe(DOMAIN);
    expect(p.get('login_hint')).toBe(`alice@${DOMAIN}`);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('client_id')).toBe(CLIENT.client_id);
    expect(p.has('client_secret')).toBe(false);
    expect(p.get('redirect_uri')).toBe(`http://127.0.0.1:${flow.port}/callback`);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const page = await hit(flow.port, `/callback?state=${state}&code=${encodeURIComponent(CODE)}&scope=x`);
    expect(page.status).toBe(200);
    const r = await flow.done;
    expect(r).toEqual({ email: `alice@${DOMAIN}`, replaced: null });
    expect([...keychain.items]).toEqual([[`alice@${DOMAIN}`, REFRESH]]);
    expect(google.revoked).toEqual([]);
    assertClean(r, page.body);
  });

  it('replacing another account\'s connection revokes the old token; the same account\'s is not revoked', async () => {
    keychain.items.set(`old@${DOMAIN}`, OLD_REFRESH);
    const { flow, state } = await start();
    await hit(flow.port, `/callback?state=${state}&code=${encodeURIComponent(CODE)}`);
    const r = await flow.done;
    expect(r).toEqual({ email: `alice@${DOMAIN}`, replaced: `old@${DOMAIN}` });
    expect([...keychain.items]).toEqual([[`alice@${DOMAIN}`, REFRESH]]);
    expect(google.revoked).toEqual([OLD_REFRESH]);

    google = new FakeGoogleAuth();
    const again = await start();
    await hit(again.flow.port, `/callback?state=${again.state}&code=${encodeURIComponent(CODE)}`);
    expect(await again.flow.done).toEqual({ email: `alice@${DOMAIN}`, replaced: null });
    expect(google.revoked).toEqual([]);
    assertClean(r);
  });

  it('refuses an account outside the team domain: revoked at Google, nothing stored', async () => {
    for (const claims of [{ email: 'eve@other.example', hd: 'other.example' }, { email: 'eve@other.example', hd: DOMAIN }, { hd: undefined }, { email: `eve@sub.${DOMAIN}` }]) {
      google = new FakeGoogleAuth();
      google.claims = claims;
      const { flow, state } = await start();
      await hit(flow.port, `/callback?state=${state}&code=${encodeURIComponent(CODE)}`);
      const err = await flow.done.catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(new RegExp(`not in ${DOMAIN.replace('.', '\\.')}.*nothing was stored`));
      expect(keychain.items.size).toBe(0);
      expect(google.revoked).toEqual([REFRESH]);
      assertClean(err);
    }
  });

  it('refuses a wrong nonce, audience, issuer, an unverified email or an expired ID token', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ nonce: 'someone-elses-nonce' }, /did not match this request/],
      [{ aud: 'other.apps.googleusercontent.com' }, /another app/],
      [{ iss: 'https://evil.example' }, /did not come from Google/],
      [{ email_verified: false }, /not verified/],
      [{ exp: 1 }, /expired/],
    ];
    for (const [claims, why] of cases) {
      google = new FakeGoogleAuth();
      google.claims = claims;
      const { flow, state } = await start();
      await hit(flow.port, `/callback?state=${state}&code=${encodeURIComponent(CODE)}`);
      const err = (await flow.done.catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(why);
      expect(keychain.items.size).toBe(0);
      assertClean(err);
    }
  });

  it('refuses when Drive access was not granted or no refresh token came back', async () => {
    google.scope = 'openid email';
    let s = await start();
    await hit(s.flow.port, `/callback?state=${s.state}&code=${encodeURIComponent(CODE)}`);
    expect(((await s.flow.done.catch((e: Error) => e)) as Error).message).toMatch(/Drive read access was not granted/);
    expect(google.revoked).toEqual([REFRESH]);

    google = new FakeGoogleAuth();
    google.omitRefresh = true;
    s = await start();
    await hit(s.flow.port, `/callback?state=${s.state}&code=${encodeURIComponent(CODE)}`);
    expect(((await s.flow.done.catch((e: Error) => e)) as Error).message).toMatch(/lasting Drive connection/);
    expect(google.revoked).toEqual([ACCESS]);
    expect(keychain.items.size).toBe(0);
  });

  it('a wrong state, path or Host is not ours: 404, and the listener keeps waiting', async () => {
    const { flow, state } = await start();
    flows.push(flow);
    const forged = 'A'.repeat(43);
    expect((await hit(flow.port, `/callback?state=${forged}&code=${encodeURIComponent(CODE)}`)).status).toBe(404);
    expect((await hit(flow.port, `/callback?state=${state}&state=${state}&code=x1234567890`)).status).toBe(404);
    expect((await hit(flow.port, `/other?state=${state}&code=${encodeURIComponent(CODE)}`)).status).toBe(404);
    expect((await hit(flow.port, `/callback?state=${state}&code=${encodeURIComponent(CODE)}`, `localhost:${flow.port}`)).status).toBe(404);
    expect(google.seen).toEqual([]);
    // The real answer still completes it.
    expect((await hit(flow.port, `/callback?state=${state}&code=${encodeURIComponent(CODE)}`)).status).toBe(200);
    expect((await flow.done).email).toBe(`alice@${DOMAIN}`);
    // After that the listener is closed.
    await expect(hit(flow.port, `/callback?state=${state}&code=${encodeURIComponent(CODE)}`)).rejects.toThrow();
  });

  it('a PKCE mismatch is refused by Google and nothing is stored', async () => {
    const { flow, state } = await start();
    google.challenge = 'not-the-challenge-we-sent-------------------';
    await hit(flow.port, `/callback?state=${state}&code=${encodeURIComponent(CODE)}`);
    const err = (await flow.done.catch((e: Error) => e)) as Error;
    expect(err.message).toBe('Google refused the sign-in (400 invalid_grant); run /team-relay:drive connect again');
    expect(keychain.items.size).toBe(0);
    assertClean(err);
  });

  it('a cancelled sign-in or a missing code ends the wait with nothing stored', async () => {
    let s = await start();
    expect((await hit(s.flow.port, `/callback?state=${s.state}&error=access_denied`)).status).toBe(200);
    expect(((await s.flow.done.catch((e: Error) => e)) as Error).message).toMatch(/cancelled or refused \(access_denied\)/);
    s = await start();
    expect((await hit(s.flow.port, `/callback?state=${s.state}`)).status).toBe(400);
    expect(((await s.flow.done.catch((e: Error) => e)) as Error).message).toMatch(/no code/);
    expect(keychain.items.size).toBe(0);
    expect(google.seen).toEqual([]);
  });

  it('times out', async () => {
    const { flow } = await start({ timeoutMs: 50 });
    expect(((await flow.done.catch((e: Error) => e)) as Error).message).toMatch(/not finished within/);
  });

  it('refuses a login hint outside the domain before opening anything', async () => {
    await expect(start({ loginHint: 'eve@other.example' })).rejects.toThrow(/must be an address in example\.com/);
  });

  it('a Keychain that cannot keep the token: Google token revoked, nothing stored', async () => {
    const broken: Keychain = { ...keychain, write: async () => Promise.reject(new Error('the Keychain could not be written (security exit 1)')) };
    const { flow, state } = await start({ keychain: broken });
    await hit(flow.port, `/callback?state=${state}&code=${encodeURIComponent(CODE)}`);
    const err = (await flow.done.catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/Keychain could not keep the connection/);
    expect(google.revoked).toEqual([REFRESH]);
    assertClean(err);
  });
});

describe('checkIdToken', () => {
  it('accepts an array audience only with azp equal to our client', () => {
    const base = { iss: 'accounts.google.com', email: `a@${DOMAIN}`, email_verified: true, hd: DOMAIN, nonce: 'n', exp: 9e9 };
    const want = { clientId: CLIENT.client_id, nonce: 'n', domain: DOMAIN, nowMs: Date.now() };
    expect(checkIdToken(idToken({ ...base, aud: [CLIENT.client_id, 'x'], azp: CLIENT.client_id }), want)).toEqual({ ok: true, email: `a@${DOMAIN}` });
    expect(checkIdToken(idToken({ ...base, aud: [CLIENT.client_id, 'x'], azp: 'x' }), want).ok).toBe(false);
    expect(checkIdToken('not.a-jwt', want).ok).toBe(false);
    expect(checkIdToken(undefined, want).ok).toBe(false);
  });
});

describe('status and disconnect', () => {
  it('status names the account, never the token', async () => {
    expect(await driveStatus(keychain)).toMatch(/not connected/);
    keychain.items.set(`alice@${DOMAIN}`, REFRESH);
    const line = await driveStatus(keychain);
    expect(line).toMatch(new RegExp(`connected as alice@${DOMAIN}`));
    expect(line).not.toContain(REFRESH);
    expect(await driveStatus(null)).toBe(MAC_ONLY);
  });

  it('disconnect revokes at Google and deletes the Keychain item', async () => {
    keychain.items.set(`alice@${DOMAIN}`, REFRESH);
    const line = await driveDisconnect(keychain, google.fetch as typeof fetch);
    expect(line).toMatch(/revoked at Google and removed from this Mac/);
    expect(google.revoked).toEqual([REFRESH]);
    expect(keychain.items.size).toBe(0);
    expect(google.seen[0]!.url.toString()).toBe('https://oauth2.googleapis.com/revoke');
    assertClean(line);
    expect(await driveDisconnect(keychain, google.fetch as typeof fetch)).toMatch(/was not connected/);
  });

  it('disconnect still deletes the item when Google cannot be reached', async () => {
    keychain.items.set(`alice@${DOMAIN}`, REFRESH);
    const line = await driveDisconnect(keychain, (async () => Promise.reject(new Error('offline'))) as typeof fetch);
    expect(line).toMatch(/removed from this Mac\. Google could not confirm/);
    expect(keychain.items.size).toBe(0);
    expect(line).not.toContain(REFRESH);
  });
});

describe('teamDriveDomain', () => {
  it('uses the one domain, or the login hint\'s among several', () => {
    expect(teamDriveDomain([{ domain: DOMAIN }, { domain: DOMAIN }])).toBe(DOMAIN);
    expect(() => teamDriveDomain([])).toThrow(/no shared Google Drive/);
    expect(() => teamDriveDomain(null)).toThrow(/no shared Google Drive/);
    expect(() => teamDriveDomain([{ domain: DOMAIN }, { domain: 'other.example' }])).toThrow(/several domains/);
    expect(teamDriveDomain([{ domain: DOMAIN }, { domain: 'other.example' }], 'bob@other.example')).toBe('other.example');
    expect(() => teamDriveDomain([{ domain: DOMAIN }], 'bob@other.example')).toThrow(/not in your team's Drive domain/);
  });
});

describe('the /team-relay:drive command line', () => {
  const boundaries = (drives: Array<{ domain: string; shared_drive: string }>) => ({
    team: 'demo',
    version: 1,
    boundaries: { topic: 't', github_orgs: [], drives, member_folders: false },
    updated_at: null,
    updated_by: null,
  });

  it('parses only the known subcommands', () => {
    expect(parseDriveArgs([])).toEqual({ cmd: 'status' });
    expect(parseDriveArgs(['status'])).toEqual({ cmd: 'status' });
    expect(parseDriveArgs(['disconnect'])).toEqual({ cmd: 'disconnect' });
    expect(parseDriveArgs(['connect'])).toEqual({ cmd: 'connect' });
    expect(parseDriveArgs(['connect', 'Alice@Example.com'])).toEqual({ cmd: 'connect', email: 'alice@example.com' });
    for (const bad of [['connect', 'x'], ['status', 'x'], ['rm', '-rf'], ['connect', 'a@b.c', 'd']]) expect(parseDriveArgs(bad)).toBeNull();
  });

  it('refuses on other platforms and prints usage for anything else', async () => {
    expect(await runDriveCli(['status'], { platform: 'linux', keychain })).toEqual({ exitCode: 1, line: MAC_ONLY });
    expect(await runDriveCli(['connect'], { platform: 'win32' })).toEqual({ exitCode: 1, line: MAC_ONLY });
    expect(await runDriveCli(['bogus'], { platform: 'darwin', keychain })).toEqual({ exitCode: 2, line: USAGE });
  });

  it('connects with the team\'s domain and the relay\'s client, end to end', async () => {
    let flowPort = 0;
    let state = '';
    const run = runDriveCli(['connect'], {
      platform: 'darwin',
      keychain,
      fetch: google.fetch as typeof fetch,
      relay: () => ({ driveClient: async () => CLIENT, boundaries: async () => boundaries([{ domain: DOMAIN, shared_drive: 'Example Team Drive' }]) }),
      open: (u) => {
        const a = new URL(u);
        google.challenge = a.searchParams.get('code_challenge')!;
        google.redirectUri = a.searchParams.get('redirect_uri')!;
        google.nonce = a.searchParams.get('nonce')!;
        expect(a.searchParams.get('hd')).toBe(DOMAIN);
        flowPort = Number(new URL(google.redirectUri).port);
        state = a.searchParams.get('state')!;
      },
      timeoutMs: 10_000,
      log: (l) => logs.push(l),
    });
    while (!flowPort) await new Promise((r) => setTimeout(r, 5));
    await hit(flowPort, `/callback?state=${state}&code=${encodeURIComponent(CODE)}`);
    const out = await run;
    expect(out).toEqual({ exitCode: 0, line: `Google Drive connected as alice@${DOMAIN} (read-only). The token is kept in this Mac's Keychain only.` });
    expect(keychain.items.get(`alice@${DOMAIN}`)).toBe(REFRESH);
    assertClean(out);
  });

  it('says why it cannot connect: no drives, no Drive client, not signed in', async () => {
    const noDrives = await runDriveCli(['connect'], {
      platform: 'darwin',
      keychain,
      relay: () => ({ driveClient: async () => CLIENT, boundaries: async () => boundaries([]) }),
    });
    expect(noDrives.exitCode).toBe(1);
    expect(noDrives.line).toMatch(/no shared Google Drive/);
    const noClient = await runDriveCli(['connect'], {
      platform: 'darwin',
      keychain,
      relay: () => ({
        driveClient: async () => Promise.reject(Object.assign(new Error('x'), { status: 404, code: 'drive_not_configured' })),
        boundaries: async () => boundaries([{ domain: DOMAIN, shared_drive: 'D' }]),
      }),
    });
    expect(noClient.line).toBe('Google Drive: Google Drive is not set up for this team (ask the relay admin)');
    const notSignedIn = await runDriveCli(['connect'], {
      platform: 'darwin',
      keychain,
      relay: () => {
        throw new Error('not connected');
      },
    });
    expect(notSignedIn.line).toMatch(/run \/team-relay:login first/);
  });
});

describe('commands/drive.md', () => {
  it('runs dist/drive-cli.js itself, at expansion; the model can neither invoke it nor use tools', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { ENTRIES } = await import('../scripts/build.js');
    const root = join(import.meta.dirname, '..');
    const text = readFileSync(join(root, 'commands', 'drive.md'), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    expect(fm).toMatch(/^disable-model-invocation: true$/m);
    expect(fm).not.toMatch(/allowed-tools/);
    const injected = [...text.matchAll(/!`([^`]*)`/g)].map((m) => m[1]);
    expect(injected).toEqual(['node "${CLAUDE_PLUGIN_ROOT}/dist/drive-cli.js" $ARGUMENTS']);
    expect(ENTRIES).toContain('drive-cli');
  });
});
