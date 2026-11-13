// The member's own, local part of answering, per team (13 Nov 2026, local folders only): the
// folders on this Mac their answerer may read from for that team. One list, at most 20, chosen
// in /team-relay:setup or with /team-relay:folders. The team's boundaries are its topic alone
// (boundaries-types.ts); what is read is decided here and in boundary-set.ts, never by an owner.
//
//   $XDG_CONFIG_HOME/team-relay/boundaries.local.json   (default ~/.config/team-relay/)
//   {"teams": {"<team>": {"folders": ["~/code/example-org", "/Volumes/Work/notes"]}}}
//
// Earlier plugins wrote two lists per team, `repo_roots` (folders searched only for clones of
// the team's repositories) and `extra_folders` (folders of the member's own, often unused, as
// the team had to allow them), and an `accepted` entry. Reading either as a folder to answer
// from would silently widen what is read, so they never are: the answerer reads `folders` alone
// (empty for a member who has not chosen folders since 13 Nov 2026). The old entries are a
// read-only `previous` list, `repo_roots` then `extra_folders`, each with its kind, a duplicate
// (the same string, or the same path once ~ is expanded) and one already in `folders` left out.
// They are shown where folders are chosen (/team-relay:folders, the setup page, setup-cli) so the
// member can add the ones they still want, and only by the usual ways (the Mac's chooser, or
// /team-relay:folders add <path>, each checked again). They stay in the file until the member
// saves folders: every write stores `folders` alone (the old keys and `accepted` gone).
//
// Accepting: a member has accepted their team's boundaries when the version the relay holds for
// them (GET me/acceptance) is from 1 to the current version (hasAccepted). A greater one belongs
// to an earlier team under the same id (deleted and created again, versions start over).
//
// The file is mode 600 in a mode-700 directory, owned by the member, never a symlink; one others
// could read or write is refused, never used (the answerer may read nothing from it then). The
// directory is the relay's config directory, which the answerer can never read (deny list).
// Every entry is checked strictly: an absolute or ~-prefixed path to a folder that passes the
// folder rules (scope.ts folderSafety: not /, $HOME or above it, not directly in $HOME, not
// under ~/Library or any ~/.* entry, not a configuration or credential location). A folder
// that is gone is kept (a disconnected disk); it is checked again whenever the allowed set is
// built (boundary-set.ts).

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { configDir } from './answering-lock.js';
import { BOUNDARIES_VERSION_MAX } from './boundaries-rule.js';
import { TEAM_RE } from './relay-client-core.js';
import { folderSafety } from './scope.js';

export const MEMBER_FOLDERS_FILE = 'boundaries.local.json';
/** At most this many folders per team. */
export const MAX_FOLDERS = 20;
/** At most this many teams in the file. */
export const MAX_TEAMS = 20;
const MAX_PATH = 1024;
const MAX_FILE_BYTES = 256 * 1024;
/** The lists of earlier plugins, read into `folders` in this order after it. */
export const OLD_FOLDER_LISTS = ['repo_roots', 'extra_folders'] as const;

/**
 * One team's folders: the one list (at most 20), and what reading an earlier plugin's lists left
 * out past 20 (in order; empty once the list was saved again).
 */
/** A folder an earlier plugin's file held: shown to the member, never read from. */
export type PreviousFolder = { path: string; kind: 'repo_root' | 'own_folder' };
export type TeamSettings = { folders: string[]; previous: PreviousFolder[] };
export type MemberSettings = { teams: Record<string, TeamSettings> };

export class MemberFoldersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberFoldersError';
  }
}

export function memberFoldersPath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), MEMBER_FOLDERS_FILE);
}

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

/** `~` or `~/x` against $HOME; an absolute path normalised; anything else null. */
export function expandPath(raw: string, env: NodeJS.ProcessEnv): string | null {
  if (raw === '~') return normalize(home(env));
  if (raw.startsWith('~/')) return normalize(join(home(env), raw.slice(2)));
  if (isAbsolute(raw)) return normalize(raw);
  return null;
}

/**
 * Why `raw` cannot be a member folder (null: it can), and where it resolves. The same folder
 * rules as the scope folder, without the git rule (a folder of clones is usually no repository).
 */
export function memberFolderProblem(raw: unknown, env: NodeJS.ProcessEnv): { path: string | null; reason: string | null } {
  if (typeof raw !== 'string' || raw.length === 0) return { path: null, reason: 'it is not a path' };
  if (raw.length > MAX_PATH) return { path: null, reason: 'it is longer than 1024 characters' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { path: null, reason: 'it contains control characters' };
  const expanded = expandPath(raw, env);
  if (!expanded) return { path: null, reason: 'it is not an absolute path or one starting with ~/' };
  const { path, reason } = folderSafety(expanded, env);
  return { path, reason };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new MemberFoldersError(`${what} has an unknown field (${JSON.stringify(k.slice(0, 40))})`);
  }
}

/** Whether `list` already holds `raw`: the same string, or the same path once expanded. */
function holds(list: readonly string[], raw: string, env: NodeJS.ProcessEnv): boolean {
  const target = expandPath(raw, env);
  return list.some((e) => e === raw || (target !== null && expandPath(e, env) === target));
}

/** One list of a team's entry, checked strictly (wrong type, more than 20, an unsafe folder: refused). */
function parseList(raw: unknown, key: string, env: NodeJS.ProcessEnv): string[] {
  const list = raw ?? [];
  if (!Array.isArray(list)) throw new MemberFoldersError(`${key} must be a list of paths`);
  if (list.length > MAX_FOLDERS) throw new MemberFoldersError(`${key} has more than ${MAX_FOLDERS} entries`);
  for (const entry of list) {
    const { reason } = memberFolderProblem(entry, env);
    // A folder that is gone is kept (a disconnected disk); every other problem refuses the file.
    if (reason && reason !== 'it does not exist') throw new MemberFoldersError(`${key} entry ${JSON.stringify(String(entry).slice(0, 200))} cannot be used: ${reason}`);
  }
  return list as string[];
}

/**
 * An earlier plugin's list: a list of at most 20 strings (else the file is refused). An entry
 * that could not be added now (other than a folder that is gone) is left out of `previous`.
 */
function parseOldList(raw: unknown, key: string, env: NodeJS.ProcessEnv): string[] {
  const list = raw ?? [];
  if (!Array.isArray(list)) throw new MemberFoldersError(`${key} must be a list of paths`);
  if (list.length > MAX_FOLDERS) throw new MemberFoldersError(`${key} has more than ${MAX_FOLDERS} entries`);
  if (list.some((e) => typeof e !== 'string')) throw new MemberFoldersError(`${key} must be a list of paths`);
  return (list as string[]).filter((e) => {
    const { reason } = memberFolderProblem(e, env);
    return reason === null || reason === 'it does not exist';
  });
}

/**
 * One team's settings, checked strictly: `folders` (the only folders ever read), and an earlier
 * plugin's `repo_roots` and `extra_folders` as `previous` (never read; duplicates and ones in
 * `folders` left out); `accepted` ignored.
 */
export function parseTeamSettings(raw: unknown, env: NodeJS.ProcessEnv, team = 'a team'): TeamSettings {
  if (!isObj(raw)) throw new MemberFoldersError(`the settings for ${team} are not a JSON object`);
  onlyKeys(raw, ['folders', ...OLD_FOLDER_LISTS, 'accepted'], `the settings for ${team}`);
  const folders: string[] = [];
  for (const entry of parseList(raw.folders, 'folders', env)) if (!holds(folders, entry, env)) folders.push(entry);
  const previous: PreviousFolder[] = [];
  const seen: string[] = [...folders];
  for (const [key, kind] of [['repo_roots', 'repo_root'], ['extra_folders', 'own_folder']] as const) {
    for (const entry of parseOldList(raw[key], key, env)) {
      if (holds(seen, entry, env)) continue;
      seen.push(entry);
      previous.push({ path: entry, kind });
    }
  }
  return { folders, previous };
}

function emptyTeams(): Record<string, TeamSettings> {
  return Object.create(null) as Record<string, TeamSettings>;
}

/** The file's content, checked strictly (unknown keys, wrong types, too many entries: refused). */
export function parseMemberSettings(raw: unknown, env: NodeJS.ProcessEnv): MemberSettings {
  if (!isObj(raw)) throw new MemberFoldersError('the folders file is not a JSON object');
  if ('repo_roots' in raw || 'extra_folders' in raw || 'folders' in raw) {
    throw new MemberFoldersError('the folders file has an older format (no "teams"); remove it and set your folders again with /team-relay:folders');
  }
  onlyKeys(raw, ['teams'], 'the folders file');
  if (!isObj(raw.teams)) throw new MemberFoldersError('the folders file needs "teams", an object');
  const names = Object.keys(raw.teams);
  if (names.length > MAX_TEAMS) throw new MemberFoldersError(`the folders file has more than ${MAX_TEAMS} teams`);
  const teams = emptyTeams();
  for (const name of names) {
    if (!TEAM_RE.test(name)) throw new MemberFoldersError(`the folders file has a team name that is not a team id (${JSON.stringify(name.slice(0, 40))})`);
    teams[name] = parseTeamSettings(raw.teams[name], env, `team ${name}`);
  }
  return { teams };
}

/** One team's settings (no folders when the team is not in the file). */
export function teamSettings(settings: MemberSettings, team: string): TeamSettings {
  const t = Object.prototype.hasOwnProperty.call(settings.teams, team) ? settings.teams[team] : undefined;
  return t ? { folders: [...t.folders], previous: t.previous.map((x) => ({ ...x })) } : { folders: [], previous: [] };
}

/** The settings with one team's folders replaced (the previous list is gone: it is not written). */
export function withTeam(settings: MemberSettings, team: string, value: { folders: string[] }): MemberSettings {
  if (!TEAM_RE.test(team)) throw new MemberFoldersError('not a team id');
  const teams = emptyTeams();
  for (const [k, v] of Object.entries(settings.teams)) teams[k] = v;
  teams[team] = { folders: [...value.folders], previous: [] };
  return { teams };
}

function uid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function checkPrivate(st: Stats, what: string, kind: 'file' | 'directory'): void {
  if (st.isSymbolicLink()) throw new MemberFoldersError(`${what} is a symbolic link; refusing to use it`);
  if (kind === 'file' ? !st.isFile() : !st.isDirectory()) throw new MemberFoldersError(`${what} is not a ${kind}; refusing to use it`);
  const me = uid();
  if (me !== null && st.uid !== me) throw new MemberFoldersError(`${what} is owned by another user; refusing to use it`);
  if ((st.mode & 0o077) !== 0) {
    const mode = (st.mode & 0o777).toString(8).padStart(3, '0');
    throw new MemberFoldersError(`${what} has mode ${mode}, readable or writable by others; refusing to use it (chmod ${kind === 'file' ? '600' : '700'} it)`);
  }
}

/** The member's settings for every team; none when the file is absent. Throws MemberFoldersError when it must not be used. */
export function readMemberSettings(path: string, env: NodeJS.ProcessEnv): MemberSettings {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { teams: emptyTeams() };
    throw new MemberFoldersError(`cannot read the folders file (${code ?? 'error'})`);
  }
  checkPrivate(lstatSync(dirname(path)), 'the team relay configuration directory', 'directory');
  checkPrivate(st, 'the folders file', 'file');
  if (st.size > MAX_FILE_BYTES) throw new MemberFoldersError('the folders file is too large');
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new MemberFoldersError('the folders file is not valid JSON');
  }
  return parseMemberSettings(json, env);
}

/** One team's settings from the file (see readMemberSettings). */
export function readTeamSettings(path: string, env: NodeJS.ProcessEnv, team: string): TeamSettings {
  return teamSettings(readMemberSettings(path, env), team);
}

/** What is written: each team's `folders` alone (earlier lists and `accepted` are not kept). */
function serialise(settings: MemberSettings): Record<string, unknown> {
  const teams: Record<string, unknown> = {};
  for (const name of Object.keys(settings.teams).sort()) teams[name] = { folders: settings.teams[name]!.folders };
  return { teams };
}

/** Store the member's settings atomically (mode 600, in a mode-700 directory). Checked first. */
export function writeMemberSettings(path: string, value: MemberSettings, env: NodeJS.ProcessEnv): void {
  const checked = parseMemberSettings(serialise(value), env);
  const dir = dirname(path);
  let st: Stats | null = null;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new MemberFoldersError(`cannot use the configuration directory (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (st === null) {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    st = lstatSync(dir);
  }
  checkPrivate(st, 'the team relay configuration directory', 'directory');
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new MemberFoldersError('the folders file is not a regular file; refusing to replace it');
  } catch (err) {
    if (err instanceof MemberFoldersError) throw err;
  }
  const tmp = join(dir, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(serialise(checked), null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw new MemberFoldersError(`cannot write the folders file (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}

/** The folders with `raw` added (checked) or removed. Returns the new list and what changed. */
export function changeMemberFolders(
  current: readonly string[],
  op: 'add' | 'remove',
  raw: string,
  env: NodeJS.ProcessEnv,
): { folders: string[]; changed: boolean; resolved: string | null } {
  if (op === 'remove') {
    const target = expandPath(raw, env);
    const kept = current.filter((e) => e !== raw && (target === null || expandPath(e, env) !== target));
    return { folders: kept, changed: kept.length !== current.length, resolved: target };
  }
  const { path, reason } = memberFolderProblem(raw, env);
  if (reason) throw new MemberFoldersError(`${JSON.stringify(raw.slice(0, 200))} cannot be added: ${reason}`);
  if (holds(current, raw, env)) return { folders: [...current], changed: false, resolved: path };
  if (current.length >= MAX_FOLDERS) throw new MemberFoldersError(`at most ${MAX_FOLDERS} folders`);
  return { folders: [...current, raw], changed: true, resolved: path };
}

const KIND_TEXT: Record<PreviousFolder['kind'], string> = { repo_root: 'repository root', own_folder: 'folder of your own' };

/**
 * The folders an earlier plugin's file held, for where folders are chosen (null: none). Paths
 * are as the member wrote them, quoted when they hold anything but plain characters.
 */
export function previousSentence(previous: readonly PreviousFolder[]): string | null {
  if (previous.length === 0) return null;
  const shown = (p: string) => (/^[\w~./ @+,-]+$/.test(p) ? p : JSON.stringify(p.slice(0, 200)));
  const list = previous.map((x) => `${shown(x.path)} (${KIND_TEXT[x.kind]})`).join(', ');
  return `Folders you chose before 13 Nov 2026 (not used now; add the ones you still want with /team-relay:folders add <path>): ${list}.`;
}

/**
 * Whether a member has accepted their team's boundaries: the version the relay holds for them
 * is a whole number from 1 to the current version. Version 0 is never accepted; a greater one
 * belongs to an earlier team under the same id.
 */
export function hasAccepted(acceptedVersion: unknown, currentVersion: number): boolean {
  return (
    typeof acceptedVersion === 'number' &&
    Number.isSafeInteger(acceptedVersion) &&
    acceptedVersion >= 1 &&
    acceptedVersion <= BOUNDARIES_VERSION_MAX &&
    acceptedVersion <= currentVersion
  );
}
