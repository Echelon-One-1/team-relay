// M10-SPEC §2: what a member's automatic answerer may read when the team has boundaries: the
// allowed set, recomputed at the start of every run from one version of the team's boundaries
// (relay) and the member's local folders (member-folders.ts).
//
// 1. GitHub: every git work tree under the member's repo_roots (at most 3 levels deep; never
//    through a symlink, node_modules, .git or any dot folder) whose own config names an origin
//    on github.com (https, git@github.com: or ssh:// form) in one of the team's whole orgs, or
//    (PICKERS-SPEC §6.1) exactly one of its repositories (org and repository compared without
//    case). In it only the files git tracks (`git ls-files -z`, run with execFile, never a
//    shell; cached per work tree by HEAD and the index's stat). Submodules and nested
//    repositories are not followed through their parent: each work tree stands on its own.
// 2. Drive, picked folders (PICKERS-SPEC §6.2): each `drive_folders` entry found by its Drive id
//    in a Drive for desktop mount of an account in its domain (drive-locate.ts); its files.
//    Legacy name-matched drives: for each {domain, shared_drive},
//    ~/Library/CloudStorage/GoogleDrive-<account>/Shared drives/<shared_drive>, where
//    <account>'s domain is exactly that domain. Other accounts' mounts and My Drive are never in
//    it. Walks are capped; files over 5 MB are left out, except Google Docs/Sheets/Slides link
//    files, which read_google_file reads.
// 3. The member's extra_folders, only when the team allows member folders: the files git
//    tracks when the folder is in a work tree, else all its files (the same walk as Drive).
//
// Always out, at any depth: the credential deny list (deny-list.ts, also without regard to
// case) and the sensitive names (read-trail-core.ts). Every file is held by its canonical path
// (realpath, which on macOS also fixes case): a file reached through a symlink is in only when
// the path it resolves to is itself in, so a symlink pointing outside the set is out.

import { execFile } from 'node:child_process';
import { promises as fsp, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, normalize, relative, sep } from 'node:path';
import type { Boundaries, DriveBoundary, FolderBoundary, RepoBoundary, TeamBoundaries } from './boundaries-types.js';
import {
  BOUNDARIES_MAX_DRIVES,
  BOUNDARIES_MAX_FOLDERS,
  BOUNDARIES_MAX_ORGS,
  BOUNDARIES_MAX_REPOS,
  domainOk,
  driveItemIdOk,
  driveNameOk,
  orgOk,
  readBoundaries,
  repoKey,
  repoNameOk,
  versionOk,
} from './boundaries-rule.js';
import { ANY_DEPTH, credentialHit, globRe, within } from './deny-list.js';
import { DriveLocator } from './drive-locate.js';
import { acceptedAtVersion, effectiveBoundaries, memberFolderProblem, type ItemSince, type MemberFolders, type TeamSettings, type Widening } from './member-folders.js';
import { SHARE_NAME_RE, MAX_SHARES } from './manifest.js';
import { neutraliseChannelTags } from './notify.js';
import { sensitiveName } from './read-trail-core.js';
import { relayCredentialDirs, shareName } from './scope.js';

export type AreaKind = 'github' | 'drive' | 'folder';

export type Area = {
  kind: AreaKind;
  /** How tools and people name it: "github:<org>/<repo>", "drive:<shared drive>", "folder:<basename>". */
  name: string;
  /** The canonical root folder. */
  root: string;
  /** Canonical absolute paths, sorted. */
  files: string[];
  /** For a drive area of a legacy, name-matched drive: the boundary it came from. */
  drive?: DriveBoundary;
  /**
   * For a drive area of a picked folder (PICKERS-SPEC §6.2): its domain, its folder id, and the
   * Drive id of the shared drive root it is in, read locally from that root's attribute.
   */
  folder?: { domain: string; folder_id: string; drive_root_id: string; whole_drive: boolean; folder_name: string };
  /** For a github area: the org and repository its origin names. */
  repo?: { org: string; repo: string };
  /** Its walk or listing stopped at a cap. */
  truncated: boolean;
};

export type AllowedSet = {
  /** The boundaries version this set was built from. */
  version: number;
  areas: Area[];
  /** Canonical path → its area. */
  files: Map<string, Area>;
  /** Problems met while building it (a refused folders file, a folder that cannot be used). */
  notes: string[];
};

export const REPO_SEARCH_DEPTH = 3;
/** Files larger than this are left out of walked areas (Drive, plain folders), Google link files excepted. */
export const MAX_WALK_FILE_BYTES = 5 * 1024 * 1024;
export const GOOGLE_LINK_EXTENSIONS = ['.gdoc', '.gsheet', '.gslides'] as const;

export type Limits = {
  /** Directories visited looking for work trees, per repo root. */
  repoSearchDirs: number;
  /** Files per walked area. */
  walkFiles: number;
  /** Directories per walked area. */
  walkDirs: number;
  walkDepth: number;
  /** Files in the whole set. */
  totalFiles: number;
  /** Wall-clock budget for one walk (ms). */
  walkMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  repoSearchDirs: 5000,
  walkFiles: 20_000,
  walkDirs: 5000,
  walkDepth: 20,
  totalFiles: 100_000,
  walkMs: 20_000,
};

export function isGoogleLinkName(path: string): boolean {
  return (GOOGLE_LINK_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
}

/** The member's home: $HOME, or the account's own when it is unset or blank (one rule for the set, the deny list and Drive). */
export function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

// -- GitHub origins ------------------------------------------------------------------------------

// Group 1: the org; group 2: the repository. Literals, so nothing outside reaches a RegExp.
const ORIGIN_RES = [
  /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i,
  /^git@github\.com:([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i,
  /^ssh:\/\/git@github\.com(?::22)?\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i,
];

/** The team's GitHub sources: whole orgs and single repositories. */
export type GithubSources = { github_orgs: readonly string[]; github_repos: ReadonlyArray<{ org: string; repo: string }> };

/**
 * PICKERS-SPEC §6.1: whether a clone's origin is one of the team's GitHub sources: its org is a
 * whole-org entry, or org/repository is a repository entry (both without case).
 */
export function githubSourceMatcher(s: GithubSources): (origin: { org: string; repo: string }) => boolean {
  const orgs = new Set(s.github_orgs.map((o) => o.toLowerCase()));
  const repos = new Set(s.github_repos.map((r) => repoKey(r)));
  return (o) => orgs.has(o.org.toLowerCase()) || repos.has(repoKey(o));
}

/** The org and repository a github.com origin URL names, or null for anything else. */
export function parseGithubOrigin(url: string): { org: string; repo: string } | null {
  const u = url.trim();
  for (const re of ORIGIN_RES) {
    const m = re.exec(u);
    if (m && !/^\.+$/.test(m[2]!)) return { org: m[1]!, repo: m[2]! };
  }
  return null;
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
          if (opts.maxBytes !== undefined && st.size > opts.maxBytes && !isGoogleLinkName(real)) return null;
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

/** Every regular file below `root` (canonical), never through a symlink or a dot entry, within caps. */
async function walk(root: string, limits: Limits): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
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
  return { files, truncated };
}

/** Work trees at most `depth` levels below `root` (root included), never through a symlink. */
export async function findWorkTrees(root: string, depth: number, maxDirs: number): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length && seen < maxDirs) {
    const { dir, depth: d } = queue.shift()!;
    seen++;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.name === '.git' && (e.isDirectory() || e.isFile()))) found.push(dir);
    if (d >= depth) continue;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) queue.push({ dir: join(dir, e.name), depth: d + 1 });
    }
  }
  return found;
}

// -- Drive ---------------------------------------------------------------------------------------

const ACCOUNT_RE = /^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+)$/;

/** The Drive for desktop mounts of a shared drive, for accounts in its domain only. */
export async function driveRoots(drive: DriveBoundary, home: string): Promise<Array<{ account: string; root: string }>> {
  const name = drive.shared_drive;
  // eslint-disable-next-line no-control-regex
  if (!name || name === '.' || name === '..' || name.includes('/') || /[\u0000-\u001f\u007f]/.test(name)) return [];
  const domain = drive.domain.toLowerCase();
  const cloud = await canonical(join(home, 'Library', 'CloudStorage'));
  if (!cloud) return [];
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(cloud, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ account: string; root: string }> = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue;
    const m = /^GoogleDrive-(.+)$/.exec(e.name);
    if (!m) continue;
    const account = m[1]!;
    const am = ACCOUNT_RE.exec(account);
    if (!am || am[1]!.toLowerCase() !== domain) continue;
    const shared = join(cloud, e.name, 'Shared drives');
    const root = join(shared, name);
    try {
      const a = await fsp.lstat(shared);
      const b = await fsp.lstat(root);
      if (!a.isDirectory() || !b.isDirectory()) continue;
    } catch {
      continue;
    }
    const real = await canonical(root);
    if (real !== root || dirname(real) !== shared) continue;
    out.push({ account, root: real });
  }
  return out;
}

// -- the set -------------------------------------------------------------------------------------

export type BuildInput = {
  version: number;
  boundaries: Boundaries;
  /** The member's folders, or why they cannot be used. */
  member: MemberFolders | { error: string };
  env: NodeJS.ProcessEnv;
  git?: GitRunner;
  cache?: GitCache | null;
  limits?: Partial<Limits>;
  /**
   * PICKERS-SPEC §6.2: finds picked Drive folders (and remembers where; the daemon and the
   * channel host each keep one). Default: a new one for this build, reading /usr/bin/xattr.
   */
  locator?: DriveLocator;
};

/** The allowed set for one run. */
export async function buildAllowedSet(input: BuildInput): Promise<AllowedSet> {
  const { env, boundaries } = input;
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const git = input.git ?? runGit;
  const cache = input.cache === undefined ? null : input.cache;
  const ctx = denyContext(env);
  const home = homeDir(env);
  const notes: string[] = [];
  const areas: Area[] = [];
  const budget = { left: limits.totalFiles };
  const matches = githubSourceMatcher(boundaries);
  const github = boundaries.github_orgs.length > 0 || boundaries.github_repos.length > 0;
  const member = 'error' in input.member ? null : input.member;
  if ('error' in input.member) notes.push(`your folders file cannot be used (${input.member.error})`);

  // 1. GitHub work trees under the repo roots.
  if (member && github) {
    const trees = new Set<string>();
    for (const raw of member.repo_roots) {
      const { path, reason } = memberFolderProblem(raw, env);
      if (reason || !path) {
        notes.push(`repo root ${JSON.stringify(raw.slice(0, 200))} is not used: ${reason ?? 'not a path'}`);
        continue;
      }
      const root = await canonical(path);
      if (!root) continue;
      for (const t of await findWorkTrees(root, REPO_SEARCH_DEPTH, limits.repoSearchDirs)) trees.add(t);
    }
    for (const tree of [...trees].sort()) {
      // A submodule's checkout (its .git a file pointing into another repository's
      // .git/modules) is not followed; a linked work tree (.git/worktrees) is a clone like any.
      const gd = await gitDirOf(tree);
      if (gd === null || `${normalize(gd)}/`.includes('/.git/modules/')) continue;
      const origin = await git(tree, ['config', '--local', '--get', 'remote.origin.url'], env);
      const parsed = origin === null ? null : parseGithubOrigin(origin);
      if (!parsed || !matches(parsed)) continue;
      const rel = await trackedFiles(tree, env, git, cache);
      if (rel === null) continue;
      const kept = await keepFiles(
        rel.map((r) => join(tree, r)),
        ctx,
        { budget },
      );
      areas.push({ kind: 'github', name: `github:${parsed.org}/${parsed.repo}`, root: tree, files: kept.files, repo: parsed, truncated: kept.truncated });
    }
  }

  // 2. Picked shared-drive folders, found by id in the mounts of accounts in their domain only.
  if (boundaries.drive_folders.length > 0) {
    const locator = input.locator ?? new DriveLocator({ home });
    const found = await locator.locate(boundaries.drive_folders);
    const entries = boundaries.drive_folders
      .filter((e, i) => boundaries.drive_folders.findIndex((x) => x.folder_id === e.folder_id) === i)
      .flatMap((e) => {
        const f = found.get(e.folder_id);
        return f ? [{ e, f }] : [];
      })
      // Parents before what they hold, so a folder inside one already walked is not walked again.
      .sort((a, b) => (a.f.path < b.f.path ? -1 : a.f.path > b.f.path ? 1 : 0));
    const walked: string[] = [];
    for (const { e, f } of entries) {
      if (walked.some((root) => within(f.path, root))) continue;
      walked.push(f.path);
      const w = await walk(f.path, limits);
      const kept = await keepFiles(w.files, ctx, { maxBytes: MAX_WALK_FILE_BYTES, budget });
      areas.push({
        kind: 'drive',
        name: `drive:${e.folder_name}`,
        root: f.path,
        files: kept.files,
        folder: { domain: e.domain, folder_id: e.folder_id, drive_root_id: f.drive_root_id, whole_drive: f.path === f.drive_root, folder_name: e.folder_name },
        truncated: w.truncated || kept.truncated,
      });
    }
  }

  // 2b. Legacy shared drives, by name, through the mounts of accounts in their domain only.
  for (const drive of boundaries.drives) {
    const roots = await driveRoots(drive, home);
    for (const [i, r] of roots.entries()) {
      const w = await walk(r.root, limits);
      const kept = await keepFiles(w.files, ctx, { maxBytes: MAX_WALK_FILE_BYTES, budget });
      const name = i === 0 ? `drive:${drive.shared_drive}` : `drive:${drive.shared_drive} (${r.account})`;
      areas.push({ kind: 'drive', name, root: r.root, files: kept.files, drive, truncated: w.truncated || kept.truncated });
    }
  }

  // 3. The member's own folders, when the team allows them.
  if (member && boundaries.member_folders) {
    for (const raw of member.extra_folders) {
      const { path, reason } = memberFolderProblem(raw, env);
      if (reason || !path) {
        notes.push(`folder ${JSON.stringify(raw.slice(0, 200))} is not used: ${reason ?? 'not a path'}`);
        continue;
      }
      const root = await canonical(path);
      if (!root) continue;
      const inside = await git(root, ['rev-parse', '--is-inside-work-tree'], env);
      let kept: { files: string[]; truncated: boolean };
      if (inside?.trim() === 'true') {
        const rel = await trackedFiles(root, env, git, null);
        if (rel === null) continue;
        kept = await keepFiles(rel.map((r) => join(root, r)), ctx, { budget });
      } else {
        const w = await walk(root, limits);
        const k = await keepFiles(w.files, ctx, { maxBytes: MAX_WALK_FILE_BYTES, budget });
        kept = { files: k.files, truncated: w.truncated || k.truncated };
      }
      areas.push({ kind: 'folder', name: `folder:${basename(root)}`, root, files: kept.files, truncated: kept.truncated });
    }
  } else if (member && member.extra_folders.length > 0) {
    notes.push('the team does not allow member folders, so your extra folders are not used');
  }

  // Area names are unique: a repeated one gets its root's folder name.
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

/**
 * What the member can answer from, as share names (M4-SPEC §3 limits: at most 16 names in
 * [A-Za-z0-9._-]{1,64}): drive names, then repository names, then folder names; past the
 * limit, the last one says how many more.
 */
export function shareNames(set: AllowedSet): string[] {
  const order: AreaKind[] = ['drive', 'github', 'folder'];
  const names: string[] = [];
  for (const kind of order) {
    const raws = set.areas
      .filter((x) => x.kind === kind)
      .map((a) => (kind === 'github' && a.repo ? a.repo.repo : kind === 'drive' && a.drive ? a.drive.shared_drive : kind === 'drive' && a.folder ? a.folder.folder_name : basename(a.root)))
      .sort();
    for (const raw of raws) {
      const n = shareName(raw);
      if (SHARE_NAME_RE.test(n) && !names.includes(n)) names.push(n);
    }
  }
  if (names.length <= MAX_SHARES) return names;
  const more = names.length - (MAX_SHARES - 1);
  return [...names.slice(0, MAX_SHARES - 1), `and-${more}-more`];
}

/** One line about what is in the set (names only), for the member. */
export function setSummary(set: AllowedSet): string {
  const by = (k: AreaKind) => set.areas.filter((a) => a.kind === k);
  const parts: string[] = [];
  const gh = by('github');
  // Legacy drives and picked whole drives read as shared drives; other picked folders as folders.
  const dr = by('drive').filter((a) => !a.folder || a.folder.whole_drive);
  const df = by('drive').filter((a) => a.folder && !a.folder.whole_drive);
  const fo = by('folder');
  const list = (as: Area[]) => {
    const names = as.slice(0, 8).map((a) => a.name.replace(/^[a-z]+:/, ''));
    return `${names.join(', ')}${as.length > 8 ? ` and ${as.length - 8} more` : ''}`;
  };
  parts.push(gh.length ? `${gh.length} GitHub ${gh.length === 1 ? 'repository' : 'repositories'} (${list(gh)})` : 'no GitHub repositories');
  parts.push(dr.length ? `${dr.length === 1 ? 'the shared drive' : `${dr.length} shared drives`} ${list(dr)}` : 'no shared drive');
  if (df.length) parts.push(`${df.length === 1 ? 'the Drive folder' : `${df.length} Drive folders`} ${list(df)}`);
  if (fo.length) parts.push(`${fo.length} of your folders (${list(fo)})`);
  return `${parts.join(', ')}; ${set.files.size} files`;
}

/** The path relative to its area's root, for glob matching and display. */
export function areaRelative(area: Area, path: string): string {
  return relative(area.root, path).split(sep).join('/');
}

/** Owner-written text (a team's topic, name or a drive's name) as one quoted, single-line JSON string. */
export function quotedOwnerText(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = neutraliseChannelTags(text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim());
  return JSON.stringify(flat.length <= limit ? flat : flat.slice(0, limit));
}

/** At most `max` names, then how many more. */
function someOf(names: string[], max: number): string {
  return `${names.slice(0, max).join(', ')}${names.length > max ? ` and ${names.length - max} more` : ''}`;
}

/** A picked folder for the member: its name and its drive's (owner-written, quoted), and its domain. */
/** A picked Drive folder for a reader: its quoted name and where it is (owner text quoted). */
export function folderText(f: FolderBoundary, withDomain: boolean): string {
  const where =
    f.drive_id !== null && f.folder_id === f.drive_id
      ? ' (a whole shared drive'
      : f.drive_name !== null
        ? ` (in ${quotedOwnerText(f.drive_name, 100)}`
        : ' (in a shared drive';
  return `${quotedOwnerText(f.folder_name, 255)}${where}${withDomain ? `, ${f.domain}` : ''})`;
}

/** Repositories as org/repo (id-shaped names). */
const repoNames = (repos: ReadonlyArray<Pick<RepoBoundary, 'org' | 'repo'>>) => someOf(repos.map((r) => `${r.org}/${r.repo}`), 10);

/**
 * What a widening adds, for the member: org and repository names (id-shaped), Drive folder and
 * drive names (owner-written, quoted) and their domains.
 */
export function wideningText(w: Widening): string {
  const parts: string[] = [];
  if (w.github_orgs.length) parts.push(`${w.github_orgs.length === 1 ? 'the GitHub org' : 'the GitHub orgs'} ${w.github_orgs.join(', ')}`);
  if (w.github_repos.length) parts.push(`${w.github_repos.length === 1 ? 'the GitHub repository' : 'the GitHub repositories'} ${repoNames(w.github_repos)}`);
  if (w.drive_folders.length) {
    const names = someOf(w.drive_folders.map((f) => folderText(f, true)), 10);
    parts.push(`${w.drive_folders.length === 1 ? 'the Drive folder' : 'the Drive folders'} ${names}`);
  }
  if (w.drives.length) {
    const names = w.drives.map((d) => `${quotedOwnerText(d.shared_drive, 100)} (${d.domain})`).join(', ');
    parts.push(`${w.drives.length === 1 ? 'the shared drive' : 'the shared drives'} ${names}`);
  }
  if (w.member_folders) parts.push("members' own folders");
  return parts.join(', ') || 'nothing to read yet';
}

const NOTHING: Widening = { github_orgs: [], github_repos: [], drive_folders: [], drives: [], member_folders: false };

/**
 * M10-SPEC: the SessionStart sentence for a team with boundaries (names only; folder and drive
 * names are owner-written, so quoted): what answers come from (the team's boundaries narrowed to
 * what the member accepted, §7.1), what is waiting to be accepted, and how many repo roots the
 * member set. M11-SPEC §2: what the member accepted is the relay's (`acceptedVersion`, GET
 * me/acceptance); accepting happens in the console at `consoleAt`.
 */
export function boundariesSentence(
  current: Boundaries,
  version: number,
  settings: TeamSettings | { error: string },
  since: ItemSince,
  acceptedVersion: number,
  consoleAt: string,
): string {
  if ('error' in settings) {
    return (
      `Your team has boundaries (version ${version}), but your folders file cannot be used (${settings.error.slice(0, 200)}), ` +
      'so teammates\' questions to you are declined until you fix it: run /team-relay:folders.'
    );
  }
  const eff = effectiveBoundaries(current, acceptedAtVersion(current, acceptedVersion, since), since);
  if (eff.notAccepted) {
    return (
      `Your team has boundaries (version ${version}) that you have not accepted yet, so teammates' questions to you are declined. ` +
      `Accept them in the console at ${consoleAt} (your answerer would then answer on its own from ${wideningText(eff.pending ?? NOTHING)}).`
    );
  }
  const b = eff.boundaries;
  const orgs = b.github_orgs.length ? `files git tracks in your clones of ${b.github_orgs.length === 1 ? 'the GitHub org' : 'the GitHub orgs'} ${b.github_orgs.join(', ')}` : null;
  const repos = b.github_repos.length
    ? `files git tracks in your clones of ${b.github_repos.length === 1 ? 'the GitHub repository' : 'the GitHub repositories'} ${repoNames(b.github_repos)}`
    : null;
  const folders = b.drive_folders.length
    ? `${b.drive_folders.length === 1 ? 'the Drive folder' : 'the Drive folders'} ${someOf(b.drive_folders.map((f) => folderText(f, false)), 10)}`
    : null;
  const drives = b.drives.length ? `${b.drives.length === 1 ? 'the shared drive' : 'the shared drives'} ${b.drives.map((d) => quotedOwnerText(d.shared_drive, 100)).join(', ')}` : null;
  const own = b.member_folders ? 'your own added folders' : null;
  const from = [orgs, repos, folders, drives, own].filter(Boolean).join(', ') || 'nothing yet';
  const pending = eff.pending
    ? ` Version ${version} adds ${wideningText(eff.pending)}, which you have not accepted: accept it in the console at ${consoleAt}; until then answers come only from what you accepted.`
    : '';
  let roots: string;
  if ((b.github_orgs.length || b.github_repos.length) && settings.repo_roots.length === 0) roots = ' You have set no repo roots yet: run /team-relay:folders add-root <the folder your clones are in>.';
  else roots = ` Repo roots set: ${settings.repo_roots.length} (/team-relay:folders shows them).`;
  return `Your team has boundaries (version ${version}): your answerer answers teammates on its own from ${from}; reads of anything else are denied and off-topic questions declined.${pending}${roots}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A boundaries document from the relay, by the one rule (M10-SPEC §7.5, boundaries-rule.ts):
 * the relay checked it on write, and the host acts on nothing that does not pass it again
 * (drive domains and names reach the member's session and the file system).
 *
 * PICKERS-SPEC §2.3: a document the M10 code wrote (no `github_repos`, no `drive_folders`; its
 * `since` without their maps) passes too, and is completed in place with the picked lists (and
 * maps) empty, so every reader after this check sees the one shape.
 */
export function validBoundaries(v: unknown): v is TeamBoundaries {
  if (!isObj(v) || !versionOk(v.version)) return false;
  if (v.boundaries === null) return v.since === undefined || v.since === null;
  const b = readBoundaries(v.boundaries);
  if (!b || !sinceValid(v.since, v.version)) return false;
  v.boundaries = b;
  if (isObj(v.since)) v.since = { github_orgs: v.since.github_orgs, github_repos: v.since.github_repos ?? {}, drive_folders: v.since.drive_folders ?? {}, drives: v.since.drives, member_folders: v.since.member_folders };
  return true;
}

/**
 * M10-SPEC §7.1 and PICKERS-SPEC §2.3: the relay's `since` for a document of version `version`:
 * absent or null (every item then counts as added in `version`), or exactly `github_orgs`
 * (lower-case org names), `github_repos` (lower-case `org/repo`), `drive_folders` (folder ids),
 * `drives` (domain, shared_drive, since) and `member_folders` (null or a version), each version a
 * whole number from 1 to `version`; one the M10 relay wrote has no `github_repos` or
 * `drive_folders`.
 */
function sinceValid(v: unknown, version: number): boolean {
  if (v === undefined || v === null) return true;
  const inRange = (n: unknown) => versionOk(n) && n >= 1 && n <= version;
  const keys = (o: Record<string, unknown>, want: string[]) => Object.keys(o).length === want.length && want.every((k) => Object.prototype.hasOwnProperty.call(o, k));
  if (!isObj(v) || !(keys(v, ['github_orgs', 'drives', 'member_folders']) || keys(v, ['github_orgs', 'github_repos', 'drive_folders', 'drives', 'member_folders']))) return false;
  const orgs = v.github_orgs;
  if (!isObj(orgs) || Object.keys(orgs).length > BOUNDARIES_MAX_ORGS) return false;
  if (!Object.entries(orgs).every(([o, n]) => orgOk(o) && o === o.toLowerCase() && inRange(n))) return false;
  if (v.github_repos !== undefined) {
    const repos = v.github_repos;
    if (!isObj(repos) || Object.keys(repos).length > BOUNDARIES_MAX_REPOS) return false;
    const repoKeyOk = (k: string) => {
      const at = k.indexOf('/');
      return at > 0 && k === k.toLowerCase() && orgOk(k.slice(0, at)) && repoNameOk(k.slice(at + 1));
    };
    if (!Object.entries(repos).every(([k, n]) => repoKeyOk(k) && inRange(n))) return false;
  }
  if (v.drive_folders !== undefined) {
    const folders = v.drive_folders;
    if (!isObj(folders) || Object.keys(folders).length > BOUNDARIES_MAX_FOLDERS) return false;
    if (!Object.entries(folders).every(([k, n]) => driveItemIdOk(k) && inRange(n))) return false;
  }
  if (!Array.isArray(v.drives) || v.drives.length > BOUNDARIES_MAX_DRIVES) return false;
  if (!v.drives.every((d) => isObj(d) && keys(d, ['domain', 'shared_drive', 'since']) && domainOk(d.domain) && driveNameOk(d.shared_drive) && inRange(d.since))) return false;
  return v.member_folders === null || inRange(v.member_folders);
}
