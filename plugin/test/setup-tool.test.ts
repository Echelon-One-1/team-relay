// /team-relay:setup (ACC-1): the command calls the `setup` tool, which signs in when needed (the
// login tool's own sign-in), starts one setup page on this Mac (the console server on 127.0.0.1,
// a fresh key) and opens it on /join by way of the private redirect file; a second call reopens
// the same page; the page stops after Done or 30 minutes without a request, and with the server.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient, staticTokenProvider } from '../src/relay-client.js';
import { SETUP_IDLE_MS, SetupPages, type Schedule, type SetupDone, type SetupLive } from '../src/setup-page.js';
import {
  SETUP_CANCELLED,
  SETUP_CLOSED,
  SETUP_CONNECT_WAIT_MS,
  SETUP_DONE_WAIT_MS,
  SETUP_OPEN,
  SETUP_OPEN_SIGN_IN,
  SETUP_SIGN_IN_WAIT_MS,
  SETUP_STALE,
  SETUP_STILL_OPEN,
  setupDoneLine,
  setupTool,
} from '../src/setup-tool.js';
import { SIGN_IN_URL_RULE } from '../src/login.js';
import { redirectHtml } from '../src/console-open.js';
import { normaliseRelayUrl, readCredential, writeCredential } from '../src/credentials.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST, FIXTURES, PLUGIN_ROOT, spawnServer, textOf, waitFor, type Spawned } from './helpers/mcp.js';

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

function post(port: number, path: string, key: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${port}`,
      'X-Console-Key': key,
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'same-origin',
    };
    const r = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers, setHost: false, agent: false }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end('{}');
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
  const SUMMARY: SetupDone = { kind: 'done', team: 'demo', folders: 2, background: true };
  const DONE_LINE = 'Setup is done: team demo, 2 folders, background answering on.';
  const page = (done: Promise<SetupDone> = Promise.resolve(SUMMARY)) => ({ url: 'u', reused: false, done });

  it('signed in: opens the page and, at Done, returns one line', async () => {
    const opened: SetupLive[] = [];
    let signIns = 0;
    const r = await setupTool({}, { live: () => live, signIn: async () => (signIns++, null), pages: { open: async (l) => (opened.push(l), page()) } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toEqual({ message: DONE_LINE });
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
      pages: { open: async (l) => (opened.push(l), page()) },
    });
    expect(SETUP_SIGN_IN_WAIT_MS).toBe(300_000);
    expect(waits).toEqual([300_000]);
    expect(opened).toEqual([live]);
    expect(JSON.parse(textOf(r)).message).toBe(DONE_LINE);
  });

  it('a sign-in that does not finish opens nothing and says so', async () => {
    const opened: SetupLive[] = [];
    const r = await setupTool({}, { live: () => null, signIn: async () => 'The sign-in did not finish within 5 minutes.', pages: { open: async (l) => (opened.push(l), page()) } });
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
      pages: { open: async (l) => (opened.push(l), page()) },
      sleep: async (ms) => {
        slept.push(ms);
        if (slept.length === 3) now = live;
      },
    });
    expect(JSON.parse(textOf(r))).toEqual({ message: DONE_LINE });
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
      pages: { open: async () => page() },
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
        pages: { open: async () => page() },
        sleep: async () => void slept++,
      });
      expect(JSON.parse(textOf(r))).toEqual({ message: DONE_LINE });
      expect(slept).toBe(0);
    }
  });

  it('no browser could be opened on the sign-in: returns the sign-in URL under the login tool\'s rule', async () => {
    const opened: SetupLive[] = [];
    const r = await setupTool({}, {
      live: () => null,
      signIn: async () => ({ signInUrl: 'https://relay.example.com/v1/login/start?port=1' }),
      pages: { open: async (l) => (opened.push(l), page()) },
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

  // 15 Nov 2026, a real Mac: the saved sign-in named a relay and team that no longer exist; setup
  // dead-ended on the 404. A stale sign-in is treated as signed out: setup signs in again.
  it('a stale sign-in (it no longer works at its relay): signs in again at once and says so in one sentence', async () => {
    expect(SETUP_STALE).toBe("Your saved sign-in no longer works at its team relay, so you're signing in again.");
    let now: SetupLive | null = null;
    let slept = 0;
    const said: string[] = [];
    const r = await setupTool(
      {},
      {
        live: () => now,
        stored: () => 'stale',
        notConnected: () => 'x',
        signIn: async () => ((now = live), null),
        pages: { open: async () => page() },
        sleep: async () => void slept++,
      },
      (m) => said.push(m),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toEqual({ message: `${SETUP_STALE} ${DONE_LINE}` });
    expect(said[0]).toBe(SETUP_STALE);
    expect(slept).toBe(0);
  });

  it('a stored sign-in found stale while setup waits for its connection: signs in again', async () => {
    let now: SetupLive | null = null;
    let state: 'present' | 'stale' = 'present';
    let signIns = 0;
    let slept = 0;
    const r = await setupTool({}, {
      live: () => now,
      stored: () => state,
      notConnected: () => 'x',
      signIn: async () => (signIns++, (now = live), null),
      pages: { open: async () => page() },
      sleep: async () => {
        if (++slept === 2) state = 'stale';
      },
    });
    expect(JSON.parse(textOf(r))).toEqual({ message: `${SETUP_STALE} ${DONE_LINE}` });
    expect(signIns).toBe(1);
    expect(slept).toBe(2);
  });

  it('a stale sign-in whose new sign-in fails: says both, and the page is not opened', async () => {
    const opened: SetupLive[] = [];
    const r = await setupTool({}, { live: () => null, stored: () => 'stale', signIn: async () => 'The sign-in did not complete: x.', pages: { open: async (l) => (opened.push(l), page()) } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`${SETUP_STALE} The sign-in did not complete: x. Then run /team-relay:setup again.`);
    expect(opened).toEqual([]);
  });

  // Security review, 15 Nov 2026: signed in to another relay that is not answering is an outage,
  // not a reason to switch: setup stops at once and says so, and signs nobody in.
  it('signed in to another relay that is not answering: stops at once, says why, signs nobody in', async () => {
    let signIns = 0;
    let slept = 0;
    const opened: SetupLive[] = [];
    const why = "Not connected: this Mac is signed in to another team relay (old.example.com) that isn't answering right now; try again later, or run /team-relay:logout first to switch";
    const r = await setupTool({}, {
      live: () => null,
      stored: () => 'elsewhere',
      notConnected: () => why,
      signIn: async () => (signIns++, null),
      pages: { open: async (l) => (opened.push(l), page()) },
      sleep: async () => void slept++,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`${why}.`);
    expect(textOf(r)).not.toContain(SETUP_STALE);
    expect(signIns).toBe(0);
    expect(slept).toBe(0);
    expect(opened).toEqual([]);
  });

  it('found to be another relay not answering while setup waits for its connection: stops, signs nobody in', async () => {
    let state: 'present' | 'elsewhere' = 'present';
    let signIns = 0;
    const r = await setupTool({}, {
      live: () => null,
      stored: () => state,
      notConnected: () => 'Not connected: x',
      signIn: async () => (signIns++, null),
      pages: { open: async () => page() },
      sleep: async () => void (state = 'elsewhere'),
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('Not connected: x.');
    expect(signIns).toBe(0);
  });

  it('a sign-in the relay refused (401) is not called stale', async () => {
    let now: SetupLive | null = null;
    const said: string[] = [];
    const r = await setupTool({}, { live: () => now, stored: () => 'refused', signIn: async () => ((now = live), null), pages: { open: async () => page() } }, (m) => said.push(m));
    expect(JSON.parse(textOf(r))).toEqual({ message: DONE_LINE });
    expect(said).not.toContain(SETUP_STALE);
  });

  // 15 Nov 2026, a real Mac: the page said "Done. All set." while Claude still showed "The setup
  // page is open". The tool now waits for Done (at most 10 minutes) and says how it ended.
  describe('waiting for Done', () => {
    it('Done ends the wait at once with one line: the team, how many folders, background on or off', async () => {
      let pressDone!: (d: SetupDone) => void;
      const done = new Promise<SetupDone>((r) => (pressDone = r));
      const said: string[] = [];
      const call = setupTool({}, { live: () => live, signIn: async () => null, pages: { open: async () => page(done) } }, (m) => said.push(m));
      await new Promise((r) => setTimeout(r, 20));
      expect(said).toContain(SETUP_OPEN);
      const started = Date.now();
      pressDone({ kind: 'done', team: 'demo', folders: 1, background: false });
      const r = await call;
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(textOf(r))).toEqual({ message: 'Setup is done: team demo, 1 folder, background answering off.' });
      expect(setupDoneLine({ kind: 'done', team: 'demo', folders: 4, background: true })).toBe('Setup is done: team demo, 4 folders, background answering on.');
      expect(setupDoneLine({ kind: 'done', team: 'demo', folders: null, background: true })).toBe('Setup is done: team demo, background answering on.');
    });

    it('no Done within the wait: says the page is still open, and leaves it open', async () => {
      expect(SETUP_DONE_WAIT_MS).toBe(600_000);
      expect(SETUP_STILL_OPEN).toBe('The setup page is still open in your browser. Finish it there; run /team-relay:setup again if you closed it.');
      const r = await setupTool({}, { live: () => live, signIn: async () => null, pages: { open: async () => page(new Promise<SetupDone>(() => {})) }, doneWaitMs: 30 });
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(textOf(r))).toEqual({ message: SETUP_STILL_OPEN });
    });

    it('the page closed without Done (30 minutes idle, or the server stopping): says so', async () => {
      const r = await setupTool({}, { live: () => live, signIn: async () => null, pages: { open: async () => page(Promise.resolve({ kind: 'closed' })) } });
      expect(JSON.parse(textOf(r))).toEqual({ message: SETUP_CLOSED });
    });

    it('the request cancelled while waiting: returns at once, the page left to its own life', async () => {
      const ac = new AbortController();
      const call = setupTool({}, { live: () => live, signIn: async () => null, pages: { open: async () => page(new Promise<SetupDone>(() => {})) } }, () => {}, ac.signal);
      await new Promise((r) => setTimeout(r, 20));
      const started = Date.now();
      ac.abort();
      const r = await call;
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe(SETUP_CANCELLED);
    });

    it('cancelled during the sign-in: the signal reaches the sign-in wait, and the call returns at once without opening the page', async () => {
      const ac = new AbortController();
      const opened: SetupLive[] = [];
      let got: AbortSignal | undefined;
      const call = setupTool(
        {},
        {
          live: () => null,
          signIn: (_ms, _p, signal) => {
            got = signal;
            return new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ cancelled: true })));
          },
          pages: { open: async (l) => (opened.push(l), page()) },
        },
        () => {},
        ac.signal,
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(got).toBe(ac.signal);
      ac.abort();
      const r = await call;
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe(SETUP_CANCELLED);
      expect(opened).toEqual([]);
    });

    it('already cancelled: opens nothing', async () => {
      const ac = new AbortController();
      ac.abort();
      const opened: SetupLive[] = [];
      const r = await setupTool({}, { live: () => live, signIn: async () => null, pages: { open: async (l) => (opened.push(l), page()) } }, () => {}, ac.signal);
      expect(r.isError).toBe(true);
      expect(opened).toEqual([]);
    });
  });

  it('takes no arguments', async () => {
    const r = await setupTool({ url: 'x' }, { live: () => live, signIn: async () => null, pages: { open: async () => page() } });
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
      expect(second).toMatchObject({ url: first.url, reused: true });
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

  it('says when the member pressed Done (team, folder count, background) to every call waiting on that page; a page that closes without Done says closed', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'tr-setup-done-'));
    const env = { HOME: tmpRoot, XDG_CONFIG_HOME: join(tmpRoot, 'xdg') };
    const pages = new SetupPages({ env, log: () => {}, platform: 'darwin', staticDir: NO_UI, schedule, open: () => {}, localDeps: () => ({ background: { availability: () => ({ available: true }), installed: () => true, install: async () => {}, uninstall: async () => true } }) });
    try {
      const first = await pages.open(live());
      const second = await pages.open(live());
      expect(second.done).toBe(first.done);
      const { port, key } = parse(first.url);
      expect((await post(port, '/api/local/done', key)).status).toBe(200);
      await expect(first.done).resolves.toEqual({ kind: 'done', team: 'demo', folders: 0, background: true });
      // The page still stops 3 s after Done, as before.
      expect(scheduled.filter((x) => x.ms === 3000 && !x.cancelled)).toHaveLength(1);

      const next = await pages.open(live());
      expect(next.done).not.toBe(first.done);
      await pages.stop();
      await expect(next.done).resolves.toEqual({ kind: 'closed' });
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

    // The call waits for Done on the page.
    const first = s.client.callTool({ name: 'setup', arguments: {} });
    const entries = () => (existsSync(browserLog) ? readFileSync(browserLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { url: string }) : []);
    // First the relay's sign-in, then the setup page.
    const page = await waitFor(() => entries().find((e) => /\/join#k=/.test(e.url)), 10_000, 'the setup page to open');
    expect(entries()[0]!.url.startsWith(`${relay.url}/v1/login/start?port=`)).toBe(true);
    let { port, key } = parse(page.url);
    const state = await get(port, '/api/local/setup', key);
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body).signed_in).toEqual({ member: 'alice', team: 'demo', email: 'alice@example.com' });

    // A second call meanwhile: the same page again, no second server; both wait for its Done.
    const second = s.client.callTool({ name: 'setup', arguments: {} });
    await waitFor(() => entries().filter((e) => e.url === page.url).length === 2, 10_000, 'the page to open again');
    expect(entries().filter((e) => /\/join#k=/.test(e.url)).every((e) => e.url === page.url)).toBe(true);
    expect((await post(port, '/api/local/done', key)).status).toBe(200);
    const DONE = /^Setup is done: team demo, 0 folders, background answering (on|off)\.$/;
    for (const r of await Promise.all([first, second])) {
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(JSON.parse(textOf(r)).message).toMatch(DONE);
    }

    // A new call after Done: a fresh page, which stops with the server (the waiting call ends with it).
    const third = s.client.callTool({ name: 'setup', arguments: {} }).catch(() => null);
    const fresh = await waitFor(() => entries().find((e) => /\/join#k=/.test(e.url) && e.url !== page.url), 10_000, 'a fresh page');
    ({ port, key } = parse(fresh.url));
    expect((await get(port, '/api/local/setup', key)).status).toBe(200);
    await s.close();
    await third;
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
    // The configured relay not answering is not a stale sign-in: no new sign-in.
    expect(textOf(r)).not.toContain('no longer works');
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
    const page = await waitFor(() => entries().find((e) => /\/join#k=/.test(e.url)), 10_000, 'the setup page to open');
    const { port, key } = parse(page.url);
    await post(port, '/api/local/done', key);
    const r = await setup;
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(JSON.parse(textOf(r)).message).toMatch(/^Setup is done: team demo, /);
  });

  // 15 Nov 2026, a real Mac: the saved sign-in named a team the relay no longer knows (404); setup
  // dead-ended before the sign-in. Now: one plain sentence, the normal sign-in, the page.
  it('a saved sign-in its relay no longer knows (404): signs in again, says so, and the new sign-in replaces it', async () => {
    const credFile = join(xdg, 'team-relay', 'credentials.json');
    const oldCredential = relay.mintCredential('bob');
    writeCredential(credFile, { relay_url: relay.url, team: 'gone', member: 'bob', credential: oldCredential, expires_at: null });
    const s = await server();
    const said = await waitFor(async () => {
      const t = textOf(await s.client.callTool({ name: 'whoami', arguments: {} }));
      return /no longer works/.test(t) ? t : null;
    }, 20_000, 'a first attempt');
    expect(JSON.parse(said).message).toBe('Not connected: your saved sign-in no longer works at its team relay; run /team-relay:setup to sign in again');
    const setup = s.client.callTool({ name: 'setup', arguments: {} });
    const page = await waitFor(() => entries().find((e) => /\/join#k=/.test(e.url)), 20_000, 'the setup page to open');
    expect(entries()[0]!.url.startsWith(`${relay.url}/v1/login/start?port=`)).toBe(true);
    const { port, key } = parse(page.url);
    await post(port, '/api/local/done', key);
    const r = await setup;
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(JSON.parse(textOf(r)).message.startsWith(`${SETUP_STALE} Setup is done: team demo, `), textOf(r)).toBe(true);
    expect(readCredential(credFile)).toMatchObject({ team: 'demo', member: 'alice' });
  });

  it('a saved sign-in for another relay that is not answering: not stale; setup stops with one sentence, no sign-in, the file kept', async () => {
    const closed = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        srv.close(() => resolve(port));
      });
    });
    const credFile = join(xdg, 'team-relay', 'credentials.json');
    writeCredential(credFile, { relay_url: `http://127.0.0.1:${closed}`, team: 'demo', member: 'bob', credential: relay.mintCredential('bob'), expires_at: null });
    const before = readFileSync(credFile, 'utf8');
    // No RELAY_URL: the configured relay is the plugin's default, another one.
    const s = await server({ RELAY_URL: '' });
    await waitFor(async () => (/isn't answering right now/.test(textOf(await s.client.callTool({ name: 'whoami', arguments: {} }))) ? true : null), 20_000, 'a first attempt');
    const r = await s.client.callTool({ name: 'setup', arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      `Not connected: this Mac is signed in to another team relay (127.0.0.1:${closed}) that isn't answering right now; try again later, or run /team-relay:logout first to switch.`,
    );
    expect(entries()).toEqual([]);
    expect(readFileSync(credFile, 'utf8')).toBe(before);
  });

  // The cross-relay exception (reviewer, 15 Nov 2026): the saved sign-in names another relay than
  // the configured one (the plugin's default, here a copy of the bundle beside its own
  // relay.default.json), and that relay answers 404 for everything (a deleted Cloud Run service:
  // not the relay's own not_found). Setup signs in to the configured relay and the new sign-in
  // replaces the stale file; the old credential reaches neither relay.
  describe('a saved sign-in for another relay that is gone', () => {
    let gone: FakeRelay;
    let dist: string;
    let credFile: string;
    let oldCredential: string;
    beforeEach(async () => {
      gone = await new FakeRelay().start();
      gone.fail(() => true, 404, 1_000_000, {});
      dist = join(xdg, 'plugin', 'dist');
      mkdirSync(dist, { recursive: true });
      copyFileSync(join(DIST, 'channel.js'), join(dist, 'channel.js'));
      writeFileSync(join(xdg, 'plugin', 'relay.default.json'), JSON.stringify({ relay_url: relay.url }));
      credFile = join(xdg, 'team-relay', 'credentials.json');
      oldCredential = gone.mintCredential('bob');
      writeCredential(credFile, { relay_url: gone.url, team: 'demo', member: 'bob', credential: oldCredential, expires_at: null });
    });
    afterEach(async () => {
      while (open.length) await open.pop()!.close();
      await gone.stop();
    });
    const spawn = async (extra: Record<string, string> = {}) => {
      const s = await spawnServer(
        'channel.js',
        { RELAY_ROLE: 'asker', RELAY_AUTH: '', XDG_CONFIG_HOME: xdg, TEAM_RELAY_OPEN_COMMAND: join(FIXTURES, 'fake-browser.mjs'), FAKE_BROWSER_LOG: browserLog, ...extra },
        dist,
      );
      open.push(s);
      await waitFor(async () => (/no longer works/.test(textOf(await s.client.callTool({ name: 'whoami', arguments: {} }))) ? true : null), 20_000, 'a first attempt');
      return s;
    };

    it('signs in to the configured relay, replaces the stale file, and the old credential reaches neither relay', async () => {
      const s = await spawn();
      const setup = s.client.callTool({ name: 'setup', arguments: {} });
      const page = await waitFor(() => entries().find((e) => /\/join#k=/.test(e.url)), 20_000, 'the setup page to open');
      expect(entries()[0]!.url.startsWith(`${relay.url}/v1/login/start?port=`)).toBe(true);
      const { port, key } = parse(page.url);
      await post(port, '/api/local/done', key);
      const r = await setup;
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(JSON.parse(textOf(r)).message.startsWith(`${SETUP_STALE} Setup is done: team demo, `)).toBe(true);
      const now = readCredential(credFile);
      expect(now?.relay_url).toBe(normaliseRelayUrl(relay.url));
      expect(now).toMatchObject({ team: 'demo', member: 'alice' });
      const seen = (r: FakeRelay) => r.requests.map((q) => `${JSON.stringify(q.headers)} ${q.raw} ${q.path}`).join('\n');
      expect(seen(relay)).not.toContain(oldCredential);
      // At the gone relay only its own GET /me ever carried it (the connection's attempts).
      expect(gone.requests.every((q) => q.method === 'GET' && q.path.endsWith('/me'))).toBe(true);
    });

    it('the stale file rewritten during the sign-in: the new sign-in is refused and the rewritten file kept', async () => {
      const s = await spawn({ FAKE_BROWSER_MODE: 'ignore' });
      const setup = s.client.callTool({ name: 'setup', arguments: {} });
      const first = await waitFor(() => entries()[0], 20_000, 'the sign-in to open');
      // Another sign-in for the gone relay lands meanwhile (a new file: another fingerprint).
      const other = `trc_${'R'.repeat(43)}`;
      writeCredential(credFile, { relay_url: gone.url, team: 'demo', member: 'carol', credential: other, expires_at: null });
      const before = readFileSync(credFile, 'utf8');
      const dir = mkdtempSync(join(xdg, 'open-'));
      writeFileSync(join(dir, 'console.html'), redirectHtml(first.url));
      await new Promise<void>((resolve, reject) =>
        execFile(process.execPath, [join(FIXTURES, 'fake-browser.mjs'), join(dir, 'console.html')], { env: { ...process.env, FAKE_BROWSER_LOG: browserLog } }, (err) => (err ? reject(err) : resolve())),
      );
      const r = await setup;
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/signed in, but nothing was stored: this computer is signed in to another relay/);
      expect(readFileSync(credFile, 'utf8')).toBe(before);
    });
  });

  it('cancelled while the sign-in waits: the call ends at once, the sign-in goes on and still signs the session in', async () => {
    const s = await server({ FAKE_BROWSER_MODE: 'ignore' });
    const ac = new AbortController();
    const setup = s.client.callTool({ name: 'setup', arguments: {} }, undefined, { signal: ac.signal }).then(
      () => 'returned',
      () => 'rejected',
    );
    const first = await waitFor(() => entries()[0], 20_000, 'the sign-in to open');
    ac.abort();
    expect(await setup).toBe('rejected');
    // The server stopped waiting at once (before the sign-in finished), and says so in its log.
    await waitFor(() => s.stderr().includes('setup: stopped waiting for the sign-in (the call was cancelled)'), 10_000, 'the wait to stop');
    // Its next call is answered (no page opened, still not signed in).
    const who = JSON.parse(textOf(await s.client.callTool({ name: 'whoami', arguments: {} })));
    expect(who).toMatchObject({ connected: false, sign_in_pending: true });
    expect(entries().filter((e) => /\/join#k=/.test(e.url))).toEqual([]);
    // The sign-in itself was left running: finishing it in the browser signs this session in.
    const dir = mkdtempSync(join(xdg, 'open-'));
    writeFileSync(join(dir, 'console.html'), redirectHtml(first.url));
    await new Promise<void>((resolve, reject) =>
      execFile(process.execPath, [join(FIXTURES, 'fake-browser.mjs'), join(dir, 'console.html')], { env: { ...process.env, FAKE_BROWSER_LOG: browserLog } }, (err) => (err ? reject(err) : resolve())),
    );
    await waitFor(async () => JSON.parse(textOf(await s.client.callTool({ name: 'whoami', arguments: {} }))).connected === true || null, 10_000, 'connected');
  });

  it('a saved sign-in the relay refuses (401): signs in again without calling it stale', async () => {
    writeCredential(join(xdg, 'team-relay', 'credentials.json'), { relay_url: relay.url, team: 'demo', member: 'bob', credential: `trc_${'Z'.repeat(43)}`, expires_at: null });
    const s = await server();
    await waitFor(async () => (/sign in again|signed out/i.test(textOf(await s.client.callTool({ name: 'whoami', arguments: {} }))) ? true : null), 20_000, 'a first attempt');
    const setup = s.client.callTool({ name: 'setup', arguments: {} });
    const page = await waitFor(() => entries().find((e) => /\/join#k=/.test(e.url)), 20_000, 'the setup page to open');
    const { port, key } = parse(page.url);
    await post(port, '/api/local/done', key);
    const r = await setup;
    expect(JSON.parse(textOf(r)).message).toMatch(/^Setup is done: team demo, /);
    expect(textOf(r)).not.toContain('no longer works');
  });
});
