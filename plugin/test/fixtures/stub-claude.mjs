#!/usr/bin/env node
// Stands in for the headless `claude -p` the automatic answerer runs (M8-SPEC §6). It is
// started with the host's exact command line (TEAM_RELAY_CLAUDE_BIN points here). Like Claude
// Code it reads the prompt from stdin, starts the MCP servers of --mcp-config with their env,
// and calls the host's tools; it plays Claude Code's permission flow too, calling the
// --permission-prompt-tool for a tool use no rule covers and honouring its answer.
//
// What to do comes from the prompt: a question whose text holds `STUB:{"steps":[...]}` runs
// those steps; a capability call runs the capability (after asking permission) and replies
// with its result. Steps:
//   {"permission": {"tool_name": "Read", "input": {...}}}   ask, as Claude Code would; an allowed Read then
//                                                            reads the file at updatedInput.file_path (as
//                                                            Claude Code does) and records its path and text
//   {"capability": "name"}                                   ask for mcp__capabilities__<name> with
//                                                            the call's params, run it if allowed
//   {"read": {"tool_name": "Read", "input": {...}, "response": {...}, "fail": false, "skip_post": false}}
//                                                            a tool use a rule allows (inside the
//                                                            folder): runs the settings' PreToolUse
//                                                            hooks, then (unless a hook blocked it)
//                                                            its PostToolUse or PostToolUseFailure
//                                                            hooks, as Claude Code would
//   {"host": {"tool": "list_files", "args": {...}}}           call one of the host server's own tools
//                                                            (M10 boundary mode: list_files,
//                                                            search_files)
//   {"request_approval": "reason"}
//   {"reply": {"text": "...", "needs_approval": true, ...}}  "{{decision}}" in text is replaced by
//                                                            the last permission's behavior
//   {"sleep": ms}   {"exit": code}
//   {"wait_for_file": path}   wait (polling) until the test creates that file: a run held open
//                             until the test releases it
// Every run is recorded (argv, cwd, stdin, the environment's keys, settings, mcp config with the
// token replaced, and each tool call's result) in $TMPDIR/stub-claude/<request_id>.json.

import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const stdin = await new Promise((resolve) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (buf += c));
  process.stdin.on('end', () => resolve(buf));
});

const requestId = /\b(rq_[0-9a-f]{32})\b/.exec(stdin)?.[1] ?? 'unknown';
const mcp = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8'));
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8'));
const record = {
  argv,
  cwd: process.cwd(),
  stdin,
  env: Object.keys(process.env).sort(),
  envValues: {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT,
    TEAM_RELAY_CHANNEL: process.env.TEAM_RELAY_CHANNEL,
    TEAM_RELAY_AUTO_ANSWER: process.env.TEAM_RELAY_AUTO_ANSWER,
  },
  settings,
  mcp: JSON.parse(JSON.stringify(mcp).replace(/"TEAM_RELAY_HOST_TOKEN":"[^"]*"/, '"TEAM_RELAY_HOST_TOKEN":"<token>"')),
  rubric: flag('--append-system-prompt'),
  hostTokenLength: (mcp.mcpServers?.host?.env?.TEAM_RELAY_HOST_TOKEN ?? '').length,
  calls: [],
};
const dir = join(tmpdir(), 'stub-claude');
mkdirSync(dir, { recursive: true });
// Written whole and renamed into place, so a reader never sees half a record.
const save = () => {
  const tmp = join(dir, `.${requestId}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, join(dir, `${requestId}.json`));
};
save();

async function connect(name) {
  const cfg = mcp.mcpServers[name];
  if (!cfg) return null;
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...cfg.env }, stderr: 'pipe' });
  const client = new Client({ name: 'stub-claude', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}
const host = await connect('host');
const capabilities = await connect('capabilities');
record.hostTools = host ? (await host.listTools()).tools.map((t) => t.name) : [];
save();
const text = (res) => (res.content ?? []).map((c) => c.text ?? '').join('');

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 3_600_000 });
  const out = { tool: name, args, isError: res.isError === true, text: text(res) };
  record.calls.push(out);
  save();
  return out;
}

/** Run the settings' hooks for one event and tool; resolves to the exit codes (async hooks: not awaited). */
async function runHooks(event, toolName, payload) {
  const codes = [];
  for (const group of settings.hooks?.[event] ?? []) {
    if (group.matcher !== '*' && !new RegExp(`^(?:${group.matcher})$`).test(toolName)) continue;
    for (const h of group.hooks) {
      const child = spawn(h.command, h.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      let err = '';
      child.stderr.on('data', (c) => (err += c));
      child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'stub', cwd: process.cwd(), ...payload }));
      const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, err })));
      if (h.async) continue;
      codes.push(await done);
    }
  }
  return codes;
}

let hookSeq = 0;
async function read(step) {
  const id = `toolu_read_${hookSeq++}`;
  const base = { tool_name: step.tool_name, tool_input: step.input, tool_use_id: id };
  const pre = await runHooks('PreToolUse', step.tool_name, base);
  const blocked = pre.some((r) => r.code === 2);
  const out = { tool: step.tool_name, hook: true, args: step.input, blocked, pre: pre.map((r) => r.code), stderr: pre.map((r) => r.err).join('') };
  // skip_post: the search's result is never reported (a lost PostToolUse).
  if (!blocked && !step.skip_post) {
    const post = step.fail
      ? await runHooks('PostToolUseFailure', step.tool_name, { ...base, error: 'failed' })
      : await runHooks('PostToolUse', step.tool_name, { ...base, tool_response: step.response ?? {} });
    out.post = post.map((r) => r.code);
  }
  record.calls.push(out);
  save();
}

let decision = 'none';
async function permission(toolName, input) {
  const r = await call(host, 'permission', { tool_name: toolName, input, tool_use_id: 'toolu_stub' });
  const parsed = JSON.parse(r.text);
  decision = parsed.behavior;
  if (toolName === 'Read' && parsed.behavior === 'allow') {
    // Claude Code runs the tool with the input the prompt tool returned.
    const path = parsed.updatedInput?.file_path;
    let content = null;
    try {
      content = readFileSync(path, 'utf8').slice(0, 10000);
    } catch (err) {
      content = `<unreadable: ${err.code ?? 'error'}>`;
    }
    r.read = { path, content };
    save();
  }
  return parsed;
}

let steps = [];
const script = /STUB:(\{.*\})/.exec(stdin)?.[1];
if (script) steps = JSON.parse(script).steps;
const cap = /run the capability ([a-z][a-z0-9_]*) for request (rq_[0-9a-f]{32})/.exec(stdin);
let params = {};
if (cap) {
  const m = /<<<teammate-text-[0-9a-f]+\n([\s\S]*?)\nteammate-text-[0-9a-f]+>>>/.exec(stdin);
  params = m ? JSON.parse(m[1]) : {};
  if (!script) steps = [{ capability: cap[1] }];
}

let capResult = null;
for (const step of steps) {
  if (step.permission) await permission(step.permission.tool_name, step.permission.input);
  if (step.read) await read(step.read);
  if (step.capability) {
    const input = { ...params, request_id: requestId };
    const p = await permission(`mcp__capabilities__${step.capability}`, input);
    if (p.behavior === 'allow' && capabilities) {
      const r = await call(capabilities, step.capability, p.updatedInput);
      capResult = r.isError ? { error: r.text } : JSON.parse(r.text);
    }
    await call(host, 'reply', {
      text: p.behavior === 'allow' ? `ran ${step.capability}` : `could not run ${step.capability}: ${p.message}`,
      ...(capResult ? { data: capResult } : {}),
    });
  }
  if (step.host) await call(host, step.host.tool, step.host.args ?? {});
  if (step.request_approval) await call(host, 'request_approval', { reason: step.request_approval });
  if (step.reply) {
    const args = { ...step.reply, text: step.reply.text.replace('{{decision}}', decision) };
    await call(host, 'reply', args);
  }
  if (step.sleep) await new Promise((r) => setTimeout(r, step.sleep));
  if (step.wait_for_file) {
    const until = Date.now() + 60_000;
    while (!existsSync(step.wait_for_file) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  }
  if (step.exit !== undefined) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'stub exit' }));
    process.exit(step.exit);
  }
}

process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'stub done' }));
await host?.close();
await capabilities?.close();
process.exit(0);
