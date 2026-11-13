// /team-relay:setup (ACC-1): the command calls the `setup` tool, which signs in when needed (the
// login tool's own sign-in), starts one setup page on this Mac (the console server on 127.0.0.1,
// a fresh key) and opens it on /join by way of the private redirect file; a second call reopens
// the same page; the page stops after Done or 30 minutes without a request, and with the server.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, staticTokenProvider } from '../src/relay-client.js';
import { SETUP_IDLE_MS, SetupPages, type Schedule, type SetupLive } from '../src/setup-page.js';
import { SETUP_CONNECT_WAIT_MS, SETUP_OPEN, SETUP_OPEN_SIGN_IN, SETUP_SIGN_IN_WAIT_MS, setupTool } from '../src/setup-tool.js';
import { SIGN_IN_URL_RULE } from '../src/login.js';
import { redirectHtml } from '../src/console-open.js';
import { writeCredential } from '../src/credentials.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { FIXTURES, PLUGIN_ROOT, spawnServer, textOf, waitFor, type Spawned } from './helpers/mcp.js';

const NO_UI = join(tmpdir(), 'team-relay-no-such-console');

function get(port: number, path: string, key: string | null): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };
    if (key) headers['X-Console-Key'] = key;
    const r = httpRequest({ host: '127.0.0.1', port, path, headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

const parse = (url: string) => {
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/join#k=([A-Za-z0-9_-]{43})$/.exec(url);
  if (!m) throw new Error(`not a setup page URL: ${url}`);
  return { port: Number(m[1]), key: m[2]! };
};

describe('the command', () => {
  it('/team-relay:setup calls the setup tool with no arguments, and the model cannot run it on its own', () => {
    const text = readFileSync(join(PLUGIN_ROOT, 'commands', 'setup.md'), 'utf8');
    expect(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1]).toMatch(/^disable-model-invocation: true$/m);
    expect(text).toMatch(/Call the `setup` tool of this plugin's `relay` server, with no arguments, once/);
    expect(text).not.toContain('$ARGUMENTS');
    expect(text).not.toMatch(/!`/);
  });
});

describe('setupTool', () => {
  const live: SetupLive = { client: {} as RelayClient, member: 'bob', team: 'demo', email: null };

  it('signed in: opens the page and returns at once with one line', async () => {
    const opened: SetupLive[] = [];
    let signIns = 0;
    const r = await setupTool({}, { live: () => live, signIn: async () => (signIns++, null), pages: { open: async (l) => (opened.push(l), { url: 'u', reused: false }) } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toEqual({ message: SETUP_OPEN });
    expect(SETUP_OPEN).toBe('The setup page is open in your browser. Come back here when it says Done.');
    expect(opened).toEqual([live]);
    expect(signIns).toBe(0);
  });

  it('not signed in: signs in first (waiting up to 5 minutes), then opens the page', async () => {
    let now: SetupLive | null = null;
    const waits: number[] = [];
    const opened: SetupLive[] = [];
    const r = await setupTool({}, {
      live: () => now,
      signIn: async (ms) => {
        waits.push(ms);
        now = live;
        return null;
      },
      pages: { open: async (l) => (opened.push(l), { url: 'u', reused: false }) },
    });
    expect(SETUP_SIGN_IN_WAIT_MS).toBe(300_000);
    expect(waits).toEqual([300_000]);
    expect(opened).toEqual([live]);
    expect(JSON.parse(textOf(r)).message).toBe(SETUP_OPEN);
  });

  it('a sign-in that does not finish opens nothing and says so', async () => {
    const opened: SetupLive[] = [];
    const r = await setupTool({}, { live: () => null, signIn: async () => 'The sign-in did not finish within 5 minutes.', pages: { open: async (l) => (opened.push(l), { url: 'u', reused: false }) } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('The sign-in did not finish within 5 minutes. Then run /team-relay:setup again.');
    expect(opened).toEqual([]);
  });

  it('signed in but not connected yet: waits up to 5 s for the connection, never a new Google sign-in', async () => {
    let now: SetupLive | null = null;
    let signIns = 0;
    const slept: number[] = [];
    const opened: SetupLive[] = [];
    const r = await setupTool({}, {
      live: () => now,
      stored: () => 'present',
      notConnected: () => 'Not connected: x',
      signIn: async () => (signIns++, null),
      pages: { open: async (l) => (opened.push(l), { url: 'u', reused: false }) },
      sleep: async (ms) => {
        slept.push(ms);
        if (slept.length === 3) now = live;
      },
    });
    expect(JSON.parse(textOf(r))).toEqual({ message: SETUP_OPEN });
    expect(slept).toEqual([100, 100, 100]);
    expect(opened).toEqual([live]);
    expect(signIns).toBe(0);
  });

  it('signed in but still not connected after 5 s: says why (as whoami does) and signs nobody in', async () => {
    let signIns = 0;
    let waited = 0;
    const r = await setupTool({}, {
      live: () => null,
      stored: () => 'present',
      notConnected: () => 'Not connected: the relay did not answer (offline)',
      signIn: async () => (signIns++, null),
      pages: { open: async () => ({ url: 'u', reused: false }) },
      sleep: async (ms) => void (waited += ms),
    });
    expect(SETUP_CONNECT_WAIT_MS).toBe(5000);
    expect(waited).toBe(5000);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('Not connected: the relay did not answer (offline) Run /team-relay:setup again in a moment.');
    expect(signIns).toBe(0);
  });

  it('a stored sign-in the relay refused, or none: signs in again at once', async () => {
    for (const stored of ['refused', 'none'] as const) {
      let now: SetupLive | null = null;
      let slept = 0;
      const r = await setupTool({}, {
        live: () => now,
        stored: () => stored,
        notConnected: () => 'x',
        signIn: async () => ((now = live), null),
        pages: { open: async () => ({ url: 'u', reused: false }) },
        sleep: async () => void slept++,
      });
      expect(JSON.parse(textOf(r))).toEqual({ message: SETUP_OPEN });
      expect(slept).toBe(0);
    }
  });

  it('no browser could be opened on the sign-in: returns the sign-in URL under the login tool\'s rule', async () => {
    const opened: SetupLive[] = [];
    const r = await setupTool({}, {
      live: () => null,
      signIn: async () => ({ signInUrl: 'https://relay.example.com/v1/login/start?port=1' }),
      pages: { open: async (l) => (opened.push(l), { url: 'u', reused: false }) },
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toEqual({
      status: 'waiting_for_browser',
      sign_in_url: 'https://relay.example.com/v1/login/start?port=1',
      sign_in_url_rule: SIGN_IN_URL_RULE,
      message: SETUP_OPEN_SIGN_IN,
    });
    expect(opened).toEqual([]);
  });

  it('takes no arguments', async () => {
    const r = await setupTool({ url: 'x' }, { live: () => live, signIn: async () => null, pages: { open: async () => ({ url: 'u', reused: false }) } });
    expect(r.isError).toBe(true);
  });
});

describe('SetupPages', () => {
  let relay: FakeRelay;
  let scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
  const schedule: Schedule = (fn, ms) => {
    const s = { fn, ms, cancelled: false };
    scheduled.push(s);
    return () => void (s.cancelled = true);
  };
  const live = (): SetupLive => ({
    client: new RelayClient({ url: relay.url, team: 'demo', token: staticTokenProvider(TOKEN_OF.bob!), attempts: 1 }),
    member: 'bob',
    team: 'demo',
    email: 'bob@example.com',
  });
  const idle = () => scheduled.filter((s) => s.ms === SETUP_IDLE_MS && !s.cancelled);

  beforeEach(async () => {
    relay = await new FakeRelay().start();
    scheduled = [];
  });
  afterEach(async () => {
    await relay.stop();
  });

  it('opens /join with a fresh 32-byte key through the private redirect file; a second call reopens the same page', async () => {
    const opened: string[] = [];
    const tmpRoot = mkdtempSync(join(tmpdir(), 'tr-setup-open-'));
    const pages = new SetupPages({
      env: { HOME: tmpRoot },
      log: () => {},
      platform: 'darwin',
      staticDir: NO_UI,
      schedule,
      openOptions: {
        opener: '/usr/bin/true',
        tmpRoot,
        deleteAfterMs: 60_000,
        run: (command, args, done) => {
          opened.push(readFileSync(args[0]!, 'utf8'));
          // The key is in no process argument: only the redirect file's path is.
          expect(args.join(' ')).not.toMatch(/#k=/);
          done(null);
        },
      },
    });
    try {
      const first = await pages.open(live());
      const { port, key } = parse(first.url);
      expect(first.reused).toBe(false);
      expect(Buffer.from(key, 'base64url')).toHaveLength(32);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain(`content="0;url=${first.url}"`);
      expect((await get(port, '/api/local/setup', key)).status).toBe(200);
      expect((await get(port, '/api/local/setup', null)).status).toBe(401);

      const second = await pages.open(live());
      expect(second).toEqual({ url: first.url, reused: true });
      expect(opened).toHaveLength(2);
      expect(opened[1]).toBe(opened[0]);
      expect((await get(port, '/api/local/setup', key)).status).toBe(200);

      await pages.stop();
      expect(pages.active).toBe(false);
      await expect(get(port, '/api/local/setup', key)).rejects.toThrow();
      // A new page after a stop: a new key.
      const third = await pages.open(live());
      expect(third.reused).toBe(false);
      expect(parse(third.url).key).not.toBe(key);
    } finally {
      await pages.stop();
    }
  });

  it('stops after 30 minutes without a request; each request puts that off', async () => {
    const pages = new SetupPages({ env: {}, log: () => {}, staticDir: NO_UI, schedule, open: () => {} });
    const { url } = await pages.open(live());
    const { port, key } = parse(url);
    expect(idle()).toHaveLength(1);
    const before = idle()[0]!;
    await get(port, '/api/local/setup', key);
    expect(before.cancelled).toBe(true);
    expect(idle()).toHaveLength(1);
    idle()[0]!.fn();
    await waitFor(() => !pages.active, 5000, 'the page to stop');
    await expect(get(port, '/api/local/setup', key)).rejects.toThrow();
  });
});

describe('the setup tool in the relay server', () => {
  let relay: FakeRelay;
  let xdg: string;
  let browserLog: string;
  const open: Spawned[] = [];

  beforeEach(async () => {
    relay = await new FakeRelay().start();
    xdg = mkdtempSync(join(tmpdir(), 'team-relay-setup-tool-'));
    browserLog = join(xdg, 'browser.log');
  });
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
    await relay.stop();
  });

  it('not signed in: signs in through the browser, then opens the setup page; the page stops with the server', async () => {
    const s = await spawnServer('channel.js', {
      RELAY_ROLE: 'asker',
      RELAY_AUTH: '',
      RELAY_URL: relay.url,
      XDG_CONFIG_HOME: xdg,
      TEAM_RELAY_OPEN_COMMAND: join(FIXTURES, 'fake-browser.mjs'),
      FAKE_BROWSER_LOG: browserLog,
    });
    open.push(s);
    const { tools } = await s.client.listTools();
    expect(tools.find((t) => t.name === 'setup')?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });

    const r = await s.client.callTool({ name: 'setup', arguments: {} });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(JSON.parse(textOf(r))).toEqual({ message: SETUP_OPEN });
    const entries = () => (existsSync(browserLog) ? readFileSync(browserLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { url: string }) : []);
    // First the relay's sign-in, then the setup page.
    const page = await waitFor(() => entries().find((e) => /\/join#k=/.test(e.url)), 10_000, 'the setup page to open');
    expect(entries()[0]!.url.startsWith(`${relay.url}/v1/login/start?port=`)).toBe(true);
    const { port, key } = parse(page.url);
    const state = await get(port, '/api/local/setup', key);
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body).signed_in).toEqual({ member: 'alice', team: 'demo', email: 'alice@example.com' });

    // A second call: the same page again, no second server.
    const again = await s.client.callTool({ name: 'setup', arguments: {} });
    expect(JSON.parse(textOf(again))).toEqual({ message: SETUP_OPEN });
    await waitFor(() => entries().filter((e) => e.url === page.url).length === 2, 10_000, 'the page to open again');
    expect(entries().filter((e) => /\/join#k=/.test(e.url)).every((e) => e.url === page.url)).toBe(true);

    await s.close();
    open.length = 0;
    let stopped = false;
    for (let i = 0; i < 500 && !stopped; i++) {
      stopped = await get(port, '/api/local/setup', key).then(
        () => false,
        () => true,
      );
      if (!stopped) await new Promise((r) => setTimeout(r, 20));
    }
    expect(stopped).toBe(true);
  });

  const entries = () => (existsSync(browserLog) ? readFileSync(browserLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { url: string }) : []);
  const server = async (extra: Record<string, string> = {}) => {
    const s = await spawnServer('channel.js', {
      RELAY_ROLE: 'asker',
      RELAY_AUTH: '',
      RELAY_URL: relay.url,
      XDG_CONFIG_HOME: xdg,
      TEAM_RELAY_OPEN_COMMAND: join(FIXTURES, 'fake-browser.mjs'),
      FAKE_BROWSER_LOG: browserLog,
      ...extra,
    });
    open.push(s);
    return s;
  };

  it('no browser opens on the sign-in: the result carries sign_in_url under the login rule, at once', async () => {
    const s = await server({ TEAM_RELAY_OPEN_COMMAND: '/usr/bin/false' });
    const started = Date.now();
    const r = await s.client.callTool({ name: 'setup', arguments: {} });
    expect(r.isError, textOf(r)).toBeFalsy();
    const out = JSON.parse(textOf(r));
    expect(out).toMatchObject({ status: 'waiting_for_browser', sign_in_url_rule: SIGN_IN_URL_RULE, message: SETUP_OPEN_SIGN_IN });
    expect(out.sign_in_url.startsWith(`${relay.url}/v1/login/start?port=`)).toBe(true);
    // Not the 5 minutes of the sign-in wait.
    expect(Date.now() - started).toBeLessThan(60_000);
    // The sign-in keeps waiting: finishing it at that URL signs this session in.
    const dir = mkdtempSync(join(xdg, 'open-'));
    writeFileSync(join(dir, 'console.html'), redirectHtml(out.sign_in_url));
    await new Promise<void>((resolve, reject) =>
      execFile(process.execPath, [join(FIXTURES, 'fake-browser.mjs'), join(dir, 'console.html')], { env: { ...process.env, FAKE_BROWSER_LOG: browserLog } }, (err) => (err ? reject(err) : resolve())),
    );
    await waitFor(async () => JSON.parse(textOf(await s.client.callTool({ name: 'whoami', arguments: {} }))).connected === true || null, 10_000, 'connected');
  });

  it('a sign-in stored but the relay not answering yet: says so, and starts no new Google sign-in', async () => {
    const closed = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        srv.close(() => resolve(port));
      });
    });
    const down = `http://127.0.0.1:${closed}`;
    writeCredential(join(xdg, 'team-relay', 'credentials.json'), { relay_url: down, team: 'demo', member: 'bob', credential: relay.mintCredential('bob'), expires_at: null });
    const s = await server({ RELAY_URL: down });
    await waitFor(async () => (/did not answer/.test(textOf(await s.client.callTool({ name: 'whoami', arguments: {} }))) ? true : null), 20_000, 'a first attempt');
    const r = await s.client.callTool({ name: 'setup', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Not connected: the relay did not answer \(.*\) Run \/team-relay:setup again in a moment\.$/);
    expect(entries()).toEqual([]);
  });

  it('a stored sign-in that cannot be used (a corrupt file): no waiting for a connection that cannot come; the sign-in says what to do', async () => {
    mkdirSync(join(xdg, 'team-relay'), { recursive: true, mode: 0o700 });
    chmodSync(join(xdg, 'team-relay'), 0o700);
    writeFileSync(join(xdg, 'team-relay', 'credentials.json'), '{not json', { mode: 0o600 });
    const s = await server();
    await waitFor(async () => (/not valid JSON/.test(textOf(await s.client.callTool({ name: 'whoami', arguments: {} }))) ? true : null), 20_000, 'a first attempt');
    const r = await s.client.callTool({ name: 'setup', arguments: {} });
    expect(r.isError).toBe(true);
    // The sign-in's own answer (sign out first), not "run /team-relay:setup again in a moment".
    expect(textOf(r)).toMatch(/^not signed in: the stored sign-in on this computer cannot be used \(the credential file is not valid JSON\); nothing was changed\. Run \/team-relay:logout, then \/team-relay:login\. Then run \/team-relay:setup again\.$/);
  });

  it('a sign-in replaced by a newer one while setup waits: setup waits for the newer one', async () => {
    const s = await server({ FAKE_BROWSER_MODE: 'ignore' });
    const setup = s.client.callTool({ name: 'setup', arguments: {} });
    await waitFor(() => (entries().length === 1 ? true : null), 10_000, 'the first sign-in to open');
    const login = JSON.parse(textOf(await s.client.callTool({ name: 'login', arguments: {} })));
    const dir = mkdtempSync(join(xdg, 'open-'));
    writeFileSync(join(dir, 'console.html'), redirectHtml(login.sign_in_url));
    await new Promise<void>((resolve, reject) =>
      execFile(process.execPath, [join(FIXTURES, 'fake-browser.mjs'), join(dir, 'console.html')], { env: { ...process.env, FAKE_BROWSER_LOG: browserLog } }, (err) => (err ? reject(err) : resolve())),
    );
    const r = await setup;
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(JSON.parse(textOf(r))).toEqual({ message: SETUP_OPEN });
  });
});
