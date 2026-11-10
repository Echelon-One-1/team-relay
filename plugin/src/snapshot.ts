// M10-SPEC §7.3: reads are snapshots. When the host allows a built-in Read in boundary mode, it
// opens the file itself and hands the answerer a copy, so the answerer never opens a member path
// and nothing can change between the check and the read:
//
// 1. the requested path must lead (realpath) to a file in the run's allowed set;
// 2. that canonical path is opened, and checked once open, by openAllowed (the one way the host
//    opens a member file, for search_files too): O_NOFOLLOW (a final symlink is refused),
//    O_RDONLY and O_NONBLOCK (a FIFO swapped in never blocks the host); the open file must be a
//    regular file (fstat), within the size cap, and still be the file at that canonical path:
//    realpath again gives the same path, still in the set, and the path's device and inode are
//    the open file's;
// 3. its bytes (read from the open descriptor, never past the cap) are written to the run's
//    private snapshot folder under a fresh random name that keeps the extension (so PDFs and
//    images still render), mode 600, never replacing anything.
//
// Within one run (one question), a second Read of the same unchanged file (same device, inode,
// size and modification time) gets the copy already made; nothing is kept across runs (the
// folder goes with the run: never a cache). A run copies at most 100 MB in all; past that a
// Read is denied. Each Read reserves the file's size against that before it reads (Reads of
// one run can run in parallel) and gives back what it does not use.
//
// A run's folder is named trs-<pid>-XXXXXX after the host process that made it. At host start,
// the member's own snapshot folders left by a host that ended without cleaning up (a crash, a
// kill) are removed: removeStaleSnapshotDirs, only those whose host process is gone.

import { randomBytes } from 'node:crypto';
import { constants, promises as fsp, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { alwaysOut, canonical, inSet, type AllowedSet, type DenyCtx } from './boundary-set.js';

/** The largest file a Read snapshot copies. */
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
/** The most a run copies in all. */
export const MAX_RUN_SNAPSHOT_BYTES = 100 * 1024 * 1024;
/** The prefix of a run's snapshot folder made by process `pid` (mkdtemp adds six letters and digits). */
export function snapshotDirPrefix(pid: number = process.pid): string {
  return `trs-${pid}-`;
}
const SNAPSHOT_DIR_RE = /^trs-([1-9][0-9]{0,9})-[A-Za-z0-9]{6}$/;
const PID_MAX = 2 ** 31 - 1;

export type SnapshotOutcome =
  | { ok: true; path: string; source: string; bytes: number }
  | { ok: false; why: 'outside' | 'too_large' | 'unsafe' | 'run_cap' };

/**
 * One run's snapshots: its private folder (mode 700), the copies made so far, and how much they
 * hold together with what Reads in progress have reserved.
 */
export type SnapshotRun = {
  readonly dir: string;
  readonly maxTotal: number;
  total: number;
  readonly copies: Map<string, { path: string; bytes: number }>;
};

/** The snapshot state of a run whose private folder is `dir`. */
export function snapshotRun(dir: string, maxTotal = MAX_RUN_SNAPSHOT_BYTES): SnapshotRun {
  return { dir, maxTotal, total: 0, copies: new Map() };
}

export type SnapshotInput = {
  set: AllowedSet;
  ctx: DenyCtx;
  /** The absolute path the answerer asked for. */
  requested: string;
  /** The run the copy is made for. */
  run: SnapshotRun;
  maxBytes?: number;
  /** Tests only: runs between the set check and the open, to play a file swapped in between. */
  beforeOpen?: (canonicalPath: string) => Promise<void> | void;
};

export type OpenAllowedInput = {
  set: AllowedSet;
  ctx: DenyCtx;
  /** A canonical path the set holds. */
  real: string;
  maxBytes: number;
  /** Tests only: runs just before the open. */
  beforeOpen?: (canonicalPath: string) => Promise<void> | void;
};

export type OpenAllowed = { ok: true; fh: FileHandle; st: BigIntStats } | { ok: false; why: 'too_large' | 'unsafe' };

/**
 * Open `real` for reading the way the host opens every member file: never through a final
 * symlink, never blocking on a FIFO, and only when the open file is a regular file of at most
 * `maxBytes` that is still the file the set holds at that canonical path. The caller closes
 * the handle.
 */
export async function openAllowed(input: OpenAllowedInput): Promise<OpenAllowed> {
  const { set, ctx, real } = input;
  await input.beforeOpen?.(real);
  let fh: FileHandle;
  try {
    fh = await fsp.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, why: 'unsafe' };
  }
  let keep = false;
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) return { ok: false, why: 'unsafe' };
    if (st.size > BigInt(input.maxBytes)) return { ok: false, why: 'too_large' };
    // Still the file the set holds at that path (no folder above it swapped in the meantime).
    const again = await canonical(real);
    if (again !== real || !set.files.has(again) || alwaysOut(again, ctx)) return { ok: false, why: 'unsafe' };
    const now = await fsp.stat(real, { bigint: true }).catch(() => null);
    if (!now || now.dev !== st.dev || now.ino !== st.ino) return { ok: false, why: 'unsafe' };
    keep = true;
    return { ok: true, fh, st };
  } catch {
    return { ok: false, why: 'unsafe' };
  } finally {
    if (!keep) await fh.close().catch(() => {});
  }
}

/** The file's bytes from the open descriptor, reading at most one byte past `max`; null when it holds more. */
export async function readCapped(fh: FileHandle, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buf = Buffer.alloc(Math.min(1024 * 1024, max + 1 - total));
    const { bytesRead } = await fh.read(buf, 0, buf.length, null);
    if (bytesRead === 0) break;
    chunks.push(buf.subarray(0, bytesRead));
    total += bytesRead;
    if (total > max) return null;
  }
  return Buffer.concat(chunks, total);
}

const EXT_RE = /^\.[A-Za-z0-9]{1,16}$/;

/** A copy of an allowed file in the run's folder, or why there is none. Never follows a symlink it did not check. */
export async function snapshotRead(input: SnapshotInput): Promise<SnapshotOutcome> {
  const max = input.maxBytes ?? MAX_SNAPSHOT_BYTES;
  const run = input.run;
  const real = await inSet(input.set, input.requested, input.ctx);
  if (!real) return { ok: false, why: 'outside' };
  const opened = await openAllowed({ set: input.set, ctx: input.ctx, real, maxBytes: max, ...(input.beforeOpen ? { beforeOpen: input.beforeOpen } : {}) });
  if (!opened.ok) return opened;
  const { fh, st } = opened;
  try {
    // The same unchanged file, read again in this run: the copy already made.
    const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
    const made = run.copies.get(key);
    if (made) return { ok: true, path: made.path, source: real, bytes: made.bytes };
    // Reserve the file's size against the run's cap before reading (no await between the check
    // and the reservation), so Reads in parallel never pass the cap together.
    const reserved = Number(st.size);
    if (reserved > run.maxTotal - run.total) return { ok: false, why: 'run_cap' };
    run.total += reserved;
    let used = 0;
    try {
      // Read from the descriptor, never past what was reserved: a file that grew since it was
      // checked changed under the read, and is refused.
      const body = await readCapped(fh, reserved);
      if (body === null) return { ok: false, why: 'unsafe' };
      const ext = extname(real);
      const copy = join(run.dir, `${randomBytes(16).toString('hex')}${EXT_RE.test(ext) ? ext : ''}`);
      await fsp.writeFile(copy, body, { flag: 'wx', mode: 0o600 });
      used = body.length;
      run.copies.set(key, { path: copy, bytes: body.length });
      return { ok: true, path: copy, source: real, bytes: body.length };
    } finally {
      // What was reserved and not copied (a failure, a file that shrank) is given back.
      run.total -= reserved - used;
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Whether process `pid` is known to be gone (kill(pid, 0) says ESRCH); a live one, or one of another user, is not. */
function processGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > PID_MAX || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Remove the snapshot folders a host of this user left behind in `root` (the host's temp
 * directory) before `startedAt` (ms since the epoch): only entries named exactly as a host
 * names them (trs-<pid>- and six letters or digits) whose host process is gone (so never
 * another live host's), that are real folders (never a symlink), owned by this user, mode 700
 * and last changed before the host started. Returns how many it removed.
 */
export async function removeStaleSnapshotDirs(root: string, startedAt: number): Promise<number> {
  const me = typeof process.getuid === 'function' ? process.getuid() : null;
  if (me === null) return 0;
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const m = SNAPSHOT_DIR_RE.exec(name);
    if (!m || !processGone(Number(m[1]))) continue;
    const path = join(root, name);
    const st = await fsp.lstat(path).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory() || st.uid !== me || (st.mode & 0o777) !== 0o700) continue;
    if (!(st.mtimeMs < startedAt)) continue;
    try {
      await fsp.rm(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Left for the next start.
    }
  }
  return removed;
}
