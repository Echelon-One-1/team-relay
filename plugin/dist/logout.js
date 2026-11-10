import { createRequire as __teamRelayCreateRequire } from 'node:module'; const require = __teamRelayCreateRequire(import.meta.url);

// src/credentials.ts
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

// src/relay-client-core.ts
var TEAM_RE = /^[a-z][a-z0-9_-]{1,31}$/;
var MEMBER_RE = /^[a-z][a-z0-9_]{1,31}$/;
var LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function parseRelayUrl(raw) {
  if (!raw) throw new Error("RELAY_URL must be set");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RELAY_URL is not a valid URL");
  }
  if (url.username || url.password) throw new Error("RELAY_URL must not carry credentials");
  if (url.search || url.hash) throw new Error("RELAY_URL must not carry a query or fragment");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  throw new Error("RELAY_URL must be https (plain http is allowed only to localhost)");
}

// src/credentials.ts
var CREDENTIAL_RE = /^trc_[A-Za-z0-9_-]{43}$/;
var EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
var CREDENTIALS_DIR = "team-relay";
var CREDENTIALS_FILE = "credentials.json";
var MAX_FILE_BYTES = 16 * 1024;
var CredentialFileError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialFileError";
  }
};
function credentialsPath(env = process.env) {
  const explicit = env.RELAY_CREDENTIALS_FILE?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new CredentialFileError("RELAY_CREDENTIALS_FILE must be an absolute path");
    return explicit;
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), ".config");
  return join(base, CREDENTIALS_DIR, CREDENTIALS_FILE);
}
function uid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}
function checkOwnedPrivate(st, what, kind) {
  if (st.isSymbolicLink()) throw new CredentialFileError(`${what} is a symbolic link; refusing to use it`);
  if (kind === "file" ? !st.isFile() : !st.isDirectory()) throw new CredentialFileError(`${what} is not a ${kind}; refusing to use it`);
  const me = uid();
  if (me !== null && st.uid !== me) throw new CredentialFileError(`${what} is owned by another user; refusing to use it`);
  if ((st.mode & 63) !== 0) {
    const mode = (st.mode & 511).toString(8).padStart(3, "0");
    throw new CredentialFileError(
      `${what} has mode ${mode}, readable or writable by others; refusing to use it (run /team-relay:logout and /team-relay:login again, or chmod ${kind === "file" ? "600" : "700"} it)`
    );
  }
}
var RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
function normaliseRelayUrl(raw) {
  const url = parseRelayUrl(raw);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}
function parseStoredCredential(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CredentialFileError("the credential file is not a JSON object");
  const c = raw;
  const { relay_url, team, member, credential, expires_at, email } = c;
  if (typeof relay_url !== "string") throw new CredentialFileError("the credential file has no relay_url");
  let url;
  try {
    url = normaliseRelayUrl(relay_url);
  } catch {
    throw new CredentialFileError("the credential file has an invalid relay_url");
  }
  if (typeof team !== "string" || !TEAM_RE.test(team)) throw new CredentialFileError("the credential file has an invalid team");
  if (typeof member !== "string" || !MEMBER_RE.test(member)) throw new CredentialFileError("the credential file has an invalid member");
  if (typeof credential !== "string" || !CREDENTIAL_RE.test(credential)) throw new CredentialFileError("the credential file has an invalid credential");
  if (expires_at !== void 0 && expires_at !== null && (typeof expires_at !== "string" || !RFC3339.test(expires_at))) {
    throw new CredentialFileError("the credential file has an invalid expires_at");
  }
  if (email !== void 0 && email !== null && (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email))) {
    throw new CredentialFileError("the credential file has an invalid email");
  }
  return {
    relay_url: url,
    team,
    member,
    credential,
    expires_at: typeof expires_at === "string" ? expires_at : null,
    ...typeof email === "string" ? { email } : {}
  };
}
function readCredential(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw new CredentialFileError(`cannot read the credential file (${err.code ?? "error"})`);
  }
  checkOwnedPrivate(lstatSync(dirname(path)), "the credential directory", "directory");
  checkOwnedPrivate(st, "the credential file", "file");
  if (st.size > MAX_FILE_BYTES) throw new CredentialFileError("the credential file is too large");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new CredentialFileError(`cannot read the credential file (${err.code ?? "error"})`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CredentialFileError("the credential file is not valid JSON");
  }
  return parseStoredCredential(json);
}
function removeCredential(path) {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw new CredentialFileError(`cannot remove the credential file (${err.code ?? "error"})`);
  }
}

// src/relay-client.ts
var REQUEST_ID_RE = /^rq_[0-9a-f]{32}$/;
var RelayError = class extends Error {
  status;
  code;
  detail;
  constructor(status, code, detail) {
    super(`relay ${status} ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
};
var RelayNetworkError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "RelayNetworkError";
  }
};
function isRetryable(err) {
  if (err instanceof RelayNetworkError) return true;
  if (err instanceof RelayError) return err.status >= 500 || err.status === 429;
  return false;
}
var DEFAULT_BACKOFF = { baseMs: 1e3, maxMs: 3e4 };
function backoffDelay(attempt, b = DEFAULT_BACKOFF, random = Math.random) {
  const exp = Math.min(b.maxMs, b.baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(exp / 2 + random() * (exp / 2));
}
var TOKEN_REFRESH_MARGIN_MS = 5 * 6e4;
var GCLOUD_OUTPUT_LIMIT = 64 * 1024;
var METADATA_OUTPUT_LIMIT = 16 * 1024;
var SIGN_IN_AGAIN = "the relay refused your sign-in (signed out, expired, or no longer on the team): run /team-relay:login again";
function isCredentialProvider(p) {
  return p.kind === "credential";
}
var CLIENT_IP_HASH_RE = /^[0-9a-f]{64}$/;
var ON_BEHALF_OF_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}$/;
var defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
var RelayClient = class _RelayClient {
  team;
  opts;
  base;
  token;
  backoff;
  attempts;
  timeoutMs;
  sleep;
  random;
  userAgent;
  constructor(opts) {
    if (!TEAM_RE.test(opts.team)) throw new Error("RELAY_TEAM is not a valid team id");
    this.opts = opts;
    this.team = opts.team;
    const base = parseRelayUrl(opts.url);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    this.base = base;
    this.token = opts.token;
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.attempts = Math.max(1, opts.attempts ?? 4);
    this.timeoutMs = opts.timeoutMs ?? 3e4;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.userAgent = opts.userAgent ?? "team-relay-plugin/0.1.0";
  }
  /**
   * The same relay, sign-in and settings for another team (M9-SPEC §5: the hosted console's
   * delegate reads any team its viewer is on). The team id is checked like RELAY_TEAM.
   */
  withTeam(team) {
    if (team === this.team) return this;
    return new _RelayClient({ ...this.opts, team });
  }
  /**
   * True when this client signs in with a stored device credential or a static token, which
   * are bound to one team (no Google identity for the account routes).
   */
  get boundToTeam() {
    return isCredentialProvider(this.token) || this.token.kind === "static";
  }
  /** The relay's base URL (without a trailing slash). */
  get url() {
    return this.base.toString().replace(/\/$/, "");
  }
  teamPath(...parts) {
    return ["v1", "teams", this.team, ...parts].map(encodeURIComponent).join("/");
  }
  async once(method, path, body, timeoutMs, signal, onBehalfOf, clientIpHash) {
    const url = new URL(path, this.base);
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${await this.token()}`,
      "User-Agent": this.userAgent
    };
    if (onBehalfOf !== void 0) {
      if (!ON_BEHALF_OF_RE.test(onBehalfOf)) throw new Error("X-Relay-On-Behalf-Of must be a lower-case email address");
      headers["X-Relay-On-Behalf-Of"] = onBehalfOf;
    }
    if (clientIpHash !== void 0) {
      if (!CLIENT_IP_HASH_RE.test(clientIpHash)) throw new Error("X-Relay-Client-IP-Hash must be 64 lower-case hex characters");
      headers["X-Relay-Client-IP-Hash"] = clientIpHash;
    }
    let payload;
    if (body !== void 0) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, signal: combined, redirect: "error" });
    } catch (err) {
      if (signal?.aborted) throw err;
      const e = err;
      const why = e.cause?.code ?? e.cause?.message ?? (e.name === "TimeoutError" ? "timed out" : e.name);
      throw new RelayNetworkError(`relay unreachable (${String(why).slice(0, 120)})`);
    }
    let text;
    try {
      text = await res.text();
    } catch {
      throw new RelayNetworkError("relay response was cut off");
    }
    let json = void 0;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (res.ok) throw new RelayNetworkError(`relay answered ${res.status} with a body that is not JSON`);
      }
    }
    if (!res.ok) {
      const obj = json && typeof json === "object" ? json : {};
      const code = typeof obj.error === "string" ? obj.error : `http_${res.status}`;
      const detail = typeof obj.detail === "string" ? obj.detail.slice(0, 500) : "";
      throw new RelayError(res.status, code, detail);
    }
    return json;
  }
  /**
   * One call with retry and exponential backoff on network errors, 5xx and 429. A 401 with
   * a refreshable identity drops the cached token and retries once at once (M2-SPEC §2).
   */
  async call(method, path, body, opts = {}) {
    const attempts = Math.max(1, opts.attempts ?? this.attempts);
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let refreshed = false;
    for (let attempt = 0; ; ) {
      try {
        return await this.once(method, path, body, timeoutMs, opts.signal, opts.onBehalfOf, opts.clientIpHash);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (err instanceof RelayError && err.status === 401 && !refreshed && this.token.invalidate) {
          refreshed = true;
          this.token.invalidate();
          continue;
        }
        if (err instanceof RelayError && err.status === 401 && isCredentialProvider(this.token)) {
          throw new RelayError(401, err.code, SIGN_IN_AGAIN);
        }
        if (attempt + 1 >= attempts || !isRetryable(err)) throw err;
        await this.sleep(backoffDelay(attempt, this.backoff, this.random));
        attempt++;
      }
    }
  }
  me(opts) {
    return this.call("GET", this.teamPath("me"), void 0, opts);
  }
  publishManifest(member, manifest, opts) {
    if (!MEMBER_RE.test(member)) throw new Error("invalid member id");
    return this.call(
      "PUT",
      this.teamPath("members", member, "manifest"),
      manifest,
      opts
    );
  }
  directory(opts) {
    return this.call("GET", this.teamPath("directory"), void 0, opts);
  }
  /**
   * M7-SPEC §1: what waits in this member's inbox for their answering session. A peek: it moves
   * no cursor and writes no presence, so a session without the channel may read it too.
   */
  inboxSummary(opts) {
    return this.call("GET", this.teamPath("inbox", "summary"), void 0, opts);
  }
  /** Safe to retry: the idempotency key makes a repeated POST return the original request. */
  createRequest(body, opts) {
    return this.call("POST", this.teamPath("requests"), body, opts);
  }
  readStream(stream, q = {}, opts) {
    const params = new URLSearchParams();
    if (q.after !== void 0) params.set("after", String(q.after));
    if (q.wait !== void 0) params.set("wait", String(q.wait));
    if (q.limit !== void 0) params.set("limit", String(q.limit));
    const qs = params.toString();
    const timeoutMs = opts?.timeoutMs ?? (q.wait ?? 0) * 1e3 + 2e4;
    return this.call("GET", this.teamPath("streams", stream) + (qs ? `?${qs}` : ""), void 0, {
      ...opts,
      timeoutMs
    });
  }
  ackCursor(stream, ackedSeq, opts) {
    return this.call("POST", this.teamPath("streams", stream, "cursor"), { acked_seq: ackedSeq }, opts);
  }
  checkRequestId(id) {
    if (!REQUEST_ID_RE.test(id)) throw new Error("request_id must look like rq_ followed by 32 lowercase hex characters");
  }
  ackRequest(requestId, opts) {
    this.checkRequestId(requestId);
    return this.call("POST", this.teamPath("requests", requestId, "ack"), {}, opts);
  }
  reply(requestId, body, opts) {
    this.checkRequestId(requestId);
    return this.call(
      "POST",
      this.teamPath("requests", requestId, "reply"),
      body,
      opts
    );
  }
  /** Not idempotent (it appends), so it is sent once unless the caller asks otherwise. */
  progress(requestId, body, opts) {
    this.checkRequestId(requestId);
    return this.call("POST", this.teamPath("requests", requestId, "progress"), body, {
      attempts: 1,
      ...opts
    });
  }
  getRequest(requestId, opts) {
    this.checkRequestId(requestId);
    return this.call("GET", this.teamPath("requests", requestId), void 0, opts);
  }
  /** M2-SPEC §3.3: a tool's name, outcome and duration only. Appends, so it is sent once. */
  toolEvent(requestId, body, opts) {
    this.checkRequestId(requestId);
    return this.call("POST", this.teamPath("requests", requestId, "events"), body, {
      attempts: 1,
      ...opts
    });
  }
  /** M10-SPEC §1: the team's boundaries (any member). Never set: version 0, boundaries null. */
  boundaries(opts) {
    return this.call("GET", this.teamPath("boundaries"), void 0, opts);
  }
  /** M10-SPEC §1 (owners): replace the boundaries; a stale version is 409 version_conflict. Sent once. */
  setBoundaries(body, opts) {
    return this.call("PUT", this.teamPath("boundaries"), body, { attempts: 1, ...opts });
  }
  /**
   * M10-SPEC §2a: the Desktop OAuth client members use to connect Google Drive (read-only).
   * An installed-app client is not confidential (Google's rule); it is served to members so it
   * stays out of git. Not configured: 404 drive_not_configured.
   */
  driveClient(opts) {
    return this.call("GET", this.teamPath("drive-client"), void 0, opts);
  }
  /** M6-SPEC §2: the team's roster (owners see every email; members only their own). */
  roster(opts) {
    return this.call("GET", this.teamPath("roster"), void 0, opts);
  }
  /** M6-SPEC §2 (owners): add a member. Not idempotent, so sent once. */
  addMember(body, opts) {
    return this.call("POST", this.teamPath("roster"), body, { attempts: 1, ...opts });
  }
  /** M6-SPEC §2 (owners): add or remove one email, or change the role. Sent once. */
  updateMember(member, body, opts) {
    if (!MEMBER_RE.test(member)) throw new Error("invalid member id");
    return this.call("PATCH", this.teamPath("roster", member), body, { attempts: 1, ...opts });
  }
  /** M6-SPEC §2 (owners): remove a member (their device credentials are revoked). Sent once. */
  removeMember(member, opts) {
    if (!MEMBER_RE.test(member)) throw new Error("invalid member id");
    return this.call("DELETE", this.teamPath("roster", member), void 0, { attempts: 1, ...opts });
  }
  /** M5-SPEC §3: revoke the credential this client signs in with (logout). */
  revokeSelf(opts) {
    return this.call("DELETE", this.teamPath("credentials", "self"), void 0, { attempts: 1, ...opts });
  }
  // M9-SPEC §2, §4, §7: the account routes. They take a Google identity (a Google ID token,
  // or a delegate on behalf of an email); a device credential or a static token is refused
  // with 403 google_identity_required. The mutations are sent once.
  /** The teams (and invitations) of the signed-in Google account. */
  myTeams(opts) {
    return this.call("GET", "v1/me/teams", void 0, opts);
  }
  /** Create a team; the caller becomes its first owner. */
  createTeam(body, opts) {
    return this.call("POST", "v1/teams", body, { attempts: 1, ...opts });
  }
  /** Accept or decline an invitation to `team`. */
  answerInvitation(team, accept, opts) {
    if (!TEAM_RE.test(team)) throw new Error("invalid team id");
    return this.call("POST", ["v1", "me", "invitations", team].map(encodeURIComponent).join("/"), { accept }, {
      attempts: 1,
      ...opts
    });
  }
  /** An owner deletes this client's team (M9-SPEC §7.7); `confirm` is the team id typed again. */
  deleteTeam(confirm, opts) {
    return this.call("DELETE", ["v1", "teams", this.team].map(encodeURIComponent).join("/"), { confirm }, {
      attempts: 1,
      ...opts
    });
  }
  /** Relay admins (M9-SPEC §4): every team, a page at a time. */
  adminTeams(q = {}, opts) {
    const params = new URLSearchParams();
    if (q.after !== void 0) params.set("after", q.after);
    if (q.limit !== void 0) params.set("limit", String(q.limit));
    const qs = params.toString();
    return this.call("GET", "v1/admin/teams" + (qs ? `?${qs}` : ""), void 0, opts);
  }
  /** Relay admins (M9-SPEC §4): delete a team; `confirm` is its id typed again. */
  adminDeleteTeam(team, confirm, opts) {
    if (!TEAM_RE.test(team)) throw new Error("invalid team id");
    return this.call("DELETE", ["v1", "admin", "teams", team].map(encodeURIComponent).join("/"), { confirm }, {
      attempts: 1,
      ...opts
    });
  }
  /** M2-SPEC §3.5: the team's activity feed. */
  activity(q = {}, opts) {
    const params = new URLSearchParams();
    if (q.since !== void 0) params.set("since", q.since);
    if (q.limit !== void 0) params.set("limit", String(q.limit));
    const qs = params.toString();
    return this.call("GET", this.teamPath("activity") + (qs ? `?${qs}` : ""), void 0, opts);
  }
};

// src/tool-util.ts
function describeError(err) {
  if (err instanceof RelayError) {
    return `relay refused (${err.status} ${err.code})${err.detail ? `: ${err.detail}` : ""}`;
  }
  if (err instanceof RelayNetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return "unexpected error";
}

// src/logout.ts
async function logout(env = process.env, opts = {}) {
  let path;
  try {
    path = credentialsPath(env);
  } catch (err) {
    return { exitCode: 1, line: `team-relay: cannot sign out: ${describeError(err)}` };
  }
  const remove = () => {
    try {
      removeCredential(path);
      return null;
    } catch (err) {
      return describeError(err);
    }
  };
  let stored;
  try {
    stored = readCredential(path);
  } catch (err) {
    const why = err instanceof CredentialFileError ? err.message : describeError(err);
    const failed2 = remove();
    if (failed2) return { exitCode: 1, line: `team-relay: the stored sign-in cannot be used (${why}), and it could not be deleted: ${failed2}` };
    return {
      exitCode: 0,
      line: `team-relay: signed out on this computer. The stored sign-in could not be used (${why}), so it was deleted here without asking the relay; it expires on its own.`
    };
  }
  if (!stored) return { exitCode: 0, line: "team-relay: not signed in on this computer; nothing to do." };
  const who = `${stored.member}${stored.email ? ` (${stored.email})` : ""}`;
  let revoked;
  try {
    const credential = stored.credential;
    const client = new RelayClient({ url: stored.relay_url, team: stored.team, token: () => credential, attempts: 1, timeoutMs: opts.timeoutMs ?? 1e4 });
    await client.revokeSelf();
    revoked = "The relay revoked this computer's credential";
  } catch (err) {
    if (err instanceof RelayError && (err.status === 401 || err.status === 404)) revoked = "The relay no longer accepted this credential";
    else revoked = `The relay did not revoke it (${describeError(err)}), so the credential expires on its own`;
  }
  const failed = remove();
  if (failed) return { exitCode: 1, line: `team-relay: ${revoked}, but the credential file could not be deleted: ${failed}` };
  return { exitCode: 0, line: `team-relay: signed out of team ${stored.team} as ${who}. ${revoked}, and it was deleted here. Run /team-relay:login to sign in again.` };
}
if (process.argv[1] && /logout\.[jt]s$/.test(process.argv[1])) {
  if (process.argv.length > 2) {
    process.stderr.write("usage: logout.js (no arguments)\n");
    process.exitCode = 2;
  } else {
    void logout().then(
      ({ exitCode, line }) => {
        process.stdout.write(`${line}
`);
        process.exitCode = exitCode;
      },
      (err) => {
        process.stdout.write(`team-relay: cannot sign out: ${describeError(err)}
`);
        process.exitCode = 1;
      }
    );
  }
}
export {
  logout
};
