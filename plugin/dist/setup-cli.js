import { createRequire as __teamRelayCreateRequire } from 'node:module'; const require = __teamRelayCreateRequire(import.meta.url);

// src/setup-cli.ts
import { createReadStream, openSync as openSync4 } from "node:fs";
import { basename as basename5, join as join8 } from "node:path";
import { createInterface } from "node:readline";

// src/boundaries-types.ts
var SELF_TEST_PENDING = "the self-test has not run yet";

// src/boundary-set.ts
import { homedir as homedir5 } from "node:os";

// src/boundaries-rule.ts
var BOUNDARIES_VERSION_MAX = 2 ** 31 - 1;

// src/deny-list.ts
import { realpathSync } from "node:fs";
import { normalize } from "node:path";
var HOME_PATHS = [
  "~/.ssh/**",
  "~/.gnupg/**",
  "~/.aws/**",
  "~/.config/gcloud/**",
  "~/.azure/**",
  "~/.kube/**",
  "~/.docker/**",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.git-credentials",
  "~/.claude/**",
  "~/.claude-team-relay/**",
  "~/.config/team-relay/**",
  "~/Library/Keychains/**",
  "~/.config/gh/**",
  "~/.zsh_history",
  "~/.bash_history",
  "~/.*_history",
  "~/Library/Application Support/**/Cookies*",
  "~/Library/Application Support/Firefox/**",
  "~/Library/Application Support/Google/Chrome/**",
  "~/.terraform.d/**",
  "~/.cargo/credentials*",
  "~/.vault-token",
  "~/.pgpass",
  "~/.config/solana/**",
  "~/.foundry/**",
  "~/.ethereum/**"
];
var ANY_DEPTH = [
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/*.p12",
  "**/*.pfx",
  "**/*.keystore",
  "**/*.jks",
  "**/credentials.json",
  "**/*.tfvars",
  "**/keystore/**",
  "**/.npmrc",
  "**/.netrc",
  "**/.pypirc",
  "**/.git-credentials",
  "**/id_ecdsa*",
  "**/id_dsa*",
  "**/*.ppk",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/.aws/**",
  "**/.kube/**"
];
function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
function within(p, dir) {
  return p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}
function realOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return normalize(p);
  }
}
function credentialHit(p, ctx) {
  const homes = [.../* @__PURE__ */ new Set([normalize(ctx.home), realOr(ctx.home)])];
  for (const rule of HOME_PATHS) {
    const re = globRe(rule.slice(2).replace(/\/\*\*$/, ""));
    for (const h of homes) {
      if (p === h || !within(p, h)) continue;
      const parts = p.slice(h.length).split("/").filter(Boolean);
      for (let k = 1; k <= parts.length; k++) if (re.test(parts.slice(0, k).join("/"))) return rule;
    }
  }
  for (const rule of ANY_DEPTH) {
    const re = globRe(rule.replace(/^\*\*\//, "").replace(/\/\*\*$/, ""));
    if (p.split("/").some((part) => part !== "" && re.test(part))) return rule;
  }
  if (ctx.cloudsdkConfig && ctx.cloudsdkConfig.startsWith("/") && within(p, realOr(ctx.cloudsdkConfig))) return "CLOUDSDK_CONFIG";
  for (const d of ctx.credentialDirs ?? []) {
    if (within(p, d) || within(p, realOr(d))) return `${d}/**`;
  }
  return null;
}

// src/member-folders.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { chmodSync as chmodSync2, closeSync as closeSync2, fsyncSync as fsyncSync2, lstatSync as lstatSync2, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync2, renameSync as renameSync2, rmSync as rmSync2, writeSync as writeSync2 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { basename as basename3, dirname as dirname3, isAbsolute as isAbsolute4, join as join4, normalize as normalize3 } from "node:path";

// src/answering-lock.ts
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
function configDir(env) {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "team-relay");
}

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

// src/scope.ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute3, join as join3, normalize as normalize2 } from "node:path";

// src/credentials.ts
import { randomBytes } from "node:crypto";
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
import { homedir as homedir2 } from "node:os";
import { basename, dirname, isAbsolute as isAbsolute2, join as join2 } from "node:path";
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
    if (!isAbsolute2(explicit)) throw new CredentialFileError("RELAY_CREDENTIALS_FILE must be an absolute path");
    return explicit;
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute2(xdg) ? xdg : join2(env.HOME?.trim() || homedir2(), ".config");
  return join2(base, CREDENTIALS_DIR, CREDENTIALS_FILE);
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
function credentialFileExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function credentialFingerprint(path) {
  try {
    const st = lstatSync(path);
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}
function ensureDir(dir) {
  let st = null;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if (err.code !== "ENOENT") throw new CredentialFileError(`cannot use the credential directory (${err.code ?? "error"})`);
  }
  if (st === null) {
    mkdirSync(dirname(dir), { recursive: true, mode: 448 });
    mkdirSync(dir, { mode: 448 });
    chmodSync(dir, 448);
    st = lstatSync(dir);
  }
  checkOwnedPrivate(st, "the credential directory", "directory");
}
function writeCredential(path, value) {
  const checked = parseStoredCredential(value);
  const dir = dirname(path);
  ensureDir(dir);
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new CredentialFileError("the credential file is not a regular file; refusing to replace it");
  } catch (err) {
    if (err instanceof CredentialFileError) throw err;
  }
  const tmp = join2(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const body = `${JSON.stringify(checked, null, 2)}
`;
  let fd = null;
  try {
    fd = openSync(tmp, "wx", 384);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tmp, 384);
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw new CredentialFileError(`cannot write the credential file (${err.code ?? "error"})`);
  }
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
  }
}

// src/scope.ts
function relayCredentialDirs(env) {
  const dirs = [configDir(env)];
  try {
    dirs.push(dirname2(credentialsPath(env)));
  } catch {
  }
  return [...new Set(dirs)];
}
function folderSafety(cwd, env) {
  const path = realOr(cwd);
  const refuse = (reason) => ({ path, reason });
  if (!isAbsolute3(path)) return refuse("it is not an absolute path");
  try {
    if (!statSync(path).isDirectory()) return refuse("it is not a directory");
  } catch {
    return refuse("it does not exist");
  }
  const home2 = env.HOME?.trim() || homedir3();
  const homeReal = realOr(home2);
  if (path === "/") return refuse("it is the root directory");
  if (path === homeReal || normalize2(cwd) === normalize2(home2)) return refuse("it is your home directory");
  if (within(homeReal, path) || within(normalize2(home2), path)) return refuse("it contains your home directory");
  const configDirs = [join3(homeReal, ".claude"), join3(homeReal, ".claude-team-relay"), ...relayCredentialDirs(env).map(realOr)];
  const claudeConfig = env.CLAUDE_CONFIG_DIR?.trim();
  if (claudeConfig && isAbsolute3(claudeConfig)) configDirs.push(realOr(claudeConfig));
  for (const d of configDirs) {
    if (within(path, d)) return refuse(`it is inside a configuration directory (${d})`);
  }
  const cloudsdk = env.CLOUDSDK_CONFIG?.trim();
  const hit = credentialHit(path, {
    home: home2,
    cloudsdkConfig: cloudsdk && isAbsolute3(cloudsdk) ? cloudsdk : void 0,
    credentialDirs: relayCredentialDirs(env)
  });
  if (hit) return refuse(`it is inside a credential location on the deny list (${hit})`);
  if (dirname2(path) === homeReal || dirname2(normalize2(cwd)) === normalize2(home2)) return refuse("it is a folder directly in your home directory");
  const hidden = homeEntries(homeReal);
  for (const e of hidden) {
    if (within(path, e.path) || within(path, e.real)) return refuse(`it is inside ~/${e.name}`);
    if (within(e.real, path)) return refuse(`it contains ~/${e.name}`);
  }
  return { path, reason: null };
}
function homeEntries(homeReal) {
  let names;
  try {
    names = readdirSync(homeReal);
  } catch {
    names = [];
  }
  const wanted = /* @__PURE__ */ new Set(["Library", ...names.filter((n) => n.startsWith(".") && n !== "." && n !== "..")]);
  return [...wanted].map((name) => {
    const path = join3(homeReal, name);
    return { name, path, real: realOr(path) };
  });
}

// src/member-folders.ts
var MEMBER_FOLDERS_FILE = "boundaries.local.json";
var MAX_FOLDERS = 20;
var MAX_TEAMS = 20;
var MAX_PATH = 1024;
var MAX_FILE_BYTES2 = 256 * 1024;
var OLD_FOLDER_LISTS = ["repo_roots", "extra_folders"];
var MemberFoldersError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "MemberFoldersError";
  }
};
function memberFoldersPath(env) {
  return join4(configDir(env), MEMBER_FOLDERS_FILE);
}
function home(env) {
  return env.HOME?.trim() || homedir4();
}
function expandPath(raw, env) {
  if (raw === "~") return normalize3(home(env));
  if (raw.startsWith("~/")) return normalize3(join4(home(env), raw.slice(2)));
  if (isAbsolute4(raw)) return normalize3(raw);
  return null;
}
function memberFolderProblem(raw, env) {
  if (typeof raw !== "string" || raw.length === 0) return { path: null, reason: "it is not a path" };
  if (raw.length > MAX_PATH) return { path: null, reason: "it is longer than 1024 characters" };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { path: null, reason: "it contains control characters" };
  const expanded = expandPath(raw, env);
  if (!expanded) return { path: null, reason: "it is not an absolute path or one starting with ~/" };
  const { path, reason } = folderSafety(expanded, env);
  return { path, reason };
}
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function onlyKeys(o, allowed, what) {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new MemberFoldersError(`${what} has an unknown field (${JSON.stringify(k.slice(0, 40))})`);
  }
}
function holds(list, raw, env) {
  const target = expandPath(raw, env);
  return list.some((e) => e === raw || target !== null && expandPath(e, env) === target);
}
function parseList(raw, key, env) {
  const list = raw ?? [];
  if (!Array.isArray(list)) throw new MemberFoldersError(`${key} must be a list of paths`);
  if (list.length > MAX_FOLDERS) throw new MemberFoldersError(`${key} has more than ${MAX_FOLDERS} entries`);
  for (const entry of list) {
    const { reason } = memberFolderProblem(entry, env);
    if (reason && reason !== "it does not exist") throw new MemberFoldersError(`${key} entry ${JSON.stringify(String(entry).slice(0, 200))} cannot be used: ${reason}`);
  }
  return list;
}
function parseOldList(raw, key, env) {
  const list = raw ?? [];
  if (!Array.isArray(list)) throw new MemberFoldersError(`${key} must be a list of paths`);
  if (list.length > MAX_FOLDERS) throw new MemberFoldersError(`${key} has more than ${MAX_FOLDERS} entries`);
  if (list.some((e) => typeof e !== "string")) throw new MemberFoldersError(`${key} must be a list of paths`);
  return list.filter((e) => {
    const { reason } = memberFolderProblem(e, env);
    return reason === null || reason === "it does not exist";
  });
}
function parseTeamSettings(raw, env, team = "a team") {
  if (!isObj(raw)) throw new MemberFoldersError(`the settings for ${team} are not a JSON object`);
  onlyKeys(raw, ["folders", ...OLD_FOLDER_LISTS, "accepted"], `the settings for ${team}`);
  const folders2 = [];
  for (const entry of parseList(raw.folders, "folders", env)) if (!holds(folders2, entry, env)) folders2.push(entry);
  const previous = [];
  const seen = [...folders2];
  for (const [key, kind] of [["repo_roots", "repo_root"], ["extra_folders", "own_folder"]]) {
    for (const entry of parseOldList(raw[key], key, env)) {
      if (holds(seen, entry, env)) continue;
      seen.push(entry);
      previous.push({ path: entry, kind });
    }
  }
  return { folders: folders2, previous };
}
function emptyTeams() {
  return /* @__PURE__ */ Object.create(null);
}
function parseMemberSettings(raw, env) {
  if (!isObj(raw)) throw new MemberFoldersError("the folders file is not a JSON object");
  if ("repo_roots" in raw || "extra_folders" in raw || "folders" in raw) {
    throw new MemberFoldersError('the folders file has an older format (no "teams"); remove it and set your folders again with /team-relay:folders');
  }
  onlyKeys(raw, ["teams"], "the folders file");
  if (!isObj(raw.teams)) throw new MemberFoldersError('the folders file needs "teams", an object');
  const names = Object.keys(raw.teams);
  if (names.length > MAX_TEAMS) throw new MemberFoldersError(`the folders file has more than ${MAX_TEAMS} teams`);
  const teams = emptyTeams();
  for (const name of names) {
    if (!TEAM_RE.test(name)) throw new MemberFoldersError(`the folders file has a team name that is not a team id (${JSON.stringify(name.slice(0, 40))})`);
    teams[name] = parseTeamSettings(raw.teams[name], env, `team ${name}`);
  }
  return { teams };
}
function teamSettings(settings, team) {
  const t = Object.prototype.hasOwnProperty.call(settings.teams, team) ? settings.teams[team] : void 0;
  return t ? { folders: [...t.folders], previous: t.previous.map((x) => ({ ...x })) } : { folders: [], previous: [] };
}
function withTeam(settings, team, value) {
  if (!TEAM_RE.test(team)) throw new MemberFoldersError("not a team id");
  const teams = emptyTeams();
  for (const [k, v] of Object.entries(settings.teams)) teams[k] = v;
  teams[team] = { folders: [...value.folders], previous: [] };
  return { teams };
}
function uid2() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}
function checkPrivate(st, what, kind) {
  if (st.isSymbolicLink()) throw new MemberFoldersError(`${what} is a symbolic link; refusing to use it`);
  if (kind === "file" ? !st.isFile() : !st.isDirectory()) throw new MemberFoldersError(`${what} is not a ${kind}; refusing to use it`);
  const me = uid2();
  if (me !== null && st.uid !== me) throw new MemberFoldersError(`${what} is owned by another user; refusing to use it`);
  if ((st.mode & 63) !== 0) {
    const mode = (st.mode & 511).toString(8).padStart(3, "0");
    throw new MemberFoldersError(`${what} has mode ${mode}, readable or writable by others; refusing to use it (chmod ${kind === "file" ? "600" : "700"} it)`);
  }
}
function readMemberSettings(path, env) {
  let st;
  try {
    st = lstatSync2(path);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { teams: emptyTeams() };
    throw new MemberFoldersError(`cannot read the folders file (${code ?? "error"})`);
  }
  checkPrivate(lstatSync2(dirname3(path)), "the team relay configuration directory", "directory");
  checkPrivate(st, "the folders file", "file");
  if (st.size > MAX_FILE_BYTES2) throw new MemberFoldersError("the folders file is too large");
  let json;
  try {
    json = JSON.parse(readFileSync2(path, "utf8"));
  } catch {
    throw new MemberFoldersError("the folders file is not valid JSON");
  }
  return parseMemberSettings(json, env);
}
function serialise(settings) {
  const teams = {};
  for (const name of Object.keys(settings.teams).sort()) teams[name] = { folders: settings.teams[name].folders };
  return { teams };
}
function writeMemberSettings(path, value, env) {
  const checked = parseMemberSettings(serialise(value), env);
  const dir = dirname3(path);
  let st = null;
  try {
    st = lstatSync2(dir);
  } catch (err) {
    if (err.code !== "ENOENT") throw new MemberFoldersError(`cannot use the configuration directory (${err.code ?? "error"})`);
  }
  if (st === null) {
    mkdirSync2(dirname3(dir), { recursive: true, mode: 448 });
    mkdirSync2(dir, { mode: 448 });
    chmodSync2(dir, 448);
    st = lstatSync2(dir);
  }
  checkPrivate(st, "the team relay configuration directory", "directory");
  try {
    const existing = lstatSync2(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new MemberFoldersError("the folders file is not a regular file; refusing to replace it");
  } catch (err) {
    if (err instanceof MemberFoldersError) throw err;
  }
  const tmp = join4(dir, `.${basename3(path)}.${randomBytes2(8).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = openSync2(tmp, "wx", 384);
    writeSync2(fd, `${JSON.stringify(serialise(checked), null, 2)}
`);
    fsyncSync2(fd);
    closeSync2(fd);
    fd = null;
    chmodSync2(tmp, 384);
    renameSync2(tmp, path);
  } catch (err) {
    if (fd !== null) closeSync2(fd);
    rmSync2(tmp, { force: true });
    throw new MemberFoldersError(`cannot write the folders file (${err.code ?? "error"})`);
  }
}
var KIND_TEXT = { repo_root: "repository root", own_folder: "folder of your own" };
function previousSentence(previous) {
  if (previous.length === 0) return null;
  const shown = (p) => /^[\w~./ @+,-]+$/.test(p) ? p : JSON.stringify(p.slice(0, 200));
  const list = previous.map((x) => `${shown(x.path)} (${KIND_TEXT[x.kind]})`).join(", ");
  return `Folders you chose before 13 Nov 2026 (not used now; add the ones you still want with /team-relay:folders add <path>): ${list}.`;
}
function hasAccepted(acceptedVersion, currentVersion) {
  return typeof acceptedVersion === "number" && Number.isSafeInteger(acceptedVersion) && acceptedVersion >= 1 && acceptedVersion <= BOUNDARIES_VERSION_MAX && acceptedVersion <= currentVersion;
}

// src/relay-client.ts
import { execFile } from "node:child_process";
import { readFileSync as readFileSync4 } from "node:fs";

// src/relay-default.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { fileURLToPath } from "node:url";
function defaultRelayFile() {
  return fileURLToPath(new URL("../relay.default.json", import.meta.url));
}
function defaultRelayUrl(file = defaultRelayFile()) {
  try {
    const raw = JSON.parse(readFileSync3(file, "utf8"));
    if (typeof raw.relay_url !== "string") return null;
    parseRelayUrl(raw.relay_url);
    return raw.relay_url;
  } catch {
    return null;
  }
}

// src/relay-client.ts
var REQUEST_ID_RE = /^rq_[0-9a-f]{32}$/;
var RelayError = class extends Error {
  status;
  code;
  detail;
  /** The relay's Retry-After, in whole seconds (0..RETRY_AFTER_MAX_S), when it sent one. */
  retryAfter;
  constructor(status2, code, detail, retryAfter) {
    super(`relay ${status2} ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "RelayError";
    this.status = status2;
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
};
var RETRY_AFTER_MAX_S = 3600;
function parseRetryAfter(v) {
  const t = v?.trim();
  if (!t || !/^[0-9]{1,10}$/.test(t)) return void 0;
  return Math.min(RETRY_AFTER_MAX_S, Number(t));
}
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
        raw = readFileSync4(file, "utf8");
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
var TOKEN_REFRESH_MARGIN_MS = 5 * 6e4;
var JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
var ACCOUNT_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
var GCLOUD_OUTPUT_LIMIT = 64 * 1024;
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
    execFile(
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
var METADATA_BASE = "http://metadata.google.internal";
var METADATA_IDENTITY_PATH = "/computeMetadata/v1/instance/service-accounts/default/identity";
var METADATA_OUTPUT_LIMIT = 16 * 1024;
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
var NotConnected = class extends Error {
  constructor(message = "Not connected: run /team-relay:login") {
    super(message);
    this.name = "NotConnected";
  }
};
var SIGN_IN_AGAIN = "the relay refused your sign-in (signed out, expired, or no longer on the team): run /team-relay:login again";
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
      throw new RelayError(res.status, code, detail, parseRetryAfter(res.headers.get("retry-after")));
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

// src/notify.ts
var DATA_JSON_LIMIT = 16 * 1024;

// src/boundary-set.ts
var MAX_WALK_FILE_BYTES = 5 * 1024 * 1024;
function homeDir(env) {
  return env.HOME?.trim() || homedir5();
}
var ANY_DEPTH_RES = ANY_DEPTH.map((rule) => globRe(rule.replace(/^\*\*\//, "").replace(/\/\*\*$/, "")));

// src/console-url.ts
function consoleUrl(relayUrl) {
  try {
    const u = new URL(relayUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return relayUrl;
    return u.origin;
  } catch {
    return relayUrl;
  }
}

// src/daemon-launch.ts
import { execFile as execFile2 } from "node:child_process";
import { randomBytes as randomBytes3 } from "node:crypto";
import { accessSync, chmodSync as chmodSync3, closeSync as closeSync3, constants, fsyncSync as fsyncSync3, lstatSync as lstatSync3, mkdirSync as mkdirSync3, openSync as openSync3, readFileSync as readFileSync5, renameSync as renameSync3, rmSync as rmSync3, statSync as statSync2, writeSync as writeSync3 } from "node:fs";
import { basename as basename4, dirname as dirname4, isAbsolute as isAbsolute5, join as join5 } from "node:path";
var AGENT_LABEL = "com.team-relay.answerer";
var LAUNCHER_FILE = "daemon-launch.mjs";
var LAUNCHCTL = "/bin/launchctl";
var PLUGIN_KEY_RE = /^team-relay@[A-Za-z0-9._-]{1,100}$/;
var PLUGIN_KEY_ENV = "TEAM_RELAY_PLUGIN_KEY";
function installedPluginsPath(home2) {
  return join5(home2, ".claude", "plugins", "installed_plugins.json");
}
var isObj2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function pickPluginEntry(json, key) {
  if (!PLUGIN_KEY_RE.test(key) || !isObj2(json) || !isObj2(json.plugins) || !Object.prototype.hasOwnProperty.call(json.plugins, key)) return null;
  const list = json.plugins[key];
  if (!Array.isArray(list)) return null;
  const e = list.find((x) => isObj2(x) && x.scope === "user" && typeof x.installPath === "string" && isAbsolute5(x.installPath));
  if (!e) return null;
  const path = e.installPath;
  const str = (v) => typeof v === "string" ? v : "";
  return { key, installPath: path, identity: [path, str(e.gitCommitSha), str(e.lastUpdated), str(e.version)].join("\n") };
}
function readInstalledPlugin(home2, key) {
  try {
    return pickPluginEntry(JSON.parse(readFileSync5(installedPluginsPath(home2), "utf8")), key);
  } catch {
    return null;
  }
}
function launcherSource(key) {
  if (!PLUGIN_KEY_RE.test(key)) throw new AgentError(`--plugin ${key} cannot be used: it must be team-relay@<marketplace name>`);
  return `// The team relay's background answerer (written by setup-cli.js daemon install).
// At each start it finds where the team-relay plugin is installed now, under the key setup
// installed it with, and runs its dist/daemon.js.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const KEY = ${JSON.stringify(key)};
const home = process.env.HOME;
function pick(json) {
  if (!json || typeof json !== 'object' || !json.plugins || typeof json.plugins !== 'object' || Array.isArray(json.plugins)) return null;
  if (!Object.prototype.hasOwnProperty.call(json.plugins, KEY)) return null;
  const list = json.plugins[KEY];
  if (!Array.isArray(list)) return null;
  return list.find((e) => e && typeof e === 'object' && !Array.isArray(e) && e.scope === 'user' && typeof e.installPath === 'string' && isAbsolute(e.installPath)) ?? null;
}
let entry = null;
try {
  if (home && isAbsolute(home)) entry = pick(JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')));
} catch {
  entry = null;
}
if (!entry) {
  process.stderr.write('team-relay: the plugin is not installed for this user; nothing to run\\n');
  process.exit(1);
}
process.env.${PLUGIN_KEY_ENV} = KEY;
await import(pathToFileURL(join(entry.installPath, 'dist', 'daemon.js')).href);
`;
}
function xmlEscape(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}
function agentPath(node, claude) {
  const dirs = [dirname4(node), dirname4(claude), "/usr/bin", "/bin"];
  return dirs.filter((d, i) => dirs.indexOf(d) === i).join(":");
}
function plistXml(i) {
  const s = (v) => `<string>${xmlEscape(v)}</string>`;
  const env = [
    ["HOME", i.home],
    ["PATH", agentPath(i.node, i.claude)],
    ["TEAM_RELAY_CLAUDE_BIN", i.claude],
    ...i.xdgConfigHome ? [["XDG_CONFIG_HOME", i.xdgConfigHome]] : []
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${s(AGENT_LABEL)}`,
    `  <key>ProgramArguments</key><array>${s(i.node)}${s(i.launcher)}</array>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "  <key>ThrottleInterval</key><integer>30</integer>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...env.map(([k, v]) => `    <key>${xmlEscape(k)}</key>${s(v)}`),
    "  </dict>",
    `  <key>StandardOutPath</key>${s("/dev/null")}`,
    `  <key>StandardErrorPath</key>${s("/dev/null")}`,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}
function agentPlistPath(home2) {
  return join5(home2, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}
function launcherPath(configDir2) {
  return join5(configDir2, LAUNCHER_FILE);
}
var defaultExec = (file, args) => new Promise((resolve) => {
  execFile2(file, args, { timeout: 15e3, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
    const code = err ? typeof err.code === "number" ? err.code : null : 0;
    resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
});
var AgentError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentError";
  }
};
function claudeProblem(path) {
  if (!path || !isAbsolute5(path)) return "it is not an absolute path";
  try {
    if (!statSync2(path).isFile()) return "it is not a file";
    accessSync(path, constants.X_OK);
  } catch {
    return "it does not exist or is not executable";
  }
  return null;
}
function ensureDir2(dir) {
  try {
    const st = lstatSync3(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new AgentError(`${dir} is not a directory`);
    return;
  } catch (err) {
    if (err instanceof AgentError) throw err;
  }
  mkdirSync3(dir, { recursive: true, mode: 448 });
  chmodSync3(dir, 448);
}
function writePrivate(path, text) {
  try {
    const st = lstatSync3(path);
    if (st.isSymbolicLink() || !st.isFile()) throw new AgentError(`${path} is not a regular file; refusing to replace it`);
  } catch (err) {
    if (err instanceof AgentError) throw err;
  }
  const tmp = join5(dirname4(path), `.${basename4(path)}.${randomBytes3(8).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = openSync3(tmp, "wx", 384);
    writeSync3(fd, text);
    fsyncSync3(fd);
    closeSync3(fd);
    fd = null;
    chmodSync3(tmp, 384);
    renameSync3(tmp, path);
  } catch (err) {
    if (fd !== null) closeSync3(fd);
    rmSync3(tmp, { force: true });
    throw err instanceof AgentError ? err : new AgentError(`cannot write ${path} (${err.code ?? "error"})`);
  }
}
var BOOTOUT_WAIT_MS = 2e4;
var BOOTOUT_POLL_MS = 500;
var BOOTSTRAP_RETRIES = 3;
var BOOTSTRAP_RETRY_MS = 2e3;
var realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function installAgent(i) {
  const exec = i.exec ?? defaultExec;
  const sleep = i.sleep ?? realSleep;
  if (!isAbsolute5(i.home)) throw new AgentError("HOME is not an absolute path");
  if (!isAbsolute5(i.node)) throw new AgentError("the node path is not absolute");
  const bad = claudeProblem(i.claude);
  if (bad) throw new AgentError(`--claude ${i.claude} cannot be used: ${bad}`);
  if (!Number.isInteger(i.uid) || i.uid < 0) throw new AgentError("the user id is unknown");
  const source = launcherSource(i.pluginKey);
  const entry = readInstalledPlugin(i.home, i.pluginKey);
  if (!entry) throw new AgentError(`${i.pluginKey} is not installed for this user (claude plugin install ${i.pluginKey}), so the background answerer would have nothing to run.`);
  let hasDaemon = false;
  try {
    hasDaemon = statSync2(join5(entry.installPath, "dist", "daemon.js")).isFile();
  } catch {
    hasDaemon = false;
  }
  if (!hasDaemon) throw new AgentError(`${i.pluginKey} is installed, but without dist/daemon.js: update it (claude plugin update ${i.pluginKey}) and run this again.`);
  ensureDir2(i.configDir);
  const launcher = launcherPath(i.configDir);
  writePrivate(launcher, source);
  const plist = agentPlistPath(i.home);
  ensureDir2(dirname4(plist));
  writePrivate(plist, plistXml({ node: i.node, launcher, claude: i.claude, home: i.home, ...i.xdgConfigHome ? { xdgConfigHome: i.xdgConfigHome } : {} }));
  const target = `gui/${i.uid}/${AGENT_LABEL}`;
  await exec(LAUNCHCTL, ["bootout", target]);
  for (let waited = 0; ; waited += BOOTOUT_POLL_MS) {
    if ((await exec(LAUNCHCTL, ["print", target])).code !== 0) break;
    if (waited >= BOOTOUT_WAIT_MS) break;
    await sleep(BOOTOUT_POLL_MS);
  }
  for (let attempt = 0; ; attempt++) {
    const r = await exec(LAUNCHCTL, ["bootstrap", `gui/${i.uid}`, plist]);
    if (r.code === 0) break;
    if (attempt >= BOOTSTRAP_RETRIES) throw new AgentError(`launchctl bootstrap failed (exit ${r.code ?? "unknown"}): ${r.stderr.trim().slice(0, 200) || "no reason given"}`);
    await sleep(BOOTSTRAP_RETRY_MS);
  }
  return { plist, launcher };
}
async function uninstallAgent(i) {
  const exec = i.exec ?? defaultExec;
  await exec(LAUNCHCTL, ["bootout", `gui/${i.uid}/${AGENT_LABEL}`]);
  let found = false;
  for (const path of [agentPlistPath(i.home), launcherPath(i.configDir)]) {
    try {
      lstatSync3(path);
      found = true;
    } catch {
      continue;
    }
    rmSync3(path, { force: true });
  }
  return found;
}

// src/login.ts
import { createHash, randomBytes as randomBytes4, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";

// src/console-open.ts
import { execFile as execFile3 } from "node:child_process";
import { chmodSync as chmodSync4, mkdtempSync, rmSync as rmSync4, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute as isAbsolute6, join as join6 } from "node:path";
var REDIRECT_TTL_MS = 1e4;
var REDIRECT_FILE = "console.html";
var defaultRun = (command, args, done) => {
  execFile3(command, args, { shell: false, timeout: 1e4 }, (err) => done(err));
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
  if (custom) return isAbsolute6(custom) ? custom : null;
  if (platform === "darwin") return "open";
  if (platform === "linux") return "xdg-open";
  return null;
}
function openInBrowser(url, opts) {
  const what = opts.what ?? "the URL above";
  const told = (opened) => opts.onResult?.(opened);
  const opener = opts.opener ?? openerFor(opts.platform ?? process.platform);
  if (!opener) {
    opts.log(`no browser opener on this platform; open ${what} yourself`);
    told(false);
    return null;
  }
  let dir;
  try {
    dir = mkdtempSync(join6(opts.tmpRoot ?? tmpdir(), "team-relay-console-"));
    chmodSync4(dir, 448);
  } catch {
    opts.log(`could not prepare the browser hand-off; open ${what} yourself`);
    told(false);
    return null;
  }
  const cleanup = () => rmSync4(dir, { recursive: true, force: true });
  const file = join6(dir, REDIRECT_FILE);
  try {
    writeFileSync(file, redirectHtml(url, opts.title), { mode: 384, flag: "wx" });
  } catch {
    cleanup();
    opts.log(`could not prepare the browser hand-off; open ${what} yourself`);
    told(false);
    return null;
  }
  process.once("exit", cleanup);
  setTimeout(() => {
    process.removeListener("exit", cleanup);
    cleanup();
  }, opts.deleteAfterMs ?? REDIRECT_TTL_MS).unref();
  (opts.run ?? defaultRun)(opener, [file], (err) => {
    if (err) opts.log(`could not open a browser (${opener}); open ${what} yourself`);
    told(!err);
  });
  return file;
}

// src/login.ts
var LOGIN_TIMEOUT_MS = 5 * 6e4;
var DEVICE_RE = /^[A-Za-z0-9 ._()-]{1,64}$/;
var CODE_RE = /^[A-Za-z0-9_-]{16,256}$/;
var STATE_RE = /^[A-Za-z0-9_-]{43}$/;
var TOKEN_RESPONSE_LIMIT = 16 * 1024;
function base64url(buf) {
  return buf.toString("base64url");
}
function codeChallenge(verifier) {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}
function deviceLabel(host = hostname()) {
  const clean = host.split(".")[0].replace(/[^A-Za-z0-9._()-]/g, "-").replace(/^-+|-+$/g, "");
  const label = `Claude Code on ${clean || "this computer"}`.slice(0, 64).trimEnd();
  return DEVICE_RE.test(label) ? label : "Claude Code";
}
function sameSecret(a, b) {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
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
function respond(res, status2, body) {
  res.writeHead(status2, {
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
var SUPERSEDED = "the sign-in was replaced by a newer one";
var LoginError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "LoginError";
  }
};
function connectedAs(c) {
  return `Connected as ${c.member}${c.email ? ` (${c.email})` : ""} on team ${c.team}`;
}
function identityChange(stored, replaced) {
  if (!replaced) return null;
  const member = replaced.member !== stored.member;
  const team = replaced.team !== stored.team;
  if (!member && !team) return null;
  const what = member && team ? "a different member of a different team" : member ? "a different member" : "a different team";
  return `This is ${what} than before: this computer was signed in as ${replaced.member} on team ${replaced.team}, and is now ${stored.member} on team ${stored.team}. If you did not mean to switch, run /team-relay:logout.`;
}
function replaceableCredential(credentialsFile, relayNorm) {
  let existing;
  try {
    existing = readCredential(credentialsFile);
  } catch (err) {
    const why = err instanceof CredentialFileError ? err.message : "it cannot be read";
    throw new LoginError(`the stored sign-in on this computer cannot be used (${why}); nothing was changed. Run /team-relay:logout, then /team-relay:login.`);
  }
  if (!existing) return null;
  if (existing.relay_url !== relayNorm) {
    throw new LoginError(
      `this computer is signed in to another relay (${existing.relay_url}) than the one configured for this session (${relayNorm}); nothing was changed. To switch relays, run /team-relay:logout first, then /team-relay:login.`
    );
  }
  return { relay_url: existing.relay_url, team: existing.team, member: existing.member, ...existing.email ? { email: existing.email } : {} };
}
async function startLogin(opts) {
  const log = opts.log ?? (() => {
  });
  const relay = parseRelayUrl(opts.relayUrl);
  const relayNorm = normaliseRelayUrl(opts.relayUrl);
  replaceableCredential(opts.credentialsFile, relayNorm);
  const base = new URL(relay.toString());
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const device = opts.device ?? deviceLabel();
  if (!DEVICE_RE.test(device)) throw new LoginError("the device label is not valid");
  const verifier = base64url(randomBytes4(48));
  const state = base64url(randomBytes4(32));
  const challenge = codeChallenge(verifier);
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  let settle;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  done.catch(() => {
  });
  let finished = false;
  let timer = null;
  let server = null;
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
    settle.reject(new LoginError(message));
  };
  const succeed = (v) => {
    if (finished) return;
    finished = true;
    shut();
    settle.resolve(v);
  };
  let port = 0;
  let used = false;
  const discard = (credential, team) => {
    void doFetch(new URL(`v1/teams/${team}/credentials/self`, base).toString(), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${credential}`, Accept: "application/json", "User-Agent": "team-relay-plugin/0.1.0" },
      redirect: "error",
      signal: AbortSignal.timeout(1e4)
    }).then(
      (r) => void r.body?.cancel().catch(() => {
      }),
      () => log("could not revoke the unused credential at the relay; it expires on its own")
    );
  };
  const exchange = async (code) => {
    let res;
    try {
      res = await doFetch(new URL("v1/login/token", base).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "team-relay-plugin/0.1.0" },
        body: JSON.stringify({ code, code_verifier: verifier }),
        redirect: "error",
        signal: AbortSignal.timeout(3e4)
      });
    } catch {
      return fail("the relay did not answer the sign-in; run /team-relay:login again");
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let code2 = `http_${res.status}`;
      try {
        const j = JSON.parse(text);
        if (typeof j.error === "string" && /^[a-z_]{1,40}$/.test(j.error)) code2 = j.error;
      } catch {
      }
      return fail(`the relay refused the sign-in (${res.status} ${code2}); run /team-relay:login again`);
    }
    if (text.length > TOKEN_RESPONSE_LIMIT) return fail("the relay answered the sign-in with something unexpected");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return fail("the relay answered the sign-in with something that is not JSON");
    }
    const { credential, team, member, relay_url, expires_at, email } = body;
    if (typeof credential !== "string" || !CREDENTIAL_RE.test(credential)) return fail("the relay did not return a device credential");
    if (typeof team !== "string" || !TEAM_RE.test(team)) return fail("the relay did not return a valid team");
    if (typeof member !== "string" || !MEMBER_RE.test(member)) return fail("the relay did not return a valid member id");
    if (relay_url !== void 0 && relay_url !== null) {
      let same = false;
      try {
        same = typeof relay_url === "string" && normaliseRelayUrl(relay_url) === relayNorm;
      } catch {
        same = false;
      }
      if (!same) return fail("the relay named a different relay URL than the one you signed in to; nothing was stored");
    }
    if (email !== void 0 && email !== null && (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email))) {
      discard(credential, team);
      return fail("the relay returned an invalid email for the signed-in account; nothing was stored");
    }
    const stored = {
      relay_url: relayNorm,
      team,
      member,
      credential,
      expires_at: typeof expires_at === "string" ? expires_at : null,
      ...typeof email === "string" ? { email } : {}
    };
    let replaced;
    try {
      replaced = replaceableCredential(opts.credentialsFile, relayNorm);
    } catch (err) {
      discard(credential, team);
      return fail(`signed in, but nothing was stored: ${err.message}`);
    }
    try {
      writeCredential(opts.credentialsFile, stored);
    } catch (err) {
      discard(credential, team);
      return fail(`signed in, but the credential could not be stored: ${err.message}`);
    }
    succeed({ stored, replaced });
  };
  const handle = (req, res) => {
    req.resume();
    if (used || finished) {
      respond(res, 410, page("Sign-in link used", "This sign-in has finished. You can close this tab."));
      return;
    }
    const notOurs = (logLine) => {
      respond(res, 404, page("Not found", "There is nothing here."));
      log(`ignored a request to the sign-in listener (${logLine}); still waiting`);
    };
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}`) return notOurs("unexpected Host");
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
    const codes = url2.searchParams.getAll("code");
    const errors = url2.searchParams.getAll("error");
    if (errors.length > 0) {
      respond(res, 200, page("Sign-in cancelled", "Nothing was changed. You can close this tab."));
      log(`the sign-in was cancelled in the browser (${/^[a-z_]{1,40}$/.test(errors[0]) ? errors[0] : "error"})`);
      return fail("sign-in cancelled in the browser; run /team-relay:login to try again");
    }
    if (codes.length !== 1 || !CODE_RE.test(codes[0])) {
      respond(res, 400, page("Sign-in did not complete", "The sign-in answer carried no code. Run /team-relay:login again in Claude Code."));
      log("the sign-in answer carried no code");
      return fail("the sign-in did not complete (no code); run /team-relay:login again");
    }
    respond(res, 200, page("Connected", "Connected. You can close this tab."));
    void exchange(codes[0]);
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
  const start = new URL("v1/login/start", base);
  start.searchParams.set("port", String(port));
  start.searchParams.set("state", state);
  start.searchParams.set("code_challenge", challenge);
  start.searchParams.set("code_challenge_method", "S256");
  start.searchParams.set("device", device);
  const url = start.toString();
  timer = setTimeout(() => fail("the sign-in timed out after 5 minutes; run /team-relay:login again"), opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
  timer.unref?.();
  let told;
  const opened = new Promise((resolve) => told = resolve);
  try {
    if (opts.open) {
      opts.open(url);
      told(true);
    } else {
      openInBrowser(url, { log, title: "Team relay sign-in", what: "the sign-in link", onResult: told });
    }
  } catch {
    log("could not open a browser; open the sign-in link yourself");
    told(false);
  }
  return { url, port, done, opened, cancel: () => fail(SUPERSEDED) };
}

// src/tool-util.ts
function describeError(err) {
  if (err instanceof RelayError) {
    return `relay refused (${err.status} ${err.code})${err.detail ? `: ${err.detail}` : ""}`;
  }
  if (err instanceof RelayNetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return "unexpected error";
}

// src/relay-connect.ts
var STABLE_READ_TRIES = 5;
function readConnection(env) {
  const path = credentialsPath(env);
  for (let tries = 1; ; tries++) {
    const before = credentialFingerprint(path);
    let connection;
    try {
      connection = connectionFromEnv(env);
    } catch (err) {
      connection = err instanceof Error ? err : new Error(String(err));
    }
    const after = credentialFingerprint(path);
    if (before === after) return { fingerprint: after, connection };
    if (tries >= STABLE_READ_TRIES) return { fingerprint: after, connection: new Error("the credential file kept changing while it was read") };
  }
}
async function connectOnce(env, opts = {}) {
  const { fingerprint, connection: c } = readConnection(env);
  if (c instanceof NotConnected) return { kind: "not_signed_in", fingerprint };
  if (c instanceof Error) return { kind: "config", problem: describeError(c), fingerprint };
  let client;
  try {
    client = new RelayClient({ url: c.url, team: c.team, token: c.token });
  } catch (err) {
    return { kind: "config", problem: describeError(err), fingerprint };
  }
  let me;
  try {
    me = await client.me({ attempts: 1, timeoutMs: opts.timeoutMs ?? 15e3 });
  } catch (err) {
    if (err instanceof RelayError && err.status === 401 && c.mode === "credential") return { kind: "refused", fingerprint };
    return { kind: "unreachable", problem: `the relay did not answer (${describeError(err)})`, fingerprint };
  }
  if (me.team !== client.team || !MEMBER_RE.test(me.member)) return { kind: "wrong_team", problem: "the relay answered for a different team", fingerprint };
  return { kind: "connected", client, me, connection: c, fingerprint };
}

// src/setup-steps.ts
import { execFile as execFile5 } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";

// src/locate.ts
import { execFile as execFile4, execFileSync } from "node:child_process";
import { accessSync as accessSync2, constants as constants2, readFileSync as readFileSync6, readdirSync as readdirSync2, statSync as statSync3 } from "node:fs";
import { delimiter, isAbsolute as isAbsolute7, join as join7 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function executableFile(path) {
  try {
    if (!statSync3(path).isFile()) return false;
    accessSync2(path, constants2.X_OK);
    return true;
  } catch {
    return false;
  }
}
var NODE_PINS_FILE = fileURLToPath2(new URL("../bin/node-pins.sh", import.meta.url));
function pinnedNodeVersion(file = NODE_PINS_FILE) {
  let text;
  try {
    text = readFileSync6(file, "utf8");
  } catch {
    return null;
  }
  const found = [...text.matchAll(/^NODE_VERSION='(v\d{1,9}\.\d{1,9}\.\d{1,9})'$/gm)];
  return found.length === 1 ? found[0][1] : null;
}
function nodeArch(arch) {
  return arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
}
function pinnedNodePath(home2, version, arch) {
  return join7(home2, ".local", "share", "team-relay", `node-${version}-darwin-${arch}`, "bin", "node");
}
var realNodeVersion = (path) => {
  try {
    return execFileSync(path, ["--version"], { encoding: "utf8", timeout: 1e4, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
function newEnoughNode(version) {
  const m = /^v(\d{1,9})\.(\d{1,9})\.\d{1,9}$/.exec(version ?? "");
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 22 || major === 22 && minor >= 12;
}
function versionedNodePath(path) {
  if (/\/(\.nvm|\.fnm|fnm|fnm_multishells|\.asdf\/installs|mise\/installs|\.volta\/tools|Cellar|\.n\/n\/versions)\//.test(path)) return true;
  return path.split("/").some((seg) => /^(node[@-])?v\d+(\.\d+){0,2}$/.test(seg) || /^(node[@-])?\d+\.\d+(\.\d+)?$/.test(seg) || /^node@\d/.test(seg));
}
function pinnedNode(o) {
  const pin = pinnedNodeVersion(o.pinsFile);
  const arch = nodeArch(o.arch ?? process.arch);
  if (!pin || !arch) return null;
  const pinned = pinnedNodePath(homeDir(o.env), pin, arch);
  return executableFile(pinned) && newEnoughNode((o.version ?? realNodeVersion)(pinned)) ? pinned : null;
}
function stablePathNode(o) {
  const version = o.version ?? realNodeVersion;
  for (const dir of (o.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute7(dir)) continue;
    const n = join7(dir, "node");
    if (versionedNodePath(n)) continue;
    if (executableFile(n) && newEnoughNode(version(n))) return n;
  }
  return null;
}
var RUN_NODE_FILE = fileURLToPath2(new URL("../bin/run-node", import.meta.url));
var FETCH_NODE_TIMEOUT_MS = 15 * 60 * 1e3;
var runNodeFetch = (env) => new Promise((resolve) => {
  execFile4("/bin/sh", [RUN_NODE_FILE, "--fetch-only"], { env, timeout: FETCH_NODE_TIMEOUT_MS, windowsHide: true }, () => resolve()).stdin?.end();
});
async function ensureAnswererNode(o) {
  const have = pinnedNode(o);
  if (have) return have;
  if (nodeArch(o.arch ?? process.arch) && pinnedNodeVersion(o.pinsFile)) {
    await (o.fetch ?? runNodeFetch)(o.env);
    const got = pinnedNode(o);
    if (got) return got;
  }
  return stablePathNode(o);
}

// src/setup-steps.ts
var CHOOSE_FOLDER_SCRIPT = [
  "on run argv",
  "activate",
  "set chosen to choose folder with prompt (item 1 of argv) with multiple selections allowed",
  'set out to ""',
  "repeat with f in chosen",
  "set out to out & (POSIX path of (f as alias)) & (character id 0)",
  "end repeat",
  "return out",
  "end run"
];
var OSASCRIPT = "/usr/bin/osascript";
var CHOOSER_TIMEOUT_MS = 10 * 60 * 1e3;
function chosenPaths(stdout) {
  return stdout.replace(/\n$/, "").split("\0").filter((p) => p !== "").map((p) => p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
}
var runExecFile = (f, a, o, cb) => void execFile5(f, a, o, (e, out, err) => cb(e, String(out), String(err)));
function osascriptChooser(run = runExecFile) {
  return (prompt) => new Promise((resolve) => {
    const args = CHOOSE_FOLDER_SCRIPT.flatMap((line) => ["-e", line]);
    args.push(prompt);
    try {
      run(OSASCRIPT, args, { timeout: CHOOSER_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) resolve({ kind: "chosen", paths: chosenPaths(stdout) });
        else if (/\(-128\)/.test(stderr)) resolve({ kind: "cancelled" });
        else resolve({ kind: "unavailable" });
      });
    } catch {
      resolve({ kind: "unavailable" });
    }
  });
}
function chooserAvailable(platform) {
  return platform === "darwin" && existsSync2(OSASCRIPT);
}
function defaultChooser(platform) {
  if (!chooserAvailable(platform)) return async () => ({ kind: "unavailable" });
  return osascriptChooser();
}
function addFolder(out, raw, env) {
  const { reason } = memberFolderProblem(raw, env);
  if (reason) return { kind: "refused", reason };
  const target = expandPath(raw, env);
  if (out.some((e) => e === raw || expandPath(e, env) === target)) return { kind: "duplicate" };
  if (out.length >= MAX_FOLDERS) return { kind: "full" };
  out.push(raw);
  return { kind: "added" };
}
function saveTeamFolders(env, team, change) {
  const file = memberFoldersPath(env);
  const fresh = readMemberSettings(file, env);
  const next = change(teamSettings(fresh, team).folders);
  writeMemberSettings(file, withTeam(fresh, team, { folders: next }), env);
  return [...next];
}
async function installBackground(i) {
  const xdg = i.env.XDG_CONFIG_HOME?.trim();
  await installAgent({
    home: homeDir(i.env),
    configDir: configDir(i.env),
    node: i.node,
    claude: i.claude,
    uid: i.uid,
    pluginKey: i.pluginKey,
    ...i.exec ? { exec: i.exec } : {},
    ...i.sleep ? { sleep: i.sleep } : {},
    ...xdg && xdg.startsWith("/") ? { xdgConfigHome: xdg } : {}
  });
}
function uninstallBackground(i) {
  return uninstallAgent({ home: homeDir(i.env), configDir: configDir(i.env), uid: i.uid, ...i.exec ? { exec: i.exec } : {} });
}
var BACKGROUND_NO_NODE = "Background answering needs Node.js, which could not be found or downloaded on this Mac.";
async function backgroundNode(env, fetch2) {
  const node = await ensureAnswererNode({ env, ...fetch2 ? { fetch: fetch2 } : {} });
  if (!node) throw new AgentError(BACKGROUND_NO_NODE);
  return node;
}
function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

// src/setup-cli.ts
var HELP = [
  "usage: node setup-cli.js <command>",
  "",
  "  login [--relay <url>]            sign in to the team relay in your browser",
  "  folders                          choose the folders your Claude may answer your team from",
  "  daemon install --claude <path> --plugin team-relay@<marketplace>",
  "                                   start answering teammates in the background (macOS)",
  "  daemon uninstall                 stop answering in the background",
  "  status [--after-setup]          show your setup checklist (--after-setup: as the setup line's last step)"
].join("\n");
var NOT_SIGNED_IN = "You are not signed in to your team on this Mac yet. Run the setup line again.";
var PROTECTED_DIRS = ["Documents", "Desktop", "Downloads", join8("Library", "Mobile Documents")];
var PRIVACY_FOLDERS_NOTE = 'The first time your Mac answers from a folder in Documents, Desktop, Downloads or iCloud Drive, macOS may ask whether "node" may open it: click Allow.';
function privacyProtected(raw, env) {
  const path = memberFolderProblem(raw, env).path ?? expandPath(raw, env);
  if (!path) return false;
  const home2 = homeDir(env);
  const p = path.toLowerCase();
  return PROTECTED_DIRS.some((d) => {
    const dir = join8(home2, d).toLowerCase();
    return p === dir || p.startsWith(`${dir}/`);
  });
}
async function defaultConnect(env) {
  const a = await connectOnce(env);
  if (a.kind === "connected") return { client: a.client, member: a.me.member, team: a.me.team };
  if (a.kind === "not_signed_in") return { error: NOT_SIGNED_IN };
  if (a.kind === "refused") return { error: "Your sign-in to the team has ended (or you are no longer on the team). Run the setup line again to sign in." };
  return { error: `Could not reach your team just now (${a.problem}). Check your internet connection, then run the setup line again.` };
}
var yes = (answer, byDefault) => {
  const a = (answer ?? "").trim().toLowerCase();
  if (a === "") return byDefault;
  return a === "y" || a === "yes";
};
async function login(argv, d) {
  const { io, env } = d;
  let relayArg;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--relay" && argv[i + 1] !== void 0) relayArg = argv[++i];
    else {
      io.print(HELP);
      return 2;
    }
  }
  const path = credentialsPath(env);
  let stored;
  try {
    stored = readCredential(path);
  } catch (err) {
    io.print(`The stored sign-in on this computer cannot be used (${err instanceof CredentialFileError ? err.message : "it cannot be read"}).`);
    return 1;
  }
  const relayUrl = relayArg ?? stored?.relay_url ?? configValue(env.RELAY_URL) ?? defaultRelayUrl() ?? void 0;
  if (!relayUrl) {
    io.print("No relay is configured: run `node setup-cli.js login --relay <url>`.");
    return 1;
  }
  let relayNorm;
  try {
    parseRelayUrl(relayUrl);
    relayNorm = normaliseRelayUrl(relayUrl);
  } catch (err) {
    io.print(`That relay URL cannot be used: ${describeError(err)}.`);
    return 1;
  }
  if (stored && stored.relay_url === relayNorm) {
    const a = await (d.connect ?? (() => defaultConnect(env)))();
    if ("client" in a) {
      io.print(`Already signed in. ${connectedAs({ member: a.member, team: a.team, email: stored.email })}.`);
      return 0;
    }
    if (!a.error.startsWith("The relay refused")) {
      io.print(a.error);
      return 1;
    }
  }
  let flow;
  try {
    flow = await (d.startLogin ?? startLogin)({ relayUrl, credentialsFile: path, log: (line) => io.print(`  ${line}`) });
  } catch (err) {
    io.print(err instanceof LoginError ? `Not signed in: ${err.message}` : `Could not start the sign-in: ${describeError(err)}`);
    return 1;
  }
  io.print("Sign in with your work Google account in the browser window that opened, and choose your team.");
  io.print("If no window opened, open this link yourself (it is for you only; do not share it):");
  io.print(flow.url);
  try {
    const r = await flow.done;
    const change = identityChange(r.stored, r.replaced);
    io.print(`${connectedAs(r.stored)}.${change ? ` ${change}` : ""}`);
    return 0;
  } catch (err) {
    io.print(`The sign-in did not finish (${describeError(err)}).`);
    return 1;
  }
}
var FOLDERS_PROMPT = "Pick the folders your Claude may answer your team from. Hold Cmd to pick more than one.";
var plural = (n, one, many) => `${n === 0 ? "no" : n} ${n === 1 ? one : many}`;
async function chooseFolders(d, current) {
  const { io, env } = d;
  const name = (raw) => {
    const resolved = expandPath(raw, env) ?? raw;
    return basename5(resolved) || resolved;
  };
  const describe = (raw) => {
    const { reason } = memberFolderProblem(raw, env);
    return reason ? `Not used: ${raw} (${reason}).` : `${name(raw)} (${expandPath(raw, env) ?? raw})`;
  };
  const add = (raw, out2) => {
    const r2 = addFolder(out2, raw, env);
    if (r2.kind === "refused") io.print(`  Not used: ${raw} (${r2.reason}).`);
    else if (r2.kind === "duplicate") io.print(`  ${name(raw)} is already in the list.`);
    else if (r2.kind === "full") io.print(`  At most ${MAX_FOLDERS} folders; ${name(raw)} is not added.`);
    else io.print(`  ${describe(raw)}`);
  };
  let saidNo = false;
  if (current.length > 0) {
    io.print("The folders your Claude answers your team from:");
    for (const raw of current) io.print(`  ${describe(raw)}`);
    if (yes(await io.ask("Keep these folders? [Y/n] "), true)) return current;
    saidNo = true;
  }
  const chooser = d.chooseFolders ?? defaultChooser(d.platform ?? process.platform);
  io.print("A window opens: pick the folders your Claude may answer your team from (hold Cmd to pick more than one), then click Choose.");
  const r = await chooser(FOLDERS_PROMPT);
  if (r.kind === "cancelled") {
    if (saidNo && yes(await io.ask("Stop using any folders? [y/N] "), false)) return [];
    io.print(current.length > 0 ? "Nothing picked, so your folders stay as they were." : "Nothing picked.");
    return current;
  }
  if (r.kind === "chosen") {
    const out2 = [];
    for (const raw of r.paths) add(raw, out2);
    if (out2.length === 0 && r.paths.length > 0) {
      io.print(current.length > 0 ? "None of those can be used, so your folders stay as they were." : "None of those can be used.");
      return current;
    }
    return out2;
  }
  io.print("Type the full path of each folder your Claude may answer your team from, one per line (~ means your home folder). Press Enter on an empty line to finish.");
  const out = [];
  for (; ; ) {
    const line = await io.ask("> ");
    if (line === null || line.trim() === "") break;
    add(line.trim(), out);
  }
  return out;
}
async function folders(d) {
  const { io, env } = d;
  const c = await (d.connect ?? (() => defaultConnect(env)))();
  if ("error" in c) {
    io.print(c.error);
    return 1;
  }
  const file = memberFoldersPath(env);
  let all;
  try {
    all = readMemberSettings(file, env);
  } catch (err) {
    io.print(`Your saved folders cannot be read (${describeError(err)}). Ask a team owner for help.`);
    return 1;
  }
  const current = teamSettings(all, c.team);
  io.print("Your Claude answers your team from folders you choose on this Mac. In a folder that is a git repository, only the files git tracks are used.");
  const previous = previousSentence(current.previous);
  if (previous) io.print(previous);
  const chosen = await chooseFolders(d, current.folders);
  let saved;
  try {
    saved = saveTeamFolders(env, c.team, () => chosen);
  } catch (err) {
    io.print(`Nothing was saved (${err instanceof MemberFoldersError ? err.message : describeError(err)}).`);
    return 1;
  }
  io.print(`Saved: ${plural(saved.length, "folder", "folders")}.`);
  if (saved.some((raw) => privacyProtected(raw, env))) io.print(PRIVACY_FOLDERS_NOTE);
  return 0;
}
async function daemon(argv, d) {
  const { io, env } = d;
  const platform = d.platform ?? process.platform;
  const sub = argv[0];
  if (sub !== "install" && sub !== "uninstall") {
    io.print(HELP);
    return 2;
  }
  let claude;
  let plugin;
  for (let i = 1; i < argv.length; i++) {
    if (sub === "install" && argv[i] === "--claude" && argv[i + 1] !== void 0 && claude === void 0) claude = argv[++i];
    else if (sub === "install" && argv[i] === "--plugin" && argv[i + 1] !== void 0 && plugin === void 0) plugin = argv[++i];
    else {
      io.print(HELP);
      return 2;
    }
  }
  if (platform !== "darwin") {
    io.print("The background answerer runs on macOS only.");
    return 1;
  }
  const uid3 = d.uid ?? currentUid();
  try {
    if (sub === "uninstall") {
      const found = await uninstallBackground({ env, uid: uid3, ...d.exec ? { exec: d.exec } : {} });
      io.print(found ? "Your Mac no longer answers your team in the background." : "Your Mac was not answering your team in the background; nothing to do.");
      return 0;
    }
    if (!claude) {
      io.print("daemon install needs --claude <the absolute path of claude>.");
      return 2;
    }
    if (!plugin) {
      io.print("daemon install needs --plugin team-relay@<marketplace name>, the plugin as the setup command installed it.");
      return 2;
    }
    await installBackground({
      env,
      uid: uid3,
      node: d.node ?? await backgroundNode(env, d.fetchNode),
      claude,
      pluginKey: plugin,
      ...d.exec ? { exec: d.exec } : {},
      ...d.sleep ? { sleep: d.sleep } : {}
    });
    io.print("Your Mac now answers your team in the background whenever it is on. Claude Code does not need to be open.");
    return 0;
  } catch (err) {
    io.print(err instanceof AgentError ? err.message : `That did not work: ${describeError(err)}`);
    return 1;
  }
}
var SELF_TEST_RUNNING = "Your Mac is checking that everything works. This takes about a minute.";
var WAITING_FOR_CHECK_IN = "Waiting for your Mac to check in\u2026";
var PENDING_POLL_MS = 5e3;
var PENDING_WAIT_MS = 9e4;
function checklist(p) {
  const s = p.status;
  const reason = typeof s?.self_test?.reason === "string" && s.self_test.reason ? s.self_test.reason : null;
  const pending = s?.self_test?.ok !== true && reason === SELF_TEST_PENDING;
  const checks = s === null ? [{ id: "setup", done: false, todo: "Paste the setup line into Terminal on this Mac." }] : [
    { id: "setup", done: true, todo: "" },
    {
      id: "claude",
      done: s.claude?.found === true && s.claude.signed_in === true,
      todo: s.claude?.found === true ? "Claude Code is not signed in on this Mac. Run the setup line again and sign in when it asks." : "Claude Code is not on this Mac. Run the setup line again and say yes when it offers to install it."
    },
    { id: "answering", done: p.answering, todo: "Your Mac isn't answering right now. Make sure it's switched on; if this stays, run the setup line again." },
    {
      id: "folders",
      done: typeof p.folderCount === "number" && p.folderCount > 0,
      todo: "You have not chosen the folders your Claude answers from yet. Run the setup line again and pick them."
    },
    {
      id: "self_test",
      done: s.self_test?.ok === true,
      todo: pending ? SELF_TEST_RUNNING : reason ? `Your Mac's last check did not pass. Run the setup line again. If it still does not pass, show this to a team owner: ${reason}.` : "Your Mac has not checked that everything works yet. Wait a minute."
    }
  ];
  const open = checks.filter((c) => !c.done);
  return [
    { id: "mac", title: "Set up your Mac", done: open.length === 0, todo: open[0]?.todo ?? "", checks },
    {
      id: "accept",
      title: "Accept what the team shares",
      done: p.boundariesVersion > 0 && hasAccepted(p.acceptedVersion, p.boundariesVersion),
      todo: p.boundariesVersion > 0 ? `Open ${p.console} and click Accept.` : `Your team has not chosen what to share yet. A team owner does that on ${p.console}.`,
      checks: []
    }
  ];
}
async function status(d, afterSetup) {
  const { io, env } = d;
  const c = await (d.connect ?? (() => defaultConnect(env)))();
  if ("error" in c) {
    io.print(c.error);
    return 1;
  }
  let ms, acc;
  try {
    [ms, acc] = await Promise.all([c.client.membersStatus({ attempts: 2, timeoutMs: 15e3 }), c.client.acceptance({ attempts: 2, timeoutMs: 15e3 })]);
  } catch (err) {
    io.print(`Could not check with your team just now (${describeError(err)}). Run the setup line again in a minute.`);
    return 1;
  }
  const mine = (list) => list.members.find((m) => m.member === c.member);
  const pending = (e) => e?.status?.self_test.ok === false && e.status.self_test.reason === SELF_TEST_PENDING;
  const notIn = (e) => afterSetup && !e?.status;
  const said = /* @__PURE__ */ new Set();
  const sayOnce = (line) => {
    if (!said.has(line)) io.print(line);
    said.add(line);
  };
  const sleep = d.sleep ?? ((t) => new Promise((r) => setTimeout(r, t)));
  for (let waited = 0; ; ) {
    const e = mine(ms);
    if (notIn(e)) sayOnce(WAITING_FOR_CHECK_IN);
    else if (pending(e)) sayOnce(SELF_TEST_RUNNING);
    else break;
    if (waited >= PENDING_WAIT_MS) break;
    await sleep(PENDING_POLL_MS);
    waited += PENDING_POLL_MS;
    try {
      ms = await c.client.membersStatus({ attempts: 2, timeoutMs: 15e3 });
    } catch {
    }
  }
  const entry = mine(ms);
  const url = consoleUrl(c.client.url);
  const acceptedVersion = typeof acc.version === "number" ? acc.version : 0;
  const boundariesVersion = typeof ms.boundaries_version === "number" ? ms.boundaries_version : 0;
  const steps = checklist({
    status: entry?.status ?? null,
    folderCount: typeof entry?.folder_count === "number" ? entry.folder_count : null,
    answering: entry?.answering === true,
    acceptedVersion,
    boundariesVersion,
    console: url
  });
  const done = steps.filter((s) => s.done).length;
  io.print(`Your setup (${c.member}, team ${c.team}): ${done} of ${steps.length} done.`);
  for (const s of steps) {
    if (s.done) {
      io.print(`  [x] ${s.title}`);
    } else if (s.checks.length > 0) {
      io.print(`  [ ] ${s.title}`);
      for (const ch of s.checks) if (!ch.done) io.print(`      - ${ch.todo}`);
    } else {
      io.print(`  [ ] ${s.title} - ${s.todo}`);
    }
  }
  io.print(`Ask the team: ${url}/ask`);
  if (afterSetup) {
    const toAccept = boundariesVersion > 0 && !hasAccepted(acceptedVersion, boundariesVersion);
    io.print("");
    io.print(`Done. Go back to the team page in your browser${toAccept ? " and click Accept" : ""}.`);
  }
  return 0;
}
async function runSetup(argv, d) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case void 0:
    case "help":
    case "--help":
    case "-h":
      d.io.print(HELP);
      return 0;
    case "login":
      return login(rest, d);
    case "folders":
      if (rest.length > 0) break;
      return folders(d);
    case "daemon":
      return daemon(rest, d);
    case "status":
      if (rest.length === 0) return status(d, false);
      if (rest.length === 1 && rest[0] === "--after-setup") return status(d, true);
      break;
  }
  d.io.print(HELP);
  return 2;
}
function terminalIO() {
  let input = process.stdin;
  if (!process.stdin.isTTY) {
    try {
      input = createReadStream("", { fd: openSync4("/dev/tty", "r") });
    } catch {
      input = process.stdin;
    }
  }
  const rl = createInterface({ input, terminal: false });
  const it = rl[Symbol.asyncIterator]();
  return {
    io: {
      print: (line) => process.stdout.write(`${line}
`),
      ask: async (prompt) => {
        process.stdout.write(prompt);
        const r = await it.next();
        return r.done ? null : String(r.value);
      }
    },
    close: () => {
      rl.close();
      if (input !== process.stdin) input.destroy?.();
    }
  };
}
if (process.argv[1] && /setup-cli\.[jt]s$/.test(process.argv[1])) {
  const t = terminalIO();
  void runSetup(process.argv.slice(2), { env: process.env, io: t.io }).then(
    (code) => {
      t.close();
      process.exit(code);
    },
    (err) => {
      process.stdout.write(`team-relay setup: ${describeError(err)}
`);
      t.close();
      process.exit(1);
    }
  );
}
export {
  CHOOSER_TIMEOUT_MS,
  CHOOSE_FOLDER_SCRIPT,
  FOLDERS_PROMPT,
  HELP,
  NOT_SIGNED_IN,
  PRIVACY_FOLDERS_NOTE,
  SELF_TEST_RUNNING,
  WAITING_FOR_CHECK_IN,
  checklist,
  chosenPaths,
  osascriptChooser,
  runSetup
};
