// A scripted, looping stand-in for the console server's /api/* (dev only: `pnpm dev` with
// VITE_MOCK=1, or `?mock` on the dev server). The fixture snapshot is re-based to the
// moment the mock starts, its in-flight requests carry on to completion, and a new round
// of traffic starts every CYCLE_MS, so the live behaviour (edges in flight, tracks
// advancing, presence changing, a broadcast fanning out, a request running out of time)
// can be watched without a relay. It masks exactly as the relay does (M2 §3.5, §7.8): a
// non-participant sees no question, params or answer previews; a recipient sees its own
// answer preview only; the asker sees every one.
//
// M11: the viewer's acceptance of the boundaries (alice accepted version 1 of `demo`'s; they
// are at 2), every member's setup status (bob is set up, alice has not connected Drive, carol's
// Mac has never reported), and questions asked from the console: on `demo` bob acknowledges
// after 1 s and answers after 4 s, carol acknowledges after 2 s and does not answer; nobody
// answers on a quiet team.

import type {
  Acceptance,
  ActivityPage,
  ActivityRecipient,
  ActivityRequest,
  Directory,
  DirectoryMember,
  InboxSummary,
  MemberSetupStatus,
  MemberStatusEntry,
  MembersStatus,
  MyRequest,
  ProgressEntry,
  RequestDetail,
  AdminTeam,
  Boundaries,
  BoundariesSince,
  Roster,
  RosterMember,
  TeamBoundaries,
  Teams,
} from '@/api/types'
import {
  FIXTURE_NOW,
  RQ,
  fixtureCapabilityDetail,
  fixtureDirectory,
  fixtureJoin,
  fixtureMe,
  fixtureAdminTeams,
  fixtureBoundaries,
  fixtureOpsBoundaries,
  fixtureRequests,
  fixtureRoster,
  fixtureTeams,
} from './fixtures'
import { boundariesValid, versionOk } from '@/lib/boundaries'

export const CYCLE_MS = 100_000
/** The relay keeps an equal-updated_at group whole on a page, up to this many (M2 §7.10). */
const MAX_GROUP = 500
const KEEP_CYCLES = 12
const DAY_MS = 24 * 3600_000

const iso = (t: number) => new Date(t).toISOString()
const parse = (s: string) => Date.parse(s)

interface ScriptEvent {
  at: number
  apply: (req: ActivityRequest, progress: ProgressEntry[]) => void
}

interface Script {
  base: ActivityRequest
  events: ScriptEvent[]
}

function blankRecipient(): ActivityRecipient {
  return {
    status: 'pending',
    delivered_at: null,
    acked_at: null,
    answered_at: null,
    answer_delivered_at: null,
    tools: [],
    progress_count: 0,
    last_progress_pct: null,
    answer_preview: null,
  }
}

function rec(req: ActivityRequest, m: string): ActivityRecipient {
  const r = req.recipients[m]
  if (!r) throw new Error(`no recipient ${m}`)
  return r
}

// Event builders --------------------------------------------------------------------------

const deliver = (m: string, at: number): ScriptEvent => ({
  at,
  apply: (q) => {
    rec(q, m).delivered_at ??= iso(at)
  },
})

const ack = (m: string, at: number): ScriptEvent => ({
  at,
  apply: (q) => {
    const r = rec(q, m)
    if (r.status === 'pending' || r.status === 'no_response') r.status = 'acked'
    r.acked_at ??= iso(at)
  },
})

const tool = (m: string, at: number, name: string, status: 'ok' | 'error', durationMs: number): ScriptEvent => ({
  at,
  apply: (q, progress) => {
    rec(q, m).tools.push({ tool: name, status, at: iso(at), duration_ms: durationMs })
    progress.push({
      seq: progress.length + 1,
      member: m,
      kind: 'tool',
      text: null,
      pct: null,
      tool: name,
      status,
      duration_ms: durationMs,
      time: iso(at),
    })
  },
})

/** M4 §2: the answering session asks its member to allow a tool (no duration). */
const waiting = (m: string, at: number, name: string): ScriptEvent => ({
  at,
  apply: (q, progress) => {
    rec(q, m).tools.push({ tool: name, status: 'waiting', at: iso(at), duration_ms: null })
    progress.push({
      seq: progress.length + 1,
      member: m,
      kind: 'tool',
      text: null,
      pct: null,
      tool: name,
      status: 'waiting',
      duration_ms: null,
      time: iso(at),
    })
  },
})

const step = (m: string, at: number, pct: number, text: string): ScriptEvent => ({
  at,
  apply: (q, progress) => {
    const r = rec(q, m)
    r.progress_count += 1
    r.last_progress_pct = pct
    progress.push({ seq: progress.length + 1, member: m, kind: 'progress', text, pct, time: iso(at) })
  },
})

const answer = (m: string, at: number, preview: string): ScriptEvent => ({
  at,
  apply: (q) => {
    const r = rec(q, m)
    r.status = 'answered'
    r.acked_at ??= iso(at)
    r.answered_at = iso(at)
    r.answer_preview = preview
  },
})

const returned = (m: string, at: number): ScriptEvent => ({
  at,
  apply: (q) => {
    rec(q, m).answer_delivered_at ??= iso(at)
  },
})

/** The lazy sweep (M1 §4): a pending recipient past the ack deadline, an acked one past the answer deadline. */
const sweep = (at: number): ScriptEvent => ({
  at,
  apply: (q) => {
    for (const r of Object.values(q.recipients)) {
      if (r.status === 'pending' && at >= parse(q.ack_deadline)) r.status = 'no_response'
      else if (r.status === 'acked' && at >= parse(q.answer_deadline)) r.status = 'timed_out'
    }
  },
})

// Scripts ---------------------------------------------------------------------------------

function hexId(seed: number): string {
  let h = (seed * 2654435761) >>> 0
  let out = ''
  for (let i = 0; i < 32; i++) {
    h = (Math.imul(h ^ (h >>> 15), 2246822519) + i * 374761393) >>> 0
    out += (h & 15).toString(16)
  }
  return `rq_${out}`
}

interface NewRequest {
  id: string
  at: number
  asker: string
  to: string[]
  broadcast?: boolean
  question?: string
  capability?: { name: string; environment: 'staging' | 'production'; params: Record<string, unknown> }
  ackS?: number
  answerS?: number
}

function base(n: NewRequest): ActivityRequest {
  const ackS = n.ackS ?? 120
  const answerS = n.answerS ?? 1800
  return {
    request_id: n.id,
    kind: n.capability ? 'capability' : 'question',
    asker: n.asker,
    broadcast: n.broadcast ?? false,
    created_at: iso(n.at),
    updated_at: iso(n.at),
    ack_deadline: iso(n.at + ackS * 1000),
    answer_deadline: iso(n.at + answerS * 1000),
    expire_at: iso(n.at + 7 * DAY_MS),
    capability: n.capability ?? null,
    question: n.question ?? null,
    recipients: Object.fromEntries(n.to.map((m) => [m, blankRecipient()])),
    participant: true,
  }
}

function cycleScripts(k: number, t0: number): Script[] {
  const s = (sec: number) => t0 + sec * 1000
  const id = (slot: number) => hexId(k * 16 + slot + 1)
  return [
    {
      base: base({
        id: id(0),
        at: s(2),
        asker: 'alice',
        to: ['bob'],
        question: 'Is the payments sandbox key in staging still the one issued in August?',
      }),
      events: [
        deliver('bob', s(2.7)),
        ack('bob', s(6.1)),
        tool('bob', s(9.4), 'Grep', 'ok', 51),
        // The key file is outside bob's shared folders: he is asked, and allows it.
        waiting('bob', s(10.3), 'Read'),
        tool('bob', s(19.2), 'Read', 'ok', 14),
        answer('bob', s(24.6), 'Yes. deploy/staging.env still references the August key; its rotation is scheduled for 1 October.'),
        returned('bob', s(25.8)),
      ],
    },
    {
      base: base({
        id: id(1),
        at: s(14),
        asker: 'bob',
        to: ['alice'],
        question: 'Which dashboard shows the ingest lag you mentioned this morning?',
      }),
      events: [
        deliver('alice', s(14.5)),
        ack('alice', s(18.2)),
        tool('alice', s(21.3), 'Read', 'ok', 11),
        answer('alice', s(33.9), 'The Grafana board "Ingest / lag by source", panel three. The staging lag spikes after each deploy.'),
        returned('alice', s(35.1)),
      ],
    },
    {
      base: base({
        id: id(2),
        at: s(28),
        asker: 'alice',
        to: ['carol'],
        capability: { name: 'service_health', environment: 'staging', params: { service: 'worker' } },
        ackS: 60,
        answerS: 60,
      }),
      events: [
        deliver('carol', s(28.8)),
        ack('carol', s(31.5)),
        step('carol', s(32.2), 50, 'Calling the worker health endpoint'),
        tool('carol', s(34.6), 'service_health', 'ok', 1320),
        answer('carol', s(36.1), 'worker is healthy: 200 in 112 ms, 0 errors in the last 15 minutes, queue depth 4.'),
        returned('carol', s(37.4)),
      ],
    },
    {
      base: base({
        id: id(3),
        at: s(44),
        asker: 'alice',
        to: ['bob', 'carol'],
        broadcast: true,
        question: 'Who owns the orders table migration that is blocking the release branch?',
      }),
      events: [
        deliver('bob', s(44.6)),
        deliver('carol', s(45.1)),
        ack('bob', s(48.9)),
        ack('carol', s(53.2)),
        tool('bob', s(51.0), 'Grep', 'ok', 66),
        tool('carol', s(56.4), 'Grep', 'error', 3),
        tool('carol', s(57.9), 'Grep', 'ok', 48),
        answer('bob', s(61.8), 'Not mine; git blame on the migration points at carol.'),
        returned('bob', s(62.9)),
        tool('carol', s(60.2), 'Read', 'ok', 17),
        answer('carol', s(70.4), 'Mine. It is waiting on the backfill; I will land it after the 14:00 freeze lifts.'),
        returned('carol', s(71.6)),
      ],
    },
    {
      base: base({
        id: id(4),
        at: s(58),
        asker: 'carol',
        to: ['bob'],
        question: 'Can you share the staging connection limits you tuned last week?',
      }),
      events: [
        deliver('bob', s(58.6)),
        ack('bob', s(62.3)),
        tool('bob', s(65.7), 'Read', 'ok', 13),
        answer('bob', s(79.2), 'max_connections 200, pool 40 per service, idle timeout 30 s.'),
        returned('bob', s(80.1)),
      ],
    },
    {
      base: base({
        id: id(5),
        at: s(72),
        asker: 'alice',
        to: ['bob'],
        capability: {
          name: 'staging_db_query',
          environment: 'staging',
          params: { dataset: 'events', field: 'created_on', op: 'gt', value: '2026-09-22', limit: 50 },
        },
        ackS: 60,
        answerS: 120,
      }),
      events: [
        deliver('bob', s(72.7)),
        ack('bob', s(75.0)),
        step('bob', s(75.8), 30, 'Reading events created after 2026-09-22'),
        tool('bob', s(78.9), 'staging_db_query', 'ok', 2410),
        step('bob', s(79.6), 80, '50 rows, summarising'),
        answer('bob', s(84.3), '50 rows (the limit). Most are checkout_started and payment_failed, all from the eu-west tenant.'),
        returned('bob', s(85.2)),
      ],
    },
    {
      base: base({
        id: id(6),
        at: s(86),
        asker: 'alice',
        to: ['carol'],
        question: 'Do you still have the load-test results from Tuesday?',
        ackS: 10,
        answerS: 60,
      }),
      // The feed reports the stored status (M2 §7.2): until the sweep runs, 3.5 s after the
      // ack deadline, the console derives "no response" from the deadline itself.
      events: [deliver('carol', s(86.8)), sweep(s(99.5))],
    },
    {
      // bob asks everyone: alice is a co-recipient, so she sees her own answer and not carol's.
      base: base({
        id: id(7),
        at: s(36),
        asker: 'bob',
        to: ['alice', 'carol'],
        broadcast: true,
        question: 'Is anyone still using the old CI cache key on their branch?',
      }),
      events: [
        deliver('alice', s(36.5)),
        deliver('carol', s(36.9)),
        ack('alice', s(39.4)),
        ack('carol', s(41.0)),
        tool('alice', s(42.1), 'Grep', 'ok', 42),
        answer('alice', s(47.3), 'Not on mine; my branches were rebased onto the new key on Monday.'),
        returned('alice', s(48.2)),
        tool('carol', s(44.8), 'Grep', 'ok', 58),
        answer('carol', s(52.6), 'One branch, carol/backfill; I will switch it over today.'),
        returned('carol', s(53.5)),
      ],
    },
  ]
}

/** The fixture's in-flight requests carry on from where the snapshot left them. */
function fixtureScripts(shift: number): Script[] {
  const at = (sec: number) => parse(FIXTURE_NOW) + shift + sec * 1000
  return fixtureRequests.map((req) => {
    const b = shiftRequest(req, shift)
    switch (req.request_id) {
      case RQ.working:
        return {
          base: b,
          events: [
            tool('bob', at(4), 'Read', 'ok', 16),
            tool('bob', at(7), 'Grep', 'ok', 39),
            answer('bob', at(15), 'Migration 0142_add_fulfilment_state added it on 12 September; staging is on 0144, so it is applied.'),
            returned('bob', at(16.2)),
          ],
        }
      case RQ.incoming:
        return {
          base: b,
          events: [
            ack('alice', at(5)),
            tool('alice', at(8), 'Read', 'ok', 10),
            answer('alice', at(19), 'Only in staging. Production rotates with the quarterly job on 1 October.'),
            returned('alice', at(20.4)),
          ],
        }
      case RQ.returning:
        return { base: b, events: [returned('carol', at(3))] }
      case RQ.grant:
        // carol allows the read; the answer follows.
        return {
          base: b,
          events: [
            tool('carol', at(6), 'Read', 'ok', 14),
            answer('carol', at(14), 'It says to page the platform on-call if the backlog stays above 5,000 for ten minutes.'),
            returned('carol', at(15.2)),
          ],
        }
      case RQ.capability:
        // Its progress notes, re-timed, so the detail sheet has them to show.
        return {
          base: b,
          events: fixtureCapabilityDetail.progress
            .filter((p) => p.kind === 'progress')
            .map((p) => {
              const t = parse(p.time) + shift
              return {
                at: t,
                apply: (_q: ActivityRequest, progress: ProgressEntry[]) => {
                  progress.push({ ...p, seq: progress.length + 1, time: iso(t) })
                },
              }
            }),
        }
      default:
        return { base: b, events: [] }
    }
  })
}

function shiftIso(s: string | null, shift: number): string | null {
  return s === null ? null : iso(parse(s) + shift)
}

function shiftRequest(req: ActivityRequest, shift: number): ActivityRequest {
  const q = structuredClone(req)
  q.created_at = iso(parse(q.created_at) + shift)
  q.updated_at = iso(parse(q.updated_at) + shift)
  q.ack_deadline = iso(parse(q.ack_deadline) + shift)
  q.answer_deadline = iso(parse(q.answer_deadline) + shift)
  q.expire_at = iso(parse(q.expire_at) + shift)
  for (const r of Object.values(q.recipients)) {
    r.delivered_at = shiftIso(r.delivered_at, shift)
    r.acked_at = shiftIso(r.acked_at, shift)
    r.answered_at = shiftIso(r.answered_at, shift)
    r.answer_delivered_at = shiftIso(r.answer_delivered_at, shift)
    for (const t of r.tools) t.at = iso(parse(t.at) + shift)
  }
  return q
}

// The relay stand-in ----------------------------------------------------------------------

interface Materialised {
  request: ActivityRequest
  progress: ProgressEntry[]
}

function materialise(script: Script, now: number): Materialised | null {
  if (parse(script.base.created_at) > now) return null
  const request = structuredClone(script.base)
  const progress: ProgressEntry[] = []
  let updated = parse(request.updated_at)
  for (const e of [...script.events].sort((a, b) => a.at - b.at)) {
    if (e.at > now) break
    e.apply(request, progress)
    updated = Math.max(updated, e.at)
  }
  request.updated_at = iso(updated)
  return { request, progress }
}

/** What `viewer` may see of a request, exactly as the relay's feed entry (M2 §3.5, §7.8). */
export function maskFor(viewer: string, req: ActivityRequest): ActivityRequest {
  const isAsker = req.asker === viewer
  const participant = isAsker || viewer in req.recipients
  const q = structuredClone(req)
  q.participant = participant
  if (!participant) {
    q.question = null
    if (q.capability) q.capability.params = null
  }
  for (const [m, r] of Object.entries(q.recipients)) {
    if (!isAsker && m !== viewer) r.answer_preview = null
  }
  return q
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const v = s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
  return Math.round(v * 10) / 10
}

/** What a Mac reports (M11 §3), all set unless said otherwise. Synthetic. */
export function mockStatus(now: number, o: { found?: boolean; signedIn?: boolean; roots?: number; drive?: boolean; selfOk?: boolean; reason?: string | null }): MemberSetupStatus {
  return {
    daemon: { version: '0.11.0', started_at: iso(now - 3_600_000) },
    claude: { found: o.found ?? true, signed_in: o.signedIn ?? true },
    folders: { repo_roots: o.roots ?? 1, clones: 6, extra_folders: 0 },
    drive: { connected: o.drive ?? true },
    self_test: { ok: o.selfOk ?? true, at: iso(now - 600_000), reason: o.reason ?? null },
    seen_at: iso(now - 20_000),
  }
}

/** M11 §4: how bob and carol take a question asked from the console (synthetic). */
const MOCK_REPLIES: Record<string, { ack: number; at: number | null; text: string }> = {
  bob: {
    ack: 1000,
    at: 4000,
    text: 'The export job is jobs/export_invoices.\nRetries are set in config/jobs.yaml: three attempts, backoff from 30 s.',
  },
  carol: { ack: 2000, at: null, text: '' },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export class MockRelay {
  readonly startedAt: number
  /** Whose view this is: the relay masks per caller. The fixtures' viewer is alice. */
  readonly viewer: string
  reachable = true
  /** Answers every /api/* call with 429 rate_limited while set (M2 §7.3), for the dev view. */
  rateLimited = false
  /** M6 §4: answers as the console server does for a signed-in account not on the team. */
  stranger = false
  /**
   * M7 §3, for the dev view (?waiting): the viewer has questions waiting and no answering
   * session, and carol's answering session has stopped with questions waiting for her.
   */
  waiting = false
  /** The viewer's role on the roster (M6 §4): an owner manages members; a member only reads. */
  role: 'owner' | 'member' = 'owner'
  /** M6 §1, in memory: changes an owner makes, under the relay's invariants. */
  private rosterEntries: RosterMember[] = structuredClone(fixtureRoster.members)
  /** M9: the viewer's teams, invitations and the relay's other teams, in memory. */
  private account: Teams = structuredClone(fixtureTeams)
  private world: AdminTeam[] = structuredClone(fixtureAdminTeams)
  /** The quiet teams (every team but `demo`): their rosters; no traffic. */
  private quiet = new Map<string, RosterMember[]>([
    [
      'research',
      [
        { member: 'alice', emails: ['alice@example.com'], role: 'owner', added_by: 'alice', added_at: '2026-09-19T10:00:00Z' },
        { member: 'erin', emails: ['erin@example.com'], role: 'member', added_by: 'alice', added_at: '2026-09-19T10:05:00Z' },
        { member: 'frank', emails: ['frank@example.com'], role: 'member', added_by: 'alice', added_at: '2026-09-23T08:00:00Z', status: 'invited' },
      ],
    ],
  ])
  /** M10 §1: each team's boundaries; a team not here has never had them set. */
  private bounds = new Map<string, TeamBoundaries>([['demo', structuredClone(fixtureBoundaries)]])
  /** M11 §2: the viewer's acceptance per team; a team not here was never accepted. */
  private accepted = new Map<string, Acceptance>([['demo', { version: 1, accepted_at: '2026-09-20T12:00:00Z' }]])
  /** M11 §3: each member's status on `demo` (tests change them with setMemberStatus). */
  private statuses = new Map<string, { status: MemberSetupStatus | null; answering: boolean; accepted?: number }>()
  /** M11 §4: questions asked from the console, per team, with each recipient's full answer. */
  private asked: Array<{ team: string; script: Script; answers: Record<string, string> }> = []
  private readonly shift: number
  private readonly now: () => number

  constructor(now: () => number = Date.now, viewer: string = fixtureMe.member) {
    this.now = now
    this.viewer = viewer
    this.startedAt = now()
    this.shift = this.startedAt - parse(FIXTURE_NOW)
  }

  private scripts(now: number): Script[] {
    const out = fixtureScripts(this.shift)
    out.push(...this.asked.filter((a) => a.team === 'demo').map((a) => a.script))
    const current = Math.floor((now - this.startedAt) / CYCLE_MS)
    for (let k = Math.max(0, current - KEEP_CYCLES); k <= current; k++) {
      out.push(...cycleScripts(k, this.startedAt + k * CYCLE_MS))
    }
    return out
  }

  state(now = this.now()): Materialised[] {
    return this.scripts(now)
      .map((s) => materialise(s, now))
      .filter((m): m is Materialised => m !== null && parse(m.request.expire_at) > now)
  }

  activity(since: string | null, limit: number, now = this.now()): ActivityPage {
    const from = since === null ? now - DAY_MS : parse(since)
    const docs = this.state(now)
      .map((m) => m.request)
      .filter((r) => parse(r.updated_at) > from)
      .sort((a, b) => parse(a.updated_at) - parse(b.updated_at) || a.request_id.localeCompare(b.request_id))
    // As the relay pages (M2 §7.10): never split a group of equal updated_at across pages.
    // Cut before the group that straddles the limit, or, when that group is the whole page,
    // return the group whole (at most MAX_GROUP).
    let rows = docs.slice(0, limit)
    const boundary = rows.at(-1)?.updated_at
    if (docs.length > limit && docs[limit]?.updated_at === boundary) {
      const before = rows.filter((r) => r.updated_at !== boundary)
      rows = before.length > 0 ? before : docs.filter((r) => r.updated_at === boundary).slice(0, MAX_GROUP)
    }
    const last = rows.at(-1)
    return {
      requests: rows.map((r) => maskFor(this.viewer, r)),
      next_since: last ? last.updated_at : since === null ? iso(from) : since,
      server_time: iso(now),
    }
  }

  directory(now = this.now()): Directory {
    const all = this.state(now).map((m) => m.request)
    const since = now - DAY_MS
    const recent = all.filter((r) => parse(r.created_at) > since)
    const fixtureIds = new Set(fixtureRequests.map((f) => f.request_id))
    const members: DirectoryMember[] = fixtureDirectory.members.map((m) => {
      const d = structuredClone(m)
      d.published_at = shiftIso(d.published_at, this.shift)
      const polling = iso(now - (now % 15_000)) // presence is written at most every 15 s
      if (m.member === 'bob') {
        d.sessions = { working: { last_seen: polling }, answering: { last_seen: polling } }
      } else {
        d.sessions = { working: { last_seen: this.carolWorkingSeen(now) }, answering: { last_seen: this.waiting ? iso(now - 20 * 60_000) : polling } }
      }
      // M7 §1: an answering session that is polling takes what arrives at once.
      d.inbox_waiting = this.waiting && m.member === 'carol' ? 3 : 0
      d.last_seen =
        [d.sessions.working.last_seen, d.sessions.answering.last_seen]
          .filter((x): x is string => x !== null)
          .sort()
          .at(-1) ?? null

      // The fixture's stats are the 24 h baseline; the scripted rounds add to them.
      const scripted = recent.filter((r) => !fixtureIds.has(r.request_id))
      const mine = recent.flatMap((r) => {
        const s = r.recipients[m.member]
        return s ? [{ r, s }] : []
      })
      const answerSeconds = mine
        .filter(({ s }) => s.status === 'answered' && s.answered_at !== null)
        .map(({ r, s }) => (parse(s.answered_at ?? r.created_at) - parse(r.created_at)) / 1000)
      d.stats = {
        asked: m.stats.asked + scripted.filter((r) => r.asker === m.member).length,
        answered:
          m.stats.answered +
          scripted.filter((r) => r.recipients[m.member]?.status === 'answered').length,
        // Open only while the relevant deadline is ahead (M2 §7.2), as the relay counts it.
        open: mine.filter(
          ({ r, s }) =>
            (s.status === 'pending' && now < parse(r.ack_deadline)) ||
            (s.status === 'acked' && now < parse(r.answer_deadline)),
        ).length,
        median_answer_seconds: median(answerSeconds),
      }
      return d
    })
    return { members, stats_complete: true }
  }

  /** GET /api/inbox/summary (M7 §1) as the viewer reads it. */
  inboxSummary(now = this.now()): InboxSummary {
    if (!this.waiting) return { pending: 0, more: false, oldest_at: null, from: [], answering: { last_seen: iso(now - (now % 15_000)) } }
    return { pending: 2, more: false, oldest_at: iso(now - 7 * 60_000), from: ['bob', 'carol'], answering: { last_seen: null } }
  }

  /**
   * carol's working session wakes up to ask her question in each round (50 s to 85 s into
   * it) and is idle the rest of the time; before her first round it is the fixture's.
   */
  private carolWorkingSeen(now: number): string {
    const t = now - this.startedAt
    const k = Math.floor(t / CYCLE_MS)
    const phase = t - k * CYCLE_MS
    if (phase >= 50_000 && phase < 85_000) return iso(now - (now % 15_000))
    const lastRound = phase >= 85_000 ? k : k - 1
    if (lastRound < 0) {
      const seen = fixtureDirectory.members.find((m) => m.member === 'carol')?.sessions.working.last_seen
      return iso(parse(seen ?? FIXTURE_NOW) + this.shift)
    }
    return iso(this.startedAt + lastRound * CYCLE_MS + 84_000)
  }

  detail(id: string, now = this.now()): RequestDetail | null {
    const found = this.state(now).find((m) => m.request.request_id === id)
    if (!found) return null
    const r = found.request
    const viewer = this.viewer
    const isAsker = r.asker === viewer
    if (!isAsker && !(viewer in r.recipients)) return null
    // M11 §4: the asker reads each recipient's full answer next to its preview.
    const full = this.asked.find((a) => a.script.base.request_id === id)?.answers ?? {}
    const visible = Object.fromEntries(
      Object.entries(r.recipients)
        .filter(([m]) => isAsker || m === viewer)
        .map(([m, rr]) => [m, isAsker ? { ...rr, answer: rr.status === 'answered' ? (full[m] ?? rr.answer_preview) : null } : rr]),
    )
    return {
      request_id: r.request_id,
      kind: r.kind,
      asker: r.asker,
      broadcast: r.broadcast,
      question: r.question,
      capability: r.capability,
      created_at: r.created_at,
      ack_deadline: r.ack_deadline,
      answer_deadline: r.answer_deadline,
      expire_at: r.expire_at,
      recipients: visible,
      progress: found.progress.filter((p) => isAsker || p.member === viewer),
    }
  }

  /**
   * GET /api/roster as the relay masks it (M6 §2): an owner sees every email; a member sees
   * their own and null for everyone else's.
   */
  roster(): Roster {
    const owner = this.viewerRole() === 'owner'
    // As a member (?role=member), bob owns the team and alice is a member.
    const view = this.role === 'owner' ? this.rosterEntries : this.rosterEntries.map((m) => ({ ...m, role: m.member === 'bob' ? ('owner' as const) : ('member' as const) }))
    return {
      members: view.filter((m) => owner || m.status !== 'invited').map((m) => ({
        ...m,
        emails: owner || m.member === this.viewer ? [...(m.emails ?? [])] : (m.emails ?? []).map(() => null),
      })),
    }
  }

  private viewerRole(): 'owner' | 'member' {
    return this.rosterEntries.find((m) => m.member === this.viewer)?.role === 'owner' && this.role === 'owner' ? 'owner' : 'member'
  }

  /** M6 §2 changes, refused as the relay refuses them (403 for a member, 409 for a conflict). */
  change(method: string, p: string, body: unknown): Response {
    const refuse = (status: number, code: string, detail: string) =>
      json({ error: 'relay_refused', relay_status: status, relay_error: code, detail }, 502)
    if (this.viewerRole() !== 'owner') return refuse(403, 'forbidden', 'Only owners can change the roster.')
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const owners = () => this.rosterEntries.filter((m) => m.role === 'owner').length
    const emailsOf = (m: RosterMember) => (m.emails ?? []).filter((e): e is string => typeof e === 'string')
    if (method === 'POST' && p === '/api/roster') {
      const member = String(b.member ?? '')
      const email = String(b.email ?? '').toLowerCase()
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(member) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'bad_request', detail: 'member and email are required' }, 400)
      }
      if (this.rosterEntries.some((m) => m.member === member)) return refuse(409, 'conflict', 'That member id is already on the team.')
      if (this.rosterEntries.some((m) => emailsOf(m).includes(email))) {
        return refuse(409, 'conflict', 'That email already belongs to a member of the team.')
      }
      const entry: RosterMember = { member, emails: [email], role: 'member', added_by: this.viewer, added_at: new Date(this.now()).toISOString(), status: 'invited' }
      this.rosterEntries.push(entry)
      return json(entry, 201)
    }
    const m = /^\/api\/roster\/([a-z][a-z0-9_]{1,31})$/.exec(p)
    const target = m ? this.rosterEntries.find((x) => x.member === m[1]) : undefined
    if (!target) return json({ error: 'not_found' }, 404)
    if (method === 'PATCH') {
      if (b.role === 'member' && target.role === 'owner' && owners() === 1) {
        return refuse(409, 'last_owner', 'A team always has at least one owner.')
      }
      if (b.role === 'owner' || b.role === 'member') target.role = b.role
      return json(target)
    }
    if (method === 'DELETE') {
      if (target.role === 'owner' && owners() === 1) return refuse(409, 'last_owner', 'A team always has at least one owner.')
      this.rosterEntries = this.rosterEntries.filter((x) => x !== target)
      return json({ member: target.member, removed: true })
    }
    return json({ error: 'method_not_allowed' }, 405)
  }

  // --- M10: boundaries ----------------------------------------------------------------------

  /** GET and PUT /api/boundaries for `team`, by the relay's rules (owners write, at the current version). */
  private boundariesCall(team: string, method: string, body: unknown): Response {
    const current: TeamBoundaries = this.bounds.get(team) ?? { team, version: 0, boundaries: null, since: null, updated_at: null, updated_by: null }
    if (method === 'GET') return json(current)
    if (method !== 'PUT') return json({ error: 'method_not_allowed' }, 405)
    const mine = this.account.teams.find((t) => t.team === team)!
    const owner = team === 'demo' ? this.viewerRole() === 'owner' : mine.role === 'owner'
    if (!owner) return this.refuse(403, 'forbidden', 'Only team owners can set the boundaries.')
    const b = (typeof body === 'object' && body !== null ? body : {}) as { version?: unknown; boundaries?: TeamBoundaries['boundaries'] }
    if (!versionOk(b.version) || !boundariesValid(b.boundaries)) {
      return json({ error: 'invalid_body', detail: 'These boundaries break the rule the relay checks (M10 §7.5).' }, 400)
    }
    if (b.version !== current.version) return this.refuse(409, 'version_conflict', 'The boundaries changed since you read them.')
    const next: TeamBoundaries = {
      team,
      version: current.version + 1,
      boundaries: structuredClone(b.boundaries),
      since: nextSince(current, current.version + 1, b.boundaries),
      updated_at: new Date(this.now()).toISOString(),
      updated_by: team === 'demo' ? this.viewer : mine.member,
    }
    this.bounds.set(team, next)
    return json(next)
  }

  /** Another owner saves while the viewer edits (tests and the dev view). */
  setBoundariesAs(team: string, member: string, boundaries: NonNullable<TeamBoundaries['boundaries']>): void {
    const current = this.bounds.get(team)
    const version = (current?.version ?? 0) + 1
    this.bounds.set(team, { team, version, boundaries, since: nextSince(current ?? null, version, boundaries), updated_at: new Date(this.now()).toISOString(), updated_by: member })
  }

  // --- M11: acceptance, members' status, asking ------------------------------------------

  /** Sets what a member's Mac last reported on `demo` (tests and the dev view). */
  setMemberStatus(member: string, status: MemberSetupStatus | null, answering: boolean, accepted?: number): void {
    this.statuses.set(member, { status, answering, ...(accepted !== undefined ? { accepted } : {}) })
  }

  private memberStatus(team: string): MembersStatus {
    const bounds = this.bounds.get(team)
    const version = bounds?.version ?? 0
    const now = this.now()
    const mine = this.account.teams.find((t) => t.team === team)!
    const viewerAccepted = this.accepted.get(team)?.version ?? 0
    if (team !== 'demo') {
      const roster = (this.quiet.get(team) ?? []).filter((m) => m.status !== 'invited')
      return {
        members: roster.map((m) => ({ member: m.member, status: null, answering: false, accepted_version: m.member === mine.member ? viewerAccepted : 0 })),
        boundaries_version: version,
      }
    }
    const defaults: Record<string, { status: MemberSetupStatus | null; answering: boolean; accepted?: number }> = {
      alice: { status: mockStatus(now, { drive: false }), answering: true },
      bob: { status: mockStatus(now, {}), answering: true, accepted: version },
      carol: { status: null, answering: false, accepted: 0 },
    }
    const members: MemberStatusEntry[] = this.rosterEntries
      .filter((m) => m.status !== 'invited')
      .map((m) => {
        const s = this.statuses.get(m.member) ?? defaults[m.member] ?? { status: null, answering: false }
        const accepted = m.member === this.viewer ? viewerAccepted : (s.accepted ?? 0)
        return { member: m.member, status: s.status, answering: s.answering, accepted_version: accepted }
      })
    return { members, boundaries_version: version }
  }

  private viewerOn(team: string): string {
    return team === 'demo' ? this.viewer : this.account.teams.find((t) => t.team === team)!.member
  }

  private teammatesOn(team: string): string[] {
    const viewer = this.viewerOn(team)
    const roster = team === 'demo' ? this.rosterEntries : (this.quiet.get(team) ?? [])
    return roster.filter((m) => m.status !== 'invited' && m.member !== viewer).map((m) => m.member)
  }

  /** M11 §2-§4 for `team`, by the relay's rules. */
  private m11(team: string, method: string, p: string, body: unknown): Response {
    const now = this.now()
    if (p === '/api/acceptance') {
      if (method === 'GET') return json(this.accepted.get(team) ?? { version: 0, accepted_at: null })
      if (method !== 'PUT') return json({ error: 'method_not_allowed' }, 405)
      const b = (typeof body === 'object' && body !== null ? body : {}) as { version?: unknown }
      if (!versionOk(b.version) || Object.keys(b).some((k) => k !== 'version')) return json({ error: 'bad_request', detail: 'send {"version": n}' }, 400)
      const bounds = this.bounds.get(team)
      if (!bounds?.boundaries) return this.refuse(409, 'not_set', 'The team has no boundaries to accept yet.')
      if (b.version !== bounds.version) return this.refuse(409, 'version_conflict', 'The boundaries changed since you read them.')
      const out = { version: b.version, accepted_at: iso(now) }
      this.accepted.set(team, out)
      return json(out)
    }
    if (method === 'GET' && p === '/api/members-status') return json(this.memberStatus(team))
    if (method === 'GET' && p === '/api/my-requests') {
      const viewer = this.viewerOn(team)
      const docs =
        team === 'demo'
          ? this.state(now).map((m) => m.request)
          : this.asked.filter((a) => a.team === team).flatMap((a) => (materialise(a.script, now)?.request ? [materialise(a.script, now)!.request] : []))
      const requests: MyRequest[] = docs
        .filter((d) => d.asker === viewer && d.kind === 'question')
        .sort((a, b) => parse(b.created_at) - parse(a.created_at) || b.request_id.localeCompare(a.request_id))
        .slice(0, 20)
        .map((d) => ({ id: d.request_id, to: d.broadcast ? '*' : Object.keys(d.recipients), created_at: d.created_at, question_preview: [...(d.question ?? '')].slice(0, 200).join('') }))
      return json({ requests })
    }
    if (p === '/api/ask') {
      if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
      const b = (typeof body === 'object' && body !== null ? body : {}) as { to?: unknown; question?: unknown }
      if (typeof b.question !== 'string' || b.question.trim() === '' || (b.to !== '*' && !Array.isArray(b.to))) {
        return json({ error: 'bad_request', detail: 'send {"to", "question"}' }, 400)
      }
      const teammates = this.teammatesOn(team)
      const to = b.to === '*' ? [...teammates].sort() : (b.to as unknown[]).map(String)
      if (to.length === 0) return this.refuse(400, 'bad_recipients', 'You have no teammates to ask.')
      if (to.some((m) => !teammates.includes(m))) return this.refuse(400, 'bad_recipients', "'to' names someone who is not in your team.")
      const id = hexId(1_000_000 + this.asked.length)
      const events: ScriptEvent[] = []
      const answers: Record<string, string> = {}
      if (team === 'demo') {
        for (const m of to) {
          const reply = MOCK_REPLIES[m]
          if (!reply) continue
          events.push(deliver(m, now + 500), ack(m, now + reply.ack))
          if (reply.at !== null) {
            events.push(answer(m, now + reply.at, reply.text.slice(0, 2000)))
            answers[m] = reply.text
          }
        }
      }
      const created = base({ id, at: now, asker: this.viewerOn(team), to, broadcast: b.to === '*', question: b.question })
      events.push(sweep(parse(created.ack_deadline)), sweep(parse(created.answer_deadline)))
      this.asked.push({ team, script: { base: created, events }, answers })
      return json({ request_id: id, recipients: to, created: true }, 201)
    }
    return json({ error: 'not_found' }, 404)
  }

  /** GET /api/requests/{id} of a question asked on a quiet team (the asker's view). */
  private askedDetail(team: string, id: string): Response | null {
    const a = this.asked.find((x) => x.team === team && x.script.base.request_id === id)
    if (!a) return null
    const m = materialise(a.script, this.now())
    if (!m) return json({ error: 'not_found' }, 404)
    const r = m.request
    return json({
      request_id: r.request_id,
      kind: r.kind,
      asker: r.asker,
      broadcast: r.broadcast,
      question: r.question,
      capability: null,
      created_at: r.created_at,
      ack_deadline: r.ack_deadline,
      answer_deadline: r.answer_deadline,
      expire_at: r.expire_at,
      recipients: Object.fromEntries(Object.entries(r.recipients).map(([k, v]) => [k, { ...v, answer: a.answers[k] ?? null }])),
      progress: m.progress,
    } satisfies RequestDetail)
  }

  // --- M9: teams ---------------------------------------------------------------------------

  private refuse(status: number, code: string, detail: string): Response {
    return json({ error: 'relay_refused', relay_status: status, relay_error: code, detail }, 502)
  }

  /** A team other than `demo`: its roster, and no traffic yet. */
  private quietTeam(team: string, method: string, p: string, init?: RequestInit): Response {
    const roster = this.quiet.get(team) ?? []
    const mine = this.account.teams.find((t) => t.team === team)!
    const active = roster.filter((m) => m.status !== 'invited')
    const owner = active.some((m) => m.member === mine.member && m.role === 'owner')
    if (method !== 'GET') {
      if (!owner) return this.refuse(403, 'forbidden', 'Only owners can change the roster.')
      const b = (typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : {}) as Record<string, unknown>
      if (method === 'POST' && p === '/api/roster') {
        const entry: RosterMember = { member: String(b.member), emails: [String(b.email).toLowerCase()], role: 'member', added_by: mine.member, added_at: new Date(this.now()).toISOString(), status: 'invited' }
        if (roster.some((m) => m.member === entry.member)) return this.refuse(409, 'member_exists', 'That member id is already on the team.')
        this.quiet.set(team, [...roster, entry])
        return json(entry, 201)
      }
      const target = roster.find((m) => `/api/roster/${m.member}` === p)
      if (!target) return json({ error: 'not_found' }, 404)
      if (method === 'DELETE') this.quiet.set(team, roster.filter((m) => m !== target))
      else if (b.role === 'owner' || b.role === 'member') target.role = b.role
      return json(target)
    }
    const now = this.now()
    if (p === '/api/me') return json({ team, name: mine.name, member: mine.member, role: mine.role, teammates: active.map((m) => m.member).filter((m) => m !== mine.member) })
    if (p === '/api/join') return json({ ...fixtureJoin, team })
    if (p === '/api/roster') {
      return json({
        members: roster
          .filter((m) => owner || m.status !== 'invited')
          .map((m) => ({ ...m, emails: owner || m.member === mine.member ? m.emails : (m.emails ?? []).map(() => null) })),
      })
    }
    if (p === '/api/directory') {
      return json({
        members: active
          .filter((m) => m.member !== mine.member)
          .map((m) => ({
            member: m.member,
            last_seen: null,
            manifest: null,
            published_at: null,
            sessions: { working: { last_seen: null }, answering: { last_seen: null } },
            stats: { asked: 0, answered: 0, open: 0, median_answer_seconds: null },
            inbox_waiting: 0,
          })),
        stats_complete: true,
      } satisfies Directory)
    }
    if (p === '/api/inbox/summary') return json({ pending: 0, more: false, oldest_at: null, from: [], answering: { last_seen: null } })
    if (p === '/api/activity') return json({ requests: [], next_since: iso(now - DAY_MS), server_time: iso(now) } satisfies ActivityPage)
    return json({ error: 'not_found' }, 404)
  }

  private adminList(url: URL): Response {
    if (!this.account.admin || this.stranger) return this.refuse(403, 'forbidden', 'Only a relay admin can do this.')
    const after = url.searchParams.get('after')
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200)))
    const seeds = after === null ? this.world.filter((t) => t.seed) : []
    const rest = this.world.filter((t) => !t.seed && (after === null || t.id > after)).sort((a, b) => a.id.localeCompare(b.id))
    const page = rest.slice(0, limit)
    return json({ teams: [...seeds, ...page], next: rest.length > limit ? (page.at(-1)?.id ?? null) : null })
  }

  private removeTeam(id: string, confirm: unknown): Response {
    const t = this.world.find((w) => w.id === id)
    if (!t || t.status !== 'active') return this.refuse(404, 'not_found', 'No such team.')
    if (t.seed) return this.refuse(409, 'seed_team', "This team comes from the relay's team file.")
    if (confirm !== id) return this.refuse(422, 'confirm_mismatch', 'Send {"confirm": "<team id>"}.')
    const now = this.now()
    Object.assign(t, { status: 'deleted', removal: 'complete', deleted_at: iso(now), reserved_until: iso(now + 31 * DAY_MS), members: 0, owners: 0 })
    const mine = this.account.teams.find((x) => x.team === id)
    this.account.teams = this.account.teams.filter((x) => x.team !== id)
    this.account.invitations = this.account.invitations.filter((x) => x.team !== id)
    if (mine && t.created_by_member === mine.member && this.account.teams_created !== null) this.account.teams_created -= 1
    this.quiet.delete(id)
    return json({ team: id, status: 'deleted', removal: 'complete', deleted_at: t.deleted_at, reserved_until: t.reserved_until })
  }

  /** M9's changes, refused as the relay refuses them. */
  accountChange(method: string, p: string, body: unknown): Response {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const now = this.now()
    if (method === 'POST' && p === '/api/teams') {
      const name = String(b.name ?? '').trim()
      const member = String(b.owner_member_id ?? '')
      const id = typeof b.id === 'string' ? b.id : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      const reserved = ['admin', 'api', 'login', 'v1', 'health', 'static', 'www', 'team', 'teams', 'relay', 'console', 'demo', 'test']
      if (reserved.includes(id) || this.world.some((w) => w.id === id)) return this.refuse(409, 'team_id_unavailable', 'That team id is not available.')
      if (name.toLowerCase() === 'demo') return this.refuse(409, 'team_name_unavailable', "That name belongs to a team in the relay's configuration.")
      if ((this.account.teams_created ?? 0) >= (this.account.max_teams_created ?? 3)) return this.refuse(409, 'team_limit', 'You have created 3 teams.')
      this.world.push({ id, name, status: 'active', seed: false, created_at: iso(now), created_by_member: member, members: 1, owners: 1, last_activity_at: null })
      this.account.teams = [...this.account.teams, { team: id, name, member, role: 'owner' }]
      this.account.teams_created = (this.account.teams_created ?? 0) + 1
      this.quiet.set(id, [{ member, emails: ['alice@example.com'], role: 'owner', added_by: member, added_at: iso(now) }])
      return json({ team: id, name, status: 'active', created_at: iso(now), member, role: 'owner' }, 201)
    }
    let m = /^\/api\/invitations\/([a-z][a-z0-9_-]{1,31})$/.exec(p)
    if (method === 'POST' && m) {
      const inv = this.account.invitations.find((i) => i.team === m![1])
      if (!inv) return this.refuse(404, 'not_found', 'That invitation is no longer open.')
      this.account.invitations = this.account.invitations.filter((i) => i !== inv)
      if (b.accept !== true) return json({ team: inv.team, member: inv.member, status: 'declined' })
      this.account.teams = [...this.account.teams, { team: inv.team, name: inv.name, member: inv.member, role: inv.role }]
      if (inv.team === 'ops') this.bounds.set('ops', structuredClone(fixtureOpsBoundaries))
      this.quiet.set(inv.team, [
        { member: inv.invited_by_member ?? 'olga', emails: ['olga@example.com'], role: 'owner', added_by: 'olga', added_at: '2026-09-12T15:45:00Z' },
        { member: inv.member, emails: ['alice@example.com'], role: inv.role, added_by: 'olga', added_at: iso(now) },
      ])
      return json({ team: inv.team, name: inv.name, member: inv.member, role: inv.role, status: 'active' })
    }
    m = /^\/api\/teams\/([a-z][a-z0-9_-]{1,31})$/.exec(p)
    if (method === 'DELETE' && m) {
      const mine = this.account.teams.find((t) => t.team === m![1])
      if (!mine) return json({ error: 'not_on_team', team: m[1] }, 403)
      if (mine.role !== 'owner') return this.refuse(403, 'forbidden', 'Only an owner can delete the team.')
      return this.removeTeam(m[1]!, b.confirm)
    }
    m = /^\/api\/admin\/teams\/([a-z][a-z0-9_-]{1,31})$/.exec(p)
    if (method === 'DELETE' && m) return this.removeTeam(m[1]!, b.confirm)
    return json({ error: 'method_not_allowed' }, 405)
  }

  /** Simulated network time per call, in ms (a range); tests set it to 0. */
  latency: [number, number] = [35, 105]

  /** A Transport for the API client (src/api/client.ts). */
  handle = async (path: string, init?: RequestInit): Promise<Response> => {
    const [lo, hi] = this.latency
    if (hi > 0) await new Promise((resolve) => setTimeout(resolve, lo + Math.random() * (hi - lo)))
    const url = new URL(path, 'http://console.invalid/')
    const p = url.pathname.replace(/^\/+/, '/')
    const method = (init?.method ?? 'GET').toUpperCase()
    // M9 §2: the viewer's teams. A stranger (?mock=stranger) is on none, with one invitation.
    if (p === '/api/teams' && method === 'GET') {
      if (this.stranger) {
        return json({ ...this.account, teams: [], admin: false, teams_created: 0, email: 'dana@example.com' } satisfies Teams)
      }
      return json(this.account)
    }
    if (p === '/api/admin/teams' && method === 'GET') return this.adminList(url)
    if (method !== 'GET' && (p === '/api/teams' || p.startsWith('/api/teams/') || p.startsWith('/api/invitations/') || p.startsWith('/api/admin/teams/'))) {
      let body: unknown = undefined
      if (typeof init?.body === 'string' && init.body !== '') body = JSON.parse(init.body)
      return this.accountChange(method, p, body)
    }
    // A stranger gets nothing, the join details included (M6-SPEC §7 item 6: the hosted
    // console answers /api/join only to a member of its team).
    if (this.stranger) return json({ error: 'not_on_team', email: 'dana@example.com' }, 403)
    // M9 §5: a call about one team names it; a team the viewer is not on gets no data.
    const team = new Headers(init?.headers).get('X-Relay-Team') ?? 'demo'
    if (!this.account.teams.some((t) => t.team === team)) return json({ error: 'not_on_team', team }, 403)
    if (p === '/api/boundaries') {
      if (!this.reachable) return json({ error: 'relay_unreachable' }, 502)
      let body: unknown = undefined
      if (typeof init?.body === 'string' && init.body !== '') body = JSON.parse(init.body)
      return this.boundariesCall(team, method, body)
    }
    if (p === '/api/acceptance' || p === '/api/members-status' || p === '/api/my-requests' || p === '/api/ask') {
      if (!this.reachable) return json({ error: 'relay_unreachable' }, 502)
      let body: unknown = undefined
      if (typeof init?.body === 'string' && init.body !== '') body = JSON.parse(init.body)
      return this.m11(team, method, p, body)
    }
    if (team !== 'demo') {
      const asked = /^\/api\/requests\/(rq_[0-9a-f]{32})$/.exec(p)
      const found = asked?.[1] ? this.askedDetail(team, asked[1]) : null
      if (found) return found
      return this.quietTeam(team, method, p, init)
    }
    // Answered by the console server itself, so it does not depend on the relay being reachable.
    if (p === '/api/join') return json(fixtureJoin)
    if (!this.reachable) return json({ error: 'relay_unreachable' }, 502)
    if (this.rateLimited) return json({ error: 'relay_refused', relay_status: 429, relay_error: 'rate_limited' }, 502)
    if (method !== 'GET') {
      if (p !== '/api/roster' && !p.startsWith('/api/roster/')) return json({ error: 'method_not_allowed' }, 405)
      let body: unknown = undefined
      if (typeof init?.body === 'string' && init.body !== '') body = JSON.parse(init.body)
      return this.change(method, p, body)
    }
    if (p === '/api/roster') return json(this.roster())
    if (p === '/api/me') return json({ ...fixtureMe, name: 'Demo', role: this.role })
    if (p === '/api/directory') return json(this.directory())
    if (p === '/api/inbox/summary') return json(this.inboxSummary())
    if (p === '/api/activity') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100)))
      return json(this.activity(url.searchParams.get('since'), limit))
    }
    const m = /^\/api\/requests\/(rq_[0-9a-f]{32})$/.exec(p)
    if (m?.[1]) {
      const d = this.detail(m[1])
      return d ? json(d) : json({ error: 'not_found' }, 404)
    }
    return json({ error: 'not_found' }, 404)
  }
}

/**
 * M10 §7.1, as the relay keeps it: an item the previous version holds keeps its `since`
 * (orgs without case, drives on domain and name); one added, or added back after a removal,
 * gets `version`; member folders likewise while allowed.
 */
function nextSince(prev: TeamBoundaries | null, version: number, next: Boundaries): BoundariesSince {
  const p = prev?.boundaries ? (prev.since ?? null) : null
  const org = (o: string) => {
    const key = o.toLowerCase()
    return p && Object.prototype.hasOwnProperty.call(p.github_orgs, key) ? (p.github_orgs[key] ?? version) : version
  }
  return {
    github_orgs: Object.fromEntries(next.github_orgs.map((o) => [o.toLowerCase(), org(o)])),
    drives: next.drives.map((d) => ({
      domain: d.domain,
      shared_drive: d.shared_drive,
      since: p?.drives.find((x) => x.domain === d.domain && x.shared_drive === d.shared_drive)?.since ?? version,
    })),
    member_folders: next.member_folders ? (p?.member_folders ?? version) : null,
  }
}
