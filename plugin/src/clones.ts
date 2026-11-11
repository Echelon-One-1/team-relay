// Which clones of the team's GitHub sources sit under a member's repo roots (M11-SPEC §3
// `folders.clones`, §5 `setup-cli.js folders`; PICKERS-SPEC §6.1), found the way the answerer's
// allowed set finds them (boundary-set.ts): work trees at most 3 levels below each root, never
// through a symlink, a submodule's checkout not counted, whose `origin` is
// github.com/<org>/<repo> where the org is a whole-org entry or `org/repo` a repository entry
// (both compared without case). Only counts and the team's own item keys leave here: no path,
// folder or other repository name.

import { readFile, lstat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { orgKey, repoKey } from './boundaries-rule.js';
import type { ItemKey } from './boundaries-types.js';
import { DEFAULT_LIMITS, REPO_SEARCH_DEPTH, canonical, findWorkTrees, githubSourceMatcher, parseGithubOrigin, runGit, type GitRunner, type GithubSources } from './boundary-set.js';
import { memberFolderProblem } from './member-folders.js';

export type { GithubSources };

/** A clone and the github.com org and repository its origin names. */
export type CloneOrigin = { tree: string; org: string; repo: string };

/** Whether `tree` is a submodule's checkout (its .git a file pointing into another .git/modules). */
async function isSubmodule(tree: string): Promise<boolean> {
  const dotgit = join(tree, '.git');
  try {
    const st = await lstat(dotgit);
    if (!st.isFile() || st.size > 4096) return false;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotgit, 'utf8'));
    if (!m) return false;
    const dir = m[1]!.startsWith('/') ? m[1]! : join(tree, m[1]!);
    return `${normalize(dir)}/`.includes('/.git/modules/');
  } catch {
    return false;
  }
}

/** The clones (with a github.com origin) under one root as the member wrote it (null: the root cannot be used). */
async function originsUnder(raw: string, env: NodeJS.ProcessEnv, git: GitRunner): Promise<CloneOrigin[] | null> {
  const { path, reason } = memberFolderProblem(raw, env);
  if (reason || !path) return null;
  const root = await canonical(path);
  if (!root) return null;
  const out: CloneOrigin[] = [];
  for (const tree of await findWorkTrees(root, REPO_SEARCH_DEPTH, DEFAULT_LIMITS.repoSearchDirs)) {
    if (await isSubmodule(tree)) continue;
    const origin = await git(tree, ['config', '--local', '--get', 'remote.origin.url'], env);
    const parsed = origin === null ? null : parseGithubOrigin(origin.trim());
    if (parsed) out.push({ tree, ...parsed });
  }
  return out;
}

const hasSources = (s: GithubSources) => s.github_orgs.length > 0 || s.github_repos.length > 0;

/** The clones of the team's GitHub sources under all the repo roots, each work tree once. */
export async function matchingClones(roots: readonly string[], s: GithubSources, env: NodeJS.ProcessEnv, git: GitRunner = runGit): Promise<CloneOrigin[]> {
  if (!hasSources(s)) return [];
  const match = githubSourceMatcher(s);
  const seen = new Map<string, CloneOrigin>();
  for (const raw of roots) for (const c of (await originsUnder(raw, env, git)) ?? []) if (match(c) && !seen.has(c.tree)) seen.set(c.tree, c);
  return [...seen.values()];
}

/** Clones of the team's GitHub sources under one repo root (0 when the root cannot be used). */
export async function clonesUnder(raw: string, s: GithubSources, env: NodeJS.ProcessEnv, git: GitRunner = runGit): Promise<number> {
  return (await matchingClones([raw], s, env, git)).length;
}

/** Clones of the team's GitHub sources under all the repo roots, each counted once. */
export async function countClones(roots: readonly string[], s: GithubSources, env: NodeJS.ProcessEnv, git: GitRunner = runGit): Promise<number> {
  return (await matchingClones(roots, s, env, git)).length;
}

/**
 * PICKERS-SPEC §6.1: the keys of the GitHub items some clone stands for: a whole org when a clone
 * of any of its repositories is there, a repository when a clone of it is.
 */
export function foundGithubKeys(clones: readonly CloneOrigin[], s: GithubSources): Set<ItemKey> {
  const orgs = new Set(s.github_orgs.map((o) => orgKey(o)));
  const repos = new Set(s.github_repos.map((r) => repoKey(r)));
  const found = new Set<ItemKey>();
  for (const c of clones) {
    const o = orgKey(c.org);
    const r = repoKey(c);
    if (orgs.has(o)) found.add(o);
    if (repos.has(r)) found.add(r);
  }
  return found;
}
