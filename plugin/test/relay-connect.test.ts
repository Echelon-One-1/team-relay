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
import { connectOnce } from '../src/relay-connect.js';
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
