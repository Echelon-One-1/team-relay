// The console's view of the relay, exactly as the local console server proxies it
// (docs/M2-SPEC.md §4.4). Shapes follow M2 §3.1 (directory sessions), §3.5 (the activity
// feed), §3.6 (directory stats) and M1 §3.2 / §3.11 (me, a request's side surface).
// Times are RFC 3339 UTC strings throughout.

export type Iso = string

/** One of the viewer's teams (M9 §2, GET /api/teams). */
export interface TeamEntry {
  team: string
  /** Display name: someone's text, always shown escaped (React does). */
  name: string
  member: string
  role: RosterRole
}

/** An open invitation (M9 §7.2): accepting makes the viewer `member` with `role` there. */
export interface InvitationEntry {
  team: string
  name: string
  member: string
  role: RosterRole
  invited_by_member: string | null
}

/** GET /api/teams: the viewer's teams, as the console server checks them (M9 §2, §5). */
export interface Teams {
  teams: TeamEntry[]
  invitations: InvitationEntry[]
  /** A relay admin (M9 §4): may list and delete every team. */
  admin: boolean
  /** Teams this account created and has not deleted, and the most it may (3). Null: unknown. */
  teams_created: number | null
  max_teams_created: number | null
  suggested_member: string | null
  /** False for a sign-in bound to one team (a device credential): no creating, no invitations. */
  can_manage_teams: boolean
  /** RELAY_TEAM: the console's default team. */
  default_team: string
  /** Hosted: the signed-in Google account. */
  email?: string
}

/** One row of GET /api/admin/teams (M9 §4): no emails, no content. */
export interface AdminTeam {
  id: string
  name: string
  status: 'active' | 'deleted'
  /** A team of the relay's team file: never deleted through the API. */
  seed: boolean
  created_at: Iso | null
  created_by_member: string | null
  members: number
  owners: number
  last_activity_at: Iso | null
  removal?: 'complete' | 'pending'
  deleted_at?: Iso
  reserved_until?: Iso
}

export interface AdminTeamsPage {
  teams: AdminTeam[]
  /** The `after` of the next page, or null on the last. */
  next: string | null
}

/** GET /api/me (M1 §3.2). */
export interface Me {
  team: string
  /** The team's display name (M9), from relays that say. */
  name?: string
  member: string
  teammates: string[]
  /** The viewer's email, when the server gives it (the join panel's commands use it). */
  email?: string
  /** The viewer's role on the roster (M6), from relays that say. */
  role?: RosterRole
}

/**
 * GET /api/join: answered by the console server itself, never the relay (plugin/src/
 * console-app.ts). What a new member needs to install the plugin; nothing secret.
 */
export interface Join {
  relay_url: string
  team: string
  /** The team-relay repository, or null. */
  repo_url: string | null
  /**
   * What `/plugin marketplace add` takes (M5 §1): a GitHub owner/repo or a git URL, or null
   * (ask the team owner). Absent from older console servers.
   */
  marketplace_source?: string | null
  marketplace: string
  plugin: string
  /** True when the team's relay is the plugin's default (no RELAY_URL needed; /team-relay:login takes no relay URL). */
  default_relay?: boolean
}

export type RosterRole = 'owner' | 'member'

/** A shared Google Drive the team answers from (M10 §1). */
export interface DriveBoundary {
  /** The Google Workspace domain, lower case, e.g. example.com. */
  domain: string
  /** The shared drive's name, as it appears under "Shared drives". */
  shared_drive: string
}

/** What a team's answerers may read and talk about (M10 §1). */
export interface Boundaries {
  /** 1-500 characters: what the team talks about; anything else is declined on its own. */
  topic: string
  /** At most 10 GitHub orgs; members answer from the files git tracks in their clones. */
  github_orgs: string[]
  /** At most 10 shared drives. */
  drives: DriveBoundary[]
  /** Members may add their own local folders. */
  member_folders: boolean
}

/**
 * M10 §7.1: in which version each item was last added (kept while it stays; the version that
 * added it back after a removal). Members' answerers use it; the console only passes it on.
 */
export interface BoundariesSince {
  /** By lower-case org name. */
  github_orgs: Record<string, number>
  /** One per drive of `boundaries.drives`, in that order. */
  drives: Array<DriveBoundary & { since: number }>
  /** While members' folders are allowed; null while not. */
  member_folders: number | null
}

/** GET /api/boundaries (M10 §1). Never set: version 0 and boundaries null. */
export interface TeamBoundaries {
  team: string
  version: number
  boundaries: Boundaries | null
  /** M10 §7.1; null when `boundaries` is. */
  since?: BoundariesSince | null
  updated_at: Iso | null
  /** The member who last set them. */
  updated_by: string | null
}

/**
 * One entry of GET /api/roster (M6 §2). Owners see every email; a member sees their own and
 * null for everyone else's.
 */
export interface RosterMember {
  member: string
  emails: Array<string | null> | null
  role: RosterRole
  added_by?: string | null
  added_at?: Iso | null
  /**
   * M9 §7.2: an entry an owner added is `invited` until its person accepts; only owners see
   * invitations. Absent from older relays (read as active).
   */
  status?: 'active' | 'invited'
}

export interface Roster {
  members: RosterMember[]
}

export type Environment = 'staging' | 'production'

export interface ManifestParam {
  type: 'enum' | 'string' | 'integer' | 'number' | 'boolean'
  description: string
  values?: string[]
  default?: unknown
  min?: number
  max?: number
  max_length?: number
  pattern?: string
}

export interface ManifestCapability {
  name: string
  title: string
  description: string
  environment: Environment
  default_enabled?: boolean
  timeout_seconds?: number
  params: Record<string, ManifestParam>
  required?: string[]
}

/** A folder the member's answering session reads without asking, by name only (M4 §3). */
export interface ManifestShare {
  name: string
}

export interface Manifest {
  version: 1
  capabilities: ManifestCapability[]
  /** Absent from older plugins; an empty list is "shares nothing". */
  shares?: ManifestShare[]
}

export interface SessionPresence {
  last_seen: Iso | null
}

export interface MemberStats {
  asked: number
  answered: number
  open: number
  median_answer_seconds: number | null
}

/** One entry of GET /api/directory (M1 §3.4 with M2 §3.1 and §3.6). */
export interface DirectoryMember {
  member: string
  last_seen: Iso | null
  manifest: Manifest | null
  published_at: Iso | null
  sessions: {
    working: SessionPresence
    answering: SessionPresence
  }
  stats: MemberStats
  /**
   * M7 §1: unexpired questions in the member's inbox their answering session has not taken
   * yet, at most 50. Absent from older relays.
   */
  inbox_waiting?: number
}

/** GET /api/inbox/summary (M7 §1): what waits for the viewer's own answering session. */
export interface InboxSummary {
  /** At most 50. */
  pending: number
  /** The count stopped at 50 and more are waiting. */
  more?: boolean
  oldest_at: Iso | null
  /** Distinct senders, at most five. */
  from: string[]
  answering: SessionPresence
}

/**
 * GET /api/approvals/summary (M8 §5, local console only): how many answers wait for the
 * viewer's approval in their channel working session on this computer.
 */
export interface ApprovalsSummary {
  pending: number
}

export interface Directory {
  members: DirectoryMember[]
  /**
   * False when the 24 h window held more requests than the relay reads for stats: the
   * counts then cover the most recently updated ones only (M2 §7.10). Absent from older relays.
   */
  stats_complete?: boolean
}

export type RecipientStatus = 'pending' | 'acked' | 'answered' | 'no_response' | 'timed_out'

/**
 * M2 §3.3; `waiting` (M4 §2): the answering session is asking its member to allow the tool
 * (a read outside the shared folders). The next `ok` or `error` event for it clears that.
 */
export type ToolStatus = 'ok' | 'error' | 'waiting'

export interface ToolEvent {
  tool: string
  status: ToolStatus
  at: Iso
  duration_ms: number | null
}

export interface ActivityRecipient {
  status: RecipientStatus
  delivered_at: Iso | null
  acked_at: Iso | null
  answered_at: Iso | null
  answer_delivered_at: Iso | null
  tools: ToolEvent[]
  progress_count: number
  last_progress_pct: number | null
  /** Participants only; null for everyone else (M2 §3.5). */
  answer_preview: string | null
}

export interface ActivityCapability {
  name: string
  environment: Environment
  /** Participants only; null for everyone else. */
  params: Record<string, unknown> | null
}

/** One request in GET /api/activity (M2 §3.5). */
export interface ActivityRequest {
  request_id: string
  kind: 'question' | 'capability'
  asker: string
  broadcast: boolean
  created_at: Iso
  updated_at: Iso
  ack_deadline: Iso
  answer_deadline: Iso
  expire_at: Iso
  capability: ActivityCapability | null
  /** Participants only; null for everyone else, and for capability calls. */
  question: string | null
  recipients: Record<string, ActivityRecipient>
  participant: boolean
}

export interface ActivityPage {
  requests: ActivityRequest[]
  next_since: Iso | null
  server_time: Iso
}

/** A progress entry on GET /api/requests/{id}: M1 §3.11, with M2 §3.3's `kind`. */
export interface ProgressEntry {
  seq: number
  member: string
  kind?: 'progress' | 'tool'
  text?: string | null
  pct?: number | null
  time: Iso
  tool?: string
  status?: ToolStatus
  duration_ms?: number | null
}

/** GET /api/requests/{id} (M1 §3.11): the asker sees every recipient, a recipient itself. */
export interface RequestDetail {
  request_id: string
  kind: 'question' | 'capability'
  asker: string
  broadcast: boolean
  question: string | null
  capability: ActivityCapability | null
  created_at: Iso
  ack_deadline: Iso
  answer_deadline: Iso
  expire_at: Iso
  recipients: Record<string, Partial<ActivityRecipient> & { status: RecipientStatus }>
  progress: ProgressEntry[]
}
