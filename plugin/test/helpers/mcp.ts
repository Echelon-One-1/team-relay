// Spawn a bundled server over stdio with the MCP client SDK, playing Claude Code.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export type ChannelNotification = { content: string; meta: Record<string, string> };

export type Spawned = {
  client: Client;
  notifications: ChannelNotification[];
  otherNotifications: Array<{ method: string; params?: unknown }>;
  stderr: () => string;
  close: () => Promise<void>;
};

/**
 * Minimal parent environment for a spawned server: only what node needs, plus `env`. The
 * suites use static test tokens, so RELAY_AUTH is `token` unless `env` says otherwise (the
 * default, `google`, is covered by identity.test.ts with a fake gcloud). The test process is
 * no Claude Code session, so each server is told it is a channel session (TEAM_RELAY_CHANNEL=1)
 * unless `env` says otherwise; channel-mode.test.ts covers the detection itself.
 */
export function baseEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    RELAY_AUTH: 'token',
    TEAM_RELAY_CHANNEL: '1',
    // M8: a channel working session answers on its own; the suites that are not about that
    // turn it off (test/answer-host*.test.ts turn it on), and nothing pops a real notification.
    TEAM_RELAY_AUTO_ANSWER: '0',
    TEAM_RELAY_DESKTOP_NOTIFY: '0',
    // test/helpers/isolate.ts: never the developer's own stored sign-in.
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
  };
  return { ...out, ...env };
}

export async function spawnServer(bundle: 'channel.js' | 'capabilities.js', env: Record<string, string>): Promise<Spawned> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST + bundle],
    env: baseEnv(env),
    stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const client = new Client({ name: 'test-claude-code', version: '0.0.0' }, { capabilities: {} });
  const notifications: ChannelNotification[] = [];
  const otherNotifications: Array<{ method: string; params?: unknown }> = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') notifications.push(n.params as ChannelNotification);
    else otherNotifications.push(n);
  };
  await client.connect(transport);
  return {
    client,
    notifications,
    otherNotifications,
    stderr: () => err,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The entries test/fixtures/fake-browser.mjs logged to `file` (FAKE_BROWSER_LOG), once there
 * are `count` complete lines. The fake browser is its own process and logs only after its
 * callback request has its answer, while the sign-in on the plugin's side ends on that same
 * request: a sign-in that has finished says nothing about whether the log is written yet.
 */
export async function browserLog(file: string, count = 1): Promise<Array<Record<string, unknown>>> {
  const lines = await waitFor(
    () => {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      // Only whole lines: the browser appends each entry with its newline in one write.
      const whole = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
      return whole.length >= count ? whole : null;
    },
    10_000,
    `the fake browser's log (${file})`,
  );
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return (r.content ?? []).map((c) => c.text ?? '').join('');
}

/**
 * Wait until `fn` holds, however long that takes: no deadline of its own (the test's timeout
 * bounds it). For conditions that must come, such as a log line or a reply.
 */
export async function until<T>(fn: () => T | undefined | false | null): Promise<T> {
  for (;;) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
}
