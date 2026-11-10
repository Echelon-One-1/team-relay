// `dist/daemon.js`: the background answerer (M11-SPEC §1), started by the per-user LaunchAgent
// through ~/.config/team-relay/daemon-launch.mjs (daemon-launch.ts). Everything it does is in
// daemon-core.ts; this file wires the process: the log file, SIGTERM (stop within 15 s) and the
// exit code (0 when stopped or when the plugin was updated, so launchd starts the new version).

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonLog, daemonLogPath, pluginVersion, runDaemon } from './daemon-core.js';
import { PLUGIN_KEY_ENV, PLUGIN_KEY_RE, readInstalledPlugin } from './daemon-launch.js';
import { homeDir } from './boundary-set.js';
import { describeError } from './tool-util.js';

const STOP_WITHIN_MS = 14_000;

const env = process.env;
const file = new DaemonLog(daemonLogPath(env));
const log = (line: string) => file.line(line);
const dist = dirname(fileURLToPath(import.meta.url));
const controller = new AbortController();

function stop(why: string): void {
  if (controller.signal.aborted) return;
  log(`stopping (${why})`);
  controller.abort();
  // Whatever happens, the process is gone within 15 s of SIGTERM.
  setTimeout(() => process.exit(0), STOP_WITHIN_MS).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('unhandledRejection', (err) => {
  log(`unexpected error: ${describeError(err)}`);
  process.exit(1);
});

const version = pluginVersion(dist);
const keyGiven = env[PLUGIN_KEY_ENV]?.trim() ?? '';
const pluginKey = PLUGIN_KEY_RE.test(keyGiven) ? keyGiven : null;
if (!pluginKey) log('not started by the launcher (no plugin key): updates of the plugin are not watched');
log(`starting the background answerer (version ${version}, pid ${process.pid})`);
runDaemon({
  env,
  log,
  dist,
  version,
  signal: controller.signal,
  // The launcher's key (daemon-launch.ts): the update check reads that install only.
  ...(pluginKey ? { installedIdentity: () => readInstalledPlugin(homeDir(env), pluginKey)?.identity ?? null } : {}),
}).then(
  (outcome) => {
    log(outcome === 'updated' ? 'exiting: the plugin was updated' : 'stopped');
    process.exit(0);
  },
  (err: unknown) => {
    log(`ended: ${describeError(err)}`);
    process.exit(1);
  },
);
