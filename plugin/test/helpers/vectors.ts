// M10-SPEC §7.5 and PICKERS-SPEC §2: schema/boundaries-vectors.json, its placeholders expanded as
// the file's "placeholders" texts say (the relay's and the console UI's tests expand them the
// same way).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Doc = Record<string, unknown>;
type Drive = { domain: string; shared_drive: string };

export type Vectors = {
  /** PUT bodies' boundaries the rule accepts. */
  valid: Doc[];
  /** PUT bodies' boundaries the rule refuses (400 invalid_body); `field` is the boundaries field at fault, null for the body itself. */
  invalid: Array<{ why: string; field: string | null; boundaries: Doc }>;
  /** Documents the M10 code wrote: refused as a PUT body, read with the picked lists empty. */
  m10_documents: Doc[];
  /** What the relay stores of a valid body. */
  normalised: Array<{ why: string; boundaries: Doc; expect: Doc }>;
  /** Legacy drives sent against those stored (null: nothing stored); ok false is 400 legacy_drive. */
  legacy_drives: Array<{ why: string; stored: Drive[] | null; sent: Drive[]; ok: boolean }>;
  keys: Array<{ kind: 'org' | 'repo' | 'folder' | 'drive'; item: Doc; key: string }>;
  item_keys: Array<{ boundaries: Doc; keys: string[] }>;
  /** A document the M10 code stored as version 1, then each PUT in turn (version 2, 3, ...). */
  since: {
    comment: string;
    start: { version: number; boundaries: Doc; since: Doc };
    steps: Array<{ why: string; boundaries: Doc; since: Doc }>;
  };
  /** The status group `sources` (invalid: 400 invalid_body; kept: what the relay stores of a valid one). */
  sources: {
    valid: Doc[];
    invalid: Array<{ why: string; sources: unknown }>;
    kept: Array<{ why: string; boundaries: Doc; missing: string[]; kept: string[] }>;
  };
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
  REPO_100: 'r'.repeat(100),
  REPO_101: 'r'.repeat(101),
  FOLDER_NAME_255: 'f'.repeat(255),
  FOLDER_NAME_256: 'f'.repeat(256),
  ID_200: 'x'.repeat(200),
  ID_201: 'x'.repeat(201),
  KEY_400: 'k'.repeat(400),
  KEY_401: 'k'.repeat(401),
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
