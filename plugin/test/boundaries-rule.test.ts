// M10-SPEC §7.5 and PICKERS-SPEC §2: the plugin's own checks of a boundaries document
// (boundaries-rule.ts) accept exactly what schema/boundaries-vectors.json says: a PUT body (the
// console server), what the relay hands the host (validBoundaries, readBoundaries) and what a
// member accepted (parseAccepted). Keys, `since` and the status group follow the same file. The
// relay is the authority.

import { describe, expect, it } from 'vitest';
import {
  BOUNDARIES_FIELDS,
  ITEM_KEY_MAX,
  boundariesValid,
  boundaryItems,
  domainOk,
  driveNameOk,
  folderOk,
  itemKey,
  itemKeys,
  knownItemKeys,
  legacyDrivesOk,
  nextSince,
  normaliseBoundaries,
  readBoundaries,
  repoOk,
  sinceByKey,
  sourcesOk,
  versionOk,
  type SinceSource,
} from '../src/boundaries-rule.js';
import type { Boundaries, BoundariesSince, BoundaryItem, DriveBoundary } from '../src/boundaries-types.js';
import { validBoundaries } from '../src/boundary-set.js';
import { MemberFoldersError, parseAccepted } from '../src/member-folders.js';
import { PLACEHOLDERS, RAW_VECTORS, VECTORS } from './helpers/vectors.js';

const pick = (b: Record<string, unknown>) => ({ version: 1, github_orgs: b.github_orgs, drives: b.drives, member_folders: b.member_folders });
// What a member accepted holds the M10 fields; the cases about other fields say nothing about it.
const ACCEPTED_FIELDS = ['github_orgs', 'drives', 'member_folders'];
const aboutAccepted = (field: string | null) => field !== null && ACCEPTED_FIELDS.includes(field);
const asB = (d: Record<string, unknown>) => d as unknown as Boundaries;

describe('the plugin follows schema/boundaries-vectors.json (M10-SPEC §7.5, PICKERS-SPEC §2.1)', () => {
  it('knows every placeholder the file names, and expands every one', () => {
    expect(Object.keys(VECTORS.placeholders).sort()).toEqual(Object.keys(PLACEHOLDERS).sort());
    const { placeholders: _p, comment: _c, ...cases } = VECTORS as typeof VECTORS & { comment: string };
    expect(JSON.stringify(cases)).not.toMatch(new RegExp(`"(${Object.keys(PLACEHOLDERS).join('|')})"`));
    expect(JSON.stringify(RAW_VECTORS)).toMatch(/"FOLDER_NAME_255"/);
    expect(PLACEHOLDERS.DOMAIN_253!.length).toBe(253);
    expect(PLACEHOLDERS.DOMAIN_254!.length).toBe(254);
  });

  it('every invalid case names the boundaries field at fault (null: the body itself)', () => {
    for (const v of VECTORS.invalid) expect(v.field === null || (BOUNDARIES_FIELDS as readonly string[]).includes(v.field), v.why).toBe(true);
    for (const f of BOUNDARIES_FIELDS) expect(VECTORS.invalid.some((v) => v.field === f), f).toBe(true);
  });

  it.each(VECTORS.valid.map((b, i) => [i, b] as const))('accepts valid document %i (every valid version too)', (_i, b) => {
    expect(boundariesValid(b)).toBe(true);
    expect(readBoundaries(b)).toBe(b);
    for (const r of b.github_repos as unknown[]) expect(repoOk(r)).toBe(true);
    for (const f of b.drive_folders as unknown[]) expect(folderOk(f)).toBe(true);
    for (const version of VECTORS.versions.valid) expect(validBoundaries({ team: 'demo', version, boundaries: b, updated_at: null, updated_by: null })).toBe(true);
  });

  it.each(VECTORS.invalid.map((v) => [v.why, v.boundaries] as const))('refuses: %s', (_why, b) => {
    expect(boundariesValid(b)).toBe(false);
    expect(readBoundaries(b)).toBeNull();
    expect(validBoundaries({ team: 'demo', version: 1, boundaries: b, updated_at: null, updated_by: null })).toBe(false);
  });

  it.each(VECTORS.versions.invalid.map((v) => [JSON.stringify(v), v] as const))('refuses version %s', (_s, v) => {
    expect(versionOk(v)).toBe(false);
    expect(validBoundaries({ team: 'demo', version: v, boundaries: VECTORS.valid[0], updated_at: null, updated_by: null })).toBe(false);
    expect(validBoundaries({ team: 'demo', version: v, boundaries: null, updated_at: null, updated_by: null })).toBe(false);
  });

  it('never set (version 0, no boundaries) is a boundaries document', () => {
    expect(validBoundaries({ team: 'demo', version: 0, boundaries: null, updated_at: null, updated_by: null })).toBe(true);
  });

  it.each(VECTORS.valid.map((b, i) => [i, b] as const))('parseAccepted accepts the orgs, drives and member folders of valid document %i', (_i, b) => {
    const a = parseAccepted(pick(b));
    for (const d of b.drives as DriveBoundary[]) {
      expect(domainOk(d.domain) && driveNameOk(d.shared_drive)).toBe(true);
      expect(a.drives).toContainEqual(d);
    }
  });

  it.each(VECTORS.invalid.filter((v) => aboutAccepted(v.field)).map((v) => [v.why, v.boundaries] as const))('parseAccepted refuses: %s', (_why, b) => {
    expect(() => parseAccepted(pick(b))).toThrow(MemberFoldersError);
  });

  it('the cases left out of parseAccepted are about a field it does not hold', () => {
    for (const v of VECTORS.invalid.filter((x) => !aboutAccepted(x.field))) expect(() => parseAccepted(pick(v.boundaries)), v.why).not.toThrow();
  });
});

describe('documents the M10 code wrote (PICKERS-SPEC §2.3, §2.5)', () => {
  it.each(VECTORS.m10_documents.map((b, i) => [i, b] as const))('M10 document %i is no PUT body, and is read with the picked lists empty', (_i, b) => {
    expect(boundariesValid(b)).toBe(false);
    expect(readBoundaries(b)).toEqual({ ...b, github_repos: [], drive_folders: [] });
  });

  it('only exactly the M10 fields read as an M10 document', () => {
    const m10 = VECTORS.m10_documents[0]!;
    expect(readBoundaries({ ...m10, github_repos: [] })).toBeNull();
    expect(readBoundaries({ ...m10, drive_folders: [] })).toBeNull();
    expect(readBoundaries({ ...m10, extra: 1 })).toBeNull();
    expect(readBoundaries({ ...m10, topic: '' })).toBeNull();
    expect(readBoundaries({ ...m10, drives: [{ domain: 'example.com', shared_drive: 'a/b' }] })).toBeNull();
    expect(readBoundaries(null)).toBeNull();
    expect(readBoundaries([m10])).toBeNull();
  });
});

describe('what the relay stores of a valid body (PICKERS-SPEC §2.1)', () => {
  it.each(VECTORS.normalised.map((v) => [v.why, v] as const))('%s', (_why, v) => {
    expect(boundariesValid(v.boundaries)).toBe(true);
    expect(boundariesValid(v.expect)).toBe(true);
    const n = normaliseBoundaries(asB(v.boundaries));
    expect(n).toEqual(v.expect);
    expect(normaliseBoundaries(n)).toEqual(n);
  });

  it('copies entries rather than sharing them with the document sent', () => {
    const b = asB(VECTORS.valid[0]!);
    const n = normaliseBoundaries(b);
    expect(n.drive_folders[0]).not.toBe(b.drive_folders[0]);
    expect(n.github_repos[0]).not.toBe(b.github_repos[0]);
  });
});

describe('legacy drives can be kept, never added (PICKERS-SPEC §2.1)', () => {
  it.each(VECTORS.legacy_drives.map((v) => [v.why, v] as const))('%s', (_why, v) => {
    expect(legacyDrivesOk(v.stored, v.sent)).toBe(v.ok);
  });
});

describe('item keys (PICKERS-SPEC §2.2)', () => {
  it.each(VECTORS.keys.map((v) => [v.key, v] as const))('%s', (_key, v) => {
    expect(itemKey({ kind: v.kind, ...v.item } as BoundaryItem)).toBe(v.key);
  });

  it.each(VECTORS.item_keys.map((v, i) => [i, v] as const))('the keys of document %i, in order', (_i, v) => {
    expect(boundariesValid(v.boundaries)).toBe(true);
    expect(itemKeys(asB(v.boundaries))).toEqual(v.keys);
    expect(boundaryItems(asB(v.boundaries)).map(itemKey)).toEqual(v.keys);
  });

  it('no key of a valid document is longer than 400 characters (the longest is a legacy drive, 360)', () => {
    const longest = itemKey({ kind: 'drive', domain: PLACEHOLDERS.DOMAIN_253!, shared_drive: PLACEHOLDERS.DRIVE_100! });
    expect([...longest].length).toBe(360);
    expect(itemKey({ kind: 'folder', domain: 'example.com', drive_id: null, folder_id: PLACEHOLDERS.ID_200!, folder_name: 'F', drive_name: null }).length).toBe(207);
    expect(itemKey({ kind: 'repo', org: 'a'.repeat(39), repo: PLACEHOLDERS.REPO_100!, id: null }).length).toBe(145);
    for (const b of VECTORS.valid) for (const k of itemKeys(asB(b))) expect([...k].length).toBeLessThanOrEqual(ITEM_KEY_MAX);
  });
});

describe('since: in which version each item was last added (M10-SPEC §7.1, PICKERS-SPEC §2.3)', () => {
  const { start, steps } = VECTORS.since;

  it('the start is a document the M10 code wrote', () => {
    expect(boundariesValid(start.boundaries)).toBe(false);
    expect(readBoundaries(start.boundaries)).not.toBeNull();
  });

  it('every step is a valid body that keeps only legacy drives already stored', () => {
    let stored = readBoundaries(start.boundaries)!;
    for (const s of steps) {
      expect(boundariesValid(s.boundaries), s.why).toBe(true);
      expect(legacyDrivesOk(stored.drives, asB(s.boundaries).drives), s.why).toBe(true);
      stored = normaliseBoundaries(asB(s.boundaries));
    }
  });

  it('rules 1-4, step by step from the M10 document', () => {
    let prev: SinceSource = { version: start.version, boundaries: start.boundaries as unknown as Boundaries, since: start.since as unknown as BoundariesSince };
    steps.forEach((s, i) => {
      const version = start.version + i + 1;
      const since = nextSince(prev, version, asB(s.boundaries));
      expect(since, `version ${version}: ${s.why}`).toEqual(s.since);
      // Every item of the document as stored has a since, and nothing else does.
      const stored = normaliseBoundaries(asB(s.boundaries));
      expect([...sinceByKey(stored, since, version).keys()]).toEqual(itemKeys(stored));
      expect(Object.keys(since.github_repos).length + Object.keys(since.drive_folders).length + Object.keys(since.github_orgs).length + since.drives.length).toBe(itemKeys(stored).length);
      prev = { version, boundaries: stored, since };
    });
  });

  it('an item keeps its version while it stays; dropped and added back, it gets the version that added it back (M10 steps)', () => {
    const team = { domain: 'example.com', shared_drive: 'Example Team Drive' };
    const other = { domain: 'example.com', shared_drive: 'Other Drive' };
    const base: Boundaries = { topic: 'T', github_orgs: ['Example-Org'], github_repos: [], drive_folders: [], drives: [team], member_folders: false };
    const S = (o: Pick<BoundariesSince, 'github_orgs' | 'drives' | 'member_folders'>): BoundariesSince => ({ github_repos: {}, drive_folders: {}, ...o });
    // The same steps as the relay's test (relay/tests/test_boundaries.py).
    const m10Steps: Array<[Boundaries, BoundariesSince]> = [
      [base, S({ github_orgs: { 'example-org': 1 }, drives: [{ ...team, since: 1 }], member_folders: null })],
      [{ ...base, topic: 'Changed', github_orgs: ['example-org', 'acme'] }, S({ github_orgs: { 'example-org': 1, acme: 2 }, drives: [{ ...team, since: 1 }], member_folders: null })],
      [{ ...base, github_orgs: ['acme'], drives: [], member_folders: true }, S({ github_orgs: { acme: 2 }, drives: [], member_folders: 3 })],
      [{ ...base, github_orgs: ['ACME', 'Example-Org'], drives: [other, team], member_folders: true }, S({ github_orgs: { acme: 2, 'example-org': 4 }, drives: [{ ...other, since: 4 }, { ...team, since: 4 }], member_folders: 3 })],
      [{ ...base, github_orgs: ['acme', 'Example-Org'], member_folders: false }, S({ github_orgs: { acme: 2, 'example-org': 4 }, drives: [{ ...team, since: 4 }], member_folders: null })],
      [{ ...base, github_orgs: ['acme', 'Example-Org'], drives: [other, team], member_folders: true }, S({ github_orgs: { acme: 2, 'example-org': 4 }, drives: [{ ...other, since: 6 }, { ...team, since: 4 }], member_folders: 6 })],
    ];
    let prev: SinceSource | null = null;
    m10Steps.forEach(([b, want], i) => {
      const since = nextSince(prev, i + 1, b);
      expect(since, `version ${i + 1}`).toEqual(want);
      prev = { version: i + 1, boundaries: b, since };
    });
  });

  it('an item the replaced document holds but its since does not name counts as added in that version', () => {
    const b: Boundaries = { topic: 'T', github_orgs: ['example-org'], github_repos: [{ org: 'other-org', repo: 'api', id: 1 }], drive_folders: [], drives: [], member_folders: true };
    expect(nextSince({ version: 4, boundaries: b, since: null }, 5, b)).toEqual({
      github_orgs: { 'example-org': 4 },
      github_repos: { 'other-org/api': 4 },
      drive_folders: {},
      drives: [],
      member_folders: 4,
    });
    // Without the replaced version (an older caller), such an item counts as new.
    expect(nextSince({ boundaries: b, since: null }, 5, b).github_orgs).toEqual({ 'example-org': 5 });
    // Nothing replaced: everything is new.
    expect(nextSince(null, 1, b)).toEqual({ github_orgs: { 'example-org': 1 }, github_repos: { 'other-org/api': 1 }, drive_folders: {}, drives: [], member_folders: 1 });
    expect(nextSince({ version: 0, boundaries: null, since: null }, 1, b).github_orgs).toEqual({ 'example-org': 1 });
  });

  it('a key named like an Object.prototype member is looked up as an own entry only', () => {
    const b: Boundaries = { topic: 'T', github_orgs: ['constructor'], github_repos: [{ org: 'example-org', repo: '__proto__', id: 1 }], drive_folders: [], drives: [], member_folders: false };
    const since = nextSince({ version: 2, boundaries: { ...b, github_orgs: [], github_repos: [] }, since: { github_orgs: {}, github_repos: {}, drive_folders: {}, drives: [], member_folders: null } }, 3, b);
    expect(since.github_orgs).toEqual({ constructor: 3 });
    expect(Object.prototype.hasOwnProperty.call(since.github_repos, 'example-org/__proto__')).toBe(true);
    expect(since.github_repos['example-org/__proto__']).toBe(3);
  });
});

describe('the status group sources (PICKERS-SPEC §3.3)', () => {
  it.each(VECTORS.sources.valid.map((s, i) => [i, s] as const))('accepts valid sources %i', (_i, s) => {
    expect(sourcesOk(s)).toBe(true);
  });

  it.each(VECTORS.sources.invalid.map((v) => [v.why, v.sources] as const))('refuses: %s', (_why, s) => {
    expect(sourcesOk(s)).toBe(false);
  });

  it.each(VECTORS.sources.kept.map((v) => [v.why, v] as const))('%s', (_why, v) => {
    expect(boundariesValid(v.boundaries)).toBe(true);
    expect(sourcesOk({ boundaries_version: 1, missing: v.missing })).toBe(true);
    expect(knownItemKeys(asB(v.boundaries), v.missing)).toEqual(v.kept);
  });
});
