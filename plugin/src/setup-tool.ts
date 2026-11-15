// /team-relay:setup: the `setup` tool of a working session's relay server. Setting up without
// Terminal: it signs the member in when they are not (the same sign-in as `login`, waited for as
// `login_wait` does, up to 5 minutes), then opens the setup page on their own Mac (setup-page.ts)
// and waits, up to 10 minutes, for the member to press Done there; then it says in one line how
// it ended (the team, how many folders, background answering on or off). Everything else
// happens on the page, where the member decides. A cancelled call stops waiting at once and
// leaves the page to its own life (it stops after Done, 30 minutes idle, or with the server).
//
// A sign-in that is stored but not connected yet (the session is starting, or reconnecting after
// the relay did not answer) is waited for briefly, never replaced by a new Google sign-in: only
// with no stored sign-in, one the relay refused, or a stale one (its relay answered 404 for it;
// relay-connect.ts staleSignIn) does it sign in again. A stale sign-in stays stored until the new
// one succeeds, which then replaces it. A sign-in for another relay than the configured one that
// is not answering is never stale (an outage is no reason to switch relays): setup stops and says
// so, and switching stays the member's choice (/team-relay:logout first). When no browser could be opened on the sign-in, the result carries the
// sign-in URL for the user to open themselves (as the login tool's does, under the same rule).

import { SIGN_IN_URL_RULE } from './login.js';
import { describeError, toolError, toolJson, unknownKey, type ToolResult } from './tool-util.js';
import type { OpenedPage, SetupDone, SetupLive } from './setup-page.js';

export const SETUP_TOOL = {
  name: 'setup',
  description:
    'Set up the team relay on this Mac without Terminal (/team-relay:setup). Takes no arguments. Signs in first when needed ' +
    "(the browser opens on the relay's Google sign-in), then opens the setup page on this Mac in the browser, where the user " +
    "accepts the team's boundaries, picks the folders their Claude answers from and turns background answering on. " +
    'Waits (up to 10 minutes) until they press Done there, then returns one line saying how setup ended.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

/** What the tool says (as progress) once the page is open. */
export const SETUP_OPEN = 'The setup page is open in your browser. Come back here when it says Done.';

/** Said first when the stored sign-in no longer works at its relay (a 404). */
export const SETUP_STALE = "Your saved sign-in no longer works at its team relay, so you're signing in again.";

/** What the tool says when Done was not pressed within the wait. */
export const SETUP_STILL_OPEN = 'The setup page is still open in your browser. Finish it there; run /team-relay:setup again if you closed it.';

/** What the tool says when the page closed without Done. */
export const SETUP_CLOSED = 'The setup page closed before Done was pressed. Run /team-relay:setup again to finish setting up.';

/** What the tool says when its call was cancelled while waiting for Done. */
export const SETUP_CANCELLED = 'Stopped waiting for the setup page. It stays open in your browser until you press Done or close it.';

/** How long the tool waits for Done on the page (Claude Code's per-call limit for a stdio server is 30 minutes idle). */
export const SETUP_DONE_WAIT_MS = 10 * 60 * 1000;

/** "Setup is done: team demo, 4 folders, background answering on." Counts and on/off only. */
export function setupDoneLine(d: Extract<SetupDone, { kind: 'done' }>): string {
  const folders = d.folders === null ? '' : ` ${d.folders} folder${d.folders === 1 ? '' : 's'},`;
  return `Setup is done: team ${d.team},${folders} background answering ${d.background ? 'on' : 'off'}.`;
}

/** What the tool says when no browser could be opened on the sign-in. */
export const SETUP_OPEN_SIGN_IN =
  'No browser tab could be opened for the sign-in. Show the user sign_in_url as the rule says; once they have signed in there, ' +
  'run /team-relay:setup again to open the setup page.';

/** How long the tool waits for a sign-in it started. */
export const SETUP_SIGN_IN_WAIT_MS = 5 * 60 * 1000;

/** How long it waits for a stored sign-in to connect before saying it is not connected. */
export const SETUP_CONNECT_WAIT_MS = 5000;

export type SetupToolDeps = {
  /** The signed-in member now (null: not signed in). */
  live: () => SetupLive | null;
  /**
   * Whether a sign-in is stored: 'none' (or none usable), 'refused' (the relay refused it),
   * 'stale' (its relay answered 404 for it), 'elsewhere' (it is for another relay than the
   * configured one, which is not answering), or 'present' (the session is connecting with it).
   * Without it: as 'none'.
   */
  stored?: () => 'none' | 'refused' | 'stale' | 'elsewhere' | 'present';
  /** Why the session is not connected, in one sentence (the whoami tool's). */
  notConnected?: () => string;
  /**
   * Signs in (as `login`) and waits for it (as `login_wait`, at most `waitMs`): null once signed
   * in; the sign-in URL when no browser could be opened on it; `cancelled` at once when `signal`
   * aborts (the sign-in itself goes on in the browser); else why not, in one sentence.
   */
  signIn: (waitMs: number, progress: (message: string) => void, signal?: AbortSignal) => Promise<null | string | { signInUrl: string } | { cancelled: true }>;
  pages: { open(live: SetupLive): Promise<OpenedPage> };
  /** Tests: the wait between looks at the connection. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests: how long to wait for Done (default SETUP_DONE_WAIT_MS). */
  doneWaitMs?: number;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function setupTool(
  args: Record<string, unknown>,
  deps: SetupToolDeps,
  progress: (message: string) => void = () => {},
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (unknownKey(args, [])) return toolError('setup takes no arguments');
  let live = deps.live();
  let stored = live ? null : (deps.stored?.() ?? 'none');
  if (!live && stored === 'present') {
    // Signed in already, not connected yet: give the connection a moment (unless it turns out stale).
    const sleep = deps.sleep ?? realSleep;
    for (let waited = 0; !live && stored === 'present' && waited < SETUP_CONNECT_WAIT_MS; waited += 100) {
      await sleep(100);
      live = deps.live();
      stored = live ? null : (deps.stored?.() ?? 'none');
    }
    if (!live && stored === 'present') return toolError(`${deps.notConnected?.() ?? 'Not connected yet.'} Run /team-relay:setup again in a moment.`);
  }
  // Signed in to another relay that is not answering: what to do is in the sentence; never a new sign-in.
  if (!live && stored === 'elsewhere') return toolError(`${deps.notConnected?.() ?? 'Not connected: signed in to another team relay that is not answering right now'}.`);
  const stale = !live && stored === 'stale';
  const said = (text: string) => (stale ? `${SETUP_STALE} ${text}` : text);
  if (signal?.aborted) return toolError(SETUP_CANCELLED);
  if (!live) {
    if (stale) progress(SETUP_STALE);
    progress('signing in: finish in the browser');
    const why = await deps.signIn(SETUP_SIGN_IN_WAIT_MS, progress, signal);
    if (why !== null && typeof why === 'object' && 'cancelled' in why) return toolError(SETUP_CANCELLED);
    if (why !== null && typeof why === 'object') {
      return toolJson({ status: 'waiting_for_browser', sign_in_url: why.signInUrl, sign_in_url_rule: SIGN_IN_URL_RULE, message: said(SETUP_OPEN_SIGN_IN) });
    }
    if (why !== null) return toolError(said(`${why} Then run /team-relay:setup again.`));
    live = deps.live();
    if (!live) return toolError(said('The sign-in finished, but this session is not connected yet. Run /team-relay:setup again in a moment.'));
    if (signal?.aborted) return toolError(SETUP_CANCELLED);
  }
  let page: OpenedPage;
  try {
    page = await deps.pages.open(live);
  } catch (err) {
    return toolError(said(`The setup page could not start (${describeError(err)}). Run /team-relay:setup again.`));
  }
  progress(SETUP_OPEN);
  const ended = await waitForDone(page.done, deps.doneWaitMs ?? SETUP_DONE_WAIT_MS, progress, signal);
  if (ended === 'cancelled') return toolError(SETUP_CANCELLED);
  if (ended === 'timeout') return toolJson({ message: said(SETUP_STILL_OPEN) });
  if (ended.kind === 'closed') return toolJson({ message: said(SETUP_CLOSED) });
  return toolJson({ message: said(setupDoneLine(ended)) });
}

/**
 * How the page ended, or 'timeout' after `ms`, or 'cancelled' when `signal` aborts. Its timers
 * and the abort listener are removed whichever comes first; the page is not touched.
 */
function waitForDone(done: Promise<SetupDone>, ms: number, progress: (message: string) => void, signal?: AbortSignal): Promise<SetupDone | 'timeout' | 'cancelled'> {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => end('timeout'), ms);
    // Progress keeps the call alive in a client that times idle tool calls out.
    const tick = setInterval(() => progress('waiting for Done on the setup page'), 15_000);
    const onAbort = () => end('cancelled');
    function end(v: SetupDone | 'timeout' | 'cancelled') {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(tick);
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    }
    if (signal?.aborted) return end('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    done.then(end, () => end({ kind: 'closed' }));
  });
}
