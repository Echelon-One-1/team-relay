// M10-SPEC §1: a team's boundaries, as the relay stores and returns them. Shared by the answer
// host (what a member's answerer may read), the console server (proxy) and the console UI.

export interface DriveBoundary {
  /** The Google Workspace domain whose Drive for desktop mount counts, e.g. "example.com". */
  domain: string;
  /** The shared drive's name exactly as it appears under "Shared drives". */
  shared_drive: string;
}

export interface Boundaries {
  /** What the team talks about (1-500 chars). Questions outside it are declined automatically. */
  topic: string;
  /** GitHub orgs whose local clones (tracked files only) members answer from. */
  github_orgs: string[];
  /** Shared Google Drives members answer from. */
  drives: DriveBoundary[];
  /** Whether members may add their own local folders. */
  member_folders: boolean;
}

/**
 * M10-SPEC §7.1: in which version each item of the current boundaries was last added (kept
 * while the item stays; the version that added it back when it was dropped in between). A
 * member's acceptance of version n covers an item only when its `since` is at most n.
 */
export interface BoundariesSince {
  /** By lower-case org name. */
  github_orgs: Record<string, number>;
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

/** `PUT` body: the full document and the version it replaces (stale → 409 version_conflict). */
export interface SetBoundariesBody {
  version: number;
  boundaries: Boundaries;
}

/** M11-SPEC §2: `GET`/`PUT /v1/teams/{team}/me/acceptance`. Never accepted: version 0. */
export interface Acceptance {
  version: number;
  accepted_at: string | null;
}

/** M11-SPEC §3: what a member's background answerer reports (counts and booleans only). */
export interface MemberStatusBody {
  daemon: { version: string; started_at: string };
  claude: { found: boolean; signed_in: boolean };
  folders: { repo_roots: number; clones: number; extra_folders: number };
  drive: { connected: boolean };
  self_test: { ok: boolean; at: string; reason: string | null };
}

/** M11-SPEC §3: one member in `GET /v1/teams/{team}/members/status`. */
export interface MemberStatusEntry {
  member: string;
  status: (MemberStatusBody & { seen_at: string }) | null;
  answering: boolean;
  accepted_version: number;
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
