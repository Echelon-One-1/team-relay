// Typed HTTP client for the relay API (M1-SPEC §3, M2-SPEC §3), with retry and backoff.
//
// The bearer token is read through a provider on every request (so a rotated token file
// is picked up, and a cached Google ID token is refreshed) and never appears in an error
// message, a log line or a file.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { credentialFileExists, credentialsPath, normaliseRelayUrl, readCredential } from './credentials.js';
import { MEMBER_RE, TEAM_RE, parseRelayUrl } from './relay-client-core.js';
import { defaultRelayUrl } from './relay-default.js';
import type {
  Acceptance,
  GithubListing,
  MemberStatusBody,
  MembersStatus,
  MyRequest,
  SetBoundariesBody,
  SourcesConfig,
  TeamBoundaries,
} from './boundaries-types.js';

export { MEMBER_RE, TEAM_RE, parseRelayUrl };
export const REQUEST_ID_RE = /^rq_[0-9a-f]{32}$/;
export const MESSAGE_ID_RE = /^msg_[0-9a-f]{32}$/;

export type StreamName = 'inbox' | 'replies';
export type EnvelopeType = 'question' | 'capability_call' | 'answer' | 'no_response' | 'timed_out';

export type Envelope = {
  id: string;
  seq: number;
  team: string;
  stream: StreamName;
  type: EnvelopeType;
  from: string;
  to: string;
  request_id: string;
  broadcast: boolean;
  time: string;
  expire_at: string;
  data: Record<string, unknown>;
};

export type Me = { team: string; member: string; teammates: string[]; role?: RosterRole; name?: string };
export type DirectoryEntry = {
  member: string;
  last_seen: string | null;
  manifest: unknown;
  published_at: string | null;
};
export type StreamPage = { messages: Envelope[]; cursor: number; head: number };
/** M2-SPEC §3.3; `waiting` (M4-SPEC §2): the tool is waiting for the member's permission. */
export type ToolEventBody = { tool: string; status: 'ok' | 'error' | 'waiting'; duration_ms: number | null };

/** M6-SPEC §2. */
export type RosterRole = 'owner' | 'member';
export type RosterMember = {
  member: string;
  emails: Array<string | null> | null;
  role: RosterRole;
  added_by?: string | null;
  added_at?: string | null;
  /** M9-SPEC §7.2: an entry an owner added is `invited` until its person accepts. */
  status?: 'active' | 'invited';
};
export type RosterPage = { members: RosterMember[] };
export type AddMemberBody = { member: string; email: string; role?: RosterRole };
export type UpdateMemberBody = { add_email?: string; remove_email?: string; role?: RosterRole };

export type CreateRequestBody = {
  idempotency_key: string;
  kind: 'question' | 'capability';
  to: string[] | '*';
  question?: string;
  capability?: { name: string; params: Record<string, unknown> };
  ack_timeout_seconds?: number;
  answer_timeout_seconds?: number;
  ttl_seconds?: number;
};
export type CreateRequestResult = {
  request_id: string;
  recipients: string[];
  created: boolean;
  ack_deadline?: string;
  answer_deadline?: string;
  expire_at?: string;
};

/** A non-2xx answer from the relay. `code` is the relay's error code. */
export class RelayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  /** The relay's Retry-After, in whole seconds (0..RETRY_AFTER_MAX_S), when it sent one. */
  readonly retryAfter: number | undefined;
  constructor(status: number, code: string, detail: string, retryAfter?: number) {
    super(`relay ${status} ${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

/** PICKERS-SPEC §4.3: the longest Retry-After kept (the relay caps GitHub's at an hour). */
export const RETRY_AFTER_MAX_S = 3600;

/** A Retry-After header in whole seconds (the only form the relay sends), capped; anything else is none. */
export function parseRetryAfter(v: string | null): number | undefined {
  const t = v?.trim();
  if (!t || !/^[0-9]{1,10}$/.test(t)) return undefined;
  return Math.min(RETRY_AFTER_MAX_S, Number(t));
}

/** The relay could not be reached, or answered with something that is not JSON. */
export class RelayNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayNetworkError';
  }
}

/**
 * Network errors, 5xx and 429 (the relay's `rate_limited` and `too_many_polls`, M1-SPEC
 * §11.7) are retried with backoff; every other status is final.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof RelayNetworkError) return true;
  if (err instanceof RelayError) return err.status >= 500 || err.status === 429;
  return false;
}

export type Backoff = { baseMs: number; maxMs: number };
export const DEFAULT_BACKOFF: Backoff = { baseMs: 1000, maxMs: 30_000 };

/** Exponential backoff with full jitter in [delay/2, delay]. attempt starts at 0. */
export function backoffDelay(attempt: number, b: Backoff = DEFAULT_BACKOFF, random = Math.random): number {
  const exp = Math.min(b.maxMs, b.baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/**
 * Supplies the bearer token for each request. A provider that can mint a fresh token (the
 * Google identity) carries `invalidate`; the client calls it on a 401 and retries once.
 */
export type TokenProvider = (() => string | Promise<string>) & { invalidate?: () => void };
/** A provider that mints tokens and can be told to drop the one it holds. */
export type RefreshableTokenProvider = (() => Promise<string>) & { invalidate: () => void };

/**
 * A plugin option Claude Code could not fill is passed through literally as
 * `${user_config.<key>}` (plugins reference: optional values are left literal), so such a
 * value, like an empty one, means "not set".
 */
export function configValue(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (!t || /^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(t)) return undefined;
  return t;
}

/**
 * A static development token (RELAY_AUTH=token). Like a device credential it is bound to its
 * member's team: the relay's account routes (M9-SPEC §2) refuse it.
 */
export type StaticTokenProvider = (() => string) & { kind: 'static' };

export function staticTokenProvider(read: string | (() => string)): StaticTokenProvider {
  return Object.assign(typeof read === 'string' ? () => read : read, { kind: 'static' as const });
}

/** RELAY_TOKEN_FILE wins over RELAY_TOKEN; trailing newlines are stripped; re-read on each call. */
export function tokenProviderFromEnv(env: NodeJS.ProcessEnv): TokenProvider {
  const file = configValue(env.RELAY_TOKEN_FILE);
  if (file) {
    return staticTokenProvider(() => {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (err) {
        throw new Error(`cannot read RELAY_TOKEN_FILE (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
      }
      const token = raw.replace(/[\r\n]+$/, '');
      if (!token) throw new Error('RELAY_TOKEN_FILE is empty');
      return token;
    });
  }
  const token = configValue(env.RELAY_TOKEN);
  if (!token) throw new Error('RELAY_AUTH is "token", so RELAY_TOKEN or RELAY_TOKEN_FILE must be set');
  return staticTokenProvider(token);
}

// ---------------------------------------------------------------------------------------
// Google identity (M2-SPEC §2, §4.1): the member's own gcloud user identity.

/** gcloud's own OAuth client id: the audience of a token from `gcloud auth print-identity-token`. */
export const GCLOUD_AUDIENCE = '32555940559.apps.googleusercontent.com';
/** A cached ID token is used until this long before its `exp`. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ACCOUNT_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
const GCLOUD_OUTPUT_LIMIT = 64 * 1024;

/** A gcloud account id: an email address, never something that could read as an option. */
export function checkGcloudAccount(account: string): string {
  if (account.length > 254 || !ACCOUNT_RE.test(account)) {
    throw new Error('RELAY_GCLOUD_ACCOUNT must be an account email address');
  }
  return account;
}

/** The `exp` claim of a JWT, in ms since the epoch, read (not verified) from its payload. */
export function jwtExpiryMs(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Anything token-shaped is cut out of gcloud's own messages before they reach an error. */
function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/ya29\.[A-Za-z0-9_.-]+/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim()
    .slice(0, 200);
}

export type GcloudOptions = {
  /** `--account=<account>` when set. */
  account?: string;
  /** The environment gcloud runs with (its PATH also locates the gcloud executable). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => number;
};

/**
 * A token provider backed by `gcloud auth print-identity-token`, run with an argv array
 * (never a shell). The token is cached until 5 minutes before its `exp` (read from the JWT
 * payload, not verified: the relay verifies it); `invalidate` drops the cache so the next
 * request mints a fresh one. Concurrent requests share one gcloud run.
 */
export function gcloudTokenProvider(opts: GcloudOptions = {}): RefreshableTokenProvider {
  const now = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const args = ['auth', 'print-identity-token'];
  if (opts.account !== undefined) args.push(`--account=${checkGcloudAccount(opts.account)}`);
  let cached: { token: string; until: number } | null = null;
  let inflight: Promise<string> | null = null;

  const mint = () =>
    new Promise<string>((resolve, reject) => {
      execFile(
        'gcloud',
        args,
        { env, timeout: timeoutMs, maxBuffer: GCLOUD_OUTPUT_LIMIT, shell: false, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
            if (e.code === 'ENOENT') return reject(new Error('gcloud was not found on PATH (RELAY_AUTH=google needs the Google Cloud CLI)'));
            if (e.killed) return reject(new Error('gcloud auth print-identity-token timed out'));
            const why = scrub(String(stderr ?? '').split('\n').find((l) => l.trim()) ?? '');
            return reject(new Error(`gcloud auth print-identity-token failed${why ? `: ${why}` : ''}`));
          }
          const token = String(stdout).trim();
          if (!JWT_RE.test(token)) return reject(new Error('gcloud auth print-identity-token did not print an ID token'));
          resolve(token);
        },
      );
    });

  const provider = Object.assign(async () => {
    if (cached && now() < cached.until) return cached.token;
    inflight ??= mint()
      .then((token) => {
        const exp = jwtExpiryMs(token);
        // A token without a usable exp, or already inside the margin, is used once, not kept.
        cached = exp !== null && exp - TOKEN_REFRESH_MARGIN_MS > now() ? { token, until: exp - TOKEN_REFRESH_MARGIN_MS } : null;
        return token;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }, {
    invalidate: () => {
      cached = null;
    },
  });
  return provider;
}

// ---------------------------------------------------------------------------------------
// The runtime service account on Google Cloud (M3-SPEC §3): an ID token for the relay from
// the metadata server, used by the hosted console.

export const METADATA_BASE = 'http://metadata.google.internal';
const METADATA_IDENTITY_PATH = '/computeMetadata/v1/instance/service-accounts/default/identity';
const METADATA_OUTPUT_LIMIT = 16 * 1024;

export type MetadataOptions = {
  /** The token's audience: the relay's URL. */
  audience: string;
  /** Tests only: where the metadata server is. */
  base?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  now?: () => number;
};

/**
 * A token provider backed by the metadata server's identity endpoint
 * (`?audience=<RELAY_URL>&format=full`, header `Metadata-Flavor: Google`). Cached until 5
 * minutes before its `exp`; `invalidate` drops it (the client does so once on a 401);
 * concurrent requests share one fetch. The token never reaches an error or a log.
 */
export function metadataTokenProvider(opts: MetadataOptions): RefreshableTokenProvider {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? ((u: string, i: RequestInit) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 5_000;
  if (!opts.audience) throw new Error('RELAY_AUTH=metadata needs RELAY_URL as the token audience');
  const url = new URL(METADATA_IDENTITY_PATH, opts.base ?? METADATA_BASE);
  url.searchParams.set('audience', opts.audience);
  url.searchParams.set('format', 'full');
  const target = url.toString();
  let cached: { token: string; until: number } | null = null;
  let inflight: Promise<string> | null = null;

  const mint = async (): Promise<string> => {
    let res: Response;
    try {
      res = await doFetch(target, {
        method: 'GET',
        headers: { 'Metadata-Flavor': 'Google' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('the metadata server did not answer (RELAY_AUTH=metadata runs only on Google Cloud)');
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`the metadata server refused an identity token (${res.status})`);
    const token = text.trim();
    if (token.length > METADATA_OUTPUT_LIMIT || !JWT_RE.test(token)) throw new Error('the metadata server did not return an ID token');
    return token;
  };

  return Object.assign(async () => {
    if (cached && now() < cached.until) return cached.token;
    inflight ??= mint()
      .then((token) => {
        const exp = jwtExpiryMs(token);
        cached = exp !== null && exp - TOKEN_REFRESH_MARGIN_MS > now() ? { token, until: exp - TOKEN_REFRESH_MARGIN_MS } : null;
        return token;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }, {
    invalidate: () => {
      cached = null;
    },
  });
}

export type AuthMode = 'credential' | 'google' | 'token' | 'metadata';

/**
 * RELAY_AUTH (M5-SPEC §6), when set, wins: `credential` (the device credential
 * /team-relay:login stored), `google` (your gcloud identity), `token` (a static dev token,
 * for the emulator and tests), or `metadata` (the runtime service account on Google Cloud:
 * the hosted console). Unset: the credential file if there is one, else `google`.
 */
export function authModeFromEnv(env: NodeJS.ProcessEnv): AuthMode {
  const explicit = configValue(env.RELAY_AUTH);
  if (explicit === undefined) return credentialFileExists(credentialsPath(env)) ? 'credential' : 'google';
  if (explicit !== 'credential' && explicit !== 'google' && explicit !== 'token' && explicit !== 'metadata') {
    throw new Error('RELAY_AUTH must be "credential", "google" or "token" (or "metadata" on Google Cloud)');
  }
  return explicit;
}

/** Nothing says which relay or team to use, and there is no stored sign-in. */
export class NotConnected extends Error {
  constructor(message = 'Not connected: run /team-relay:login') {
    super(message);
    this.name = 'NotConnected';
  }
}

/** What a 401 means for a device credential (M5-SPEC §6): sign in again, never a retry loop. */
export const SIGN_IN_AGAIN =
  'the relay refused your sign-in (signed out, expired, or no longer on the team): run /team-relay:login again';

/** A provider of the stored device credential, bound to the relay and team it was minted for. */
export type CredentialTokenProvider = (() => string) & { kind: 'credential'; path: string };

/**
 * Reads the credential file on every call, so a logout or a new login is seen at once. The
 * credential is only ever sent to the relay and team it was minted for: once the file names
 * another relay or team (a login elsewhere since), this provider refuses.
 */
export function credentialTokenProvider(path: string, bound: { relay_url: string; team: string }): CredentialTokenProvider {
  const relay = normaliseRelayUrl(bound.relay_url);
  return Object.assign(
    () => {
      const stored = readCredential(path);
      if (!stored) throw new NotConnected();
      if (stored.relay_url !== relay || stored.team !== bound.team) {
        throw new NotConnected('you signed in to another relay or team since this started: restart it');
      }
      return stored.credential;
    },
    { kind: 'credential' as const, path },
  );
}

export function isCredentialProvider(p: TokenProvider): p is TokenProvider & CredentialTokenProvider {
  return (p as { kind?: unknown }).kind === 'credential';
}

/** Where to reach the relay, as whom: the result of reading the environment and the credential file. */
export type Connection = {
  mode: AuthMode;
  url: string;
  team: string;
  token: TokenProvider;
  /** The member the stored credential was issued to (credential mode). */
  member?: string;
};

/**
 * The connection the environment asks for. Credential mode takes the relay and team from
 * the file (RELAY_URL / RELAY_TEAM, when set, must agree with it). Other modes need
 * RELAY_TEAM; RELAY_URL defaults to the plugin's default relay (plugin/relay.default.json).
 * Throws NotConnected when there is neither a stored sign-in nor a team to sign in to.
 */
export function connectionFromEnv(env: NodeJS.ProcessEnv, gcloud: Omit<GcloudOptions, 'account'> = {}): Connection {
  const explicitMode = configValue(env.RELAY_AUTH) !== undefined;
  const mode = authModeFromEnv(env);
  if (mode === 'credential') {
    const path = credentialsPath(env);
    const stored = readCredential(path);
    if (!stored) throw new NotConnected();
    const envUrl = configValue(env.RELAY_URL);
    if (envUrl !== undefined) {
      let same = false;
      try {
        same = normaliseRelayUrl(envUrl) === stored.relay_url;
      } catch {
        same = false;
      }
      if (!same) {
        throw new Error('RELAY_URL is not the relay you signed in to: unset it, or run /team-relay:logout and then /team-relay:login to sign in to it');
      }
    }
    const envTeam = configValue(env.RELAY_TEAM);
    if (envTeam !== undefined && envTeam !== stored.team) {
      throw new Error('RELAY_TEAM is not the team you signed in to: unset it, or run /team-relay:login again');
    }
    return { mode, url: stored.relay_url, team: stored.team, member: stored.member, token: credentialTokenProvider(path, stored) };
  }
  const team = configValue(env.RELAY_TEAM);
  if (!team) {
    if (!explicitMode) throw new NotConnected();
    throw new Error('RELAY_TEAM must be set');
  }
  const url = configValue(env.RELAY_URL) ?? (mode === 'google' ? defaultRelayUrl() : null) ?? '';
  let token: TokenProvider;
  if (mode === 'token') token = tokenProviderFromEnv(env);
  else if (mode === 'metadata') token = metadataTokenProvider({ audience: configValue(env.RELAY_URL) ?? '' });
  else {
    const account = configValue(env.RELAY_GCLOUD_ACCOUNT);
    token = gcloudTokenProvider({ env, ...gcloud, ...(account !== undefined ? { account } : {}) });
  }
  return { mode, url, team, token };
}

/** The credentials the environment asks for (RELAY_AUTH, the credential file, RELAY_GCLOUD_ACCOUNT, RELAY_TOKEN[_FILE]). */
export function credentialsFromEnv(env: NodeJS.ProcessEnv, gcloud: Omit<GcloudOptions, 'account'> = {}): TokenProvider {
  const mode = authModeFromEnv(env);
  if (mode === 'credential') return connectionFromEnv(env, gcloud).token;
  if (mode === 'token') return tokenProviderFromEnv(env);
  if (mode === 'metadata') return metadataTokenProvider({ audience: configValue(env.RELAY_URL) ?? '' });
  const account = configValue(env.RELAY_GCLOUD_ACCOUNT);
  return gcloudTokenProvider({ env, ...gcloud, ...(account !== undefined ? { account } : {}) });
}

export type RelayClientOptions = {
  url: string;
  team: string;
  token: TokenProvider;
  backoff?: Backoff;
  /** Attempts per call for retryable failures (network, 5xx, 429). 1 means no retry. */
  attempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  userAgent?: string;
};

type CallOptions = {
  attempts?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** M3-SPEC §2: the member a delegate (the hosted console) reads as, by email. */
  onBehalfOf?: string;
  /**
   * M9-SPEC §7.6: the hosted console's salted SHA-256 of its viewer's address (64 lower-case
   * hex), sent as X-Relay-Client-IP-Hash on a team creation so the relay's per-address limit
   * holds through the console.
   */
  clientIpHash?: string;
};

/** M9-SPEC §2: GET /v1/me/teams. */
export type MyTeam = { team: string; name?: string; member: string; role: RosterRole };
export type MyInvitation = { team: string; name?: string; member: string; role?: RosterRole; invited_by_member?: string };
export type MyTeams = {
  teams: MyTeam[];
  invitations?: MyInvitation[];
  admin?: boolean;
  teams_created?: number;
  max_teams_created?: number;
  suggested_member?: string;
};
/** M9-SPEC §2: POST /v1/teams. `id` is made from the name when absent. */
export type CreateTeamBody = { id?: string; name: string; owner_member_id: string };

export const CLIENT_IP_HASH_RE = /^[0-9a-f]{64}$/;

const ON_BEHALF_OF_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}$/;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RelayClient {
  readonly team: string;
  private readonly opts: RelayClientOptions;
  private readonly base: URL;
  private readonly token: TokenProvider;
  private readonly backoff: Backoff;
  private readonly attempts: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly userAgent: string;

  constructor(opts: RelayClientOptions) {
    if (!TEAM_RE.test(opts.team)) throw new Error('RELAY_TEAM is not a valid team id');
    this.opts = opts;
    this.team = opts.team;
    const base = parseRelayUrl(opts.url);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    this.base = base;
    this.token = opts.token;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.attempts = Math.max(1, opts.attempts ?? 4);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.userAgent = opts.userAgent ?? 'team-relay-plugin/0.1.0';
  }

  /**
   * The same relay, sign-in and settings for another team (M9-SPEC §5: the hosted console's
   * delegate reads any team its viewer is on). The team id is checked like RELAY_TEAM.
   */
  withTeam(team: string): RelayClient {
    if (team === this.team) return this;
    return new RelayClient({ ...this.opts, team });
  }

  /**
   * True when this client signs in with a stored device credential or a static token, which
   * are bound to one team (no Google identity for the account routes).
   */
  get boundToTeam(): boolean {
    return isCredentialProvider(this.token) || (this.token as { kind?: unknown }).kind === 'static';
  }

  /** The relay's base URL (without a trailing slash). */
  get url(): string {
    return this.base.toString().replace(/\/$/, '');
  }

  private teamPath(...parts: string[]): string {
    return ['v1', 'teams', this.team, ...parts].map(encodeURIComponent).join('/');
  }

  private async once<T>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    onBehalfOf?: string,
    clientIpHash?: string,
  ): Promise<T> {
    const url = new URL(path, this.base);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${await this.token()}`,
      'User-Agent': this.userAgent,
    };
    if (onBehalfOf !== undefined) {
      if (!ON_BEHALF_OF_RE.test(onBehalfOf)) throw new Error('X-Relay-On-Behalf-Of must be a lower-case email address');
      headers['X-Relay-On-Behalf-Of'] = onBehalfOf;
    }
    if (clientIpHash !== undefined) {
      if (!CLIENT_IP_HASH_RE.test(clientIpHash)) throw new Error('X-Relay-Client-IP-Hash must be 64 lower-case hex characters');
      headers['X-Relay-Client-IP-Hash'] = clientIpHash;
    }
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: payload, signal: combined, redirect: 'error' });
    } catch (err) {
      if (signal?.aborted) throw err;
      const e = err as Error & { cause?: { code?: string; message?: string } };
      const why = e.cause?.code ?? e.cause?.message ?? (e.name === 'TimeoutError' ? 'timed out' : e.name);
      throw new RelayNetworkError(`relay unreachable (${String(why).slice(0, 120)})`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new RelayNetworkError('relay response was cut off');
    }
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (res.ok) throw new RelayNetworkError(`relay answered ${res.status} with a body that is not JSON`);
      }
    }
    if (!res.ok) {
      const obj = (json && typeof json === 'object' ? json : {}) as { error?: unknown; detail?: unknown };
      const code = typeof obj.error === 'string' ? obj.error : `http_${res.status}`;
      const detail = typeof obj.detail === 'string' ? obj.detail.slice(0, 500) : '';
      throw new RelayError(res.status, code, detail, parseRetryAfter(res.headers.get('retry-after')));
    }
    return json as T;
  }

  /**
   * One call with retry and exponential backoff on network errors, 5xx and 429. A 401 with
   * a refreshable identity drops the cached token and retries once at once (M2-SPEC §2).
   */
  async call<T>(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<T> {
    const attempts = Math.max(1, opts.attempts ?? this.attempts);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let refreshed = false;
    for (let attempt = 0; ; ) {
      try {
        return await this.once<T>(method, path, body, timeoutMs, opts.signal, opts.onBehalfOf, opts.clientIpHash);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (err instanceof RelayError && err.status === 401 && !refreshed && this.token.invalidate) {
          refreshed = true;
          this.token.invalidate();
          continue;
        }
        // A device credential cannot be refreshed: tell the member to sign in again.
        if (err instanceof RelayError && err.status === 401 && isCredentialProvider(this.token)) {
          throw new RelayError(401, err.code, SIGN_IN_AGAIN);
        }
        if (attempt + 1 >= attempts || !isRetryable(err)) throw err;
        await this.sleep(backoffDelay(attempt, this.backoff, this.random));
        attempt++;
      }
    }
  }

  me(opts?: CallOptions) {
    return this.call<Me>('GET', this.teamPath('me'), undefined, opts);
  }

  publishManifest(member: string, manifest: unknown, opts?: CallOptions) {
    if (!MEMBER_RE.test(member)) throw new Error('invalid member id');
    return this.call<{ published_at: string; capabilities: string[] }>(
      'PUT',
      this.teamPath('members', member, 'manifest'),
      manifest,
      opts,
    );
  }

  directory(opts?: CallOptions) {
    return this.call<{ members: DirectoryEntry[] }>('GET', this.teamPath('directory'), undefined, opts);
  }

  /**
   * M7-SPEC §1: what waits in this member's inbox for their answering session. A peek: it moves
   * no cursor and writes no presence, so a session without the channel may read it too.
   */
  inboxSummary(opts?: CallOptions) {
    return this.call<unknown>('GET', this.teamPath('inbox', 'summary'), undefined, opts);
  }

  /** Safe to retry: the idempotency key makes a repeated POST return the original request. */
  createRequest(body: CreateRequestBody, opts?: CallOptions) {
    return this.call<CreateRequestResult>('POST', this.teamPath('requests'), body, opts);
  }

  readStream(stream: StreamName, q: { after?: number; wait?: number; limit?: number } = {}, opts?: CallOptions) {
    const params = new URLSearchParams();
    if (q.after !== undefined) params.set('after', String(q.after));
    if (q.wait !== undefined) params.set('wait', String(q.wait));
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    const qs = params.toString();
    const timeoutMs = opts?.timeoutMs ?? ((q.wait ?? 0) * 1000 + 20_000);
    return this.call<StreamPage>('GET', this.teamPath('streams', stream) + (qs ? `?${qs}` : ''), undefined, {
      ...opts,
      timeoutMs,
    });
  }

  ackCursor(stream: StreamName, ackedSeq: number, opts?: CallOptions) {
    return this.call<{ cursor: number }>('POST', this.teamPath('streams', stream, 'cursor'), { acked_seq: ackedSeq }, opts);
  }

  private checkRequestId(id: string) {
    if (!REQUEST_ID_RE.test(id)) throw new Error('request_id must look like rq_ followed by 32 lowercase hex characters');
  }

  ackRequest(requestId: string, opts?: CallOptions) {
    this.checkRequestId(requestId);
    return this.call<{ status: string }>('POST', this.teamPath('requests', requestId, 'ack'), {}, opts);
  }

  reply(requestId: string, body: { idempotency_key: string; text: string; data?: unknown }, opts?: CallOptions) {
    this.checkRequestId(requestId);
    return this.call<{ status: string; message_id: string }>(
      'POST',
      this.teamPath('requests', requestId, 'reply'),
      body,
      opts,
    );
  }

  /** Not idempotent (it appends), so it is sent once unless the caller asks otherwise. */
  progress(requestId: string, body: { text: string; pct: number | null }, opts?: CallOptions) {
    this.checkRequestId(requestId);
    return this.call<{ seq: number }>('POST', this.teamPath('requests', requestId, 'progress'), body, {
      attempts: 1,
      ...opts,
    });
  }

  getRequest(requestId: string, opts?: CallOptions) {
    this.checkRequestId(requestId);
    return this.call<Record<string, unknown>>('GET', this.teamPath('requests', requestId), undefined, opts);
  }

  /** M2-SPEC §3.3: a tool's name, outcome and duration only. Appends, so it is sent once. */
  toolEvent(requestId: string, body: ToolEventBody, opts?: CallOptions) {
    this.checkRequestId(requestId);
    return this.call<Record<string, unknown>>('POST', this.teamPath('requests', requestId, 'events'), body, {
      attempts: 1,
      ...opts,
    });
  }

  /** M10-SPEC §1: the team's boundaries (any member). Never set: version 0, boundaries null. */
  boundaries(opts?: CallOptions) {
    return this.call<TeamBoundaries>('GET', this.teamPath('boundaries'), undefined, opts);
  }

  /** M10-SPEC §1 (owners): replace the boundaries; a stale version is 409 version_conflict. Sent once. */
  setBoundaries(body: SetBoundariesBody, opts?: CallOptions) {
    return this.call<TeamBoundaries>('PUT', this.teamPath('boundaries'), body, { attempts: 1, ...opts });
  }

  /**
   * PICKERS-SPEC §3.5 (owners): the GitHub App's install link and the Google Picker's public
   * settings. Never a key or a token.
   */
  sourcesConfig(opts?: CallOptions) {
    return this.call<SourcesConfig>('GET', this.teamPath('sources', 'config'), undefined, opts);
  }

  /**
   * PICKERS-SPEC §3.6 (owners): the repositories of the allowed orgs where the relay's GitHub App
   * is installed. Not configured: 404 github_not_configured; GitHub's rate limit: 503
   * github_rate_limited with a Retry-After (RelayError.retryAfter).
   */
  sourcesGithub(opts?: CallOptions) {
    return this.call<GithubListing>('GET', this.teamPath('sources', 'github'), undefined, opts);
  }

  /** M11-SPEC §2: the boundaries version this member accepted (0: never). */
  acceptance(opts?: CallOptions) {
    return this.call<Acceptance>('GET', this.teamPath('me', 'acceptance'), undefined, opts);
  }

  /** M11-SPEC §2: accept the current boundaries version (only for oneself). Sent once. */
  setAcceptance(version: number, opts?: CallOptions) {
    return this.call<Acceptance>('PUT', this.teamPath('me', 'acceptance'), { version }, { attempts: 1, ...opts });
  }

  /** M11-SPEC §3: the background answerer's status (the member itself only). Sent once. */
  putStatus(body: MemberStatusBody, opts?: CallOptions) {
    return this.call<Record<string, unknown>>('PUT', this.teamPath('me', 'status'), body, { attempts: 1, ...opts });
  }

  /** M11-SPEC §3: every member's setup progress and whether they are answering now. */
  membersStatus(opts?: CallOptions) {
    return this.call<MembersStatus>('GET', this.teamPath('members', 'status'), undefined, opts);
  }

  /** M11-SPEC §4: this member's recent requests, newest first. */
  myRequests(limit = 20, opts?: CallOptions) {
    return this.call<{ requests: MyRequest[] }>('GET', this.teamPath('me', 'requests') + `?limit=${limit}`, undefined, opts);
  }

  /**
   * M10-SPEC §2a: the Desktop OAuth client members use to connect Google Drive (read-only).
   * An installed-app client is not confidential (Google's rule); it is served to members so it
   * stays out of git. Not configured: 404 drive_not_configured.
   */
  driveClient(opts?: CallOptions) {
    return this.call<{ client_id: string; client_secret: string }>('GET', this.teamPath('drive-client'), undefined, opts);
  }

  /** M6-SPEC §2: the team's roster (owners see every email; members only their own). */
  roster(opts?: CallOptions) {
    return this.call<RosterPage>('GET', this.teamPath('roster'), undefined, opts);
  }

  /** M6-SPEC §2 (owners): add a member. Not idempotent, so sent once. */
  addMember(body: AddMemberBody, opts?: CallOptions) {
    return this.call<Record<string, unknown>>('POST', this.teamPath('roster'), body, { attempts: 1, ...opts });
  }

  /** M6-SPEC §2 (owners): add or remove one email, or change the role. Sent once. */
  updateMember(member: string, body: UpdateMemberBody, opts?: CallOptions) {
    if (!MEMBER_RE.test(member)) throw new Error('invalid member id');
    return this.call<Record<string, unknown>>('PATCH', this.teamPath('roster', member), body, { attempts: 1, ...opts });
  }

  /** M6-SPEC §2 (owners): remove a member (their device credentials are revoked). Sent once. */
  removeMember(member: string, opts?: CallOptions) {
    if (!MEMBER_RE.test(member)) throw new Error('invalid member id');
    return this.call<Record<string, unknown>>('DELETE', this.teamPath('roster', member), undefined, { attempts: 1, ...opts });
  }

  /** M5-SPEC §3: revoke the credential this client signs in with (logout). */
  revokeSelf(opts?: CallOptions) {
    return this.call<Record<string, unknown>>('DELETE', this.teamPath('credentials', 'self'), undefined, { attempts: 1, ...opts });
  }

  // M9-SPEC §2, §4, §7: the account routes. They take a Google identity (a Google ID token,
  // or a delegate on behalf of an email); a device credential or a static token is refused
  // with 403 google_identity_required. The mutations are sent once.

  /** The teams (and invitations) of the signed-in Google account. */
  myTeams(opts?: CallOptions) {
    return this.call<MyTeams>('GET', 'v1/me/teams', undefined, opts);
  }

  /** Create a team; the caller becomes its first owner. */
  createTeam(body: CreateTeamBody, opts?: CallOptions) {
    return this.call<Record<string, unknown>>('POST', 'v1/teams', body, { attempts: 1, ...opts });
  }

  /** Accept or decline an invitation to `team`. */
  answerInvitation(team: string, accept: boolean, opts?: CallOptions) {
    if (!TEAM_RE.test(team)) throw new Error('invalid team id');
    return this.call<Record<string, unknown>>('POST', ['v1', 'me', 'invitations', team].map(encodeURIComponent).join('/'), { accept }, {
      attempts: 1,
      ...opts,
    });
  }

  /** An owner deletes this client's team (M9-SPEC §7.7); `confirm` is the team id typed again. */
  deleteTeam(confirm: string, opts?: CallOptions) {
    return this.call<Record<string, unknown>>('DELETE', ['v1', 'teams', this.team].map(encodeURIComponent).join('/'), { confirm }, {
      attempts: 1,
      ...opts,
    });
  }

  /** Relay admins (M9-SPEC §4): every team, a page at a time. */
  adminTeams(q: { after?: string; limit?: number } = {}, opts?: CallOptions) {
    const params = new URLSearchParams();
    if (q.after !== undefined) params.set('after', q.after);
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    const qs = params.toString();
    return this.call<Record<string, unknown>>('GET', 'v1/admin/teams' + (qs ? `?${qs}` : ''), undefined, opts);
  }

  /** Relay admins (M9-SPEC §4): delete a team; `confirm` is its id typed again. */
  adminDeleteTeam(team: string, confirm: string, opts?: CallOptions) {
    if (!TEAM_RE.test(team)) throw new Error('invalid team id');
    return this.call<Record<string, unknown>>('DELETE', ['v1', 'admin', 'teams', team].map(encodeURIComponent).join('/'), { confirm }, {
      attempts: 1,
      ...opts,
    });
  }

  /** M2-SPEC §3.5: the team's activity feed. */
  activity(q: { since?: string; limit?: number } = {}, opts?: CallOptions) {
    const params = new URLSearchParams();
    if (q.since !== undefined) params.set('since', q.since);
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    const qs = params.toString();
    return this.call<Record<string, unknown>>('GET', this.teamPath('activity') + (qs ? `?${qs}` : ''), undefined, opts);
  }
}

/**
 * Build a client from the environment and the credential file (connectionFromEnv): the
 * stored device credential by default, else RELAY_URL, RELAY_TEAM, RELAY_AUTH,
 * RELAY_GCLOUD_ACCOUNT and RELAY_TOKEN / RELAY_TOKEN_FILE.
 */
export function relayClientFromEnv(env: NodeJS.ProcessEnv, extra: Partial<RelayClientOptions> = {}): RelayClient {
  const c = connectionFromEnv(env);
  return new RelayClient({ url: c.url, team: c.team, token: c.token, ...extra });
}
