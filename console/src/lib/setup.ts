// M11 §6: the Join checklist, worked out from what the viewer's Mac last reported
// (GET /api/members-status), the version they accepted (GET /api/acceptance) and the team's
// boundaries (GET /api/boundaries); the setup command and the owner's invite message.

import type { Acceptance, Join, MemberStatusEntry, MembersStatus, TeamBoundaries } from '@/api/types'

export type SetupStepId = 'setup' | 'claude' | 'answering' | 'folders' | 'drive' | 'boundaries' | 'self_test'

export interface SetupStep {
  id: SetupStepId
  title: string
  done: boolean
  /** What to do, in one sentence, while it is not done. */
  todo: string
}

export const SETUP_STEPS = 7

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

const NOT_KNOWN = "Not known yet: the team's boundaries have not loaded."

/**
 * The seven steps of M11 §6, in order. `bounds` null or undefined: not read (loading, or the
 * read failed), so "Folders chosen" and "Google Drive connected" are not known and never tick.
 * Read: a team with no GitHub orgs (or no boundaries set) ticks "Folders chosen", one with no
 * drives "Google Drive connected".
 */
export function setupSteps(entry: MemberStatusEntry | null, bounds: TeamBoundaries | null | undefined, accepted: number, current: number): SetupStep[] {
  const s = entry?.status ?? null
  const b = boundariesSet(bounds) ? bounds.boundaries : null
  const read = !!bounds
  const noOrgs = read && (!b || b.github_orgs.length === 0)
  const noDrives = read && (!b || b.drives.length === 0)
  const claudeOk = !!s && s.claude.found && s.claude.signed_in
  let claudeTodo = 'Runs once the setup command has started on your Mac.'
  if (s && !s.claude.found) claudeTodo = 'Install Claude Code, then run the setup command again.'
  else if (s && !s.claude.signed_in) claudeTodo = 'Run claude auth login in Terminal, or the setup command again, to sign Claude Code in.'
  const set = b !== null && current > 0
  return [
    { id: 'setup', title: 'Run the setup command', done: s !== null, todo: 'Copy the command above and run it in Terminal on your Mac.' },
    { id: 'claude', title: 'Claude Code found and signed in', done: claudeOk, todo: claudeTodo },
    {
      id: 'answering',
      title: 'Answering in the background',
      done: entry?.answering === true,
      todo: s
        ? 'Your Mac has not checked in for a few minutes; keep it awake and online, or run the setup command again.'
        : 'Starts on its own when the setup command finishes.',
    },
    {
      id: 'folders',
      title: 'Folders chosen',
      done: read && (noOrgs || (!!s && s.folders.repo_roots > 0)),
      todo: read
        ? `Run the setup command again and give the folders that hold your clones of ${b ? listWords(b.github_orgs) : "the team's GitHub orgs"}.`
        : NOT_KNOWN,
    },
    {
      id: 'drive',
      title: 'Google Drive connected',
      done: read && (noDrives || (!!s && s.drive.connected)),
      todo: read ? 'Run the setup command again and connect Google Drive when it asks.' : NOT_KNOWN,
    },
    {
      id: 'boundaries',
      title: 'Boundaries accepted',
      done: set && accepted === current,
      todo: set ? 'Read the boundaries below and accept them.' : "An owner has not set the team's boundaries yet; nothing is answered until they do.",
    },
    {
      id: 'self_test',
      title: 'Self-test passed',
      done: !!s && s.self_test.ok,
      todo: s ? selfTestTodo(s.self_test.reason) : 'Runs on its own once the setup is done.',
    },
  ]
}

function selfTestTodo(reason: string | null): string {
  if (reason === SELF_TEST_PENDING) return 'Running the self-test now; this takes about a minute.'
  const r = plainLine(reason)
  return r ? `The self-test failed (${r}); fix that, then run the setup command again.` : 'The self-test failed; run the setup command again.'
}

/** A reason the Mac reported, as one short plain line, or null. */
function plainLine(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '')
  return t && t.length <= 200 ? t : null
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** How many of the seven steps a member has done (the Members panel's "n of 7 set up"). */
export function setupCount(entry: MemberStatusEntry, bounds: TeamBoundaries | null | undefined, current: number): number {
  return setupSteps(entry, bounds, entry.accepted_version, current).filter((s) => s.done).length
}

// ---------------------------------------------------------------------------------------
// The boundaries the viewer is asked to accept, with what is new since their last acceptance.

export interface BoundaryItems {
  topic: string
  orgs: Array<{ name: string; isNew: boolean }>
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
  return {
    topic: b.topic,
    orgs: b.github_orgs.map((name) => ({ name, isNew: fresh(since?.github_orgs[name.toLowerCase()]) })),
    drives: b.drives.map((d, i) => {
      const s = since?.drives[i]
      const match = s && s.domain === d.domain && s.shared_drive === d.shared_drive ? s.since : undefined
      return { domain: d.domain, shared_drive: d.shared_drive, isNew: fresh(match) }
    }),
    memberFolders: { allowed: b.member_folders, isNew: b.member_folders && fresh(since?.member_folders) },
  }
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

/** M11 §6: what an owner sends someone they invited. Plain text. */
export function inviteMessage(teamName: string, origin: string): string {
  return [
    `You're invited to the team ${oneLine(teamName)} on Team relay.`,
    '',
    `Console: ${origin}/`,
    `Setup command (run it in Terminal on your Mac): ${setupCommand(origin)}`,
    '',
    'Open the link, accept the invitation, then follow the checklist.',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------
// The answers as read: never trusted to be shaped (an older server, a proxy's page).

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
const MEMBER_RE = /^[a-z][a-z0-9_]{1,31}$/

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
    })
  }
  return { members, boundaries_version: raw.boundaries_version as number }
}

/** GET /api/acceptance; null when it is not that answer. */
export function readAcceptance(raw: unknown): Acceptance | null {
  if (!isObj(raw) || !count(raw.version, 2 ** 31 - 1)) return null
  return { version: raw.version as number, accepted_at: typeof raw.accepted_at === 'string' ? raw.accepted_at : null }
}
