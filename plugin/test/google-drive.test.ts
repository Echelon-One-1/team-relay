// M10-SPEC §2a, ACC-7: read_google_file. Every Google endpoint is a fake fetch and the Keychain
// is a fake: nothing here talks to Google or touches the real Keychain. All names, ids and
// addresses are synthetic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DRIVE_SCOPE,
  FIRST_SHEET_NOTE,
  GOOGLE_HOSTS,
  KEYCHAIN_SERVICE,
  MAX_TEXT_BYTES,
  NOT_CONNECTED,
  clearDriveTokenCache,
  csvField,
  isGoogleLinkFile,
  macKeychain,
  readGoogleFile,
  type Keychain,
} from '../src/google-drive.js';

const DOMAIN = 'example.com';
const DRIVE_NAME = 'Example Team Drive';
const DRIVE = { domain: DOMAIN, shared_drive: DRIVE_NAME };
const TEAM_DRIVE_ID = '0ATEAMdriveIDxyz';
const OTHER_DRIVE_ID = '0AOTHERdriveIDxy';
const REFRESH = '1//0gREFRESH-secret_token.abcdefXYZ';
const ACCESS_PREFIX = 'ya29.ACCESS-secret-';
const CLIENT = { client_id: '1234-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-clientsecret' };
const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const SHEET_ID = '1SheetIdAbCdEfGhIjKlMnOpQrStUvWxYz012';
const SLIDES_ID = '1SlidesIdAbCdEfGhIjKlMnOpQrStUvWxYz01';
const ELSEWHERE_ID = '1ElsewhereAbCdEfGhIjKlMnOpQrStUvWxYz0';
const MYDRIVE_ID = '1MyDriveAbCdEfGhIjKlMnOpQrStUvWxYz012';

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

type Call = { url: URL; method: string; headers: Record<string, string>; body: string; redirect: RequestInit['redirect'] };

type FileMeta = { mimeType: string; driveId?: string; parents?: string[] };

class FakeGoogle {
  calls: Call[] = [];
  tokenCalls = 0;
  drivesPages: Array<Array<{ id: string; name: string }>> = [[{ id: TEAM_DRIVE_ID, name: DRIVE_NAME }, { id: OTHER_DRIVE_ID, name: 'Other' }]];
  files: Record<string, FileMeta> = {
    [DOC_ID]: { mimeType: 'application/vnd.google-apps.document', driveId: TEAM_DRIVE_ID },
    [SHEET_ID]: { mimeType: 'application/vnd.google-apps.spreadsheet', driveId: TEAM_DRIVE_ID },
    [SLIDES_ID]: { mimeType: 'application/vnd.google-apps.presentation', driveId: TEAM_DRIVE_ID },
    [ELSEWHERE_ID]: { mimeType: 'application/vnd.google-apps.document', driveId: OTHER_DRIVE_ID },
    [MYDRIVE_ID]: { mimeType: 'application/vnd.google-apps.document' },
  };
  exports: Record<string, string> = {
    [`${DOC_ID} text/markdown`]: '# Plan\n\nSynthetic document body.\n',
    [`${DOC_ID} text/plain`]: 'Plan\n\nSynthetic document body.\n',
    [`${SLIDES_ID} text/plain`]: 'Slide 1\nSynthetic slide.\n',
    [`${SHEET_ID} text/csv`]: 'a,b\n1,2\n',
  };
  sheetsApi: 'ok' | 'disabled' = 'ok';
  sheets: Array<{ title: string; sheetType?: string; values: unknown[][] }> = [
    { title: 'Summary', values: [['name', 'value'], ['alpha', '1'], ['with, comma', 'say "hi"']] },
    { title: "Bob's data", values: [['x'], ['y']] },
    { title: 'Chart 1', sheetType: 'OBJECT', values: [] },
  ];
  refreshStatus = 200;
  refreshError: string | null = null;
  status: Record<string, number> = {};
  /** Drive returns 401 for this many requests (an access token Google no longer accepts). */
  unauthorizedOnce = 0;
  currentAccess = '';

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = typeof init?.body === 'string' ? init.body : '';
    this.calls.push({ url, method: init?.method ?? 'GET', headers, body, redirect: init?.redirect });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      this.tokenCalls++;
      const form = new URLSearchParams(body);
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('client_id')).toBe(CLIENT.client_id);
      if (this.refreshStatus !== 200) return json(this.refreshStatus, { error: this.refreshError ?? 'server_error', error_description: `bad ${form.get('refresh_token')}` });
      if (form.get('refresh_token') !== REFRESH) return json(400, { error: 'invalid_grant' });
      this.currentAccess = `${ACCESS_PREFIX}${this.tokenCalls}`;
      return json(200, { access_token: this.currentAccess, expires_in: 3599, scope: DRIVE_SCOPE, token_type: 'Bearer' });
    }
    const auth = headers.Authorization;
    if (this.unauthorizedOnce > 0) {
      this.unauthorizedOnce--;
      return json(401, { error: { message: `token ${auth} expired` } });
    }
    if (auth !== `Bearer ${this.currentAccess}`) return json(401, { error: { message: 'bad token' } });

    if (url.host === 'www.googleapis.com' && url.pathname === '/drive/v3/drives') {
      expect(url.searchParams.get('useDomainAdminAccess')).toBe('false');
      const i = Number(url.searchParams.get('pageToken') ?? '0');
      const next = i + 1 < this.drivesPages.length ? String(i + 1) : undefined;
      return json(200, { drives: this.drivesPages[i], ...(next ? { nextPageToken: next } : {}) });
    }
    const exp = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname);
    if (url.host === 'www.googleapis.com' && exp) {
      const key = `${decodeURIComponent(exp[1]!)} ${url.searchParams.get('mimeType')}`;
      if (this.status[key]) return json(this.status[key]!, { error: { message: `secret detail ${auth}` } });
      const text = this.exports[key];
      if (text === undefined) return json(400, { error: { message: 'unsupported' } });
      return new Response(text, { status: 200 });
    }
    const meta = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (url.host === 'www.googleapis.com' && meta) {
      const id = decodeURIComponent(meta[1]!);
      expect(url.searchParams.get('supportsAllDrives')).toBe('true');
      if (this.status[`meta ${id}`]) return json(this.status[`meta ${id}`]!, { error: { message: `nope ${auth}` } });
      const f = this.files[id];
      if (!f) return json(404, { error: { message: 'File not found' } });
      // Only the fields asked for (as Drive does): `parents` only when `fields` names it.
      const fields = (url.searchParams.get('fields') ?? '').split(',');
      return json(200, { id, name: 'Synthetic', mimeType: f.mimeType, ...(f.driveId ? { driveId: f.driveId } : {}), ...(f.parents && fields.includes('parents') ? { parents: f.parents } : {}) });
    }
    if (url.host === 'sheets.googleapis.com') {
      if (this.sheetsApi === 'disabled') return json(403, { error: { status: 'PERMISSION_DENIED', message: 'Sheets API has not been used' } });
      const vals = /^\/v4\/spreadsheets\/([^/]+)\/values\/(.+)$/.exec(url.pathname);
      if (vals) {
        const range = decodeURIComponent(vals[2]!);
        const sheet = this.sheets.find((s) => `'${s.title.replace(/'/g, "''")}'` === range);
        if (!sheet) return json(400, { error: { message: 'Unable to parse range' } });
        return json(200, { range, majorDimension: 'ROWS', values: sheet.values });
      }
      return json(200, { sheets: this.sheets.map((s, index) => ({ properties: { title: s.title, index, sheetType: s.sheetType ?? 'GRID' } })) });
    }
    throw new Error(`unexpected request to ${url.toString()}`);
  };
}

let root: string;
let google: FakeGoogle;
let keychain: ReturnType<typeof fakeKeychain>;
let now: number;
const relay = { driveClient: async () => CLIENT };

const teamDir = () => join(root, `GoogleDrive-alice@${DOMAIN}`, 'Shared drives', DRIVE_NAME, 'Clients');

function link(name: string, content: unknown, dir = teamDir()): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

const linkJson = (docId: string, extra: Record<string, unknown> = {}) => ({ '': 'synthetic', doc_id: docId, email: `alice@${DOMAIN}`, resource_key: '', ...extra });

const read = (path: string, drive = DRIVE) => readGoogleFile(path, drive, { fetch: google.fetch as typeof fetch, relay, now: () => now, keychain, cloudStorageRoot: root });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'team-relay-gdrive-'));
  google = new FakeGoogle();
  keychain = fakeKeychain({ [`alice@${DOMAIN}`]: REFRESH });
  now = 1_800_000_000_000;
  clearDriveTokenCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** No reason, text or call ever leaks a token; every call goes to a fixed Google host without redirects. */
function assertClean(result: unknown) {
  const s = JSON.stringify(result);
  expect(s).not.toContain(REFRESH);
  expect(s).not.toContain(ACCESS_PREFIX);
  expect(s).not.toContain(CLIENT.client_secret);
  for (const c of google.calls) {
    expect(c.url.protocol).toBe('https:');
    expect(GOOGLE_HOSTS.has(c.url.hostname)).toBe(true);
    expect(c.redirect).toBe('error');
    // The refresh token only ever goes to the token endpoint, in a POST body.
    expect(c.url.toString()).not.toContain(REFRESH);
    expect(c.url.toString()).not.toContain(ACCESS_PREFIX);
    if (c.body.includes(encodeURIComponent(REFRESH))) expect(`${c.url.host}${c.url.pathname}`).toBe('oauth2.googleapis.com/token');
  }
}

describe('isGoogleLinkFile', () => {
  it('knows .gdoc, .gsheet and .gslides in any case, and nothing else', () => {
    for (const p of ['/a/b.gdoc', '/a/b.GSHEET', 'x.gSlides']) expect(isGoogleLinkFile(p)).toBe(true);
    for (const p of ['/a/b.docx', '/a/b.gdoc.txt', '/a/gdoc', '', '/a/b.gform', '/a/.gdocx']) expect(isGoogleLinkFile(p)).toBe(false);
  });
});

describe('readGoogleFile (ACC-7)', () => {
  it('exports a Doc in the team drive as Markdown, with the resource key header and the right calls', async () => {
    const p = link('Plan.gdoc', linkJson(DOC_ID, { resource_key: '0-abcRK_1' }));
    const r = await read(p);
    expect(r).toEqual({ ok: true, text: '# Plan\n\nSynthetic document body.\n', mime: 'text/markdown', truncated: false });
    const meta = google.calls.find((c) => c.url.pathname === `/drive/v3/files/${DOC_ID}`)!;
    expect(meta.headers['X-Goog-Drive-Resource-Keys']).toBe(`${DOC_ID}/0-abcRK_1`);
    expect(meta.url.searchParams.get('fields')).toBe('id,name,mimeType,driveId');
    assertClean(r);
  });

  it('falls back to plain text when Markdown export is refused', async () => {
    google.status[`${DOC_ID} text/markdown`] = 400;
    const r = await read(link('Plan.gdoc', linkJson(DOC_ID)));
    expect(r).toMatchObject({ ok: true, mime: 'text/plain', text: 'Plan\n\nSynthetic document body.\n' });
  });

  it('exports Slides as plain text', async () => {
    const r = await read(link('Deck.gslides', linkJson(SLIDES_ID)));
    expect(r).toEqual({ ok: true, text: 'Slide 1\nSynthetic slide.\n', mime: 'text/plain', truncated: false });
  });

  it('exports every grid sheet of a Sheet as CSV through the Sheets API', async () => {
    const r = await read(link('Book.gsheet', linkJson(SHEET_ID)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mime).toBe('text/csv');
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('# Sheet: Summary\nname,value\nalpha,1\n"with, comma","say ""hi"""\n\n' + "# Sheet: Bob's data\nx\ny\n\n");
    expect(r.text).not.toContain('Chart 1');
    assertClean(r);
  });

  it('falls back to the first sheet, and says so, when the Sheets API refuses', async () => {
    google.sheetsApi = 'disabled';
    const r = await read(link('Book.gsheet', linkJson(SHEET_ID)));
    expect(r).toEqual({ ok: true, text: `${FIRST_SHEET_NOTE}a,b\n1,2\n`, mime: 'text/csv', truncated: false });
  });

  it('denies a Doc in another shared drive, without exporting it', async () => {
    const r = await read(link('Elsewhere.gdoc', linkJson(ELSEWHERE_ID)));
    expect(r).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(google.calls.some((c) => c.url.pathname.endsWith('/export'))).toBe(false);
  });

  it('denies a Doc in My Drive (no driveId), without exporting it', async () => {
    const r = await read(link('Mine.gdoc', linkJson(MYDRIVE_ID)));
    expect(r).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(google.calls.some((c) => c.url.pathname.endsWith('/export'))).toBe(false);
  });

  it('rejects a forged or missing doc_id without asking Google', async () => {
    for (const bad of ['../../etc/passwd', 'short', `${DOC_ID}/export`, `${DOC_ID}?x=1`, 'a'.repeat(201), 42, null, '']) {
      const r = await read(link('Forged.gdoc', linkJson('x', { doc_id: bad })));
      expect(r).toEqual({ ok: false, reason: 'the link file has no valid doc_id' });
    }
    const missing = await read(link('NoId.gdoc', { email: `alice@${DOMAIN}` }));
    expect(missing).toEqual({ ok: false, reason: 'the link file has no valid doc_id' });
    const notJson = await read(link('Junk.gdoc', 'not json'));
    expect(notJson).toEqual({ ok: false, reason: 'the link file is not a Google link' });
    const badKey = await read(link('Key.gdoc', linkJson(DOC_ID, { resource_key: 'a/b' })));
    expect(badKey).toEqual({ ok: false, reason: 'the link file has an invalid resource_key' });
    expect(google.calls).toEqual([]);
  });

  it('rejects a link file over 4 KB without asking Google', async () => {
    const r = await read(link('Big.gdoc', JSON.stringify(linkJson(DOC_ID, { pad: 'x'.repeat(5000) }))));
    expect(r).toEqual({ ok: false, reason: 'the link file is too large to be a Google link' });
    expect(google.calls).toEqual([]);
  });

  it('checks the mount itself: other accounts, other domains, My Drive, other drives and symlinks out are denied', async () => {
    const outside = [
      link('A.gdoc', linkJson(DOC_ID), join(root, 'GoogleDrive-bob@other.example', 'Shared drives', DRIVE_NAME)),
      link('B.gdoc', linkJson(DOC_ID), join(root, `GoogleDrive-alice@sub.${DOMAIN}`, 'Shared drives', DRIVE_NAME)),
      link('C.gdoc', linkJson(DOC_ID), join(root, `GoogleDrive-alice@${DOMAIN}`, 'My Drive')),
      link('D.gdoc', linkJson(DOC_ID), join(root, `GoogleDrive-alice@${DOMAIN}`, 'Shared drives', 'Another Drive')),
      link('E.gdoc', linkJson(DOC_ID), join(root, 'Dropbox')),
    ];
    // A symlink inside the team drive that points outside it.
    const target = link('F.gdoc', linkJson(DOC_ID), join(root, 'GoogleDrive-bob@other.example', 'Shared drives', DRIVE_NAME, 'x'));
    mkdirSync(teamDir(), { recursive: true });
    const sym = join(teamDir(), 'Sym.gdoc');
    symlinkSync(target, sym);
    // A .gdoc symlink pointing at a non-Google file inside the drive.
    const plain = link('notes.txt', linkJson(DOC_ID));
    const sym2 = join(teamDir(), 'Sym2.gdoc');
    symlinkSync(plain, sym2);
    for (const p of [...outside, sym]) expect(await read(p), p).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(await read(sym2)).toEqual({ ok: false, reason: 'not a Google file' });
    expect(await read('relative/Plan.gdoc')).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(await read(join(teamDir(), 'missing.gdoc'))).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(await read(link('Plan.docx', linkJson(DOC_ID)))).toEqual({ ok: false, reason: 'not a Google file' });
    expect(google.calls).toEqual([]);
  });

  it('denies a link file written for an account outside the domain', async () => {
    const r = await read(link('Plan.gdoc', linkJson(DOC_ID, { email: 'eve@other.example' })));
    expect(r).toEqual({ ok: false, reason: 'not in the team drive' });
  });

  it('refuses a drive boundary that is not well formed', async () => {
    const p = link('Plan.gdoc', linkJson(DOC_ID));
    expect(await read(p, { domain: 'Example.COM', shared_drive: DRIVE_NAME })).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(await read(p, { domain: DOMAIN, shared_drive: 'a/b' })).toEqual({ ok: false, reason: 'not in the team drive' });
  });

  it('a .gdoc whose Google type is not a Doc is not read', async () => {
    const r = await read(link('Mislabelled.gdoc', linkJson(SHEET_ID)));
    expect(r).toEqual({ ok: false, reason: 'not a Google file' });
  });

  it('without a Drive connection says so plainly, and asks Google nothing', async () => {
    keychain.items.clear();
    const r = await read(link('Plan.gdoc', linkJson(DOC_ID)));
    expect(r).toEqual({ ok: false, reason: NOT_CONNECTED });
    expect(google.calls).toEqual([]);
    const none = await readGoogleFile(link('Plan.gdoc', linkJson(DOC_ID)), DRIVE, { fetch: google.fetch as typeof fetch, relay, keychain: null, cloudStorageRoot: root });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toMatch(/only be read on macOS/);
  });

  it('a connected account outside the team domain is not used', async () => {
    keychain.items.clear();
    keychain.items.set('alice@other.example', REFRESH);
    const r = await read(link('Plan.gdoc', linkJson(DOC_ID)));
    expect(r).toEqual({ ok: false, reason: `the connected Google account is not in ${DOMAIN}: run /team-relay:drive connect` });
    expect(google.calls).toEqual([]);
  });

  it('refreshes the access token once, keeps it in memory until it expires, then refreshes again', async () => {
    const p = link('Plan.gdoc', linkJson(DOC_ID));
    expect((await read(p)).ok).toBe(true);
    expect((await read(p)).ok).toBe(true);
    expect(google.tokenCalls).toBe(1);
    now += 3600_000;
    expect((await read(p)).ok).toBe(true);
    expect(google.tokenCalls).toBe(2);
  });

  it('a 401 from Drive gets one fresh token and one retry', async () => {
    const p = link('Plan.gdoc', linkJson(DOC_ID));
    expect((await read(p)).ok).toBe(true);
    google.unauthorizedOnce = 1;
    const r = await read(p);
    expect(r.ok).toBe(true);
    expect(google.tokenCalls).toBe(2);
    assertClean(r);
  });

  it('a revoked connection asks the member to connect again, without Google\'s text', async () => {
    google.refreshStatus = 400;
    google.refreshError = 'invalid_grant';
    const r = await read(link('Plan.gdoc', linkJson(DOC_ID)));
    expect(r).toEqual({ ok: false, reason: 'the Google Drive connection has expired or was revoked: run /team-relay:drive connect' });
    assertClean(r);
  });

  it('a relay without the Drive client says Drive is not set up', async () => {
    const err = Object.assign(new Error('relay 404'), { status: 404, code: 'drive_not_configured' });
    const r = await readGoogleFile(link('Plan.gdoc', linkJson(DOC_ID)), DRIVE, {
      fetch: google.fetch as typeof fetch,
      relay: { driveClient: async () => Promise.reject(err) },
      keychain,
      cloudStorageRoot: root,
    });
    expect(r).toEqual({ ok: false, reason: 'Google Drive is not set up for this team (ask the relay admin)' });
  });

  it('Google refusals become a short reason with the status only', async () => {
    google.status[`meta ${DOC_ID}`] = 403;
    const r = await read(link('Plan.gdoc', linkJson(DOC_ID)));
    expect(r).toEqual({ ok: false, reason: 'Google refused (403)' });
    google.status[`meta ${DOC_ID}`] = 0;
    google.status[`${DOC_ID} text/markdown`] = 403;
    const r2 = await read(link('Plan.gdoc', linkJson(DOC_ID)));
    expect(r2).toEqual({ ok: false, reason: 'Google refused (403)' });
    assertClean([r, r2]);
  });

  it('a network failure is "Google did not answer"', async () => {
    const r = await readGoogleFile(link('Plan.gdoc', linkJson(DOC_ID)), DRIVE, {
      fetch: (async () => Promise.reject(new Error(`ECONNRESET ${REFRESH}`))) as typeof fetch,
      relay,
      keychain,
      cloudStorageRoot: root,
    });
    expect(r).toEqual({ ok: false, reason: 'Google did not answer' });
    assertClean(r);
  });

  it('caps the text at 200 KB, flags it, and never cuts a character in half', async () => {
    google.exports[`${DOC_ID} text/markdown`] = 'é'.repeat(MAX_TEXT_BYTES); // 2 bytes each: 400 KB
    const r = await read(link('Plan.gdoc', linkJson(DOC_ID)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(r.text).toBe('é'.repeat(MAX_TEXT_BYTES / 2));
    google.exports[`${DOC_ID} text/markdown`] = 'x'.repeat(MAX_TEXT_BYTES);
    expect(await read(link('Plan.gdoc', linkJson(DOC_ID)))).toMatchObject({ ok: true, truncated: false });
  });

  it('caps the sheets CSV at 200 KB too', async () => {
    google.sheets = [
      { title: 'Big', values: Array.from({ length: 3000 }, (_, i) => [`row ${i}`, 'x'.repeat(100)]) },
      { title: 'Never reached', values: [['z']] },
    ];
    const r = await read(link('Book.gsheet', linkJson(SHEET_ID)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(r.text).not.toContain('Never reached');
  });

  it('two shared drives with the team drive\'s name (across pages) is an error', async () => {
    google.drivesPages = [[{ id: TEAM_DRIVE_ID, name: DRIVE_NAME }], [{ id: '0ASECONDdrive', name: DRIVE_NAME }]];
    const r = await read(link('Plan.gdoc', linkJson(DOC_ID)));
    expect(r).toEqual({ ok: false, reason: "two or more shared drives have the team drive's name; cannot tell which one it is" });
    expect(google.calls.some((c) => c.url.pathname.startsWith('/drive/v3/files/'))).toBe(false);
  });

  it('a team drive the member cannot see is an error', async () => {
    google.drivesPages = [[{ id: OTHER_DRIVE_ID, name: 'Other' }], [{ id: '0AX', name: `${DRIVE_NAME} ` }]];
    const r = await read(link('Plan.gdoc', linkJson(DOC_ID)));
    expect(r).toEqual({ ok: false, reason: 'the team drive is not visible to the connected Google account' });
  });
});

describe('readGoogleFile in a picked folder (PICKERS-SPEC §6.2, ACC-014)', () => {
  const FOLDER = 'application/vnd.google-apps.folder';
  const DOCUMENT = 'application/vnd.google-apps.document';
  // The picked folder "Clients" (top level of the team drive), a subfolder of it, and a sibling.
  const CLIENTS_ID = '1ClientsFolderAbCdEfGhIjKlMnOpQrSt';
  const DEEP_ID = '1DeepFolderAbCdEfGhIjKlMnOpQrStUvW';
  const SIBLING_ID = '1SiblingFolderAbCdEfGhIjKlMnOpQrSt';
  const PLANTED_ID = '1PlantedDocAbCdEfGhIjKlMnOpQrStUvW';
  beforeEach(() => {
    google.files[CLIENTS_ID] = { mimeType: FOLDER, driveId: TEAM_DRIVE_ID, parents: [TEAM_DRIVE_ID] };
    google.files[DEEP_ID] = { mimeType: FOLDER, driveId: TEAM_DRIVE_ID, parents: [CLIENTS_ID] };
    google.files[SIBLING_ID] = { mimeType: FOLDER, driveId: TEAM_DRIVE_ID, parents: [TEAM_DRIVE_ID] };
    google.files[DOC_ID] = { mimeType: DOCUMENT, driveId: TEAM_DRIVE_ID, parents: [DEEP_ID] };
    // A Doc of the same shared drive outside the folder, reached through a link file planted inside it.
    google.files[PLANTED_ID] = { mimeType: DOCUMENT, driveId: TEAM_DRIVE_ID, parents: [SIBLING_ID] };
    google.exports[`${PLANTED_ID} text/markdown`] = '# Outside\n';
  });
  const area = (root = teamDir(), drive_root_id = TEAM_DRIVE_ID, folder_id = CLIENTS_ID) => ({ domain: DOMAIN, root, drive_root_id, folder_id });
  const readIn = (path: string, a: ReturnType<typeof area>) => readGoogleFile(path, a, { fetch: google.fetch as typeof fetch, relay, now: () => now, keychain, cloudStorageRoot: root });
  const listedDrives = () => google.calls.some((c) => c.url.pathname === '/drive/v3/drives');
  const exported = () => google.calls.some((c) => c.url.pathname.endsWith('/export'));
  /** The files.get calls, in order, as `id fields`. */
  const gets = () => google.calls.filter((c) => /^\/drive\/v3\/files\/[^/]+$/.test(c.url.pathname)).map((c) => `${decodeURIComponent(c.url.pathname.split('/').at(-1)!)} ${c.url.searchParams.get('fields')}`);

  it("a Doc in a subfolder of the picked folder is read: its ancestry reaches the folder, and drives are never listed by name", async () => {
    const p = link('Plan.gdoc', linkJson(DOC_ID), join(teamDir(), 'Deep'));
    const r = await readIn(p, area());
    expect(r).toEqual({ ok: true, text: '# Plan\n\nSynthetic document body.\n', mime: 'text/markdown', truncated: false });
    // The file, then its parent; the walk stops at the picked folder (never read itself).
    expect(gets()).toEqual([`${DOC_ID} id,name,mimeType,driveId,parents`, `${DEEP_ID} id,parents,driveId`]);
    expect(google.calls.filter((c) => /^\/drive\/v3\/files\//.test(c.url.pathname)).every((c) => c.url.searchParams.get('supportsAllDrives') === 'true')).toBe(true);
    expect(listedDrives()).toBe(false);
    assertClean(r);
    // A Doc directly in the folder needs no parent read at all.
    google.calls.length = 0;
    google.files[DOC_ID]!.parents = [CLIENTS_ID];
    expect((await readIn(p, area())).ok).toBe(true);
    expect(gets()).toEqual([`${DOC_ID} id,name,mimeType,driveId,parents`]);
  });

  it('a link file planted in the folder that points at a Doc elsewhere in the same drive is denied, before any export', async () => {
    const r = await readIn(link('Planted.gdoc', linkJson(PLANTED_ID)), area());
    expect(r).toEqual({ ok: false, reason: 'not in the picked Drive folder' });
    expect(exported()).toBe(false);
    // The walk went up to the drive root, which it does not read.
    expect(gets()).toEqual([`${PLANTED_ID} id,name,mimeType,driveId,parents`, `${SIBLING_ID} id,parents,driveId`]);
  });

  it('the walk is capped at 20 levels: a folder deeper than that is denied', async () => {
    // DOC_ID sits 25 folders below the picked folder.
    const chain = Array.from({ length: 25 }, (_, i) => `1ChainFolder${String(i).padStart(2, '0')}AbCdEfGhIjKlMnOp`);
    chain.forEach((id, i) => (google.files[id] = { mimeType: FOLDER, driveId: TEAM_DRIVE_ID, parents: [i === 0 ? CLIENTS_ID : chain[i - 1]!] }));
    google.files[DOC_ID]!.parents = [chain.at(-1)!];
    const r = await readIn(link('Plan.gdoc', linkJson(DOC_ID)), area());
    expect(r).toEqual({ ok: false, reason: 'not in the picked Drive folder' });
    expect(exported()).toBe(false);
    expect(gets().length).toBe(20);
    // At 19 folders below it (20 levels up to it), it is read.
    google.calls.length = 0;
    google.files[DOC_ID]!.parents = [chain[18]!];
    expect((await readIn(link('Plan.gdoc', linkJson(DOC_ID)), area())).ok).toBe(true);
  });

  it('a parent that cannot be read, or that is in another drive, or a file with no or several parents, is denied', async () => {
    const p = link('Plan.gdoc', linkJson(DOC_ID), join(teamDir(), 'Deep'));
    google.status[`meta ${DEEP_ID}`] = 404;
    expect(await readIn(p, area())).toEqual({ ok: false, reason: 'not in the picked Drive folder' });
    google.status[`meta ${DEEP_ID}`] = 403;
    expect(await readIn(p, area())).toEqual({ ok: false, reason: 'not in the picked Drive folder' });
    delete google.status[`meta ${DEEP_ID}`];
    google.files[DEEP_ID]!.driveId = OTHER_DRIVE_ID;
    expect(await readIn(p, area())).toEqual({ ok: false, reason: 'not in the picked Drive folder' });
    google.files[DEEP_ID]!.driveId = TEAM_DRIVE_ID;
    google.files[DEEP_ID]!.parents = [];
    expect(await readIn(p, area())).toEqual({ ok: false, reason: 'not in the picked Drive folder' });
    google.files[DEEP_ID]!.parents = [CLIENTS_ID];
    google.files[DOC_ID]!.parents = [DEEP_ID, SIBLING_ID];
    expect(await readIn(p, area())).toEqual({ ok: false, reason: 'not in the picked Drive folder' });
    google.files[DOC_ID]!.parents = ['../bad'];
    expect(await readIn(p, area())).toEqual({ ok: false, reason: 'not in the picked Drive folder' });
    delete google.files[DOC_ID]!.parents;
    expect(await readIn(p, area())).toEqual({ ok: false, reason: 'not in the picked Drive folder' });
    expect(exported()).toBe(false);
    // A network failure on a parent read is Google not answering (and nothing is exported either).
    google.files[DOC_ID]!.parents = [DEEP_ID];
    const failing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes(`/files/${DEEP_ID}`)) throw new TypeError('fetch failed');
      return google.fetch(input, init);
    }) as typeof fetch;
    expect(await readGoogleFile(p, area(), { fetch: failing, relay, now: () => now, keychain, cloudStorageRoot: root })).toEqual({ ok: false, reason: 'Google did not answer' });
    expect(exported()).toBe(false);
  });

  it("a whole-drive area keeps the driveId check only: one files.get, no parents asked for", async () => {
    const driveRoot = join(root, `GoogleDrive-alice@${DOMAIN}`, 'Shared drives', DRIVE_NAME);
    const whole = area(driveRoot, TEAM_DRIVE_ID, TEAM_DRIVE_ID);
    // Even the Doc outside "Clients" is in the drive, so it is read.
    const r = await readIn(link('Planted.gdoc', linkJson(PLANTED_ID), join(driveRoot, 'Other')), whole);
    expect(r).toEqual({ ok: true, text: '# Outside\n', mime: 'text/markdown', truncated: false });
    expect(gets()).toEqual([`${PLANTED_ID} id,name,mimeType,driveId`]);
    expect(listedDrives()).toBe(false);
    google.calls.length = 0;
    expect(await readIn(link('Elsewhere.gdoc', linkJson(ELSEWHERE_ID), driveRoot), whole)).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(exported()).toBe(false);
  });

  it("the file's driveId must equal the drive root's local id: another drive is denied before the walk", async () => {
    const p = link('Plan.gdoc', linkJson(DOC_ID), join(teamDir(), 'Deep'));
    expect(await readIn(p, area(teamDir(), OTHER_DRIVE_ID))).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(gets()).toEqual([`${DOC_ID} id,name,mimeType,driveId,parents`]);
    google.calls.length = 0;
    expect(await readIn(link('Elsewhere.gdoc', linkJson(ELSEWHERE_ID)), area())).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(exported()).toBe(false);
    expect(listedDrives()).toBe(false);
  });

  it('a link file outside the picked folder is denied without asking Google, even in the same shared drive', async () => {
    const driveRoot = join(root, `GoogleDrive-alice@${DOMAIN}`, 'Shared drives', DRIVE_NAME);
    const sibling = link('Plan.gdoc', linkJson(DOC_ID), join(driveRoot, 'Other'));
    const atRoot = link('Top.gdoc', linkJson(DOC_ID), driveRoot);
    mkdirSync(teamDir(), { recursive: true });
    // A symlink inside the folder that leads out of it.
    const hop = join(teamDir(), 'Hop.gdoc');
    symlinkSync(sibling, hop);
    // A prefix of the folder's name is not the folder.
    const prefix = link('Plan.gdoc', linkJson(DOC_ID), `${teamDir()}2`);
    for (const p of [sibling, atRoot, hop, prefix]) expect(await readIn(p, area()), p).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(google.calls).toEqual([]);
  });

  it("an area that is not inside a shared drive of an account in the domain is refused, and so is a malformed one", async () => {
    const other = join(root, 'GoogleDrive-alice@other.example', 'Shared drives', DRIVE_NAME, 'Clients');
    const p = link('Plan.gdoc', { ...linkJson(DOC_ID), email: 'alice@other.example' }, other);
    expect(await readIn(p, area(other))).toEqual({ ok: false, reason: 'not in the team drive' });
    const mine = join(root, `GoogleDrive-alice@${DOMAIN}`, 'My Drive', 'Clients');
    expect(await readIn(link('Plan.gdoc', linkJson(DOC_ID), mine), area(mine))).toEqual({ ok: false, reason: 'not in the team drive' });
    const inFolder = link('Plan.gdoc', linkJson(DOC_ID));
    expect(await readIn(inFolder, area('relative/Clients'))).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(await readIn(inFolder, area(teamDir(), 'no/id'))).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(await readIn(inFolder, area(teamDir(), TEAM_DRIVE_ID, 'no/id'))).toEqual({ ok: false, reason: 'not in the team drive' });
    const { folder_id: _f, ...noFolder } = area();
    expect(await readGoogleFile(inFolder, noFolder as ReturnType<typeof area>, { fetch: google.fetch as typeof fetch, relay, now: () => now, keychain, cloudStorageRoot: root })).toEqual({ ok: false, reason: 'not in the team drive' });
    expect(google.calls).toEqual([]);
  });
});

describe('csvField', () => {
  it('quotes only what needs quoting (RFC 4180)', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('say "x"')).toBe('"say ""x"""');
    expect(csvField(3)).toBe('3');
    expect(csvField(null)).toBe('');
  });
});

describe('macKeychain (with a fake /usr/bin/security)', () => {
  type Run = { args: string[]; stdin: string | undefined };
  function fakeSecurity() {
    const runs: Run[] = [];
    const store = new Map<string, string>();
    const exec = async (args: string[], stdin?: string) => {
      runs.push({ args, stdin });
      if (args[0] === '-i') {
        const m = /^add-generic-password -U -s "([^"]+)" -a "([^"]+)" -l "[^"]+" -w "([^"]+)"\n$/.exec(stdin ?? '');
        if (!m) return { code: 1, stdout: '' };
        store.set(m[2]!, m[3]!);
        return { code: 0, stdout: '' };
      }
      if (args[0] === 'find-generic-password') {
        const a = args.indexOf('-a');
        const acct = a >= 0 ? args[a + 1]! : store.keys().next().value;
        if (!acct || !store.has(acct)) return { code: 44, stdout: '' };
        if (args.includes('-w')) return { code: 0, stdout: `${store.get(acct)}\n` };
        return { code: 0, stdout: `keychain: "/x"\nattributes:\n    "acct"<blob>="${acct}"\n    "svce"<blob>="${KEYCHAIN_SERVICE}"\n` };
      }
      if (args[0] === 'delete-generic-password') {
        const first = store.keys().next().value;
        if (!first) return { code: 44, stdout: '' };
        store.delete(first);
        return { code: 0, stdout: '' };
      }
      return { code: 1, stdout: '' };
    };
    return { runs, store, exec };
  }

  it('writes the token on stdin, never as an argument, and reads it back', async () => {
    const f = fakeSecurity();
    const k = macKeychain(f.exec);
    await k.write(`alice@${DOMAIN}`, REFRESH);
    expect(await k.account()).toBe(`alice@${DOMAIN}`);
    expect(await k.read(`alice@${DOMAIN}`)).toBe(REFRESH);
    for (const r of f.runs) expect(r.args.join(' ')).not.toContain(REFRESH);
    expect(f.runs[0]!.args).toEqual(['-i']);
    expect(f.runs.every((r) => r.args.includes(KEYCHAIN_SERVICE) || r.args[0] === '-i')).toBe(true);
  });

  it('refuses a token or account that could break out of the quoted command', async () => {
    const k = macKeychain(fakeSecurity().exec);
    await expect(k.write(`alice@${DOMAIN}`, 'abc" -w "x')).rejects.toThrow(/unexpected form/);
    await expect(k.write('a"b@example.com', REFRESH)).rejects.toThrow(/invalid account/);
  });

  it('removes every item of the service; an empty Keychain has no account', async () => {
    const f = fakeSecurity();
    const k = macKeychain(f.exec);
    f.store.set(`a@${DOMAIN}`, REFRESH);
    f.store.set(`b@${DOMAIN}`, REFRESH);
    expect(await k.removeAll()).toBe(2);
    expect(await k.account()).toBeNull();
    expect(await k.read(`a@${DOMAIN}`)).toBeNull();
  });

  it('a write that the Keychain did not keep is an error', async () => {
    const f = fakeSecurity();
    const k = macKeychain(async (args, stdin) => (args[0] === '-i' ? { code: 0, stdout: '' } : f.exec(args, stdin)));
    await expect(k.write(`alice@${DOMAIN}`, REFRESH)).rejects.toThrow(/did not keep/);
  });
});
