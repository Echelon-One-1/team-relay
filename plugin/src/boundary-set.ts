// What a member's automatic answerer may read for a team: the allowed set, recomputed at the
// start of every run from the folders the member chose for that team on this Mac
// (member-folders.ts; 13 Nov 2026, local folders only). The team's boundaries are its topic
// alone; nothing an owner picks is read.
//
// For each chosen folder (its canonical path, passing the folder rules, scope.ts folderSafety):
// - inside a git work tree: only the files git tracks (`git ls-files -z`, run with execFile,
//   never a shell; cached per work tree by HEAD and the index's stat), so ignored files such as
//   .env stay out;
// - otherwise every file below it (a capped walk, never through a symlink, node_modules or a dot
//   entry; files over 5 MB left out), except that a folder which is the top of a git work tree
//   (it holds a `.git` folder or file) is not walked into: that work tree's tracked files are
//   taken instead. Submodule checkouts and nested repositories are not followed through their
//   parent: each work tree stands on its own.
//
// Always out, at any depth: the credential deny list (deny-list.ts, also without regard to
// case), the sensitive names (read-trail-core.ts) and git's own files. Every file is held by its
// canonical path (realpath, which on macOS also fixes case): a file reached through a symlink is
// in only when the path it resolves to is itself in, so a symlink pointing outside the set is
// out. The secret screen (secret-screen.ts) then applies to whatever is read.

import { execFile } from 'node:child_process';
import { promises as fsp, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, normalize, relative, sep } from 'node:path';
import type { TeamBoundaries } from './boundaries-types.js';
import { readBoundaries, versionOk } from './boundaries-rule.js';
import { ANY_DEPTH, credentialHit, globRe, within } from './deny-list.js';
import { hasAccepted, memberFolderProblem, type TeamSettings } from './member-folders.js';
import { neutraliseChannelTags } from './notify.js';
import { sensitiveName } from './read-trail-core.js';
import { relayCredentialDirs } from './scope.js';

export type AreaKind = 'folder';

export type Area = {
  kind: AreaKind;
  /** How tools and people name it: "folder:<basename>" (made unique). */
  name: string;
  /** The canonical root folder. */
  root: string;
  /** Canonical absolute paths, sorted. */
  files: string[];
  /** Its walk or listing stopped at a cap. */
  truncated: boolean;
};

export type AllowedSet = {
  /** The boundaries version this set was built for. */
  version: number;
  areas: Area[];
  /** Canonical path → its area. */
  files: Map<string, Area>;
  /** Problems met while building it (a refused folders file, a folder that cannot be used). */
  notes: string[];
};

/** Files larger than this are left out of walked folders (git's tracked files are not capped). */
export const MAX_WALK_FILE_BYTES = 5 * 1024 * 1024;

export type Limits = {
  /** Files per walked folder. */
  walkFiles: number;
  /** Directories per walked folder. */
  walkDirs: number;
  walkDepth: number;
  /** Files in the whole set. */
  totalFiles: number;
  /** Wall-clock budget for one walk (ms). */
  walkMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  walkFiles: 20_000,
  walkDirs: 5000,
  walkDepth: 20,
  totalFiles: 100_000,
  walkMs: 20_000,
};

/** The member's home: $HOME, or the account's own when it is unset or blank (one rule for the set and the deny list). */
export function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

// -- running git ---------------------------------------------------------------------------------

/**
 * git's environment: PATH and HOME only, so nothing of the session (GIT_DIR, GIT_WORK_TREE,
 * GIT_CONFIG_*) redirects it, and it never prompts.
 */
function gitEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    PATH: env.PATH || process.env.PATH || '/usr/bin:/bin',
    HOME: homeDir(env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

export type GitRunner = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string | null>;

/** git with execFile (no shell), the fsmonitor hook off; null when it fails. */
export const runGit: GitRunner = (cwd, args, env) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
      { env: gitEnv(env), timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });

/** ls-files results by work tree, kept while HEAD and the index are unchanged. */
export class GitCache {
  private readonly entries = new Map<string, { key: string; files: string[] }>();
  get(tree: string, key: string): string[] | null {
    const e = this.entries.get(tree);
    return e && e.key === key ? e.files : null;
  }
  set(tree: string, key: string, files: string[]): void {
    if (this.entries.size > 500) this.entries.clear();
    this.entries.set(tree, { key, files });
  }
}

/** The work tree's git directory: `.git` itself, or where a `.git` file points. */
async function gitDirOf(tree: string): Promise<string | null> {
  const dotgit = join(tree, '.git');
  try {
    const st = await fsp.lstat(dotgit);
    if (st.isDirectory()) return dotgit;
    if (!st.isFile() || st.size > 4096) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fsp.readFile(dotgit, 'utf8'));
    if (!m) return null;
    return m[1]!.startsWith('/') ? m[1]! : join(tree, m[1]!);
  } catch {
    return null;
  }
}

/** HEAD's content and the index's stat: the cache key for ls-files (null: do not cache). */
async function gitCacheKey(tree: string): Promise<string | null> {
  const dir = await gitDirOf(tree);
  if (!dir) return null;
  try {
    const head = (await fsp.readFile(join(dir, 'HEAD'), 'utf8')).slice(0, 300);
    let ref = '';
    const m = /^ref:\s*(\S+)/.exec(head);
    if (m && /^refs\/[A-Za-z0-9._/-]+$/.test(m[1]!) && !m[1]!.includes('..')) {
      ref = await fsp.readFile(join(dir, m[1]!), 'utf8').catch(() => '');
    }
    const idx = await fsp.stat(join(dir, 'index'));
    return `${head}|${ref.trim()}|${idx.mtimeMs}|${idx.size}|${idx.ino}`;
  } catch {
    return null;
  }
}

/** Paths git tracks under `dir` (relative to it), or null when it is not in a work tree. */
async function trackedFiles(dir: string, env: NodeJS.ProcessEnv, git: GitRunner, cache: GitCache | null): Promise<string[] | null> {
  const key = cache ? await gitCacheKey(dir) : null;
  if (cache && key) {
    const hit = cache.get(dir, key);
    if (hit) return hit;
  }
  const out = await git(dir, ['ls-files', '-z', '--cached', '--full-name'], env);
  if (out === null) return null;
  // --full-name gives paths from the top of the work tree; make them relative to `dir`.
  const top = await git(dir, ['rev-parse', '--show-toplevel'], env);
  if (top === null) return null;
  const topReal = await canonical(top.trim());
  if (!topReal) return null;
  const files: string[] = [];
  for (const rel of out.split('\0')) {
    if (!rel) continue;
    const abs = join(topReal, rel);
    if (abs === dir || !within(abs, dir)) continue;
    files.push(relative(dir, abs));
  }
  if (cache && key) cache.set(dir, key, files);
  return files;
}

// -- files ---------------------------------------------------------------------------------------

/** The canonical path (native realpath: symlinks resolved, case as on disk), or null. */
export async function canonical(path: string): Promise<string | null> {
  try {
    return await fsp.realpath(path);
  } catch {
    return null;
  }
}

const ANY_DEPTH_RES = ANY_DEPTH.map((rule) => globRe(rule.replace(/^\*\*\//, '').replace(/\/\*\*$/, '')));

export type DenyCtx = { home: string; cloudsdkConfig?: string | undefined; credentialDirs: string[] };

export function denyContext(env: NodeJS.ProcessEnv): DenyCtx {
  const cloudsdk = env.CLOUDSDK_CONFIG?.trim();
  return {
    home: homeDir(env),
    cloudsdkConfig: cloudsdk && cloudsdk.startsWith('/') ? cloudsdk : undefined,
    credentialDirs: relayCredentialDirs(env),
  };
}

/** Whether a path may never be in the set: the deny list (and its any-depth names without case) or a sensitive name. */
export function alwaysOut(path: string, ctx: DenyCtx): boolean {
  if (credentialHit(path, ctx) !== null) return true;
  if (sensitiveName(path)) return true;
  for (const part of path.split('/')) {
    if (part === '') continue;
    // git's own files are never answer material.
    if (part === '.git') return true;
    const lower = part.toLowerCase();
    if (ANY_DEPTH_RES.some((re) => re.test(lower))) return true;
  }
  return false;
}

/**
 * Keep the candidates (absolute paths below `root`, a canonical folder) that are regular files
 * reached without a symlink, under the size cap when one is given, and not always out.
 */
async function keepFiles(
  candidates: string[],
  ctx: DenyCtx,
  opts: { maxBytes?: number; budget: { left: number } },
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const BATCH = 64;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const checked = await Promise.all(
      batch.map(async (p) => {
        if (alwaysOut(p, ctx)) return null;
        const real = await canonical(p);
        // Reached through a symlink (or a case that is not the file's own): out here; the
        // file it leads to is in only under its own path, if at all.
        if (real !== p) return null;
        try {
          const st = await fsp.stat(real);
          if (!st.isFile()) return null;
          if (opts.maxBytes !== undefined && st.size > opts.maxBytes) return null;
        } catch {
          return null;
        }
        return real;
      }),
    );
    for (const f of checked) {
      if (f === null) continue;
      if (opts.budget.left <= 0) {
        truncated = true;
        break;
      }
      opts.budget.left--;
      files.push(f);
    }
    if (truncated) break;
  }
  files.sort();
  return { files, truncated };
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Every regular file below `root` (canonical), never through a symlink or a dot entry, within
 * caps; a folder holding a `.git` entry (the top of a work tree, whatever the entry's type) is
 * not walked into but returned in `trees`.
 */
async function walk(root: string, limits: Limits): Promise<{ files: string[]; trees: string[]; truncated: boolean }> {
  const files: string[] = [];
  const trees: string[] = [];
  let dirs = 0;
  let truncated = false;
  const until = Date.now() + limits.walkMs;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (++dirs > limits.walkDirs || Date.now() > until) {
      truncated = true;
      break;
    }
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.name === '.git')) {
      trees.push(dir);
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < limits.walkDepth) queue.push({ dir: p, depth: depth + 1 });
      } else if (e.isFile()) {
        if (files.length >= limits.walkFiles) {
          truncated = true;
          break;
        }
        files.push(p);
      }
    }
    if (truncated) break;
  }
  return { files, trees, truncated };
}

// -- the set -------------------------------------------------------------------------------------

export type BuildInput = {
  /** The team's boundaries version the set is built for. */
  version: number;
  /** The member's folders for the team, or why they cannot be used. */
  member: { folders: readonly string[] } | { error: string };
  env: NodeJS.ProcessEnv;
  git?: GitRunner;
  cache?: GitCache | null;
  limits?: Partial<Limits>;
};

/** One chosen folder's files (canonical root), by the reading rule above. */
async function folderFiles(
  root: string,
  input: { env: NodeJS.ProcessEnv; git: GitRunner; cache: GitCache | null; limits: Limits; ctx: DenyCtx; budget: { left: number } },
): Promise<{ files: string[]; truncated: boolean } | null> {
  const { env, git, cache, limits, ctx, budget } = input;
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], env);
  if (inside?.trim() === 'true') {
    const rel = await trackedFiles(root, env, git, cache);
    if (rel === null) return null;
    return keepFiles(
      rel.map((r) => join(root, r)),
      ctx,
      { budget },
    );
  }
  const w = await walk(root, limits);
  const walked = await keepFiles(w.files, ctx, { maxBytes: MAX_WALK_FILE_BYTES, budget });
  const files = [...walked.files];
  let truncated = w.truncated || walked.truncated;
  for (const tree of w.trees) {
    const rel = await trackedFiles(tree, env, git, cache);
    if (rel === null) continue;
    const kept = await keepFiles(
      rel.map((r) => join(tree, r)),
      ctx,
      { budget },
    );
    files.push(...kept.files);
    truncated ||= kept.truncated;
  }
  files.sort();
  return { files, truncated };
}

/** The allowed set for one run. */
export async function buildAllowedSet(input: BuildInput): Promise<AllowedSet> {
  const { env } = input;
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const git = input.git ?? runGit;
  const cache = input.cache === undefined ? null : input.cache;
  const ctx = denyContext(env);
  const notes: string[] = [];
  const areas: Area[] = [];
  const budget = { left: limits.totalFiles };
  if ('error' in input.member) notes.push(`your folders file cannot be used (${input.member.error})`);
  const folders = 'error' in input.member ? [] : input.member.folders;
  for (const raw of folders) {
    const { path, reason } = memberFolderProblem(raw, env);
    if (reason || !path) {
      notes.push(`folder ${JSON.stringify(raw.slice(0, 200))} is not used: ${reason ?? 'not a path'}`);
      continue;
    }
    const root = await canonical(path);
    if (!root) continue;
    const kept = await folderFiles(root, { env, git, cache, limits, ctx, budget });
    if (!kept) continue;
    areas.push({ kind: 'folder', name: `folder:${basename(root)}`, root, files: kept.files, truncated: kept.truncated });
  }

  // Area names are unique: a repeated one gets a number.
  const used = new Set<string>();
  for (const a of areas) {
    let n = a.name;
    for (let k = 2; used.has(n); k++) n = `${a.name} (${k})`;
    a.name = n;
    used.add(n);
  }
  const files = new Map<string, Area>();
  for (const a of areas) for (const f of a.files) if (!files.has(f)) files.set(f, a);
  return { version: input.version, areas, files, notes };
}

/** Whether `path` (absolute or not) is in the set, judged by where it really leads. Returns the canonical path. */
export async function inSet(set: AllowedSet, path: string, ctx: DenyCtx): Promise<string | null> {
  if (alwaysOut(normalize(path), ctx)) return null;
  const real = await canonical(path);
  if (!real || alwaysOut(real, ctx)) return null;
  return set.files.has(real) ? real : null;
}

/** One line about what is in the set (folder names only), for the member. */
export function setSummary(set: AllowedSet): string {
  const n = set.areas.length;
  if (n === 0) return `none of your folders; ${set.files.size} files`;
  const names = set.areas.slice(0, 8).map((a) => a.name.replace(/^[a-z]+:/, ''));
  const list = `${names.join(', ')}${n > 8 ? ` and ${n - 8} more` : ''}`;
  return `${n === 1 ? '1 of your folders' : `${n} of your folders`} (${list}); ${set.files.size} files`;
}

/** The path relative to its area's root, for glob matching and display. */
export function areaRelative(area: Area, path: string): string {
  return relative(area.root, path).split(sep).join('/');
}

/** Owner-written text (a team's topic or name) as one quoted, single-line JSON string. */
export function quotedOwnerText(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = neutraliseChannelTags(text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim());
  return JSON.stringify(flat.length <= limit ? flat : flat.slice(0, limit));
}

/** What answers come from, for the member: how many folders they chose (paths stay in /team-relay:folders). */
export function foldersText(count: number): string {
  if (count === 0) return 'nothing yet: you have chosen no folders (choose them with /team-relay:setup or /team-relay:folders add <path>)';
  return `your ${count === 1 ? 'chosen folder' : `${count} chosen folders`} (only the files git tracks inside a repository; /team-relay:folders list shows them)`;
}

/**
 * The SessionStart sentence for a team with boundaries: whether the member accepted them (the
 * relay's version, `acceptedVersion`; accepting happens in the console at `consoleAt`), what
 * answers come from (how many folders the member chose), and how many folders an earlier
 * plugin's file held that are not used now (never their paths).
 */
export function boundariesSentence(version: number, settings: TeamSettings | { error: string }, acceptedVersion: number, consoleAt: string): string {
  if ('error' in settings) {
    return (
      `Your team has boundaries (version ${version}), but your folders file cannot be used (${settings.error.slice(0, 200)}), ` +
      "so teammates' questions to you are declined until you fix it: run /team-relay:folders."
    );
  }
  const n = settings.previous.length;
  const tail = n
    ? ` ${n === 1 ? '1 folder' : `${n} folders`} you chose before 13 Nov 2026 ${n === 1 ? 'is' : 'are'} not used now; /team-relay:folders list shows ${n === 1 ? 'it' : 'them'}.`
    : '';
  if (!hasAccepted(acceptedVersion, version)) {
    return (
      `Your team has boundaries (version ${version}) that you have not accepted yet, so teammates' questions to you are declined. ` +
      `Accept them in the console at ${consoleAt} (your answerer would then answer on its own from ${foldersText(settings.folders.length)}).${tail}`
    );
  }
  return `Your team has boundaries (version ${version}): your answerer answers teammates on its own from ${foldersText(settings.folders.length)}; reads of anything else are denied and off-topic questions declined.${tail}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A boundaries document from the relay, by the one rule (boundaries-rule.ts): the relay checked
 * it on write, and the host acts on nothing that does not pass it again (the topic reaches every
 * answerer's prompt). One an earlier relay returned (fields of the earlier schemas beside the
 * topic, a `since`) passes too, and is reduced in place to {topic} and no `since`, so every
 * reader after this check sees the one shape.
 */
export function validBoundaries(v: unknown): v is TeamBoundaries {
  if (!isObj(v) || !versionOk(v.version)) return false;
  if (v.boundaries !== null) {
    const b = readBoundaries(v.boundaries);
    if (!b) return false;
    v.boundaries = b;
  }
  delete v.since;
  return true;
}
