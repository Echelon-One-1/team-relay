/// <reference types="node" />
// schema/boundaries-vectors.json, as every implementation's tests load it: read from disk and
// parsed with JSON.parse (it holds a lone surrogate, which the bundler's JSON loader refuses),
// every placeholder expanded as the file's "placeholders" texts say.

import { readFileSync } from 'node:fs'
import path from 'node:path'

const raw = readFileSync(path.resolve(import.meta.dirname, '../../../schema/boundaries-vectors.json'), 'utf8')

export interface Vectors {
  valid: Record<string, unknown>[]
  invalid: Array<{ why: string; field: string | null; boundaries: Record<string, unknown> }>
  m10_documents: Record<string, unknown>[]
  normalised: Array<{ why: string; boundaries: Record<string, unknown>; expect: Record<string, unknown> }>
  legacy_drives: Array<{ why: string; stored: unknown[] | null; sent: unknown[]; ok: boolean }>
  keys: Array<{ kind: string; item: Record<string, unknown>; key: string }>
  item_keys: Array<{ boundaries: Record<string, unknown>; keys: string[] }>
  since: { start: Record<string, unknown>; steps: Record<string, unknown>[] }
  sources: {
    valid: unknown[]
    invalid: Array<{ why: string; sources: unknown }>
    kept: Array<{ why: string; boundaries: Record<string, unknown>; missing: string[]; kept: string[] }>
  }
  versions: { valid: unknown[]; invalid: unknown[] }
  placeholders: Record<string, string>
}

/** Each placeholder's value, as the file's "placeholders" texts say. */
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
}

function expand(v: unknown): unknown {
  if (typeof v === 'string') return Object.prototype.hasOwnProperty.call(PLACEHOLDERS, v) ? PLACEHOLDERS[v] : v
  if (Array.isArray(v)) return v.map(expand)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
  return v
}

const parsed = JSON.parse(raw) as Vectors & { placeholders: Record<string, string> }

/** The file as written (placeholders not expanded). */
export const rawVectors = parsed

/** The file with every placeholder expanded. */
export const vectors = { ...(expand(parsed) as Vectors), placeholders: parsed.placeholders }
