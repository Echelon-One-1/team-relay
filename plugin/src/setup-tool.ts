// /team-relay:setup: the `setup` tool of a working session's relay server. Setting up without
// Terminal: it signs the member in when they are not (the same sign-in as `login`, waited for as
// `login_wait` does, up to 5 minutes), then opens the setup page on their own Mac (setup-page.ts)
// and returns at once. Everything else happens on the page, where the member decides.

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

/** How long the tool waits for a sign-in it started. */
export const SETUP_SIGN_IN_WAIT_MS = 5 * 60 * 1000;

export type SetupToolDeps = {
  /** The signed-in member now (null: not signed in). */
  live: () => SetupLive | null;
  /**
   * Signs in (as `login`) and waits for it (as `login_wait`, at most `waitMs`): null once signed
   * in, else why not, in one sentence.
   */
  signIn: (waitMs: number, progress: (message: string) => void) => Promise<string | null>;
  pages: { open(live: SetupLive): Promise<{ url: string; reused: boolean }> };
};

export async function setupTool(args: Record<string, unknown>, deps: SetupToolDeps, progress: (message: string) => void = () => {}): Promise<ToolResult> {
  if (unknownKey(args, [])) return toolError('setup takes no arguments');
  let live = deps.live();
  if (!live) {
    progress('signing in: finish in the browser');
    const why = await deps.signIn(SETUP_SIGN_IN_WAIT_MS, progress);
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
