// /team-relay:setup's page routes (/api/local/*, local-setup.ts), served by the console server on
// the member's own Mac (setup-page.ts). Every route has the console's gate (the Host, the
// per-launch key, Sec-Fetch-Site) and is 404 hosted; a change is JSON of at most 4 KiB with only
// its own fields. One list of folders (every member's own): added only from the Mac's chooser (a
// fake here), checked by the folder rules, de-duplicated, at most 20, stored mode 600. Remove only
// removes. Background answering is the same LaunchAgent `setup-cli daemon install` writes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleServer, relayBackend } from '../src/console-app.js';
import type { Exec } from '../src/daemon-launch.js';
import { CHOOSER_PROMPT, createLocalSetup } from '../src/local-setup.js';
import { pinnedNodePath, pinnedNodeVersion } from '../src/locate.js';
import { MAX_FOLDERS, memberFoldersPath, readTeamSettings, withTeam, writeMemberSettings } from '../src/member-folders.js';
import { RelayClient, staticTokenProvider } from '../src/relay-client.js';
import { runSetup } from '../src/setup-cli.js';
import { SetupPages, type Schedule } from '../src/setup-page.js';
import { BACKGROUND_MAC_ONLY, BACKGROUND_NO_CLAUDE, BACKGROUND_NO_NODE, backgroundAvailability, type ChooseResult } from '../src/setup-steps.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';

const NO_UI = join(tmpdir(), 'team-relay-no-such-console');

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any };
type ReqOpts = { method?: string; key?: string | null; headers?: Record<string, string>; body?: string; host?: string };

function req(port: number, path: string, o: ReqOpts = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: o.host ?? `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    if (o.key) headers['X-Console-Key'] = o.key;
    const r = httpRequest({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

let relay: FakeRelay;
let tmp: string;
let home: string;
let xdg: string;
let env: NodeJS.ProcessEnv;
let pages: SetupPages;
let port: number;
let key: string;
let scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
let chooserAnswers: Array<ChooseResult | Promise<ChooseResult>>;
let prompts: string[];
let launchctl: string[][];

const schedule: Schedule = (fn, ms) => {
  const s = { fn, ms, cancelled: false };
  scheduled.push(s);
  return () => {
    s.cancelled = true;
  };
};
// launchctl: bootout says not loaded, print says gone (113), bootstrap works.
const exec: Exec = async (_file, args) => (launchctl.push(args), { code: args[0] === 'bootout' ? 3 : args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' });

/** A key's own write, as the page sends it. */
const write = (method: string, body: unknown, extra: Record<string, string> = {}): ReqOpts => ({
  method,
  key,
  headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const choose = () => req(port, '/api/local/folders/choose', write('POST', {}));
const stored = () => readTeamSettings(memberFoldersPath(env), env, 'demo').extra_folders;
const store = (folders: string[]) => writeMemberSettings(memberFoldersPath(env), withTeam({ teams: {} }, 'demo', { repo_roots: [], extra_folders: folders, accepted: null }), env);
const folder = (...parts: string[]) => {
  const p = join(home, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

beforeEach(async () => {
  relay = await new FakeRelay().start();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tr-local-setup-')));
  home = join(tmp, 'home');
  xdg = join(tmp, 'xdg');
  mkdirSync(home);
  mkdirSync(xdg, { mode: 0o700 });
  env = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: xdg };
  scheduled = [];
  chooserAnswers = [];
  prompts = [];
  launchctl = [];
  const urls: string[] = [];
  pages = new SetupPages({
    env,
    log: () => {},
    platform: 'darwin',
    staticDir: NO_UI,
    open: (u) => void urls.push(u),
    schedule,
    exec,
    sleep: async () => {},
    uid: 501,
    node: process.execPath,
    localDeps: () => ({
      chooser: async (prompt: string) => {
        prompts.push(prompt);
        return (await chooserAnswers.shift()) ?? { kind: 'cancelled' };
      },
    }),
  });
  const client = new RelayClient({ url: relay.url, team: 'demo', token: staticTokenProvider(TOKEN_OF.bob!), attempts: 1 });
  const { url } = await pages.open({ client, member: 'bob', team: 'demo', email: 'bob@example.com' });
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/join#k=([A-Za-z0-9_-]{43})$/.exec(url)!;
  port = Number(m[1]);
  key = m[2]!;
});
afterEach(async () => {
  await pages.stop();
  await relay.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const ROUTES: Array<[string, string, unknown]> = [
  ['GET', '/api/local/setup', undefined],
  ['POST', '/api/local/folders/choose', {}],
  ['POST', '/api/local/folders/remove', { path: '~/code' }],
  ['PUT', '/api/local/background', { on: false }],
  ['POST', '/api/local/done', {}],
];

describe('ACC-2: the gate on every /api/local route', () => {
  it('missing key 401, wrong key 403, another Host 403, a cross-site request 403', async () => {
    for (const [method, path, body] of ROUTES) {
      const o = write(method, body);
      expect((await req(port, path, { ...o, key: null })).status, `${method} ${path} no key`).toBe(401);
      expect((await req(port, path, { ...o, key: 'x'.repeat(43) })).status, `${method} ${path} wrong key`).toBe(403);
      expect((await req(port, path, { ...o, host: `evil.example:${port}` })).status, `${method} ${path} host`).toBe(403);
      expect((await req(port, path, { ...o, headers: { ...o.headers, 'Sec-Fetch-Site': 'cross-site' } })).status, `${method} ${path} cross-site`).toBe(403);
    }
    expect(prompts).toEqual([]);
    expect(launchctl).toEqual([]);
    expect(scheduled.some((s) => s.ms === 3000)).toBe(false);
  });

  it('a change needs Sec-Fetch-Site: same-origin and JSON; one method each; no query', async () => {
    for (const [method, path, body] of ROUTES.slice(1)) {
      const o = write(method, body);
      const { 'Sec-Fetch-Site': _drop, ...noSite } = o.headers!;
      expect((await req(port, path, { ...o, headers: noSite })).status, `${path} no Sec-Fetch-Site`).toBe(403);
      expect((await req(port, path, { ...o, headers: { ...o.headers, 'Sec-Fetch-Site': 'none' } })).status, `${path} none`).toBe(403);
      expect((await req(port, path, { ...o, headers: { ...o.headers, 'Content-Type': 'text/plain' } })).status, `${path} text/plain`).toBe(415);
      expect((await req(port, `${path}?x=1`, o)).status, `${path} query`).toBe(400);
      const wrong = await req(port, path, { ...o, method: method === 'PUT' ? 'POST' : 'PUT' });
      expect(wrong.status, `${path} method`).toBe(405);
      expect(wrong.headers.allow).toBe(method);
    }
    const get = await req(port, '/api/local/setup', write('POST', {}));
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('GET');
    expect((await req(port, '/api/local/setup?team=demo', { key })).status).toBe(400);
    for (const path of ['/api/local', '/api/local/', '/api/local/folders', '/api/local/folders/add', '/api/local/drive/connect', '/api/local/constructor', '/api/local/setup/']) {
      expect((await req(port, path, { key })).status, path).toBe(404);
    }
    // No route adds a folder it is given.
    expect((await req(port, '/api/local/folders/add', write('POST', { path: folder('code') }))).status).toBe(404);
    expect(existsSync(memberFoldersPath(env))).toBe(false);
    expect(prompts).toEqual([]);
  });

  it('400 on unknown fields (a path to choose included), a body that is not JSON or not an object; 413 past 4 KiB', async () => {
    for (const [method, path, body] of ROUTES.slice(1)) {
      const extra = await req(port, path, write(method, { ...(body as object), extra: 1 }));
      expect(extra.status, `${path} unknown field`).toBe(400);
      expect(extra.json()).toMatchObject({ error: 'bad_request', detail: 'unknown field "extra"' });
      expect((await req(port, path, { ...write(method, undefined), body: '{nope' })).status, `${path} bad JSON`).toBe(400);
      expect((await req(port, path, { ...write(method, undefined), body: '[1]' })).status, `${path} array`).toBe(400);
      expect((await req(port, path, { ...write(method, undefined), body: `{"path":"${'a'.repeat(4100)}"}` })).status, `${path} too large`).toBe(413);
    }
    expect((await req(port, '/api/local/folders/choose', write('POST', { path: folder('code') }))).status).toBe(400);
    expect((await req(port, '/api/local/background', write('PUT', { on: 'yes' }))).status).toBe(400);
    expect((await req(port, '/api/local/folders/remove', write('POST', { path: 3 }))).status).toBe(400);
    expect(prompts).toEqual([]);
    expect(launchctl).toEqual([]);
  });

  it('is 404 on a console server without the setup routes, and hosted', async () => {
    const client = new RelayClient({ url: relay.url, team: 'demo', token: staticTokenProvider(TOKEN_OF.bob!), attempts: 1 });
    const local = createLocalSetup({
      env,
      platform: 'darwin',
      signedIn: { member: 'bob', team: 'demo', email: null },
      chooser: async () => ((prompts.push('hosted'), { kind: 'cancelled' })),
      background: { availability: () => ({ available: true }), installed: () => false, install: async () => void prompts.push('install'), uninstall: async () => false },
      onDone: () => prompts.push('done'),
    });
    const bare = createConsoleServer({ backend: relayBackend(client), key, staticDir: NO_UI });
    const PUBLIC = 'console.example.com';
    const hosted = createConsoleServer({
      backend: relayBackend(client),
      staticDir: NO_UI,
      hosted: { publicHost: PUBLIC, verify: async () => ({ email: 'bob@example.com' }), ipHashSalt: 's'.repeat(40) },
      local,
    });
    const bp = await bare.listen(0);
    const hp = await hosted.listen(0);
    try {
      for (const [method, path, body] of ROUTES) {
        expect((await req(bp, path, write(method, body))).status, `bare ${path}`).toBe(404);
        expect((await req(hp, path, { ...write(method, body), key: null, host: PUBLIC })).status, `hosted ${path}`).toBe(404);
      }
    } finally {
      await bare.close();
      await hosted.close();
    }
    expect(prompts).toEqual([]);
  });
});

describe('GET /api/local/setup', () => {
  it('says who is signed in, the folders (~/ for home), the chooser and the background answerer', async () => {
    store([folder('code', 'example-org')]);
    const r = await req(port, '/api/local/setup', { key });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toEqual({
      signed_in: { member: 'bob', team: 'demo', email: 'bob@example.com' },
      folders: ['~/code/example-org'],
      chooser: true,
      background: { installed: false, available: false, reason: BACKGROUND_NO_CLAUDE },
      limits: { max_folders: 20 },
    });
  });

  it('background answering is available on a Mac where Claude Code is found (the desktop app\'s own counts); else why not', async () => {
    const exe = join(home, 'Library', 'Application Support', 'Claude', 'claude-code', '2.1.9', 'abc', 'claude.app', 'Contents', 'MacOS', 'claude');
    mkdirSync(join(exe, '..'), { recursive: true });
    writeFileSync(exe, '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    writeFileSync(join(home, 'Library', 'Application Support', 'Claude', 'claude-code', '2.1.9', 'abc', '.verified'), 'x');
    expect((await req(port, '/api/local/setup', { key })).json().background).toEqual({ installed: false, available: true });
    expect(backgroundAvailability('linux', env)).toEqual({ available: false, reason: BACKGROUND_MAC_ONLY });
    expect(backgroundAvailability('darwin', env)).toEqual({ available: true });
    expect(backgroundAvailability('darwin', env, () => '/x/claude', () => false)).toEqual({ available: false, reason: BACKGROUND_NO_NODE });
  });
});

describe('ACC-3: choosing folders', () => {
  it('validates each chosen folder (home, /, ~/Library, ~/.ssh, a link to home: refused with why), de-duplicates and stores mode 600', async () => {
    const code = folder('code', 'example-org');
    const other = folder('work', 'other');
    const lib = folder('Library', 'Stuff');
    const ssh = folder('.ssh', 'keys');
    const link = join(tmp, 'home-link');
    symlinkSync(home, link);
    chooserAnswers.push({ kind: 'chosen', paths: [code, home, '/', lib, ssh, link, other, code] });
    const r = await choose();
    expect(r.status).toBe(200);
    const out = r.json();
    expect(out.cancelled).toBe(false);
    expect(out.added).toEqual(['~/code/example-org', '~/work/other']);
    expect(out.refused).toEqual([
      { path: '~', reason: expect.stringMatching(/home directory/) },
      { path: '/', reason: 'it is the root directory' },
      { path: '~/Library/Stuff', reason: 'it is inside ~/Library' },
      { path: '~/.ssh/keys', reason: expect.stringMatching(/\.ssh/) },
      { path: link, reason: 'it is your home directory' },
      { path: '~/code/example-org', reason: 'it is already in the list' },
    ]);
    expect(out.folders).toEqual(['~/code/example-org', '~/work/other']);
    expect(stored()).toEqual([code, other]);
    const file = memberFoldersPath(env);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    // Written by rename: no temporary file is left behind.
    expect(readdirSync(join(xdg, 'team-relay')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(prompts).toEqual([CHOOSER_PROMPT]);
    // Choosing again adds to the list; one already there is said so.
    const third = folder('work', 'third');
    chooserAnswers.push({ kind: 'chosen', paths: [other, third] });
    const again = (await choose()).json();
    expect(again.added).toEqual(['~/work/third']);
    expect(again.refused).toEqual([{ path: '~/work/other', reason: 'it is already in the list' }]);
    expect(stored()).toEqual([code, other, third]);
  });

  it('keeps at most 20', async () => {
    store(Array.from({ length: MAX_FOLDERS - 1 }, (_, i) => folder('many', `f${i}`)));
    chooserAnswers.push({ kind: 'chosen', paths: [folder('more', 'a'), folder('more', 'b')] });
    const out = (await choose()).json();
    expect(out.added).toEqual(['~/more/a']);
    expect(out.refused).toEqual([{ path: '~/more/b', reason: 'at most 20 folders' }]);
    expect(stored()).toHaveLength(20);
  });

  it('is allowed for every member, whatever the team shares', async () => {
    relay.setBoundaries({ topic: 'T', github_orgs: [], drives: [], member_folders: false });
    chooserAnswers.push({ kind: 'chosen', paths: [folder('work', 'mine')] });
    const r = await choose();
    expect(r.status).toBe(200);
    expect(r.json().added).toEqual(['~/work/mine']);
  });

  it('409 while a chooser is open; the first one still finishes', async () => {
    let answer!: (r: ChooseResult) => void;
    chooserAnswers.push(new Promise<ChooseResult>((r) => (answer = r)));
    const first = choose();
    await waitUntil(() => prompts.length === 1);
    const second = await choose();
    expect(second.status).toBe(409);
    expect(second.json().error).toBe('chooser_open');
    answer({ kind: 'chosen', paths: [folder('code', 'example-org')] });
    expect((await first).json().added).toEqual(['~/code/example-org']);
    // Free again afterwards.
    chooserAnswers.push({ kind: 'cancelled' });
    expect((await choose()).status).toBe(200);
  });

  it('Cancel changes nothing', async () => {
    store([folder('code', 'example-org')]);
    const before = readFileSync(memberFoldersPath(env), 'utf8');
    chooserAnswers.push({ kind: 'cancelled' });
    const r = await choose();
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ added: [], refused: [], cancelled: true, folders: ['~/code/example-org'] });
    expect(readFileSync(memberFoldersPath(env), 'utf8')).toBe(before);
  });
});

describe('ACC-4: removing a folder', () => {
  it('removes exactly the stored entry, by its ~/ form or its full path; 404 otherwise; never adds', async () => {
    const a = folder('code', 'a');
    const b = folder('code', 'b');
    store([a, b]);
    const r = await req(port, '/api/local/folders/remove', write('POST', { path: '~/code/a' }));
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ folders: ['~/code/b'] });
    expect(stored()).toEqual([b]);
    const before = readFileSync(memberFoldersPath(env), 'utf8');
    for (const path of [a, folder('code', 'c'), '~/code', '/']) {
      const miss = await req(port, '/api/local/folders/remove', write('POST', { path }));
      expect(miss.status, path).toBe(404);
    }
    expect(readFileSync(memberFoldersPath(env), 'utf8')).toBe(before);
    expect((await req(port, '/api/local/folders/remove', write('POST', { path: b }))).json().folders).toEqual([]);
    expect(prompts).toEqual([]);
  });
});

describe('ACC-5: background answering', () => {
  const KEY = 'team-relay@market';
  let claudeDir: string;
  beforeEach(() => {
    claudeDir = join(tmp, 'bin');
    mkdirSync(claudeDir);
    writeFileSync(join(claudeDir, 'claude'), '#!/bin/sh\n');
    chmodSync(join(claudeDir, 'claude'), 0o755);
    const plugin = join(home, '.claude', 'plugins', 'cache', 'market', 'team-relay', '0.1.0');
    mkdirSync(join(plugin, 'dist'), { recursive: true });
    writeFileSync(join(plugin, 'dist', 'daemon.js'), '');
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [KEY]: [{ scope: 'user', installPath: plugin }] } }));
    env.PATH = `${claudeDir}:/usr/bin:/bin`;
    env.CLAUDE_PLUGIN_ROOT = plugin;
  });

  it('on writes the same LaunchAgent and launcher as `setup-cli daemon install`; off removes them; the state reads back', async () => {
    const plist = join(home, 'Library', 'LaunchAgents', 'com.team-relay.answerer.plist');
    const launcher = join(xdg, 'team-relay', 'daemon-launch.mjs');
    const on = await req(port, '/api/local/background', write('PUT', { on: true }));
    expect(on.status).toBe(200);
    expect(on.json()).toEqual({ installed: true });
    expect(launchctl).toEqual([
      ['bootout', 'gui/501/com.team-relay.answerer'],
      ['print', 'gui/501/com.team-relay.answerer'],
      ['bootstrap', 'gui/501', plist],
    ]);
    const fromPage = { plist: readFileSync(plist, 'utf8'), launcher: readFileSync(launcher, 'utf8') };
    expect((await req(port, '/api/local/setup', { key })).json().background).toEqual({ installed: true, available: true });

    const off = await req(port, '/api/local/background', write('PUT', { on: false }));
    expect(off.json()).toEqual({ installed: false });
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(launcher)).toBe(false);
    expect((await req(port, '/api/local/setup', { key })).json().background).toEqual({ installed: false, available: true });

    // The setup line's own install, for the same claude and plugin key, writes the same files.
    const code = await runSetup(['daemon', 'install', '--claude', join(claudeDir, 'claude'), '--plugin', KEY], {
      env,
      io: { print: () => {}, ask: async () => null },
      platform: 'darwin',
      uid: 501,
      exec,
      sleep: async () => {},
      node: process.execPath,
    });
    expect(code).toBe(0);
    expect({ plist: readFileSync(plist, 'utf8'), launcher: readFileSync(launcher, 'utf8') }).toEqual(fromPage);
  });

  it("the background answerer runs the pinned private node, got first when missing; else a stable PATH node; never this process's own", async () => {
    const plist = join(home, 'Library', 'LaunchAgents', 'com.team-relay.answerer.plist');
    const pin = pinnedNodeVersion()!;
    const nodeStub = (path: string, version: string) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const onPath = nodeStub(join(claudeDir, 'node'), 'v24.0.0');
    const arch = process.arch === 'x64' ? 'x64' : 'arm64';
    let fetches = 0;
    let fetchInstalls = false;
    const fetchNode = async () => {
      fetches++;
      if (fetchInstalls) nodeStub(pinnedNodePath(home, pin, arch), pin);
    };
    const ownPages = new SetupPages({ env, log: () => {}, platform: 'darwin', staticDir: NO_UI, open: () => {}, schedule, exec, sleep: async () => {}, uid: 501, fetchNode });
    const client = new RelayClient({ url: relay.url, team: 'demo', token: staticTokenProvider(TOKEN_OF.bob!), attempts: 1 });
    try {
      const { url } = await ownPages.open({ client, member: 'bob', team: 'demo', email: null });
      const m = /^http:\/\/127\.0\.0\.1:(\d+)\/join#k=([A-Za-z0-9_-]{43})$/.exec(url)!;
      const put = () => req(Number(m[1]), '/api/local/background', { ...write('PUT', { on: true }), key: m[2]! });
      const programs = () => [...readFileSync(plist, 'utf8').matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]);
      // The pinned copy is missing and cannot be got: the PATH node.
      expect((await put()).status).toBe(200);
      expect(fetches).toBe(1);
      expect(programs()).toContain(onPath);
      expect(programs()).not.toContain(process.execPath);
      // Got first, then used.
      fetchInstalls = true;
      expect((await put()).status).toBe(200);
      expect(fetches).toBe(2);
      const pinned = pinnedNodePath(home, pin, arch);
      expect(programs()).toContain(pinned);
      expect(programs()).not.toContain(onPath);
      // There now: not got again.
      expect((await put()).status).toBe(200);
      expect(fetches).toBe(2);
      // Neither: refused with a plain reason, nothing installed.
      rmSync(join(home, '.local'), { recursive: true });
      rmSync(onPath);
      fetchInstalls = false;
      const none = await put();
      expect(none.status).toBe(500);
      expect(none.json()).toEqual({ error: 'background_failed', detail: BACKGROUND_NO_NODE });
    } finally {
      await ownPages.stop();
    }
  });

  it('says plainly when Claude Code cannot be found, and installs nothing', async () => {
    env.PATH = '/usr/bin:/bin';
    const r = await req(port, '/api/local/background', write('PUT', { on: true }));
    expect(r.status).toBe(409);
    expect(r.json()).toEqual({ error: 'background_unavailable', detail: BACKGROUND_NO_CLAUDE });
    expect(launchctl).toEqual([]);
    expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.team-relay.answerer.plist'))).toBe(false);
  });
});

describe('Done', () => {
  it('answers ok and stops the server 3 s later', async () => {
    const r = await req(port, '/api/local/done', write('POST', {}));
    expect(r.json()).toEqual({ ok: true });
    const stop = scheduled.filter((s) => s.ms === 3000 && !s.cancelled);
    expect(stop).toHaveLength(1);
    // No longer the page to reopen, but still answering until the stop.
    expect(pages.active).toBe(false);
    expect((await req(port, '/api/local/setup', { key })).status).toBe(200);
    stop[0]!.fn();
    await expect(req(port, '/api/local/setup', { key })).rejects.toThrow();
  });

  it('a /team-relay:setup right after Done gets a fresh server; the old one still stops, also with the MCP server', async () => {
    await req(port, '/api/local/done', write('POST', {}));
    const stop = scheduled.filter((s) => s.ms === 3000 && !s.cancelled);
    const client = new RelayClient({ url: relay.url, team: 'demo', token: staticTokenProvider(TOKEN_OF.bob!), attempts: 1 });
    const again = await pages.open({ client, member: 'bob', team: 'demo', email: 'bob@example.com' });
    expect(again.reused).toBe(false);
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/join#k=([A-Za-z0-9_-]{43})$/.exec(again.url)!;
    expect(m[2]).not.toBe(key);
    expect(pages.active).toBe(true);
    expect((await req(Number(m[1]), '/api/local/setup', { key: m[2]! })).status).toBe(200);
    // The MCP server exits before the 3 s: both stop, and the Done timer is cancelled.
    await pages.stop();
    expect(stop[0]!.cancelled).toBe(true);
    await expect(req(port, '/api/local/setup', { key })).rejects.toThrow();
    await expect(req(Number(m[1]), '/api/local/setup', { key: m[2]! })).rejects.toThrow();
  });
});

async function waitUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('condition not met');
}
