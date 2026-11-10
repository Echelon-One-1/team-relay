import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ManifestError,
  hasLoneSurrogate,
  loadManifest,
  parseManifest,
  validateManifest,
  validateParams,
  type Capability,
  type Manifest,
} from '../src/manifest.js';
import { PLUGIN_ROOT } from './helpers/mcp.js';

const shipped = () => loadManifest(join(PLUGIN_ROOT, 'manifest.yaml'));

function base(): { version: 1; capabilities: Array<Record<string, unknown>> } {
  return {
    version: 1,
    capabilities: [
      {
        name: 'lookup',
        title: 'Look something up',
        description: 'Synthetic capability.',
        environment: 'staging',
        params: {
          code: { type: 'string', max_length: 8, pattern: '^[a-z]+$', description: 'A code.' },
          count: { type: 'integer', min: 1, max: 10, default: 3, description: 'How many.' },
        },
        required: ['code'],
      },
    ],
  };
}

function problemsOf(doc: unknown): string[] {
  try {
    validateManifest(doc);
  } catch (err) {
    expect(err).toBeInstanceOf(ManifestError);
    return (err as ManifestError).problems;
  }
  throw new Error('expected the manifest to be rejected');
}

function withParam(name: string, param: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const doc = base();
  const cap = doc.capabilities[0]!;
  (cap.params as Record<string, unknown>)[name] = param;
  Object.assign(cap, extra);
  return doc;
}

describe('manifest validation', () => {
  it('accepts the shipped team manifest', () => {
    const m = shipped();
    expect(m.capabilities.map((c) => c.name)).toEqual(['staging_db_query', 'service_health', 'production_db_count']);
  });

  it('accepts the minimal base document', () => {
    expect(() => validateManifest(base())).not.toThrow();
  });

  it('rejects an unanchored pattern', () => {
    expect(problemsOf(withParam('code', { type: 'string', max_length: 8, pattern: '[a-z]+', description: 'x' })).join()).toMatch(/pattern/);
  });

  it('rejects a pattern whose closing $ is escaped (not really anchored)', () => {
    const p = problemsOf(withParam('code', { type: 'string', max_length: 8, pattern: '^[a-z]+\\$', description: 'x' }));
    expect(p.join()).toMatch(/anchored/);
  });

  it('rejects a pattern that does not compile', () => {
    const p = problemsOf(withParam('code', { type: 'string', max_length: 8, pattern: '^[a-$', description: 'x' }));
    expect(p.join()).toMatch(/does not compile/);
  });

  it('rejects a required name that is not a param', () => {
    const doc = base();
    doc.capabilities[0]!.required = ['code', 'missing'];
    expect(problemsOf(doc).join()).toMatch(/required name missing/);
  });

  it('rejects a default that violates its own param', () => {
    expect(problemsOf(withParam('count', { type: 'integer', min: 1, max: 10, default: 50, description: 'x' })).join()).toMatch(/default/);
    expect(
      problemsOf(withParam('kind', { type: 'enum', values: ['a', 'b'], default: 'c', description: 'x' })).join(),
    ).toMatch(/default/);
    expect(
      problemsOf(withParam('word', { type: 'string', max_length: 3, pattern: '^[a-z]*$', default: 'ABC', description: 'x' })).join(),
    ).toMatch(/default/);
    expect(
      problemsOf(withParam('word', { type: 'string', max_length: 2, pattern: '^[a-z]*$', default: 'abc', description: 'x' })).join(),
    ).toMatch(/default/);
  });

  it('rejects min greater than max', () => {
    expect(problemsOf(withParam('count', { type: 'integer', min: 10, max: 1, description: 'x' })).join()).toMatch(/min 10 is greater than max 1/);
    expect(problemsOf(withParam('ratio', { type: 'number', min: 1.5, max: 0.5, description: 'x' })).join()).toMatch(/greater than max/);
  });

  it('rejects duplicate capability names', () => {
    const doc = base();
    doc.capabilities.push({ ...doc.capabilities[0]! });
    expect(problemsOf(doc).join()).toMatch(/duplicate capability name: lookup/);
  });

  it('rejects unknown keys at every level', () => {
    expect(problemsOf({ ...base(), extra: true }).join()).toMatch(/additional/);
    const doc = base();
    doc.capabilities[0]!.sql = 'select 1';
    expect(problemsOf(doc).join()).toMatch(/additional/);
    expect(problemsOf(withParam('code', { type: 'string', max_length: 8, pattern: '^[a-z]+$', description: 'x', raw: true }))).not.toHaveLength(0);
  });

  it('rejects a free-form string param without a pattern', () => {
    expect(problemsOf(withParam('code', { type: 'string', max_length: 8, description: 'x' }))).not.toHaveLength(0);
  });

  it('rejects a string param without max_length and an unknown param type', () => {
    expect(problemsOf(withParam('code', { type: 'string', pattern: '^[a-z]+$', description: 'x' }))).not.toHaveLength(0);
    expect(problemsOf(withParam('where', { type: 'path', description: 'x' }))).not.toHaveLength(0);
  });

  it('rejects a bad version, a bad environment and a bad capability name', () => {
    expect(problemsOf({ ...base(), version: 2 })).not.toHaveLength(0);
    const env = base();
    env.capabilities[0]!.environment = 'dev';
    expect(problemsOf(env)).not.toHaveLength(0);
    const name = base();
    name.capabilities[0]!.name = 'Bad-Name';
    expect(problemsOf(name)).not.toHaveLength(0);
  });

  it('reports YAML syntax errors as manifest errors', () => {
    expect(() => parseManifest('version: 1\ncapabilities: [\n')).toThrow(ManifestError);
  });
});

describe('param validation (§3.5 parity)', () => {
  const cap = (): Capability => shipped().capabilities.find((c) => c.name === 'staging_db_query')!;

  it('fills defaults and keeps given values', () => {
    expect(validateParams(cap(), { dataset: 'users' })).toEqual({ ok: true, params: { dataset: 'users', op: 'eq', limit: 20 } });
    expect(validateParams(cap(), { dataset: 'orders', limit: 5, field: 'status', op: 'ne', value: 'active' })).toEqual({
      ok: true,
      params: { dataset: 'orders', field: 'status', op: 'ne', value: 'active', limit: 5 },
    });
  });

  it('rejects an enum value outside the list', () => {
    expect(validateParams(cap(), { dataset: 'secrets' })).toMatchObject({ ok: false, param: 'dataset' });
    expect(validateParams(cap(), { dataset: 3 })).toMatchObject({ ok: false, param: 'dataset' });
    expect(validateParams(cap(), { dataset: 'users', op: 'like' })).toMatchObject({ ok: false, param: 'op' });
    expect(validateParams(cap(), { dataset: 'users', field: 'password' })).toMatchObject({ ok: false, param: 'field' });
  });

  it('enforces integer bounds and type', () => {
    expect(validateParams(cap(), { dataset: 'users', limit: 500 })).toMatchObject({ ok: false, param: 'limit' });
    expect(validateParams(cap(), { dataset: 'users', limit: 0 })).toMatchObject({ ok: false, param: 'limit' });
    expect(validateParams(cap(), { dataset: 'users', limit: 2.5 })).toMatchObject({ ok: false, param: 'limit' });
    expect(validateParams(cap(), { dataset: 'users', limit: '5' })).toMatchObject({ ok: false, param: 'limit' });
    expect(validateParams(cap(), { dataset: 'users', limit: true })).toMatchObject({ ok: false, param: 'limit' });
    expect(validateParams(cap(), { dataset: 'users', limit: 100 })).toMatchObject({ ok: true });
    expect(validateParams(cap(), { dataset: 'users', limit: 1 })).toMatchObject({ ok: true });
  });

  it('enforces max_length in characters', () => {
    expect(validateParams(cap(), { dataset: 'users', value: 'a'.repeat(100) })).toMatchObject({ ok: true });
    expect(validateParams(cap(), { dataset: 'users', value: 'a'.repeat(101) })).toMatchObject({ ok: false, param: 'value' });
  });

  it('matches the pattern against the whole value', () => {
    expect(validateParams(cap(), { dataset: 'users', value: "a'; drop table users" })).toMatchObject({ ok: false, param: 'value' });
    expect(validateParams(cap(), { dataset: 'users', value: 'active\n' })).toMatchObject({ ok: false, param: 'value' });
    expect(validateParams(cap(), { dataset: 'users', value: 'status = 1' })).toMatchObject({ ok: false, param: 'value' });
    expect(validateParams(cap(), { dataset: 'users', value: 'a.b@c-d_e' })).toMatchObject({ ok: true });
    expect(validateParams(cap(), { dataset: 'users', value: '' })).toMatchObject({ ok: true });
    const m: Manifest = validateManifest({
      version: 1,
      capabilities: [
        {
          name: 'alt',
          title: 't',
          description: 'd',
          environment: 'staging',
          params: { value: { type: 'string', max_length: 10, pattern: '^a$|^b$', description: 'x' } },
        },
      ],
    });
    const alt = m.capabilities[0]!;
    expect(validateParams(alt, { value: 'a' })).toMatchObject({ ok: true });
    expect(validateParams(alt, { value: 'b' })).toMatchObject({ ok: true });
    expect(validateParams(alt, { value: 'ab' })).toMatchObject({ ok: false });
  });

  it('requires required params and names the first failing one', () => {
    expect(validateParams(cap(), {})).toMatchObject({ ok: false, param: 'dataset', detail: expect.stringMatching(/required/) });
    expect(validateParams(cap(), { limit: 500 })).toMatchObject({ ok: false, param: 'dataset' });
  });

  it('rejects unknown keys', () => {
    expect(validateParams(cap(), { dataset: 'users', sql: 'select 1' })).toMatchObject({ ok: false, param: 'sql' });
    expect(validateParams(cap(), { dataset: 'users', __proto__x: 1 })).toMatchObject({ ok: false });
  });

  it('rejects params that are not an object', () => {
    expect(validateParams(cap(), null)).toMatchObject({ ok: false });
    expect(validateParams(cap(), ['users'])).toMatchObject({ ok: false });
    expect(validateParams(cap(), 'dataset=users')).toMatchObject({ ok: false });
  });

  it('validates number and boolean params', () => {
    const m = validateManifest({
      version: 1,
      capabilities: [
        {
          name: 'mixed',
          title: 't',
          description: 'd',
          environment: 'staging',
          params: {
            ratio: { type: 'number', min: 0, max: 1, default: 0.5, description: 'x' },
            flag: { type: 'boolean', default: false, description: 'x' },
          },
        },
      ],
    });
    const c = m.capabilities[0]!;
    expect(validateParams(c, {})).toEqual({ ok: true, params: { ratio: 0.5, flag: false } });
    expect(validateParams(c, { ratio: 1.5 })).toMatchObject({ ok: false, param: 'ratio' });
    expect(validateParams(c, { ratio: Number.NaN })).toMatchObject({ ok: false, param: 'ratio' });
    expect(validateParams(c, { flag: 'true' })).toMatchObject({ ok: false, param: 'flag' });
    expect(validateParams(c, { flag: true, ratio: 0 })).toEqual({ ok: true, params: { ratio: 0, flag: true } });
  });
});

describe('patterns are RE2 (§11.1)', () => {
  const stringParam = (pattern: string, extra: Record<string, unknown> = {}) =>
    withParam('code', { type: 'string', max_length: 50, pattern, description: 'x', ...extra });
  const capWith = (pattern: string, maxLength = 50): Capability =>
    validateManifest(stringParam(pattern, { max_length: maxLength })).capabilities[0]!;

  it('ReDoS regression: catastrophic patterns are matched in linear time (child process, kill timeout)', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(PLUGIN_ROOT, 'test', 'fixtures', 'redos-probe.ts')], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    expect(r.signal, 'the probe was killed: a manifest pattern is being evaluated by a backtracking engine').toBeNull();
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as { results: boolean[]; ms: number };
    expect(out.results).toEqual([false, false, false, true]);
    expect(out.ms).toBeLessThan(2000);
  });

  it('no source file hands a manifest pattern to a JavaScript RegExp', () => {
    for (const f of readdirSync(join(PLUGIN_ROOT, 'src'))) {
      // deny-list.ts compiles its own constant credential globs (M8), never a manifest pattern.
      if (f === 'deny-list.ts') continue;
      const text = readFileSync(join(PLUGIN_ROOT, 'src', f), 'utf8');
      expect(text, f).not.toMatch(/new RegExp\(/);
      expect(text, f).not.toMatch(/RegExp\(\s*[a-z]/);
    }
  });

  it('rejects patterns RE2 cannot compile: lookaround, backreferences, bad syntax, huge repeats', () => {
    for (const pattern of ['^(?=a)a$', '^(?!a)b$', '^(?<=a)b$', '^(a)\\1$', '^[a-$', '^a{1001}$', '^((a{100}){100}){100}$']) {
      expect(problemsOf(stringParam(pattern)).join(), pattern).toMatch(/does not compile in RE2/);
    }
  });

  it('accepts RE2 syntax that ECMAScript lacks, with RE2 meaning', () => {
    expect(validateParams(capWith('^(?i)[a-z]+$'), { code: 'ABC' })).toMatchObject({ ok: true });
    expect(validateParams(capWith('^\\Qa.b\\E$'), { code: 'a.b' })).toMatchObject({ ok: true });
    expect(validateParams(capWith('^\\Qa.b\\E$'), { code: 'axb' })).toMatchObject({ ok: false });
    expect(validateParams(capWith('^[[:alpha:]]+$'), { code: 'abc' })).toMatchObject({ ok: true });
    expect(validateParams(capWith('^[[:alpha:]]+$'), { code: 'ab1' })).toMatchObject({ ok: false });
    expect(validateParams(capWith('^(?P<x>[a-z]+)$'), { code: 'abc' })).toMatchObject({ ok: true });
  });

  it('matches with RE2 semantics: $ only at the end, \\d and \\s ASCII only, full match', () => {
    expect(validateParams(capWith('^[a-z]+$'), { code: 'abc\n' })).toMatchObject({ ok: false });
    expect(validateParams(capWith('^\\d+$'), { code: '\u0663' })).toMatchObject({ ok: false });
    expect(validateParams(capWith('^\\s$'), { code: '\u00a0' })).toMatchObject({ ok: false });
    expect(validateParams(capWith('^a|b$'), { code: 'ab' })).toMatchObject({ ok: false });
    expect(validateParams(capWith('^a|b$'), { code: 'a' })).toMatchObject({ ok: true });
    expect(validateParams(capWith('^.$'), { code: '😀' })).toMatchObject({ ok: true });
  });

  it('requires ^…$ anchoring and at most 300 characters', () => {
    expect(problemsOf(stringParam('[a-z]+$'))).not.toHaveLength(0);
    expect(problemsOf(stringParam('^[a-z]+'))).not.toHaveLength(0);
    expect(problemsOf(stringParam('^[a-z]+\\$')).join()).toMatch(/anchored/);
    const at300 = `^${'a'.repeat(298)}$`;
    expect(() => validateManifest(stringParam(at300, { max_length: 300 }))).not.toThrow();
    expect(problemsOf(stringParam(`^${'a'.repeat(299)}$`)).join()).toMatch(/pattern|300/);
  });

  it('rejects a pattern with a lone surrogate', () => {
    expect(problemsOf(stringParam('^a\ud800$')).join()).toMatch(/lone surrogate/);
  });
});

describe('param rules, one reading on both sides (§11.2, §11.3)', () => {
  it('a required param may not declare a default', () => {
    const doc = base();
    const params = doc.capabilities[0]!.params as Record<string, Record<string, unknown>>;
    params.code!.default = 'abc';
    expect(problemsOf(doc).join()).toMatch(/code: a required param may not declare a default/);
    const enumDoc = withParam('kind', { type: 'enum', values: ['a', 'b'], default: 'a', description: 'x' }, { required: ['code', 'kind'] });
    expect(problemsOf(enumDoc).join()).toMatch(/kind: a required param may not declare a default/);
    // Optional with a default is fine, and it is filled in.
    const ok = validateManifest(withParam('kind', { type: 'enum', values: ['a', 'b'], default: 'b', description: 'x' }));
    expect(validateParams(ok.capabilities[0]!, { code: 'x' })).toEqual({ ok: true, params: { code: 'x', count: 3, kind: 'b' } });
  });

  it('request_id is reserved and may not be a param', () => {
    const doc = withParam('request_id', { type: 'string', max_length: 40, pattern: '^rq_[0-9a-f]{32}$', description: 'x' });
    expect(problemsOf(doc).join()).toMatch(/request_id is a reserved name/);
  });

  it('integer accepts integral numbers (5 and 5.0), rejects fractions', () => {
    const c = validateManifest(base()).capabilities[0]!;
    const parsed = JSON.parse('{"code": "x", "count": 5.0}') as Record<string, unknown>;
    expect(validateParams(c, parsed)).toEqual({ ok: true, params: { code: 'x', count: 5 } });
    expect(validateParams(c, { code: 'x', count: 5.000001 })).toMatchObject({ ok: false, param: 'count' });
    const negZero = validateManifest(withParam('nn', { type: 'integer', min: -1, max: 1, description: 'x' })).capabilities[0]!;
    const r = validateParams(negZero, { code: 'x', nn: -0 });
    expect(r.ok && Object.is(r.params.nn, 0)).toBe(true);
  });

  it('rejects non-finite values and magnitudes beyond ±2^53 for integer and number', () => {
    const wide = validateManifest(
      withParam('ii', { type: 'integer', min: -(2 ** 53), max: 2 ** 53, description: 'x' }, {}),
    ).capabilities[0]!;
    expect(validateParams(wide, { code: 'x', ii: 2 ** 53 })).toMatchObject({ ok: true });
    expect(validateParams(wide, { code: 'x', ii: -(2 ** 53) })).toMatchObject({ ok: true });
    expect(validateParams(wide, { code: 'x', ii: 2 ** 53 + 2 })).toMatchObject({ ok: false, param: 'ii' });
    expect(validateParams(wide, { code: 'x', ii: 1e300 })).toMatchObject({ ok: false, param: 'ii' });
    expect(validateParams(wide, { code: 'x', ii: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false, param: 'ii' });
    expect(validateParams(wide, { code: 'x', ii: Number.NaN })).toMatchObject({ ok: false, param: 'ii' });
    const num = validateManifest(withParam('ff', { type: 'number', min: -(2 ** 53), max: 2 ** 53, description: 'x' })).capabilities[0]!;
    expect(validateParams(num, { code: 'x', ff: 0.5 })).toMatchObject({ ok: true });
    expect(validateParams(num, { code: 'x', ff: Number.NEGATIVE_INFINITY })).toMatchObject({ ok: false, param: 'ff' });
    expect(validateParams(num, { code: 'x', ff: Number.NaN })).toMatchObject({ ok: false, param: 'ff' });
    expect(validateParams(num, { code: 'x', ff: 2 ** 54 })).toMatchObject({ ok: false, param: 'ff' });
  });

  it('rejects manifest bounds and defaults beyond ±2^53', () => {
    expect(problemsOf(withParam('ii', { type: 'integer', min: 0, max: 2 ** 60, description: 'x' })).join()).toMatch(/max must be finite and within/);
    expect(problemsOf(withParam('ff', { type: 'number', min: -1e300, max: 1, description: 'x' })).join()).toMatch(/min must be finite and within/);
    expect(() => parseManifest(
      'version: 1\ncapabilities:\n  - name: inf\n    title: t\n    description: d\n    environment: staging\n    params:\n      ff:\n        type: number\n        min: 0\n        max: .inf\n        description: x\n',
    )).toThrow(ManifestError);
  });

  it('max_length counts code points, not UTF-16 units', () => {
    const c = validateManifest(withParam('code', { type: 'string', max_length: 3, pattern: '^.*$', description: 'x' })).capabilities[0]!;
    expect(validateParams(c, { code: '😀😀😀' })).toMatchObject({ ok: true });
    expect(validateParams(c, { code: '😀😀😀😀' })).toMatchObject({ ok: false, param: 'code' });
  });

  it('rejects strings with lone surrogates, even when the pattern would match', () => {
    const c = validateManifest(withParam('code', { type: 'string', max_length: 10, pattern: '^.*$', description: 'x' })).capabilities[0]!;
    expect(validateParams(c, { code: '\ud800' })).toMatchObject({ ok: false, param: 'code', detail: expect.stringMatching(/lone surrogate/) });
    expect(validateParams(c, { code: 'a\udc00' })).toMatchObject({ ok: false, param: 'code' });
    expect(validateParams(c, { code: '\udc00\ud800' })).toMatchObject({ ok: false, param: 'code' });
    expect(validateParams(c, { code: '\ud83d\ude00' })).toMatchObject({ ok: true });
  });

  it('hasLoneSurrogate finds unpaired halves only', () => {
    expect(hasLoneSurrogate('plain')).toBe(false);
    expect(hasLoneSurrogate('😀')).toBe(false);
    expect(hasLoneSurrogate('x\ud83d')).toBe(true);
    expect(hasLoneSurrogate('\ude00x')).toBe(true);
  });
});

describe('shares (M4-SPEC §3)', () => {
  const withShares = (shares: unknown) => ({ version: 1, capabilities: [], shares });

  it('accepts folder names, none, or no list at all', () => {
    expect(validateManifest(withShares([{ name: 'orders-service' }, { name: 'My_Notes' }, { name: 'v1.2' }])).shares).toHaveLength(3);
    expect(validateManifest(withShares([])).shares).toEqual([]);
    expect(validateManifest({ version: 1, capabilities: [] }).shares).toBeUndefined();
    expect(() => validateManifest(withShares(Array.from({ length: 16 }, (_, i) => ({ name: `d${i}` }))))).not.toThrow();
  });

  it('refuses a path, a bad name, a repeated name, more than 16, and anything but {name}', () => {
    for (const shares of [
      [{ name: '/Users/bob/src' }],  // e1-guard: allow (synthetic macOS home path in a test)
      [{ name: 'a/b' }],
      [{ name: 'My Notes' }],
      [{ name: '' }],
      [{ name: 'a'.repeat(65) }],
      [{ name: 'notes\n' }],
      [{ name: 'a' }, { name: 'a' }],
      Array.from({ length: 17 }, (_, i) => ({ name: `d${i}` })),
      [{ name: 'a', path: '/x' }],
      ['a'],
      { name: 'a' },
    ]) {
      expect(() => validateManifest(withShares(shares)), JSON.stringify(shares)).toThrow(ManifestError);
    }
  });
});
