// `node dist/drive-cli.js [status | connect [email] | disconnect]`: /team-relay:drive
// (M10-SPEC §2a). A command the member runs, never a tool the model can call: nothing a
// teammate writes can connect or disconnect their Drive.
//
// Prints one line on stdout. Exit 0: done (or nothing to do); 1: it did not work; 2: usage.
// Never prints a token.

import { EMAIL_RE } from './credentials.js';
import { DriveConnectError, MAC_ONLY, driveDisconnect, driveStatus, startDriveConnect, teamDriveDomain } from './drive-login.js';
import { DriveReadError, KeychainError, defaultKeychain, fetchDriveClient, type FetchLike, type Keychain } from './google-drive.js';
import { validBoundaries } from './boundary-set.js';

export const USAGE = 'usage: /team-relay:drive [status | connect [your-email] | disconnect]';

export type DriveCliRelay = {
  driveClient(): Promise<{ client_id: string; client_secret: string }>;
  /** The team's boundaries document, checked here (an M10-shaped one is read too). */
  boundaries(): Promise<unknown>;
};

export type DriveCliDeps = {
  platform?: NodeJS.Platform;
  keychain?: Keychain | null;
  relay?: () => DriveCliRelay;
  fetch?: FetchLike;
  open?: (url: string) => void;
  timeoutMs?: number;
  log?: (line: string) => void;
};

export type DriveCliOutcome = { exitCode: number; line: string };

type Parsed = { cmd: 'status' } | { cmd: 'disconnect' } | { cmd: 'connect'; email?: string };

/** The subcommand. `$ARGUMENTS` arrives split by the shell; anything unexpected is usage. */
export function parseDriveArgs(argv: string[]): Parsed | null {
  const a = argv.filter((x) => x !== '');
  if (a.length === 0 || (a.length === 1 && a[0] === 'status')) return { cmd: 'status' };
  if (a.length === 1 && a[0] === 'disconnect') return { cmd: 'disconnect' };
  if (a[0] === 'connect' && a.length === 1) return { cmd: 'connect' };
  if (a[0] === 'connect' && a.length === 2 && a[1]!.length <= 254 && EMAIL_RE.test(a[1]!)) return { cmd: 'connect', email: a[1]!.toLowerCase() };
  return null;
}

async function defaultRelay(): Promise<DriveCliRelay> {
  const { relayClientFromEnv } = await import('./relay-client.js');
  const c = relayClientFromEnv(process.env, { attempts: 1, timeoutMs: 15_000 });
  return { driveClient: () => c.driveClient(), boundaries: () => c.boundaries() };
}

export async function runDriveCli(argv: string[], deps: DriveCliDeps = {}): Promise<DriveCliOutcome> {
  const parsed = parseDriveArgs(argv);
  if (!parsed) return { exitCode: 2, line: USAGE };
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return { exitCode: 1, line: MAC_ONLY };
  const keychain = deps.keychain === undefined ? defaultKeychain(platform) : deps.keychain;
  if (!keychain) return { exitCode: 1, line: MAC_ONLY };

  try {
    if (parsed.cmd === 'status') return { exitCode: 0, line: await driveStatus(keychain) };
    if (parsed.cmd === 'disconnect') return { exitCode: 0, line: await driveDisconnect(keychain, deps.fetch) };

    let relay: DriveCliRelay;
    try {
      relay = deps.relay ? deps.relay() : await defaultRelay();
    } catch {
      return { exitCode: 1, line: 'Not signed in to the team relay: run /team-relay:login first.' };
    }
    let tb: unknown;
    try {
      tb = await relay.boundaries();
    } catch {
      tb = null;
    }
    if (!validBoundaries(tb)) return { exitCode: 1, line: 'The team relay did not give your team\'s boundaries; try again later.' };
    // PICKERS-SPEC §6.2: the picked Drive folders and the legacy drives name the domains.
    const domain = teamDriveDomain(tb.boundaries ? [...tb.boundaries.drive_folders, ...tb.boundaries.drives] : [], parsed.email);
    const client = await fetchDriveClient(relay);
    const flow = await startDriveConnect({
      domain,
      client,
      keychain,
      ...(parsed.email ? { loginHint: parsed.email } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.open ? { open: deps.open } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
    const r = await flow.done;
    const was = r.replaced ? ` It replaced the connection for ${r.replaced}.` : '';
    return { exitCode: 0, line: `Google Drive connected as ${r.email} (read-only). The token is kept in this Mac's Keychain only.${was}` };
  } catch (err) {
    if (err instanceof DriveConnectError || err instanceof DriveReadError || err instanceof KeychainError) return { exitCode: 1, line: `Google Drive: ${err.message}` };
    return { exitCode: 1, line: 'Google Drive: that did not work; try again.' };
  }
}

if (process.argv[1] && /drive-cli\.[jt]s$/.test(process.argv[1])) {
  void runDriveCli(process.argv.slice(2), { log: (l) => process.stderr.write(`team-relay: ${l}\n`) }).then(
    ({ exitCode, line }) => {
      process.stdout.write(`${line}\n`);
      process.exitCode = exitCode;
    },
    () => {
      process.stdout.write('Google Drive: that did not work; try again.\n');
      process.exitCode = 1;
    },
  );
}
