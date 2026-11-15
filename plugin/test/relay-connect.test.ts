// connectOnce (relay-connect.ts) says which credential file it read: the fingerprint the
// asker channel (channel.ts) and the background answerer (daemon-core.ts) compare the file
// with afterwards. Regression: they took the fingerprint before the read, so a sign-in stored
// between the two was used but recorded as "no file"; the next look took it for yet another
// sign-in and dropped the connection, and a credential revoked meanwhile then went unreported
// on the channel (channel-login.test.ts, "a credential revoked while connected").

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as credentials from '../src/credentials.js';
import { connectOnce, otherRelayProblem, otherRelayUnreachable, staleSignIn } from '../src/relay-connect.js';
import { createServer } from 'node:net';
import { RelayError, RelayNetworkError, type Connection } from '../src/relay-client.js';
import { FakeRelay } from './helpers/fake-relay.js';

// The real module, with credentialFingerprint observable: a test can store a sign-in right
// after the first look at the file, as another process may.
vi.mock('../src/credentials.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/credentials.js')>();
  return { ...real, credentialFingerprint: vi.fn(real.credentialFingerprint) };
});
const fingerprint = vi.mocked(credentials.credentialFingerprint);
const { credentialFingerprint: realFingerprint } = await vi.importActual<typeof import('../src/credentials.js')>('../src/credentials.js');

let relay: FakeRelay;
let xdg: string;
const env = () => ({ XDG_CONFIG_HOME: xdg, HOME: xdg, PATH: process.env.PATH ?? '' });
const credFile = () => join(xdg, 'team-relay', 'credentials.json');

beforeEach(async () => {
  relay = await new FakeRelay().start();
  xdg = mkdtempSync(join(tmpdir(), 'team-relay-connect-'));
  fingerprint.mockClear();
});
afterEach(async () => {
  fingerprint.mockImplementation(realFingerprint);
  await relay.stop();
  rmSync(xdg, { recursive: true, force: true });
});

function store(member: string) {
  const token = relay.mintCredential(member);
  credentials.writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member, credential: token, expires_at: null });
  return token;
}

describe('connectOnce: the fingerprint of the credential file it read', () => {
  it('is the file it connected with', async () => {
    store('alice');
    const a = await connectOnce(env());
    expect(a.kind).toBe('connected');
    expect(a.fingerprint).toBe(realFingerprint(credFile()));
  });

  it('is null when there is no file', async () => {
    const a = await connectOnce(env());
    expect(a).toEqual({ kind: 'not_signed_in', fingerprint: null });
  });

  it('a sign-in stored right after the first look: the fingerprint is of that sign-in, not of "no file"', async () => {
    // The first look finds no file; the sign-in lands before the read (another process).
    fingerprint.mockImplementationOnce((path) => {
      const before = realFingerprint(path);
      store('alice');
      return before;
    });
    const a = await connectOnce(env());
    expect(a.kind).toBe('connected');
    if (a.kind === 'connected') expect(a.me.member).toBe('alice');
    expect(a.fingerprint).not.toBeNull();
    expect(a.fingerprint).toBe(realFingerprint(credFile()));
  });

  it('a sign-in replaced right after the first look: the fingerprint and the member are of the newer one', async () => {
    store('bob');
    fingerprint.mockImplementationOnce((path) => {
      const before = realFingerprint(path);
      store('alice');
      return before;
    });
    const a = await connectOnce(env());
    expect(a.kind).toBe('connected');
    if (a.kind === 'connected') expect(a.me.member).toBe('alice');
    expect(a.fingerprint).toBe(realFingerprint(credFile()));
  });

  it('a refused credential: the fingerprint is of the refused file, so it is not tried again', async () => {
    fingerprint.mockImplementationOnce((path) => {
      const before = realFingerprint(path);
      relay.credentials.delete(store('alice'));
      return before;
    });
    const a = await connectOnce(env());
    expect(a.kind).toBe('refused');
    expect(a.fingerprint).toBe(realFingerprint(credFile()));
  });

  it('a file that keeps changing while it is read is not used', async () => {
    store('alice');
    let n = 0;
    fingerprint.mockImplementation(() => `changing-${n++}`);
    const a = await connectOnce(env());
    expect(a.kind).toBe('config');
    if (a.kind === 'config') expect(a.problem).toMatch(/kept changing while it was read/);
    expect(relay.requests).toEqual([]);
  });
});

// 15 Nov 2026, a real Mac: the stored sign-in named a relay and a team that no longer exist, and
// /team-relay:setup dead-ended on the 404. Such a sign-in is "stale": setup signs in again
// against the configured relay. Only a 404, or a relay other than the configured one that cannot
// be reached; never a 401/403 or a network error at the configured relay.
describe('connectOnce: a stale sign-in', () => {
  it('a team the relay does not know (404): unreachable and stale, with the fingerprint of that file', async () => {
    credentials.writeCredential(credFile(), { relay_url: relay.url, team: 'gone', member: 'bob', credential: relay.mintCredential('bob'), expires_at: null });
    const a = await connectOnce({ ...env(), RELAY_URL: relay.url });
    expect(a).toMatchObject({ kind: 'unreachable', stale: true, fingerprint: realFingerprint(credFile()) });
  });

  it('a 404 at the configured relay that is not its own answer (no not_found): not stale', async () => {
    store('alice');
    relay.fail(() => true, 404, 1, {});
    const a = await connectOnce({ ...env(), RELAY_URL: relay.url });
    expect(a.kind).toBe('unreachable');
    expect('stale' in a).toBe(false);
  });

  it('a 401 at the configured relay is refused, not stale', async () => {
    credentials.writeCredential(credFile(), { relay_url: relay.url, team: 'demo', member: 'bob', credential: `trc_${'Z'.repeat(43)}`, expires_at: null });
    const a = await connectOnce({ ...env(), RELAY_URL: relay.url });
    expect(a.kind).toBe('refused');
    expect('stale' in a).toBe(false);
  });

  it('the configured relay not answering is not stale', async () => {
    relay.fail(() => true, 503);
    store('alice');
    const a = await connectOnce({ ...env(), RELAY_URL: relay.url });
    expect(a.kind).toBe('unreachable');
    expect('stale' in a).toBe(false);
  });
});

describe('connectOnce: signed in to another relay that is not answering', () => {
  it('not stale: unreachable, saying it is signed in to another team relay (its host) and how to switch', async () => {
    const port = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    credentials.writeCredential(credFile(), { relay_url: `http://127.0.0.1:${port}`, team: 'demo', member: 'bob', credential: `trc_${'Q'.repeat(43)}`, expires_at: null });
    // No RELAY_URL: the configured relay is the plugin's default, another one.
    const a = await connectOnce(env());
    expect(a).toMatchObject({ kind: 'unreachable', otherRelay: true, problem: otherRelayProblem(`http://127.0.0.1:${port}`) });
    expect('stale' in a).toBe(false);
    expect(otherRelayProblem(`http://127.0.0.1:${port}`)).toBe(
      `this Mac is signed in to another team relay (127.0.0.1:${port}) that isn't answering right now; try again later, or run /team-relay:logout first to switch`,
    );
  });
});

describe('staleSignIn: only a 404 from the saved relay', () => {
  const cred = (url: string): Connection => ({ mode: 'credential', url, team: 'demo', member: 'bob', token: { get: async () => 'x' } } as unknown as Connection);
  const configured = 'https://relay.example.com';
  const net = new RelayNetworkError('relay unreachable (ENOTFOUND)');

  it('the configured relay: only its own JSON 404 (not_found), never another 404 (a proxy, a host in front of it)', () => {
    expect(staleSignIn(new RelayError(404, 'not_found', ''), cred(configured), configured)).toBe(true);
    expect(staleSignIn(new RelayError(404, 'not_found', ''), cred(`${configured}/`), configured)).toBe(true);
    expect(staleSignIn(new RelayError(404, 'http_404', ''), cred(configured), configured)).toBe(false);
    expect(staleSignIn(new RelayError(404, 'page_missing', ''), cred(configured), configured)).toBe(false);
  });

  // The real case, 15 Nov 2026: a deleted Cloud Run service answers Google's HTML 404 (http_404).
  it('a saved relay other than the configured one: any 404', () => {
    expect(staleSignIn(new RelayError(404, 'http_404', ''), cred('https://old.example.com'), configured)).toBe(true);
    expect(staleSignIn(new RelayError(404, 'not_found', ''), cred('https://old.example.com'), configured)).toBe(true);
  });

  it('no configured relay to compare with: only the relay\'s own not_found', () => {
    expect(staleSignIn(new RelayError(404, 'not_found', ''), cred('https://old.example.com'), null)).toBe(true);
    expect(staleSignIn(new RelayError(404, 'http_404', ''), cred('https://old.example.com'), null)).toBe(false);
  });

  // Security review, 15 Nov 2026: a short outage must not let setup replace a working sign-in
  // for another relay without the member choosing to switch.
  it('never a network error, at the configured relay or another one', () => {
    expect(staleSignIn(net, cred(configured), configured)).toBe(false);
    expect(staleSignIn(net, cred('https://old.example.com'), configured)).toBe(false);
  });

  it('never a 401, a 403 or a 5xx', () => {
    for (const status of [401, 403, 500, 503]) {
      expect(staleSignIn(new RelayError(status, 'x', ''), cred(configured), configured)).toBe(false);
      expect(staleSignIn(new RelayError(status, 'x', ''), cred('https://old.example.com'), configured)).toBe(false);
    }
  });

  it('only a device credential from /team-relay:login', () => {
    const token = { ...cred('https://old.example.com'), mode: 'token' } as Connection;
    expect(staleSignIn(new RelayError(404, 'not_found', ''), token, configured)).toBe(false);
  });
});

describe('otherRelayUnreachable', () => {
  const cred = (url: string): Connection => ({ mode: 'credential', url, team: 'demo', member: 'bob', token: { get: async () => 'x' } } as unknown as Connection);
  const configured = 'https://relay.example.com';
  const net = new RelayNetworkError('relay unreachable (ENOTFOUND)');

  it('a network error at a saved relay other than the configured one', () => {
    expect(otherRelayUnreachable(net, cred('https://old.example.com'), configured)).toBe(true);
    expect(otherRelayUnreachable(net, cred(configured), configured)).toBe(false);
    expect(otherRelayUnreachable(net, cred(`${configured}/`), configured)).toBe(false);
    expect(otherRelayUnreachable(net, cred('https://old.example.com'), null)).toBe(false);
    expect(otherRelayUnreachable(new RelayError(404, 'not_found', ''), cred('https://old.example.com'), configured)).toBe(false);
    expect(otherRelayUnreachable(net, { ...cred('https://old.example.com'), mode: 'token' } as Connection, configured)).toBe(false);
  });
});
