// The console's --demo backend (M2-SPEC §4.4): a synthetic team `demo` (alice, bob, carol)
// with a scripted, looping stream of activity, served in exactly the shapes the relay serves
// (§3.1, §3.5, §3.6 of M2-SPEC; §3.2, §3.4, §3.11 of M1-SPEC) and by the relay's rules
// (§7 of M2-SPEC): `updated_at` strictly increasing per request, feed pages that never split
// a group of requests with the same `updated_at`, `stats_complete` on the directory, `open`
// by effective status, `answered` by `answered_at` in the window, the median to 3 decimals,
// and answer previews masked as the relay masks them. The viewer is alice.
//
// Every cycle (60 s) starts seven requests: a directed question (whose answerer waits a
// moment for bob to allow a file read, M4-SPEC §2), a capability call with
// progress and a tool event, a broadcast that one teammate never acknowledges (no_response),
// a question between two teammates (alice is not a participant, so its text is masked), an
// acknowledged question that is never answered (timed_out), a capability call between two
// teammates, and a broadcast both recipients answer (alice sees only her own answer). The
// last is created in the same millisecond the capability call before it changes, so the
// feed has an equal-`updated_at` group to keep whole. Deadlines are applied the way the
// relay's sweep applies them, a moment after they pass, so a stored `pending` or `acked` past
// its deadline shows for that moment, as it can on the relay. A request's state at any moment
// is computed from its script, so the feed is consistent however often it is polled. All names
// and text are synthetic.
//
// M9-SPEC: the demo is several teams (DemoAccount): alice's scripted `demo` team (from the
// team file, so it cannot be deleted), `research`, a quiet team she created, an invitation to
// `ops`, and, since she is a relay admin in the demo, other people's teams in the admin
// listing. She can create teams (at most 3), accept or decline, and delete, by the relay's
// rules and with its refusals; a new team is quiet (no traffic). Nothing leaves the process.
//
// M11-SPEC §2-§4: alice accepted version 1 of `demo`'s boundaries (they are at 2 now, so the
// console asks her to accept again); each member's background answerer reports its status
// (bob is fully set up, alice has not connected Drive, carol's Claude Code is signed out), and
// questions alice asks from the console are answered by bob and carol on a short script. The
// quiet teams have no statuses and nobody answers there.
//
// M10-SPEC §1: each team has boundaries. `demo` and `ops` have them set (alice owns `demo`, so
// she can change them; she is a member of `ops`, so she reads them only); `research` and any
// new team have none yet. A change needs the current version (else 409 version_conflict), as
// on the relay. The directory's shares read as what each member can answer from.
//
// PICKERS-SPEC: the demo plays the relay's picked sources. `demo`'s boundaries hold a whole org,
// one repository of another org, a whole shared drive, one folder of another shared drive and a
// legacy drive matched by name (which can be kept or removed, never added: 400 legacy_drive).
// Its owner reads the sources settings (the GitHub App configured, `google_picker` null: the
// Picker never runs in the demo) and a fake GitHub listing (two installations and a suspended
// one); anyone else is refused (403), as the relay refuses them. Members' statuses carry the
// sources their Macs could not find, as item keys of the current boundaries: the owner sees
// every member's, anyone else only their own.

import { createHash } from 'node:crypto';
import { boundariesValid, knownItemKeys, legacyDrivesOk, nextSince, normaliseBoundaries } from './boundaries-rule.js';
import type {
  Acceptance,
  Boundaries,
  GithubListing,
  MemberSources,
  MemberStatusEntry,
  MembersStatus,
  MyRequest,
  SetBoundariesBody,
  SourcesConfig,
  TeamBoundaries,
} from './boundaries-types.js';
import { defaultManifestPath } from './exposed.js';
import { loadManifest, type Capability, type Manifest } from './manifest.js';

export const DEMO_TEAM = 'demo';
export const DEMO_ME = 'alice';
export const DEMO_MEMBERS = ['alice', 'bob', 'carol'] as const;
export const DEMO_CYCLE_MS = 60_000;
/** History present at start-up, so the console is not empty on its first poll. */
const WARMUP_CYCLES = 10;
const DAY_MS = 86_400_000;
/**
 * Demo requests are created with ttl_seconds 3600 (valid: at least the answer timeout), so
 * the feed, which serves unexpired requests only, holds about an hour of history.
 */
const DEMO_TTL_MS = 3_600_000;
const PREVIEW_CHARS = 2000;
/** How long after a deadline the (simulated) sweep records no_response or timed_out. */
export const SWEEP_LAG_MS = 2000;
/** The relay's limits (M2-SPEC §3.6, §7.10): one stats read, one equal-updated_at group. */
const STATS_READ_CAP = 500;
const ACTIVITY_MAX_GROUP = 500;

type Member = (typeof DEMO_MEMBERS)[number];
type Status = 'pending' | 'acked' | 'answered' | 'no_response' | 'timed_out';

export type ToolUse = { tool: string; status: 'ok' | 'error' | 'waiting'; at: string; duration_ms: number | null };
export type RecipientView = {
  status: Status;
  delivered_at: string | null;
  acked_at: string | null;
  answered_at: string | null;
  answer_delivered_at: string | null;
  tools: ToolUse[];
  progress_count: number;
  last_progress_pct: number | null;
  answer_preview: string | null;
};
export type ActivityRequest = {
  request_id: string;
  kind: 'question' | 'capability';
  asker: string;
  broadcast: boolean;
  created_at: string;
  updated_at: string;
  ack_deadline: string;
  answer_deadline: string;
  expire_at: string;
  capability: { name: string; environment: string; params: Record<string, unknown> | null } | null;
  question: string | null;
  recipients: Record<string, RecipientView>;
  participant: boolean;
};
type ProgressItem =
  | { seq: number; member: string; kind: 'progress'; text: string; pct: number | null; time: string }
  | { seq: number; member: string; kind: 'tool'; tool: string; status: 'ok' | 'error' | 'waiting'; duration_ms: number | null; time: string };

// ---------------------------------------------------------------------------------------
// Scripts: offsets in ms from the request's creation.

// A step names a member of any team (a question asked from the console may go to a quiet team).
type Step =
  | { at: number; to: string; do: 'deliver' | 'ack' | 'answer_delivered' }
  | { at: number; to: string; do: 'answer'; text: string }
  | { at: number; to: string; do: 'tool'; tool: string; status: 'ok' | 'error'; duration_ms: number }
  // M4-SPEC §2: a permission request in the answering session (no duration).
  | { at: number; to: string; do: 'waiting'; tool: string }
  | { at: number; to: string; do: 'progress'; text: string; pct: number };

type Script = {
  offset: number;
  kind: 'question' | 'capability';
  asker: string;
  to: string[];
  broadcast: boolean;
  question?: string;
  capability?: { name: string; params: Record<string, unknown> };
  ackTimeout: number;
  answerTimeout: number;
  steps: Step[];
};

const QUESTIONS_TO_BOB = [
  'Which service owns the nightly invoice export, and where is its retry policy configured?',
  'Is the orders table still partitioned by month in staging, or did that change with the last migration?',
  'What is the current timeout for calls from the web app to the pricing service?',
];
const ANSWERS_FROM_BOB = [
  'The invoice export lives in the worker service (jobs/export_invoices). Retries are set in its job config: three attempts, exponential backoff starting at 30 s.',
  'Still monthly. The last migration only added an index on status; partitioning is unchanged.',
  'Eight seconds, set in the web app client config, with one retry on a connection error only.',
];
const SECOND_FACTS = [
  'Does anyone know whether the feature flag for the new checkout is on in staging?',
  'Who changed the staging rate limits this week, and why?',
  'Is there a runbook for rotating the staging database password?',
];

function scripts(cycle: number): Script[] {
  const v = cycle % 3;
  return [
    {
      offset: 0,
      kind: 'question',
      asker: 'alice',
      to: ['bob'],
      broadcast: false,
      question: QUESTIONS_TO_BOB[v]!,
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 800, to: 'bob', do: 'deliver' },
        { at: 2500, to: 'bob', do: 'ack' },
        { at: 4000, to: 'bob', do: 'tool', tool: 'Grep', status: 'ok', duration_ms: 31 + v * 7 },
        // A file outside bob's shared folders: his session waits for him to allow it.
        { at: 5200, to: 'bob', do: 'waiting', tool: 'Read' },
        { at: 16_000, to: 'bob', do: 'tool', tool: 'Read', status: 'ok', duration_ms: 12 + v * 3 },
        { at: 20_000, to: 'bob', do: 'answer', text: ANSWERS_FROM_BOB[v]! },
        { at: 21_100, to: 'bob', do: 'answer_delivered' },
      ],
    },
    {
      offset: 6000,
      kind: 'capability',
      asker: 'alice',
      to: ['bob'],
      broadcast: false,
      capability: {
        name: 'staging_db_query',
        params: { dataset: 'orders', field: 'status', op: 'eq', value: ['pending', 'failed', 'shipped'][v]!, limit: 20 },
      },
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 900, to: 'bob', do: 'deliver' },
        { at: 2800, to: 'bob', do: 'ack' },
        { at: 4000, to: 'bob', do: 'progress', text: 'connecting to the staging database', pct: 10 },
        { at: 6200, to: 'bob', do: 'progress', text: 'reading rows', pct: 60 },
        { at: 8500, to: 'bob', do: 'tool', tool: 'staging_db_query', status: 'ok', duration_ms: 4100 + v * 250 },
        { at: 11_000, to: 'bob', do: 'answer', text: `Found ${3 + v} orders with that status in staging; rows are in the data.` },
        { at: 12_000, to: 'bob', do: 'answer_delivered' },
      ],
    },
    {
      offset: 15_000,
      kind: 'question',
      asker: 'bob',
      to: ['alice', 'carol'],
      broadcast: true,
      question: 'Is anyone else seeing slow builds on the shared runner this afternoon?',
      ackTimeout: 20,
      answerTimeout: 600,
      steps: [
        { at: 1000, to: 'alice', do: 'deliver' },
        { at: 1600, to: 'carol', do: 'deliver' },
        { at: 3000, to: 'alice', do: 'ack' },
        { at: 4500, to: 'alice', do: 'tool', tool: 'Read', status: 'ok', duration_ms: 9 },
        { at: 10_000, to: 'alice', do: 'answer', text: 'Yes, since about two o\'clock: the cache volume is nearly full, so every build restores from scratch.' },
        { at: 11_000, to: 'alice', do: 'answer_delivered' },
      ],
    },
    {
      offset: 25_000,
      kind: 'question',
      asker: 'carol',
      to: ['bob'],
      broadcast: false,
      question: SECOND_FACTS[v]!,
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 700, to: 'bob', do: 'deliver' },
        { at: 2000, to: 'bob', do: 'ack' },
        { at: 3300, to: 'bob', do: 'tool', tool: 'Glob', status: 'ok', duration_ms: 18 },
        { at: 4100, to: 'bob', do: 'tool', tool: 'Read', status: 'error', duration_ms: 4 },
        { at: 5000, to: 'bob', do: 'tool', tool: 'Read', status: 'ok', duration_ms: 11 },
        { at: 12_000, to: 'bob', do: 'answer', text: 'Yes; details are in the team notes under staging.' },
        { at: 13_000, to: 'bob', do: 'answer_delivered' },
      ],
    },
    {
      offset: 32_000,
      kind: 'question',
      asker: 'alice',
      to: ['carol'],
      broadcast: false,
      question: 'Can you check why the staging data refresh did not run last night?',
      ackTimeout: 10,
      answerTimeout: 25,
      steps: [
        { at: 900, to: 'carol', do: 'deliver' },
        { at: 2400, to: 'carol', do: 'ack' },
        { at: 4000, to: 'carol', do: 'tool', tool: 'Grep', status: 'ok', duration_ms: 44 },
        { at: 6500, to: 'carol', do: 'tool', tool: 'Read', status: 'ok', duration_ms: 15 },
      ],
    },
    {
      offset: 40_000,
      kind: 'capability',
      asker: 'bob',
      to: ['carol'],
      broadcast: false,
      capability: { name: 'service_health', params: { service: ['worker', 'api', 'web'][v]! } },
      ackTimeout: 120,
      answerTimeout: 1800,
      steps: [
        { at: 800, to: 'carol', do: 'deliver' },
        { at: 2000, to: 'carol', do: 'ack' },
        { at: 3000, to: 'carol', do: 'progress', text: 'calling the health endpoint', pct: 50 },
        { at: 4800, to: 'carol', do: 'tool', tool: 'service_health', status: 'ok', duration_ms: 1800 },
        { at: 7000, to: 'carol', do: 'answer', text: 'Healthy, no errors in the last hour.' },
        { at: 8000, to: 'carol', do: 'answer_delivered' },
      ],
    },
    {
      // Created as carol's answer above is returned (40 s + 8 s): the same updated_at.
      offset: 48_000,
      kind: 'question',
      asker: 'carol',
      to: ['alice', 'bob'],
      broadcast: true,
      question: 'Which of you knows how the staging cache is warmed after a deploy?',
      ackTimeout: 60,
      answerTimeout: 600,
      steps: [
        // Delivered to both in the same millisecond: two changes, the second stamped 1 ms on.
        { at: 800, to: 'alice', do: 'deliver' },
        { at: 800, to: 'bob', do: 'deliver' },
        { at: 2000, to: 'bob', do: 'ack' },
        { at: 2600, to: 'alice', do: 'ack' },
        { at: 3500, to: 'alice', do: 'tool', tool: 'Grep', status: 'ok', duration_ms: 27 },
        { at: 6000, to: 'bob', do: 'answer', text: 'A post-deploy job requests the ten busiest pages once each.' },
        { at: 6800, to: 'bob', do: 'answer_delivered' },
        { at: 8000, to: 'alice', do: 'answer', text: 'The deploy pipeline runs a warm-up step; the page list is in its config.' },
        { at: 9000, to: 'alice', do: 'answer_delivered' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();

/** Stable per (epoch, cycle, index), shaped like a relay request id. */
function requestId(epoch: number, cycle: number, index: number): string {
  return `rq_${createHash('sha256').update(`team-relay-demo:${epoch}:${cycle}:${index}`).digest('hex').slice(0, 32)}`;
}

type Materialised = {
  doc: ActivityRequest; // the full (participant) view
  progress: ProgressItem[];
  /** M11-SPEC §4: each recipient's full answer (the asker reads it on the request). */
  answers: Record<string, string>;
};

function materialise(s: Script, created: number, id: string, now: number, environments: Map<string, string>): Materialised | null {
  if (created > now) return null;
  const recipients: Record<string, RecipientView> = {};
  for (const m of s.to) {
    recipients[m] = {
      status: 'pending',
      delivered_at: null,
      acked_at: null,
      answered_at: null,
      answer_delivered_at: null,
      tools: [],
      progress_count: 0,
      last_progress_pct: null,
      answer_preview: null,
    };
  }
  const progress: ProgressItem[] = [];
  const answers: Record<string, string> = {};
  let updated = created;
  const ackDeadline = created + s.ackTimeout * 1000;
  const answerDeadline = created + s.answerTimeout * 1000;
  // Deadlines become events too (the relay's sweep), in time order with the scripted steps.
  type Timed = { at: number; apply: () => void };
  const events: Timed[] = s.steps.map((step) => ({
    at: created + step.at,
    apply: () => {
      const r = recipients[step.to]!;
      const t = iso(created + step.at);
      switch (step.do) {
        case 'deliver':
          r.delivered_at ??= t;
          break;
        case 'ack':
          if (r.status === 'pending' || r.status === 'no_response') r.status = 'acked';
          r.acked_at ??= t;
          break;
        case 'tool':
          r.tools.push({ tool: step.tool, status: step.status, at: t, duration_ms: step.duration_ms });
          progress.push({ seq: progress.length + 1, member: step.to, kind: 'tool', tool: step.tool, status: step.status, duration_ms: step.duration_ms, time: t });
          break;
        case 'waiting':
          r.tools.push({ tool: step.tool, status: 'waiting', at: t, duration_ms: null });
          progress.push({ seq: progress.length + 1, member: step.to, kind: 'tool', tool: step.tool, status: 'waiting', duration_ms: null, time: t });
          break;
        case 'progress':
          r.progress_count++;
          r.last_progress_pct = step.pct;
          progress.push({ seq: progress.length + 1, member: step.to, kind: 'progress', text: step.text, pct: step.pct, time: t });
          break;
        case 'answer':
          r.status = 'answered';
          r.acked_at ??= t;
          r.answered_at = t;
          r.answer_preview = step.text.slice(0, PREVIEW_CHARS);
          answers[step.to] = step.text;
          break;
        case 'answer_delivered':
          r.answer_delivered_at ??= t;
          break;
      }
    },
  }));
  // The sweep records a passed deadline a moment later (it runs on the relay's own schedule).
  for (const m of s.to) {
    events.push({ at: ackDeadline + SWEEP_LAG_MS, apply: () => void (recipients[m]!.status === 'pending' && (recipients[m]!.status = 'no_response')) });
    events.push({ at: answerDeadline + SWEEP_LAG_MS, apply: () => void (recipients[m]!.status === 'acked' && (recipients[m]!.status = 'timed_out')) });
  }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.at > now) break;
    const before = JSON.stringify(recipients);
    e.apply();
    // M2-SPEC §7.1: every change stamps max(now, previous updated_at + 1 ms).
    if (JSON.stringify(recipients) !== before) updated = Math.max(e.at, updated + 1);
  }
  const doc: ActivityRequest = {
    request_id: id,
    kind: s.kind,
    asker: s.asker,
    broadcast: s.broadcast,
    created_at: iso(created),
    updated_at: iso(updated),
    ack_deadline: iso(ackDeadline),
    answer_deadline: iso(answerDeadline),
    expire_at: iso(created + DEMO_TTL_MS),
    capability: s.capability
      ? { name: s.capability.name, environment: environments.get(s.capability.name) ?? 'staging', params: { ...s.capability.params } }
      : null,
    question: s.question ?? null,
    recipients,
    participant: true,
  };
  return { doc, progress, answers };
}

/**
 * The view `viewer` gets (M2-SPEC §3.5): the question and params only for participants; an
 * answer preview only for the asker and for the recipient who wrote it (as in §3.11, where a
 * recipient sees only its own entry), which is also how the relay reads it.
 */
function viewFor(doc: ActivityRequest, viewer: string): ActivityRequest {
  const isAsker = doc.asker === viewer;
  const participant = isAsker || Object.hasOwn(doc.recipients, viewer);
  const recipients: Record<string, RecipientView> = {};
  for (const [m, r] of Object.entries(doc.recipients)) {
    recipients[m] = { ...r, answer_preview: isAsker || m === viewer ? r.answer_preview : null };
  }
  return {
    ...doc,
    question: participant ? doc.question : null,
    capability: doc.capability ? { ...doc.capability, params: participant ? doc.capability.params : null } : null,
    recipients,
    participant,
  };
}

/** M2-SPEC §7.2: open while the deadline for the stored status is still ahead. */
export function stillOpen(doc: ActivityRequest, r: RecipientView, now: number): boolean {
  if (r.status === 'pending') return now < Date.parse(doc.ack_deadline);
  if (r.status === 'acked') return now < Date.parse(doc.answer_deadline);
  return false;
}

/** The median, rounded to 3 decimals as the relay rounds it; null for none. */
export function median3(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  const m = v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
  return Math.round(m * 1000) / 1000;
}

function memberStats(docs: ActivityRequest[], member: string, start: number, now: number) {
  let asked = 0;
  let answered = 0;
  let open = 0;
  const seconds: number[] = [];
  for (const d of docs) {
    if (d.asker === member && Date.parse(d.created_at) >= start) asked++;
    const r = d.recipients[member];
    if (!r) continue;
    if (r.answered_at !== null && Date.parse(r.answered_at) >= start) {
      answered++;
      seconds.push((Date.parse(r.answered_at) - Date.parse(d.created_at)) / 1000);
    }
    if (stillOpen(d, r, now)) open++;
  }
  return { asked, answered, open, median_answer_seconds: median3(seconds) };
}

export class NotFound extends Error {
  constructor() {
    super('not_found');
    this.name = 'NotFound';
  }
}

/** A roster change the relay would refuse (M6-SPEC §1, §2), answered in the relay's terms. */
export class RosterRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'RosterRefusal';
  }
}

export type DemoRosterEntry = {
  member: string;
  emails: string[];
  role: 'owner' | 'member';
  added_by: string;
  added_at: string;
  /** M9-SPEC §7.2: an addition is an invitation until its person accepts. */
  status: 'active' | 'invited';
};

/** A demo team other than the scripted one: its id, name, roster and whose view it is. */
export type DemoTeamOptions = {
  team?: string;
  name?: string;
  /** A quiet team: this roster, no traffic, no presence. */
  roster?: DemoRosterEntry[];
  /** The viewer's member id there (alice, unless she chose another when creating it). */
  viewer?: string;
  /** M10-SPEC §1: the team's boundaries and who set them; absent, never set. */
  boundaries?: { boundaries: Boundaries; version: number; updated_by: string };
};

/** PICKERS-SPEC §2.1: the demo's shared drives and the picked folder (synthetic ids). */
export const DEMO_DRIVE_ID = '0AExampleDriveId0PVA';
export const DEMO_DELIVERY_DRIVE_ID = '0AExampleDeliveryPVA';
export const DEMO_FOLDER_ID = '1ExampleFolderIdxxxxxxxxxxxxxxxxx';

/** M10-SPEC §1 and PICKERS-SPEC §2.1: the scripted demo team's boundaries (synthetic). */
export const DEMO_BOUNDARIES: Boundaries = {
  topic: 'Example Co: the orders and payments services, their runbooks, deploys and incidents, and how the team works.',
  github_orgs: ['example-org'],
  github_repos: [{ org: 'example-labs', repo: 'api', id: 123456 }],
  drive_folders: [
    { domain: 'example.com', drive_id: DEMO_DRIVE_ID, folder_id: DEMO_DRIVE_ID, folder_name: 'Example Team Drive', drive_name: 'Example Team Drive' },
    { domain: 'example.com', drive_id: DEMO_DELIVERY_DRIVE_ID, folder_id: DEMO_FOLDER_ID, folder_name: 'Clients', drive_name: 'Example Delivery Drive' },
  ],
  drives: [{ domain: 'example.com', shared_drive: 'Example Archive' }],
  member_folders: true,
};

/** PICKERS-SPEC §3.5: the demo relay's sources settings (the Picker never runs in the demo). */
export const DEMO_SOURCES_CONFIG: SourcesConfig = {
  github: { configured: true, install_url: 'https://github.com/apps/example-relay-sources/installations/new' },
  google_picker: null,
};

/** PICKERS-SPEC §3.6: the demo relay's GitHub listing (synthetic), sorted as the relay sorts it. */
const DEMO_GITHUB: Omit<GithubListing, 'fetched_at'> = {
  installations: [
    {
      account: 'example-labs',
      state: 'ok',
      repository_selection: 'selected',
      repos: [
        { name: 'api', id: 123456, private: true, archived: false },
        { name: 'ml-notebooks', id: 123457, private: false, archived: false },
      ],
      truncated: false,
    },
    {
      account: 'example-org',
      state: 'ok',
      repository_selection: 'all',
      repos: [
        { name: 'old-site', id: 100104, private: false, archived: true },
        { name: 'orders-service', id: 100101, private: true, archived: false },
        { name: 'payments', id: 100102, private: true, archived: false },
        { name: 'runbooks', id: 100103, private: true, archived: false },
      ],
      truncated: false,
    },
    { account: 'example-sandbox', state: 'suspended', repository_selection: 'all', repos: [], truncated: false },
  ],
};

/** PICKERS-SPEC §3.3: what each scripted member's Mac could not find (item keys). */
const DEMO_MISSING: Record<string, string[]> = {
  alice: [`folder:${DEMO_FOLDER_ID}`],
  bob: [],
  carol: ['org:example-org', 'repo:example-labs/api'],
};

/** M6-SPEC §1: at most this many members per team. */
export const ROSTER_MAX = 50;

/** M11-SPEC §4: how the scripted teammates answer a question asked from the console (synthetic). */
const DEMO_REPLIES: Record<string, { ack: number; at: number; text: string }> = {
  bob: {
    ack: 1500,
    at: 6000,
    text:
      'From the orders-service repository: the export job is jobs/export_invoices, and its retries are set in config/jobs.yaml (three attempts, backoff from 30 s).\n\nI read README.md and config/jobs.yaml to answer.',
  },
  carol: {
    ack: 2500,
    at: 14_000,
    text: 'I could not find that in what I answer from. bob owns the worker service; he will know.',
  },
};
/** The questions a demo team keeps from the console (the oldest go first). */
const ASKED_MAX = 200;

export class BadRequest extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'BadRequest';
  }
}

export class DemoTeam {
  readonly team: string;
  readonly name: string;
  /** No scripted traffic: a team created (or joined) in the demo. */
  readonly quiet: boolean;
  private readonly viewer: string;
  private readonly epoch: number;
  private readonly manifests: Record<Member, Manifest | null>;
  private readonly environments = new Map<string, string>();
  private readonly publishedAt: string;
  /** M6-SPEC §1, in memory: alice owns the demo team; bob and carol are members. */
  private readonly rosterEntries: DemoRosterEntry[];
  /** M10-SPEC §1, in memory. */
  private bounds: TeamBoundaries;
  /** M11-SPEC §2, in memory: the boundaries version the viewer accepted (0: never). */
  private accepted: Acceptance;
  /** M11-SPEC §4, in memory: questions the viewer asked from the console, oldest first. */
  private readonly asked: Array<{ id: string; created: number; script: Script }> = [];

  constructor(
    private readonly now: () => number = Date.now,
    manifestPath: string = defaultManifestPath(),
    options: DemoTeamOptions = {},
  ) {
    this.team = options.team ?? DEMO_TEAM;
    this.name = options.name ?? 'Demo';
    this.quiet = options.roster !== undefined;
    this.viewer = options.viewer ?? DEMO_ME;
    const start = now();
    // Cycles are aligned to the wall clock, starting a few cycles back.
    this.epoch = Math.floor(start / DEMO_CYCLE_MS) * DEMO_CYCLE_MS - WARMUP_CYCLES * DEMO_CYCLE_MS;
    const manifest = loadManifest(manifestPath);
    const pick = (names: string[]): Manifest => ({
      version: 1,
      capabilities: manifest.capabilities.filter((c: Capability) => names.includes(c.name)),
    });
    for (const c of manifest.capabilities) this.environments.set(c.name, c.environment);
    // M4-SPEC §3, M10-SPEC §2: bob can answer from two folders, by name; carol from nothing yet.
    this.manifests = {
      alice: null,
      bob: { ...pick(['staging_db_query']), shares: [{ name: 'orders-service' }, { name: 'runbooks' }] },
      carol: { ...pick(['service_health', 'production_db_count']), shares: [] },
    };
    this.publishedAt = iso(this.epoch - 3_600_000);
    const added = iso(this.epoch - 7 * DAY_MS);
    this.rosterEntries = options.roster
      ? options.roster.map((e) => ({ ...e, emails: [...e.emails] }))
      : [
          { member: 'alice', emails: ['alice@example.com'], role: 'owner', added_by: 'alice', added_at: added, status: 'active' },
          { member: 'bob', emails: ['bob@example.com'], role: 'member', added_by: 'alice', added_at: added, status: 'active' },
          { member: 'carol', emails: ['carol@example.com', 'carol.w@example.org'], role: 'member', added_by: 'alice', added_at: added, status: 'active' },
          // M9-SPEC §7.2: an invitation dana has not answered yet.
          { member: 'dana', emails: ['dana@example.com'], role: 'member', added_by: 'alice', added_at: iso(this.epoch - DAY_MS), status: 'invited' },
        ];
    const set = options.roster === undefined ? { boundaries: DEMO_BOUNDARIES, version: 2, updated_by: DEMO_ME } : options.boundaries;
    // M10-SPEC §7.1: every item of the scripted boundaries has been there since version 1.
    this.bounds = set
      ? {
          team: this.team,
          version: set.version,
          boundaries: structuredClone(set.boundaries),
          since: nextSince(null, 1, set.boundaries),
          updated_at: iso(this.epoch - 2 * DAY_MS),
          updated_by: set.updated_by,
        }
      : { team: this.team, version: 0, boundaries: null, since: null, updated_at: null, updated_by: null };
    this.accepted = options.roster === undefined ? { version: 1, accepted_at: iso(this.epoch - 3 * DAY_MS) } : { version: 0, accepted_at: null };
  }

  /** GET /v1/teams/{team}/me/acceptance (M11-SPEC §2): the viewer's own. Never accepted: 0. */
  acceptance(): Acceptance {
    return { ...this.accepted };
  }

  /**
   * PUT /v1/teams/{team}/me/acceptance (M11-SPEC §2): the viewer accepts, for themselves, the
   * version they were shown; it must be the current one.
   */
  setAcceptance(version: number): Acceptance {
    if (this.bounds.boundaries === null) throw new RosterRefusal(409, 'not_set', 'The team has no boundaries to accept yet.');
    if (version !== this.bounds.version) {
      throw new RosterRefusal(409, 'version_conflict', 'The boundaries changed since you read them. Read them again.');
    }
    this.accepted = { version, accepted_at: iso(this.now()) };
    return this.acceptance();
  }

  /**
   * GET /v1/teams/{team}/members/status (M11-SPEC §3): each active member's last status (counts
   * and booleans only), whether they answered within 180 s, and the version they accepted.
   */
  membersStatus(): MembersStatus {
    const now = this.now();
    const active = this.rosterEntries.filter((e) => e.status === 'active').map((e) => e.member);
    const status = (o: { signedIn?: boolean; roots?: number; clones?: number; drive?: boolean; selfOk?: boolean; reason?: string; seenAgo: number }) => ({
      daemon: { version: '0.11.0', started_at: iso(now - 5 * 3_600_000) },
      claude: { found: true, signed_in: o.signedIn ?? true },
      folders: { repo_roots: o.roots ?? 1, clones: o.clones ?? 7, extra_folders: 0 },
      drive: { connected: o.drive ?? true },
      self_test: { ok: o.selfOk ?? true, at: iso(now - 2 * 3_600_000), reason: o.reason ?? null },
      seen_at: iso(now - o.seenAgo),
    });
    // PICKERS-SPEC §3.4: an owner sees every member's missing sources, anyone else only their
    // own; each list is filtered against the current boundaries, as the relay filters it.
    const owner = this.viewerRole() === 'owner';
    const sources = (member: string, version: number): MemberSources | null => {
      if (!owner && member !== this.viewer) return null;
      const b = this.bounds.boundaries;
      return { boundaries_version: version, missing: b ? knownItemKeys(b, DEMO_MISSING[member] ?? []) : [] };
    };
    const entry = (member: string): MemberStatusEntry => {
      const accepted = member === this.viewer ? this.accepted.version : 0;
      if (this.quiet) return { member, status: null, answering: false, accepted_version: accepted, sources: null };
      const s =
        member === 'bob'
          ? status({ seenAgo: 25_000 })
          : member === 'carol'
            ? status({ signedIn: false, roots: 0, clones: 0, selfOk: false, reason: 'Claude Code is not signed in.', seenAgo: 9 * 60_000 })
            : status({ drive: false, seenAgo: 40_000 });
      const version = member === 'bob' ? this.bounds.version : accepted;
      // carol's Mac last looked at the version before the current one (her daemon is behind).
      const looked = member === 'carol' ? Math.max(0, this.bounds.version - 1) : this.bounds.version;
      return { member, status: s, answering: now - Date.parse(s.seen_at) < 180_000, accepted_version: version, sources: sources(member, looked) };
    };
    return { members: active.map(entry), boundaries_version: this.bounds.version };
  }

  /** GET /v1/teams/{team}/me/requests (M11-SPEC §4): the viewer's own questions, newest first. */
  myRequests(limit: number): { requests: MyRequest[] } {
    const askedIds = new Set(this.asked.map((a) => a.id));
    const mine = this.all(this.now())
      .map((m) => m.doc)
      .filter((d) => d.asker === this.viewer && d.kind === 'question')
      .sort(
        (a, b) =>
          Date.parse(b.created_at) - Date.parse(a.created_at) ||
          Number(askedIds.has(b.request_id)) - Number(askedIds.has(a.request_id)) ||
          b.request_id.localeCompare(a.request_id),
      );
    return {
      requests: mine.slice(0, limit).map((d) => ({
        id: d.request_id,
        to: d.broadcast ? '*' : Object.keys(d.recipients),
        created_at: d.created_at,
        question_preview: [...(d.question ?? '')].slice(0, 200).join(''),
      })),
    };
  }

  /**
   * POST /v1/teams/{team}/requests as a question from the viewer (M11-SPEC §4), with the relay's
   * refusals. On `demo`, bob answers after 6 s and carol after 14 s; nobody answers on a quiet team.
   */
  ask(body: { to: '*' | string[]; question: string }) {
    const teammates = this.me().teammates;
    let to: string[];
    if (body.to === '*') {
      to = [...teammates].sort();
      if (to.length === 0) throw new RosterRefusal(400, 'bad_recipients', 'You have no teammates to broadcast to.');
    } else {
      if (body.to.includes(this.viewer)) throw new RosterRefusal(400, 'bad_recipients', 'You cannot send a request to yourself.');
      if (body.to.some((m) => !teammates.includes(m))) throw new RosterRefusal(400, 'bad_recipients', "'to' names someone who is not in your team.");
      to = [...body.to];
    }
    const created = this.now();
    const id = `rq_${createHash('sha256').update(`team-relay-demo-ask:${this.team}:${this.epoch}:${this.asked.length}:${created}`).digest('hex').slice(0, 32)}`;
    const steps: Step[] = [];
    if (!this.quiet) {
      for (const m of to) {
        const reply = DEMO_REPLIES[m];
        if (!reply) continue;
        steps.push({ at: reply.ack - 900, to: m, do: 'deliver' }, { at: reply.ack, to: m, do: 'ack' }, { at: reply.at, to: m, do: 'answer', text: reply.text });
      }
    }
    const script: Script = { offset: 0, kind: 'question', asker: this.viewer, to, broadcast: body.to === '*', question: body.question, ackTimeout: 120, answerTimeout: 1800, steps };
    this.asked.push({ id, created, script });
    if (this.asked.length > ASKED_MAX) this.asked.shift();
    return {
      request_id: id,
      recipients: to,
      created: true,
      ack_deadline: iso(created + 120_000),
      answer_deadline: iso(created + 1_800_000),
      expire_at: iso(created + DEMO_TTL_MS),
    };
  }

  /** GET /v1/teams/{team}/boundaries (M10-SPEC §1): any member. Never set: version 0, null. */
  boundaries(): TeamBoundaries {
    return structuredClone(this.bounds);
  }

  /**
   * PUT /v1/teams/{team}/boundaries (M10-SPEC §1, PICKERS-SPEC §3.2): owners, at the current
   * version; a legacy drive the stored document does not hold is 400 legacy_drive. Stored as the
   * relay stores it (normaliseBoundaries), with `since` by PICKERS-SPEC §2.3.
   */
  setBoundaries(body: SetBoundariesBody): TeamBoundaries {
    if (this.viewerRole() !== 'owner') throw new RosterRefusal(403, 'forbidden', 'Only team owners can set the boundaries.');
    if (!boundariesValid(body.boundaries)) throw new RosterRefusal(400, 'invalid_body', 'The boundaries do not pass the rule.');
    if (!legacyDrivesOk(this.bounds.boundaries?.drives ?? null, body.boundaries.drives)) {
      throw new RosterRefusal(400, 'legacy_drive', 'Pick shared-drive folders instead of typing drive names.');
    }
    if (body.version !== this.bounds.version) {
      throw new RosterRefusal(409, 'version_conflict', 'The boundaries changed since you read them. Read them again.');
    }
    const version = this.bounds.version + 1;
    const stored = normaliseBoundaries(body.boundaries);
    this.bounds = {
      team: this.team,
      version,
      boundaries: stored,
      since: nextSince(this.bounds, version, stored),
      updated_at: iso(this.now()),
      updated_by: this.viewer,
    };
    return this.boundaries();
  }

  /** GET /v1/teams/{team}/sources/config (PICKERS-SPEC §3.5): owners only. */
  sourcesConfig(): SourcesConfig {
    if (this.viewerRole() !== 'owner') throw new RosterRefusal(403, 'forbidden', 'Only team owners can choose the sources.');
    return structuredClone(DEMO_SOURCES_CONFIG);
  }

  /** GET /v1/teams/{team}/sources/github (PICKERS-SPEC §3.6): owners only; a fake listing. */
  sourcesGithub(): GithubListing {
    if (this.viewerRole() !== 'owner') throw new RosterRefusal(403, 'forbidden', 'Only team owners can choose the sources.');
    return { ...structuredClone(DEMO_GITHUB), fetched_at: iso(this.now()) };
  }

  /** The viewer's role here, by the roster's active entries. */
  viewerRole(): 'owner' | 'member' {
    return this.rosterEntries.find((e) => e.member === this.viewer && e.status === 'active')?.role ?? 'member';
  }

  /** Active members and owners, as the admin listing counts them. */
  counts(): { members: number; owners: number } {
    const active = this.rosterEntries.filter((e) => e.status === 'active');
    return { members: active.length, owners: active.filter((e) => e.role === 'owner').length };
  }

  private requireOwner(): void {
    if (this.viewerRole() !== 'owner') throw new RosterRefusal(403, 'forbidden', 'Only owners can change the roster.');
  }

  /**
   * M6-SPEC §2 as alice (an owner) reads it: every member with emails and role. The demo keeps
   * changes in memory, under the relay's invariants (§1): unique ids and emails, at most 50
   * members, 1 to 5 emails each, and always at least one owner.
   */
  roster() {
    const owner = this.viewerRole() === 'owner';
    // M9-SPEC §7.2: an owner sees the open invitations; anyone else the active members only,
    // and only their own email.
    return {
      members: this.rosterEntries
        .filter((e) => owner || e.status === 'active')
        .map((e) => ({
          member: e.member,
          emails: owner || e.member === this.viewer ? [...e.emails] : e.emails.map(() => null),
          role: e.role,
          added_by: e.added_by,
          added_at: e.added_at,
          status: e.status,
        })),
    };
  }

  private entry(member: string): DemoRosterEntry {
    const e = this.rosterEntries.find((x) => x.member === member);
    if (!e) throw new NotFound();
    return e;
  }

  private emailTaken(email: string, except?: DemoRosterEntry): boolean {
    return this.rosterEntries.some((e) => e !== except && e.emails.includes(email));
  }

  addMember(body: { member: string; email: string; role?: 'owner' | 'member' }) {
    this.requireOwner();
    if (this.rosterEntries.some((e) => e.member === body.member)) throw new RosterRefusal(409, 'member_exists', 'That member id is already on the team.');
    if (this.emailTaken(body.email)) throw new RosterRefusal(409, 'email_taken', 'That email already belongs to a member of the team.');
    if (this.rosterEntries.length >= ROSTER_MAX) throw new RosterRefusal(409, 'team_full', `A team has at most ${ROSTER_MAX} members, invitations included.`);
    const entry: DemoRosterEntry = {
      member: body.member,
      emails: [body.email],
      role: body.role ?? 'member',
      added_by: this.viewer,
      added_at: iso(this.now()),
      status: 'invited',
    };
    this.rosterEntries.push(entry);
    return { ...entry, emails: [...entry.emails] };
  }

  updateMember(member: string, body: { add_email?: string; remove_email?: string; role?: 'owner' | 'member' }) {
    this.requireOwner();
    const e = this.entry(member);
    const emails = [...e.emails];
    if (body.add_email !== undefined) {
      if (this.emailTaken(body.add_email, e) || emails.includes(body.add_email)) throw new RosterRefusal(409, 'conflict', 'That email already belongs to a member of the team.');
      if (emails.length >= 5) throw new RosterRefusal(409, 'too_many_emails', 'A member has at most 5 emails.');
      emails.push(body.add_email);
    }
    if (body.remove_email !== undefined) {
      if (!emails.includes(body.remove_email)) throw new RosterRefusal(404, 'not_found', 'That email is not one of theirs.');
      if (emails.length === 1) throw new RosterRefusal(409, 'last_email', 'A member needs at least one email.');
      emails.splice(emails.indexOf(body.remove_email), 1);
    }
    if (body.role === 'member' && e.role === 'owner' && e.status === 'active' && this.activeOwners() === 1) {
      throw new RosterRefusal(409, 'last_owner', 'A team always has at least one owner.');
    }
    e.emails = emails;
    if (body.role !== undefined) e.role = body.role;
    return { member: e.member, emails: [...e.emails], role: e.role, added_by: e.added_by, added_at: e.added_at, status: e.status };
  }

  private activeOwners(): number {
    return this.rosterEntries.filter((x) => x.role === 'owner' && x.status === 'active').length;
  }

  /** Remove a member, or withdraw an invitation (which retires nothing, M9-SPEC §7.2). */
  removeMember(member: string) {
    this.requireOwner();
    const e = this.entry(member);
    if (e.role === 'owner' && e.status === 'active' && this.activeOwners() === 1) {
      throw new RosterRefusal(409, 'last_owner', 'A team always has at least one owner.');
    }
    this.rosterEntries.splice(this.rosterEntries.indexOf(e), 1);
    return { member, removed: true };
  }

  /** Every request created by `now`; expired ones only when asked for (the feed passes them). */
  private all(now: number, withExpired = false): Materialised[] {
    const out: Materialised[] = [];
    for (const a of this.asked) {
      const m = materialise(a.script, a.created, a.id, now, this.environments);
      if (m && (withExpired || Date.parse(m.doc.expire_at) > now)) out.push(m);
    }
    if (this.quiet) return out;
    const first = Math.max(0, Math.floor((now - DEMO_TTL_MS - this.epoch) / DEMO_CYCLE_MS) - 1);
    const last = Math.floor((now - this.epoch) / DEMO_CYCLE_MS);
    for (let c = first; c <= last; c++) {
      const cycleStart = this.epoch + c * DEMO_CYCLE_MS;
      scripts(c).forEach((s, i) => {
        const m = materialise(s, cycleStart + s.offset, requestId(this.epoch, c, i), now, this.environments);
        if (m && (withExpired || Date.parse(m.doc.expire_at) > now)) out.push(m);
      });
    }
    return out;
  }

  me() {
    const teammates = this.quiet
      ? this.rosterEntries.filter((e) => e.status === 'active' && e.member !== this.viewer).map((e) => e.member)
      : DEMO_MEMBERS.filter((m) => m !== DEMO_ME);
    return { team: this.team, name: this.name, member: this.viewer, role: this.viewerRole(), teammates };
  }

  private presence(member: Member, now: number): { working: string | null; answering: string | null } {
    // Presence is written at most once per 15 s per stream (M2-SPEC §3.1).
    const tick = (offset: number) => iso(Math.floor((now - offset) / 15_000) * 15_000);
    const cycleStart = this.epoch + Math.floor((now - this.epoch) / DEMO_CYCLE_MS) * DEMO_CYCLE_MS;
    switch (member) {
      case 'bob':
        return { working: tick(2000), answering: tick(1000) };
      case 'carol':
        // The working session goes quiet within each cycle: online, then idle.
        return { working: iso(cycleStart + 3000), answering: tick(4000) };
      default:
        return { working: tick(0), answering: tick(500) };
    }
  }

  /**
   * M7-SPEC §1 as alice reads it. Her answering session polls through the demo, so it takes
   * what arrives at once and nothing waits.
   */
  inboxSummary() {
    if (this.quiet) return { pending: 0, more: false, oldest_at: null, from: [], answering: { last_seen: null } };
    const p = this.presence(DEMO_ME, this.now());
    return { pending: 0, more: false, oldest_at: null, from: [], answering: { last_seen: p.answering } };
  }

  /**
   * M2-SPEC §3.1, §3.6 as the relay computes them: one read of the most recently updated
   * requests of the last 24 h (at most STATS_READ_CAP, `stats_complete` false when the cap was
   * reached), expired ones left out; `asked` by creation in the window, `answered` and the
   * median by `answered_at` in the window, `open` by effective status (§7.2).
   */
  directory() {
    const now = this.now();
    const start = now - DAY_MS;
    const read = this.all(now)
      .map((m) => m.doc)
      .filter((d) => Date.parse(d.updated_at) > start)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.request_id.localeCompare(a.request_id))
      .slice(0, STATS_READ_CAP);
    if (this.quiet) {
      // A quiet team: its members, none of them running a session yet.
      const members = this.me().teammates.map((member) => ({
        member,
        last_seen: null,
        manifest: null,
        published_at: null,
        sessions: { working: { last_seen: null }, answering: { last_seen: null } },
        stats: { asked: 0, answered: 0, open: 0, median_answer_seconds: null },
        inbox_waiting: 0,
      }));
      return { members, stats_complete: true };
    }
    const members = DEMO_MEMBERS.filter((m) => m !== DEMO_ME).map((member) => {
      const p = this.presence(member, now);
      const seen = [p.working, p.answering].filter((x): x is string => x !== null).sort();
      const manifest = this.manifests[member];
      return {
        member,
        last_seen: seen.at(-1) ?? null,
        manifest,
        published_at: manifest ? this.publishedAt : null,
        sessions: { working: { last_seen: p.working }, answering: { last_seen: p.answering } },
        stats: memberStats(read, member, start, now),
        // M7-SPEC §1: every demo answering session is polling, so nothing waits.
        inbox_waiting: 0,
      };
    });
    return { members, stats_complete: read.length < STATS_READ_CAP };
  }

  /**
   * M2-SPEC §3.5 with §7.10: ascending by updated_at, since-exclusive, at most `limit`, except
   * that a page never splits the requests sharing one updated_at: it is cut before such a
   * group, or, when the whole page is one group, returns all of it (up to 500). `next_since`
   * is the updated_at of the last request read, expired or not; expired ones are not returned.
   */
  activity(q: { since?: string; limit?: number } = {}) {
    const now = this.now();
    let since: number;
    if (q.since === undefined) since = now - DAY_MS;
    else {
      since = Date.parse(q.since);
      if (!Number.isFinite(since)) throw new BadRequest('since must be an RFC 3339 time');
    }
    const limit = q.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BadRequest('limit must be 1..200');
    const read = this.all(now, true)
      .map((m) => m.doc)
      .filter((d) => Date.parse(d.updated_at) > since)
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.request_id.localeCompare(b.request_id));
    let page = read.slice(0, limit);
    if (read.length > limit && read[limit]!.updated_at === page.at(-1)!.updated_at) {
      const boundary = page.at(-1)!.updated_at;
      const before = page.filter((d) => d.updated_at !== boundary);
      page = before.length > 0 ? before : read.filter((d) => d.updated_at === boundary).slice(0, ACTIVITY_MAX_GROUP);
    }
    return {
      requests: page.filter((d) => Date.parse(d.expire_at) > now).map((d) => viewFor(d, DEMO_ME)),
      next_since: page.length > 0 ? page.at(-1)!.updated_at : iso(since),
      server_time: iso(now),
    };
  }

  /**
   * M1-SPEC §3.11 as alice, in the relay's shape: the asker sees every recipient, a recipient
   * only itself; progress holds progress and tool events in one shape (M2-SPEC §3.3), the
   * fields that do not apply to a kind being null.
   */
  request(id: string) {
    const now = this.now();
    const found = this.all(now).find((m) => m.doc.request_id === id);
    if (!found) throw new NotFound();
    const { doc, progress, answers } = found;
    const isAsker = doc.asker === this.viewer;
    if (!isAsker && !doc.recipients[this.viewer]) throw new NotFound();
    // M11-SPEC §4: the asker reads each recipient's full answer next to its preview.
    type RecipientDetail = { status: Status; acked_at: string | null; answered_at: string | null; answer_preview?: string | null; answer?: string | null };
    const recipients: Record<string, RecipientDetail> = {};
    for (const [m, r] of Object.entries(doc.recipients)) {
      if (isAsker) recipients[m] = { status: r.status, acked_at: r.acked_at, answered_at: r.answered_at, answer_preview: r.answer_preview, answer: answers[m] ?? null };
      else if (m === this.viewer) recipients[m] = { status: r.status, acked_at: r.acked_at, answered_at: r.answered_at };
    }
    return {
      request_id: doc.request_id,
      kind: doc.kind,
      asker: doc.asker,
      broadcast: doc.broadcast,
      question: doc.question,
      capability: doc.capability,
      created_at: doc.created_at,
      ack_deadline: doc.ack_deadline,
      answer_deadline: doc.answer_deadline,
      expire_at: doc.expire_at,
      recipients,
      progress: progress
        .filter((p) => isAsker || p.member === this.viewer)
        .map((p) =>
          p.kind === 'progress'
            ? { seq: p.seq, member: p.member, kind: p.kind, text: p.text, pct: p.pct, tool: null, status: null, duration_ms: null, time: p.time }
            : { seq: p.seq, member: p.member, kind: p.kind, text: null, pct: null, tool: p.tool, status: p.status, duration_ms: p.duration_ms, time: p.time },
        ),
    };
  }
}

// ---------------------------------------------------------------------------------------
// M9-SPEC: the demo account: alice's teams, her invitations, and (she is an admin here) the
// relay's other teams, with the relay's rules and refusals.

/** M9-SPEC §2: teams one account may have created and not deleted. */
export const DEMO_MAX_TEAMS_CREATED = 3;
const RESERVED_TEAM_IDS = new Set(['admin', 'api', 'login', 'v1', 'health', 'static', 'www', 'team', 'teams', 'relay', 'console', 'demo', 'test']);
const NEW_TEAM_ID = /^[a-z][a-z0-9-]{2,31}$/;
const RESERVE_MS = 31 * DAY_MS;

/** A team of the demo relay, as the admin listing shows it. */
type WorldTeam = {
  id: string;
  name: string;
  seed: boolean;
  status: 'active' | 'deleted';
  created_at: string;
  created_by_member: string | null;
  /** Counts for a team alice is not on (hers come from its roster). */
  members: number;
  owners: number;
  last_activity_at: string | null;
  deleted_at?: string;
  reserved_until?: string;
};

type DemoInvitation = {
  team: string;
  name: string;
  member: string;
  role: 'owner' | 'member';
  invited_by_member: string;
  roster: DemoRosterEntry[];
  boundaries?: DemoTeamOptions['boundaries'];
};

/** M9-SPEC §2 on the relay: the team id made from a name when none is given. */
export function teamIdFromName(name: string): string {
  let id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(id)) id = `team-${id}`;
  id = id.slice(0, 32).replace(/-+$/, '');
  return id.length >= 3 ? id : `${id}-team`.slice(0, 32);
}

export class DemoAccount {
  readonly defaultTeam = DEMO_TEAM;
  private readonly held = new Map<string, DemoTeam>();
  /** Teams alice created and has not deleted (M9-SPEC §2's per-account count). */
  private readonly createdByMe = new Set<string>();
  private readonly world = new Map<string, WorldTeam>();
  private invitations: DemoInvitation[];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly manifestPath: string = defaultManifestPath(),
  ) {
    const t = now();
    const at = (daysAgo: number) => iso(t - daysAgo * DAY_MS);
    const entry = (member: string, role: 'owner' | 'member', status: 'active' | 'invited', by: string, daysAgo: number): DemoRosterEntry => ({
      member,
      emails: [`${member}@example.com`],
      role,
      added_by: by,
      added_at: at(daysAgo),
      status,
    });
    this.held.set(DEMO_TEAM, new DemoTeam(now, manifestPath));
    this.world.set(DEMO_TEAM, { id: DEMO_TEAM, name: 'Demo', seed: true, status: 'active', created_at: at(30), created_by_member: null, members: 0, owners: 0, last_activity_at: null });
    this.held.set(
      'research',
      new DemoTeam(now, manifestPath, {
        team: 'research',
        name: 'Research',
        roster: [entry('alice', 'owner', 'active', 'alice', 5), entry('erin', 'member', 'active', 'alice', 4), entry('frank', 'member', 'invited', 'alice', 1)],
      }),
    );
    this.createdByMe.add('research');
    this.world.set('research', { id: 'research', name: 'Research', seed: false, status: 'active', created_at: at(5), created_by_member: 'alice', members: 0, owners: 0, last_activity_at: at(1) });
    this.invitations = [
      {
        team: 'ops',
        name: 'Operations',
        member: 'alice',
        role: 'member',
        invited_by_member: 'olga',
        roster: [entry('olga', 'owner', 'active', 'olga', 12), entry('pat', 'member', 'active', 'olga', 9), entry('alice', 'member', 'active', 'olga', 0)],
        boundaries: {
          boundaries: {
            topic: 'Operations at Example Co: on-call, incidents, infrastructure and the runbooks behind them.',
            github_orgs: ['example-ops'],
            github_repos: [],
            drive_folders: [{ domain: 'example.com', drive_id: '0AExampleOpsDrive0PVA', folder_id: '0AExampleOpsDrive0PVA', folder_name: 'Operations', drive_name: 'Operations' }],
            drives: [],
            member_folders: false,
          },
          version: 1,
          updated_by: 'olga',
        },
      },
    ];
    this.world.set('ops', { id: 'ops', name: 'Operations', seed: false, status: 'active', created_at: at(12), created_by_member: 'olga', members: 2, owners: 1, last_activity_at: at(0.2) });
    this.world.set('design-guild', { id: 'design-guild', name: 'Design guild', seed: false, status: 'active', created_at: at(20), created_by_member: 'hana', members: 4, owners: 2, last_activity_at: at(2) });
    this.world.set('field-notes', { id: 'field-notes', name: 'Field notes', seed: false, status: 'active', created_at: at(8), created_by_member: 'ivo', members: 1, owners: 1, last_activity_at: null });
    this.world.set('old-pilot', {
      id: 'old-pilot',
      name: 'Old pilot',
      seed: false,
      status: 'deleted',
      created_at: at(40),
      created_by_member: 'jun',
      members: 0,
      owners: 0,
      last_activity_at: at(4),
      deleted_at: at(3),
      reserved_until: iso(t - 3 * DAY_MS + RESERVE_MS),
    });
  }

  /** One of alice's active teams (the default when none is named), else NotFound. */
  team(id: string = DEMO_TEAM): DemoTeam {
    const t = this.held.get(id);
    if (!t) throw new NotFound();
    return t;
  }

  /** GET /v1/me/teams as alice reads it: the file's team first, then the created ones by id. */
  myTeams() {
    const ids = [...this.held.keys()].sort((a, b) => (a === DEMO_TEAM ? -1 : b === DEMO_TEAM ? 1 : a.localeCompare(b)));
    return {
      teams: ids.map((id) => {
        const t = this.held.get(id)!;
        const me = t.me();
        return { team: id, name: t.name, member: me.member, role: me.role };
      }),
      invitations: this.invitations.map((i) => ({ team: i.team, name: i.name, member: i.member, role: i.role, invited_by_member: i.invited_by_member })),
      admin: true,
      teams_created: this.createdByMe.size,
      max_teams_created: DEMO_MAX_TEAMS_CREATED,
      suggested_member: DEMO_ME,
    };
  }

  private taken(id: string): boolean {
    const w = this.world.get(id);
    return RESERVED_TEAM_IDS.has(id) || (w !== undefined && (w.status === 'active' || Date.parse(w.reserved_until ?? '') > this.now()));
  }

  /** POST /v1/teams, with the relay's refusals (M9-SPEC §2, §7.4). */
  createTeam(body: { id?: string; name: string; owner_member_id: string }) {
    const name = body.name.trim();
    const id = body.id ?? teamIdFromName(name);
    if (!NEW_TEAM_ID.test(id)) throw new RosterRefusal(422, 'invalid_body', 'The team id must be 3 to 32 characters: a lower-case letter, then lower-case letters, digits or -.');
    if (this.taken(id)) throw new RosterRefusal(409, 'team_id_unavailable', 'That team id is not available. Choose another.');
    if (name.replace(/\s+/g, ' ').toLowerCase() === 'demo') {
      throw new RosterRefusal(409, 'team_name_unavailable', "That name belongs to a team in the relay's configuration. Choose another.");
    }
    if (this.createdByMe.size >= DEMO_MAX_TEAMS_CREATED) {
      throw new RosterRefusal(409, 'team_limit', `You have created ${DEMO_MAX_TEAMS_CREATED} teams, the most one account may. Delete one to create another.`);
    }
    const created = iso(this.now());
    const member = body.owner_member_id;
    const team = new DemoTeam(this.now, this.manifestPath, {
      team: id,
      name,
      viewer: member,
      roster: [{ member, emails: ['alice@example.com'], role: 'owner', added_by: member, added_at: created, status: 'active' }],
    });
    this.held.set(id, team);
    this.createdByMe.add(id);
    this.world.set(id, { id, name, seed: false, status: 'active', created_at: created, created_by_member: member, members: 0, owners: 0, last_activity_at: null });
    return { team: id, name, status: 'active', created_at: created, member, role: 'owner' };
  }

  /** POST /v1/me/invitations/{team} (M9-SPEC §7.2). */
  answerInvitation(team: string, accept: boolean) {
    const inv = this.invitations.find((i) => i.team === team);
    if (!inv) throw new RosterRefusal(404, 'not_found', 'That invitation is no longer open.');
    this.invitations = this.invitations.filter((i) => i !== inv);
    if (!accept) return { team, member: inv.member, status: 'declined' };
    this.held.set(
      team,
      new DemoTeam(this.now, this.manifestPath, {
        team,
        name: inv.name,
        viewer: inv.member,
        roster: inv.roster,
        ...(inv.boundaries ? { boundaries: inv.boundaries } : {}),
      }),
    );
    return { team, name: inv.name, member: inv.member, role: inv.role, status: 'active' };
  }

  private remove(team: string, confirm: string) {
    const w = this.world.get(team);
    if (!w || w.status !== 'active') throw new NotFound();
    if (w.seed) throw new RosterRefusal(409, 'seed_team', "This team comes from the relay's team file; it cannot be deleted here.");
    if (confirm !== team) throw new RosterRefusal(422, 'confirm_mismatch', 'Send {"confirm": "<team id>"} to delete the team.');
    const t = this.now();
    w.status = 'deleted';
    w.deleted_at = iso(t);
    w.reserved_until = iso(t + RESERVE_MS);
    this.held.delete(team);
    this.createdByMe.delete(team);
    this.invitations = this.invitations.filter((i) => i.team !== team);
    return { team, status: 'deleted', removal: 'complete', deleted_at: w.deleted_at, reserved_until: w.reserved_until };
  }

  /** DELETE /v1/teams/{team}: an owner deletes a team the API created (M9-SPEC §7.7). */
  deleteTeam(team: string, confirm: string) {
    const held = this.team(team);
    if (held.viewerRole() !== 'owner') throw new RosterRefusal(403, 'forbidden', 'Only an owner can delete the team.');
    return this.remove(team, confirm);
  }

  /** GET /v1/admin/teams (M9-SPEC §4): the file's teams first, then the others by id. */
  adminTeams(q: { after?: string; limit?: number } = {}) {
    const limit = q.limit ?? 200;
    const row = (w: WorldTeam) => {
      const held = this.held.get(w.id);
      const counts = held ? held.counts() : { members: w.members, owners: w.owners };
      return {
        id: w.id,
        name: w.name,
        status: w.status,
        seed: w.seed,
        created_at: w.created_at,
        created_by_member: w.created_by_member,
        ...counts,
        last_activity_at: w.id === DEMO_TEAM ? iso(this.now() - 20_000) : w.last_activity_at,
        ...(w.status === 'deleted' ? { removal: 'complete', deleted_at: w.deleted_at, reserved_until: w.reserved_until } : {}),
      };
    };
    const all = [...this.world.values()];
    const seeds = q.after === undefined ? all.filter((w) => w.seed) : [];
    const rest = all
      .filter((w) => !w.seed && (q.after === undefined || w.id > q.after))
      .filter((w) => w.status === 'active' || Date.parse(w.reserved_until ?? '') > this.now())
      .sort((a, b) => a.id.localeCompare(b.id));
    const page = rest.slice(0, limit);
    return { teams: [...seeds, ...page].map(row), next: rest.length > limit ? page.at(-1)!.id : null };
  }

  /** DELETE /v1/admin/teams/{team} (M9-SPEC §4). */
  adminDeleteTeam(team: string, confirm: string) {
    return this.remove(team, confirm);
  }
}
