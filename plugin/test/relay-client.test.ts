import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RelayClient,
  RelayError,
  RelayNetworkError,
  backoffDelay,
  isRetryable,
  parseRelayUrl,
  tokenProviderFromEnv,
} from '../src/relay-client.js';
import { FakeRelay, TOKEN_OF } from './helpers/fake-relay.js';

let relay: FakeRelay;
const sleeps: number[] = [];

function client(token = TOKEN_OF.alice!, extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
  return new RelayClient({
    url: relay.url,
    team: 'demo',
    token: () => token,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    ...extra,
  });
}

beforeEach(async () => {
  relay = await new FakeRelay().start();
  sleeps.length = 0;
});
afterEach(async () => {
  await relay.stop();
});

describe('relay client', () => {
  it('sends the bearer token, JSON headers and a user agent', async () => {
    const me = await client().me();
    expect(me).toEqual({ team: 'demo', member: 'alice', teammates: ['bob', 'carol'] });
    const r = relay.requests.at(-1)!;
    expect(r.path).toBe('/v1/teams/demo/me');
    expect(r.headers.authorization).toBe(`Bearer ${TOKEN_OF.alice}`);
    expect(r.headers.accept).toBe('application/json');
    expect(r.headers['user-agent']).toMatch(/^team-relay-plugin\//);
    expect(r.headers['content-type']).toBeUndefined();

    await client().ackCursor('replies', 0);
    const post = relay.requests.at(-1)!;
    expect(post.headers['content-type']).toBe('application/json');
    expect(post.body).toEqual({ acked_seq: 0 });
  });

  it('retries 5xx with exponential backoff, then succeeds', async () => {
    relay.fail((r) => r.path.endsWith('/me'), 503, 2);
    const me = await client().me();
    expect(me.member).toBe('alice');
    expect(relay.requests.filter((r) => r.path.endsWith('/me'))).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('backs off and retries a 429 (rate_limited, too_many_polls) like a 5xx', async () => {
    relay.fail((r) => r.path.endsWith('/me'), 429, 1, { error: 'rate_limited', detail: 'slow down' });
    relay.fail((r) => r.path.endsWith('/me'), 429, 1, { error: 'too_many_polls', detail: 'two already' });
    const me = await client().me();
    expect(me.member).toBe('alice');
    expect(relay.requests.filter((r) => r.path.endsWith('/me'))).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(isRetryable(new RelayError(429, 'rate_limited', ''))).toBe(true);
    expect(isRetryable(new RelayError(422, 'invalid_timeouts', ''))).toBe(false);
    expect(isRetryable(new RelayError(409, 'idempotency_conflict', ''))).toBe(false);
  });

  it('surfaces a 429 after the configured attempts', async () => {
    relay.fail((r) => r.path.endsWith('/requests'), 429, 10, { error: 'rate_limited', detail: 'too many requests' });
    const err = await client(TOKEN_OF.alice, { attempts: 2 })
      .createRequest({ idempotency_key: 'key-rate-limited', kind: 'question', to: ['bob'], question: 'hi' })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited' });
    const posts = relay.requests.filter((r) => r.path.endsWith('/requests'));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toEqual(posts[1]!.body);
  });

  it('gives up after the configured attempts and surfaces the relay error', async () => {
    relay.fail((r) => r.path.endsWith('/me'), 500, 10);
    const err = await client(TOKEN_OF.alice, { attempts: 3 }).me().catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err.status).toBe(500);
    expect(relay.requests.filter((r) => r.path.endsWith('/me'))).toHaveLength(3);
  });

  it('does not retry a 401 and never puts the token in the error', async () => {
    const token = 'tok-unknown-secret-value-42';
    const err = await client(token).me().catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthenticated');
    expect(String(err.message)).not.toContain(token);
    expect(JSON.stringify(err)).not.toContain(token);
    expect(relay.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('does not retry other 4xx and reports code and detail', async () => {
    relay.fail((r) => r.path.endsWith('/requests'), 422, 5, { error: 'invalid_params', detail: 'limit must be <= 100' });
    const err = await client()
      .createRequest({ idempotency_key: 'key-12345678', kind: 'question', to: ['bob'], question: 'hi' })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'invalid_params', detail: 'limit must be <= 100' });
    expect(relay.requests).toHaveLength(1);
  });

  it('retries network errors, then reports them as RelayNetworkError', async () => {
    const url = relay.url;
    await relay.stop();
    const c = new RelayClient({ url, team: 'demo', token: () => 'x', attempts: 3, sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    const err = await c.me().catch((e) => e);
    expect(err).toBeInstanceOf(RelayNetworkError);
    expect(sleeps).toEqual([500, 1000]);
    relay = await new FakeRelay().start();
  });

  it('resends the same idempotency key and body on retry', async () => {
    relay.fail((r) => r.path.endsWith('/requests'), 502, 1);
    const res = await client().createRequest({ idempotency_key: 'same-key-123', kind: 'question', to: ['bob'], question: 'hello' });
    expect(res.created).toBe(true);
    const posts = relay.requests.filter((r) => r.path.endsWith('/requests'));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toEqual(posts[1]!.body);
  });

  it('sends progress once (it appends, so it is not blindly retried)', async () => {
    relay.fail((r) => r.path.endsWith('/progress'), 503, 1);
    const err = await client().progress(`rq_${'a'.repeat(32)}`, { text: 'x', pct: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(relay.requests.filter((r) => r.path.endsWith('/progress'))).toHaveLength(1);
  });

  it('builds stream reads with after, wait and limit', async () => {
    await client().readStream('inbox', { after: 3, wait: 0, limit: 7 });
    const r = relay.requests.at(-1)!;
    expect(r.path).toBe('/v1/teams/demo/streams/inbox');
    expect(Object.fromEntries(r.query)).toEqual({ after: '3', wait: '0', limit: '7' });
  });

  it('refuses malformed request ids before building a URL', async () => {
    expect(() => client().ackRequest('../../me')).toThrow(/request_id/);
    expect(() => client().getRequest('rq_XYZ')).toThrow(/request_id/);
    expect(relay.requests).toHaveLength(0);
  });

  it('computes backoff between 1 s and 30 s', () => {
    expect(backoffDelay(0, undefined, () => 1)).toBe(1000);
    expect(backoffDelay(3, undefined, () => 1)).toBe(8000);
    expect(backoffDelay(10, undefined, () => 1)).toBe(30000);
    expect(backoffDelay(10, undefined, () => 0)).toBe(15000);
  });
});

describe('relay settings', () => {
  it('accepts https anywhere and http only to loopback', () => {
    expect(parseRelayUrl('https://relay.example.com').href).toBe('https://relay.example.com/');
    expect(parseRelayUrl('http://127.0.0.1:8080').host).toBe('127.0.0.1:8080');
    expect(parseRelayUrl('http://localhost:8080').host).toBe('localhost:8080');
    expect(() => parseRelayUrl('http://relay.example.com')).toThrow(/https/);
    expect(() => parseRelayUrl('ftp://relay.example.com')).toThrow();
    expect(() => parseRelayUrl('https://user:pw@relay.example.com')).toThrow(/credentials/);
    expect(() => parseRelayUrl('not a url')).toThrow();
    expect(() => parseRelayUrl(undefined)).toThrow(/RELAY_URL/);
  });

  it('rejects a bad team id', () => {
    expect(() => new RelayClient({ url: 'https://relay.example.com', team: '../x', token: () => 't' })).toThrow(/team/);
  });

  it('prefers RELAY_TOKEN_FILE, strips the trailing newline and re-reads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-relay-token-'));
    const file = join(dir, 'token');
    writeFileSync(file, 'file-token\n');
    const provider = tokenProviderFromEnv({ RELAY_TOKEN: 'env-token', RELAY_TOKEN_FILE: file });
    expect(provider()).toBe('file-token');
    writeFileSync(file, 'rotated-token\r\n');
    expect(provider()).toBe('rotated-token');
    expect(tokenProviderFromEnv({ RELAY_TOKEN: 'env-token' })()).toBe('env-token');
    expect(() => tokenProviderFromEnv({})).toThrow(/RELAY_TOKEN/);
    const missing = tokenProviderFromEnv({ RELAY_TOKEN_FILE: join(dir, 'nope') });
    expect(() => missing()).toThrow(/ENOENT/);
    writeFileSync(file, '\n');
    expect(() => provider()).toThrow(/empty/);
  });
});
