// Synthetic fixtures in exactly the shapes the console server proxies (M2 §3.1, §3.5, §3.6;
// M1 §3.2, §3.11). Team `demo`, members alice (the viewer), bob and carol. Nothing here is
// real: names, questions, answers and ids are invented.
//
// The snapshot is taken at FIXTURE_NOW and covers every state the console draws:
//   answered            alice → bob, question, three tools, answer returned
//   in flight, working  alice → bob, question, acked, one tool so far
//   broadcast           alice → *, bob answered, carol never acked (no_response)
//   capability call     alice → bob, staging_db_query, a tool event and progress
//   timed_out           alice → carol, acked, a tool error, no answer by the deadline
//   masked              carol → bob and bob → carol: alice is not a participant
//   incoming            bob → alice, delivered to alice's answering session, not acked
//   returning           alice → carol, service_health answered, answer not yet picked up
//   waiting for access  alice → carol, acked, a Glob, then a Read carol has not allowed yet
//                       (M4 §2: the tool event is `waiting`)
// bob shares two folders with his answering session; carol shares none (M4 §3).

import type { ActivityPage, ActivityRequest, AdminTeam, Directory, Join, Manifest, Me, RequestDetail, Roster, TeamBoundaries, Teams } from '@/api/types'

export const FIXTURE_NOW = '2026-09-23T10:15:00.000Z'

export const fixtureMe: Me = { team: 'demo', member: 'alice', teammates: ['bob', 'carol'] }

/** GET /api/join: the fields the console reads (the server sends more). */
export const fixtureJoin: Join = {
  relay_url: 'https://relay.example.com',
  team: 'demo',
}

/** GET /api/boundaries for `demo` (M10 §1, schema v3): the topic, set by alice, an owner. Synthetic. */
export const fixtureBoundaries: TeamBoundaries = {
  team: 'demo',
  version: 2,
  boundaries: {
    topic: 'Example Co: the orders and payments services, their runbooks, deploys and incidents, and how the team works.',
  },
  updated_at: '2026-09-21T09:30:00Z',
  updated_by: 'alice',
}

/** GET /api/boundaries for `ops` (M10 §1), once alice has joined it as a member: set by olga. */
export const fixtureOpsBoundaries: TeamBoundaries = {
  team: 'ops',
  version: 1,
  boundaries: {
    topic: 'Operations at Example Co: on-call, incidents, infrastructure and the runbooks behind them.',
  },
  updated_at: '2026-09-14T08:00:00Z',
  updated_by: 'olga',
}

/** GET /api/roster as alice, an owner, reads it (M6 §2): every email visible. */
export const fixtureRoster: Roster = {
  members: [
    { member: 'alice', emails: ['alice@example.com'], role: 'owner', added_by: 'alice', added_at: '2026-09-17T09:00:00Z' },
    { member: 'bob', emails: ['bob@example.com'], role: 'member', added_by: 'alice', added_at: '2026-09-17T09:02:00Z' },
    { member: 'carol', emails: ['carol@example.com', 'carol.w@example.org'], role: 'member', added_by: 'alice', added_at: '2026-09-18T14:30:00Z' },
    // M9 §7.2: an invitation dana has not answered yet (owners see it).
    { member: 'dana', emails: ['dana@example.com'], role: 'member', added_by: 'alice', added_at: '2026-09-22T11:15:00Z', status: 'invited' },
  ],
}

/** GET /api/teams as alice reads it (M9 §2): two teams, an invitation, and she is a relay admin. */
export const fixtureTeams: Teams = {
  teams: [
    { team: 'demo', name: 'Demo', member: 'alice', role: 'owner' },
    { team: 'research', name: 'Research', member: 'alice', role: 'owner' },
  ],
  invitations: [{ team: 'ops', name: 'Operations', member: 'alice', role: 'member', invited_by_member: 'olga' }],
  admin: true,
  teams_created: 1,
  max_teams_created: 3,
  suggested_member: 'alice',
  can_manage_teams: true,
  default_team: 'demo',
}

/** GET /api/admin/teams (M9 §4): every team, with no emails and no content. */
export const fixtureAdminTeams: AdminTeam[] = [
  { id: 'demo', name: 'Demo', status: 'active', seed: true, created_at: '2026-08-25T09:00:00Z', created_by_member: null, members: 3, owners: 1, last_activity_at: '2026-09-24T09:59:40Z' },
  { id: 'design-guild', name: 'Design guild', status: 'active', seed: false, created_at: '2026-09-04T10:12:00Z', created_by_member: 'hana', members: 4, owners: 2, last_activity_at: '2026-09-22T16:40:00Z' },
  { id: 'field-notes', name: 'Field notes', status: 'active', seed: false, created_at: '2026-09-16T08:30:00Z', created_by_member: 'ivo', members: 1, owners: 1, last_activity_at: null },
  { id: 'old-pilot', name: 'Old pilot', status: 'deleted', seed: false, created_at: '2026-08-15T12:00:00Z', created_by_member: 'jun', members: 0, owners: 0, last_activity_at: '2026-09-20T13:05:00Z', removal: 'complete', deleted_at: '2026-09-21T09:00:00Z', reserved_until: '2026-10-22T09:00:00Z' },
  { id: 'ops', name: 'Operations', status: 'active', seed: false, created_at: '2026-09-12T15:45:00Z', created_by_member: 'olga', members: 2, owners: 1, last_activity_at: '2026-09-24T07:20:00Z' },
  { id: 'research', name: 'Research', status: 'active', seed: false, created_at: '2026-09-19T10:00:00Z', created_by_member: 'alice', members: 2, owners: 1, last_activity_at: '2026-09-23T18:02:00Z' },
  { id: 'support-rota', name: 'Support rota', status: 'active', seed: false, created_at: '2026-09-10T07:00:00Z', created_by_member: 'kai', members: 6, owners: 2, last_activity_at: '2026-09-24T09:31:00Z' },
]

const stagingDbQuery: Manifest['capabilities'][number] = {
  name: 'staging_db_query',
  title: 'Query the staging database',
  description: 'Read-only lookup against one staging dataset, at most 100 rows.',
  environment: 'staging',
  default_enabled: false,
  timeout_seconds: 120,
  params: {
    dataset: { type: 'enum', values: ['users', 'orders', 'events'], description: 'Which staging dataset to read.' },
    field: { type: 'enum', values: ['id', 'status', 'created_on', 'country'], description: 'Field to compare.' },
    op: { type: 'enum', values: ['eq', 'ne', 'lt', 'gt'], default: 'eq', description: 'Comparison operator.' },
    value: {
      type: 'string',
      max_length: 100,
      pattern: '^[A-Za-z0-9_.@-]{0,100}$',
      description: 'Value to compare the field against.',
    },
    limit: { type: 'integer', min: 1, max: 100, default: 20, description: 'Maximum rows to return.' },
  },
  required: ['dataset'],
}

const serviceHealth: Manifest['capabilities'][number] = {
  name: 'service_health',
  title: "Check a service's health",
  description: 'Reports the health endpoint and recent error count of one named service.',
  environment: 'staging',
  default_enabled: false,
  timeout_seconds: 60,
  params: {
    service: { type: 'enum', values: ['api', 'worker', 'web'], description: 'Which service to check.' },
  },
  required: ['service'],
}

const productionDbCount: Manifest['capabilities'][number] = {
  name: 'production_db_count',
  title: 'Count rows in a production table',
  description: 'Returns a row count only, never row contents, for one production table.',
  environment: 'production',
  default_enabled: false,
  timeout_seconds: 60,
  params: {
    table: { type: 'enum', values: ['users', 'orders'], description: 'Which production table to count.' },
  },
  required: ['table'],
}

export const fixtureDirectory: Directory = {
  members: [
    {
      member: 'bob',
      last_seen: '2026-09-23T10:14:57.000Z',
      manifest: {
        version: 1,
        capabilities: [stagingDbQuery, serviceHealth],
        shares: [{ name: 'orders-service' }, { name: 'runbooks' }],
      },
      published_at: '2026-09-23T08:31:12.000Z',
      sessions: {
        working: { last_seen: '2026-09-23T10:14:44.000Z' },
        answering: { last_seen: '2026-09-23T10:14:57.000Z' },
      },
      stats: { asked: 3, answered: 6, open: 1, median_answer_seconds: 29 },
    },
    {
      member: 'carol',
      last_seen: '2026-09-23T10:14:58.000Z',
      manifest: { version: 1, capabilities: [serviceHealth, productionDbCount], shares: [] },
      published_at: '2026-09-22T16:02:40.000Z',
      sessions: {
        working: { last_seen: '2026-09-23T10:11:40.000Z' },
        answering: { last_seen: '2026-09-23T10:14:58.000Z' },
      },
      stats: { asked: 2, answered: 2, open: 0, median_answer_seconds: 47 },
    },
  ],
}

function recipient(p: Partial<ActivityRequest['recipients'][string]>): ActivityRequest['recipients'][string] {
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
    ...p,
  }
}

export const RQ = {
  answered: 'rq_1f0c6a2e9b7d4c35a8e21f609d3b7c41',
  working: 'rq_2b8e4d1a7c3f4e69b05d8a2c6e1f9b73',
  broadcast: 'rq_3c9a5e2b8d4f4a17c16e9b3d7f2a0c85',
  capability: 'rq_4d0b6f3c9e5a4b28d27f0c4e8a3b1d96',
  timedOut: 'rq_5e1c7a4d0f6b4c39e38a1d5f9b4c2ea7',
  masked: 'rq_6f2d8b5e1a7c4d4af49b2e6a0c5d3fb8',
  incoming: 'rq_7a3e9c6f2b8d4e5ba50c3f7b1d6e4ac9',
  returning: 'rq_8b4f0d7a3c9e4f6cb61d4a8c2e7f5bda',
  maskedCapability: 'rq_9c5a1e8b4d0f4a7dc72e5b9d3f8a6ceb',
  grant: 'rq_a0d6b2f9c5e14b8e9d8f3a6c0b4e7d21',
} as const

export const fixtureRequests: ActivityRequest[] = [
  {
    request_id: RQ.timedOut,
    kind: 'question',
    asker: 'alice',
    broadcast: false,
    created_at: '2026-09-23T09:40:00.000Z',
    updated_at: '2026-09-23T10:10:00.000Z',
    ack_deadline: '2026-09-23T09:42:00.000Z',
    answer_deadline: '2026-09-23T10:10:00.000Z',
    expire_at: '2026-09-30T09:40:00.000Z',
    capability: null,
    question: 'Can you check whether the nightly export job still writes to the old bucket path?',
    recipients: {
      carol: recipient({
        status: 'timed_out',
        delivered_at: '2026-09-23T09:40:01.120Z',
        acked_at: '2026-09-23T09:40:06.480Z',
        tools: [
          { tool: 'Grep', status: 'ok', at: '2026-09-23T09:40:11.020Z', duration_ms: 61 },
          { tool: 'Read', status: 'error', at: '2026-09-23T09:40:14.300Z', duration_ms: 4 },
        ],
      }),
    },
    participant: true,
  },
  {
    request_id: RQ.answered,
    kind: 'question',
    asker: 'alice',
    broadcast: false,
    created_at: '2026-09-23T10:02:10.000Z',
    updated_at: '2026-09-23T10:02:42.050Z',
    ack_deadline: '2026-09-23T10:04:10.000Z',
    answer_deadline: '2026-09-23T10:32:10.000Z',
    expire_at: '2026-09-30T10:02:10.000Z',
    capability: null,
    question: 'Where does the retry budget for the ingest worker live, and what is it set to in staging?',
    recipients: {
      bob: recipient({
        status: 'answered',
        delivered_at: '2026-09-23T10:02:10.640Z',
        acked_at: '2026-09-23T10:02:13.210Z',
        answered_at: '2026-09-23T10:02:41.300Z',
        answer_delivered_at: '2026-09-23T10:02:42.050Z',
        tools: [
          { tool: 'Grep', status: 'ok', at: '2026-09-23T10:02:16.050Z', duration_ms: 38 },
          { tool: 'Read', status: 'ok', at: '2026-09-23T10:02:17.400Z', duration_ms: 12 },
          { tool: 'Read', status: 'ok', at: '2026-09-23T10:02:19.900Z', duration_ms: 9 },
        ],
        answer_preview:
          'It lives in worker/config/retry.ts as INGEST_RETRY_BUDGET. Staging overrides it to 5 attempts with a 30 s ceiling in deploy/staging.env; production keeps the default of 8.',
      }),
    },
    participant: true,
  },
  {
    request_id: RQ.broadcast,
    kind: 'question',
    asker: 'alice',
    broadcast: true,
    created_at: '2026-09-23T10:05:00.000Z',
    updated_at: '2026-09-23T10:07:00.000Z',
    ack_deadline: '2026-09-23T10:07:00.000Z',
    answer_deadline: '2026-09-23T10:35:00.000Z',
    expire_at: '2026-09-30T10:05:00.000Z',
    capability: null,
    question: 'Has anyone changed the staging feature flags since Monday?',
    recipients: {
      bob: recipient({
        status: 'answered',
        delivered_at: '2026-09-23T10:05:00.510Z',
        acked_at: '2026-09-23T10:05:04.020Z',
        answered_at: '2026-09-23T10:05:52.700Z',
        answer_delivered_at: '2026-09-23T10:05:53.300Z',
        tools: [{ tool: 'Grep', status: 'ok', at: '2026-09-23T10:05:09.800Z', duration_ms: 57 }],
        answer_preview: 'Not me. The flag file was last touched on Friday by the release script.',
      }),
      carol: recipient({ status: 'no_response' }),
    },
    participant: true,
  },
  {
    request_id: RQ.maskedCapability,
    kind: 'capability',
    asker: 'bob',
    broadcast: false,
    created_at: '2026-09-23T10:07:30.000Z',
    updated_at: '2026-09-23T10:07:36.900Z',
    ack_deadline: '2026-09-23T10:09:30.000Z',
    answer_deadline: '2026-09-23T10:37:30.000Z',
    expire_at: '2026-09-30T10:07:30.000Z',
    capability: { name: 'production_db_count', environment: 'production', params: null },
    question: null,
    recipients: {
      carol: recipient({
        status: 'answered',
        delivered_at: '2026-09-23T10:07:30.700Z',
        acked_at: '2026-09-23T10:07:32.100Z',
        answered_at: '2026-09-23T10:07:36.200Z',
        answer_delivered_at: '2026-09-23T10:07:36.900Z',
        tools: [{ tool: 'production_db_count', status: 'ok', at: '2026-09-23T10:07:35.900Z', duration_ms: 980 }],
      }),
    },
    participant: false,
  },
  {
    request_id: RQ.capability,
    kind: 'capability',
    asker: 'alice',
    broadcast: false,
    created_at: '2026-09-23T10:09:12.000Z',
    updated_at: '2026-09-23T10:09:21.100Z',
    ack_deadline: '2026-09-23T10:11:12.000Z',
    answer_deadline: '2026-09-23T10:11:12.000Z',
    expire_at: '2026-09-30T10:09:12.000Z',
    capability: {
      name: 'staging_db_query',
      environment: 'staging',
      params: { dataset: 'orders', field: 'status', op: 'eq', value: 'failed', limit: 20 },
    },
    question: null,
    recipients: {
      bob: recipient({
        status: 'answered',
        delivered_at: '2026-09-23T10:09:12.900Z',
        acked_at: '2026-09-23T10:09:15.000Z',
        answered_at: '2026-09-23T10:09:20.400Z',
        answer_delivered_at: '2026-09-23T10:09:21.100Z',
        tools: [{ tool: 'staging_db_query', status: 'ok', at: '2026-09-23T10:09:17.200Z', duration_ms: 1840 }],
        progress_count: 2,
        last_progress_pct: 80,
        answer_preview:
          '12 rows. Nine failed on card_declined, two on address_invalid, one on timeout; all created after 08:40 today.',
      }),
    },
    participant: true,
  },
  {
    request_id: RQ.masked,
    kind: 'question',
    asker: 'carol',
    broadcast: false,
    created_at: '2026-09-23T10:11:05.000Z',
    updated_at: '2026-09-23T10:11:49.600Z',
    ack_deadline: '2026-09-23T10:13:05.000Z',
    answer_deadline: '2026-09-23T10:41:05.000Z',
    expire_at: '2026-09-30T10:11:05.000Z',
    capability: null,
    question: null,
    recipients: {
      bob: recipient({
        status: 'answered',
        delivered_at: '2026-09-23T10:11:05.800Z',
        acked_at: '2026-09-23T10:11:09.400Z',
        answered_at: '2026-09-23T10:11:48.900Z',
        answer_delivered_at: '2026-09-23T10:11:49.600Z',
        tools: [{ tool: 'Read', status: 'ok', at: '2026-09-23T10:11:14.000Z', duration_ms: 15 }],
      }),
    },
    participant: false,
  },
  {
    request_id: RQ.grant,
    kind: 'question',
    asker: 'alice',
    broadcast: false,
    created_at: '2026-09-23T10:12:40.000Z',
    updated_at: '2026-09-23T10:12:49.500Z',
    ack_deadline: '2026-09-23T10:14:40.000Z',
    answer_deadline: '2026-09-23T10:42:40.000Z',
    expire_at: '2026-09-30T10:12:40.000Z',
    capability: null,
    question: 'What does the on-call handover note say about the queue backlog alert?',
    recipients: {
      carol: recipient({
        status: 'acked',
        delivered_at: '2026-09-23T10:12:40.610Z',
        acked_at: '2026-09-23T10:12:44.300Z',
        tools: [
          { tool: 'Glob', status: 'ok', at: '2026-09-23T10:12:47.100Z', duration_ms: 22 },
          // M4 §2: a read outside carol's shared folders, waiting for her to allow it.
          { tool: 'Read', status: 'waiting', at: '2026-09-23T10:12:49.500Z', duration_ms: null },
        ],
      }),
    },
    participant: true,
  },
  {
    request_id: RQ.working,
    kind: 'question',
    asker: 'alice',
    broadcast: false,
    created_at: '2026-09-23T10:14:31.000Z',
    updated_at: '2026-09-23T10:14:39.000Z',
    ack_deadline: '2026-09-23T10:16:31.000Z',
    answer_deadline: '2026-09-23T10:44:31.000Z',
    expire_at: '2026-09-30T10:14:31.000Z',
    capability: null,
    question: 'Which migration added the orders.fulfilment_state column, and is it applied on staging?',
    recipients: {
      bob: recipient({
        status: 'acked',
        delivered_at: '2026-09-23T10:14:31.720Z',
        acked_at: '2026-09-23T10:14:35.100Z',
        tools: [{ tool: 'Grep', status: 'ok', at: '2026-09-23T10:14:39.000Z', duration_ms: 44 }],
      }),
    },
    participant: true,
  },
  {
    request_id: RQ.incoming,
    kind: 'question',
    asker: 'bob',
    broadcast: false,
    created_at: '2026-09-23T10:14:52.000Z',
    updated_at: '2026-09-23T10:14:52.400Z',
    ack_deadline: '2026-09-23T10:16:52.000Z',
    answer_deadline: '2026-09-23T10:44:52.000Z',
    expire_at: '2026-09-30T10:14:52.000Z',
    capability: null,
    question: 'Did the webhook signing secret rotate on your side too, or only in staging?',
    recipients: {
      alice: recipient({ status: 'pending', delivered_at: '2026-09-23T10:14:52.400Z' }),
    },
    participant: true,
  },
  {
    request_id: RQ.returning,
    kind: 'capability',
    asker: 'alice',
    broadcast: false,
    created_at: '2026-09-23T10:14:46.000Z',
    updated_at: '2026-09-23T10:14:58.300Z',
    ack_deadline: '2026-09-23T10:15:46.000Z',
    answer_deadline: '2026-09-23T10:15:46.000Z',
    expire_at: '2026-09-30T10:14:46.000Z',
    capability: { name: 'service_health', environment: 'staging', params: { service: 'api' } },
    question: null,
    recipients: {
      carol: recipient({
        status: 'answered',
        delivered_at: '2026-09-23T10:14:46.600Z',
        acked_at: '2026-09-23T10:14:49.000Z',
        answered_at: '2026-09-23T10:14:58.300Z',
        tools: [{ tool: 'service_health', status: 'ok', at: '2026-09-23T10:14:57.700Z', duration_ms: 1210 }],
        progress_count: 1,
        last_progress_pct: 50,
        answer_preview: 'api is healthy: 200 from /healthz in 84 ms, 3 errors in the last 15 minutes (all 499s).',
      }),
    },
    participant: true,
  },
]

export const fixtureActivity: ActivityPage = {
  requests: [...fixtureRequests].sort((a, b) => a.updated_at.localeCompare(b.updated_at)),
  next_since: '2026-09-23T10:14:58.300Z',
  server_time: FIXTURE_NOW,
}

/** GET /api/requests/{RQ.capability} as alice, the asker: every recipient, all progress. */
export const fixtureCapabilityDetail: RequestDetail = {
  request_id: RQ.capability,
  kind: 'capability',
  asker: 'alice',
  broadcast: false,
  question: null,
  capability: {
    name: 'staging_db_query',
    environment: 'staging',
    params: { dataset: 'orders', field: 'status', op: 'eq', value: 'failed', limit: 20 },
  },
  created_at: '2026-09-23T10:09:12.000Z',
  ack_deadline: '2026-09-23T10:11:12.000Z',
  answer_deadline: '2026-09-23T10:11:12.000Z',
  expire_at: '2026-09-30T10:09:12.000Z',
  recipients: {
    bob: { status: 'answered', acked_at: '2026-09-23T10:09:15.000Z', answered_at: '2026-09-23T10:09:20.400Z' },
  },
  progress: [
    {
      seq: 1,
      member: 'bob',
      kind: 'progress',
      text: 'Reading orders where status is failed',
      pct: 40,
      time: '2026-09-23T10:09:16.100Z',
    },
    {
      seq: 2,
      member: 'bob',
      kind: 'tool',
      text: null,
      pct: null,
      tool: 'staging_db_query',
      status: 'ok',
      duration_ms: 1840,
      time: '2026-09-23T10:09:17.200Z',
    },
    { seq: 3, member: 'bob', kind: 'progress', text: '12 rows, summarising', pct: 80, time: '2026-09-23T10:09:18.600Z' },
  ],
}
