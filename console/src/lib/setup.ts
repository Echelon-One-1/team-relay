// M11 §6 and M11-SPEC "Simpler joining": the viewer's two steps (set up your Mac, accept the
// team's topic), worked out from what the viewer's Mac last reported (GET
// /api/members-status), the version they accepted (GET /api/acceptance) and the team's
// boundaries (GET /api/boundaries). "Ask the team" is not a step: the Setup page always offers
// it below them. Also the setup line and
// the owner's invite message. Everything here is read by people who have never used Terminal:
// plain sentences, never the names of tools.

import type { Acceptance, Join, MemberStatusEntry, MembersStatus, TeamBoundaries } from '@/api/types'

export type MacCheckId = 'setup' | 'claude' | 'answering' | 'folders' | 'self_test'

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

/**
 * Whether the viewer's acceptance holds for the boundaries' current version: they accepted a
 * version from 1 up to it (as the plugin counts it; a version above it was accepted on an
 * earlier team under the same id). The topic carries nothing to widen, so a later topic needs
 * no new acceptance.
 */
export function isAccepted(accepted: number, current: number): boolean {
  return accepted >= 1 && accepted <= current
}

/** Whether boundaries are set (version 0 and null mean never). */
export function boundariesSet(bounds: TeamBoundaries | null | undefined): bounds is TeamBoundaries & { boundaries: NonNullable<TeamBoundaries['boundaries']> } {
  return !!bounds && bounds.version > 0 && bounds.boundaries !== null
}

export const SETUP_LINE_TODO = 'Paste the setup line into Terminal on your Mac, press Enter and answer its questions.'
export const FOLDERS_TODO = "Your Mac has no folders chosen yet, so your Claude can't read anything for teammates. Run the setup line again and choose your folders."
export const CHECKING = 'Your Mac is checking that everything works. This takes about a minute.'

/**
 * What "Set up your Mac" is made of: the Mac has reported in, Claude Code is there and signed
 * in, the Mac answers now, it reported at least one folder chosen (a count of 0 is the only
 * miss) and the self-test. Before the Mac has reported anything, the only
 * check is running the setup line.
 */
export function macChecks(entry: MemberStatusEntry | null): MacCheck[] {
  const s = entry?.status ?? null
  if (!s) return [{ id: 'setup', done: false, todo: SETUP_LINE_TODO }]
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
      // Null: not known (another member's count, which only owners read): never shown as missing.
      done: entry?.folder_count !== 0,
      todo: FOLDERS_TODO,
    },
    { id: 'self_test', done: s.self_test.ok, todo: selfTestTodo(s.self_test.reason) },
  ]
}

/** The two steps, in order. */
export function setupSteps(entry: MemberStatusEntry | null, bounds: TeamBoundaries | null | undefined, accepted: number, current: number): SetupStep[] {
  const checks = macChecks(entry)
  const set = boundariesSet(bounds) && current > 0
  return [
    { id: 'mac', title: 'Set up your Mac', done: checks.every((c) => c.done), checks },
    { id: 'accept', title: "Accept the team's topic", done: set && isAccepted(accepted, current), checks: [] },
  ]
}

/**
 * Whether the viewer has joined, for the team page's join card: their Mac has reported in at
 * least once and they have accepted the team's topic at least once (when it is set). Later
 * trouble (the Mac switched off, a check failing) does not bring the card back: the Setup tab's
 * count and the accept banner show it.
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

/** A member's folder count as an owner reads it: "1 folder", "0 folders". */
export function folderCountText(n: number): string {
  return n === 1 ? '1 folder' : `${n} folders`
}

/** How many of the two steps a member has done (the Members panel's "set up" or "n of 2 set up"). */
export function setupCount(entry: MemberStatusEntry, bounds: TeamBoundaries | null | undefined, current: number): number {
  return setupSteps(entry, bounds, entry.accepted_version, current).filter((s) => s.done).length
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
/** The most folders a member may choose on their Mac. */
export const MAX_FOLDERS = 20
function readStatus(v: unknown): MemberStatusEntry['status'] | undefined {
  if (v === null) return null
  if (!isObj(v)) return undefined
  const { daemon, claude, self_test: test } = v
  if (!isObj(daemon) || !isObj(claude) || !isObj(test) || typeof v.seen_at !== 'string') return undefined
  if (typeof claude.found !== 'boolean' || typeof claude.signed_in !== 'boolean' || typeof test.ok !== 'boolean') return undefined
  return {
    daemon: { version: typeof daemon.version === 'string' ? daemon.version.slice(0, 32) : '', started_at: typeof daemon.started_at === 'string' ? daemon.started_at : '' },
    claude: { found: claude.found, signed_in: claude.signed_in },
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
      folder_count: count(m.folder_count, MAX_FOLDERS) ? (m.folder_count as number) : null,
    })
  }
  return { members, boundaries_version: raw.boundaries_version as number }
}

/** GET /api/acceptance; null when it is not that answer. */
export function readAcceptance(raw: unknown): Acceptance | null {
  if (!isObj(raw) || !count(raw.version, 2 ** 31 - 1)) return null
  return { version: raw.version as number, accepted_at: typeof raw.accepted_at === 'string' ? raw.accepted_at : null }
}
