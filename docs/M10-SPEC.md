# Milestone 10: team boundaries, answers without dialogs, one public host

Status: spec, approved 10 Nov 2026; corrected after review (§7). Extends M1-M9.

## Decisions (maintainer, 10 Nov 2026)

- A team's owner sets its boundaries when setting up the team in the console: GitHub orgs, shared
  Google Drives and, optionally, local folders members add for themselves.
- Inside the boundaries, answers go out on their own: no approval dialogs.
- Off-topic questions are declined on their own.
- Within a team, sharing everything inside the boundaries is the point (accepted risk, §7.4).
- One public host serves the relay and the console.

## 1. Team boundaries (relay + console)

Stored in `teams/{team}/settings/boundaries` with `version`, `updated_by`, `updated_at`. A change is
audited (who and when; no content). Purged with the team.

| Field | Rule |
|---|---|
| `topic` | 1-500 chars, what the team talks about, e.g. "Example Org: our clients, products and engineering." |
| `github_orgs` | up to 10 org names (§7.5), e.g. `example-org` |
| `drives` | up to 10 `{domain, shared_drive}`, e.g. `{example.com, "Example Team Drive"}` |
| `member_folders` | true/false: members may add their own local folders |

Endpoints (the contract relay, plugin and console share):
- `GET /v1/teams/{team}/boundaries` (any active member, or a delegate with `read`) → `200
  {"team", "version": int, "boundaries": {"topic", "github_orgs": [..], "drives": [{"domain",
  "shared_drive"}], "member_folders": bool} | null, "updated_at": iso|null, "updated_by": member|null}`.
  Never set → `version: 0`, `boundaries: null`.
- `PUT /v1/teams/{team}/boundaries` (owners; a delegate needs `manage-roster` and an owner
  on-behalf-of) body `{"version": <current>, "boundaries": {...}}` (strict: unknown fields 400,
  lists de-duplicated, `domain` a lower-case DNS name, `shared_drive` 1-100 chars no `/` or control
  chars, `topic` trimmed) → `200` same shape with `version+1`; stale version `409 version_conflict`;
  non-owner `403`; not a member `404`. Audited (`boundaries_set`, version, no text). Console: Team settings gets a Boundaries form (owner edits,
members see it read-only); the create-team dialog links to it straight after creating. Console route
`PUT /api/boundaries` under the existing write rules (same-origin, JSON, body cap, per-route check).

(Correction, 11 Nov 2026, docs/PICKERS-SPEC.md §2-§3: owners now **pick** exact sources. The
document gains `github_repos` (≤100 `{org, repo, id}`: single repositories; one whose org is in
`github_orgs` is dropped, the whole org covers it) and `drive_folders` (≤20 `{domain, drive_id,
folder_id, folder_name, drive_name}`: shared-drive folders, or a whole shared drive when `folder_id
== drive_id`), both answered with their own `since` maps. The PUT body must hold all six fields
(`topic`, `github_orgs`, `github_repos`, `drive_folders`, `drives`, `member_folders`); an M10-shaped
body is 400. `drives` is now **legacy**: a PUT may keep an entry the stored document holds, never add
one (`400 legacy_drive`); the version is checked first, so a stale save is `409 version_conflict`.
RELAY_GITHUB_ORGS and RELAY_ALLOWED_SHARED_DRIVES, when set, refuse other orgs and drives
(`org_not_allowed`, `drive_not_allowed`) and hide stored ones. A document stored before reads with
empty new lists and the same version; the console's PUT body cap is 160 KiB.)

## 2. What each member's answerer may read

The plugin fetches the team's boundaries when it starts and before each answer (a run uses one
version). Each member sets, in a local file and a `/team-relay:folders` command:
- `repo_roots`: where their clones live (e.g. `~/code/example-org`), searched 3 levels deep;
- `extra_folders`: their own folders, only if the team allows it.

The allowed set, recomputed per run:
1. **GitHub:** every git work tree under `repo_roots` whose `origin` is `github.com/<allowed org>/*`
   (https or ssh form), and in it **only files git tracks** (`git ls-files`). Untracked and ignored
   files (`.env`, local notes, build output) are out.
2. **Drive:** `~/Library/CloudStorage/GoogleDrive-<account>/Shared drives/<name>` where the account's
   domain is the team's domain and the name is listed. Other accounts' mounts and My Drive are out.
   Native Google Docs/Sheets/Slides are only links on disk: see §2a.
3. **The member's own folders**, when allowed (git-tracked files if a repo, else all files).

Always out, at any depth: the credential deny list (M4/M8, unchanged) and the sensitive names list
(M8 §7.1).

(Correction, 11 Nov 2026, docs/PICKERS-SPEC.md §6: 1. also takes a clone whose origin is
`github.com/<org>/<repo>` of a `github_repos` entry, git-tracked files only as above. 2. also takes,
for each `drive_folders` entry, the folder found under `Shared drives` of an account in the entry's
domain by its Drive item id (the extended attribute `com.google.drivefs.item-id#S`, read with
`/usr/bin/xattr`; never a symlink), not by name: the drive root by `drive_id`, a subfolder by name
hint then id. Name matching stays only for legacy `drives` entries. A Mac never calls GitHub or the
Drive API to find a source; one not found locally is skipped and reported as missing by its key.)

### 2a. Native Google Docs, Sheets and Slides

- A `.gdoc`/`.gsheet`/`.gslides` link file inside an allowed Drive holds `doc_id` (checked on
  a real drive). The host tool **read_google_file(path)** reads that id and asks the Drive API, as the
  member, for the file's `driveId`; only when it equals the allowed shared drive's id does it export
  the file (Docs → Markdown/text, Sheets → CSV per sheet, Slides → text), capped at 200 KB.
  Anything else is denied without asking.
- The member connects Drive once with `/team-relay:drive`: Google sign-in on loopback + PKCE with a
  Desktop OAuth client in the relay's project, scope `drive.readonly`, consent screen Internal
  (the team domain only). The refresh token stays on the member's Mac (macOS Keychain); it never
  goes to the relay. Disconnect with the same command; without it the answerer just says those files
  can't be read.
- The exported text goes through the same secret screen as everything else.
- The Desktop OAuth client (id and its non-confidential installed-app secret) is served by the relay:
  `GET /v1/teams/{team}/drive-client` (any active member) → `{client_id, client_secret}` from the
  mounted secret `team-relay-drive-client` (`/secrets/drive-oauth/client.json`, optional);
  absent → `404 drive_not_configured`. It never enters git.
- Shared drive identity: the host resolves the allowed drive's id by name with `drives.list` (as the
  member) and compares it with the file's `driveId`; the link file must also sit under the mount of
  an account in the team's domain.
  (Correction, 11 Nov 2026, docs/PICKERS-SPEC.md §6.2: for a picked folder the link file's real
  path must be under that folder, and the file's `driveId` must equal the id read locally from the
  shared drive root's attribute; no `drives.list` by name. The `drives.list` check above stays for
  legacy name entries only. The Drive Desktop client is unchanged; the console's Drive folder
  picker uses its own Web client with scope `drive.file`, in the owner's browser only, served
  through `GET /v1/teams/{team}/sources/config` to owners.)

The member's directory entry shows what they can answer from (repo names, drive names, folder names),
so teammates know whom to ask.

## 3. How a question is answered (no dialogs)

- The answerer gets the built-in **Read** and two host tools, **list_files** and **search_files**,
  that only ever see the allowed set. Built-in Glob and Grep are removed (they would see untracked
  files). No Bash, Write, Edit, web or agents, as today.
- Every Read goes through the host: allowed set → allowed at once; anything else → **denied at once**
  with a reason. Nothing waits for the member.
- The rubric gives the team topic: answer only questions about it, only from the allowed files and
  general knowledge; say "I don't know" when the files don't say. The people/customers/
  infrastructure "ask for approval" rule is dropped for teams with boundaries.
- Decision table:
  - off-topic (the answerer says so) → fixed reply "I only answer questions about <team> topics."
  - secret screen flags the draft → not sent; the asker gets "This answer may contain a credential,
    so it wasn't sent. Ask <member> directly."; the member gets a one-line note in their session
    No dialog.
  - otherwise → sent.
- Capability calls (action tools) still wait for approval as today.
- Volume limits stay (3 queued per asker, 20 runs per hour per member); over the limit the question
  is declined with a fixed "too many questions right now, try later" instead of waiting.
- Teams without boundaries keep today's M8 behaviour.

## 4. Several clients in one answer

A deployment whose own rules allow one model call to carry only one client's material must record an
exception for the relay before using it; the deployment this was built for did (10 Nov 2026).

## 5. One public host

- `gcp-bootstrap.sh`, `deploy.sh`, `deploy-console.sh` as before (project-agnostic), plus
  `scripts/deploy-lb.sh` (idempotent gcloud) when `PUBLIC_HOST` is set: a global external HTTPS load
  balancer, a reserved global static IP, a Google-managed certificate for `PUBLIC_HOST`, and two
  serverless NEGs. URL map: `/v1/*` and `/healthz` → relay backend (no IAP: the relay signs people in
  itself); everything else → console backend with IAP (custom OAuth client, `IAP_ACCESS`).
  (Correction, 11 Nov 2026: `/setup` (M11) and the public sign-in page at `/` and `/login` also go
  to the relay; see [SIGNIN-PAGE.md](SIGNIN-PAGE.md).) Both
  Cloud Run services get ingress `internal-and-cloud-load-balancing`, so the `run.app` URLs answer
  nothing from outside. `RELAY_PUBLIC_URL` and the relay's audience become `https://PUBLIC_HOST`;
  the console server calls the relay through that address; login callback
  `https://PUBLIC_HOST/v1/login/callback`; relay cookies stay under `/v1/login`.
- DNS: the domain owner adds `A <host> → <static IP>`; the certificate goes active once it resolves.
- Google sign-in: a web OAuth client on an **Internal** consent screen, and `RELAY_ALLOWED_DOMAINS`
  (§7.2) so the relay itself refuses every other domain.
- Message text kept 7 days (default), then deleted by Firestore TTL; audit keeps hashes 90 days.

## 6. Member setup (short guide in the repo README)

Install the plugin (`team-relay-dev` marketplace), start Claude Code with the channel flag, sign in
with the work account, accept the invitation, run `/team-relay:folders` to set `repo_roots` and accept
the team's boundaries (§7.1), and `/team-relay:drive` to connect Drive. Drive for desktop must be
signed in with the work account.

## Acceptance criteria

- ACC-1 Owner sets and edits boundaries in the console; a member sees them read-only; a non-owner PUT is 403; invalid fields 400.
- ACC-2 A tracked file in an allowed org's clone is read without asking; an untracked/ignored file in the same clone is denied without asking; a clone of another org is denied.
- ACC-3 A file in the allowed shared drive's mount is read; the same path under another account's mount or My Drive is denied.
- ACC-4 list_files/search_files never return a path outside the allowed set (property test over a fixture tree with untracked, ignored, symlinked and deny-listed files, including a symlink from inside to outside).
- ACC-5 An off-topic question gets the fixed decline with no dialog and no file read required.
- ACC-6 No question in boundary mode ever creates an approval item (except a capability call).
- ACC-7 read_google_file exports a Doc whose driveId is the allowed drive; a Doc in another drive, My Drive, or with a forged/missing doc_id is denied; no Drive connection → a clear "can't read Google files" in the answer; the token is never sent to the relay or written outside the Keychain.
- ACC-8 Secret-screen hit: nothing sent but the fixed line to the asker; the member gets a note; no approval item.
- ACC-9 Boundaries change mid-session: the next run uses the new version.
- ACC-10 Deployed behind `PUBLIC_HOST`: smoke + e2e pass; a Google account outside `RELAY_ALLOWED_DOMAINS` is refused by the relay on every route (login, ID token, invitation, delegate on-behalf-of).

## Tests

Relay: boundaries store on both stores, endpoints, validation, owner rule, purge, audit (pytest +
Firestore emulator). Plugin: allowed-set resolver over a synthetic fixture tree, permission classifier,
host tools, rubric and decision table, stub-claude end-to-end (vitest). Console: form, read-only view,
route rules. E2e: two members exchange an in-boundary and an off-topic question.

## Rollout / rollback

Deploy; the owner and one teammate first, then the rest of the team. Rollback: stop the
Cloud Run services (members' sessions keep working, they just get no relay). Deleting the team purges
all its data.

## 7. Corrections (10 Nov 2026, after the code and security reviews)

1. **Members accept the boundaries they answer from.** The member's local settings are per team:
   `teams.<team>: {repo_roots, extra_folders, accepted: {version, github_orgs, drives, member_folders}}`.
   The answerer reads only from what is both in the team's current boundaries and in the member's
   accepted set. Narrowing applies at once. Widening (a new org, a new drive, member folders turned
   on) applies only after the member accepts it in `/team-relay:folders` (a dialog showing exactly
   what is added); until then the host pushes one status line per new version ("<team>'s boundaries
   changed (version N adds …); run /team-relay:folders to accept") and keeps answering from the
   intersection. Nothing accepted yet → questions are declined with the fixed "<member> hasn't set
   up answering for this team yet." This is set-up consent, not a per-question dialog. An item
   the team drops leaves the accepted set at once (written back, no dialog), so adding it back
   needs a new acceptance. The relay records for each org, drive and `member_folders` the
   version in which it was last added (`since` in GET and PUT, kept while it stays), and an
   accepted item counts only while its `since` is at most the accepted version, so this holds
   even when the member's host never read the version that dropped it.
2. **The relay refuses other domains.** `RELAY_ALLOWED_DOMAINS` (comma-separated lower-case
   domains, optional; set for any domain-only deployment). When set, every Google identity must
   have `email_verified`, an email whose domain is exactly in the list, and an `hd` claim equal to
   that domain: direct ID tokens (incl. the gcloud audience), the login callback, delegate
   on-behalf-of emails, roster adds and invitations, team creation, and seed principals (startup
   error). Boundaries `drives[].domain` must be in the list; boundaries saved before the list was
   set are handed out (GET, and the PUT answer) without the drives of other domains.
3. **Reads are snapshots.** When the host allows a Read, it opens the file itself (`O_NOFOLLOW`),
   checks it is a regular file whose real path is in the set, copies it (cap 10 MB) into the run's
   private folder and returns `updatedInput` with `file_path` set to the copy. The child never opens
   a member path, so nothing can change between the check and the read.
   The copy is made per question and removed with the run; it is never a cache. Within one run, a
   second Read of the same unchanged file (device, inode, size, modification time) gets the copy
   already made, and a run copies at most 100 MB in all (past that a Read is denied). search_files
   opens files the same way (one shared open-and-check). At start, the host removes the member's
   own snapshot folders an earlier host left behind (named as the host names them, owned by the
   member, mode 700, older than the host's start, never a symlink), and only when the host
   process named in the folder (`trs-<pid>-XXXXXX`) is gone, so never another live host's;
   each Read reserves its bytes against the 100 MB before reading. GitHub content is
   the member's clone as it is on disk (never fetched: decided 10 Nov 2026); Drive content is the
   synced mount, and native Google files come from the Drive API at question time.
4. **Accepted risks** (maintainer, 10 Nov 2026):
   - Any member may receive anything inside the boundaries, whatever their own GitHub repo access or
     Drive folder access ("sharing all clients and work within the team is fine").
   - The secret screen is pattern-based; an asker who talks the answerer into encoding a secret can
     get past it. Credential files and untracked files are never readable, and tracked files are
     kept secret-free by the repos' own secret scanning.
   - The Drive refresh token (scope `drive.readonly`, the narrowest Google offers for reading
     shared-drive files) sits in the login Keychain, readable by the member's own processes without
     a prompt, like any file of theirs; the answerer itself has no shell.
5. **One validation rule** (`schema/boundaries-vectors.json`, loaded by the relay, console server,
   console UI and plugin tests): org `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`; version an integer 0..2^31-1
   (not a boolean); topic trimmed, 1-500 chars, newline and tab allowed, no other control, format,
   surrogate, private-use, unassigned or line/paragraph-separator characters; `domain` already
   lower-case, ≥2 labels, not an IP, no trailing dot, ≤253 chars; `shared_drive` 1-100 chars, no
   `/`, no control/format characters, no leading or trailing space, not `.` or `..`; list caps (10)
   count the lists as sent, before de-duplication; unknown fields refused. Python and Node may
   know different Unicode versions, so a character assigned in one and unassigned in the other
   can be judged differently; the relay is the authority, and the vectors hold no such character.
   (Correction, 11 Nov 2026: the topic and the picked folder and drive names are no longer checked
   for unassigned code points on any side, and the vectors now hold such characters on purpose:
   a new emoji passed the console and failed at the relay. Legacy `shared_drive` names keep the
   check; see PICKERS-SPEC.)
6. Boundaries never read (relay unreachable at start) → questions are declined with the fixed busy
   text; never an approval item.
7. Behind a load balancer every per-address limit uses the configured hop count:
   `RELAY_FORWARDED_FOR_HOPS` (relay, incl. `POST /v1/teams`) and `CONSOLE_PROXY_HOPS` (console,
   required in hosted mode when its public host is not `run.app`).
8. Public repository: tests and examples use `example-org`, `example.com`, `alice@example.com`;
   deployment values live in the operator's git-ignored `config/deploy.local.env`.
