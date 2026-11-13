// The console's HTTP server (M2-SPEC §4.4; hosted mode M3-SPEC §3), as a factory the entry
// script and the tests share.
//
// Local mode (bin/console):
// - Loopback only; any request whose Host is not 127.0.0.1:<port> or localhost:<port> is
//   refused (DNS rebinding).
// - /api/* needs X-Console-Key equal to the per-launch key (compared in constant time):
//   missing is 401, wrong is 403. No CORS headers, ever; a cross-site fetch is refused.
// - A read-only proxy of exactly seven GETs: /api/me, /api/directory, /api/activity,
//   /api/requests/{id}, /api/roster (M6-SPEC §3), /api/inbox/summary (M7-SPEC §3) and
//   /api/boundaries (M10-SPEC §1). The only writes are the owner's roster changes: POST
//   /api/roster, PATCH and DELETE /api/roster/{member}; and an owner's boundaries: PUT
//   /api/boundaries (a body of at most BOUNDARIES_BODY_LIMIT, checked by checkSetBoundaries:
//   the relay's own rules, unknown fields refused). Each has Content-Type: application/json
//   and Sec-Fetch-Site: same-origin, no query but `team`, and a body checked here before it is
//   sent on. Nothing else is proxied, so there is no way to send, ack or reply from the
//   console.
// - GET /api/approvals/summary (local mode only, M8-SPEC §5), answered by the console server
//   itself: {"pending": n}, how many answers wait for this member's approval in their channel
//   working session on this computer (from ~/.config/team-relay/approvals.json; counts only).
// - GET /api/join, answered by the console server itself (never proxied): what a new member
//   needs to install the plugin (relay URL, team, the repository to clone, marketplace and
//   plugin names). Nothing secret; the same gate as the other /api routes. Hosted, it is
//   answered only to a member of the team (M6-SPEC §7 item 6; below).
// - M11-SPEC §2-§4 (guided joining, asking from the browser): GET /api/acceptance (the
//   viewer's own acceptance of the boundaries), GET /api/members-status (every member's setup
//   progress, counts and booleans only) and GET /api/my-requests (the viewer's last 20
//   requests); PUT /api/acceptance {"version"} (the viewer accepts the current boundaries for
//   themselves: there is no route naming another member) and POST /api/ask {"to", "question"}
//   (a question, never a capability call; the idempotency key is made here). Both changes
//   follow the rules above (checkAcceptance, checkAsk; ASK_BODY_LIMIT), and hosted, each is
//   sent for the IAP-verified viewer, never for anyone the browser names.
// - PICKERS-SPEC §3.7: GET /api/sources/config (the GitHub App's install link and the Google
//   Picker's public settings; locally `google_picker` is always null, since the picker's OAuth
//   client cannot have a loopback origin) and GET /api/sources/github (the repositories of the
//   orgs where the relay's GitHub App is installed). Both are owners' reads, proxied with the
//   other team routes' rules and shaped here (sourcesConfigView, githubListingView) before the
//   page sees them; neither ever holds a key or a token.
// - Static files from dist/console/ under a strict CSP; a placeholder page when it is absent.
//   PICKERS-SPEC §5.4: hosted only, GET/HEAD /pick/drive serves dist/console/pick-drive.html
//   under its own headers (PICKER_HEADERS), the one page Google's Picker runs on; locally it is
//   404, and /pick-drive.html itself is 404 everywhere, so that page never loads under other
//   headers and no other page loads under its headers.
//
// Several teams (M9-SPEC §5): every team-scoped /api/* route (me, directory, activity,
// requests, roster and its changes, inbox summary, boundaries, join) takes the team from a `team` query
// parameter or an X-Relay-Team header (the same value when both are sent), checked against
// the viewer's active teams (GET /v1/me/teams, kept 15 s per viewer; a stored device
// credential or a static token is bound to its one team, which is then the only one). Without
// either, RELAY_TEAM is the team, and only when the viewer is on it. A team the viewer is not
// on answers 403 {"error": "not_on_team", "email"?, "team"}, and nothing is asked of the relay.
// The account routes, each a change with the roster changes' rules (JSON, Sec-Fetch-Site:
// same-origin, the key or IAP, a checked body of at most 4 KiB, no query):
// GET /api/teams (the viewer's teams and invitations), POST /api/teams (create one; hosted,
// with X-Relay-Client-IP-Hash, M9-SPEC §7.6), POST /api/invitations/{team} (accept or
// decline), DELETE /api/teams/{team} (an owner deletes it), GET /api/admin/teams and DELETE
// /api/admin/teams/{team} (relay admins, M9-SPEC §4).
//
// Hosted mode (the container, CONSOLE_MODE=hosted, behind IAP):
// - Binds 0.0.0.0; the Host must equal the service's public host exactly.
// - No console key: every request, static files included, must carry a valid IAP assertion
//   (x-goog-iap-jwt-assertion); anything else is a bare 401. The viewer's email from it is
//   sent to the relay as X-Relay-On-Behalf-Of on each of the same routes. A viewer who is not
//   an active member of the team asked for (M6-SPEC §4: any signed-in Google account reaches
//   the page; M9-SPEC §7.2: an invitation is not membership) gets 403 {"error":
//   "not_on_team", "email", "team"} and no data. That includes /api/join (M6-SPEC §7 item 6).
//   The relay's own refusals of a non-member (the any-team delegate's 404, a per-team
//   delegate's 403 not_a_member) answer the same, and drop the viewer's cached teams.
// - A team creation carries X-Relay-Client-IP-Hash: sha256(CONSOLE_IP_HASH_SALT + the
//   viewer's address), 64 lower-case hex. The address is the right-most X-Forwarded-For
//   entry: Cloud Run's front end (which IAP sits in, with no load balancer in front here)
//   appends the address the connection came from, so that entry is the only one a client
//   cannot write; anything left of it is the client's own claim. IPv6 counts per /64, as the
//   relay counts it. Without the header (not on Cloud Run) the socket's peer counts.
//   Behind Google's external Application Load Balancer (M10-SPEC §5; CONSOLE_PROXY_HOPS=2)
//   the balancer appends two entries, `<client address>,<balancer address>`, so the address
//   is the second from the right; fewer entries than that count as one shared "unknown".

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, sep } from 'node:path';
import { BadRequest, NotFound, RosterRefusal, type DemoAccount } from './console-demo.js';
import { IAP_HEADER, type IapIdentity } from './iap.js';
import {
  MEMBER_RE,
  REQUEST_ID_RE,
  RelayError,
  RelayNetworkError,
  TEAM_RE,
  type AddMemberBody,
  type CreateTeamBody,
  type RelayClient,
  type RosterRole,
  type UpdateMemberBody,
} from './relay-client.js';
import type { GithubInstallation, GithubListing, GithubRepo, GooglePickerConfig, SetBoundariesBody, SourcesConfig } from './boundaries-types.js';
import {
  BOUNDARIES_FIELDS,
  BOUNDARIES_MAX_DRIVES,
  BOUNDARIES_MAX_FOLDERS,
  BOUNDARIES_MAX_ORGS,
  BOUNDARIES_MAX_REPOS,
  BOUNDARIES_VERSION_MAX,
  boundariesValid,
  DOMAIN_MAX,
  DRIVE_DOMAIN_RE,
  DRIVE_NAME_MAX,
  domainOk,
  driveItemIdOk,
  driveNameOk,
  FOLDER_NAME_MAX,
  folderNameOk,
  GITHUB_ORG_RE,
  normaliseBoundaries,
  orgOk,
  pickedDriveNameOk,
  REPO_NAME_MAX,
  repoIdOk,
  repoNameOk,
  SHARED_DRIVE_MAX,
  TOPIC_MAX,
  topicOk,
  versionOk,
} from './boundaries-rule.js';
import { normaliseRelayUrl } from './credentials.js';
import { codePointLength, hasLoneSurrogate } from './manifest.js';
import { defaultRelayUrl } from './relay-default.js';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * PICKERS-SPEC §5.4: the CSP of the Google Drive picker page (`GET /pick/drive`, hosted only)
 * and of nothing else. Google's scripts (api.js and the Picker code it loads, Google Identity
 * Services), the Picker's iframe and the Drive API's `files.get` are allowed there; the page
 * shows no team data. Every other page keeps CONTENT_SECURITY_POLICY. Styles allow
 * 'unsafe-inline' because the Picker writes its dialog's layout as <style> blocks in this page
 * (their text changes with Google's releases, so no hash; it takes no nonce); scripts stay strict.
 */
export const PICKER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' https://apis.google.com https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://www.googleapis.com https://accounts.google.com/gsi/ https://oauth2.googleapis.com/revoke",
  "frame-src https://docs.google.com https://accounts.google.com/gsi/",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * PICKERS-SPEC §5.4: every header of the picker page besides Content-Type and Content-Length,
 * exactly. COOP `same-origin-allow-popups` lets Google's consent popup talk back to the page;
 * the referrer policy is the one Google Identity Services asks for.
 */
export const PICKER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': PICKER_CONTENT_SECURITY_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
});

/** PICKERS-SPEC §3.7: the picker page's path (hosted only), and the built file it serves. */
export const PICKER_PATH = '/pick/drive';
export const PICKER_FILE = 'pick-drive.html';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** How long a viewer's teams (GET /v1/me/teams) are trusted, and how many viewers are kept. */
export const TEAMS_TTL_MS = 15_000;
const TEAMS_CACHE_MAX = 1000;

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Who a call is for: in hosted mode, the viewer IAP signed in; and which team it is about
 * (M9-SPEC §5), once the console server has checked the viewer is on it.
 */
export type ReadContext = { viewer?: string; team?: string };

/** What the proxy reads. Each call answers with the relay's JSON. */
export type ConsoleBackend = {
  /** RELAY_TEAM: the team when a call names none (M9-SPEC §5). */
  readonly defaultTeam: string;
  /**
   * The one team this backend can reach when its sign-in is bound to a team (a stored device
   * credential or a static token: no /v1/me/teams), else null.
   */
  readonly fixedTeam: string | null;
  me(ctx?: ReadContext): Promise<unknown>;
  directory(ctx?: ReadContext): Promise<unknown>;
  activity(q: { since?: string; limit?: number }, ctx?: ReadContext): Promise<unknown>;
  request(id: string, ctx?: ReadContext): Promise<unknown>;
  /** M6-SPEC §2, §3: the roster, and the owner's changes to it. */
  roster(ctx?: ReadContext): Promise<unknown>;
  /** M7-SPEC §1, §3: what waits for the viewer's answering session. */
  inboxSummary(ctx?: ReadContext): Promise<unknown>;
  addMember(body: AddMemberBody, ctx?: ReadContext): Promise<unknown>;
  updateMember(member: string, body: UpdateMemberBody, ctx?: ReadContext): Promise<unknown>;
  removeMember(member: string, ctx?: ReadContext): Promise<unknown>;
  /** M9-SPEC §2: the viewer's teams and invitations (the relay's GET /v1/me/teams). */
  myTeams(ctx?: ReadContext): Promise<unknown>;
  createTeam(body: CreateTeamBody, ctx?: ReadContext & { clientIpHash?: string }): Promise<unknown>;
  answerInvitation(team: string, accept: boolean, ctx?: ReadContext): Promise<unknown>;
  /** M9-SPEC §7.7: an owner deletes `ctx.team`. */
  deleteTeam(confirm: string, ctx?: ReadContext): Promise<unknown>;
  /** M9-SPEC §4: relay admins. */
  adminTeams(q: { after?: string; limit?: number }, ctx?: ReadContext): Promise<unknown>;
  adminDeleteTeam(team: string, confirm: string, ctx?: ReadContext): Promise<unknown>;
  /** M10-SPEC §1: the team's boundaries (any member), and an owner's replacement of them. */
  boundaries(ctx?: ReadContext): Promise<unknown>;
  setBoundaries(body: SetBoundariesBody, ctx?: ReadContext): Promise<unknown>;
  /** M11-SPEC §2: the viewer's own acceptance of the boundaries, and accepting `version` for themselves. */
  acceptance(ctx?: ReadContext): Promise<unknown>;
  setAcceptance(version: number, ctx?: ReadContext): Promise<unknown>;
  /** M11-SPEC §3: every member's setup progress and whether they answer now. */
  membersStatus(ctx?: ReadContext): Promise<unknown>;
  /** M11-SPEC §4: the viewer's own recent requests, newest first. */
  myRequests(limit: number, ctx?: ReadContext): Promise<unknown>;
  /** M11-SPEC §4: a question from the viewer (never a capability call). */
  ask(body: AskBody, ctx?: ReadContext): Promise<unknown>;
  /** PICKERS-SPEC §3.5 (owners): the GitHub App's install link and the Google Picker's public settings. */
  sourcesConfig(ctx?: ReadContext): Promise<unknown>;
  /** PICKERS-SPEC §3.6 (owners): the repositories of the allowed orgs where the GitHub App is installed. */
  sourcesGithub(ctx?: ReadContext): Promise<unknown>;
};

/** How many of the viewer's requests the Ask page lists (M11-SPEC §4). */
export const MY_REQUESTS_LIMIT = 20;

/** At most this many per-team clients are kept (a hosted console serves many teams). */
const TEAM_CLIENTS_MAX = 256;

export function relayBackend(client: RelayClient): ConsoleBackend {
  const opts = (ctx?: ReadContext) => ({
    attempts: 1,
    timeoutMs: 15_000,
    ...(ctx?.viewer !== undefined ? { onBehalfOf: ctx.viewer } : {}),
  });
  // A device credential or a static token belongs to one team, and the relay's account routes
  // refuse it (403 google_identity_required): that team is then the only one.
  const bound = client.boundToTeam;
  const clients = new Map<string, RelayClient>();
  const on = (ctx?: ReadContext): RelayClient => {
    const team = ctx?.team;
    if (team === undefined || team === client.team) return client;
    let c = clients.get(team);
    if (!c) {
      if (clients.size >= TEAM_CLIENTS_MAX) clients.delete(clients.keys().next().value!);
      c = client.withTeam(team);
      clients.set(team, c);
    }
    return c;
  };
  return {
    defaultTeam: client.team,
    fixedTeam: bound ? client.team : null,
    me: (ctx) => on(ctx).me(opts(ctx)),
    directory: (ctx) => on(ctx).directory(opts(ctx)),
    activity: (q, ctx) => on(ctx).activity(q, opts(ctx)),
    request: (id, ctx) => on(ctx).getRequest(id, opts(ctx)),
    roster: (ctx) => on(ctx).roster(opts(ctx)),
    inboxSummary: (ctx) => on(ctx).inboxSummary(opts(ctx)),
    addMember: (body, ctx) => on(ctx).addMember(body, opts(ctx)),
    updateMember: (member, body, ctx) => on(ctx).updateMember(member, body, opts(ctx)),
    removeMember: (member, ctx) => on(ctx).removeMember(member, opts(ctx)),
    myTeams: async (ctx) => {
      if (!bound) {
        try {
          return await client.myTeams(opts(ctx));
        } catch (err) {
          // A static token (RELAY_AUTH=token) has no Google identity either.
          if (!(err instanceof RelayError && err.status === 403 && err.code === 'google_identity_required')) throw err;
        }
      }
      return boundTeams(await client.me(opts(ctx)), client.team);
    },
    createTeam: (body, ctx) =>
      client.createTeam(body, { ...opts(ctx), ...(ctx?.clientIpHash !== undefined ? { clientIpHash: ctx.clientIpHash } : {}) }),
    answerInvitation: (team, accept, ctx) => client.answerInvitation(team, accept, opts(ctx)),
    deleteTeam: (confirm, ctx) => on(ctx).deleteTeam(confirm, opts(ctx)),
    adminTeams: (q, ctx) => client.adminTeams(q, opts(ctx)),
    adminDeleteTeam: (team, confirm, ctx) => client.adminDeleteTeam(team, confirm, opts(ctx)),
    boundaries: (ctx) => on(ctx).boundaries(opts(ctx)),
    setBoundaries: (body, ctx) => on(ctx).setBoundaries(body, opts(ctx)),
    acceptance: (ctx) => on(ctx).acceptance(opts(ctx)),
    setAcceptance: (version, ctx) => on(ctx).setAcceptance(version, opts(ctx)),
    membersStatus: (ctx) => on(ctx).membersStatus(opts(ctx)),
    myRequests: (limit, ctx) => on(ctx).myRequests(limit, opts(ctx)),
    // One key per question sent from the page: the console never retries it (attempts: 1).
    ask: (body, ctx) => on(ctx).createRequest({ idempotency_key: randomUUID(), kind: 'question', to: body.to, question: body.question }, opts(ctx)),
    sourcesConfig: (ctx) => on(ctx).sourcesConfig(opts(ctx)),
    sourcesGithub: (ctx) => on(ctx).sourcesGithub(opts(ctx)),
  };
}

/**
 * /v1/me/teams' shape for a sign-in bound to one team (a device credential or a static
 * token): that team, from /me; no invitations, no admin, and no creating (`can_manage_teams`
 * false: the relay asks for a Google identity there).
 */
function boundTeams(me: unknown, team: string): Record<string, unknown> {
  const m = (me && typeof me === 'object' ? me : {}) as Record<string, unknown>;
  const member = typeof m.member === 'string' ? m.member : null;
  return {
    teams: member
      ? [{ team, name: typeof m.name === 'string' ? m.name : team, member, role: m.role === 'owner' ? 'owner' : 'member' }]
      : [],
    invitations: [],
    admin: false,
    teams_created: null,
    max_teams_created: null,
    can_manage_teams: false,
  };
}

export function demoBackend(account: DemoAccount): ConsoleBackend {
  return {
    defaultTeam: account.defaultTeam,
    fixedTeam: null,
    me: async (ctx) => account.team(ctx?.team).me(),
    directory: async (ctx) => account.team(ctx?.team).directory(),
    activity: async (q, ctx) => account.team(ctx?.team).activity(q),
    request: async (id, ctx) => account.team(ctx?.team).request(id),
    roster: async (ctx) => account.team(ctx?.team).roster(),
    inboxSummary: async (ctx) => account.team(ctx?.team).inboxSummary(),
    addMember: async (body, ctx) => account.team(ctx?.team).addMember(body),
    updateMember: async (member, body, ctx) => account.team(ctx?.team).updateMember(member, body),
    removeMember: async (member, ctx) => account.team(ctx?.team).removeMember(member),
    myTeams: async () => account.myTeams(),
    createTeam: async (body) => account.createTeam(body),
    answerInvitation: async (team, accept) => account.answerInvitation(team, accept),
    deleteTeam: async (confirm, ctx) => account.deleteTeam(ctx?.team ?? account.defaultTeam, confirm),
    adminTeams: async (q) => account.adminTeams(q),
    adminDeleteTeam: async (team, confirm) => account.adminDeleteTeam(team, confirm),
    boundaries: async (ctx) => account.team(ctx?.team).boundaries(),
    setBoundaries: async (body, ctx) => account.team(ctx?.team).setBoundaries(body),
    acceptance: async (ctx) => account.team(ctx?.team).acceptance(),
    setAcceptance: async (version, ctx) => account.team(ctx?.team).setAcceptance(version),
    membersStatus: async (ctx) => account.team(ctx?.team).membersStatus(),
    myRequests: async (limit, ctx) => account.team(ctx?.team).myRequests(limit),
    ask: async (body, ctx) => account.team(ctx?.team).ask(body),
    sourcesConfig: async (ctx) => account.team(ctx?.team).sourcesConfig(),
    sourcesGithub: async (ctx) => account.team(ctx?.team).sourcesGithub(),
  };
}

// ---------------------------------------------------------------------------------------
// The roster bodies (M6-SPEC §2), checked before anything reaches the relay.

/** A lower-cased Google email address, as the roster stores it. */
export const ROSTER_EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;
const ROLES: readonly RosterRole[] = ['owner', 'member'];
/** The largest body a roster change may have. */
export const ROSTER_BODY_LIMIT = 4096;

export class BodyError extends Error {}

function onlyKeys(body: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new BodyError(`unknown field ${k.slice(0, 40)}`);
}

function email(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new BodyError(`${field} must be an email address`);
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !ROSTER_EMAIL_RE.test(e)) throw new BodyError(`${field} must be an email address`);
  return e;
}

function role(v: unknown): RosterRole {
  if (typeof v !== 'string' || !ROLES.includes(v as RosterRole)) throw new BodyError('role must be "owner" or "member"');
  return v as RosterRole;
}

export function checkAddMember(raw: unknown): AddMemberBody {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BodyError('the body must be a JSON object');
  const b = raw as Record<string, unknown>;
  onlyKeys(b, ['member', 'email', 'role']);
  if (typeof b.member !== 'string' || !MEMBER_RE.test(b.member)) {
    throw new BodyError('member must be 2 to 32 characters: a lower-case letter, then lower-case letters, digits or _');
  }
  const out: AddMemberBody = { member: b.member, email: email(b.email, 'email') };
  if (b.role !== undefined) out.role = role(b.role);
  return out;
}

export function checkUpdateMember(raw: unknown): UpdateMemberBody {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BodyError('the body must be a JSON object');
  const b = raw as Record<string, unknown>;
  onlyKeys(b, ['add_email', 'remove_email', 'role']);
  const out: UpdateMemberBody = {};
  if (b.add_email !== undefined) out.add_email = email(b.add_email, 'add_email');
  if (b.remove_email !== undefined) out.remove_email = email(b.remove_email, 'remove_email');
  if (b.role !== undefined) out.role = role(b.role);
  if (Object.keys(out).length === 0) throw new BodyError('nothing to change: give add_email, remove_email or role');
  return out;
}

// ---------------------------------------------------------------------------------------
// The account bodies (M9-SPEC §2, §4, §7), checked before anything reaches the relay.

/** A team id the API creates (M9-SPEC §1); the file's teams may also hold `_` (TEAM_RE). */
export const NEW_TEAM_ID_RE = /^[a-z][a-z0-9-]{2,31}$/;
/** Control, format (bidi, zero-width), private-use, unassigned and line/paragraph separators. */
const NAME_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BodyError('the body must be a JSON object');
  return raw as Record<string, unknown>;
}

/** POST /api/teams: {name, owner_member_id, id?}; the name trimmed, 1 to 60 characters. */
export function checkCreateTeam(raw: unknown): CreateTeamBody {
  const b = object(raw);
  onlyKeys(b, ['id', 'name', 'owner_member_id']);
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if ([...name].length < 1 || [...name].length > 60 || NAME_FORBIDDEN_RE.test(name)) {
    throw new BodyError('name must be 1 to 60 characters, with no control or invisible characters');
  }
  if (typeof b.owner_member_id !== 'string' || !MEMBER_RE.test(b.owner_member_id)) {
    throw new BodyError('owner_member_id must be 2 to 32 characters: a lower-case letter, then lower-case letters, digits or _');
  }
  const out: CreateTeamBody = { name, owner_member_id: b.owner_member_id };
  if (b.id !== undefined) {
    if (typeof b.id !== 'string' || !NEW_TEAM_ID_RE.test(b.id)) {
      throw new BodyError('id must be 3 to 32 characters: a lower-case letter, then lower-case letters, digits or -');
    }
    out.id = b.id;
  }
  return out;
}

/** POST /api/invitations/{team}: exactly {"accept": true} or {"accept": false}. */
export function checkInvitationAnswer(raw: unknown): boolean {
  const b = object(raw);
  onlyKeys(b, ['accept']);
  if (typeof b.accept !== 'boolean') throw new BodyError('send {"accept": true} or {"accept": false}');
  return b.accept;
}

/** A deletion's body: exactly {"confirm": "<the team id>"}, the id typed again. */
export function checkConfirm(raw: unknown, team: string): string {
  const b = object(raw);
  onlyKeys(b, ['confirm']);
  if (b.confirm !== team) throw new BodyError('type the team id to confirm: {"confirm": "<team id>"}');
  return team;
}

// ---------------------------------------------------------------------------------------
// The boundaries body (M10-SPEC §1, PICKERS-SPEC §2.1, §3.2), checked before anything reaches
// the relay.

/**
 * The largest PUT /api/boundaries body: the largest valid document (a 500-character topic, 10
 * orgs, 100 repositories, 20 folders with 255-character names in shared drives with
 * 100-character names, 10 legacy drives; every name of characters outside the BMP), with every
 * character that is not ASCII escaped as \uXXXX, is about 136 KiB and fits; the relay's own cap
 * is 256 KiB. (PICKERS-SPEC §3.2 sized the cap at 64 KiB on an estimate of 40 KiB for the
 * largest body; that body is about 69 KiB even unescaped, so 64 KiB would refuse valid bodies.)
 */
export const BOUNDARIES_BODY_LIMIT = 160 * 1024;
// The rule itself (limits, character classes, trimming) is boundaries-rule.ts, shared with the
// host's check of what the relay hands it and of what a member accepted.
export {
  BOUNDARIES_MAX_DRIVES,
  BOUNDARIES_MAX_FOLDERS,
  BOUNDARIES_MAX_ORGS,
  BOUNDARIES_MAX_REPOS,
  BOUNDARIES_VERSION_MAX,
  DOMAIN_MAX,
  DRIVE_DOMAIN_RE,
  GITHUB_ORG_RE,
  SHARED_DRIVE_MAX,
  TOPIC_MAX,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasExactly = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));

/**
 * A list as sent; the cap counts it before duplicates are dropped (M10-SPEC §7.5). Every
 * refusal names the field at fault and never quotes a value (PICKERS-SPEC §3).
 */
function list(v: unknown, field: string, max: number, what: string): unknown[] {
  if (!Array.isArray(v)) throw new BodyError(`${field} must be a list`);
  if (v.length > max) throw new BodyError(`${field}: at most ${max} ${what}`);
  return v;
}

const REPO_FIELDS = ['org', 'repo', 'id'] as const;
const FOLDER_FIELDS = ['domain', 'drive_id', 'folder_id', 'folder_name', 'drive_name'] as const;
const LEGACY_DRIVE_FIELDS = ['domain', 'shared_drive'] as const;
const ORG_TEXT = '1 to 39 letters, digits or -, not starting with -';
const DOMAIN_TEXT = 'a lower-case domain name, such as example.com';
const NAME_TEXT = 'with no control or invisible characters and no leading or trailing space';

function checkRepo(v: unknown): void {
  if (!isRecord(v) || !hasExactly(v, REPO_FIELDS)) throw new BodyError('github_repos: each repository must be exactly {"org", "repo", "id"}');
  if (!orgOk(v.org)) throw new BodyError(`github_repos: a repository's org must be ${ORG_TEXT}`);
  if (!repoNameOk(v.repo)) {
    throw new BodyError(`github_repos: a repository's name must be 1 to ${REPO_NAME_MAX} letters, digits, ., _ or -, and not only dots`);
  }
  if (!repoIdOk(v.id)) throw new BodyError("github_repos: a repository's id must be a whole number from 1 to 2^53-1, or null");
}

function checkFolder(v: unknown): void {
  if (!isRecord(v) || !hasExactly(v, FOLDER_FIELDS)) {
    throw new BodyError('drive_folders: each folder must be exactly {"domain", "drive_id", "folder_id", "folder_name", "drive_name"}');
  }
  if (!domainOk(v.domain)) throw new BodyError(`drive_folders: a folder's domain must be ${DOMAIN_TEXT}`);
  if (v.drive_id !== null && !driveItemIdOk(v.drive_id)) {
    throw new BodyError('drive_folders: a shared drive id must be 10 to 200 letters, digits, _ or -, or null');
  }
  if (!driveItemIdOk(v.folder_id)) throw new BodyError('drive_folders: a folder id must be 10 to 200 letters, digits, _ or -');
  if (!folderNameOk(v.folder_name)) throw new BodyError(`drive_folders: a folder name must be 1 to ${FOLDER_NAME_MAX} characters, ${NAME_TEXT}`);
  if (!pickedDriveNameOk(v.drive_name)) {
    throw new BodyError(`drive_folders: a shared drive name must be null or 1 to ${DRIVE_NAME_MAX} characters, ${NAME_TEXT}`);
  }
}

function checkLegacyDrive(v: unknown): void {
  if (!isRecord(v) || !hasExactly(v, LEGACY_DRIVE_FIELDS)) throw new BodyError('drives: each drive must be exactly {"domain", "shared_drive"}');
  // Neither is trimmed: a value with surrounding space is refused, as the relay refuses it.
  if (!domainOk(v.domain)) throw new BodyError(`drives: a drive domain must be ${DOMAIN_TEXT}`);
  if (!driveNameOk(v.shared_drive)) {
    throw new BodyError(`drives: a shared drive name must be 1 to ${SHARED_DRIVE_MAX} characters, with no /, no control or invisible characters and no leading or trailing space`);
  }
}

/**
 * PUT /api/boundaries: exactly {"version", "boundaries": {"topic", "github_orgs",
 * "github_repos", "drive_folders", "drives", "member_folders"}}, every field required, by the
 * one rule of PICKERS-SPEC §2.1 (boundaries-rule.ts, schema/boundaries-vectors.json); the caps
 * count the lists as sent. What is sent on is the document as the relay stores it
 * (normaliseBoundaries): the topic trimmed, duplicates and repositories of whole orgs dropped.
 * Whether a legacy drive was already stored (400 legacy_drive) and the relay's allowlists are
 * the relay's to check.
 */
export function checkSetBoundaries(raw: unknown): SetBoundariesBody {
  const b = object(raw);
  onlyKeys(b, ['version', 'boundaries']);
  if (!versionOk(b.version)) {
    throw new BodyError('version must be the whole number the boundaries were read at');
  }
  if (!isRecord(b.boundaries)) {
    throw new BodyError(`boundaries must be {${BOUNDARIES_FIELDS.map((f) => `"${f}"`).join(', ')}}`);
  }
  const x = b.boundaries;
  onlyKeys(x, [...BOUNDARIES_FIELDS]);
  // As the relay: refused characters are looked for in the topic as sent, before trimming.
  if (!topicOk(x.topic)) {
    throw new BodyError(`topic must be 1 to ${TOPIC_MAX} characters, with no control or invisible characters`);
  }
  for (const o of list(x.github_orgs, 'github_orgs', BOUNDARIES_MAX_ORGS, 'GitHub orgs')) {
    if (!orgOk(o)) throw new BodyError(`github_orgs: a GitHub org must be ${ORG_TEXT}`);
  }
  list(x.github_repos, 'github_repos', BOUNDARIES_MAX_REPOS, 'repositories').forEach(checkRepo);
  list(x.drive_folders, 'drive_folders', BOUNDARIES_MAX_FOLDERS, 'shared-drive folders').forEach(checkFolder);
  list(x.drives, 'drives', BOUNDARIES_MAX_DRIVES, 'shared drives').forEach(checkLegacyDrive);
  if (typeof x.member_folders !== 'boolean') throw new BodyError('member_folders must be true or false');
  // The one rule, whole: the checks above are it, field by field, so that a refusal names its field.
  if (!boundariesValid(x)) throw new BodyError('boundaries do not pass the rule');
  return { version: b.version, boundaries: normaliseBoundaries(x) };
}

// ---------------------------------------------------------------------------------------
// The sources reads (PICKERS-SPEC §3.5, §3.6), shaped before the page sees them: the relay's
// answer is data, and only the fields the page needs, each well-formed, are passed on.

/** GitHub's "install this app" page for an app's slug. */
const INSTALL_URL_RE = /^https:\/\/github\.com\/apps\/[a-z0-9][a-z0-9-]{0,99}\/installations\/new$/;
/** PICKERS-SPEC §4.2: the picker's settings, each public by design and restricted by Google. */
const PICKER_CLIENT_ID_RE = /^[A-Za-z0-9.-]{1,200}\.apps\.googleusercontent\.com$/;
const PICKER_API_KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/;
const PICKER_APP_ID_RE = /^[0-9]{6,20}$/;
/** PICKERS-SPEC §3.6: at most this many repositories per installation, and installations listed. */
export const GITHUB_REPOS_MAX = 1000;
const GITHUB_INSTALLATIONS_MAX = 300;

/** The Google Picker's settings when each is well-formed, else null (the page then offers paste only). */
function pickerConfig(v: unknown): GooglePickerConfig | null {
  if (!isRecord(v)) return null;
  const { client_id, api_key, app_id } = v;
  if (typeof client_id !== 'string' || !PICKER_CLIENT_ID_RE.test(client_id)) return null;
  if (typeof api_key !== 'string' || !PICKER_API_KEY_RE.test(api_key)) return null;
  if (typeof app_id !== 'string' || !PICKER_APP_ID_RE.test(app_id)) return null;
  return { client_id, api_key, app_id };
}

/**
 * GET /api/sources/config as the page gets it: `github.configured` true only when the relay says
 * so, `install_url` only a github.com app installation page, `google_picker` only well-formed
 * settings, and always null locally (`local`), where the picker cannot run. Nothing else the
 * relay might send is passed on.
 */
export function sourcesConfigView(raw: unknown, local: boolean, viewer?: string): SourcesConfig {
  const r = isRecord(raw) ? raw : {};
  const gh = isRecord(r.github) ? r.github : {};
  const configured = gh.configured === true;
  const install = configured && typeof gh.install_url === 'string' && INSTALL_URL_RE.test(gh.install_url) ? gh.install_url : null;
  const picker = local ? null : pickerConfig(r.google_picker);
  // The viewer's own IAP-verified email only (§5.2): Google's sign-in then offers that account.
  const hint = typeof viewer === 'string' && viewer.length <= 254 && ROSTER_EMAIL_RE.test(viewer) ? viewer : null;
  return { github: { configured, install_url: install }, google_picker: picker && hint ? { ...picker, login_hint: hint } : picker };
}

function githubRepo(v: unknown): GithubRepo | null {
  if (!isRecord(v) || !repoNameOk(v.name) || typeof v.id !== 'number' || !Number.isSafeInteger(v.id) || v.id < 1) return null;
  return { name: v.name, id: v.id, private: v.private === true, archived: v.archived === true };
}

function githubInstallation(v: unknown): GithubInstallation | null {
  if (!isRecord(v) || !orgOk(v.account)) return null;
  const suspended = v.state === 'suspended';
  const repos: GithubRepo[] = [];
  if (!suspended && Array.isArray(v.repos)) {
    for (const x of v.repos) {
      const repo = githubRepo(x);
      if (repo && repos.length < GITHUB_REPOS_MAX) repos.push(repo);
    }
  }
  repos.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  const truncated = v.truncated === true || (Array.isArray(v.repos) && v.repos.length > GITHUB_REPOS_MAX && !suspended);
  return {
    account: v.account,
    state: suspended ? 'suspended' : 'ok',
    repository_selection: v.repository_selection === 'selected' ? 'selected' : 'all',
    repos,
    truncated,
  };
}

/**
 * GET /api/sources/github as the page gets it: each installation on a well-formed org login,
 * its repositories well-formed (name by the repository rule, a positive whole id), sorted by
 * lower-case name, at most 1000; a suspended installation lists none. Malformed entries are
 * dropped, never repaired.
 */
export function githubListingView(raw: unknown): GithubListing {
  const r = isRecord(raw) ? raw : {};
  const installations: GithubInstallation[] = [];
  if (Array.isArray(r.installations)) {
    for (const x of r.installations.slice(0, GITHUB_INSTALLATIONS_MAX)) {
      const inst = githubInstallation(x);
      if (inst) installations.push(inst);
    }
  }
  const fetched = typeof r.fetched_at === 'string' && RFC3339.test(r.fetched_at) ? r.fetched_at : new Date().toISOString();
  return { installations, fetched_at: fetched };
}

// ---------------------------------------------------------------------------------------
// Accepting the boundaries and asking from the browser (M11-SPEC §2, §4), checked before
// anything reaches the relay.

/** PUT /api/acceptance: exactly {"version": <the boundaries version shown>}. */
export function checkAcceptance(raw: unknown): number {
  const b = object(raw);
  onlyKeys(b, ['version']);
  if (!versionOk(b.version)) throw new BodyError('version must be the whole number the boundaries were shown at');
  return b.version;
}

/** POST /api/ask: who the question is for, and the question (the relay's limits, M1-SPEC §3). */
export type AskBody = { to: '*' | string[]; question: string };
export const ASK_MAX_RECIPIENTS = 64;
export const QUESTION_MAX = 8000;
/**
 * The largest POST /api/ask body: 8000 characters outside the BMP, each sent as two \uXXXX
 * escapes, and 64 member ids of 32 characters, fit.
 */
export const ASK_BODY_LIMIT = 128 * 1024;

/**
 * POST /api/ask: exactly {"to": "*" | [member ids], "question"}. A question only: no kind, no
 * capability, no sender, no timeouts and no idempotency key (the server makes one). The
 * question is kept as typed, 1 to 8000 characters with one that is not white space.
 */
export function checkAsk(raw: unknown): AskBody {
  const b = object(raw);
  onlyKeys(b, ['to', 'question']);
  let to: AskBody['to'];
  if (b.to === '*') to = '*';
  else if (Array.isArray(b.to)) {
    if (b.to.length < 1 || b.to.length > ASK_MAX_RECIPIENTS) throw new BodyError(`to must name 1 to ${ASK_MAX_RECIPIENTS} teammates, or be "*"`);
    const seen = new Set<string>();
    for (const m of b.to) {
      if (typeof m !== 'string' || !MEMBER_RE.test(m)) throw new BodyError('to must hold member ids');
      if (seen.has(m)) throw new BodyError('to names a member twice');
      seen.add(m);
    }
    to = [...seen];
  } else throw new BodyError('to must be a list of teammates or "*"');
  const q = b.question;
  if (typeof q !== 'string' || q.length === 0 || codePointLength(q) > QUESTION_MAX) {
    throw new BodyError(`question must be 1 to ${QUESTION_MAX} characters`);
  }
  if (q.trim().length === 0) throw new BodyError('question must contain a character that is not white space');
  if (hasLoneSurrogate(q)) throw new BodyError('question contains a lone surrogate');
  return { to, question: q };
}

// ---------------------------------------------------------------------------------------
// The viewer's teams (M9-SPEC §2, §5), as the console hands them to its page.

export type TeamEntry = { team: string; name: string; member: string; role: RosterRole };
export type InvitationEntry = { team: string; name: string; member: string; role: RosterRole; invited_by_member: string | null };
export type TeamsView = {
  teams: TeamEntry[];
  invitations: InvitationEntry[];
  admin: boolean;
  teams_created: number | null;
  max_teams_created: number | null;
  suggested_member: string | null;
  /** False when the sign-in is bound to one team (a device credential): no creating, no invitations. */
  can_manage_teams: boolean;
};

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null);
const displayName = (v: unknown, team: string): string =>
  typeof v === 'string' && v.trim() !== '' && [...v].length <= 60 && !NAME_FORBIDDEN_RE.test(v) ? v : team;
const roleOf = (v: unknown): RosterRole => (v === 'owner' ? 'owner' : 'member');

/** The relay's /v1/me/teams, kept to well-formed entries (never trusted to be shaped). */
export function parseTeams(raw: unknown): TeamsView {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)).slice(0, 500) : [];
  const seen = new Set<string>();
  const teams: TeamEntry[] = [];
  for (const t of list(r.teams)) {
    if (typeof t.team !== 'string' || !TEAM_RE.test(t.team) || typeof t.member !== 'string' || !MEMBER_RE.test(t.member) || seen.has(t.team)) continue;
    seen.add(t.team);
    teams.push({ team: t.team, name: displayName(t.name, t.team), member: t.member, role: roleOf(t.role) });
  }
  const invitations: InvitationEntry[] = [];
  for (const t of list(r.invitations)) {
    if (typeof t.team !== 'string' || !TEAM_RE.test(t.team) || typeof t.member !== 'string' || !MEMBER_RE.test(t.member) || seen.has(t.team)) continue;
    seen.add(t.team);
    invitations.push({
      team: t.team,
      name: displayName(t.name, t.team),
      member: t.member,
      role: roleOf(t.role),
      invited_by_member: typeof t.invited_by_member === 'string' && MEMBER_RE.test(t.invited_by_member) ? t.invited_by_member : null,
    });
  }
  return {
    teams,
    invitations,
    admin: r.admin === true,
    teams_created: count(r.teams_created),
    max_teams_created: count(r.max_teams_created),
    suggested_member: typeof r.suggested_member === 'string' && MEMBER_RE.test(r.suggested_member) ? r.suggested_member : null,
    can_manage_teams: r.can_manage_teams !== false,
  };
}

// ---------------------------------------------------------------------------------------
// The viewer's address for the relay's per-address creation limit (M9-SPEC §7.6).

/**
 * The viewer's address from X-Forwarded-For: the entry Google's front end wrote, `hops` from the
 * right (1: Cloud Run's own front end; 2: the external Application Load Balancer, which appends
 * the client's address and then its own). With one hop and no header (not on Cloud Run), the
 * socket peer; behind the load balancer, a request without both of its entries did not come
 * through it, and gets '' (one shared "unknown" bucket).
 */
export function clientAddress(req: IncomingMessage, hops: ProxyHops = 1): string {
  const raw = req.headers['x-forwarded-for'];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  const entries = (joined ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (hops === 2) return entries.length >= 2 ? entries[entries.length - 2]! : '';
  return entries.at(-1) ?? req.socket.remoteAddress ?? '';
}

/** How many X-Forwarded-For entries Google appends in front of the console (M10-SPEC §5). */
export type ProxyHops = 1 | 2;

/** Whether a public host is Cloud Run's own address (a name under run.app, port aside). */
export function isRunAppHost(publicHost: string): boolean {
  return /^[^:]+\.run\.app(?::[0-9]{1,5})?$/.test(publicHost);
}

/**
 * CONSOLE_PROXY_HOPS: 1 (Cloud Run directly) or 2 (behind the load balancer). Unset means 1,
 * but only on a run.app host: any other public host is served through the load balancer
 * (M10-SPEC §5), so the count must be said there (§7.7); unset, every viewer would share the
 * balancer's address in the per-address limits.
 */
export function checkProxyHops(raw: string | undefined, publicHost: string): ProxyHops {
  const v = raw?.trim();
  if (!v) {
    if (isRunAppHost(publicHost)) return 1;
    throw new Error(
      `CONSOLE_PROXY_HOPS must be set when the public host (${publicHost}) is not a run.app address: 2 behind the load balancer`,
    );
  }
  if (v === '1') return 1;
  if (v === '2') return 2;
  throw new Error('CONSOLE_PROXY_HOPS must be 1 (Cloud Run) or 2 (behind the load balancer)');
}

function expandIpv6(a: string): string[] | null {
  let addr = a;
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (v4) {
    const o = v4[2]!.split('.').map(Number);
    addr = `${v4[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  return groups.length === 8 ? groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')) : null;
}

/** What one client counts as: an IPv4 address, an IPv6 /64, or "unknown" for anything else. */
export function addressKey(address: string): string {
  let a = address.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(a);
  if (bracketed) a = bracketed[1]!;
  a = a.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped) a = mapped[1]!;
  const kind = isIP(a);
  if (kind === 4) return a;
  if (kind === 6) {
    const groups = expandIpv6(a);
    return groups ? `${groups.slice(0, 4).join(':')}::/64` : 'unknown';
  }
  return 'unknown';
}

/** X-Relay-Client-IP-Hash: sha256(salt + the viewer's address key), 64 lower-case hex. */
export function clientIpHash(salt: string, req: IncomingMessage, hops: ProxyHops = 1): string {
  return createHash('sha256').update(salt + addressKey(clientAddress(req, hops)), 'utf8').digest('hex');
}

/** CONSOLE_IP_HASH_SALT: required in hosted mode, at least 32 characters (surrounding space dropped). */
export function checkIpHashSalt(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v || v.length < 32 || v.length > 4096) throw new Error('CONSOLE_IP_HASH_SALT must be set to at least 32 characters');
  return v;
}

/** GET /api/join: how to join the team, for the console's join panel. Nothing secret. */
export type JoinInfo = {
  relay_url: string;
  team: string;
  /** The team-relay repository (JOIN_REPO_URL), or null. */
  repo_url: string | null;
  /**
   * What `/plugin marketplace add` takes (M5-SPEC §1): JOIN_MARKETPLACE (GitHub owner/repo,
   * or an https git URL), else derived from JOIN_REPO_URL, else null (ask the team owner).
   */
  marketplace_source: string | null;
  marketplace: string;
  plugin: string;
  /** True when relay_url is the plugin's own default, so a bare /team-relay:login reaches it. */
  default_relay: boolean;
};

/** The marketplace at the repository root (.claude-plugin/marketplace.json) and its plugin. */
export const JOIN_MARKETPLACE = 'team-relay-dev';
export const JOIN_PLUGIN = 'team-relay';

const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** JOIN_MARKETPLACE: GitHub owner/repo or a plain https URL; unset or empty is null. */
export function checkJoinMarketplace(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (GITHUB_REPO_RE.test(v) && !v.split('/').some((x) => x === '.' || x === '..')) return v;
  try {
    return checkJoinRepoUrl(v);
  } catch {
    throw new Error('JOIN_MARKETPLACE must be a GitHub owner/repo or a plain https URL');
  }
}

/** A GitHub repository URL becomes owner/repo; any other URL stays as it is. */
export function marketplaceFromRepoUrl(repoUrl: string | null): string | null {
  if (!repoUrl) return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(repoUrl);
  return m ? `${m[1]}/${m[2]}` : repoUrl;
}

export function joinInfo(
  relayUrl: string,
  team: string,
  repoUrl: string | null,
  marketplaceSource: string | null = null,
  defaultRelay: string | null = defaultRelayUrl(),
): JoinInfo {
  let isDefault = false;
  try {
    isDefault = defaultRelay !== null && normaliseRelayUrl(relayUrl) === normaliseRelayUrl(defaultRelay);
  } catch {
    isDefault = false;
  }
  return {
    relay_url: relayUrl,
    team,
    repo_url: repoUrl,
    marketplace_source: marketplaceSource ?? marketplaceFromRepoUrl(repoUrl),
    marketplace: JOIN_MARKETPLACE,
    plugin: JOIN_PLUGIN,
    default_relay: isDefault,
  };
}

/** --demo: nothing real, and no repository. */
export const DEMO_JOIN: JoinInfo = joinInfo('https://relay.example.com', 'demo', null, 'example/team-relay', null);

/**
 * JOIN_REPO_URL: an https URL with a host and an optional plain path, nothing a shell would
 * read as more than one word (it is shown in a command to copy), no credentials, query or
 * fragment. Unset or empty is null.
 */
const REPO_URL_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?(\/[A-Za-z0-9._~%+-]+)*\/?$/i;

export function checkJoinRepoUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error('JOIN_REPO_URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('JOIN_REPO_URL must be an https URL');
  if (url.username || url.password) throw new Error('JOIN_REPO_URL must not carry credentials');
  if (url.search || url.hash || v.includes('?') || v.includes('#')) throw new Error('JOIN_REPO_URL must not carry a query or fragment');
  if (v.length > 512 || !REPO_URL_RE.test(v) || v.split('/').slice(3).some((seg) => seg === '.' || seg === '..')) {
    throw new Error('JOIN_REPO_URL must be a plain https URL: a host and a path of letters, digits and ._~%+-');
  }
  return v;
}

const PLACEHOLDER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Team relay console</title></head>
<body>
<h1>Team relay console</h1>
<p>The console has not been built yet: <code>dist/console/</code> is missing. Build it from
<code>console/</code> (it builds into <code>plugin/dist/console/</code>), then reload this page.</p>
<p>The API is running: <code>/api/me</code>, <code>/api/directory</code>, <code>/api/activity</code>,
<code>/api/requests/{id}</code>, <code>/api/roster</code>, <code>/api/inbox/summary</code>, <code>/api/boundaries</code>, <code>/api/acceptance</code>,
<code>/api/members-status</code>, <code>/api/my-requests</code> and <code>/api/join</code>, with the key from this page's
address in an <code>X-Console-Key</code> header.</p>
</body>
</html>
`;

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time comparison: both sides are hashed first, so lengths never leak or throw. */
export function keyMatches(given: string, key: string): boolean {
  return timingSafeEqual(digest(given), digest(key));
}

export type HostedOptions = {
  /** The service's public host (CONSOLE_PUBLIC_HOST); the Host header must equal it. */
  publicHost: string;
  /** Verifies the IAP assertion: the viewer, or null to refuse. */
  verify: (assertion: string | undefined) => Promise<IapIdentity | null>;
  /** CONSOLE_IP_HASH_SALT (M9-SPEC §7.6): salts the viewer's address before it is hashed. */
  ipHashSalt: string;
  /** CONSOLE_PROXY_HOPS (M10-SPEC §5): 2 behind the load balancer; 1 (the default) on Cloud Run alone. */
  proxyHops?: ProxyHops;
};

export type ConsoleServerOptions = {
  backend: ConsoleBackend;
  /** dist/console/ (the built UI). */
  staticDir: string;
  /** What GET /api/join answers (its `team` is the one asked about); without it, /api/join is 404. */
  join?: JoinInfo;
  /** Tests only: the clock the teams cache reads. */
  now?: () => number;
  /**
   * M8-SPEC §5, local mode only: how many answers wait for this member's approval in their
   * channel working session on this computer (GET /api/approvals/summary; 404 without it).
   */
  approvals?: () => { pending: number };
  log?: (line: string) => void;
} & (
  | { /** Local mode: the per-launch key. */ key: string; hosted?: undefined }
  | { key?: undefined; /** Hosted mode (M3-SPEC §3). */ hosted: HostedOptions }
);

export type ConsoleServer = {
  server: Server;
  /**
   * Bind `port` (0 picks a free one) on 127.0.0.1 locally, 0.0.0.0 hosted; resolves with the
   * bound port.
   */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
};

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/;

/** CONSOLE_PUBLIC_HOST: a lower-case host name (a port only if it is part of the public host). */
export function checkPublicHost(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) throw new Error('CONSOLE_PUBLIC_HOST must be set');
  if (v.length > 253 || !HOST_RE.test(v)) throw new Error('CONSOLE_PUBLIC_HOST must be a lower-case host name, without a scheme or path');
  return v;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}, head = false) {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(buf.length), ...extra });
  res.end(head ? undefined : buf);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });
}

/** The request body, at most `limit` bytes (else it rejects, and the rest is discarded). */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(new Error('too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? undefined : v;
}

export function createConsoleServer(opts: ConsoleServerOptions): ConsoleServer {
  const log = opts.log ?? (() => {});
  const hosted = opts.hosted ?? null;
  if (hosted) {
    checkPublicHost(hosted.publicHost);
    checkIpHashSalt(hosted.ipHashSalt);
  }
  else if (typeof opts.key !== 'string' || opts.key === '') throw new Error('a console key is required in local mode');
  let port = -1;
  let staticRoot: string | null = null;
  try {
    if (statSync(opts.staticDir).isDirectory()) staticRoot = realpathSync(opts.staticDir);
  } catch {
    staticRoot = null;
  }

  function hostAllowed(req: IncomingMessage): boolean {
    const host = headerValue(req, 'host')?.toLowerCase();
    if (hosted) return host === hosted.publicHost;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  // --- The viewer's teams (M9-SPEC §5), kept briefly per viewer -----------------------
  const now = opts.now ?? Date.now;
  const teamsCache = new Map<string, { at: number; view: Promise<TeamsView> }>();

  /** The viewer's teams: from the cache while fresh, else one /v1/me/teams (shared by concurrent calls). */
  function viewerTeams(ctx: ReadContext, fresh = false): Promise<TeamsView> {
    const key = ctx.viewer ?? '';
    const hit = teamsCache.get(key);
    if (hit && !fresh && now() - hit.at < TEAMS_TTL_MS) return hit.view;
    const view = opts.backend.myTeams(ctx.viewer !== undefined ? { viewer: ctx.viewer } : {}).then(parseTeams);
    if (teamsCache.size >= TEAMS_CACHE_MAX && !teamsCache.has(key)) teamsCache.delete(teamsCache.keys().next().value!);
    const entry = { at: now(), view };
    teamsCache.set(key, entry);
    view.catch(() => {
      if (teamsCache.get(key) === entry) teamsCache.delete(key);
    });
    return view;
  }

  function forgetTeams(viewer: string | undefined): void {
    teamsCache.delete(viewer ?? '');
  }

  /** The not-on-team answer: no data, only who is signed in (hosted) and the team asked about. */
  function notOnTeam(res: ServerResponse, viewer: string | undefined, team: string): void {
    sendJson(res, 403, { error: 'not_on_team', ...(hosted && viewer !== undefined ? { email: viewer } : {}), team });
  }

  /**
   * The team a team-scoped call is about: `team` (query) or X-Relay-Team, else RELAY_TEAM, and
   * only one the viewer is an active member of. Answers the refusal itself and resolves null.
   */
  async function resolveTeam(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ReadContext): Promise<string | null> {
    const asked = askedTeam(req, res, url);
    if (asked === null) return null;
    const team = asked === undefined ? opts.backend.defaultTeam : asked;
    const fixed = opts.backend.fixedTeam;
    if (fixed !== null) {
      if (team !== fixed) {
        notOnTeam(res, ctx.viewer, team);
        return null;
      }
      return team;
    }
    let view: TeamsView;
    try {
      view = await viewerTeams(ctx);
    } catch (err) {
      failure(res, err, ctx.viewer);
      return null;
    }
    if (!view.teams.some((t) => t.team === team)) {
      notOnTeam(res, ctx.viewer, team);
      return null;
    }
    return team;
  }

  /** The team a call names (query `team` or X-Relay-Team), undefined for none; null once refused. */
  function askedTeam(req: IncomingMessage, res: ServerResponse, url: URL): string | undefined | null {
    const fromQuery = url.searchParams.getAll('team');
    const header = req.headers['x-relay-team'];
    if (fromQuery.length > 1 || Array.isArray(header)) {
      sendJson(res, 400, { error: 'bad_request', detail: 'name the team once' });
      return null;
    }
    const q = fromQuery[0];
    if (q !== undefined && header !== undefined && q !== header) {
      sendJson(res, 400, { error: 'bad_request', detail: 'the team parameter and X-Relay-Team differ' });
      return null;
    }
    const asked = q ?? header;
    if (asked !== undefined && !TEAM_RE.test(asked)) {
      sendJson(res, 400, { error: 'bad_request', detail: 'team must be a team id' });
      return null;
    }
    return asked;
  }

  /** A relay (or demo) failure as the console answers it. `team`: a team read that failed. */
  function failure(res: ServerResponse, err: unknown, viewer: string | undefined, team?: string): void {
    // M6-SPEC §4, M9-SPEC §7.3: the relay's refusal of a viewer who is not (or no longer) on
    // the team (the any-team delegate's 404, a per-team delegate's 403 not_a_member) gets no
    // data, only this, and their teams are read again next time. A plain 401 is the console's
    // own sign-in to the relay failing: a misconfiguration, passed on as such.
    if (err instanceof RelayError && err.status === 403 && err.code === 'not_a_member') {
      forgetTeams(viewer);
      return notOnTeam(res, viewer, team ?? opts.backend.defaultTeam);
    }
    if (team !== undefined && (err instanceof NotFound || (err instanceof RelayError && err.status === 404))) {
      forgetTeams(viewer);
      return notOnTeam(res, viewer, team);
    }
    if (err instanceof NotFound || (err instanceof RelayError && err.status === 404)) return sendJson(res, 404, { error: 'not_found' });
    if (err instanceof BadRequest) return sendJson(res, 400, { error: 'bad_request', detail: err.detail });
    if (err instanceof RosterRefusal) {
      return sendJson(res, 502, { error: 'relay_refused', relay_status: err.status, relay_error: err.code, detail: err.detail });
    }
    if (err instanceof RelayError) {
      // The relay's Retry-After (a whole number of seconds) rides along, so the page waits as
      // long as the relay asked (PICKERS-SPEC §3.6: GitHub's rate limit).
      const wait = err.retryAfter;
      return sendJson(
        res,
        502,
        {
          error: 'relay_refused',
          relay_status: err.status,
          relay_error: err.code,
          ...(err.detail ? { detail: err.detail.slice(0, 300) } : {}),
          ...(wait !== undefined ? { retry_after: wait } : {}),
        },
        wait !== undefined ? { 'Retry-After': String(wait) } : {},
      );
    }
    if (err instanceof RelayNetworkError) return sendJson(res, 502, { error: 'relay_unreachable', detail: err.message });
    // Credentials (gcloud, the credential file) or anything else: the message never carries a token.
    const detail = err instanceof Error ? err.message.slice(0, 300) : 'unexpected error';
    return sendJson(res, 502, { error: 'relay_unavailable', detail });
  }

  /** The routes that change something, by path: which methods each allows. */
  function changeRoute(
    path: string,
  ): {
    methods: string[];
    kind: 'roster' | 'roster_one' | 'boundaries' | 'acceptance' | 'ask' | 'teams' | 'team' | 'invitation' | 'admin_team';
    id: string | null;
  } | null {
    if (path === '/api/roster') return { methods: ['POST'], kind: 'roster', id: null };
    if (path === '/api/boundaries') return { methods: ['PUT'], kind: 'boundaries', id: null };
    if (path === '/api/acceptance') return { methods: ['PUT'], kind: 'acceptance', id: null };
    if (path === '/api/ask') return { methods: ['POST'], kind: 'ask', id: null };
    let m = /^\/api\/roster\/([^/]+)$/.exec(path);
    if (m) return { methods: ['PATCH', 'DELETE'], kind: 'roster_one', id: m[1]! };
    if (path === '/api/teams') return { methods: ['POST'], kind: 'teams', id: null };
    m = /^\/api\/teams\/([^/]+)$/.exec(path);
    if (m) return { methods: ['DELETE'], kind: 'team', id: m[1]! };
    m = /^\/api\/invitations\/([^/]+)$/.exec(path);
    if (m) return { methods: ['POST'], kind: 'invitation', id: m[1]! };
    m = /^\/api\/admin\/teams\/([^/]+)$/.exec(path);
    if (m) return { methods: ['DELETE'], kind: 'admin_team', id: m[1]! };
    return null;
  }

  /**
   * The changes: the roster's (M6-SPEC §3), the boundaries (M10-SPEC §1) and the account's
   * (M9-SPEC §2, §4, §7). Each is JSON from the console's own page, with a body checked here first.
   */
  async function change(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: ReadContext,
    route: NonNullable<ReturnType<typeof changeRoute>>,
  ): Promise<void> {
    const method = req.method ?? '';
    const reads = route.kind === 'teams' || route.kind === 'roster' || route.kind === 'boundaries' || route.kind === 'acceptance' ? ['GET'] : [];
    if (!route.methods.includes(method)) {
      req.resume();
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: [...reads, ...route.methods].join(', ') });
    }
    // A change is made only from the console's own page.
    if (headerValue(req, 'sec-fetch-site') !== 'same-origin') {
      req.resume();
      return sendJson(res, 403, { error: 'forbidden', detail: 'Sec-Fetch-Site: same-origin is required' });
    }
    const type = headerValue(req, 'content-type') ?? '';
    if (!/^application\/json\s*(;.*)?$/i.test(type)) {
      req.resume();
      return sendJson(res, 415, { error: 'unsupported_media_type', detail: 'Content-Type must be application/json' });
    }
    // Only a roster, boundaries, acceptance or ask change names a team (the query's `team` or
    // X-Relay-Team); nothing else here.
    const teamScoped =
      route.kind === 'roster' || route.kind === 'roster_one' || route.kind === 'boundaries' || route.kind === 'acceptance' || route.kind === 'ask';
    const extra = [...url.searchParams.keys()].filter((k) => !(teamScoped && k === 'team'));
    if (extra.length > 0) {
      req.resume();
      return sendJson(res, 400, { error: 'bad_request', detail: 'no query parameters here' });
    }
    const id = route.id;
    const idOk = id === null || (route.kind === 'roster_one' ? MEMBER_RE.test(id) : TEAM_RE.test(id));
    if (!idOk) {
      req.resume();
      return sendJson(res, 404, { error: 'not_found' });
    }
    const limit = route.kind === 'boundaries' ? BOUNDARIES_BODY_LIMIT : route.kind === 'ask' ? ASK_BODY_LIMIT : ROSTER_BODY_LIMIT;
    let text: string;
    try {
      text = await readBody(req, limit);
    } catch {
      return sendJson(res, 413, { error: 'too_large', detail: `at most ${limit} bytes` });
    }
    let raw: unknown = undefined;
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return sendJson(res, 400, { error: 'bad_request', detail: 'the body is not JSON' });
      }
    }
    const viewer = ctx.viewer;
    const who: ReadContext = viewer !== undefined ? { viewer } : {};
    let call: () => Promise<unknown>;
    let status = 200;
    let what: string;
    let team: string | undefined;
    try {
      switch (route.kind) {
        case 'roster':
        case 'roster_one': {
          let body: unknown;
          if (method === 'POST') body = checkAddMember(raw);
          else if (method === 'PATCH') body = checkUpdateMember(raw);
          else if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0)) {
            throw new BodyError('a removal takes no body');
          }
          const resolved = await resolveTeam(req, res, url, who);
          if (resolved === null) return;
          team = resolved;
          const on: ReadContext = { ...who, team: resolved };
          if (method === 'POST') {
            status = 201;
            call = () => opts.backend.addMember(body as AddMemberBody, on);
          } else if (method === 'PATCH') call = () => opts.backend.updateMember(id!, body as UpdateMemberBody, on);
          else call = () => opts.backend.removeMember(id!, on);
          what = `roster ${method === 'POST' ? 'add' : method === 'PATCH' ? 'update' : 'remove'}${id ? ` ${id}` : ''} (team ${resolved})`;
          break;
        }
        case 'boundaries': {
          const body = checkSetBoundaries(raw);
          const resolved = await resolveTeam(req, res, url, who);
          if (resolved === null) return;
          team = resolved;
          call = () => opts.backend.setBoundaries(body, { ...who, team: resolved });
          // Who and which version; never the text.
          what = `boundaries set from version ${body.version} (team ${resolved})`;
          break;
        }
        case 'acceptance': {
          // M11-SPEC §2, §8: for the viewer only; the browser cannot name anyone else.
          const version = checkAcceptance(raw);
          const resolved = await resolveTeam(req, res, url, who);
          if (resolved === null) return;
          team = resolved;
          call = () => opts.backend.setAcceptance(version, { ...who, team: resolved });
          what = `boundaries accepted at version ${version} (team ${resolved})`;
          break;
        }
        case 'ask': {
          const body = checkAsk(raw);
          const resolved = await resolveTeam(req, res, url, who);
          if (resolved === null) return;
          team = resolved;
          status = 201;
          call = () => opts.backend.ask(body, { ...who, team: resolved });
          // Whom, by count; never the question.
          what = `question asked of ${body.to === '*' ? 'everyone' : `${body.to.length} ${body.to.length === 1 ? 'member' : 'members'}`} (team ${resolved})`;
          break;
        }
        case 'teams': {
          const body = checkCreateTeam(raw);
          // M9-SPEC §7.6: hosted, the relay counts the viewer's address, salted and hashed.
          const ipHash = hosted ? { clientIpHash: clientIpHash(hosted.ipHashSalt, req, hosted.proxyHops ?? 1) } : {};
          status = 201;
          call = () => opts.backend.createTeam(body, { ...who, ...ipHash });
          what = 'team create';
          break;
        }
        case 'invitation': {
          const accept = checkInvitationAnswer(raw);
          call = () => opts.backend.answerInvitation(id!, accept, who);
          what = `invitation ${accept ? 'accept' : 'decline'} (team ${id})`;
          break;
        }
        case 'team': {
          const confirm = checkConfirm(raw, id!);
          // Only a team the viewer is on (the relay also checks they own it).
          url.searchParams.set('team', id!);
          const resolved = await resolveTeam(req, res, url, who);
          if (resolved === null) return;
          call = () => opts.backend.deleteTeam(confirm, { ...who, team: resolved });
          what = `team delete (team ${id})`;
          break;
        }
        case 'admin_team': {
          const confirm = checkConfirm(raw, id!);
          call = () => opts.backend.adminDeleteTeam(id!, confirm, who);
          what = `admin team delete (team ${id})`;
          break;
        }
      }
    } catch (err) {
      return sendJson(res, 400, { error: 'bad_request', detail: err instanceof BodyError ? err.message : 'bad body' });
    }
    log(what);
    try {
      const out = await call();
      // What the viewer's teams are may have changed: read them again next time.
      if (!teamScoped) forgetTeams(viewer);
      return sendJson(res, status, out);
    } catch (err) {
      if (!teamScoped) forgetTeams(viewer);
      // A roster change's 404 is about the member (or the team: then not_on_team, from the
      // relay's refusal of a non-member); so is a boundaries change's, which names no member.
      // An account route's 404 is the relay's own.
      const aboutTeam = route.kind === 'roster' || route.kind === 'boundaries' || route.kind === 'acceptance' || route.kind === 'ask';
      if (team !== undefined && aboutTeam && err instanceof RelayError && err.status === 404) return failure(res, err, viewer, team);
      return failure(res, err, viewer);
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, viewer: string | undefined): Promise<void> {
    // A page on another site cannot read these (no CORS), and is refused outright when the
    // browser says the request is cross-site.
    const site = headerValue(req, 'sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      req.resume();
      return sendJson(res, 403, { error: 'forbidden', detail: 'cross-site request' });
    }
    if (!hosted) {
      const given = headerValue(req, 'x-console-key');
      if (given === undefined || given === '') {
        req.resume();
        return sendJson(res, 401, { error: 'unauthenticated', detail: 'X-Console-Key is required' });
      }
      if (!keyMatches(given, opts.key!)) {
        req.resume();
        return sendJson(res, 403, { error: 'forbidden', detail: 'wrong console key' });
      }
    }
    const ctx: ReadContext = viewer !== undefined ? { viewer } : {};
    const path = url.pathname;
    const route = changeRoute(path);
    if (req.method !== 'GET') {
      if (route) return change(req, res, url, ctx, route);
      req.resume();
      return sendJson(res, 405, { error: 'method_not_allowed', detail: 'the console is read-only' }, { Allow: 'GET' });
    }
    req.resume();

    const query = [...url.searchParams.keys()];
    if (path === '/api/approvals/summary') {
      // Answered here from the host's count on this computer (counts only), never proxied; the
      // hosted console cannot see a laptop's queue.
      if (query.length > 0) return sendJson(res, 400, { error: 'bad_request', detail: 'no query parameters here' });
      if (hosted || !opts.approvals) return sendJson(res, 404, { error: 'not_found' });
      return sendJson(res, 200, opts.approvals());
    }
    if (path === '/api/teams') {
      // M9-SPEC §2: the viewer's teams and invitations; read afresh (the page asks rarely).
      if (query.length > 0) return sendJson(res, 400, { error: 'bad_request', detail: 'no query parameters here' });
      let view: TeamsView;
      try {
        view = opts.backend.fixedTeam !== null ? parseTeams(await opts.backend.myTeams(ctx)) : await viewerTeams(ctx, true);
      } catch (err) {
        return failure(res, err, viewer);
      }
      return sendJson(res, 200, {
        ...view,
        default_team: opts.backend.defaultTeam,
        // Hosted, the viewer's own IAP-verified email, for the not-on-team page; theirs only.
        ...(hosted && viewer !== undefined ? { email: viewer } : {}),
      });
    }
    if (path === '/api/admin/teams') {
      // M9-SPEC §4: the relay decides who is an admin; the console only checks the query.
      const q: { after?: string; limit?: number } = {};
      for (const k of query) {
        if (k !== 'after' && k !== 'limit') return sendJson(res, 400, { error: 'bad_request', detail: `unknown parameter ${k.slice(0, 40)}` });
      }
      if (url.searchParams.getAll('after').length > 1 || url.searchParams.getAll('limit').length > 1) {
        return sendJson(res, 400, { error: 'bad_request', detail: 'repeated parameter' });
      }
      const after = url.searchParams.get('after');
      if (after !== null) {
        if (!TEAM_RE.test(after)) return sendJson(res, 400, { error: 'bad_request', detail: 'after must be a team id' });
        q.after = after;
      }
      const limit = url.searchParams.get('limit');
      if (limit !== null) {
        if (!/^[0-9]{1,4}$/.test(limit) || Number(limit) < 1 || Number(limit) > 1000) {
          return sendJson(res, 400, { error: 'bad_request', detail: 'limit must be 1..1000' });
        }
        q.limit = Number(limit);
      }
      try {
        return sendJson(res, 200, await opts.backend.adminTeams(q, ctx));
      } catch (err) {
        return failure(res, err, viewer);
      }
    }

    // Every other route is about one team: `team` (query) or X-Relay-Team.
    const own = query.filter((k) => k !== 'team');
    const known =
      path === '/api/join' ||
      path === '/api/me' ||
      path === '/api/directory' ||
      path === '/api/roster' ||
      path === '/api/inbox/summary' ||
      path === '/api/boundaries' ||
      path === '/api/acceptance' ||
      path === '/api/members-status' ||
      path === '/api/my-requests' ||
      path === '/api/sources/config' ||
      path === '/api/sources/github';
    const requestMatch = /^\/api\/requests\/([^/]+)$/.exec(path);
    if (!known && path !== '/api/activity' && !requestMatch) return sendJson(res, 404, { error: 'not_found' });
    if (requestMatch && (!REQUEST_ID_RE.test(requestMatch[1]!) || own.length > 0)) return sendJson(res, 404, { error: 'not_found' });
    if (known && own.length > 0) return sendJson(res, 400, { error: 'bad_request', detail: 'no query parameters here' });
    const q: { since?: string; limit?: number } = {};
    if (path === '/api/activity') {
      for (const k of own) {
        if (k !== 'since' && k !== 'limit') return sendJson(res, 400, { error: 'bad_request', detail: `unknown parameter ${k.slice(0, 40)}` });
      }
      if (url.searchParams.getAll('since').length > 1 || url.searchParams.getAll('limit').length > 1) {
        return sendJson(res, 400, { error: 'bad_request', detail: 'repeated parameter' });
      }
      const since = url.searchParams.get('since');
      if (since !== null) {
        if (!RFC3339.test(since)) return sendJson(res, 400, { error: 'bad_request', detail: 'since must be an RFC 3339 time' });
        q.since = since;
      }
      const limit = url.searchParams.get('limit');
      if (limit !== null) {
        if (!/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) {
          return sendJson(res, 400, { error: 'bad_request', detail: 'limit must be 1..200' });
        }
        q.limit = Number(limit);
      }
    }

    if (path === '/api/join' && !hosted) {
      // Answered here, from the server's own configuration, never proxied, and nothing secret:
      // locally the key holder is the member, so no relay call is needed for it.
      const asked = askedTeam(req, res, url);
      if (asked === null) return;
      if (!opts.join) return sendJson(res, 404, { error: 'not_found' });
      return sendJson(res, 200, { ...opts.join, team: asked ?? opts.join.team });
    }
    const team = await resolveTeam(req, res, url, ctx);
    if (team === null) return;
    const on: ReadContext = { ...ctx, team };

    if (path === '/api/join') {
      // Hosted, only to an active member of the team (resolveTeam above; M6-SPEC §7 item 6).
      if (!opts.join) return sendJson(res, 404, { error: 'not_found' });
      return sendJson(res, 200, { ...opts.join, team });
    }
    let call: () => Promise<unknown>;
    if (path === '/api/me') {
      // Hosted, the viewer's own IAP-verified email rides along on /api/me so the join panel can
      // fill in their commands; it is theirs, and nobody else's is ever added.
      call = async () => {
        const me = await opts.backend.me(on);
        return on.viewer !== undefined && me !== null && typeof me === 'object' && !Array.isArray(me)
          ? { ...(me as Record<string, unknown>), email: on.viewer }
          : me;
      };
    } else if (path === '/api/directory') call = () => opts.backend.directory(on);
    else if (path === '/api/inbox/summary') call = () => opts.backend.inboxSummary(on);
    else if (path === '/api/roster') call = () => opts.backend.roster(on);
    else if (path === '/api/boundaries') call = () => opts.backend.boundaries(on);
    else if (path === '/api/acceptance') call = () => opts.backend.acceptance(on);
    else if (path === '/api/members-status') call = () => opts.backend.membersStatus(on);
    else if (path === '/api/my-requests') call = () => opts.backend.myRequests(MY_REQUESTS_LIMIT, on);
    // PICKERS-SPEC §3.7: locally the Google Picker cannot run (its OAuth client's origin is the
    // hosted console's), so `google_picker` is null there whatever the relay holds.
    else if (path === '/api/sources/config') call = async () => sourcesConfigView(await opts.backend.sourcesConfig(on), !hosted, on.viewer);
    else if (path === '/api/sources/github') call = async () => githubListingView(await opts.backend.sourcesGithub(on));
    else if (path === '/api/activity') call = () => opts.backend.activity(q, on);
    else {
      const rid = requestMatch![1]!;
      call = () => opts.backend.request(rid, on);
    }

    try {
      return sendJson(res, 200, await call());
    } catch (err) {
      // A request's 404 is about the request; any other read's is about the team, except the
      // boundaries', M11's and the sources': membership was just checked, so a 404 there is a
      // relay without the route (before M10, M11, PICKERS-SPEC) or, for the GitHub listing, a
      // relay without the GitHub App (404 github_not_configured): shown as "not available",
      // never as "not on this team".
      const newer =
        path === '/api/boundaries' ||
        path === '/api/acceptance' ||
        path === '/api/members-status' ||
        path === '/api/my-requests' ||
        path === '/api/sources/config' ||
        path === '/api/sources/github';
      return failure(res, err, viewer, requestMatch || newer ? undefined : team);
    }
  }

  function staticFile(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) return send(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
    const html = (body: string | Buffer) => send(res, 200, body, MIME['.html']!, { 'Cache-Control': 'no-cache' }, head);
    if (url.pathname.toLowerCase() === `/${PICKER_FILE}`) return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
    const index = staticRoot ? join(staticRoot, 'index.html') : null;
    if (!staticRoot || !index || !existsSync(index)) return html(PLACEHOLDER);

    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, 'bad path\n', 'text/plain; charset=utf-8');
    }
    if (rel.includes('\0') || rel.includes('\\') || rel.split('/').some((seg) => seg === '..' || seg === '.')) {
      return send(res, 400, 'bad path\n', 'text/plain; charset=utf-8');
    }
    if (rel === '/' || rel === '') return html(readFileSync(index));
    const candidate = join(staticRoot, rel);
    let real: string | null = null;
    try {
      real = realpathSync(candidate);
    } catch {
      real = null;
    }
    // PICKERS-SPEC §3.7: the picker page loads only at /pick/drive, under its own headers.
    if (real && real.slice(staticRoot.length + 1).toLowerCase() === PICKER_FILE) return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
    if (real && real.startsWith(staticRoot + sep) && statSync(real).isFile()) {
      const type = MIME[extname(real).toLowerCase()] ?? 'application/octet-stream';
      // Hashed assets never change under their name; everything else is revalidated.
      // Hosted, everything is behind sign-in, so no shared cache may keep it.
      const cache = rel.startsWith('/assets/') ? `${hosted ? 'private' : 'public'}, max-age=31536000, immutable` : 'no-cache';
      return send(res, 200, readFileSync(real), type, { 'Cache-Control': cache }, head);
    }
    // A client-side route (no file extension) gets the app; a missing asset is a 404.
    if (!extname(rel)) return html(readFileSync(index));
    return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
  }

  /**
   * PICKERS-SPEC §3.7, §5.4: GET or HEAD /pick/drive, hosted only and with no query, answers
   * dist/console/pick-drive.html with exactly PICKER_HEADERS (never the console's own headers).
   */
  function pickerPage(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const notFound = () => send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
    if (!hosted || url.search !== '') return notFound();
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) return send(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
    if (!staticRoot) return notFound();
    let real: string;
    try {
      real = realpathSync(join(staticRoot, PICKER_FILE));
    } catch {
      return notFound();
    }
    if (real !== join(staticRoot, PICKER_FILE) || !statSync(real).isFile()) return notFound();
    const body = readFileSync(real);
    res.writeHead(200, { ...PICKER_HEADERS, 'Content-Type': MIME['.html']!, 'Content-Length': String(body.length) });
    res.end(head ? undefined : body);
  }

  /** Hosted: a bare 401, no detail (the reason is logged by the verifier). */
  const unauthorized = (res: ServerResponse) =>
    send(res, 401, 'unauthorized\n', 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });

  const server = createServer((req, res) => {
    // Only a change's body is ever read (change); any other is discarded.
    if (!hostAllowed(req)) {
      req.resume();
      send(res, 403, 'forbidden host\n', 'text/plain; charset=utf-8');
      return;
    }
    if (!hosted) {
      route(req, res, undefined);
      return;
    }
    const assertion = req.headers[IAP_HEADER];
    hosted.verify(Array.isArray(assertion) ? undefined : assertion).then(
      (identity) => {
        if (!identity) {
          req.resume();
          return unauthorized(res);
        }
        route(req, res, identity.email);
      },
      () => {
        log('iap: verification error');
        req.resume();
        if (!res.headersSent) unauthorized(res);
      },
    );
  });

  function route(req: IncomingMessage, res: ServerResponse, viewer: string | undefined): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      req.resume();
      send(res, 400, 'bad request\n', 'text/plain; charset=utf-8');
      return;
    }
    // Only origin-form paths that are already normal: nothing the URL parser had to resolve.
    const rawPath = (req.url ?? '').split('?')[0];
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (!isApi) req.resume();
    if (!rawPath?.startsWith('/') || rawPath !== url.pathname) {
      req.resume();
      send(res, 400, 'bad path\n', 'text/plain; charset=utf-8');
      return;
    }
    if (isApi) {
      api(req, res, url, viewer).catch((err: unknown) => {
        log(`api error: ${err instanceof Error ? err.message : 'unexpected'}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      });
      return;
    }
    try {
      if (url.pathname === PICKER_PATH) pickerPage(req, res, url);
      else staticFile(req, res, url);
    } catch {
      if (!res.headersSent) send(res, 500, 'internal error\n', 'text/plain; charset=utf-8');
    }
  }

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return {
    server,
    listen: (p: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, hosted ? '0.0.0.0' : '127.0.0.1', () => {
          server.off('error', reject);
          port = (server.address() as AddressInfo).port;
          resolve(port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
