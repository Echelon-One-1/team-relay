import { createRequire as __teamRelayCreateRequire } from 'node:module'; const require = __teamRelayCreateRequire(import.meta.url);

// src/answering-lock.ts
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
var LOCK_FILE = "answering.lock";
function configDir(env) {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "team-relay");
}
function lockPath(env) {
  return join(configDir(env), LOCK_FILE);
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function parseInfo(raw) {
  try {
    const v = JSON.parse(raw);
    if (typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid <= 0) return null;
    if (v.role !== "host" && v.role !== "answerer" && v.role !== "daemon") return null;
    return { pid: v.pid, role: v.role, started_at: typeof v.started_at === "string" ? v.started_at : "" };
  } catch {
    return null;
  }
}
function readLock(path, alive = pidAlive) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const info = parseInfo(raw);
  return info && alive(info.pid) ? info : null;
}

// src/answering-lock-info.ts
function main() {
  if (process.argv.length > 2) {
    process.stderr.write("usage: answering-lock-info.js\n");
    return 2;
  }
  const holder = readLock(lockPath(process.env));
  if (!holder) return 0;
  process.stdout.write(`${JSON.stringify({ pid: holder.pid, role: holder.role })}
`);
  return 3;
}
process.exitCode = main();
