import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildAnsweringCommand, capabilityLines, render, run } from '../scripts/generate.js';
import { validateManifest } from '../src/manifest.js';
import { PLUGIN_ROOT } from './helpers/mcp.js';

function copyPlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-relay-gen-'));
  cpSync(join(PLUGIN_ROOT, 'manifest.yaml'), join(dir, 'manifest.yaml'));
  cpSync(join(PLUGIN_ROOT, '.claude-plugin'), join(dir, '.claude-plugin'), { recursive: true });
  cpSync(join(PLUGIN_ROOT, '.mcp.json'), join(dir, '.mcp.json'));
  cpSync(join(PLUGIN_ROOT, 'hooks'), join(dir, 'hooks'), { recursive: true });
  cpSync(join(PLUGIN_ROOT, 'commands'), join(dir, 'commands'), { recursive: true });
  return dir;
}

describe('generator', () => {
  it('matches the committed plugin.json and .mcp.json', () => {
    for (const file of render(PLUGIN_ROOT)) {
      expect(readFileSync(file.path, 'utf8'), file.path).toBe(file.content);
    }
    expect(run({ check: true }).drifted).toEqual([]);
  });

  it('licenses the plugin and its marketplace entry under MIT, as LICENSE says', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(plugin.license).toBe('MIT');
    const market = JSON.parse(readFileSync(join(PLUGIN_ROOT, '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
    expect(market.plugins.find((p: { name: string }) => p.name === 'team-relay').license).toBe('MIT');
    expect(readFileSync(join(PLUGIN_ROOT, '..', 'LICENSE'), 'utf8')).toMatch(/^MIT License/);
    // A plugin.json without it gets it back, after author; one with another value is corrected.
    const dir = copyPlugin();
    const path = join(dir, '.claude-plugin', 'plugin.json');
    const { license: _l, ...bare } = plugin;
    writeFileSync(path, JSON.stringify({ ...bare, license: undefined }, null, 2) + '\n');
    expect(run({ root: dir, check: true }).drifted).toEqual([path]);
    run({ root: dir, check: false });
    const fixed = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(fixed).indexOf('license')).toBe(Object.keys(fixed).indexOf('author') + 1);
    writeFileSync(path, JSON.stringify({ ...fixed, license: 'Apache-2.0' }, null, 2) + '\n');
    run({ root: dir, check: false });
    expect(JSON.parse(readFileSync(path, 'utf8')).license).toBe('MIT');
  });

  it('asks no install questions: plugin.json has no userConfig (M5-SPEC §6)', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(plugin.userConfig).toBeUndefined();
    expect(JSON.stringify(plugin)).not.toContain('user_config');
    expect(plugin.channels).toEqual([{ server: 'relay' }]);
    expect(plugin.name).toBe('team-relay');
  });

  it('writes the relay server in asker role, with no user_config reference and no relay URL', () => {
    const raw = readFileSync(join(PLUGIN_ROOT, '.mcp.json'), 'utf8');
    const mcp = JSON.parse(raw);
    expect(Object.keys(mcp.mcpServers)).toEqual(['relay']);
    // Started through bin/run-node, never `node` from Claude Code's PATH (M11-SPEC "Simpler joining").
    expect(mcp.mcpServers.relay).toEqual({
      command: '/bin/sh',
      args: ['${CLAUDE_PLUGIN_ROOT}/bin/run-node', '${CLAUDE_PLUGIN_ROOT}/dist/channel.js'],
      env: { RELAY_ROLE: 'asker' },
    });
    expect(raw).not.toContain('user_config');
    expect(raw).not.toMatch(/https?:\/\//);
  });

  it('the manifest still drives /team-relay:answering: each capability with its two settings', () => {
    const text = readFileSync(join(PLUGIN_ROOT, 'commands', 'answering.md'), 'utf8');
    expect(text).toMatch(/^---\ndescription: .+\ndisable-model-invocation: true\n---\n/);
    expect(text).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/answerer"');
    expect(text).toContain('`CAP_STAGING_DB_QUERY_ENABLED=true` and `CAP_STAGING_DB_QUERY_RUNNER=/absolute/path/to/program`');
    expect(text).toContain('`CAP_SERVICE_HEALTH_ENABLED=true`');
    expect(text).toMatch(/CAP_PRODUCTION_DB_COUNT_ENABLED=true.+Production data: also needs `ALLOW_PRODUCTION=true`/);
    expect(text).not.toMatch(/Query the staging database.+ALLOW_PRODUCTION/);
    expect(text).toContain('ANSWERER_READ_DIRS');
  });

  it('lists a production capability as needing ALLOW_PRODUCTION, whatever default_enabled says', () => {
    const manifest = validateManifest({
      version: 1,
      capabilities: [
        { name: 'prod_thing', title: 'Prod thing', description: 'd', environment: 'production', default_enabled: true, params: {} },
        { name: 'stage_thing', title: 'Stage thing', description: 'd', environment: 'staging', default_enabled: true, params: {} },
      ],
    });
    const lines = capabilityLines(manifest);
    expect(lines[0]).toMatch(/CAP_PROD_THING_ENABLED=true.+ALLOW_PRODUCTION=true/);
    expect(lines[1]).not.toMatch(/ALLOW_PRODUCTION/);
    expect(buildAnsweringCommand(manifest)).toContain('Prod thing (`prod_thing`, production)');
  });

  it('leaves every other plugin.json key untouched', () => {
    const dir = copyPlugin();
    const path = join(dir, '.claude-plugin', 'plugin.json');
    const plugin = JSON.parse(readFileSync(path, 'utf8'));
    plugin.homepage = 'https://example.com/team-relay';
    plugin.userConfig = { stale: { type: 'string', title: 'x', description: 'x' } };
    writeFileSync(path, JSON.stringify(plugin, null, 2) + '\n');
    run({ root: dir, check: false });
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.homepage).toBe('https://example.com/team-relay');
    expect(after.userConfig).toBeUndefined();
    expect(Object.keys(after)).toEqual(Object.keys(plugin).filter((k) => k !== 'userConfig'));
  });

  it('--check detects drift in any generated file and does not write', () => {
    const dir = copyPlugin();
    expect(run({ root: dir, check: true }).drifted).toEqual([]);

    const manifestPath = join(dir, 'manifest.yaml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('title: Check a service\'s health', 'title: Check health'));
    const commandBefore = readFileSync(join(dir, 'commands', 'answering.md'), 'utf8');
    expect(run({ root: dir, check: true }).drifted).toEqual([join(dir, 'commands', 'answering.md')]);
    expect(readFileSync(join(dir, 'commands', 'answering.md'), 'utf8')).toBe(commandBefore);

    writeFileSync(join(dir, '.mcp.json'), '{}\n');
    const pluginPath = join(dir, '.claude-plugin', 'plugin.json');
    writeFileSync(pluginPath, JSON.stringify({ ...JSON.parse(readFileSync(pluginPath, 'utf8')), userConfig: {} }, null, 2) + '\n');
    expect(run({ root: dir, check: true }).drifted).toHaveLength(3);
    run({ root: dir, check: false });
    expect(run({ root: dir, check: true }).drifted).toEqual([]);
  });

  it('the CLI --check exits 0 on the committed files', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(PLUGIN_ROOT, 'scripts', 'generate.ts'), '--check'], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
  });
});
