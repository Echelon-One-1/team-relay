// M10-SPEC §7.5: the one validation rule for a team's boundaries, as this plugin applies it: to
// the console server's PUT body (console-app.ts checkSetBoundaries), to the boundaries the relay
// hands the host (boundary-set.ts validBoundaries) and to what a member accepted
// (member-folders.ts parseAccepted). The relay is the authority; schema/boundaries-vectors.json
// holds the cases every implementation's tests load.
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
//   lists        at most 10 orgs and 10 drives, counted as sent (before duplicates are dropped)
//   fields       exactly topic, github_orgs, drives, member_folders (a bool); a drive exactly
//                domain and shared_drive

import type { Boundaries, BoundariesSince } from './boundaries-types.js';

export const TOPIC_MAX = 500;
export const SHARED_DRIVE_MAX = 100;
export const DOMAIN_MAX = 253;
export const BOUNDARIES_MAX_ORGS = 10;
export const BOUNDARIES_MAX_DRIVES = 10;
/** A version is a change count: a whole number 0..2^31-1. */
export const BOUNDARIES_VERSION_MAX = 2 ** 31 - 1;
/** A GitHub organisation name: letters, digits and -, not starting with -. */
export const GITHUB_ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** A lower-case DNS name with at least two labels, no trailing dot (length and last label checked apart). */
export const DRIVE_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/**
 * The topic goes into every answerer's prompt: no control characters but newline and tab, and
 * nothing invisible (format characters such as bidi overrides and zero-width marks, lone
 * surrogates, private-use, unassigned, line and paragraph separators) that could hide text.
 */
const TOPIC_FORBIDDEN_RE = /[\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/u;
/** A shared drive's name is a folder on disk: no `/`, no control or invisible characters. */
const DRIVE_NAME_FORBIDDEN_RE = /[/\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
/** The white space the relay trims from a topic (Python's str.strip()), and no drive name may start or end with. */
const EDGE_SPACE_RE =
  /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** Length in code points, as the relay (Python) counts. */
export const chars = (s: string) => [...s].length;
/** Surrounding white space dropped, as the relay drops it from a topic. */
export const trimText = (s: string) => s.replace(EDGE_SPACE_RE, '');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));

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

/** A shared drive's name as sent: 1-100 characters, no /, no control or invisible characters, no surrounding space, not . or .. */
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

/** Whether a boundaries document, exactly as given, passes the rule. */
export function boundariesValid(raw: unknown): raw is Boundaries {
  if (!isObj(raw) || !exactKeys(raw, ['topic', 'github_orgs', 'drives', 'member_folders'])) return false;
  if (!topicOk(raw.topic)) return false;
  const { github_orgs: orgs, drives } = raw;
  if (!Array.isArray(orgs) || orgs.length > BOUNDARIES_MAX_ORGS || !orgs.every(orgOk)) return false;
  if (!Array.isArray(drives) || drives.length > BOUNDARIES_MAX_DRIVES) return false;
  for (const d of drives as unknown[]) {
    if (!isObj(d) || !exactKeys(d, ['domain', 'shared_drive']) || !domainOk(d.domain) || !driveNameOk(d.shared_drive)) return false;
  }
  return typeof raw.member_folders === 'boolean';
}

/**
 * M10-SPEC §7.1: the relay's `since` for boundaries `next` stored as `version`, given the
 * document it replaces (`prev`, null: none): an item `prev` holds keeps its version (orgs
 * compared without case, drives on domain and name); one added, or added back after a removal,
 * gets `version`; member folders likewise while allowed (null while not). The relay computes it
 * (relay/boundaries.py carried_since); the console's demo relay plays it with this.
 */
export function nextSince(prev: { boundaries: Boundaries | null; since?: BoundariesSince | null } | null, version: number, next: Boundaries): BoundariesSince {
  const p = prev?.boundaries ? (prev.since ?? null) : null;
  const org = (o: string) => {
    const key = o.toLowerCase();
    return p && Object.prototype.hasOwnProperty.call(p.github_orgs, key) ? (p.github_orgs[key] ?? version) : version;
  };
  return {
    github_orgs: Object.fromEntries(next.github_orgs.map((o) => [o.toLowerCase(), org(o)])),
    drives: next.drives.map((d) => ({
      domain: d.domain,
      shared_drive: d.shared_drive,
      since: p?.drives.find((x) => x.domain === d.domain && x.shared_drive === d.shared_drive)?.since ?? version,
    })),
    member_folders: next.member_folders ? (p?.member_folders ?? version) : null,
  };
}
