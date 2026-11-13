// Where the programs the background answerer runs are on this Mac: claude (Claude Code) and the
// node its LaunchAgent starts. Shared by the setup line (setup-cli.ts), the setup page
// (setup-page.ts) and the background answerer itself (daemon-core.ts), so all find them alike.
//
// claude: the first `claude` on PATH (absolute entries only), else ~/.local/bin/claude, else
// ~/.claude/local/claude, else the copy the Claude desktop app keeps for its own Claude Code,
// ~/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app/Contents/MacOS/claude
// (the newest version with a build the app marked `.verified`). That last path changes with every
// update of the app, so the background answerer looks claude up again whenever the path it was
// installed with no longer runs (resolveClaudeBin).
//
// node: the pinned private copy bin/run-node and the setup line install
// (~/.local/share/team-relay/node-<pin>-darwin-<arch>/bin/node; the pin is read from
// bin/node-pins.sh, never copied here). When it is missing it is got first, through
// `bin/run-node --fetch-only` (the same download, SHA-256 check and lock). Only when that fails,
// the first node on PATH that is new enough and whose PATH name is not under a folder named
// after one version (nvm, fnm, asdf, mise, volta, Homebrew's Cellar): such a name stops working
// when that version is removed. Never this process's own resolved node.

import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir } from './boundary-set.js';

/** Whether `path` is an executable file. */
export function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// -- claude ------------------------------------------------------------------------------------------

/** Where the Claude desktop app keeps its own Claude Code, under the home folder. */
export const DESKTOP_CLAUDE_DIR = ['Library', 'Application Support', 'Claude', 'claude-code'] as const;
/** The executable inside one build of it. */
export const DESKTOP_CLAUDE_EXE = ['claude.app', 'Contents', 'MacOS', 'claude'] as const;
/** The file the app puts beside claude.app once that build is checked. */
export const DESKTOP_VERIFIED = '.verified';

/** `1.2.3` as numbers; null for any other name. */
function versionOf(name: string): number[] | null {
  const m = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

function dirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The Claude desktop app's own claude: in the newest version folder that has one, the build marked
 * `.verified` whose executable is there (the most recently verified one when there are several).
 */
export function desktopClaude(home: string): string | null {
  const root = join(home, ...DESKTOP_CLAUDE_DIR);
  const versions = dirNames(root)
    .map((name) => ({ name, v: versionOf(name) }))
    .filter((x): x is { name: string; v: number[] } => x.v !== null)
    .sort((a, b) => compareVersions(b.v, a.v));
  for (const { name } of versions) {
    const builds: Array<{ exe: string; at: number; build: string }> = [];
    for (const build of dirNames(join(root, name))) {
      const dir = join(root, name, build);
      let at: number;
      try {
        const st = statSync(join(dir, DESKTOP_VERIFIED));
        if (!st.isFile()) continue;
        at = st.mtimeMs;
      } catch {
        continue;
      }
      const exe = join(dir, ...DESKTOP_CLAUDE_EXE);
      if (executableFile(exe)) builds.push({ exe, at, build });
    }
    builds.sort((a, b) => b.at - a.at || (a.build < b.build ? 1 : a.build > b.build ? -1 : 0));
    if (builds[0]) return builds[0].exe;
  }
  return null;
}

/**
 * Where claude is: the first `claude` on PATH (absolute entries only), else ~/.local/bin/claude,
 * else ~/.claude/local/claude, else the Claude desktop app's own (desktopClaude). Null when there
 * is none.
 */
export function findClaude(env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const c = join(dir, 'claude');
    if (executableFile(c)) return c;
  }
  const home = homeDir(env);
  for (const c of [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude')]) {
    if (executableFile(c)) return c;
  }
  return desktopClaude(home);
}

/**
 * The background answerer's claude: TEAM_RELAY_CLAUDE_BIN (the path it was installed with) while
 * that is an executable file; when it was set but no longer runs (the desktop app updated and its
 * old build is gone), claude is looked up again (findClaude). Null when it is not set, or nothing
 * is found.
 */
export function resolveClaudeBin(env: NodeJS.ProcessEnv): string | null {
  const b = env.TEAM_RELAY_CLAUDE_BIN?.trim() ?? '';
  if (!b || !isAbsolute(b)) return null;
  if (executableFile(b)) return b;
  return findClaude(env);
}

// -- node --------------------------------------------------------------------------------------------

/** bin/node-pins.sh beside this bundle (dist/ and src/ both sit beside bin/). */
export const NODE_PINS_FILE = fileURLToPath(new URL('../bin/node-pins.sh', import.meta.url));

/** The pinned Node.js version in node-pins.sh (`vX.Y.Z`), or null when it cannot be read. */
export function pinnedNodeVersion(file: string = NODE_PINS_FILE): string | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const found = [...text.matchAll(/^NODE_VERSION='(v\d{1,9}\.\d{1,9}\.\d{1,9})'$/gm)];
  return found.length === 1 ? found[0]![1]! : null;
}

/** nodejs.org's name for this processor in the pinned build's folder name; null when there is none. */
export function nodeArch(arch: string): 'arm64' | 'x64' | null {
  return arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
}

/** The pinned private copy's node (the path bin/run-node and the setup line install it at). */
export function pinnedNodePath(home: string, version: string, arch: 'arm64' | 'x64'): string {
  return join(home, '.local', 'share', 'team-relay', `node-${version}-darwin-${arch}`, 'bin', 'node');
}

/** The version a node says (`node --version`), or null when it does not run. */
export type NodeVersion = (path: string) => string | null;

const realNodeVersion: NodeVersion = (path) => {
  try {
    return execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

/** Whether a `vX.Y.Z` is 22.12 or newer (package.json "engines"). */
export function newEnoughNode(version: string | null): boolean {
  const m = /^v(\d{1,9})\.(\d{1,9})\.\d{1,9}$/.exec(version ?? '');
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 22 || (major === 22 && minor >= 12);
}

/**
 * Whether a node's PATH name sits in a folder named after one Node.js version (nvm, fnm, asdf,
 * mise, volta's images, Homebrew's Cellar or node@<n>, or any folder named like a version): the
 * name stops working when that version is removed, so the background answerer never uses it.
 */
export function versionedNodePath(path: string): boolean {
  if (/\/(\.nvm|\.fnm|fnm|fnm_multishells|\.asdf\/installs|mise\/installs|\.volta\/tools|Cellar|\.n\/n\/versions)\//.test(path)) return true;
  return path.split('/').some((seg) => /^(node[@-])?v\d+(\.\d+){0,2}$/.test(seg) || /^(node[@-])?\d+\.\d+(\.\d+)?$/.test(seg) || /^node@\d/.test(seg));
}

export type AnswererNodeOptions = {
  env: NodeJS.ProcessEnv;
  /** process.arch (default). */
  arch?: string;
  /** node-pins.sh (default: NODE_PINS_FILE). */
  pinsFile?: string;
  version?: NodeVersion;
};

/** The pinned private copy when it is there and runs (22.12 or newer). */
export function pinnedNode(o: AnswererNodeOptions): string | null {
  const pin = pinnedNodeVersion(o.pinsFile);
  const arch = nodeArch(o.arch ?? process.arch);
  if (!pin || !arch) return null;
  const pinned = pinnedNodePath(homeDir(o.env), pin, arch);
  return executableFile(pinned) && newEnoughNode((o.version ?? realNodeVersion)(pinned)) ? pinned : null;
}

/** The first `node` on PATH (absolute entries only) that runs, is new enough and is not under a version folder. */
export function stablePathNode(o: AnswererNodeOptions): string | null {
  const version = o.version ?? realNodeVersion;
  for (const dir of (o.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const n = join(dir, 'node');
    if (versionedNodePath(n)) continue;
    if (executableFile(n) && newEnoughNode(version(n))) return n;
  }
  return null;
}

/**
 * The node the background answerer's LaunchAgent runs, as it is now: the pinned private copy,
 * else a stable PATH node (stablePathNode); null when there is neither.
 */
export function answererNode(o: AnswererNodeOptions): string | null {
  return pinnedNode(o) ?? stablePathNode(o);
}

/** bin/run-node beside this bundle. */
export const RUN_NODE_FILE = fileURLToPath(new URL('../bin/run-node', import.meta.url));

/** Gets the pinned private copy (bin/run-node --fetch-only); resolves when that ended. */
export type FetchPinnedNode = (env: NodeJS.ProcessEnv) => Promise<void>;

/** How long getting the pinned copy may take (a ~45 MB download on a slow link). */
export const FETCH_NODE_TIMEOUT_MS = 15 * 60 * 1000;

export const runNodeFetch: FetchPinnedNode = (env) =>
  new Promise((resolve) => {
    execFile('/bin/sh', [RUN_NODE_FILE, '--fetch-only'], { env, timeout: FETCH_NODE_TIMEOUT_MS, windowsHide: true }, () => resolve()).stdin?.end();
  });

/**
 * The node for the background answerer, getting it first when needed: the pinned private copy;
 * when it is missing, bin/run-node --fetch-only gets it (the same download, check and lock as at
 * the plugin's start), then it is used; only when that fails a stable PATH node. Null: none.
 */
export async function ensureAnswererNode(o: AnswererNodeOptions & { fetch?: FetchPinnedNode }): Promise<string | null> {
  const have = pinnedNode(o);
  if (have) return have;
  if (nodeArch(o.arch ?? process.arch) && pinnedNodeVersion(o.pinsFile)) {
    await (o.fetch ?? runNodeFetch)(o.env);
    const got = pinnedNode(o);
    if (got) return got;
  }
  return stablePathNode(o);
}

/** Whether ensureAnswererNode can give a node here (without getting anything now). */
export function answererNodeObtainable(o: AnswererNodeOptions & { runNode?: string }): boolean {
  if (answererNode(o)) return true;
  if (nodeArch(o.arch ?? process.arch) === null || pinnedNodeVersion(o.pinsFile) === null) return false;
  try {
    return statSync(o.runNode ?? RUN_NODE_FILE).isFile();
  } catch {
    return false;
  }
}
