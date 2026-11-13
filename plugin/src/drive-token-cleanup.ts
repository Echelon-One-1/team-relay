// 13 Nov 2026: removes the Google Drive sign-in an earlier plugin kept in the macOS Keychain
// (service "team-relay-drive"). Google Drive is no longer read, so that refresh token is only a
// risk. Runs at daemon start and at session start, macOS only, and only on the member's login
// Keychain, named as a file from the home the plugin uses ($HOME/Library/Keychains/
// login.keychain-db; the earlier plugin stored the item in the default keychain, the login one):
// when that file is not there nothing runs. Otherwise one `security find-generic-password`
// lookup when the item is gone (exit 44), so it is cheap and safe to run every time. When an item is there: its token is read, Google is asked to revoke it (best
// effort, about 5 s; a failure is ignored) and the item is deleted, one item at a time, at most
// 20. /usr/bin/security runs through execFile, never a shell. The token is never logged or
// printed: the one line says only that the sign-in was removed and whether Google revoked it.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from './boundary-set.js';

export const OLD_DRIVE_SERVICE = 'team-relay-drive';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const SECURITY = '/usr/bin/security';
const ITEM_NOT_FOUND = 44;
const MAX_ITEMS = 20;
const REVOKE_TIMEOUT_MS = 5000;
// A token as Google issues it: printable, no space or control character.
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;

export type SecurityRun = (args: string[]) => Promise<{ code: number; stdout: string }>;
export type RevokeFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

const runSecurity: SecurityRun = (args) =>
  new Promise((resolve) => {
    const child = execFile(SECURITY, args, { shell: false, timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
    child.stdin?.end();
  });

/** Google says the token is gone on 200, or on 400 invalid_token (it already was). */
async function revoke(doFetch: RevokeFetch, token: string): Promise<boolean> {
  try {
    const r = await doFetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    if (r.status === 200) return true;
    if (r.status !== 400) return false;
    const j = (await r.json().catch(() => null)) as { error?: unknown } | null;
    return j?.error === 'invalid_token';
  } catch {
    return false;
  }
}

export type CleanupOutcome = 'not_macos' | 'no_keychain' | 'absent' | 'removed' | 'failed';

/** The member's login Keychain file, from the home the plugin uses. */
export function loginKeychainPath(env: NodeJS.ProcessEnv): string {
  return join(homeDir(env), 'Library', 'Keychains', 'login.keychain-db');
}

/**
 * Removes every old Google Drive sign-in from the Keychain. Logs one line when something was
 * there; nothing when it was not. Never throws.
 */
export async function removeOldDriveSignIn(o: { env: NodeJS.ProcessEnv; log: (line: string) => void; platform?: NodeJS.Platform; run?: SecurityRun; fetch?: RevokeFetch }): Promise<CleanupOutcome> {
  if ((o.platform ?? process.platform) !== 'darwin') return 'not_macos';
  const keychain = loginKeychainPath(o.env);
  try {
    if (!existsSync(keychain)) return 'no_keychain';
  } catch {
    return 'no_keychain';
  }
  const run = o.run ?? runSecurity;
  const doFetch = o.fetch ?? (globalThis.fetch as unknown as RevokeFetch);
  let removed = 0;
  let revoked = 0;
  try {
    for (let i = 0; i < MAX_ITEMS; i++) {
      // The one lookup: absent ends it at once.
      const found = await run(['find-generic-password', '-s', OLD_DRIVE_SERVICE, '-w', keychain]);
      if (found.code === ITEM_NOT_FOUND) break;
      if (found.code !== 0) {
        o.log(`could not check the Keychain for the old Google Drive sign-in (security exit ${found.code}); trying again next start`);
        return removed > 0 ? report() : 'failed';
      }
      const token = found.stdout.replace(/\r?\n$/, '');
      if (TOKEN_RE.test(token) && (await revoke(doFetch, token))) revoked++;
      const del = await run(['delete-generic-password', '-s', OLD_DRIVE_SERVICE, keychain]);
      if (del.code === ITEM_NOT_FOUND) break;
      if (del.code !== 0) {
        o.log(`could not remove the old Google Drive sign-in from the Keychain (security exit ${del.code}); trying again next start`);
        return removed > 0 ? report() : 'failed';
      }
      removed++;
    }
  } catch {
    o.log('could not check the Keychain for the old Google Drive sign-in; trying again next start');
    return removed > 0 ? report() : 'failed';
  }
  return removed > 0 ? report() : 'absent';

  function report(): CleanupOutcome {
    const google = revoked === removed ? 'Google revoked it' : revoked === 0 ? 'Google could not be asked to revoke it' : `Google revoked ${revoked} of ${removed}`;
    o.log(`removed the old Google Drive sign-in from the Keychain (${google})`);
    return 'removed';
  }
}
