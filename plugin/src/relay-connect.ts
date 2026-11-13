// One attempt to connect to the relay as the stored sign-in (or the environment) says, shared by
// the channel server's asker connection (channel.ts, M5-SPEC §6) and the background answerer
// (daemon.ts, M11-SPEC §1): read the connection, make the client, ask GET /me and check the answer.
// What the caller does with the outcome (wait for a new sign-in, back off, connect) is its own.

import { MEMBER_RE, NotConnected, RelayClient, RelayError, configValue, connectionFromEnv, type Connection, type Me } from './relay-client.js';
import type { HostConnection } from './answer-host.js';
import { credentialFingerprint, credentialsPath } from './credentials.js';
import { describeError } from './tool-util.js';

export type ConnectAttempt = (
  /** Connected: the client and who the relay says this is. */
  | { kind: 'connected'; client: RelayClient; me: Me; connection: Connection }
  /** No stored sign-in and nothing in the environment: wait for a sign-in. */
  | { kind: 'not_signed_in' }
  /** The environment or the credential file cannot be used. */
  | { kind: 'config'; problem: string }
  /** The relay refused the stored device credential (401): wait for a new sign-in, never retry it. */
  | { kind: 'refused' }
  /** The relay did not answer (or refused a sign-in that is not a device credential). */
  | { kind: 'unreachable'; problem: string }
  /** The relay answered for another team (or with a member id that is not one). */
  | { kind: 'wrong_team'; problem: string }
) & {
  /**
   * The credential file this attempt read (credentialFingerprint; null: there was none). The
   * caller compares the file with it later to notice a new sign-in or a sign-out. Taken apart
   * from the read, it could describe another file than the one used: a sign-in stored in
   * between would look like yet another one, and the connection would be dropped for it.
   */
  fingerprint: string | null;
};

/** How many times the read is repeated while the credential file keeps changing under it. */
const STABLE_READ_TRIES = 5;

/**
 * The connection the environment asks for, and the fingerprint of the credential file it was
 * read from: the file is fingerprinted before and after the (synchronous) read, and read
 * again while the two differ (a sign-in or sign-out in another process meanwhile). A sign-in
 * replaces the file whole (credentials.ts writeCredential), so the same fingerprint on both
 * sides means the read saw that very file.
 */
function readConnection(env: NodeJS.ProcessEnv): { fingerprint: string | null; connection: Connection | Error } {
  const path = credentialsPath(env);
  for (let tries = 1; ; tries++) {
    const before = credentialFingerprint(path);
    let connection: Connection | Error;
    try {
      connection = connectionFromEnv(env);
    } catch (err) {
      connection = err instanceof Error ? err : new Error(String(err));
    }
    const after = credentialFingerprint(path);
    if (before === after) return { fingerprint: after, connection };
    if (tries >= STABLE_READ_TRIES) return { fingerprint: after, connection: new Error('the credential file kept changing while it was read') };
  }
}

export async function connectOnce(env: NodeJS.ProcessEnv, opts: { timeoutMs?: number } = {}): Promise<ConnectAttempt> {
  const { fingerprint, connection: c } = readConnection(env);
  if (c instanceof NotConnected) return { kind: 'not_signed_in', fingerprint };
  if (c instanceof Error) return { kind: 'config', problem: describeError(c), fingerprint };
  let client: RelayClient;
  try {
    client = new RelayClient({ url: c.url, team: c.team, token: c.token });
  } catch (err) {
    return { kind: 'config', problem: describeError(err), fingerprint };
  }
  let me: Me;
  try {
    me = await client.me({ attempts: 1, timeoutMs: opts.timeoutMs ?? 15_000 });
  } catch (err) {
    if (err instanceof RelayError && err.status === 401 && c.mode === 'credential') return { kind: 'refused', fingerprint };
    return { kind: 'unreachable', problem: `the relay did not answer (${describeError(err)})`, fingerprint };
  }
  if (me.team !== client.team || !MEMBER_RE.test(me.member)) return { kind: 'wrong_team', problem: 'the relay answered for a different team', fingerprint };
  return { kind: 'connected', client, me, connection: c, fingerprint };
}

/** How an answer host's own servers reach the relay: the same way this process does. */
export function hostConnection(c: Connection, env: NodeJS.ProcessEnv, credentialsFile: string): HostConnection {
  return {
    mode: c.mode,
    url: c.url,
    team: c.team,
    ...(c.mode === 'credential' ? { credentialsFile } : {}),
    ...(c.mode === 'token' ? { tokenFile: configValue(env.RELAY_TOKEN_FILE), token: configValue(env.RELAY_TOKEN) } : {}),
    ...(c.mode === 'google' ? { gcloudAccount: configValue(env.RELAY_GCLOUD_ACCOUNT) } : {}),
  };
}
