// PICKERS-SPEC §6.2: where a picked shared-drive folder (boundaries `drive_folders`) is on this
// Mac. Only the member's own Drive for desktop mounts are looked at, and never the Drive API: a
// folder is the directory whose extended attribute `com.google.drivefs.item-id#S` (written by
// Drive for desktop) is the folder's Drive id.
//
// Mounts: ~/Library/CloudStorage/GoogleDrive-<account>/Shared drives for each account whose
// domain is the entry's domain (the same rule as the name-matched drives, boundary-set.ts), the
// `Shared drives` folder a real directory (never a symlink). Its directories (one listing; no dot
// names; never a symlink; at most 50) are the shared drive roots.
//
// For one entry, in order, within budgets per call of `locate` (one build of the allowed set):
//   1. Drive root: the root whose id is the entry's drive_id (or, with no drive_id, its
//      folder_id). When the entry is the whole drive (folder_id == drive_id), that is it.
//   2. Name hint: breadth-first under that root (under every root when there is no drive_id),
//      directories only, never through a symlink or a dot name, depth at most 8, at most 5000
//      directories listed; a directory named exactly the entry's folder_name (NFC) has its id
//      read; the first whose id is the folder_id is the folder.
//   3. Blind scan (only with a drive_id, when 2 found nothing: the folder was renamed): the same
//      walk, reading every directory's id, at most 300 reads and 10 s.
//   4. Not found: the entry is missing.
//
// Cache (memory, per locator): folder_id → where it was found. A cached path is used only after
// it is checked again (at most every 60 s, always when `force`): still a real directory that is
// its own real path, under the same `Shared drives` root of an account in the domain, its id
// (and its root's) read now as cached. A mismatch searches again. A not-found entry is searched
// again after 10 minutes, or at once when the entries or the mounts' listing change.
//
// The attribute is read with /usr/bin/xattr through execFile (no shell; PATH and HOME only; 5 s
// timeout), at most 4 at once; anything but a well-formed id is no id. Tests inject the reader.

import { execFile } from 'node:child_process';
import { promises as fsp, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DRIVE_ITEM_ID_RE } from './boundaries-rule.js';
import type { FolderBoundary } from './boundaries-types.js';

export const DRIVEFS_ITEM_ID_ATTR = 'com.google.drivefs.item-id#S';
export const XATTR_BIN = '/usr/bin/xattr';
const XATTR_TIMEOUT_MS = 5000;
const READS_AT_ONCE = 4;

/** Reads a folder's Drive id from its attribute; null when it has none (or it cannot be read). */
export type ItemIdReader = (path: string) => Promise<string | null>;

/** The Drive id `/usr/bin/xattr -p com.google.drivefs.item-id#S <path>` prints, when it is one. */
export function xattrItemId(home: string): ItemIdReader {
  return (path) =>
    new Promise((resolve) => {
      try {
        execFile(
          XATTR_BIN,
          ['-p', DRIVEFS_ITEM_ID_ATTR, path],
          { env: { PATH: '/usr/bin:/bin', HOME: home }, timeout: XATTR_TIMEOUT_MS, maxBuffer: 4096, encoding: 'utf8', windowsHide: true, shell: false },
          (err, stdout) => {
            const id = err ? '' : String(stdout).trim();
            resolve(DRIVE_ITEM_ID_RE.test(id) ? id : null);
          },
        );
      } catch {
        resolve(null);
      }
    });
}

export type LocateLimits = {
  /** Shared drive roots looked at per mount. */
  rootsPerMount: number;
  /** How deep below a drive root a folder is looked for. */
  depth: number;
  /** Directories listed by the name-hint walks of one `locate`. */
  hintDirs: number;
  /** Ids read by the blind scans of one `locate`. */
  blindReads: number;
  /** Wall-clock budget of the blind scans of one `locate` (ms). */
  blindMs: number;
  /** A cached folder is checked again after this long (ms), and always when forced. */
  verifyMs: number;
  /** A folder not found is not looked for again for this long (ms), unless entries or mounts change. */
  notFoundMs: number;
};

export const DEFAULT_LOCATE_LIMITS: LocateLimits = {
  rootsPerMount: 50,
  depth: 8,
  hintDirs: 5000,
  blindReads: 300,
  blindMs: 10_000,
  verifyMs: 60_000,
  notFoundMs: 10 * 60_000,
};

/** One picked folder found on this Mac. */
export type FoundFolder = {
  folder_id: string;
  domain: string;
  /** The Google account of the mount it is in. */
  account: string;
  /** The canonical `Shared drives` folder of that mount. */
  shared: string;
  /** The canonical shared drive root it is in. */
  drive_root: string;
  /** That root's Drive id, read from its attribute (the shared drive's id). */
  drive_root_id: string;
  /** The folder's canonical path (the drive root itself for a whole drive). */
  path: string;
};

export type Mount = { account: string; shared: string };

const ACCOUNT_RE = /^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+)$/;
const byName = (a: Dirent, b: Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

async function listDirs(dir: string): Promise<Dirent[]> {
  try {
    // A Dirent of a symlink is never a directory: nothing is reached through one.
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).sort(byName);
  } catch {
    return [];
  }
}

/** The `Shared drives` folders of the Drive for desktop mounts of accounts in exactly `domain`. */
export async function driveMounts(home: string, domain: string): Promise<Mount[]> {
  const want = domain.toLowerCase();
  const cloud = await realOrNull(join(home, 'Library', 'CloudStorage'));
  if (!cloud) return [];
  const out: Mount[] = [];
  for (const e of await listDirs(cloud)) {
    const m = /^GoogleDrive-(.+)$/.exec(e.name);
    const am = m ? ACCOUNT_RE.exec(m[1]!) : null;
    if (!m || !am || am[1]!.toLowerCase() !== want) continue;
    const shared = join(cloud, e.name, 'Shared drives');
    try {
      const st = await fsp.lstat(shared);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    if ((await realOrNull(shared)) !== shared) continue;
    out.push({ account: m[1]!, shared });
  }
  return out;
}

/**
 * What the mounts look like now: the GoogleDrive-* folders and the shared drive roots in each.
 * Compared only, on this Mac (a change means a folder not found before may be there now); it
 * never leaves the Mac.
 */
export async function mountsSignature(home: string): Promise<string> {
  const cloud = await realOrNull(join(home, 'Library', 'CloudStorage'));
  if (!cloud) return '';
  const parts: string[] = [];
  for (const e of await listDirs(cloud)) {
    if (!e.name.startsWith('GoogleDrive-')) continue;
    const roots = (await listDirs(join(cloud, e.name, 'Shared drives'))).map((r) => r.name);
    parts.push(JSON.stringify([e.name, roots]));
  }
  return parts.join('\n');
}

/** At most `n` calls of `fn` at once. */
function limited(fn: ItemIdReader, n: number): ItemIdReader {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (path) => {
    if (running >= n) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await fn(path);
    } catch {
      return null;
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

type Root = { path: string; id: string | null };
type Budget = { hintDirs: number; blindReads: number; blindUntil: number | null; roots: Map<string, Root[]>; mounts: Map<string, Mount[]> };
type Cached = FoundFolder & { verifiedAt: number };

export type LocatorOptions = {
  home: string;
  /** Reads a folder's Drive id (tests inject one; default /usr/bin/xattr). */
  readId?: ItemIdReader;
  now?: () => number;
  limits?: Partial<LocateLimits>;
};

/** Finds picked folders in the member's Drive for desktop mounts, and remembers where. */
export class DriveLocator {
  private readonly home: string;
  private readonly readId: ItemIdReader;
  private readonly now: () => number;
  private readonly limits: LocateLimits;
  private readonly cache = new Map<string, Cached>();
  private readonly notFound = new Map<string, number>();
  private entriesKey: string | null = null;
  private mountsKey: string | null = null;

  constructor(o: LocatorOptions) {
    this.home = o.home;
    this.readId = limited(o.readId ?? xattrItemId(o.home), READS_AT_ONCE);
    this.now = o.now ?? Date.now;
    this.limits = { ...DEFAULT_LOCATE_LIMITS, ...o.limits };
  }

  /**
   * Where each entry is on this Mac (by folder_id; an entry not found is not in the map).
   * `force`: every cached path is checked again now (before a status report).
   */
  async locate(entries: readonly FolderBoundary[], opts: { force?: boolean } = {}): Promise<Map<string, FoundFolder>> {
    const entriesKey = JSON.stringify(entries.map((e) => [e.domain, e.drive_id, e.folder_id, e.folder_name]));
    const mountsKey = await mountsSignature(this.home);
    if (entriesKey !== this.entriesKey || mountsKey !== this.mountsKey) this.notFound.clear();
    this.entriesKey = entriesKey;
    this.mountsKey = mountsKey;
    const budget: Budget = { hintDirs: this.limits.hintDirs, blindReads: this.limits.blindReads, blindUntil: null, roots: new Map(), mounts: new Map() };
    const out = new Map<string, FoundFolder>();
    for (const e of entries) {
      if (out.has(e.folder_id) || !DRIVE_ITEM_ID_RE.test(e.folder_id) || (e.drive_id !== null && !DRIVE_ITEM_ID_RE.test(e.drive_id))) continue;
      const cached = this.cache.get(e.folder_id);
      if (cached) {
        if (cached.domain === e.domain && (e.drive_id === null || e.drive_id === cached.drive_root_id)) {
          if (!opts.force && this.now() - cached.verifiedAt < this.limits.verifyMs) {
            out.set(e.folder_id, strip(cached));
            continue;
          }
          if (await this.verify(cached, budget)) {
            cached.verifiedAt = this.now();
            out.set(e.folder_id, strip(cached));
            continue;
          }
        }
        this.cache.delete(e.folder_id);
      }
      const missedAt = this.notFound.get(e.folder_id);
      if (missedAt !== undefined && this.now() - missedAt < this.limits.notFoundMs) continue;
      const found = await this.search(e, budget);
      if (found) {
        this.notFound.delete(e.folder_id);
        this.cache.set(e.folder_id, { ...found, verifiedAt: this.now() });
        out.set(e.folder_id, found);
      } else {
        this.notFound.set(e.folder_id, this.now());
      }
    }
    return out;
  }

  private async mounts(domain: string, budget: Budget): Promise<Mount[]> {
    let m = budget.mounts.get(domain);
    if (!m) {
      m = await driveMounts(this.home, domain);
      budget.mounts.set(domain, m);
    }
    return m;
  }

  /** The shared drive roots of one mount and their ids, read once per `locate`. */
  private async roots(mount: Mount, budget: Budget): Promise<Root[]> {
    let r = budget.roots.get(mount.shared);
    if (!r) {
      const dirs = (await listDirs(mount.shared)).slice(0, this.limits.rootsPerMount).map((d) => join(mount.shared, d.name));
      r = await Promise.all(dirs.map(async (path) => ({ path, id: await this.readId(path) })));
      budget.roots.set(mount.shared, r);
    }
    return r;
  }

  /** Whether a cached place is still the folder (see the module comment). */
  private async verify(c: Cached, budget: Budget): Promise<boolean> {
    if (!(await this.mounts(c.domain, budget)).some((m) => m.shared === c.shared && m.account === c.account)) return false;
    const rel = relative(c.shared, c.path);
    if (!rel || rel.startsWith('..') || rel.split(sep).some((s) => s === '' || s.startsWith('.'))) return false;
    if (join(c.shared, rel.split(sep)[0]!) !== c.drive_root) return false;
    for (const p of c.path === c.drive_root ? [c.path] : [c.drive_root, c.path]) {
      try {
        const st = await fsp.lstat(p);
        if (!st.isDirectory()) return false;
      } catch {
        return false;
      }
      if ((await realOrNull(p)) !== p) return false;
    }
    if ((await this.readId(c.path)) !== c.folder_id) return false;
    return c.path === c.drive_root || (await this.readId(c.drive_root)) === c.drive_root_id;
  }

  private async search(e: FolderBoundary, budget: Budget): Promise<FoundFolder | null> {
    for (const mount of await this.mounts(e.domain, budget)) {
      const roots = await this.roots(mount, budget);
      const found = (root: Root & { id: string }, path: string): FoundFolder => ({
        folder_id: e.folder_id,
        domain: e.domain,
        account: mount.account,
        shared: mount.shared,
        drive_root: root.path,
        drive_root_id: root.id,
        path,
      });
      const withId = roots.filter((r): r is Root & { id: string } => r.id !== null);
      if (e.drive_id !== null) {
        const root = withId.find((r) => r.id === e.drive_id);
        if (!root) continue;
        if (e.folder_id === e.drive_id) return found(root, root.path);
        const p = (await this.walk([root], e, budget, 'hint')) ?? (await this.walk([root], e, budget, 'blind'));
        if (p) return found(root, p.path);
      } else {
        const whole = withId.find((r) => r.id === e.folder_id);
        if (whole) return found(whole, whole.path);
        const p = await this.walk(withId, e, budget, 'hint');
        if (p) return found(p.root as Root & { id: string }, p.path);
      }
    }
    return null;
  }

  /**
   * Breadth-first below the roots, directories only, never through a symlink or a dot name, at
   * most `depth` levels: 'hint' reads the id of each directory named as the entry; 'blind' reads
   * every directory's id. The first whose id is the folder's, and is its own real path, is it.
   */
  private async walk(roots: Root[], e: FolderBoundary, budget: Budget, mode: 'hint' | 'blind'): Promise<{ root: Root; path: string } | null> {
    const want = e.folder_name.normalize('NFC');
    if (mode === 'blind') budget.blindUntil ??= this.now() + this.limits.blindMs;
    const queue: Array<{ root: Root; dir: string; depth: number }> = roots.map((root) => ({ root, dir: root.path, depth: 0 }));
    const isIt = async (path: string) => (await this.readId(path)) === e.folder_id && (await realOrNull(path)) === path;
    while (queue.length) {
      const { root, dir, depth } = queue.shift()!;
      if (mode === 'hint') {
        if (budget.hintDirs <= 0) return null;
        budget.hintDirs--;
      }
      const children = (await listDirs(dir)).map((d) => ({ name: d.name, path: join(dir, d.name) }));
      if (mode === 'hint') {
        for (const c of children) if (c.name.normalize('NFC') === want && (await isIt(c.path))) return { root, path: c.path };
      } else {
        for (let i = 0; i < children.length; ) {
          if (budget.blindReads <= 0 || this.now() > budget.blindUntil!) return null;
          const batch = children.slice(i, i + Math.min(READS_AT_ONCE, budget.blindReads));
          budget.blindReads -= batch.length;
          i += batch.length;
          const ids = await Promise.all(batch.map((c) => this.readId(c.path)));
          for (const [k, c] of batch.entries()) if (ids[k] === e.folder_id && (await realOrNull(c.path)) === c.path) return { root, path: c.path };
        }
      }
      if (depth + 1 < this.limits.depth) for (const c of children) queue.push({ root, dir: c.path, depth: depth + 1 });
    }
    return null;
  }
}

function strip(c: Cached): FoundFolder {
  const { verifiedAt: _v, ...f } = c;
  return f;
}
