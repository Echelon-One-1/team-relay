import { consoleKey, isHosted } from './key'
import type {
  ActivityPage,
  AdminTeamsPage,
  ApprovalsSummary,
  Boundaries,
  Directory,
  InboxSummary,
  Join,
  Me,
  RequestDetail,
  Roster,
  RosterRole,
  TeamBoundaries,
  Teams,
} from './types'

// Every call goes to the console server's proxy: locally (M2 §4.4) with the key in
// X-Console-Key; hosted behind IAP (M3 §4) without a key, with the IAP session cookie. A call
// about one team names it in X-Relay-Team (M9 §5), and the console server checks the viewer is
// on it. The only writes are an owner's roster changes (M6 §3), an owner's boundaries (M10 §1)
// and the account's own (M9: create a team, answer an invitation, delete a team, an admin's
// delete): a same-origin JSON POST, PUT, PATCH or DELETE, which the browser marks
// Sec-Fetch-Site: same-origin. Nothing can be sent, acked or replied.

export type Transport = (path: string, init: RequestInit) => Promise<Response>

export type ApiErrorKind =
  /** The console server answered, but the relay behind it did not (502/503/504). */
  | 'relay_unreachable'
  /** Nothing answered at all: the console server is not running any more. */
  | 'server_unreachable'
  /** The key is missing, wrong or from an earlier launch (401/403). */
  | 'unauthorized'
  /**
   * Hosted: the IAP sign-in lapsed. The answer was a redirect (to Google's sign-in), not
   * JSON, or a refusal of the keyless call.
   */
  | 'session_expired'
  | 'not_found'
  /** The relay's per-member read budget is spent (429 rate_limited, M2 §7.3). */
  | 'rate_limited'
  /**
   * Hosted (M6 §4): the Google account IAP signed in is not on the team; the console server
   * answers 403 {"error": "not_on_team", "email"} and no data.
   */
  | 'not_on_team'
  | 'failed'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null
  /** For `rate_limited`: how long the server asked us to wait, when it said. */
  readonly retryAfterMs: number | null
  /** For `not_on_team`: the signed-in account, as the console server named it. */
  readonly email: string | null
  /** For a relay refusal: the relay's status (401: the stored sign-in was refused). */
  readonly relayStatus: number | null

  constructor(
    kind: ApiErrorKind,
    status: number | null,
    message: string,
    retryAfterMs: number | null = null,
    extra: { email?: string | null; relayStatus?: number | null } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.retryAfterMs = retryAfterMs
    this.email = extra.email ?? null
    this.relayStatus = extra.relayStatus ?? null
  }
}

const NOT_ON_TEAM_EMAIL = /^[^\s@<>"'`]{1,64}@[^\s@<>"'`]{1,253}$/

/** The console server's 403 for a signed-in account that is not on the team (M6 §4). */
async function notOnTeam(res: Response): Promise<ApiError | null> {
  if (res.status !== 403 || !isJson(res)) return null
  try {
    const body: unknown = await res.clone().json()
    if (typeof body !== 'object' || body === null || (body as { error?: unknown }).error !== 'not_on_team') return null
    const email = (body as { email?: unknown }).email
    return new ApiError('not_on_team', 403, 'Not on this team', null, {
      email: typeof email === 'string' && NOT_ON_TEAM_EMAIL.test(email) ? email : null,
    })
  } catch {
    return null
  }
}

const TIMEOUT_MS = 10_000

let transport: Transport = (path, init) => fetch(path, init)

export function setTransport(next: Transport): void {
  transport = next
}

export function resetTransport(): void {
  transport = (path, init) => fetch(path, init)
}

export interface Timed<T> {
  data: T
  /** Round trip through the console server to the relay and back, in milliseconds. */
  rttMs: number
}

function expired(status: number | null): ApiError {
  return new ApiError('session_expired', status, 'The sign-in has expired')
}

function isJson(res: Response): boolean {
  return /^application\/json\b/i.test(res.headers.get('Content-Type') ?? '')
}

/** A team id as the relay shapes them; anything else is never sent. */
export const TEAM_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/

function teamHeader(headers: Record<string, string>, team: string | null | undefined): void {
  if (team !== null && team !== undefined && TEAM_ID_RE.test(team)) headers['X-Relay-Team'] = team
}

export async function getJson<T>(path: string, team?: string | null): Promise<Timed<T>> {
  const key = consoleKey()
  const keyless = key === null
  if (keyless && !isHosted()) {
    throw new ApiError('unauthorized', null, 'No console key')
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (!keyless) headers['X-Console-Key'] = key
  teamHeader(headers, team)
  const started = performance.now()
  let res: Response
  try {
    res = await transport(path, {
      method: 'GET',
      headers,
      // Hosted, IAP's session cookie must travel with the call (same origin only); the
      // local console server needs none.
      credentials: keyless ? 'same-origin' : 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      // An expired IAP session answers with a redirect to Google's sign-in: never follow it.
      redirect: 'manual',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : null,
    })
  } catch {
    throw new ApiError('server_unreachable', null, 'The console server did not answer')
  }
  const rttMs = Math.max(0, Math.round(performance.now() - started))
  if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400)) {
    throw expired(res.status || null)
  }
  const stranger = await notOnTeam(res)
  if (stranger) throw stranger
  if (res.status === 401 || res.status === 403) {
    // Keyless (hosted) there is no key to refuse, and a refusal that is not the console
    // server's JSON came from IAP: either way, signing in again is the answer.
    if (keyless || !isJson(res)) throw expired(res.status)
    throw new ApiError('unauthorized', res.status, 'The console key was refused')
  }
  if (res.status === 404) {
    throw new ApiError('not_found', res.status, 'Not found')
  }
  if (res.status === 429) {
    throw new ApiError('rate_limited', res.status, 'Slowed down by the relay', retryAfter(res))
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    // The console server reports a relay refusal as 502 with the relay's status in the body
    // (plugin/src/console-app.ts); a refusal for being over the read budget is a slow-down,
    // not an outage.
    if (res.status === 502 && (await relayRateLimited(res))) {
      throw new ApiError('rate_limited', res.status, 'Slowed down by the relay', retryAfter(res))
    }
    throw new ApiError('relay_unreachable', res.status, 'The relay did not answer', null, { relayStatus: await relayStatusOf(res) })
  }
  if (!res.ok) {
    throw new ApiError('failed', res.status, `Request failed with ${res.status}`)
  }
  // A page instead of JSON is IAP's sign-in (or its interstitial), not the console server.
  if (!isJson(res)) throw expired(res.status)
  let data: T
  try {
    data = (await res.json()) as T
  } catch {
    throw expired(res.status)
  }
  return { data, rttMs }
}

/** Retry-After in seconds (the only form a JSON API sends), capped at five minutes. */
function retryAfter(res: Response): number | null {
  const v = res.headers.get('Retry-After')
  if (v === null || !/^\d{1,6}$/.test(v.trim())) return null
  return Math.min(300, Number(v.trim())) * 1000
}

async function relayStatusOf(res: Response): Promise<number | null> {
  try {
    const body: unknown = await res.clone().json()
    const st = typeof body === 'object' && body !== null ? (body as { relay_status?: unknown }).relay_status : null
    return typeof st === 'number' ? st : null
  } catch {
    return null
  }
}

async function relayRateLimited(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.clone().json()
    if (typeof body !== 'object' || body === null) return false
    const b = body as Record<string, unknown>
    return b.relay_status === 429 || b.relay_error === 'rate_limited' || b.error === 'rate_limited'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------
// Roster changes (M6 §3, §4): the owner's only writes.

/** Why a change did not happen, in words for the panel or dialog it was made in. */
export class ChangeError extends Error {
  readonly status: number | null
  readonly relayStatus: number | null
  /** The relay's error code (team_limit, team_id_unavailable, ...), when it refused. */
  readonly relayError: string | null
  /** The relay's own detail, when it is plain short text. */
  readonly detail: string | null
  /** The session is gone (local key refused, or the IAP sign-in lapsed): reload. */
  readonly signedOut: boolean
  /** The console server says the viewer is not on that team (any more). */
  readonly notOnTeam: boolean
  constructor(
    message: string,
    opts: {
      status?: number | null
      relayStatus?: number | null
      relayError?: string | null
      detail?: string | null
      signedOut?: boolean
      notOnTeam?: boolean
    } = {},
  ) {
    super(message)
    this.name = 'ChangeError'
    this.status = opts.status ?? null
    this.relayStatus = opts.relayStatus ?? null
    this.relayError = opts.relayError ?? null
    this.detail = opts.detail ?? null
    this.signedOut = opts.signedOut ?? false
    this.notOnTeam = opts.notOnTeam ?? false
  }
}

/** The relay's own detail, when it is plain short text; never markup or a wall of text. */
function plainDetail(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t.length > 200 || /[<>]/.test(t)) return null
  return t
}

async function changeError(res: Response): Promise<ChangeError> {
  let body: Record<string, unknown> = {}
  if (isJson(res)) {
    try {
      const b: unknown = await res.json()
      if (typeof b === 'object' && b !== null) body = b as Record<string, unknown>
    } catch {
      body = {}
    }
  }
  if (res.status === 403 && body.error === 'not_on_team') {
    return new ChangeError('This Google account is not on the team.', { status: 403, notOnTeam: true })
  }
  // A refused key (local), or IAP's refusal, which is not the console server's JSON (hosted).
  if (res.status === 401 || (res.status === 403 && (!isJson(res) || body.detail === 'wrong console key'))) {
    return new ChangeError(isHosted() ? 'Your session has expired. Reload to sign in again.' : 'This console link is no longer valid.', {
      status: res.status,
      signedOut: true,
    })
  }
  if (res.status === 400 || res.status === 403 || res.status === 413 || res.status === 415) {
    return new ChangeError(plainDetail(body.detail) ?? 'The console refused that change.', { status: res.status })
  }
  if (res.status === 502 && body.error === 'relay_refused') {
    const rs = typeof body.relay_status === 'number' ? body.relay_status : null
    const detail = plainDetail(body.detail)
    const message =
      rs === 409
        ? (detail ?? 'That member id or email is already on the team.')
        : rs === 403
          ? 'Only team owners can change members.'
          : rs === 429
            ? 'Too many member changes for now. Try again in a while.'
            : rs === 404
              ? (detail ?? 'That member is no longer on the team.')
              : rs === 401
                ? 'The relay refused your sign-in. Run /team-relay:login again.'
                : (detail ?? `The relay refused that change (${rs ?? 'error'}).`)
    const code = typeof body.relay_error === 'string' && /^[a-z_]{1,40}$/.test(body.relay_error) ? body.relay_error : null
    return new ChangeError(message, { status: 502, relayStatus: rs, relayError: code, detail })
  }
  if (res.status >= 500) return new ChangeError('The relay did not answer. Try again.', { status: res.status })
  return new ChangeError(`The change failed (${res.status}).`, { status: res.status })
}

/** A change: JSON, same origin, no redirects followed. Resolves with the relay's answer. */
export async function sendChange<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, team?: string | null): Promise<T> {
  const key = consoleKey()
  if (key === null && !isHosted()) throw new ChangeError('No console key.', { signedOut: true })
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
  if (key !== null) headers['X-Console-Key'] = key
  teamHeader(headers, team)
  let res: Response
  try {
    res = await transport(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: key === null ? 'same-origin' : 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'manual',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : null,
    })
  } catch {
    throw new ChangeError('The console server did not answer.')
  }
  if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400)) {
    throw new ChangeError('Your session has expired. Reload to sign in again.', { signedOut: true })
  }
  if (!res.ok) throw await changeError(res)
  try {
    return (await res.json()) as T
  } catch {
    return {} as T
  }
}

const seg = (v: string) => encodeURIComponent(v)

export const api = {
  /** M9 §2: the viewer's teams (not about one team). */
  teams: () => getJson<Teams>('api/teams'),
  me: (team?: string | null) => getJson<Me>('api/me', team),
  directory: (team?: string | null) => getJson<Directory>('api/directory', team),
  join: (team?: string | null) => getJson<Join>('api/join', team),
  roster: (team?: string | null) => getJson<Roster>('api/roster', team),
  inboxSummary: (team?: string | null) => getJson<InboxSummary>('api/inbox/summary', team),
  approvalsSummary: () => getJson<ApprovalsSummary>('api/approvals/summary'),
  /** M10 §1: the team's boundaries (any member). */
  boundaries: (team?: string | null) => getJson<TeamBoundaries>('api/boundaries', team),
  /** M10 §1: an owner replaces them, from the version they were read at (stale: 409). */
  setBoundaries: (version: number, boundaries: Boundaries, team?: string | null) =>
    sendChange<TeamBoundaries>('PUT', 'api/boundaries', { version, boundaries }, team),
  addMember: (member: string, email: string, team?: string | null) => sendChange<unknown>('POST', 'api/roster', { member, email }, team),
  setRole: (member: string, role: RosterRole, team?: string | null) => sendChange<unknown>('PATCH', `api/roster/${seg(member)}`, { role }, team),
  removeMember: (member: string, team?: string | null) => sendChange<unknown>('DELETE', `api/roster/${seg(member)}`, undefined, team),
  /** M9 §2: create a team; the viewer becomes its first owner. */
  createTeam: (body: { name: string; id?: string; owner_member_id: string }) => sendChange<{ team: string }>('POST', 'api/teams', body),
  /** M9 §7.2: accept or decline an invitation. */
  answerInvitation: (team: string, accept: boolean) => sendChange<unknown>('POST', `api/invitations/${seg(team)}`, { accept }),
  /** M9 §7.7: an owner deletes the team; `confirm` is the id typed again. */
  deleteTeam: (team: string, confirm: string) => sendChange<unknown>('DELETE', `api/teams/${seg(team)}`, { confirm }),
  /** M9 §4: relay admins. */
  adminTeams: (after: string | null, limit = 50) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (after !== null) q.set('after', after)
    return getJson<AdminTeamsPage>(`api/admin/teams?${q.toString()}`)
  },
  adminDeleteTeam: (team: string, confirm: string) => sendChange<unknown>('DELETE', `api/admin/teams/${seg(team)}`, { confirm }),
  activity: (since: string | null, limit = 200, team?: string | null) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (since !== null) q.set('since', since)
    return getJson<ActivityPage>(`api/activity?${q.toString()}`, team)
  },
  request: (id: string, team?: string | null) => {
    if (!/^rq_[0-9a-f]{32}$/.test(id)) {
      return Promise.reject(new ApiError('not_found', null, 'Not a request id'))
    }
    return getJson<RequestDetail>(`api/requests/${id}`, team)
  },
}
