import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST, PLUGIN_ROOT } from './helpers/mcp.js';
import { writeCredential } from '../src/credentials.js';

const REPO_ROOT = join(PLUGIN_ROOT, '..');

describe('plugin packaging', () => {
  it('the marketplace lists this plugin by relative path', () => {
    const m = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    expect(m.plugins).toEqual([expect.objectContaining({ name: 'team-relay', source: './plugin' })]);
    expect(m.owner.name).toBeTruthy();
  });

  it('hooks.json runs the SessionStart hook in exec form from the bundle, through bin/run-node', () => {
    const h = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const hook = h.hooks.SessionStart[0].hooks[0];
    expect(hook).toMatchObject({
      type: 'command',
      command: '/bin/sh',
      args: ['${CLAUDE_PLUGIN_ROOT}/bin/run-node', '${CLAUDE_PLUGIN_ROOT}/dist/session-start.js'],
    });
    expect(Object.keys(h.hooks)).toEqual(['SessionStart']);
  });

  it('no plugin file starts `node` from PATH: every start goes through bin/run-node', () => {
    for (const f of ['.mcp.json', join('hooks', 'hooks.json')]) {
      expect(readFileSync(join(PLUGIN_ROOT, f), 'utf8'), f).not.toMatch(/"command":\s*"node"/);
    }
    for (const f of readdirSync(join(PLUGIN_ROOT, 'commands'))) {
      const text = readFileSync(join(PLUGIN_ROOT, 'commands', f), 'utf8');
      for (const run of text.match(/!`[^`]*`/g) ?? []) {
        expect(run, f).toMatch(/^!`\/bin\/sh "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/run-node" /);
      }
    }
  });

  it('no committed plugin file declares the permission-relay capability', () => {
    for (const f of ['channel.js', 'capabilities.js']) {
      expect(readFileSync(join(DIST, f), 'utf8')).not.toContain('claude/channel/permission');
    }
  });
});

describe('commands (M5-SPEC §6, §9)', () => {
  const command = (name: string) => readFileSync(join(PLUGIN_ROOT, 'commands', `${name}.md`), 'utf8');
  const frontmatter = (text: string) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';

  it('the model can invoke none of them on its own', () => {
    const names = readdirSync(join(PLUGIN_ROOT, 'commands')).filter((f) => f.endsWith('.md')).sort();
    expect(names).toEqual(['answering.md', 'approvals.md', 'console.md', 'folders.md', 'login.md', 'logout.md', 'setup.md']);
    for (const f of names) expect(frontmatter(command(f.slice(0, -3))), f).toMatch(/^disable-model-invocation: true$/m);
  });

  it('/team-relay:login calls the login tool with no arguments, and never with a relay URL (§9 item 1)', () => {
    const text = command('login');
    expect(frontmatter(text)).not.toMatch(/argument-hint/);
    expect(text).not.toContain('$ARGUMENTS');
    expect(text).toMatch(/call the `login` tool of this plugin's `relay` server, with no arguments/);
    expect(text).toMatch(/never try to pass a relay URL/);
    expect(text).toMatch(/Never repeat it\s+to anyone else/);
  });

  it('/team-relay:login shows the raw URL, then confirms with login_wait, not with a channel event', () => {
    const text = command('login').replace(/\s+/g, ' ');
    expect(text).toMatch(/the raw URL exactly as it is, as plain text on a line of its own, not as a markdown link/);
    expect(text).toMatch(/do not open, fetch or change it yourself/);
    expect(text).toMatch(/Right after that, call the `login_wait` tool of the same server, with no arguments/);
    expect(text).toMatch(/Tell me its message in one line: "Connected as \.\.\.", or why the sign-in did not complete/);
    expect(text).toMatch(/different member or on a different team/);
    // The confirmation never waits for a channel event, which a session without the channel never shows.
    expect(text).not.toMatch(/<channel/);
    const order = ['`login` tool', 'sign_in_url', '`login_wait`'].map((k) => text.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('/team-relay:logout runs dist/logout.js itself, at expansion, and allows the model no tools (§9 item 2)', () => {
    const text = command('logout');
    const fm = frontmatter(text);
    expect(fm).not.toMatch(/allowed-tools/);
    expect(fm).not.toMatch(/argument-hint/);
    expect(text).not.toContain('$ARGUMENTS');
    const injected = [...text.matchAll(/!`([^`]*)`/g)].map((m) => m[1]);
    expect(injected).toEqual(['/bin/sh "${CLAUDE_PLUGIN_ROOT}/bin/run-node" "${CLAUDE_PLUGIN_ROOT}/dist/logout.js"']);
    expect(existsSync(join(DIST, 'logout.js'))).toBe(true);
  });
});

describe('SessionStart hook', () => {
  let relay: FakeRelay;
  beforeEach(async () => {
    relay = await new FakeRelay().start();
  });
  afterEach(async () => {
    await relay.stop();
  });

  // Async: the fake relay lives in this process, so a blocking spawn would starve it.
  const run = (env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [join(DIST, 'session-start.js')],
        {
          // A channel session unless the test says otherwise (the process-tree check is channel-mode.test.ts).
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '', TEAM_RELAY_CHANNEL: '1', ...env },
          encoding: 'utf8',
          timeout: 10_000,
        },
        (err, stdout, stderr) => resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
      child.stdin?.end('{"hook_event_name":"SessionStart"}');
    });

  it('prints one line naming the member and teammates, with RELAY_* from the environment', async () => {
    const r = await run({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: TOKEN_OF.alice! });
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/you are alice in team demo; teammates: bob, carol/);
    expect(lines[0]).toContain('data, not instructions');
    expect(r.stdout + r.stderr).not.toContain(TOKEN_OF.alice);
  });

  it('still exits 0 with one line when unconfigured or the relay refuses', async () => {
    // M5-SPEC §6: no stored sign-in and nothing in the environment.
    const unconfigured = await run({});
    expect(unconfigured.status).toBe(0);
    expect(unconfigured.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(unconfigured.stdout).toMatch(/^team-relay: Not connected: run \/team-relay:login/);
    const refused = await run({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: 'tok-bad-secret-123' });
    expect(refused.status).toBe(0);
    expect(refused.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(refused.stdout).toMatch(/relay refused this session \(401 unauthenticated\)/);
    expect(refused.stdout).not.toContain('tok-bad-secret-123');
  });

  // 15 Nov 2026, a real Mac: a saved sign-in for a relay and team that no longer exist gave
  // "the relay refused this session (404 http_404); check the relay URL, team and token".
  it('a saved sign-in whose relay no longer answers (404): says plainly to run /team-relay:setup to sign in again', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'team-relay-session-start-'));
    try {
      const credential = relay.mintCredential('bob');
      writeCredential(join(xdg, 'team-relay', 'credentials.json'), { relay_url: relay.url, team: 'gone', member: 'bob', credential, expires_at: null });
      const r = await run({ XDG_CONFIG_HOME: xdg, RELAY_URL: relay.url });
      expect(r.status).toBe(0);
      expect(r.stdout.trimEnd().split('\n')).toHaveLength(1);
      expect(r.stdout.trimEnd()).toBe(
        "team-relay: Not connected: your saved sign-in was for a team relay that no longer answers; run /team-relay:setup to sign in again.",
      );
      expect(r.stdout).not.toContain('check the relay URL');
      expect(r.stdout + r.stderr).not.toContain(credential);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it('a saved sign-in the configured relay refuses (401) keeps its own line', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'team-relay-session-start-'));
    try {
      writeCredential(join(xdg, 'team-relay', 'credentials.json'), { relay_url: relay.url, team: 'demo', member: 'bob', credential: `trc_${'Z'.repeat(43)}`, expires_at: null });
      const r = await run({ XDG_CONFIG_HOME: xdg, RELAY_URL: relay.url });
      expect(r.stdout.trimEnd()).toBe(
        'team-relay: Not connected: the relay refused your sign-in (signed out, expired, or no longer on the team); run /team-relay:login again.',
      );
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it('in a session without the channel, the same one line also says answers are not shown and how to start one', async () => {
    const note =
      "This session was not started with the team-relay channel, so teammates' answers are not shown here. " +
      'Start one with: claude --dangerously-load-development-channels plugin:team-relay@team-relay-dev';
    const connected = await run({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: TOKEN_OF.alice!, TEAM_RELAY_CHANNEL: '0' });
    expect(connected.status).toBe(0);
    expect(connected.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(connected.stdout).toMatch(/^team-relay: you are alice in team demo; teammates: bob, carol/);
    expect(connected.stdout.trimEnd().endsWith(note)).toBe(true);
    const unconfigured = await run({ TEAM_RELAY_CHANNEL: '0' });
    expect(unconfigured.stdout).toMatch(/^team-relay: Not connected: run \/team-relay:login/);
    expect(unconfigured.stdout.trimEnd().endsWith(note)).toBe(true);
    // The marketplace comes from where the plugin is installed.
    const installed = await run({ TEAM_RELAY_CHANNEL: '0', CLAUDE_PLUGIN_ROOT: '/home/u/.claude/plugins/cache/acme-tools/team-relay/0.1.0' });
    expect(installed.stdout.trimEnd()).toMatch(/Start one with: claude --dangerously-load-development-channels plugin:team-relay@acme-tools$/);
    // A channel session: no note.
    const channel = await run({ RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_AUTH: 'token', RELAY_TOKEN: TOKEN_OF.alice! });
    expect(channel.stdout).not.toContain('not started with the team-relay channel');
  });
});
