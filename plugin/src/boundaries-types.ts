// M10-SPEC §1 and PICKERS-SPEC §2: a team's boundaries, as the relay stores and returns them.
// Shared by the answer host (what a member's answerer may read), the console server (proxy) and
// the console UI.

/**
 * A legacy shared drive, matched by name (M10). PICKERS-SPEC §2.1: a PUT may keep the entries
 * the stored document already holds, never add one; owners pick shared-drive folders instead.
 */
export interface DriveBoundary {
  /** The Google Workspace domain whose Drive for desktop mount counts, e.g. "example.com". */
  domain: string;
  /** The shared drive's name exactly as it appears under "Shared drives". */
  shared_drive: string;
}

/** PICKERS-SPEC §2.1: one GitHub repository, matched by a clone's origin `github.com/<org>/<repo>`. */
export interface RepoBoundary {
  /** The GitHub organisation (or user) that owns the repository, e.g. "example-org". */
  org: string;
  /** The repository's name, e.g. "api". */
  repo: string;
  /** GitHub's repository id from the relay's listing; null when pasted (not checked against GitHub). */
  id: number | null;
}

/**
 * PICKERS-SPEC §2.1: one folder of a shared drive (or the whole shared drive), matched on a
 * member's Mac by the Drive for desktop attribute `com.google.drivefs.item-id#S`.
 */
export interface FolderBoundary {
  /** The Google Workspace domain whose Drive for desktop mount counts, e.g. "example.com". */
  domain: string;
  /** The shared drive's id; null when the folder was pasted as a link (not checked). */
  drive_id: string | null;
  /** The folder's Drive id; equal to `drive_id` when the entry is the whole shared drive. */
  folder_id: string;
  /** The folder's name when picked: display text and a search hint only, never a path. */
  folder_name: string;
  /** The shared drive's name when it could be read; null otherwise ("in a shared drive"). */
  drive_name: string | null;
}

export interface Boundaries {
  /** What the team talks about (1-500 chars). Questions outside it are declined automatically. */
  topic: string;
  /** Whole GitHub orgs: local clones (tracked files only) of any of their repositories. */
  github_orgs: string[];
  /** Single GitHub repositories (of orgs that are not whole-org entries). */
  github_repos: RepoBoundary[];
  /** Picked shared-drive folders and whole shared drives. */
  drive_folders: FolderBoundary[];
  /** Legacy shared drives matched by name, kept from before owners could pick folders. */
  drives: DriveBoundary[];
  /** Whether members may add their own local folders. */
  member_folders: boolean;
}

/**
 * M10-SPEC §1: a boundaries document as the M10 relay wrote and returned it, before the picked
 * lists existed. PICKERS-SPEC §2.3: a reader treats the absent lists as empty (boundaries-rule.ts
 * readBoundaries); a PUT body of this shape is refused.
 */
export type M10Boundaries = Omit<Boundaries, 'github_repos' | 'drive_folders'>;

/**
 * PICKERS-SPEC §2.2: the one key of a boundaries item (boundaries-rule.ts itemKey), used by
 * `since`, acceptance and the missing-sources report. At most 400 characters.
 */
export type ItemKey = `org:${string}` | `repo:${string}` | `folder:${string}` | `drive:${string}`;

/** One item of a boundaries document, by kind (member folders are a switch, not an item). */
export type BoundaryItem =
  | { kind: 'org'; org: string }
  | ({ kind: 'repo' } & RepoBoundary)
  | ({ kind: 'folder' } & FolderBoundary)
  | ({ kind: 'drive' } & DriveBoundary);

/**
 * M10-SPEC §7.1 and PICKERS-SPEC §2.3: in which version each item of the current boundaries was
 * last added (kept while the item stays; the version that added it back when it was dropped in
 * between). A member's acceptance of version n covers an item only when its `since` is at most n.
 */
export interface BoundariesSince {
  /** By lower-case org name. */
  github_orgs: Record<string, number>;
  /** By lower-case `org/repo`. */
  github_repos: Record<string, number>;
  /** By folder id (case kept). */
  drive_folders: Record<string, number>;
  /** One per drive of `boundaries.drives`, in that order. */
  drives: Array<DriveBoundary & { since: number }>;
  /** While members' folders are allowed; null while not. */
  member_folders: number | null;
}

/** `GET`/`PUT /v1/teams/{team}/boundaries`. Never set: `version` 0 and `boundaries` null. */
export interface TeamBoundaries {
  team: string;
  version: number;
  boundaries: Boundaries | null;
  /**
   * M10-SPEC §7.1 (null when `boundaries` is). An item it does not name counts as added in
   * `version`, so no earlier acceptance covers it.
   */
  since?: BoundariesSince | null;
  updated_at: string | null;
  updated_by: string | null;
}

/**
 * `PUT` body: the full document and the version it replaces (stale → 409 version_conflict).
 * PICKERS-SPEC §3.2: every field of `boundaries` is required.
 */
export interface SetBoundariesBody {
  version: number;
  boundaries: Boundaries;
}

/** M11-SPEC §2: `GET`/`PUT /v1/teams/{team}/me/acceptance`. Never accepted: version 0. */
export interface Acceptance {
  version: number;
  accepted_at: string | null;
}

/**
 * M11-SPEC §3: `self_test.reason` while the daemon's first self-test is still running (not a
 * failure). The console recognises the same literal (console/src/lib/setup.ts).
 */
export const SELF_TEST_PENDING = 'the self-test has not run yet';

/**
 * PICKERS-SPEC §3.3: which items of the team's boundaries (version `boundaries_version`) the
 * member's Mac could not find locally, as item keys (never paths or local names). The relay
 * keeps only keys of items of its current boundaries.
 */
export interface MemberSources {
  /** The boundaries version the Mac looked for: 0..2^31-1. */
  boundaries_version: number;
  /** 0-140 item keys, each 1-400 characters with no control or format character. */
  missing: string[];
}

/**
 * M11-SPEC §3: what a member's background answerer reports (counts and booleans only; since
 * PICKERS-SPEC §8 also keys of the team's own boundary items).
 */
export interface MemberStatusBody {
  daemon: { version: string; started_at: string };
  claude: { found: boolean; signed_in: boolean };
  folders: { repo_roots: number; clones: number; extra_folders: number };
  drive: { connected: boolean };
  self_test: { ok: boolean; at: string; reason: string | null };
  /** PICKERS-SPEC §3.3: absent from an older plugin's status. */
  sources?: MemberSources;
}

/** M11-SPEC §3: one member in `GET /v1/teams/{team}/members/status`. */
export interface MemberStatusEntry {
  member: string;
  status: (MemberStatusBody & { seen_at: string }) | null;
  answering: boolean;
  accepted_version: number;
  /**
   * PICKERS-SPEC §3.4: what this member's Mac could not find, filtered against the current
   * boundaries. Owners get every member's; anyone else only their own (others null). Null too
   * when the member's plugin has not reported it.
   */
  sources: MemberSources | null;
}

export interface MembersStatus {
  members: MemberStatusEntry[];
  boundaries_version: number;
}

/** M11-SPEC §4: one of `GET /v1/teams/{team}/me/requests`. */
export interface MyRequest {
  id: string;
  to: '*' | string[];
  created_at: string;
  question_preview: string;
}

/** PICKERS-SPEC §3.5: the public settings of the Google Picker (restricted by Google, not secret). */
export interface GooglePickerConfig {
  /** The picker's own Web OAuth client id (`….apps.googleusercontent.com`). */
  client_id: string;
  /** The browser API key, restricted to the Google Picker API and the console's host. */
  api_key: string;
  /** The Cloud project number, the Picker's `setAppId`. */
  app_id: string;
  /**
   * Hosted only: the viewer's own IAP-verified email, so Google's sign-in offers that account
   * (`login_hint`, and its domain as `hd`), never a personal one (PICKERS-SPEC §5.2).
   */
  login_hint?: string;
}

/**
 * PICKERS-SPEC §3.5: `GET /v1/teams/{team}/sources/config` (owners only, `no-store`). Never holds
 * the GitHub App's key or a token of any kind.
 */
export interface SourcesConfig {
  github: { configured: boolean; install_url: string | null };
  /** Null when the relay has no picker settings, and always in the local console. */
  google_picker: GooglePickerConfig | null;
}

/** PICKERS-SPEC §3.6: one repository of an installation's listing. */
export interface GithubRepo {
  name: string;
  id: number;
  private: boolean;
  archived: boolean;
}

/** PICKERS-SPEC §3.6: one installation of the relay's GitHub App on an allowed org. */
export interface GithubInstallation {
  /** The org's login as GitHub spells it. */
  account: string;
  /** `suspended`: the installation is suspended on GitHub and lists no repositories. */
  state: 'ok' | 'suspended';
  /** GitHub's "All repositories" (`all`) or "Only select repositories" (`selected`). */
  repository_selection: 'all' | 'selected';
  /** Sorted by lower-case name; at most 1000. */
  repos: GithubRepo[];
  /** Whether the installation has more repositories than listed. */
  truncated: boolean;
}

/** PICKERS-SPEC §3.6: `GET /v1/teams/{team}/sources/github` (owners only). */
export interface GithubListing {
  installations: GithubInstallation[];
  /** When the relay read the listing from GitHub (ISO 8601). */
  fetched_at: string;
}
