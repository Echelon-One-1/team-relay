// The fake relay's PUT me/status is as strict as the relay (member_state.py, 13 Nov 2026), so a
// plugin that sends a wrong status fails here and not only against the real relay.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemberStatusBody } from '../src/boundaries-types.js';
import { RelayClient, RelayError } from '../src/relay-client.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';

let relay: FakeRelay;
let client: RelayClient;
beforeAll(async () => {
  relay = await new FakeRelay().start();
  client = new RelayClient({ url: relay.url, team: 'demo', token: () => TOKEN_OF.bob!, attempts: 1 });
});
afterAll(async () => {
  await relay.stop();
});

const good = (): MemberStatusBody => ({
  daemon: { version: '1.0.0', started_at: '2026-11-13T09:00:00.000Z' },
  claude: { found: true, signed_in: true },
  folder_count: 2,
  folders_ok: true,
  self_test: { ok: true, at: '2026-11-13T09:01:00.000Z', reason: null },
});

async function status(body: unknown): Promise<number> {
  try {
    await client.putStatus(body as MemberStatusBody);
    return 200;
  } catch (err) {
    if (err instanceof RelayError) {
      expect(err.code).toBe('invalid_body');
      return err.status;
    }
    throw err;
  }
}

describe('fake relay: PUT me/status', () => {
  it('takes a whole status, and folders_ok false with folder_count 0', async () => {
    expect(await status(good())).toBe(200);
    expect(await status({ ...good(), folder_count: 0, folders_ok: false })).toBe(200);
    expect(relay.memberStatus.get('bob')).toMatchObject({ folder_count: 0, folders_ok: false });
  });

  it('refuses a status that is missing a field, has an unknown one or a wrong value (400 invalid_body)', async () => {
    const without = (k: keyof MemberStatusBody) => {
      const b: Record<string, unknown> = { ...good() };
      delete b[k];
      return b;
    };
    for (const k of ['daemon', 'claude', 'folder_count', 'folders_ok', 'self_test'] as const) expect(await status(without(k)), k).toBe(400);
    const bad: unknown[] = [
      { ...good(), extra: 1 },
      { ...good(), folders_ok: 'yes' },
      { ...good(), folders_ok: false },
      { ...good(), folder_count: 21 },
      { ...good(), folder_count: -1 },
      { ...good(), folder_count: 1.5 },
      { ...good(), daemon: { version: '1' } },
      { ...good(), daemon: { ...good().daemon, pid: 1 } },
      { ...good(), claude: { found: 'yes', signed_in: true } },
      { ...good(), self_test: { ok: true, at: '2026-11-13T09:01:00.000Z' } },
      { ...good(), self_test: { ok: true, at: '2026-11-13T09:01:00.000Z', reason: 3 } },
    ];
    for (const b of bad) expect(await status(b), JSON.stringify(b)).toBe(400);
  });
});
