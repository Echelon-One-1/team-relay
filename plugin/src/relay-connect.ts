// One attempt to connect to the relay as the stored sign-in (or the environment) says, shared by
// the channel server's asker connection (channel.ts, M5-SPEC §6) and the background answerer
// (daemon.ts, M11-SPEC §1): read the connection, make the client, ask GET /me and check the answer.
// What the caller does with the outcome (wait for a new sign-in, back off, connect) is its own.

import { MEMBER_RE, NotConnected, RelayClient, RelayError, configValue, connectionFromEnv, type Connection, type Me } from './relay-client.js';
import type { HostConnection } from './answer-host.js';
import { describeError } from './tool-util.js';

export type ConnectAttempt =
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
  | { kind: 'wrong_team'; problem: string };

export async function connectOnce(env: NodeJS.ProcessEnv, opts: { timeoutMs?: number } = {}): Promise<ConnectAttempt> {
  let c: Connection;
  try {
    c = connectionFromEnv(env);
  } catch (err) {
    return err instanceof NotConnected ? { kind: 'not_signed_in' } : { kind: 'config', problem: describeError(err) };
  }
  let client: RelayClient;
  try {
    client = new RelayClient({ url: c.url, team: c.team, token: c.token });
  } catch (err) {
    return { kind: 'config', problem: describeError(err) };
  }
  let me: Me;
  try {
    me = await client.me({ attempts: 1, timeoutMs: opts.timeoutMs ?? 15_000 });
  } catch (err) {
    if (err instanceof RelayError && err.status === 401 && c.mode === 'credential') return { kind: 'refused' };
    return { kind: 'unreachable', problem: `the relay did not answer (${describeError(err)})` };
  }
  if (me.team !== client.team || !MEMBER_RE.test(me.member)) return { kind: 'wrong_team', problem: 'the relay answered for a different team' };
  return { kind: 'connected', client, me, connection: c };
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
