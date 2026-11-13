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
  removed: Array<{ field: string; boundaries: Record<string, unknown> }>
  normalised: Array<{ why: string; boundaries: Record<string, unknown>; expect: Record<string, unknown> }>
  stored: Array<{ why: string; stored: Record<string, unknown>; expect: Record<string, unknown> }>
  versions: { valid: unknown[]; invalid: unknown[] }
  folder_counts: { valid: unknown[]; invalid: unknown[] }
  placeholders: Record<string, string>
}

/** Each placeholder's value, as the file's "placeholders" texts say. */
export const PLACEHOLDERS: Record<string, string> = {
  TOPIC_500: 'a'.repeat(500),
  TOPIC_501: 'a'.repeat(501),
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
