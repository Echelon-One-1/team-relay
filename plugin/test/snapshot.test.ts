// M10-SPEC §7.3: reads are snapshots. The host opens an allowed file itself (O_NOFOLLOW), checks
// it is a regular file still at its canonical path in the set, and copies it (cap 10 MB) into
// the run's private folder; the answerer only ever gets the copy's path.

import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionResult } from '../src/answer-tools.js';
import { buildAllowedSet, denyContext, type AllowedSet, type Area } from '../src/boundary-set.js';
import { MAX_RUN_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES, removeStaleSnapshotDirs, snapshotDirPrefix, snapshotRead, snapshotRun } from '../src/snapshot.js';
import { REPO_ROOT, makeFixture, type Fixture } from './helpers/boundary-fixture.js';

let f: Fixture;
let set: AllowedSet;

beforeAll(async () => {
  f = makeFixture();
  set = await buildAllowedSet({ version: 1, member: { folders: [REPO_ROOT] }, env: f.env });
});

function runDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'trs-test-')));
  return d;
}

/** A set holding exactly these files, in one plain area (for files the fixture does not have). */
function setOf(root: string, files: string[]): AllowedSet {
  const area: Area = { kind: 'folder', name: 'folder:x', root, files: [...files].sort(), truncated: false };
  return { version: 1, areas: [area], files: new Map(files.map((p) => [p, area])), notes: [] };
}

describe('Read snapshots (M10-SPEC §7.3)', () => {
  it('copies an allowed file into the run folder under a fresh name that keeps the extension', async () => {
    const dir = runDir();
    const run = snapshotRun(dir);
    const ctx = denyContext(f.env);
    const src = join(f.repoRoot, 'alpha', 'README.md');
    const a = await snapshotRead({ set, ctx, requested: src, run });
    // Another run (another question) never gets this run's copy.
    const b = await snapshotRead({ set, ctx, requested: src, run: snapshotRun(dir) });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.path).toMatch(new RegExp(`^${dir}/[0-9a-f]{32}\\.md$`));
    expect(b.path).not.toBe(a.path);
    expect(a.source).toBe(realpathSync(src));
    expect(readFileSync(a.path, 'utf8')).toBe(readFileSync(src, 'utf8'));
    expect(statSync(a.path).mode & 0o777).toBe(0o600);
    // A file reached through a link inside the set is copied from where it really is.
    const viaLink = await snapshotRead({ set, ctx, requested: join(f.repoRoot, 'alpha', 'link-in.md'), run });
    expect(viaLink).toMatchObject({ ok: true, source: realpathSync(src) });
    rmSync(dir, { recursive: true });
  });

  it('keeps binary content and the extension (a PDF or an image still renders); an odd extension is dropped', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'trs-src-')));
    const pdf = join(root, 'report.PDF');
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a, 0x80]);
    writeFileSync(pdf, bytes);
    const odd = join(root, 'notes.<x>');
    writeFileSync(odd, 'odd');
    const s = setOf(root, [pdf, odd]);
    const dir = runDir();
    const run = snapshotRun(dir);
    const p = await snapshotRead({ set: s, ctx: denyContext(f.env), requested: pdf, run });
    expect(p.ok && p.path.endsWith('.PDF')).toBe(true);
    if (p.ok) expect(readFileSync(p.path).equals(bytes)).toBe(true);
    const o = await snapshotRead({ set: s, ctx: denyContext(f.env), requested: odd, run });
    expect(o.ok && /\/[0-9a-f]{32}$/.test(o.path)).toBe(true);
  });

  it('a path outside the set, or on the deny list, is never copied', async () => {
    const dir = runDir();
    const run = snapshotRun(dir);
    const ctx = denyContext(f.env);
    for (const p of [f.forbidden.untracked!, f.forbidden.symlinkOut!, f.forbidden.trackedEnv!, f.forbidden.outside!, '/etc/hosts']) {
      expect(await snapshotRead({ set, ctx, requested: p, run }), p).toEqual({ ok: false, why: 'outside' });
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a file swapped for a symlink after the set was built is never followed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'trs-src-')));
    const outside = join(root, '..', `${root.split('/').pop()}-outside.md`);
    writeFileSync(outside, 'SECRET FROM OUTSIDE\n');
    const file = join(root, 'plan.md');
    writeFileSync(file, 'plan\n');
    const s = setOf(root, [file]);
    const dir = runDir();
    const run = snapshotRun(dir);
    // Swapped before the check: it now leads outside the set.
    rmSync(file);
    symlinkSync(outside, file);
    expect(await snapshotRead({ set: s, ctx: denyContext(f.env), requested: file, run })).toEqual({ ok: false, why: 'outside' });
    // Swapped between the check and the open: O_NOFOLLOW refuses the link.
    rmSync(file);
    writeFileSync(file, 'plan\n');
    const raced = await snapshotRead({
      set: s,
      ctx: denyContext(f.env),
      requested: file,
      run,
      beforeOpen: () => {
        rmSync(file);
        symlinkSync(outside, file);
      },
    });
    expect(raced).toEqual({ ok: false, why: 'unsafe' });
    // A folder above it swapped between the check and the open: the open file is not the one at the path.
    rmSync(file);
    const sub = join(root, 'sub');
    mkdirSync(sub);
    const inner = join(sub, 'inner.md');
    writeFileSync(inner, 'inner\n');
    const elsewhere = join(root, '..', `${root.split('/').pop()}-elsewhere`);
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'inner.md'), 'SECRET FROM ELSEWHERE\n');
    const s2 = setOf(root, [inner]);
    const swappedDir = await snapshotRead({
      set: s2,
      ctx: denyContext(f.env),
      requested: inner,
      run,
      beforeOpen: () => {
        renameSync(sub, join(root, 'sub-old'));
        symlinkSync(elsewhere, sub);
      },
    });
    expect(swappedDir).toEqual({ ok: false, why: 'unsafe' });
    // Nothing was copied, so nothing from outside reached the run folder.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a FIFO swapped in is refused without blocking; a file over 10 MB is refused', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'trs-src-')));
    const file = join(root, 'pipe.md');
    writeFileSync(file, 'x');
    const s = setOf(root, [file]);
    const dir = runDir();
    const run = snapshotRun(dir);
    const fifo = await snapshotRead({
      set: s,
      ctx: denyContext(f.env),
      requested: file,
      run,
      beforeOpen: () => {
        rmSync(file);
        execFileSync('mkfifo', [file]);
      },
    });
    expect(fifo).toEqual({ ok: false, why: 'unsafe' });
    const big = join(root, 'big.txt');
    writeFileSync(big, Buffer.alloc(MAX_SNAPSHOT_BYTES + 1, 0x61));
    const atCap = join(root, 'cap.txt');
    writeFileSync(atCap, Buffer.alloc(MAX_SNAPSHOT_BYTES, 0x61));
    const s2 = setOf(root, [big, atCap]);
    expect(await snapshotRead({ set: s2, ctx: denyContext(f.env), requested: big, run })).toEqual({ ok: false, why: 'too_large' });
    const ok = await snapshotRead({ set: s2, ctx: denyContext(f.env), requested: atCap, run });
    expect(ok.ok && statSync(ok.path).size === MAX_SNAPSHOT_BYTES).toBe(true);
    // A file that grew past the cap after the set was built is refused too.
    const growing = join(root, 'grow.txt');
    writeFileSync(growing, 'small');
    const s3 = setOf(root, [growing]);
    const grew = await snapshotRead({
      set: s3,
      ctx: denyContext(f.env),
      requested: growing,
      run,
      maxBytes: 16,
      beforeOpen: () => {
        writeFileSync(growing, 'x'.repeat(17));
      },
    });
    expect(grew).toEqual({ ok: false, why: 'too_large' });
  });

  it('within one run, the same unchanged file is copied once; a changed one is copied again', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'trs-src-')));
    const file = join(root, 'notes.md');
    writeFileSync(file, 'first\n');
    const other = join(root, 'other.md');
    writeFileSync(other, 'other\n');
    const s = setOf(root, [file, other]);
    const ctx = denyContext(f.env);
    const dir = runDir();
    const run = snapshotRun(dir);
    const a = await snapshotRead({ set: s, ctx, requested: file, run });
    const again = await snapshotRead({ set: s, ctx, requested: file, run });
    expect(a.ok && again.ok).toBe(true);
    if (!a.ok || !again.ok) return;
    expect(again.path).toBe(a.path);
    expect(run.total).toBe(6);
    expect(readdirSync(dir)).toHaveLength(1);
    // Another file is its own copy.
    const o = await snapshotRead({ set: s, ctx, requested: other, run });
    expect(o.ok && o.path !== a.path).toBe(true);
    // Changed (size and modification time): copied again, with what it says now.
    writeFileSync(file, 'second, longer\n');
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const changed = await snapshotRead({ set: s, ctx, requested: file, run });
    expect(changed.ok && changed.path !== a.path).toBe(true);
    if (changed.ok) expect(readFileSync(changed.path, 'utf8')).toBe('second, longer\n');
    // Same size, new modification time: copied again too.
    writeFileSync(file, 'third, longer.\n');
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    const touched = await snapshotRead({ set: s, ctx, requested: file, run });
    expect(touched.ok && changed.ok && touched.path !== changed.path).toBe(true);
    if (touched.ok) expect(readFileSync(touched.path, 'utf8')).toBe('third, longer.\n');
    expect(readdirSync(dir)).toHaveLength(4);
  });

  it('a run copies at most 100 MB in all; past that a Read is denied (a reused copy costs nothing)', async () => {
    expect(MAX_RUN_SNAPSHOT_BYTES).toBe(100 * 1024 * 1024);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'trs-src-')));
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((n, i) => {
      const p = join(root, n);
      writeFileSync(p, Buffer.alloc(40 + i, 0x61));
      return p;
    });
    const s = setOf(root, files);
    const ctx = denyContext(f.env);
    // A cap of 100 bytes stands for the 100 MB.
    const run = snapshotRun(runDir(), 100);
    expect(await snapshotRead({ set: s, ctx, requested: files[0]!, run })).toMatchObject({ ok: true, bytes: 40 });
    expect(await snapshotRead({ set: s, ctx, requested: files[1]!, run })).toMatchObject({ ok: true, bytes: 41 });
    expect(run.total).toBe(81);
    // 42 more would pass 100.
    expect(await snapshotRead({ set: s, ctx, requested: files[2]!, run })).toEqual({ ok: false, why: 'run_cap' });
    // A file already copied is still read.
    expect(await snapshotRead({ set: s, ctx, requested: files[0]!, run })).toMatchObject({ ok: true, bytes: 40 });
    expect(run.total).toBe(81);
    // A file that grew past what is left between the check and the read is refused too.
    const small = join(root, 'small.txt');
    writeFileSync(small, 'x');
    const s2 = setOf(root, [small]);
    const grew = await snapshotRead({ set: s2, ctx, requested: small, run, beforeOpen: () => writeFileSync(small, Buffer.alloc(20, 0x62)) });
    expect(grew).toEqual({ ok: false, why: 'run_cap' });
    expect(run.total).toBe(81);
    // A new run starts again from nothing.
    expect(await snapshotRead({ set: s, ctx, requested: files[2]!, run: snapshotRun(runDir(), 100) })).toMatchObject({ ok: true, bytes: 42 });
  });

  it('parallel Reads never pass the run cap together: each reserves its bytes before reading', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'trs-src-')));
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((n) => {
      const p = join(root, n);
      writeFileSync(p, Buffer.alloc(40, 0x61));
      return p;
    });
    const s = setOf(root, files);
    const ctx = denyContext(f.env);
    const dir = runDir();
    const run = snapshotRun(dir, 100);
    const outcomes = await Promise.all(files.map((requested) => snapshotRead({ set: s, ctx, requested, run })));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
    expect(outcomes.filter((o) => !o.ok)).toEqual([
      { ok: false, why: 'run_cap' },
      { ok: false, why: 'run_cap' },
    ]);
    expect(run.total).toBe(80);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('a Read that fails after reserving gives its bytes back', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'trs-src-')));
    const file = join(root, 'a.txt');
    writeFileSync(file, Buffer.alloc(60, 0x61));
    const s = setOf(root, [file]);
    const ctx = denyContext(f.env);
    // The run's folder is gone: the copy cannot be written.
    const gone = join(runDir(), 'missing');
    const run = snapshotRun(gone, 100);
    await expect(snapshotRead({ set: s, ctx, requested: file, run })).rejects.toThrow();
    expect(run.total).toBe(0);
    mkdirSync(gone, { mode: 0o700 });
    expect(await snapshotRead({ set: s, ctx, requested: file, run })).toMatchObject({ ok: true, bytes: 60 });
    expect(run.total).toBe(60);
  });

  it('the permission result carries the host\'s updated input; other Read parameters pass through', () => {
    const input = { file_path: '/member/path.md', offset: 10, limit: 20 };
    const updated = { ...input, file_path: '/run/abc.md' };
    expect(JSON.parse(permissionResult({ allow: true, updatedInput: updated }, input))).toEqual({ behavior: 'allow', updatedInput: updated });
    expect(JSON.parse(permissionResult({ allow: true }, input))).toEqual({ behavior: 'allow', updatedInput: input });
    expect(JSON.parse(permissionResult({ allow: true, updatedInput: 'x' }, input))).toEqual({ behavior: 'allow', updatedInput: input });
    expect(JSON.parse(permissionResult({ allow: false, updatedInput: updated }, input))).toEqual({ behavior: 'deny', message: 'The member did not allow this.' });
  });
});

describe('stale snapshot folders (M10-SPEC §7.3)', () => {
  /** The pid of a process that has ended (and been reaped). */
  const deadPid = () => {
    const r = spawnSync(process.execPath, ['-e', '']);
    expect(r.status).toBe(0);
    return r.pid!;
  };

  it('at host start, only this user\'s own trs-<pid>-XXXXXX folders of ended hosts, from before the start, are removed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'trs-root-')));
    const start = Date.now();
    const past = new Date(start - 3_600_000);
    const future = new Date(start + 3_600_000);
    const dir = (name: string, mode = 0o700, when: Date = past) => {
      const p = join(root, name);
      mkdirSync(p);
      writeFileSync(join(p, 'copy.md'), 'left behind\n');
      chmodSync(p, mode);
      utimesSync(p, when, when);
      return p;
    };
    const dead = deadPid();
    const stale = [dir(`trs-${dead}-Ab12Cd`), dir(`trs-${dead}-000000`)];
    const kept = [
      dir(`trs-${process.pid}-Ab12Cd`), // a live host (this process)
      dir(`trs-${process.ppid}-Ab12Cd`), // a live process
      dir('trs-1-Ab12Cd'), // alive, another user's (EPERM): not known to be gone
      dir('trs-0-Ab12Cd'), // no process id
      dir(`trs-0${dead}-Ab12Cd`), // not as the host writes it
      dir('trs-Ab12Cd'), // no process id at all
      dir(`trs-${dead}-Ab12C`), // five characters
      dir(`trs-${dead}-Ab12Cde`), // seven
      dir(`trs-${dead}-Ab-2Cd`), // not a letter or digit
      dir(`trs-test-${dead}-Ab12Cd`),
      dir(`xtrs-${dead}-Ab12Cd`),
      dir(`trh-${dead}-Ab12Cd`), // the socket's folder
      dir(`trs-${dead}-Op3nRn`, 0o700, future), // changed after the start
      dir(`trs-${dead}-Mode55`, 0o755),
    ];
    // A symlink with the name, to a folder of the user's elsewhere: never followed, never removed.
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'trs-target-')));
    writeFileSync(join(target, 'keep.md'), 'keep\n');
    chmodSync(target, 0o700);
    utimesSync(target, past, past);
    symlinkSync(target, join(root, `trs-${dead}-Link01`));
    // A file with the name.
    writeFileSync(join(root, `trs-${dead}-File01`), 'x');
    chmodSync(join(root, `trs-${dead}-File01`), 0o700);
    utimesSync(join(root, `trs-${dead}-File01`), past, past);

    expect(await removeStaleSnapshotDirs(root, start)).toBe(2);
    for (const p of stale) expect(existsSync(p), p).toBe(false);
    for (const p of kept) expect(existsSync(join(p, 'copy.md')), p).toBe(true);
    expect(lstatSync(join(root, `trs-${dead}-Link01`)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, 'keep.md'))).toBe(true);
    expect(existsSync(join(root, `trs-${dead}-File01`))).toBe(true);
    // A folder that is not there is nothing to do.
    expect(await removeStaleSnapshotDirs(join(root, 'missing'), start)).toBe(0);
  });

  it('the host makes its run folders by the same pattern, with its own process id, and never removes its own', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'trs-root-')));
    expect(snapshotDirPrefix()).toBe(`trs-${process.pid}-`);
    const made = mkdtempSync(join(root, snapshotDirPrefix()));
    chmodSync(made, 0o700);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(made, past, past);
    expect(made.split('/').pop()).toMatch(new RegExp(`^trs-${process.pid}-[A-Za-z0-9]{6}$`));
    expect(await removeStaleSnapshotDirs(root, Date.now())).toBe(0);
    expect(existsSync(made)).toBe(true);
  });
});
