import type { ChangeError } from '@/api/client'
import type { Boundaries, TeamBoundaries } from '@/api/types'

// M10 §1, schema v3 (13 Nov 2026): a team's boundaries are its topic alone. The topic is checked
// here by the one rule the relay, the console server (plugin/src/console-app.ts, plugin/src/
// boundaries-rule.ts) and this page share (schema/boundaries-vectors.json), before anything is
// sent; and the refusals in words.

export const TOPIC_MAX = 500
export const VERSION_MAX = 2 ** 31 - 1

/**
 * Fields of the earlier schemas (GitHub, Google Drive, members' own folders), in the order the
 * relay names the first one it finds when it refuses a body that holds one.
 */
export const REMOVED_FIELDS = ['github_orgs', 'github_repos', 'drive_folders', 'drives', 'member_folders'] as const

/**
 * Characters no topic may hold: controls (newline and tab allowed), format characters (bidi
 * overrides, zero-width marks), surrogates, private use, line and paragraph separators. Unassigned
 * code points are allowed (each side's Unicode tables differ in age).
 */
const TOPIC_FORBIDDEN_RE = /[\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/u
/** The white space the relay trims from a topic (Python's str.strip()). */
const EDGE_SPACE_RE = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g

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

/** The version a change is made from: a whole number 0..2^31-1, never a boolean or a string. */
export const versionOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= VERSION_MAX

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Whether a boundaries document, exactly as it would be sent, passes the rule: {topic} and nothing else. */
export function boundariesValid(raw: unknown): raw is Boundaries {
  return isObject(raw) && Object.keys(raw).length === 1 && has(raw, 'topic') && topicOk(raw.topic)
}

/** The first field of an earlier schema a boundaries object holds (the one the relay names), or null. */
export function removedField(raw: unknown): (typeof REMOVED_FIELDS)[number] | null {
  if (!isObject(raw)) return null
  return REMOVED_FIELDS.find((f) => has(raw, f)) ?? null
}

/**
 * A document to show, as a relay answers it: one that passes the rule, or one an earlier relay
 * wrote (the topic and fields of the earlier schemas only), read as its topic alone. Null for
 * anything else.
 */
export function readBoundaries(raw: unknown): Boundaries | null {
  if (!isObject(raw) || !has(raw, 'topic') || !topicOk(raw.topic)) return null
  const known = new Set<string>(['topic', ...REMOVED_FIELDS])
  if (!Object.keys(raw).every((k) => known.has(k))) return null
  return { topic: raw.topic }
}

/**
 * GET /api/boundaries as read: the document through readBoundaries. Null when it is not that
 * answer at all, or holds a document that breaks the rule.
 */
export function readTeamBoundaries(raw: unknown): TeamBoundaries | null {
  if (!isObject(raw) || typeof raw.team !== 'string' || !versionOk(raw.version)) return null
  const updated_at = typeof raw.updated_at === 'string' ? raw.updated_at : null
  const updated_by = typeof raw.updated_by === 'string' ? raw.updated_by : null
  if (raw.boundaries === null || raw.boundaries === undefined) return { team: raw.team, version: raw.version, boundaries: null, updated_at, updated_by }
  const boundaries = readBoundaries(raw.boundaries)
  if (boundaries === null) return null
  return { team: raw.team, version: raw.version, boundaries, updated_at, updated_by }
}

/** What the form holds while an owner edits: the topic as typed. */
export interface BoundariesDraft {
  topic: string
}

export const draftFrom = (b: Boundaries | null): BoundariesDraft => ({ topic: b?.topic ?? '' })

export const sameDraft = (a: BoundariesDraft, b: BoundariesDraft) => a.topic === b.topic

/** The problem with the draft's topic in words; null when it can be saved. */
export function boundariesProblem(d: BoundariesDraft): string | null {
  const topic = trimText(d.topic)
  if (topic === '') return 'Say what the team talks about: questions about anything else are declined.'
  if (chars(topic) > TOPIC_MAX) return `The topic is ${chars(topic)} characters; at most ${TOPIC_MAX}.`
  if (!topicOk(d.topic)) return 'The topic has a control or invisible character. Retype it.'
  return null
}

/** The draft as it is sent: the topic trimmed. */
export const toBoundaries = (d: BoundariesDraft): Boundaries => ({ topic: trimText(d.topic) })

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
  if (err.relayStatus === 400 || err.relayStatus === 422 || err.status === 400) {
    return { conflict: false, message: err.detail ?? 'The relay refused this topic. Check it and save again.' }
  }
  if (err.relayStatus === 404) return { conflict: false, message: 'This relay does not keep boundaries yet. Ask whoever runs it to update it.' }
  return { conflict: false, message: err.message }
}

/** Whether a team has boundaries set (version 0 or null boundaries: never set). */
export function isSet(b: TeamBoundaries | undefined): b is TeamBoundaries & { boundaries: Boundaries } {
  return !!b && b.version > 0 && b.boundaries !== null
}
