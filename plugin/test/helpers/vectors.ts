// schema/boundaries-vectors.json (schema v3, 13 Nov 2026: the topic alone), its placeholders
// expanded as the file's "placeholders" texts say (the relay's and the console UI's tests expand
// them the same way).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Doc = Record<string, unknown>;

export type Vectors = {
  comment: string;
  /** PUT bodies' boundaries the rule accepts. */
  valid: Doc[];
  /** PUT bodies' boundaries the rule refuses (400 invalid_body); `field` is the boundaries field at fault, null for the body itself. */
  invalid: Array<{ why: string; field: string | null; boundaries: Doc }>;
  /** Bodies holding a field of the earlier schemas: 400 invalid_body naming `field`. */
  removed: Array<{ field: string; boundaries: Doc }>;
  /** What the relay stores of a valid body. */
  normalised: Array<{ why: string; boundaries: Doc; expect: Doc }>;
  /** Documents an earlier relay stored or returned: read as `expect` (the topic alone). */
  stored: Array<{ why: string; stored: Doc; expect: Doc }>;
  /** The PUT body's version. */
  versions: { valid: unknown[]; invalid: unknown[] };
  /** The member status's folder_count. */
  folder_counts: { valid: unknown[]; invalid: unknown[] };
  placeholders: Record<string, string>;
};

/** Each placeholder's value. */
export const PLACEHOLDERS: Record<string, string> = {
  TOPIC_500: 'a'.repeat(500),
  TOPIC_501: 'a'.repeat(501),
};

function expand(v: unknown): unknown {
  if (typeof v === 'string') return Object.prototype.hasOwnProperty.call(PLACEHOLDERS, v) ? PLACEHOLDERS[v] : v;
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
  return v;
}

/** The raw file, as written. */
export const RAW_VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL('../../../schema/boundaries-vectors.json', import.meta.url)), 'utf8')) as Vectors;

/** The vectors with every placeholder expanded (comment and placeholders left as they are). */
export const VECTORS: Vectors = { ...(expand({ ...RAW_VECTORS, comment: '', placeholders: {} }) as Vectors), comment: RAW_VECTORS.comment, placeholders: RAW_VECTORS.placeholders };
