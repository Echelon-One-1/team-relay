// The background answerer's LaunchAgent (M11-SPEC §1, §5): where the plugin is installed now,
// the launcher that runs the installed plugin's dist/daemon.js, and the per-user agent that runs
// the launcher. `setup-cli.js daemon install|uninstall` writes and removes them; the daemon reads
// the install path once a minute to notice an update.
//
//   ~/.config/team-relay/daemon-launch.mjs            mode 600 (XDG_CONFIG_HOME when absolute)
//   ~/Library/LaunchAgents/com.team-relay.answerer.plist   mode 600
//
// The launcher reads `installed_plugins.json` at each start, so a plugin update needs no new
// agent: the daemon exits 0 when the install path changes and launchd starts the launcher again.
// Every value in the plist is XML-escaped; launchctl is run by absolute path, with arguments only.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

export const AGENT_LABEL = 'com.team-relay.answerer';
export const LAUNCHER_FILE = 'daemon-launch.mjs';
export const LAUNCHCTL = '/bin/launchctl';
const PLUGIN_NAME = 'team-relay';

export type PluginEntry = { key: string; installPath: string; identity: string };

/** ~/.claude/plugins/installed_plugins.json for this home. */
export function installedPluginsPath(home: string): string {
  return join(home, '.claude', 'plugins', 'installed_plugins.json');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The user-scope install of the team-relay plugin in `installed_plugins.json`'s content
 * (`{"plugins": {"team-relay@<marketplace>": [{"scope": "user", "installPath": ...}]}}`); the most
 * recently updated one when several marketplaces carry it. Null when there is none. The
 * launcher (launcherSource) applies exactly this rule.
 */
export function pickPluginEntry(json: unknown): PluginEntry | null {
  if (!isObj(json) || !isObj(json.plugins)) return null;
  let best: { key: string; e: Record<string, unknown> } | null = null;
  for (const key of Object.keys(json.plugins).sort()) {
    if (!key.startsWith(`${PLUGIN_NAME}@`)) continue;
    const list = json.plugins[key];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!isObj(e) || e.scope !== 'user' || typeof e.installPath !== 'string' || !isAbsolute(e.installPath)) continue;
      const updated = typeof e.lastUpdated === 'string' ? e.lastUpdated : '';
      const bestUpdated = best && typeof best.e.lastUpdated === 'string' ? best.e.lastUpdated : '';
      if (!best || updated > bestUpdated) best = { key, e };
    }
  }
  if (!best) return null;
  const e = best.e;
  const path = e.installPath as string;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return { key: best.key, installPath: path, identity: [path, str(e.gitCommitSha), str(e.lastUpdated), str(e.version)].join('\n') };
}

/** The installed team-relay plugin for this home, or null (not installed, or the file cannot be read). */
export function readInstalledPlugin(home: string): PluginEntry | null {
  try {
    return pickPluginEntry(JSON.parse(readFileSync(installedPluginsPath(home), 'utf8')));
  } catch {
    return null;
  }
}

/** The launcher's source: finds the installed plugin (pickPluginEntry's rule) and imports its dist/daemon.js. */
export function launcherSource(): string {
  return `// The team relay's background answerer (written by setup-cli.js daemon install).
// At each start it finds where the team-relay plugin is installed now and runs its dist/daemon.js.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const home = process.env.HOME;
function pick(json) {
  if (!json || typeof json !== 'object' || !json.plugins || typeof json.plugins !== 'object' || Array.isArray(json.plugins)) return null;
  let best = null;
  for (const key of Object.keys(json.plugins).sort()) {
    if (!key.startsWith('${PLUGIN_NAME}@')) continue;
    const list = json.plugins[key];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e !== 'object' || e.scope !== 'user' || typeof e.installPath !== 'string' || !isAbsolute(e.installPath)) continue;
      const updated = typeof e.lastUpdated === 'string' ? e.lastUpdated : '';
      const bestUpdated = best && typeof best.lastUpdated === 'string' ? best.lastUpdated : '';
      if (!best || updated > bestUpdated) best = e;
    }
  }
  return best;
}
let entry = null;
try {
  if (home && isAbsolute(home)) entry = pick(JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')));
} catch {
  entry = null;
}
if (!entry) {
  process.stderr.write('team-relay: the plugin is not installed for this user; nothing to run\\n');
  process.exit(1);
}
await import(pathToFileURL(join(entry.installPath, 'dist', 'daemon.js')).href);
`;
}

/** A value for a plist <string>: XML-escaped. */
export function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export type AgentInput = {
  /** The absolute path of node. */
  node: string;
  /** The absolute path of the launcher. */
  launcher: string;
  /** The absolute path of claude. */
  claude: string;
  home: string;
  /** Set when the member's configuration lives in XDG_CONFIG_HOME (so the agent finds the sign-in there). */
  xdgConfigHome?: string;
};

/** PATH for the agent: node's folder, claude's folder, then /usr/bin:/bin (git lives there). */
export function agentPath(node: string, claude: string): string {
  const dirs = [dirname(node), dirname(claude), '/usr/bin', '/bin'];
  return dirs.filter((d, i) => dirs.indexOf(d) === i).join(':');
}

/** The LaunchAgent's plist (M11-SPEC §5). */
export function plistXml(i: AgentInput): string {
  const s = (v: string) => `<string>${xmlEscape(v)}</string>`;
  const env: Array<[string, string]> = [
    ['HOME', i.home],
    ['PATH', agentPath(i.node, i.claude)],
    ['TEAM_RELAY_CLAUDE_BIN', i.claude],
    ...(i.xdgConfigHome ? ([['XDG_CONFIG_HOME', i.xdgConfigHome]] as Array<[string, string]>) : []),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${s(AGENT_LABEL)}`,
    `  <key>ProgramArguments</key><array>${s(i.node)}${s(i.launcher)}</array>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>30</integer>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.map(([k, v]) => `    <key>${xmlEscape(k)}</key>${s(v)}`),
    '  </dict>',
    `  <key>StandardOutPath</key>${s('/dev/null')}`,
    `  <key>StandardErrorPath</key>${s('/dev/null')}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function agentPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

export function launcherPath(configDir: string): string {
  return join(configDir, LAUNCHER_FILE);
}

export type ExecResult = { code: number | null; stdout: string; stderr: string };
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

/** execFile, arguments only (never a shell), 15 s at most. */
export const defaultExec: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/** Why `path` is not an executable file that can be claude (null: it can). */
export function claudeProblem(path: string): string | null {
  if (!path || !isAbsolute(path)) return 'it is not an absolute path';
  try {
    if (!statSync(path).isFile()) return 'it is not a file';
    accessSync(path, constants.X_OK);
  } catch {
    return 'it does not exist or is not executable';
  }
  return null;
}

/** A directory we may create (mode 700); one that exists is used as it is, unless it is a symlink. */
function ensureDir(dir: string): void {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new AgentError(`${dir} is not a directory`);
    return;
  } catch (err) {
    if (err instanceof AgentError) throw err;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Write `text` to `path` atomically, mode 600, never through a symlink. */
function writePrivate(path: string, text: string): void {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) throw new AgentError(`${path} is not a regular file; refusing to replace it`);
  } catch (err) {
    if (err instanceof AgentError) throw err;
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw err instanceof AgentError ? err : new AgentError(`cannot write ${path} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}

export type InstallInput = {
  home: string;
  /** The team relay's configuration directory (answering-lock.ts configDir). */
  configDir: string;
  node: string;
  claude: string;
  uid: number;
  exec?: Exec;
  xdgConfigHome?: string;
};

/** Write the launcher and the agent (mode 600), then load it: bootout (when loaded), bootstrap. */
export async function installAgent(i: InstallInput): Promise<{ plist: string; launcher: string }> {
  const exec = i.exec ?? defaultExec;
  if (!isAbsolute(i.home)) throw new AgentError('HOME is not an absolute path');
  if (!isAbsolute(i.node)) throw new AgentError('the node path is not absolute');
  const bad = claudeProblem(i.claude);
  if (bad) throw new AgentError(`--claude ${i.claude} cannot be used: ${bad}`);
  if (!Number.isInteger(i.uid) || i.uid < 0) throw new AgentError('the user id is unknown');
  ensureDir(i.configDir);
  const launcher = launcherPath(i.configDir);
  writePrivate(launcher, launcherSource());
  const plist = agentPlistPath(i.home);
  ensureDir(dirname(plist));
  writePrivate(plist, plistXml({ node: i.node, launcher, claude: i.claude, home: i.home, ...(i.xdgConfigHome ? { xdgConfigHome: i.xdgConfigHome } : {}) }));
  // Not loaded yet is fine: bootout's answer is not checked.
  await exec(LAUNCHCTL, ['bootout', `gui/${i.uid}/${AGENT_LABEL}`]);
  const r = await exec(LAUNCHCTL, ['bootstrap', `gui/${i.uid}`, plist]);
  if (r.code !== 0) throw new AgentError(`launchctl bootstrap failed (exit ${r.code ?? 'unknown'}): ${r.stderr.trim().slice(0, 200) || 'no reason given'}`);
  return { plist, launcher };
}

/** Stop the agent (when loaded) and remove it and the launcher. Returns whether anything was there. */
export async function uninstallAgent(i: { home: string; configDir: string; uid: number; exec?: Exec }): Promise<boolean> {
  const exec = i.exec ?? defaultExec;
  await exec(LAUNCHCTL, ['bootout', `gui/${i.uid}/${AGENT_LABEL}`]);
  let found = false;
  for (const path of [agentPlistPath(i.home), launcherPath(i.configDir)]) {
    try {
      lstatSync(path);
      found = true;
    } catch {
      continue;
    }
    rmSync(path, { force: true });
  }
  return found;
}
