// A team's boundaries, as the relay stores and returns them. Shared by the answer host, the
// console server (proxy) and the console UI.
//
// Since 13 Nov 2026 (local folders only, schema v3) a team's boundaries are its topic alone:
// what members read from is the folders each one chooses on their own Mac
// (member-folders.ts), never something the owner picks.

export interface Boundaries {
  /** What the team talks about (1-500 chars). Questions outside it are declined automatically. */
  topic: string;
}

/** `GET`/`PUT /v1/teams/{team}/boundaries`. Never set: `version` 0 and `boundaries` null. */
export interface TeamBoundaries {
  team: string;
  version: number;
  boundaries: Boundaries | null;
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

/**
 * M11-SPEC §3: `self_test.reason` while the daemon's first self-test is still running (not a
 * failure). The console recognises the same literal (console/src/lib/setup.ts).
 */
export const SELF_TEST_PENDING = 'the self-test has not run yet';

/** The most folders a member chooses for one team (member-folders.ts MAX_FOLDERS). */
export const FOLDER_COUNT_MAX = 20;

/**
 * M11-SPEC §3 and 13 Nov 2026: what a member's background answerer reports (counts and
 * booleans only; never a folder's name or path).
 */
export interface MemberStatusBody {
  daemon: { version: string; started_at: string };
  claude: { found: boolean; signed_in: boolean };
  /** How many folders the member chose for the team: 0..20. */
  folder_count: number;
  /** False when the member's folders file cannot be used (then folder_count is 0). */
  folders_ok: boolean;
  self_test: { ok: boolean; at: string; reason: string | null };
}

/** One member's status as `GET members/status` returns it (folder counts apart). */
export interface MemberStatus {
  daemon: MemberStatusBody['daemon'];
  claude: MemberStatusBody['claude'];
  self_test: MemberStatusBody['self_test'];
  seen_at: string;
}

/** M11-SPEC §3: one member in `GET /v1/teams/{team}/members/status`. */
export interface MemberStatusEntry {
  member: string;
  status: MemberStatus | null;
  answering: boolean;
  accepted_version: number;
  /**
   * How many folders the member chose. Owners get every member's; anyone else only their own
   * (others null). Null too when the member's plugin has not reported it.
   */
  folder_count: number | null;
  /** Whether the member's folders file can be used; the same visibility as folder_count. */
  folders_ok: boolean | null;
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
