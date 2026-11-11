import type { ChangeError } from '@/api/client'
import type { Boundaries, BoundariesSince, DriveBoundary, FolderBoundary, RepoBoundary, TeamBoundaries } from '@/api/types'

// M10 §1 and PICKERS-SPEC §2.1: the Boundaries form's values, checked here by the one rule the
// relay, the console server (plugin/src/console-app.ts checkSetBoundaries, plugin/src/
// boundaries-rule.ts) and this page share (schema/boundaries-vectors.json), before anything is
// sent; and the refusals in words.

export const TOPIC_MAX = 500
export const ORGS_MAX = 10
export const REPOS_MAX = 100
export const FOLDERS_MAX = 20
export const DRIVES_MAX = 10
export const DRIVE_NAME_MAX = 100
export const FOLDER_NAME_MAX = 255
export const REPO_NAME_MAX = 100
export const DOMAIN_MAX = 253
export const VERSION_MAX = 2 ** 31 - 1
/** A GitHub org: letters, digits and -, not starting with -, at most 39 characters. */
export const GITHUB_ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
/** A GitHub repository's name: letters, digits, `.`, `_` and `-` (not all dots, checked apart). */
export const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
/** A Google Drive id (of a folder, or of a shared drive, which is also its top folder's id). */
export const DRIVE_ITEM_ID_RE = /^[A-Za-z0-9_-]{10,200}$/
/** A lower-case DNS name of at least two labels, no trailing dot (the length and the last label are checked apart). */
export const DRIVE_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
/**
 * Characters no topic or name may hold: controls (the topic allows newline and tab), format
 * characters (bidi overrides, zero-width marks), surrogates, private use, unassigned, line and
 * paragraph separators. A legacy drive's name is a folder on disk, so no / either.
 */
/* The topic, like picked names, is not checked for unassigned code points (11 Nov 2026). */
const TOPIC_FORBIDDEN_RE = /[\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/u
const DRIVE_NAME_FORBIDDEN_RE = /[/\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u
/* Picked names come from Drive and are not checked for unassigned code points (Cn): each side's Unicode tables differ in age (PICKERS-SPEC, correction of 11 Nov 2026). */
const FOLDER_NAME_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u
/** The white space the relay trims from a topic (Python's str.strip()), and no name may start or end with. */
const EDGE_SPACE_RE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g

const FIELDS = ['topic', 'github_orgs', 'github_repos', 'drive_folders', 'drives', 'member_folders']
const M10_FIELDS = ['topic', 'github_orgs', 'drives', 'member_folders']

export const chars = (s: string) => [...s].length

/** Surrounding white space dropped, as the relay drops it from a topic. */
export const trimText = (s: string) => s.replace(EDGE_SPACE_RE, '')

/** A topic as sent: 1-500 characters once trimmed, newline and tab the only control characters. */
export function topicOk(topic: unknown): topic is string {
  if (typeof topic !== 'string') return false
  const t = trimText(topic)
  // As the relay: refused characters are looked for in the topic as sent, before trimming.
  return chars(t) >= 1 && chars(t) <= TOPIC_MAX && !TOPIC_FORBIDDEN_RE.test(topic)
}

export const orgOk = (org: unknown): org is string => typeof org === 'string' && GITHUB_ORG_RE.test(org)

/** A drive's domain as sent: already lower case, at least two labels, not an IP, no trailing dot. */
export function domainOk(domain: unknown): domain is string {
  if (typeof domain !== 'string' || domain.length > DOMAIN_MAX || !DRIVE_DOMAIN_RE.test(domain)) return false
  return !/^[0-9]+$/.test(domain.slice(domain.lastIndexOf('.') + 1))
}

/** A legacy shared drive's name as sent: 1-100 characters, no /, no control or invisible characters, no surrounding space, not . or .. */
export function driveNameOk(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    chars(name) >= 1 &&
    chars(name) <= DRIVE_NAME_MAX &&
    !DRIVE_NAME_FORBIDDEN_RE.test(name) &&
    name === trimText(name) &&
    name !== '.' &&
    name !== '..'
  )
}

/** A repository's name: ^[A-Za-z0-9._-]{1,100}$ and not all dots. */
export const repoNameOk = (name: unknown): name is string => typeof name === 'string' && GITHUB_REPO_RE.test(name) && !/^\.+$/.test(name)

/** A repository's id: a whole number 1..2^53-1, or null (pasted). */
export const repoIdOk = (id: unknown): id is number | null => id === null || (typeof id === 'number' && Number.isSafeInteger(id) && id >= 1)

/** A Drive id (folder or shared drive). */
export const driveItemIdOk = (id: unknown): id is string => typeof id === 'string' && DRIVE_ITEM_ID_RE.test(id)

/** A picked folder's name: 1-255 characters, no control or invisible characters, no surrounding space (/ allowed: display text only). */
export function folderNameOk(name: unknown, max: number = FOLDER_NAME_MAX): name is string {
  return typeof name === 'string' && chars(name) >= 1 && chars(name) <= max && !FOLDER_NAME_FORBIDDEN_RE.test(name) && name === trimText(name)
}

/** A picked folder's shared drive name: null, or the folder-name rule at most 100 characters. */
export const pickedDriveNameOk = (name: unknown): name is string | null => name === null || folderNameOk(name, DRIVE_NAME_MAX)

/** The version a change is made from: a whole number 0..2^31-1, never a boolean or a string. */
export const versionOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= VERSION_MAX

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k))
const listOk = (v: unknown, max: number, ok: (x: unknown) => boolean) => Array.isArray(v) && v.length <= max && v.every(ok)

/** One github_repos entry exactly as sent. */
export const repoOk = (r: unknown): r is RepoBoundary => isObject(r) && onlyKeys(r, ['org', 'repo', 'id']) && orgOk(r.org) && repoNameOk(r.repo) && repoIdOk(r.id)

/** One drive_folders entry exactly as sent. */
export function folderOk(f: unknown): f is FolderBoundary {
  return (
    isObject(f) &&
    onlyKeys(f, ['domain', 'drive_id', 'folder_id', 'folder_name', 'drive_name']) &&
    domainOk(f.domain) &&
    (f.drive_id === null || driveItemIdOk(f.drive_id)) &&
    driveItemIdOk(f.folder_id) &&
    folderNameOk(f.folder_name) &&
    pickedDriveNameOk(f.drive_name)
  )
}

/** One legacy drives entry exactly as sent. */
export const legacyDriveOk = (d: unknown): d is DriveBoundary => isObject(d) && onlyKeys(d, ['domain', 'shared_drive']) && domainOk(d.domain) && driveNameOk(d.shared_drive)

function commonValid(raw: Record<string, unknown>): boolean {
  return topicOk(raw.topic) && listOk(raw.github_orgs, ORGS_MAX, orgOk) && listOk(raw.drives, DRIVES_MAX, legacyDriveOk) && typeof raw.member_folders === 'boolean'
}

/**
 * Whether a boundaries document, exactly as it would be sent, passes the rule: every field
 * present and no other, the list caps counted as sent (before duplicates are dropped).
 */
export function boundariesValid(raw: unknown): raw is Boundaries {
  if (!isObject(raw) || !onlyKeys(raw, FIELDS)) return false
  return commonValid(raw) && listOk(raw.github_repos, REPOS_MAX, repoOk) && listOk(raw.drive_folders, FOLDERS_MAX, folderOk)
}

/**
 * PICKERS-SPEC §2.5: a document to show, as a relay answers it: one that passes the rule, or one
 * the M10 code wrote (its four fields only), read with no repositories and no folders. Null for
 * anything else.
 */
export function readBoundaries(raw: unknown): Boundaries | null {
  if (boundariesValid(raw)) return raw
  if (!isObject(raw) || !onlyKeys(raw, M10_FIELDS) || !commonValid(raw)) return null
  return {
    topic: raw.topic as string,
    github_orgs: raw.github_orgs as string[],
    github_repos: [],
    drive_folders: [],
    drives: raw.drives as DriveBoundary[],
    member_folders: raw.member_folders as boolean,
  }
}

const sinceMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {}
  if (!isObject(v)) return out
  for (const [k, n] of Object.entries(v)) if (versionOk(n)) out[k] = n
  return out
}

/**
 * GET /api/boundaries as read: the document through readBoundaries, `since` with every map
 * (absent ones empty, so their items count as added in the current version). Null when it is not
 * that answer at all, or holds a document that breaks the rule.
 */
export function readTeamBoundaries(raw: unknown): TeamBoundaries | null {
  if (!isObject(raw) || typeof raw.team !== 'string' || !versionOk(raw.version)) return null
  const updated_at = typeof raw.updated_at === 'string' ? raw.updated_at : null
  const updated_by = typeof raw.updated_by === 'string' ? raw.updated_by : null
  if (raw.boundaries === null || raw.boundaries === undefined) return { team: raw.team, version: raw.version, boundaries: null, since: null, updated_at, updated_by }
  const boundaries = readBoundaries(raw.boundaries)
  if (boundaries === null) return null
  let since: BoundariesSince | null = null
  if (isObject(raw.since)) {
    const s = raw.since
    since = {
      github_orgs: sinceMap(s.github_orgs),
      github_repos: sinceMap(s.github_repos),
      drive_folders: sinceMap(s.drive_folders),
      drives: Array.isArray(s.drives)
        ? s.drives.filter((d): d is DriveBoundary & { since: number } => isObject(d) && typeof d.domain === 'string' && typeof d.shared_drive === 'string' && versionOk(d.since))
        : [],
      member_folders: versionOk(s.member_folders) ? s.member_folders : null,
    }
  }
  return { team: raw.team, version: raw.version, boundaries, since, updated_at, updated_by }
}

/** What the form holds while an owner edits. Every list holds items that already pass the rule. */
export interface BoundariesDraft {
  topic: string
  github_orgs: string[]
  github_repos: RepoBoundary[]
  drive_folders: FolderBoundary[]
  /** Legacy, name-matched drives: an owner keeps or removes them, never adds one. */
  drives: DriveBoundary[]
  member_folders: boolean
}

export function draftFrom(b: Boundaries | null): BoundariesDraft {
  if (!b) return { topic: '', github_orgs: [], github_repos: [], drive_folders: [], drives: [], member_folders: false }
  return {
    topic: b.topic,
    github_orgs: [...b.github_orgs],
    github_repos: b.github_repos.map((r) => ({ ...r })),
    drive_folders: b.drive_folders.map((f) => ({ ...f })),
    drives: b.drives.map((d) => ({ ...d })),
    member_folders: b.member_folders,
  }
}

const sameList = <T>(a: T[], b: T[], eq: (x: T, y: T) => boolean) => a.length === b.length && a.every((x, i) => eq(x, b[i]!))

export function sameDraft(a: BoundariesDraft, b: BoundariesDraft): boolean {
  return (
    a.topic === b.topic &&
    a.member_folders === b.member_folders &&
    sameList(a.github_orgs, b.github_orgs, (x, y) => x === y) &&
    sameList(a.github_repos, b.github_repos, (x, y) => x.org === y.org && x.repo === y.repo && x.id === y.id) &&
    sameList(
      a.drive_folders,
      b.drive_folders,
      (x, y) => x.domain === y.domain && x.drive_id === y.drive_id && x.folder_id === y.folder_id && x.folder_name === y.folder_name && x.drive_name === y.drive_name,
    ) &&
    sameList(a.drives, b.drives, (x, y) => x.domain === y.domain && x.shared_drive === y.shared_drive)
  )
}

export type BoundariesField = 'topic' | 'github' | 'drive'

/**
 * The first problem with the draft, on the section it is about; null when it can be saved. What
 * is sent is checked by the one rule once more (boundariesValid).
 */
export function boundariesProblem(d: BoundariesDraft): { field: BoundariesField; message: string } | null {
  const topic = trimText(d.topic)
  if (topic === '') return { field: 'topic', message: 'Say what the team talks about: questions about anything else are declined.' }
  if (chars(topic) > TOPIC_MAX) return { field: 'topic', message: `The topic is ${chars(topic)} characters; at most ${TOPIC_MAX}.` }
  if (!topicOk(d.topic)) return { field: 'topic', message: 'The topic has a control or invisible character. Retype it.' }
  const b = toBoundaries(d)
  if (b.github_orgs.length > ORGS_MAX) return { field: 'github', message: `At most ${ORGS_MAX} whole GitHub organisations.` }
  if (b.github_repos.length > REPOS_MAX) return { field: 'github', message: `At most ${REPOS_MAX} repositories.` }
  if (!b.github_orgs.every(orgOk) || !b.github_repos.every(repoOk)) return { field: 'github', message: 'One of the GitHub entries is not a GitHub address. Remove it and add it again.' }
  if (b.drive_folders.length > FOLDERS_MAX) return { field: 'drive', message: `At most ${FOLDERS_MAX} Google Drive folders.` }
  if (!b.drive_folders.every(folderOk) || !b.drives.every(legacyDriveOk) || b.drives.length > DRIVES_MAX) {
    return { field: 'drive', message: 'One of the Google Drive entries cannot be saved. Remove it and add it again.' }
  }
  if (!boundariesValid(b)) return { field: 'topic', message: 'These boundaries cannot be saved. Check each field.' }
  return null
}

const lowerRepo = (r: { org: string; repo: string }) => `${r.org.toLowerCase()}/${r.repo.toLowerCase()}`

/**
 * The draft as it is sent: the topic trimmed; the first of duplicates kept (orgs and repositories
 * without case, folders on folder_id, legacy drives exactly); a repository of a whole org left out
 * (the whole org covers it).
 */
export function toBoundaries(d: BoundariesDraft): Boundaries {
  const orgs: string[] = []
  for (const o of d.github_orgs.map((x) => x.trim())) if (o && !orgs.some((h) => h.toLowerCase() === o.toLowerCase())) orgs.push(o)
  const whole = new Set(orgs.map((o) => o.toLowerCase()))
  const repos: RepoBoundary[] = []
  for (const r of d.github_repos) {
    if (whole.has(r.org.toLowerCase()) || repos.some((h) => lowerRepo(h) === lowerRepo(r))) continue
    repos.push({ org: r.org, repo: r.repo, id: r.id })
  }
  const folders: FolderBoundary[] = []
  for (const f of d.drive_folders) {
    if (folders.some((h) => h.folder_id === f.folder_id)) continue
    folders.push({ domain: f.domain, drive_id: f.drive_id, folder_id: f.folder_id, folder_name: f.folder_name, drive_name: f.drive_name })
  }
  const drives: DriveBoundary[] = []
  for (const x of d.drives) if (!drives.some((h) => h.domain === x.domain && h.shared_drive === x.shared_drive)) drives.push({ domain: x.domain, shared_drive: x.shared_drive })
  return { topic: trimText(d.topic), github_orgs: orgs, github_repos: repos, drive_folders: folders, drives, member_folders: d.member_folders }
}

/** A refused save in words; `conflict` when someone else saved first (the form then reloads). */
export function boundariesRefusal(err: ChangeError): { conflict: boolean; message: string } {
  if (err.relayError === 'version_conflict' || err.relayStatus === 409) {
    return {
      conflict: true,
      message: 'Someone else changed the boundaries while you were editing. The latest version is shown now: make your change again.',
    }
  }
  if (err.signedOut || err.notOnTeam) return { conflict: false, message: err.message }
  if (err.relayError === 'legacy_drive') {
    return { conflict: false, message: 'A shared drive typed by name can only be kept or removed. Pick shared-drive folders instead.' }
  }
  if (err.relayError === 'org_not_allowed') {
    return { conflict: false, message: 'This relay only allows some GitHub organisations, and one of yours is not one of them. Remove it, or ask whoever runs the relay.' }
  }
  if (err.relayError === 'drive_not_allowed') {
    return { conflict: false, message: 'This relay only allows some shared drives, and one of your folders is in another. Remove it, or ask whoever runs the relay.' }
  }
  if (err.relayStatus === 403) return { conflict: false, message: 'Only team owners can change the boundaries.' }
  if (err.relayStatus === 429 || err.relayError === 'rate_limited') return { conflict: false, message: 'Too many changes for now. Try again in a while.' }
  if (err.relayStatus === 400 || err.relayStatus === 422 || err.status === 400) {
    return { conflict: false, message: err.detail ?? 'The relay refused these boundaries. Check each field.' }
  }
  if (err.relayStatus === 404) return { conflict: false, message: 'This relay does not keep boundaries yet. Ask whoever runs it to update it.' }
  return { conflict: false, message: err.message }
}

/** Whether a team has boundaries set (version 0 or null boundaries: never set). */
export function isSet(b: TeamBoundaries | undefined): b is TeamBoundaries & { boundaries: Boundaries } {
  return !!b && b.version > 0 && b.boundaries !== null
}

/** A domain as typed: no spaces, lower case, without a scheme or a trailing path. */
export function tidyDomain(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\s/g, '')
}
