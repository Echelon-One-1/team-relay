// A small in-memory stand-in for the relay (M1-SPEC §3), enough to drive the plugin's
// client and servers in tests. It is deliberately simple: no deadlines, no audit, no param
// validation (a created request stores its params as sent).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { nextSince } from '../../src/boundaries-rule.js';
import type { Boundaries, BoundariesSince } from '../../src/boundaries-types.js';

export const TOKENS: Record<string, string> = {
  'tok-alice-0123456789': 'alice',
  'tok-bob-0123456789': 'bob',
  'tok-carol-0123456789': 'carol',
};
export const TOKEN_OF: Record<string, string> = Object.fromEntries(Object.entries(TOKENS).map(([t, m]) => [m, t]));
const MEMBERS = ['alice', 'bob', 'carol'];
const TEAM = 'demo';

export type Recorded = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
  /** The request body exactly as received. */
  raw: string;
  member: string | null;
  at: number;
};

type Envelope = Record<string, unknown> & { id: string; seq: number };
type StreamState = { messages: Envelope[]; cursor: number };
type Fault = { match: (r: Recorded) => boolean; status: number; body?: unknown; times: number };

export type RecipientState = { status: string; acked_at: string | null; answered_at: string | null };
export type RequestDoc = {
  request_id: string;
  kind: 'question' | 'capability';
  asker: string;
  broadcast: boolean;
  question: string | null;
  capability: { name: string; params: Record<string, unknown> } | null;
  created_at: string;
  ack_deadline: string;
  answer_deadline: string;
  expire_at: string;
  recipients: Record<string, RecipientState>;
};

export const hex32 = () => randomBytes(16).toString('hex');
export const rqId = () => `rq_${hex32()}`;
export const msgId = () => `msg_${hex32()}`;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

export class FakeRelay {
  readonly requests: Recorded[] = [];
  readonly manifests = new Map<string, unknown>();
  readonly progress: Array<{ request_id: string; member: string; text: string; pct: number | null }> = [];
  readonly created: Array<Record<string, unknown>> = [];
  readonly replies: Array<{ request_id: string; member: string; body: Record<string, unknown> }> = [];
  readonly acks: Array<{ request_id: string; member: string }> = [];
  /** M2-SPEC §3.3 tool events, as received. */
  readonly toolEvents: Array<{ request_id: string; member: string; body: unknown; raw: string }> = [];
  /** Extra bearer tokens (for example Google ID tokens from a fake gcloud): token → member or null. */
  authorize: ((token: string) => string | null) | null = null;
  /** When set, requests matching it are never answered (a hung relay). */
  hang: ((r: Recorded) => boolean) | null = null;
  /** Request documents as §3.11 serves them (the full asker view). */
  readonly requestDocs = new Map<string, RequestDoc>();
  private readonly streams = new Map<string, StreamState>();
  private readonly idem = new Map<string, { request_id: string; body: string }>();
  private faults: Fault[] = [];
  /** M7-SPEC §1: when each member's answering session last polled (null: never). */
  readonly answeringSeen = new Map<string, string | null>();
  /** Called when a cursor POST arrives, before it is answered. */
  onCursor: ((member: string, stream: string, seq: number) => Promise<void> | void) | null = null;
  private server: Server | null = null;
  url = '';

  // --- M5-SPEC §2, §3: the login flow and device credentials, reduced ---------------------
  /** The member a login mints a credential for (the fake provider approves at once). */
  loginAs = 'alice';
  /** When set, /v1/login/token answers with this status and error instead. */
  loginRefusal: { status: number; error: string } | null = null;
  /** When set, the member presses Cancel on the chooser: the browser comes home with ?error=access_denied. */
  loginCancel = false;
  /** When set, /v1/login/token names this relay_url instead of this relay's own. */
  loginRelayUrl: string | null = null;
  /**
   * The Google account /v1/login/token reports (M5-SPEC §9 item 3): by default the member's
   * first roster email; null leaves the field out (a relay from before it); a string is sent
   * as it is.
   */
  loginEmail: string | null | undefined = undefined;
  readonly logins = new Map<string, { challenge: string; state: string; port: number; device: string; member: string; used: boolean }>();
  /** Device credentials: token → member (revoked ones are removed). */
  readonly credentials = new Map<string, string>();
  readonly revoked: string[] = [];

  // --- M6-SPEC §1, §2: the roster, reduced ------------------------------------------------
  readonly roster: Array<{ member: string; emails: string[]; role: 'owner' | 'member' }> = [
    { member: 'alice', emails: ['alice@example.com'], role: 'owner' },
    { member: 'bob', emails: ['bob@example.com'], role: 'member' },
    { member: 'carol', emails: ['carol@example.com'], role: 'member' },
  ];

  // --- M10-SPEC §1: the team's boundaries (never set: version 0, null) ----------------------
  boundaries: {
    version: number;
    boundaries: Record<string, unknown> | null;
    since: BoundariesSince | null;
    updated_at: string | null;
    updated_by: string | null;
  } = {
    version: 0,
    boundaries: null,
    since: null,
    updated_at: null,
    updated_by: null,
  };
  /** Tests only: the team a boundaries document names (null: this team), to play a relay that answers with another team's. */
  boundariesTeam: string | null = null;
  /** M10-SPEC §1: the team's display name /me reports (absent: the field is left out). */
  teamName: string | null = null;

  /**
   * Set the team's boundaries, as an owner's PUT would (the version goes up by one), with the
   * relay's `since` (M10-SPEC §7.1): an item the previous version holds keeps its version; one
   * added, or added back after a removal, gets the new one.
   */
  setBoundaries(b: Record<string, unknown> | null): void {
    const version = this.boundaries.version + 1;
    const prev = { boundaries: this.boundaries.boundaries as unknown as Boundaries | null, since: this.boundaries.since };
    const since = b ? nextSince(prev, version, b as unknown as Boundaries) : null;
    this.boundaries = { version, boundaries: b, since, updated_at: iso(), updated_by: 'alice' };
  }

  /** Mint a device credential for `member` directly (as a completed login would). */
  mintCredential(member: string): string {
    const token = `trc_${randomBytes(32).toString('base64url')}`;
    this.credentials.set(token, member);
    return token;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  /**
   * Store a request document as the relay would (defaults: a directed capability call from
   * alice to bob, acked, expiring in a week). Returns its id.
   */
  addRequest(partial: Partial<Omit<RequestDoc, 'recipients'>> & { recipients?: Record<string, Partial<RecipientState>> } = {}): string {
    const request_id = partial.request_id ?? rqId();
    const recipients: Record<string, RecipientState> = {};
    for (const [m, st] of Object.entries(partial.recipients ?? { bob: { status: 'acked' } })) {
      recipients[m] = { status: 'pending', acked_at: null, answered_at: null, ...st };
    }
    this.requestDocs.set(request_id, {
      kind: 'capability',
      asker: 'alice',
      broadcast: false,
      question: null,
      capability: null,
      created_at: iso(),
      ack_deadline: iso(120_000),
      answer_deadline: iso(1800_000),
      expire_at: iso(604800_000),
      ...partial,
      request_id,
      recipients,
    });
    return request_id;
  }

  /** The next `times` requests matching `match` get `status` (and `body`). */
  fail(match: (r: Recorded) => boolean, status: number, times = 1, body?: unknown) {
    this.faults.push({ match, status, times, body });
  }

  stream(member: string, stream: string): StreamState {
    const key = `${member}/${stream}`;
    let s = this.streams.get(key);
    if (!s) {
      s = { messages: [], cursor: 0 };
      this.streams.set(key, s);
    }
    return s;
  }

  /** Append an envelope to a member's stream; fields not given get synthetic defaults. */
  enqueue(member: string, stream: 'inbox' | 'replies', partial: Record<string, unknown>): Envelope {
    const s = this.stream(member, stream);
    const env: Envelope = {
      id: msgId(),
      seq: s.messages.length + 1,
      team: TEAM,
      stream,
      type: stream === 'inbox' ? 'question' : 'answer',
      from: 'alice',
      to: member,
      request_id: rqId(),
      broadcast: false,
      time: iso(),
      expire_at: iso(7 * 86400_000),
      data: {},
      ...partial,
    };
    env.seq = s.messages.length + 1;
    s.messages.push(env);
    return env;
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  private async readBody(req: IncomingMessage): Promise<{ parsed: unknown; raw: string }> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return { parsed: undefined, raw: '' };
    try {
      return { parsed: JSON.parse(text), raw: text };
    } catch {
      return { parsed: { __invalid_json: text }, raw: text };
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const member = TOKENS[token] ?? this.credentials.get(token) ?? (token && this.authorize ? this.authorize(token) : null);
    const { parsed, raw } = await this.readBody(req);
    const rec: Recorded = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: parsed,
      raw,
      member,
      at: Date.now(),
    };
    this.requests.push(rec);
    if (this.hang?.(rec)) return;

    const fault = this.faults.find((f) => f.times > 0 && f.match(rec));
    if (fault) {
      fault.times--;
      return this.send(res, fault.status, fault.body ?? { error: fault.status === 401 ? 'unauthenticated' : 'unavailable', detail: 'injected' });
    }
    if (url.pathname === '/healthz') return this.send(res, 200, { ok: true });
    if (url.pathname === '/v1/login/start' && rec.method === 'GET') return this.loginStart(url, res);
    if (url.pathname === '/v1/login/token' && rec.method === 'POST') return this.loginToken(rec, res);
    if (!member) return this.send(res, 401, { error: 'unauthenticated' });

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'v1' || parts[1] !== 'teams') return this.send(res, 404, { error: 'not_found' });
    if (parts[2] !== TEAM) return this.send(res, 404, { error: 'not_found' });
    const rest = parts.slice(3);
    const m = rec.method;
    const body = (rec.body ?? {}) as Record<string, unknown>;

    if (m === 'GET' && rest.length === 1 && rest[0] === 'me') {
      return this.send(res, 200, { team: TEAM, ...(this.teamName ? { name: this.teamName } : {}), member, teammates: MEMBERS.filter((x) => x !== member) });
    }
    if (m === 'GET' && rest.length === 1 && rest[0] === 'boundaries') {
      return this.send(res, 200, { team: this.boundariesTeam ?? TEAM, ...this.boundaries });
    }
    if (m === 'GET' && rest.length === 1 && rest[0] === 'drive-client') {
      return this.send(res, 404, { error: 'drive_not_configured' });
    }
    if (m === 'PUT' && rest[0] === 'members' && rest[2] === 'manifest' && rest.length === 3) {
      if (rest[1] !== member) return this.send(res, 403, { error: 'forbidden' });
      this.manifests.set(member, rec.body);
      const caps = ((rec.body as { capabilities?: Array<{ name: string }> })?.capabilities ?? []).map((c) => c.name);
      return this.send(res, 200, { published_at: iso(), capabilities: caps });
    }
    if (m === 'GET' && rest.length === 2 && rest[0] === 'inbox' && rest[1] === 'summary') {
      // M7-SPEC §1, reduced: unexpired inbox messages past the cursor, at most 50; a peek.
      const s = this.stream(member, 'inbox');
      const now = Date.now();
      const waiting = s.messages.filter((e) => e.seq > s.cursor && Date.parse(String(e.expire_at)) > now);
      const read = waiting.slice(0, 50);
      return this.send(res, 200, {
        pending: read.length,
        more: waiting.length > 50,
        oldest_at: read[0] ? read[0].time : null,
        from: [...new Set(read.map((e) => String(e.from)))].slice(0, 5),
        answering: { last_seen: this.answeringSeen.get(member) ?? null },
      });
    }
    if (m === 'GET' && rest.length === 1 && rest[0] === 'activity') {
      // M2-SPEC §3.5, reduced: no request documents, the envelope of the answer only.
      const since = url.searchParams.get('since');
      return this.send(res, 200, { requests: [], next_since: since ?? iso(-86_400_000), server_time: iso() });
    }
    if (m === 'GET' && rest.length === 1 && rest[0] === 'directory') {
      return this.send(res, 200, {
        members: MEMBERS.filter((x) => x !== member).map((x) => ({
          member: x,
          last_seen: null,
          manifest: this.manifests.get(x) ?? null,
          published_at: this.manifests.has(x) ? iso() : null,
        })),
      });
    }
    if (m === 'POST' && rest.length === 1 && rest[0] === 'requests') {
      const key = `${member}|${String(body.idempotency_key)}`;
      const { idempotency_key: _k, ...rest2 } = body;
      const bodyText = JSON.stringify(rest2);
      const prior = this.idem.get(key);
      if (prior) {
        if (prior.body !== bodyText) return this.send(res, 409, { error: 'idempotency_conflict', detail: 'different body' });
        return this.send(res, 200, { request_id: prior.request_id, recipients: [], created: false });
      }
      const request_id = rqId();
      this.idem.set(key, { request_id, body: bodyText });
      this.created.push({ ...body, request_id, asker: member });
      const recipients = body.to === '*' ? MEMBERS.filter((x) => x !== member) : (body.to as string[]);
      this.addRequest({
        request_id,
        kind: body.kind === 'capability' ? 'capability' : 'question',
        asker: member,
        broadcast: body.to === '*',
        question: typeof body.question === 'string' ? body.question : null,
        capability: (body.capability as RequestDoc['capability']) ?? null,
        recipients: Object.fromEntries(recipients.map((r) => [r, { status: 'pending' }])),
      });
      return this.send(res, 201, { request_id, recipients, created: true, ack_deadline: iso(120_000), answer_deadline: iso(1800_000), expire_at: iso(604800_000) });
    }
    if (rest[0] === 'streams' && (rest[1] === 'inbox' || rest[1] === 'replies')) {
      const s = this.stream(member, rest[1]);
      if (m === 'GET' && rest.length === 2) {
        const afterQ = url.searchParams.get('after');
        const after = afterQ === null ? s.cursor : Number(afterQ);
        const wait = Math.min(25, Number(url.searchParams.get('wait') ?? '0'));
        const limit = Number(url.searchParams.get('limit') ?? '50');
        const deadline = Date.now() + wait * 1000;
        let closed = false;
        res.on('close', () => (closed = true));
        for (;;) {
          const msgs = s.messages.filter((e) => e.seq > after).slice(0, limit);
          if (msgs.length > 0 || Date.now() >= deadline || closed || !this.server) {
            if (closed) return;
            return this.send(res, 200, { messages: msgs, cursor: s.cursor, head: s.messages.length });
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      if (m === 'POST' && rest.length === 3 && rest[2] === 'cursor') {
        const n = Number(body.acked_seq);
        if (n > s.messages.length) return this.send(res, 400, { error: 'beyond_head' });
        if (this.onCursor) await this.onCursor(member, rest[1], n);
        s.cursor = Math.max(s.cursor, n);
        return this.send(res, 200, { cursor: s.cursor });
      }
    }
    if (rest[0] === 'requests' && rest.length >= 2) {
      const request_id = rest[1]!;
      const doc = this.requestDocs.get(request_id);
      const mine = doc?.recipients[member];
      if (m === 'POST' && rest[2] === 'ack') {
        this.acks.push({ request_id, member });
        if (mine && (mine.status === 'pending' || mine.status === 'no_response')) {
          mine.status = 'acked';
          mine.acked_at = iso();
        }
        return this.send(res, 200, { status: mine?.status ?? 'acked' });
      }
      if (m === 'POST' && rest[2] === 'reply') {
        this.replies.push({ request_id, member, body });
        if (mine) {
          mine.status = 'answered';
          mine.answered_at = iso();
        }
        return this.send(res, 200, { status: 'answered', message_id: msgId() });
      }
      if (m === 'POST' && rest[2] === 'events' && rest.length === 3) {
        // M2-SPEC §3.3: recipient only.
        if (!mine) return this.send(res, 404, { error: 'not_found' });
        this.toolEvents.push({ request_id, member, body, raw: rec.raw });
        return this.send(res, 201, { seq: this.toolEvents.filter((e) => e.request_id === request_id).length });
      }
      if (m === 'POST' && rest[2] === 'progress') {
        this.progress.push({ request_id, member, text: String(body.text), pct: (body.pct as number | null) ?? null });
        return this.send(res, 201, { seq: this.progress.filter((p) => p.request_id === request_id).length });
      }
      if (m === 'GET' && rest.length === 2) {
        // §3.11: the asker sees everything; a recipient only its own entry and progress.
        if (!doc || (doc.asker !== member && !mine)) return this.send(res, 404, { error: 'not_found' });
        const isAsker = doc.asker === member;
        const progress = this.progress
          .filter((p) => p.request_id === request_id)
          .map(({ member: pm, text, pct }, i) => ({ seq: i + 1, member: pm, text, pct, time: iso() }))
          .filter((p) => isAsker || p.member === member);
        return this.send(res, 200, {
          ...doc,
          recipients: isAsker ? doc.recipients : { [member]: mine },
          progress,
        });
      }
    }
    if (rest[0] === 'credentials' && rest[1] === 'self' && rest.length === 2 && m === 'DELETE') {
      if (!this.credentials.has(token)) return this.send(res, 404, { error: 'not_found' });
      this.credentials.delete(token);
      this.revoked.push(token);
      return this.send(res, 200, { revoked: true });
    }
    if (rest[0] === 'roster') return this.rosterRoute(rest, m, member, body, res);
    return this.send(res, 404, { error: 'not_found' });
  }

  private rosterRoute(rest: string[], m: string, member: string, body: Record<string, unknown>, res: ServerResponse) {
    const owner = this.roster.find((r) => r.member === member)?.role === 'owner';
    if (m === 'GET' && rest.length === 1) {
      return this.send(res, 200, {
        members: this.roster.map((r) => ({
          member: r.member,
          emails: owner || r.member === member ? r.emails : r.emails.map(() => null),
          role: r.role,
          added_by: 'alice',
          added_at: iso(-86_400_000),
        })),
      });
    }
    if (!owner) return this.send(res, 403, { error: 'forbidden', detail: 'owners only' });
    if (m === 'POST' && rest.length === 1) {
      const id = String(body.member);
      const email = String(body.email).toLowerCase();
      if (this.roster.some((r) => r.member === id || r.emails.includes(email))) return this.send(res, 409, { error: 'conflict', detail: 'member id or email taken' });
      const entry = { member: id, emails: [email], role: (body.role === 'owner' ? 'owner' : 'member') as 'owner' | 'member' };
      this.roster.push(entry);
      return this.send(res, 201, { ...entry, added_by: member, added_at: iso() });
    }
    const target = this.roster.find((r) => r.member === rest[1]);
    if (!target || rest.length !== 2) return this.send(res, 404, { error: 'not_found' });
    if (m === 'PATCH') {
      if (body.role === 'owner' || body.role === 'member') target.role = body.role;
      if (typeof body.add_email === 'string') target.emails.push(body.add_email.toLowerCase());
      if (typeof body.remove_email === 'string') target.emails = target.emails.filter((e) => e !== body.remove_email);
      return this.send(res, 200, { ...target });
    }
    if (m === 'DELETE') {
      if (target.role === 'owner' && this.roster.filter((r) => r.role === 'owner').length === 1) {
        return this.send(res, 409, { error: 'last_owner', detail: 'a team needs an owner' });
      }
      this.roster.splice(this.roster.indexOf(target), 1);
      for (const [t, who] of this.credentials) if (who === target.member) this.credentials.delete(t);
      return this.send(res, 200, { removed: target.member });
    }
    return this.send(res, 405, { error: 'method_not_allowed' });
  }

  /** GET /v1/login/start: the fake provider approves at once and sends the browser home. */
  private loginStart(url: URL, res: ServerResponse) {
    const q = url.searchParams;
    const port = Number(q.get('port'));
    const state = q.get('state') ?? '';
    const challenge = q.get('code_challenge') ?? '';
    const device = q.get('device') ?? '';
    if (!(port >= 1024 && port <= 65535) || !/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9 ._()-]{1,64}$/.test(device)) {
      return this.send(res, 400, { error: 'bad_request' });
    }
    if (this.loginCancel) {
      res.writeHead(303, { Location: `http://127.0.0.1:${port}/callback?error=access_denied&state=${state}`, 'Content-Length': '0' });
      return res.end();
    }
    const code = randomBytes(32).toString('base64url');
    this.logins.set(code, { challenge, state, port, device, member: this.loginAs, used: false });
    res.writeHead(303, { Location: `http://127.0.0.1:${port}/callback?code=${code}&state=${state}`, 'Content-Length': '0' });
    res.end();
  }

  /** POST /v1/login/token: code unused and the verifier's S256 equal to the challenge. */
  private loginToken(rec: Recorded, res: ServerResponse) {
    if (this.loginRefusal) return this.send(res, this.loginRefusal.status, { error: this.loginRefusal.error });
    const b = (rec.body ?? {}) as { code?: unknown; code_verifier?: unknown };
    const login = typeof b.code === 'string' ? this.logins.get(b.code) : undefined;
    if (!login || login.used || typeof b.code_verifier !== 'string') return this.send(res, 400, { error: 'invalid_grant' });
    const s256 = createHash('sha256').update(b.code_verifier, 'ascii').digest('base64url');
    if (s256 !== login.challenge) return this.send(res, 400, { error: 'invalid_grant' });
    login.used = true;
    const credential = this.mintCredential(login.member);
    const email = this.loginEmail === undefined ? (this.roster.find((r) => r.member === login.member)?.emails[0] ?? null) : this.loginEmail;
    return this.send(res, 200, {
      credential,
      team: TEAM,
      member: login.member,
      relay_url: this.loginRelayUrl ?? this.url,
      expires_at: iso(90 * 86_400_000),
      ...(email !== null ? { email } : {}),
    });
  }
}
