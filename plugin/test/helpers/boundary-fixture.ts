// A synthetic member machine for boundary mode (synthetic data only; 13 Nov 2026, local folders
// only): a home directory with a plain folder of clones (real `git init` repositories with fake
// origins; tracked, untracked and ignored files; deny-listed and sensitive names; symlinks in and
// out; a submodule-style checkout; repositories under node_modules and a dot folder), a plain
// folder of the member's own (every file, big and hidden ones and credentials excepted), and a
// folder outside everything.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const ORG = 'example-org';
export const TOPIC = 'Example Org: our clients, products and engineering.';
/** The member's folder of clones, as they write it (a plain folder holding repositories). */
export const REPO_ROOT = '~/code/example-org';
/** A plain folder of the member's own, as they write it. */
export const MY_FOLDER = '~/notes/team';
/** The folders the member chose (default for writeFolders). */
export const FOLDERS = [REPO_ROOT, MY_FOLDER];
/** The team the tests sign in to. */
export const TEAM = 'demo';

export type Fixture = {
  root: string;
  home: string;
  xdg: string;
  env: NodeJS.ProcessEnv;
  /** ~/code/example-org: a plain folder holding work trees. */
  repoRoot: string;
  /** ~/code/example-org/alpha: a work tree (tracked, untracked and ignored files). */
  alpha: string;
  outside: string;
  /** Files that must be in the set built from FOLDERS (canonical paths). */
  allowed: string[];
  /** Files that must never be in it (each exists on disk). */
  forbidden: Record<string, string>;
  /** ~/notes/team: a plain folder of the member's own. */
  myFolder: string;
};

function put(path: string, text: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export function git(cwd: string, home: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    encoding: 'utf8',
  });
}

function repo(dir: string, home: string, origin: string | null, tracked: Record<string, string>, extra: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  git(dir, home, 'init', '-q');
  if (origin) git(dir, home, 'remote', 'add', 'origin', origin);
  for (const [rel, text] of Object.entries(tracked)) put(join(dir, rel), text);
  // -f: tracked even where .gitignore would leave them out (the deny list must still keep them out).
  if (Object.keys(tracked).length) git(dir, home, 'add', '-f', '--', ...Object.keys(tracked));
  for (const [rel, text] of Object.entries(extra)) put(join(dir, rel), text);
}

export function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tr-folders-')));
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');
  mkdirSync(home, { recursive: true });
  mkdirSync(xdg, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: xdg, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const repoRoot = join(home, 'code', 'example-org');
  const outside = join(root, 'outside');
  put(join(outside, 'private.md'), 'outside the boundaries\n');
  put(join(outside, 'a.md'), 'outside a\n');
  const forbidden: Record<string, string> = {};
  const allowed: string[] = [];

  // The folder of clones is a plain folder: its own files are read, each work tree in it by git.
  allowed.push(put(join(repoRoot, 'README.md'), 'the folder of clones\n'));
  forbidden.repoRootEnv = put(join(repoRoot, '.env'), 'X=1\n');

  // alpha: a work tree with tracked, untracked and ignored files.
  const alpha = join(repoRoot, 'alpha');
  repo(
    alpha,
    home,
    `https://github.com/${ORG}/alpha.git`,
    {
      'README.md': 'alpha: the staging bucket lives in europe-west3.\n',
      'docs/guide.md': 'Release on Tuesdays.\n',
      'docs/Mixed Case.MD': 'mixed case\n',
      '.gitignore': 'build/\n*.log\n',
      '.env': 'API_TOKEN=abc\n',
      'config/app.pem': 'not really a key\n',
      'secrets.yaml': 'db: staging\n',
      'infra/terraform.tfstate': '{}\n',
      '.AWS/config': '[default]\n',
      'sub/inner.md': 'inner\n',
    },
    { 'notes.txt': 'untracked notes\n', 'build/out.js': 'ignored build output\n', 'debug.log': 'ignored log\n' },
  );
  allowed.push(join(alpha, 'README.md'), join(alpha, 'docs/guide.md'), join(alpha, 'docs/Mixed Case.MD'), join(alpha, '.gitignore'));
  forbidden.untracked = join(alpha, 'notes.txt');
  forbidden.ignored = join(alpha, 'build/out.js');
  forbidden.ignoredLog = join(alpha, 'debug.log');
  forbidden.trackedEnv = join(alpha, '.env');
  forbidden.trackedPem = join(alpha, 'config/app.pem');
  forbidden.trackedSecrets = join(alpha, 'secrets.yaml');
  forbidden.trackedTfstate = join(alpha, 'infra/terraform.tfstate');
  forbidden.trackedAwsUpper = join(alpha, '.AWS/config');
  forbidden.gitInternals = join(alpha, '.git', 'HEAD');
  // A tracked symlink that leads outside, and one that leads to a tracked file.
  symlinkSync(join(outside, 'private.md'), join(alpha, 'link-out.md'));
  symlinkSync(join(alpha, 'README.md'), join(alpha, 'link-in.md'));
  git(alpha, home, 'add', 'link-out.md', 'link-in.md');
  forbidden.symlinkOut = join(alpha, 'link-out.md');
  // A tracked folder later swapped for a symlink to a folder outside with the same file names.
  rmSync(join(alpha, 'sub'), { recursive: true });
  put(join(outside, 'sub', 'inner.md'), 'swapped in from outside\n');
  symlinkSync(join(outside, 'sub'), join(alpha, 'sub'));
  forbidden.swappedDir = join(alpha, 'sub', 'inner.md');
  // An untracked symlink folder leading outside.
  symlinkSync(outside, join(alpha, 'outside-link'));
  forbidden.untrackedLinkDir = join(alpha, 'outside-link', 'a.md');

  // A submodule-style checkout inside alpha (its git directory under alpha/.git/modules): not followed.
  const sub = join(alpha, 'vendor', 'lib');
  repo(sub, home, `https://github.com/${ORG}/lib.git`, { 'lib.md': 'submodule file\n' });
  mkdirSync(join(alpha, '.git', 'modules'), { recursive: true });
  renameSync(join(sub, '.git'), join(alpha, '.git', 'modules', 'lib'));
  writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/lib\n');
  git(sub, home, 'config', 'core.worktree', sub);
  forbidden.submodule = join(sub, 'lib.md');

  // beta (two levels down, an untracked file beside a tracked one) and a deep one with no origin.
  const beta = join(repoRoot, 'clients', 'beta');
  repo(beta, home, `git@github.com:${ORG}/beta.git`, { 'plan.md': 'beta plan\n' }, { 'scratch.md': 'untracked in beta\n' });
  allowed.push(join(beta, 'plan.md'));
  forbidden.betaUntracked = join(beta, 'scratch.md');
  const deep = join(repoRoot, 'clients', 'x', 'y', 'deep');
  repo(deep, home, null, { 'd.md': 'deep\n' });
  allowed.push(join(deep, 'd.md'));
  // A plain file between the work trees is read.
  allowed.push(put(join(repoRoot, 'clients', 'index.md'), 'clients index\n'));
  // Never walked into: node_modules and dot folders, repositories or not.
  const nm = join(repoRoot, 'node_modules', 'pkg');
  repo(nm, home, `https://github.com/${ORG}/pkg.git`, { 'p.md': 'package\n' });
  forbidden.nodeModules = join(nm, 'p.md');
  const dot = join(repoRoot, '.hidden', 'h');
  repo(dot, home, `https://github.com/${ORG}/h.git`, { 'h.md': 'hidden\n' });
  forbidden.dotFolder = join(dot, 'h.md');

  // A plain folder of the member's own: every file, except those over 5 MB, dot entries,
  // credentials and sensitive names, and symlinks out.
  const myFolder = join(home, 'notes', 'team');
  allowed.push(put(join(myFolder, 'ideas.md'), 'my ideas: kick-off on Monday.\n'));
  allowed.push(put(join(myFolder, 'Clients', 'plan.md'), 'Client plan: kick-off on Monday.\n'));
  allowed.push(put(join(myFolder, 'Roadmap.gdoc'), JSON.stringify({ doc_id: 'abcdefghij1234567890' })));
  forbidden.myFolderEnv = put(join(myFolder, '.env'), 'X=1\n');
  forbidden.tooBig = put(join(myFolder, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1, 65));
  forbidden.hidden = put(join(myFolder, '.hidden.md'), 'hidden\n');
  forbidden.sensitive = put(join(myFolder, 'Ops', 'service-account-prod.json'), '{}\n');
  symlinkSync(join(outside, 'private.md'), join(myFolder, 'shortcut.md'));
  forbidden.myFolderSymlinkOut = join(myFolder, 'shortcut.md');
  forbidden.outside = join(outside, 'private.md');
  forbidden.notChosen = put(join(home, 'other', 'x.md'), 'a folder the member did not choose\n');

  return { root, home, xdg, env, repoRoot, alpha, outside, allowed: allowed.map((p) => realpathSync(p)), forbidden, myFolder };
}

/**
 * Write the member's settings file (mode 600 in a mode-700 directory) for one team: the chosen
 * folders, or (`raw`) the team's entry exactly as given (an earlier plugin's lists).
 */
export function writeFolders(f: Fixture, folders: string[], opts: { team?: string; raw?: Record<string, unknown> } = {}): void {
  const dir = join(f.xdg, 'team-relay');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const entry = opts.raw ?? { folders };
  writeFileSync(join(dir, 'boundaries.local.json'), JSON.stringify({ teams: { [opts.team ?? TEAM]: entry } }), { mode: 0o600 });
  chmodSync(join(dir, 'boundaries.local.json'), 0o600);
}

/** The team's boundaries as the relay answers them (schema v3: the topic alone). */
export const BOUNDARIES = { topic: TOPIC };
