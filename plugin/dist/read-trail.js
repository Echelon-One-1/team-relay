import { createRequire as __teamRelayCreateRequire } from 'node:module'; const require = __teamRelayCreateRequire(import.meta.url);

// src/read-trail.ts
import { readFileSync } from "node:fs";

// src/host-socket.ts
import { createConnection, createServer } from "node:net";
var MAX_LINE = 1024 * 1024;
function lineReader(sock, onLine, onTooLong) {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    buf += chunk;
    for (; ; ) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      onLine(line);
    }
    if (buf.length > MAX_LINE) {
      buf = "";
      onTooLong();
    }
  });
}
var HostSocketClient = class _HostSocketClient {
  sock = null;
  nextId = 1;
  waiting = /* @__PURE__ */ new Map();
  closedError = null;
  static async connect(path, token) {
    const c = new _HostSocketClient();
    await c.open(path, token);
    return c;
  }
  open(path, token) {
    return new Promise((resolve, reject) => {
      const sock = createConnection(path);
      let authed = false;
      sock.once("error", (err) => {
        if (!authed) reject(err);
      });
      sock.on("close", () => {
        this.closedError = new Error("the team relay host is gone");
        if (!authed) reject(new Error("the team relay host refused this answerer"));
        for (const w of this.waiting.values()) w.reject(this.closedError);
        this.waiting.clear();
      });
      lineReader(
        sock,
        (line) => {
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            sock.destroy();
            return;
          }
          if (!authed) {
            if (msg.auth === "ok") {
              authed = true;
              resolve();
            } else sock.destroy();
            return;
          }
          const w = typeof msg.id === "number" ? this.waiting.get(msg.id) : void 0;
          if (!w) return;
          this.waiting.delete(msg.id);
          if (typeof msg.error === "string") w.reject(new Error(msg.error));
          else w.resolve(msg.result);
        },
        () => sock.destroy()
      );
      sock.on("connect", () => sock.write(`${JSON.stringify({ auth: token })}
`));
      this.sock = sock;
    });
  }
  call(method, params) {
    if (this.closedError || !this.sock) return Promise.reject(this.closedError ?? new Error("not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.sock.write(`${JSON.stringify({ id, method, params })}
`);
    });
  }
  close() {
    this.sock?.destroy();
  }
};

// src/read-trail-core.ts
import { basename } from "node:path";
var SENSITIVE_NAMES = [
  "*.tfstate",
  "secrets.*",
  "*.properties",
  "docker-compose*",
  "kubeconfig",
  "*service-account*.json",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".dev.vars",
  "id_ecdsa*",
  "id_dsa*",
  "*.ppk",
  "*.pem",
  "*.key",
  "*.p12"
];
function globMatch(glob, name) {
  const parts = glob.toLowerCase().split("*");
  const s = name.toLowerCase();
  if (parts.length === 1) return s === parts[0];
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!s.startsWith(first) || s.length < first.length + last.length || !s.endsWith(last)) return false;
  let at = first.length;
  const end = s.length - last.length;
  for (const mid of parts.slice(1, -1)) {
    const i = s.indexOf(mid, at);
    if (i < 0 || i + mid.length > end) return false;
    at = i + mid.length;
  }
  return true;
}
function sensitiveName(path) {
  const name = basename(path.replace(/[/\\]+$/, ""));
  return name !== "" && SENSITIVE_NAMES.some((glob) => globMatch(glob, name));
}
function pathsIn(value, limit = Number.POSITIVE_INFINITY) {
  const out = /* @__PURE__ */ new Set();
  const strings = [];
  const walk = (v, depth) => {
    if (strings.length >= limit || depth > 8) return;
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        strings.push(k);
        walk(x, depth + 1);
      }
    }
  };
  walk(value, 0);
  for (const text of strings) {
    for (const m of text.matchAll(/[^\s"'`,;:()[\]{}<>|\\]+/g)) {
      const token = m[0];
      if (!/[A-Za-z]/.test(token)) continue;
      out.add(token);
      if (out.size >= limit) return [...out];
    }
  }
  return [...out];
}
function trailReport(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const p = payload;
  const tool = p.tool_name;
  if (tool !== "Read" && tool !== "Grep") return null;
  const id = typeof p.tool_use_id === "string" ? p.tool_use_id.slice(0, 200) : "";
  const input = typeof p.tool_input === "object" && p.tool_input !== null ? p.tool_input : {};
  if (p.hook_event_name === "PreToolUse") {
    const raw = tool === "Read" ? input.file_path : input.path;
    return { phase: "pre", tool, tool_use_id: id, ...typeof raw === "string" && raw ? { path: raw.slice(0, 4096) } : {} };
  }
  if (tool !== "Grep") return null;
  if (p.hook_event_name === "PostToolUse") {
    const sensitive = [...new Set(pathsIn(p.tool_response).filter(sensitiveName))].slice(0, 100).map((x) => x.slice(0, 4096));
    return { phase: "post", tool, tool_use_id: id, paths: sensitive };
  }
  if (p.hook_event_name === "PostToolUseFailure") return { phase: "failed", tool, tool_use_id: id };
  return null;
}

// src/credentials.ts
var MAX_FILE_BYTES = 16 * 1024;

// src/relay-client.ts
var RelayError = class extends Error {
  status;
  code;
  detail;
  /** The relay's Retry-After, in whole seconds (0..RETRY_AFTER_MAX_S), when it sent one. */
  retryAfter;
  constructor(status, code, detail, retryAfter) {
    super(`relay ${status} ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
};
var RelayNetworkError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "RelayNetworkError";
  }
};
var TOKEN_REFRESH_MARGIN_MS = 5 * 6e4;
var GCLOUD_OUTPUT_LIMIT = 64 * 1024;
var METADATA_OUTPUT_LIMIT = 16 * 1024;

// src/tool-util.ts
function describeError(err) {
  if (err instanceof RelayError) {
    return `relay refused (${err.status} ${err.code})${err.detail ? `: ${err.detail}` : ""}`;
  }
  if (err instanceof RelayNetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return "unexpected error";
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// src/read-trail.ts
var CAP_MS = 8e3;
var STDIN_LIMIT = 16 * 1024 * 1024;
var blocking = true;
function finish(ok, why) {
  if (!ok && blocking) {
    process.stderr.write(`team relay: this read could not be recorded (${why ?? "unknown"}), so it is not allowed
`);
    process.exit(2);
  }
  process.exit(0);
}
setTimeout(() => finish(false, "the host did not answer in time"), CAP_MS);
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (c) => {
      size += c.length;
      if (size > STDIN_LIMIT) {
        process.stdin.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(null));
  });
}
async function run() {
  const argv = process.argv.slice(2);
  const raw = await readStdin();
  let payload = null;
  try {
    payload = raw === null ? null : JSON.parse(raw);
  } catch {
    payload = null;
  }
  blocking = !isPlainObject(payload) || payload.hook_event_name === "PreToolUse";
  if (argv.length !== 2 || argv[0] !== "--config" || !argv[1]) finish(false, "usage: read-trail.js --config <file>");
  if (raw === null || payload === null) finish(false, "the hook input was not JSON");
  const report = trailReport(payload);
  if (!report) finish(true);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(argv[1], "utf8"));
  } catch (err) {
    finish(false, `its config could not be read: ${describeError(err)}`);
  }
  if (typeof cfg.socket !== "string" || typeof cfg.token !== "string") finish(false, "its config is incomplete");
  const host = await HostSocketClient.connect(cfg.socket, cfg.token);
  try {
    const res = await host.call("trail", report);
    if (!isPlainObject(res) || res.ok !== true) finish(false, "the host refused it");
  } finally {
    host.close();
  }
  finish(true);
}
run().catch((err) => finish(false, describeError(err)));
