// /team-relay:setup: the `setup` tool of a working session's relay server. Setting up without
// Terminal: it signs the member in when they are not (the same sign-in as `login`, waited for as
// `login_wait` does, up to 5 minutes), then opens the setup page on their own Mac (setup-page.ts)
// and returns at once. Everything else happens on the page, where the member decides.
//
// A sign-in that is stored but not connected yet (the session is starting, or reconnecting after
// the relay did not answer) is waited for briefly, never replaced by a new Google sign-in: only
// with no stored sign-in, or one the relay refused, does it sign in again. When no browser could
// be opened on the sign-in, the result carries the sign-in URL for the user to open themselves
// (as the login tool's does, under the same rule).

import { SIGN_IN_URL_RULE } from './login.js';
import { describeError, toolError, toolJson, unknownKey, type ToolResult } from './tool-util.js';
import type { SetupLive } from './setup-page.js';

export const SETUP_TOOL = {
  name: 'setup',
  description:
    'Set up the team relay on this Mac without Terminal (/team-relay:setup). Takes no arguments. Signs in first when needed ' +
    "(the browser opens on the relay's Google sign-in), then opens the setup page on this Mac in the browser, where the user " +
    "accepts the team's boundaries, picks the folders their Claude answers from and turns background answering on. Returns at once.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
} as const;

/** What the tool says once the page is open. */
export const SETUP_OPEN = 'The setup page is open in your browser. Come back here when it says Done.';

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
   * Whether a sign-in is stored: 'none' (or none usable), 'refused' (the relay refused it), or
   * 'present' (the session is connecting with it). Without it: as 'none'.
   */
  stored?: () => 'none' | 'refused' | 'present';
  /** Why the session is not connected, in one sentence (the whoami tool's). */
  notConnected?: () => string;
  /**
   * Signs in (as `login`) and waits for it (as `login_wait`, at most `waitMs`): null once signed
   * in; the sign-in URL when no browser could be opened on it; else why not, in one sentence.
   */
  signIn: (waitMs: number, progress: (message: string) => void) => Promise<null | string | { signInUrl: string }>;
  pages: { open(live: SetupLive): Promise<{ url: string; reused: boolean }> };
  /** Tests: the wait between looks at the connection. */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function setupTool(args: Record<string, unknown>, deps: SetupToolDeps, progress: (message: string) => void = () => {}): Promise<ToolResult> {
  if (unknownKey(args, [])) return toolError('setup takes no arguments');
  let live = deps.live();
  if (!live && deps.stored?.() === 'present') {
    // Signed in already, not connected yet: give the connection a moment.
    const sleep = deps.sleep ?? realSleep;
    for (let waited = 0; !live && waited < SETUP_CONNECT_WAIT_MS; waited += 100) {
      await sleep(100);
      live = deps.live();
    }
    if (!live) return toolError(`${deps.notConnected?.() ?? 'Not connected yet.'} Run /team-relay:setup again in a moment.`);
  }
  if (!live) {
    progress('signing in: finish in the browser');
    const why = await deps.signIn(SETUP_SIGN_IN_WAIT_MS, progress);
    if (why !== null && typeof why === 'object') {
      return toolJson({ status: 'waiting_for_browser', sign_in_url: why.signInUrl, sign_in_url_rule: SIGN_IN_URL_RULE, message: SETUP_OPEN_SIGN_IN });
    }
    if (why !== null) return toolError(`${why} Then run /team-relay:setup again.`);
    live = deps.live();
    if (!live) return toolError('The sign-in finished, but this session is not connected yet. Run /team-relay:setup again in a moment.');
  }
  try {
    await deps.pages.open(live);
  } catch (err) {
    return toolError(`The setup page could not start (${describeError(err)}). Run /team-relay:setup again.`);
  }
  return toolJson({ message: SETUP_OPEN });
}
