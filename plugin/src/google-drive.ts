// Native Google Docs, Sheets and Slides in a team's shared Drive (M10-SPEC §2a).
//
// On disk, Drive for desktop keeps a native Google file as a small JSON link file
// (.gdoc/.gsheet/.gslides) holding its `doc_id`. readGoogleFile(path) reads that id and asks
// the Drive API, as the member, for the file's `driveId`; only when it equals the id of the
// team's shared drive is the file exported. For a picked folder's area (PICKERS-SPEC §6.2) that
// id is the one read locally from the shared drive root's Drive for desktop attribute (no
// drives.list); for a legacy, name-matched drive it is resolved by name with drives.list, as the
// member. Exported as:
// Docs → Markdown (plain text when Markdown is refused), Sheets → CSV for every sheet (Sheets
// API values, which drive.readonly covers; the Drive CSV export of the first sheet, said so in
// the text, when the Sheets API refuses), Slides → plain text. At most 200 KB of text.
//
// Defence in depth: the caller (the answer host) has already checked the path is inside an
// allowed Drive mount. This module checks again on its own: the link file's real path must sit
// under ~/Library/CloudStorage/GoogleDrive-<account>/Shared drives/<shared drive>/ for an
// account in the team's domain (for a picked folder's area: also under the area's root), be a
// regular file of at most 4 KB, and carry a well-formed doc_id; the connected Google account
// must be in the team's domain too.
//
// The refresh token lives only in the macOS Keychain (service "team-relay-drive", account =
// the Google email), written and read through /usr/bin/security without a shell and never as a
// process argument. Access tokens are kept in memory until they expire. Neither ever appears
// in a reason, a log line or a result; Google's answers are never passed through either (a
// reason names the HTTP status at most). Every request goes to a fixed Google endpoint, with a
// timeout, and no redirect is followed.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { EMAIL_RE } from './credentials.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const KEYCHAIN_SERVICE = 'team-relay-drive';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
/** The only hosts this module and drive-login.ts ever talk to. */
export const GOOGLE_HOSTS: ReadonlySet<string> = new Set(['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com', 'sheets.googleapis.com']);

export const DOC_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const RESOURCE_KEY_RE = /^[A-Za-z0-9_-]{1,200}$/;
/** What a Google refresh token looks like ("1//0g…"): no space, quote or backslash. */
export const REFRESH_TOKEN_RE = /^[A-Za-z0-9._~+/-]{10,2048}$/;
const ACCESS_TOKEN_RE = /^[A-Za-z0-9._~+/-]{10,4096}$/;
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CLIENT_ID_RE = /^[A-Za-z0-9.-]{1,200}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_RE = /^[A-Za-z0-9_-]{1,200}$/;

export const MAX_LINK_FILE_BYTES = 4 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SHEET_JSON_BYTES = 8 * 1024 * 1024;
const MAX_DRIVE_PAGES = 50;
const MAX_SHEETS = 100;
export const GOOGLE_TIMEOUT_MS = 20_000;
const USER_AGENT = 'team-relay-plugin/0.1.0';

const GOOGLE_TYPES: Record<string, { mime: string; kind: 'doc' | 'sheet' | 'slides' }> = {
  '.gdoc': { mime: 'application/vnd.google-apps.document', kind: 'doc' },
  '.gsheet': { mime: 'application/vnd.google-apps.spreadsheet', kind: 'sheet' },
  '.gslides': { mime: 'application/vnd.google-apps.presentation', kind: 'slides' },
};

export const NOT_CONNECTED = 'not connected: run /team-relay:drive';

/** A .gdoc/.gsheet/.gslides link file (by name, case-insensitive). */
export function isGoogleLinkFile(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  return Object.hasOwn(GOOGLE_TYPES, extname(path).toLowerCase());
}

export type GoogleFileResult = { ok: true; text: string; mime: string; truncated: boolean } | { ok: false; reason: string };

export type DriveClientSource = { driveClient(): Promise<{ client_id: string; client_secret: string }> };

// ---------------------------------------------------------------------------------------------
// Keychain

/** Where the refresh token lives. Tests inject a fake; the default is the macOS Keychain. */
export interface Keychain {
  /** The Google email of the stored item, or null when there is none. */
  account(): Promise<string | null>;
  /** The refresh token stored for `account`, or null. */
  read(account: string): Promise<string | null>;
  /** Store (or replace) the refresh token for `account`. */
  write(account: string, token: string): Promise<void>;
  /** Remove every item of this service; how many were removed. */
  removeAll(): Promise<number>;
}

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainError';
  }
}

const SECURITY = '/usr/bin/security';
const ITEM_NOT_FOUND = 44;

type ExecResult = { code: number; stdout: string };
type Exec = (args: string[], stdin?: string) => Promise<ExecResult>;

const execSecurity: Exec = (args, stdin) =>
  new Promise((resolve) => {
    const child = execFile(SECURITY, args, { shell: false, timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });

/**
 * The macOS Keychain through /usr/bin/security (execFile, never a shell). The token is
 * written through `security -i` on stdin, so it never appears in a process argument (which
 * every local user can read with ps), and read back with `-w` on stdout.
 */
export function macKeychain(exec: Exec = execSecurity): Keychain {
  const checkAccount = (account: string) => {
    if (typeof account !== 'string' || account.length > 254 || !EMAIL_RE.test(account)) throw new KeychainError('invalid account');
  };
  return {
    async account() {
      const r = await exec(['find-generic-password', '-s', KEYCHAIN_SERVICE]);
      if (r.code === ITEM_NOT_FOUND) return null;
      if (r.code !== 0) throw new KeychainError(`the Keychain could not be read (security exit ${r.code})`);
      const m = /"acct"<blob>="([^"\n]*)"/.exec(r.stdout);
      const acct = m?.[1];
      return acct && EMAIL_RE.test(acct) ? acct : null;
    },
    async read(account) {
      checkAccount(account);
      const r = await exec(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w']);
      if (r.code === ITEM_NOT_FOUND) return null;
      if (r.code !== 0) throw new KeychainError(`the Keychain could not be read (security exit ${r.code})`);
      const token = r.stdout.replace(/\n$/, '');
      return REFRESH_TOKEN_RE.test(token) ? token : null;
    },
    async write(account, token) {
      checkAccount(account);
      if (!REFRESH_TOKEN_RE.test(token)) throw new KeychainError('the token has an unexpected form; nothing was stored');
      // Neither value can hold a quote, a space or a backslash (checked above), so quoting is exact.
      const line = `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account}" -l "${KEYCHAIN_SERVICE}" -w "${token}"\n`;
      const r = await exec(['-i'], line);
      if (r.code !== 0) throw new KeychainError(`the Keychain could not be written (security exit ${r.code})`);
      // `security -i` reports a failed command on stderr and may still exit 0: read it back.
      const back = await this.read(account);
      if (back !== token) throw new KeychainError('the Keychain did not keep the token');
    },
    async removeAll() {
      let n = 0;
      for (let i = 0; i < 20; i++) {
        const r = await exec(['delete-generic-password', '-s', KEYCHAIN_SERVICE]);
        if (r.code === ITEM_NOT_FOUND) return n;
        if (r.code !== 0) throw new KeychainError(`the Keychain item could not be deleted (security exit ${r.code})`);
        n++;
      }
      throw new KeychainError('too many Keychain items to delete');
    },
  };
}

/** The Keychain this platform has, or null (only macOS: there is no file fallback, by design). */
export function defaultKeychain(platform: NodeJS.Platform = process.platform): Keychain | null {
  return platform === 'darwin' ? macKeychain() : null;
}

// ---------------------------------------------------------------------------------------------
// HTTP to Google

export type FetchLike = typeof fetch;

export class GoogleHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 0 ? 'Google did not answer' : `Google refused (${status})`);
    this.name = 'GoogleHttpError';
    this.status = status;
  }
}

/** Throws unless `url` is https on one of the fixed Google hosts, default port, no userinfo. */
export function assertGoogleUrl(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !GOOGLE_HOSTS.has(u.hostname) || u.port !== '' || u.username || u.password) {
    throw new Error('not a Google endpoint');
  }
  return u;
}

async function readCapped(res: Response, max: number): Promise<{ buf: Buffer; over: boolean }> {
  if (!res.body) return { buf: Buffer.alloc(0), over: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.byteLength > max) {
      chunks.push(Buffer.from(value.subarray(0, max - n)));
      n = max;
      await reader.cancel().catch(() => {});
      return { buf: Buffer.concat(chunks), over: true };
    }
    chunks.push(Buffer.from(value));
    n += value.byteLength;
  }
  return { buf: Buffer.concat(chunks), over: false };
}

export type GoogleResponse = { status: number; body: Buffer; over: boolean };

/**
 * One request to a fixed Google endpoint: a timeout, no redirect followed, the body read up to
 * `maxBytes`. A network failure or timeout is status 0. Never throws with Google's text.
 */
export async function googleRequest(
  doFetch: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number; timeoutMs?: number } = {},
): Promise<GoogleResponse> {
  assertGoogleUrl(url);
  const signal = AbortSignal.timeout(init.timeoutMs ?? GOOGLE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: init.method ?? 'GET',
      headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: 'error',
      signal,
    });
    const { buf, over } = await readCapped(res, init.maxBytes ?? MAX_JSON_BYTES);
    return { status: res.status, body: buf, over };
  } catch {
    return { status: 0, body: Buffer.alloc(0), over: false };
  }
}

function jsonOf(r: GoogleResponse): Record<string, unknown> | null {
  if (r.over) return null;
  try {
    const v = JSON.parse(r.body.toString('utf8')) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** POST a form to a fixed Google endpoint (the token never goes in a URL). */
export function googleForm(doFetch: FetchLike, url: string, form: Record<string, string>, maxBytes = 16 * 1024): Promise<GoogleResponse> {
  return googleRequest(doFetch, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    maxBytes,
  });
}

/** The OAuth error code Google gave (e.g. invalid_grant), when it is a plain code. */
export function oauthError(r: GoogleResponse): string | null {
  const j = jsonOf(r);
  const e = j?.error;
  return typeof e === 'string' && /^[a-z_]{1,40}$/.test(e) ? e : null;
}

/** Revoke a token at Google (best effort). True when Google says it is gone. */
export async function revokeToken(doFetch: FetchLike, token: string): Promise<boolean> {
  const r = await googleForm(doFetch, GOOGLE_REVOKE_URL, { token });
  return r.status === 200 || (r.status === 400 && oauthError(r) === 'invalid_token');
}

/** The relay-served Desktop OAuth client, checked for shape. */
export async function fetchDriveClient(relay: DriveClientSource): Promise<{ client_id: string; client_secret: string }> {
  let c: { client_id: string; client_secret: string };
  try {
    c = await relay.driveClient();
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    const code = (err as { code?: unknown }).code;
    if (status === 404 && code === 'drive_not_configured') throw new DriveReadError('Google Drive is not set up for this team (ask the relay admin)');
    throw new DriveReadError('the team relay did not give the Google Drive client; try again later');
  }
  if (!c || typeof c.client_id !== 'string' || !CLIENT_ID_RE.test(c.client_id) || typeof c.client_secret !== 'string' || !CLIENT_SECRET_RE.test(c.client_secret)) {
    throw new DriveReadError('the team relay gave an invalid Google Drive client');
  }
  return { client_id: c.client_id, client_secret: c.client_secret };
}

/** A lower-case DNS name. */
export function isDomain(d: unknown): d is string {
  return typeof d === 'string' && DOMAIN_RE.test(d);
}

/** Whether `email` is an address in exactly `domain` (not a subdomain), case-insensitive. */
export function emailInDomain(email: string, domain: string): boolean {
  if (!EMAIL_RE.test(email)) return false;
  const at = email.lastIndexOf('@');
  return email.slice(at + 1).toLowerCase() === domain.toLowerCase();
}

/** A failure whose message is a short, non-sensitive reason. */
export class DriveReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveReadError';
  }
}

// ---------------------------------------------------------------------------------------------
// Access tokens (in memory only)

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

/** Forget every cached access token (disconnect; tests). */
export function clearDriveTokenCache(): void {
  tokenCache.clear();
}

function cacheKey(account: string, refresh: string): string {
  return `${account}\n${createHash('sha256').update(refresh).digest('hex')}`;
}

async function refreshAccessToken(doFetch: FetchLike, relay: DriveClientSource, refresh: string, now: () => number): Promise<CachedToken> {
  const client = await fetchDriveClient(relay);
  const r = await googleForm(doFetch, GOOGLE_TOKEN_URL, {
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });
  if (r.status === 0) throw new DriveReadError('Google did not answer');
  if (r.status !== 200) {
    const e = oauthError(r);
    if (e === 'invalid_grant' || e === 'unauthorized_client' || e === 'invalid_client') {
      throw new DriveReadError('the Google Drive connection has expired or was revoked: run /team-relay:drive connect');
    }
    throw new DriveReadError(`Google refused (${r.status})`);
  }
  const j = jsonOf(r);
  const token = j?.access_token;
  const expiresIn = j?.expires_in;
  const scope = j?.scope;
  if (typeof token !== 'string' || !ACCESS_TOKEN_RE.test(token)) throw new DriveReadError('Google answered with something unexpected');
  if (typeof scope === 'string' && !scope.split(' ').includes(DRIVE_SCOPE)) {
    throw new DriveReadError('the Google Drive connection does not allow reading Drive: run /team-relay:drive connect');
  }
  const secs = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 3600) : 300;
  return { token, expiresAt: now() + Math.max(0, secs - 60) * 1000 };
}

class Session {
  private current: CachedToken | null = null;
  constructor(
    private readonly doFetch: FetchLike,
    private readonly relay: DriveClientSource,
    private readonly account: string,
    private readonly refresh: string,
    private readonly now: () => number,
  ) {}

  async token(): Promise<string> {
    const key = cacheKey(this.account, this.refresh);
    const hit = tokenCache.get(key);
    if (hit && hit.expiresAt > this.now()) {
      this.current = hit;
      return hit.token;
    }
    const fresh = await refreshAccessToken(this.doFetch, this.relay, this.refresh, this.now);
    tokenCache.set(key, fresh);
    this.current = fresh;
    return fresh.token;
  }

  invalidate(): void {
    tokenCache.delete(cacheKey(this.account, this.refresh));
    this.current = null;
  }

  /** GET a Drive/Sheets URL as the member; one retry with a fresh token on 401. */
  async get(url: string, opts: { maxBytes?: number; headers?: Record<string, string> } = {}): Promise<GoogleResponse> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token();
      const r = await googleRequest(this.doFetch, url, {
        headers: { Authorization: `Bearer ${token}`, Accept: '*/*', ...(opts.headers ?? {}) },
        ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      });
      if (r.status === 401 && attempt === 0) {
        this.invalidate();
        continue;
      }
      return r;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The link file

export type LinkFile = { docId: string; resourceKey: string | null; kind: 'doc' | 'sheet' | 'slides'; googleMime: string };

/** The default root of Drive for desktop mounts on macOS. */
export function cloudStorageRoot(): string {
  return join(homedir(), 'Library', 'CloudStorage');
}

/** A legacy shared drive, matched by name (M10-SPEC §2a). */
export type NamedDriveArea = { domain: string; shared_drive: string };
/**
 * PICKERS-SPEC §6.2: a picked folder's area: its canonical root folder, the Drive id of the
 * shared drive it is in (read locally from that drive root's attribute) and the picked folder's
 * own Drive id (the drive's id when the whole shared drive was picked).
 */
export type FolderDriveArea = { domain: string; root: string; drive_root_id: string; folder_id: string };
export type GoogleFileArea = NamedDriveArea | FolderDriveArea;

const isFolderArea = (a: GoogleFileArea): a is FolderDriveArea => 'root' in a;

/** Whether `rel` (relative) stays below its base: not empty, not upwards, not absolute. */
const below = (rel: string) => rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);

/**
 * Check the link file sits under GoogleDrive-<account in domain>/Shared drives/<shared drive>/
 * below `root` (real paths, so a symlink cannot lead out): for a legacy drive the shared drive of
 * that name, for a picked folder below the folder's own root. Then read and parse it.
 */
export function readLinkFile(linkPath: string, area: GoogleFileArea, root: string): LinkFile {
  if (!isGoogleLinkFile(linkPath)) throw new DriveReadError('not a Google file');
  if (!isAbsolute(linkPath)) throw new DriveReadError('not in the team drive');
  let realRoot: string;
  let realFile: string;
  let realArea: string | null = null;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(linkPath);
    if (isFolderArea(area)) realArea = realpathSync(area.root);
  } catch {
    throw new DriveReadError('not in the team drive');
  }
  if (!isGoogleLinkFile(realFile)) throw new DriveReadError('not a Google file');
  const ext = extname(realFile).toLowerCase();
  if (ext !== extname(linkPath).toLowerCase()) throw new DriveReadError('not a Google file');
  const rel = relative(realRoot, realFile);
  if (!below(rel)) throw new DriveReadError('not in the team drive');
  const segs = rel.split(sep);
  const mount = /^GoogleDrive-(.+)$/.exec(segs[0] ?? '');
  const account = mount?.[1];
  if (segs.length < 4 || !account || !emailInDomain(account, area.domain) || segs[1] !== 'Shared drives') throw new DriveReadError('not in the team drive');
  if (isFolderArea(area)) {
    // The area's root is itself in a shared drive of that mount, and the file below it.
    const areaRel = relative(realRoot, realArea!);
    const areaSegs = areaRel.split(sep);
    if (!below(areaRel) || areaSegs.length < 3 || areaSegs[0] !== segs[0] || areaSegs[1] !== 'Shared drives' || !below(relative(realArea!, realFile))) {
      throw new DriveReadError('not in the team drive');
    }
  } else if ((segs[2] ?? '').normalize('NFC') !== area.shared_drive.normalize('NFC')) {
    throw new DriveReadError('not in the team drive');
  }

  let fd: number;
  try {
    fd = openSync(realFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new DriveReadError('the link file cannot be read');
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new DriveReadError('not a Google file');
    if (st.size > MAX_LINK_FILE_BYTES) throw new DriveReadError('the link file is too large to be a Google link');
    const buf = Buffer.alloc(MAX_LINK_FILE_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > MAX_LINK_FILE_BYTES) throw new DriveReadError('the link file is too large to be a Google link');
    }
    text = buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DriveReadError('the link file is not a Google link');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new DriveReadError('the link file is not a Google link');
  const o = json as Record<string, unknown>;
  const docId = o.doc_id;
  if (typeof docId !== 'string' || !DOC_ID_RE.test(docId)) throw new DriveReadError('the link file has no valid doc_id');
  const rk = o.resource_key;
  let resourceKey: string | null = null;
  if (typeof rk === 'string' && rk !== '') {
    if (!RESOURCE_KEY_RE.test(rk)) throw new DriveReadError('the link file has an invalid resource_key');
    resourceKey = rk;
  } else if (rk !== undefined && rk !== null && rk !== '') {
    throw new DriveReadError('the link file has an invalid resource_key');
  }
  // The account Drive for desktop wrote it for must be in the team's domain too.
  const email = o.email;
  if (email !== undefined && email !== null && email !== '' && (typeof email !== 'string' || !emailInDomain(email, area.domain))) {
    throw new DriveReadError('not in the team drive');
  }
  const t = GOOGLE_TYPES[ext]!;
  return { docId, resourceKey, kind: t.kind, googleMime: t.mime };
}

// ---------------------------------------------------------------------------------------------
// Drive and Sheets calls

/** The id of the one shared drive the member sees with exactly this name. */
/** Levels of parents walked up from a file to find the picked folder (PICKERS-SPEC §6.2, 11 Nov 2026). */
export const MAX_ANCESTRY_LEVELS = 20;
const NOT_IN_FOLDER = 'not in the picked Drive folder';

/** A Drive item's one parent, or null (none, several, or not id-shaped: an item in a shared drive has exactly one). */
function oneParent(parents: unknown): string | null {
  if (!Array.isArray(parents) || parents.length !== 1) return null;
  const p: unknown = parents[0];
  return typeof p === 'string' && DOC_ID_RE.test(p) ? p : null;
}

/**
 * PICKERS-SPEC §6.2 (11 Nov 2026): whether a file whose parents are `parents` lies in the picked
 * folder `folderId` of the shared drive `driveId`, asked of the Drive API as the member: walk up
 * one parent at a time (each `files.get` with `id,parents,driveId`), at most MAX_ANCESTRY_LEVELS,
 * stopping as soon as the folder is met. Not in it: the drive root reached first, the cap hit, a
 * parent that cannot be read, a parent in another drive, or an item without exactly one parent.
 * Nothing is kept between files. A network failure throws (Google did not answer).
 */
async function reachesFolder(s: Session, parents: unknown, driveId: string, folderId: string): Promise<boolean> {
  let current = oneParent(parents);
  for (let level = 1; level <= MAX_ANCESTRY_LEVELS; level++) {
    if (current === null || current === driveId) return false;
    if (current === folderId) return true;
    if (level === MAX_ANCESTRY_LEVELS) return false;
    const q = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,parents,driveId' });
    const r = await s.get(`${DRIVE_API}files/${encodeURIComponent(current)}?${q.toString()}`);
    if (r.status === 0) throw new GoogleHttpError(0);
    if (r.status !== 200) return false;
    const m = jsonOf(r);
    if (!m || m.id !== current || m.driveId !== driveId) return false;
    current = oneParent(m.parents);
  }
  return false;
}

async function resolveSharedDrive(s: Session, name: string): Promise<string> {
  const want = name.normalize('NFC');
  const found: string[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_DRIVE_PAGES; page++) {
    const q = new URLSearchParams({ pageSize: '100', useDomainAdminAccess: 'false', fields: 'nextPageToken,drives(id,name)' });
    if (pageToken) q.set('pageToken', pageToken);
    const r = await s.get(`${DRIVE_API}drives?${q.toString()}`);
    if (r.status !== 200) throw new GoogleHttpError(r.status);
    const j = jsonOf(r);
    if (!j) throw new DriveReadError('Google answered with something unexpected');
    const drives = Array.isArray(j.drives) ? j.drives : [];
    for (const d of drives) {
      if (typeof d !== 'object' || d === null) continue;
      const { id, name: n } = d as Record<string, unknown>;
      if (typeof id === 'string' && typeof n === 'string' && n.normalize('NFC') === want) found.push(id);
    }
    const next = j.nextPageToken;
    if (typeof next !== 'string' || next === '') {
      pageToken = null;
      break;
    }
    pageToken = next;
  }
  if (pageToken) throw new DriveReadError('too many shared drives to find the team drive');
  if (found.length === 0) throw new DriveReadError('the team drive is not visible to the connected Google account');
  if (new Set(found).size > 1) throw new DriveReadError('two or more shared drives have the team drive\'s name; cannot tell which one it is');
  return found[0]!;
}

function decode(buf: Buffer, truncated: boolean): string {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // A cut inside a multi-byte character leaves a replacement character at the end.
  if (truncated) text = text.replace(/�+$/, '');
  return text;
}

async function exportAs(s: Session, docId: string, mime: string): Promise<GoogleResponse> {
  const q = new URLSearchParams({ mimeType: mime, supportsAllDrives: 'true' });
  return s.get(`${DRIVE_API}files/${encodeURIComponent(docId)}/export?${q.toString()}`, { maxBytes: MAX_TEXT_BYTES });
}

function textResult(r: GoogleResponse, mime: string, prefix = ''): GoogleFileResult {
  const pre = Buffer.from(prefix, 'utf8');
  const room = MAX_TEXT_BYTES - pre.length;
  const over = r.over || r.body.length > room;
  const body = r.body.length > room ? r.body.subarray(0, room) : r.body;
  return { ok: true, text: prefix + decode(body, over), mime, truncated: over };
}

/** One CSV field (RFC 4180). */
export function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sheetRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/**
 * Every grid sheet as CSV, through the Sheets API (drive.readonly is enough for it). Null
 * when the Sheets API cannot be used (not enabled for the client's project, refused): the
 * caller falls back to the Drive export of the first sheet.
 */
async function exportSheets(s: Session, docId: string): Promise<GoogleFileResult | null> {
  const meta = await s.get(`${SHEETS_API}${encodeURIComponent(docId)}?${new URLSearchParams({ fields: 'sheets.properties(title,sheetType,index)' }).toString()}`);
  if (meta.status !== 200) return null;
  const j = jsonOf(meta);
  if (!j || !Array.isArray(j.sheets)) return null;
  const titles: string[] = [];
  const props = j.sheets
    .map((x) => (typeof x === 'object' && x !== null ? (x as { properties?: Record<string, unknown> }).properties : undefined))
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .sort((a, b) => (typeof a.index === 'number' ? a.index : 0) - (typeof b.index === 'number' ? b.index : 0));
  for (const p of props) {
    if (typeof p.title !== 'string' || p.title.length === 0 || p.title.length > 200) continue;
    if (p.sheetType !== undefined && p.sheetType !== 'GRID') continue;
    titles.push(p.title);
  }
  let out = '';
  let truncated = titles.length > MAX_SHEETS;
  const budget = MAX_TEXT_BYTES;
  for (const title of titles.slice(0, MAX_SHEETS)) {
    const q = new URLSearchParams({ majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' });
    const r = await s.get(`${SHEETS_API}${encodeURIComponent(docId)}/values/${encodeURIComponent(sheetRange(title))}?${q.toString()}`, { maxBytes: MAX_SHEET_JSON_BYTES });
    if (r.over) {
      truncated = true;
      break;
    }
    if (r.status !== 200) return out ? { ok: true, text: out, mime: 'text/csv', truncated: true } : null;
    const v = jsonOf(r);
    const rows = Array.isArray(v?.values) ? (v!.values as unknown[]) : [];
    let section = `# Sheet: ${title.replace(/[\r\n]+/g, ' ')}\n`;
    for (const row of rows) section += `${(Array.isArray(row) ? row : []).map(csvField).join(',')}\n`;
    section += '\n';
    if (Buffer.byteLength(out + section, 'utf8') > budget) {
      const room = budget - Buffer.byteLength(out, 'utf8');
      if (room > 0) out += decode(Buffer.from(section, 'utf8').subarray(0, room), true);
      truncated = true;
      break;
    }
    out += section;
  }
  return { ok: true, text: out, mime: 'text/csv', truncated };
}

export const FIRST_SHEET_NOTE = '(first sheet only: the other sheets could not be read)\n';

async function exportFile(s: Session, link: LinkFile): Promise<GoogleFileResult> {
  if (link.kind === 'doc') {
    const md = await exportAs(s, link.docId, 'text/markdown');
    if (md.status === 200) return textResult(md, 'text/markdown');
    if (md.status !== 400 && md.status !== 415) throw new GoogleHttpError(md.status);
    const plain = await exportAs(s, link.docId, 'text/plain');
    if (plain.status === 200) return textResult(plain, 'text/plain');
    throw new GoogleHttpError(plain.status);
  }
  if (link.kind === 'slides') {
    const r = await exportAs(s, link.docId, 'text/plain');
    if (r.status === 200) return textResult(r, 'text/plain');
    throw new GoogleHttpError(r.status);
  }
  const all = await exportSheets(s, link.docId);
  if (all) return all;
  const csv = await exportAs(s, link.docId, 'text/csv');
  if (csv.status === 200) return textResult(csv, 'text/csv', FIRST_SHEET_NOTE);
  throw new GoogleHttpError(csv.status);
}

// ---------------------------------------------------------------------------------------------
// The entry point

export type ReadGoogleFileDeps = {
  fetch?: FetchLike;
  relay?: DriveClientSource;
  now?: () => number;
  /** The Keychain (tests inject a fake). Default: the macOS Keychain; none elsewhere. */
  keychain?: Keychain | null;
  /** Where Drive for desktop mounts live. Default: ~/Library/CloudStorage. */
  cloudStorageRoot?: string;
};

async function defaultRelay(): Promise<DriveClientSource> {
  const { relayClientFromEnv } = await import('./relay-client.js');
  return relayClientFromEnv(process.env, { attempts: 1, timeoutMs: 10_000 });
}

/** The area as given, checked for shape (null: it cannot be used). */
function areaOk(a: unknown): GoogleFileArea | null {
  if (typeof a !== 'object' || a === null) return null;
  const o = a as Record<string, unknown>;
  if (!isDomain(o.domain)) return null;
  if ('root' in o) {
    const idOk = (v: unknown): v is string => typeof v === 'string' && DOC_ID_RE.test(v);
    return typeof o.root === 'string' && isAbsolute(o.root) && idOk(o.drive_root_id) && idOk(o.folder_id)
      ? { domain: o.domain, root: o.root, drive_root_id: o.drive_root_id, folder_id: o.folder_id }
      : null;
  }
  const n = o.shared_drive;
  return typeof n === 'string' && n.length > 0 && n.length <= 100 && !/[/\u0000-\u001f\u007f]/.test(n) ? { domain: o.domain, shared_drive: n } : null;
}

/**
 * Read a native Google file in the team's shared drive (a legacy drive by name, or a picked
 * folder's area), as the connected member. Never throws; every failure is {ok:false, reason}
 * with a short reason that holds no token and no text from Google.
 */
export async function readGoogleFile(linkPath: string, given: GoogleFileArea, deps: ReadGoogleFileDeps = {}): Promise<GoogleFileResult> {
  try {
    if (!isGoogleLinkFile(linkPath)) return { ok: false, reason: 'not a Google file' };
    const drive = areaOk(given);
    if (!drive) return { ok: false, reason: 'not in the team drive' };
    const link = readLinkFile(linkPath, drive, deps.cloudStorageRoot ?? cloudStorageRoot());

    const keychain = deps.keychain === undefined ? defaultKeychain() : deps.keychain;
    if (!keychain) return { ok: false, reason: 'Google files can only be read on macOS (the Drive connection lives in the macOS Keychain)' };
    const account = await keychain.account();
    if (!account) return { ok: false, reason: NOT_CONNECTED };
    if (!emailInDomain(account, drive.domain)) {
      return { ok: false, reason: `the connected Google account is not in ${drive.domain}: run /team-relay:drive connect` };
    }
    const refresh = await keychain.read(account);
    if (!refresh) return { ok: false, reason: NOT_CONNECTED };

    const doFetch = deps.fetch ?? ((u: string | URL | Request, i?: RequestInit) => fetch(u, i));
    const relay = deps.relay ?? (await defaultRelay());
    const s = new Session(doFetch as FetchLike, relay, account, refresh, deps.now ?? Date.now);

    // PICKERS-SPEC §6.2: a picked folder's drive id was read on this Mac; only a legacy drive is looked up by name.
    const driveId = isFolderArea(drive) ? drive.drive_root_id : await resolveSharedDrive(s, drive.shared_drive);
    // A folder inside a shared drive (not a whole drive): the file's ancestry must reach it.
    const folderId = isFolderArea(drive) && drive.folder_id !== drive.drive_root_id ? drive.folder_id : null;

    const q = new URLSearchParams({ supportsAllDrives: 'true', fields: folderId ? 'id,name,mimeType,driveId,parents' : 'id,name,mimeType,driveId' });
    const headers: Record<string, string> = link.resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${link.docId}/${link.resourceKey}` } : {};
    const meta = await s.get(`${DRIVE_API}files/${encodeURIComponent(link.docId)}?${q.toString()}`, { headers });
    if (meta.status !== 200) throw new GoogleHttpError(meta.status);
    const m = jsonOf(meta);
    if (!m || m.id !== link.docId) return { ok: false, reason: 'Google answered with something unexpected' };
    if (typeof m.driveId !== 'string' || m.driveId !== driveId) return { ok: false, reason: 'not in the team drive' };
    if (m.mimeType !== link.googleMime) return { ok: false, reason: 'not a Google file' };
    if (folderId && !(await reachesFolder(s, m.parents, driveId, folderId))) return { ok: false, reason: NOT_IN_FOLDER };

    return await exportFile(s, link);
  } catch (err) {
    if (err instanceof DriveReadError || err instanceof GoogleHttpError) return { ok: false, reason: err.message };
    if (err instanceof KeychainError) return { ok: false, reason: `${NOT_CONNECTED} (${err.message})` };
    return { ok: false, reason: 'the Google file could not be read' };
  }
}
