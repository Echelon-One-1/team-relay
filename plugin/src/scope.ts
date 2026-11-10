// The scope folder (M8-SPEC §1, §7 item 3): the working session's folder, which its automatic
// answerer may read without asking. It is the channel server's working directory, resolved.
// It qualifies only when it is inside a git work tree (a `.git` in it, or in an ancestor that
// is below $HOME: never $HOME's own, never one above it), is not /, $HOME or an ancestor of
// $HOME, is not a direct child of $HOME, is not under ~/Library or any ~/.* entry and does not
// contain one (symlinks resolved both ways), and is not inside the credential deny list or the
// team relay's or Claude Code's config directories. Otherwise the host still answers but with
// no automatic folder access (every read needs the member's approval) and shares no folder.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { configDir } from './answering-lock.js';
import { credentialsPath } from './credentials.js';
import { credentialHit, realOr, within } from './deny-list.js';

export type Scope = {
  /** The resolved folder. */
  path: string;
  /** Whether reads inside it are automatic. */
  qualifies: boolean;
  /** Why it does not qualify (null when it does). */
  reason: string | null;
  /** The name published as a share (M4-SPEC §3), only when it qualifies. */
  share: string | null;
};

/** The team relay's own credential directories: its config dir and wherever the credential file is. */
export function relayCredentialDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = [configDir(env)];
  try {
    dirs.push(dirname(credentialsPath(env)));
  } catch {
    // a relative RELAY_CREDENTIALS_FILE is refused where it is used
  }
  return [...new Set(dirs)];
}

/** The share name for a folder: its basename in the manifest's share-name alphabet. */
export function shareName(path: string): string {
  return basename(path).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'folder';
}

export function scopeFolder(cwd: string, env: NodeJS.ProcessEnv): Scope {
  const { path, reason } = folderSafety(cwd, env);
  const refuse = (why: string): Scope => ({ path, qualifies: false, reason: why, share: null });
  if (reason) return refuse(reason);
  const homeReal = realOr(env.HOME?.trim() || homedir());
  if (!inGitWorkTree(path, homeReal)) return refuse('it is not inside a git work tree (no .git in it or in a folder above it, below your home directory)');
  return { path, qualifies: true, reason: null, share: shareName(path) };
}

/**
 * The folder rules every automatically readable folder follows (M8-SPEC §7 item 3, M10-SPEC §2),
 * except the git work tree rule: the folder resolved (symlinks), and why it must not be read
 * automatically (null: it may be). Not /, $HOME or above it, not directly in $HOME, not under
 * or containing ~/Library or any ~/.* entry, not inside a configuration directory or the
 * credential deny list.
 */
export function folderSafety(cwd: string, env: NodeJS.ProcessEnv): { path: string; reason: string | null } {
  const path = realOr(cwd);
  const refuse = (reason: string) => ({ path, reason });
  if (!isAbsolute(path)) return refuse('it is not an absolute path');
  try {
    if (!statSync(path).isDirectory()) return refuse('it is not a directory');
  } catch {
    return refuse('it does not exist');
  }
  const home = env.HOME?.trim() || homedir();
  const homeReal = realOr(home);
  if (path === '/') return refuse('it is the root directory');
  if (path === homeReal || normalize(cwd) === normalize(home)) return refuse('it is your home directory');
  if (within(homeReal, path) || within(normalize(home), path)) return refuse('it contains your home directory');
  const configDirs = [join(homeReal, '.claude'), join(homeReal, '.claude-team-relay'), ...relayCredentialDirs(env).map(realOr)];
  const claudeConfig = env.CLAUDE_CONFIG_DIR?.trim();
  if (claudeConfig && isAbsolute(claudeConfig)) configDirs.push(realOr(claudeConfig));
  for (const d of configDirs) {
    if (within(path, d)) return refuse(`it is inside a configuration directory (${d})`);
  }
  const cloudsdk = env.CLOUDSDK_CONFIG?.trim();
  const hit = credentialHit(path, {
    home,
    cloudsdkConfig: cloudsdk && isAbsolute(cloudsdk) ? cloudsdk : undefined,
    credentialDirs: relayCredentialDirs(env),
  });
  if (hit) return refuse(`it is inside a credential location on the deny list (${hit})`);
  if (dirname(path) === homeReal || dirname(normalize(cwd)) === normalize(home)) return refuse('it is a folder directly in your home directory');
  const hidden = homeEntries(homeReal);
  for (const e of hidden) {
    if (within(path, e.path) || within(path, e.real)) return refuse(`it is inside ~/${e.name}`);
    if (within(e.real, path)) return refuse(`it contains ~/${e.name}`);
  }
  return { path, reason: null };
}

/** ~/Library and every ~/.* entry, with where each resolves to. */
function homeEntries(homeReal: string): Array<{ name: string; path: string; real: string }> {
  let names: string[];
  try {
    names = readdirSync(homeReal);
  } catch {
    names = [];
  }
  // Library is checked even when it cannot be listed.
  const wanted = new Set(['Library', ...names.filter((n) => n.startsWith('.') && n !== '.' && n !== '..')]);
  return [...wanted].map((name) => {
    const path = join(homeReal, name);
    return { name, path, real: realOr(path) };
  });
}

/**
 * A `.git` (a directory, or the file a linked work tree or submodule has) in `path` or in a
 * folder above it, looking no higher than the last folder below $HOME (and never at /).
 */
export function inGitWorkTree(path: string, homeReal: string): boolean {
  for (let d = path; ; d = dirname(d)) {
    if (d === '/' || within(homeReal, d)) return false;
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}
