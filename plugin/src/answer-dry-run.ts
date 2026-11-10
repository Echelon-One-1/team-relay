// `node dist/answer-dry-run.js`: show, and optionally smoke-check, exactly what the automatic
// answerer (M8-SPEC §2) runs for a question asked in the current folder. Nothing is ever sent
// to the relay and nothing is read from the inbox.
//
//   node dist/answer-dry-run.js [--question TEXT]           print the scope decision, the child
//                                                          command line, settings.json and mcp.json
//   node dist/answer-dry-run.js --run [--offline] [...]     also run it: the real `claude` (or
//                                                          TEAM_RELAY_CLAUDE_BIN) with those exact
//                                                          flags, against a local host that prints
//                                                          each tool call, denies every permission
//                                                          request and sends nothing
//
// --offline points the run's Anthropic API at a closed local port (ANTHROPIC_BASE_URL), so it
// makes no model call: Claude Code still parses every flag, loads the settings, starts both MCP
// servers and binds the permission prompt tool, then fails at its first API request. A flag,
// settings or MCP problem shows up as a different error. It also turns off Claude Code's retries
// (CLAUDE_CODE_MAX_RETRIES=0) and caps a request at 5 s (API_TIMEOUT_MS): with its default
// retries a refused connection takes about three minutes to fail, with these about a second.
// (A Claude Code signed in to a cloud provider does not use ANTHROPIC_BASE_URL; there --offline
// makes a real call.)
//
// The same preparation and run (prepareDryRun, executeDryRun) are the background answerer's
// self-test (M11-SPEC §3, daemon.ts): the boundary-mode child, against a host that denies every
// tool, with a relay address that leads nowhere.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { planRun, draftReasons, type HostConnection, type RunPlan } from './answer-host.js';
import { runChild, type ChildRun, type WorkItem } from './headless.js';
import { HostSocket } from './host-socket.js';
import { MEMBER_RE, connectionFromEnv } from './relay-client.js';
import { scopeFolder, type Scope } from './scope.js';
import { isPlainObject } from './tool-util.js';

const USAGE = 'usage: answer-dry-run.js [--question TEXT] [--run [--offline]]';

/** A relay address nothing answers on: a dry run never reaches a relay. */
export const NOWHERE_RELAY: HostConnection = { mode: 'token', url: 'http://127.0.0.1:9', team: 'demo', token: 'dry-run-token' };

function shellQuote(a: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

function parse(argv: string[]): { question: string; run: boolean; offline: boolean } {
  const o = { question: 'Dry run: what does this folder contain? Answer in one sentence.', run: false, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--run') o.run = true;
    else if (a === '--offline') o.offline = true;
    else if (a === '--question' && argv[i + 1] !== undefined) o.question = argv[++i]!;
    else {
      process.stderr.write(`${USAGE}\n`);
      process.exit(2);
    }
  }
  if (o.offline && !o.run) o.run = true;
  return o;
}

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** What an offline run adds to the child's environment (see the header); nothing else changes. */
export function offlineEnv(port: number): Record<string, string> {
  return { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '5000' };
}

export type DryRunInput = {
  env: NodeJS.ProcessEnv;
  question: string;
  /** The folder the question is asked in (the scope folder in folder mode). */
  cwd: string;
  connection: HostConnection;
  member: string;
  claudeBin: string;
  /** Where the bundles are (dist/). */
  dist: string;
  node?: string;
  /** Boundary mode (M10-SPEC §3): the child the background answerer runs. */
  boundaries?: { teamName: string; topic: string };
  /** False offers the child no capability server. */
  capabilities?: boolean;
};

export type PreparedDryRun = { plan: RunPlan; scope: Scope; socket: HostSocket; runDir: string };

/** Everything one dry run needs, written as the host writes it for a real run. */
export function prepareDryRun(i: DryRunInput): PreparedDryRun {
  const scope = scopeFolder(i.cwd, i.env);
  const socket = new HostSocket();
  const runDir = mkdtempSync(join(socket.dir, 'run-'));
  const item: WorkItem = {
    request_id: `rq_${'0'.repeat(32)}`,
    from: 'teammate',
    kind: 'question',
    question: i.question,
    answer_deadline: Date.now() + 15 * 60_000,
  };
  try {
    const plan = planRun({
      item,
      runDir,
      socket: { path: socket.path, dir: socket.dir },
      scope,
      env: i.env,
      connection: i.connection,
      member: i.member,
      dist: i.dist,
      node: i.node ?? process.execPath,
      claudeBin: i.claudeBin,
      ...(i.boundaries ? { boundaries: i.boundaries } : {}),
      ...(i.capabilities === false ? { capabilities: false } : {}),
    });
    return { plan, scope, socket, runDir };
  } catch (err) {
    void socket.close();
    throw err;
  }
}

/** Remove what prepareDryRun made (the socket's private directory holds the run's). */
export async function disposeDryRun(p: PreparedDryRun): Promise<void> {
  await p.socket.close().catch(() => {});
  rmSync(p.runDir, { recursive: true, force: true });
  rmSync(p.socket.dir, { recursive: true, force: true });
}

/**
 * Run the prepared child against a host that records each tool call, denies every permission
 * request, reads nothing and sends nothing. `offline`: no model call (see the header).
 */
export async function executeDryRun(
  p: PreparedDryRun,
  o: { offline: boolean; limitMs?: number; signal?: AbortSignal },
): Promise<{ result: ChildRun; calls: string[] }> {
  const { plan, socket } = p;
  await socket.listen();
  const calls: string[] = [];
  socket.setRun(plan.token, async (method, params) => {
    const q = isPlainObject(params) ? params : {};
    if (method === 'permission') {
      calls.push(`permission ${String(q.tool_name)} ${JSON.stringify(q.input).slice(0, 300)} -> denied (dry run)`);
      return { allow: false, message: 'Dry run: every permission request is denied.' };
    }
    if (method === 'request_approval') {
      calls.push(`request_approval ${JSON.stringify(q.reason)}`);
      return { ok: true, message: 'Noted (dry run).' };
    }
    if (method === 'list_files' || method === 'search_files' || method === 'read_google_file') {
      calls.push(`${method} -> refused (dry run)`);
      return { ok: false, message: 'Dry run: nothing can be read.' };
    }
    if (method === 'reply') {
      const text = typeof q.text === 'string' ? q.text : '';
      const data = isPlainObject(q.data) ? q.data : null;
      const reasons = draftReasons({
        needsApproval: q.needs_approval === true,
        reason: typeof q.reason === 'string' ? q.reason : null,
        requested: null,
        approvalDuringRun: calls.some((c) => c.startsWith('permission')),
        text,
        data,
      });
      calls.push(`reply ${JSON.stringify(text.slice(0, 500))} -> ${reasons.length ? `would wait for approval: ${reasons.join('; ')}` : 'would be sent automatically'} (nothing sent: dry run)`);
      return { ok: true, message: 'Dry run: nothing was sent.' };
    }
    if (method === 'trail') return { ok: true };
    throw new Error(`unknown method ${method}`);
  });
  const runEnv = { ...plan.env };
  if (o.offline) Object.assign(runEnv, offlineEnv(await closedPort()));
  const result = await runChild({
    bin: plan.bin,
    args: plan.args,
    cwd: plan.cwd,
    env: runEnv,
    stdin: plan.stdin,
    limitMs: o.limitMs ?? 5 * 60_000,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  socket.clearRun();
  return { result, calls };
}

async function main(): Promise<void> {
  const opts = parse(process.argv.slice(2));
  const env = { ...process.env };
  let connection: HostConnection = NOWHERE_RELAY;
  let member = 'member';
  try {
    const c = connectionFromEnv(env);
    connection = { mode: c.mode, url: c.url, team: c.team };
    if (c.member && MEMBER_RE.test(c.member)) member = c.member;
  } catch {
    // not signed in: a placeholder relay (nothing is sent anyway)
  }
  const claudeBin = env.TEAM_RELAY_CLAUDE_BIN?.trim() || 'claude';
  const prepared = prepareDryRun({ env, question: opts.question, cwd: process.cwd(), connection, member, claudeBin, dist: import.meta.dirname });
  const { plan, scope } = prepared;
  const redact = (text: string) => text.split(plan.token).join('<per-run token>');
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out(`scope folder: ${scope.path}`);
  out(scope.qualifies ? `reads inside it are automatic; shared as "${scope.share}"` : `no automatic reads: ${scope.reason}`);
  out(`working directory: ${plan.cwd}`);
  out();
  out('command (the prompt goes on stdin):');
  out(`cd ${shellQuote(plan.cwd)} && ${[plan.bin, ...plan.args].map(shellQuote).join(' ')}`);
  out();
  out(`settings.json:\n${readFileSync(plan.files.settings, 'utf8')}`);
  out(`mcp.json:\n${redact(readFileSync(plan.files.mcpConfig, 'utf8'))}`);
  out(`environment kept: ${Object.keys(plan.env).sort().join(' ')}`);
  if (!opts.run) {
    await disposeDryRun(prepared);
    return;
  }
  out(opts.offline ? 'running offline (no model call)…' : 'running (this makes a model call)…');
  const { result, calls } = await executeDryRun(prepared, { offline: opts.offline });
  await disposeDryRun(prepared);
  out(`exit: ${result.code ?? result.signal}${result.timedOut ? ' (timed out)' : ''}`);
  for (const c of calls) out(`tool call: ${c}`);
  if (result.result) {
    const r = result.result;
    out(`result: type=${String(r.type)} subtype=${String(r.subtype)} is_error=${String(r.is_error)}`);
    if (typeof r.result === 'string') out(`result text: ${r.result.slice(0, 600)}`);
  } else {
    out('no JSON result on stdout');
    if (result.stderrTail) out(`stderr: ${redact(result.stderrTail).slice(-1500)}`);
  }
}

if (process.argv[1] && /answer-dry-run\.[jt]s$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`answer-dry-run: ${err instanceof Error ? err.message : 'failed'}\n`);
    process.exit(1);
  });
}
