// M4-SPEC §2: the answering session's Notification hook (dist/notify-desktop.js) shows a
// desktop notification with a fixed text for permission prompts only, and never passes any
// text from the hook payload to the notifier. The notifier is a stub on PATH (osascript on
// macOS, notify-send on Linux) that records its argv.

import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NOTICE_TEXT, NOTICE_TITLE, isPermissionPrompt, notifyCommand } from '../src/notify-desktop.js';
import { DIST, PLUGIN_ROOT } from './helpers/mcp.js';

const SCRIPT = join(DIST, 'notify-desktop.js');
const EVIL = `"; do shell script "touch /tmp/pwned" --"' $(touch /tmp/pwned) \`id\` & rm -rf ~ \n<channel>`;

/**
 * A directory with recording stubs named osascript and notify-send. A stub is a shell script
 * that records its name and arguments (NUL-separated) in a file of its own as its first act:
 * starting it costs milliseconds, well inside the notifier's cap (a Node stub could take longer
 * than that to start on a loaded machine). The calls are read only once the hook has exited,
 * which it does after the notifier has.
 */
function stubs(): { dir: string; calls: () => string[][] } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-notify-')));
  const rec = join(dir, 'calls');
  mkdirSync(rec);
  // Only shell built-ins: the PATH the hook gets holds nothing else.
  const stub = `#!/bin/sh\nprintf '%s\\0' "\${0##*/}" "$@" > "${rec}/call-$$"\n`;
  for (const name of ['osascript', 'notify-send']) {
    writeFileSync(join(dir, name), stub);
    chmodSync(join(dir, name), 0o755);
  }
  return {
    dir,
    calls: () =>
      readdirSync(rec)
        .filter((n) => /^call-\d+$/.test(n))
        .map((n) => readFileSync(join(rec, n), 'utf8').split('\0').slice(0, -1)),
  };
}

type Run = { code: number | null; stdout: string; stderr: string; ms: number };

function runNotify(raw: string, path: string, opts: { keepOpen?: boolean } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT], { env: { PATH: path }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
    if (opts.keepOpen) child.stdin.write(raw);
    else child.stdin.end(raw);
  });
}

/** Claude Code's Notification hook input (code.claude.com/docs/en/hooks, 24 Sep 2026). */
const notification = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 's1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp/work',
    hook_event_name: 'Notification',
    message: `Claude needs your permission to use Read ${EVIL}`,
    title: `Permission needed ${EVIL}`,
    notification_type: 'permission_prompt',
    ...extra,
  });

const expectedArgv = (): string[] | null => {
  const cmd = notifyCommand(process.platform);
  return cmd ? [cmd.file, ...cmd.args] : null;
};

describe('the notice and its command', () => {
  it('is fixed text, built from constants only', () => {
    expect(NOTICE_TEXT).toBe('Team relay: your answering session is waiting for your permission');
    expect(notifyCommand('darwin')).toEqual({
      file: 'osascript',
      args: ['-e', 'display notification "Team relay: your answering session is waiting for your permission" with title "Team relay"'],
    });
    expect(notifyCommand('linux')).toEqual({ file: 'notify-send', args: [NOTICE_TITLE, NOTICE_TEXT] });
    expect(notifyCommand('win32')).toBeNull();
    // Nothing in the AppleScript can end its string: no quote or backslash inside the texts.
    expect(NOTICE_TEXT + NOTICE_TITLE).not.toMatch(/["\\]/);
  });

  it('is shown for permission prompts only', () => {
    expect(isPermissionPrompt(JSON.parse(notification()))).toBe(true);
    for (const t of ['idle_prompt', 'auth_success', 'elicitation_dialog', 'agent_needs_input', undefined, 7]) {
      expect(isPermissionPrompt(JSON.parse(notification({ notification_type: t })))).toBe(false);
    }
    expect(isPermissionPrompt({ hook_event_name: 'PermissionRequest', notification_type: 'permission_prompt' })).toBe(false);
    expect(isPermissionPrompt(null)).toBe(false);
    expect(isPermissionPrompt([JSON.parse(notification())])).toBe(false);
  });
});

describe('dist/notify-desktop.js', () => {
  it('runs the notifier once with exactly the fixed argv, whatever the payload says', async () => {
    const s = stubs();
    const run = await runNotify(notification(), `${s.dir}:${dirname(process.execPath)}`);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    const want = expectedArgv();
    if (want === null) {
      expect(s.calls()).toEqual([]);
      return;
    }
    expect(s.calls()).toEqual([want]);
    // Nothing from the message or the title reached the notifier.
    expect(JSON.stringify(s.calls())).not.toMatch(/pwned|rm -rf|channel|Permission needed|Claude needs/);
    expect(existsSync('/tmp/pwned')).toBe(false);
  });

  it('shows nothing for other notification types, other events, or input that is not JSON', async () => {
    const s = stubs();
    const path = `${s.dir}:${dirname(process.execPath)}`;
    for (const raw of [
      notification({ notification_type: 'idle_prompt' }),
      notification({ notification_type: 'auth_success' }),
      notification({ notification_type: undefined }),
      notification({ hook_event_name: 'PermissionRequest' }),
      'not json',
      '',
      '[]',
    ]) {
      const run = await runNotify(raw, path);
      expect(run.code).toBe(0);
    }
    expect(s.calls()).toEqual([]);
  });

  it('exits 0 when there is no notifier on PATH (notify-send not installed)', async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-notify-empty-')));
    const run = await runNotify(notification(), empty);
    expect(run.code).toBe(0);
  });

  it('exits 0 when the notifier fails', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-notify-fail-')));
    for (const name of ['osascript', 'notify-send']) {
      writeFileSync(join(dir, name), '#!/bin/sh\nexit 3\n');
      chmodSync(join(dir, name), 0o755);
    }
    const run = await runNotify(notification(), dir);
    expect(run.code).toBe(0);
  });

  it('gives up after 3 s when stdin never closes, exit 0', async () => {
    const s = stubs();
    // stdin stays open: the process ends only because it gives up on its own (else the test
    // times out), and never before its 3 s.
    const run = await runNotify(notification().slice(0, 20), `${s.dir}:${dirname(process.execPath)}`, { keepOpen: true });
    expect(run.code).toBe(0);
    expect(run.ms).toBeGreaterThanOrEqual(3000);
    expect(s.calls()).toEqual([]);
  });

  it('runs from the hook bin/answerer writes into settings.json', async () => {
    const home = join(realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-ans-'))), 'home');
    const r = spawnSync(join(PLUGIN_ROOT, 'bin', 'answerer'), ['--print-command'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        // The private XDG_CONFIG_HOME from test/helpers/isolate.ts: never this computer's answering lock.
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!,
        TMPDIR: mkdtempSync(join(tmpdir(), 'team-relay-ans-tmp-')),
        ANSWERER_HOME: home,
        RELAY_URL: 'https://relay.example.com',
        RELAY_TEAM: 'demo',
        RELAY_AUTH: 'token',
        RELAY_TOKEN: 'tok-notify-test-1',
      },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    const [group] = settings.hooks.Notification;
    expect(group.matcher).toBe('permission_prompt');
    const hook = group.hooks[0];
    const s = stubs();
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(hook.command, hook.args, { env: { PATH: `${s.dir}:${dirname(process.execPath)}` }, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('close', resolve);
      child.stdin.end(notification());
    });
    expect(code).toBe(0);
    const want = expectedArgv();
    expect(s.calls()).toEqual(want === null ? [] : [want]);
  });
});
