// A synthetic member machine for M10 boundary mode (synthetic data only): a home directory with
// clones under a repo root (real `git init` repositories with fake origin URLs; tracked,
// untracked and ignored files; deny-listed and sensitive names; symlinks in and out), a fake
// Drive for desktop tree with an account in the team's domain, one in another domain, and My
// Drive, a plain folder of the member's own, and a folder outside everything.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const ORG = 'example-org';
export const DOMAIN = 'example.com';
export const SHARED_DRIVE = 'Team Drive';
export const TOPIC = 'Example Org: our clients, products and engineering.';
/** The member's repo root, as they write it. */
export const REPO_ROOT = '~/code/example-org';
/** The team the tests sign in to. */
export const TEAM = 'demo';

export type Fixture = {
  root: string;
  home: string;
  xdg: string;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  outside: string;
  /** Files that must be in the set (canonical paths). */
  allowed: string[];
  /** Files that must never be in it (each exists on disk). */
  forbidden: Record<string, string>;
  driveRoot: string;
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tr-m10-')));
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

  // The repo root is itself a clone (a workspace repository), ignoring the clones inside it.
  repo(repoRoot, home, `https://github.com/${ORG}/workspace.git`, { 'README.md': 'workspace readme\n', '.gitignore': 'alpha/\nclients/\nother/\nlab/\nnode_modules/\n' });
  allowed.push(join(repoRoot, 'README.md'), join(repoRoot, '.gitignore'));

  // alpha: https origin, the allowed org.
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

  // beta: ssh origin, the org in another case, two levels down.
  const beta = join(repoRoot, 'clients', 'beta');
  repo(beta, home, `git@github.com:${ORG.toUpperCase()}/beta.git`, { 'plan.md': 'beta plan\n' });
  allowed.push(join(beta, 'plan.md'));
  // gamma: ssh:// origin, three levels down.
  const gamma = join(repoRoot, 'clients', 'x', 'gamma');
  repo(gamma, home, `ssh://git@github.com/${ORG}/gamma`, { 'g.md': 'gamma\n' });
  allowed.push(join(gamma, 'g.md'));
  // Too deep (four levels), another org, another host, no origin, inside node_modules, a dot folder.
  const deep = join(repoRoot, 'clients', 'x', 'y', 'deep');
  repo(deep, home, `https://github.com/${ORG}/deep.git`, { 'd.md': 'deep\n' });
  forbidden.tooDeep = join(deep, 'd.md');
  const other = join(repoRoot, 'other');
  repo(other, home, 'https://github.com/OtherOrg/other.git', { 'o.md': 'other org\n' });
  forbidden.otherOrg = join(other, 'o.md');
  const lab = join(repoRoot, 'lab');
  repo(lab, home, `https://gitlab.com/${ORG}/lab.git`, { 'l.md': 'gitlab\n' });
  forbidden.otherHost = join(lab, 'l.md');
  const nm = join(repoRoot, 'node_modules', 'pkg');
  repo(nm, home, `https://github.com/${ORG}/pkg.git`, { 'p.md': 'package\n' });
  forbidden.nodeModules = join(nm, 'p.md');
  const dot = join(repoRoot, '.hidden', 'h');
  repo(dot, home, `https://github.com/${ORG}/h.git`, { 'h.md': 'hidden\n' });
  forbidden.dotFolder = join(dot, 'h.md');

  // Drive for desktop: an account in the team's domain, one in another domain, My Drive.
  const cloud = join(home, 'Library', 'CloudStorage');
  const driveRoot = join(cloud, `GoogleDrive-alice@${DOMAIN}`, 'Shared drives', SHARED_DRIVE);
  put(join(driveRoot, 'Clients', 'plan.md'), 'Drive plan: kick-off on Monday.\n');
  put(join(driveRoot, 'Roadmap.gdoc'), JSON.stringify({ doc_id: 'abcdefghij1234567890' }));
  put(join(driveRoot, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1, 65));
  put(join(driveRoot, '.hidden.md'), 'hidden in drive\n');
  put(join(driveRoot, 'Ops', 'service-account-prod.json'), '{}\n');
  symlinkSync(join(outside, 'private.md'), join(driveRoot, 'shortcut.md'));
  allowed.push(join(driveRoot, 'Clients', 'plan.md'), join(driveRoot, 'Roadmap.gdoc'));
  forbidden.driveTooBig = join(driveRoot, 'big.bin');
  forbidden.driveHidden = join(driveRoot, '.hidden.md');
  forbidden.driveSensitive = join(driveRoot, 'Ops', 'service-account-prod.json');
  forbidden.driveSymlinkOut = join(driveRoot, 'shortcut.md');
  forbidden.myDrive = put(join(cloud, `GoogleDrive-alice@${DOMAIN}`, 'My Drive', 'private.md'), 'my drive\n');
  forbidden.otherSharedDrive = put(join(cloud, `GoogleDrive-alice@${DOMAIN}`, 'Shared drives', 'Other Drive', 'x.md'), 'other shared drive\n');
  forbidden.otherAccount = put(join(cloud, 'GoogleDrive-alice@example.net', 'Shared drives', SHARED_DRIVE, 'x.md'), 'other account\n');
  forbidden.lookalikeDomain = put(join(cloud, `GoogleDrive-alice@${DOMAIN}.evil.example`, 'Shared drives', SHARED_DRIVE, 'x.md'), 'lookalike\n');

  // A plain folder of the member's own (used only when the team allows member folders).
  const myFolder = join(home, 'notes', 'team');
  put(join(myFolder, 'ideas.md'), 'my ideas\n');
  put(join(myFolder, '.env'), 'X=1\n');
  forbidden.myFolderEnv = join(myFolder, '.env');
  forbidden.outside = join(outside, 'private.md');

  return { root, home, xdg, env, repoRoot, outside, allowed: allowed.map((p) => realpathSync(p)), forbidden, driveRoot, myFolder };
}

/** What a member who accepted BOUNDARIES (version 1) has on record (as an M10 plugin wrote it). */
export const ACCEPTED = { version: 1, github_orgs: [ORG], drives: [{ domain: DOMAIN, shared_drive: SHARED_DRIVE }], member_folders: false };

/**
 * Write the member's settings file (mode 600 in a mode-700 directory) for one team: the folders
 * and what was accepted (by default ACCEPTED; null: nothing accepted).
 */
export function writeFolders(
  f: Fixture,
  value: { repo_roots: string[]; extra_folders: string[] },
  opts: { team?: string; accepted?: Record<string, unknown> | null } = {},
): void {
  const dir = join(f.xdg, 'team-relay');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const accepted = opts.accepted === undefined ? ACCEPTED : opts.accepted;
  const team = { ...value, ...(accepted ? { accepted } : {}) };
  writeFileSync(join(dir, 'boundaries.local.json'), JSON.stringify({ teams: { [opts.team ?? TEAM]: team } }), { mode: 0o600 });
  chmodSync(join(dir, 'boundaries.local.json'), 0o600);
}

/** The team's boundaries as the relay answers them (PICKERS-SPEC §2.1: no picked repositories or folders). */
export const BOUNDARIES = {
  topic: TOPIC,
  github_orgs: [ORG],
  github_repos: [] as Array<{ org: string; repo: string; id: number | null }>,
  drive_folders: [] as Array<{ domain: string; drive_id: string | null; folder_id: string; folder_name: string; drive_name: string | null }>,
  drives: [{ domain: DOMAIN, shared_drive: SHARED_DRIVE }],
  member_folders: false,
};

/** The same boundaries as the M10 relay wrote them (PICKERS-SPEC §2.5: no picked lists). */
export const M10_BOUNDARIES = {
  topic: TOPIC,
  github_orgs: [ORG],
  drives: [{ domain: DOMAIN, shared_drive: SHARED_DRIVE }],
  member_folders: false,
};
