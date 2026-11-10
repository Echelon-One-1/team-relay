import { QueryClient, useMutation, useQuery, useQueryClient, type Query } from '@tanstack/react-query'

import { ApiError, ChangeError, api } from '@/api/client'
import type {
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
} from '@/api/types'
import { emptyActivity, pollActivity, PollError, type ActivityState } from '@/lib/activity'
import { readTeams } from '@/lib/teams'
import { useTeam } from './team'

// Every query about one team is keyed by it (M9 §5), so switching teams reads the other team
// afresh and never mixes two teams' data; the team comes from TeamContext.

// Polling cadence (M2 §5): the feed every 3 s, incrementally from `next_since` (less the
// overlap of M2 §7.1); the
// directory every 10 s. Both stop while the tab is hidden and resume with a fetch as soon
// as it is visible again.
export const ACTIVITY_INTERVAL_MS = 3_000
export const DIRECTORY_INTERVAL_MS = 10_000
export const ACTIVITY_PAGE = 200
/** A backlog larger than one page is drained in this many pages per poll at most. */
const MAX_PAGES_PER_POLL = 5

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: true,
        refetchIntervalInBackground: false,
        staleTime: 1_000,
      },
    },
  })
}

// Over the relay's read budget (429 rate_limited, M2 §7.3) a query keeps what it has,
// waits SLOW_BASE_MS, then twice as long on each further 429 up to SLOW_MAX_MS (or longer
// when the server says so in Retry-After), and returns to its normal cadence on the first
// poll that succeeds.
export const SLOW_BASE_MS = 10_000
export const SLOW_MAX_MS = 60_000

/** Consecutive rate-limited polls, per query. */
const slowStreak = new Map<string, number>()

export function slowDelay(streak: number, retryAfterMs: number | null = null): number {
  const exp = Math.min(SLOW_MAX_MS, SLOW_BASE_MS * 2 ** Math.max(0, Math.min(streak, 10) - 1))
  return Math.max(exp, retryAfterMs ?? 0)
}

async function tracked<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const out = await fn()
    slowStreak.delete(name)
    return out
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'rate_limited') slowStreak.set(name, (slowStreak.get(name) ?? 0) + 1)
    else slowStreak.delete(name)
    throw err
  }
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function whileVisible<T>(name: string, ms: number) {
  return (query: Query<T, ApiError, T, readonly unknown[]>): number | false => {
    if (hidden()) return false
    // Signed out, or not on the team: nothing more will succeed until the page is reloaded.
    if (query.state.error instanceof ApiError && (query.state.error.kind === 'session_expired' || query.state.error.kind === 'not_on_team')) return false
    const streak = slowStreak.get(name) ?? 0
    if (streak === 0) return ms
    const err = query.state.error
    return slowDelay(streak, err instanceof ApiError ? err.retryAfterMs : null)
  }
}

export const activityKey = (team: string | null) => ['activity', team] as const

export function useMe() {
  const team = useTeam()
  return useQuery<Me, ApiError>({
    queryKey: ['me', team],
    queryFn: async () => (await api.me(team)).data,
    staleTime: Infinity,
    retry: (count, err) => err.kind !== 'unauthorized' && err.kind !== 'session_expired' && err.kind !== 'not_on_team' && count < 100,
    retryDelay: (count, err) => (err.kind === 'rate_limited' ? slowDelay(count + 1, err.retryAfterMs) : 3_000),
  })
}

/** The join panel's values (the console server's own configuration): read once. */
export function useJoin() {
  const team = useTeam()
  return useQuery<Join, ApiError>({
    queryKey: ['join', team],
    queryFn: async () => (await api.join(team)).data,
    staleTime: Infinity,
    retry: (count, err) =>
      err.kind !== 'unauthorized' && err.kind !== 'session_expired' && err.kind !== 'not_found' && count < 5,
    retryDelay: 3_000,
  })
}

export function useDirectory() {
  const team = useTeam()
  return useQuery<Directory, ApiError>({
    queryKey: ['directory', team],
    queryFn: () => tracked('directory', async () => (await api.directory(team)).data),
    refetchInterval: whileVisible('directory', DIRECTORY_INTERVAL_MS),
  })
}

/**
 * M7 §3: what waits for the viewer's own answering session, polled with the directory. A
 * console server or relay without the route (404) is not asked again.
 */
export function useInboxSummary() {
  const team = useTeam()
  return useQuery<InboxSummary, ApiError>({
    queryKey: ['inbox-summary', team],
    queryFn: () => tracked('inbox-summary', async () => (await api.inboxSummary(team)).data),
    refetchInterval: (query) => (query.state.error?.kind === 'not_found' ? false : whileVisible<InboxSummary>('inbox-summary', DIRECTORY_INTERVAL_MS)(query)),
  })
}

/**
 * M8 §5: answers waiting for the viewer's approval in their channel working session. Only the
 * local console answers it; a server without the route (404, the hosted console) is not asked again.
 */
export function useApprovalsSummary() {
  return useQuery<ApprovalsSummary, ApiError>({
    queryKey: ['approvals-summary'],
    queryFn: () => tracked('approvals-summary', async () => (await api.approvalsSummary()).data),
    refetchInterval: (query) =>
      query.state.error?.kind === 'not_found' ? false : whileVisible<ApprovalsSummary>('approvals-summary', DIRECTORY_INTERVAL_MS)(query),
  })
}

export const ROSTER_INTERVAL_MS = 30_000
export const rosterKey = (team: string | null) => ['roster', team] as const

/** M6 §2: the team's roster, for the Members panel (owners see emails; members names and roles). */
export function useRoster() {
  const team = useTeam()
  return useQuery<Roster, ApiError>({
    queryKey: rosterKey(team),
    queryFn: () => tracked('roster', async () => (await api.roster(team)).data),
    refetchInterval: whileVisible('roster', ROSTER_INTERVAL_MS),
  })
}

export type RosterChange =
  | { kind: 'add'; member: string; email: string }
  | { kind: 'role'; member: string; role: RosterRole }
  | { kind: 'remove'; member: string }

/** M6 §3: an owner's change, sent once; the roster and the directory are read again after it. */
export function useRosterChange() {
  const qc = useQueryClient()
  const team = useTeam()
  return useMutation<unknown, ChangeError, RosterChange>({
    mutationFn: (c) =>
      c.kind === 'add'
        ? api.addMember(c.member, c.email, team)
        : c.kind === 'role'
          ? api.setRole(c.member, c.role, team)
          : api.removeMember(c.member, team),
    retry: false,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: rosterKey(team) })
      void qc.invalidateQueries({ queryKey: ['directory', team] })
      void qc.invalidateQueries({ queryKey: ['me', team] })
    },
  })
}

// ---------------------------------------------------------------------------------------
// The team's boundaries (M10 §1).

export const BOUNDARIES_INTERVAL_MS = 60_000
export const boundariesKey = (team: string | null) => ['boundaries', team] as const

/**
 * GET /api/boundaries: read on start and every minute (another owner may change them). A
 * console server or relay without the route (404) is not asked again.
 */
export function useBoundaries() {
  const team = useTeam()
  return useQuery<TeamBoundaries, ApiError>({
    queryKey: boundariesKey(team),
    queryFn: () => tracked('boundaries', async () => (await api.boundaries(team)).data),
    refetchInterval: (query) =>
      query.state.error?.kind === 'not_found' ? false : whileVisible<TeamBoundaries>('boundaries', BOUNDARIES_INTERVAL_MS)(query),
  })
}

/**
 * M10 §1: an owner's change, sent once from the version it was read at. The answer becomes the
 * boundaries on screen; after a refusal they are read again (a 409 means someone else saved first).
 */
export function useSetBoundaries() {
  const qc = useQueryClient()
  const team = useTeam()
  return useMutation<TeamBoundaries, ChangeError, { version: number; boundaries: Boundaries }>({
    mutationFn: (c) => api.setBoundaries(c.version, c.boundaries, team),
    retry: false,
    onSuccess: (out) => {
      if (out && typeof out === 'object' && typeof out.version === 'number') qc.setQueryData(boundariesKey(team), out)
      else void qc.invalidateQueries({ queryKey: boundariesKey(team) })
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: boundariesKey(team) })
    },
  })
}

// ---------------------------------------------------------------------------------------
// The viewer's teams (M9 §2, §4, §5, §7).

export const TEAMS_INTERVAL_MS = 60_000
export const teamsKey = ['teams'] as const

/**
 * GET /api/teams, read on start and every minute (new invitations show up). A console
 * server without it (404) serves one team: the console then names none.
 */
export function useTeams() {
  return useQuery<Teams, ApiError>({
    queryKey: teamsKey,
    queryFn: () =>
      tracked('teams', async () => {
        const teams = readTeams((await api.teams()).data)
        if (teams === null) throw new ApiError('failed', null, 'Not a teams answer')
        return teams
      }),
    staleTime: 5_000,
    // A failure shows the console's default team at once (with its own error states); the
    // teams are read again on the next interval.
    retry: false,
    refetchInterval: (query) => (query.state.error?.kind === 'not_found' ? false : whileVisible<Teams>('teams', TEAMS_INTERVAL_MS)(query)),
  })
}

export type TeamChange =
  | { kind: 'create'; name: string; id?: string; owner_member_id: string }
  | { kind: 'answer'; team: string; accept: boolean }
  | { kind: 'delete'; team: string; confirm: string }

/** M9: create a team, answer an invitation, or delete a team; the teams are read again after. */
export function useTeamChange() {
  const qc = useQueryClient()
  return useMutation<unknown, ChangeError, TeamChange>({
    mutationFn: (c) =>
      c.kind === 'create'
        ? api.createTeam({ name: c.name, owner_member_id: c.owner_member_id, ...(c.id ? { id: c.id } : {}) })
        : c.kind === 'answer'
          ? api.answerInvitation(c.team, c.accept)
          : api.deleteTeam(c.team, c.confirm),
    retry: false,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: teamsKey })
      void qc.invalidateQueries({ queryKey: ['admin-teams'] })
    },
  })
}

/** M9 §4: one page of every team, for relay admins. */
export function useAdminTeams(after: string | null) {
  return useQuery<AdminTeamsPage, ApiError>({
    queryKey: ['admin-teams', after],
    queryFn: async () => (await api.adminTeams(after)).data,
    retry: (count, err) => err.kind !== 'unauthorized' && err.kind !== 'session_expired' && err.kind !== 'not_found' && count < 2,
    retryDelay: 2_000,
  })
}

/** M9 §4: an admin deletes a team (its id typed again). */
export function useAdminDelete() {
  const qc = useQueryClient()
  return useMutation<unknown, ChangeError, { team: string; confirm: string }>({
    mutationFn: (c) => api.adminDeleteTeam(c.team, c.confirm),
    retry: false,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['admin-teams'] })
      void qc.invalidateQueries({ queryKey: teamsKey })
    },
  })
}

/** When the feed's polls started failing, or null while they succeed. */
let failingSince: number | null = null

export function resetFeedHealth(): void {
  failingSince = null
  slowStreak.clear()
}

export function useActivity() {
  const qc = useQueryClient()
  const team = useTeam()
  const key = activityKey(team)
  return useQuery<ActivityState, ApiError>({
    queryKey: key,
    queryFn: () =>
      tracked('activity', async () => {
        const prev = qc.getQueryData<ActivityState>(key) ?? emptyActivity()
        let state: ActivityState
        try {
          state = await pollActivity(prev, (since) => api.activity(since, ACTIVITY_PAGE, team), {
            pageSize: ACTIVITY_PAGE,
            maxPages: MAX_PAGES_PER_POLL,
          })
        } catch (e) {
          const err = e instanceof PollError ? e.cause : e
          // Keep the pages that did arrive; the next poll resumes after them.
          if (e instanceof PollError && e.partial !== null) qc.setQueryData(key, e.partial)
          if (!(err instanceof ApiError && err.kind === 'rate_limited')) failingSince ??= Date.now()
          throw err
        }
        failingSince = null
        return state
      }),
    refetchInterval: whileVisible('activity', ACTIVITY_INTERVAL_MS),
    structuralSharing: false,
  })
}

/** The side surface (M1 §3.11), for participants only; polled while the request is open. */
export function useRequestDetail(id: string | null, enabled: boolean, live: boolean) {
  const team = useTeam()
  return useQuery<RequestDetail, ApiError>({
    queryKey: ['request', team, id],
    queryFn: () => tracked('request', async () => (await api.request(id ?? '', team)).data),
    enabled: enabled && id !== null,
    refetchInterval: live ? whileVisible('request', ACTIVITY_INTERVAL_MS) : false,
  })
}

export type Connection =
  | { state: 'connecting' }
  | { state: 'live'; rttMs: number | null; updatedAt: number }
  /** Over the relay's read budget: polling less often, what is on screen is kept. */
  | { state: 'slowed'; updatedAt: number | null }
  | {
      state: 'unreachable'
      reason: 'relay' | 'server'
      since: number
      updatedAt: number | null
      /** The relay refused the console's sign-in (401): /team-relay:login again (M5 §6). */
      signInRefused?: boolean
    }
  | { state: 'unauthorized' }
  /** Hosted: the IAP sign-in lapsed; a reload signs in again. */
  | { state: 'session_expired' }
  /** Hosted (M6 §4): the signed-in account is not on the team. */
  | { state: 'not_on_team'; email: string | null }

/** The relay connection as the header and the banner describe it, from the feed's poll. */
export function useConnection(): Connection {
  const q = useActivity()
  const err = q.error
  if (err?.kind === 'unauthorized') return { state: 'unauthorized' }
  if (err?.kind === 'session_expired') return { state: 'session_expired' }
  if (err?.kind === 'not_on_team') return { state: 'not_on_team', email: err.email }
  const failing = q.isError && err !== null
  if (failing && err.kind === 'rate_limited') {
    return { state: 'slowed', updatedAt: q.data?.receivedAt ?? null }
  }
  if (failing) {
    return {
      state: 'unreachable',
      reason: err.kind === 'relay_unreachable' ? 'relay' : 'server',
      since: failingSince ?? q.errorUpdatedAt,
      updatedAt: q.data?.receivedAt ?? null,
      signInRefused: err.kind === 'relay_unreachable' && err.relayStatus === 401,
    }
  }
  if (!q.data) return { state: 'connecting' }
  return { state: 'live', rttMs: q.data.rttMs, updatedAt: q.data.receivedAt ?? q.dataUpdatedAt }
}
