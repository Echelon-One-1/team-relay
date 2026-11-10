import { createRequire as __teamRelayCreateRequire } from 'node:module'; const require = __teamRelayCreateRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/relay-client-core.ts
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
var TEAM_RE, MEMBER_RE, LOOPBACK;
var init_relay_client_core = __esm({
  "src/relay-client-core.ts"() {
    "use strict";
    TEAM_RE = /^[a-z][a-z0-9_-]{1,31}$/;
    MEMBER_RE = /^[a-z][a-z0-9_]{1,31}$/;
    LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  }
});

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
function credentialFileExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
var CREDENTIAL_RE, EMAIL_RE, CREDENTIALS_DIR, CREDENTIALS_FILE, MAX_FILE_BYTES, CredentialFileError, RFC3339;
var init_credentials = __esm({
  "src/credentials.ts"() {
    "use strict";
    init_relay_client_core();
    CREDENTIAL_RE = /^trc_[A-Za-z0-9_-]{43}$/;
    EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
    CREDENTIALS_DIR = "team-relay";
    CREDENTIALS_FILE = "credentials.json";
    MAX_FILE_BYTES = 16 * 1024;
    CredentialFileError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "CredentialFileError";
      }
    };
    RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
  }
});

// src/relay-default.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { fileURLToPath } from "node:url";
function defaultRelayFile() {
  return fileURLToPath(new URL("../relay.default.json", import.meta.url));
}
function defaultRelayUrl(file = defaultRelayFile()) {
  try {
    const raw = JSON.parse(readFileSync2(file, "utf8"));
    if (typeof raw.relay_url !== "string") return null;
    parseRelayUrl(raw.relay_url);
    return raw.relay_url;
  } catch {
    return null;
  }
}
var init_relay_default = __esm({
  "src/relay-default.ts"() {
    "use strict";
    init_relay_client_core();
  }
});

// src/relay-client.ts
var relay_client_exports = {};
__export(relay_client_exports, {
  CLIENT_IP_HASH_RE: () => CLIENT_IP_HASH_RE,
  DEFAULT_BACKOFF: () => DEFAULT_BACKOFF,
  GCLOUD_AUDIENCE: () => GCLOUD_AUDIENCE,
  MEMBER_RE: () => MEMBER_RE,
  MESSAGE_ID_RE: () => MESSAGE_ID_RE,
  METADATA_BASE: () => METADATA_BASE,
  NotConnected: () => NotConnected,
  REQUEST_ID_RE: () => REQUEST_ID_RE,
  RelayClient: () => RelayClient,
  RelayError: () => RelayError,
  RelayNetworkError: () => RelayNetworkError,
  SIGN_IN_AGAIN: () => SIGN_IN_AGAIN,
  TEAM_RE: () => TEAM_RE,
  TOKEN_REFRESH_MARGIN_MS: () => TOKEN_REFRESH_MARGIN_MS,
  authModeFromEnv: () => authModeFromEnv,
  backoffDelay: () => backoffDelay,
  checkGcloudAccount: () => checkGcloudAccount,
  configValue: () => configValue,
  connectionFromEnv: () => connectionFromEnv,
  credentialTokenProvider: () => credentialTokenProvider,
  credentialsFromEnv: () => credentialsFromEnv,
  gcloudTokenProvider: () => gcloudTokenProvider,
  isCredentialProvider: () => isCredentialProvider,
  isRetryable: () => isRetryable,
  jwtExpiryMs: () => jwtExpiryMs,
  metadataTokenProvider: () => metadataTokenProvider,
  parseRelayUrl: () => parseRelayUrl,
  relayClientFromEnv: () => relayClientFromEnv,
  staticTokenProvider: () => staticTokenProvider,
  tokenProviderFromEnv: () => tokenProviderFromEnv
});
import { execFile as execFile3 } from "node:child_process";
import { readFileSync as readFileSync3 } from "node:fs";
function isRetryable(err) {
  if (err instanceof RelayNetworkError) return true;
  if (err instanceof RelayError) return err.status >= 500 || err.status === 429;
  return false;
}
function backoffDelay(attempt, b = DEFAULT_BACKOFF, random = Math.random) {
  const exp = Math.min(b.maxMs, b.baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(exp / 2 + random() * (exp / 2));
}
function configValue(v) {
  if (v === void 0) return void 0;
  const t = v.trim();
  if (!t || /^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(t)) return void 0;
  return t;
}
function staticTokenProvider(read) {
  return Object.assign(typeof read === "string" ? () => read : read, { kind: "static" });
}
function tokenProviderFromEnv(env) {
  const file = configValue(env.RELAY_TOKEN_FILE);
  if (file) {
    return staticTokenProvider(() => {
      let raw;
      try {
        raw = readFileSync3(file, "utf8");
      } catch (err) {
        throw new Error(`cannot read RELAY_TOKEN_FILE (${err.code ?? "error"})`);
      }
      const token2 = raw.replace(/[\r\n]+$/, "");
      if (!token2) throw new Error("RELAY_TOKEN_FILE is empty");
      return token2;
    });
  }
  const token = configValue(env.RELAY_TOKEN);
  if (!token) throw new Error('RELAY_AUTH is "token", so RELAY_TOKEN or RELAY_TOKEN_FILE must be set');
  return staticTokenProvider(token);
}
function checkGcloudAccount(account) {
  if (account.length > 254 || !ACCOUNT_RE.test(account)) {
    throw new Error("RELAY_GCLOUD_ACCOUNT must be an account email address");
  }
  return account;
}
function jwtExpiryMs(token) {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1e3 : null;
  } catch {
    return null;
  }
}
function scrub(text) {
  return text.replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/ya29\.[A-Za-z0-9_.-]+/g, "[redacted]").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200);
}
function gcloudTokenProvider(opts = {}) {
  const now = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 3e4;
  const args = ["auth", "print-identity-token"];
  if (opts.account !== void 0) args.push(`--account=${checkGcloudAccount(opts.account)}`);
  let cached = null;
  let inflight = null;
  const mint = () => new Promise((resolve, reject) => {
    execFile3(
      "gcloud",
      args,
      { env, timeout: timeoutMs, maxBuffer: GCLOUD_OUTPUT_LIMIT, shell: false, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const e = err;
          if (e.code === "ENOENT") return reject(new Error("gcloud was not found on PATH (RELAY_AUTH=google needs the Google Cloud CLI)"));
          if (e.killed) return reject(new Error("gcloud auth print-identity-token timed out"));
          const why = scrub(String(stderr ?? "").split("\n").find((l) => l.trim()) ?? "");
          return reject(new Error(`gcloud auth print-identity-token failed${why ? `: ${why}` : ""}`));
        }
        const token = String(stdout).trim();
        if (!JWT_RE.test(token)) return reject(new Error("gcloud auth print-identity-token did not print an ID token"));
        resolve(token);
      }
    );
  });
  const provider = Object.assign(async () => {
    if (cached && now() < cached.until) return cached.token;
    inflight ??= mint().then((token) => {
      const exp = jwtExpiryMs(token);
      cached = exp !== null && exp - TOKEN_REFRESH_MARGIN_MS > now() ? { token, until: exp - TOKEN_REFRESH_MARGIN_MS } : null;
      return token;
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  }, {
    invalidate: () => {
      cached = null;
    }
  });
  return provider;
}
function metadataTokenProvider(opts) {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 5e3;
  if (!opts.audience) throw new Error("RELAY_AUTH=metadata needs RELAY_URL as the token audience");
  const url = new URL(METADATA_IDENTITY_PATH, opts.base ?? METADATA_BASE);
  url.searchParams.set("audience", opts.audience);
  url.searchParams.set("format", "full");
  const target = url.toString();
  let cached = null;
  let inflight = null;
  const mint = async () => {
    let res;
    try {
      res = await doFetch(target, {
        method: "GET",
        headers: { "Metadata-Flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new Error("the metadata server did not answer (RELAY_AUTH=metadata runs only on Google Cloud)");
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`the metadata server refused an identity token (${res.status})`);
    const token = text.trim();
    if (token.length > METADATA_OUTPUT_LIMIT || !JWT_RE.test(token)) throw new Error("the metadata server did not return an ID token");
    return token;
  };
  return Object.assign(async () => {
    if (cached && now() < cached.until) return cached.token;
    inflight ??= mint().then((token) => {
      const exp = jwtExpiryMs(token);
      cached = exp !== null && exp - TOKEN_REFRESH_MARGIN_MS > now() ? { token, until: exp - TOKEN_REFRESH_MARGIN_MS } : null;
      return token;
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  }, {
    invalidate: () => {
      cached = null;
    }
  });
}
function authModeFromEnv(env) {
  const explicit = configValue(env.RELAY_AUTH);
  if (explicit === void 0) return credentialFileExists(credentialsPath(env)) ? "credential" : "google";
  if (explicit !== "credential" && explicit !== "google" && explicit !== "token" && explicit !== "metadata") {
    throw new Error('RELAY_AUTH must be "credential", "google" or "token" (or "metadata" on Google Cloud)');
  }
  return explicit;
}
function credentialTokenProvider(path, bound) {
  const relay = normaliseRelayUrl(bound.relay_url);
  return Object.assign(
    () => {
      const stored = readCredential(path);
      if (!stored) throw new NotConnected();
      if (stored.relay_url !== relay || stored.team !== bound.team) {
        throw new NotConnected("you signed in to another relay or team since this started: restart it");
      }
      return stored.credential;
    },
    { kind: "credential", path }
  );
}
function isCredentialProvider(p) {
  return p.kind === "credential";
}
function connectionFromEnv(env, gcloud = {}) {
  const explicitMode = configValue(env.RELAY_AUTH) !== void 0;
  const mode = authModeFromEnv(env);
  if (mode === "credential") {
    const path = credentialsPath(env);
    const stored = readCredential(path);
    if (!stored) throw new NotConnected();
    const envUrl = configValue(env.RELAY_URL);
    if (envUrl !== void 0) {
      let same = false;
      try {
        same = normaliseRelayUrl(envUrl) === stored.relay_url;
      } catch {
        same = false;
      }
      if (!same) {
        throw new Error("RELAY_URL is not the relay you signed in to: unset it, or run /team-relay:logout and then /team-relay:login to sign in to it");
      }
    }
    const envTeam = configValue(env.RELAY_TEAM);
    if (envTeam !== void 0 && envTeam !== stored.team) {
      throw new Error("RELAY_TEAM is not the team you signed in to: unset it, or run /team-relay:login again");
    }
    return { mode, url: stored.relay_url, team: stored.team, member: stored.member, token: credentialTokenProvider(path, stored) };
  }
  const team = configValue(env.RELAY_TEAM);
  if (!team) {
    if (!explicitMode) throw new NotConnected();
    throw new Error("RELAY_TEAM must be set");
  }
  const url = configValue(env.RELAY_URL) ?? (mode === "google" ? defaultRelayUrl() : null) ?? "";
  let token;
  if (mode === "token") token = tokenProviderFromEnv(env);
  else if (mode === "metadata") token = metadataTokenProvider({ audience: configValue(env.RELAY_URL) ?? "" });
  else {
    const account = configValue(env.RELAY_GCLOUD_ACCOUNT);
    token = gcloudTokenProvider({ env, ...gcloud, ...account !== void 0 ? { account } : {} });
  }
  return { mode, url, team, token };
}
function credentialsFromEnv(env, gcloud = {}) {
  const mode = authModeFromEnv(env);
  if (mode === "credential") return connectionFromEnv(env, gcloud).token;
  if (mode === "token") return tokenProviderFromEnv(env);
  if (mode === "metadata") return metadataTokenProvider({ audience: configValue(env.RELAY_URL) ?? "" });
  const account = configValue(env.RELAY_GCLOUD_ACCOUNT);
  return gcloudTokenProvider({ env, ...gcloud, ...account !== void 0 ? { account } : {} });
}
function relayClientFromEnv(env, extra = {}) {
  const c = connectionFromEnv(env);
  return new RelayClient({ url: c.url, team: c.team, token: c.token, ...extra });
}
var REQUEST_ID_RE, MESSAGE_ID_RE, RelayError, RelayNetworkError, DEFAULT_BACKOFF, GCLOUD_AUDIENCE, TOKEN_REFRESH_MARGIN_MS, JWT_RE, ACCOUNT_RE, GCLOUD_OUTPUT_LIMIT, METADATA_BASE, METADATA_IDENTITY_PATH, METADATA_OUTPUT_LIMIT, NotConnected, SIGN_IN_AGAIN, CLIENT_IP_HASH_RE, ON_BEHALF_OF_RE, defaultSleep, RelayClient;
var init_relay_client = __esm({
  "src/relay-client.ts"() {
    "use strict";
    init_credentials();
    init_relay_client_core();
    init_relay_default();
    REQUEST_ID_RE = /^rq_[0-9a-f]{32}$/;
    MESSAGE_ID_RE = /^msg_[0-9a-f]{32}$/;
    RelayError = class extends Error {
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
    RelayNetworkError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "RelayNetworkError";
      }
    };
    DEFAULT_BACKOFF = { baseMs: 1e3, maxMs: 3e4 };
    GCLOUD_AUDIENCE = "32555940559.apps.googleusercontent.com";
    TOKEN_REFRESH_MARGIN_MS = 5 * 6e4;
    JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    ACCOUNT_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
    GCLOUD_OUTPUT_LIMIT = 64 * 1024;
    METADATA_BASE = "http://metadata.google.internal";
    METADATA_IDENTITY_PATH = "/computeMetadata/v1/instance/service-accounts/default/identity";
    METADATA_OUTPUT_LIMIT = 16 * 1024;
    NotConnected = class extends Error {
      constructor(message = "Not connected: run /team-relay:login") {
        super(message);
        this.name = "NotConnected";
      }
    };
    SIGN_IN_AGAIN = "the relay refused your sign-in (signed out, expired, or no longer on the team): run /team-relay:login again";
    CLIENT_IP_HASH_RE = /^[0-9a-f]{64}$/;
    ON_BEHALF_OF_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}$/;
    defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
    RelayClient = class _RelayClient {
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
      /** M11-SPEC §2: the boundaries version this member accepted (0: never). */
      acceptance(opts) {
        return this.call("GET", this.teamPath("me", "acceptance"), void 0, opts);
      }
      /** M11-SPEC §2: accept the current boundaries version (only for oneself). Sent once. */
      setAcceptance(version, opts) {
        return this.call("PUT", this.teamPath("me", "acceptance"), { version }, { attempts: 1, ...opts });
      }
      /** M11-SPEC §3: the background answerer's status (the member itself only). Sent once. */
      putStatus(body, opts) {
        return this.call("PUT", this.teamPath("me", "status"), body, { attempts: 1, ...opts });
      }
      /** M11-SPEC §3: every member's setup progress and whether they are answering now. */
      membersStatus(opts) {
        return this.call("GET", this.teamPath("members", "status"), void 0, opts);
      }
      /** M11-SPEC §4: this member's recent requests, newest first. */
      myRequests(limit = 20, opts) {
        return this.call("GET", this.teamPath("me", "requests") + `?limit=${limit}`, void 0, opts);
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
  }
});

// src/drive-cli.ts
init_credentials();

// src/drive-login.ts
import { createHash as createHash2, randomBytes as randomBytes2, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { createServer } from "node:http";

// src/console-open.ts
import { execFile } from "node:child_process";
import { chmodSync as chmodSync2, mkdtempSync, rmSync as rmSync2, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute as isAbsolute2, join as join2 } from "node:path";
var REDIRECT_TTL_MS = 1e4;
var REDIRECT_FILE = "console.html";
var defaultRun = (command, args, done) => {
  execFile(command, args, { shell: false, timeout: 1e4 }, (err) => done(err));
};
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
function redirectHtml(url, title = "Team console") {
  const u = escapeHtml(url);
  const t = escapeHtml(title);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0;url=${u}">`,
    `<title>${t}</title></head>`,
    `<body><p><a href="${u}">${t}</a></p></body></html>`,
    ""
  ].join("\n");
}
function openerFor(platform, env = process.env) {
  const custom = env.TEAM_RELAY_OPEN_COMMAND?.trim();
  if (custom) return isAbsolute2(custom) ? custom : null;
  if (platform === "darwin") return "open";
  if (platform === "linux") return "xdg-open";
  return null;
}
function openInBrowser(url, opts) {
  const what = opts.what ?? "the URL above";
  const opener = opts.opener ?? openerFor(opts.platform ?? process.platform);
  if (!opener) {
    opts.log(`no browser opener on this platform; open ${what} yourself`);
    return null;
  }
  let dir;
  try {
    dir = mkdtempSync(join2(opts.tmpRoot ?? tmpdir(), "team-relay-console-"));
    chmodSync2(dir, 448);
  } catch {
    opts.log(`could not prepare the browser hand-off; open ${what} yourself`);
    return null;
  }
  const cleanup = () => rmSync2(dir, { recursive: true, force: true });
  const file = join2(dir, REDIRECT_FILE);
  try {
    writeFileSync(file, redirectHtml(url, opts.title), { mode: 384, flag: "wx" });
  } catch {
    cleanup();
    opts.log(`could not prepare the browser hand-off; open ${what} yourself`);
    return null;
  }
  process.once("exit", cleanup);
  setTimeout(() => {
    process.removeListener("exit", cleanup);
    cleanup();
  }, opts.deleteAfterMs ?? REDIRECT_TTL_MS).unref();
  (opts.run ?? defaultRun)(opener, [file], (err) => {
    if (err) opts.log(`could not open a browser (${opener}); open ${what} yourself`);
  });
  return file;
}

// src/drive-login.ts
init_credentials();

// src/google-drive.ts
import { execFile as execFile2 } from "node:child_process";
init_credentials();
var DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
var KEYCHAIN_SERVICE = "team-relay-drive";
var GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
var GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
var GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
var GOOGLE_HOSTS = /* @__PURE__ */ new Set(["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com", "sheets.googleapis.com"]);
var REFRESH_TOKEN_RE = /^[A-Za-z0-9._~+/-]{10,2048}$/;
var DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
var CLIENT_ID_RE = /^[A-Za-z0-9.-]{1,200}\.apps\.googleusercontent\.com$/;
var CLIENT_SECRET_RE = /^[A-Za-z0-9_-]{1,200}$/;
var MAX_LINK_FILE_BYTES = 4 * 1024;
var MAX_TEXT_BYTES = 200 * 1024;
var MAX_JSON_BYTES = 1024 * 1024;
var MAX_SHEET_JSON_BYTES = 8 * 1024 * 1024;
var GOOGLE_TIMEOUT_MS = 2e4;
var USER_AGENT = "team-relay-plugin/0.1.0";
var KeychainError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "KeychainError";
  }
};
var SECURITY = "/usr/bin/security";
var ITEM_NOT_FOUND = 44;
var execSecurity = (args, stdin) => new Promise((resolve) => {
  const child = execFile2(SECURITY, args, { shell: false, timeout: 1e4, maxBuffer: 64 * 1024, encoding: "utf8" }, (err, stdout) => {
    const code = err ? typeof err.code === "number" ? err.code : 1 : 0;
    resolve({ code, stdout: String(stdout ?? "") });
  });
  if (stdin !== void 0) child.stdin?.end(stdin);
  else child.stdin?.end();
});
function macKeychain(exec = execSecurity) {
  const checkAccount = (account) => {
    if (typeof account !== "string" || account.length > 254 || !EMAIL_RE.test(account)) throw new KeychainError("invalid account");
  };
  return {
    async account() {
      const r = await exec(["find-generic-password", "-s", KEYCHAIN_SERVICE]);
      if (r.code === ITEM_NOT_FOUND) return null;
      if (r.code !== 0) throw new KeychainError(`the Keychain could not be read (security exit ${r.code})`);
      const m = /"acct"<blob>="([^"\n]*)"/.exec(r.stdout);
      const acct = m?.[1];
      return acct && EMAIL_RE.test(acct) ? acct : null;
    },
    async read(account) {
      checkAccount(account);
      const r = await exec(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]);
      if (r.code === ITEM_NOT_FOUND) return null;
      if (r.code !== 0) throw new KeychainError(`the Keychain could not be read (security exit ${r.code})`);
      const token = r.stdout.replace(/\n$/, "");
      return REFRESH_TOKEN_RE.test(token) ? token : null;
    },
    async write(account, token) {
      checkAccount(account);
      if (!REFRESH_TOKEN_RE.test(token)) throw new KeychainError("the token has an unexpected form; nothing was stored");
      const line = `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account}" -l "${KEYCHAIN_SERVICE}" -w "${token}"
`;
      const r = await exec(["-i"], line);
      if (r.code !== 0) throw new KeychainError(`the Keychain could not be written (security exit ${r.code})`);
      const back = await this.read(account);
      if (back !== token) throw new KeychainError("the Keychain did not keep the token");
    },
    async removeAll() {
      let n = 0;
      for (let i = 0; i < 20; i++) {
        const r = await exec(["delete-generic-password", "-s", KEYCHAIN_SERVICE]);
        if (r.code === ITEM_NOT_FOUND) return n;
        if (r.code !== 0) throw new KeychainError(`the Keychain item could not be deleted (security exit ${r.code})`);
        n++;
      }
      throw new KeychainError("too many Keychain items to delete");
    }
  };
}
function defaultKeychain(platform = process.platform) {
  return platform === "darwin" ? macKeychain() : null;
}
function assertGoogleUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !GOOGLE_HOSTS.has(u.hostname) || u.port !== "" || u.username || u.password) {
    throw new Error("not a Google endpoint");
  }
  return u;
}
async function readCapped(res, max) {
  if (!res.body) return { buf: Buffer.alloc(0), over: false };
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.byteLength > max) {
      chunks.push(Buffer.from(value.subarray(0, max - n)));
      n = max;
      await reader.cancel().catch(() => {
      });
      return { buf: Buffer.concat(chunks), over: true };
    }
    chunks.push(Buffer.from(value));
    n += value.byteLength;
  }
  return { buf: Buffer.concat(chunks), over: false };
}
async function googleRequest(doFetch, url, init = {}) {
  assertGoogleUrl(url);
  const signal = AbortSignal.timeout(init.timeoutMs ?? GOOGLE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: init.method ?? "GET",
      headers: { "User-Agent": USER_AGENT, ...init.headers ?? {} },
      ...init.body !== void 0 ? { body: init.body } : {},
      redirect: "error",
      signal
    });
    const { buf, over } = await readCapped(res, init.maxBytes ?? MAX_JSON_BYTES);
    return { status: res.status, body: buf, over };
  } catch {
    return { status: 0, body: Buffer.alloc(0), over: false };
  }
}
function jsonOf(r) {
  if (r.over) return null;
  try {
    const v = JSON.parse(r.body.toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
function googleForm(doFetch, url, form, maxBytes = 16 * 1024) {
  return googleRequest(doFetch, url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    maxBytes
  });
}
function oauthError(r) {
  const j = jsonOf(r);
  const e = j?.error;
  return typeof e === "string" && /^[a-z_]{1,40}$/.test(e) ? e : null;
}
async function revokeToken(doFetch, token) {
  const r = await googleForm(doFetch, GOOGLE_REVOKE_URL, { token });
  return r.status === 200 || r.status === 400 && oauthError(r) === "invalid_token";
}
async function fetchDriveClient(relay) {
  let c;
  try {
    c = await relay.driveClient();
  } catch (err) {
    const status = err.status;
    const code = err.code;
    if (status === 404 && code === "drive_not_configured") throw new DriveReadError("Google Drive is not set up for this team (ask the relay admin)");
    throw new DriveReadError("the team relay did not give the Google Drive client; try again later");
  }
  if (!c || typeof c.client_id !== "string" || !CLIENT_ID_RE.test(c.client_id) || typeof c.client_secret !== "string" || !CLIENT_SECRET_RE.test(c.client_secret)) {
    throw new DriveReadError("the team relay gave an invalid Google Drive client");
  }
  return { client_id: c.client_id, client_secret: c.client_secret };
}
function isDomain(d) {
  return typeof d === "string" && DOMAIN_RE.test(d);
}
function emailInDomain(email, domain) {
  if (!EMAIL_RE.test(email)) return false;
  const at = email.lastIndexOf("@");
  return email.slice(at + 1).toLowerCase() === domain.toLowerCase();
}
var DriveReadError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DriveReadError";
  }
};
var tokenCache = /* @__PURE__ */ new Map();
function clearDriveTokenCache() {
  tokenCache.clear();
}

// src/login.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
init_credentials();
init_relay_client_core();
var LOGIN_TIMEOUT_MS = 5 * 6e4;
var TOKEN_RESPONSE_LIMIT = 16 * 1024;
function base64url(buf) {
  return buf.toString("base64url");
}
function codeChallenge(verifier) {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

// src/drive-login.ts
var DRIVE_CONNECT_TIMEOUT_MS = 11e4;
var DRIVE_CONNECT_SCOPE = `openid email ${DRIVE_SCOPE}`;
var STATE_RE = /^[A-Za-z0-9_-]{43}$/;
var GOOGLE_CODE_RE = /^[A-Za-z0-9._~/+-]{10,1024}$/;
var GOOGLE_ISSUERS = /* @__PURE__ */ new Set(["https://accounts.google.com", "accounts.google.com"]);
var MAC_ONLY = "Google Drive can only be connected on macOS: the connection is kept in the macOS Keychain, never in a file.";
var DriveConnectError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DriveConnectError";
  }
};
function sameSecret(a, b) {
  const ha = createHash2("sha256").update(a, "utf8").digest();
  const hb = createHash2("sha256").update(b, "utf8").digest();
  return timingSafeEqual2(ha, hb);
}
var PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function page(title, text) {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${title}</title>`,
    "<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f5;color:#1c1c1a}",
    "main{max-width:26rem;padding:1.5rem 1.75rem;border:1px solid #e3e2de;border-radius:12px;background:#fff}",
    "h1{font-size:16px;margin:0 0 .4rem}p{margin:0;color:#5c5b57}",
    "@media (prefers-color-scheme:dark){body{background:#151514;color:#ecebe7}main{background:#1d1d1b;border-color:#2e2e2b}p{color:#a3a29c}}</style>",
    `</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`,
    ""
  ].join("\n");
}
function respond(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Content-Security-Policy": PAGE_CSP,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    Connection: "close"
  });
  res.end(body);
}
function idTokenClaims(idToken) {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts[1].length > 8192) return null;
  try {
    const v = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
function checkIdToken(idToken, want) {
  if (typeof idToken !== "string" || idToken.length > 16384) return { ok: false, reason: "Google did not say which account signed in" };
  const c = idTokenClaims(idToken);
  if (!c) return { ok: false, reason: "Google did not say which account signed in" };
  if (typeof c.iss !== "string" || !GOOGLE_ISSUERS.has(c.iss)) return { ok: false, reason: "the sign-in did not come from Google" };
  const audOk = c.aud === want.clientId || Array.isArray(c.aud) && c.aud.includes(want.clientId) && c.azp === want.clientId;
  if (!audOk) return { ok: false, reason: "the sign-in was for another app" };
  if (typeof c.exp !== "number" || c.exp * 1e3 <= want.nowMs) return { ok: false, reason: "the sign-in had already expired" };
  if (typeof c.nonce !== "string" || !sameSecret(c.nonce, want.nonce)) return { ok: false, reason: "the sign-in did not match this request" };
  const email = c.email;
  if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, reason: "Google did not say which account signed in" };
  if (c.email_verified !== true) return { ok: false, reason: "the Google account's email is not verified" };
  if (c.hd !== want.domain || !emailInDomain(email, want.domain)) {
    return { ok: false, reason: `the Google account is not in ${want.domain}; sign in with your ${want.domain} account` };
  }
  return { ok: true, email: email.toLowerCase() };
}
async function startDriveConnect(opts) {
  const log = opts.log ?? (() => {
  });
  const now = opts.now ?? Date.now;
  if (!isDomain(opts.domain)) throw new DriveConnectError("the team's Drive domain is not valid");
  if (opts.loginHint !== void 0 && (!EMAIL_RE.test(opts.loginHint) || !emailInDomain(opts.loginHint, opts.domain))) {
    throw new DriveConnectError(`the account must be an address in ${opts.domain}`);
  }
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const verifier = base64url(randomBytes2(48));
  const state = base64url(randomBytes2(32));
  const nonce = base64url(randomBytes2(32));
  const challenge = codeChallenge(verifier);
  let settle;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  done.catch(() => {
  });
  let finished = false;
  let used = false;
  let timer = null;
  let server = null;
  let port = 0;
  const shut = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (server) {
      server.close();
      server.closeAllConnections();
    }
  };
  const fail = (message) => {
    if (finished) return;
    finished = true;
    shut();
    settle.reject(new DriveConnectError(message));
  };
  const succeed = (v) => {
    if (finished) return;
    finished = true;
    shut();
    settle.resolve(v);
  };
  const discard = async (token) => {
    if (!token) return;
    const gone = await revokeToken(doFetch, token).catch(() => false);
    if (!gone) log('could not revoke the unused Google token; remove "team relay" access at myaccount.google.com/permissions');
  };
  const redirectUri = () => `http://127.0.0.1:${port}/callback`;
  const exchange = async (code) => {
    const r = await googleForm(
      doFetch,
      GOOGLE_TOKEN_URL,
      {
        code,
        client_id: opts.client.client_id,
        client_secret: opts.client.client_secret,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
        code_verifier: verifier
      },
      64 * 1024
    );
    if (r.status === 0) return fail("Google did not answer the sign-in; run /team-relay:drive connect again");
    let body = null;
    if (!r.over) {
      try {
        const v = JSON.parse(r.body.toString("utf8"));
        if (typeof v === "object" && v !== null && !Array.isArray(v)) body = v;
      } catch {
        body = null;
      }
    }
    const refresh = typeof body?.refresh_token === "string" ? body.refresh_token : null;
    const access = typeof body?.access_token === "string" ? body.access_token : null;
    if (r.status !== 200 || !body) {
      await discard(refresh ?? access);
      const e = oauthError(r);
      return fail(`Google refused the sign-in (${r.status}${e ? ` ${e}` : ""}); run /team-relay:drive connect again`);
    }
    const reject = async (why) => {
      await discard(refresh ?? access);
      return fail(`${why}; nothing was stored`);
    };
    if (!refresh || !REFRESH_TOKEN_RE.test(refresh)) return reject("Google did not give a lasting Drive connection");
    const scope = typeof body.scope === "string" ? body.scope.split(" ") : [];
    if (!scope.includes(DRIVE_SCOPE)) return reject('Drive read access was not granted (tick "See and download your Google Drive files")');
    const id = checkIdToken(body.id_token, { clientId: opts.client.client_id, nonce, domain: opts.domain, nowMs: now() });
    if (!id.ok) return reject(id.reason);
    let previous = null;
    let previousToken = null;
    try {
      previous = await opts.keychain.account();
      if (previous && previous !== id.email) previousToken = await opts.keychain.read(previous);
      await opts.keychain.removeAll();
      await opts.keychain.write(id.email, refresh);
    } catch (err) {
      await discard(refresh);
      return fail(`signed in, but the Keychain could not keep the connection (${err.message}); nothing was stored`);
    }
    clearDriveTokenCache();
    if (previousToken) await discard(previousToken);
    succeed({ email: id.email, replaced: previous && previous !== id.email ? previous : null });
  };
  const handle = (req, res) => {
    req.resume();
    if (used || finished) {
      respond(res, 410, page("Sign-in link used", "This sign-in has finished. You can close this tab."));
      return;
    }
    const notOurs = (why) => {
      respond(res, 404, page("Not found", "There is nothing here."));
      log(`ignored a request to the Drive sign-in listener (${why}); still waiting`);
    };
    if (req.headers.host !== `127.0.0.1:${port}`) return notOurs("unexpected Host");
    let url2;
    try {
      url2 = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    } catch {
      return notOurs("unreadable request");
    }
    if (req.method !== "GET" || url2.pathname !== "/callback") return notOurs("not GET /callback");
    const states = url2.searchParams.getAll("state");
    if (states.length !== 1 || !STATE_RE.test(states[0]) || !sameSecret(states[0], state)) return notOurs("wrong state");
    used = true;
    const errors = url2.searchParams.getAll("error");
    if (errors.length > 0) {
      respond(res, 200, page("Not connected", "Nothing was changed. You can close this tab."));
      const e = /^[a-z_]{1,40}$/.test(errors[0]) ? errors[0] : "error";
      return fail(`the Google sign-in was cancelled or refused (${e}); run /team-relay:drive connect to try again`);
    }
    const codes = url2.searchParams.getAll("code");
    if (codes.length !== 1 || !GOOGLE_CODE_RE.test(codes[0])) {
      respond(res, 400, page("Not connected", "The sign-in answer carried no code. Run /team-relay:drive connect again in Claude Code."));
      return fail("the Google sign-in did not complete (no code); run /team-relay:drive connect again");
    }
    respond(res, 200, page("Google Drive connected", "You can close this tab and go back to Claude Code."));
    void exchange(codes[0]).catch(() => fail("the Google sign-in could not be completed; run /team-relay:drive connect again"));
  };
  server = createServer(handle);
  server.requestTimeout = 3e4;
  server.headersTimeout = 1e4;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = server.address().port;
  const auth = new URL(GOOGLE_AUTH_URL);
  auth.searchParams.set("client_id", opts.client.client_id);
  auth.searchParams.set("redirect_uri", redirectUri());
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", DRIVE_CONNECT_SCOPE);
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  auth.searchParams.set("hd", opts.domain);
  auth.searchParams.set("state", state);
  auth.searchParams.set("nonce", nonce);
  auth.searchParams.set("code_challenge", challenge);
  auth.searchParams.set("code_challenge_method", "S256");
  if (opts.loginHint) auth.searchParams.set("login_hint", opts.loginHint);
  const url = auth.toString();
  const limit = opts.timeoutMs ?? DRIVE_CONNECT_TIMEOUT_MS;
  timer = setTimeout(() => fail(`the Google sign-in was not finished within ${Math.round(limit / 1e3)} seconds; run /team-relay:drive connect again`), limit);
  timer.unref?.();
  try {
    (opts.open ?? ((u) => void openInBrowser(u, { log, title: "Connect Google Drive", what: "the Google sign-in link" })))(url);
  } catch {
    log("could not open a browser");
  }
  return { url, port, done, cancel: () => fail("the Google sign-in was cancelled") };
}
function teamDriveDomain(drives, loginHint) {
  const domains = [...new Set((drives ?? []).map((d) => d.domain).filter(isDomain))];
  if (domains.length === 0) throw new DriveConnectError("your team has no shared Google Drive in its boundaries, so there is nothing to connect");
  if (loginHint) {
    const d = domains.find((x) => emailInDomain(loginHint, x));
    if (!d) throw new DriveConnectError(`that account is not in your team's Drive domain (${domains.join(", ")})`);
    return d;
  }
  if (domains.length > 1) throw new DriveConnectError(`your team's drives are in several domains (${domains.join(", ")}): run /team-relay:drive connect <your email>`);
  return domains[0];
}
async function driveStatus(keychain) {
  if (!keychain) return MAC_ONLY;
  const account = await keychain.account();
  return account ? `Google Drive is connected as ${account} on this Mac. /team-relay:drive disconnect removes it.` : "Google Drive is not connected on this Mac. Run /team-relay:drive connect.";
}
async function driveDisconnect(keychain, doFetch = (u, i) => fetch(u, i)) {
  if (!keychain) return MAC_ONLY;
  const account = await keychain.account();
  if (!account) {
    await keychain.removeAll();
    return "Google Drive was not connected on this Mac; nothing to do.";
  }
  let token = null;
  try {
    token = await keychain.read(account);
  } catch {
    token = null;
  }
  const revoked = token ? await revokeToken(doFetch, token).catch(() => false) : false;
  await keychain.removeAll();
  clearDriveTokenCache();
  return revoked ? `Google Drive disconnected: ${account}'s access was revoked at Google and removed from this Mac.` : `Google Drive disconnected: removed from this Mac. Google could not confirm the revocation; remove "team relay" at myaccount.google.com/permissions to be sure.`;
}

// src/drive-cli.ts
var USAGE = "usage: /team-relay:drive [status | connect [your-email] | disconnect]";
function parseDriveArgs(argv) {
  const a = argv.filter((x) => x !== "");
  if (a.length === 0 || a.length === 1 && a[0] === "status") return { cmd: "status" };
  if (a.length === 1 && a[0] === "disconnect") return { cmd: "disconnect" };
  if (a[0] === "connect" && a.length === 1) return { cmd: "connect" };
  if (a[0] === "connect" && a.length === 2 && a[1].length <= 254 && EMAIL_RE.test(a[1])) return { cmd: "connect", email: a[1].toLowerCase() };
  return null;
}
async function defaultRelay() {
  const { relayClientFromEnv: relayClientFromEnv2 } = await Promise.resolve().then(() => (init_relay_client(), relay_client_exports));
  const c = relayClientFromEnv2(process.env, { attempts: 1, timeoutMs: 15e3 });
  return { driveClient: () => c.driveClient(), boundaries: () => c.boundaries() };
}
async function runDriveCli(argv, deps = {}) {
  const parsed = parseDriveArgs(argv);
  if (!parsed) return { exitCode: 2, line: USAGE };
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return { exitCode: 1, line: MAC_ONLY };
  const keychain = deps.keychain === void 0 ? defaultKeychain(platform) : deps.keychain;
  if (!keychain) return { exitCode: 1, line: MAC_ONLY };
  try {
    if (parsed.cmd === "status") return { exitCode: 0, line: await driveStatus(keychain) };
    if (parsed.cmd === "disconnect") return { exitCode: 0, line: await driveDisconnect(keychain, deps.fetch) };
    let relay;
    try {
      relay = deps.relay ? deps.relay() : await defaultRelay();
    } catch {
      return { exitCode: 1, line: "Not signed in to the team relay: run /team-relay:login first." };
    }
    let boundaries;
    try {
      boundaries = await relay.boundaries();
    } catch {
      return { exitCode: 1, line: "The team relay did not give your team's boundaries; try again later." };
    }
    const domain = teamDriveDomain(boundaries.boundaries?.drives, parsed.email);
    const client = await fetchDriveClient(relay);
    const flow = await startDriveConnect({
      domain,
      client,
      keychain,
      ...parsed.email ? { loginHint: parsed.email } : {},
      ...deps.fetch ? { fetch: deps.fetch } : {},
      ...deps.open ? { open: deps.open } : {},
      ...deps.timeoutMs !== void 0 ? { timeoutMs: deps.timeoutMs } : {},
      ...deps.log ? { log: deps.log } : {}
    });
    const r = await flow.done;
    const was = r.replaced ? ` It replaced the connection for ${r.replaced}.` : "";
    return { exitCode: 0, line: `Google Drive connected as ${r.email} (read-only). The token is kept in this Mac's Keychain only.${was}` };
  } catch (err) {
    if (err instanceof DriveConnectError || err instanceof DriveReadError || err instanceof KeychainError) return { exitCode: 1, line: `Google Drive: ${err.message}` };
    return { exitCode: 1, line: "Google Drive: that did not work; try again." };
  }
}
if (process.argv[1] && /drive-cli\.[jt]s$/.test(process.argv[1])) {
  void runDriveCli(process.argv.slice(2), { log: (l) => process.stderr.write(`team-relay: ${l}
`) }).then(
    ({ exitCode, line }) => {
      process.stdout.write(`${line}
`);
      process.exitCode = exitCode;
    },
    () => {
      process.stdout.write("Google Drive: that did not work; try again.\n");
      process.exitCode = 1;
    }
  );
}
export {
  USAGE,
  parseDriveArgs,
  runDriveCli
};
