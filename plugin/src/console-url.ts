// M11-SPEC §2, §4: one public host serves the relay and the console (M10-SPEC §5), so the console
// a member opens to accept the team's boundaries and to follow answers is the relay URL's origin.

/** The console's address for a relay URL: its origin (scheme, host and port), never a path. */
export function consoleUrl(relayUrl: string): string {
  try {
    const u = new URL(relayUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return relayUrl;
    return u.origin;
  } catch {
    return relayUrl;
  }
}
