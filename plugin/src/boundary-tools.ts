// M10-SPEC §3: the host's file tools for an answerer in boundary mode. They run in the host,
// see only the run's allowed set (boundary-set.ts) and never return a path or text from
// outside it:
//
//   list_files(area?, glob?)                          paths in the set (absolute, for Read)
//   search_files(pattern, area?, glob?, max_results?) lines matching an RE2 pattern
//
// Every file is checked again before it is opened (its canonical path must still be itself and
// in the set) and opened as a Read snapshot opens it (snapshot.ts openAllowed), searches are capped in results, bytes and time, and a matching line that the secret screen
// flags is withheld.

import { RE2JS } from 're2js';
import { areaRelative, canonical, type AllowedSet, type Area, type DenyCtx } from './boundary-set.js';
import { screenSecrets } from './secret-screen.js';
import { openAllowed, readCapped } from './snapshot.js';

export const LIST_LIMIT = 500;
export const SEARCH_DEFAULT_RESULTS = 50;
export const SEARCH_MAX_RESULTS = 200;
export const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SEARCH_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const SEARCH_MAX_MS = 20_000;
const LINE_SHOWN = 300;
const LINE_SCANNED = 10_000;
const PATTERN_LIMIT = 300;
const WITHHELD_LINE = '[line withheld: it may contain a credential]';

export type ToolOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; message: string };

function areaList(set: AllowedSet) {
  return set.areas.map((a) => ({ area: a.name, kind: a.kind, root: a.root, files: a.files.length, ...(a.truncated ? { truncated: true } : {}) }));
}

/** The areas an `area` argument picks: all of them, or one by its name (with or without its "kind:" prefix). */
function pickAreas(set: AllowedSet, area: unknown): Area[] | string {
  if (area === undefined || area === null || area === '') return set.areas;
  if (typeof area !== 'string' || area.length > 300) return 'area must be one of the area names list_files shows';
  // A name, or the name without its kind.
  const found = set.areas.filter((a) => a.name === area || a.name.replace(/^[a-z]+:/, '') === area);
  if (found.length === 0) return `there is no area ${JSON.stringify(area.slice(0, 100))}; the areas are: ${set.areas.map((a) => a.name).join(', ') || '(none)'}`;
  return found;
}

/**
 * A glob (`*`, `**`, `?`; everything else literal) as an RE2 pattern: the answerer's glob is
 * never given to a JavaScript RegExp, so no glob can make matching slow.
 */
export function globToRe2(glob: string): RE2JS {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += RE2JS.quote(c);
  }
  return RE2JS.compile(re);
}

/** A glob over paths relative to the area root (`*`, `**`, `?`); without a "/", it may match the file name alone. */
function globFilter(glob: unknown): ((rel: string) => boolean) | string | null {
  if (glob === undefined || glob === null || glob === '') return null;
  if (typeof glob !== 'string' || glob.length > PATTERN_LIMIT) return 'glob must be a short pattern such as "**/*.md"';
  let re: RE2JS;
  try {
    re = globToRe2(glob);
  } catch {
    return 'glob must be a short pattern such as "**/*.md"';
  }
  const nameOnly = !glob.includes('/');
  return (rel) => re.matches(rel) || (nameOnly && re.matches(rel.slice(rel.lastIndexOf('/') + 1)));
}

function filesOf(areas: Area[], filter: ((rel: string) => boolean) | null): Array<{ area: Area; path: string }> {
  const out: Array<{ area: Area; path: string }> = [];
  for (const a of areas) for (const f of a.files) if (!filter || filter(areaRelative(a, f))) out.push({ area: a, path: f });
  return out;
}

export function listFiles(set: AllowedSet, args: Record<string, unknown>): ToolOutcome {
  const areas = pickAreas(set, args.area);
  if (typeof areas === 'string') return { ok: false, message: areas };
  const filter = globFilter(args.glob);
  if (typeof filter === 'string') return { ok: false, message: filter };
  const all = filesOf(areas, filter);
  const shown = all.slice(0, LIST_LIMIT);
  return {
    ok: true,
    result: {
      areas: areaList(set),
      total: all.length,
      files: shown.map((f) => f.path),
      ...(all.length > shown.length ? { truncated: true, note: `only the first ${LIST_LIMIT} are shown: narrow with area or glob` } : {}),
    },
  };
}

/**
 * The file's text when it is still itself, in the set, small enough and not binary; else null.
 * Opened the one way the host opens a member file (snapshot.ts openAllowed: no symlink, no
 * FIFO, the same inode as the set's path).
 */
async function readInSet(set: AllowedSet, path: string, budget: { bytes: number }, opts: SearchOptions): Promise<string | null> {
  const real = await canonical(path);
  if (real !== path || !set.files.has(real)) return null;
  const cap = Math.min(SEARCH_MAX_FILE_BYTES, budget.bytes);
  const opened = await openAllowed({ set, ctx: opts.ctx, real, maxBytes: cap, ...(opts.beforeOpen ? { beforeOpen: opts.beforeOpen } : {}) });
  if (!opened.ok) return null;
  try {
    const body = await readCapped(opened.fh, cap);
    if (body === null) return null;
    budget.bytes -= body.length;
    if (body.subarray(0, 8000).includes(0)) return null;
    return body.toString('utf8');
  } catch {
    return null;
  } finally {
    await opened.fh.close().catch(() => {});
  }
}

export type SearchOptions = {
  ctx: DenyCtx;
  now?: () => number;
  /** Tests only: runs just before each file is opened. */
  beforeOpen?: (canonicalPath: string) => Promise<void> | void;
};

export async function searchFiles(set: AllowedSet, args: Record<string, unknown>, opts: SearchOptions): Promise<ToolOutcome> {
  const now = opts.now ?? Date.now;
  const pattern = args.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > PATTERN_LIMIT) {
    return { ok: false, message: `pattern must be 1 to ${PATTERN_LIMIT} characters (an RE2 regular expression; (?i) ignores case)` };
  }
  let re: RE2JS;
  try {
    re = RE2JS.compile(pattern);
  } catch {
    return { ok: false, message: 'pattern is not a valid RE2 regular expression' };
  }
  const max = args.max_results ?? SEARCH_DEFAULT_RESULTS;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > SEARCH_MAX_RESULTS) {
    return { ok: false, message: `max_results must be a whole number from 1 to ${SEARCH_MAX_RESULTS}` };
  }
  const areas = pickAreas(set, args.area);
  if (typeof areas === 'string') return { ok: false, message: areas };
  const filter = globFilter(args.glob);
  if (typeof filter === 'string') return { ok: false, message: filter };
  const until = now() + SEARCH_MAX_MS;
  const budget = { bytes: SEARCH_MAX_TOTAL_BYTES };
  const results: Array<{ path: string; line: number; text: string }> = [];
  let searched = 0;
  let skipped = 0;
  let stopped: string | null = null;
  for (const { path } of filesOf(areas, filter)) {
    if (results.length >= max) {
      stopped = `stopped at max_results (${max})`;
      break;
    }
    if (now() > until) {
      stopped = 'stopped: the search took too long; narrow it with area or glob';
      break;
    }
    if (budget.bytes <= 0) {
      stopped = 'stopped: too much text searched; narrow it with area or glob';
      break;
    }
    const text = await readInSet(set, path, budget, opts);
    if (text === null) {
      skipped++;
      continue;
    }
    searched++;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < max; i++) {
      const line = lines[i]!;
      if (!re.matcher(line.length > LINE_SCANNED ? line.slice(0, LINE_SCANNED) : line).find()) continue;
      const shown = line.length > LINE_SHOWN ? `${line.slice(0, LINE_SHOWN)}…` : line;
      results.push({ path, line: i + 1, text: screenSecrets(line).length ? WITHHELD_LINE : shown });
    }
  }
  return {
    ok: true,
    result: { results, files_searched: searched, ...(skipped ? { files_skipped: skipped } : {}), ...(stopped ? { truncated: true, note: stopped } : {}) },
  };
}
