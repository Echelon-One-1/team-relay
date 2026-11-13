// M5-SPEC §6 and §9 in the asker channel: with no stored sign-in it starts, waits quietly and
// says "Not connected"; the login tool (no arguments; browser stubbed by
// test/fixtures/fake-browser.mjs through TEAM_RELAY_OPEN_COMMAND) signs in to the configured
// relay only, stores the credential and the stream loop starts without a restart; a
// credential stored by another session is picked up too; whoami says who you became; there
// is no logout tool, and dist/logout.js (/team-relay:logout) signs out; a refused credential
// is not retried in a loop.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCredential } from '../src/credentials.js';
import { FakeRelay } from './helpers/fake-relay.js';
import { DIST, FIXTURES, browserLog as browserLogEntries, sleep, spawnServer, textOf, waitFor, type Spawned } from './helpers/mcp.js';

let relay: FakeRelay;
let xdg: string;
let browserLog: string;
const open: Spawned[] = [];

beforeEach(async () => {
  relay = await new FakeRelay().start();
  xdg = mkdtempSync(join(tmpdir(), 'team-relay-chlogin-'));
  browserLog = join(xdg, 'browser.log');
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await relay.stop();
});

const credFile = () => join(xdg, 'team-relay', 'credentials.json');

async function asker(extra: Record<string, string> = {}) {
  const s = await spawnServer('channel.js', {
    RELAY_ROLE: 'asker',
    // No RELAY_AUTH or RELAY_TEAM: the plugin as installed (M5-SPEC §6). RELAY_URL names the
    // fake relay, the one way to configure another relay (§9 item 1).
    RELAY_AUTH: '',
    RELAY_URL: relay.url,
    XDG_CONFIG_HOME: xdg,
    TEAM_RELAY_OPEN_COMMAND: join(FIXTURES, 'fake-browser.mjs'),
    FAKE_BROWSER_LOG: browserLog,
    ...extra,
  });
  open.push(s);
  return s;
}

async function call(s: Spawned, name: string, args: Record<string, unknown> = {}) {
  const r = await s.client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: textOf(r) };
}

const statusNotes = (s: Spawned) => s.notifications.filter((n) => n.meta.type === 'status');

/** Poll an async condition until it gives a value. */
async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** /team-relay:logout: `node dist/logout.js`, as the command runs it. */
function runLogout(extra: Record<string, string> = {}) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [join(DIST, 'logout.js'), ...(extra.ARG ? [extra.ARG] : [])],
      { env: { PATH: process.env.PATH ?? '', HOME: xdg, XDG_CONFIG_HOME: xdg, ...extra }, encoding: 'utf8', timeout: 20_000 },
      (err, stdout, stderr) => resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe('asker channel before sign-in', () => {
  it('starts, and every teammate tool says Not connected: run /team-relay:login', async () => {
    const s = await asker();
    for (const name of ['list_teammates', 'ask_question', 'invoke_capability', 'request_status']) {
      const r = await call(s, name, name === 'ask_question' ? { to: ['bob'], question: 'hi' } : {});
      expect(r.isError, name).toBe(true);
      expect(r.text).toBe('Not connected: run /team-relay:login');
    }
    const who = JSON.parse((await call(s, 'whoami')).text);
    expect(who).toEqual({ connected: false, message: 'Not connected: run /team-relay:login' });
    // Waiting quietly: nothing is asked of any relay.
    await sleep(300);
    expect(relay.requests).toEqual([]);
    expect(s.client.getInstructions()).toMatch(/type="status" events come from this plugin itself/);
  });
});

describe('login tool (M5-SPEC §2, §6, §9)', () => {
  it('returns the sign-in URL at once, stores the credential, and starts the stream without a restart', async () => {
    const s = await asker();
    const r = await call(s, 'login');
    expect(r.isError, r.text).toBe(false);
    const res = JSON.parse(r.text);
    expect(res.status).toBe('waiting_for_browser');
    expect(res.relay_url).toBe(relay.url);
    expect(res.sign_in_url.startsWith(`${relay.url}/v1/login/start?port=`)).toBe(true);
    // §9 item 3: the result tells the model never to repeat the sign-in URL to anyone else.
    expect(res.sign_in_url_rule).toMatch(/for the user of this session only/);
    expect(res.sign_in_url_rule).toMatch(/Never repeat it to anyone else, never put it in a message to a teammate or in any tool call/);

    const note = await waitFor(() => statusNotes(s).find((n) => /Connected as/.test(n.content)), 10_000, 'the signed-in status');
    expect(note.content).toBe('team-relay: Connected as alice (alice@example.com) on team demo. Teammate tools are ready.');
    expect(note.meta).toEqual({ type: 'status' });

    // Stored with the right modes, never shown.
    expect(lstatSync(credFile()).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(xdg, 'team-relay')).mode & 0o777).toBe(0o700);
    const stored = JSON.parse(readFileSync(credFile(), 'utf8'));
    expect(stored.email).toBe('alice@example.com');
    expect(r.text).not.toContain(stored.credential);

    // The browser got the URL from a file, never from its arguments. (It logs after the
    // sign-in has ended here: it is another process, so wait for its line.)
    const entry = (await browserLogEntries(browserLog))[0] as { argv: string[]; url: string };
    expect(entry.argv).toHaveLength(1);
    expect(entry.argv[0]).not.toContain('login');
    expect(entry.url).toBe(res.sign_in_url);

    // Connected: whoami, the tools, and the replies stream.
    const who = await waitForConnected(s);
    expect(who).toMatchObject({ message: 'Connected as alice (alice@example.com) on team demo', email: 'alice@example.com', member: 'alice', team: 'demo' });
    expect(who.changed).toBeUndefined();
    const teammates = await call(s, 'list_teammates');
    expect(teammates.isError, teammates.text).toBe(false);
    const env = relay.enqueue('alice', 'replies', { type: 'answer', from: 'bob', data: { text: 'hello from bob' } });
    await waitFor(() => s.notifications.find((n) => n.meta.message_id === env.id), 10_000, 'the pushed answer');
    expect(relay.requests.filter((r) => r.path.startsWith('/v1/teams/')).every((r) => r.headers.authorization === `Bearer ${stored.credential}`)).toBe(true);
  });

  it('takes no arguments: a relay URL from the model is refused before anything happens (§9 item 1)', async () => {
    const s = await asker();
    const tools = await s.client.listTools();
    const login = tools.tools.find((t) => t.name === 'login')!;
    expect(login.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    for (const args of [{ relay_url: 'https://evil.example.com' }, { relay_url: relay.url }, { extra: 1 }]) {
      const r = await call(s, 'login', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).toMatch(/login takes no arguments.*only by RELAY_URL in the environment/);
    }
    await sleep(200);
    expect(existsSync(browserLog)).toBe(false);
    expect(relay.requests).toEqual([]);
  });

  it('refuses to replace a credential from another relay than the configured one, with a clear message', async () => {
    writeCredential(credFile(), {
      relay_url: 'https://other-relay.example.com',
      team: 'demo',
      member: 'alice',
      credential: `trc_${'L'.repeat(43)}`,
      expires_at: null,
    });
    const before = readFileSync(credFile(), 'utf8');
    const s = await asker();
    const r = await call(s, 'login');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^not signed in: this computer is signed in to another relay \(https:\/\/other-relay\.example\.com\) than the one configured for this session/);
    expect(r.text).toMatch(/run \/team-relay:logout first, then \/team-relay:login/);
    expect(r.text).not.toContain('L'.repeat(43));
    await sleep(200);
    expect(existsSync(browserLog)).toBe(false);
    expect(relay.requests.some((x) => x.path.startsWith('/v1/login/'))).toBe(false);
    expect(readFileSync(credFile(), 'utf8')).toBe(before);
  });

  it('says plainly when the new sign-in is a different member than the one it replaced', async () => {
    const token = relay.mintCredential('bob');
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'bob', credential: token, expires_at: null, email: 'bob@example.com' });
    const s = await asker();
    await waitForConnected(s);
    await call(s, 'login');
    const note = await waitFor(() => statusNotes(s).find((n) => /Connected as alice/.test(n.content)), 10_000, 'the signed-in status');
    expect(note.content).toBe(
      'team-relay: Connected as alice (alice@example.com) on team demo. Teammate tools are ready. ' +
        'This is a different member than before: this computer was signed in as bob on team demo, and is now alice on team demo. ' +
        'If you did not mean to switch, run /team-relay:logout.',
    );
    const who = await poll(async () => {
      const w = JSON.parse((await call(s, 'whoami')).text);
      return w.connected && w.member === 'alice' ? w : null;
    }, 10_000, 'connected as alice');
    expect(who.changed).toMatch(/different member than before/);
  });

  it('says "Connected as <member> on team <team>" when the relay does not report the email yet', async () => {
    relay.loginEmail = null;
    const s = await asker();
    await call(s, 'login');
    const note = await waitFor(() => statusNotes(s).find((n) => /Connected as/.test(n.content)), 10_000, 'the signed-in status');
    expect(note.content).toBe('team-relay: Connected as alice on team demo. Teammate tools are ready.');
    expect((await waitForConnected(s)).message).toBe('Connected as alice on team demo');
  });

  it('a sign-in the relay refuses says so on the channel and stores nothing', async () => {
    relay.loginRefusal = { status: 400, error: 'invalid_grant' };
    const s = await asker();
    await call(s, 'login');
    const note = await waitFor(() => statusNotes(s).find((n) => /did not complete/.test(n.content)), 10_000, 'the failure status');
    expect(note.content).toMatch(/400 invalid_grant/);
    expect(existsSync(credFile())).toBe(false);
    expect(JSON.parse((await call(s, 'whoami')).text).connected).toBe(false);
  });

  it('a callback with the wrong state does not end the sign-in, and whoami never repeats the URL', async () => {
    const s = await asker({ FAKE_BROWSER_MODE: 'wrong-state' });
    await call(s, 'login');
    const entry = (await browserLogEntries(browserLog))[0] as { steps: Array<{ status: number }> };
    expect(entry.steps.at(-1)!.status).toBe(404);
    await sleep(300);
    expect(statusNotes(s)).toEqual([]);
    const who = JSON.parse((await call(s, 'whoami')).text);
    expect(who).toEqual({ connected: false, message: 'Not connected: run /team-relay:login', sign_in_pending: true });
    expect(existsSync(credFile())).toBe(false);
  });

  it('a cancel on the chooser says so on the channel, and a later login works', async () => {
    relay.loginCancel = true;
    const s = await asker();
    await call(s, 'login');
    const note = await waitFor(() => statusNotes(s).find((n) => /did not complete/.test(n.content)), 10_000, 'the cancel status');
    expect(note.content).toMatch(/sign-in cancelled in the browser/);
    relay.loginCancel = false;
    await call(s, 'login');
    await waitFor(() => statusNotes(s).find((n) => /Connected as alice/.test(n.content)), 10_000, 'the signed-in status');
  });

  it('refuses a configured relay URL that is not https', async () => {
    const s = await asker({ RELAY_URL: 'http://relay.example.com' });
    const r = await call(s, 'login');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/https/);
  });
});

async function waitForConnected(s: Spawned) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const who = JSON.parse((await call(s, 'whoami')).text);
    if (who.connected) return who;
    if (Date.now() > deadline) throw new Error(`not connected: ${JSON.stringify(who)}`);
    await sleep(100);
  }
}

describe('a credential stored by another session, whoami and /team-relay:logout', () => {
  it('connects as soon as the file appears; whoami names relay, team, member and account; there is no logout tool', async () => {
    const s = await asker();
    await sleep(200);
    const token = relay.mintCredential('bob');
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'bob', credential: token, expires_at: '2026-12-23T00:00:00Z', email: 'bob@example.com' });
    const who = await waitForConnected(s);
    expect(who).toMatchObject({
      connected: true,
      message: 'Connected as bob (bob@example.com) on team demo',
      relay_url: relay.url,
      team: 'demo',
      member: 'bob',
      email: 'bob@example.com',
      signed_in_with: 'device credential (/team-relay:login)',
      credential_expires_at: '2026-12-23T00:00:00Z',
    });
    expect(JSON.stringify(who)).not.toContain(token);

    // §9 item 2: logout is not a tool the model can call.
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('logout');
    const r = await call(s, 'logout');
    expect(r.isError).toBe(true);
    expect(r.text).toBe('unknown tool: logout');
    expect(existsSync(credFile())).toBe(true);
    expect(relay.revoked).toEqual([]);

    // /team-relay:logout: revoked at the relay, deleted here, and the session goes back to waiting.
    const out = await runLogout();
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toBe(
      "team-relay: signed out of team demo as bob (bob@example.com). The relay revoked this computer's credential, and it was deleted here. Run /team-relay:login to sign in again.\n",
    );
    expect(out.stdout + out.stderr).not.toContain(token);
    expect(relay.revoked).toEqual([token]);
    expect(existsSync(credFile())).toBe(false);
    await poll(async () => ((await call(s, 'list_teammates')).text === 'Not connected: run /team-relay:login' ? true : null), 10_000, 'back to waiting');
    const again = await runLogout();
    expect(again).toMatchObject({ status: 0, stdout: 'team-relay: not signed in on this computer; nothing to do.\n' });
  });

  it('/team-relay:logout sends the credential only to its own relay, whatever RELAY_URL says', async () => {
    const token = relay.mintCredential('alice');
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'alice', credential: token, expires_at: null });
    const out = await runLogout({ RELAY_URL: 'https://evil.example.com', RELAY_TEAM: 'other' });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^team-relay: signed out of team demo as alice\. The relay revoked/);
    expect(relay.revoked).toEqual([token]);
    expect(existsSync(credFile())).toBe(false);
  });

  it('/team-relay:logout still signs out when the relay is unreachable or no longer knows the credential', async () => {
    const stale = relay.mintCredential('alice');
    relay.credentials.delete(stale);
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'alice', credential: stale, expires_at: null });
    const refused = await runLogout();
    expect(refused.status).toBe(0);
    expect(refused.stdout).toMatch(/The relay no longer accepted this credential, and it was deleted here/);
    expect(existsSync(credFile())).toBe(false);

    writeCredential(credFile(), { relay_url: 'http://127.0.0.1:9', team: 'demo', member: 'alice', credential: `trc_${'U'.repeat(43)}`, expires_at: null });
    const unreachable = await runLogout();
    expect(unreachable.status).toBe(0);
    expect(unreachable.stdout).toMatch(/The relay did not revoke it \(.*\), so the credential expires on its own, and it was deleted here/);
    expect(unreachable.stdout).not.toContain('U'.repeat(43));
    expect(existsSync(credFile())).toBe(false);
  });

  it('/team-relay:logout deletes a credential file that must not be used, without sending it anywhere', async () => {
    const token = relay.mintCredential('alice');
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'alice', credential: token, expires_at: null });
    const { chmodSync } = await import('node:fs');
    chmodSync(credFile(), 0o644);
    const out = await runLogout();
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/signed out on this computer\. The stored sign-in could not be used \(the credential file has mode 644/);
    expect(existsSync(credFile())).toBe(false);
    expect(relay.revoked).toEqual([]);
    expect(relay.requests).toEqual([]);
    // Arguments are refused: the command runs it with none.
    const withArg = await runLogout({ ARG: 'https://evil.example.com' });
    expect(withArg.status).toBe(2);
  });

  it('a credential the relay refuses is not retried in a loop, and a new login connects', async () => {
    const s = await asker();
    const stale = relay.mintCredential('alice');
    relay.credentials.delete(stale);
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'alice', credential: stale, expires_at: null });
    await waitFor(() => relay.requests.some((r) => r.path === '/v1/teams/demo/me'), 10_000, 'the first /me');
    await sleep(4500);
    const tries = relay.requests.filter((r) => r.path === '/v1/teams/demo/me').length;
    expect(tries).toBe(1);
    const who = JSON.parse((await call(s, 'whoami')).text);
    expect(who.connected).toBe(false);
    expect(who.message).toMatch(/run \/team-relay:login again/);
    const r = await call(s, 'list_teammates');
    expect(r.text).toMatch(/run \/team-relay:login again/);

    // A new login replaces the file: connected, no restart.
    await call(s, 'login');
    await waitForConnected(s);
  });

  it('a credential revoked while connected: one status line, no retry loop', async () => {
    const s = await asker();
    const token = relay.mintCredential('alice');
    writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'alice', credential: token, expires_at: null });
    await waitForConnected(s);
    relay.credentials.delete(token);
    const note = await waitFor(() => statusNotes(s).find((n) => /refused your sign-in/.test(n.content)), 40_000, 'the refused status');
    expect(note.content).toMatch(/run \/team-relay:login again/);
    const count = relay.requests.length;
    await sleep(3000);
    expect(relay.requests.length).toBe(count);
  }, 60_000);
});
