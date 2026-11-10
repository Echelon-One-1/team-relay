// M10-SPEC §7.5: the plugin's own checks of a boundaries document (boundaries-rule.ts) accept
// exactly what schema/boundaries-vectors.json says: what the relay hands the host
// (validBoundaries) and what a member accepted (parseAccepted). The relay is the authority.

import { describe, expect, it } from 'vitest';
import { boundariesValid, domainOk, driveNameOk, nextSince, versionOk } from '../src/boundaries-rule.js';
import type { Boundaries, BoundariesSince } from '../src/boundaries-types.js';
import { validBoundaries } from '../src/boundary-set.js';
import { MemberFoldersError, parseAccepted } from '../src/member-folders.js';
import { PLACEHOLDERS, VECTORS } from './helpers/vectors.js';

const pick = (b: Record<string, unknown>) => ({ version: 1, github_orgs: b.github_orgs, drives: b.drives, member_folders: b.member_folders });
// The cases about the topic, or about a field outside the accepted set, say nothing about it.
const aboutAccepted = (why: string) => !/topic/.test(why) && why !== 'extra field';

describe('the plugin follows schema/boundaries-vectors.json (M10-SPEC §7.5)', () => {
  it('knows every placeholder the file names', () => {
    expect(Object.keys(VECTORS.placeholders).sort()).toEqual(Object.keys(PLACEHOLDERS).sort());
  });

  it.each(VECTORS.valid.map((b, i) => [i, b] as const))('validBoundaries accepts valid document %i (every valid version too)', (_i, b) => {
    expect(boundariesValid(b)).toBe(true);
    for (const version of VECTORS.versions.valid) expect(validBoundaries({ team: 'demo', version, boundaries: b, updated_at: null, updated_by: null })).toBe(true);
  });

  it.each(VECTORS.invalid.map((v) => [v.why, v.boundaries] as const))('validBoundaries refuses: %s', (_why, b) => {
    expect(boundariesValid(b)).toBe(false);
    expect(validBoundaries({ team: 'demo', version: 1, boundaries: b, updated_at: null, updated_by: null })).toBe(false);
  });

  it.each(VECTORS.versions.invalid.map((v) => [JSON.stringify(v), v] as const))('validBoundaries refuses version %s', (_s, v) => {
    expect(versionOk(v)).toBe(false);
    expect(validBoundaries({ team: 'demo', version: v, boundaries: VECTORS.valid[0], updated_at: null, updated_by: null })).toBe(false);
    expect(validBoundaries({ team: 'demo', version: v, boundaries: null, updated_at: null, updated_by: null })).toBe(false);
  });

  it('never set (version 0, no boundaries) is a boundaries document', () => {
    expect(validBoundaries({ team: 'demo', version: 0, boundaries: null, updated_at: null, updated_by: null })).toBe(true);
  });

  it.each(VECTORS.valid.map((b, i) => [i, b] as const))('parseAccepted accepts the orgs, drives and member folders of valid document %i', (_i, b) => {
    const a = parseAccepted(pick(b));
    for (const d of b.drives as Array<{ domain: string; shared_drive: string }>) {
      expect(domainOk(d.domain) && driveNameOk(d.shared_drive)).toBe(true);
      expect(a.drives).toContainEqual(d);
    }
  });

  it.each(VECTORS.invalid.filter((v) => aboutAccepted(v.why)).map((v) => [v.why, v.boundaries] as const))('parseAccepted refuses: %s', (_why, b) => {
    expect(() => parseAccepted(pick(b))).toThrow(MemberFoldersError);
  });

  it('the cases left out of parseAccepted are about the topic or a field it does not hold', () => {
    const left = VECTORS.invalid.filter((v) => !aboutAccepted(v.why));
    for (const v of left) expect(() => parseAccepted(pick(v.boundaries))).not.toThrow();
  });
});

describe('since: in which version each item was last added (M10-SPEC §7.1)', () => {
  it('an item keeps its version while it stays; dropped and added back, it gets the version that added it back', () => {
    const team = { domain: 'example.com', shared_drive: 'Example Team Drive' };
    const other = { domain: 'example.com', shared_drive: 'Other Drive' };
    const base: Boundaries = { topic: 'T', github_orgs: ['Example-Org'], drives: [team], member_folders: false };
    // The same steps as the relay's test (relay/tests/test_boundaries.py).
    const steps: Array<[Boundaries, BoundariesSince]> = [
      [base, { github_orgs: { 'example-org': 1 }, drives: [{ ...team, since: 1 }], member_folders: null }],
      [{ ...base, topic: 'Changed', github_orgs: ['example-org', 'acme'] }, { github_orgs: { 'example-org': 1, acme: 2 }, drives: [{ ...team, since: 1 }], member_folders: null }],
      [{ ...base, github_orgs: ['acme'], drives: [], member_folders: true }, { github_orgs: { acme: 2 }, drives: [], member_folders: 3 }],
      [{ ...base, github_orgs: ['ACME', 'Example-Org'], drives: [other, team], member_folders: true }, { github_orgs: { acme: 2, 'example-org': 4 }, drives: [{ ...other, since: 4 }, { ...team, since: 4 }], member_folders: 3 }],
      [{ ...base, github_orgs: ['acme', 'Example-Org'], member_folders: false }, { github_orgs: { acme: 2, 'example-org': 4 }, drives: [{ ...team, since: 4 }], member_folders: null }],
      [{ ...base, github_orgs: ['acme', 'Example-Org'], drives: [other, team], member_folders: true }, { github_orgs: { acme: 2, 'example-org': 4 }, drives: [{ ...other, since: 6 }, { ...team, since: 4 }], member_folders: 6 }],
    ];
    let prev: { boundaries: Boundaries; since: BoundariesSince } | null = null;
    steps.forEach(([b, want], i) => {
      const since = nextSince(prev, i + 1, b);
      expect(since, `version ${i + 1}`).toEqual(want);
      expect(validBoundaries({ team: 'demo', version: i + 1, boundaries: b, since, updated_at: null, updated_by: null })).toBe(true);
      prev = { boundaries: b, since };
    });
  });
});
