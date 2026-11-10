// How many clones of the team's GitHub organisations sit under a member's repo roots (M11-SPEC
// §3 `folders.clones`, §5 `setup-cli.js folders`), found the way the answerer's allowed set finds
// them (boundary-set.ts): work trees at most 3 levels below each root, never through a symlink,
// whose `origin` is github.com/<allowed org>/*, a submodule's checkout not counted. Only a count
// leaves here: no path, folder or repository name.

import { readFile, lstat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { DEFAULT_LIMITS, REPO_SEARCH_DEPTH, canonical, findWorkTrees, parseGithubOrigin, runGit, type GitRunner } from './boundary-set.js';
import { memberFolderProblem } from './member-folders.js';

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

/** The clones of `orgs` under one root as the member wrote it (null: the root cannot be used). */
async function treesUnder(raw: string, orgs: Set<string>, env: NodeJS.ProcessEnv, git: GitRunner): Promise<string[] | null> {
  const { path, reason } = memberFolderProblem(raw, env);
  if (reason || !path) return null;
  const root = await canonical(path);
  if (!root) return null;
  const out: string[] = [];
  for (const tree of await findWorkTrees(root, REPO_SEARCH_DEPTH, DEFAULT_LIMITS.repoSearchDirs)) {
    if (await isSubmodule(tree)) continue;
    const origin = await git(tree, ['config', '--local', '--get', 'remote.origin.url'], env);
    const parsed = origin === null ? null : parseGithubOrigin(origin.trim());
    if (parsed && orgs.has(parsed.org.toLowerCase())) out.push(tree);
  }
  return out;
}

/** Clones of `orgs` under one repo root (0 when the root cannot be used). */
export async function clonesUnder(raw: string, orgs: readonly string[], env: NodeJS.ProcessEnv, git: GitRunner = runGit): Promise<number> {
  const set = new Set(orgs.map((o) => o.toLowerCase()));
  if (set.size === 0) return 0;
  return (await treesUnder(raw, set, env, git))?.length ?? 0;
}

/** Clones of `orgs` under all the repo roots, each counted once. */
export async function countClones(roots: readonly string[], orgs: readonly string[], env: NodeJS.ProcessEnv, git: GitRunner = runGit): Promise<number> {
  const set = new Set(orgs.map((o) => o.toLowerCase()));
  if (set.size === 0) return 0;
  const all = new Set<string>();
  for (const raw of roots) for (const t of (await treesUnder(raw, set, env, git)) ?? []) all.add(t);
  return all.size;
}
