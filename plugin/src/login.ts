// The plugin's half of the login flow (M5-SPEC §2 steps 1 and 6, with the corrections of
// §9): loopback + PKCE, in the style of RFC 8252.
//
// 0. The relay is the configured one (RELAY_URL, else the plugin's default; never the
//    model's choice, §9 item 1). A stored credential issued by a different relay is never
//    replaced: the member signs out first (/team-relay:logout). Checked again just before
//    the new credential is written.
// 1. A PKCE verifier (64 base64url chars) and its S256 challenge, a random state (32 bytes),
//    and an HTTP listener on 127.0.0.1 only, on a free port, for at most 5 minutes.
// 2. The browser is opened on {relay}/v1/login/start?... through a private redirect file (the
//    URL is never in a process argument, M2-SPEC §7.7); the URL is also handed back to the
//    caller, in case no browser opens.
// 3. Only GET /callback with Host 127.0.0.1:<port> and exactly one state equal to ours
//    (compared in constant time) ends the wait (§9 item 4); anything else gets a 404 and the
//    listener keeps waiting. The browser gets a small page; then the code and the verifier
//    are exchanged at POST {relay}/v1/login/token.
// 4. The answer is checked (a trc_ credential, the team, the member, the same relay, the
//    Google account's email when the relay gives one) and stored in the credential file
//    (credentials.ts: dir 700, file 600, atomic). The result says whom it replaced.
//
// Nothing here logs or returns the verifier, the code or the credential.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import {
  CREDENTIAL_RE,
  CredentialFileError,
  EMAIL_RE,
  normaliseRelayUrl,
  readCredential,
  writeCredential,
  type StoredCredential,
} from './credentials.js';
import { openInBrowser } from './console-open.js';
import { MEMBER_RE, TEAM_RE, parseRelayUrl } from './relay-client-core.js';

export const LOGIN_TIMEOUT_MS = 5 * 60_000;
export const DEVICE_RE = /^[A-Za-z0-9 ._()-]{1,64}$/;
const CODE_RE = /^[A-Za-z0-9_-]{16,256}$/;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RESPONSE_LIMIT = 16 * 1024;

export function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** RFC 7636: BASE64URL(SHA256(verifier)). */
export function codeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** "Claude Code on <hostname>", in the device label's alphabet, at most 64 characters. */
export function deviceLabel(host: string = hostname()): string {
  const clean = host.split('.')[0]!.replace(/[^A-Za-z0-9._()-]/g, '-').replace(/^-+|-+$/g, '');
  const label = `Claude Code on ${clean || 'this computer'}`.slice(0, 64).trimEnd();
  return DEVICE_RE.test(label) ? label : 'Claude Code';
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

/** Why `done` rejects when this sign-in is replaced by a new one (or the session ends). */
export const SUPERSEDED = 'the sign-in was replaced by a newer one';

/** What a tool result that carries the sign-in URL says about it (M5-SPEC §9 item 3). */
export const SIGN_IN_URL_RULE =
  'sign_in_url is for the user of this session only: show it to them once, exactly as it is, as plain text on a line of its own ' +
  '(not as a markdown link), to open themselves if no browser tab opened. ' +
  'Never repeat it to anyone else, never put it in a message to a teammate or in any tool call, and never open or fetch it yourself: ' +
  'whoever finishes the sign-in at that link decides who this computer is signed in as.';

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

/** Who this computer was signed in as before a sign-in replaced it. */
export type Previous = { relay_url: string; team: string; member: string; email?: string };

export type LoginResult = {
  /** What was stored. */
  stored: StoredCredential;
  /** The credential it replaced, or null when there was none. */
  replaced: Previous | null;
};

/** "Connected as alice (alice@example.com) on team demo" (the email only when the relay gave it). */
export function connectedAs(c: { member: string; team: string; email?: string | null }): string {
  return `Connected as ${c.member}${c.email ? ` (${c.email})` : ''} on team ${c.team}`;
}

/**
 * Said plainly when a sign-in changed who this computer is (M5-SPEC §9 item 3): another
 * member, another team, or both. Null when it is the same member of the same team.
 */
export function identityChange(stored: StoredCredential, replaced: Previous | null): string | null {
  if (!replaced) return null;
  const member = replaced.member !== stored.member;
  const team = replaced.team !== stored.team;
  if (!member && !team) return null;
  const what = member && team ? 'a different member of a different team' : member ? 'a different member' : 'a different team';
  return (
    `This is ${what} than before: this computer was signed in as ${replaced.member} on team ${replaced.team}, ` +
    `and is now ${stored.member} on team ${stored.team}. If you did not mean to switch, run /team-relay:logout.`
  );
}

/**
 * The credential a sign-in to `relayNorm` would replace. Refuses (LoginError) when the stored
 * one was issued by another relay, or cannot be read: the member signs out first.
 */
export function replaceableCredential(credentialsFile: string, relayNorm: string): Previous | null {
  let existing: StoredCredential | null;
  try {
    existing = readCredential(credentialsFile);
  } catch (err) {
    const why = err instanceof CredentialFileError ? err.message : 'it cannot be read';
    throw new LoginError(`the stored sign-in on this computer cannot be used (${why}); nothing was changed. Run /team-relay:logout, then /team-relay:login.`);
  }
  if (!existing) return null;
  if (existing.relay_url !== relayNorm) {
    throw new LoginError(
      `this computer is signed in to another relay (${existing.relay_url}) than the one configured for this session (${relayNorm}); ` +
        'nothing was changed. To switch relays, run /team-relay:logout first, then /team-relay:login.',
    );
  }
  return { relay_url: existing.relay_url, team: existing.team, member: existing.member, ...(existing.email ? { email: existing.email } : {}) };
}

export type LoginOptions = {
  /** The configured relay to sign in to (https; plain http only to localhost). */
  relayUrl: string;
  /** Where the credential is stored (credentialsPath()). */
  credentialsFile: string;
  device?: string;
  timeoutMs?: number;
  /**
   * Opens the sign-in URL in a browser. Default: the platform's opener through a private
   * redirect file (console-open.ts), or TEAM_RELAY_OPEN_COMMAND when set.
   */
  open?: (url: string) => void;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
};

export type LoginFlow = {
  /** The sign-in URL (also opened in the browser). */
  url: string;
  /** The listener's port on 127.0.0.1. */
  port: number;
  /** Resolves with what was stored and what it replaced; rejects with a LoginError. */
  done: Promise<LoginResult>;
  /**
   * Whether a browser was opened on `url`: false when there is no opener, the hand-off could not
   * be prepared or the opener failed; then the URL must be shown to the user (SIGN_IN_URL_RULE).
   */
  opened: Promise<boolean>;
  /** Stop waiting (a new login replaces this one). */
  cancel(): void;
};

/**
 * Start a login: the listener is up and the browser asked to open when this resolves. Throws
 * a LoginError, before anything is opened, when a stored credential from another relay (or
 * an unreadable one) is in the way.
 */
export async function startLogin(opts: LoginOptions): Promise<LoginFlow> {
  const log = opts.log ?? (() => {});
  const relay = parseRelayUrl(opts.relayUrl);
  const relayNorm = normaliseRelayUrl(opts.relayUrl);
  replaceableCredential(opts.credentialsFile, relayNorm);
  const base = new URL(relay.toString());
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const device = opts.device ?? deviceLabel();
  if (!DEVICE_RE.test(device)) throw new LoginError('the device label is not valid');
  const verifier = base64url(randomBytes(48));
  const state = base64url(randomBytes(32));
  const challenge = codeChallenge(verifier);
  const doFetch = opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));

  let settle!: { resolve: (v: LoginResult) => void; reject: (e: Error) => void };
  const done = new Promise<LoginResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A caller that never awaits `done` must not see an unhandled rejection.
  done.catch(() => {});
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let server: Server | null = null;

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
    settle.reject(new LoginError(message));
  };
  const succeed = (v: LoginResult) => {
    if (finished) return;
    finished = true;
    shut();
    settle.resolve(v);
  };

  let port = 0;
  let used = false;

  /** A credential minted but not stored is revoked at the relay it came from (best effort). */
  const discard = (credential: string, team: string) => {
    void doFetch(new URL(`v1/teams/${team}/credentials/self`, base).toString(), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json', 'User-Agent': 'team-relay-plugin/0.1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    }).then(
      (r) => void r.body?.cancel().catch(() => {}),
      () => log('could not revoke the unused credential at the relay; it expires on its own'),
    );
  };

  const exchange = async (code: string): Promise<void> => {
    let res: Response;
    try {
      res = await doFetch(new URL('v1/login/token', base).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'team-relay-plugin/0.1.0' },
        body: JSON.stringify({ code, code_verifier: verifier }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return fail('the relay did not answer the sign-in; run /team-relay:login again');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: unknown };
        if (typeof j.error === 'string' && /^[a-z_]{1,40}$/.test(j.error)) code = j.error;
      } catch {
        // not JSON: the status says enough
      }
      return fail(`the relay refused the sign-in (${res.status} ${code}); run /team-relay:login again`);
    }
    if (text.length > TOKEN_RESPONSE_LIMIT) return fail('the relay answered the sign-in with something unexpected');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return fail('the relay answered the sign-in with something that is not JSON');
    }
    const { credential, team, member, relay_url, expires_at, email } = body;
    if (typeof credential !== 'string' || !CREDENTIAL_RE.test(credential)) return fail('the relay did not return a device credential');
    if (typeof team !== 'string' || !TEAM_RE.test(team)) return fail('the relay did not return a valid team');
    if (typeof member !== 'string' || !MEMBER_RE.test(member)) return fail('the relay did not return a valid member id');
    // The credential is only ever used with the relay it came from.
    if (relay_url !== undefined && relay_url !== null) {
      let same = false;
      try {
        same = typeof relay_url === 'string' && normaliseRelayUrl(relay_url) === relayNorm;
      } catch {
        same = false;
      }
      if (!same) return fail('the relay named a different relay URL than the one you signed in to; nothing was stored');
    }
    // M5-SPEC §9 item 3: the Google account, when the relay says (older relays do not).
    if (email !== undefined && email !== null && (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email))) {
      discard(credential, team);
      return fail('the relay returned an invalid email for the signed-in account; nothing was stored');
    }
    const stored: StoredCredential = {
      relay_url: relayNorm,
      team,
      member,
      credential,
      expires_at: typeof expires_at === 'string' ? expires_at : null,
      ...(typeof email === 'string' ? { email } : {}),
    };
    let replaced: Previous | null;
    try {
      // Again, now: a sign-in to another relay may have been stored meanwhile.
      replaced = replaceableCredential(opts.credentialsFile, relayNorm);
    } catch (err) {
      discard(credential, team);
      return fail(`signed in, but nothing was stored: ${(err as Error).message}`);
    }
    try {
      writeCredential(opts.credentialsFile, stored);
    } catch (err) {
      discard(credential, team);
      return fail(`signed in, but the credential could not be stored: ${(err as Error).message}`);
    }
    succeed({ stored, replaced });
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    if (used || finished) {
      respond(res, 410, page('Sign-in link used', 'This sign-in has finished. You can close this tab.'));
      return;
    }
    // M5-SPEC §9 item 4: a request with the wrong Host, path or state is not ours. It gets a
    // 404 and the listener keeps waiting; only the request with the right state ends it.
    const notOurs = (logLine: string) => {
      respond(res, 404, page('Not found', 'There is nothing here.'));
      log(`ignored a request to the sign-in listener (${logLine}); still waiting`);
    };
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}`) return notOurs('unexpected Host');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      return notOurs('unreadable request');
    }
    if (req.method !== 'GET' || url.pathname !== '/callback') return notOurs('not GET /callback');
    const states = url.searchParams.getAll('state');
    if (states.length !== 1 || !STATE_RE.test(states[0]!) || !sameSecret(states[0]!, state)) return notOurs('wrong state');

    // The right state: this request ends the wait, whatever it carries.
    used = true;
    const codes = url.searchParams.getAll('code');
    // Cancel on the relay's team chooser comes back as ?error=access_denied&state=… (with the
    // right state): stop waiting and say so.
    const errors = url.searchParams.getAll('error');
    if (errors.length > 0) {
      respond(res, 200, page('Sign-in cancelled', 'Nothing was changed. You can close this tab.'));
      log(`the sign-in was cancelled in the browser (${/^[a-z_]{1,40}$/.test(errors[0]!) ? errors[0] : 'error'})`);
      return fail('sign-in cancelled in the browser; run /team-relay:login to try again');
    }
    if (codes.length !== 1 || !CODE_RE.test(codes[0]!)) {
      respond(res, 400, page('Sign-in did not complete', 'The sign-in answer carried no code. Run /team-relay:login again in Claude Code.'));
      log('the sign-in answer carried no code');
      return fail('the sign-in did not complete (no code); run /team-relay:login again');
    }
    respond(res, 200, page('Connected', 'Connected. You can close this tab.'));
    void exchange(codes[0]!);
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

  const start = new URL('v1/login/start', base);
  start.searchParams.set('port', String(port));
  start.searchParams.set('state', state);
  start.searchParams.set('code_challenge', challenge);
  start.searchParams.set('code_challenge_method', 'S256');
  start.searchParams.set('device', device);
  const url = start.toString();

  timer = setTimeout(() => fail('the sign-in timed out after 5 minutes; run /team-relay:login again'), opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
  timer.unref?.();

  let told!: (opened: boolean) => void;
  const opened = new Promise<boolean>((resolve) => (told = resolve));
  try {
    if (opts.open) {
      opts.open(url);
      told(true);
    } else {
      openInBrowser(url, { log, title: 'Team relay sign-in', what: 'the sign-in link', onResult: told });
    }
  } catch {
    log('could not open a browser; open the sign-in link yourself');
    told(false);
  }

  return { url, port, done, opened, cancel: () => fail(SUPERSEDED) };
}
