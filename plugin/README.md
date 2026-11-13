# team-relay (Claude Code plugin)

Lets the members of a small team ask each other's Claude Code sessions questions, and ask a
teammate to run one of a fixed set of named, parameterised operations (a *capability*). The
answer is pushed into the asker's session over a Claude Code channel. The contract is
`../docs/M1-SPEC.md` (this plugin is its §8, as corrected in §11), `../docs/M2-SPEC.md`
§2 and §4 (Google identity, tool events, the console), `../docs/M4-SPEC.md` (what the
answering session may read, and how a member grants more), `../docs/M5-SPEC.md` (install
with no questions, sign in with `/team-relay:login`, and its §9 corrections after the security
review), `../docs/M6-SPEC.md` (owners manage members in the console),
`../docs/M7-SPEC.md` §2 (say when questions are waiting), `../docs/M8-SPEC.md` (answers
ship on their own, within the folder you are working in) and `../docs/M9-SPEC.md` §5 and §7
(the console serves every team you are on: creating, joining by invitation and deleting teams,
and the relay admin's page). Licensed MIT (`../LICENSE`; `plugin.json` and the marketplace
entry say so, written by `pnpm generate`).

- **Working session** (your normal `claude`, started with the channel): the plugin's `relay`
  channel in *asker* role. Tools `list_teammates`, `ask_question`, `invoke_capability`,
  `request_status`, `login`, `login_wait`, `whoami` and `review_approvals` (signing out is the
  `/team-relay:logout` command, never a tool); answers, "no response yet" and "acknowledged
  but not answered" notices arrive as `<channel source="relay" ...>` events. **It also answers
  your teammates on its own** (M8, below): each question runs a short-lived, locked-down
  headless Claude in the session's folder; ordinary answers ship automatically, anything else
  waits for you (`/team-relay:approvals`).
- **Answering session** (`bin/answerer`, optional since M8): a separate, locked-down
  interactive `claude` that receives teammates' questions and capability calls, acknowledges,
  answers and replies, in its own terminal. Only one answerer runs per computer.

## Install

The repository root is a marketplace (`.claude-plugin/marketplace.json`, name
`team-relay-dev`) with this one plugin.

```
/plugin marketplace add <github-owner>/team-relay      # or a local clone's path
/plugin install team-relay@team-relay-dev
```

There are no install questions (`.claude-plugin/plugin.json` has no `userConfig`): the relay
URL defaults to the plugin's own relay (`relay.default.json`, the one place it is written),
and capabilities are enabled where they run, in the answering session's environment.

Commands (`commands/*.md`, namespaced by the plugin name):

| Command | What it does |
|---|---|
| `/team-relay:login` | Calls the `login` tool, which takes no arguments: signs this computer in to the configured relay (below). The relay's page lists your open team invitations (Accept, Decline) and lets you create a team (at most 3 per Google account). |
| `/team-relay:setup` | Calls the `setup` tool (no arguments): signs in first when needed (the `login` sign-in, waited for up to 5 minutes), then starts the setup page on this Mac (the console server on 127.0.0.1, a fresh key, opened on `/join` by way of a private redirect file) and returns at once. The page's own routes (`/api/local/*`, local only) show who is signed in, the one list of folders your Claude answers from (added only with the Mac's folder chooser, checked by the folder rules, at most 20; Remove only removes), background answering (the same LaunchAgent as `setup-cli daemon install`) and Done. It stops 3 s after Done, after 30 minutes without use, or with the MCP server; a second call reopens the same page. |
| `/team-relay:folders` | Calls the `folders` tool: `list` (the default) shows the folders on this Mac your answerer may read for your team (at most 20; inside a git repository only the files git tracks), any an earlier version's lists dropped past 20, and whether you accepted your team's boundaries; `add <path>` and `remove <path>` change one folder, each only after you confirm it in a dialog. |
| `/team-relay:logout` | Runs `dist/logout.js` itself through `bin/run-node` (the `` !`…` `` form, when the command expands): revokes this computer's credential at its relay, then deletes it. |
| `/team-relay:approvals` | Calls the `review_approvals` tool (no arguments): each answer or step waiting for your approval opens as a dialog (MCP elicitation), and you decide there (M8, below). |
| `/team-relay:answering` | Optional: prints the one command that starts a manual answering session (`"${CLAUDE_PLUGIN_ROOT}/bin/answerer"`), and the settings that share folders and offer capabilities (generated from `manifest.yaml`). |
| `/team-relay:console` | Prints the command that opens the local console (`"${CLAUDE_PLUGIN_ROOT}/bin/console" --open`). |

Every command is `disable-model-invocation: true`: only you run them, never the model on its
own.

## Running the working session

During the channels research preview a channel from your own marketplace has to be loaded
with the development flag:

```
claude --dangerously-load-development-channels plugin:team-relay@team-relay-dev
```

A SessionStart hook adds one line of context: who you are on the relay and who your
teammates are, or `Not connected: run /team-relay:login`.

### Questions waiting for you (M7-SPEC §2)

A question sent to you while your answering session is not running waits, safely, in your
inbox until one starts. The working session says so, from the relay's inbox summary
(`GET /inbox/summary`, a peek that moves no cursor and writes no presence, so any session may
read it; it never reads your inbox stream):

- **In a channel session**, at connect (so right after every sign-in) and every 60 s: when
  questions wait and your answering session is not online (it has not polled for 45 s), one
  status event: `team-relay: 2 questions from alice and bob waiting for you. Start your
  answering session: "<plugin root>/bin/answerer"` (the command `/team-relay:answering` prints;
  at most five names, `50+` past fifty). It is repeated only when the count or the senders
  change, or once an hour while they stay the same; nothing while the answering session is
  online, and an empty inbox forgets the last notice. `TEAM_RELAY_INBOX_CHECK_SECONDS` (1..60)
  shortens the interval, for tests.
- **`whoami`** (any session) adds `inbox_waiting` (the count) and, when it applies,
  `inbox_notice` (the same sentence).
- **The SessionStart line** adds the sentence (the summary is read beside `/me`, with 3 s of
  its own; nothing on failure), and **`login_wait`**'s success message appends it.
- **Open team invitations** (M9-SPEC §7.2): when the session signs in with a Google identity
  (`RELAY_AUTH=google`), `whoami` adds `invitations` (the team ids) and `invitations_notice`,
  and the SessionStart line the same sentence ("You have an invitation to team ops from olga:
  accept it on the sign-in page (/team-relay:login lists it) or in the team console."). Only
  ids reach the session, never a team's name. A stored device credential (the usual sign-in)
  or a static token cannot read them (the relay's `/v1/me/teams` takes a Google identity), and
  then nothing is said: `/team-relay:login` lists them anyway.

### Sessions without the channel

The plugin is installed for your user, so **every** Claude Code session on the machine starts
its `relay` server, but Claude Code shows `<channel>` events only in a session started with the
channel flag (and it sends the same MCP `initialize` either way, so the server cannot learn it
from the protocol). A session without the flag that read your `replies` stream would
acknowledge answers it can never show, and they would be lost. So only a *channel session*
reads a stream (`src/channel-mode.ts`):

1. `TEAM_RELAY_CHANNEL=1` or `0` in the server's environment decides, if set.
   `bin/answerer` sets `1` in the answering session's `mcp.json`.
2. Otherwise the server looks at up to 4 ancestor processes (`/proc/<pid>/cmdline` on Linux,
   else `ps -o ppid=,args=` and `ps -o comm=`, run with `execFile`, never a shell). The nearest
   `claude` process decides: it is a channel session only when its argv has
   `--dangerously-load-development-channels` or `--channels` (a space- or comma-separated list,
   or the `=` form, any number of times) with an entry `plugin:team-relay@<marketplace>`
   (`server:relay` for the answering role). The plugin name comes from the install path, so a
   renamed plugin matches its own name.
3. Anything that cannot be inspected is not a channel session: it never consumes.

A session without the channel never polls or acknowledges any stream. Its tools all work
(`list_teammates`, `ask_question`, `invoke_capability`, `request_status`, `whoami`, `login`,
`login_wait`), and every result says plainly, in `channel_note` (a sentence at the end of an
error): "This session was not started with the team-relay channel, so teammates' answers are not
shown here. Start one with: claude --dangerously-load-development-channels
plugin:team-relay@team-relay-dev" (the marketplace the plugin is installed from, when its path
names one). `ask_question` and `invoke_capability` still send, and add `where_answers_appear`:
the answer goes to a channel session (one running now, or the next one you start: it waits in
your `replies` stream), and `request_status` shows here who has acknowledged and answered. The
SessionStart line ends with the same note. A refused credential shows on the next tool call
instead of on the stream. Presence is recorded from stream reads, so only the channel session
shows you online, which is right: it is the one that receives.

### Signing in (M5-SPEC §2, §6, §9)

`/team-relay:login` runs the asker channel's `login` tool, loopback + PKCE in the style of
RFC 8252 (no device codes, so nothing to phish).

**The relay is not the model's to choose** (§9 item 1). `login` takes no arguments: it signs
in to `RELAY_URL` from the environment Claude Code was started with, else the plugin's
default relay. A team on another relay starts its working session with
`RELAY_URL=https://<relay> claude …`. A stored credential issued by a different relay than
the configured one (or a file that cannot be used) is never replaced: `login` refuses before
anything opens and says to run `/team-relay:logout` first, and the check is made again just
before a new credential is written. (The security review showed why: a model steered by
teammate text into `login` with an attacker's relay URL would otherwise have moved the
member's sign-in there silently; `test/login.test.ts` keeps that attack as a regression.)

1. It makes a PKCE verifier (64 base64url characters) and its S256 challenge, a random
   `state` (32 bytes), and an HTTP listener on **127.0.0.1 only**, on a free port, for at
   most **5 minutes**.
2. It opens your browser at `{relay}/v1/login/start?port&state&code_challenge&device`,
   through a private mode-600 redirect file (the URL never appears in a process argument,
   M2-SPEC §7.7; `TEAM_RELAY_OPEN_COMMAND` names another opener), and returns the URL at once
   in the tool result as a plain string, in case no browser opens, with the rule that it is for
   you alone: the model shows it to you once, raw, on a line of its own (not as a markdown link),
   and never repeats it to anyone else (whoever finishes a sign-in at that link decides who your
   computer is signed in as). `whoami` never repeats it.
3. On the relay you sign in with Google, see the teams your account belongs to, and choose
   one. The relay sends the browser to `http://127.0.0.1:<port>/callback?code&state`.
4. Only `GET /callback` with `Host: 127.0.0.1:<port>` and exactly one `state` equal to ours
   (compared in constant time) ends the wait (§9 item 4); a request with another Host, path,
   method or state gets a `404` and the listener keeps waiting. Cancel on the chooser comes
   back as `?error=access_denied` with the right state and ends it as "sign-in cancelled".
   The right request is answered "Connected. You can close this tab.", and the code and the
   verifier are exchanged at `POST {relay}/v1/login/token` for a device credential (`trc_…`).
5. The credential is stored in `$XDG_CONFIG_HOME/team-relay/credentials.json` (default
   `~/.config/team-relay/`), `{relay_url, team, member, credential, expires_at, email}`
   (`email`, the Google account, when the relay reports it), the directory mode 700 and the
   file mode 600, written atomically. A file or directory others could read, one owned by
   someone else, or a symlink is refused, never used. `/team-relay:login` then calls
   `login_wait` (no arguments), which blocks until the sign-in completes or fails, or 180 s
   pass, and returns "Connected as <member> (<email>) on team <team>" (§9 item 3; without the
   email from a relay that does not report it) or why it did not complete; it waits for the
   connection too, so the teammate tools work as soon as it returns. It needs no channel
   event, so it works in a session without the channel. In a channel session the channel
   also pushes the same line as a `<channel source="relay" type="status">` event, and the
   stream starts without a restart. When the new credential is a different member or team
   than the one it replaced, the result says so plainly (`changed`), and `whoami` repeats it.
   A newer `login` in the same session replaces the one being waited for, and `login_wait`
   follows it. (`TEAM_RELAY_LOGIN_WAIT_SECONDS`, 1 to 180, shortens the wait for tests.)
   A credential minted but not stored (another relay's credential appeared meanwhile, or an
   answer that fails the checks) is revoked at the relay.

With no stored sign-in the channel starts anyway, waits quietly (it looks for the file every
2 s, so a login from another session counts too), and every teammate tool answers `Not
connected: run /team-relay:login`. A credential the relay refuses (401: signed out, expired,
or removed from the team) is never retried in a loop: the tools and a status line say to run
`/team-relay:login` again (a status line only in a channel session), and a new login reconnects. `whoami` says who you are signed in
as ("Connected as <member> (<email>) on team <team>"). The credential is only ever sent to
the relay it came from.

**Signing out is a command, not a tool** (§9 item 2), so nothing a teammate writes can steer
the model into signing you out. `/team-relay:logout` runs `dist/logout.js` when the command
expands: it revokes the credential at the relay it was issued by (`DELETE
/credentials/self`, whatever `RELAY_URL` says), then deletes the file, and prints one line.
A relay that no longer knows the credential, or cannot be reached, still ends in the file
being deleted (it then expires on its own); a file that must not be used is deleted without
being sent anywhere. A working session sees the file go within 2 s and waits again.

`RELAY_AUTH` (when set) wins over the stored credential: `google` signs in with your gcloud
identity (`gcloud auth print-identity-token`, an argv, never a shell; `--account=` with
`RELAY_GCLOUD_ACCOUNT`), cached until 5 minutes before its `exp` and refreshed once on a 401;
it needs `RELAY_TEAM` (and `RELAY_URL` for another relay). `token` is for the local emulator
and tests only (the relay refuses static tokens on Cloud Run). Unset, the credential file is
used when there is one, else `google`.

## Answering automatically (M8-SPEC)

A channel working session answers the questions and capability calls teammates send you, on
its own, within the folder it works in. Nothing to start; `TEAM_RELAY_AUTO_ANSWER=0` in the
environment Claude Code starts with turns it off for that session.

**Who answers.** One answerer per computer: the session that holds
`~/.config/team-relay/answering.lock` (`$XDG_CONFIG_HOME/team-relay/…` when that is set; an
exclusively created file holding the pid, stale when that pid is gone, broken under a second
exclusive file so two sessions cannot both take a stale one; a breaker renames the stale lock
to a name of its own and checks its content before removing it, so one suspended mid-break
cannot remove a live lock taken meanwhile: it puts that one back). Only the holder reads your
`inbox` stream. Taking over is announced: the session gets a status event ("This session now
answers teammates automatically from <folder>; reads inside it are automatic.") and you get a
desktop notification. A second channel session does not answer (its `whoami` says who does) and
takes over within 30 s of the first one ending. `bin/answerer` refuses to start while a
working session answers, and its channel server takes the same lock, so the two never both
consume your inbox.

**The scope folder** is the session's working directory, resolved (symlinks). Its name is
published as your shared folder while the session answers, and withdrawn (the manifest
re-published without it) when the session stops. Reads inside it are automatic only when it
qualifies: it is inside a git work tree (a `.git`, directory or file, in it or in a folder
above it that is below `$HOME`: your home's own repository, or one above home, does not count;
outside `$HOME`, any folder above it but `/`); it is not `/`, `$HOME`, above `$HOME` or a
folder directly in `$HOME`; it is not under `~/Library` or any `~/.*` entry, and does not
contain one (symlinks resolved both ways); and it is not inside the credential deny list,
`~/.claude`, `$CLAUDE_CONFIG_DIR`, `~/.claude-team-relay` or the team relay's config
directory. Otherwise the session still answers, but reads nothing without asking, and shares
no folder; the announcement says why.

**One question, one short-lived answerer.** For each question the host acks at the relay at
once (the asker sees "acknowledged"), then, one at a time, runs:

```
cd <scope folder>   # or, when it does not qualify, an empty private directory
claude -p --output-format json --mcp-config <run>/mcp.json --strict-mcp-config \
  --settings <run>/settings.json --setting-sources '' --permission-mode default \
  --permission-prompt-tool mcp__host__permission --no-session-persistence \
  --tools Read,Glob,Grep --append-system-prompt '<fixed rubric>' \
  --disallowedTools Bash Write Edit NotebookEdit WebFetch WebSearch Agent Task
```

with the question on stdin (never in a process argument), framed between markers made of a
random nonce as teammate data. `node dist/answer-dry-run.js` in a folder prints exactly this
for that folder (with the settings and MCP config); `--run --offline` also runs it against a
closed local API port, so Claude Code parses every flag, loads both MCP servers and binds the
permission tool without a model call. What was checked against Claude Code 2.1.282 and its
docs (24 Sep 2026):

- `-p` uses your normal login (OAuth or keychain; only `--bare` would skip it). The run's
  environment is yours reduced to what Claude Code needs to run and sign in (`PATH`, `HOME`,
  locale, proxies, `ANTHROPIC_*`, `CLAUDE_CODE_USE_{VERTEX,BEDROCK,FOUNDRY}`, cloud provider
  settings, `CLAUDE_CONFIG_DIR`): nothing of the working session (its session ids, messaging
  socket) and nothing of the relay's sign-in reaches it. Auto memory is off
  (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`).
- `--setting-sources ''` is accepted and loads no user, project or local settings: none of
  your hooks, no plugin you installed (the run's init lists only Claude Code's built-in ones),
  no CLAUDE.md, and nothing from the folder's own `.claude/` or `.mcp.json`. `--settings`
  still applies, and its hooks run. `--strict-mcp-config` keeps every MCP server but the two
  below out.
- Without `--tools`, a `-p` session also has scheduling, messaging, remote-trigger, workflow,
  worktree and skill tools; `--tools Read,Glob,Grep` leaves exactly those three built-ins
  (MCP tools are unaffected).
- `--permission-prompt-tool`: Claude Code calls `mcp__host__permission` with `{tool_name,
  input, tool_use_id}` for any tool use no rule decides (deny rules are applied first) and
  expects one text block with `{"behavior":"allow","updatedInput":<input>}` or
  `{"behavior":"deny","message":"…"}`; anything else is a deny.
- In the default permission mode a read inside the working directory needs no approval, and a
  symlink inside it that points outside still prompts; deny rules match either the link or its
  target.

`mcp.json` (mode 600 in a mode-700 private directory the run cannot read) has exactly two
servers: `host` (`dist/answer-tools.js`: `reply`, `request_approval`, `permission`), which
talks back to the host over a Unix socket (mode 600, in a mode-700 `mkdtemp` directory) and
must first present that run's own 32-byte token; and `capabilities` (the M1 capability server),
when you enabled any capability (`CAP_<NAME>_ENABLED` and `CAP_<NAME>_RUNNER` in the
environment your working session starts with). `settings.json` allows `mcp__host__reply`,
`mcp__host__request_approval` and `Read(//<scope>/**)` (when the folder qualifies), and denies
the tools above plus the whole credential deny list of `bin/answerer` (it applies inside the
folder too: `.env`, `*.pem`, `credentials.json` …), the host's private directory, the relay
credential and `$CLAUDE_CONFIG_DIR`. Its hooks are the plugin's own: the read trail (below)
and tool events (name, outcome, duration) for the asker's console. A run has 10 minutes of its
own time (time spent waiting for you does not count) and is stopped at the question's answer
deadline plus 60 s whatever it is doing.

**The read trail.** The host learns which files the answerer read, from hooks in its
`settings.json` that report over the private socket (`node dist/read-trail.js --config
<run>/read-trail.json`, the run's token in a mode-600 file the answerer cannot read):
PreToolUse for Read and Grep reports the path about to be read or searched, and blocks the
tool when the report cannot be made; PostToolUse and PostToolUseFailure for Grep report the
files a search matched. An answer written after reading or matching a file whose name
suggests secrets (`*.tfstate`, `secrets.*`, `*.properties`, `docker-compose*`, `kubeconfig`,
`*service-account*.json`, `.npmrc`, `.netrc`, `.git-credentials`, `.dev.vars`, `id_ecdsa*`,
`id_dsa*`, `*.ppk`, `*.pem`, `*.key`, `*.p12`), or while a search's matches were never
reported, waits for you.

**What ships on its own, and what waits for you** (§3), decided by the host, not the model:

| Ships automatically | Waits for your approval |
|---|---|
| Reading files inside the scope folder (minus the deny list) | Any read outside it, and every capability tool: the `permission` tool holds the call |
| An answer the answerer did not flag, that passes the secret screen and the read trail, when nothing needed approval during the run | An answer the answerer flags (`needs_approval`: people, customers, credentials, infrastructure, production, not grounded, unsure) or asks approval for (`request_approval`) |
| | An answer the secret screen flags: private keys and key bodies; provider tokens and API keys by prefix and entropy; hex strings of 32 or more characters (hashes too) and padded base64; `KEY=value`, `key: value` and JSON pairs whose key names a secret (`password`, `secret`, `token`, `pass`, `pwd`, `pw` …); prose that states one ("the password for staging is …"); URLs with credentials in any form (`user:pass@`, `:pass@`, a token as the user, `?access_token=`, signed-URL parameters). Secrets split across lines, spaced out, or spelled with invisible characters, full-width or look-alike letters are found too |
| | An answer after reading a file whose name suggests secrets, or while a search was not recorded (the read trail) |
| | An answer produced after anything needed approval during the run |
| | Any question past the volume limits: more than 3 from one teammate waiting to be answered, or more than 20 automatic answers in the last hour; it waits for your approval to be answered at all (Answer it / Don't answer / Decline politely) |

Denied without asking you: credential paths (even when the model names them, or a Glob
pattern or Grep glob names them: a pattern's fixed prefix, and the pattern itself, are checked
against the deny list first), any other built-in tool, a capability tool for a question
(capabilities run only for a capability call, with exactly its params and request id). A
capability call therefore asks you twice: before it runs, and before its result is sent. A
path that resolves elsewhere is shown with where it really leads (`…/proj/link →
/elsewhere/x`).

**Deciding.** When something starts waiting, the working session gets a status event
(`team-relay: alice asked: "…" — an answer is waiting for your approval (1 pending). Run
/team-relay:approvals.`; the question is quoted as teammate data, on one line, neutralised
and cut at 200 characters), a desktop notification with a fixed text, and the asker's console
a `waiting` tool event ("waiting for bob"). They are grouped: at most one desktop
notification every 5 minutes, and within 5 minutes of a status event that quoted a teammate
the next ones carry counts only (`team-relay: another item is waiting for your approval (2
pending).`). `/team-relay:approvals` then shows each item as a
dialog (MCP elicitation: Claude Code 2.1.282 advertises it and renders flat forms of strings,
numbers, booleans and single-choice enums): the teammate's text quoted, what is asked (the
path, the capability and its params, or the draft exactly as it would be sent, each line
marked with `> `), why it waits (what the answerer wrote is labelled as its own words), and
one choice: Allow / Deny, or Send / Don't send / Decline politely ("I couldn't answer this
automatically; <you> hasn't approved it."). Send is offered only when the dialog shows the
whole draft exactly: the length measured is the length shown, and a draft with control,
direction or invisible characters (shown escaped) or a channel tag cannot be sent from a
dialog or the page. The dialog's own Decline or Esc leaves it pending.
The decision is yours, in the dialog: the model that runs the command only gets the counts.
A Claude Code without elicitation gets the approvals on a local page instead (127.0.0.1, a
random port and a per-launch key, the console server's rules), opened in your browser through
the same private redirect file as `bin/console --open`; the command says so. Anything you have
not decided is denied when the question's answer deadline passes or after 30 minutes,
whichever is sooner; a lapse sends nothing (the relay's "acknowledged but not answered"
applies).

**Nothing lost on stop.** The host moves your inbox cursor past a question only once it is
fully handled (answered, declined or lapsed), never past one still open. A question in flight
or waiting for you when the session closes is withdrawn, not decided, and the next host
receives it again (at least once); one the relay says is already answered is skipped.

**What approvals rely on.** Your decision is yours only while nothing else can answer the
dialog for you. The working session must have no `Elicitation` or `ElicitationResult` hook
(in your settings, a project's or a plugin's) that could accept a dialog, and no
auto-allowed `Bash` (an allow rule, auto mode or `--dangerously-skip-permissions`) with which
its model could answer the page or run the plugin's tools as you. The plugin cannot see or
change that session's settings; this is a documented limit.

**Seeing it.** `whoami` adds `answering_automatically`, `answering_folder`,
`approvals_pending` and `approvals_notice`; the SessionStart line of any session says "N
answers waiting for your approval: run /team-relay:approvals in your channel working
session"; the local console's header shows the count (`GET /api/approvals/summary`, answered
by the console server from `~/.config/team-relay/approvals.json`, which holds only the host's
pid and the count). The hosted console cannot see a laptop's queue: it shows the `waiting`
tool events.

| Variable (in the environment Claude Code starts with) | |
|---|---|
| `TEAM_RELAY_AUTO_ANSWER=0` | this channel session does not answer automatically |
| `TEAM_RELAY_CLAUDE_BIN` | absolute path of the `claude` to run (default: `claude` on `PATH`) |
| `TEAM_RELAY_ANSWER_MODEL` | a model for the answerer (default: Claude Code's) |
| `TEAM_RELAY_DESKTOP_NOTIFY=0` | no desktop notification (the status event still comes) |
| `CAP_<NAME>_ENABLED`, `CAP_<NAME>_RUNNER`, `ALLOW_PRODUCTION`, `MANIFEST_PATH` | the capabilities you offer, as for `bin/answerer` |

## Answering in the background (M11-SPEC)

On macOS a background answerer answers teammates while your computer is on, without a Claude
Code window open. The setup command from the console's Join page installs it; `dist/setup-cli.js`
holds its steps, and each can be run again:

```
node dist/setup-cli.js login [--relay <url>]          # skipped when already signed in to that relay
node dist/setup-cli.js folders                        # choose the folders your Claude answers your team from
node dist/setup-cli.js daemon install --claude <abs path of claude> --plugin team-relay@<marketplace>
node dist/setup-cli.js daemon uninstall
node dist/setup-cli.js status [--after-setup]         # your setup checklist (--after-setup: wait for the first check-in)
```

Claude Code starts the plugin's servers, its SessionStart hook and the `!` lines of its commands
with `/bin/sh bin/run-node <script>`, never `node` from PATH: `bin/run-node` uses the first `node`
in an absolute PATH entry when it is 22.12 or newer, else the newest Node.js the setup line installed in
`~/.local/share/team-relay/node-v<version>-*`. On a Mac with neither it gets the pinned build itself
(`bin/node-pins.sh`, the same version and SHA-256 the setup line uses): it downloads the tarball
from nodejs.org over https, refuses it unless its SHA-256 is the pinned one, unpacks it and renames
it into that same folder, then runs it. One start downloads at a time; the others wait for it, up to
120 s. When that fails it removes what it downloaded and says in one line why ("Could not get
Node.js for the team relay: ... Check your internet connection and restart Claude."). Anywhere
else it says in one line to paste the setup line again (M11-SPEC "Simpler joining" §3).

`daemon install` writes `~/.config/team-relay/daemon-launch.mjs` (at each start it finds the
plugin installed for you under exactly that `team-relay@<marketplace>` key in
`~/.claude/plugins/installed_plugins.json` and starts its `dist/daemon.js`) and the per-user
LaunchAgent `~/Library/LaunchAgents/com.team-relay.answerer.plist`, then loads it. It refuses
when nothing is installed under that key. Files are readable by you only.

The first time the background answerer reads a folder in Documents, Desktop, Downloads or iCloud
Drive, macOS may ask whether "node" may access it: click Allow. A refusal is
written to the log.

The background answerer:

- answers only from the folders you chose (inside a git repository only the files git tracks;
  credentials and secret-looking names never), on your team's topic, once you accepted your
  team's boundaries; a team without boundaries
  gets "not set up yet", it never answers from a folder, runs no capabilities and asks for no
  approvals;
- holds the answering lock as `daemon`, so a working session or `bin/answerer` on the same
  computer does not read your inbox while it runs;
- reports to the relay every minute only counts and yes/no facts (signed in, how many folders
  you chose, self-test result), never a path, question or answer; owners see the count, nobody
  sees the folders' names;
- runs a self-test at start and every 6 hours, with no network (the first one beside connecting);
- writes `~/Library/Logs/team-relay/daemon.log` (yours only, 5 MB, one older file kept) with
  events and request ids, never question or answer text;
- finishes its current answer and restarts when the plugin is updated; stops within 15 s of
  `launchctl bootout` or `daemon uninstall`.

You accept your team's boundaries in the team console (Join or Team page), never on this
computer: the relay keeps the version you accepted, and when the relay cannot say it, questions
are declined as busy. `TEAM_RELAY_DESKTOP_NOTIFY=0` turns off its desktop notifications.

## Running the answering session

Optional since M8: a channel working session answers on its own (above). The manual session
is the alternative when you want to answer in a terminal of your own; start your working
sessions with `TEAM_RELAY_AUTO_ANSWER=0`, since only one answerer runs per computer.

```
# after /team-relay:login: no relay settings needed
export CAP_STAGING_DB_QUERY_ENABLED=true
export CAP_STAGING_DB_QUERY_RUNNER=/absolute/path/to/your/runner
export ANSWERER_READ_DIRS=~/src/orders-service:~/notes/runbooks   # optional: folders it may read without asking
bin/answerer
```

**Nothing is readable by default** (M4-SPEC §1). The answering session reads a local file
only when it is inside a folder you share, or when you allow it at the moment it is needed:

- **Shared folders** (`ANSWERER_READ_DIRS`, optional, `:`-separated, at most 16, `~/`
  allowed): readable without asking. Share folders deliberately: a teammate's question can
  ask for anything in them. Each entry must be an existing directory (after `~` and symlinks
  are resolved) that is not `/`, not your home directory, not above it, and not inside
  `ANSWERER_HOME`, `~/.claude`, `CLAUDE_CONFIG_DIR` or a credential location on the deny list
  below; otherwise `bin/answerer` refuses to start, naming the entry and the reason. Their
  names (the basename only, never the path; characters outside `A-Z a-z 0-9 . _ -` become
  `_`) are published to your team with your capabilities, so the console shows
  "Shares: orders-service, runbooks".
- **Grants, per request:** any other `Read`, `Glob` or `Grep` opens Claude Code's own
  permission dialog in the answering session's terminal, naming the path. Allow it once,
  allow that folder for the rest of the session, or deny it. A desktop notification tells you
  when the dialog is waiting, and the asker's console shows "waiting for <you> to allow
  access" (below). Grants last at most for the session: `bin/answerer` starts every session
  with none (it removes the working directory's `.claude/settings.local.json`, where "don't
  ask again" is saved).
- **Never:** credentials and other secrets on the deny list stay unreadable whatever you
  answer (deny rules beat an approval), and no dialog can enable `Bash`, `Write`, `Edit`,
  `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent` or `Task`.

`bin/answerer` creates `${ANSWERER_HOME:-~/.claude-team-relay/answerer}` (mode 700) with:

- `mcp.json`: the `relay` channel in *answerer* role and the `capabilities` server, with the
  settings passed explicitly. With the stored sign-in (the default after `/team-relay:login`;
  `dist/credential-info.js` checks the file by the same rules and prints only its relay,
  team and member) the servers get `RELAY_AUTH=credential` and `RELAY_CREDENTIALS_FILE`, its
  absolute path, and the relay and team come from it (`RELAY_URL` / `RELAY_TEAM`, when set,
  must agree). Without one and with `RELAY_AUTH=google` no token is stored:
  the servers run gcloud themselves (`PATH`, `RELAY_GCLOUD_ACCOUNT` and any `CLOUDSDK_*`
  settings are passed through), and a `token` file left by an earlier token-mode run is
  removed. With `RELAY_AUTH=token` the token is handed over as `RELAY_TOKEN_FILE`; a
  `RELAY_TOKEN` value is written to `token` (mode 600) and never into `mcp.json`, and it is
  removed from the session's environment.
- `settings.json`:
  - `permissions.defaultMode` `default` (Claude Code's Manual mode: anything not allowed
    prompts), with auto mode and bypass mode disabled for the session
    (`disableAutoMode`, `disableBypassPermissionsMode`); the command also passes
    `--permission-mode default`;
  - allows `mcp__relay__*`, `mcp__capabilities__*` and one `Read(//<folder>/**)` per shared
    folder (the physical path, glob characters escaped). There is no bare `Read`, `Glob` or
    `Grep` allow: Claude Code applies `Read` rules to `Glob` and `Grep`;
  - denies `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent`, `Task`;
  - denies reading credential stores and other secrets with `Read(...)` path rules only.
    Claude Code evaluates path rules for `Read` (and applies them to `Glob` and `Grep`); a
    `Glob(...)` or `Grep(...)` path rule is accepted but never consulted, so there are none
    (M2-SPEC §7.5). In the home directory: `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/**`,
    `~/.config/gcloud/**`, `~/.azure/**`, `~/.kube/**`, `~/.docker/**`, `~/.netrc`,
    `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.claude/**`,
    `~/.claude-team-relay/**`, `~/.config/team-relay/**` (the relay's own credential),
    `~/Library/Keychains/**`, `~/.config/gh/**`,
    `~/.zsh_history`, `~/.bash_history`, `~/.*_history`,
    `~/Library/Application Support/**/Cookies*`, `~/Library/Application Support/Firefox/**`,
    `~/Library/Application Support/Google/Chrome/**`, `~/.terraform.d/**`,
    `~/.cargo/credentials*`, `~/.vault-token`, `~/.pgpass`, `~/.config/solana/**`,
    `~/.foundry/**`, `~/.ethereum/**`;
  - anywhere, each as written (`**/x`), home-anchored (`~/**/x`) and root-anchored
    (`//**/x`), because a `**/x` rule resolves from the session's (empty) working directory:
    `.env`, `.env.*`, `.envrc`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`, `*.pfx`,
    `*.keystore`, `*.jks`, `credentials.json`, `*.tfvars`, `keystore/**`;
  - and the session's own files: `~/.claude.json`, `ANSWERER_HOME`, the token file (token
    mode), the credential file and its directory (also `$XDG_CONFIG_HOME/team-relay` when
    set), `CLOUDSDK_CONFIG` and your own `CLAUDE_CONFIG_DIR` when set (literal paths, with
    glob characters escaped);
  - `PostToolUse`, `PostToolUseFailure` and `PermissionRequest` hooks (exec form,
    `"async": true`, so they run in the background and never delay a tool call or a dialog)
    running `node dist/tool-event.js --config $ANSWERER_HOME/tool-event.json` (below);
  - a `Notification` hook for `permission_prompt` only (exec form, async) running
    `node dist/notify-desktop.js` (below).
- `tool-event.json`: the hook's relay settings (URL, team, sign-in mode, account, token file
  or credential file path, state directory); no secret.
- `state/` (mode 700): `active.json`, the requests this session has acknowledged and not yet
  answered (ids and times only, each with its answer deadline), written atomically by the
  answering channel, which clears it when it starts. An entry past its answer deadline is
  dropped whenever the file is read (M2-SPEC §7.6). The deadline comes from the question or
  capability call the channel pushed, else the ack response, else `GET /requests/{id}`; when
  none of them gives one, the longest answer window the relay allows (24 h from the ack).
- `config/`: the session's own `CLAUDE_CONFIG_DIR`, so none of your memory, `CLAUDE.md`,
  plugins or hooks load. The first run there needs a login (or Vertex env, which passes
  through).

The session's working directory is **not** under `ANSWERER_HOME`: Claude Code loads memory
files from every ancestor of its working directory, which `CLAUDE_CONFIG_DIR` does not cover,
and your home directory holds your own `~/.claude/`. So it runs from
`${TMPDIR:-/tmp}/team-relay-answerer-<uid>/work` (both levels mode 700, created when missing,
owned by you and never a symlink), or from `ANSWERER_WORKDIR` when set (an absolute path).

Before anything else the launcher removes the working directory's
`.claude/settings.local.json` (and `.claude/` when that leaves it empty): outside a git
repository, that is where Claude Code saves a "don't ask again" answer, and grants must not
outlive the session. It never removes through a symlink or in a directory you do not own. It
then refuses to start, before writing anything, when `ANSWERER_READ_DIRS` has an entry it
refuses (above), or when the working directory:

- is inside `$HOME` (compared after resolving symlinks; a `TMPDIR` inside `$HOME` needs
  `ANSWERER_WORKDIR`),
- is not empty (anything besides that one file), or
- or any ancestor contains `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`,
  `.claude/rules/`, `.claude/settings.json` or `.claude/settings.local.json`.

It then runs `claude --mcp-config … --strict-mcp-config --settings … --permission-mode default
--disallowedTools Bash Write Edit NotebookEdit WebFetch WebSearch Agent Task
--dangerously-load-development-channels server:relay` from that directory. Extra arguments are passed through to `claude`.
`bin/answerer --print-command` writes the files and prints the command instead of running it.

At startup the answering channel publishes your discovery payload: the manifest restricted
to the capabilities this session will actually run, and `shares`, the names of your shared
folders (an empty list when you share none), validated against the same schema the relay
uses.

**These are permission rules, not an OS sandbox.** Claude Code enforces them for its own
file tools; nothing stops another process your user runs from reading a file. Whatever is in
a shared folder, and whatever you allow in a dialog, a teammate can ask for and the session
can read. The deny rules cover the usual credential stores, not every secret on your machine
(a key under another name, a database dump, a document), so do not share a folder that
holds one, and read the path in a dialog before you allow it. The instructions tell the
session never to try to read credentials and never to send secrets to teammates, but that is
an instruction to a model, not a boundary.

### Seeing a grant happen (M4-SPEC §2)

- **You:** when a permission dialog has waited about six seconds (Claude Code's timing for
  `permission_prompt` notifications), `dist/notify-desktop.js` shows a desktop notification
  with a fixed text, "Team relay: your answering session is waiting for your permission", via
  `osascript` on macOS or `notify-send` on Linux when it is installed (nothing elsewhere). It
  reads the hook input only to check that it is a permission prompt; no text from the hook
  input or from a teammate is ever passed to the notifier, and it runs no shell. It always
  exits 0 and gives up after 3 s.
- **The asker and the team:** the `PermissionRequest` hook posts a tool event with
  `status: "waiting"` (the tool's name only, never the path) to the request being answered.
  The console shows "waiting for <you> to allow access" in amber until the next event for
  that tool arrives. If you deny, no event follows (Claude Code runs no hook for a denied
  dialog), so the console shows the waiting state until the next tool event or the answer.

### Tool events (M2-SPEC §4.3)

Every tool call in the answering session (and every failed one), and every permission
request, runs `dist/tool-event.js`.
It takes the tool's name from the hook input (an `mcp__<server>__` prefix stripped; the
relay's own `ack_question` and `reply` are skipped), finds the most recently acknowledged
open request in `state/active.json` (none open: nothing is sent), and posts
`{"tool", "status": "ok"|"error"|"waiting", "duration_ms"}` to that request's
`/requests/{id}/events` (`waiting` for a permission request, with no duration). Claude Code's hook input carries `duration_ms` (the tool's run time)
on both events, so it is sent when present. The tool's input, output and error text are
never sent. The hook runs asynchronously, the script always exits 0 and gives up after 3 s,
so a slow or unreachable relay never holds up the session. A request past its answer deadline
is no longer open, so tool calls after it are not reported.

### Environment

| Name | Used by | Meaning |
|---|---|---|
| `RELAY_URL` | both servers, `bin/answerer`, `login` | Relay base URL. From the stored sign-in by default; otherwise the plugin's default relay. The only way to make `/team-relay:login` sign in to another relay (M5-SPEC §9). |
| `RELAY_TEAM` | both servers, `bin/answerer` | Team id. From the stored sign-in by default; needed for `google` and `token`. |
| `RELAY_AUTH` | both servers, `bin/answerer`, `bin/console` | Unset: the stored credential if there is one, else `google`. `credential`, `google` (`gcloud auth print-identity-token`) or `token`; `metadata` (the runtime service account) for the hosted console. |
| `RELAY_CREDENTIALS_FILE` | every part | Optional: the credential file's absolute path. Default `$XDG_CONFIG_HOME/team-relay/credentials.json` or `~/.config/team-relay/credentials.json`. |
| `TEAM_RELAY_OPEN_COMMAND` | `login`, `bin/console --open` | Optional: an absolute path to the program that opens the browser, given only the redirect file's path (tests use a stub). |
| `RELAY_GCLOUD_ACCOUNT` | both servers, `bin/answerer`, `bin/console` | Optional, with `google`: `--account=` for gcloud (an email address). |
| `RELAY_TOKEN_FILE` / `RELAY_TOKEN` | both servers, `bin/answerer`, `bin/console` | Only with `token`: bearer token; the file wins, trailing newline stripped, re-read on every request. |
| `RELAY_ROLE` | channel | `asker` or `answerer`. |
| `TEAM_RELAY_INBOX_CHECK_SECONDS` | asker channel | Optional, 1..60 (default 60): how often a channel session checks for questions waiting for your answering session (tests shorten it). |
| `MANIFEST_PATH` | answerer channel, capability server | Defaults to this plugin's `manifest.yaml`. |
| `ALLOW_PRODUCTION` | answerer channel, capability server | Only the exact value `true` allows production capabilities. |
| `CAP_<NAME>_ENABLED` | answerer channel, capability server | Only `true` enables `<name>` (`NAME` is the capability name uppercased). |
| `CAP_<NAME>_RUNNER` | answerer channel, capability server | Absolute path of an executable regular file. |
| `ANSWERER_READ_DIRS` | `bin/answerer` | Optional: the folders the answering session reads without asking, `:`-separated, at most 16 (`~/` allowed). Refused entries stop the launcher. Their basenames are published as `shares`. |
| `ANSWERER_SHARES` | answerer channel | Set by `bin/answerer`: the JSON list of shared folder names to publish. |
| `ANSWERER_HOME` | `bin/answerer` | Where the session's configuration lives (`mcp.json`, `settings.json`, `tool-event.json`, `config/`, `state/`). Default `~/.claude-team-relay/answerer`. |
| `ANSWERER_STATE_DIR` | answerer channel | Set by `bin/answerer` to `$ANSWERER_HOME/state`: where `active.json` is kept. |
| `CONSOLE_PORT` | `bin/console` | Default 4317; `0` picks a free port. |
| `JOIN_MARKETPLACE` | console server | Optional: the marketplace source in `GET /api/join` (a GitHub `owner/repo`, or a plain `https://` URL). Consoles before "Simpler joining" (M11-SPEC) showed it in their join panel; the current console does not. |
| `JOIN_REPO_URL` | console server | Optional: the `https://` URL of this repository; a GitHub URL becomes the marketplace source when `JOIN_MARKETPLACE` is unset. |
| `CONSOLE_MODE` | console server | `local` (default) or `hosted` (the container only). |
| `PORT`, `CONSOLE_PUBLIC_HOST`, `IAP_AUDIENCE` | hosted console | Listening port (default 8080), the exact public host, the IAP audience. |
| `CONSOLE_IP_HASH_SALT` | hosted console | Required, at least 32 characters (a secret): salts the viewer's address before it is hashed for the relay's per-address team creation limit (M9-SPEC §7.6). |
| `ANSWERER_WORKDIR` | `bin/answerer` | The session's working directory: absolute, outside `$HOME`, empty. Default `${TMPDIR:-/tmp}/team-relay-answerer-<uid>/work`. |

A capability is offered only when it is enabled, its runner is an executable regular file,
and it is staging data or `ALLOW_PRODUCTION=true`.

A capability tool runs only for the request it names. Before starting the runner the
capability server reads `GET /requests/{request_id}` from the relay as you and requires a
directed (not broadcast) capability request for that same capability, addressed to you, not
yet answered by you and not expired, whose params equal the tool's arguments after defaults
(compared key-order-independently). Anything else is a tool error and the runner never
starts, so the answering Claude cannot be talked into running a capability for a broadcast
question, for another capability's request or with other params.

### Writing a runner

A runner is any executable. It is started **without a shell and without arguments**, with
only `PATH`, `HOME`, `LANG` and `CAPABILITY_NAME` in its environment. It reads one JSON line
on stdin, `{"capability": …, "params": {…}, "request_id": "rq_…"}` (params already validated
against the manifest, defaults filled), and prints one JSON **object** (at most 64 KiB) on
stdout; it becomes the reply's `data`, so an array, string, number or `null` is a tool error. Lines on stderr of the form `{"progress": "text", "pct": 40}` are reported to the
relay as progress (visible through `request_status`, never pushed into anyone's session);
other stderr lines go to the capability server's log. The manifest's `timeout_seconds` is
enforced with SIGTERM, then SIGKILL 5 s later. `test/fixtures/fake-runner.mjs` is a
synthetic example.

## The console (M2-SPEC §4.4)

```
bin/console --demo --open     # synthetic teams (demo: alice, bob, carol; more below), no relay needed
bin/console --open            # your team, with your stored sign-in (or the RELAY_* settings above)
```

`bin/console` runs `node dist/console-server.js`, which binds **127.0.0.1 only** and prints
`http://127.0.0.1:<port>/#k=<key>`; the key is 32 random bytes made for this launch and
travels in the URL fragment, which the browser never sends to a server. The console sends
it back as `X-Console-Key` on every API call. The server:

- refuses any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS
  rebinding), any `/api/*` call without the key (401) or with a wrong one (403, compared in
  constant time), and any call the browser marks cross-site; it sends no CORS headers;
- proxies six GETs to the relay with your own credentials: `/api/me`, `/api/directory`,
  `/api/activity` (`since`, `limit`), `/api/requests/{id}`, `/api/roster` (M6-SPEC §2) and
  `/api/inbox/summary` (M7-SPEC §3: the header's "2 questions waiting for you"; agent cards
  show "<n> waiting" from the directory's `inbox_waiting`, both only while that answering
  session is not online);
- proxies an owner's roster changes and nothing else (M6-SPEC §3): `POST /api/roster`
  `{member, email, role?}`, `PATCH /api/roster/{member}` `{add_email?, remove_email?, role?}`
  and `DELETE /api/roster/{member}`. Each needs `Content-Type: application/json` (else 415)
  and `Sec-Fetch-Site: same-origin` (else 403, before anything is read), a body of at most
  4 KiB that is checked here (known fields only, a member id, lower-cased emails) before it is
  sent on once, never retried. The relay decides whether you are an owner. Every other
  method and path is refused: nothing can be sent, acked or replied from the console;
- serves several teams (M9-SPEC §5): every team-scoped route above (and `/api/join`) takes the
  team from a `team` query parameter or an `X-Relay-Team` header (the same value when both
  are sent; not a team id, twice, or different: 400), checked against the viewer's **active**
  teams from the relay's `GET /v1/me/teams`, kept 15 s per viewer and read again after any
  change to them. Without either, `RELAY_TEAM` is the team, and only when the viewer is on it.
  Any other team answers `403 {"error": "not_on_team", "email"?, "team"}` and the relay is not
  asked. A sign-in bound to one team (a stored device credential, or a static token) reaches
  that team only, with no `/v1/me/teams` call;
- the account routes, each a change with the roster changes' rules (JSON, same origin, at most
  4 KiB, checked here, no query, sent once): `GET /api/teams` (the viewer's teams and
  invitations, `admin`, `teams_created` of `max_teams_created`, `suggested_member`,
  `can_manage_teams`, `default_team`, and hosted the viewer's email; for a bound sign-in its
  one team from `/me`), `POST /api/teams` `{name, id?, owner_member_id}` (create; the name is
  trimmed, 1 to 60 characters with no control or invisible characters; the id
  `^[a-z][a-z0-9-]{2,31}$`), `POST /api/invitations/{team}` `{"accept": true|false}`,
  `DELETE /api/teams/{team}` `{"confirm": "<team id>"}` (a team the viewer is on; the relay
  checks they own it), `GET /api/admin/teams?after=&limit=` (1..1000) and `DELETE
  /api/admin/teams/{team}` `{"confirm": "<team id>"}` (the relay decides who is an admin). A
  confirmation that is not the team id is refused here (400);
- passes a relay refusal on as `502 {"error": "relay_refused", "relay_status",
  "relay_error", "detail"}`, so the panel or dialog can say why a change was refused
  (`team_id_unavailable`, `team_name_unavailable`, `team_limit`, `rate_limited`, `seed_team`,
  and so on);
- answers `GET /api/join` itself, never proxying it, behind the same key (IAP when hosted,
  and then only to a member of the team, below): `{"relay_url", "team", "repo_url", "marketplace_source", "marketplace":
  "team-relay-dev", "plugin": "team-relay", "default_relay"}` from the relay and the team asked about,
  `JOIN_MARKETPLACE` and `JOIN_REPO_URL` (`null` when unset; demo values with `--demo`);
  `default_relay` says whether the plugin's default relay is this one (else the panel's
  working-session command starts with `RELAY_URL=<relay>`; `/team-relay:login` takes no
  relay URL). The current console reads only `relay_url` from it (the local console's setup
  line, M11-SPEC "Simpler joining"); the other fields served the join panel of older consoles. Nothing in it is secret; a
  `JOIN_REPO_URL` or `JOIN_MARKETPLACE` that is not plain stops the server at startup;
- with `--open`, opens the console without putting the key in any process's arguments
  (which other local users can list): it writes a mode-600 HTML file that redirects to the
  URL into a private temp directory (mode 700), hands the browser opener (`open` on macOS,
  `xdg-open` on Linux) that file's path, and deletes it after 10 s or when the server
  stops, whichever is first (M2-SPEC §7.7);
- serves the built console from `dist/console/` (built from `../console/`) under a strict
  CSP (`default-src 'self'`, no inline script or style, no external requests), and a
  placeholder page when that directory is missing.

The console's header has a team switcher (your teams, your open invitations with Accept and
Decline, *Create team*, and *Admin* for relay admins); it remembers the last team in the
browser (`localStorage`, when the browser allows it). An owner's Members panel shows people
they invited as *Invited* with *Withdraw*, and *Team settings* has *Delete team* (type the id to
confirm; the relay refuses its configured teams). Someone on no team sees their invitations
and *Create a team*. The admin page (`/admin`) lists every team a page at a time (id, name,
status, members, owners, created, last activity; no emails, no content) with *Delete* after the
id is typed. Screenshots: `../console/screenshots/`.

`--demo` serves several synthetic teams: alice owns `demo` (the scripted one below, from the
team file, so it cannot be deleted; dana is invited) and `research`, a quiet team she created;
she is invited to `ops` and is a relay admin, so the admin page lists other people's teams
too. Creating (at most 3), accepting, declining and deleting follow the relay's rules and
refusals, in memory. The `demo` team is a scripted, looping stream in the relay's own shapes:
every minute a
directed question, a capability call with progress and a tool event, a broadcast one
teammate never acknowledges (`no_response`), a question between two teammates (you see its
metadata, not its text), an acknowledged question that is never answered (`timed_out`), a
capability call between two teammates, and a broadcast to you and a teammate that you both
answer (you see only your own answer). It follows the relay's rules too (M2-SPEC §7): each
request's `updated_at` strictly increases, a feed page never splits requests that share one
`updated_at`, deadlines are recorded by a sweep a moment after they pass (so the console's
effective status shows), and the directory carries `stats_complete`, `open` by effective
status, `answered` by `answered_at` in the window and the median to 3 decimals.

### The hosted console (M3-SPEC §3)

The same server runs in a container on Cloud Run behind IAP (`Dockerfile.console`,
`cloudbuild.console.yaml`; build context is the repository root) with `CONSOLE_MODE=hosted`:

- listens on `0.0.0.0:$PORT` (default 8080), prints nothing and makes no key; the `Host`
  must equal `CONSOLE_PUBLIC_HOST` (the service's `run.app` host) exactly, else 403;
- every request, static files included, needs a valid `x-goog-iap-jwt-assertion`: ES256
  only, signed by a key from `https://www.gstatic.com/iap/verify/public_key-jwk` (cached per
  its Cache-Control, one fetch at a time, an unknown `kid` refetches at most every 5
  minutes), `iss` `https://cloud.google.com/iap`, `aud` exactly `IAP_AUDIENCE`, `exp` and
  `iat` within 30 s of skew, and an `email` claim. Anything else is a bare `401`; the reason
  is logged, the token and the email never are;
- proxies the same routes, with the service account's ID token (`RELAY_AUTH=metadata`,
  required in hosted mode) and `X-Relay-On-Behalf-Of: <viewer email, lower-cased>`; the
  relay acts as that member (M3-SPEC §2; roster changes need the delegate's `manage-roster`
  scope and an owner, M6-SPEC §3);
- serves every team the viewer is an active member of (M9-SPEC §5): the relay's delegate
  entry for the console is `team: "*"` with `scope: [read, manage-roster, manage-teams]`
  (`../relay/README.md`, "The any-team delegate"); `RELAY_TEAM` is the default team only;
- answers `403 {"error": "not_on_team", "email", "team"}` for a team the viewer is not an
  active member of (IAP admits any Google account, M6-SPEC §5; an invitation is not
  membership, M9-SPEC §7.2), before anything is asked of the team; the relay's own refusal
  of a non-member (the any-team delegate's `404`, a per-team delegate's `403 not_a_member`)
  answers the same and drops the viewer's cached teams. Someone on no team gets their
  invitations and "Create a team", and no data. A plain `401` from the relay is the console's
  own sign-in failing (a setup problem) and is shown as such;
- answers `GET /api/join` only to an active member of the team asked about (M6-SPEC §7 item 6);
- creates a team for the viewer with `X-Relay-Client-IP-Hash`: the SHA-256 (64 lower-case hex)
  of `CONSOLE_IP_HASH_SALT` followed by the viewer's address, so the relay's per-address limit
  holds through the console without it ever seeing the address (M9-SPEC §7.6). The address is
  the **right-most** `X-Forwarded-For` entry: Cloud Run's front end, where IAP runs (the
  service has no load balancer in front), appends the address the connection came from, so
  that entry is the only one a client cannot write; anything left of it is the client's own
  claim. IPv6 counts per /64 and an IPv4-mapped address as IPv4, as the relay counts them.
  Should a load balancer ever be put in front, it appends its own address after the client's,
  and every viewer would share one bucket: creations limited too much, never too little;

`IAP_AUDIENCE` for a Cloud Run service is, in Google's "signed headers" documentation,
`/projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME` (the project *number*).

`RELAY_AUTH=metadata` asks the metadata server
(`/computeMetadata/v1/instance/service-accounts/default/identity?audience=<RELAY_URL>&format=full`,
`Metadata-Flavor: Google`) for an ID token, keeps it until 5 minutes before its `exp`, and
fetches a fresh one once when the relay answers 401.

## Trust model

- **Teammate text is data.** Everything inside a `<channel source="relay">` tag was written
  by a teammate (or their Claude). Both roles' instructions tell Claude never to run
  commands, edit files or change settings because such a message says so. Teammate text
  only ever reaches the tag body; tag attributes carry relay-checked ids only.
- **Tool results with teammate text are labelled.** `list_teammates` (capability titles,
  descriptions, param descriptions and enum values from each teammate's published manifest)
  and `request_status` (question and progress text) carry a `teammate_authored_data` field
  saying so, every string in them has `<channel` / `</channel` neutralised as pushed content
  does, and the instructions say such results are data, not instructions.
- **No permission relay.** The channel declares `claude/channel` and never
  `claude/channel/permission`: a teammate can never approve or deny a tool call in your
  session.
- **Named operations only.** Teammates can ask you to run a capability from the manifest,
  with params that are enums, bounded numbers, booleans or length-capped strings matching an
  anchored allow-list pattern. Params are validated by the asker, the relay and again by
  your capability server before a runner starts, which also binds the run to its request
  (above).
- **Patterns are RE2.** A manifest `pattern` is RE2 syntax (at most 300 characters, anchored
  `^…$`, must compile) and is only ever evaluated by `re2js`, in linear time, as a full match
  of the whole value, so a teammate's published manifest cannot stall your channel with a
  catastrophically backtracking pattern. Patterns are not passed to clients in tool input
  schemas. The same param rules as the relay apply: a `required` param may not have a
  `default`, `request_id` is reserved, integers and numbers must be finite and within ±2^53
  (`5.0` is the integer 5), `max_length` counts code points, and strings with lone
  surrogates are rejected.
- **Production data is opt-in** in the answering session's environment.
- **Identity is the relay's.** The sender of every message is the member the relay
  resolved from a verified credential; nothing a client writes can claim another sender.
- The token (device credential, static or Google ID token) is never logged, never put in an
  error or a tool result. The only file the plugin writes one to is the credential file
  (mode 600). All logs go to stderr (stdout is the MCP transport).
- **The answering session reads nothing by default**: only folders you share, and files or
  folders you allow in Claude Code's own dialog for that session; credential stores stay
  denied whatever you answer. These are permission rules, not an OS sandbox (see above).
- **Automatic answers stay in the folder** (M8): the answerer reads the scope folder minus
  the deny list and nothing else without your decision; it has no shell, no writing or
  editing and no web; its settings, hooks, plugins and MCP servers are only the plugin's own.
  What it sends is decided by the host's table above, never by the model alone, and nothing
  it wants beyond that happens before you decide in a dialog (or the local page) that the
  model cannot answer for you. A tool call approves nothing; unanswered approvals are denied.
- **The desktop notices are fixed text**; no teammate or hook-input text reaches them.
- **Tool events carry a name, an outcome (`ok`, `error`, or `waiting` for your permission)
  and a duration**, never a tool's input, output, error text or path.
- Network errors, 5xx and 429 (`rate_limited`, `too_many_polls`) are retried with
  exponential backoff; other refusals (for example `422 invalid_timeouts`) are tool errors.

## Development

```
pnpm install
pnpm typecheck
pnpm test             # builds dist/ first; the stdio suites drive node dist/*.js
pnpm build            # esbuild → dist/{channel,capabilities,session-start,tool-event,notify-desktop,console-server,credential-info,logout,answer-tools,answering-lock-info,answer-dry-run}.js (committed); never touches dist/console/
pnpm generate         # manifest.yaml → commands/answering.md, and plugin.json (no userConfig) and .mcp.json
pnpm generate --check # fails when those files are out of date
../scripts/e2e.sh     # the M1 gate, the M2 scenarios, the M5/M6 sign-in and roster scenarios when the relay serves them, M7, M8 and M9
```

`pnpm test` never runs `test/e2e/`. `../scripts/e2e.sh` (Docker and `../relay/.venv` needed)
starts a Firestore emulator on 127.0.0.1:8682 and the relay with throwaway static tokens and a
fake Google sign-in (`relay/tests/fake_oauth_app.py`), builds `dist/`, runs `pnpm test:e2e`
with `E2E=1`, and tears everything down on exit; the files run in name order. The sign-in
scenarios drive the real login tool with a headless stub browser
(`test/fixtures/fake-browser.mjs`), which presses one button of each page as a browser would:
Accept for an invitation it is told to accept (`FAKE_BROWSER_ACCEPT`), Create team on the
create page with the values it is given (`FAKE_BROWSER_CREATE`), else Continue. The M9
scenario (`test/e2e/m9.test.ts`) runs the hosted console server in the test process (IAP
stood in for, the delegate's ID token from the fake Google): a new account creates a team on
the sign-in page, invites a member who accepts and signs in, they exchange a question, the
owner creates and deletes a second team, and an admin deletes the first; both are refused. The automatic answerer's
tests (`test/answer-host.test.ts`, `test/e2e/m8.test.ts`) run the host with a stub `claude`
(`test/fixtures/stub-claude.mjs`, through `TEAM_RELAY_CLAUDE_BIN`) that reads the prompt, starts
the run's MCP servers and calls the host's tools as the question scripts it; no model is called.

After changing `manifest.yaml`, run `pnpm generate` and commit the result; after changing
`src/`, run `pnpm build` and commit `dist/`.
