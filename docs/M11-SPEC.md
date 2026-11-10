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
  connecting; until it ends the status says `{ok: false, reason: "the self-test has not run yet"}`.
  `reason` is a fixed sentence (error text, which can hold paths, stays in the local log).

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

1. Finds `node` (>= 22, the plugin's own minimum) and `claude` (PATH, then `~/.local/bin/claude`, `~/.claude/local/claude`).
   No `node`: says how to install it (nodejs.org) and stops. No `claude`: offers to install Claude
   Code with its official installer (asks first) and stops on no.
2. `claude auth status`; not signed in → `claude auth login`.
3. `claude plugin marketplace add __MARKETPLACE__` (skipped when present), then
   `claude plugin install team-relay@<marketplace name>`, or `claude plugin update` when installed.
4. Finds the install path in `~/.claude/plugins/installed_plugins.json` and from there runs
   `node <path>/dist/setup-cli.js` for the rest. One rule finds the plugin everywhere (here, the
   install check, the launcher, the daemon's update check): the first user-scope entry with an
   absolute `installPath` under exactly the key it installed, `team-relay@<marketplace name>`;
   never another scope or another marketplace's copy. In this order:
   - `login`: the browser sign-in of M5 against `__RELAY_URL__` (team chosen in the browser);
     skipped when a valid sign-in for this relay exists.
   - `folders`: shows the team's GitHub orgs and asks for the folders that hold those clones
     (one per line, empty line ends; `~` allowed; each must exist, not be `/` or `$HOME`); shows
     how many clones it found in each. Extra folders only when the team allows them. Re-running
     shows the current list and lets the member keep or replace it. When a chosen folder is under
     `~/Documents`, `~/Desktop`, `~/Downloads` or `~/Library/Mobile Documents`, one sentence says
     macOS may ask to allow "node" the first time the background answerer reads it: click Allow.
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
   - `drive`: when the team has drives, connects Google Drive (M10's Drive sign-in) unless
     connected, and says macOS may ask to allow "node" for Google Drive. Last of the steps that
     change things: a failed or cancelled Drive sign-in does not stop the setup; it says to run
     the same setup command again to connect Drive, and goes on.
   - `status`: prints the checklist of §6 from the relay's view. "Folders chosen" and "Google
     Drive connected" need nothing only when the boundaries were read and hold no orgs (or no
     drives); boundaries that could not be read leave both not known, never ticked (the console
     too).
5. Ends with the console URL and "open it to accept the boundaries".

`setup-cli.js daemon uninstall` removes the agent; `setup-cli.js` with no command prints help.

The console is at the relay's origin: one public host serves both (M10-SPEC §5), so the setup
command and the console links are that host; a relay deployed at its run.app URL only (no
`PUBLIC_HOST`) has no setup command, and `scripts/deploy.sh` warns so.

## 6. Guided join (console)

- Owners: after adding a member (M6), the console shows **Copy invite message**: the console URL,
  the team name and the setup command, in plain text.
- The invitee accepts the invitation (M9) and lands on **Join**: a checklist with live ticks from
  `GET members/status` and `me/acceptance` (polled every 5 s while the page is open):
  1. Run the setup command (copy button) - ticked when a status has arrived.
  2. Claude Code found and signed in - `claude.found && claude.signed_in`.
  3. Answering in the background - `answering`.
  4. Folders chosen - `folders.repo_roots > 0` (or the team has no orgs).
  5. Google Drive connected - `drive.connected` (or the team has no drives).
  6. Boundaries accepted - accepted version equals the current one (Accept button inline).
  7. Self-test passed - `self_test.ok`.
  Each unticked step says in one sentence what to do. All ticked: "You're set up. Ask the team"
  links to Ask.
- **Members** shows each member's progress (n of 7) and whether they are answering now.

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
  network calls are to the relay, GitHub (marketplace) and, when the member agrees, Claude Code's
  installer.
- The daemon has the member's sign-in and Drive token (as the channel server did); the child it
  runs keeps M10's limits. The LaunchAgent and launcher are the member's own files, mode 600.
- Status holds counts and booleans only: no paths, folder names, questions or answers.
