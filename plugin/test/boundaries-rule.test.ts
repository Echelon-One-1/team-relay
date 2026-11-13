// Schema v3 (13 Nov 2026: a team's boundaries are its topic alone): the plugin's own checks of a
// boundaries document (boundaries-rule.ts) accept exactly what schema/boundaries-vectors.json
// says, section by section: a PUT body (the console server's checkSetBoundaries), what the relay
// hands the host (validBoundaries, readBoundaries), a document an earlier relay stored, versions
// and the status's folder_count. The relay is the authority.

import { describe, expect, it } from 'vitest';
import {
  BOUNDARIES_FIELDS,
  REMOVED_BOUNDARIES_FIELDS,
  boundariesValid,
  folderCountOk,
  normaliseBoundaries,
  readBoundaries,
  removedField,
  removedFieldDetail,
  versionOk,
} from '../src/boundaries-rule.js';
import type { Boundaries } from '../src/boundaries-types.js';
import { validBoundaries } from '../src/boundary-set.js';
import { BodyError, checkSetBoundaries } from '../src/console-app.js';
import { PLACEHOLDERS, RAW_VECTORS, VECTORS } from './helpers/vectors.js';

const asB = (d: Record<string, unknown>) => d as unknown as Boundaries;
/** The console server's refusal of a PUT body, as its detail (null: accepted). */
const putRefusal = (boundaries: unknown, version: unknown = 1): string | null => {
  try {
    checkSetBoundaries({ version, boundaries });
    return null;
  } catch (err) {
    if (err instanceof BodyError) return err.message;
    throw err;
  }
};

describe('the plugin follows schema/boundaries-vectors.json (schema v3)', () => {
  it('has every section, and knows and expands every placeholder', () => {
    for (const k of ['comment', 'valid', 'invalid', 'removed', 'normalised', 'stored', 'versions', 'folder_counts', 'placeholders']) {
      expect(Object.prototype.hasOwnProperty.call(RAW_VECTORS, k), k).toBe(true);
    }
    expect(Object.keys(RAW_VECTORS).sort()).toEqual(['comment', 'folder_counts', 'invalid', 'normalised', 'placeholders', 'removed', 'stored', 'valid', 'versions']);
    expect(Object.keys(VECTORS.placeholders).sort()).toEqual(Object.keys(PLACEHOLDERS).sort());
    const { placeholders: _p, comment: _c, ...cases } = VECTORS;
    expect(JSON.stringify(cases)).not.toMatch(new RegExp(`"(${Object.keys(PLACEHOLDERS).join('|')})"`));
    expect(JSON.stringify(RAW_VECTORS.valid)).toMatch(/"TOPIC_500"/);
    expect(PLACEHOLDERS.TOPIC_500!.length).toBe(500);
  });

  it('every invalid case names the boundaries field at fault (null: the body itself)', () => {
    for (const v of VECTORS.invalid) expect(v.field === null || (BOUNDARIES_FIELDS as readonly string[]).includes(v.field), v.why).toBe(true);
    expect(VECTORS.invalid.some((v) => v.field === 'topic')).toBe(true);
  });

  it.each(VECTORS.valid.map((b, i) => [i, b] as const))('valid: accepts document %i (as a PUT body, from the relay, at every valid version)', (_i, b) => {
    expect(boundariesValid(b)).toBe(true);
    expect(readBoundaries(b)).toEqual(b);
    expect(putRefusal(b)).toBeNull();
    for (const version of VECTORS.versions.valid) {
      const tb = { team: 'demo', version, boundaries: { ...b }, updated_at: null, updated_by: null };
      expect(validBoundaries(tb)).toBe(true);
      expect(tb.boundaries).toEqual(b);
    }
  });

  it.each(VECTORS.invalid.map((v) => [v.why, v] as const))('invalid: refuses %s', (_why, v) => {
    expect(boundariesValid(v.boundaries)).toBe(false);
    expect(readBoundaries(v.boundaries)).toBeNull();
    expect(validBoundaries({ team: 'demo', version: 1, boundaries: v.boundaries, updated_at: null, updated_by: null })).toBe(false);
    const detail = putRefusal(v.boundaries);
    expect(detail).not.toBeNull();
    if (v.field === 'topic') expect(detail).toMatch(/^topic /);
    else expect(detail).toMatch(/^unknown field /);
  });

  it.each(VECTORS.removed.map((v, i) => [`${i} (${v.field})`, v] as const))('removed: a PUT body holding a field of the earlier schemas is refused naming it: %s', (_n, v) => {
    expect(boundariesValid(v.boundaries)).toBe(false);
    expect(removedField(v.boundaries)).toBe(v.field);
    expect(putRefusal(v.boundaries)).toBe(removedFieldDetail(v.field));
    expect(putRefusal(v.boundaries)).toBe(`boundaries.${v.field}: no longer part of a team's boundaries (only the topic is, since 13 Nov 2026)`);
  });

  it('removed: the fields are looked for in the relay\'s order', () => {
    expect(REMOVED_BOUNDARIES_FIELDS).toEqual(['github_orgs', 'github_repos', 'drive_folders', 'drives', 'member_folders']);
    expect(removedField({ topic: 't', member_folders: true, drives: [] })).toBe('drives');
    expect(removedField({ topic: 't' })).toBeNull();
    expect(removedField(null)).toBeNull();
  });

  it.each(VECTORS.normalised.map((v) => [v.why, v] as const))('normalised: %s', (_why, v) => {
    expect(boundariesValid(v.boundaries)).toBe(true);
    expect(boundariesValid(v.expect)).toBe(true);
    const n = normaliseBoundaries(asB(v.boundaries));
    expect(n).toEqual(v.expect);
    expect(normaliseBoundaries(n)).toEqual(n);
    expect(checkSetBoundaries({ version: 3, boundaries: v.boundaries })).toEqual({ version: 3, boundaries: v.expect });
  });

  it.each(VECTORS.stored.map((v) => [v.why, v] as const))('stored: %s is read as its topic alone', (_why, v) => {
    expect(boundariesValid(v.stored)).toBe(false);
    expect(readBoundaries(v.stored)).toEqual(v.expect);
    // What the relay hands the host: reduced in place to {topic}, an old `since` dropped.
    const tb: Record<string, unknown> = { team: 'demo', version: 4, boundaries: structuredClone(v.stored), since: { github_orgs: {} }, updated_at: null, updated_by: null };
    expect(validBoundaries(tb)).toBe(true);
    expect(tb.boundaries).toEqual(v.expect);
    expect('since' in tb).toBe(false);
  });

  it('stored: only fields of the earlier schemas are dropped; anything else is still refused', () => {
    const stored = VECTORS.stored[0]!.stored;
    expect(readBoundaries({ ...stored, extra: 1 })).toBeNull();
    expect(readBoundaries({ ...stored, topic: '' })).toBeNull();
    expect(readBoundaries({ github_orgs: [] })).toBeNull();
    expect(readBoundaries(null)).toBeNull();
    expect(readBoundaries([stored])).toBeNull();
  });

  it.each(VECTORS.versions.valid.map((v) => [JSON.stringify(v), v] as const))('versions: accepts %s', (_s, v) => {
    expect(versionOk(v)).toBe(true);
    expect(putRefusal(VECTORS.valid[0], v)).toBeNull();
  });

  it.each(VECTORS.versions.invalid.map((v) => [JSON.stringify(v), v] as const))('versions: refuses %s', (_s, v) => {
    expect(versionOk(v)).toBe(false);
    expect(putRefusal(VECTORS.valid[0], v)).toMatch(/^version /);
    expect(validBoundaries({ team: 'demo', version: v, boundaries: VECTORS.valid[0], updated_at: null, updated_by: null })).toBe(false);
    expect(validBoundaries({ team: 'demo', version: v, boundaries: null, updated_at: null, updated_by: null })).toBe(false);
  });

  it('never set (version 0, no boundaries) is a boundaries document', () => {
    expect(validBoundaries({ team: 'demo', version: 0, boundaries: null, updated_at: null, updated_by: null })).toBe(true);
  });

  it.each(VECTORS.folder_counts.valid.map((v) => [JSON.stringify(v), v] as const))('folder_counts: accepts %s', (_s, v) => {
    expect(folderCountOk(v)).toBe(true);
  });

  it.each(VECTORS.folder_counts.invalid.map((v) => [JSON.stringify(v), v] as const))('folder_counts: refuses %s', (_s, v) => {
    expect(folderCountOk(v)).toBe(false);
  });
});
