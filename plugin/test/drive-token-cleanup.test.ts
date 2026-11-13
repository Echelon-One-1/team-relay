// The old Google Drive sign-in is removed from the Keychain (13 Nov 2026): a fake
// /usr/bin/security and a fake fetch, so nothing touches the real Keychain or Google.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOOGLE_REVOKE_URL, OLD_DRIVE_SERVICE, backoffPath, loginKeychainPath, removeOldDriveSignIn, removeOldDriveSignInWithin, type RevokeFetch, type SecurityRun } from '../src/drive-token-cleanup.js';

let home: string;
let env: NodeJS.ProcessEnv;
let KC: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tr-kc-'));
  env = { HOME: home };
  KC = join(home, 'Library', 'Keychains', 'login.keychain-db');
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
  writeFileSync(KC, '');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const TOKEN = '1//synthetic-refresh-token-0123456789';

/** A Keychain holding the given tokens under the old service, as /usr/bin/security answers. */
function keychain(tokens: string[], o: { deleteCode?: number; findCode?: number } = {}) {
  const items = [...tokens];
  const calls: string[][] = [];
  const run: SecurityRun = async (args) => {
    calls.push(args);
    expect(args).toContain(OLD_DRIVE_SERVICE);
    if (args[0] === 'find-generic-password') {
      if (o.findCode !== undefined) return { code: o.findCode, stdout: '' };
      return items.length ? { code: 0, stdout: `${items[0]}\n` } : { code: 44, stdout: '' };
    }
    if (args[0] === 'delete-generic-password') {
      if (o.deleteCode !== undefined) return { code: o.deleteCode, stdout: '' };
      if (!items.length) return { code: 44, stdout: '' };
      items.shift();
      return { code: 0, stdout: '' };
    }
    throw new Error(`unexpected security call ${args[0]}`);
  };
  return { run, calls, items };
}

function google(answer: { status: number; body?: unknown } | 'throws') {
  const calls: Array<{ url: string; body: string; method: string }> = [];
  const fetch: RevokeFetch = async (url, init) => {
    calls.push({ url, body: init.body, method: init.method });
    if (answer === 'throws') throw new Error('network down');
    return { status: answer.status, json: async () => answer.body ?? {} };
  };
  return { fetch, calls };
}

describe('removeOldDriveSignIn', () => {
  it('an old sign-in is revoked at Google with its token, then deleted; one line, no token', async () => {
    const kc = keychain([TOKEN]);
    const g = google({ status: 200 });
    const logs: string[] = [];
    expect(await removeOldDriveSignIn({ env, log: (l) => logs.push(l), platform: 'darwin', run: kc.run, fetch: g.fetch })).toBe('removed');
    expect(g.calls).toEqual([{ url: GOOGLE_REVOKE_URL, method: 'POST', body: `token=${encodeURIComponent(TOKEN)}` }]);
    expect(kc.items).toEqual([]);
    expect(kc.calls).toEqual([
      ['find-generic-password', '-s', OLD_DRIVE_SERVICE, '-w', KC],
      ['delete-generic-password', '-s', OLD_DRIVE_SERVICE, KC],
      ['find-generic-password', '-s', OLD_DRIVE_SERVICE, '-w', KC],
    ]);
    expect(logs).toEqual(['removed the old Google Drive sign-in from the Keychain (Google revoked it)']);
    expect(logs.join('\n')).not.toContain('synthetic-refresh-token');
  });

  it('a token Google already forgot (400 invalid_token) counts as revoked', async () => {
    const kc = keychain([TOKEN]);
    const logs: string[] = [];
    await removeOldDriveSignIn({ env, log: (l) => logs.push(l), platform: 'darwin', run: kc.run, fetch: google({ status: 400, body: { error: 'invalid_token' } }).fetch });
    expect(logs).toEqual(['removed the old Google Drive sign-in from the Keychain (Google revoked it)']);
  });

  it('when Google fails or cannot be reached the item is still deleted', async () => {
    for (const answer of [{ status: 500 }, { status: 400, body: { error: 'invalid_request' } }, 'throws'] as const) {
      const kc = keychain([TOKEN]);
      const g = google(answer);
      const logs: string[] = [];
      expect(await removeOldDriveSignIn({ env, log: (l) => logs.push(l), platform: 'darwin', run: kc.run, fetch: g.fetch })).toBe('removed');
      expect(g.calls).toHaveLength(1);
      expect(kc.items).toEqual([]);
      expect(logs).toEqual(['removed the old Google Drive sign-in from the Keychain (Google could not be asked to revoke it)']);
      expect(logs.join('\n')).not.toContain('synthetic-refresh-token');
    }
  });

  it('two old sign-ins are both revoked and deleted', async () => {
    const kc = keychain([TOKEN, `${TOKEN}-b`]);
    const g = google({ status: 200 });
    const logs: string[] = [];
    await removeOldDriveSignIn({ env, log: (l) => logs.push(l), platform: 'darwin', run: kc.run, fetch: g.fetch });
    expect(g.calls.map((c) => c.body)).toEqual([`token=${encodeURIComponent(TOKEN)}`, `token=${encodeURIComponent(`${TOKEN}-b`)}`]);
    expect(kc.items).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it('nothing there: one lookup, no call to Google, no line', async () => {
    const kc = keychain([]);
    const g = google({ status: 200 });
    const logs: string[] = [];
    expect(await removeOldDriveSignIn({ env, log: (l) => logs.push(l), platform: 'darwin', run: kc.run, fetch: g.fetch })).toBe('absent');
    expect(kc.calls).toEqual([['find-generic-password', '-s', OLD_DRIVE_SERVICE, '-w', KC]]);
    expect(g.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('the login Keychain is named from HOME (trimmed); with no such file under HOME nothing is run', async () => {
    expect(loginKeychainPath({ HOME: ` ${home} ` })).toBe(KC);
    rmSync(KC);
    const kc = keychain([TOKEN]);
    const g = google({ status: 200 });
    const logs: string[] = [];
    expect(await removeOldDriveSignIn({ env, log: (l) => logs.push(l), platform: 'darwin', run: kc.run, fetch: g.fetch })).toBe('no_keychain');
    expect(kc.calls).toEqual([]);
    expect(g.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('not macOS: nothing is run', async () => {
    const kc = keychain([TOKEN]);
    const g = google({ status: 200 });
    const logs: string[] = [];
    expect(await removeOldDriveSignIn({ env, log: (l) => logs.push(l), platform: 'linux', run: kc.run, fetch: g.fetch })).toBe('not_macos');
    expect(kc.calls).toEqual([]);
    expect(g.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('a Keychain that cannot be read or an item that cannot be deleted: one line without the token, tried again next start', async () => {
    const logs: string[] = [];
    const locked = keychain([TOKEN], { findCode: 51 });
    expect(await removeOldDriveSignIn({ env, log: (l) => logs.push(l), platform: 'darwin', run: locked.run, fetch: google({ status: 200 }).fetch })).toBe('failed');
    const stuck = keychain([TOKEN], { deleteCode: 1 });
    expect(await removeOldDriveSignIn({ env, log: (l) => logs.push(l), platform: 'darwin', run: stuck.run, fetch: google({ status: 200 }).fetch })).toBe('failed');
    expect(logs).toEqual([
      'could not check the Keychain for the old Google Drive sign-in (security exit 51); trying again next start',
      'could not remove the old Google Drive sign-in from the Keychain (security exit 1); trying again next start',
    ]);
    expect(logs.join('\n')).not.toContain('synthetic-refresh-token');
  });

  it('session start waits at most its cap for a Keychain that does not answer (a locked one shows a dialog)', async () => {
    const calls: string[][] = [];
    const hangs: SecurityRun = (args) => {
      calls.push(args);
      return new Promise(() => {});
    };
    const t0 = Date.now();
    expect(await removeOldDriveSignInWithin(150, { env, log: () => {}, platform: 'darwin', run: hangs, fetch: google({ status: 200 }).fetch })).toBe('still_running');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(calls).toHaveLength(1);
  });

  it('a lookup that timed out is remembered (a timestamp only, mode 600): skipped for a day, then tried again', async () => {
    const t = Date.parse('2026-11-13T09:00:00.000Z');
    let calls = 0;
    const slow: SecurityRun = async () => {
      calls++;
      return { code: 1, stdout: '', timedOut: true };
    };
    const logs: string[] = [];
    const run = (now: number) => removeOldDriveSignIn({ env, log: (l) => logs.push(l), platform: 'darwin', run: slow, fetch: google({ status: 200 }).fetch, now: () => now });
    expect(await run(t)).toBe('timed_out');
    expect(calls).toBe(1);
    const file = backoffPath(env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('2026-11-13T09:00:00.000Z\n');
    expect(logs).toEqual(['the Keychain did not answer in time (it may be locked); not looking for the old Google Drive sign-in again for a day']);
    expect(await run(t + 23 * 3_600_000)).toBe('backed_off');
    expect(calls).toBe(1);
    expect(await run(t + 25 * 3_600_000)).toBe('timed_out');
    expect(calls).toBe(2);
    // Once the Keychain answers, the note is gone.
    const kc = keychain([]);
    expect(await removeOldDriveSignIn({ env, log: () => {}, platform: 'darwin', run: kc.run, fetch: google({ status: 200 }).fetch, now: () => t + 50 * 3_600_000 })).toBe('absent');
    expect(existsSync(file)).toBe(false);
  });

  it('when the cap is reached the lookup is stopped and remembered as timed out', async () => {
    const stoppable: SecurityRun = (_args, signal) =>
      new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ code: 1, stdout: '', timedOut: true })));
    expect(await removeOldDriveSignInWithin(100, { env, log: () => {}, platform: 'darwin', run: stoppable, fetch: google({ status: 200 }).fetch })).toBe('timed_out');
    expect(existsSync(backoffPath(env))).toBe(true);
  });
});
