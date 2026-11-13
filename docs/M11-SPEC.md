# Milestone 11: answering in the background, guided joining, asking from the browser

Status: spec, approved 10 Nov 2026. Extends M1-M10.

## Decisions (maintainer, 10 Nov 2026)

- Most members use the Claude Code desktop app, which loads no channels. Answering therefore
  runs in the background, outside any Claude session, and asking also works from the console.
- Joining is guided in the console: an invite message, then a checklist with live ticks.
- Setup is one command: `curl -fsSL https://<public host>/setup | bash`.
- A member accepts the team's boundaries in the browser. Only that member can accept for
  themselves; owners never can.
- Members pick the folders that hold their clones (no discovery of the disk).
- The repository gets CI and required checks; two deploy-script lessons from M10 are fixed.

## 1. The background answerer (plugin)

`dist/daemon.js`, run by a per-user macOS LaunchAgent (§5). It is the answer host of M8-M10
without a Claude session around it:

- Reads the stored sign-in (`credentials.json`, M5) and waits while there is none. A 401 waits for
  a new sign-in, as the channel server does.
- Takes the answering lock (M8 §1) with a new role `daemon`. While a channel session or the
  manual answerer holds it, the daemon waits and checks again every 30 s.
- Answers in boundary mode only (M10). A team without boundaries gets the existing
  `NOT_SET_UP_REPLY`; nothing is answered from folder mode, so no approval dialog is ever
  needed.
- The child is exactly M10's: the same flags, tools, settings and snapshot reads. The `claude`
  binary is the absolute path in `TEAM_RELAY_CLAUDE_BIN` (set by setup; launchd's PATH is
  minimal). Missing or not executable: the daemon reports `claude.found=false` (§3) and answers
  nothing.
- Acceptance comes from the relay (§2), not the local settings file. The answerer reads the
  intersection of the current boundaries and what the member accepted, with M10 §7.1's `since`
  rule unchanged (an item added after the accepted version is not covered; an accepted version
  greater than the document's covers nothing).
- Every 60 s it sends its status (§3). It writes ids, counts and reasons to
  `~/Library/Logs/team-relay/daemon.log` (mode 600, rotated at 5 MB, one old file kept), never a
  question, answer or file content.
- Once a minute it checks the installed plugin path (§5), under the key the launcher hands it
  (`TEAM_RELAY_PLUGIN_KEY`). When it has changed (the plugin was updated), the daemon finishes
  the current run, releases the lock and exits 0; launchd starts the new version.
- macOS privacy protection may refuse a LaunchAgent's `node` folders under `~/Documents`,
  `~/Desktop`, `~/Downloads`, `~/Library/Mobile Documents` and `~/Library/CloudStorage` (or ask
  the member first). When it recounts its facts (§3) the daemon lists each repo root, own folder
  and, for a team with drives, the Drive mount; an EPERM is logged with the kind of folder, its
  own name only and how many times so far. The status schema does not change.
- SIGTERM: stop taking work, end the running child, release the lock, exit within 15 s.
- Desktop notifications as M8 (`TEAM_RELAY_DESKTOP_NOTIFY=0` turns them off).

## 2. Accepting the boundaries in the browser (relay + console)

Stored in `teams/{team}/acceptances/{member}`: `{version, accepted_at}`. Purged with the team and
when the member leaves the roster.

- `GET /v1/teams/{team}/me/acceptance` (the member, or a delegate with `read` on behalf of the
  member) → `200 {"version": int, "accepted_at": iso|null}`. Never accepted: `version: 0`.
- `PUT /v1/teams/{team}/me/acceptance` body `{"version": int}` (strict) → `200` the same shape.
  `version` must equal the current boundaries version, else `409 version_conflict` (nobody accepts
  a version they were not shown). Boundaries never set: `409 not_set`. Allowed for the member
  itself (credential or ID token) or a delegate with the new scope `member-self` on behalf of that
  member. There is no route that names another member: an owner cannot accept for anyone. Rate
  limited with the existing per-member write budget. Audited (`boundaries_accepted`, version).
- The console's Join and Team pages show the boundaries with what changed since the member's last
  accepted version (items whose `since` is greater) and one "Accept" button. The local `accept`
  action of the `/team-relay:folders` tool is removed; it now says where to accept (the console
  URL).
- Any `accepted` value in the local settings file from M10 is ignored from now on (members accept
  once more in the browser).

## 3. Member status (relay)

- `PUT /v1/teams/{team}/me/status` (the member itself only; never a delegate) body, strict:
  `{"daemon": {"version": str<=32, "started_at": iso}, "claude": {"found": bool, "signed_in": bool},
  "folders": {"repo_roots": int 0-64, "clones": int 0-10000, "extra_folders": int 0-64},
  "drive": {"connected": bool}, "self_test": {"ok": bool, "at": iso, "reason": str<=200|null}}`.
  The relay adds `seen_at` (its own time). One document per member,
  `teams/{team}/member_status/{member}`, overwritten; purged with the team and the member.
  At most one write per member per 20 s (429 beyond).
- `GET /v1/teams/{team}/members/status` (any active member, or a delegate with `read`) →
  `200 {"members": [{"member", "status": {...}|null, "answering": bool, "accepted_version": int}],
  "boundaries_version": int}`. `answering` is `seen_at` within the last 180 s.
- `self_test` is the daemon's check at start and every 6 h: `claude auth status` succeeds and the
  M10 child starts with the real flags against a local host that denies every tool (as
  `answer-dry-run --run --offline`: the API at a closed local port, `CLAUDE_CODE_MAX_RETRIES=0`
  and `API_TIMEOUT_MS=5000`, so the refused request fails in about a second instead of
  minutes of retries), with no relay traffic and no question content. The first one runs beside
  connecting; until it ends the status says `{ok: false, reason: "the self-test has not run yet"}`
  (`SELF_TEST_PENDING`), which the checklists show as running, not failed. `reason` is a fixed
  sentence (error text, which can hold paths, stays in the local log).
- Claude's sign-in and the clone count are recounted every 10 min (or when the folders or the
  boundaries change); `drive.connected` is checked for every status (one keychain look-up).
- (Correction, 11 Nov 2026, docs/PICKERS-SPEC.md §3.3-§3.4, §8.) The body may also hold
  `"sources": {"boundaries_version": int, "missing": [item key, …]}` (optional; an explicit null is
  400; ≤140 keys of ≤400 characters, no control characters): the team's own boundary items this
  Mac did not find (`org:…`, `repo:…`, `folder:…`, `drive:…`). The relay keeps only keys of items of
  its current boundaries, in the writing transaction, and filters them again on read.
  `members/status` entries gain `"sources": {…}|null`: an owner gets every member's, anyone else
  only their own (others `null`). Old daemons' statuses (no `sources`) are still accepted.

## 4. Asking from the console (relay + console)

- The console gets an **Ask** page: pick teammates or everyone, type a question (1-8000 chars),
  send. It lists the viewer's last 20 requests; each shows who acknowledged and answered, live
  (polled every 3 s while open, every 30 s otherwise), and the answers.
- `POST /v1/teams/{team}/requests` is allowed for a delegate with `member-self` on behalf of the
  viewer, under the asker's existing limits. A capability invocation is not (questions only).
- `GET /v1/teams/{team}/requests/{id}` returns, to the asker only, each recipient's full
  `answer` (up to 32000 chars) next to `answer_preview`. The relay keeps the full text on the
  request record for the record's existing lifetime and no longer.
- `GET /v1/teams/{team}/me/requests?limit=20` (the member, or a delegate with `read` on behalf of
  the member) lists the member's own recent requests, newest first: `{id, to, created_at,
  question_preview (200 chars)}`.
- In the plugin, `ask_question`'s result says that answers can be followed in the console (its
  URL), and `request_status` shows the full answers for the asker.

## 5. One-command setup (relay serves it; plugin does the work)

`GET /setup` on the relay (no auth, `text/x-shellscript; charset=utf-8`, `Cache-Control:
no-store`) returns `relay/relay/static/setup.sh` with two placeholders replaced: `__RELAY_URL__`
(the relay's `RELAY_PUBLIC_URL`, an `https://` origin) and `__MARKETPLACE__`
(`RELAY_PLUGIN_MARKETPLACE`, `owner/repo`). Both are checked at start (refuse to start when set
and malformed); unset → `/setup` is 404. The load balancer routes `/setup` to the relay.

The script (bash 3.2, `set -euo pipefail`, macOS only, never `sudo`, re-runnable):

1. Finds `node` (>= 22.12, the plugin's own minimum) and `claude` (PATH, then `~/.local/bin/claude`, `~/.claude/local/claude`).
   Since 10 Nov 2026 it always installs (or finds) a pinned official Node.js privately and runs
   with it, whatever node is on PATH (see "Simpler joining" §3). No `claude`: offers to install Claude Code with its
   official installer (asks first) and stops on no.
2. `claude auth status`; not signed in → `claude auth login`.
3. `claude plugin marketplace add __MARKETPLACE__` (skipped when present), then
   `claude plugin install --scope user team-relay@<marketplace name>`, or `claude plugin update
   --scope user` when it is installed for this user (the rule of step 4; an install for a project
   only does not count).
4. Finds the install path in `~/.claude/plugins/installed_plugins.json` and from there runs
   `node <path>/dist/setup-cli.js` for the rest. One rule finds the plugin everywhere (here, the
   install check, the launcher, the daemon's update check): the first user-scope entry with an
   absolute `installPath` under exactly the key it installed, `team-relay@<marketplace name>`;
   never another scope or another marketplace's copy. In this order: `login`, `folders`, `drive`
   (never fatal), `daemon install`, `status --after-setup`.
   - `login`: the browser sign-in of M5 against `__RELAY_URL__` (team chosen in the browser);
     skipped when a valid sign-in for this relay exists.
   - `folders`: shows the team's GitHub orgs and opens the Mac's folder chooser for the
     folders that hold those clones (changed 10 Nov 2026, see "Simpler joining" §4; typed, one
     per line, only when no chooser can open; each must exist, not be `/` or `$HOME`); shows
     how many clones it found in each. Extra folders only when the team allows them. Re-running
     shows the current list and lets the member keep or replace it. When a chosen folder is under
     `~/Documents`, `~/Desktop`, `~/Downloads` or `~/Library/Mobile Documents`, one sentence says
     macOS may ask to allow "node" the first time the background answerer reads it: click Allow.
   - `drive`: when the team has drives, connects Google Drive (M10's Drive sign-in) unless
     connected, and says macOS may ask to allow "node" for Google Drive. Before `daemon install`
     (so the daemon's first status already says connected), but a failed or cancelled Drive
     sign-in does not stop the setup: it says to run the same setup command again to connect
     Drive, and goes on.
   - `daemon install --claude <path> --plugin team-relay@<marketplace name>`: first checks that
     the launcher would find `dist/daemon.js` under that key (else it stops, saying so, and
     writes nothing). Writes `~/Library/LaunchAgents/<label>.plist` (label
     `com.team-relay.answerer`) running the absolute node path with
     `~/.config/team-relay/daemon-launch.mjs`, which holds the key, reads the install path under
     it from `installed_plugins.json` at each start and imports `dist/daemon.js` from it.
     `RunAtLoad`, `KeepAlive`, `ThrottleInterval 30`, environment `TEAM_RELAY_CLAUDE_BIN`, `HOME`,
     a PATH of node's and claude's folders plus `/usr/bin:/bin`. Then `launchctl bootout` (if
     loaded), a wait (up to 20 s) until `launchctl print gui/<uid>/<label>` no longer finds it,
     and `launchctl bootstrap gui/<uid>`, tried up to 3 more times 2 s apart when it fails. Files
     mode 600, folders 700.
   - `status`: prints the checklist of §6 from the relay's view (two steps since 10 Nov 2026,
     "Simpler joining" §2). "Folders chosen" and "Google Drive connected" need nothing only when
     the boundaries were read and hold no orgs (or no drives); boundaries that could not be read
     leave both not known, never ticked (the console too). While the self-test has not run yet
     it says so once and looks again every 5 s, for up to 90 s in all, before printing the
     checklist. `--after-setup` (the script's last step) also waits, in the same loop, while the
     Mac has not reported in yet, and ends with the closing line (see 5).
5. Ends with "Done. Go back to the team page in your browser", plus " and click Accept" only
   when the team shares something this member has not accepted (printed by `status
   --after-setup`), then the console URL. When `status` fails, the script says "(Could not
   check with the team just now.)" and "Done. Go back to the team page in your browser.", then
   the URL (10 Nov 2026).

`setup-cli.js daemon uninstall` removes the agent; `setup-cli.js` with no command prints help.

The console is at the relay's origin: one public host serves both (M10-SPEC §5), so the setup
command and the console links are that host; a relay deployed at its run.app URL only (no
`PUBLIC_HOST`) has no setup command, and `scripts/deploy.sh` warns so.

## 6. Guided join (console)

- Owners: after adding a member (M6), the console shows **Copy invite message**: the console URL,
  the team name and the setup command, in plain text.
- The invitee accepts the invitation (M9) and lands on **Join** (the Setup page). Since 10 Nov
  2026 it shows two plain steps with "Ask the team" always below them, and the invite message
  and the team page's join card are plain too: see "Simpler joining" §1-§2. The seven checks below are still what step 1 ("Set up
  your Mac") is made of. Live ticks from `GET members/status` and `me/acceptance` (polled every
  5 s while the page is open):
  1. Run the setup command (copy button) - ticked when a status has arrived.
  2. Claude Code found and signed in - `claude.found && claude.signed_in`.
  3. Answering in the background - `answering`.
  4. Folders chosen - `folders.repo_roots > 0` (or the team has no orgs).
  5. Google Drive connected - `drive.connected` (or the team has no drives).
  6. Boundaries accepted - accepted version equals the current one (Accept button inline).
  7. Self-test passed - `self_test.ok`; while `reason` is the not-run-yet sentence, "Running the
     self-test now; this takes about a minute." (not a failure).
  Each unticked step says in one sentence what to do. All ticked: "You're set up. Ask the team"
  links to Ask.
- **Members** shows each member's progress ("set up", or "n of 2 set up", since 10 Nov 2026)
  and whether they are answering now.

## 7. Repository checks and deploy fixes

- `.github/workflows/ci.yml` (actions pinned by SHA, `contents: read`): job `checks` runs the
  plugin tests and type check and verifies `dist/` is built from `src/`, the console tests and
  build, and the relay tests against the Firestore emulator; job `gitleaks`.
- `.github/CODEOWNERS` names the maintainers' team; a ruleset on `main` requires a PR, the code
  owner's review and `checks` + `gitleaks`.
- `scripts/gcp-bootstrap.sh` enables `cloudresourcemanager.googleapis.com` (the IAP access step
  needs it).
- `scripts/deploy.sh` deploys the relay with `--no-invoker-iam-check` and ingress
  `internal-and-cloud-load-balancing` instead of granting `allUsers` the invoker role (refused by
  domain-restricted sharing). The relay authenticates every `/v1` request itself. It passes
  `RELAY_PUBLIC_URL` and `RELAY_PLUGIN_MARKETPLACE`.
- `scripts/deploy-lb.sh` adds the `/setup` path rule to the relay backend.

## 8. Security notes

- `member-self` lets the console act as the IAP-verified viewer for their own acceptance and
  questions only; the viewer is the IAP identity, never a value from the browser. Writes keep the
  console's existing rules (same origin, JSON, body cap).
- The setup script is public and holds no secret. It runs as the user, never as root. Its only
  network calls are to the relay, GitHub (marketplace), nodejs.org (one pinned, hash-checked
  build, when the Mac does not have it yet; 10 Nov 2026) and, when the member agrees,
  Claude Code's installer.
- The daemon has the member's sign-in and Drive token (as the channel server did); the child it
  runs keeps M10's limits. The LaunchAgent and launcher are the member's own files, mode 600.
- Status holds counts and booleans only: no paths, folder names, questions or answers.
  (Correction, 11 Nov 2026, docs/PICKERS-SPEC.md §8: status holds counts, booleans and keys of
  the team's own boundary items: no paths, local folder names, questions or answers.)

## Simpler joining (maintainer, 10 Nov 2026)

Most members use the Claude Code desktop app and have never used Terminal. Joining must not show
them words like plugin, marketplace, channel, CLI, Node, daemon, LaunchAgent, repo root or
boundaries version: plain, short sentences that say what to do. The maintainer approved four
decisions; where they differ from §5 and §6, these win.

### 1. One simple join card (console)

- The developer "Join the team" panel (marketplace, install, channel and `ANSWERER_READ_DIRS`
  commands) is removed from the Team page, with what only it used (`console/src/lib/join.ts`).
  `GET /api/join` stays: the local console reads the relay's address from it for the setup line
  (the console now reads only `relay_url` and `team`; the server's other fields are unchanged).
- In its place, a viewer who has not joined yet sees one small card, **Join in 2 minutes**:
  1. Open Terminal: press Cmd+Space, type Terminal, press Enter.
  2. Paste this line and press Enter, then answer its questions: the setup line, with a big
     Copy button.
  3. Come back to this page and click Accept (a button, "Go to Accept", that opens the Setup
     page, where the list and the Accept button are).
  A link "See your progress" opens Setup. The card shows once progress has loaded and the
  viewer has not joined; joined means their Mac has reported in at least once and they have
  accepted at least once (or the team shares nothing yet). Later trouble (the Mac switched off,
  a check failing) or something new to accept does not bring the card back: the Setup tab's
  count and the accept banner show those. While the card shows, the accept banner does not. A
  relay without setup progress (404) shows no card.
- The owner's **Copy invite message** is plain text, no markdown:

  ```
  You're invited to the team <name> on Team relay.

  <console URL>/

  Open the link and accept the invitation. Then, on your Mac:

  1. Open Terminal: press Cmd+Space, type Terminal, press Enter.
  2. Paste this line and press Enter, then answer its questions:
  curl -fsSL <console URL>/setup | bash
  3. Come back to the page and click Accept.
  ```

### 2. Two plain steps on Setup, then Ask the team (console and `setup-cli status`)

The seven steps of §6 become two:

1. **Set up your Mac**: done when every old check is (Run the setup command, Claude Code found
   and signed in, answering in the background, folders chosen, Google Drive connected,
   self-test passed), with the same rules: boundaries that could not be read never count as
   done for folders and Drive, and the self-test's not-run-yet reason shows as running ("Your
   Mac is checking that everything works. This takes about a minute."), not failed. The step
   holds the setup line with its copy box. The old checks show only while one is not done, each
   as one sentence of what to do (for example "Your Mac isn't answering right now. Make sure
   it's switched on; if this stays, run the setup line again."), never their technical names.
   Before the Mac has reported anything, none are listed (the step's own text says what to do).
   A failed self-test says to run the setup line again and, if it still fails, to show a team
   owner the Mac's reason.
2. **Accept what the team shares** (old step 6): the topic, the GitHub orgs, the shared drives
   and whether own folders are allowed, as a readable list; items added since the viewer last
   accepted are marked "new"; an Accept button; a 409 says what the team shares changed and
   shows the latest.

**Ask the team** is not a step: below the two, always, "Ask your teammates a question at any
time." with an "Ask the team" button to the Ask page; both steps done, it becomes "You're all
set" with a big "Ask the team" button. (A step for it would have ticked off again: `my-requests`
lists only questions that have not expired.) Nothing reads whether anyone has asked. The
Members panel shows "set up" for a member with both steps done, else "n of 2 set up". The page
tabs are Ask, Team, Setup; the landing page is still the team's. `setup-cli status` prints the
same two steps (the Mac's open checks indented under step 1), then "Ask the team: <console
URL>/ask".

### 3. Setup installs Node.js itself (`relay/relay/static/setup.sh`)

- The script always runs with its own copy of a pinned Node.js, whatever node Terminal has: the
  Claude Code app may not see Terminal's PATH, and the plugin's launcher (below) falls back to
  this copy. When there is no working copy of the pinned build, it downloads the official build
  `https://nodejs.org/dist/v22.23.4/node-v22.23.4-darwin-<arch>.tar.gz` (`uname -m`: `arm64` ->
  `darwin-arm64`, `x86_64` -> `darwin-x64`; anything else stops), and checks its SHA-256
  against the values pinned in the script (from nodejs.org's `SHASUMS256.txt`): arm64
  `c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428`, x64
  `efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819`. Any other hash: it
  stops and installs nothing.
- It unpacks into a temporary folder inside `~/.local/share/team-relay` (mode 700), checks
  `bin/node` is there, and renames it to `~/.local/share/team-relay/node-v22.23.4-darwin-<arch>`
  (the tarball's own name, so a new pin is a new folder and is downloaded), so a half-unpacked
  copy is never used. A copy that is there but does not run is replaced the same way. No sudo.
  That node runs everything after: `setup-cli` and, through its own path, the LaunchAgent. Once
  `daemon install` has succeeded with it, the other `node-v*` folders in
  `~/.local/share/team-relay` (older pins) are removed, and nothing else there. Every step of the download (folder, mode,
  download, hash, unpack, move) stops with one plain sentence when it fails, never a bare exit.
- Nothing is linked onto PATH (no `~/.local/bin/node`). The plugin no longer depends on `node`
  from Claude Code's PATH: `.mcp.json`, `hooks/hooks.json` (both generated by
  `plugin/scripts/generate.ts`) and the `!` lines of `/team-relay:logout` and `/team-relay:drive`
  run `/bin/sh ${CLAUDE_PLUGIN_ROOT}/bin/run-node <script> <args>`. `plugin/bin/run-node` (POSIX
  sh) uses the first `node` on PATH when it is 22.12 or newer (absolute PATH entries only: an
  empty or relative entry such as `.` is skipped, so no node from the current folder runs;
  the version must read `vMAJOR.MINOR.PATCH`, numbers of at most 9 digits), else the newest
  `~/.local/share/team-relay/node-v<version>-*/bin/node` that runs and is new enough, else prints
  "Team relay needs its helper: paste the setup line from your team page into Terminal again."
  on stderr and exits 1; then `exec "$node" "$@"`.
  Correction (13 Nov 2026): on a Mac (arm64 or x86_64) with neither, run-node now gets the pinned
  build itself instead of that line: the same version and SHA-256s as this script, kept in
  `plugin/bin/node-pins.sh` (`scripts/tests/run-node.test.sh` fails when the two differ), downloaded
  with `curl -fsSL --proto '=https' --tlsv1.2`, checked with `shasum -a 256`, unpacked and renamed
  into `~/.local/share/team-relay/node-<version>-darwin-<arch>`, then run. A lock folder there
  (`.node-download.lock`, holding its owner's process id) lets one start download; the others wait
  up to 120 s. Any failure removes the download and says "Could not get Node.js for the team relay:
  <why>. Check your internet connection and restart Claude." Elsewhere the line above is unchanged.
- The pinned values are plain assignments that only an edit of the script changes; no
  environment variable can replace them. The tests (`scripts/tests/setup-script.test.sh`) serve
  their own tarballs and run a copy of the script with the two hash lines edited by `sed`; the
  hash-mismatch case runs the script with its real values.
- Every message is plain ("Getting a helper the setup needs (about 50 MB)..."), and the script
  ends as §5 item 5 says. The Claude Code install is unchanged (it asks first).

### 4. Pick folders in Finder (`plugin/src/setup-cli.ts folders`)

- Instead of typing paths, `folders` opens the Mac's own folder chooser: `osascript` run with
  `execFile` (no shell), `choose folder with prompt ... with multiple selections allowed`, the
  prompt naming the team's GitHub orgs and passed as an argument of the script's run handler
  (never part of the script text). The script first calls `activate`, so the window comes to the
  front, and turns each folder into a POSIX path followed by a NUL (a folder name may hold a new
  line, never a NUL; the one new line osascript adds at the end is dropped). `execFile` has a
  10-minute timeout: a chooser left open that long closes and the member types the folders
  instead. It then says what it found in each folder in plain words ("Found 7 project folders in
  DEV.").
- Cancel keeps the current list (or none). Folders that cannot be used are said and left out;
  when none can, the list stays as it was. No osascript, or it fails for another reason (no
  screen): the member types the paths as before. The same checks as before (exists, not `/` or
  the home folder). On a re-run the current list is shown with "Keep these folders?"; no opens
  the chooser again. A Cancel after that explicit no asks "Stop using project folders? [y/N]"
  (for own folders, "Stop using folders of your own? [y/N]"): y saves none, anything else keeps
  the current list.
- Own folders, when the team allows them, the same way with a second chooser.
- The chooser is injected (`SetupDeps.chooseFolders`), so tests never run osascript.
- The other lines of `setup-cli` are plain and short too (sign-in, Drive, the background
  answerer: "Your Mac now answers your team in the background whenever it is on. Claude Code
  does not need to be open.").
