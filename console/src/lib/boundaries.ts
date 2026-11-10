import type { ChangeError } from '@/api/client'
import type { Boundaries, DriveBoundary, TeamBoundaries } from '@/api/types'

// M10 §1: the Boundaries form's values, checked here by the one rule the relay, the console
// server (plugin/src/console-app.ts checkSetBoundaries) and this page share (M10 §7.5,
// schema/boundaries-vectors.json), before anything is sent; and the refusals in words.

export const TOPIC_MAX = 500
export const ORGS_MAX = 10
export const DRIVES_MAX = 10
export const DRIVE_NAME_MAX = 100
export const DOMAIN_MAX = 253
export const VERSION_MAX = 2 ** 31 - 1
/** A GitHub org: letters, digits and -, not starting with -, at most 39 characters. */
export const GITHUB_ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
/** A lower-case DNS name of at least two labels, no trailing dot (the length and the last label are checked apart). */
export const DRIVE_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
/**
 * Characters no topic or drive name may hold: controls (the topic allows newline and tab),
 * format characters (bidi overrides, zero-width marks), surrogates, private use, unassigned,
 * line and paragraph separators.
 */
const TOPIC_FORBIDDEN_RE = /[\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/u
const DRIVE_NAME_FORBIDDEN_RE = /[/\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u
/** The white space the relay trims from a topic (Python's str.strip()). */
const EDGE_SPACE_RE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g

/** Surrounding white space dropped, as the relay drops it from a topic. */
export const trimText = (s: string) => s.replace(EDGE_SPACE_RE, '')

/** A topic as sent: 1-500 characters once trimmed, newline and tab the only control characters. */
export function topicOk(topic: string): boolean {
  const t = trimText(topic)
  // As the relay: refused characters are looked for in the topic as sent, before trimming.
  return chars(t) >= 1 && chars(t) <= TOPIC_MAX && !TOPIC_FORBIDDEN_RE.test(topic)
}

export const orgOk = (org: string) => GITHUB_ORG_RE.test(org)

/** A drive's domain as sent: already lower case, at least two labels, not an IP, no trailing dot. */
export function domainOk(domain: string): boolean {
  if (domain.length > DOMAIN_MAX || !DRIVE_DOMAIN_RE.test(domain)) return false
  return !/^[0-9]+$/.test(domain.slice(domain.lastIndexOf('.') + 1))
}

/** A shared drive's name as sent: 1-100 characters, no /, no control or invisible characters, no surrounding space, not . or .. */
export function driveNameOk(name: string): boolean {
  return (
    chars(name) >= 1 &&
    chars(name) <= DRIVE_NAME_MAX &&
    !DRIVE_NAME_FORBIDDEN_RE.test(name) &&
    name === trimText(name) &&
    name !== '.' &&
    name !== '..'
  )
}

/** The version a change is made from: a whole number 0..2^31-1, never a boolean or a string. */
export const versionOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= VERSION_MAX

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o)

/**
 * Whether a boundaries document, exactly as it would be sent, passes M10 §7.5: every field
 * present and no other, the list caps counted as sent (before duplicates are dropped).
 */
export function boundariesValid(raw: unknown): raw is Boundaries {
  if (!isObject(raw) || !onlyKeys(raw, ['topic', 'github_orgs', 'drives', 'member_folders'])) return false
  const { topic, github_orgs, drives, member_folders } = raw
  if (typeof topic !== 'string' || !topicOk(topic)) return false
  if (!Array.isArray(github_orgs) || github_orgs.length > ORGS_MAX) return false
  if (!github_orgs.every((o) => typeof o === 'string' && orgOk(o))) return false
  if (!Array.isArray(drives) || drives.length > DRIVES_MAX) return false
  for (const d of drives as unknown[]) {
    if (!isObject(d) || !onlyKeys(d, ['domain', 'shared_drive'])) return false
    if (typeof d.domain !== 'string' || !domainOk(d.domain)) return false
    if (typeof d.shared_drive !== 'string' || !driveNameOk(d.shared_drive)) return false
  }
  return typeof member_folders === 'boolean'
}

/** What the form holds while an owner edits: drive rows may be half filled. */
export interface BoundariesDraft {
  topic: string
  github_orgs: string[]
  drives: DriveBoundary[]
  member_folders: boolean
}

export function draftFrom(b: Boundaries | null): BoundariesDraft {
  if (!b) return { topic: '', github_orgs: [], drives: [], member_folders: false }
  return { topic: b.topic, github_orgs: [...b.github_orgs], drives: b.drives.map((d) => ({ ...d })), member_folders: b.member_folders }
}

export function sameDraft(a: BoundariesDraft, b: BoundariesDraft): boolean {
  return (
    a.topic === b.topic &&
    a.member_folders === b.member_folders &&
    a.github_orgs.length === b.github_orgs.length &&
    a.github_orgs.every((o, i) => o === b.github_orgs[i]) &&
    a.drives.length === b.drives.length &&
    a.drives.every((d, i) => d.domain === b.drives[i]!.domain && d.shared_drive === b.drives[i]!.shared_drive)
  )
}

export const chars = (s: string) => [...s].length

/** A domain as typed: no spaces, lower case, without a scheme or a trailing path. */
export function tidyDomain(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\s/g, '')
}

/** Why an org cannot be added (null: it can). */
export function orgProblem(org: string, have: string[]): string | null {
  const o = org.trim()
  if (o === '') return null
  if (!orgOk(o)) return 'A GitHub org name is 1 to 39 letters, digits or -, not starting with -, as in its github.com address.'
  if (have.some((h) => h.toLowerCase() === o.toLowerCase())) return `${o} is already listed.`
  if (have.length >= ORGS_MAX) return `At most ${ORGS_MAX} GitHub orgs.`
  return null
}

export type BoundariesField = 'topic' | 'org' | { drive: number; part: 'domain' | 'shared_drive' }

/**
 * The first problem with the draft, on the field it is about; null when it can be saved. The
 * form tidies surrounding space before sending (toBoundaries); everything else follows the one
 * rule, and what is sent is checked by it once more (boundariesValid).
 */
export function boundariesProblem(d: BoundariesDraft): { field: BoundariesField; message: string } | null {
  const topic = trimText(d.topic)
  if (topic === '') return { field: 'topic', message: 'Say what the team talks about: questions about anything else are declined.' }
  if (chars(topic) > TOPIC_MAX) return { field: 'topic', message: `The topic is ${chars(topic)} characters; at most ${TOPIC_MAX}.` }
  if (!topicOk(d.topic)) return { field: 'topic', message: 'The topic has a control or invisible character. Retype it.' }
  if (d.github_orgs.length > ORGS_MAX) return { field: 'org', message: `At most ${ORGS_MAX} GitHub orgs.` }
  if (d.github_orgs.some((o) => !orgOk(o.trim()))) {
    return { field: 'org', message: 'A GitHub org name is 1 to 39 letters, digits or -, not starting with -, as in its github.com address.' }
  }
  const rows = d.drives.map((x, i) => ({ ...x, i })).filter((x) => x.domain.trim() !== '' || trimText(x.shared_drive) !== '')
  if (rows.length > DRIVES_MAX) return { field: { drive: rows[DRIVES_MAX]!.i, part: 'domain' }, message: `At most ${DRIVES_MAX} shared drives.` }
  for (const r of rows) {
    if (!domainOk(r.domain.trim())) {
      return { field: { drive: r.i, part: 'domain' }, message: 'The domain is the Google Workspace domain of the drive, such as example.com.' }
    }
    if (!driveNameOk(trimText(r.shared_drive))) {
      return {
        field: { drive: r.i, part: 'shared_drive' },
        message: `The shared drive's name exactly as it shows under "Shared drives": 1 to ${DRIVE_NAME_MAX} characters, no /.`,
      }
    }
  }
  if (!boundariesValid(toBoundaries(d))) return { field: 'topic', message: 'These boundaries cannot be saved. Check each field.' }
  return null
}

/** The draft as it is sent: trimmed, empty drive rows left out, duplicates dropped. */
export function toBoundaries(d: BoundariesDraft): Boundaries {
  const orgs: string[] = []
  for (const o of d.github_orgs.map((x) => x.trim())) if (o && !orgs.some((h) => h.toLowerCase() === o.toLowerCase())) orgs.push(o)
  const drives: DriveBoundary[] = []
  for (const x of d.drives) {
    const domain = x.domain.trim()
    const shared_drive = trimText(x.shared_drive)
    if (!domain && !shared_drive) continue
    if (!drives.some((h) => h.domain === domain && h.shared_drive === shared_drive)) drives.push({ domain, shared_drive })
  }
  return { topic: trimText(d.topic), github_orgs: orgs, drives, member_folders: d.member_folders }
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
  if (err.relayStatus === 403) return { conflict: false, message: 'Only team owners can change the boundaries.' }
  if (err.relayStatus === 429 || err.relayError === 'rate_limited') return { conflict: false, message: 'Too many changes for now. Try again in a while.' }
  if (err.relayStatus === 400 || err.relayStatus === 422) {
    return { conflict: false, message: err.detail ?? 'The relay refused these boundaries. Check each field.' }
  }
  if (err.relayStatus === 404) return { conflict: false, message: 'This relay does not keep boundaries yet. Ask whoever runs it to update it.' }
  return { conflict: false, message: err.message }
}

/** Whether a team has boundaries set (version 0 or null boundaries: never set). */
export function isSet(b: TeamBoundaries | undefined): b is TeamBoundaries & { boundaries: Boundaries } {
  return !!b && b.version > 0 && b.boundaries !== null
}
