// The `host` MCP server of a headless answerer (M8-SPEC §2): `node dist/answer-tools.js`,
// started by the answerer's Claude Code from the mcp.json the host wrote for that one run.
// It holds no state and decides nothing: every call goes to the host over its private Unix
// socket (host-socket.ts), authenticated with the run's token (TEAM_RELAY_HOST_SOCKET,
// TEAM_RELAY_HOST_TOKEN), and the host's decision comes back.
//
//   reply(text, data?, needs_approval?, reason?)  the answer; the host sends it or holds it
//   request_approval(reason)                      the answer must wait for the member
//   (boundary mode, M10-SPEC §3, TEAM_RELAY_HOST_MODE=boundaries: reply(text, data?, off_topic?),
//    list_files, search_files and read_google_file instead of request_approval)
//   permission(tool_name, input, tool_use_id)     Claude Code's --permission-prompt-tool:
//                                                 returns {"behavior":"allow","updatedInput":...}
//                                                 (the input, or the host's: a Read snapshot)
//                                                 or {"behavior":"deny","message":...}
//
// The answerer's settings allow reply and request_approval without a prompt; permission is
// not allowed, so the model cannot call it as a tool (Claude Code routes such a call to the
// prompt tool, and the host denies it).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HostSocketClient } from './host-socket.js';
import { makeLogger } from './log.js';
import { isPlainObject, toolError, type ToolResult } from './tool-util.js';

const log = makeLogger('answer-tools');

export const ANSWER_TOOLS = [
  {
    name: 'reply',
    description:
      'Send your answer to the teammate who asked. Call exactly once, at the end. Set needs_approval to true (with a short reason) when ' +
      'the answer is specific to people, customers, credentials, infrastructure or production, is not grounded in the working folder or ' +
      'general knowledge, or you are unsure: the member then approves it before it is sent.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 32000 },
        data: { type: 'object', description: 'Optional structured result (for example a capability tool result), at most 64 KiB as JSON.' },
        needs_approval: { type: 'boolean' },
        reason: { type: 'string', maxLength: 500 },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_approval',
    description: 'Say that your answer must wait for the member\'s approval before it is sent (for example when you are unsure). Does not block.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'permission',
    description: 'Used by Claude Code itself to ask the member about a tool use. Never call it yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name', 'input'],
    },
  },
] as const;

const PERMISSION_TOOL_DEF = ANSWER_TOOLS[2];

/**
 * M10-SPEC §3: the host's tools in boundary mode (TEAM_RELAY_HOST_MODE=boundaries): reply with
 * an off_topic flag instead of needs_approval, the three file tools, and the permission tool.
 * No request_approval: nothing waits for the member in boundary mode but a capability call.
 */
export const BOUNDARY_TOOLS = [
  {
    name: 'reply',
    description:
      'Send your answer to the teammate who asked. Call exactly once, at the end. When the question is not about the team\'s topic, ' +
      'set off_topic to true (the teammate then gets a fixed, polite decline instead of your text).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 32000 },
        data: { type: 'object', description: 'Optional structured result (for example a capability tool result), at most 64 KiB as JSON.' },
        off_topic: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description:
      'List the files you may read (absolute paths, for Read), with the areas they are in (GitHub repositories, shared drives, ' +
      'the member\'s folders). Optionally only one area, and only paths matching a glob relative to the area (for example "**/*.md"; ' +
      'without a "/", it also matches file names). At most 500 paths per call.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', maxLength: 300 },
        glob: { type: 'string', maxLength: 300 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_files',
    description:
      'Search the files you may read for lines matching an RE2 regular expression ((?i) at the start ignores case). Optionally one ' +
      'area and a glob, as for list_files. Returns path, line number and the line (clipped). Google Docs/Sheets/Slides are not searched: ' +
      'read them with read_google_file.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1, maxLength: 300 },
        area: { type: 'string', maxLength: 300 },
        glob: { type: 'string', maxLength: 300 },
        max_results: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_google_file',
    description:
      'Read a Google Doc, Sheet or Slides file from the team\'s shared drive: give the path of its .gdoc, .gsheet or .gslides file ' +
      '(from list_files). Returns its text (Docs as Markdown, Sheets as CSV, Slides as text), at most 200 KB.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  PERMISSION_TOOL_DEF,
] as const;

/** The tools this server lists: the boundary set or the M8 set. */
export function toolsFor(mode: string | undefined): ReadonlyArray<(typeof ANSWER_TOOLS)[number] | (typeof BOUNDARY_TOOLS)[number]> {
  return mode === 'boundaries' ? BOUNDARY_TOOLS : ANSWER_TOOLS;
}

/**
 * The exact text --permission-prompt-tool must return. On allow, `updatedInput` is the host's
 * (M10-SPEC §7.3: a Read pointed at the host's snapshot copy), else `input` unchanged.
 */
export function permissionResult(decision: unknown, input: unknown): string {
  const d = isPlainObject(decision) ? decision : {};
  if (d.allow === true) return JSON.stringify({ behavior: 'allow', updatedInput: isPlainObject(d.updatedInput) ? d.updatedInput : input });
  const message = typeof d.message === 'string' && d.message ? d.message : 'The member did not allow this.';
  return JSON.stringify({ behavior: 'deny', message });
}

async function main(): Promise<void> {
  const path = process.env.TEAM_RELAY_HOST_SOCKET ?? '';
  const token = process.env.TEAM_RELAY_HOST_TOKEN ?? '';
  if (!path || !token) {
    log('TEAM_RELAY_HOST_SOCKET and TEAM_RELAY_HOST_TOKEN are required');
    process.exit(1);
  }
  let host: HostSocketClient;
  try {
    host = await HostSocketClient.connect(path, token);
  } catch (err) {
    log(`cannot reach the host: ${err instanceof Error ? err.message : 'error'}`);
    process.exit(1);
  }

  const server = new Server({ name: 'host', version: '0.1.0' }, { capabilities: { tools: {} } });
  const mode = process.env.TEAM_RELAY_HOST_MODE;
  const listed = toolsFor(mode);
  const names = new Set<string>(listed.map((t) => t.name));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed.map((t) => ({ ...t })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<ToolResult> => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    if (!isPlainObject(args)) return toolError('arguments must be an object');
    try {
      if (name === 'permission') {
        const decision = await host.call('permission', {
          tool_name: args.tool_name,
          input: args.input,
          tool_use_id: args.tool_use_id,
        });
        return { content: [{ type: 'text', text: permissionResult(decision, args.input) }] };
      }
      if (!names.has(name)) return toolError(`unknown tool: ${name}`);
      if (name === 'reply' || name === 'request_approval') {
        const result = await host.call(name, args);
        const r = isPlainObject(result) ? result : {};
        const text = typeof r.message === 'string' ? r.message : 'done';
        return r.ok === false ? toolError(text) : { content: [{ type: 'text', text }] };
      }
      if (name === 'list_files' || name === 'search_files' || name === 'read_google_file') {
        // The host answers {ok, result} or {ok: false, message}; only it sees the files.
        const out = await host.call(name, args);
        const r = isPlainObject(out) ? out : {};
        if (r.ok !== true) return toolError(typeof r.message === 'string' ? r.message : 'failed');
        return { content: [{ type: 'text', text: JSON.stringify(r.result ?? {}) }] };
      }
      return toolError(`unknown tool: ${name}`);
    } catch (err) {
      // For the prompt tool, a failure is a denial, never an allow.
      if (name === 'permission') {
        return { content: [{ type: 'text', text: permissionResult({ allow: false, message: 'The team relay host is not reachable.' }, args.input) }] };
      }
      return toolError(err instanceof Error ? err.message : 'failed');
    }
  });

  const shutdown = () => {
    host.close();
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && /answer-tools\.(js|ts)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.message : 'error'}`);
    process.exit(1);
  });
}
