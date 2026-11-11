// M11 §6 and M11-SPEC "Simpler joining": the viewer's two steps (set up your Mac, accept what
// the team shares), worked out from what the viewer's Mac last reported (GET
// /api/members-status), the version they accepted (GET /api/acceptance) and the team's
// boundaries (GET /api/boundaries). "Ask the team" is not a step: the Setup page always offers
// it below them. Also the setup line and
// the owner's invite message. Everything here is read by people who have never used Terminal:
// plain sentences, never the names of tools.

import type { Acceptance, ItemKey, Join, MemberSources, MemberStatusEntry, MembersStatus, TeamBoundaries } from '@/api/types'
import { toBoundaries } from './boundaries'
import { folderLabel, folderWhere, itemKey, itemLabel, itemsForKeys, itemSince, repoName, sourceItems, type SourceItem } from './sources'

export type MacCheckId = 'setup' | 'claude' | 'answering' | 'folders' | 'drive' | 'self_test'

/** One thing "Set up your Mac" needs; `todo` is one plain sentence of what to do. */
export interface MacCheck {
  id: MacCheckId
  done: boolean
  todo: string
}

export type SetupStepId = 'mac' | 'accept'

export interface SetupStep {
  id: SetupStepId
  title: string
  done: boolean
  /** "Set up your Mac": what it is made of. Empty for the other one. */
  checks: MacCheck[]
}

export const SETUP_STEPS = 2

/**
 * `self_test.reason` while the Mac's first self-test is still running: not a failure. The same
 * literal as the plugin's SELF_TEST_PENDING (plugin/src/boundaries-types.ts).
 */
export const SELF_TEST_PENDING = 'the self-test has not run yet'

/** The version the viewer accepted: their own acceptance when it has loaded, else members-status's. */
export function acceptedVersion(entry: MemberStatusEntry | null, acceptance: Acceptance | null | undefined): number {
  if (acceptance && Number.isInteger(acceptance.version)) return acceptance.version
  return entry?.accepted_version ?? 0
}

/** The boundaries' current version: the newer of the boundaries read and members-status's. */
export function currentVersion(bounds: TeamBoundaries | null | undefined, statusVersion: number | null | undefined): number {
  return Math.max(bounds?.version ?? 0, statusVersion ?? 0)
}

/** Whether boundaries are set (version 0 and null mean never). */
export function boundariesSet(bounds: TeamBoundaries | null | undefined): bounds is TeamBoundaries & { boundaries: NonNullable<TeamBoundaries['boundaries']> } {
  return !!bounds && bounds.version > 0 && bounds.boundaries !== null
}

export const SETUP_LINE_TODO = 'Paste the setup line into Terminal on your Mac, press Enter and answer its questions.'
const NOT_KNOWN = "We couldn't check this yet, because the team's settings haven't loaded. This page tries again in a moment."
export const CHECKING = 'Your Mac is checking that everything works. This takes about a minute.'

/**
 * What "Set up your Mac" is made of: the Mac has reported in, Claude Code is there and signed
 * in, the Mac answers now, folders and Google Drive (when the team's boundaries ask for them)
 * and the self-test. `bounds` null or undefined: not read (loading, or the read failed), so
 * folders and Drive are not known and never done. Read: a team with no GitHub orgs (or no
 * boundaries set) needs no folders, one with no drives no Drive. Before the Mac has reported
 * anything, the only check is running the setup line.
 */
export function macChecks(entry: MemberStatusEntry | null, bounds: TeamBoundaries | null | undefined): MacCheck[] {
  const s = entry?.status ?? null
  if (!s) return [{ id: 'setup', done: false, todo: SETUP_LINE_TODO }]
  const b = boundariesSet(bounds) ? bounds.boundaries : null
  const read = !!bounds
  // PICKERS-SPEC: whole orgs and single repositories need project folders; picked Drive
  // folders and legacy drives need Google Drive.
  const noOrgs = read && (!b || (b.github_orgs.length === 0 && b.github_repos.length === 0))
  const noDrives = read && (!b || (b.drives.length === 0 && b.drive_folders.length === 0))
  return [
    { id: 'setup', done: true, todo: SETUP_LINE_TODO },
    {
      id: 'claude',
      done: s.claude.found && s.claude.signed_in,
      todo: s.claude.found
        ? "Claude Code isn't signed in on your Mac. Run the setup line again and sign in when it asks."
        : "Claude Code isn't on your Mac yet. Run the setup line again and say yes when it offers to install it.",
    },
    {
      id: 'answering',
      done: entry?.answering === true,
      todo: "Your Mac isn't answering right now. Make sure it's switched on; if this stays, run the setup line again.",
    },
    {
      id: 'folders',
      done: read && (noOrgs || s.folders.repo_roots > 0),
      todo: read
        ? `Your Mac doesn't know where your ${b ? listWords(githubOrgs(b)) : 'team'} project folders are yet. Run the setup line again and pick them.`
        : NOT_KNOWN,
    },
    {
      id: 'drive',
      done: read && (noDrives || s.drive.connected),
      todo: read ? "Google Drive isn't connected yet. Run the setup line again and sign in to Google when it asks." : NOT_KNOWN,
    },
    { id: 'self_test', done: s.self_test.ok, todo: selfTestTodo(s.self_test.reason) },
  ]
}

/** The two steps, in order. */
export function setupSteps(entry: MemberStatusEntry | null, bounds: TeamBoundaries | null | undefined, accepted: number, current: number): SetupStep[] {
  const checks = macChecks(entry, bounds)
  const set = boundariesSet(bounds) && current > 0
  return [
    { id: 'mac', title: 'Set up your Mac', done: checks.every((c) => c.done), checks },
    { id: 'accept', title: 'Accept what the team shares', done: set && accepted === current, checks: [] },
  ]
}

/**
 * Whether the viewer has joined, for the team page's join card: their Mac has reported in at
 * least once and they have accepted what the team shares at least once (when the team shares
 * anything yet). Later trouble (the Mac switched off, a check failing, something new to accept)
 * does not bring the card back: the Setup tab's count and the accept banner show it.
 */
export function hasJoined(entry: MemberStatusEntry | null, bounds: TeamBoundaries | null | undefined, accepted: number): boolean {
  return !!entry?.status && (!boundariesSet(bounds) || accepted > 0)
}

function selfTestTodo(reason: string | null): string {
  if (reason === SELF_TEST_PENDING) return CHECKING
  const r = plainLine(reason)
  const base = "Your Mac's last check didn't pass. Run the setup line again."
  return r ? `${base} If it still doesn't pass, show this to a team owner: ${r}.` : base
}

/** A reason the Mac reported, as one short plain line, or null. */
function plainLine(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '')
  return t && t.length <= 200 ? t : null
}

/** The orgs a team shares from: whole orgs, then the orgs of single repositories, each once (without case). */
function githubOrgs(b: NonNullable<TeamBoundaries['boundaries']>): string[] {
  const out: string[] = []
  for (const o of [...b.github_orgs, ...b.github_repos.map((r) => r.org)]) if (!out.some((x) => x.toLowerCase() === o.toLowerCase())) out.push(o)
  return out
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** How many of the two steps a member has done (the Members panel's "set up" or "n of 2 set up"). */
export function setupCount(entry: MemberStatusEntry, bounds: TeamBoundaries | null | undefined, current: number): number {
  return setupSteps(entry, bounds, entry.accepted_version, current).filter((s) => s.done).length
}

// ---------------------------------------------------------------------------------------
// The boundaries the viewer is asked to accept, with what is new since their last acceptance.

export interface BoundaryItems {
  topic: string
  /** Whole GitHub organisations. */
  orgs: Array<{ name: string; isNew: boolean }>
  /** Single repositories, as example-org/api. */
  repos: Array<{ name: string; isNew: boolean }>
  /** Picked shared-drive folders: the folder's name and where it is ("in Example Team Drive"). */
  folders: Array<{ key: ItemKey; name: string; where: string; isNew: boolean }>
  /** Legacy shared drives, matched by name. */
  drives: Array<{ domain: string; shared_drive: string; isNew: boolean }>
  memberFolders: { allowed: boolean; isNew: boolean }
}

/**
 * M10 §7.1's `since`: an item is new when it was added after the version the viewer accepted.
 * An item `since` does not name counts as added in the current version. Nothing is marked
 * before a first acceptance (everything is new then).
 */
export function boundaryItems(bounds: TeamBoundaries & { boundaries: NonNullable<TeamBoundaries['boundaries']> }, accepted: number): BoundaryItems {
  const b = bounds.boundaries
  const since = bounds.since ?? null
  const fresh = (v: number | null | undefined) => accepted > 0 && (v ?? bounds.version) > accepted
  const n = toBoundaries(b)
  return {
    topic: b.topic,
    orgs: b.github_orgs.map((name) => ({ name, isNew: fresh(since?.github_orgs[name.toLowerCase()]) })),
    repos: n.github_repos.map((r) => ({ name: repoName(r), isNew: fresh(itemSince({ kind: 'repo', ...r }, since, bounds.version)) })),
    folders: n.drive_folders.map((f) => ({
      key: itemKey({ kind: 'folder', ...f }),
      name: f.folder_name,
      where: folderWhere(f),
      isNew: fresh(itemSince({ kind: 'folder', ...f }, since, bounds.version)),
    })),
    drives: b.drives.map((d, i) => {
      const s = since?.drives[i]
      const match = s && s.domain === d.domain && s.shared_drive === d.shared_drive ? s.since : undefined
      return { domain: d.domain, shared_drive: d.shared_drive, isNew: fresh(match) }
    }),
    memberFolders: { allowed: b.member_folders, isNew: b.member_folders && fresh(since?.member_folders) },
  }
}

// ---------------------------------------------------------------------------------------
// PICKERS-SPEC §7.4: what the viewer's Mac cannot find, one plain line each.

/** A repository is cloned with one line in Terminal; everything else is a sentence. */
export type MissingLine =
  | { kind: 'repo'; key: ItemKey; name: string; command: string; todo: string }
  | { kind: 'org'; key: ItemKey; name: string; todo: string; link: string }
  | { kind: 'folder' | 'drive'; key: ItemKey; name: string; todo: string }

export interface MissingSources {
  /** Items of the current boundaries the Mac reported it cannot find. */
  missing: MissingLine[]
  /** Items added after the version the Mac last looked for: not known yet. */
  checking: Array<{ key: ItemKey; name: string }>
}

export const CLONE_TODO = 'Run it in Terminal inside the folder you picked for projects.'
const DRIVE_TODO = "Make sure Google Drive for desktop is signed in with your work account; if it still doesn't show, ask a team owner for access to the shared drive."

/** One missing item as a line to act on. */
export function missingLine(item: SourceItem): MissingLine {
  const key = itemKey(item)
  switch (item.kind) {
    case 'repo':
      return { kind: 'repo', key, name: repoName(item), command: `git clone https://github.com/${item.org}/${item.repo}.git`, todo: CLONE_TODO }
    case 'org':
      return {
        kind: 'org',
        key,
        name: item.org,
        todo: `No ${item.org} projects found. Clone the ones you work on into the folder you picked for projects.`,
        link: `https://github.com/orgs/${item.org}/repositories`,
      }
    case 'folder':
      return { kind: 'folder', key, name: folderLabel(item), todo: `${folderLabel(item)} isn't on this Mac. ${DRIVE_TODO}` }
    case 'drive':
      return { kind: 'drive', key, name: item.shared_drive, todo: `The shared drive ${item.shared_drive} isn't on this Mac. ${DRIVE_TODO}` }
  }
}

/**
 * The viewer's missing sources: the keys their Mac reported, as items of the current boundaries
 * (a key of an item removed since is left out), and the items added after the version the Mac
 * looked for ("checking…"). Empty while nothing is known (an older plugin, no boundaries).
 */
export function missingSources(entry: MemberStatusEntry | null, bounds: TeamBoundaries | null | undefined): MissingSources {
  const src = entry?.sources ?? null
  if (!src || !boundariesSet(bounds)) return { missing: [], checking: [] }
  const missing = itemsForKeys(bounds.boundaries, src.missing).map(missingLine)
  const known = new Set<string>(missing.map((m) => m.key))
  const checking =
    src.boundaries_version < bounds.version
      ? sourceItems(bounds.boundaries)
          .filter((i) => !known.has(itemKey(i)) && itemSince(i, bounds.since, bounds.version) > src.boundaries_version)
          .map((i) => ({ key: itemKey(i), name: itemLabel(i) }))
      : []
  return { missing, checking }
}

/** A member's missing sources by name, for an owner's Members panel. */
export function missingNames(entry: MemberStatusEntry, bounds: TeamBoundaries | null | undefined): string[] {
  if (!entry.sources || !boundariesSet(bounds)) return []
  return itemsForKeys(bounds.boundaries, entry.sources.missing).map(itemLabel)
}

// ---------------------------------------------------------------------------------------
// The setup command and the invite message.

const HTTPS_ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * The team's public address: the page's own origin on the hosted console (M10 §5: one host
 * serves the relay and the console). The local console runs on this computer only, so there it
 * is the relay's origin from /api/join. Null when neither is a plain https origin.
 */
export function publicOrigin(loc: Pick<Location, 'hostname' | 'origin'>, join: Join | null | undefined): string | null {
  if (!LOOPBACK.has(loc.hostname)) return HTTPS_ORIGIN_RE.test(loc.origin) ? loc.origin : null
  if (!join) return null
  try {
    const u = new URL(join.relay_url)
    if (u.username || u.password) return null
    return HTTPS_ORIGIN_RE.test(u.origin) ? u.origin : null
  } catch {
    return null
  }
}

/** M11 §5: the one command that sets a Mac up. */
export function setupCommand(origin: string): string {
  return `curl -fsSL ${origin}/setup | bash`
}

/** A team's display name on one line (it is someone's text; the message is plain text). */
function oneLine(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
}

/** The three things a new member does after opening the team page (the join card says the same). */
export const OPEN_TERMINAL = 'Open Terminal: press Cmd+Space, type Terminal, press Enter.'
export const PASTE_LINE = 'Paste this line and press Enter, then answer its questions:'
export const COME_BACK = 'Come back to this page and click Accept.'

/** M11 §6, "Simpler joining": what an owner sends someone they invited. Plain text, no markdown. */
export function inviteMessage(teamName: string, origin: string): string {
  return [
    `You're invited to the team ${oneLine(teamName)} on Team relay.`,
    '',
    `${origin}/`,
    '',
    'Open the link and accept the invitation. Then, on your Mac:',
    '',
    `1. ${OPEN_TERMINAL}`,
    `2. ${PASTE_LINE}`,
    setupCommand(origin),
    `3. ${COME_BACK.replace('this page', 'the page')}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------------------
// The answers as read: never trusted to be shaped (an older server, a proxy's page).

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
const MEMBER_RE = /^[a-z][a-z0-9_]{1,31}$/
/** PICKERS-SPEC §3.3: a key is 1-400 characters with no control or format character, of one of the four kinds. */
const KEY_RE = /^(?:org|repo|folder|drive):/
const KEY_FORBIDDEN_RE = /[\p{Cc}\p{Cf}]/u

/** A member's `sources` as read; null for anything else (an older relay or plugin sends none). */
function readSources(v: unknown): MemberSources | null {
  if (!isObj(v) || !count(v.boundaries_version, 2 ** 31 - 1) || !Array.isArray(v.missing) || v.missing.length > 140) return null
  const missing: ItemKey[] = []
  for (const k of v.missing) {
    if (typeof k !== 'string' || [...k].length > 400 || !KEY_RE.test(k) || KEY_FORBIDDEN_RE.test(k)) return null
    if (!missing.includes(k as ItemKey)) missing.push(k as ItemKey)
  }
  return { boundaries_version: v.boundaries_version as number, missing }
}

function readStatus(v: unknown): MemberStatusEntry['status'] | undefined {
  if (v === null) return null
  if (!isObj(v)) return undefined
  const { daemon, claude, folders, drive, self_test: test } = v
  if (!isObj(daemon) || !isObj(claude) || !isObj(folders) || !isObj(drive) || !isObj(test) || typeof v.seen_at !== 'string') return undefined
  if (typeof claude.found !== 'boolean' || typeof claude.signed_in !== 'boolean' || typeof drive.connected !== 'boolean' || typeof test.ok !== 'boolean') return undefined
  if (!count(folders.repo_roots, 64) || !count(folders.clones, 10_000) || !count(folders.extra_folders, 64)) return undefined
  return {
    daemon: { version: typeof daemon.version === 'string' ? daemon.version.slice(0, 32) : '', started_at: typeof daemon.started_at === 'string' ? daemon.started_at : '' },
    claude: { found: claude.found, signed_in: claude.signed_in },
    folders: { repo_roots: folders.repo_roots as number, clones: folders.clones as number, extra_folders: folders.extra_folders as number },
    drive: { connected: drive.connected },
    self_test: { ok: test.ok, at: typeof test.at === 'string' ? test.at : '', reason: typeof test.reason === 'string' ? test.reason.slice(0, 200) : null },
    seen_at: v.seen_at,
  }
}

/** GET /api/members-status, kept to well-formed entries; null when it is not that answer at all. */
export function readMembersStatus(raw: unknown): MembersStatus | null {
  if (!isObj(raw) || !Array.isArray(raw.members) || !count(raw.boundaries_version, 2 ** 31 - 1)) return null
  const members: MemberStatusEntry[] = []
  for (const m of raw.members.slice(0, 500)) {
    if (!isObj(m) || typeof m.member !== 'string' || !MEMBER_RE.test(m.member)) continue
    const status = readStatus(m.status)
    if (status === undefined) continue
    members.push({
      member: m.member,
      status,
      answering: m.answering === true,
      accepted_version: count(m.accepted_version, 2 ** 31 - 1) ? (m.accepted_version as number) : 0,
      sources: readSources(m.sources),
    })
  }
  return { members, boundaries_version: raw.boundaries_version as number }
}

/** GET /api/acceptance; null when it is not that answer. */
export function readAcceptance(raw: unknown): Acceptance | null {
  if (!isObj(raw) || !count(raw.version, 2 ** 31 - 1)) return null
  return { version: raw.version as number, accepted_at: typeof raw.accepted_at === 'string' ? raw.accepted_at : null }
}
