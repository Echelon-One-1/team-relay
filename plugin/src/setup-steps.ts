// The setup steps shared by the setup line (setup-cli.ts, in Terminal) and the setup page
// (local-setup.ts, on the member's own Mac in the browser): the Mac's folder chooser, adding a
// chosen folder to the list, saving the folders, and the background answerer's install and
// uninstall. One code path each, so both ways
// of setting up do exactly the same thing.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { configDir } from './answering-lock.js';
import { homeDir } from './boundary-set.js';
import { AgentError, agentPlistPath, installAgent, uninstallAgent, type Exec } from './daemon-launch.js';
import { answererNodeObtainable, ensureAnswererNode, findClaude, type FetchPinnedNode } from './locate.js';
import {
  MAX_FOLDERS,
  expandPath,
  memberFolderProblem,
  memberFoldersPath,
  readMemberSettings,
  teamSettings,
  withTeam,
  writeMemberSettings,
} from './member-folders.js';

// -- the Mac's folder chooser ----------------------------------------------------------------------

/** What the Mac's folder chooser gave: folders, a Cancel, or no chooser here (then the member types). */
export type ChooseResult = { kind: 'chosen'; paths: string[] } | { kind: 'cancelled' } | { kind: 'unavailable' };
export type FolderChooser = (prompt: string) => Promise<ChooseResult>;

/**
 * The AppleScript of the chooser. It brings its window to the front first (Terminal may be behind
 * the browser). The prompt is the run handler's argument, never part of the script text; each
 * chosen folder is turned into a POSIX path here, each followed by a NUL (a folder name may hold a
 * new line, never a NUL).
 */
export const CHOOSE_FOLDER_SCRIPT = [
  'on run argv',
  'activate',
  'set chosen to choose folder with prompt (item 1 of argv) with multiple selections allowed',
  'set out to ""',
  'repeat with f in chosen',
  'set out to out & (POSIX path of (f as alias)) & (character id 0)',
  'end repeat',
  'return out',
  'end run',
];
export const OSASCRIPT = '/usr/bin/osascript';
/** A chooser left open this long closes, and the member types the folders instead. */
export const CHOOSER_TIMEOUT_MS = 10 * 60 * 1000;

export type ExecFileLike = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
  cb: (err: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => void,
) => void;

/**
 * The folders in osascript's output: NUL-separated, with the one new line osascript adds at the
 * end dropped; a trailing slash dropped (but never from "/").
 */
export function chosenPaths(stdout: string): string[] {
  return stdout
    .replace(/\n$/, '')
    .split('\0')
    .filter((p) => p !== '')
    .map((p) => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p));
}

const runExecFile: ExecFileLike = (f, a, o, cb) => void execFile(f, a, o, (e, out, err) => cb(e, String(out), String(err)));

/**
 * The Mac's own folder chooser: osascript, run directly (no shell), with the prompt as an
 * argument. Cancel (AppleScript error -128) is a Cancel; any other failure (no osascript, no
 * screen to show it on, left open past CHOOSER_TIMEOUT_MS) means the member types the folders.
 */
export function osascriptChooser(run: ExecFileLike = runExecFile): FolderChooser {
  return (prompt) =>
    new Promise((resolve) => {
      const args = CHOOSE_FOLDER_SCRIPT.flatMap((line) => ['-e', line]);
      args.push(prompt);
      try {
        run(OSASCRIPT, args, { timeout: CHOOSER_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (!err) resolve({ kind: 'chosen', paths: chosenPaths(stdout) });
          else if (/\(-128\)/.test(stderr)) resolve({ kind: 'cancelled' });
          else resolve({ kind: 'unavailable' });
        });
      } catch {
        resolve({ kind: 'unavailable' });
      }
    });
}

/** Whether this computer has the Mac's folder chooser. */
export function chooserAvailable(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' && existsSync(OSASCRIPT);
}

/** The Mac's chooser here, or one that is always unavailable. */
export function defaultChooser(platform: NodeJS.Platform): FolderChooser {
  if (!chooserAvailable(platform)) return async () => ({ kind: 'unavailable' });
  return osascriptChooser();
}

// -- folder lists ----------------------------------------------------------------------------------

/** What adding one folder to the list did. */
export type AddOutcome = { kind: 'added' } | { kind: 'refused'; reason: string } | { kind: 'duplicate' } | { kind: 'full' };

/**
 * Adds `raw` to `out` (in place) when it can be used: it passes the folder rules
 * (memberFolderProblem), is not in the list already (the same text, or the same folder once ~
 * is expanded), and the list has room (MAX_FOLDERS).
 */
export function addFolder(out: string[], raw: string, env: NodeJS.ProcessEnv): AddOutcome {
  const { reason } = memberFolderProblem(raw, env);
  if (reason) return { kind: 'refused', reason };
  const target = expandPath(raw, env);
  if (out.some((e) => e === raw || expandPath(e, env) === target)) return { kind: 'duplicate' };
  if (out.length >= MAX_FOLDERS) return { kind: 'full' };
  out.push(raw);
  return { kind: 'added' };
}

/**
 * Reads the member's folders for `team` afresh (the file may have changed meanwhile; an earlier
 * plugin's lists are never part of it, member-folders.ts), lets `change` work out the new
 * list, and stores this team as `folders` alone (atomically, mode 600; its earlier lists leave
 * the file), keeping the other teams as they were. Returns
 * the list as stored. Throws MemberFoldersError when the file must not be used.
 */
export function saveTeamFolders(env: NodeJS.ProcessEnv, team: string, change: (current: string[]) => string[]): string[] {
  const file = memberFoldersPath(env);
  const fresh = readMemberSettings(file, env);
  const next = change(teamSettings(fresh, team).folders);
  writeMemberSettings(file, withTeam(fresh, team, { folders: next }), env);
  return [...next];
}

// -- the background answerer -----------------------------------------------------------------------

export type BackgroundInput = {
  env: NodeJS.ProcessEnv;
  uid: number;
  /** The absolute path of node, for the LaunchAgent. */
  node: string;
  /** The absolute path of claude. */
  claude: string;
  /** `team-relay@<marketplace name>`: the key the plugin is installed under. */
  pluginKey: string;
  exec?: Exec;
  sleep?: (ms: number) => Promise<void>;
};

/** Writes and loads the background answerer's LaunchAgent (throws AgentError on failure). */
export async function installBackground(i: BackgroundInput): Promise<void> {
  const xdg = i.env.XDG_CONFIG_HOME?.trim();
  await installAgent({
    home: homeDir(i.env),
    configDir: configDir(i.env),
    node: i.node,
    claude: i.claude,
    uid: i.uid,
    pluginKey: i.pluginKey,
    ...(i.exec ? { exec: i.exec } : {}),
    ...(i.sleep ? { sleep: i.sleep } : {}),
    ...(xdg && xdg.startsWith('/') ? { xdgConfigHome: xdg } : {}),
  });
}

/** Stops and removes it; whether anything was there. */
export function uninstallBackground(i: { env: NodeJS.ProcessEnv; uid: number; exec?: Exec }): Promise<boolean> {
  return uninstallAgent({ home: homeDir(i.env), configDir: configDir(i.env), uid: i.uid, ...(i.exec ? { exec: i.exec } : {}) });
}

/** Why background answering cannot be turned on here: not a Mac. */
export const BACKGROUND_MAC_ONLY = 'Background answering works on a Mac only.';
/** Why background answering cannot be turned on here: no Claude Code found. */
export const BACKGROUND_NO_CLAUDE = 'Background answering needs Claude Code, which was not found on this Mac.';

/** Why background answering cannot be turned on here: no Node.js to run it with. */
export const BACKGROUND_NO_NODE = 'Background answering needs Node.js, which could not be found or downloaded on this Mac.';

/** Whether background answering can be turned on here, and why not when it cannot. */
export function backgroundAvailability(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  find: (env: NodeJS.ProcessEnv) => string | null = findClaude,
  node: (env: NodeJS.ProcessEnv) => boolean = (e) => answererNodeObtainable({ env: e }),
): { available: true } | { available: false; reason: string } {
  if (platform !== 'darwin') return { available: false, reason: BACKGROUND_MAC_ONLY };
  if (!find(env)) return { available: false, reason: BACKGROUND_NO_CLAUDE };
  if (!node(env)) return { available: false, reason: BACKGROUND_NO_NODE };
  return { available: true };
}

/**
 * The node for the background answerer (locate.ts ensureAnswererNode: the pinned private copy,
 * got first when missing; else a stable PATH node). Throws AgentError when there is none.
 */
export async function backgroundNode(env: NodeJS.ProcessEnv, fetch?: FetchPinnedNode): Promise<string> {
  const node = await ensureAnswererNode({ env, ...(fetch ? { fetch } : {}) });
  if (!node) throw new AgentError(BACKGROUND_NO_NODE);
  return node;
}

/** Whether the background answerer's LaunchAgent is installed for this member. */
export function backgroundInstalled(env: NodeJS.ProcessEnv): boolean {
  return existsSync(agentPlistPath(homeDir(env)));
}

/** This process's user id (-1 when unknown). */
export function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}


/** Where claude is (locate.ts): PATH, ~/.local/bin, ~/.claude/local, then the Claude desktop app's own. */
export { findClaude };
