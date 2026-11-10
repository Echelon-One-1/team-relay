// M10-SPEC §2, §7.1: the member's own, local part of the boundaries, per team. Where their
// clones live (`repo_roots`, searched 3 levels deep for work trees of the team's GitHub orgs),
// folders of their own (`extra_folders`, used only when the team allows it), and the team
// boundaries they accepted (`accepted`). The answerer reads only from what is both in the team's
// current boundaries and in the accepted set (effectiveBoundaries): narrowing applies at once,
// widening only once the member accepts it in /team-relay:folders. Nothing accepted: nothing is
// answered for that team.
//
//   $XDG_CONFIG_HOME/team-relay/boundaries.local.json   (default ~/.config/team-relay/)
//   {"teams": {"<team>": {"repo_roots": ["~/code/example-org"], "extra_folders": [],
//     "accepted": {"version": 3, "github_orgs": ["example-org"],
//                  "drives": [{"domain": "example.com", "shared_drive": "Example Team Drive"}],
//                  "member_folders": false}}}}
//
// The file is mode 600 in a mode-700 directory, owned by the member, never a symlink; one others
// could read or write is refused, never used (the answerer may read nothing from it then). The
// directory is the relay's config directory, which the answerer can never read (deny list).
// Every entry is checked strictly: an absolute or ~-prefixed path to a folder that passes the
// folder rules (scope.ts folderSafety: not /, $HOME or above it, not directly in $HOME, not
// under ~/Library or any ~/.* entry, not a configuration or credential location), and the
// accepted set by the boundaries rules (M10-SPEC §7.5). The Drive mounts under
// ~/Library/CloudStorage are never configured here: the host resolves them from the team's
// boundaries (boundary-set.ts).

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { configDir } from './answering-lock.js';
import { BOUNDARIES_MAX_DRIVES, BOUNDARIES_MAX_ORGS, BOUNDARIES_VERSION_MAX, domainOk, driveNameOk, orgOk } from './boundaries-rule.js';
import type { Boundaries, BoundariesSince, DriveBoundary } from './boundaries-types.js';
import { TEAM_RE } from './relay-client-core.js';
import { folderSafety } from './scope.js';

export const MEMBER_FOLDERS_FILE = 'boundaries.local.json';
/** At most this many entries in each list. */
export const MAX_FOLDERS = 20;
/** At most this many teams in the file. */
export const MAX_TEAMS = 20;
const MAX_PATH = 1024;
const MAX_FILE_BYTES = 256 * 1024;

export type MemberFolders = { repo_roots: string[]; extra_folders: string[] };
export type FolderList = keyof MemberFolders;
/** M10-SPEC §7.1: the boundaries the member accepted for a team (what the answerer may come to read). */
export type AcceptedBoundaries = { version: number; github_orgs: string[]; drives: DriveBoundary[]; member_folders: boolean };
/** One team's local settings. `accepted` null: the member has not accepted any boundaries yet. */
export type TeamSettings = MemberFolders & { accepted: AcceptedBoundaries | null };
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
 * rules as the scope folder, without the git rule (a repo root is usually no repository).
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

/** One team's two folder lists, checked strictly (wrong types, too many entries, unsafe folders: refused). */
export function parseMemberFolders(raw: unknown, env: NodeJS.ProcessEnv, what = 'the folders file'): MemberFolders {
  if (!isObj(raw)) throw new MemberFoldersError(`${what} is not a JSON object`);
  const out: MemberFolders = { repo_roots: [], extra_folders: [] };
  for (const key of ['repo_roots', 'extra_folders'] as const) {
    const list = raw[key] ?? [];
    if (!Array.isArray(list)) throw new MemberFoldersError(`${key} must be a list of paths`);
    if (list.length > MAX_FOLDERS) throw new MemberFoldersError(`${key} has more than ${MAX_FOLDERS} entries`);
    for (const entry of list) {
      const { reason } = memberFolderProblem(entry, env);
      // A folder that is gone is kept (a disconnected disk); every other problem refuses the file.
      // Each entry is checked again whenever the allowed set is built (boundary-set.ts).
      if (reason && reason !== 'it does not exist') throw new MemberFoldersError(`${key} entry ${JSON.stringify(String(entry).slice(0, 200))} cannot be used: ${reason}`);
      if (!out[key].includes(entry as string)) out[key].push(entry as string);
    }
  }
  return out;
}

/** Drives match exactly on domain and name. */
export function sameDrive(a: DriveBoundary, b: DriveBoundary): boolean {
  return a.domain === b.domain && a.shared_drive === b.shared_drive;
}

/** The accepted part of one team's settings, checked by the boundaries rules. */
export function parseAccepted(raw: unknown): AcceptedBoundaries {
  if (!isObj(raw)) throw new MemberFoldersError('accepted is not a JSON object');
  onlyKeys(raw, ['version', 'github_orgs', 'drives', 'member_folders'], 'accepted');
  const v = raw.version;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > BOUNDARIES_VERSION_MAX) throw new MemberFoldersError('accepted.version must be a whole number from 1');
  if (!Array.isArray(raw.github_orgs) || raw.github_orgs.length > BOUNDARIES_MAX_ORGS) throw new MemberFoldersError('accepted.github_orgs must be a list of at most 10 org names');
  const orgs: string[] = [];
  for (const o of raw.github_orgs) {
    if (!orgOk(o)) throw new MemberFoldersError('accepted.github_orgs has an entry that is not a GitHub org name');
    if (!orgs.some((x) => x.toLowerCase() === o.toLowerCase())) orgs.push(o);
  }
  if (!Array.isArray(raw.drives) || raw.drives.length > BOUNDARIES_MAX_DRIVES) throw new MemberFoldersError('accepted.drives must be a list of at most 10 shared drives');
  const drives: DriveBoundary[] = [];
  for (const d of raw.drives) {
    if (!isObj(d)) throw new MemberFoldersError('accepted.drives has an entry that is not an object');
    onlyKeys(d, ['domain', 'shared_drive'], 'an accepted drive');
    if (!domainOk(d.domain)) throw new MemberFoldersError('accepted.drives has a domain that is not a lower-case DNS name');
    if (!driveNameOk(d.shared_drive)) throw new MemberFoldersError('accepted.drives has a shared drive name that cannot be used');
    const drive = { domain: d.domain, shared_drive: d.shared_drive };
    if (!drives.some((x) => sameDrive(x, drive))) drives.push(drive);
  }
  if (typeof raw.member_folders !== 'boolean') throw new MemberFoldersError('accepted.member_folders must be true or false');
  return { version: v, github_orgs: orgs, drives, member_folders: raw.member_folders };
}

/** One team's settings, checked strictly. */
export function parseTeamSettings(raw: unknown, env: NodeJS.ProcessEnv, team = 'a team'): TeamSettings {
  if (!isObj(raw)) throw new MemberFoldersError(`the settings for ${team} are not a JSON object`);
  onlyKeys(raw, ['repo_roots', 'extra_folders', 'accepted'], `the settings for ${team}`);
  const folders = parseMemberFolders(raw, env, `the settings for ${team}`);
  const accepted = raw.accepted === undefined || raw.accepted === null ? null : parseAccepted(raw.accepted);
  return { ...folders, accepted };
}

function emptyTeams(): Record<string, TeamSettings> {
  return Object.create(null) as Record<string, TeamSettings>;
}

/** The file's content, checked strictly (unknown keys, wrong types, too many entries: refused). */
export function parseMemberSettings(raw: unknown, env: NodeJS.ProcessEnv): MemberSettings {
  if (!isObj(raw)) throw new MemberFoldersError('the folders file is not a JSON object');
  if ('repo_roots' in raw || 'extra_folders' in raw) {
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

/** One team's settings (empty, nothing accepted, when the team is not in the file). */
export function teamSettings(settings: MemberSettings, team: string): TeamSettings {
  const t = Object.prototype.hasOwnProperty.call(settings.teams, team) ? settings.teams[team] : undefined;
  return t ? { repo_roots: [...t.repo_roots], extra_folders: [...t.extra_folders], accepted: t.accepted } : { repo_roots: [], extra_folders: [], accepted: null };
}

/** The settings with one team's entry replaced. */
export function withTeam(settings: MemberSettings, team: string, value: TeamSettings): MemberSettings {
  if (!TEAM_RE.test(team)) throw new MemberFoldersError('not a team id');
  const teams = emptyTeams();
  for (const [k, v] of Object.entries(settings.teams)) teams[k] = v;
  teams[team] = value;
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

function serialise(settings: MemberSettings): Record<string, unknown> {
  const teams: Record<string, unknown> = {};
  for (const name of Object.keys(settings.teams).sort()) {
    const t = settings.teams[name]!;
    teams[name] = { repo_roots: t.repo_roots, extra_folders: t.extra_folders, ...(t.accepted ? { accepted: t.accepted } : {}) };
  }
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

/** The list with `raw` added (checked) or removed. Returns the new value and what changed. */
export function changeMemberFolders<T extends MemberFolders>(
  current: T,
  list: FolderList,
  op: 'add' | 'remove',
  raw: string,
  env: NodeJS.ProcessEnv,
): { value: T; changed: boolean; resolved: string | null } {
  if (op === 'remove') {
    const target = expandPath(raw, env);
    const kept = current[list].filter((e) => e !== raw && (target === null || expandPath(e, env) !== target));
    return { value: { ...current, [list]: kept }, changed: kept.length !== current[list].length, resolved: target };
  }
  const { path, reason } = memberFolderProblem(raw, env);
  if (reason) throw new MemberFoldersError(`${JSON.stringify(raw.slice(0, 200))} cannot be added: ${reason}`);
  const target = expandPath(raw, env);
  if (current[list].some((e) => e === raw || (target !== null && expandPath(e, env) === target))) {
    return { value: current, changed: false, resolved: path };
  }
  if (current[list].length >= MAX_FOLDERS) throw new MemberFoldersError(`at most ${MAX_FOLDERS} entries in ${list}`);
  return { value: { ...current, [list]: [...current[list], raw] }, changed: true, resolved: path };
}

// -- M10-SPEC §7.1: what the member accepted, and what the answerer may read ---------------------

/** What a team's current boundaries add to what the member accepted (all of it when nothing was). */
export type Widening = { github_orgs: string[]; drives: DriveBoundary[]; member_folders: boolean };

export type Effective = {
  /** The boundaries the answerer works within: the team's current ones narrowed to what was accepted. */
  boundaries: Boundaries;
  /** Nothing accepted for this team yet: questions are declined. */
  notAccepted: boolean;
  /** What the current boundaries add beyond the accepted set (null: nothing). */
  pending: Widening | null;
};

/**
 * M10-SPEC §7.1: in which version each item of the team's current boundaries was last added
 * (the relay's `since`). An item the relay does not name counts as added in the current
 * version, so no earlier acceptance covers it.
 */
/** When each item of a boundaries document was last added, and that document's version. */
export type ItemSince = { version: number; org: (org: string) => number; drive: (d: DriveBoundary) => number; memberFolders: () => number };

/** The `since` of a boundaries document from the relay, as lookups (see ItemSince). */
export function sinceOf(tb: { version: number; since?: BoundariesSince | null }): ItemSince {
  const s = tb.since ?? null;
  return {
    version: tb.version,
    // Own keys only: an org may be named like an Object.prototype member ("constructor").
    org: (o) => {
      const key = o.toLowerCase();
      return s && Object.prototype.hasOwnProperty.call(s.github_orgs, key) ? (s.github_orgs[key] ?? tb.version) : tb.version;
    },
    drive: (d) => s?.drives.find((x) => sameDrive(x, d))?.since ?? tb.version,
    memberFolders: () => s?.member_folders ?? tb.version,
  };
}

/**
 * M10-SPEC §7.1: the intersection of the team's current boundaries and the accepted set (orgs
 * compared without case, drives exactly on domain and name, member folders only when both
 * allow them), and what the current boundaries add to it. An accepted item counts only when it
 * has been in the boundaries since the accepted version (`since`): one the team dropped and
 * added back after that is waiting again. The topic is the team's current one.
 */
export function effectiveBoundaries(current: Boundaries, acceptedRaw: AcceptedBoundaries | null, since: ItemSince): Effective {
  const accepted = acceptedRaw ? (narrowAccepted(current, acceptedRaw, since)?.accepted ?? acceptedRaw) : null;
  const orgs = new Set((accepted?.github_orgs ?? []).map((o) => o.toLowerCase()));
  const acceptedDrives = accepted?.drives ?? [];
  const added: Widening = {
    github_orgs: current.github_orgs.filter((o) => !orgs.has(o.toLowerCase())),
    drives: current.drives.filter((d) => !acceptedDrives.some((a) => sameDrive(a, d))),
    member_folders: current.member_folders && accepted?.member_folders !== true,
  };
  const widens = added.github_orgs.length > 0 || added.drives.length > 0 || added.member_folders;
  return {
    boundaries: {
      topic: current.topic,
      github_orgs: current.github_orgs.filter((o) => orgs.has(o.toLowerCase())),
      drives: current.drives.filter((d) => acceptedDrives.some((a) => sameDrive(a, d))),
      member_folders: current.member_folders && accepted?.member_folders === true,
    },
    notAccepted: accepted === null,
    pending: widens ? added : null,
  };
}

/**
 * M10-SPEC §7.1: the accepted set without what the team's current boundaries no longer hold
 * (orgs compared without case, drives exactly, member folders only while the team allows
 * them) and without what they hold only since a version after the accepted one (`since`: the
 * team dropped it and added it back, whether or not this host saw the drop), and what that
 * drops; null when nothing is dropped. Narrowing needs no dialog, and what is dropped needs a
 * new acceptance to come back.
 */
export function narrowAccepted(current: Boundaries, accepted: AcceptedBoundaries | null, since: ItemSince): { accepted: AcceptedBoundaries; dropped: Widening } | null {
  if (!accepted) return null;
  // An acceptance of a version this document has not reached belongs to an earlier team under
  // the same id (deleted and created again, versions start over): it covers nothing.
  const stale = accepted.version > since.version;
  const covered = (n: number) => !stale && n <= accepted.version;
  const orgs = new Set(current.github_orgs.map((o) => o.toLowerCase()));
  const keep = (o: string) => orgs.has(o.toLowerCase()) && covered(since.org(o));
  const listed = (d: DriveBoundary) => current.drives.some((c) => sameDrive(c, d)) && covered(since.drive(d));
  const folders = current.member_folders && covered(since.memberFolders());
  const dropped: Widening = {
    github_orgs: accepted.github_orgs.filter((o) => !keep(o)),
    drives: accepted.drives.filter((d) => !listed(d)),
    member_folders: accepted.member_folders && !folders,
  };
  if (dropped.github_orgs.length === 0 && dropped.drives.length === 0 && !dropped.member_folders) return null;
  return {
    accepted: {
      version: accepted.version,
      github_orgs: accepted.github_orgs.filter(keep),
      drives: accepted.drives.filter(listed),
      member_folders: accepted.member_folders && folders,
    },
    dropped,
  };
}

/**
 * One team's settings from the file, with what the team's current boundaries dropped taken
 * out of the accepted set and written back (atomically) first. Throws MemberFoldersError when
 * the file cannot be read or written.
 */
export function settingsNarrowedTo(
  path: string,
  env: NodeJS.ProcessEnv,
  team: string,
  current: Boundaries,
  since: ItemSince,
): { settings: TeamSettings; dropped: Widening | null } {
  const all = readMemberSettings(path, env);
  const mine = teamSettings(all, team);
  const narrowed = narrowAccepted(current, mine.accepted, since);
  if (!narrowed) return { settings: mine, dropped: null };
  const next: TeamSettings = { ...mine, accepted: narrowed.accepted };
  writeMemberSettings(path, withTeam(all, team, next), env);
  return { settings: next, dropped: narrowed.dropped };
}

/** What accepting a team's boundaries (version `version`) records. */
export function acceptedFrom(current: Boundaries, version: number): AcceptedBoundaries {
  return parseAccepted({
    version,
    github_orgs: current.github_orgs,
    drives: current.drives.map((d) => ({ domain: d.domain, shared_drive: d.shared_drive })),
    member_folders: current.member_folders,
  });
}
