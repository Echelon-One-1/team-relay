// Channel-session detection (channel-mode.ts): the argv parsing table, the ancestor walk with
// a fake process table, the TEAM_RELAY_CHANNEL override, a process table that cannot be read,
// the install-path naming, and the real thing: the bundles started under a stand-in `claude`
// process (test/fixtures/fake-claude.mjs, through a symlink named claude) with and without
// the channel flag.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  argvLoadsChannel,
  channelEntries,
  channelOverride,
  detectChannelSession,
  inspectProcess,
  isClaudeArgv,
  notChannelNote,
  pluginRef,
  splitPsArgs,
  type ProcInfo,
} from '../src/channel-mode.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST, FIXTURES, sleep, textOf } from './helpers/mcp.js';

const DEV = '--dangerously-load-development-channels';
const CH = '--channels';
const OURS = 'plugin:team-relay@team-relay-dev';

describe('argv: which channels a claude command line loads', () => {
  const table: Array<[string, string[], boolean, boolean]> = [
    // [what, argv after "claude", asker loads, answerer loads]
    ['the development flag, one value', [DEV, OURS], true, false],
    ['the development flag, = form', [`${DEV}=${OURS}`], true, false],
    ['the released flag', [CH, OURS], true, false],
    ['the released flag, = form', [`${CH}=${OURS}`], true, false],
    ['a space-separated list, ours last', [DEV, 'plugin:other@market', 'server:foo', OURS], true, false],
    ['a comma-separated list', [DEV, `plugin:other@m,${OURS}`], true, false],
    ['a comma list in the = form', [`${CH}=server:x,${OURS}`], true, false],
    ['a list that ends at the next option', [DEV, 'plugin:other@m', '--model', 'opus', OURS], false, false],
    ['two flags, ours in the second', [DEV, 'plugin:other@m', '--verbose', CH, OURS], true, false],
    ['the = form takes one value: a positional after it is not in the list', [`${DEV}=plugin:other@m`, OURS], false, false],
    ['another marketplace for this plugin', [DEV, 'plugin:team-relay@acme-market'], true, false],
    ['another plugin only', [DEV, 'plugin:other-relay@team-relay-dev'], false, false],
    ['a plugin whose name only starts with ours', [DEV, 'plugin:team-relay-x@m'], false, false],
    ['no marketplace after the @', [DEV, 'plugin:team-relay@'], false, false],
    ['the answering session', [DEV, 'server:relay'], false, true],
    ['the answering session among others', ['--strict-mcp-config', DEV, 'server:other', 'server:relay'], false, true],
    ['a server that only starts with relay', [DEV, 'server:relay2'], false, false],
    ['no flag at all', ['--model', 'opus', '-p', 'hello'], false, false],
    ['the flag with no value', [DEV], false, false],
    ['the flag followed by an option', [DEV, '--verbose', OURS], false, false],
    ['the value only as a prompt, no flag', [OURS], false, false],
    ['after --, nothing is an option', ['--', DEV, OURS], false, false],
    ['a flag that merely starts like ours', ['--channelsx', OURS], false, false],
  ];
  for (const [what, rest, asker, answerer] of table) {
    it(what, () => {
      const argv = ['claude', ...rest];
      expect(argvLoadsChannel(argv, 'asker')).toBe(asker);
      expect(argvLoadsChannel(argv, 'answerer')).toBe(answerer);
    });
  }

  it('collects every entry of every flag', () => {
    expect(channelEntries(['claude', DEV, 'a', 'b,c', '--x', `${CH}=d,e`, CH, 'f'])).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('a renamed plugin (from its install path) is matched by its own name', () => {
    expect(argvLoadsChannel(['claude', DEV, 'plugin:zeta-relay@zeta-market'], 'asker', 'zeta-relay')).toBe(true);
    expect(argvLoadsChannel(['claude', DEV, OURS], 'asker', 'zeta-relay')).toBe(false);
  });
});

describe('argv: which process is claude', () => {
  it.each([
    [['claude', DEV, OURS], true],
    [['/Users/x/.local/bin/claude'], true],
    [['/Users/x/Library/Application Support/Claude/claude-code/2.1.280/claude.app/Contents/MacOS/claude', '--resume=1'], true],
    [['C:\\Program Files\\claude\\claude.exe'], true],
    [['node', '/usr/local/bin/claude', DEV, OURS], true],
    [['/usr/bin/node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'], true],
    [['bun', '/opt/claude'], true],
    [['node', '/x/dist/channel.js'], false],
    [['/bin/zsh', '-c', 'claude'], false],
    [['claude-helper'], false],
    [['vitest'], false],
    [[], false],
  ])('%j → %s', (argv, want) => {
    expect(isClaudeArgv(argv)).toBe(want);
  });
});

describe('ps output', () => {
  it('keeps an executable path with spaces whole, from comm', () => {
    const comm = '/Users/x/Library/Application Support/Claude/claude-code/2.1.280/claude.app/Contents/MacOS/claude';
    expect(splitPsArgs(`${comm} ${DEV} ${OURS} --verbose`, comm)).toEqual([comm, DEV, OURS, '--verbose']);
    expect(splitPsArgs(comm, comm)).toEqual([comm]);
  });

  it('falls back to a plain split when comm is not the start of args', () => {
    expect(splitPsArgs('claude --channels a', 'other')).toEqual(['claude', '--channels', 'a']);
    expect(splitPsArgs('  ', '')).toEqual([]);
  });
});

describe('detectChannelSession: the ancestor walk', () => {
  /** A fake process table: pid → [ppid, argv]. Every pid looked at is recorded. */
  function table(rows: Record<number, [number, string[]]>) {
    const seen: number[] = [];
    const inspect = async (pid: number): Promise<ProcInfo> => {
      seen.push(pid);
      const row = rows[pid];
      if (!row) throw new Error(`no such process ${pid}`);
      return { ppid: row[0], argv: row[1] };
    };
    return { inspect, seen };
  }
  const detect = (inspect: (pid: number) => Promise<ProcInfo>, env: Record<string, string> = {}, role: 'asker' | 'answerer' = 'asker') =>
    detectChannelSession({ env, role, startPid: 100, inspect });

  it('the parent is claude with the flag: a channel session', async () => {
    const t = table({ 100: [50, ['claude', DEV, OURS]] });
    expect(await detect(t.inspect)).toEqual({ channel: true, reason: 'claude (ancestor 1) loads this channel' });
  });

  it('the parent is claude without the flag: not a channel session', async () => {
    const t = table({ 100: [50, ['claude', '--model', 'opus']] });
    expect((await detect(t.inspect)).channel).toBe(false);
  });

  it('claude further up, through a shell and a runtime, still decides', async () => {
    const t = table({ 100: [101, ['/bin/sh', '-c', 'node x.js']], 101: [102, ['node', 'x.js']], 102: [1, ['claude', CH, OURS]] });
    expect(await detect(t.inspect)).toEqual({ channel: true, reason: 'claude (ancestor 3) loads this channel' });
  });

  it('the nearest claude decides: a claude without the flag inside a channel session is not one', async () => {
    const t = table({ 100: [101, ['claude']], 101: [1, ['claude', DEV, OURS]] });
    expect((await detect(t.inspect)).channel).toBe(false);
    expect(t.seen).toEqual([100]);
  });

  it('looks at no more than 4 ancestors', async () => {
    const t = table({
      100: [101, ['sh']],
      101: [102, ['sh']],
      102: [103, ['sh']],
      103: [104, ['sh']],
      104: [1, ['claude', DEV, OURS]],
    });
    const d = await detect(t.inspect);
    expect(d.channel).toBe(false);
    expect(d.reason).toMatch(/no claude process among the 4 nearest ancestors/);
    expect(t.seen).toEqual([100, 101, 102, 103]);
  });

  it('stops at init', async () => {
    const t = table({ 100: [1, ['sh']] });
    expect((await detect(t.inspect)).channel).toBe(false);
    expect(t.seen).toEqual([100]);
  });

  it('a process table that cannot be read (ps missing or failing) is not a channel session', async () => {
    const failing = async (): Promise<ProcInfo> => {
      throw new Error('spawn ps ENOENT');
    };
    const d = await detect(failing);
    expect(d.channel).toBe(false);
    expect(d.reason).toMatch(/could not inspect ancestor 1 \(spawn ps ENOENT\)/);
    // A failure further up is the same.
    const t = table({ 100: [101, ['sh']] });
    expect((await detect(t.inspect)).channel).toBe(false);
  });

  it('the answering role looks for server:relay, not the plugin', async () => {
    const t = table({ 100: [1, ['claude', '--strict-mcp-config', DEV, 'server:relay']] });
    expect((await detect(t.inspect, {}, 'answerer')).channel).toBe(true);
    expect((await detect(t.inspect, {}, 'asker')).channel).toBe(false);
  });

  it('TEAM_RELAY_CHANNEL=1 or 0 wins without looking at any process; other values are ignored', async () => {
    const withFlag = table({ 100: [1, ['claude', DEV, OURS]] });
    expect(await detect(withFlag.inspect, { TEAM_RELAY_CHANNEL: '0' })).toEqual({ channel: false, reason: 'TEAM_RELAY_CHANNEL=0' });
    const without = table({ 100: [1, ['claude']] });
    expect(await detect(without.inspect, { TEAM_RELAY_CHANNEL: '1' })).toEqual({ channel: true, reason: 'TEAM_RELAY_CHANNEL=1' });
    expect(withFlag.seen).toEqual([]);
    expect(without.seen).toEqual([]);
    for (const v of ['', 'yes', 'true', '2']) expect(channelOverride({ TEAM_RELAY_CHANNEL: v })).toBeNull();
    expect(channelOverride({ TEAM_RELAY_CHANNEL: ' 1 ' })).toBe(true);
    expect((await detect(withFlag.inspect, { TEAM_RELAY_CHANNEL: 'yes' })).channel).toBe(true);
  });

  it('the plugin name comes from CLAUDE_PLUGIN_ROOT when the walk is not told it', async () => {
    const t = table({ 100: [1, ['claude', DEV, 'plugin:zeta-relay@zeta-market']] });
    const env = { CLAUDE_PLUGIN_ROOT: '/home/u/.claude/plugins/cache/zeta-market/zeta-relay/0.1.0' };
    expect((await detect(t.inspect, env)).channel).toBe(true);
    expect((await detect(t.inspect, {})).channel).toBe(false);
  });
});

describe('inspectProcess: the real process table', () => {
  it('reads this process: its parent and its argv', async () => {
    const me = await inspectProcess(process.pid);
    expect(me.ppid).toBe(process.ppid);
    expect(me.argv.length).toBeGreaterThan(0);
    expect(me.argv.join(' ')).toMatch(/node|vitest/);
  });

  it('refuses a pid that is not one', async () => {
    await expect(inspectProcess(0)).rejects.toThrow(/not a pid/);
    await expect(inspectProcess(2 ** 22 + 12345)).rejects.toThrow();
  });
});

describe('pluginRef and the note', () => {
  it('reads the marketplace and plugin from the install path, else team-relay@team-relay-dev', () => {
    expect(pluginRef({ CLAUDE_PLUGIN_ROOT: '/Users/u/.claude/plugins/cache/team-relay-dev/team-relay/0.1.0' }, null)).toEqual({  // e1-guard: allow (synthetic macOS home path in a test)
      plugin: 'team-relay',
      marketplace: 'team-relay-dev',
    });
    expect(pluginRef({ CLAUDE_PLUGIN_ROOT: '/Users/u/.claude/plugins/cache/acme-tools/team-relay/0.2.0/' }, null)).toEqual({  // e1-guard: allow (synthetic macOS home path in a test)
      plugin: 'team-relay',
      marketplace: 'acme-tools',
    });
    // A development checkout, or a path that is not a cache entry.
    expect(pluginRef({ CLAUDE_PLUGIN_ROOT: '/src/multiagent/plugin' }, null)).toEqual({ plugin: 'team-relay', marketplace: 'team-relay-dev' });
    expect(pluginRef({ CLAUDE_PLUGIN_ROOT: '/x/cache/bad name/team-relay/1' }, null)).toEqual({ plugin: 'team-relay', marketplace: 'team-relay-dev' });
    expect(pluginRef({ CLAUDE_PLUGIN_ROOT: '/x/cache/m;rm -rf/team-relay/1' }, null).marketplace).toBe('team-relay-dev');
    expect(pluginRef({}, null)).toEqual({ plugin: 'team-relay', marketplace: 'team-relay-dev' });
    // Without CLAUDE_PLUGIN_ROOT, the bundle's own location.
    expect(pluginRef({}, '/Users/u/.claude/plugins/cache/other-market/team-relay/0.1.0/')).toEqual({ plugin: 'team-relay', marketplace: 'other-market' });  // e1-guard: allow (synthetic macOS home path in a test)
  });

  it('says it plainly, with the command', () => {
    expect(notChannelNote({ CLAUDE_PLUGIN_ROOT: '/u/.claude/plugins/cache/acme-tools/team-relay/0.2.0' })).toBe(
      "This session was not started with the team-relay channel, so teammates' answers are not shown here. " +
        'Start one with: claude --dangerously-load-development-channels plugin:team-relay@acme-tools',
    );
    expect(notChannelNote({})).toMatch(/Start one with: claude --dangerously-load-development-channels plugin:team-relay@team-relay-dev$/);
  });
});

// ---------------------------------------------------------------------------------------
// Under a stand-in claude process: no override, the real process-tree check.

describe('the bundles under a claude process', () => {
  let relay: FakeRelay;
  let bin: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    relay = await new FakeRelay().start();
    bin = mkdtempSync(join(tmpdir(), 'team-relay-fake-claude-'));
    symlinkSync(process.execPath, join(bin, 'claude'));
  });
  afterEach(async () => {
    while (clients.length) await clients.pop()!.close().catch(() => {});
    await relay.stop();
  });

  const env = (bundle: string, extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '',
    FAKE_CLAUDE_NODE: process.execPath,
    FAKE_CLAUDE_CHILD: join(DIST, bundle),
    ...extra,
  });

  async function askerUnder(flags: string[]) {
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: join(bin, 'claude'),
      args: [join(FIXTURES, 'fake-claude.mjs'), ...flags],
      env: env('channel.js', { RELAY_ROLE: 'asker', RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: TOKEN_OF.alice! }),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    await client.connect(transport);
    clients.push(client);
    return { client, stderr: () => stderr };
  }

  const streamReads = () => relay.requests.filter((r) => r.path.includes('/streams/'));

  it('started with the channel flag, the asker reads its replies stream', async () => {
    relay.enqueue('alice', 'replies', { type: 'answer', from: 'bob', data: { text: 'hi' } });
    const s = await askerUnder([DEV, 'plugin:other@m', OURS]);
    const deadline = Date.now() + 10_000;
    while (relay.stream('alice', 'replies').cursor < 1 && Date.now() < deadline) await sleep(50);
    expect(relay.stream('alice', 'replies').cursor).toBe(1);
    expect(s.stderr()).toMatch(/channel session \(claude \(ancestor 1\) loads this channel\)/);
  });

  it('started without it (or with another plugin only), the asker never reads a stream, and its tools say why', async () => {
    relay.enqueue('alice', 'replies', { type: 'answer', from: 'bob', data: { text: 'hi' } });
    for (const flags of [[], [DEV, 'plugin:other@m']]) {
      const s = await askerUnder(flags);
      const r = await s.client.callTool({ name: 'list_teammates', arguments: {} });
      expect(r.isError).not.toBe(true);
      expect(JSON.parse(textOf(r))).toMatchObject({ channel_session: false, channel_note: notChannelNote({}) });
      expect(s.stderr()).toMatch(/not a channel session: no stream is read \(claude \(ancestor 1\) was started without this channel\)/);
    }
    await sleep(1500);
    expect(streamReads()).toEqual([]);
    expect(relay.stream('alice', 'replies').cursor).toBe(0);
  });

  const sessionStart = (flags: string[]) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        join(bin, 'claude'),
        [join(FIXTURES, 'fake-claude.mjs'), ...flags],
        { env: env('session-start.js'), encoding: 'utf8', timeout: 15_000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      child.stdin?.end('{"hook_event_name":"SessionStart"}');
    });

  it('the SessionStart hook adds the note only in a session without the channel', async () => {
    const without = await sessionStart(['--model', 'opus']);
    expect(without.trimEnd().split('\n')).toHaveLength(1);
    expect(without).toMatch(/^team-relay: Not connected: run \/team-relay:login/);
    expect(without.trimEnd().endsWith(notChannelNote({}))).toBe(true);
    const withFlag = await sessionStart([`${DEV}=${OURS}`]);
    expect(withFlag).toMatch(/^team-relay: Not connected: run \/team-relay:login/);
    expect(withFlag).not.toContain('not started with the team-relay channel');
  });
});
