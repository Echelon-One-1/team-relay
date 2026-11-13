// The allowed set (13 Nov 2026, local folders only): what the answerer may read is the folders the
// member chose, by one reading rule. Inside a git work tree only the files git tracks; a plain
// folder every file (at most 5 MB each), and in it each work tree's tracked files; the deny list,
// sensitive names and symlinks out are always out. Built over a synthetic machine (real git
// repositories, a plain folder of the member's own), with the host's file tools, including a
// property test that list_files and search_files never return a path outside the set.

import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alwaysOut,
  boundariesSentence,
  buildAllowedSet,
  denyContext,
  GitCache,
  homeDir,
  inSet,
  runGit,
  setSummary,
  validBoundaries,
  type AllowedSet,
  type GitRunner,
} from '../src/boundary-set.js';
import { globToRe2, listFiles, searchFiles } from '../src/boundary-tools.js';
import { BOUNDARIES, FOLDERS, MY_FOLDER, REPO_ROOT, git, makeFixture, type Fixture } from './helpers/boundary-fixture.js';

let f: Fixture;
let set: AllowedSet;

const build = (folders: string[], extra: Partial<Parameters<typeof buildAllowedSet>[0]> = {}) => buildAllowedSet({ version: 1, member: { folders }, env: f.env, ...extra });

beforeAll(async () => {
  f = makeFixture();
  set = await build(FOLDERS);
});

describe('the allowed set: the folders the member chose, by the reading rule', () => {
  it('holds exactly the allowed files of the chosen folders, one area per folder', () => {
    expect([...set.files.keys()].sort()).toEqual([...f.allowed].sort());
    expect(set.areas.map((a) => a.name)).toEqual(['folder:example-org', 'folder:team']);
    expect(set.areas.map((a) => a.root)).toEqual([f.repoRoot, f.myFolder]);
    expect(set.notes).toEqual([]);
    expect(setSummary(set)).toBe(`2 of your folders (example-org, team); ${f.allowed.length} files`);
  });

  it('leaves out every forbidden file, and inSet denies each of them', async () => {
    const ctx = denyContext(f.env);
    for (const [why, p] of Object.entries(f.forbidden)) {
      expect(existsSync(p) || why === 'gitInternals', why).toBe(true);
      expect(set.files.has(p), why).toBe(false);
      expect(await inSet(set, p, ctx), why).toBeNull();
    }
  });

  it('the chosen folder is the repository: only its tracked files; untracked and ignored files are out', async () => {
    const s = await build([`${REPO_ROOT}/alpha`]);
    expect(s.areas.map((a) => a.name)).toEqual(['folder:alpha']);
    expect([...s.files.keys()].sort()).toEqual(['.gitignore', 'README.md', 'docs/Mixed Case.MD', 'docs/guide.md'].map((r) => join(f.alpha, r)).sort());
    for (const p of [f.forbidden.untracked!, f.forbidden.ignored!, f.forbidden.ignoredLog!]) expect(s.files.has(p), p).toBe(false);
    // A folder inside a work tree: that tree's tracked files under it.
    const docs = await build([`${REPO_ROOT}/alpha/docs`]);
    expect([...docs.files.keys()].sort()).toEqual([join(f.alpha, 'docs', 'Mixed Case.MD'), join(f.alpha, 'docs', 'guide.md')]);
  });

  it('the chosen folder is a plain folder holding repositories: its own files all, each repository only by what git tracks', async () => {
    const s = await build([REPO_ROOT]);
    expect(s.files.has(join(f.repoRoot, 'README.md'))).toBe(true);
    expect(s.files.has(join(f.repoRoot, 'clients', 'index.md'))).toBe(true);
    expect(s.files.has(join(f.alpha, 'README.md'))).toBe(true);
    expect(s.files.has(join(f.repoRoot, 'clients', 'beta', 'plan.md'))).toBe(true);
    expect(s.files.has(join(f.repoRoot, 'clients', 'x', 'y', 'deep', 'd.md'))).toBe(true);
    for (const k of ['untracked', 'ignored', 'ignoredLog', 'betaUntracked', 'submodule', 'nodeModules', 'dotFolder', 'repoRootEnv']) {
      expect(s.files.has(f.forbidden[k]!), k).toBe(false);
    }
  });

  it('a plain folder of the member\'s own: every file, except big ones, dot entries, credentials, sensitive names and symlinks out', async () => {
    const s = await build([MY_FOLDER]);
    expect([...s.files.keys()].sort()).toEqual(['Clients/plan.md', 'Roadmap.gdoc', 'ideas.md'].map((r) => join(f.myFolder, r)).sort());
    for (const k of ['myFolderEnv', 'tooBig', 'hidden', 'sensitive', 'myFolderSymlinkOut']) expect(s.files.has(f.forbidden[k]!), k).toBe(false);
  });

  it('the deny list, sensitive names and secret names stay out even when git tracks them', () => {
    for (const k of ['trackedEnv', 'trackedPem', 'trackedSecrets', 'trackedTfstate', 'trackedAwsUpper', 'gitInternals']) {
      expect(set.files.has(f.forbidden[k]!), k).toBe(false);
    }
  });

  it('a symlink leading out stays out, tracked or not, file or folder', () => {
    for (const k of ['symlinkOut', 'swappedDir', 'untrackedLinkDir', 'myFolderSymlinkOut', 'outside']) expect(set.files.has(f.forbidden[k]!), k).toBe(false);
    for (const p of set.files.keys()) expect(p.startsWith(f.outside), p).toBe(false);
  });

  it('a folder the member did not choose is out; nothing chosen, nothing read', async () => {
    expect(set.files.has(f.forbidden.notChosen!)).toBe(false);
    const none = await build([]);
    expect(none.files.size).toBe(0);
    expect(setSummary(none)).toBe('none of your folders; 0 files');
  });

  it('a symlink to a file in the set is read as that file; case is the file\'s own', async () => {
    const ctx = denyContext(f.env);
    expect(await inSet(set, join(f.alpha, 'link-in.md'), ctx)).toBe(join(f.alpha, 'README.md'));
    // macOS: a different case resolves to the file's own name (Linux: no such file, so out).
    const lower = await inSet(set, join(f.alpha, 'docs', 'mixed case.md'), ctx);
    expect(lower === null || lower === join(f.alpha, 'docs', 'Mixed Case.MD')).toBe(true);
    expect(await inSet(set, join(f.alpha, 'docs', '..', 'README.md'), ctx)).toBe(join(f.alpha, 'README.md'));
  });

  it('the deny list holds at any depth and without case', () => {
    const ctx = denyContext(f.env);
    for (const p of ['/x/.env', '/x/.ENV', '/x/a/ID_RSA', '/x/y.PEM', '/x/.Aws/config', '/x/.git/config', '/x/terraform.tfstate', '/x/Secrets.yaml', `${f.home}/.ssh/config`]) {
      expect(alwaysOut(p, ctx), p).toBe(true);
    }
    expect(alwaysOut('/x/docs/readme.md', ctx)).toBe(false);
  });

  it('a refused folders file gives nothing, and says why; a folder that cannot be used is skipped with a note', async () => {
    const s = await buildAllowedSet({ version: 1, member: { error: 'mode 644' }, env: f.env });
    expect(s.areas).toEqual([]);
    expect(s.notes[0]).toMatch(/your folders file cannot be used \(mode 644\)/);
    const gone = await build(['~/code/gone', MY_FOLDER]);
    expect(gone.areas.map((a) => a.name)).toEqual(['folder:team']);
    expect(gone.notes).toEqual(['folder "~/code/gone" is not used: it does not exist']);
  });

  it('two chosen folders with the same name get distinct area names', async () => {
    const other = join(f.home, 'work', 'team');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'w.md'), 'work team\n');
    try {
      const s = await build([MY_FOLDER, '~/work/team']);
      expect(s.areas.map((a) => a.name)).toEqual(['folder:team', 'folder:team (2)']);
    } finally {
      rmSync(join(f.home, 'work'), { recursive: true });
    }
  });

  it('ls-files is cached while HEAD and the index stay the same, and read again when they change', async () => {
    const calls: string[][] = [];
    const counting: GitRunner = (cwd, args, env) => {
      calls.push(args);
      return runGit(cwd, args, env);
    };
    const cache = new GitCache();
    const lsFiles = () => calls.filter((a) => a.includes('ls-files')).length;
    await build(FOLDERS, { git: counting, cache });
    // alpha, beta and deep (the submodule, node_modules and dot folders are never walked into).
    expect(lsFiles()).toBe(3);
    await build(FOLDERS, { git: counting, cache });
    expect(lsFiles()).toBe(3);
    const beta = join(f.repoRoot, 'clients', 'beta');
    writeFileSync(join(beta, 'new.md'), 'new\n');
    git(beta, f.home, 'add', 'new.md');
    const again = await build(FOLDERS, { git: counting, cache });
    expect(lsFiles()).toBe(4);
    expect(again.files.has(join(beta, 'new.md'))).toBe(true);
    git(beta, f.home, 'rm', '-q', '--cached', 'new.md');
    rmSync(join(beta, 'new.md'));
  });

  it('one home rule for the set and the deny list: $HOME, else the account\'s own when unset or blank', () => {
    expect(homeDir({ HOME: '/Users/alice' })).toBe('/Users/alice'); // e1-guard: allow (synthetic test path)
    expect(homeDir({ HOME: '  ' })).toBe(homedir());
    expect(homeDir({})).toBe(homedir());
    expect(denyContext({ HOME: '' }).home).toBe(homedir());
  });
});

describe('validBoundaries and the SessionStart sentence', () => {
  it('validBoundaries accepts the relay shape (the topic alone) and refuses others', () => {
    expect(validBoundaries({ team: 'demo', version: 0, boundaries: null })).toBe(true);
    expect(validBoundaries({ version: 2, boundaries: BOUNDARIES })).toBe(true);
    expect(validBoundaries({ version: 2, boundaries: { ...BOUNDARIES, extra: 1 } })).toBe(false);
    expect(validBoundaries({ version: '2', boundaries: null })).toBe(false);
    // An earlier relay's document is reduced to the topic.
    const old: Record<string, unknown> = { version: 2, boundaries: { ...BOUNDARIES, github_orgs: ['example-org'], member_folders: true }, since: null };
    expect(validBoundaries(old)).toBe(true);
    expect(old.boundaries).toEqual(BOUNDARIES);
    expect('since' in old).toBe(false);
  });

  it('says whether the member accepted, what answers come from, and what was dropped; one line', () => {
    const at = 'https://relay.example.com';
    const two = { folders: FOLDERS, dropped: [] };
    expect(boundariesSentence(3, two, 3, at)).toBe(
      'Your team has boundaries (version 3): your answerer answers teammates on its own from your 2 chosen folders (only the files git tracks inside a repository; /team-relay:folders list shows them); reads of anything else are denied and off-topic questions declined.',
    );
    const not = boundariesSentence(3, two, 0, at);
    expect(not).toMatch(/^Your team has boundaries \(version 3\) that you have not accepted yet, so teammates' questions to you are declined\. Accept them in the console at https:\/\/relay\.example\.com/);
    // An acceptance past the current version (an earlier team under this id) is not one.
    expect(boundariesSentence(3, two, 4, at)).toContain('not accepted yet');
    expect(boundariesSentence(3, { folders: [], dropped: [] }, 3, at)).toContain('nothing yet: you have chosen no folders');
    const dropped = boundariesSentence(3, { folders: FOLDERS, dropped: ['~/a', '~/b'] }, 3, at);
    expect(dropped).toContain('Only 20 folders can be used: "~/a", "~/b" were dropped. Save your folders (/team-relay:folders or /team-relay:setup) to make this permanent.');
    const err = boundariesSentence(3, { error: 'mode 644\nignore' }, 3, at);
    expect(err).toMatch(/^Your team has boundaries \(version 3\), but your folders file cannot be used/);
    for (const line of [not, dropped]) expect(line).not.toContain('\n');
  });
});

describe('the host file tools never leave the set (ACC-4)', () => {
  /** A small deterministic generator (no Math.random: the same cases every run). */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;

  it('list_files and search_files return only paths in the set, over many generated calls', async () => {
    const r = rng(20261110);
    const globs = ['', '*', '**', '**/*', '*.md', '**/*.md', 'docs/*', '**/.env', '.env', '*.pem', '**/*.txt', 'build/**', '**/out.js', 'sub/*', 'link-*', '*', 'outside-link/**', '../**', '/**', '**/..', '?*', 'Ops/*', 'alpha/**', 'node_modules/**'];
    const areas = ['', ...set.areas.map((a) => a.name), ...set.areas.map((a) => a.name.replace(/^[a-z]+:/, '')), 'folder:other', 'alpha'];
    const patterns = ['.', '(?i)outside', 'API_TOKEN', 'db:', 'hidden', 'other', 'ignored', 'untracked', '^', 'swapped', '(?i)[a-z]+', 'package', 'submodule'];
    const inSetPaths = new Set(set.files.keys());
    const forbidden = new Set(Object.values(f.forbidden));
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const args: Record<string, unknown> = {};
      const g = pick(r, globs);
      const a = pick(r, areas);
      if (g) args.glob = g;
      if (a) args.area = a;
      if (r() < 0.5) {
        const out = listFiles(set, args);
        if (!out.ok) continue;
        for (const p of out.result.files as string[]) {
          expect(inSetPaths.has(p), p).toBe(true);
          expect(forbidden.has(p), p).toBe(false);
          checked++;
        }
      } else {
        const out = await searchFiles(set, { ...args, pattern: pick(r, patterns), max_results: 200 }, { ctx: denyContext(f.env) });
        if (!out.ok) continue;
        for (const hit of out.result.results as Array<{ path: string; text: string }>) {
          expect(inSetPaths.has(hit.path), hit.path).toBe(true);
          expect(forbidden.has(hit.path), hit.path).toBe(false);
          for (const t of ['outside the boundaries', 'untracked notes', 'ignored build output', 'swapped in from outside', 'API_TOKEN', 'submodule file', 'package', 'did not choose']) {
            expect(hit.text).not.toContain(t);
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('a file swapped for a symlink after the set was built is not searched', async () => {
    const local = await build([REPO_ROOT]);
    const target = join(f.repoRoot, 'clients', 'x', 'y', 'deep', 'd.md');
    expect(local.files.has(target)).toBe(true);
    rmSync(target);
    symlinkSync(join(f.outside, 'private.md'), target);
    try {
      const out = await searchFiles(local, { pattern: 'outside' }, { ctx: denyContext(f.env) });
      expect(out.ok && out.result.results).toEqual([]);
    } finally {
      rmSync(target);
      writeFileSync(target, 'deep\n');
    }
  });

  // M10-SPEC §7.3: search_files opens a file the way a Read snapshot does (snapshot.ts openAllowed).
  describe('search_files opens only the file the set holds (no symlink, no FIFO, same inode)', () => {
    const plainSet = (root: string, files: string[]): AllowedSet => {
      const area = { kind: 'folder' as const, name: 'folder:x', root, files: [...files].sort(), truncated: false };
      return { version: 1, areas: [area], files: new Map(files.map((p) => [p, area])), notes: [] };
    };
    const tree = () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'trs-search-')));
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trs-search-out-')));
      writeFileSync(join(outside, 'plan.md'), 'SECRET FROM OUTSIDE\n');
      mkdirSync(join(outside, 'sub'));
      writeFileSync(join(outside, 'sub', 'inner.md'), 'SECRET FROM OUTSIDE\n');
      mkdirSync(join(root, 'sub'));
      writeFileSync(join(root, 'plan.md'), 'plan inside\n');
      writeFileSync(join(root, 'sub', 'inner.md'), 'inner inside\n');
      const files = [join(root, 'plan.md'), join(root, 'sub', 'inner.md')];
      return { root, outside, files, set: plainSet(root, files) };
    };
    const texts = (out: Awaited<ReturnType<typeof searchFiles>>) => (out.ok ? (out.result.results as Array<{ text: string }>).map((r) => r.text) : null);

    it('a parent folder swapped for a symlink after the set was built is not searched', async () => {
      const t = tree();
      renameSync(join(t.root, 'sub'), join(t.root, 'sub-old'));
      symlinkSync(join(t.outside, 'sub'), join(t.root, 'sub'));
      expect(texts(await searchFiles(t.set, { pattern: '.' }, { ctx: denyContext(f.env) }))).toEqual(['plan inside']);
    });

    it('a file or a parent folder swapped between the check and the open is not searched', async () => {
      const t = tree();
      const [plan, inner] = t.files as [string, string];
      let swapped = 0;
      const out = await searchFiles(t.set, { pattern: '.' }, {
        ctx: denyContext(f.env),
        beforeOpen: (p) => {
          swapped++;
          if (p === plan) {
            rmSync(plan);
            symlinkSync(join(t.outside, 'plan.md'), plan);
          } else if (p === inner) {
            renameSync(join(t.root, 'sub'), join(t.root, 'sub-old'));
            symlinkSync(join(t.outside, 'sub'), join(t.root, 'sub'));
          }
        },
      });
      expect(swapped).toBe(2);
      expect(texts(out)).toEqual([]);
      expect(out.ok && out.result.files_skipped).toBe(2);
    });

    it('a FIFO swapped in never blocks the search', async () => {
      const t = tree();
      const [plan, inner] = t.files as [string, string];
      // In place before the search (no writer: a blocking open would never return).
      rmSync(plan);
      execFileSync('mkfifo', [plan]);
      const before = await searchFiles(t.set, { pattern: '.' }, { ctx: denyContext(f.env) });
      expect(texts(before)).toEqual(['inner inside']);
      expect(before.ok && before.result.files_skipped).toBe(1);
      // Swapped in between the check and the open.
      const raced = await searchFiles(t.set, { pattern: '.' }, {
        ctx: denyContext(f.env),
        beforeOpen: (p) => {
          if (p !== inner) return;
          rmSync(inner);
          execFileSync('mkfifo', [inner]);
        },
      });
      expect(texts(raced)).toEqual([]);
      expect(raced.ok && raced.result.files_skipped).toBe(2);
    });
  });

  it('globs are matched with RE2: *, ** and ? only, everything else literal', () => {
    const m = (g: string, p: string) => globToRe2(g).matches(p);
    expect(m('*.md', 'a.md')).toBe(true);
    expect(m('*.md', 'docs/a.md')).toBe(false);
    expect(m('**/*.md', 'docs/x/a.md')).toBe(true);
    expect(m('**/*.md', 'a.md')).toBe(true);
    expect(m('docs/**', 'docs/x/y')).toBe(true);
    expect(m('a?c', 'abc')).toBe(true);
    expect(m('a.c', 'abc')).toBe(false);
    expect(m('(a|b)', 'a')).toBe(false);
    expect(m('[ab]', 'a')).toBe(false);
    expect(m('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(200))).toBe(false);
  });

  it('list_files: areas, a glob, an unknown area', () => {
    const all = listFiles(set, {});
    expect(all.ok && all.result.total).toBe(set.files.size);
    expect(all.ok && (all.result.areas as Array<{ area: string }>).map((a) => a.area)).toEqual(['folder:example-org', 'folder:team']);
    const md = listFiles(set, { area: 'example-org', glob: 'alpha/docs/*' });
    expect(md.ok && md.result.files).toEqual([join(f.alpha, 'docs', 'Mixed Case.MD'), join(f.alpha, 'docs', 'guide.md')]);
    const bad = listFiles(set, { area: 'nope' });
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.message).toMatch(/^there is no area "nope"; the areas are: /);
  });

  it('search_files: RE2 only, results capped, a line that looks like a secret withheld, binary skipped', async () => {
    expect(await searchFiles(set, { pattern: '(a+)+\\1' }, { ctx: denyContext(f.env) })).toMatchObject({ ok: false, message: 'pattern is not a valid RE2 regular expression' });
    expect(await searchFiles(set, { pattern: '' }, { ctx: denyContext(f.env) })).toMatchObject({ ok: false });
    expect(await searchFiles(set, { pattern: 'x', max_results: 0 }, { ctx: denyContext(f.env) })).toMatchObject({ ok: false });
    const hits = await searchFiles(set, { pattern: '(?i)EUROPE-west3' }, { ctx: denyContext(f.env) });
    expect(hits.ok && hits.result.results).toEqual([{ path: join(f.alpha, 'README.md'), line: 1, text: 'alpha: the staging bucket lives in europe-west3.' }]);
    const capped = await searchFiles(set, { pattern: '.', max_results: 2 }, { ctx: denyContext(f.env) });
    expect(capped.ok && (capped.result.results as unknown[]).length).toBe(2);
    expect(capped.ok && capped.result.note).toBe('stopped at max_results (2)');
    // A tracked file with a secret-looking line, and a binary one.
    const beta = join(f.repoRoot, 'clients', 'beta');
    writeFileSync(join(beta, 'ops.md'), 'deploy notes\nDB_PASSWORD=hunter2hunter2\n');
    writeFileSync(join(beta, 'blob.dat'), Buffer.from([0, 1, 2, 3, 100, 101, 112, 108, 111, 121]));
    git(beta, f.home, 'add', 'ops.md', 'blob.dat');
    try {
      const s2 = await build([REPO_ROOT]);
      const found = await searchFiles(s2, { pattern: 'DB_PASSWORD|deploy', glob: 'clients/beta/*' }, { ctx: denyContext(f.env) });
      expect(found.ok && found.result.results).toEqual([
        { path: join(beta, 'ops.md'), line: 1, text: 'deploy notes' },
        { path: join(beta, 'ops.md'), line: 2, text: '[line withheld: it may contain a credential]' },
      ]);
      expect(found.ok && found.result.files_skipped).toBe(1);
    } finally {
      git(beta, f.home, 'rm', '-q', '--cached', 'ops.md', 'blob.dat');
      rmSync(join(beta, 'ops.md'));
      rmSync(join(beta, 'blob.dat'));
    }
  });
});
