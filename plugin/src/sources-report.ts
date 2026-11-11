// PICKERS-SPEC §3.3, §8: which of the team's boundary items this Mac cannot find, as item keys
// (boundaries-rule.ts itemKey), for the status the background answerer sends. Found the way the
// answerer's allowed set finds them, from local copies only (never a GitHub or Drive API call):
//
//   whole org        no clone of any of its repositories under the member's repo roots
//   repository       no clone of it under the member's repo roots
//   Drive folder     not found by its Drive id in a Drive for desktop mount (drive-locate.ts)
//   legacy drive     no `Shared drives/<name>` in a mount of an account in its domain
//
// Only keys of the team's own items leave here (the relay drops anything else as well): never a
// path, a local folder name or a repository the team did not list.

import { boundaryItems, folderKey, itemKey, SOURCES_MISSING_MAX } from './boundaries-rule.js';
import type { Boundaries, ItemKey } from './boundaries-types.js';
import { driveRoots, homeDir, runGit, type GitRunner } from './boundary-set.js';
import { foundGithubKeys, matchingClones } from './clones.js';
import { DriveLocator } from './drive-locate.js';
import type { MemberFolders } from './member-folders.js';

export type SourcesDeps = {
  git?: GitRunner;
  /** Finds picked Drive folders (the daemon keeps one, with its cache). Default: a new one. */
  locator?: DriveLocator;
  /** Check every cached Drive folder again now (default true: the result goes into a status). */
  force?: boolean;
};

/** The keys of the items of `b` (as stored) that are not on this Mac, in item order; at most 140. */
export async function missingSources(b: Boundaries, folders: Pick<MemberFolders, 'repo_roots'>, env: NodeJS.ProcessEnv, deps: SourcesDeps = {}): Promise<ItemKey[]> {
  const items = boundaryItems(b);
  const found = new Set<ItemKey>();
  if (items.some((i) => i.kind === 'org' || i.kind === 'repo')) {
    for (const k of foundGithubKeys(await matchingClones(folders.repo_roots, b, env, deps.git ?? runGit), b)) found.add(k);
  }
  const home = homeDir(env);
  const picked = items.flatMap((i) => (i.kind === 'folder' ? [i] : []));
  if (picked.length > 0) {
    const locator = deps.locator ?? new DriveLocator({ home });
    for (const id of (await locator.locate(picked, { force: deps.force ?? true })).keys()) found.add(folderKey({ folder_id: id }));
  }
  for (const i of items) if (i.kind === 'drive' && (await driveRoots(i, home)).length > 0) found.add(itemKey(i));
  return items
    .map(itemKey)
    .filter((k) => !found.has(k))
    .slice(0, SOURCES_MISSING_MAX);
}
