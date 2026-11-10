// The Members panel's rules (M6 §1, §4), as pure functions: which viewer is an owner, the
// member id suggested from an email's local part, and the checks the relay also makes.

import type { Roster, RosterMember } from '@/api/types'

export const MEMBER_ID_RE = /^[a-z][a-z0-9_]{1,31}$/
/** A plain email address (the relay lower-cases and checks it again). */
export const EMAIL_RE = /^[^\s@<>"'`]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i
/** M6 §1: at most 50 members per team. */
export const MAX_MEMBERS = 50

/** The roster's well-formed entries only (whatever answered, it is never trusted to be shaped). */
export function entries(roster: Roster | undefined): RosterMember[] {
  const list: unknown = roster?.members
  if (!Array.isArray(list)) return []
  return list.filter(
    (m): m is RosterMember =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as RosterMember).member === 'string' &&
      MEMBER_ID_RE.test((m as RosterMember).member) &&
      ((m as RosterMember).role === 'owner' || (m as RosterMember).role === 'member'),
  )
}

/** M9 §7.2: an entry an owner added and its person has not accepted yet (absent: active). */
export function isInvited(m: RosterMember): boolean {
  return m.status !== undefined && m.status !== 'active'
}

export function isOwner(roster: Roster | undefined, member: string | null): boolean {
  if (!member) return false
  return entries(roster).some((m) => m.member === member && m.role === 'owner' && !isInvited(m))
}

/** Owners who have accepted: an invitation to be an owner is not one. */
export function ownerCount(roster: Roster | undefined): number {
  return entries(roster).filter((m) => m.role === 'owner' && !isInvited(m)).length
}

/** Active members, owners first, then by member id; the open invitations after them. */
export function sortedMembers(roster: Roster | undefined): RosterMember[] {
  return [...entries(roster)].sort((a, b) => {
    if (isInvited(a) !== isInvited(b)) return isInvited(a) ? 1 : -1
    return a.role === b.role ? a.member.localeCompare(b.member) : a.role === 'owner' ? -1 : 1
  })
}

/** The emails the viewer may see (others' are masked to null for a member). */
export function visibleEmails(m: RosterMember): string[] {
  return (Array.isArray(m.emails) ? m.emails : []).filter((e): e is string => typeof e === 'string' && e.length > 0)
}

/**
 * A member id from an email's local part: lower-case letters, digits and _, starting with a
 * letter, 2 to 32 characters, and not one already taken (a _2, _3 ... suffix when it is).
 */
export function suggestMemberId(email: string, taken: Iterable<string> = []): string {
  const local = email.trim().toLowerCase().split('@')[0] ?? ''
  let id = local
    .split('+')[0]!
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!/^[a-z]/.test(id)) id = `m_${id}`.replace(/_+$/, '')
  id = id.slice(0, 32).replace(/_+$/, '')
  if (id.length < 2) id = `${id}_member`.slice(0, 32)
  const used = new Set(taken)
  if (!used.has(id)) return id
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`
    const candidate = `${id.slice(0, 32 - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return id
}

/** What is wrong with an add, before it is sent; null when nothing is. */
export function addProblem(roster: Roster | undefined, member: string, email: string): string | null {
  const e = email.trim().toLowerCase()
  if (!EMAIL_RE.test(e)) return 'Enter a Google email address.'
  if (!MEMBER_ID_RE.test(member)) return 'Pick a member id like alice_2: it starts with a lower-case letter, then lower-case letters, digits or _, 2 to 32 characters.'
  const members = entries(roster)
  if (members.some((m) => m.member === member)) return `${member} is already a member id on this team.`
  if (members.some((m) => visibleEmails(m).includes(e))) return 'That email already belongs to a member of the team.'
  if (members.length >= MAX_MEMBERS) return `A team has at most ${MAX_MEMBERS} members, open invitations included.`
  return null
}
