// M8-SPEC §1, §6: one answerer per machine. The lock is exclusive, a stale one (its pid gone)
// is taken over, only the holder reads the inbox, and bin/answerer refuses to start while a
// channel working session answers automatically.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDir, heldBy, lockPath, pidAlive, readLock, takeAndRemove, tryAcquire, type Acquired } from '../src/answering-lock.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';
import { DIST, PLUGIN_ROOT, sleep, spawnServer, type Spawned } from './helpers/mcp.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-relay-lock-'));
  path = join(dir, 'team-relay', 'answering.lock');
});

/** A pid that is certainly not running: a child that has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

describe('the answering lock', () => {
  it('lives in ~/.config/team-relay (XDG_CONFIG_HOME when absolute)', () => {
    expect(lockPath({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/u' })).toBe('/x/cfg/team-relay/answering.lock');
    expect(lockPath({ XDG_CONFIG_HOME: 'relative', HOME: '/home/u' })).toBe('/home/u/.config/team-relay/answering.lock');
    expect(configDir({ HOME: '/home/u' })).toBe('/home/u/.config/team-relay');
  });

  it('has one holder: a second process is refused and told who holds it', () => {
    const a = tryAcquire(path, 'host', { pid: process.pid });
    expect(a.ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'team-relay')).mode & 0o777).toBe(0o700);
    const b = tryAcquire(path, 'answerer', { pid: process.pid + 100000, alive: (p) => p === process.pid });
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.holder).toMatchObject({ pid: process.pid, role: 'host' });
      expect(heldBy(b.holder)).toBe(`a channel working session on this computer (pid ${process.pid})`);
    }
    expect(readLock(path)).toMatchObject({ pid: process.pid, role: 'host' });
  });

  it('M11-SPEC §1: the background answerer holds it with the role daemon, and is named as such', () => {
    const a = tryAcquire(path, 'daemon', { pid: process.pid });
    expect(a.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid, role: 'daemon' });
    const b = tryAcquire(path, 'host', { pid: process.pid + 100000, alive: (p) => p === process.pid });
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.holder).toMatchObject({ pid: process.pid, role: 'daemon' });
      expect(heldBy(b.holder)).toBe(`the background answerer on this computer (pid ${process.pid})`);
    }
    expect(readLock(path)).toMatchObject({ role: 'daemon' });
    // A role nobody knows is not a holder (the lock is unusable, so it is stale once old).
    (a as Acquired).release();
    mkdirSync(join(dir, 'team-relay'), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: process.pid, role: 'other', started_at: '' }));
    expect(readLock(path)).toBeNull();
  });

  it('takes over a stale lock (its pid is gone)', () => {
    const dead = deadPid();
    expect(pidAlive(dead)).toBe(false);
    expect(tryAcquire(path, 'answerer', { pid: dead, alive: () => true }).ok).toBe(true);
    expect(readLock(path)).toBeNull();
    const mine = tryAcquire(path, 'host');
    expect(mine.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid, role: 'host' });
  });

  it('a lock file still being written (no JSON yet, fresh) is held; an old unreadable one is stale', () => {
    mkdirSync(join(dir, 'team-relay'), { recursive: true });
    writeFileSync(path, '');
    expect(tryAcquire(path, 'host', { pid: 424242 }).ok).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(tryAcquire(path, 'host', { pid: 424242, alive: () => false }).ok).toBe(true);
  });

  it('a breaker file left by a crashed process does not block for ever', () => {
    const dead = deadPid();
    tryAcquire(path, 'host', { pid: dead });
    writeFileSync(`${path}.break`, '1');
    // Fresh breaker: somebody is breaking it right now.
    expect(tryAcquire(path, 'host', { alive: (p) => p !== dead }).ok).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.break`, old, old);
    expect(tryAcquire(path, 'host', { alive: (p) => p !== dead }).ok).toBe(true);
    expect(existsSync(`${path}.break`)).toBe(false);
  });

  it('release removes only the holder\'s own lock', () => {
    const a = tryAcquire(path, 'host', { pid: 111 }) as Acquired;
    expect(a.ok).toBe(true);
    // Someone else's now (a takeover): the old holder's release leaves it alone.
    writeFileSync(path, JSON.stringify({ pid: 222, role: 'host', started_at: '' }));
    a.release();
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, JSON.stringify({ pid: 111, role: 'host', started_at: '' }));
    a.release();
    expect(existsSync(path)).toBe(false);
  });

  describe('M8-SPEC §7 item 11: breaking renames the lock aside and verifies it before removing', () => {
    const stale = JSON.stringify({ pid: 111, role: 'host', started_at: '' });
    const live = JSON.stringify({ pid: process.pid, role: 'host', started_at: 'now' });
    const leftovers = () => readdirSync(join(dir, 'team-relay')).filter((n) => n !== 'answering.lock');

    it('removes the lock when it is still the stale content it saw', () => {
      mkdirSync(join(dir, 'team-relay'), { recursive: true });
      writeFileSync(path, stale);
      expect(takeAndRemove(path, (c) => c === stale)).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(leftovers()).toEqual([]);
    });

    it('a breaker suspended after its check cannot remove a live lock taken meanwhile: it is put back', () => {
      mkdirSync(join(dir, 'team-relay'), { recursive: true });
      // The breaker saw `stale`; meanwhile another process broke it and took the lock (`live`).
      writeFileSync(path, live);
      expect(takeAndRemove(path, (c) => c === stale)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(live);
      expect(leftovers()).toEqual([]);
      // And the live holder is still the holder.
      expect(readLock(path)).toMatchObject({ pid: process.pid });
      expect(tryAcquire(path, 'answerer', { pid: process.pid + 100000, alive: (p) => p === process.pid }).ok).toBe(false);
    });

    it('never puts a lock back over one taken while it was aside', () => {
      mkdirSync(join(dir, 'team-relay'), { recursive: true });
      writeFileSync(path, live);
      const third = JSON.stringify({ pid: process.pid, role: 'answerer', started_at: 'later' });
      expect(
        takeAndRemove(path, () => {
          writeFileSync(path, third, { flag: 'wx' });
          return false;
        }),
      ).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(third);
      expect(leftovers()).toEqual([]);
    });

    it('a lock that is already gone counts as removed', () => {
      mkdirSync(join(dir, 'team-relay'), { recursive: true });
      expect(takeAndRemove(path, () => true)).toBe(true);
    });

    it('tryAcquire over a stale lock leaves nothing aside', () => {
      mkdirSync(join(dir, 'team-relay'), { recursive: true });
      writeFileSync(path, JSON.stringify({ pid: deadPid(), role: 'host', started_at: '' }));
      expect(tryAcquire(path, 'host').ok).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid });
      expect(leftovers()).toEqual([]);
    });
  });
});

describe('only the lock holder reads the inbox', () => {
  let relay: FakeRelay;
  const open: Spawned[] = [];
  beforeEach(async () => {
    relay = await new FakeRelay().start();
  });
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
    await relay.stop();
  });

  it('a manual answering session waits while a host holds the lock, and reads once it is free', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'team-relay-lock-xdg-'));
    const lock = join(xdg, 'team-relay', 'answering.lock');
    // A live host: this test process.
    const held = tryAcquire(lock, 'host') as Acquired;
    expect(held.ok).toBe(true);
    const s = await spawnServer('channel.js', {
      RELAY_URL: relay.url,
      RELAY_TEAM: 'demo',
      RELAY_TOKEN: TOKEN_OF.bob!,
      RELAY_ROLE: 'answerer',
      XDG_CONFIG_HOME: xdg,
    });
    open.push(s);
    await sleep(1500);
    const inboxReads = () => relay.requests.filter((r) => r.path.endsWith('/streams/inbox') && r.member === 'bob').length;
    expect(inboxReads()).toBe(0);
    expect(s.stderr()).toMatch(/not reading the inbox: a channel working session on this computer \(pid \d+\) answers for you/);
    held.release();
    const deadline = Date.now() + 10_000;
    while (inboxReads() === 0 && Date.now() < deadline) await sleep(100);
    expect(inboxReads()).toBeGreaterThan(0);
    expect(readLock(lock)).toMatchObject({ role: 'answerer' });
  });
});

describe('a background answerer holding the lock (M11-SPEC §1)', () => {
  let relay: FakeRelay;
  const open: Spawned[] = [];
  beforeEach(async () => {
    relay = await new FakeRelay().start();
  });
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
    await relay.stop();
  });

  it('a manual answering session waits for it like for any holder', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'team-relay-lock-xdg-'));
    const lock = join(xdg, 'team-relay', 'answering.lock');
    const held = tryAcquire(lock, 'daemon') as Acquired;
    expect(held.ok).toBe(true);
    const s = await spawnServer('channel.js', { RELAY_URL: relay.url, RELAY_TEAM: 'demo', RELAY_TOKEN: TOKEN_OF.bob!, RELAY_ROLE: 'answerer', XDG_CONFIG_HOME: xdg });
    open.push(s);
    await sleep(1500);
    expect(relay.requests.filter((r) => r.path.endsWith('/streams/inbox')).length).toBe(0);
    expect(s.stderr()).toMatch(/not reading the inbox: the background answerer on this computer \(pid \d+\) answers for you/);
    held.release();
  });
});

describe('bin/answerer and the lock', () => {
  const run = (xdg: string) =>
    spawnSync(join(PLUGIN_ROOT, 'bin', 'answerer'), ['--print-command'], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        TMPDIR: mkdtempSync(join(tmpdir(), 'team-relay-lock-ans-')),
        XDG_CONFIG_HOME: xdg,
        RELAY_AUTH: 'token',
        RELAY_URL: 'http://127.0.0.1:9',
        RELAY_TEAM: 'demo',
        RELAY_TOKEN: 'tok-bob-lock-test',
      },
      encoding: 'utf8',
    });

  it('refuses to start while a channel working session answers, and names it', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'team-relay-lock-xdg-'));
    const held = tryAcquire(join(xdg, 'team-relay', 'answering.lock'), 'host') as Acquired;
    const r = run(xdg);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`your channel working session (pid ${process.pid}) already answers teammates automatically`);
    expect(r.stderr).toContain('TEAM_RELAY_AUTO_ANSWER=0');
    held.release();
    const ok = run(xdg);
    expect(ok.status).toBe(0);
  });

  it('refuses while another manual answering session runs; a stale lock does not stop it', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'team-relay-lock-xdg-'));
    const lock = join(xdg, 'team-relay', 'answering.lock');
    const held = tryAcquire(lock, 'answerer') as Acquired;
    expect(run(xdg).stderr).toContain(`another answering session (pid ${process.pid}) is already running`);
    held.release();
    tryAcquire(lock, 'answerer', { pid: deadPid() });
    expect(run(xdg).status).toBe(0);
  });

  it('dist/answering-lock-info.js exits 3 with the holder, 0 when free', () => {
    const xdg = mkdtempSync(join(tmpdir(), 'team-relay-lock-xdg-'));
    const info = () => spawnSync(process.execPath, [join(DIST, 'answering-lock-info.js')], { env: { XDG_CONFIG_HOME: xdg, HOME: '/nonexistent' }, encoding: 'utf8' });
    expect(info().status).toBe(0);
    const held = tryAcquire(join(xdg, 'team-relay', 'answering.lock'), 'host') as Acquired;
    const r = info();
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toEqual({ pid: process.pid, role: 'host' });
    held.release();
  });
});
