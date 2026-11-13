// The one validation rule for a team's boundaries (schema v3, 13 Nov 2026: the topic alone), as
// this plugin applies it: to the console server's PUT body (console-app.ts checkSetBoundaries)
// and to the boundaries the relay hands the host (boundary-set.ts validBoundaries). The relay is
// the authority (relay/boundaries.py); schema/boundaries-vectors.json holds the cases every
// implementation's tests load.
//
//   version  an integer 0..2^31-1 (never a boolean)
//   topic    trimmed (as Python's str.strip()), 1-500 characters; newline and tab the only
//            control characters; no format, surrogate, private-use or line/paragraph-separator
//            character anywhere in it as sent (unassigned code points allowed)
//   fields   exactly topic
//
// A PUT body holding a field of the earlier schemas (github_orgs, github_repos, drive_folders,
// drives, member_folders, looked for in that order) is refused naming that field
// (removedField). A document an earlier relay stored or returned holds them too: a reader keeps
// its topic and drops the rest (readBoundaries).

import type { Boundaries } from './boundaries-types.js';

export const TOPIC_MAX = 500;
/** A version is a change count: a whole number 0..2^31-1. */
export const BOUNDARIES_VERSION_MAX = 2 ** 31 - 1;
/** The fields of a boundaries document. */
export const BOUNDARIES_FIELDS = ['topic'] as const;
/** The fields of the earlier schemas (M10, v2), in the order a refusal looks for them. */
export const REMOVED_BOUNDARIES_FIELDS = ['github_orgs', 'github_repos', 'drive_folders', 'drives', 'member_folders'] as const;
/** The relay's refusal of a removed field, word for word. */
export const removedFieldDetail = (field: string) => `boundaries.${field}: no longer part of a team's boundaries (only the topic is, since 13 Nov 2026)`;

/**
 * The topic goes into every answerer's prompt: no control characters but newline and tab, and
 * nothing invisible (format characters such as bidi overrides and zero-width marks, lone
 * surrogates, private-use, line and paragraph separators) that could hide text. Unassigned code
 * points are not refused (each side's Unicode tables differ in age).
 */
const TOPIC_FORBIDDEN_RE = /[\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/u;
/** The white space the relay trims from a topic (Python's str.strip()). */
const EDGE_SPACE_RE =
  /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** Length in code points, as the relay (Python) counts. */
export const chars = (s: string) => [...s].length;
/** Surrounding white space dropped, as the relay drops it from a topic. */
export const trimText = (s: string) => s.replace(EDGE_SPACE_RE, '');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A topic as sent: 1-500 characters once trimmed; refused characters are looked for before trimming. */
export function topicOk(topic: unknown): topic is string {
  if (typeof topic !== 'string') return false;
  const t = trimText(topic);
  return chars(t) >= 1 && chars(t) <= TOPIC_MAX && !TOPIC_FORBIDDEN_RE.test(topic);
}

/** A version: a whole number 0..2^31-1, never a boolean or a string. */
export const versionOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= BOUNDARIES_VERSION_MAX;

/** A member's folder count: a whole number 0..20, never a boolean, a float or a string. */
export const folderCountOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 20;

/** The first field of the earlier schemas a boundaries object holds (the relay's order), or null. */
export function removedField(raw: unknown): (typeof REMOVED_BOUNDARIES_FIELDS)[number] | null {
  if (!isObj(raw)) return null;
  return REMOVED_BOUNDARIES_FIELDS.find((f) => has(raw, f)) ?? null;
}

/** Whether a boundaries document, exactly as given, passes the rule: a PUT body's `boundaries`. */
export function boundariesValid(raw: unknown): raw is Boundaries {
  return isObj(raw) && Object.keys(raw).length === 1 && has(raw, 'topic') && topicOk(raw.topic);
}

/**
 * A boundaries document to act on, from the relay: exactly {topic} passing the rule, or one an
 * earlier relay returned (its topic passing the rule, every other field one of the earlier
 * schemas'), read as its topic alone. Null for anything else. The topic is returned as given.
 */
export function readBoundaries(raw: unknown): Boundaries | null {
  if (!isObj(raw) || !has(raw, 'topic') || !topicOk(raw.topic)) return null;
  const removed = REMOVED_BOUNDARIES_FIELDS as readonly string[];
  if (!Object.keys(raw).every((k) => k === 'topic' || removed.includes(k))) return null;
  return { topic: raw.topic };
}

/** What the relay stores of a valid document: the topic trimmed. */
export function normaliseBoundaries(b: Boundaries): Boundaries {
  return { topic: trimText(b.topic) };
}
