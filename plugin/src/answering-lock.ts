// One answerer per machine (M8-SPEC §1): whoever holds `~/.config/team-relay/answering.lock`
// (XDG_CONFIG_HOME when it is absolute) is the only process that reads the member's `inbox`
// stream. The host (a channel working session's server), a manual answering session
// (bin/answerer's channel server) and the background answerer (M11-SPEC §1, dist/daemon.js) take
// the same lock, so no two of them ever both consume it.
//
// The lock is an exclusively created file (O_CREAT|O_EXCL, mode 600) holding the holder's pid,
// role and start time as JSON. It is stale when that pid is gone. Breaking a stale lock goes
// through a second exclusive file (`answering.lock.break`), so two processes that both saw the
// same stale lock cannot both remove it and each think they won; and (M8-SPEC §7 item 11) it
// never unlinks the lock's name: it renames the lock to a name of its own, checks that what it
// took is exactly the stale content it saw, and only then removes it. A breaker suspended
// between its check and its removal therefore cannot remove a live lock taken meanwhile: it
// finds a different content under its own name and puts it back (link, which never replaces
// a file). The holder releases the same way, only while the file still names its own pid.

import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const LOCK_FILE = 'answering.lock';
/** A lock file younger than this that holds no JSON yet is being written, not stale. */
const WRITING_GRACE_MS = 5_000;
/** A breaker file older than this was left by a process that died mid-break. */
const BREAKER_STALE_MS = 10_000;

export type LockRole = 'host' | 'answerer' | 'daemon';
export type LockInfo = { pid: number; role: LockRole; started_at: string };
export type Held = { ok: false; holder: LockInfo | null };
export type Acquired = { ok: true; path: string; release: () => void };

/** The team relay's config directory: $XDG_CONFIG_HOME/team-relay, else ~/.config/team-relay. */
export function configDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), '.config');
  return join(base, 'team-relay');
}

export function lockPath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), LOCK_FILE);
}

/** Whether a process with this pid exists (EPERM: it does, as another user's). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseInfo(raw: string): LockInfo | null {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid <= 0) return null;
    if (v.role !== 'host' && v.role !== 'answerer' && v.role !== 'daemon') return null;
    return { pid: v.pid, role: v.role, started_at: typeof v.started_at === 'string' ? v.started_at : '' };
  } catch {
    return null;
  }
}

/** Who holds the lock now: a live holder, or null (free, or stale). */
export function readLock(path: string, alive: (pid: number) => boolean = pidAlive): LockInfo | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const info = parseInfo(raw);
  return info && alive(info.pid) ? info : null;
}

function createExclusive(path: string, body: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return true;
}

function ageMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Take the lock file at `path` away under a unique name, and remove it only when it holds
 * exactly what `expected` accepts; otherwise put it back where it was (never over a file that
 * is there by then). Returns whether it removed it (or it was already gone).
 */
export function takeAndRemove(path: string, expected: (content: string) => boolean): boolean {
  const aside = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.taken`;
  try {
    renameSync(path, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
  let content: string | null;
  try {
    content = readFileSync(aside, 'utf8');
  } catch {
    content = null;
  }
  if (content !== null && expected(content)) {
    rmSync(aside, { force: true });
    return true;
  }
  // Not what was expected (a live lock taken meanwhile): back under its name.
  try {
    linkSync(aside, path);
  } catch {
    // Someone else holds the name by now; theirs stands, and this one was not ours to keep.
  }
  rmSync(aside, { force: true });
  return false;
}

/**
 * Remove the lock at `path` when it is still exactly the stale content `seen`, under the
 * breaker file. Returns whether it is gone.
 */
function breakStale(path: string, seen: string): boolean {
  const breaker = `${path}.break`;
  if (!createExclusive(breaker, String(process.pid))) {
    if (ageMs(breaker) < BREAKER_STALE_MS) return false;
    rmSync(breaker, { force: true });
    if (!createExclusive(breaker, String(process.pid))) return false;
  }
  try {
    return takeAndRemove(path, (now) => now === seen);
  } finally {
    rmSync(breaker, { force: true });
  }
}

export function tryAcquire(
  path: string,
  role: LockRole,
  opts: { pid?: number; alive?: (pid: number) => boolean } = {},
): Acquired | Held {
  const pid = opts.pid ?? process.pid;
  const alive = opts.alive ?? pidAlive;
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ pid, role, started_at: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(path, body)) {
      return {
        ok: true,
        path,
        release: () => {
          try {
            takeAndRemove(path, (now) => parseInfo(now)?.pid === pid);
          } catch {
            // already gone
          }
        },
      };
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue; // removed between the two calls: try again
    }
    const info = parseInfo(raw);
    if (info && info.pid === pid) {
      // Ours already (a second acquire in the same process): share it.
      return { ok: true, path, release: () => {} };
    }
    if (info && alive(info.pid)) return { ok: false, holder: info };
    if (!info && ageMs(path) < WRITING_GRACE_MS) return { ok: false, holder: null };
    if (!breakStale(path, raw)) return { ok: false, holder: readLock(path, alive) };
  }
  return { ok: false, holder: readLock(path, alive) };
}

/** Said when the lock is held: who answers instead. */
export function heldBy(holder: LockInfo | null): string {
  if (!holder) return 'another answering session on this computer';
  if (holder.role === 'host') return `a channel working session on this computer (pid ${holder.pid})`;
  if (holder.role === 'daemon') return `the background answerer on this computer (pid ${holder.pid})`;
  return `a manual answering session on this computer (pid ${holder.pid})`;
}
