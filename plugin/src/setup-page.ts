// The setup page of /team-relay:setup: the console server, started inside the relay MCP server
// on the member's own Mac (127.0.0.1, a free port, a fresh 32-byte key), with the setup page's
// routes (local-setup.ts), opened in the browser on its Setup view (/join) by way of the private
// redirect file (console-open.ts: the key is in no process's arguments).
//
// At most one runs: a second /team-relay:setup while it runs opens the same page again (and waits
// for the same Done: `done` says how the page ended, to every call waiting on it). It stops
// 3 s after the member presses Done (from that moment it is no longer the page a new
// /team-relay:setup opens: that one gets a fresh server), after 30 minutes without a request, or
// when the MCP server exits (stop()).
//
// The background answerer it installs runs the pinned private node, got first through
// bin/run-node --fetch-only when it is missing; only when that fails a node on PATH whose name is
// not under a version folder (locate.ts ensureAnswererNode); never this process's resolved node,
// which a Homebrew or version-manager upgrade removes.

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readApprovalsState, statePath } from './approvals-state.js';
import { createConsoleServer, joinInfo, relayBackend, type ConsoleServer } from './console-app.js';
import { openInBrowser, type OpenOptions } from './console-open.js';
import { pluginRef } from './channel-mode.js';
import { createLocalSetup, type LocalSetupDeps } from './local-setup.js';
import { memberFoldersPath, readTeamSettings } from './member-folders.js';
import type { RelayClient } from './relay-client.js';
import type { FetchPinnedNode } from './locate.js';
import { backgroundAvailability, backgroundInstalled, backgroundNode, chooserAvailable, currentUid, findClaude, installBackground, osascriptChooser, uninstallBackground } from './setup-steps.js';
import { AgentError, type Exec } from './daemon-launch.js';

/** The page stops after this long without a request. */
export const SETUP_IDLE_MS = 30 * 60 * 1000;
/** And this long after Done (so the page's last answer arrives first). */
export const SETUP_DONE_STOP_MS = 3000;

/** Who the page is for: the signed-in member's relay client and who they are. */
export type SetupLive = { client: RelayClient; member: string; team: string; email: string | null };

/**
 * How a setup page ended: Done pressed (the team, how many folders the member's Claude answers
 * from, null when the file cannot be read, and whether background answering is installed), or
 * the page closed without Done (30 minutes idle, replaced for another member, the server stopping).
 */
export type SetupDone = { kind: 'done'; team: string; folders: number | null; background: boolean } | { kind: 'closed' };

/** What open() gives: the page's URL, whether it was the one already running, and how it ends. */
export type OpenedPage = { url: string; reused: boolean; done: Promise<SetupDone> };

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
  /** Tests: what gets the pinned node (default: bin/run-node --fetch-only). */
  fetchNode?: FetchPinnedNode;
  /** Tests: what replaces the setup routes' Mac-side parts. */
  localDeps?: (live: SetupLive) => Partial<LocalSetupDeps>;
};

type Running = {
  app: ConsoleServer;
  url: string;
  member: string;
  team: string;
  cancelIdle: () => void;
  /** Cancels the stop scheduled at Done. */
  cancelDone: () => void;
  /** Done was pressed or a stop began: never reused. */
  stopping: boolean;
  closed: boolean;
  /** Settles once: at Done, or 'closed' when the page stops without it. */
  done: Promise<SetupDone>;
  settle: (d: SetupDone) => void;
};

export class SetupPages {
  private running: Running | null = null;
  /** Pages whose member pressed Done: they close shortly (or at stop()). */
  private readonly finishing = new Set<Running>();
  private starting: Promise<OpenedPage> | null = null;
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
  async open(live: SetupLive): Promise<OpenedPage> {
    if (this.starting) await this.starting.catch(() => undefined);
    const r = this.running;
    if (r && !r.stopping && r.member === live.member && r.team === live.team) {
      this.openUrl(r.url);
      this.touch(r);
      return { url: r.url, reused: true, done: r.done };
    }
    if (r) await this.stop();
    this.starting = this.start(live);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start(live: SetupLive): Promise<OpenedPage> {
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
        availability: () => backgroundAvailability(platform, env),
        installed: () => backgroundInstalled(env),
        install: async () => {
          const claude = findClaude(env);
          if (!claude) throw new AgentError('Claude Code was not found on this Mac, so it cannot answer in the background. Install Claude Code from claude.ai/download, then try again.');
          const { plugin, marketplace } = pluginRef(env);
          await installBackground({ env, uid, node: this.o.node ?? (await backgroundNode(env, this.o.fetchNode)), claude, pluginKey: `${plugin}@${marketplace}`, ...launchctl, ...(this.o.sleep ? { sleep: this.o.sleep } : {}) });
        },
        uninstall: () => uninstallBackground({ env, uid, ...launchctl }),
      },
      onDone: () => {
        if (running) this.finish(running, summary());
      },
      log,
    };
    const deps: LocalSetupDeps = { ...base, ...(this.o.localDeps?.(live) ?? {}) };
    // What the setup tool says at Done: counts and on/off only, never a folder's path.
    const summary = (): SetupDone => {
      let folders: number | null;
      try {
        folders = readTeamSettings(memberFoldersPath(env), env, live.team).folders.length;
      } catch {
        folders = null;
      }
      let background = false;
      try {
        background = deps.background.installed();
      } catch {
        background = false;
      }
      return { kind: 'done', team: live.team, folders, background };
    };
    const local = createLocalSetup(deps);
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
    let settle!: (d: SetupDone) => void;
    const done = new Promise<SetupDone>((resolve) => (settle = resolve));
    running = { app, url, member: live.member, team: live.team, cancelIdle: () => {}, cancelDone: () => {}, stopping: false, closed: false, done, settle };
    this.running = running;
    const r = running;
    app.server.on('request', () => this.touch(r));
    this.touch(r);
    log(`setup page: serving on 127.0.0.1:${port}`);
    this.openUrl(url);
    return { url, reused: false, done };
  }

  private openUrl(url: string): void {
    if (this.o.open) return this.o.open(url);
    openInBrowser(url, { log: this.o.log, title: 'Team setup', what: 'the setup page (run /team-relay:setup again)', ...this.o.openOptions });
  }

  /** A request: the idle stop is put off again. */
  private touch(r: Running): void {
    if (r.stopping) return;
    r.cancelIdle();
    r.cancelIdle = this.schedule(() => {
      this.o.log('setup page: stopped after 30 minutes without use');
      void this.stopRunning(r);
    }, SETUP_IDLE_MS);
  }

  /** Done: no longer the page to reopen; it closes after SETUP_DONE_STOP_MS (its last answer first). */
  private finish(r: Running, summary: SetupDone): void {
    if (r.stopping) return;
    r.stopping = true;
    r.settle(summary);
    r.cancelIdle();
    if (this.running === r) this.running = null;
    this.finishing.add(r);
    r.cancelDone = this.schedule(() => void this.stopRunning(r), SETUP_DONE_STOP_MS);
  }

  private async stopRunning(r: Running): Promise<void> {
    if (r.closed) return;
    r.closed = true;
    r.stopping = true;
    // After Done this does nothing (a promise settles once).
    r.settle({ kind: 'closed' });
    r.cancelIdle();
    r.cancelDone();
    this.finishing.delete(r);
    if (this.running === r) this.running = null;
    await r.app.close();
  }

  /** Stops the page, if one runs, and any still closing after Done. */
  async stop(): Promise<void> {
    const all = [...this.finishing, ...(this.running ? [this.running] : [])];
    await Promise.all(all.map((r) => this.stopRunning(r)));
  }
}
