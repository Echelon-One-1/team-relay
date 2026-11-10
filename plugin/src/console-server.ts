// The console server (M2-SPEC §4.4), run by bin/console:
//
//   node dist/console-server.js [--demo] [--open]
//
// Binds 127.0.0.1 only (CONSOLE_PORT, default 4317; 0 picks a free one) and prints
// http://127.0.0.1:<port>/#k=<key> on stdout, where the key is 32 random bytes made for this
// launch. The console reads the key from the URL fragment (never sent to a server) and sends
// it as X-Console-Key. Without --demo it proxies its reads, and an owner's roster changes
// (M6-SPEC §3), to the relay with this member's own sign-in: the credential /team-relay:login
// stored (M5-SPEC §6), or RELAY_URL, RELAY_TEAM, RELAY_AUTH, RELAY_GCLOUD_ACCOUNT,
// RELAY_TOKEN / RELAY_TOKEN_FILE; with --demo it serves a synthetic team instead.
//
// CONSOLE_MODE=hosted (M3-SPEC §3, the container only): listens on 0.0.0.0:$PORT, prints no
// URL and makes no key. IAP is the gate: every request must carry a valid IAP assertion for
// IAP_AUDIENCE and a Host equal to CONSOLE_PUBLIC_HOST; the viewer's email is forwarded to
// the relay as X-Relay-On-Behalf-Of, with the service account's own ID token
// (RELAY_AUTH=metadata). It serves every team the viewer is on (M9-SPEC §5; RELAY_TEAM is the
// default one) and creates teams for them, sending the relay a salted hash of the viewer's
// address (CONSOLE_IP_HASH_SALT, at least 32 characters, required). Behind Google's external
// Application Load Balancer (M10-SPEC §5) CONSOLE_PROXY_HOPS=2 says the balancer appends two
// X-Forwarded-For entries, so the viewer's address is the second from the right (default 1:
// Cloud Run's own front end only, allowed only when CONSOLE_PUBLIC_HOST is a run.app host;
// any other public host without CONSOLE_PROXY_HOPS refuses to start, M10-SPEC §7.7). No flags
// are accepted in hosted mode.
//
// Both modes answer GET /api/join themselves (the console's join panel): the relay and team,
// JOIN_MARKETPLACE (optional; GitHub owner/repo or an https URL: what `/plugin marketplace
// add` takes) and JOIN_REPO_URL (optional; an https URL, else a startup error), or demo
// values with --demo.

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEMO_JOIN,
  checkIpHashSalt,
  checkJoinMarketplace,
  checkJoinRepoUrl,
  checkProxyHops,
  checkPublicHost,
  createConsoleServer,
  demoBackend,
  joinInfo,
  relayBackend,
  type ConsoleBackend,
  type JoinInfo,
} from './console-app.js';
import { DemoAccount } from './console-demo.js';
import { openInBrowser } from './console-open.js';
import { readApprovalsState, statePath } from './approvals-state.js';
import { IapKeySet, checkIapAudience, iapVerifier } from './iap.js';
import { makeLogger } from './log.js';
import { NotConnected, authModeFromEnv, configValue, relayClientFromEnv } from './relay-client.js';
import { describeError } from './tool-util.js';

const log = makeLogger('console');
const DEFAULT_PORT = 4317;

const USAGE = `usage: bin/console [--demo] [--open]
  --demo  serve synthetic teams (demo: alice, bob, carol) instead of calling the relay
  --open  open the console in the default browser (by way of a private, short-lived file)
Signs in as you with the credential /team-relay:login stored; nothing else is needed.
Environment: CONSOLE_PORT (default ${DEFAULT_PORT}; 0 picks a free port), and optionally
RELAY_URL, RELAY_TEAM, RELAY_AUTH (credential|google|token), RELAY_GCLOUD_ACCOUNT, RELAY_TOKEN_FILE or RELAY_TOKEN.
JOIN_MARKETPLACE (optional; GitHub owner/repo or https URL) and JOIN_REPO_URL (optional, https):
what the join panel tells new members to add as a plugin marketplace.
CONSOLE_MODE=hosted is for the container only (PORT, CONSOLE_PUBLIC_HOST, IAP_AUDIENCE,
CONSOLE_IP_HASH_SALT, CONSOLE_PROXY_HOPS, RELAY_URL, RELAY_TEAM, RELAY_AUTH=metadata, JOIN_MARKETPLACE,
JOIN_REPO_URL).`;

function fail(message: string, code = 1): never {
  process.stderr.write(`console: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): { demo: boolean; open: boolean } {
  const flags = { demo: false, open: false };
  for (const a of argv) {
    if (a === '--demo') flags.demo = true;
    else if (a === '--open') flags.open = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else fail(`unknown argument: ${a.slice(0, 60)}\n${USAGE}`, 2);
  }
  return flags;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) > 65535) fail('CONSOLE_PORT must be an integer from 0 to 65535');
  return Number(raw);
}

function parseHostedPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 8080;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) fail('PORT must be an integer from 1 to 65535');
  return Number(raw);
}

/** M3-SPEC §3: the hosted console, behind IAP, on Cloud Run. */
async function hosted(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0) fail('CONSOLE_MODE=hosted takes no arguments', 2);
  const env = process.env;
  const port = parseHostedPort(env.PORT);
  let publicHost: string;
  let audience: string;
  let backend: ConsoleBackend;
  let team: string;
  let join: JoinInfo;
  let ipHashSalt: string;
  let proxyHops: ReturnType<typeof checkProxyHops>;
  try {
    const repoUrl = checkJoinRepoUrl(env.JOIN_REPO_URL);
    const marketplace = checkJoinMarketplace(env.JOIN_MARKETPLACE);
    publicHost = checkPublicHost(configValue(env.CONSOLE_PUBLIC_HOST));
    audience = checkIapAudience(configValue(env.IAP_AUDIENCE));
    // M9-SPEC §7.6: the salt for the viewer's address the relay's creation limit counts.
    ipHashSalt = checkIpHashSalt(env.CONSOLE_IP_HASH_SALT);
    // M10-SPEC §5: 2 behind the load balancer, which appends two X-Forwarded-For entries;
    // required when the public host is not run.app (§7.7).
    proxyHops = checkProxyHops(env.CONSOLE_PROXY_HOPS, publicHost);
    // The hosted console reads as the service account (a relay delegate), never with a
    // developer credential or a static token.
    if (authModeFromEnv(env) !== 'metadata') throw new Error('CONSOLE_MODE=hosted needs RELAY_AUTH=metadata');
    const client = relayClientFromEnv(env);
    backend = relayBackend(client);
    team = client.team;
    join = joinInfo(configValue(env.RELAY_URL) ?? '', team, repoUrl, marketplace);
  } catch (err) {
    fail(`configuration error: ${describeError(err)}`);
  }
  const keys = new IapKeySet({ log });
  const verify = iapVerifier({ audience, keys, log });
  const staticDir = fileURLToPath(new URL('./console/', import.meta.url));
  const app = createConsoleServer({ backend, hosted: { publicHost, verify, ipHashSalt, proxyHops }, staticDir, join, log });
  let bound: number;
  try {
    bound = await app.listen(port);
  } catch (err) {
    fail(`cannot listen on 0.0.0.0:${port} (${(err as NodeJS.ErrnoException).code ?? describeError(err)})`);
  }
  log(
    `hosted: serving the viewer's teams (default ${team}) for ${publicHost} on 0.0.0.0:${bound}, behind IAP${proxyHops === 2 ? ' on the load balancer' : ''}`,
  );
  const stop = () => {
    void app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main(): Promise<void> {
  const mode = configValue(process.env.CONSOLE_MODE) ?? 'local';
  if (mode === 'hosted') return hosted();
  if (mode !== 'local') fail('CONSOLE_MODE must be "local" or "hosted"', 2);
  const flags = parseArgs(process.argv.slice(2));
  const port = parsePort(process.env.CONSOLE_PORT);

  let repoUrl: string | null;
  let marketplace: string | null;
  try {
    repoUrl = checkJoinRepoUrl(process.env.JOIN_REPO_URL);
    marketplace = checkJoinMarketplace(process.env.JOIN_MARKETPLACE);
  } catch (err) {
    fail(`configuration error: ${describeError(err)}`);
  }

  let backend: ConsoleBackend;
  let label: string;
  let join: JoinInfo;
  if (flags.demo) {
    backend = demoBackend(new DemoAccount());
    label = 'demo teams (synthetic: alice, bob, carol)';
    join = DEMO_JOIN;
  } else {
    let client;
    try {
      client = relayClientFromEnv(process.env);
    } catch (err) {
      if (err instanceof NotConnected) fail('not signed in: run /team-relay:login in Claude Code first (or run with --demo)');
      fail(`configuration error: ${describeError(err)} (or run with --demo)`);
    }
    backend = relayBackend(client);
    label = `team ${client.team}`;
    join = joinInfo(client.url, client.team, repoUrl, marketplace);
  }

  const key = randomBytes(32).toString('base64url');
  const staticDir = fileURLToPath(new URL('./console/', import.meta.url));
  // M8-SPEC §5: the local console shows how many answers wait for this member's approval.
  const approvals = flags.demo
    ? undefined
    : () => ({ pending: readApprovalsState(statePath(process.env))?.pending ?? 0 });
  const app = createConsoleServer({ backend, key, staticDir, join, log, ...(approvals ? { approvals } : {}) });
  let bound: number;
  try {
    bound = await app.listen(port);
  } catch (err) {
    fail(`cannot listen on 127.0.0.1:${port} (${(err as NodeJS.ErrnoException).code ?? describeError(err)})`);
  }
  const url = `http://127.0.0.1:${bound}/#k=${key}`;
  log(`serving ${label} on 127.0.0.1:${bound}; stop with Ctrl-C`);
  process.stdout.write(`${url}\n`);
  // §7.7: by way of a private redirect file, so the key is in no process's arguments.
  if (flags.open) openInBrowser(url, { log });

  if (!flags.demo) {
    // A first read, so a misconfiguration shows here and not only in the browser.
    backend.me().then(
      () => log('the relay answered'),
      (err: unknown) => log(`the relay did not answer yet (${describeError(err)}); the console will show it as unreachable`),
    );
  }

  const stop = () => {
    void app.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => fail(`fatal: ${describeError(err)}`));
