// /team-relay:drive (M10-SPEC §2a): connect, show and disconnect the member's Google Drive.
//
// connect: Google's OAuth for installed apps, in the style of RFC 8252 and like login.ts:
//   1. The Desktop OAuth client comes from the relay (GET /v1/teams/{team}/drive-client); the
//      domain is the team's Drive domain (its boundaries).
//   2. A PKCE verifier and its S256 challenge, a random state and a random nonce, and an HTTP
//      listener on 127.0.0.1 only, on a free port, for a limited time.
//   3. The browser opens accounts.google.com/o/oauth2/v2/auth through a private redirect file
//      (console-open.ts; the URL is never a process argument) with scope
//      "openid email https://www.googleapis.com/auth/drive.readonly" (openid and email only to
//      learn, from the ID token, which account signed in), access_type=offline,
//      prompt=consent, hd=<domain> and, when given, login_hint.
//   4. Only GET /callback with Host 127.0.0.1:<port> and exactly one state equal to ours
//      (constant time) ends the wait; anything else gets a 404. The code and the verifier are
//      exchanged at oauth2.googleapis.com/token.
//   5. The answer must carry a refresh token, the drive.readonly scope and an ID token (received
//      straight from Google's token endpoint over TLS, OIDC Core §3.1.3.7) whose issuer is
//      Google, audience our client, nonce ours, not expired, email verified, `hd` the team's
//      domain and email in that domain. Anything else: the tokens are revoked at Google and
//      nothing is stored.
//   6. The refresh token is stored only in the macOS Keychain (google-drive.ts), replacing any
//      earlier Drive connection on this Mac. It never goes to the relay, a file or a log.
// status: which account is connected (never the token).
// disconnect: revoke at Google (best effort) and delete the Keychain item.
//
// macOS only: elsewhere there is no Keychain, and the token is never kept in a file instead.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openInBrowser } from './console-open.js';
import { EMAIL_RE } from './credentials.js';
import {
  DRIVE_SCOPE,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  REFRESH_TOKEN_RE,
  clearDriveTokenCache,
  emailInDomain,
  googleForm,
  isDomain,
  oauthError,
  revokeToken,
  type FetchLike,
  type Keychain,
} from './google-drive.js';
import { base64url, codeChallenge } from './login.js';

export const DRIVE_CONNECT_TIMEOUT_MS = 110_000;
export const DRIVE_CONNECT_SCOPE = `openid email ${DRIVE_SCOPE}`;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const GOOGLE_CODE_RE = /^[A-Za-z0-9._~/+-]{10,1024}$/;
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
export const MAC_ONLY = 'Google Drive can only be connected on macOS: the connection is kept in the macOS Keychain, never in a file.';

export class DriveConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveConnectError';
  }
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function page(title: string, text: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${title}</title>`,
    '<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f5;color:#1c1c1a}',
    'main{max-width:26rem;padding:1.5rem 1.75rem;border:1px solid #e3e2de;border-radius:12px;background:#fff}',
    'h1{font-size:16px;margin:0 0 .4rem}p{margin:0;color:#5c5b57}',
    '@media (prefers-color-scheme:dark){body{background:#151514;color:#ecebe7}main{background:#1d1d1b;border-color:#2e2e2b}p{color:#a3a29c}}</style>',
    `</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`,
    '',
  ].join('\n');
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Security-Policy': PAGE_CSP,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    Connection: 'close',
  });
  res.end(body);
}

/** The ID token's claims, without checking a signature (it came straight from Google over TLS). */
export function idTokenClaims(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts[1]!.length > 8192) return null;
  try {
    const v = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The signed-in email when the ID token passes every check, else a reason. */
export function checkIdToken(
  idToken: unknown,
  want: { clientId: string; nonce: string; domain: string; nowMs: number },
): { ok: true; email: string } | { ok: false; reason: string } {
  if (typeof idToken !== 'string' || idToken.length > 16_384) return { ok: false, reason: 'Google did not say which account signed in' };
  const c = idTokenClaims(idToken);
  if (!c) return { ok: false, reason: 'Google did not say which account signed in' };
  if (typeof c.iss !== 'string' || !GOOGLE_ISSUERS.has(c.iss)) return { ok: false, reason: 'the sign-in did not come from Google' };
  const audOk = c.aud === want.clientId || (Array.isArray(c.aud) && c.aud.includes(want.clientId) && c.azp === want.clientId);
  if (!audOk) return { ok: false, reason: 'the sign-in was for another app' };
  if (typeof c.exp !== 'number' || c.exp * 1000 <= want.nowMs) return { ok: false, reason: 'the sign-in had already expired' };
  if (typeof c.nonce !== 'string' || !sameSecret(c.nonce, want.nonce)) return { ok: false, reason: 'the sign-in did not match this request' };
  const email = c.email;
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, reason: 'Google did not say which account signed in' };
  if (c.email_verified !== true) return { ok: false, reason: 'the Google account\'s email is not verified' };
  if (c.hd !== want.domain || !emailInDomain(email, want.domain)) {
    return { ok: false, reason: `the Google account is not in ${want.domain}; sign in with your ${want.domain} account` };
  }
  return { ok: true, email: email.toLowerCase() };
}

export type DriveClient = { client_id: string; client_secret: string };

export type DriveConnectOptions = {
  /** The team's Drive domain: the `hd` sent to Google, and the only domain accepted back. */
  domain: string;
  /** The Desktop OAuth client the relay serves. */
  client: DriveClient;
  loginHint?: string;
  keychain: Keychain;
  fetch?: FetchLike;
  /** Opens the sign-in URL. Default: the platform opener through a private redirect file. */
  open?: (url: string) => void;
  now?: () => number;
  timeoutMs?: number;
  log?: (line: string) => void;
};

export type DriveConnectResult = { email: string; replaced: string | null };

export type DriveConnectFlow = {
  url: string;
  port: number;
  done: Promise<DriveConnectResult>;
  cancel(): void;
};

/** Start a connection: the listener is up and the browser asked to open when this resolves. */
export async function startDriveConnect(opts: DriveConnectOptions): Promise<DriveConnectFlow> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  if (!isDomain(opts.domain)) throw new DriveConnectError('the team\'s Drive domain is not valid');
  if (opts.loginHint !== undefined && (!EMAIL_RE.test(opts.loginHint) || !emailInDomain(opts.loginHint, opts.domain))) {
    throw new DriveConnectError(`the account must be an address in ${opts.domain}`);
  }
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const verifier = base64url(randomBytes(48));
  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const challenge = codeChallenge(verifier);

  let settle!: { resolve: (v: DriveConnectResult) => void; reject: (e: Error) => void };
  const done = new Promise<DriveConnectResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  done.catch(() => {});
  let finished = false;
  let used = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let server: Server | null = null;
  let port = 0;

  const shut = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (server) {
      server.close();
      server.closeAllConnections();
    }
  };
  const fail = (message: string) => {
    if (finished) return;
    finished = true;
    shut();
    settle.reject(new DriveConnectError(message));
  };
  const succeed = (v: DriveConnectResult) => {
    if (finished) return;
    finished = true;
    shut();
    settle.resolve(v);
  };

  /** Tokens Google issued but we will not keep are revoked (best effort; never logged). */
  const discard = async (token: string | null) => {
    if (!token) return;
    const gone = await revokeToken(doFetch, token).catch(() => false);
    if (!gone) log('could not revoke the unused Google token; remove "team relay" access at myaccount.google.com/permissions');
  };

  const redirectUri = () => `http://127.0.0.1:${port}/callback`;

  const exchange = async (code: string): Promise<void> => {
    const r = await googleForm(
      doFetch,
      GOOGLE_TOKEN_URL,
      {
        code,
        client_id: opts.client.client_id,
        client_secret: opts.client.client_secret,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
        code_verifier: verifier,
      },
      64 * 1024,
    );
    if (r.status === 0) return fail('Google did not answer the sign-in; run /team-relay:drive connect again');
    let body: Record<string, unknown> | null = null;
    if (!r.over) {
      try {
        const v = JSON.parse(r.body.toString('utf8')) as unknown;
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) body = v as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const refresh = typeof body?.refresh_token === 'string' ? body.refresh_token : null;
    const access = typeof body?.access_token === 'string' ? body.access_token : null;
    if (r.status !== 200 || !body) {
      await discard(refresh ?? access);
      const e = oauthError(r);
      return fail(`Google refused the sign-in (${r.status}${e ? ` ${e}` : ''}); run /team-relay:drive connect again`);
    }
    const reject = async (why: string) => {
      await discard(refresh ?? access);
      return fail(`${why}; nothing was stored`);
    };
    if (!refresh || !REFRESH_TOKEN_RE.test(refresh)) return reject('Google did not give a lasting Drive connection');
    const scope = typeof body.scope === 'string' ? body.scope.split(' ') : [];
    if (!scope.includes(DRIVE_SCOPE)) return reject('Drive read access was not granted (tick "See and download your Google Drive files")');
    const id = checkIdToken(body.id_token, { clientId: opts.client.client_id, nonce, domain: opts.domain, nowMs: now() });
    if (!id.ok) return reject(id.reason);

    let previous: string | null = null;
    let previousToken: string | null = null;
    try {
      previous = await opts.keychain.account();
      if (previous && previous !== id.email) previousToken = await opts.keychain.read(previous);
      await opts.keychain.removeAll();
      await opts.keychain.write(id.email, refresh);
    } catch (err) {
      await discard(refresh);
      return fail(`signed in, but the Keychain could not keep the connection (${(err as Error).message}); nothing was stored`);
    }
    clearDriveTokenCache();
    // The earlier connection, for another account, is revoked too. (For the same account it is
    // not: revoking would end the grant the new token belongs to.)
    if (previousToken) await discard(previousToken);
    succeed({ email: id.email, replaced: previous && previous !== id.email ? previous : null });
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    if (used || finished) {
      respond(res, 410, page('Sign-in link used', 'This sign-in has finished. You can close this tab.'));
      return;
    }
    const notOurs = (why: string) => {
      respond(res, 404, page('Not found', 'There is nothing here.'));
      log(`ignored a request to the Drive sign-in listener (${why}); still waiting`);
    };
    if (req.headers.host !== `127.0.0.1:${port}`) return notOurs('unexpected Host');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      return notOurs('unreadable request');
    }
    if (req.method !== 'GET' || url.pathname !== '/callback') return notOurs('not GET /callback');
    const states = url.searchParams.getAll('state');
    if (states.length !== 1 || !STATE_RE.test(states[0]!) || !sameSecret(states[0]!, state)) return notOurs('wrong state');

    used = true;
    const errors = url.searchParams.getAll('error');
    if (errors.length > 0) {
      respond(res, 200, page('Not connected', 'Nothing was changed. You can close this tab.'));
      const e = /^[a-z_]{1,40}$/.test(errors[0]!) ? errors[0] : 'error';
      return fail(`the Google sign-in was cancelled or refused (${e}); run /team-relay:drive connect to try again`);
    }
    const codes = url.searchParams.getAll('code');
    if (codes.length !== 1 || !GOOGLE_CODE_RE.test(codes[0]!)) {
      respond(res, 400, page('Not connected', 'The sign-in answer carried no code. Run /team-relay:drive connect again in Claude Code.'));
      return fail('the Google sign-in did not complete (no code); run /team-relay:drive connect again');
    }
    respond(res, 200, page('Google Drive connected', 'You can close this tab and go back to Claude Code.'));
    void exchange(codes[0]!).catch(() => fail('the Google sign-in could not be completed; run /team-relay:drive connect again'));
  };

  server = createServer(handle);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => {
      server!.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  const auth = new URL(GOOGLE_AUTH_URL);
  auth.searchParams.set('client_id', opts.client.client_id);
  auth.searchParams.set('redirect_uri', redirectUri());
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', DRIVE_CONNECT_SCOPE);
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('hd', opts.domain);
  auth.searchParams.set('state', state);
  auth.searchParams.set('nonce', nonce);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  if (opts.loginHint) auth.searchParams.set('login_hint', opts.loginHint);
  const url = auth.toString();

  const limit = opts.timeoutMs ?? DRIVE_CONNECT_TIMEOUT_MS;
  timer = setTimeout(() => fail(`the Google sign-in was not finished within ${Math.round(limit / 1000)} seconds; run /team-relay:drive connect again`), limit);
  timer.unref?.();

  try {
    (opts.open ?? ((u: string) => void openInBrowser(u, { log, title: 'Connect Google Drive', what: 'the Google sign-in link' })))(url);
  } catch {
    log('could not open a browser');
  }
  return { url, port, done, cancel: () => fail('the Google sign-in was cancelled') };
}

/**
 * The domain to connect for: the one Drive domain in the team's boundaries, or the domain of
 * `loginHint` when it is one of several.
 */
export function teamDriveDomain(drives: Array<{ domain: string }> | null | undefined, loginHint?: string): string {
  const domains = [...new Set((drives ?? []).map((d) => d.domain).filter(isDomain))];
  if (domains.length === 0) throw new DriveConnectError('your team has no shared Google Drive in its boundaries, so there is nothing to connect');
  if (loginHint) {
    const d = domains.find((x) => emailInDomain(loginHint, x));
    if (!d) throw new DriveConnectError(`that account is not in your team's Drive domain (${domains.join(', ')})`);
    return d;
  }
  if (domains.length > 1) throw new DriveConnectError(`your team's drives are in several domains (${domains.join(', ')}): run /team-relay:drive connect <your email>`);
  return domains[0]!;
}

/** One line: which Google account is connected (never the token). */
export async function driveStatus(keychain: Keychain | null): Promise<string> {
  if (!keychain) return MAC_ONLY;
  const account = await keychain.account();
  return account
    ? `Google Drive is connected as ${account} on this Mac. /team-relay:drive disconnect removes it.`
    : 'Google Drive is not connected on this Mac. Run /team-relay:drive connect.';
}

/** Revoke the stored connection at Google (best effort) and delete it from the Keychain. */
export async function driveDisconnect(keychain: Keychain | null, doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<string> {
  if (!keychain) return MAC_ONLY;
  const account = await keychain.account();
  if (!account) {
    await keychain.removeAll();
    return 'Google Drive was not connected on this Mac; nothing to do.';
  }
  let token: string | null = null;
  try {
    token = await keychain.read(account);
  } catch {
    token = null;
  }
  const revoked = token ? await revokeToken(doFetch, token).catch(() => false) : false;
  await keychain.removeAll();
  clearDriveTokenCache();
  return revoked
    ? `Google Drive disconnected: ${account}'s access was revoked at Google and removed from this Mac.`
    : `Google Drive disconnected: removed from this Mac. Google could not confirm the revocation; remove "team relay" at myaccount.google.com/permissions to be sure.`;
}
