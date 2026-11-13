// The setup page of /team-relay:setup: the console server, started inside the relay MCP server
// on the member's own Mac (127.0.0.1, a free port, a fresh 32-byte key), with the setup page's
// routes (local-setup.ts), opened in the browser on its Setup view (/join) by way of the private
// redirect file (console-open.ts: the key is in no process's arguments).
//
// At most one runs: a second /team-relay:setup while it runs opens the same page again. It stops
// 3 s after the member presses Done, after 30 minutes without a request, or when the MCP server
// exits (stop()).

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readApprovalsState, statePath } from './approvals-state.js';
import { createConsoleServer, joinInfo, relayBackend, type ConsoleServer } from './console-app.js';
import { openInBrowser, type OpenOptions } from './console-open.js';
import { pluginRef } from './channel-mode.js';
import { createLocalSetup, type LocalSetupDeps } from './local-setup.js';
import type { RelayClient } from './relay-client.js';
import { backgroundInstalled, chooserAvailable, currentUid, findClaude, installBackground, osascriptChooser, uninstallBackground } from './setup-steps.js';
import { AgentError, type Exec } from './daemon-launch.js';

/** The page stops after this long without a request. */
export const SETUP_IDLE_MS = 30 * 60 * 1000;
/** And this long after Done (so the page's last answer arrives first). */
export const SETUP_DONE_STOP_MS = 3000;

/** Who the page is for: the signed-in member's relay client and who they are. */
export type SetupLive = { client: RelayClient; member: string; team: string; email: string | null };

/** Runs `fn` after `ms`; returns what cancels it. */
export type Schedule = (fn: () => void, ms: number) => () => void;

const realSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

export type SetupPagesOptions = {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  platform?: NodeJS.Platform;
  /** dist/console/ (the built page); default: beside this bundle. */
  staticDir?: string;
  /** How the page is opened (default: openInBrowser, by way of the private redirect file). */
  open?: (url: string) => void;
  /** Passed to openInBrowser (tests: the opener's runner). */
  openOptions?: Partial<OpenOptions>;
  schedule?: Schedule;
  /** Tests: launchctl, the waits between its calls, the user id and node for the background answerer. */
  exec?: Exec;
  sleep?: (ms: number) => Promise<void>;
  uid?: number;
  node?: string;
  /** Tests: what replaces the setup routes' Mac-side parts. */
  localDeps?: (live: SetupLive) => Partial<LocalSetupDeps>;
};

type Running = { app: ConsoleServer; url: string; member: string; team: string; cancelIdle: () => void; stopping: boolean };

export class SetupPages {
  private running: Running | null = null;
  private starting: Promise<{ url: string; reused: boolean }> | null = null;
  private readonly schedule: Schedule;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly o: SetupPagesOptions) {
    this.schedule = o.schedule ?? realSchedule;
    this.platform = o.platform ?? process.platform;
  }

  /** Whether a page is being served now. */
  get active(): boolean {
    return this.running !== null && !this.running.stopping;
  }

  /** Opens the setup page for `live`: the one running (reopened), else a new one. */
  async open(live: SetupLive): Promise<{ url: string; reused: boolean }> {
    if (this.starting) await this.starting.catch(() => undefined);
    const r = this.running;
    if (r && !r.stopping && r.member === live.member && r.team === live.team) {
      this.openUrl(r.url);
      this.touch(r);
      return { url: r.url, reused: true };
    }
    if (r) await this.stop();
    this.starting = this.start(live);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(live: SetupLive): Promise<{ url: string; reused: boolean }> {
    const { env, log } = this.o;
    const platform = this.platform;
    const key = randomBytes(32).toString('base64url');
    const client = live.client;
    let running: Running | null = null;
    const uid = this.o.uid ?? currentUid();
    const launchctl = this.o.exec ? { exec: this.o.exec } : {};
    const base: LocalSetupDeps = {
      env,
      platform,
      signedIn: { member: live.member, team: live.team, email: live.email },
      chooser: chooserAvailable(platform) ? osascriptChooser() : null,
      background: {
        installed: () => backgroundInstalled(env),
        install: async () => {
          const claude = findClaude(env);
          if (!claude) throw new AgentError('Claude Code was not found on this Mac, so it cannot answer in the background. Install Claude Code from claude.ai/download, then try again.');
          const { plugin, marketplace } = pluginRef(env);
          await installBackground({ env, uid, node: this.o.node ?? process.execPath, claude, pluginKey: `${plugin}@${marketplace}`, ...launchctl, ...(this.o.sleep ? { sleep: this.o.sleep } : {}) });
        },
        uninstall: () => uninstallBackground({ env, uid, ...launchctl }),
      },
      onDone: () => {
        if (running) this.schedule(() => void this.stopRunning(running!), SETUP_DONE_STOP_MS);
      },
      log,
    };
    const local = createLocalSetup({ ...base, ...(this.o.localDeps?.(live) ?? {}) });
    const app = createConsoleServer({
      backend: relayBackend(client),
      key,
      staticDir: this.o.staticDir ?? fileURLToPath(new URL('./console/', import.meta.url)),
      join: joinInfo(client.url, client.team, null),
      approvals: () => ({ pending: readApprovalsState(statePath(env))?.pending ?? 0 }),
      local,
      log,
    });
    const port = await app.listen(0);
    const url = `http://127.0.0.1:${port}/join#k=${key}`;
    running = { app, url, member: live.member, team: live.team, cancelIdle: () => {}, stopping: false };
    this.running = running;
    const r = running;
    app.server.on('request', () => this.touch(r));
    this.touch(r);
    log(`setup page: serving on 127.0.0.1:${port}`);
    this.openUrl(url);
    return { url, reused: false };
  }

  private openUrl(url: string): void {
    if (this.o.open) return this.o.open(url);
    openInBrowser(url, { log: this.o.log, title: 'Team setup', what: 'the setup page (run /team-relay:setup again)', ...this.o.openOptions });
  }

  /** A request: the idle stop is put off again. */
  private touch(r: Running): void {
    r.cancelIdle();
    r.cancelIdle = this.schedule(() => {
      this.o.log('setup page: stopped after 30 minutes without use');
      void this.stopRunning(r);
    }, SETUP_IDLE_MS);
  }

  private async stopRunning(r: Running): Promise<void> {
    if (r.stopping) return;
    r.stopping = true;
    r.cancelIdle();
    if (this.running === r) this.running = null;
    await r.app.close();
  }

  /** Stops the page, if one runs. */
  async stop(): Promise<void> {
    const r = this.running;
    if (r) await this.stopRunning(r);
  }
}
