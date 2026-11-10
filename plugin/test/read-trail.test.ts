// M8-SPEC §7 items 1 and 7: the read trail (the sensitive-name list, what a hook reports, the
// hook itself failing closed) and the deny-list check of Glob patterns before anyone is asked.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patternTarget } from '../src/answer-host.js';
import { HostSocket, newToken } from '../src/host-socket.js';
import { SENSITIVE_NAMES, pathsIn, sensitiveName, trailReport } from '../src/read-trail-core.js';
import { DIST } from './helpers/mcp.js';

describe('the sensitive-name list', () => {
  it('is the spec\'s list', () => {
    expect([...SENSITIVE_NAMES]).toEqual([
      '*.tfstate', 'secrets.*', '*.properties', 'docker-compose*', 'kubeconfig', '*service-account*.json', '.npmrc',
      '.netrc', '.git-credentials', '.dev.vars', 'id_ecdsa*', 'id_dsa*', '*.ppk', '*.pem', '*.key', '*.p12',
    ]);
  });

  it('matches base names, at any depth, in any case', () => {
    for (const p of [
      '/w/infra/terraform.tfstate', '/w/secrets.yaml', 'secrets.json', '/w/app/application.properties', '/w/docker-compose.yml',
      '/w/Docker-Compose.override.yaml', '/w/.kube/kubeconfig', '/w/ci/deploy-service-account-prod.json', '/w/.npmrc', '/w/.netrc',
      '/w/.git-credentials', '/w/worker/.dev.vars', '/w/keys/id_ecdsa', '/w/keys/id_dsa.pub', '/w/putty.ppk', '/w/tls/server.PEM',
      '/w/tls/server.key', '/w/cert.p12', '/w/dir/secrets.d/',
    ]) {
      expect(sensitiveName(p), p).toBe(true);
    }
    for (const p of ['/w/README.md', '/w/src/secret-screen.ts', '/w/tfstate.md', '/w/compose.yaml', '/w/keys.ts', '/w/service-account.md', '/']) {
      expect(sensitiveName(p), p).toBe(false);
    }
  });

  it('finds every path-like string in a search result', () => {
    const paths = pathsIn({ mode: 'content', filenames: ['/w/a.ts'], content: '/w/infra/prod.tfstate:12:  "x": 1\nsrc/b.ts-3-foo' });
    expect(paths).toContain('/w/a.ts');
    expect(paths).toContain('/w/infra/prod.tfstate');
    expect(paths.some((p) => p.startsWith('src/b.ts'))).toBe(true);
    expect(pathsIn('x '.repeat(20000), 10).length).toBeLessThanOrEqual(10);
  });
});

describe('what a hook reports', () => {
  it('Read and Grep before they run, Grep after; nothing else', () => {
    expect(trailReport({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: '/w/a' } })).toEqual({
      phase: 'pre',
      tool: 'Read',
      tool_use_id: 't1',
      path: '/w/a',
    });
    expect(trailReport({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 't2', tool_input: { pattern: 'x', path: '/w' } })).toMatchObject({
      phase: 'pre',
      path: '/w',
    });
    expect(trailReport({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 't2', tool_response: { filenames: ['/w/.npmrc'] } })).toMatchObject({
      phase: 'post',
      paths: ['/w/.npmrc'],
    });
    // Only the sensitive ones travel, however long the result: none is pushed past a cap.
    const many = { filenames: [...Array.from({ length: 20000 }, (_, i) => `/w/f${i}.ts`), '/w/last/secrets.env'] };
    expect(trailReport({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 't3', tool_response: many })).toMatchObject({ paths: ['/w/last/secrets.env'] });
    expect(trailReport({ hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 't4', tool_response: { filenames: ['/w/a.ts'] } })).toMatchObject({ paths: [] });
    expect(trailReport({ hook_event_name: 'PostToolUseFailure', tool_name: 'Grep', tool_use_id: 't2' })).toMatchObject({ phase: 'failed' });
    expect(trailReport({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1' })).toBeNull();
    expect(trailReport({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })).toBeNull();
    expect(trailReport('nope')).toBeNull();
  });
});

type HookRun = { code: number | null; stderr: string };
function runHook(config: string, payload: unknown): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(DIST, 'read-trail.js'), '--config', config], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

describe('the read-trail hook (dist/read-trail.js)', () => {
  let socket: HostSocket | null = null;
  afterEach(async () => {
    await socket?.close();
    socket = null;
  });
  const pre = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_1', tool_input: { file_path: '/w/secrets.yaml' } };
  const post = { hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'toolu_2', tool_input: {}, tool_response: { filenames: ['/w/x.pem'] } };

  it('reports to the host with the run\'s token, and lets the tool run', async () => {
    socket = new HostSocket();
    await socket.listen();
    const token = newToken();
    const seen: Array<{ method: string; params: unknown }> = [];
    socket.setRun(token, async (method, params) => {
      seen.push({ method, params });
      return { ok: true };
    });
    const cfg = join(mkdtempSync(join(tmpdir(), 'rt-')), 'read-trail.json');
    writeFileSync(cfg, JSON.stringify({ socket: socket.path, token }), { mode: 0o600 });
    expect(await runHook(cfg, pre)).toMatchObject({ code: 0 });
    expect(await runHook(cfg, post)).toMatchObject({ code: 0 });
    expect(seen).toEqual([
      { method: 'trail', params: { phase: 'pre', tool: 'Read', tool_use_id: 'toolu_1', path: '/w/secrets.yaml' } },
      { method: 'trail', params: { phase: 'post', tool: 'Grep', tool_use_id: 'toolu_2', paths: ['/w/x.pem'] } },
    ]);
  });

  it('fails closed before a read: no host, a wrong token or a refusal blocks the tool (exit 2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'));
    const none = join(dir, 'none.json');
    writeFileSync(none, JSON.stringify({ socket: join(dir, 'gone.sock'), token: newToken() }));
    const r1 = await runHook(none, pre);
    expect(r1.code).toBe(2);
    expect(r1.stderr).toMatch(/could not be recorded .* so it is not allowed/);
    expect((await runHook(join(dir, 'missing.json'), pre)).code).toBe(2);
    expect((await runHook(none, '{not json')).code).toBe(2);

    socket = new HostSocket();
    await socket.listen();
    socket.setRun(newToken(), async () => ({ ok: true }));
    const wrong = join(dir, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ socket: socket.path, token: newToken() }));
    expect((await runHook(wrong, pre)).code).toBe(2);
    const token = newToken();
    socket.setRun(token, async () => ({ ok: false }));
    const refused = join(dir, 'refused.json');
    writeFileSync(refused, JSON.stringify({ socket: socket.path, token }));
    expect((await runHook(refused, pre)).code).toBe(2);
  });

  it('never blocks after a tool has run (the host then counts the search as open)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'));
    const none = join(dir, 'none.json');
    writeFileSync(none, JSON.stringify({ socket: join(dir, 'gone.sock'), token: newToken() }));
    expect((await runHook(none, post)).code).toBe(0);
    // A tool it does not report on is let through.
    expect((await runHook(none, { hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: {} })).code).toBe(0);
  });
});

describe('Glob patterns against the deny list (M8-SPEC §7 item 7)', () => {
  it('takes the fixed prefix of an absolute, ~/ or relative pattern', () => {
    expect(patternTarget('/Users/u/.ssh/*', '/w', '/Users/u')).toEqual({ prefix: '/Users/u/.ssh', whole: '/Users/u/.ssh/*' });  // e1-guard: allow (synthetic macOS home path in a test)
    expect(patternTarget('~/.aws/**', '/w', '/Users/u')).toEqual({ prefix: '/Users/u/.aws', whole: '/Users/u/.aws/**' });  // e1-guard: allow (synthetic macOS home path in a test)
    expect(patternTarget('.kube/*', '/Users/u', '/Users/u')).toEqual({ prefix: '/Users/u/.kube', whole: '/Users/u/.kube/*' });  // e1-guard: allow (synthetic macOS home path in a test)
    expect(patternTarget('src/**/*.ts', '/w/app', '/Users/u')).toEqual({ prefix: '/w/app/src', whole: '/w/app/src/**/*.ts' });  // e1-guard: allow (synthetic macOS home path in a test)
    expect(patternTarget('/{a,b}/x', '/w', '/h').prefix).toBe('/');
    expect(patternTarget('../../etc/*', '/w/app', '/h')).toEqual({ prefix: '/etc', whole: '/etc/*' });
  });
});
