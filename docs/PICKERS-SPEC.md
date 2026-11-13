# Owner-picked sources: exact GitHub repositories and shared-drive folders

Status: spec, approved 11 Nov 2026 (decisions in §16). Extends M10 (boundaries) and M11 (status,
guided joining). Examples use `example-org`, `example.com`, `alice@example.com`; deployment values
live in the operator's git-ignored `config/deploy.local.env` and in Secret Manager.

## 0. Summary

Today an owner types GitHub org names and `{domain, shared drive name}` pairs; members' Macs
match clones by origin org and Drive mounts by folder name. This change lets the owner **pick**
exact sources in the console:

- **GitHub:** a picker lists the repositories of the orgs where a small read-only GitHub App
  (Metadata only) is installed. The owner ticks exact repositories and/or "whole org". The relay
  holds the app's private key (Secret Manager), mints installation tokens and lists repositories;
  nothing about the key reaches a browser or a Mac. Pasting `https://github.com/<owner>[/<repo>]`
  still works.
- **Drive:** the owner picks shared-drive folders (or a whole shared drive) in Google's own Picker,
  on a dedicated console page, with a browser-only Google Identity Services token of scope
  `drive.file` that never reaches our servers. Stored per folder: domain, shared drive id, folder
  id, folder name, shared drive name when obtainable. Pasting a folder link still works.
- **Members' Macs** use their local copies only: clones under their chosen folders (matched by
  origin `github.com/<org>/<repo>`), and Drive for desktop mounts (matched by the extended
  attribute `com.google.drivefs.item-id#S`). A Mac never calls GitHub or the Drive API to find a
  source. A source not found locally is skipped, never a failure.
- **Missing sources** are reported as keys of the team's own list (never paths or local names);
  owners see each member's missing sources by name, members see their own with a `git clone` line
  or Drive guidance.
- **Existing boundaries carry over** with no data migration: org names stay whole-org entries;
  `{domain, shared_drive}` entries stay as legacy name entries, still matched by name, until the
  owner re-picks them. No new name entry can be added.

## 1. What exists today (analysis, with citations)

Relay
- `relay/relay/boundaries.py:1-27,43-49,116-177`: strict body `{version, boundaries: {topic,
  github_orgs ≤10, drives ≤10 {domain, shared_drive}, member_folders}}`; refusals name the field,
  never the value; `allowed_domains` (RELAY_ALLOWED_DOMAINS) refuses drive domains outside it
  (`:153-158`) and `boundaries_json` hides stored ones (`:234`).
- Per-item versions: `carried_since` (`:189-210`) keeps an item's `since` while it stays; new or
  re-added items get the new version; `boundaries_json` answers `since` (`:244-261`).
- Store: `DriveBoundary`, `TeamBoundaries` with `org_since`, `drive_since`,
  `member_folders_since` (`relay/relay/store.py:417-443`); Firestore mapping
  `_boundaries_to_doc`/`_boundaries_from_doc` (`relay/relay/store_firestore.py:626-668`), which
  already tolerates absent fields with `.get(...) or []`; one transaction in `set_boundaries`
  (`:1561-1583`).
- Service: `boundaries_get` (read budget, `relay/relay/service.py:1464-1484`), `boundaries_set`
  (owner checked before the body and again in the transaction, `version_conflict`, hourly budget,
  audit of the version only, `:1486-1564`), `acceptance_set` (`:1591-1654`), `status_set` (one per
  20 s, not audited, `:1656-1682`), `members_status` (every active member's status to any member,
  `:1684-1709`).
- Routes and delegate rules: `relay/relay/app.py:117-157` (DELEGATE_ROUTES, ROSTER_MUTATIONS incl.
  `PUT boundaries`, MEMBER_SELF_MUTATIONS), handlers `:931-962`; Drive Desktop client served from
  a mounted secret, any member, `no-store` (`:972-983`). Secrets are mounted by
  `scripts/deploy.sh:174-233` (optional secrets mounted when they exist).
- Status body (`relay/relay/member_state.py:61-92,168-222`): counts and booleans only; M11 §8
  (`docs/M11-SPEC.md:226`): "Status holds counts and booleans only: no paths, folder names,
  questions or answers."

Plugin
- Types (`plugin/src/boundaries-types.ts:4-48`) and the one rule (`plugin/src/boundaries-rule.ts:86-120`,
  exact keys, shared vectors `schema/boundaries-vectors.json`).
- Allowed set (`plugin/src/boundary-set.ts`): clones whose `remote.origin.url` names an allowed
  org (`:105-119`, `:439-469`); Drive areas are
  `~/Library/CloudStorage/GoogleDrive-<account in domain>/Shared drives/<name>` (`:374-409`,
  `:471-480`); `validBoundaries` fails closed on anything off-shape (`:643-666`).
- Clone counts for status/setup (`plugin/src/clones.ts:147-177`); acceptance by item `since`
  (`plugin/src/member-folders.ts:519-632`).
- Native Google files: `readGoogleFile` checks the link file sits under `Shared drives/<name>` of
  an account in the domain (`plugin/src/google-drive.ts:413-440`), resolves the shared drive's id
  **by name with `drives.list`** as the member (`:496`, `:676`) and compares the file's `driveId`
  (`:684`). Drive connection: `drive.readonly`, Keychain only (`plugin/src/drive-login.ts:1-27`);
  `teamDriveDomain` picks the domain from the drives (`:355-366`).
- Daemon status (`plugin/src/daemon-core.ts:222-229,343-412`): counts clones of the team's orgs,
  `drive.connected` from the Keychain.
- Setup CLI: `folders` lists the orgs and counts clones per chosen folder
  (`plugin/src/setup-cli.ts:389-430`); `status` checklist (`:580-630`).

Console
- Server: strict CSP `default-src 'self'` and `connect-src 'self'`, `frame-ancestors 'none'`,
  COOP `same-origin`, `Referrer-Policy: no-referrer` (`plugin/src/console-app.ts:109-130`);
  `PUT /api/boundaries` checked by `checkSetBoundaries` (`:460-494`, routes `:1041-1047`); reads
  proxied (`:1312-1320`); static files with SPA fallback (`:1398-1431`). Hosted mode is behind IAP;
  the local console runs on `127.0.0.1:<port>`.
- UI: free-typed orgs and drive rows (`console/src/lib/boundaries.ts`,
  `console/src/components/console/boundaries.tsx`); Setup checks (`console/src/lib/setup.ts:66-101`);
  Members progress (`console/src/components/console/members.tsx:92-103,366-372`).

Google facts this design rests on (checked 11 Nov 2026)
- The Picker's result objects carry `id`, `name`, `mimeType`, `parentId`, `resourceKey`, `url`,
  … and **no `driveId`** ([DocumentObject](https://developers.google.com/workspace/drive/picker/reference/picker.documentobject)).
- `DocsView.setEnableDrives(true)` shows shared drives; `setSelectFolderEnabled(true)` allows
  picking folders; `setIncludeFolders(true)`; `setMimeTypes` filters
  ([DocsView](https://developers.google.com/workspace/drive/picker/reference/picker.docsview)).
- The web Picker needs an API key, an OAuth client id, the Cloud project number as `setAppId`,
  and a token from scope `drive.file`; it "renders in an iframe hosted on `docs.google.com`", which
  must be in the key's website restrictions
  ([web Picker guide](https://developers.google.com/workspace/drive/picker/guides/web-picker)).
- `drive.file` is non-sensitive and covers files "the user shares with an app" through the Picker;
  `drive.readonly` and `drive.metadata.readonly` are restricted
  ([scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)).
  `files.get` accepts `drive.file`; `drives.get` needs `drive` or `drive.readonly`
  ([files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get),
  [drives.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/drives/get)).
- A shared drive's id "is also the ID of the top level folder of this shared drive"
  ([Drive resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/drives)).
- Google Identity Services: `initTokenClient({client_id, scope, prompt, login_hint, hd, callback,
  error_callback})`, errors `popup_failed_to_open`, `popup_closed`; `revoke(token, done)`
  ([reference](https://developers.google.com/identity/oauth2/web/reference/js-reference)). CSP:
  `script-src https://accounts.google.com/gsi/client`, `frame-src https://accounts.google.com/gsi/`,
  `connect-src https://accounts.google.com/gsi/`, `style-src https://accounts.google.com/gsi/style`;
  COOP `same-origin-allow-popups`; Referrer-Policy `strict-origin-when-cross-origin` recommended
  ([setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)).

Consequences
- `driveId` is obtained in the owner's browser with `files.get(id, fields=id,name,mimeType,driveId,
  supportsAllDrives=true)` under the same `drive.file` token, right after the pick.
- The shared drive's **name** cannot be read with `drive.file` (`drives.get` is restricted). It is
  stored when the owner picked the shared drive itself (the Picker's `name`), copied from another
  entry of the same `drive_id` that has it, else null (the console says "in a shared drive").

## 2. Data model

### 2.1 Boundaries document (API and store)

Additive: the M10 fields keep their meaning; two lists are new.

```json
{
  "topic": "Example Org: our clients, products and engineering.",
  "github_orgs": ["example-org"],
  "github_repos": [{"org": "example-labs", "repo": "api", "id": 123456}],
  "drive_folders": [
    {"domain": "example.com", "drive_id": "0AExampleDriveId0PVA", "folder_id": "0AExampleDriveId0PVA",
     "folder_name": "Example Team Drive", "drive_name": "Example Team Drive"},
    {"domain": "example.com", "drive_id": "0AExampleDriveId0PVA", "folder_id": "1ExampleFolderIdxxxxxxxxxxxxxxxxx",
     "folder_name": "Clients", "drive_name": "Example Team Drive"}
  ],
  "drives": [{"domain": "example.com", "shared_drive": "Old Name-Matched Drive"}],
  "member_folders": false
}
```

| Field | Rule (the one rule, `boundaries-rule.ts` and `boundaries.py`, vectors in `schema/boundaries-vectors.json`) |
|---|---|
| `topic`, `member_folders` | unchanged |
| `github_orgs` | unchanged (≤10, whole-org entries: any clone with origin `github.com/<org>/*`) |
| `github_repos` | ≤100 `{org, repo, id}`; `org` as `github_orgs`; `repo` `^[A-Za-z0-9._-]{1,100}$`, not all dots; `id` a positive integer ≤ 2^53-1 or null (null: pasted, not checked against GitHub). De-duplicated on lower-case `org/repo` (first kept). An entry whose org is in `github_orgs` is dropped (the whole org already covers it). |
| `drive_folders` | ≤20 `{domain, drive_id, folder_id, folder_name, drive_name}`; `domain` as M10 (and in RELAY_ALLOWED_DOMAINS when set); `folder_id` `^[A-Za-z0-9_-]{10,200}$`; `drive_id` the same or null (null: pasted link, not checked); `folder_id == drive_id` means the whole shared drive; `folder_name` 1-255 code points, no control/format/surrogate/private-use/unassigned/line-separator character, no leading or trailing space (`/` allowed: display text and a search hint only, never a path); `drive_name` null or the same rule capped at 100. De-duplicated on `folder_id` (first kept). |
| `drives` | **legacy** name entries (M10 shape, ≤10). A PUT may keep only entries the stored document already holds (exact `domain` and `shared_drive`); any other is `400 legacy_drive` ("Pick shared-drive folders instead of typing drive names."). |

Lists are counted as sent, before de-duplication (M10 §7.5). Unknown fields: 400.

Optional relay settings that gate the lists (mirroring RELAY_ALLOWED_DOMAINS, M10 §7.2):
- `RELAY_GITHUB_ORGS` (comma-separated org logins, lower-cased): when set, every `github_orgs`
  entry and every `github_repos[].org` must be one of them (`400 org_not_allowed`), the GitHub
  listing shows only installations on them (§4.3), and `boundaries_json` leaves out stored entries
  of other orgs. Required whenever the GitHub App is configured (start-up error otherwise).
- `RELAY_ALLOWED_SHARED_DRIVES` (comma-separated shared drive ids): when set, every
  `drive_folders[].drive_id` must be one of them (`400 drive_not_allowed`); an entry with
  `drive_id` null is accepted only when its `folder_id` is one of them (a pasted whole-drive link),
  and the relay then sets `drive_id = folder_id`; `boundaries_json` leaves out other stored
  entries. Legacy `drives` are unaffected (they carry no id).

(Correction, 11 Nov 2026: `folder_name` and `drive_name` are not checked for unassigned code points
(`Cn`). Names come from Drive, and each side reads `Cn` from its own Unicode tables (the relay's
Python is older than browsers' and members' Node), so a folder named with a newly added emoji passed
the console and failed at the relay. Control, format, surrogate, private-use and line/paragraph
separator characters stay refused on every side; other fields keep the `Cn` check.)

### 2.2 Item keys

One key per item, used by `since`, acceptance and missing reports (`boundaries-rule.ts`
`itemKey`, mirrored in Python and the console):

| Item | Key |
|---|---|
| whole org | `org:<lower org>` |
| repository | `repo:<lower org>/<lower repo>` |
| Drive folder | `folder:<folder_id>` (case kept) |
| legacy drive | `drive:<domain>/<shared_drive>` |

At most 400 characters (a legacy name is ≤100, a domain ≤253).

### 2.3 Versions and `since`

- `version` counts changes as today. Reading a document stored before this change does **not**
  bump the version: absent `github_repos`/`drive_folders` read as `[]`.
- `since` in GET/PUT gains two maps; the others are unchanged:

```json
"since": {
  "github_orgs": {"example-org": 3},
  "github_repos": {"example-labs/api": 5},
  "drive_folders": {"1ExampleFolderIdxxxxxxxxxxxxxxxxx": 5},
  "drives": [{"domain": "example.com", "shared_drive": "Old Name-Matched Drive", "since": 1}],
  "member_folders": null
}
```

- `carried_since` (relay, in the writing transaction) gives each item of the new document:
  1. its `since` in the replaced document when that document holds the same item (same key);
  2. else, for a **repository** whose org is a whole-org entry of the replaced document: that
     org's `since` (narrowing an org to some of its repositories was already accepted);
  3. else, for a **Drive folder** whose `drive_id` is non-null and the replaced document holds the
     whole drive (an entry with `folder_id == drive_id == this drive_id`): that entry's `since`;
  4. else the new version (new, or added back after a removal).
  Rule 2 and 3 never apply to the legacy name entries (no id to prove it is the same drive).
- Acceptance is unchanged: a member's accepted version covers an item when its `since` is at most
  that version (`member-folders.ts` `narrowAccepted`, `effectiveBoundaries`, generalised to keys).

### 2.4 Store

`teams/{team}/settings/boundaries` keeps every M10 field exactly as now and adds:
- `github_repos`: list of `{org, repo, id, since}`;
- `drive_folders`: list of `{domain, drive_id, folder_id, folder_name, drive_name, since}`.

`TeamBoundaries` (`store.py`) gains `github_repos: list[RepoBoundary]`,
`drive_folders: list[FolderBoundary]`, `repo_since: dict[str, int]` (lower `org/repo`),
`folder_since: dict[str, int]` (folder id); `RepoBoundary(org, repo, id)` and
`FolderBoundary(domain, drive_id, folder_id, folder_name, drive_name)` are frozen dataclasses.
Both stores map them; an absent `since` reads as the document's version (as M10 does).

### 2.5 Migration (no data step)

- Stored org names are whole-org entries already; nothing changes for them, `since` included.
- Stored `{domain, shared_drive}` entries stay as legacy entries with their `since`. They keep
  working exactly as today (name match under `Shared drives`, `drives.list` by name for native
  Google files) until the owner re-picks them. They cannot be turned into ids automatically: the
  relay has no Drive access, `drive.file` cannot list drives, and a member's Mac never sends what
  it found. The console marks each one "Matched by name: pick it again" (§7.2).
- A re-picked drive is a new item (new `since`), so members accept once more (open question Q3).
- Rollback safety: an older relay reading a new document sees `github_orgs` and legacy `drives`
  only (it ignores the new fields), so members answer from **less**, never more.

## 3. API contract

Errors keep the relay's shape `{"error", "detail"}`; a refusal names the field, never the value.
Auth order unchanged (401 → 400 on-behalf → 404 other team → 403/4xx).

### 3.1 `GET /v1/teams/{team}/boundaries` (any active member; delegate with `read`)

`200` as M10 plus `github_repos`, `drive_folders` in `boundaries` and the `since` of §2.3.
RELAY_ALLOWED_DOMAINS, RELAY_GITHUB_ORGS and RELAY_ALLOWED_SHARED_DRIVES filter stored entries
out of the answer. Read budget unchanged.

### 3.2 `PUT /v1/teams/{team}/boundaries` (owners; delegate `manage-roster` on behalf of an owner)

Body `{"version": <current>, "boundaries": {topic, github_orgs, github_repos, drive_folders,
drives, member_folders}}`, every field required (an older console that sends no `github_repos`
gets `400 invalid_body`; console and relay deploy together). Validation §2.1, then the
transaction as today (owner rechecked, `409 version_conflict`, quota, audit `boundaries_set` with
the version only). New refusals: `400 legacy_drive`, `400 org_not_allowed`, `400 drive_not_allowed`.
The PUT makes **no** call to GitHub or Google: it stays a pure, transactional write.
Body cap for the console route `PUT /api/boundaries`: 160 KiB. (Correction, 11 Nov 2026: 64 KiB was
set on an estimate of about 40 KiB; the largest valid body measures about 69 KiB as a browser sends
it and about 136 KiB with every non-ASCII character escaped, so the cap is 160 KiB. The relay's own
cap stays 256 KiB.)

### 3.3 `PUT /v1/teams/{team}/me/status` (the member only; never a delegate)

Adds an optional group:

```json
"sources": {"boundaries_version": 7, "missing": ["repo:example-org/api", "folder:1ExampleFolderIdxxxxxxxxxxxxxxxxx"]}
```

- `boundaries_version` integer 0..2^31-1; `missing` 0..140 strings, each 1-400 characters with no
  control or format character. Strict (unknown fields 400).
- The relay keeps only keys that are items of its **current** boundaries (read in the status
  transaction); anything else is dropped silently (a race with a boundaries change, or a key the
  team never listed). So nothing but the team's own item names is ever stored. Absent group:
  stored as absent (an older plugin).
- Not audited, one write per 20 s, as today.

### 3.4 `GET /v1/teams/{team}/members/status` (any active member; delegate with `read`)

Each member entry gains `"sources": {"boundaries_version": int, "missing": [key…]} | null`.
Filtered again against the current boundaries on read (an item removed since disappears).
**Owners** get `sources` for every member; any other caller gets it for their own entry only
(others `null`). The console turns keys into names from the current boundaries.

### 3.5 `GET /v1/teams/{team}/sources/config` (owners; delegate `read` on behalf of an owner) — new

```json
{
  "github": {"configured": true, "install_url": "https://github.com/apps/example-relay-sources/installations/new"} ,
  "google_picker": {"client_id": "123-abc.apps.googleusercontent.com", "api_key": "AIza…", "app_id": "123456789012"}
}
```
`github` is `{"configured": false, "install_url": null}` without the app; `google_picker` is null
without the picker settings. Non-owner `403 forbidden`. `Cache-Control: no-store`. Read budget
`source_reads` (reads_per_minute). Never holds the app's key, an installation token or a token of
any kind. Added to DELEGATE_ROUTES (the service checks the on-behalf member is an owner).

### 3.6 `GET /v1/teams/{team}/sources/github` (owners; delegate `read` on behalf of an owner) — new

```json
{
  "installations": [
    {"account": "example-org", "state": "ok", "repository_selection": "all",
     "repos": [{"name": "api", "id": 123456, "private": true, "archived": false}],
     "truncated": false}
  ],
  "fetched_at": "2026-11-11T10:00:00.000Z"
}
```
- Only installations whose `account.login` (lower-cased) is in RELAY_GITHUB_ORGS; other
  installations are never named. `state` `ok` or `suspended` (no repos). Repos sorted by lower
  name; at most 1000 per installation (`truncated` true beyond).
- Errors: `404 github_not_configured`; `502 github_unavailable` (GitHub 5xx, timeout, malformed
  answer); `502 github_app_misconfigured` (GitHub refused the app's JWT: wrong id or key);
  `503 github_rate_limited` with `Retry-After` (GitHub 403/429 with no remaining budget);
  `403` non-owner; `429` read budget. GitHub's own message text is never passed on.
- Audit: none (a read). Logged: `github_listed` with team, member, installation count, repo
  count, duration; never a token.

### 3.7 Console server routes (`plugin/src/console-app.ts`)

| Route | Rule |
|---|---|
| `GET /api/sources/config` | proxied; team as other team routes; **local mode** answers `google_picker: null` (the OAuth client's JavaScript origin cannot be a loopback port) |
| `GET /api/sources/github` | proxied read |
| `PUT /api/boundaries` | `checkSetBoundaries` on the new body (§2.1 rule), 160 KiB cap, other rules unchanged |
| `GET /pick/drive` | **hosted only** (local: 404); serves `dist/console/pick-drive.html` with the picker headers of §5.4; `HEAD` too; nothing else. A request for `/pick-drive.html` itself is 404, so the page never loads under other headers |

Both reads join the set whose relay 404 means "not available" (an older relay), not "not on this
team" (`console-app.ts:1390-1394`).

## 4. GitHub App

### 4.1 The app

- Owned by the org it reads (GitHub: Developer settings → GitHub Apps → New). Where it can be
  installed: **Only on this account** (open question Q5).
- Permissions: Repository → **Metadata: Read-only** (mandatory and the only one). No organisation
  or account permissions. Events: none. Webhook: **inactive**. No callback URL, "Request user
  authorization (OAuth) during installation" off, no setup URL.
- Reference manifest (for the record; creation through the web form is simpler):

```json
{
  "name": "example-org relay sources",
  "url": "https://relay.example.com",
  "hook_attributes": {"url": "https://relay.example.com/", "active": false},
  "public": false,
  "default_permissions": {"metadata": "read"},
  "default_events": []
}
```
- Installed by an org owner on the org, **All repositories** (so "whole org" and new repositories
  show in the picker; "Only select repositories" works too, the picker then lists only those).

### 4.2 Settings and secrets (relay)

| Setting | Source | Rule |
|---|---|---|
| `RELAY_GITHUB_APP_FILE` | Secret Manager `team-relay-github-app`, mounted at `/secrets/github-app/app.json` | JSON `{"app_id": "<digits>", "slug": "<slug>", "private_key": "<PEM>"}`; `app_id` `^[0-9]{1,12}$`, `slug` `^[a-z0-9][a-z0-9-]{0,99}$`, key an RSA private key (PKCS#1 or PKCS#8 PEM, ≥2048 bits) loaded once at start with `cryptography`; malformed → start-up error that never quotes the file |
| `RELAY_GITHUB_ORGS` | env from `deploy.local.env` `GITHUB_ORGS` | comma-separated org logins; required when the app file is set |
| `RELAY_PICKER_FILE` | Secret Manager `team-relay-picker`, mounted at `/secrets/picker/picker.json` | JSON `{"client_id", "api_key", "app_id"}`: `^[A-Za-z0-9.-]{1,200}\.apps\.googleusercontent\.com$`, `^AIza[0-9A-Za-z_-]{35}$`, `^[0-9]{6,20}$`; must not equal the login's or the Drive client's id |
| `RELAY_ALLOWED_SHARED_DRIVES` | env `ALLOWED_SHARED_DRIVES` | optional, comma-separated ids `^[A-Za-z0-9_-]{10,200}$` |

All optional except as stated; without the app the picker shows paste-only; without the picker
settings the Drive section shows paste-only. Only the relay's runtime service account gets
`secretAccessor` on the two new secrets. The key never appears in a log, an error, a response or a
console page.

### 4.3 Token minting, listing, caching (`relay/relay/github_app.py`, new)

- HTTP client: `httpx.AsyncClient` (moved from dev to runtime dependencies, same pin), base
  `https://api.github.com` only, `follow_redirects=False`, timeout 10 s, headers
  `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`,
  `User-Agent: team-relay`.
- App JWT: RS256, `iat = now - 60 s`, `exp = now + 540 s` (GitHub's limit is 10 minutes),
  `iss = app_id`; made per call, never stored.
- Installations: `GET /app/installations?per_page=100` (JWT), at most 3 pages; kept the ones whose
  `account.login` is in RELAY_GITHUB_ORGS.
- Installation token: `POST /app/installations/{id}/access_tokens` with body
  `{"permissions": {"metadata": "read"}}` (narrowed even if the app ever gains more). Kept in this
  process's memory until 5 minutes before `expires_at` (tokens last one hour); one request in
  flight per installation (single-flight); never written to the store or a log.
- Repositories: `GET /installation/repositories?per_page=100&page=n`, at most 10 pages. Each
  repository is kept only when `name` passes the repo rule and `id` is a positive integer;
  everything else in GitHub's answer is ignored (data, never trusted to be shaped).
- The whole listing is cached per installation for 60 s (memory, per instance), so an owner
  ticking boxes does not cost GitHub calls. A failed refresh does not serve stale data older than
  10 minutes.
- Rate limits: an installation has 5,000 requests an hour (more for large orgs); one listing is at
  most 1 + 1 + 10 requests, then cached. A 403/429 with `x-ratelimit-remaining: 0` or a
  `retry-after` gives `503 github_rate_limited` with `Retry-After` (capped at 3600).
- Pasted URLs need no route: the console checks them against the listing it already has (§7.1).

### 4.4 Why the relay, not the console server

1. The local console runs on members' Macs (`bin/console`); the key must never be there.
2. The relay is the authority on owners (roster in the same store) and already mounts optional
   secrets (`deploy.sh:174-233`); the console server is a thin proxy holding no secret.
3. One deployment of the key, one place to rotate it, one audit/log stream.

## 5. Google Picker

### 5.1 OAuth client and consent

- A new **Web application** OAuth client in the relay's project, "team-relay picker": Authorized
  JavaScript origins `https://<PUBLIC_HOST>` only; **no** redirect URIs. Separate from the login's
  client and the Drive Desktop client (least privilege, separate revocation).
- Consent screen: the existing **Internal** one (M10 §5). `drive.file` is non-sensitive, so no
  verification. The scope may be listed on the consent screen for clarity.

### 5.2 Scope and token

- Scope `https://www.googleapis.com/auth/drive.file` only. Token from
  `google.accounts.oauth2.initTokenClient({client_id, scope, prompt: '', login_hint: <viewer
  email when known>, hd: <viewer domain>, callback, error_callback})`.
- The token lives in a variable of the picker page only: never in storage, a cookie, a URL, a
  message to the console, or any request to our origin. After the owner finishes (or closes),
  the page calls `google.accounts.oauth2.revoke(token)` and closes itself. (`drive.file` per-file
  grants for the picked folders stay recorded at Google for the project; nobody holds a token for
  them.)

(Correction, 11 Nov 2026: the picker page cannot know the viewer, so the hosted console server adds
the viewer's own IAP-verified email to its `/api/sources/config` answer as `google_picker.login_hint`
(never a value the relay sends; locally `google_picker` stays null). The page passes it as
`login_hint` to the token request; no `hd`, since an email's domain may be an alias rather than the
account's Workspace domain.)

### 5.3 API key

Created in the relay's project: application restriction **HTTP referrers**
`https://<PUBLIC_HOST>/*` and `https://docs.google.com/*` (Google's note for the Picker iframe);
API restriction **Google Picker API** only. Enable the Google Picker API and the Google Drive API
in the project (the browser's `files.get` needs the Drive API).

### 5.4 The picker page and its headers (decision Q2)

The Picker runs on its own page, `/pick/drive`, opened by the boundaries form in a new window, so
the console's own pages keep today's strict headers unchanged. The page shows no team data; it
fetches only `GET /api/sources/config` from our origin.

Headers for `/pick/drive` only (exact string, tested):

```
Content-Security-Policy: default-src 'none'; script-src 'self' https://apis.google.com https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; img-src 'self' data:; font-src 'self'; connect-src 'self' https://www.googleapis.com https://accounts.google.com/gsi/; frame-src https://docs.google.com https://accounts.google.com/gsi/; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Cross-Origin-Opener-Policy: same-origin-allow-popups
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: same-origin
Cache-Control: no-store
```

`apis.google.com` serves `js/api.js` and the Picker code `gapi.load('picker')` fetches;
`docs.google.com` is the Picker's iframe; `www.googleapis.com` is `files.get`. If the post-deploy
check (V7) shows the Picker needs another host or inline styles, the fix is to this one header,
reviewed like any change; the console's main CSP is never widened.

Flow on the page (`console/src/pick-drive/main.ts`, plain TypeScript, no React):
1. Read `#n=<nonce>` (32 random bytes, base64url, made by the form) from the fragment; none → stop.
2. `GET /api/sources/config?team=<team from fragment>`; `google_picker` null → "Picking from
   Google Drive isn't set up here. Paste a folder link instead." and stop.
3. Load `https://apis.google.com/js/api.js` and `https://accounts.google.com/gsi/client` (15 s
   limit each; failure → the "blocked" state).
4. Button "Choose folders in Google Drive" (a user gesture, so the consent popup is allowed) →
   token → `PickerBuilder().setAppId(app_id).setOAuthToken(token).setDeveloperKey(api_key)
   .addView(new DocsView(ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true)
   .setEnableDrives(true).setMimeTypes('application/vnd.google-apps.folder'))
   .enableFeature(Feature.MULTISELECT_ENABLED).setCallback(cb)`.
5. On `PICKED`, for each doc (≤20): `GET https://www.googleapis.com/drive/v3/files/<id>?fields=id,name,mimeType,driveId&supportsAllDrives=true`
   with the token. Keep it only when `mimeType` is the folder type, `id` equals the doc's `id`,
   and `driveId` is present (a shared drive). `name` from Drive, else the Picker's. When
   `id == driveId` it is the whole drive and its `name` is the drive's name.
   No `driveId` → "Only folders in shared drives can be used. <name> is in My Drive."
6. Post `{nonce, folders: [{drive_id, folder_id, folder_name, drive_name|null}]}` on
   `BroadcastChannel('team-relay-pick')`; revoke the token; show "Done. You can close this
   window." and `window.close()`.

The form listens on the same channel while a pick is open, accepts only a message whose `nonce`
equals its own (same origin; the nonce only keeps a stale or second picker window from filling
the wrong form) and whose shape passes the §2.1 rule, fills `domain` from the viewer's email domain
(RELAY_ALLOWED_DOMAINS' only domain when there is one), fills a null `drive_name` from another
entry of the same `drive_id`, and adds the folders to the draft. The relay checks everything again
on save.

(Correction, 11 Nov 2026: the picker page's `connect-src` also names
`https://oauth2.googleapis.com/revoke`, where Google's sign-in library sends `revoke()`, so the
token is revoked when the owner finishes instead of expiring within the hour.)

(Correction, 13 Nov 2026: the picker page's `style-src` also has `'unsafe-inline'`. The Picker
adds its dialog's layout as two `<style>` blocks in this page; without them the dialog opens
squashed with an empty list. Their text is Google's and changes with its releases, so a hash
cannot pin it, and the Picker takes no nonce. Scripts stay strict, and the page shows no team data.)

## 6. Matching on members' Macs (never a GitHub or Drive API call)

### 6.1 GitHub

- Unchanged search: work trees ≤3 levels under the member's chosen folders, never through a
  symlink, submodules skipped; `remote.origin.url` parsed by `parseGithubOrigin`.
- In the set when the origin's org (lower) is a whole-org entry, **or** `org/repo` (lower, `.git`
  stripped) is a `github_repos` entry. Forks whose origin is the member's own fork do not match
  (known limit, as today).
- A repository entry is **missing** when no clone matches; a whole-org entry is missing when no
  clone of that org is found.

### 6.2 Drive (new `plugin/src/drive-locate.ts`)

Reading the attribute: `execFile('/usr/bin/xattr', ['-p', 'com.google.drivefs.item-id#S', path])`
(no shell; env PATH/HOME only; timeout 5 s; output trimmed and accepted only when it passes
`^[A-Za-z0-9_-]{10,200}$`; any error = no id). Up to 4 run at once. Tests inject the reader.

Mounts: for each `GoogleDrive-<account>` under `~/Library/CloudStorage` whose account's domain is
the entry's `domain` (today's rule, `boundary-set.ts:374-409`), `Shared drives` must be a real
directory (lstat, not a symlink). Its entries (one `readdir`, directories only, no dot names,
never a symlink) are the shared drive roots.

Search for one entry, in order, with a budget per build of the allowed set:
1. **Drive root:** read the id of each shared drive root (≤50 roots per mount). A root whose id is
   the entry's `drive_id` (or, when `drive_id` is null, its `folder_id`) is the drive. When
   `folder_id` is the drive's id, done.
2. **Name hint:** breadth-first under that drive root (or under every root when `drive_id` is
   null), directories only, never through a symlink or a dot name, depth ≤ 8, ≤ 5,000 directories
   listed. Each directory whose name equals `folder_name` (NFC-normalised, exact case) has its id
   read; the first whose id is `folder_id` is the folder.
3. **Blind scan** (only when `drive_id` is known and step 2 found nothing: the folder was renamed):
   the same walk, reading the id of every directory, ≤ 300 reads and ≤ 10 s.
4. Not found → missing.

Cache (memory, per process): `folder_id → {path, account, drive_root_id, verified_at}`. Before a
cached path is used: `lstat` is a directory, `realpath` equals it, it is still under the same
`Shared drives` root, and its id read now equals `folder_id`; re-checked at most every 60 s, and
always before a status report. Any mismatch → search again. A not-found entry is not searched
again for 10 minutes unless the boundaries or the mounts' listing change. The daemon and the
channel host keep their own cache; the setup CLI searches fresh.

Use of a found folder: it becomes a `drive` area rooted at the folder (today's walk, caps and
5 MB rule unchanged), named `drive:<folder_name>`, carrying `{domain, drive_root_id, folder_id}`.
Legacy entries keep today's `driveRoots` by name.

`read_google_file` (`google-drive.ts`): for an id area, the link file's real path must be under the
area's root (instead of `Shared drives/<name>`), the mount's account in `domain`, and the file's
`driveId` (Drive API, as today) must equal the area's `drive_root_id`, the id read locally from the
root's attribute, so **no `drives.list` by name** is needed. Legacy areas keep today's check.

*Correction, 11 Nov 2026:* the `driveId` check proves only that the file is in the same shared
drive, not that it is inside the picked folder. Anyone who can write to the folder could leave a
link file there that points at a document elsewhere in that drive. So for an area of a folder
inside a shared drive (not a whole drive, not a legacy drive), before any export the file's
ancestry must reach the picked folder, asked of the Drive API as the member with the scope
already in use. The first `files.get` asks for `id,name,mimeType,driveId,parents`. Then, one
parent at a time, `files.get(<parent>, fields=id,parents,driveId, supportsAllDrives=true)`, at
most 20 levels (`MAX_ANCESTRY_LEVELS`), stopping as soon as the picked folder's id is met (the
folder itself is not read). Denied ("not in the picked Drive folder"), with nothing exported,
when:
- the drive root is reached first;
- the cap is hit;
- a parent cannot be read;
- a parent's `driveId` differs;
- an item does not have exactly one id-shaped parent.

A network failure is "Google did not answer". Nothing is cached between files. A whole-drive
area keeps the `driveId` check only and makes no extra call. The area carries the picked folder's
id (`folder_id`) for this. Legacy areas are unchanged.

Must be verified on a real Mac before merge (V1-V6; results recorded in the PR):
- V1 Subfolders inside a shared drive carry `com.google.drivefs.item-id#S`, and the value equals
  the folder's Drive id (the id in its `drive.google.com/drive/folders/<id>` link). Roots: already
  verified 11 Nov 2026 (19 characters; equals the shared drive id, which is also its root folder id).
- V2 Listing directories and reading the attribute in streaming mode downloads no file content
  and does not hang while offline (Drive for desktop activity, disk use, `xattr` timing offline).
- V3 `/usr/bin/xattr` exists on a stock Mac without developer tools; time per call (sets the
  budgets above).
- V4 A member with access to a folder but not to its shared drive: does Drive for desktop show it
  under `Shared drives`? (Expected no: then the guidance says to ask for access to the drive.)
- V5 The `Shared drives` folder name on a Mac set to another language (today's code assumes the
  English name).
- V6 The background answerer (LaunchAgent `node`) can run `/usr/bin/xattr` on the CloudStorage
  paths after the member allowed access (M11 §1 privacy note).

Browser checks (V7-V9), on the deployed host, owner account:
- V7 The Picker loads and works under the §5.4 headers (no CSP report in the browser console), in
  Chrome and Safari, with third-party cookies blocked.
- V8 With `setEnableDrives(true)` + `setSelectFolderEnabled(true)`, a shared drive itself can be
  selected; its `id` is the drive id and its `name` the drive's name.
- V9 `files.get` with the `drive.file` token returns `driveId` for a picked folder and for a picked
  drive root.

## 7. Console UI

### 7.1 GitHub section (owner's form, `github-picker.tsx`)

| State | What the owner sees |
|---|---|
| loading | skeleton rows |
| app not configured (`404 github_not_configured`, or `configured: false`) | no picker; "Paste a repository or org address" field; one line: "Picking from a list needs the relay's GitHub app. Whoever runs the relay can set it up." |
| configured, no installation | "The GitHub app isn't installed on any of your organisations yet. An organisation owner installs it here:" + link `install_url` (opens GitHub, `rel="noopener noreferrer"`) + "Check again" + paste field |
| listed | per org: a "Whole org (new repositories join automatically)" switch; a filter box; repo checkboxes (archived greyed, private marked); ticking the whole org disables and clears that org's repo ticks; "Showing the first 1000" when truncated; suspended installation: "This installation is suspended on GitHub." |
| error 502/503 | "GitHub didn't answer just now." + "Try again" (after `Retry-After` when given); paste still works; saved choices still shown |
| saved items not in the listing | shown as chips "not found in the app's list (private, renamed or not installed)"; kept unless removed |

Paste field accepts `https://github.com/<owner>` and `https://github.com/<owner>/<repo>` with an
optional `.git`, trailing `/`, `www.`, query or fragment; anything else: "Paste a github.com
address of an organisation or a repository." A parsed repo found in the listing gets its `id`;
otherwise `id: null` and the chip says "not checked".

### 7.2 Drive section (`drive-folders.tsx`)

| State | What the owner sees |
|---|---|
| picker available (hosted, `google_picker` set) | "Choose folders in Google Drive" button → opens `/pick/drive#n=<nonce>&team=<team>` (`window.open`, `noopener` not used: the channel is the link) |
| popup blocked (`window.open` null) | "Your browser blocked the window. Allow pop-ups for this site, or paste a folder link." |
| picking | "Choose in the Google window…" with Cancel (stops listening) |
| picker page states | loading Google; consent closed/denied (`popup_closed`, `access_denied`) "No access given, so nothing was picked."; Google's scripts blocked (15 s) "Google's picker couldn't load here (an extension or network may block it). Paste a folder link in the team page instead."; not a shared drive; no access (`files.get` 403/404) "You can't open <name>." |
| picker not available (local console, or not configured) | paste field only, one line why |
| list | chips: folder name, "in <drive name>" or "a whole shared drive" or "in a shared drive"; pasted: "not checked"; legacy: "<name> (matched by name)" with "Pick it again" |

Paste field accepts `https://drive.google.com/drive/folders/<id>` (also `/drive/u/<n>/folders/<id>`,
`?usp=…`, `?resourcekey=…` ignored) and `https://drive.google.com/open?id=<id>`; the owner also
types a display name (required, folder-name rule). Anything else: "Paste a link to a Google Drive
folder."

### 7.3 Members' read-only view and acceptance list

Lists whole orgs, repositories (`example-org/api`), Drive folders ("Clients, in Example Team
Drive") and legacy drives; "new" markers by `since` as today (`setup.ts boundaryItems`).

### 7.4 Missing sources

- **Setup page (the viewer's own):** below step 1, when `sources.missing` is non-empty, "Your Mac
  can't find N of the things your team shares. It answers from the rest." then one line per item:
  - repository: `git clone https://github.com/example-org/api.git` with a copy button and "Run it
    in Terminal inside the folder you picked for projects.";
  - whole org: "No example-org projects found. Clone the ones you work on into the folder you
    picked for projects." + link `https://github.com/orgs/example-org/repositories`;
  - Drive folder: "Clients (in Example Team Drive) isn't on this Mac. Make sure Google Drive for
    desktop is signed in with your work account; if it still doesn't show, ask a team owner for
    access to the shared drive.";
  - legacy drive: the same with the drive's name.
  Missing sources never make "Set up your Mac" undone. `boundaries_version` older than the
  current one: items added since show "checking…".
- **Members view (owners only):** each member row shows "can't find N" with the names in a
  disclosure; non-owners see no other member's list.
- **`setup-cli status`** prints the same lines from the relay's view of the member.

## 8. Status and privacy

- The daemon computes `missing` in `refreshFacts` (every 10 minutes, or when the folders, the
  boundaries or the mounts change) with `plugin/src/sources-report.ts` and sends it in every status.
- A key is a name from the team's own list. The relay drops every key that is not an item of its
  current boundaries, so a Mac cannot report a local path, a local folder name or a repository the
  team did not list. M11 §8 becomes: "Status holds counts, booleans and keys of the team's own
  boundary items: no paths, local folder names, questions or answers."
- Owners see all members' missing items; members their own (§3.4).

## 9. File-level plan (disjoint parts; one owner per file)

Part 0 runs first (it fixes the shared contract); the rest run in parallel after it. No git writes
by agents; the main loop commits, rebuilds `plugin/dist` and runs the full checks.

**Part 0 — contract (small)**
- `schema/boundaries-vectors.json`: valid/invalid cases for the new fields, keys, legacy rule.
- `plugin/src/boundaries-types.ts`: `RepoBoundary`, `FolderBoundary`, `Boundaries` with the new
  lists, `BoundariesSince` with the new maps, `MemberStatusBody.sources?`,
  `MemberStatusEntry.sources`, `SourcesConfig`, `GithubListing`.
- `plugin/src/boundaries-rule.ts`: rules for repos/folders, `itemKey`, `itemKeys(b)`,
  `nextSince` with §2.3 rules 1-4; `plugin/test/boundaries-rule.test.ts`.
- `docs/PICKERS-SPEC.md`: this spec.

What Part 0 fixed for the other parts (the contract they build on):
- `boundaries-rule.ts` exports, beside the M10 checks: `repoNameOk`, `repoIdOk`, `driveItemIdOk`,
  `folderNameOk`, `pickedDriveNameOk`, `repoOk`, `folderOk`, `legacyDriveOk`; `boundariesValid`
  (a PUT body: all six fields); `readBoundaries` (a document to act on: the six fields, or exactly
  the four M10 fields read with both picked lists empty; null otherwise); `normaliseBoundaries`
  (what the relay stores: topic trimmed, duplicates and repositories of whole orgs dropped);
  `legacyDrivesOk(stored, sent)` (false is `400 legacy_drive`); `orgKey`, `repoKey`, `folderKey`,
  `driveKey`, `itemKey`, `boundaryItems`, `itemKeys` (keys of the document as stored, in the order
  orgs, repositories, folders, legacy drives); `sinceByKey`; `nextSince` (rules 1-4, on the
  document as stored; `prev` and `next` may be of the M10 shape); `sourcesOk` (the status group,
  §3.3) and `knownItemKeys` (the keys the relay keeps).
- `schema/boundaries-vectors.json` keeps its `valid`, `invalid`, `versions` and `placeholders`
  and adds: `field` on every invalid case (the boundaries field at fault, null for the body),
  `m10_documents`, `normalised`, `legacy_drives`, `keys`, `item_keys`, `since` (a document the M10
  code stored as version 1, then each PUT in turn) and `sources` (`valid`, `invalid`, `kept`).
  Valid documents may hold legacy drives: a test that PUTs them over HTTP stores those drives
  first.

**Part R1 — relay boundaries, status, routes**
- `relay/relay/boundaries.py` (rules, keys, `carried_since` 1-4, `boundaries_json`, the two
  allowlists as parameters like `allowed_domains`), `relay/relay/member_state.py` (`sources`),
  `relay/relay/store.py`, `store_firestore.py`, `store_memory.py` (fields, mapping, absent = `[]`),
  `relay/relay/service.py` (`boundaries_set` legacy-drive check, `status_set` key filter,
  `members_status` owner rule, `sources_config`/`sources_github` calling Part R2's functions),
  `relay/relay/app.py` (two routes, DELEGATE_ROUTES).
- Tests: `relay/tests/test_boundaries.py`, `test_m11_member.py`, `test_store_contract.py`, new
  `relay/tests/test_picked_sources.py`.

**Part R2 — relay GitHub App and settings**
- New `relay/relay/github_app.py` (`GithubApp` with `async list_installations() -> list[Installation]`,
  token cache, single-flight), new `relay/relay/sources.py` (`config_json(settings) -> dict`,
  `async github_json(app, orgs) -> dict`, raising `ApiError` as §3.6), `relay/relay/config.py`
  (`RELAY_GITHUB_APP_FILE`, `RELAY_GITHUB_ORGS`, `RELAY_PICKER_FILE`,
  `RELAY_ALLOWED_SHARED_DRIVES`; TeamConfig gains `allowed_github_orgs`, `allowed_shared_drives`
  beside `allowed_domains`), `relay/pyproject.toml` (httpx runtime).
- Tests: new `relay/tests/test_github_app.py` (a fake GitHub on `httpx.MockTransport`; JWT claims
  verified with the public key), new `relay/tests/test_sources_config.py`, `test_config_auth.py`.

**Part P1 — plugin answer side**
- `plugin/src/boundary-set.ts` (repo match, id areas, `validBoundaries`/`sinceValid` for new fields
  and for documents without them), new `plugin/src/drive-locate.ts`, new
  `plugin/src/sources-report.ts` (`missingSources(b, folders, env, deps) -> Promise<string[]>`),
  `plugin/src/clones.ts` (match items, per-item found), `plugin/src/member-folders.ts` (keys in
  `ItemSince`, `effectiveBoundaries`, `narrowAccepted`, `acceptedFrom`; an M10 `accepted` without the
  new lists still parses and stays ignored), `plugin/src/google-drive.ts` (id areas, no
  `drives.list` for them), `plugin/src/boundary-tools.ts`, `plugin/src/answer-host.ts`
  (sentence/summary wording), `plugin/src/folders-tool.ts`.
- Tests: `boundary-set.test.ts`, `google-drive.test.ts`, `member-settings.test.ts`, new
  `drive-locate.test.ts`, `sources-report.test.ts`, `answer-host.test.ts`.

**Part P2 — plugin daemon and setup**
- `plugin/src/daemon-core.ts` (`sources` in the status, facts key includes the items),
  `plugin/src/setup-cli.ts` (`folders` lists whole orgs and repos and counts per folder; `status`
  prints missing lines), `plugin/src/drive-login.ts` (`teamDriveDomain` from folders and legacy
  drives), `plugin/src/drive-cli.ts`.
- Tests: `daemon.test.ts`, `setup-cli.test.ts`, `drive-login.test.ts`.

**Part P3 — console server**
- `plugin/src/console-app.ts` (§3.7 routes, `checkSetBoundaries` v2, 160 KiB cap, picker page and
  its headers, local-mode `google_picker: null`), `plugin/src/relay-client.ts`,
  `plugin/src/relay-client-core.ts` (two reads), `plugin/src/console-demo.ts` (demo relay: new
  shape, a fake listing, `google_picker: null`).
- Tests: `console-boundaries.test.ts`, `console-hosted.test.ts` (exact header strings for both
  page kinds), `relay-client.test.ts`, new `console-pickers.test.ts`.

**Part C1 — console boundaries form**
- `console/src/api/types.ts`, `console/src/api/client.ts`, `console/src/hooks/queries.ts`,
  `console/src/lib/boundaries.ts`, new `console/src/lib/sources.ts` (URL parsing, keys, names for
  keys, channel message check), `console/src/components/console/boundaries.tsx`, new
  `github-picker.tsx`, new `drive-folders.tsx`; tests beside them.

**Part C2 — picker page**
- New `console/pick-drive.html`, new `console/src/pick-drive/main.ts` (+ `main.test.ts` with
  fake `gapi`/`google` globals), `console/vite.config.ts` (second input, output
  `pick-drive.html`).

**Part C3 — setup and members views**
- `console/src/lib/setup.ts` (`readStatus` takes `sources`; `missingLines`), 
  `console/src/components/console/setup.tsx`, `console/src/components/console/members.tsx`;
  tests `setup.test.ts`, `steps.test.ts`. Uses the types C1 adds (C1 lands `types.ts` first).

**Part S — scripts and docs**
- `scripts/gcp-bootstrap.sh` (enable `picker.googleapis.com`, `drive.googleapis.com`; secrets
  `team-relay-github-app` from `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_KEY_FILE`, and
  `team-relay-picker` from `PICKER_CLIENT_ID`, `PICKER_API_KEY` and the project number it reads
  itself; accessor for the runtime account; values never printed), `scripts/deploy.sh` (mount
  both when present; pass `RELAY_GITHUB_ORGS`, `RELAY_ALLOWED_SHARED_DRIVES`; refuse to deploy the
  app secret without `GITHUB_ORGS`), `scripts/smoke.sh` (`/pick/drive` anonymous → IAP redirect),
  `README.md` (owner and member guide), dated corrections in `docs/M10-SPEC.md` (§1, §2, §2a) and
  `docs/M11-SPEC.md` (§3, §8); `relay/tests/test_deploy_config.py`.

## 10. Acceptance criteria

- ACC-001 An owner saves `github_repos` and `drive_folders`; GET returns them with `since`; the
  version goes up by one; a member reads them; a non-owner PUT is 403.
- ACC-002 Every rule of §2.1 is enforced identically by relay, console server and console UI
  (shared vectors): bad org/repo/id, caps counted as sent, duplicates dropped, a repo of a
  whole-org entry dropped, unknown fields 400, refusals name the field and never the value.
- ACC-003 A PUT adding a legacy drive not already stored is `400 legacy_drive`; keeping a stored
  one keeps its `since`; removing it works.
- ACC-004 A document stored by the M10 code reads with `github_repos: []`, `drive_folders: []`, its
  version and every `since` unchanged; members' acceptance still covers its items. A document
  written by the new code still holds `github_orgs`, `orgs_since` and `drives` exactly as M10 wrote
  them, so the M10 reader sees orgs and legacy drives only.
- ACC-005 `since` rules 1-4: org → its repos keep the org's `since`; whole drive → its subfolders
  keep the drive's `since`; legacy drive → re-picked drive gets the new version; removed and added
  back gets the new version.
- ACC-006 RELAY_GITHUB_ORGS and RELAY_ALLOWED_SHARED_DRIVES refuse other orgs/drives on PUT
  (`org_not_allowed`, `drive_not_allowed`), a pasted whole-drive link in the allowlist gets its
  `drive_id`, and GET leaves out stored entries outside them. The app file without
  RELAY_GITHUB_ORGS refuses to start.
- ACC-007 `GET sources/config`: owner (direct or delegate on behalf of an owner) gets it;
  non-owner 403; never contains the key or a token; `no-store`.
- ACC-008 `GET sources/github`: lists only allowlisted installations, sorted, ≤1000 per
  installation with `truncated`; tokens requested with `{"permissions":{"metadata":"read"}}`,
  reused until 5 minutes before expiry, one in flight per installation; listing cached 60 s;
  GitHub 5xx/timeout → 502 `github_unavailable`; JWT refused → 502 `github_app_misconfigured`;
  rate limit → 503 with `Retry-After`; not configured → 404; malformed GitHub data ignored; no log
  line holds a token or the key (log capture asserted).
- ACC-009 Status `sources`: optional; keys not in the current boundaries are dropped; >140 keys,
  a key over 400 characters or with a control character is 400; members/status returns every
  member's `sources` to an owner and only the caller's own to anyone else.
- ACC-010 A clone of `example-org/api` is in the set for a `github_repos` entry; a clone of
  `example-org/web` is not; with the whole org both are.
- ACC-011 A Drive folder entry resolves by attribute: the drive root by id; a subfolder by name
  hint + id; a folder with the same name and another id is out; a renamed folder is found by the
  blind scan within its budget; nothing outside `Shared drives` of an account in the domain is ever
  used; symlinks are never followed; the caps stop the walk (fixture with an injected reader).
- ACC-012 Cache: a cached path is re-verified; a moved folder is found again; a changed id
  triggers a new search; a not-found entry waits 10 minutes unless boundaries or mounts change.
- ACC-013 `missingSources` reports exactly the keys of items not found and nothing else.
- ACC-014 `read_google_file` in an id area compares `driveId` with the root's local id and makes
  no `drives.list` call; a link file outside the folder is denied; legacy areas behave as today.
  (11 Nov 2026) In a folder area, a link to a document outside the folder in the same drive, a
  walk past the cap and an unreadable parent are denied; a document in a subfolder is read; a
  whole-drive area makes no parent call.
- ACC-015 The plugin acts on documents with and without the new fields, and on nothing malformed.
- ACC-016 Narrowing an accepted org to some of its repositories needs no new acceptance; adding a
  repository of an org that was not whole is pending until accepted (plugin `effectiveBoundaries`).
- ACC-017 Console server: `PUT /api/boundaries` checks the new body (160 KiB); `/api/sources/*`
  proxied; local `google_picker: null`; `/pick/drive` hosted only, with exactly the §5.4 headers;
  every other page keeps exactly today's headers; `/pick-drive.html` is 404.
- ACC-018 GitHub picker states of §7.1, URL parsing cases (with `.git`, `/`, `www.`, query;
  refused: other hosts, `github.com/orgs/x`, more path parts).
- ACC-019 Drive section states of §7.2; a channel message with another nonce or a bad shape is
  ignored; Drive link parsing cases; legacy chip with "Pick it again".
- ACC-020 Picker page: the token is never sent to our origin, never stored (`localStorage`,
  `sessionStorage`, cookies empty; fetch spy), `revoke` is called on finish and on close; My Drive
  folders are refused; config null shows the paste message.
- ACC-021 Setup page shows the viewer's own missing items with the clone line or Drive guidance;
  missing items never untick "Set up your Mac".
- ACC-022 Members view: an owner sees each member's missing names; a member sees none of others'.
- ACC-023 `setup-cli folders` lists whole orgs and repositories and counts matches per folder;
  `status` prints the missing lines.
- ACC-024 Deploy scripts mount the new secrets only when present, never print their values, and
  the relay refuses malformed settings without quoting them.
- ACC-025 The session sentence and the widening text name repositories and folders; owner text
  (folder and drive names) is quoted and channel tags neutralised.

## 11. Test matrix

| Area | Relay (pytest, memory + Firestore emulator) | Plugin (vitest) | Console (vitest) | Manual |
|---|---|---|---|---|
| Rule, vectors | ACC-002 | ACC-002, 015 | ACC-002 | |
| Store, migration, rollback shape | ACC-004 | | | |
| since/acceptance | ACC-005 | ACC-016 | `boundaryItems` new markers | |
| Allowlists | ACC-006 | | 400 refusals in words | |
| GitHub App | ACC-007, 008 (MockTransport) | | | create, install, list (V10) |
| Status/missing | ACC-009 | ACC-013, daemon body | ACC-021, 022 | V1-V6 on a Mac |
| Local matching | | ACC-010, 011, 012, 014 | | V1, V2, V4 |
| Console server | | ACC-017 | | |
| Form and pickers | | | ACC-018, 019 | V7-V9 |
| Picker page | | | ACC-020 | V7 |
| Setup CLI | | ACC-023 | | |
| Scripts | ACC-024 (`test_deploy_config.py`) | | | bootstrap dry run |
| E2e (`scripts/e2e.sh`) | two members: one has the picked repo, one lacks it; owner sees the missing name; the question is answered from the picked repo only | | | |

Every test is deterministic (no network: GitHub and Google are fakes; xattr reader injected).
V10: the maintainer creates and installs the app and sees the listing in the deployed console.

## 12. Security considerations

- **No secrets in the browser.** The GitHub key and installation tokens stay in the relay
  (Secret Manager, memory). The Google token is minted in the owner's browser for that owner and
  never leaves the picker page; the API key and OAuth client id are public by design, restricted
  (referrers, Picker API only, one JavaScript origin).
- **Least privilege.** App: Metadata read only, no webhook, tokens narrowed per request. Google:
  `drive.file`, not `drive.readonly`; the Picker is only used to choose. Members' Macs keep their
  existing `drive.readonly` connection for native Google files only. For id areas they make one
  fewer call (`drives.list`). For a picked folder inside a shared drive they make up to 19 more:
  the parent reads of §6.2 (11 Nov 2026), with the same token and scope.
- **Strict headers stay strict.** Third-party scripts load only on `/pick/drive`, which holds no
  team data; the console's main CSP, COOP and Referrer-Policy do not change.
- **Data as data.** GitHub answers, Picker results, `files.get` answers and BroadcastChannel
  messages are validated by the same rules as typed input before any store or render; names are
  rendered as text and quoted in prompts (`quotedOwnerText`); the relay re-validates every save.
- **Never scan outside configured sources** (never-list 6): the Mac walks only `Shared drives` of
  accounts in the team's domain, within caps, and uses a folder only after its id matches.
- **A link file is not proof of place** (11 Nov 2026): a native Google file reached through a
  link file inside a picked folder is exported only after the Drive API shows its ancestry
  reaches that folder (§6.2). Otherwise a teammate who can write to the folder could plant a
  link file there that reads another document of the same shared drive.
- **Privacy of status:** only keys of the team's own items leave the Mac; the relay drops anything
  else; owners only see others' lists.
- **Tenancy.** The GitHub listing is relay-wide: every owner of any team on one relay can list the
  repository names of the allowlisted orgs (Q1). RELAY_GITHUB_ORGS and RELAY_ALLOWED_SHARED_DRIVES
  let a deployment hold its boundaries to the sources its own rules allow (e.g. a recorded
  exception naming one org and one shared drive).
- **Accepted risks to record:** a leaked app key exposes repository names (metadata) of the
  installed orgs until rotated; Google's scripts on `/pick/drive` run with our origin's rights
  (they could call our same-origin API as the owner), as any first-party embed of Google's
  Picker would; an owner can label a pasted Drive link with any name (display only; the id is
  what matches).

## 13. Rollout

Manual steps (maintainer):
1. **GitHub App.** In the org: Settings → Developer settings → GitHub Apps → New GitHub App.
   Name; homepage `https://<PUBLIC_HOST>`; Callback URL empty and "Request user authorization
   (OAuth) during installation" off (no user sign-in is used); Setup URL empty; Webhook **Active off**; Repository permissions:
   **Metadata: Read-only**, nothing else; Organization and Account permissions: none; Events:
   none; "Only on this account". Create.
2. Note the **App ID** and the **slug** (from the app's public link). Under "Private keys",
   **Generate a private key** (a `.pem` downloads). Keep it outside any repository.
3. **Install** the app on the org (app page → Install App → the org → **All repositories**).
4. Run `scripts/gcp-bootstrap.sh` with `GITHUB_APP_ID=…`, `GITHUB_APP_SLUG=…`,
   `GITHUB_APP_KEY_FILE=<path to .pem>` (creates `team-relay-github-app`). Then delete the `.pem`
   (or keep it only in the password manager).
5. In `config/deploy.local.env`: `GITHUB_ORGS=<org login>` and, if wanted (Q1),
   `ALLOWED_SHARED_DRIVES=<shared drive id>[,…]`.
6. **Google APIs.** The bootstrap enables the Google Picker API and the Google Drive API (or:
   APIs & Services → Library → enable both).
7. **OAuth client.** APIs & Services → Credentials → Create credentials → OAuth client ID → Web
   application, name "team-relay picker"; Authorized JavaScript origins `https://<PUBLIC_HOST>`;
   no redirect URIs. Copy the client id. (Consent screen: the existing Internal one; optionally add
   the `…/auth/drive.file` scope to its list.)
8. **API key.** Credentials → Create credentials → API key → Edit: Application restrictions
   **Websites**: `https://<PUBLIC_HOST>/*` and `https://docs.google.com/*`; API restrictions
   **Restrict key** → Google Picker API. Copy the key.
9. Run `scripts/gcp-bootstrap.sh` with `PICKER_CLIENT_ID=…` and `PICKER_API_KEY=…` (creates
   `team-relay-picker`; the project number is read by the script).
10. After the PR merges: `bash scripts/deploy.sh`, then `bash scripts/deploy-console.sh` (no load
    balancer change: `/pick/drive` is a console path behind IAP), then `bash scripts/smoke.sh`.
11. In the console (owner): open the boundaries, pick the repositories/whole org, pick the Drive
    folders (re-pick every "matched by name" drive), save. Run V7-V10.
12. Tell members: run the setup line again (updates the plugin), then Accept in the browser.
13. On one Mac: V1-V6, recorded in the PR or a dated note.

Order and compatibility: until a member's plugin is updated it treats the new boundaries document
as unreadable and declines questions with the busy text (fails closed; Q4). Old daemons' status
(no `sources`) is still accepted. The console and relay deploy together (the console sends the
new body).

## 14. Rollback

- Relay and console: redeploy the previous revisions. The previous relay reads new documents as
  orgs + legacy drives only (members answer from less, never more); `sources` in stored statuses
  are ignored. Members' new plugins read documents without the new fields as before.
- GitHub App: suspend or uninstall it on the org (the listing then shows nothing); remove the
  secret's mount by deleting `team-relay-github-app` and redeploying. Rotate the key in the app's
  settings if exposure is suspected.
- Picker: delete the API key or the OAuth client; the console falls back to paste-only.
- Data: nothing to undo; an owner removes picked items and saves.

## 15. Open questions (each with a recommendation)

- **Q1 GitHub listing tenancy.** (a) one relay-wide allowlist `RELAY_GITHUB_ORGS`: any owner of
  any team on this relay may list those orgs' repository names; (b) a relay admin binds orgs to
  teams; (c) owners sign in to GitHub and see only what they can see. **Recommend (a)** for a
  relay that serves one organisation's own teams under RELAY_ALLOWED_DOMAINS, recorded as an
  accepted risk; move to (b) before teams of another organisation join the relay. Also
  **recommend setting** `GITHUB_ORGS` and `ALLOWED_SHARED_DRIVES` to exactly the sources the
  deployment's own rules allow.
- **Q2 Where the Picker runs.** (a) its own page `/pick/drive` with its own headers (this spec);
  (b) inside the console page, widening the main CSP and setting COOP
  `same-origin-allow-popups` for every page. **Recommend (a)**: Google's scripts never load next to
  team data, and the main headers stay as they are.
- **Q3 A re-picked legacy drive.** (a) a new item: members accept once more; (b) carry the old
  acceptance when the picked drive's name and domain equal the legacy entry's. **Recommend (a)**:
  the name is the only link between them and it is not proof; one more Accept click is cheap.
- **Q4 Members on an old plugin during the switch.** (a) fail closed (old plugins decline until
  updated); (b) the relay serves the M10 shape to old plugins (narrowed: whole orgs and legacy
  drives) based on a new request header. **Recommend (a)** for a small team: one message asking
  members to re-run the setup line; (b) adds a permanent second code path.
- **Q5 App visibility.** (a) "Only on this account" (private); (b) "Any account" (public) to allow
  installing on a second org. **Recommend (a)**; switch to (b) only when a second org's
  repositories are needed (installing still needs that org owner's consent, and Q1's allowlist
  still gates the listing).

## 16. Decisions (maintainer approved the plan, 11 Nov 2026)

- Q1: one relay-wide org allowlist `RELAY_GITHUB_ORGS` (required with the app) and an optional
  `RELAY_ALLOWED_SHARED_DRIVES`; the cross-team visibility of org repo names is an accepted risk
  recorded in the docs; bind orgs to teams before a second organisation's team joins this relay.
- Q2: the Picker runs on its own page `/pick/drive` with its own headers; the console's main headers
  do not change.
- Q3: a drive re-picked after a name-matched legacy entry counts as new (members accept once).
- Q4: members on an old plugin fail safe (decline until updated); no second code path.
- Q5: the GitHub App is "Only on this account".
- Verified on one Mac (11 Nov 2026): V1 subfolders inside a shared drive carry
  `com.google.drivefs.item-id#S` (4 of 4 checked, depth 2-3); V3 `/usr/bin/xattr` present, 4 reads
  in 0.13 s. V2 (listing triggers no downloads), V4-V6 and the browser checks V7-V9 stay open.
- Added to Part S (a lesson from the 11 Nov deploy): `scripts/deploy.sh` refuses to remove a
  setting that is set on the live service but unset locally (e.g. `RELAY_PLUGIN_MARKETPLACE`,
  `RELAY_ALLOWED_DOMAINS`, `RELAY_BRAND_NAME`, and the new ones), naming the setting, unless
  `CONFIRM_REMOVE=<NAME>[,<NAME>]` names it; tested like the other deploy checks.
