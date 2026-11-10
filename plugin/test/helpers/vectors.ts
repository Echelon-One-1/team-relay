// M10-SPEC §7.5: schema/boundaries-vectors.json, its placeholders expanded as the file's
// "placeholders" texts say (the relay's and the console UI's tests expand them the same way).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Vectors = {
  valid: Array<Record<string, unknown>>;
  invalid: Array<{ why: string; boundaries: Record<string, unknown> }>;
  versions: { valid: unknown[]; invalid: unknown[] };
  placeholders: Record<string, string>;
};

/** Each placeholder's value. */
export const PLACEHOLDERS: Record<string, string> = {
  TOPIC_501: 'a'.repeat(501),
  DOMAIN_253: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`,
  DOMAIN_254: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.com`,
  LABEL_63_DOMAIN: `${'a'.repeat(63)}.example.com`,
  LABEL_64_DOMAIN: `${'a'.repeat(64)}.example.com`,
  DRIVE_100: 'd'.repeat(100),
  DRIVE_101: 'd'.repeat(101),
};

function expand(v: unknown): unknown {
  if (typeof v === 'string') return Object.prototype.hasOwnProperty.call(PLACEHOLDERS, v) ? PLACEHOLDERS[v] : v;
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
  return v;
}

/** The raw file, as written. */
export const RAW_VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL('../../../schema/boundaries-vectors.json', import.meta.url)), 'utf8')) as Vectors;

/** The vectors with every placeholder expanded (placeholders itself left as it is). */
export const VECTORS: Vectors = { ...(expand({ ...RAW_VECTORS, placeholders: {} }) as Vectors), placeholders: RAW_VECTORS.placeholders };
