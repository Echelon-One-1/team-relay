// Every suite runs as if nobody had signed in: the credential file (M5-SPEC §6) is looked
// for in an empty private directory, never in the developer's own ~/.config/team-relay.
// HOME is an empty private directory too, so nothing reaches the developer's login Keychain
// (drive-token-cleanup.ts names it from HOME) or other files under the real home.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'team-relay-xdg-'));
process.env.HOME = mkdtempSync(join(tmpdir(), 'team-relay-home-'));
delete process.env.RELAY_CREDENTIALS_FILE;
delete process.env.RELAY_AUTH;
delete process.env.TEAM_RELAY_OPEN_COMMAND;
