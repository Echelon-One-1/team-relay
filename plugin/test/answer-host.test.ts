// M8-SPEC §1–§6 through the bundled channel server (node dist/channel.js), playing a channel
// working session, with the stub `claude` (test/fixtures/stub-claude.mjs) standing in for the
// headless answerer: it reads the prompt and calls the host's tools as scripted. The relay is
// the fake one. Every approval is decided through MCP elicitation by this test's client (or
// the fallback page), never by a tool call.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AnswerHost, BUSY_REPLY, NOT_SET_UP_REPLY, OUTSIDE_SET } from '../src/answer-host.js';
import { boundaryRubric, childArgs, rubric } from '../src/headless.js';
import { resolveClaudeBin } from '../src/locate.js';
import { RelayClient } from '../src/relay-client.js';
import { scopeFolder } from '../src/scope.js';
import { BOUNDARIES, FOLDERS, MY_FOLDER, REPO_ROOT, TOPIC, makeFixture, writeFolders, type Fixture } from './helpers/boundary-fixture.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST, FIXTURES, baseEnv, sleep, textOf, until, waitFor } from './helpers/mcp.js';

const STUB = join(FIXTURES, 'stub-claude.mjs');
const RUNNER = join(FIXTURES, 'fake-runner.mjs');
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

type Note = { content: string; meta: Record<string, string> };
/** The member's choice in a dialog; null presses the dialog's own Decline. */
type Decide = (message: string) => string | null;
type Session = {
  client: Client;
  notes: Note[];
  elicited: string[];
  stderr: () => string;
  close: () => Promise<void>;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: Record<string, unknown> }>;
};

let relay: FakeRelay;
let tmp: string;
let xdg: string;
let proj: string;
const open: Session[] = [];

beforeEach(async () => {
  relay = await new FakeRelay().start();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tr-m8-')));
  xdg = join(tmp, 'xdg');
  mkdirSync(xdg, { mode: 0o700 });
  proj = join(tmp, 'project');
  // M8-SPEC §7 item 3: a folder qualifies only inside a git work tree.
  mkdirSync(join(proj, '.git'), { recursive: true });
  writeFileSync(join(proj, 'NOTES.md'), 'The staging bucket lives in europe-west3.\n');
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await relay.stop();
});

/** bob's channel working session in `cwd`, answering automatically. */
async function session(opts: { cwd?: string; decide?: Decide | null; env?: Record<string, string> } = {}): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(DIST, 'channel.js')],
    cwd: opts.cwd ?? proj,
    env: baseEnv({
      RELAY_URL: relay.url,
      RELAY_TEAM: 'demo',
      RELAY_TOKEN: TOKEN_OF.bob!,
      RELAY_ROLE: 'asker',
      TEAM_RELAY_AUTO_ANSWER: '1',
      TEAM_RELAY_CLAUDE_BIN: STUB,
      TMPDIR: tmp,
      XDG_CONFIG_HOME: xdg,
      ...opts.env,
    }),
    stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const decide = opts.decide === undefined ? () => null : opts.decide;
  const client = new Client({ name: 'test-claude-code', version: '0.0.0' }, { capabilities: decide ? { elicitation: {} } : {} });
  const notes: Note[] = [];
  const elicited: string[] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') notes.push(n.params as Note);
  };
  if (decide) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const message = (req.params as { message: string }).message;
      elicited.push(message);
      const d = decide(message);
      return d === null ? { action: 'decline' } : { action: 'accept', content: { decision: d } };
    });
  }
  await client.connect(transport);
  const s: Session = {
    client,
    notes,
    elicited,
    stderr: () => err,
    close: async () => {
      await client.close().catch(() => {});
    },
    call: async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      const text = textOf(res);
      return { isError: res.isError === true, text, json: res.isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
    },
  };
  open.push(s);
  // Answering starts once the session is connected and holds the lock.
  await until(() => relay.requests.some((r) => r.path.endsWith('/streams/inbox') && r.member === 'bob'));
  return s;
}

/** alice asks bob; the envelope lands in bob's inbox. */
function ask(question: string, answerMs = 600_000): string {
  const id = relay.addRequest({ kind: 'question', asker: 'alice', question, recipients: { bob: { status: 'pending' } }, answer_deadline: iso(answerMs) });
  relay.enqueue('bob', 'inbox', { type: 'question', from: 'alice', request_id: id, data: { question, ack_deadline: iso(60_000), answer_deadline: iso(answerMs) } });
  return id;
}

const script = (steps: unknown[]) => `STUB:${JSON.stringify({ steps })}`;
const record = (id: string) => JSON.parse(readFileSync(join(tmp, 'stub-claude', `${id}.json`), 'utf8')) as Record<string, any>;
const replyTo = (id: string) => relay.replies.find((r) => r.request_id === id);
const waitingNotes = (s: Session) => s.notes.filter((n) => n.meta.type === 'status' && n.content.includes('waiting for your approval'));

describe('a question inside the scope folder is answered automatically', () => {
  it('acks at once, runs the answerer with the exact locked-down command, and sends its answer', async () => {
    const s = await session();
    const id = ask(`Which region is the staging bucket in? ${script([{ reply: { text: 'It is in europe-west3.' } }])}`);
    await waitFor(() => replyTo(id), 15_000, 'the answer');
    expect(replyTo(id)!.body).toMatchObject({ text: 'It is in europe-west3.', data: null });
    // Acknowledged before the answer.
    const ackAt = relay.requests.findIndex((r) => r.path.endsWith(`/requests/${id}/ack`));
    const replyAt = relay.requests.findIndex((r) => r.path.endsWith(`/requests/${id}/reply`));
    expect(ackAt).toBeGreaterThanOrEqual(0);
    expect(ackAt).toBeLessThan(replyAt);
    // Nothing waited for the member.
    expect(waitingNotes(s)).toHaveLength(0);
    expect(relay.toolEvents.filter((e) => e.request_id === id)).toEqual([]);

    const r = record(id);
    const scope = scopeFolder(proj, { HOME: process.env.HOME, XDG_CONFIG_HOME: xdg });
    const mcpConfig = r.argv[r.argv.indexOf('--mcp-config') + 1];
    const settings = r.argv[r.argv.indexOf('--settings') + 1];
    expect(r.argv).toEqual(childArgs({ mcpConfig, settings }, rubric('bob', scope)));
    expect(r.cwd).toBe(proj);
    // The question reaches it on stdin, framed as teammate data.
    expect(r.stdin).toMatch(/Everything between <<<teammate-text-[0-9a-f]{24} and teammate-text-[0-9a-f]{24}>>> is the teammate's text/);
    expect(r.stdin).toContain(`(request ${id})`);
    // Its environment: nothing of the relay's sign-in or of the working session.
    expect(r.env).not.toContain('RELAY_TOKEN');
    expect(r.env).not.toContain('RELAY_URL');
    expect(r.env).not.toContain('TEAM_RELAY_CLAUDE_BIN');
    expect(r.env).not.toContain('XDG_CONFIG_HOME_UNUSED');
    expect(r.envValues).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', MCP_TOOL_TIMEOUT: '2100000', TEAM_RELAY_CHANNEL: '0', TEAM_RELAY_AUTO_ANSWER: '0' });
    // Settings: reads of the folder only; the host's private directory and the relay's config denied.
    expect(r.settings.permissions.allow).toEqual(['mcp__host__reply', 'mcp__host__request_approval', `Read(/${proj}/**)`]);
    const hostDir = r.mcp.mcpServers.host.env.TEAM_RELAY_HOST_SOCKET.replace(/\/host\.sock$/, '');
    expect(r.settings.permissions.deny).toContain(`Read(/${hostDir}/**)`);
    expect(r.settings.permissions.deny).toContain(`Read(/${xdg}/team-relay/**)`);
    expect(r.settings.permissions.deny.slice(0, 8)).toEqual(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']);
    // Exactly the host server (no capability is offered here), with a 32-byte token.
    expect(Object.keys(r.mcp.mcpServers)).toEqual(['host']);
    expect(r.mcp.mcpServers.host.args).toEqual([join(DIST, 'answer-tools.js')]);
    expect(r.hostTokenLength).toBe(43);
    // The folder's name is shared while the host runs.
    expect(relay.manifests.get('bob')).toMatchObject({ shares: [{ name: 'project' }] });
    // whoami says so.
    const who = await s.call('whoami');
    expect(who.json).toMatchObject({ answering_automatically: true, answering_folder: 'project', approvals_pending: 0 });
  });

  it('the answer is sent once: a second reply from the same run is refused', async () => {
    await session();
    const id = ask(script([{ reply: { text: 'one' } }, { reply: { text: 'two' } }]));
    await waitFor(() => existsSync(join(tmp, 'stub-claude', `${id}.json`)) && record(id).calls.length === 2, 15_000, 'both replies');
    expect(relay.replies.filter((r) => r.request_id === id).map((r) => r.body.text)).toEqual(['one']);
    expect(record(id).calls[1]).toMatchObject({ isError: true, text: 'You have already replied; reply only once.' });
  });
});

describe('what waits for the member (M8-SPEC §3, §4)', () => {
  it('a read outside the folder waits until approved in the dialog; the answer then waits too', async () => {
    const decisions = ['allow', 'send'];
    const s = await session({ decide: () => decisions.shift()! });
    const id = ask(`What is in /etc/hosts? ${script([{ permission: { tool_name: 'Read', input: { file_path: '/etc/hosts' } } }, { reply: { text: 'read: {{decision}}' } }])}`);
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    const notice = waitingNotes(s)[0]!;
    expect(notice.meta).toEqual({ type: 'status' });
    expect(notice.content).toMatch(/^team-relay: alice asked: "What is in \/etc\/hosts\? STUB:.*" — an answer is waiting for your approval \(1 pending\)\. Run \/team-relay:approvals\.$/);
    await waitFor(() => relay.toolEvents.find((e) => e.request_id === id), 5000, 'the waiting tool event');
    expect(relay.toolEvents.filter((e) => e.request_id === id).map((e) => e.body)).toEqual([{ tool: 'Read', status: 'waiting', duration_ms: null }]);
    expect(replyTo(id)).toBeUndefined();
    // Counts reach whoami, the state file and a SessionStart line elsewhere.
    expect((await s.call('whoami')).json).toMatchObject({ approvals_pending: 1, approvals_notice: '1 answer waiting for your approval: run /team-relay:approvals' });
    const line = await sessionStart();
    expect(line).toContain('1 answer waiting for your approval: run /team-relay:approvals in your channel working session.');

    // The member reviews: the dialog decides; the model only gets counts.
    const first = await s.call('review_approvals');
    expect(first.json.message).toMatch(/^Reviewed 1: 1 allowed\./);
    expect(s.elicited[0]).toContain('alice asked (teammate text, as they wrote it):');
    // §7 item 6: where the path really leads (on macOS /etc is a link to /private/etc).
    const hosts = realpathSync('/etc/hosts');
    expect(s.elicited[0]).toContain(`Your automatic answerer wants to read the file ${hosts === '/etc/hosts' ? hosts : `/etc/hosts → ${hosts}`}.`);
    // The stub was allowed, read, and replied: that draft waits, since an approval was needed.
    await waitFor(() => waitingNotes(s).length === 2, 15_000, 'the draft notice');
    expect(replyTo(id)).toBeUndefined();
    const second = await s.call('review_approvals');
    expect(second.json.message).toBe('Reviewed 1: 1 answer sent. Nothing else is waiting.');
    expect(s.elicited[1]).toContain('> read: allow');
    expect(s.elicited[1]).toContain('it needed your permission for a step while it worked');
    await waitFor(() => replyTo(id), 5000, 'the approved answer');
    expect(replyTo(id)!.body.text).toBe('read: allow');
    expect((await s.call('whoami')).json).toMatchObject({ approvals_pending: 0 });
  });

  it('a flagged draft waits; "Decline politely" sends the fixed sentence', async () => {
    const s = await session({ decide: () => 'decline' });
    const id = ask(script([{ reply: { text: 'Customer X pays 40k a month.', needs_approval: true, reason: 'customer data' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    // The notice (stdio) and the tool event (HTTP) are sent side by side: wait for the event itself.
    await waitFor(() => relay.toolEvents.find((e) => e.request_id === id), 5000, 'the waiting tool event');
    expect(relay.toolEvents.filter((e) => e.request_id === id).map((e) => e.body)).toEqual([{ tool: 'approval', status: 'waiting', duration_ms: null }]);
    expect(replyTo(id)).toBeUndefined();
    const r = await s.call('review_approvals');
    expect(r.json.message).toBe('Reviewed 1: 1 declined politely. Nothing else is waiting.');
    // §7 item 9: the answerer's reason, labelled as its own words.
    expect(s.elicited[0]).toContain(`the answerer flagged it (in the answerer's own words: "customer data")`);
    await waitFor(() => replyTo(id), 5000, 'the polite decline');
    expect(replyTo(id)!.body.text).toBe("I couldn't answer this automatically; bob hasn't approved it.");
  });

  it('a draft the secret screen flags waits; "Don\'t send" sends nothing', async () => {
    const s = await session({ decide: () => 'dont_send' });
    const id = ask(script([{ reply: { text: 'Use DB_PASSWORD=hunter2hunter2 for staging.' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain('the secret screen found a secret-looking KEY=value pair');
    await sleep(500);
    expect(replyTo(id)).toBeUndefined();
    await waitFor(() => relay.toolEvents.some((e) => e.request_id === id && (e.body as { status: string }).status === 'error'), 5000, 'the cleared waiting');
  });

  it('request_approval makes the answer wait', async () => {
    const s = await session({ decide: () => 'send' });
    const id = ask(script([{ request_approval: 'not sure' }, { reply: { text: 'Probably Tuesday.' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain(`the answerer asked for your approval (in the answerer's own words: "not sure")`);
    await waitFor(() => replyTo(id), 5000, 'the answer');
  });

  it('a capability call waits for the member before it runs; its result then waits too', async () => {
    const decisions = ['allow', 'send'];
    const s = await session({ decide: () => decisions.shift()!, env: { CAP_SERVICE_HEALTH_ENABLED: 'true', CAP_SERVICE_HEALTH_RUNNER: RUNNER } });
    expect((relay.manifests.get('bob') as { capabilities: Array<{ name: string }> }).capabilities.map((c) => c.name)).toEqual(['service_health']);
    const params = { service: 'api' };
    const id = relay.addRequest({ kind: 'capability', asker: 'alice', capability: { name: 'service_health', params }, recipients: { bob: { status: 'pending' } } });
    relay.enqueue('bob', 'inbox', { type: 'capability_call', from: 'alice', request_id: id, data: { capability: 'service_health', params, ack_deadline: iso(60_000), answer_deadline: iso(600_000) } });
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    expect(waitingNotes(s)[0]!.content).toContain('alice asked: "run service_health {"service":"api"}"');
    // The waiting tool event is posted beside the notice, not before it: wait for it.
    await waitFor(() => relay.toolEvents.some((e) => e.request_id === id), Infinity, 'the waiting tool event');
    expect(relay.toolEvents.filter((e) => e.request_id === id).map((e) => e.body)).toEqual([{ tool: 'service_health', status: 'waiting', duration_ms: null }]);
    // Nothing ran yet.
    expect(relay.progress.filter((p) => p.request_id === id)).toEqual([]);
    const r = record(id);
    expect(Object.keys(r.mcp.mcpServers)).toEqual(['host', 'capabilities']);
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain('alice asked you to run service_health with these params (teammate data):');
    expect(s.elicited[0]).toContain('wants to run service_health with {"service":"api"} for this capability call');
    await waitFor(() => waitingNotes(s).length === 2, 15_000, 'the draft notice');
    expect(relay.progress.filter((p) => p.request_id === id).length).toBeGreaterThan(0);
    expect(replyTo(id)).toBeUndefined();
    await s.call('review_approvals');
    await waitFor(() => replyTo(id), 5000, 'the answer');
    expect(replyTo(id)!.body).toMatchObject({ text: 'ran service_health', data: { capability: 'service_health', service: 'api', healthy: true } });
  });

  it('a question cannot run a capability, and credentials and other tools are denied without asking', async () => {
    const s = await session({ env: { CAP_SERVICE_HEALTH_ENABLED: 'true', CAP_SERVICE_HEALTH_RUNNER: RUNNER } });
    const id = ask(
      script([
        { capability: 'service_health' },
        { permission: { tool_name: 'Read', input: { file_path: join(process.env.HOME ?? '/home/u', '.ssh', 'id_ed25519') } } },
        { permission: { tool_name: 'Read', input: { file_path: join(proj, '.env') } } },
        { permission: { tool_name: 'Bash', input: { command: 'cat /etc/passwd' } } },
        { permission: { tool_name: 'mcp__host__permission', input: {} } },
      ]),
    );
    await waitFor(() => existsSync(join(tmp, 'stub-claude', `${id}.json`)) && record(id).calls.filter((c: any) => c.tool === 'permission').length === 5, 15_000, 'the denials');
    const denials = record(id).calls.filter((c: any) => c.tool === 'permission').map((c: any) => JSON.parse(c.text));
    expect(denials.map((d: any) => d.behavior)).toEqual(['deny', 'deny', 'deny', 'deny', 'deny']);
    expect(denials[0].message).toBe('Capabilities run only for a capability call, never for a question.');
    expect(denials[1].message).toMatch(/never readable/);
    expect(denials[2].message).toMatch(/never readable/);
    expect(denials[3].message).toBe('Bash is not available when answering automatically.');
    // The member was never asked about any of them: only the draft that followed waits.
    await waitFor(() => waitingNotes(s).length === 1, 5000, 'the draft notice');
    await waitFor(() => relay.toolEvents.find((e) => e.request_id === id), 5000, 'the waiting tool event');
    expect(relay.toolEvents.filter((e) => e.request_id === id).map((e) => e.body)).toEqual([{ tool: 'approval', status: 'waiting', duration_ms: null }]);
    expect(s.elicited).toHaveLength(0);
  });

  it('a lapse sends nothing: an approval nobody gives is denied at the deadline', async () => {
    const s = await session({ decide: null });
    const id = ask(script([{ permission: { tool_name: 'Read', input: { file_path: '/etc/hosts' } } }, { reply: { text: 'read: {{decision}}' } }]), 4000);
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await waitFor(() => existsSync(join(tmp, 'stub-claude', `${id}.json`)) && record(id).calls.some((c: any) => c.tool === 'reply'), 15_000, 'the answerer to go on');
    const perm = record(id).calls.find((c: any) => c.tool === 'permission');
    expect(JSON.parse(perm.text)).toEqual({ behavior: 'deny', message: 'The member did not allow this in time. Answer without it, or say you could not.' });
    await sleep(1000);
    expect(replyTo(id)).toBeUndefined();
    expect((await s.call('whoami')).json).toMatchObject({ approvals_pending: 0 });
    await waitFor(() => relay.toolEvents.some((e) => e.request_id === id && (e.body as { status: string }).status === 'error'), 5000, 'the cleared waiting');
    expect(relay.toolEvents.filter((e) => e.request_id === id).map((e) => (e.body as { tool: string; status: string }).status)).toEqual(
      expect.arrayContaining(['waiting', 'error']),
    );
  });
});

describe('the read trail (M8-SPEC §7 item 1)', () => {
  it('an answer after reading an ordinary file in the folder ships on its own; the hook reported the read', async () => {
    const s = await session();
    const id = ask(script([{ read: { tool_name: 'Read', input: { file_path: join(proj, 'NOTES.md') } } }, { reply: { text: 'europe-west3' } }]));
    await waitFor(() => replyTo(id), 15_000, 'the answer');
    const r = record(id);
    const hook = r.calls.find((c: any) => c.hook);
    expect(hook).toMatchObject({ blocked: false, pre: [0] });
    expect(waitingNotes(s)).toHaveLength(0);
  });

  it('an answer after reading a file whose name suggests secrets waits, whatever the answerer says', async () => {
    writeFileSync(join(proj, 'secrets.yaml'), 'db: staging\n');
    const s = await session({ decide: () => 'dont_send' });
    const id = ask(script([{ read: { tool_name: 'Read', input: { file_path: join(proj, 'secrets.yaml') } } }, { reply: { text: 'The db is staging.' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    expect(replyTo(id)).toBeUndefined();
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain('it read files whose names suggest secrets (secrets.yaml)');
  });

  it('a search whose matches include such a file makes the answer wait too', async () => {
    const s = await session({ decide: () => 'dont_send' });
    const response = { mode: 'content', filenames: [], content: `${join(proj, 'infra', 'terraform.tfstate')}:12:  "password": "x"` };
    const id = ask(script([{ read: { tool_name: 'Grep', input: { pattern: 'password', path: proj }, response } }, { reply: { text: 'Nothing interesting.' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain('it read files whose names suggest secrets (terraform.tfstate)');
    expect(replyTo(id)).toBeUndefined();
  });

  it('a search whose result was never reported makes the answer wait (the trail fails closed)', async () => {
    const s = await session({ decide: () => 'dont_send' });
    const id = ask(script([{ read: { tool_name: 'Grep', input: { pattern: 'x', path: proj }, skip_post: true } }, { reply: { text: 'Nothing.' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain('what one of its searches read could not be recorded');
    expect(replyTo(id)).toBeUndefined();
  });

  it('a search that failed, or matched only ordinary files, does not hold the answer', async () => {
    await session();
    const id = ask(
      script([
        { read: { tool_name: 'Grep', input: { pattern: 'x', path: proj }, fail: true } },
        { read: { tool_name: 'Grep', input: { pattern: 'bucket', path: proj }, response: { mode: 'files_with_matches', filenames: [join(proj, 'NOTES.md')] } } },
        { reply: { text: 'In NOTES.md.' } },
      ]),
    );
    await waitFor(() => replyTo(id), 15_000, 'the answer');
  });
});

describe('what the member is asked (M8-SPEC §7 items 6, 7)', () => {
  it('a path that resolves elsewhere is shown with where it really leads', async () => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'x.txt'), 'x\n');
    symlinkSync(join(outside, 'x.txt'), join(proj, 'link'));
    const s = await session({ decide: () => 'deny' });
    const id = ask(script([{ permission: { tool_name: 'Read', input: { file_path: join(proj, 'link') } } }, { reply: { text: 'no' } }]));
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    expect(s.elicited[0]).toContain(`Your automatic answerer wants to read the file ${join(proj, 'link')} → ${join(outside, 'x.txt')}.`);
    await waitFor(() => record(id).calls.some((c: any) => c.tool === 'reply'), 15_000, 'the reply');
  });

  it('a Glob or Grep glob with a fixed prefix on the deny list is denied without asking', async () => {
    const home = process.env.HOME ?? '/home/u';
    const s = await session();
    const id = ask(
      script([
        { permission: { tool_name: 'Glob', input: { pattern: join(home, '.ssh', '*') } } },
        { permission: { tool_name: 'Glob', input: { pattern: '~/.aws/**' } } },
        { permission: { tool_name: 'Glob', input: { pattern: '.kube/*', path: home } } },
        { permission: { tool_name: 'Glob', input: { pattern: '/srv/app/**/*.pem' } } },
        { permission: { tool_name: 'Grep', input: { pattern: 'x', path: '/srv', glob: join(home, '.config', 'gcloud', '**') } } },
        { reply: { text: 'none' } },
      ]),
    );
    await waitFor(() => existsSync(join(tmp, 'stub-claude', `${id}.json`)) && record(id).calls.some((c: any) => c.tool === 'reply'), 15_000, 'the reply');
    const denials = record(id).calls.filter((c: any) => c.tool === 'permission').map((c: any) => JSON.parse(c.text));
    expect(denials.map((d: any) => d.behavior)).toEqual(['deny', 'deny', 'deny', 'deny', 'deny']);
    for (const d of denials) expect(d.message).toMatch(/never readable/);
    expect(s.elicited).toHaveLength(0);
  });
});

describe('taking over answering (M8-SPEC §7 item 4)', () => {
  it('is announced in the working session', async () => {
    const s = await session();
    await waitFor(() => s.notes.find((n) => n.content.includes('now answers teammates automatically')), 5000, 'the announcement');
    const note = s.notes.find((n) => n.content.includes('now answers teammates automatically'))!;
    expect(note.meta).toEqual({ type: 'status' });
    expect(note.content).toBe(`team-relay: This session now answers teammates automatically from ${proj}; reads inside it are automatic.`);
  });

  it('says so when reads are not automatic', async () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    const s = await session({ cwd: plain });
    await waitFor(() => s.notes.find((n) => n.content.includes('now answers teammates automatically')), 5000, 'the announcement');
    expect(s.notes.find((n) => n.content.includes('now answers teammates automatically'))!.content).toMatch(
      /from .*\/plain; reads inside it are not automatic \(it is not inside a git work tree.*\): every read needs your approval\.$/,
    );
  });
});

describe('where the answerer may read (M8-SPEC §1)', () => {
  it('a folder that does not qualify: the answerer runs in an empty private directory and reads nothing without asking', async () => {
    const home = join(tmp, 'home');
    mkdirSync(home);
    await session({ cwd: home, env: { HOME: home } });
    const id = ask(script([{ reply: { text: 'nothing read' } }]));
    await waitFor(() => replyTo(id), 15_000, 'the answer');
    const r = record(id);
    expect(r.cwd).not.toBe(home);
    expect(r.cwd).toMatch(/\/trh-[^/]+\/run-[^/]+\/work$/);
    expect(r.settings.permissions.allow).toEqual(['mcp__host__reply', 'mcp__host__request_approval']);
    expect(r.stdin).not.toContain(home);
    // No folder is shared.
    expect(relay.manifests.get('bob')).toMatchObject({ shares: [] });
  });
});

describe('the fallback page (M8-SPEC §4)', () => {
  it('without elicitation, /team-relay:approvals opens the local page by way of the redirect file', async () => {
    const opened = join(tmp, 'opened.html');
    const opener = join(tmp, 'opener.sh');
    // The copy appears whole (written aside, then renamed), so it is never read half-written.
    writeFileSync(opener, `#!/bin/sh\ncp "$1" "${opened}.part" && mv "${opened}.part" "${opened}"\n`);
    chmodSync(opener, 0o700);
    const s = await session({ decide: null, env: { TEAM_RELAY_OPEN_COMMAND: opener } });
    const id = ask(script([{ reply: { text: 'maybe', needs_approval: true } }]));
    // Each wait is for a condition, bounded only by the test's own timeout.
    await waitFor(() => waitingNotes(s).length === 1, Infinity, 'the approval notice');
    const r = await s.call('review_approvals');
    expect(r.json.message).toMatch(/opened in your browser on a local page instead \(127\.0\.0\.1, with a one-time key\)/);
    // The key never reaches the model.
    expect(r.text).not.toMatch(/#k=/);
    await waitFor(() => existsSync(opened), Infinity, 'the opener');
    const url = /url=([^"]+)"/.exec(readFileSync(opened, 'utf8'))![1]!;
    const { origin, hash } = new URL(url);
    const key = hash.slice(3);
    const list = (await (await fetch(`${origin}/api/approvals`, { headers: { 'X-Approvals-Key': key } })).json()) as { items: Array<{ id: string }> };
    expect(list.items).toHaveLength(1);
    const status = await new Promise<number>((resolve) => {
      const body = JSON.stringify({ decision: 'send' });
      const req = request(`${origin}/api/approvals/${list.items[0]!.id}`, {
        method: 'POST',
        headers: { 'X-Approvals-Key': key, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => resolve(res.statusCode ?? 0));
      req.end(body);
    });
    expect(status).toBe(200);
    await waitFor(() => replyTo(id), Infinity, 'the answer');
    expect(replyTo(id)!.body.text).toBe('maybe');
  });
});

describe('one host per machine (M8-SPEC §1)', () => {
  it('a second channel session does not answer while the first holds the lock', async () => {
    const first = await session();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(DIST, 'channel.js')],
      cwd: proj,
      env: baseEnv({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_TOKEN: TOKEN_OF.bob!, RELAY_ROLE: 'asker', TEAM_RELAY_AUTO_ANSWER: '1', TEAM_RELAY_CLAUDE_BIN: STUB, TMPDIR: tmp, XDG_CONFIG_HOME: xdg }),
      stderr: 'pipe',
    });
    const second = new Client({ name: 'second', version: '0' }, { capabilities: {} });
    await second.connect(transport);
    try {
      await sleep(1000);
      const who = JSON.parse(textOf(await second.callTool({ name: 'whoami', arguments: {} })));
      expect(who.answering_automatically).toBe(false);
      expect(who.answering_note).toMatch(/^a channel working session on this computer \(pid \d+\) answers for you$/);
      expect((await first.call('whoami')).json.answering_automatically).toBe(true);
      const r = JSON.parse(textOf(await second.callTool({ name: 'review_approvals', arguments: {} })));
      expect(r.message).toMatch(/is not answering automatically/);
    } finally {
      await second.close();
    }
  });

  it('TEAM_RELAY_AUTO_ANSWER=0 keeps a channel session from answering', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(DIST, 'channel.js')],
      cwd: proj,
      env: baseEnv({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_TOKEN: TOKEN_OF.bob!, RELAY_ROLE: 'asker', TMPDIR: tmp, XDG_CONFIG_HOME: xdg }),
      stderr: 'pipe',
    });
    const c = new Client({ name: 'off', version: '0' }, { capabilities: {} });
    await c.connect(transport);
    try {
      ask('anyone?');
      await sleep(1500);
      expect(relay.requests.some((r) => r.path.endsWith('/streams/inbox'))).toBe(false);
      expect(relay.acks).toEqual([]);
    } finally {
      await c.close();
    }
  });
});

describe('boundary mode (13 Nov 2026: the topic, and the folders the member chose)', () => {
  let f: Fixture;
  beforeAll(() => {
    f = makeFixture();
    writeFolders(f, FOLDERS);
  });
  const alpha = (...p: string[]) => join(f.alpha, ...p);
  const plan = () => join(f.myFolder, 'Clients', 'plan.md');
  async function bsession(opts: { decide?: Decide | null; env?: Record<string, string>; accepted?: number } = {}) {
    relay.setBoundaries(BOUNDARIES);
    relay.teamName = 'Example Org';
    // M11-SPEC §2: bob accepted version 1 in the console (the relay holds it).
    relay.acceptances.set('bob', opts.accepted ?? 1);
    return session({ ...opts, env: { HOME: f.home, XDG_CONFIG_HOME: f.xdg, ...opts.env } });
  }
  const callsOf = (id: string, tool: string) => record(id).calls.filter((c: any) => c.tool === tool);
  const nothingWaited = async (s: Session, id: string) => {
    expect(waitingNotes(s)).toHaveLength(0);
    expect(s.elicited).toHaveLength(0);
    expect(relay.toolEvents.filter((e) => e.request_id === id && (e.body as { status: string }).status === 'waiting')).toEqual([]);
    expect((await s.call('whoami')).json).toMatchObject({ approvals_pending: 0 });
  };
  /** No chosen folder's name or path in what bob published (nobody else sees a member's folders). */
  const noFolderNames = () => {
    const m = JSON.stringify(relay.manifests.get('bob'));
    for (const x of ['example-org', 'alpha', 'notes', '"team"', f.repoRoot, f.myFolder, f.home]) expect(m, x).not.toContain(x);
  };

  it('a tracked file in a chosen repository and a file in a chosen plain folder are read without asking, and the answer ships', async () => {
    const s = await bsession();
    await waitFor(() => s.notes.find((n) => n.content.includes("within your team's boundaries")), 5000, 'the announcement');
    expect(s.notes.find((n) => n.content.includes("within your team's boundaries"))!.content).toBe(
      `team-relay: This session now answers teammates automatically within your team's boundaries (version 1): 2 of your folders (example-org, team); ${f.allowed.length} files. ` +
        'Reads of anything else are denied without asking, off-topic questions are declined, and nothing waits for your approval except a capability call. Change your folders with /team-relay:folders.',
    );
    const id = ask(
      `Where is the staging bucket? ${script([
        { host: { tool: 'list_files', args: { area: 'example-org', glob: 'alpha/**/*.md' } } },
        { permission: { tool_name: 'Read', input: { file_path: alpha('README.md') } } },
        { permission: { tool_name: 'Read', input: { file_path: plan() } } },
        { reply: { text: 'In europe-west3 ({{decision}}).' } },
      ])}`,
    );
    await waitFor(() => replyTo(id), 15_000, 'the answer');
    expect(replyTo(id)!.body).toMatchObject({ text: 'In europe-west3 (allow).', data: null });
    const r = record(id);
    const mcpConfig = r.argv[r.argv.indexOf('--mcp-config') + 1];
    const settings = r.argv[r.argv.indexOf('--settings') + 1];
    expect(r.argv).toEqual(childArgs({ mcpConfig, settings }, boundaryRubric({ member: 'bob', teamName: 'Example Org', topic: TOPIC }), undefined, 'boundaries'));
    expect(r.argv[r.argv.indexOf('--tools') + 1]).toBe('Read');
    expect(r.argv.slice(r.argv.indexOf('--disallowedTools') + 1)).toEqual(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Glob', 'Grep']);
    expect(r.rubric).toContain(`topic ${JSON.stringify(TOPIC)}`);
    // An empty private working directory, and no Read allow rule: every Read reaches the host.
    expect(r.cwd).toMatch(/\/trh-[^/]+\/run-[^/]+\/work$/);
    expect(r.settings.permissions.allow).toEqual(['mcp__host__reply', 'mcp__host__list_files', 'mcp__host__search_files']);
    expect(r.settings.permissions.allow.some((x: string) => x.startsWith('Read('))).toBe(false);
    expect(r.settings.permissions.deny).toEqual(expect.arrayContaining(['Glob', 'Grep']));
    expect(r.mcp.mcpServers.host.env.TEAM_RELAY_HOST_MODE).toBe('boundaries');
    expect([...r.hostTools].sort()).toEqual(['list_files', 'permission', 'reply', 'search_files']);
    const listed = JSON.parse(callsOf(id, 'list_files')[0].text);
    expect(listed.files).toEqual([alpha('README.md'), alpha('docs', 'guide.md')]);
    expect(callsOf(id, 'permission').map((c: any) => JSON.parse(c.text).behavior)).toEqual(['allow', 'allow']);
    // M10-SPEC §7.3: each Read went to a copy in the run's private snapshot folder (keeping the
    // extension, other parameters unchanged); the answerer never got a member path.
    const reads = callsOf(id, 'permission').map((c: any) => ({ updated: JSON.parse(c.text).updatedInput, read: c.read }));
    for (const [i, src] of [alpha('README.md'), plan()].entries()) {
      const { updated, read } = reads[i]!;
      expect(Object.keys(updated)).toEqual(['file_path']);
      expect(updated.file_path).toMatch(new RegExp(`^${tmp}/trs-[^/]+/[0-9a-f]{32}\\.md$`));
      expect(read).toEqual({ path: updated.file_path, content: readFileSync(src, 'utf8') });
    }
    // The run's folder is gone with the run.
    await waitFor(() => !existsSync(reads[0]!.updated.file_path), 5000, 'the snapshot folder to be removed');
    await nothingWaited(s, id);
    // Nobody else sees a member's folders: no share is published in boundary mode.
    expect(relay.manifests.get('bob')).toMatchObject({ shares: [] });
    noFolderNames();
    const who = (await s.call('whoami')).json;
    expect(who).toMatchObject({ answering_mode: 'boundaries', boundaries_version: 1, answering_folder: null, boundaries_acceptance: 'accepted' });
    expect(who.answering_from).toEqual({ your_folders: ['example-org', 'team'], files: f.allowed.length, summary: `2 of your folders (example-org, team); ${f.allowed.length} files` });
  });

  it('untracked, ignored, not chosen, credential and symlink-escape reads are denied at once; the answer still ships', async () => {
    const s = await bsession();
    const reads = [
      f.forbidden.untracked!,
      f.forbidden.ignored!,
      f.forbidden.betaUntracked!,
      f.forbidden.notChosen!,
      f.forbidden.outside!,
      f.forbidden.nodeModules!,
      f.forbidden.submodule!,
      f.forbidden.symlinkOut!,
      f.forbidden.swappedDir!,
      f.forbidden.untrackedLinkDir!,
      f.forbidden.myFolderSymlinkOut!,
      f.forbidden.tooBig!,
      '/etc/hosts',
    ];
    const id = ask(
      script([
        ...reads.map((p) => ({ permission: { tool_name: 'Read', input: { file_path: p } } })),
        { permission: { tool_name: 'Read', input: { file_path: f.forbidden.trackedEnv } } },
        { permission: { tool_name: 'Glob', input: { pattern: '**/*' } } },
        { permission: { tool_name: 'Grep', input: { pattern: 'x', path: f.repoRoot } } },
        { reply: { text: 'Maybe.', needs_approval: true, reason: 'unsure' } },
        { reply: { text: 'The files do not say.' } },
      ]),
    );
    await waitFor(() => replyTo(id), 15_000, 'the answer');
    const denials = callsOf(id, 'permission').map((c: any) => JSON.parse(c.text));
    expect(denials.map((d: any) => d.behavior)).toEqual(Array(reads.length + 3).fill('deny'));
    for (const d of denials.slice(0, reads.length)) expect(d.message).toBe(OUTSIDE_SET);
    expect(OUTSIDE_SET).toContain('only files in the folders the member chose (in a git repository, only the files git tracks)');
    expect(denials[reads.length].message).toMatch(/never readable/);
    expect(denials[reads.length + 1].message).toBe('Glob is not available when answering automatically.');
    expect(denials[reads.length + 2].message).toBe('Grep is not available when answering automatically.');
    // needs_approval is not a thing here: the answerer is told so, and its plain answer ships.
    expect(callsOf(id, 'reply')[0]).toMatchObject({ isError: true });
    expect(callsOf(id, 'reply')[0].text).toMatch(/needs_approval and reason are not used for this team/);
    expect(replyTo(id)!.body.text).toBe('The files do not say.');
    await nothingWaited(s, id);
  });

  it('ACC-5: an off-topic question gets the fixed decline, with no dialog and nothing read', async () => {
    const s = await bsession();
    const id = ask(`What's a good pasta recipe? ${script([{ reply: { text: 'Off topic.', off_topic: true } }])}`);
    await waitFor(() => replyTo(id), 15_000, 'the decline');
    expect(replyTo(id)!.body).toMatchObject({ text: 'I only answer questions about Example Org topics.', data: null });
    // The stub records a call once it has returned, which is after the relay has the reply.
    await waitFor(() => callsOf(id, 'reply').length === 1, 5000, 'the recorded reply');
    expect(record(id).calls.map((c: any) => c.tool)).toEqual(['reply']);
    expect(callsOf(id, 'reply')[0].text).toBe('Declined as off-topic. Nothing more to do: end here.');
    await nothingWaited(s, id);
  });

  it('ACC-8: a draft the secret screen flags is not sent; the asker gets the fixed line and the member a one-line note', async () => {
    const s = await bsession();
    const id = ask(`What's the staging DB password? ${script([{ reply: { text: 'Use DB_PASSWORD=hunter2hunter2 for staging.' } }])}`);
    await waitFor(() => replyTo(id), 15_000, 'the fixed line');
    expect(replyTo(id)!.body).toMatchObject({ text: "This answer may contain a credential, so it wasn't sent. Ask bob directly.", data: null });
    expect(relay.replies.filter((r) => r.request_id === id)).toHaveLength(1);
    await waitFor(() => s.notes.find((n) => n.content.includes('was not sent because')), 5000, 'the member note');
    const note = s.notes.find((n) => n.content.includes('was not sent because'))!;
    expect(note).toEqual({
      content: `team-relay: an automatic answer to alice was not sent because it may contain a credential (request ${id}); alice was told to ask you directly.`,
      meta: { type: 'status' },
    });
    await waitFor(() => callsOf(id, 'reply').length === 1, 5000, 'the recorded reply');
    expect(callsOf(id, 'reply')[0].text).toMatch(/^Not sent: your answer may contain a credential/);
    await nothingWaited(s, id);
  });

  it('ACC-6: a capability call still waits for the member, as in M8', async () => {
    const decisions = ['allow', 'send'];
    const s = await bsession({ decide: () => decisions.shift()!, env: { CAP_SERVICE_HEALTH_ENABLED: 'true', CAP_SERVICE_HEALTH_RUNNER: RUNNER } });
    const params = { service: 'api' };
    const id = relay.addRequest({ kind: 'capability', asker: 'alice', capability: { name: 'service_health', params }, recipients: { bob: { status: 'pending' } } });
    relay.enqueue('bob', 'inbox', { type: 'capability_call', from: 'alice', request_id: id, data: { capability: 'service_health', params, ack_deadline: iso(60_000), answer_deadline: iso(600_000) } });
    await waitFor(() => waitingNotes(s).length === 1, 15_000, 'the approval notice');
    await s.call('review_approvals');
    await waitFor(() => waitingNotes(s).length === 2, 15_000, 'the draft notice');
    await s.call('review_approvals');
    await waitFor(() => replyTo(id), 5000, 'the answer');
    expect(replyTo(id)!.body).toMatchObject({ text: 'ran service_health' });
  });

  it('a new topic and a change of folders are used by the next run; an accepted version covers later ones', async () => {
    try {
      const s = await bsession();
      const first = ask(script([{ host: { tool: 'list_files', args: {} } }, { reply: { text: 'one' } }]));
      await waitFor(() => replyTo(first), 15_000, 'the first answer');
      const before = JSON.parse(callsOf(first, 'list_files')[0].text);
      expect(before.files).toContain(alpha('README.md'));
      expect(before.files).toContain(plan());
      // The topic changes (version 2; bob accepted 1, which still counts) and bob drops a folder.
      relay.setBoundaries({ topic: 'Only the repositories.' });
      writeFolders(f, [REPO_ROOT]);
      const second = ask(script([{ host: { tool: 'list_files', args: {} } }, { permission: { tool_name: 'Read', input: { file_path: plan() } } }, { reply: { text: 'two' } }]));
      await waitFor(() => replyTo(second), 15_000, 'the second answer');
      const after = JSON.parse(callsOf(second, 'list_files')[0].text);
      expect(after.files).toContain(alpha('README.md'));
      expect(after.files).not.toContain(plan());
      expect(after.areas.map((a: any) => a.area)).toEqual(['folder:example-org']);
      expect(JSON.parse(callsOf(second, 'permission')[0].text)).toEqual({ behavior: 'deny', message: OUTSIDE_SET });
      expect(record(second).rubric).toContain('topic "Only the repositories."');
      expect((await s.call('whoami')).json).toMatchObject({ boundaries_version: 2, boundaries_acceptance: 'accepted' });
      expect(relay.manifests.get('bob')).toMatchObject({ shares: [] });
      noFolderNames();
      expect(s.notes.filter((n) => n.content.includes('accept them'))).toEqual([]);
    } finally {
      writeFolders(f, FOLDERS);
    }
  });

  it('past the per-asker limit a question is declined at once with the fixed line, never held', async () => {
    const s = await bsession();
    // The first run is held open until the test has seen the decline, so three wait behind it.
    const release = join(tmp, 'release-a1');
    const ids = [ask(script([{ wait_for_file: release }, { reply: { text: 'a1' } }]))];
    for (let i = 2; i <= 5; i++) ids.push(ask(script([{ reply: { text: `a${i}` } }])));
    await waitFor(() => replyTo(ids[4]!), 15_000, 'the decline of the fifth');
    expect(replyTo(ids[4]!)!.body.text).toBe(BUSY_REPLY);
    expect(ids.slice(0, 4).map((id) => replyTo(id))).toEqual([undefined, undefined, undefined, undefined]);
    writeFileSync(release, '');
    await waitFor(() => ids.every((id) => replyTo(id)), 30_000, 'every reply');
    expect(ids.map((id) => replyTo(id)!.body.text)).toEqual(['a1', 'a2', 'a3', 'a4', BUSY_REPLY]);
    expect(BUSY_REPLY).toBe('Too many questions right now; try again later.');
    expect(waitingNotes(s)).toHaveLength(0);
    expect((await s.call('whoami')).json).toMatchObject({ approvals_pending: 0 });
  });

  it('the SessionStart line says the team has boundaries, how many folders answers come from, earlier folders not used, and whether it is accepted', async () => {
    relay.setBoundaries(BOUNDARIES);
    relay.acceptances.set('bob', 1);
    const env = { HOME: f.home, XDG_CONFIG_HOME: f.xdg };
    expect(await sessionStart(env)).toContain(
      'Your team has boundaries (version 1): your answerer answers teammates on its own from your 2 chosen folders (only the files git tracks inside a repository; /team-relay:folders list shows them); reads of anything else are denied and off-topic questions declined.',
    );
    // A newer version is covered by the accepted one.
    relay.setBoundaries({ topic: 'Example Org: everything.' });
    expect(await sessionStart(env)).toContain('Your team has boundaries (version 2): your answerer answers teammates on its own');
    relay.acceptances.set('bob', 0);
    expect(await sessionStart(env)).toContain("Your team has boundaries (version 2) that you have not accepted yet, so teammates' questions to you are declined.");
    // An earlier plugin's lists: never read from; how many there are is said, never their paths.
    relay.acceptances.set('bob', 2);
    writeFolders(f, [], { raw: { repo_roots: [REPO_ROOT], extra_folders: [MY_FOLDER] } });
    try {
      const line = await sessionStart(env);
      expect(line).toContain('nothing yet: you have chosen no folders');
      expect(line).toContain('2 folders you chose before 13 Nov 2026 are not used now; /team-relay:folders list shows them.');
      expect(line).not.toContain(REPO_ROOT);
    } finally {
      writeFolders(f, FOLDERS);
    }
    relay.setBoundaries(null);
    expect(await sessionStart(env)).not.toContain('boundaries');
  });

  it('/team-relay:folders: list; every change is decided in a dialog', async () => {
    const decisions = ['keep', 'change', 'change'];
    const s = await bsession({ decide: () => decisions.shift() ?? null });
    try {
      const shown = await s.call('folders', {});
      expect(shown.json).toMatchObject({
        team: 'demo',
        folders: [
          { path: REPO_ROOT, resolved: f.repoRoot },
          { path: MY_FOLDER, resolved: f.myFolder },
        ],
        team_boundaries: { version: 1, topic: JSON.stringify(TOPIC) },
        accepted: { version: 1 },
        answers_come_from: `2 of your folders (example-org, team); ${f.allowed.length} files`,
      });
      // Kept in the dialog: nothing changes.
      const other = '~/code/example-org/alpha';
      const kept = await s.call('folders', { action: 'add', path: other });
      expect(kept.json.message).toBe('You kept it as it was; nothing changed.');
      expect(s.elicited[0]).toContain(`Let your automatic answerer read ${other} (${f.alpha})?`);
      // Allowed: removed; then added back.
      const removed = await s.call('folders', { action: 'remove', path: f.myFolder });
      expect(removed.json).toMatchObject({ folders: [{ path: REPO_ROOT, resolved: f.repoRoot }] });
      const added = await s.call('folders', { action: 'add', path: MY_FOLDER });
      expect((added.json.folders as unknown[]).length).toBe(2);
      expect(s.elicited).toHaveLength(3);
      // An unsafe folder is refused before any dialog.
      mkdirSync(join(f.home, 'Library', 'CloudStorage'), { recursive: true });
      const bad = await s.call('folders', { action: 'add', path: '~/Library/CloudStorage' });
      expect(bad.isError).toBe(true);
      expect(bad.text).toMatch(/cannot be added: it is inside ~\/Library/);
      expect(s.elicited).toHaveLength(3);
    } finally {
      writeFolders(f, FOLDERS);
    }
  });

  it('/team-relay:folders without dialogs changes nothing', async () => {
    const s = await bsession({ decide: null });
    const r = await s.call('folders', { action: 'remove', path: MY_FOLDER });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/does not offer dialogs to plugins.*so your folders cannot be changed from here/);
    expect(((await s.call('folders', {})).json.folders as unknown[]).length).toBe(2);
  });

  it('§7.6: while the boundaries were never read, questions get the fixed busy line; nothing runs and nothing waits', async () => {
    relay.setBoundaries(BOUNDARIES);
    relay.fail((r) => r.method === 'GET' && r.path.endsWith('/boundaries'), 403, 1000);
    const s = await session({ decide: () => 'allow', env: { HOME: f.home, XDG_CONFIG_HOME: f.xdg } });
    // Five from one asker: past the per-asker limit too, and still never held for approval.
    const ids = Array.from({ length: 5 }, (_, i) => ask(script([{ reply: { text: `x${i}` } }])));
    await waitFor(() => ids.every((id) => replyTo(id)), 15_000, 'every decline');
    expect(ids.map((id) => replyTo(id)!.body.text)).toEqual(Array(5).fill(BUSY_REPLY));
    for (const id of ids) expect(existsSync(join(tmp, 'stub-claude', `${id}.json`))).toBe(false);
    expect(waitingNotes(s)).toHaveLength(0);
    expect(s.elicited).toHaveLength(0);
    expect(relay.toolEvents).toEqual([]);
    expect((await s.call('whoami')).json).toMatchObject({ approvals_pending: 0 });
  });

  it('M11-SPEC §2: nothing accepted at the relay: the fixed decline, no run, one status line; accepting in the console lets the next question through', async () => {
    // An earlier plugin's file (its lists and `accepted: 1`): the lists are never read, `accepted` ignored.
    writeFolders(f, [], { raw: { repo_roots: [REPO_ROOT], extra_folders: [MY_FOLDER], accepted: { version: 1 } } });
    try {
      const s = await bsession({ decide: () => 'change', accepted: 0 });
      await until(() => s.notes.find((n) => n.content.includes('you have not accepted yet')));
      expect(s.notes.find((n) => n.content.startsWith('team-relay: This session now answers'))!.content).toBe(
        `team-relay: This session now answers teammates for you, but declines their questions until you accept your team's boundaries in the console: ${relay.url}`,
      );
      const a = ask(script([{ reply: { text: 'one' } }]));
      const b = ask(script([{ reply: { text: 'two' } }]));
      await until(() => replyTo(a) && replyTo(b));
      expect([replyTo(a)!.body.text, replyTo(b)!.body.text]).toEqual([NOT_SET_UP_REPLY('bob'), NOT_SET_UP_REPLY('bob')]);
      expect(NOT_SET_UP_REPLY('bob')).toBe("bob hasn't set up answering for this team yet.");
      expect(existsSync(join(tmp, 'stub-claude', `${a}.json`))).toBe(false);
      const lines = s.notes.filter((n) => n.content.includes('you have not accepted yet'));
      expect(lines.map((n) => n.content)).toEqual([
        `team-relay: demo has boundaries (version 1) you have not accepted yet, so teammates' questions to you are declined. Open the console to see and accept them: ${relay.url}`,
      ]);
      expect((await s.call('whoami')).json).toMatchObject({ boundaries_acceptance: 'not_accepted', answering_from: null, approvals_pending: 0 });
      expect(relay.manifests.get('bob')).toMatchObject({ shares: [] });
      // The folders tool accepts nothing: it says where to accept, and there is no accept action.
      const listed = await s.call('folders', {});
      expect(listed.json.accepted).toBe(`nothing yet: teammates' questions to you are declined until you accept your team's boundaries in the console (${relay.url})`);
      expect((await s.call('folders', { action: 'accept' })).isError).toBe(true);
      expect(s.elicited).toHaveLength(0);
      // Accepted in the console (the relay records it): the next question is answered, and the
      // earlier plugin's lists are read from not at all.
      relay.acceptances.set('bob', 1);
      const c = ask(script([{ host: { tool: 'list_files', args: {} } }, { permission: { tool_name: 'Read', input: { file_path: alpha('README.md') } } }, { reply: { text: 'three' } }]));
      await until(() => replyTo(c));
      expect(replyTo(c)!.body.text).toBe('three');
      expect(JSON.parse(callsOf(c, 'list_files')[0].text).files).toEqual([]);
      expect(JSON.parse(callsOf(c, 'permission')[0].text)).toEqual({ behavior: 'deny', message: OUTSIDE_SET });
      expect((await s.call('whoami')).json).toMatchObject({ boundaries_acceptance: 'accepted', answering_from: { your_folders: [], files: 0 } });
      // Chosen again under the new scheme: read from the next question on.
      writeFolders(f, FOLDERS);
      const d = ask(script([{ host: { tool: 'list_files', args: { area: 'example-org', glob: 'alpha/**/*.md' } } }, { reply: { text: 'four' } }]));
      await until(() => replyTo(d));
      expect(JSON.parse(callsOf(d, 'list_files')[0].text).files).toEqual([alpha('README.md'), alpha('docs', 'guide.md')]);
      noFolderNames();
    } finally {
      writeFolders(f, FOLDERS);
    }
  });

  it('M11-SPEC §2: when the relay cannot say what was accepted, the question gets the busy line; nothing runs or waits', async () => {
    relay.fail((r) => r.method === 'GET' && r.path.endsWith('/me/acceptance'), 503, 1000);
    const s = await bsession({ decide: () => 'allow' });
    const id = ask(script([{ reply: { text: 'x' } }]));
    await until(() => replyTo(id));
    expect(replyTo(id)!.body.text).toBe(BUSY_REPLY);
    expect(existsSync(join(tmp, 'stub-claude', `${id}.json`))).toBe(false);
    expect(s.elicited).toHaveLength(0);
    expect((await s.call('whoami')).json).toMatchObject({ boundaries_acceptance: 'unknown', approvals_pending: 0 });
  });

  it('an accepted version past the current one (an earlier team under this id) covers nothing', async () => {
    const s = await bsession({ accepted: 7 });
    const id = ask(script([{ reply: { text: 'x' } }]));
    await until(() => replyTo(id));
    expect(replyTo(id)!.body.text).toBe(NOT_SET_UP_REPLY('bob'));
    expect(existsSync(join(tmp, 'stub-claude', `${id}.json`))).toBe(false);
    expect((await s.call('whoami')).json).toMatchObject({ boundaries_acceptance: 'not_accepted' });
  });

  it('the local file is never written by answering', async () => {
    const s = await bsession();
    const before = readFileSync(join(f.xdg, 'team-relay', 'boundaries.local.json'), 'utf8');
    const id = ask(script([{ host: { tool: 'list_files', args: {} } }, { reply: { text: 'one' } }]));
    await until(() => replyTo(id));
    relay.setBoundaries({ topic: 'Another topic.' });
    const id2 = ask(script([{ reply: { text: 'two' } }]));
    await until(() => replyTo(id2));
    expect(readFileSync(join(f.xdg, 'team-relay', 'boundaries.local.json'), 'utf8')).toBe(before);
    expect(s.elicited).toEqual([]);
  });

  it("another team's boundaries document is refused: nothing is worked out from it, and questions get the busy line", async () => {
    relay.setBoundaries(BOUNDARIES);
    relay.boundariesTeam = 'elsewhere';
    const s = await session({ decide: () => 'allow', env: { HOME: f.home, XDG_CONFIG_HOME: f.xdg } });
    const id = ask(script([{ reply: { text: 'x' } }]));
    await until(() => replyTo(id));
    expect(replyTo(id)!.body.text).toBe(BUSY_REPLY);
    expect(existsSync(join(tmp, 'stub-claude', `${id}.json`))).toBe(false);
    await until(() => s.stderr().includes("another team's boundaries"));
    expect((await s.call('whoami')).json).toMatchObject({ answering_mode: 'folder', approvals_pending: 0 });
    // /team-relay:folders works out nothing from it either.
    const shown = await s.call('folders');
    expect(shown.json.team_boundaries).toBe("unknown (the relay answered with another team's boundaries)");
    expect(shown.json).not.toHaveProperty('answers_come_from');
  });

  it('§7.3: at start the host removes the snapshot folders of hosts that have ended, and only those', async () => {
    const past = new Date(Date.now() - 3_600_000);
    const future = new Date(Date.now() + 3_600_000);
    const folder = (name: string, mode: number, when: Date) => {
      const p = join(tmp, name);
      mkdirSync(p);
      writeFileSync(join(p, 'copy.md'), 'left behind\n');
      chmodSync(p, mode);
      utimesSync(p, when, when);
      return p;
    };
    // A process that has ended (and been reaped), and one that is alive: this test's own.
    const ended = spawnSync(process.execPath, ['-e', '']);
    expect(ended.status).toBe(0);
    const dead = ended.pid!;
    const stale = folder(`trs-${dead}-Stale1`, 0o700, past);
    const live = folder(`trs-${process.pid}-Live01`, 0o700, past);
    const newer = folder(`trs-${dead}-Newer1`, 0o700, future);
    const open = folder(`trs-${dead}-Open77`, 0o755, past);
    const unnamed = folder('trs-Old001', 0o700, past);
    const other = folder('trs-other-name', 0o700, past);
    const s = await bsession();
    await until(() => s.stderr().includes('removed 1 snapshot folder an earlier answering host left behind'));
    expect(existsSync(stale)).toBe(false);
    for (const p of [live, newer, open, unnamed, other]) expect(existsSync(join(p, 'copy.md')), p).toBe(true);
  });

  it('past the hourly limit a question is declined at once with the fixed line', async () => {
    relay.setBoundaries(BOUNDARIES);
    relay.acceptances.set('bob', 1);
    const pushes: string[] = [];
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    const host = new AnswerHost({
      client: new RelayClient({ url: relay.url, team: 'demo', token: () => TOKEN_OF.bob!, attempts: 1 }),
      me: { team: 'demo', member: 'bob', teammates: ['alice', 'carol'] },
      env: { PATH: process.env.PATH ?? '', HOME: f.home, TMPDIR: tmp, XDG_CONFIG_HOME: f.xdg },
      connection: { mode: 'token', url: relay.url, team: 'demo', token: TOKEN_OF.bob! },
      push: (c) => void pushes.push(c),
      log: () => {},
      cwd: proj,
      distDir: DIST,
      claudeBin: STUB,
      notify: () => {},
      limits: { perHour: 1 },
    });
    void host.start();
    try {
      const a = ask(script([{ reply: { text: 'first' } }]));
      await waitFor(() => replyTo(a), 15_000, 'the first answer');
      const b = ask(script([{ reply: { text: 'second' } }]));
      await waitFor(() => replyTo(b), 15_000, 'the decline');
      expect(replyTo(b)!.body.text).toBe(BUSY_REPLY);
      expect(host.queue.size).toBe(0);
      expect(pushes.some((p) => p.includes('waiting for your approval'))).toBe(false);
    } finally {
      await host.stop();
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
  it("a claude the desktop app replaced while the host runs: the next answer starts the new build", async () => {
    relay.setBoundaries(BOUNDARIES);
    relay.acceptances.set('bob', 1);
    const desk = join(tmp, 'desk-home');
    const marks = join(tmp, 'builds.log');
    const build = (version: string) => {
      const dir = join(desk, 'Library', 'Application Support', 'Claude', 'claude-code', version, 'h1');
      const exe = join(dir, 'claude.app', 'Contents', 'MacOS', 'claude');
      mkdirSync(join(exe, '..'), { recursive: true });
      writeFileSync(exe, `#!/bin/sh\necho ${version} >>"${marks}"\nexec "${process.execPath}" "${STUB}" "$@"\n`);
      chmodSync(exe, 0o755);
      writeFileSync(join(dir, '.verified'), 'x');
      return exe;
    };
    const old = build('2.1.9');
    const lookup = { HOME: desk, PATH: '', TEAM_RELAY_CLAUDE_BIN: old };
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    const host = new AnswerHost({
      client: new RelayClient({ url: relay.url, team: 'demo', token: () => TOKEN_OF.bob!, attempts: 1 }),
      me: { team: 'demo', member: 'bob', teammates: ['alice', 'carol'] },
      env: { PATH: process.env.PATH ?? '', HOME: f.home, TMPDIR: tmp, XDG_CONFIG_HOME: f.xdg },
      connection: { mode: 'token', url: relay.url, team: 'demo', token: TOKEN_OF.bob! },
      push: () => {},
      log: () => {},
      cwd: proj,
      distDir: DIST,
      claudeBin: () => resolveClaudeBin(lookup),
      notify: () => {},
    });
    void host.start();
    try {
      const a = ask(script([{ reply: { text: 'first' } }]));
      await waitFor(() => replyTo(a), 15_000, 'the first answer');
      // The app updates: the old build is gone, a new one is there.
      rmSync(join(desk, 'Library', 'Application Support', 'Claude', 'claude-code', '2.1.9'), { recursive: true });
      build('2.1.10');
      const b = ask(script([{ reply: { text: 'second' } }]));
      await waitFor(() => replyTo(b), 15_000, 'the second answer');
      expect(replyTo(b)!.body.text).toBe('second');
      expect(readFileSync(marks, 'utf8')).toBe('2.1.9\n2.1.10\n');
    } finally {
      await host.stop();
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});

function sessionStart(extra: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(DIST, 'session-start.js')],
      { env: { PATH: process.env.PATH ?? '', XDG_CONFIG_HOME: xdg, TEAM_RELAY_CHANNEL: '1', RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: TOKEN_OF.bob!, ...extra }, encoding: 'utf8', timeout: 10_000 },
      (_err, stdout) => resolve(stdout),
    );
    child.stdin?.end('{}');
  });
}
