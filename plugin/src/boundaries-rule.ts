// M10-SPEC §7.5 and PICKERS-SPEC §2: the one validation rule for a team's boundaries, as this
// plugin applies it: to the console server's PUT body (console-app.ts checkSetBoundaries), to the
// boundaries the relay hands the host (boundary-set.ts validBoundaries) and to what a member
// accepted (member-folders.ts parseAccepted). The relay is the authority (relay/boundaries.py);
// schema/boundaries-vectors.json holds the cases every implementation's tests load.
//
//   org          ^[A-Za-z0-9][A-Za-z0-9-]{0,38}$
//   version      an integer 0..2^31-1 (never a boolean)
//   topic        trimmed (as Python's str.strip()), 1-500 characters; newline and tab the only
//                control characters; no format, surrogate, private-use, unassigned or
//                line/paragraph-separator character anywhere in it as sent
//   domain       already lower case, at least two labels of a-z0-9- (not starting or ending
//                with -, at most 63 each), the last not all digits (not an IP), no trailing
//                dot, at most 253 characters
//   shared_drive 1-100 characters, no /, no control or format (or other refused) character,
//                no leading or trailing space, not . or ..
//   repo         {org, repo, id}: org as above; repo ^[A-Za-z0-9._-]{1,100}$, not all dots; id a
//                whole number 1..2^53-1 or null (pasted, not checked against GitHub)
//   folder       {domain, drive_id, folder_id, folder_name, drive_name}: domain as above;
//                folder_id ^[A-Za-z0-9_-]{10,200}$; drive_id the same or null (pasted);
//                folder_name 1-255 characters, no control or format (or other refused)
//                character, no leading or trailing space (/ allowed: display text only, never a
//                path); drive_name null or the same rule, at most 100 characters
//   lists        at most 10 orgs, 100 repos, 20 folders and 10 legacy drives, counted as sent
//                (before duplicates are dropped)
//   fields       exactly topic, github_orgs, github_repos, drive_folders, drives,
//                member_folders (a bool); every entry exactly its fields
//
// PICKERS-SPEC §2.1: the relay then keeps the first of duplicates (orgs and repositories
// compared without case, folders on folder_id, legacy drives exactly), drops a repository of a
// whole-org entry (normaliseBoundaries), and refuses a legacy drive the stored document does not
// already hold (legacyDrivesOk, 400 legacy_drive). A document the M10 code wrote (no
// github_repos, no drive_folders) is read with both lists empty (readBoundaries); it is never a
// valid PUT body.

import type {
  Boundaries,
  BoundariesSince,
  BoundaryItem,
  DriveBoundary,
  FolderBoundary,
  ItemKey,
  M10Boundaries,
  MemberSources,
  RepoBoundary,
} from './boundaries-types.js';

export const TOPIC_MAX = 500;
export const SHARED_DRIVE_MAX = 100;
export const DOMAIN_MAX = 253;
export const BOUNDARIES_MAX_ORGS = 10;
export const BOUNDARIES_MAX_DRIVES = 10;
/** PICKERS-SPEC §2.1: at most 100 repositories, counted as sent. */
export const BOUNDARIES_MAX_REPOS = 100;
/** PICKERS-SPEC §2.1: at most 20 shared-drive folders, counted as sent. */
export const BOUNDARIES_MAX_FOLDERS = 20;
export const REPO_NAME_MAX = 100;
/** The largest repository id: JavaScript's largest safe integer, 2^53-1. */
export const REPO_ID_MAX = Number.MAX_SAFE_INTEGER;
export const FOLDER_NAME_MAX = 255;
/** A picked folder's shared drive name: at most as long as a legacy shared drive's name. */
export const DRIVE_NAME_MAX = SHARED_DRIVE_MAX;
/** PICKERS-SPEC §2.2: no item key is longer (a legacy drive's is at most 360). */
export const ITEM_KEY_MAX = 400;
/** PICKERS-SPEC §3.3: at most this many missing keys in one status. */
export const SOURCES_MISSING_MAX = 140;
/** A version is a change count: a whole number 0..2^31-1. */
export const BOUNDARIES_VERSION_MAX = 2 ** 31 - 1;
/** A GitHub organisation name: letters, digits and -, not starting with -. */
export const GITHUB_ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** A GitHub repository name: letters, digits, `.`, `_` and `-` (not all dots, checked apart). */
export const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** A Google Drive id (of a folder, or of a shared drive, which is also its top folder's id). */
export const DRIVE_ITEM_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
/** A lower-case DNS name with at least two labels, no trailing dot (length and last label checked apart). */
export const DRIVE_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/**
 * The topic goes into every answerer's prompt: no control characters but newline and tab, and
 * nothing invisible (format characters such as bidi overrides and zero-width marks, lone
 * surrogates, private-use, unassigned, line and paragraph separators) that could hide text.
 */
/* The topic, like picked names, is not checked for unassigned code points (11 Nov 2026). */
const TOPIC_FORBIDDEN_RE = /[\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/u;
/** A shared drive's name is a folder on disk: no `/`, no control or invisible characters. */
const DRIVE_NAME_FORBIDDEN_RE = /[/\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
/** A picked folder's or drive's name is display text: `/` allowed, no control or invisible characters. */
/* Picked names come from Drive and are not checked for unassigned code points (Cn): each side's Unicode tables differ in age (PICKERS-SPEC, correction of 11 Nov 2026). */
const FOLDER_NAME_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
/** PICKERS-SPEC §3.3: a missing key holds no control or format character. */
const KEY_FORBIDDEN_RE = /[\p{Cc}\p{Cf}]/u;
/** The white space the relay trims from a topic (Python's str.strip()), and no name may start or end with. */
const EDGE_SPACE_RE =
  /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** The fields of a boundaries document, in the order the relay answers with them. */
export const BOUNDARIES_FIELDS = ['topic', 'github_orgs', 'github_repos', 'drive_folders', 'drives', 'member_folders'] as const;
/** The fields of a document the M10 code wrote. */
export const M10_BOUNDARIES_FIELDS = ['topic', 'github_orgs', 'drives', 'member_folders'] as const;

/** Length in code points, as the relay (Python) counts. */
export const chars = (s: string) => [...s].length;
/** Surrounding white space dropped, as the relay drops it from a topic. */
export const trimText = (s: string) => s.replace(EDGE_SPACE_RE, '');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
/** An own entry of a map read from JSON (a key may be named like an Object.prototype member). */
const own = (o: Record<string, number> | undefined, key: string): number | undefined => (o && Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined);

/** A topic as sent: 1-500 characters once trimmed; refused characters are looked for before trimming. */
export function topicOk(topic: unknown): topic is string {
  if (typeof topic !== 'string') return false;
  const t = trimText(topic);
  return chars(t) >= 1 && chars(t) <= TOPIC_MAX && !TOPIC_FORBIDDEN_RE.test(topic);
}

export const orgOk = (org: unknown): org is string => typeof org === 'string' && GITHUB_ORG_RE.test(org);

/** A drive's domain as sent: already lower case, at least two labels, not an IP, no trailing dot. */
export function domainOk(domain: unknown): domain is string {
  if (typeof domain !== 'string' || domain.length > DOMAIN_MAX || !DRIVE_DOMAIN_RE.test(domain)) return false;
  return !/^[0-9]+$/.test(domain.slice(domain.lastIndexOf('.') + 1));
}

/** A legacy shared drive's name as sent: 1-100 characters, no /, no control or invisible characters, no surrounding space, not . or .. */
export function driveNameOk(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    chars(name) >= 1 &&
    chars(name) <= SHARED_DRIVE_MAX &&
    !DRIVE_NAME_FORBIDDEN_RE.test(name) &&
    name === trimText(name) &&
    name !== '.' &&
    name !== '..'
  );
}

/** A version: a whole number 0..2^31-1, never a boolean or a string. */
export const versionOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= BOUNDARIES_VERSION_MAX;

/** A repository's name as sent: ^[A-Za-z0-9._-]{1,100}$ and not all dots. */
export const repoNameOk = (name: unknown): name is string => typeof name === 'string' && GITHUB_REPO_RE.test(name) && !/^\.+$/.test(name);

/** A repository's id: a whole number 1..2^53-1 (never a boolean or a string), or null (pasted). */
export const repoIdOk = (id: unknown): id is number | null => id === null || (typeof id === 'number' && Number.isSafeInteger(id) && id >= 1);

/** A Drive id (folder or shared drive): ^[A-Za-z0-9_-]{10,200}$. */
export const driveItemIdOk = (id: unknown): id is string => typeof id === 'string' && DRIVE_ITEM_ID_RE.test(id);

/** A picked folder's name: 1-255 characters, no control or invisible characters, no surrounding space (`/` allowed). */
export function folderNameOk(name: unknown, max: number = FOLDER_NAME_MAX): name is string {
  return typeof name === 'string' && chars(name) >= 1 && chars(name) <= max && !FOLDER_NAME_FORBIDDEN_RE.test(name) && name === trimText(name);
}

/** A picked folder's shared drive name: null, or the folder-name rule at most 100 characters. */
export const pickedDriveNameOk = (name: unknown): name is string | null => name === null || folderNameOk(name, DRIVE_NAME_MAX);

/** One `github_repos` entry exactly as sent. */
export function repoOk(r: unknown): r is RepoBoundary {
  return isObj(r) && exactKeys(r, ['org', 'repo', 'id']) && orgOk(r.org) && repoNameOk(r.repo) && repoIdOk(r.id);
}

/** One `drive_folders` entry exactly as sent. */
export function folderOk(f: unknown): f is FolderBoundary {
  return (
    isObj(f) &&
    exactKeys(f, ['domain', 'drive_id', 'folder_id', 'folder_name', 'drive_name']) &&
    domainOk(f.domain) &&
    (f.drive_id === null || driveItemIdOk(f.drive_id)) &&
    driveItemIdOk(f.folder_id) &&
    folderNameOk(f.folder_name) &&
    pickedDriveNameOk(f.drive_name)
  );
}

/** One legacy `drives` entry exactly as sent. */
export const legacyDriveOk = (d: unknown): d is DriveBoundary => isObj(d) && exactKeys(d, ['domain', 'shared_drive']) && domainOk(d.domain) && driveNameOk(d.shared_drive);

const listOk = (v: unknown, max: number, ok: (x: unknown) => boolean) => Array.isArray(v) && v.length <= max && v.every(ok);

/** The fields both document shapes share, checked (the topic as sent). */
function commonValid(raw: Record<string, unknown>): boolean {
  return (
    topicOk(raw.topic) &&
    listOk(raw.github_orgs, BOUNDARIES_MAX_ORGS, orgOk) &&
    listOk(raw.drives, BOUNDARIES_MAX_DRIVES, legacyDriveOk) &&
    typeof raw.member_folders === 'boolean'
  );
}

/**
 * Whether a boundaries document, exactly as given, passes the rule: a PUT body's `boundaries`
 * (every field required, PICKERS-SPEC §3.2). It says nothing about legacy drives against the
 * stored document (legacyDrivesOk) or the relay's allowlists.
 */
export function boundariesValid(raw: unknown): raw is Boundaries {
  if (!isObj(raw) || !exactKeys(raw, BOUNDARIES_FIELDS)) return false;
  return commonValid(raw) && listOk(raw.github_repos, BOUNDARIES_MAX_REPOS, repoOk) && listOk(raw.drive_folders, BOUNDARIES_MAX_FOLDERS, folderOk);
}

/**
 * PICKERS-SPEC §2.3 and §2.5: a boundaries document to act on, from the relay or from a member's
 * own copy: one that passes the rule, or one the M10 code wrote (exactly its four fields, each
 * passing the rule), read with `github_repos` and `drive_folders` empty. Null for anything else.
 * The document is returned as given otherwise (not normalised).
 */
export function readBoundaries(raw: unknown): Boundaries | null {
  if (boundariesValid(raw)) return raw;
  if (!isObj(raw) || !exactKeys(raw, M10_BOUNDARIES_FIELDS) || !commonValid(raw)) return null;
  const m10 = raw as unknown as M10Boundaries;
  return { topic: m10.topic, github_orgs: m10.github_orgs, github_repos: [], drive_folders: [], drives: m10.drives, member_folders: m10.member_folders };
}

const lowerRepo = (r: { org: string; repo: string }) => `${r.org.toLowerCase()}/${r.repo.toLowerCase()}`;
const sameDrive = (a: DriveBoundary, b: DriveBoundary) => a.domain === b.domain && a.shared_drive === b.shared_drive;

/**
 * PICKERS-SPEC §2.1: what the relay stores of a valid document: the topic trimmed; the first of
 * duplicate orgs and repositories (compared without case), folders (on `folder_id`, case kept)
 * and legacy drives (exactly); a repository whose org is a whole-org entry dropped. Entries are
 * kept as spelt and in the order sent.
 */
export function normaliseBoundaries(b: Boundaries): Boundaries {
  const orgSeen = new Set<string>();
  const github_orgs = b.github_orgs.filter((o) => !orgSeen.has(o.toLowerCase()) && orgSeen.add(o.toLowerCase()));
  const repoSeen = new Set<string>();
  const github_repos = b.github_repos.filter((r) => !orgSeen.has(r.org.toLowerCase()) && !repoSeen.has(lowerRepo(r)) && repoSeen.add(lowerRepo(r)));
  const folderSeen = new Set<string>();
  const drive_folders = b.drive_folders.filter((f) => !folderSeen.has(f.folder_id) && folderSeen.add(f.folder_id));
  const drives = b.drives.filter((d, i) => b.drives.findIndex((x) => sameDrive(x, d)) === i);
  return {
    topic: trimText(b.topic),
    github_orgs,
    github_repos: github_repos.map((r) => ({ org: r.org, repo: r.repo, id: r.id })),
    drive_folders: drive_folders.map((f) => ({ domain: f.domain, drive_id: f.drive_id, folder_id: f.folder_id, folder_name: f.folder_name, drive_name: f.drive_name })),
    drives: drives.map((d) => ({ domain: d.domain, shared_drive: d.shared_drive })),
    member_folders: b.member_folders,
  };
}

/**
 * PICKERS-SPEC §2.1: legacy name-matched drives can be kept, never added. True when every drive
 * of `sent` is one the stored document (`stored`; null: nothing stored) holds, exactly on domain
 * and name; false is the relay's `400 legacy_drive`.
 */
export function legacyDrivesOk(stored: readonly DriveBoundary[] | null, sent: readonly DriveBoundary[]): boolean {
  return sent.every((d) => (stored ?? []).some((s) => sameDrive(s, d)));
}

/** PICKERS-SPEC §2.2: a whole org's key, `org:<lower org>`. */
export const orgKey = (org: string): ItemKey => `org:${org.toLowerCase()}`;
/** PICKERS-SPEC §2.2: a repository's key, `repo:<lower org>/<lower repo>`. */
export const repoKey = (r: { org: string; repo: string }): ItemKey => `repo:${lowerRepo(r)}`;
/** PICKERS-SPEC §2.2: a Drive folder's key, `folder:<folder_id>` (case kept). */
export const folderKey = (f: { folder_id: string }): ItemKey => `folder:${f.folder_id}`;
/** PICKERS-SPEC §2.2: a legacy drive's key, `drive:<domain>/<shared_drive>`. */
export const driveKey = (d: DriveBoundary): ItemKey => `drive:${d.domain}/${d.shared_drive}`;

/** PICKERS-SPEC §2.2: the one key of a boundaries item. */
export function itemKey(item: BoundaryItem): ItemKey {
  switch (item.kind) {
    case 'org':
      return orgKey(item.org);
    case 'repo':
      return repoKey(item);
    case 'folder':
      return folderKey(item);
    case 'drive':
      return driveKey(item);
  }
}

/**
 * The items of a document as the relay stores it (normaliseBoundaries): whole orgs, then
 * repositories, Drive folders and legacy drives, each in document order.
 */
export function boundaryItems(b: Boundaries): BoundaryItem[] {
  const n = normaliseBoundaries(b);
  return [
    ...n.github_orgs.map((org): BoundaryItem => ({ kind: 'org', org })),
    ...n.github_repos.map((r): BoundaryItem => ({ kind: 'repo', ...r })),
    ...n.drive_folders.map((f): BoundaryItem => ({ kind: 'folder', ...f })),
    ...n.drives.map((d): BoundaryItem => ({ kind: 'drive', ...d })),
  ];
}

/** PICKERS-SPEC §2.2: the key of every item of `b`, in boundaryItems order (no key twice). */
export function itemKeys(b: Boundaries): ItemKey[] {
  return boundaryItems(b).map(itemKey);
}

/**
 * PICKERS-SPEC §3.3: the status group `sources` exactly as sent: `boundaries_version` a version,
 * `missing` at most 140 strings of 1-400 characters with no control or format character.
 */
export function sourcesOk(raw: unknown): raw is MemberSources {
  if (!isObj(raw) || !exactKeys(raw, ['boundaries_version', 'missing']) || !versionOk(raw.boundaries_version)) return false;
  const missing = raw.missing;
  return listOk(missing, SOURCES_MISSING_MAX, (k) => typeof k === 'string' && chars(k) >= 1 && chars(k) <= ITEM_KEY_MAX && !KEY_FORBIDDEN_RE.test(k));
}

/**
 * PICKERS-SPEC §3.3-§3.4: of reported keys, those that are keys of items of `b`, in the order
 * given, each once. The relay keeps only these (on write and again on read), so nothing but the
 * team's own item names is stored or shown.
 */
export function knownItemKeys(b: Boundaries, keys: readonly string[]): ItemKey[] {
  const known = new Set<string>(itemKeys(b));
  const out: ItemKey[] = [];
  for (const k of keys) {
    if (known.has(k)) {
      known.delete(k);
      out.push(k as ItemKey);
    }
  }
  return out;
}

/** A `since` as a reader may get it: one from before the picked lists may lack their maps. */
type SinceIn = Omit<BoundariesSince, 'github_repos' | 'drive_folders'> & Partial<Pick<BoundariesSince, 'github_repos' | 'drive_folders'>>;

/**
 * M10-SPEC §7.1 and PICKERS-SPEC §2.3: in which version each item of `b` (as stored:
 * normaliseBoundaries) was last added, by item key, for a document of version `version`; an
 * item its `since` does not name (or a null `since`) counts as added in `version`. Member
 * folders are not an item: see `since.member_folders`.
 */
export function sinceByKey(b: Boundaries, since: SinceIn | null | undefined, version: number): Map<ItemKey, number> {
  const out = new Map<ItemKey, number>();
  for (const item of boundaryItems(b)) {
    let n: number | undefined;
    if (since) {
      if (item.kind === 'org') n = own(since.github_orgs, item.org.toLowerCase());
      else if (item.kind === 'repo') n = own(since.github_repos, lowerRepo(item));
      else if (item.kind === 'folder') n = own(since.drive_folders, item.folder_id);
      else n = since.drives.find((x) => sameDrive(x, item))?.since;
    }
    out.set(itemKey(item), n ?? version);
  }
  return out;
}

/** The document a new `since` is computed from: the one it replaces, as stored or as an M10 reader got it. */
export type SinceSource = {
  /** The replaced document's version; an item its `since` does not name counts as added in it. */
  version?: number;
  boundaries: Boundaries | M10Boundaries | null;
  since?: SinceIn | null;
};

/**
 * M10-SPEC §7.1 and PICKERS-SPEC §2.3: the relay's `since` for boundaries `next` stored as
 * `version` (computed on `next` as stored: normaliseBoundaries), given the document it replaces
 * (`prev`; null: none). Each item gets, in order:
 *   1. its `since` in `prev` when `prev` holds the same item (same key);
 *   2. else, for a repository whose org is a whole-org entry of `prev`: that org's `since`;
 *   3. else, for a Drive folder with a `drive_id` when `prev` holds that whole drive (an entry
 *      whose `folder_id` and `drive_id` are this `drive_id`): that entry's `since`;
 *   4. else `version` (new, or added back after a removal).
 * Rules 2 and 3 never apply to legacy drives. `prev` and `next` may be documents of the M10
 * shape (no picked lists: read as empty). Member folders keep their `since` while allowed
 * (null while not). An item `prev` holds but its `since` does not name counts as added in
 * `prev.version` (or `version` when that is not given). The relay computes this
 * (relay/boundaries.py carried_since); the console's demo relay plays it with this.
 */
export function nextSince(prev: SinceSource | null, version: number, next: Boundaries | M10Boundaries): BoundariesSince {
  const pb: Boundaries | null = prev?.boundaries ? { github_repos: [], drive_folders: [], ...prev.boundaries } : null;
  const ps = pb ? (prev?.since ?? null) : null;
  const held = pb ? sinceByKey(pb, ps, prev?.version ?? version) : new Map<ItemKey, number>();
  const n = normaliseBoundaries({ github_repos: [], drive_folders: [], ...next });
  const github_orgs: Record<string, number> = {};
  const github_repos: Record<string, number> = {};
  const drive_folders: Record<string, number> = {};
  for (const o of n.github_orgs) github_orgs[o.toLowerCase()] = held.get(orgKey(o)) ?? version;
  for (const r of n.github_repos) github_repos[lowerRepo(r)] = held.get(repoKey(r)) ?? held.get(orgKey(r.org)) ?? version;
  for (const f of n.drive_folders) {
    const whole = f.drive_id !== null && pb?.drive_folders.some((x) => x.folder_id === f.drive_id && x.drive_id === f.drive_id) ? held.get(folderKey({ folder_id: f.drive_id })) : undefined;
    drive_folders[f.folder_id] = held.get(folderKey(f)) ?? whole ?? version;
  }
  return {
    github_orgs,
    github_repos,
    drive_folders,
    drives: n.drives.map((d) => ({ domain: d.domain, shared_drive: d.shared_drive, since: held.get(driveKey(d)) ?? version })),
    member_folders: !n.member_folders ? null : pb?.member_folders ? (ps?.member_folders ?? prev?.version ?? version) : version,
  };
}
