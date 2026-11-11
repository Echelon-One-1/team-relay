// M10-SPEC §1 and PICKERS-SPEC §2.1, §3.2: a team's boundaries in the console. GET /api/boundaries reads them (any member);
// PUT /api/boundaries replaces them (owners) under every write rule the other changes follow:
// the method, Sec-Fetch-Site: same-origin, a JSON content type, no query but `team`, a body cap
// and a strict per-route body check (checkSetBoundaries) before anything reaches the relay. The
// team comes from `team` or X-Relay-Team, checked against the viewer's teams. Also: the viewer's
// address behind Google's load balancer (M10-SPEC §5), which adds one hop to X-Forwarded-For.

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
import { normaliseBoundaries } from '../src/boundaries-rule.js';
import type { Boundaries } from '../src/boundaries-types.js';
import { DEMO_BOUNDARIES, DemoAccount } from '../src/console-demo.js';
import { RelayClient } from '../src/relay-client.js';
import { PLACEHOLDERS, VECTORS } from './helpers/vectors.js';

const KEY = 'k'.repeat(43);
const NO_UI = join(tmpdir(), 'team-relay-no-ui-here');
const PUBLIC_HOST = 'team.example.com';
const SALT = 'a-salt-of-at-least-32-characters-0123';
const SAME_ORIGIN = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };

const DRIVE_ID = '0AExampleDriveId0PVA';
const FOLDER_ID = '1ExampleFolderIdxxxxxxxxxxxxxxxxx';
/** A document with no legacy drive: one any owner may PUT, stored or not. */
const GOOD: Boundaries = {
  topic: 'Example Co: our clients and their delivery, our products and tools.',
  github_orgs: ['Example-Org'],
  github_repos: [{ org: 'example-labs', repo: 'api', id: 123456 }],
  drive_folders: [
    { domain: 'example.com', drive_id: DRIVE_ID, folder_id: DRIVE_ID, folder_name: 'Example Team Drive', drive_name: 'Example Team Drive' },
    { domain: 'example.com', drive_id: DRIVE_ID, folder_id: FOLDER_ID, folder_name: 'Clients / 2026', drive_name: null },
  ],
  drives: [],
  member_folders: true,
};
const LEGACY = { domain: 'example.com', shared_drive: 'Example Team Drive' };
const REPO = GOOD.github_repos[0]!;
const FOLDER = GOOD.drive_folders[1]!;

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

describe('checkSetBoundaries (M10-SPEC §1, PICKERS-SPEC §2.1)', () => {
  it('accepts a full document and sends it on as the relay stores it: topic trimmed, duplicates and repositories of whole orgs dropped', () => {
    const out = checkSetBoundaries({
      version: 3,
      boundaries: {
        topic: '  Example Co: delivery.\nAnd tools.  ',
        github_orgs: ['Example-Org', 'example-org', 'other-org'],
        github_repos: [
          { org: 'example-labs', repo: 'API', id: 123456 },
          { org: 'Example-Labs', repo: 'api', id: null },
          { org: 'EXAMPLE-ORG', repo: 'covered-by-the-org', id: 7 },
          { org: 'example-labs', repo: 'web', id: null },
        ],
        drive_folders: [FOLDER, { ...FOLDER, folder_name: 'Same id, other name' }, GOOD.drive_folders[0]!],
        drives: [LEGACY, LEGACY],
        member_folders: false,
      },
    });
    expect(out).toEqual({
      version: 3,
      boundaries: {
        topic: 'Example Co: delivery.\nAnd tools.',
        github_orgs: ['Example-Org', 'other-org'],
        github_repos: [
          { org: 'example-labs', repo: 'API', id: 123456 },
          { org: 'example-labs', repo: 'web', id: null },
        ],
        drive_folders: [FOLDER, GOOD.drive_folders[0]],
        drives: [LEGACY],
        member_folders: false,
      },
    });
    // Empty lists are allowed (a team on Drive only, or on repositories only).
    const empty = { ...GOOD, github_orgs: [], github_repos: [], drive_folders: [], drives: [] };
    expect(checkSetBoundaries({ version: 0, boundaries: empty }).boundaries).toEqual(empty);
    // Pasted entries carry no id: a repository's id and a folder's drive id may be null.
    const pasted = { ...GOOD, github_repos: [{ ...REPO, id: null }], drive_folders: [{ ...FOLDER, drive_id: null }] };
    expect(checkSetBoundaries({ version: 0, boundaries: pasted }).boundaries).toEqual(pasted);
  });

  it('PICKERS-SPEC §3.2: a document of the M10 shape (no github_repos, no drive_folders) is refused, naming the missing field', () => {
    const { github_repos: _r, drive_folders: _f, ...m10 } = GOOD;
    expect(() => checkSetBoundaries({ version: 0, boundaries: m10 })).toThrow(/^github_repos must be a list$/);
    expect(() => checkSetBoundaries({ version: 0, boundaries: { ...m10, github_repos: [] } })).toThrow(/^drive_folders must be a list$/);
    for (const doc of VECTORS.m10_documents) expect(() => checkSetBoundaries({ version: 0, boundaries: doc })).toThrow(BodyError);
  });

  const bad: Array<[string, unknown]> = [
    ['not an object', []],
    ['null', null],
    ['an unknown top-level field', { version: 0, boundaries: GOOD, extra: 1 }],
    ['no version', { boundaries: GOOD }],
    ['a negative version', { version: -1, boundaries: GOOD }],
    ['a fractional version', { version: 1.5, boundaries: GOOD }],
    ['a string version', { version: '1', boundaries: GOOD }],
    ['an unsafe version', { version: 2 ** 53, boundaries: GOOD }],
    ['no boundaries', { version: 0 }],
    ['null boundaries', { version: 0, boundaries: null }],
    ['an unknown boundaries field', { version: 0, boundaries: { ...GOOD, extra: true } }],
    ['no topic', { version: 0, boundaries: { ...GOOD, topic: undefined } }],
    ['an empty topic', { version: 0, boundaries: { ...GOOD, topic: '   ' } }],
    ['a topic of 501 characters', { version: 0, boundaries: { ...GOOD, topic: 'x'.repeat(501) } }],
    ['a topic with a control character', { version: 0, boundaries: { ...GOOD, topic: 'a\u0007b' } }],
    ['a topic with a bidi override', { version: 0, boundaries: { ...GOOD, topic: 'a‮b' } }],
    ['github_orgs not a list', { version: 0, boundaries: { ...GOOD, github_orgs: 'example-org' } }],
    ['an org with a slash', { version: 0, boundaries: { ...GOOD, github_orgs: ['example/org'] } }],
    ['an org of 40 characters', { version: 0, boundaries: { ...GOOD, github_orgs: ['a'.repeat(40)] } }],
    ['an empty org', { version: 0, boundaries: { ...GOOD, github_orgs: [''] } }],
    ['eleven orgs', { version: 0, boundaries: { ...GOOD, github_orgs: Array.from({ length: 11 }, (_, i) => `org-${i}`) } }],
    ['drives not a list', { version: 0, boundaries: { ...GOOD, drives: {} } }],
    ['a drive with an unknown field', { version: 0, boundaries: { ...GOOD, drives: [{ ...GOOD.drives[0], id: 'x' }] } }],
    ['a drive without a domain', { version: 0, boundaries: { ...GOOD, drives: [{ shared_drive: 'Team Drive' }] } }],
    ['an upper-case domain', { version: 0, boundaries: { ...GOOD, drives: [{ domain: 'Example.com', shared_drive: 'D' }] } }],
    ['a domain with no dot', { version: 0, boundaries: { ...GOOD, drives: [{ domain: 'localhost', shared_drive: 'D' }] } }],
    ['a domain with a path', { version: 0, boundaries: { ...GOOD, drives: [{ domain: 'example.com/x', shared_drive: 'D' }] } }],
    ['a drive name with a slash', { version: 0, boundaries: { ...GOOD, drives: [{ domain: 'example.com', shared_drive: 'a/b' }] } }],
    ['a drive name of ..', { version: 0, boundaries: { ...GOOD, drives: [{ domain: 'example.com', shared_drive: '..' }] } }],
    ['a drive name with a newline', { version: 0, boundaries: { ...GOOD, drives: [{ domain: 'example.com', shared_drive: 'a\nb' }] } }],
    ['an empty drive name', { version: 0, boundaries: { ...GOOD, drives: [{ domain: 'example.com', shared_drive: ' ' }] } }],
    ['a drive name with surrounding space (refused, never trimmed)', { version: 0, boundaries: { ...GOOD, drives: [{ domain: 'example.com', shared_drive: ' Team Drive ' }] } }],
    ['a drive name with a trailing no-break space', { version: 0, boundaries: { ...GOOD, drives: [{ domain: 'example.com', shared_drive: 'D\u00a0' }] } }],
    ['a domain with surrounding space', { version: 0, boundaries: { ...GOOD, drives: [{ domain: ' example.com', shared_drive: 'D' }] } }],
    ['a boolean version', { version: true, boundaries: GOOD }],
    ['a version over 2^31-1', { version: 2 ** 31, boundaries: GOOD }],
    ['an org starting with -', { version: 0, boundaries: { ...GOOD, github_orgs: ['-example'] } }],
    ['a topic with a lone surrogate', { version: 0, boundaries: { ...GOOD, topic: 'a\ud800b' } }],
    ['an IP address as the domain', { version: 0, boundaries: { ...GOOD, drives: [{ domain: '10.0.0.1', shared_drive: 'D' }] } }],
    ['eleven orgs that are all the same', { version: 0, boundaries: { ...GOOD, github_orgs: Array.from({ length: 11 }, () => 'example-org') } }],
    [
      'eleven drives that are all the same',
      { version: 0, boundaries: { ...GOOD, drives: Array.from({ length: 11 }, () => ({ domain: 'example.com', shared_drive: 'D' })) } },
    ],
    ['a drive name of 101 characters', { version: 0, boundaries: { ...GOOD, drives: [{ domain: 'example.com', shared_drive: 'd'.repeat(101) }] } }],
    [
      'eleven drives',
      { version: 0, boundaries: { ...GOOD, drives: Array.from({ length: 11 }, (_, i) => ({ domain: 'example.com', shared_drive: `Drive ${i}` })) } },
    ],
    ['member_folders not a boolean', { version: 0, boundaries: { ...GOOD, member_folders: 'yes' } }],
    ['no member_folders', { version: 0, boundaries: { ...GOOD, member_folders: undefined } }],
    ['no github_repos', { version: 0, boundaries: { ...GOOD, github_repos: undefined } }],
    ['no drive_folders', { version: 0, boundaries: { ...GOOD, drive_folders: undefined } }],
    ['a repository with an unknown field', { version: 0, boundaries: { ...GOOD, github_repos: [{ ...REPO, url: 'x' }] } }],
    ['a repository without an id', { version: 0, boundaries: { ...GOOD, github_repos: [{ org: 'a', repo: 'b' }] } }],
    ['a repository id as a string', { version: 0, boundaries: { ...GOOD, github_repos: [{ ...REPO, id: '1' }] } }],
    ['a repository id of 0', { version: 0, boundaries: { ...GOOD, github_repos: [{ ...REPO, id: 0 }] } }],
    ['a repository id over 2^53-1', { version: 0, boundaries: { ...GOOD, github_repos: [{ ...REPO, id: 2 ** 53 }] } }],
    ['a repository name of dots', { version: 0, boundaries: { ...GOOD, github_repos: [{ ...REPO, repo: '..' }] } }],
    ['a repository name with a slash', { version: 0, boundaries: { ...GOOD, github_repos: [{ ...REPO, repo: 'a/b' }] } }],
    ['a repository of a bad org', { version: 0, boundaries: { ...GOOD, github_repos: [{ ...REPO, org: '-x' }] } }],
    ['101 repositories', { version: 0, boundaries: { ...GOOD, github_repos: Array.from({ length: 101 }, (_, i) => ({ org: 'example-labs', repo: `r${i}`, id: i + 1 })) } }],
    ['a folder with an unknown field', { version: 0, boundaries: { ...GOOD, drive_folders: [{ ...FOLDER, path: '/x' }] } }],
    ['a folder without drive_name', { version: 0, boundaries: { ...GOOD, drive_folders: [{ domain: 'example.com', drive_id: null, folder_id: FOLDER_ID, folder_name: 'C' }] } }],
    ['a folder id too short', { version: 0, boundaries: { ...GOOD, drive_folders: [{ ...FOLDER, folder_id: 'short' }] } }],
    ['a folder id with a slash', { version: 0, boundaries: { ...GOOD, drive_folders: [{ ...FOLDER, folder_id: `${FOLDER_ID}/x` }] } }],
    ['a drive id that is empty', { version: 0, boundaries: { ...GOOD, drive_folders: [{ ...FOLDER, drive_id: '' }] } }],
    ['a folder name with a newline', { version: 0, boundaries: { ...GOOD, drive_folders: [{ ...FOLDER, folder_name: 'a\nb' }] } }],
    ['a folder name with trailing space', { version: 0, boundaries: { ...GOOD, drive_folders: [{ ...FOLDER, folder_name: 'Clients ' }] } }],
    ['a folder name of 256 characters', { version: 0, boundaries: { ...GOOD, drive_folders: [{ ...FOLDER, folder_name: 'f'.repeat(256) }] } }],
    ['a picked drive name of 101 characters', { version: 0, boundaries: { ...GOOD, drive_folders: [{ ...FOLDER, drive_name: 'd'.repeat(101) }] } }],
    ['an upper-case folder domain', { version: 0, boundaries: { ...GOOD, drive_folders: [{ ...FOLDER, domain: 'Example.com' }] } }],
    ['21 folders', { version: 0, boundaries: { ...GOOD, drive_folders: Array.from({ length: 21 }, () => FOLDER) } }],
  ];
  it.each(bad)('refuses %s', (_why, raw) => {
    const body = JSON.parse(JSON.stringify(raw ?? null)) as unknown;
    expect(() => checkSetBoundaries(body)).toThrow(BodyError);
  });

  it('accepts the largest version, 2^31-1', () => {
    expect(checkSetBoundaries({ version: 2 ** 31 - 1, boundaries: GOOD }).version).toBe(2 ** 31 - 1);
  });

  it('counts names in characters, not bytes (a folder name of 255 characters outside the BMP passes)', () => {
    const name = '\u{1F4C1}'.repeat(255);
    expect(checkSetBoundaries({ version: 0, boundaries: { ...GOOD, drive_folders: [{ ...FOLDER, folder_name: name }] } }).boundaries.drive_folders[0]!.folder_name).toBe(name);
  });

  it('counts the topic in characters, not bytes (500 non-ASCII characters pass)', () => {
    expect(checkSetBoundaries({ version: 0, boundaries: { ...GOOD, topic: 'é'.repeat(500) } }).boundaries.topic).toHaveLength(500);
    expect(checkSetBoundaries({ version: 0, boundaries: { ...GOOD, topic: '😀'.repeat(500) } }).boundaries.topic).toHaveLength(1000);
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

  it('GET: the demo team has boundaries; a team never set reads version 0 and null', async () => {
    const r = await local('/api/boundaries');
    expect(r.status).toBe(200);
    const b = r.json();
    expect(b.team).toBe('demo');
    expect(b.version).toBeGreaterThanOrEqual(1);
    expect(b.boundaries).toMatchObject({
      github_orgs: expect.any(Array),
      github_repos: expect.any(Array),
      drive_folders: expect.any(Array),
      drives: expect.any(Array),
      member_folders: expect.any(Boolean),
    });
    expect(b.boundaries).toEqual(DEMO_BOUNDARIES);
    expect(Object.keys(b.since).sort()).toEqual(['drive_folders', 'drives', 'github_orgs', 'github_repos', 'member_folders']);
    expect(typeof b.boundaries.topic).toBe('string');
    const research = await local('/api/boundaries?team=research');
    expect(research.json()).toEqual({ team: 'research', version: 0, boundaries: null, since: null, updated_at: null, updated_by: null });
    expect((await local('/api/boundaries', { headers: { 'X-Relay-Team': 'research' } })).json()).toMatchObject({ team: 'research', version: 0 });
    // A team the viewer is not on, and an unknown query parameter.
    expect((await local('/api/boundaries?team=ops')).status).toBe(403);
    expect((await local('/api/boundaries?x=1')).status).toBe(400);
  });

  it('PUT: an owner sets them at the current version; the answer carries version + 1', async () => {
    const r = await put('/api/boundaries?team=research', { version: 0, boundaries: GOOD });
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ team: 'research', version: 1, boundaries: GOOD, updated_by: 'alice' });
    expect((await local('/api/boundaries?team=research')).json()).toMatchObject({ version: 1, boundaries: GOOD });
    // A second change from the same (now stale) version is a conflict, not a silent overwrite.
    const stale = await put('/api/boundaries?team=research', { version: 0, boundaries: { ...GOOD, member_folders: false } });
    expect(stale.status).toBe(502);
    expect(stale.json()).toMatchObject({ error: 'relay_refused', relay_status: 409, relay_error: 'version_conflict' });
    expect((await local('/api/boundaries?team=research')).json()).toMatchObject({ version: 1, boundaries: { member_folders: true } });
  });

  it('PUT: legacy drives matched by name can be kept (with their since) or removed, never added (400 legacy_drive)', async () => {
    const read = (await local('/api/boundaries')).json();
    const kept = DEMO_BOUNDARIES.drives[0]!;
    const keep = await put('/api/boundaries', { version: read.version, boundaries: { ...DEMO_BOUNDARIES, topic: 'Example Co: everything.' } });
    expect(keep.status).toBe(200);
    expect(keep.json().boundaries.drives).toEqual([kept]);
    expect(keep.json().since.drives).toEqual(read.since.drives);
    expect(keep.json().since.github_repos).toEqual(read.since.github_repos);
    // A new name, or the kept one under another domain: refused, and nothing changes.
    for (const drives of [[kept, LEGACY], [{ ...kept, domain: 'example.org' }]]) {
      const add = await put('/api/boundaries', { version: keep.json().version, boundaries: { ...DEMO_BOUNDARIES, drives } });
      expect(add.status).toBe(502);
      expect(add.json()).toMatchObject({ error: 'relay_refused', relay_status: 400, relay_error: 'legacy_drive' });
    }
    // A team that never had any: none can be added.
    const fresh = await put('/api/boundaries?team=research', { version: 0, boundaries: { ...GOOD, drives: [LEGACY] } });
    expect(fresh.json()).toMatchObject({ relay_status: 400, relay_error: 'legacy_drive' });
    // Removing it works; adding it back afterwards does not.
    const removed = await put('/api/boundaries', { version: keep.json().version, boundaries: { ...DEMO_BOUNDARIES, drives: [] } });
    expect(removed.status).toBe(200);
    expect(removed.json().boundaries.drives).toEqual([]);
    const back = await put('/api/boundaries', { version: removed.json().version, boundaries: DEMO_BOUNDARIES });
    expect(back.json()).toMatchObject({ relay_status: 400, relay_error: 'legacy_drive' });
  });

  it('PUT: the demo relay stores the document as the relay does, with since by PICKERS-SPEC §2.3', async () => {
    const read = (await local('/api/boundaries')).json();
    // The whole org narrowed to one of its repositories keeps the org's since (rule 2); a new
    // folder of a whole drive keeps the drive's since (rule 3); a brand-new repository is new.
    const next = {
      ...DEMO_BOUNDARIES,
      github_orgs: [],
      github_repos: [...DEMO_BOUNDARIES.github_repos, { org: 'example-org', repo: 'payments', id: 100102 }, { org: 'example-tools', repo: 'cli', id: null }],
      drive_folders: [...DEMO_BOUNDARIES.drive_folders, { domain: 'example.com', drive_id: DEMO_BOUNDARIES.drive_folders[0]!.drive_id, folder_id: FOLDER_ID.replace('1', '2'), folder_name: 'Runbooks', drive_name: null }],
    };
    const r = await put('/api/boundaries', { version: read.version, boundaries: next });
    expect(r.status).toBe(200);
    const v = r.json().version;
    expect(v).toBe(read.version + 1);
    expect(r.json().since.github_repos).toEqual({ 'example-labs/api': read.since.github_repos['example-labs/api'], 'example-org/payments': read.since.github_orgs['example-org'], 'example-tools/cli': v });
    expect(r.json().since.drive_folders[FOLDER_ID.replace('1', '2')]).toBe(read.since.drive_folders[DEMO_BOUNDARIES.drive_folders[0]!.folder_id]);
    expect(r.json().boundaries).toEqual(normaliseBoundaries(next));
  });

  it('PUT: a member (not an owner) is refused as the relay refuses (403)', async () => {
    // alice joins ops (olga owns it) as a member.
    expect((await local('/api/invitations/ops', { method: 'POST', headers: SAME_ORIGIN, body: { accept: true } })).status).toBe(200);
    const read = await local('/api/boundaries?team=ops');
    expect(read.status).toBe(200);
    expect(read.json().boundaries).not.toBeNull();
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
    const huge = await put('/api/boundaries', JSON.stringify({ version: 0, boundaries: { ...GOOD, topic: 'x'.repeat(BOUNDARIES_BODY_LIMIT) } }));
    expect(huge.status).toBe(413);
    // A team the viewer is not on: not_on_team, and nothing changed.
    const other = await put('/api/boundaries?team=ops', body);
    expect(other.status).toBe(403);
    expect(other.json()).toMatchObject({ error: 'not_on_team', team: 'ops' });
  });

  it('the cap fits the largest valid document, every character that is not ASCII escaped', () => {
    const wide = '\u{1F600}';
    const domain = (i: number) => `${'d'.repeat(63)}.${'e'.repeat(63)}.${'f'.repeat(63)}.${'g'.repeat(48)}.example${i}.com`;
    const widest = {
      version: 2 ** 31 - 1,
      boundaries: {
        topic: wide.repeat(500),
        github_orgs: Array.from({ length: 10 }, (_, i) => `${'o'.repeat(37)}-${i}`),
        github_repos: Array.from({ length: 100 }, (_, i) => ({ org: `${'p'.repeat(35)}-${String(i).padStart(3, '0')}`, repo: `${'r'.repeat(97)}${String(i).padStart(3, '0')}`, id: Number.MAX_SAFE_INTEGER })),
        drive_folders: Array.from({ length: 20 }, (_, i) => ({
          domain: domain(i % 10),
          drive_id: `${'x'.repeat(197)}${String(i).padStart(3, '0')}`,
          folder_id: `${'y'.repeat(197)}${String(i).padStart(3, '0')}`,
          folder_name: wide.repeat(255),
          drive_name: wide.repeat(100),
        })),
        drives: Array.from({ length: 10 }, (_, i) => ({ domain: domain(i), shared_drive: `${wide.repeat(99)}${i}` })),
        member_folders: true,
      },
    };
    expect(domain(9).length).toBe(253);
    // Escaped as a browser's JSON.stringify would not, every non-ASCII character as \\uXXXX.
    const text = JSON.stringify(widest).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    expect(() => checkSetBoundaries(JSON.parse(text))).not.toThrow();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(BOUNDARIES_BODY_LIMIT);
    // PICKERS-SPEC §3.2's 64 KiB would refuse it, escaped or not.
    expect(Buffer.byteLength(JSON.stringify(widest))).toBeGreaterThan(64 * 1024);
  });

  it('a body over the cap is 413 and never reaches the relay', async () => {
    const over = JSON.stringify({ version: 0, boundaries: { ...GOOD, topic: 'x'.repeat(BOUNDARIES_BODY_LIMIT) } });
    const before = (await local('/api/boundaries')).json().version;
    const r = await put('/api/boundaries', over);
    expect(r.status).toBe(413);
    expect(r.json()).toEqual({ error: 'too_large', detail: `at most ${BOUNDARIES_BODY_LIMIT} bytes` });
    expect((await local('/api/boundaries')).json().version).toBe(before);
  });
});

// M10-SPEC §7.5: one rule. The relay, this server and the console UI accept exactly what
// schema/boundaries-vectors.json says.
describe('checkSetBoundaries follows schema/boundaries-vectors.json (M10-SPEC §7.5)', () => {
  const vectors = VECTORS;
  const invalid = vectors.invalid.map((v) => [v.why, v.boundaries] as const);

  it('expands every placeholder it names', () => {
    expect(Object.keys(vectors.placeholders).sort()).toEqual(Object.keys(PLACEHOLDERS).sort());
    expect(JSON.stringify(vectors)).not.toMatch(new RegExp(`"(${Object.keys(PLACEHOLDERS).join('|')})"(?!:)`));
    expect(invalid.some(([, b]) => b.topic === 'a'.repeat(501))).toBe(true);
    expect(PLACEHOLDERS.DOMAIN_253!.length).toBe(253);
    expect(PLACEHOLDERS.DOMAIN_254!.length).toBe(254);
  });

  it.each(vectors.valid.map((b, i) => [i, b] as const))('accepts valid document %i', (_i, b) => {
    expect(() => checkSetBoundaries({ version: 0, boundaries: b })).not.toThrow();
  });

  it.each(invalid)('refuses: %s', (_why, b) => {
    expect(() => checkSetBoundaries({ version: 0, boundaries: b })).toThrow(BodyError);
  });

  // PICKERS-SPEC §3: a refusal names the field at fault and never the value.
  const leaves = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [];
  const FIELD_NAMES = ['topic', 'github_orgs', 'github_repos', 'drive_folders', 'drives', 'member_folders'];
  it.each(vectors.invalid.map((v) => [v.why, v.field, v.boundaries] as const))('names the field and never the value: %s', (_why, field, b) => {
    let message = '';
    try {
      checkSetBoundaries({ version: 0, boundaries: b });
    } catch (err) {
      expect(err).toBeInstanceOf(BodyError);
      message = (err as Error).message;
    }
    if (field === null) expect(message).toMatch(/^unknown field /);
    else expect(message.startsWith(`${field} must `) || message.startsWith(`${field}: `), message).toBe(true);
    for (const s of leaves(b)) {
      if (s.length >= 4 && !FIELD_NAMES.includes(s)) expect(message, s).not.toContain(s);
    }
  });

  it.each(vectors.normalised.map((v) => [v.why, v.boundaries, v.expect] as const))('sends on what the relay stores: %s', (_why, b, expected) => {
    expect(checkSetBoundaries({ version: 0, boundaries: b }).boundaries).toEqual(expected);
  });

  it.each(vectors.m10_documents.map((d, i) => [i, d] as const))('refuses M10 document %i as a PUT body', (_i, d) => {
    expect(() => checkSetBoundaries({ version: 0, boundaries: d })).toThrow(BodyError);
  });

  it.each(vectors.versions.valid.map((v) => [JSON.stringify(v), v] as const))('accepts version %s', (_s, v) => {
    expect(checkSetBoundaries({ version: v, boundaries: vectors.valid[0] }).version).toBe(v);
  });

  it.each(vectors.versions.invalid.map((v) => [JSON.stringify(v), v] as const))('refuses version %s', (_s, v) => {
    expect(() => checkSetBoundaries({ version: v, boundaries: vectors.valid[0] })).toThrow(BodyError);
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
      body: { version: 0, boundaries: { ...GOOD, topic: `  ${GOOD.topic}  `, github_orgs: ['Example-Org', 'EXAMPLE-ORG'] } },
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
