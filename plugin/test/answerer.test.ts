import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { FIXTURES, PLUGIN_ROOT, textOf } from './helpers/mcp.js';

const ANSWERER = join(PLUGIN_ROOT, 'bin', 'answerer');

/** M2-SPEC §4.2 and §7.5: paths in the home directory, exactly as listed there. */
const HOME_PATHS = [
  '~/.ssh/**', '~/.gnupg/**', '~/.aws/**', '~/.config/gcloud/**', '~/.azure/**', '~/.kube/**', '~/.docker/**',
  '~/.netrc', '~/.npmrc', '~/.pypirc', '~/.git-credentials', '~/.claude/**', '~/.claude-team-relay/**',
  // M5-SPEC §6: the team relay's own device credential.
  '~/.config/team-relay/**',
  '~/Library/Keychains/**',
  // §7.5
  '~/.config/gh/**', '~/.zsh_history', '~/.bash_history', '~/.*_history',
  '~/Library/Application Support/**/Cookies*', '~/Library/Application Support/Firefox/**',
  '~/Library/Application Support/Google/Chrome/**', '~/.terraform.d/**', '~/.cargo/credentials*',
  '~/.vault-token', '~/.pgpass', '~/.config/solana/**', '~/.foundry/**', '~/.ethereum/**',
];
/** M2-SPEC §4.2 and §7.5: files that can be anywhere. */
const ANY_DEPTH = [
  '**/.env', '**/.env.*', '**/.envrc', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*',
  '**/*.p12', '**/*.pfx', '**/*.keystore', '**/*.jks', '**/credentials.json', '**/*.tfvars', '**/keystore/**',
  // M8-SPEC §7 item 2
  '**/.npmrc', '**/.netrc', '**/.pypirc', '**/.git-credentials', '**/id_ecdsa*', '**/id_dsa*', '**/*.ppk',
  '**/*.tfstate', '**/*.tfstate.*', '**/.aws/**', '**/.kube/**',
];

/** The whole deny list the launcher must write, in order. */
function expectedDeny(home: string, tokenFile: string | null, extra: string[] = []): string[] {
  return [
    'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task',
    ...HOME_PATHS.map((p) => `Read(${p})`),
    // As listed (from the empty working directory), home-anchored and root-anchored.
    ...ANY_DEPTH.flatMap((p) => [`Read(${p})`, `Read(~/${p})`, `Read(//${p})`]),
    // The session's own files.
    ...['~/.claude.json', `/${home}/**`].map((p) => `Read(${p})`),
    ...(tokenFile ? [`Read(/${tokenFile})`] : []),
    // M5-SPEC §6: the credential directory under XDG_CONFIG_HOME (test/helpers/isolate.ts sets it).
    `Read(/${XDG}/team-relay/**)`,
    ...extra.map((p) => `Read(${p})`),
  ];
}
/** The hooks the launcher must write (M2-SPEC §4.3, §7.4; M4-SPEC §2), exactly. */
function expectedHooks(home: string) {
  const nodeBin = spawnSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim();
  const toolEvent = {
    type: 'command',
    command: nodeBin,
    args: [join(PLUGIN_ROOT, 'dist', 'tool-event.js'), '--config', join(home, 'tool-event.json')],
    async: true,
    timeout: 5,
  };
  const notify = { type: 'command', command: nodeBin, args: [join(PLUGIN_ROOT, 'dist', 'notify-desktop.js')], async: true, timeout: 5 };
  return {
    PostToolUse: [{ matcher: '*', hooks: [toolEvent] }],
    PostToolUseFailure: [{ matcher: '*', hooks: [toolEvent] }],
    PermissionRequest: [{ matcher: '*', hooks: [toolEvent] }],
    Notification: [{ matcher: 'permission_prompt', hooks: [notify] }],
  };
}
const TOKEN = 'tok-bob-answerer-secret-7';
/** test/helpers/isolate.ts: an empty private XDG_CONFIG_HOME, so no stored sign-in unless a test writes one. */
const XDG = process.env.XDG_CONFIG_HOME!;

// Each run gets its own TMPDIR, so the default working directory is a fresh one under it
// and no test touches the real ${TMPDIR}/team-relay-answerer-<uid>.
function runAnswerer(env: Record<string, string>, args: string[] = ['--print-command']) {
  return spawnSync(ANSWERER, args, {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: mkdtempSync(join(tmpdir(), 'team-relay-ans-tmp-')),
      XDG_CONFIG_HOME: XDG,
      // Static test tokens; the google default has its own tests below.
      RELAY_AUTH: 'token',
      ...env,
    },
    encoding: 'utf8',
  });
}

function setup(extra: Record<string, string> = {}) {
  const home = extra.ANSWERER_HOME ?? join(mkdtempSync(join(tmpdir(), 'team-relay-ans-')), 'home');
  const r = runAnswerer({
    ANSWERER_HOME: home,
    RELAY_URL: 'http://127.0.0.1:8080',
    RELAY_TEAM: 'demo',
    RELAY_TOKEN: TOKEN,
    CAP_STAGING_DB_QUERY_ENABLED: 'true',
    CAP_STAGING_DB_QUERY_RUNNER: '/opt/runners/staging db query',
    ...extra,
  });
  // The script resolves symlinks (macOS tmp is /var -> /private/var).
  return { home: r.status === 0 ? realpathSync(home) : home, r };
}

describe('bin/answerer --print-command', () => {
  it('prints the isolated, strict session command and runs nothing', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-ans-tmp-')));
    const { home, r } = setup({ TMPDIR: `${tmp}/` });
    expect(r.status, r.stderr).toBe(0);
    const cmd = r.stdout.trim();
    expect(cmd.split('\n')).toHaveLength(1);
    expect(cmd.startsWith(`cd ${tmp}/team-relay-answerer-${process.getuid!()}/work &&`)).toBe(true);
    expect(cmd).toContain(`CLAUDE_CONFIG_DIR=${home}/config`);
    expect(cmd).toContain('env -u RELAY_TOKEN');
    expect(cmd).toContain(` claude --mcp-config ${home}/mcp.json --strict-mcp-config --settings ${home}/settings.json`);
    expect(cmd).toContain('--disallowedTools Bash Write Edit NotebookEdit WebFetch WebSearch');
    expect(cmd).toContain('--dangerously-load-development-channels server:relay');
    expect(cmd).not.toContain(TOKEN);
  });

  it('writes mcp.json with both servers, explicit env, and the token only by file', () => {
    const { home } = setup();
    const raw = readFileSync(join(home, 'mcp.json'), 'utf8');
    expect(raw).not.toContain(TOKEN);
    const mcp = JSON.parse(raw);
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['capabilities', 'relay']);
    const { relay, capabilities } = mcp.mcpServers;
    expect(relay.args).toEqual([join(PLUGIN_ROOT, 'dist', 'channel.js')]);
    expect(capabilities.args).toEqual([join(PLUGIN_ROOT, 'dist', 'capabilities.js')]);
    expect(relay.env).toMatchObject({
      RELAY_ROLE: 'answerer',
      RELAY_URL: 'http://127.0.0.1:8080',
      RELAY_TEAM: 'demo',
      RELAY_TOKEN_FILE: join(home, 'token'),
      MANIFEST_PATH: join(PLUGIN_ROOT, 'manifest.yaml'),
      ALLOW_PRODUCTION: 'false',
      CAP_STAGING_DB_QUERY_ENABLED: 'true',
      CAP_STAGING_DB_QUERY_RUNNER: '/opt/runners/staging db query',
    });
    // The answering session is started with the relay channel: its channel server is told so.
    expect(relay.env.TEAM_RELAY_CHANNEL).toBe('1');
    expect(capabilities.env.TEAM_RELAY_CHANNEL).toBeUndefined();
    expect(relay.env.RELAY_TOKEN).toBeUndefined();
    expect(capabilities.env.RELAY_TOKEN).toBeUndefined();
    expect(capabilities.env.RELAY_ROLE).toBeUndefined();
    expect(capabilities.env.RELAY_TOKEN_FILE).toBe(join(home, 'token'));
    expect(readFileSync(join(home, 'token'), 'utf8')).toBe(`${TOKEN}\n`);
    expect(statSync(join(home, 'token')).mode & 0o777).toBe(0o600);
  });

  it('uses an existing RELAY_TOKEN_FILE instead of writing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-relay-ans-tok-'));
    const tokenFile = join(dir, 'bob.token');
    writeFileSync(tokenFile, `${TOKEN}\n`);
    const { home, r } = setup({ RELAY_TOKEN: '', RELAY_TOKEN_FILE: tokenFile });
    expect(r.status, r.stderr).toBe(0);
    const mcp = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.relay.env.RELAY_TOKEN_FILE).toMatch(/bob\.token$/);
    expect(() => statSync(join(home, 'token'))).toThrow();
  });

  it('writes settings.json exactly: normal permission mode, nothing readable by default, the deny list intact (M4-SPEC §1)', () => {
    const { home } = setup();
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    expect(settings.permissions).toEqual({
      // Manual mode (config value "default"): anything not allowed prompts; auto and bypass cannot be entered.
      defaultMode: 'default',
      disableAutoMode: 'disable',
      disableBypassPermissionsMode: 'disable',
      deny: expectedDeny(home, join(home, 'token')),
      // No shared folder: no read rule at all, and never a bare Read, Glob or Grep.
      allow: ['mcp__relay__*', 'mcp__capabilities__*'],
    });
    expect(settings.hooks).toEqual(expectedHooks(home));
    expect(Object.keys(settings).sort()).toEqual(['hooks', 'permissions']);
    // Nothing that reads, writes, runs or reaches the web is allowed as a whole tool.
    for (const tool of ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task']) {
      expect(settings.permissions.allow).not.toContain(tool);
      expect(settings.permissions.allow.some((a: string) => a.startsWith(`${tool}(`) && tool !== 'Read')).toBe(false);
    }
  });

  it('starts claude in the normal permission mode (not dontAsk, not auto)', () => {
    const { r } = setup();
    expect(r.stdout).toContain(' --settings ');
    expect(r.stdout).toContain(' --permission-mode default --disallowedTools ');
    expect(r.stdout).not.toMatch(/dontAsk|--permission-mode (auto|acceptEdits|bypassPermissions|plan)|dangerously-skip-permissions/);
  });

  it('has no Glob(...) or Grep(...) path rule, and a Read rule for every §7.5 path in every form', () => {
    const { home } = setup();
    const deny: string[] = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).permissions.deny;
    // Claude Code never evaluates them (it applies Read rules to Glob and Grep): §7.5.
    expect(deny.filter((d) => /^(Glob|Grep)\(/.test(d))).toEqual([]);
    for (const p of HOME_PATHS) expect(deny).toContain(`Read(${p})`);
    for (const p of ANY_DEPTH) {
      for (const form of [p, `~/${p}`, `//${p}`]) expect(deny).toContain(`Read(${form})`);
    }
    // Spot checks against the text of §7.5, so a typo in both lists above still fails.
    for (const rule of [
      'Read(~/.config/gh/**)', 'Read(~/.*_history)', 'Read(~/Library/Application Support/**/Cookies*)',
      'Read(~/.cargo/credentials*)', 'Read(//**/.envrc)', 'Read(~/**/credentials.json)', 'Read(//**/keystore/**)',
      'Read(//**/*.tfvars)', 'Read(~/.vault-token)', 'Read(~/.pgpass)', 'Read(~/.foundry/**)',
    ]) {
      expect(deny).toContain(rule);
    }
    // Every rule is a bare tool name or a Read path rule.
    for (const d of deny) expect(d).toMatch(/^(Bash|Write|Edit|NotebookEdit|WebFetch|WebSearch|Agent|Task|Read\(.+\))$/);
    expect(new Set(deny).size).toBe(deny.length);
  });

  it('adds the hooks in exec form, async: tool events, waiting on a permission request, and the desktop notice for permission prompts only', () => {
    const { home } = setup();
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    expect(settings.hooks).toEqual(expectedHooks(home));
    for (const groups of Object.values(settings.hooks) as Array<Array<{ hooks: Array<Record<string, unknown>> }>>) {
      for (const h of groups.flatMap((g) => g.hooks)) {
        // Exec form (args, no shell), in the background, from an absolute node.
        expect(h.async).toBe(true);
        expect(Array.isArray(h.args)).toBe(true);
        expect(String(h.command).startsWith('/')).toBe(true);
      }
    }
    // M4-SPEC §2: the notice runs for permission prompts, not for idle or other notifications.
    expect(settings.hooks.Notification.map((g: { matcher: string }) => g.matcher)).toEqual(['permission_prompt']);
    expect(Object.keys(settings).sort()).toEqual(['hooks', 'permissions']);
  });

  it('writes tool-event.json (no secret in it) and a mode-700 state directory the answerer channel records into', () => {
    const { home } = setup();
    const cfg = JSON.parse(readFileSync(join(home, 'tool-event.json'), 'utf8'));
    expect(cfg).toEqual({
      relay_url: 'http://127.0.0.1:8080',
      relay_team: 'demo',
      relay_auth: 'token',
      state_dir: join(home, 'state'),
      token_file: join(home, 'token'),
    });
    expect(readFileSync(join(home, 'tool-event.json'), 'utf8')).not.toContain(TOKEN);
    expect(statSync(join(home, 'tool-event.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'state')).mode & 0o777).toBe(0o700);
    const mcp = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers.relay.env.ANSWERER_STATE_DIR).toBe(join(home, 'state'));
    expect(mcp.mcpServers.capabilities.env.ANSWERER_STATE_DIR).toBeUndefined();
  });

  it('also disallows Agent and Task on the command line', () => {
    const { r } = setup();
    expect(r.stdout).toContain(' --disallowedTools Bash Write Edit NotebookEdit WebFetch WebSearch Agent Task --dangerously-load-development-channels');
  });

  it('escapes glob characters in its own paths when it denies reading them', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-ans-')));
    const odd = join(base, 'a[b]*c?');
    const { r } = setup({ ANSWERER_HOME: odd });
    expect(r.status, r.stderr).toBe(0);
    const deny: string[] = JSON.parse(readFileSync(join(odd, 'settings.json'), 'utf8')).permissions.deny;
    const esc = (p: string) => p.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`);
    expect(deny).toContain(`Read(/${esc(odd)}/**)`);
    expect(deny).toContain(`Read(/${esc(join(odd, 'token'))})`);
    expect(deny.some((d) => d.includes('a[b]'))).toBe(false);
  });

  it('creates the home and config directories with mode 700, the files with 600, and no work/ under home', () => {
    const { home } = setup();
    for (const d of ['', 'config']) expect(statSync(join(home, d)).mode & 0o777).toBe(0o700);
    for (const f of ['mcp.json', 'settings.json']) expect(statSync(join(home, f)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, 'work'))).toBe(false);
  });

  it('passes production opt-in only as the exact string true', () => {
    const { home } = setup({ ALLOW_PRODUCTION: 'yes' });
    expect(JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')).mcpServers.relay.env.ALLOW_PRODUCTION).toBe('false');
    const second = setup({ ALLOW_PRODUCTION: 'true' });
    expect(JSON.parse(readFileSync(join(second.home, 'mcp.json'), 'utf8')).mcpServers.capabilities.env.ALLOW_PRODUCTION).toBe('true');
  });

  it('keeps awkward values intact as JSON (no splicing into JSON text)', () => {
    const { home, r } = setup({ CAP_SERVICE_HEALTH_RUNNER: '/opt/x"y\\z/run', CAP_SERVICE_HEALTH_ENABLED: 'true' });
    expect(r.status, r.stderr).toBe(0);
    const env = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')).mcpServers.capabilities.env;
    expect(env.CAP_SERVICE_HEALTH_RUNNER).toBe('/opt/x"y\\z/run');
  });

  it('passes extra arguments through to claude, quoted', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'team-relay-ans-')), 'home');
    const r = runAnswerer(
      { ANSWERER_HOME: home, RELAY_URL: 'https://relay.example.com', RELAY_TEAM: 'demo', RELAY_TOKEN: TOKEN },
      ['--print-command', '--model', 'a b'],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().endsWith('--model a\\ b')).toBe(true);
  });

  it('fails clearly when required settings are missing', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'team-relay-ans-')), 'home');
    // M5-SPEC §6: without a stored sign-in and without a team, there is nothing to sign in to.
    const noTeam = runAnswerer({ ANSWERER_HOME: home, RELAY_AUTH: '', RELAY_URL: 'https://relay.example.com' });
    expect(noTeam.status).not.toBe(0);
    expect(noTeam.stderr).toMatch(/not connected: run \/team-relay:login in Claude Code first/);
    const noToken = runAnswerer({ ANSWERER_HOME: home, RELAY_URL: 'https://relay.example.com', RELAY_TEAM: 'demo' });
    expect(noToken.status).not.toBe(0);
    expect(noToken.stderr).toMatch(/RELAY_TOKEN/);
    expect(noToken.stderr).not.toContain(TOKEN);
  });

  it('is a bash script with strict mode', () => {
    const text = readFileSync(ANSWERER, 'utf8');
    expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(text).toContain('set -euo pipefail');
    expect(statSync(ANSWERER).mode & 0o111).not.toBe(0);
  });
});

describe('bin/answerer with RELAY_AUTH=google (M2-SPEC §4.1)', () => {
  function googleSetup(extra: Record<string, string> = {}) {
    return setup({ RELAY_AUTH: '', RELAY_TOKEN: '', ...extra });
  }

  it('is the default, needs no token, and stores none', () => {
    const { home, r } = googleSetup({ RELAY_GCLOUD_ACCOUNT: 'bob@example.com', CLOUDSDK_CONFIG: '/opt/gcloud-config', CLOUDSDK_CORE_PROJECT: 'demo-project' });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(home, 'token'))).toBe(false);
    const mcp = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'));
    for (const name of ['relay', 'capabilities']) {
      const env = mcp.mcpServers[name].env;
      expect(env).toMatchObject({
        RELAY_AUTH: 'google',
        RELAY_GCLOUD_ACCOUNT: 'bob@example.com',
        CLOUDSDK_CONFIG: '/opt/gcloud-config',
        CLOUDSDK_CORE_PROJECT: 'demo-project',
      });
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.RELAY_TOKEN_FILE).toBeUndefined();
      expect(env.RELAY_TOKEN).toBeUndefined();
    }
    expect(JSON.parse(readFileSync(join(home, 'tool-event.json'), 'utf8'))).toEqual({
      relay_url: 'http://127.0.0.1:8080',
      relay_team: 'demo',
      relay_auth: 'google',
      state_dir: join(home, 'state'),
      gcloud_account: 'bob@example.com',
    });
    const deny: string[] = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).permissions.deny;
    expect(deny).toEqual(expectedDeny(home, null, ['//opt/gcloud-config/**']));
  });

  it('ignores a RELAY_TOKEN and removes a token file a token-mode run left behind', () => {
    const first = setup();
    expect(existsSync(join(first.home, 'token'))).toBe(true);
    const again = runAnswerer({
      ANSWERER_HOME: first.home,
      RELAY_URL: 'http://127.0.0.1:8080',
      RELAY_TEAM: 'demo',
      RELAY_AUTH: 'google',
      RELAY_TOKEN: TOKEN,
    });
    expect(again.status, again.stderr).toBe(0);
    expect(existsSync(join(first.home, 'token'))).toBe(false);
    for (const f of ['mcp.json', 'settings.json', 'tool-event.json']) {
      expect(readFileSync(join(first.home, f), 'utf8')).not.toContain(TOKEN);
    }
  });

  it('refuses an unknown RELAY_AUTH and an account that is not an email address', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'team-relay-ans-')), 'home');
    const base = { ANSWERER_HOME: home, RELAY_URL: 'https://relay.example.com', RELAY_TEAM: 'demo' };
    const badMode = runAnswerer({ ...base, RELAY_AUTH: 'basic' });
    expect(badMode.status).not.toBe(0);
    expect(badMode.stderr).toMatch(/RELAY_AUTH must be credential, google or token/);
    const badAccount = runAnswerer({ ...base, RELAY_AUTH: 'google', RELAY_GCLOUD_ACCOUNT: '--impersonate-service-account=x@y.z' });
    expect(badAccount.status).not.toBe(0);
    expect(badAccount.stderr).toMatch(/RELAY_GCLOUD_ACCOUNT must be an account email address/);
    expect(existsSync(join(home, 'mcp.json'))).toBe(false);
  });
});

describe('bin/answerer working directory (§11.13)', () => {
  const base = () => realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-wd-')));
  const settings = (extra: Record<string, string>) => ({
    ANSWERER_HOME: join(base(), 'home'),
    RELAY_URL: 'https://relay.example.com',
    RELAY_TEAM: 'demo',
    RELAY_TOKEN: TOKEN,
    ...extra,
  });
  function refused(extra: Record<string, string>, why: RegExp) {
    const env = settings(extra);
    const r = runAnswerer(env);
    expect(r.status, r.stdout).not.toBe(0);
    expect(r.stderr).toMatch(why);
    expect(r.stdout).toBe('');
    // Refused before anything was written.
    expect(existsSync(join(env.ANSWERER_HOME, 'mcp.json'))).toBe(false);
    return r;
  }

  it('defaults to ${TMPDIR}/team-relay-answerer-<uid>/work, both levels mode 700, and runs from it', () => {
    const tmp = base();
    const r = runAnswerer(settings({ TMPDIR: tmp }));
    expect(r.status, r.stderr).toBe(0);
    const parent = join(tmp, `team-relay-answerer-${process.getuid!()}`);
    expect(statSync(parent).mode & 0o777).toBe(0o700);
    expect(statSync(join(parent, 'work')).mode & 0o777).toBe(0o700);
    expect(r.stdout.startsWith(`cd ${join(parent, 'work')} &&`)).toBe(true);
    // Reusable: an empty existing directory is fine, and a loose mode is tightened.
    chmodSync(join(parent, 'work'), 0o755);
    const again = runAnswerer(settings({ TMPDIR: tmp }));
    expect(again.status, again.stderr).toBe(0);
    expect(statSync(join(parent, 'work')).mode & 0o777).toBe(0o700);
  });

  it('uses ANSWERER_WORKDIR, creating it when missing', () => {
    const dir = join(base(), 'a', 'b', 'work');
    const r = runAnswerer(settings({ ANSWERER_WORKDIR: dir }));
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(r.stdout.startsWith(`cd ${dir} &&`)).toBe(true);
  });

  it('refuses a working directory inside $HOME, however it is reached', () => {
    const home = base();
    refused({ HOME: home, ANSWERER_WORKDIR: join(home, 'answerer-work') }, /inside \$HOME/);
    refused({ HOME: home, ANSWERER_WORKDIR: home }, /inside \$HOME/);
    // Through a symlink that points into $HOME.
    const outside = base();
    symlinkSync(home, join(outside, 'link-to-home'));
    refused({ HOME: home, ANSWERER_WORKDIR: join(outside, 'link-to-home', 'work') }, /inside \$HOME/);
    // A TMPDIR inside $HOME makes the default refused too.
    refused({ HOME: home, TMPDIR: join(home, 'tmp') }, /inside \$HOME/);
    expect(existsSync(join(home, 'answerer-work'))).toBe(false);
  });

  for (const name of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/rules', '.claude/settings.json', '.claude/settings.local.json']) {
    it(`refuses when an ancestor holds ${name}`, () => {
      const root = base();
      const target = join(root, name);
      mkdirSync(join(target, '..'), { recursive: true });
      if (name.endsWith('rules')) mkdirSync(target);
      else writeFileSync(target, '# memory\n');
      refused({ ANSWERER_WORKDIR: join(root, 'x', 'work') }, new RegExp(`${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} would load`));
      // The same file in the working directory itself (its own .claude/settings.local.json is
      // where a previous session saved grants: removed at start instead, tested below).
      if (name === '.claude/settings.local.json') return;
      const own = join(base(), 'work');
      mkdirSync(join(own, name, '..'), { recursive: true });
      if (name.endsWith('rules')) mkdirSync(join(own, name));
      else writeFileSync(join(own, name), '# memory\n');
      refused({ ANSWERER_WORKDIR: own }, /would load into the answering session/);
    });
  }

  describe('grants never outlive a session (M4-SPEC §1)', () => {
    const GRANT = JSON.stringify({ permissions: { allow: ['Read(//Users/bob/private/**)'] } });  // e1-guard: allow (synthetic macOS home path in a test)
    const plant = (dir: string) => {
      mkdirSync(join(dir, '.claude'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, '.claude', 'settings.local.json'), GRANT);
    };

    it('removes the working directory\'s .claude/settings.local.json a previous session left, and starts', () => {
      const dir = join(base(), 'work');
      plant(dir);
      const r = runAnswerer(settings({ ANSWERER_WORKDIR: dir }));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain(join(dir, '.claude', 'settings.local.json'));
      expect(existsSync(join(dir, '.claude'))).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    });

    it('does the same in the default working directory', () => {
      const tmp = base();
      const dir = join(tmp, `team-relay-answerer-${process.getuid!()}`, 'work');
      plant(dir);
      const r = runAnswerer(settings({ TMPDIR: tmp }));
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    });

    it('still refuses anything else in the working directory, beside the grants file or in .claude/', () => {
      const beside = join(base(), 'work');
      plant(beside);
      writeFileSync(join(beside, 'notes.txt'), 'x');
      refused({ ANSWERER_WORKDIR: beside }, /must be empty/);
      expect(existsSync(join(beside, '.claude', 'settings.local.json'))).toBe(false);

      const inside = join(base(), 'work');
      plant(inside);
      writeFileSync(join(inside, '.claude', 'other.json'), '{}');
      refused({ ANSWERER_WORKDIR: inside }, /must be empty/);
      expect(existsSync(join(inside, '.claude', 'other.json'))).toBe(true);

      const memory = join(base(), 'work');
      plant(memory);
      writeFileSync(join(memory, '.claude', 'settings.json'), '{}');
      refused({ ANSWERER_WORKDIR: memory }, /settings\.json would load/);
    });

    it('never removes through a symlinked .claude, and refuses it', () => {
      const dir = join(base(), 'work');
      mkdirSync(dir);
      const elsewhere = base();
      writeFileSync(join(elsewhere, 'settings.local.json'), GRANT);
      symlinkSync(elsewhere, join(dir, '.claude'));
      refused({ ANSWERER_WORKDIR: dir }, /\.claude is a symlink/);
      expect(readFileSync(join(elsewhere, 'settings.local.json'), 'utf8')).toBe(GRANT);
    });

    it('never removes anything in a working directory reached through a symlink', () => {
      const root = base();
      const real = join(root, 'real');
      plant(real);
      symlinkSync(real, join(root, 'link'));
      refused({ ANSWERER_WORKDIR: join(root, 'link') }, /settings\.local\.json would load|is a symlink/);
      expect(readFileSync(join(real, '.claude', 'settings.local.json'), 'utf8')).toBe(GRANT);
    });
  });

  it('refuses a working directory that is not empty', () => {
    const dir = join(base(), 'work');
    mkdirSync(dir);
    writeFileSync(join(dir, '.mcp.json'), '{}');
    refused({ ANSWERER_WORKDIR: dir }, /must be empty/);
  });

  it('refuses a relative path, . or .. components, a symlink, and a file', () => {
    refused({ ANSWERER_WORKDIR: 'relative/work' }, /absolute path/);
    const root = base();
    refused({ ANSWERER_WORKDIR: `${root}/a/../work` }, /\. or \.\. components/);
    refused({ ANSWERER_WORKDIR: `${root}/./work` }, /\. or \.\. components/);
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    refused({ ANSWERER_WORKDIR: join(root, 'link') }, /is a symlink/);
    writeFileSync(join(root, 'file'), 'x');
    refused({ ANSWERER_WORKDIR: join(root, 'file') }, /not a directory/);
  });

  it('refuses a default parent directory that is a symlink (a pre-planted /tmp entry)', () => {
    const tmp = base();
    const elsewhere = base();
    symlinkSync(elsewhere, join(tmp, `team-relay-answerer-${process.getuid!()}`));
    refused({ TMPDIR: tmp }, /is a symlink/);
    expect(existsSync(join(elsewhere, 'work'))).toBe(false);
  });
});

describe('bin/answerer session files drive working servers', () => {
  it('the relay and capabilities entries in mcp.json start and authenticate via the token file', async () => {
    const relay = await new FakeRelay().start();
    const clients: Client[] = [];
    try {
      const { home, r } = setup({
        RELAY_URL: relay.url,
        RELAY_TOKEN: TOKEN_OF.bob!,
        CAP_STAGING_DB_QUERY_RUNNER: join(FIXTURES, 'fake-runner.mjs'),
      });
      expect(r.status, r.stderr).toBe(0);
      const mcp = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'));
      for (const name of ['relay', 'capabilities']) {
        const def = mcp.mcpServers[name];
        const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
        await client.connect(
          new StdioClientTransport({ command: def.command, args: def.args, env: { PATH: process.env.PATH ?? '', XDG_CONFIG_HOME: XDG, ...def.env }, stderr: 'pipe' }), // XDG: never this computer's answering lock
        );
        clients.push(client);
      }
      const [relayClient, capClient] = clients;
      expect(relayClient!.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} });
      expect((relay.manifests.get('bob') as { capabilities: Array<{ name: string }> }).capabilities.map((c) => c.name)).toEqual([
        'staging_db_query',
      ]);
      const request_id = relay.addRequest({ capability: { name: 'staging_db_query', params: { dataset: 'users', op: 'eq', limit: 20 } } });
      const res = await capClient!.callTool({ name: 'staging_db_query', arguments: { dataset: 'users', request_id } });
      expect(JSON.parse(textOf(res)).rows.length).toBeGreaterThan(0);
      expect(relay.progress).toHaveLength(2);
      // TEAM_RELAY_CHANNEL=1 from mcp.json: the channel server reads bob's inbox without looking
      // for a claude process (there is none here).
      const deadline = Date.now() + 5000;
      while (!relay.requests.some((q) => q.path === '/v1/teams/demo/streams/inbox') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(relay.requests.some((q) => q.path === '/v1/teams/demo/streams/inbox')).toBe(true);
      expect(relay.requests.every((q) => q.member === 'bob')).toBe(true);
    } finally {
      for (const c of clients) await c.close().catch(() => {});
      await relay.stop();
    }
  });
});

describe('bin/answerer ANSWERER_READ_DIRS: shared folders (M4-SPEC §1, §3)', () => {
  const esc = (p: string) => p.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`);
  /** A synthetic $HOME with folders to share and credential locations to refuse. */
  function fakeHome() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-rd-home-')));
    for (const d of [
      'src/app',
      'My Notes',
      'odd[1]*',
      'docs/app',
      '.ssh/keys',
      '.config/gcloud/configurations',
      '.config/gh/hosts',
      'Library/Application Support/Google/Chrome/Default',
      'Library/Application Support/Arc/Cookies-store',
      'proj/keystore/sub',
      'proj/.env',
      'proj/prod.pem',
      '.claude/projects',
      '.claude-team-relay/x',
      '.foundry/cache',
      'custom-claude/sub',
      'gcloud-conf/sub',
      'relay-home/state',
    ]) {
      mkdirSync(join(home, d), { recursive: true });
    }
    writeFileSync(join(home, 'file.txt'), 'x');
    symlinkSync(join(home, 'src', 'app'), join(home, 'link-to-app'));
    symlinkSync(join(home, '.ssh', 'keys'), join(home, 'link-to-ssh'));
    return home;
  }
  function run(home: string, readDirs: string | undefined, extra: Record<string, string> = {}) {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-rd-tmp-')));
    const answererHome = join(home, 'relay-home');
    const r = runAnswerer({
      HOME: home,
      TMPDIR: tmp,
      ANSWERER_HOME: answererHome,
      RELAY_URL: 'https://relay.example.com',
      RELAY_TEAM: 'demo',
      RELAY_TOKEN: TOKEN,
      ...(readDirs === undefined ? {} : { ANSWERER_READ_DIRS: readDirs }),
      ...extra,
    });
    return { r, answererHome, workParent: join(tmp, `team-relay-answerer-${process.getuid!()}`) };
  }

  it('allows one Read(//<abs>/**) per shared folder: ~ expanded, symlinks resolved, glob characters escaped, repeats once', () => {
    const home = fakeHome();
    const { r, answererHome } = run(home, `~/src/app:${home}/My Notes:${home}/link-to-app:${home}/odd[1]*:${home}/src/app/`);
    expect(r.status, r.stderr).toBe(0);
    const settings = JSON.parse(readFileSync(join(answererHome, 'settings.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual([
      'mcp__relay__*',
      'mcp__capabilities__*',
      `Read(/${home}/src/app/**)`,
      `Read(/${home}/My Notes/**)`,
      `Read(/${esc(join(home, 'odd[1]*'))}/**)`,
    ]);
    for (const rule of settings.permissions.allow.slice(2)) expect(rule).toMatch(/^Read\(\/\/.+\/\*\*\)$/);
    // The deny list is intact beside them, and still beats them.
    expect(settings.permissions.deny).toEqual(expectedDeny(answererHome, join(answererHome, 'token')));
    expect(settings.permissions.defaultMode).toBe('default');
  });

  it('hands the channel only the folder names, never the paths, to publish (M4-SPEC §3)', () => {
    const home = fakeHome();
    const { r, answererHome } = run(home, `~/src/app:${home}/My Notes:${home}/odd[1]*:${home}/docs/app`);
    expect(r.status, r.stderr).toBe(0);
    const raw = readFileSync(join(answererHome, 'mcp.json'), 'utf8');
    const mcp = JSON.parse(raw);
    // Two folders named app are one share name.
    expect(JSON.parse(mcp.mcpServers.relay.env.ANSWERER_SHARES)).toEqual(['app', 'My_Notes', 'odd_1__']);
    expect(mcp.mcpServers.capabilities.env.ANSWERER_SHARES).toBeUndefined();
    expect(raw).not.toContain(join(home, 'src'));
    expect(raw).not.toContain('My Notes');
    expect(mcp.mcpServers.relay.env.ANSWERER_READ_DIRS).toBeUndefined();
  });

  it('shares nothing when unset or empty: no read rule, no share names', () => {
    const home = fakeHome();
    for (const value of [undefined, '']) {
      const { r, answererHome } = run(home, value);
      expect(r.status, r.stderr).toBe(0);
      const settings = JSON.parse(readFileSync(join(answererHome, 'settings.json'), 'utf8'));
      expect(settings.permissions.allow).toEqual(['mcp__relay__*', 'mcp__capabilities__*']);
      const mcp = JSON.parse(readFileSync(join(answererHome, 'mcp.json'), 'utf8'));
      expect(mcp.mcpServers.relay.env.ANSWERER_SHARES).toBeUndefined();
    }
  });

  it('accepts 16 folders and refuses 17', () => {
    const home = fakeHome();
    for (let i = 0; i < 17; i++) mkdirSync(join(home, 'many', `d${i}`), { recursive: true });
    const list = (n: number) => Array.from({ length: n }, (_, i) => join(home, 'many', `d${i}`)).join(':');
    const ok = run(home, list(16));
    expect(ok.r.status, ok.r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(ok.answererHome, 'settings.json'), 'utf8')).permissions.allow).toHaveLength(18);
    const tooMany = run(home, list(17));
    expect(tooMany.r.status).not.toBe(0);
    expect(tooMany.r.stderr).toMatch(/ANSWERER_READ_DIRS names 17 folders; at most 16/);
  });

  // Every refusal: which entry and why, and nothing written or created.
  const REFUSALS: Array<[string, (home: string) => { dirs: string; env?: Record<string, string> }, RegExp]> = [
    ['an empty entry', (h) => ({ dirs: `${h}/src/app::${h}/My Notes` }), /entry 2 \(""\) is empty/],
    ['a trailing colon', (h) => ({ dirs: `${h}/src/app:` }), /entry 2 \(""\) is empty/],
    ['a relative path', () => ({ dirs: 'src/app' }), /entry 1 \("src\/app"\) must be an absolute path or start with ~\//],
    ['~user', () => ({ dirs: '~bob/src' }), /entry 1 \("~bob\/src"\) uses ~user/],
    ['a folder that does not exist', (h) => ({ dirs: `${h}/src/app:${h}/missing` }), /entry 2 \(".*\/missing"\) does not exist/],
    ['a file', (h) => ({ dirs: `${h}/file.txt` }), /entry 1 .* is not a directory/],
    ['/', () => ({ dirs: '/' }), /entry 1 \("\/"\) is the root directory/],
    ['$HOME', (h) => ({ dirs: h }), /entry 1 .* is your home directory/],
    ['~', () => ({ dirs: '~' }), /entry 1 \("~"\) is your home directory/],
    ['~/', () => ({ dirs: '~/' }), /entry 1 \("~\/"\) is your home directory/],
    ['a folder above $HOME', (h) => ({ dirs: join(h, '..') }), /entry 1 .* contains your home directory/],
    ['ANSWERER_HOME itself', (h) => ({ dirs: join(h, 'relay-home') }), /entry 1 .* is inside ANSWERER_HOME/],
    ['a folder inside ANSWERER_HOME', (h) => ({ dirs: join(h, 'relay-home', 'state') }), /entry 1 .* is inside ANSWERER_HOME/],
    ['~/.claude', (h) => ({ dirs: `${h}/src/app:~/.claude/projects` }), /entry 2 .* is inside a Claude config directory/],
    ['a folder inside CLAUDE_CONFIG_DIR', (h) => ({ dirs: join(h, 'custom-claude', 'sub'), env: { CLAUDE_CONFIG_DIR: join(h, 'custom-claude') } }), /is inside a Claude config directory/],
    ['~/.ssh', (h) => ({ dirs: join(h, '.ssh', 'keys') }), /is inside a credential location on the deny list \(~\/\.ssh\/\*\*\)/],
    ['a symlink into ~/.ssh', (h) => ({ dirs: join(h, 'link-to-ssh') }), /is inside a credential location on the deny list \(~\/\.ssh\/\*\*\)/],
    ['~/.config/gcloud', () => ({ dirs: '~/.config/gcloud/configurations' }), /\(~\/\.config\/gcloud\/\*\*\)/],
    ['~/.config/gh', () => ({ dirs: '~/.config/gh/hosts' }), /\(~\/\.config\/gh\/\*\*\)/],
    ['the Chrome profile', () => ({ dirs: '~/Library/Application Support/Google/Chrome/Default' }), /\(~\/Library\/Application Support\/Google\/Chrome\/\*\*\)/],
    ['a browser cookie store', () => ({ dirs: '~/Library/Application Support/Arc/Cookies-store' }), /\(~\/Library\/Application Support\/\*\*\/Cookies\*\)/],
    ['~/.claude-team-relay', () => ({ dirs: '~/.claude-team-relay/x' }), /\(~\/\.claude-team-relay\/\*\*\)/],
    ['~/.foundry', () => ({ dirs: '~/.foundry/cache' }), /\(~\/\.foundry\/\*\*\)/],
    ['a keystore folder anywhere', (h) => ({ dirs: join(h, 'proj', 'keystore', 'sub') }), /\(\*\*\/keystore\/\*\*\)/],
    ['a folder named .env', (h) => ({ dirs: join(h, 'proj', '.env') }), /\(\*\*\/\.env\)/],
    ['a folder named like a key file', (h) => ({ dirs: join(h, 'proj', 'prod.pem') }), /\(\*\*\/\*\.pem\)/],
    ['a folder inside CLOUDSDK_CONFIG', (h) => ({ dirs: join(h, 'gcloud-conf', 'sub'), env: { CLOUDSDK_CONFIG: join(h, 'gcloud-conf') } }), /\(CLOUDSDK_CONFIG\)/],
  ];
  for (const [what, make, why] of REFUSALS) {
    it(`refuses ${what}, naming the entry and the reason, before writing anything`, () => {
      const home = fakeHome();
      const { dirs, env } = make(home);
      const { r, answererHome, workParent } = run(home, dirs, env);
      expect(r.status, r.stdout).not.toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^answerer: refusing to start: ANSWERER_READ_DIRS /);
      expect(r.stderr).toMatch(why);
      for (const f of ['mcp.json', 'settings.json', 'tool-event.json', 'token']) expect(existsSync(join(answererHome, f))).toBe(false);
      expect(existsSync(workParent)).toBe(false);
    });
  }
});

describe('bin/answerer session files publish the shared folder names (M4-SPEC §3)', () => {
  it('the channel started from mcp.json publishes basenames, never a path', async () => {
    const relay = await new FakeRelay().start();
    let client: Client | null = null;
    try {
      const shared = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-share-')));
      mkdirSync(join(shared, 'orders-service'));
      mkdirSync(join(shared, 'Team Runbooks'));
      const { home, r } = setup({
        RELAY_URL: relay.url,
        RELAY_TOKEN: TOKEN_OF.bob!,
        ANSWERER_READ_DIRS: `${shared}/orders-service:${shared}/Team Runbooks`,
      });
      expect(r.status, r.stderr).toBe(0);
      const def = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')).mcpServers.relay;
      client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
      await client.connect(
        new StdioClientTransport({ command: def.command, args: def.args, env: { PATH: process.env.PATH ?? '', XDG_CONFIG_HOME: XDG, ...def.env }, stderr: 'pipe' }), // XDG: never this computer's answering lock
      );
      const published = relay.manifests.get('bob') as { shares: unknown };
      expect(published.shares).toEqual([{ name: 'orders-service' }, { name: 'Team_Runbooks' }]);
      const put = relay.requests.find((q) => q.method === 'PUT')!;
      expect(put.raw).not.toContain(shared);
    } finally {
      await client?.close().catch(() => {});
      await relay.stop();
    }
  });
});

describe('bin/answerer with the stored sign-in (M5-SPEC §6)', () => {
  const CREDENTIAL = `trc_${'Q'.repeat(43)}`;
  function signedIn(relayUrl = 'https://relay.example.com') {
    const xdg = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-ans-xdg-')));
    const dir = join(xdg, 'team-relay');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'credentials.json');
    writeFileSync(
      file,
      JSON.stringify({ relay_url: relayUrl, team: 'demo', member: 'bob', credential: CREDENTIAL, expires_at: '2026-12-23T00:00:00Z' }),
      { mode: 0o600 },
    );
    return { xdg, dir, file };
  }
  const run = (xdg: string, extra: Record<string, string> = {}) => {
    const home = join(mkdtempSync(join(tmpdir(), 'team-relay-ans-')), 'home');
    const r = runAnswerer({ ANSWERER_HOME: home, XDG_CONFIG_HOME: xdg, RELAY_AUTH: '', ...extra });
    return { home: r.status === 0 ? realpathSync(home) : home, r };
  };

  it('needs no settings: relay and team come from the credential file, which only the servers read', () => {
    const { xdg, dir, file } = signedIn();
    const { home, r } = run(xdg);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(home, 'token'))).toBe(false);
    const raw = readFileSync(join(home, 'mcp.json'), 'utf8');
    expect(raw).not.toContain(CREDENTIAL);
    const mcp = JSON.parse(raw);
    for (const name of ['relay', 'capabilities']) {
      expect(mcp.mcpServers[name].env).toMatchObject({
        RELAY_AUTH: 'credential',
        RELAY_CREDENTIALS_FILE: file,
        RELAY_URL: 'https://relay.example.com',
        RELAY_TEAM: 'demo',
      });
      expect(mcp.mcpServers[name].env.RELAY_TOKEN_FILE).toBeUndefined();
    }
    expect(JSON.parse(readFileSync(join(home, 'tool-event.json'), 'utf8'))).toEqual({
      relay_url: 'https://relay.example.com',
      relay_team: 'demo',
      relay_auth: 'credential',
      state_dir: join(home, 'state'),
      credentials_file: file,
    });
    // The deny list covers the default place, the XDG place and the file in use.
    const deny: string[] = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).permissions.deny;
    expect(deny).toContain('Read(~/.config/team-relay/**)');
    expect(deny).toContain(`Read(/${dir}/**)`);
    expect(deny).toContain(`Read(/${file})`);
    for (const f of ['settings.json', 'tool-event.json']) expect(readFileSync(join(home, f), 'utf8')).not.toContain(CREDENTIAL);
  });

  it('refuses RELAY_URL or RELAY_TEAM that name another relay or team', () => {
    const { xdg } = signedIn();
    const url = run(xdg, { RELAY_URL: 'https://other.example.com' });
    expect(url.r.status).not.toBe(0);
    expect(url.r.stderr).toMatch(/RELAY_URL is not the relay you signed in to/);
    const team = run(xdg, { RELAY_TEAM: 'other' });
    expect(team.r.status).not.toBe(0);
    expect(team.r.stderr).toMatch(/RELAY_TEAM is not the team you signed in to/);
    expect(run(xdg, { RELAY_URL: 'https://relay.example.com/', RELAY_TEAM: 'demo' }).r.status).toBe(0);
  });

  it('refuses a credential file others can read, without printing the credential', () => {
    const { xdg, file } = signedIn();
    chmodSync(file, 0o644);
    const { r } = run(xdg);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/mode 644/);
    expect(r.stderr).toMatch(/refusing to start: the stored sign-in cannot be used/);
    expect(r.stderr + r.stdout).not.toContain(CREDENTIAL);
  });

  it('RELAY_AUTH=credential without a sign-in says to run /team-relay:login', () => {
    const xdg = realpathSync(mkdtempSync(join(tmpdir(), 'team-relay-ans-xdg-')));
    const { r } = run(xdg, { RELAY_AUTH: 'credential' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/run \/team-relay:login in Claude Code first/);
  });

  it('refuses to share a folder inside the credential directory', () => {
    const { xdg, dir } = signedIn();
    const { r } = run(xdg, { ANSWERER_READ_DIRS: dir });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/inside a credential location on the deny list/);
  });
});
