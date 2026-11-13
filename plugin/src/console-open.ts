// `bin/console --open` (M2-SPEC §4.4, §7.7) without putting the key in any process argument.
//
// Every local user can read another process's arguments (ps), so the URL with its #k=<key>
// fragment is never passed to the opener. Instead a small HTML file that redirects to the
// URL is written, mode 600, into a fresh private directory (mkdtemp, mode 700), the opener is
// given that file's path, and the directory is removed after 10 s (or when this process exits,
// whichever comes first).

import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const REDIRECT_TTL_MS = 10_000;
export const REDIRECT_FILE = 'console.html';

export type Run = (command: string, args: string[], done: (err: Error | null) => void) => void;

export type OpenOptions = {
  log: (message: string) => void;
  platform?: NodeJS.Platform;
  /**
   * The program that opens the redirect file instead of `open` / `xdg-open` (an absolute
   * path; it is given the file's path and nothing else). TEAM_RELAY_OPEN_COMMAND sets it.
   */
  opener?: string;
  /** The redirect page's title and link text (default: the team console). */
  title?: string;
  /** What the log lines call the thing being opened (default: the URL above). */
  what?: string;
  /** Where the private directory is made (default: the OS temp directory). */
  tmpRoot?: string;
  deleteAfterMs?: number;
  /** Runs the opener (default: execFile, argv only, never a shell). */
  run?: Run;
  /** Told once whether the opener ran (false: nothing was opened, the URL is the caller's to show). */
  onResult?: (opened: boolean) => void;
};

const defaultRun: Run = (command, args, done) => {
  execFile(command, args, { shell: false, timeout: 10_000 }, (err) => done(err));
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The redirect page: no script, no external request, no referrer. */
export function redirectHtml(url: string, title = 'Team console'): string {
  const u = escapeHtml(url);
  const t = escapeHtml(title);
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0;url=${u}">`,
    `<title>${t}</title></head>`,
    `<body><p><a href="${u}">${t}</a></p></body></html>`,
    '',
  ].join('\n');
}

/** The platform's opener, or null where --open is not supported. */
export function openerFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string | null {
  const custom = env.TEAM_RELAY_OPEN_COMMAND?.trim();
  if (custom) return isAbsolute(custom) ? custom : null;
  if (platform === 'darwin') return 'open';
  if (platform === 'linux') return 'xdg-open';
  return null;
}

/**
 * Open `url` in the default browser by way of a private redirect file. Returns the file's
 * path (for tests), or null when nothing was opened.
 */
export function openInBrowser(url: string, opts: OpenOptions): string | null {
  const what = opts.what ?? 'the URL above';
  const told = (opened: boolean) => opts.onResult?.(opened);
  const opener = opts.opener ?? openerFor(opts.platform ?? process.platform);
  if (!opener) {
    opts.log(`no browser opener on this platform; open ${what} yourself`);
    told(false);
    return null;
  }
  let dir: string;
  try {
    dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), 'team-relay-console-'));
    chmodSync(dir, 0o700);
  } catch {
    opts.log(`could not prepare the browser hand-off; open ${what} yourself`);
    told(false);
    return null;
  }
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const file = join(dir, REDIRECT_FILE);
  try {
    writeFileSync(file, redirectHtml(url, opts.title), { mode: 0o600, flag: 'wx' });
  } catch {
    cleanup();
    opts.log(`could not prepare the browser hand-off; open ${what} yourself`);
    told(false);
    return null;
  }
  process.once('exit', cleanup);
  setTimeout(() => {
    process.removeListener('exit', cleanup);
    cleanup();
  }, opts.deleteAfterMs ?? REDIRECT_TTL_MS).unref();
  (opts.run ?? defaultRun)(opener, [file], (err) => {
    if (err) opts.log(`could not open a browser (${opener}); open ${what} yourself`);
    told(!err);
  });
  return file;
}
