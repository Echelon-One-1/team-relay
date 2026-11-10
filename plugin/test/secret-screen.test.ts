// M8-SPEC §3: the deterministic secret screen, over a corpus of positives and negatives. The
// secrets below are synthetic: made-up values of the right shape, never real credentials.

import { describe, expect, it } from 'vitest';
import { screenDraft, screenSecrets } from '../src/secret-screen.js';

// Built at run time so no token-shaped literal sits in the source.
const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const mixed = (n: number) => rep('aZ3kQ9xW7mPq2Lr8Tn5Vb1Yc6Hd4Jf0G', n);

const POSITIVES: Array<[string, string]> = [
  ['PEM private key', `here:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow${mixed(40)}\n-----END RSA PRIVATE KEY-----`],
  ['OpenSSH key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE\n-----END OPENSSH PRIVATE KEY-----'],
  ['EC key', '-----BEGIN EC PRIVATE KEY-----'],
  ['PGP key', '-----BEGIN PGP PRIVATE KEY BLOCK-----'],
  ['AWS key id', `the key is AKIA${rep('QWERTYUIOP234567', 16)} ok`],
  ['GitHub classic', `ghp_${mixed(36)}`],
  ['GitHub fine-grained', `github_pat_${mixed(40)}`],
  ['GitLab', `glpat-${mixed(20)}`],
  ['Slack bot', `xoxb-${rep('1234567890-', 30)}`],
  ['Slack webhook', `https://hooks.slack.com/services/T0000/B0000/${mixed(24)}`],
  ['Anthropic', `sk-ant-api03-${mixed(40)}`],
  ['OpenAI', `sk-proj-${mixed(40)}`],
  ['Stripe live', `sk_live_${mixed(24)}`],
  ['Stripe webhook', `whsec_${mixed(32)}`],
  ['Google API key', `AIza${mixed(35)}`],
  ['Google OAuth access token', `ya29.${mixed(40)}`],
  ['Google client secret', `GOCSPX-${mixed(28)}`],
  ['service account JSON', '{"type": "service_account", "private_key_id": "0123456789abcdef0123456789abcdef01234567"}'],
  ['npm', `npm_${mixed(36)}`],
  ['SendGrid', `SG.${mixed(22)}.${mixed(43)}`],
  ['Hugging Face', `hf_${mixed(34)}`],
  ['team relay credential', `trc_${mixed(43)}`],
  ['JWT', `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${mixed(43)}`],
  ['Bearer header', `Authorization: Bearer ${mixed(30)}`],
  ['.env password', 'DB_PASSWORD=hunter2hunter2'],
  ['.env API key', 'STRIPE_API_KEY="abcdef123456"'],
  ['yaml secret', 'client_secret: q8W2e4R6t8Y0'],
  ['json token', '{"access_token": "abc123def456ghi"}'],
  ['connection string', 'postgres://app:S3cretPass@db.internal:5432/app'],
  ['mongodb+srv', 'mongodb+srv://admin:pa55word@cluster0.example.net/test'],
  ['Azure storage', `DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${rep('Ab3+', 88)}==`],
  ['high-entropy token', `use this: ${mixed(48)}`],
  // M8-SPEC §7 item 1: hex strings of 32+ characters (hashes too: it errs towards flagging).
  ['git sha (hex, 40)', 'Fixed in commit 3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c0e2b4d6f8 on main.'],
  ['sha256 checksum (hex, 64)', 'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
  ['hex key in groups', 'fingerprint 9f:86:d0:81:88:4c:7d:65:9a:2f:ea:a0:c5:5a:d0:15'],
  ['hex split across lines', 'first 9f86d081884c7d659a2f\nfeaa0c55ad015a3bf4f1b2b0b822cd'],
  // pass, pwd and pw keys.
  ['db_pass', 'db_pass: s3cretValueQ'],
  ['DB_PWD', 'DB_PWD=Tr0ub4dor&3horse'],
  ['pw', 'pw=correcthorse'],
  ['camelCase userPass', '{"userPass": "correcthorse"}'],
  ['PASS=', 'SMTP_PASS=correcthorse'],
  // Prose forms.
  ['prose password', 'The database password is hunter2hunter2xyz.'],
  ['prose password, short', 'the password was hunter2'],
  ['prose secret for', 'The secret for the staging bucket is plumtree77.'],
  ['prose token quoted', 'The token is "abcdefgh".'],
  ['prose key', 'The signing key is Zk3PqR8sT2vW.'],
  ['prose pin', 'The pin is 4821.'],
  // Split across lines or spaced out.
  ['spaced out', `Key: ${[...`sk-ant-api03-${mixed(20)}`].join(' ')}`],
  ['split across lines with labels', `First half: sk-ant-api03-${mixed(6)}\nSecond half: ${mixed(18)}`],
  ['split across lines', `ghp_${mixed(20)}\n${mixed(16)}`],
  ['zero-width inside', `ghp_\u200b${mixed(36)}`],
  ['look-alike letters', 'PASSW\u041eRD=hunter2hunter2'],
  ['full-width letters', '\uff30\uff21\uff33\uff33\uff37\uff2f\uff32\uff24=hunter2hunter2'],
  // URLs with credentials in any form.
  ['mysql url', 'mysql://root:hunter2@db.internal:3306/app'],
  ['empty user', 'https://:hunter2xyz@db.internal/app'],
  ['short password', 'redis://default:pw1@cache:6379'],
  ['percent-encoded password', 'postgres://app:p%40ss%21word@db/app'],
  ['token as the user', `https://${mixed(24)}@github.com/org/repo.git`],
  ['token in the query', `https://api.example.com/v1/items?access_token=${mixed(24)}`],
  ['signed URL', `https://bucket.s3.amazonaws.com/x?X-Amz-Signature=${'9f86d081'.repeat(4)}&X-Amz-Date=20260924`],
  ['key in the query', `https://maps.example.com/api?key=${mixed(30)}`],
  ['scheme-less URL', '//admin:plumtree77@10.0.0.4/'],
  // Encoded and key bodies.
  ['padded base64', 'aGVsbG8taHVudGVyMg=='],
  ['key body without its header', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'],
  ['AWS secret in prose', 'the AWS secret is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
];

const NEGATIVES: Array<[string, string]> = [
  ['plain answer', 'The staging bucket lives in europe-west3; the worker retries three times.'],
  ['short git sha', 'Fixed in commit 3f2a9c1 on main.'],
  ['uuid', 'request 123e4567-e89b-12d3-a456-426614174000 failed'],
  ['placeholder password', 'Set DB_PASSWORD=<your-password> in .env'],
  ['env reference', 'API_KEY=${API_KEY} is read from the environment'],
  ['masked', 'password: ********'],
  ['short value', 'token: abc'],
  ['secret manager path', 'DB_PASSWORD=projects/demo/secrets/db-password'],
  ['process.env', 'const token = process.env.GITHUB_TOKEN'],
  ['connection without password', 'postgres://app@db.internal:5432/app'],
  ['url', 'See https://example.com/docs/getting-started/installation-and-configuration for details.'],
  ['file path', '/Users/someone/projects/team-relay/plugin/src/answer-host.ts'],  // e1-guard: allow (synthetic macOS home path in a test)
  ['identifier', 'The function answerQuestionAutomaticallyWithinScopeFolder is in answer-host.ts.'],
  ['words about tokens', 'Tokens are refreshed every hour; the max_tokens setting is 1000.'],
  ['sk- prose', 'Ask the sk-team channel about it.'],
  ['prose about a password', 'The password is stored in Vault and rotated monthly.'],
  ['prose about a key', 'The key is to keep the retries idempotent.'],
  ['prose about a token', 'The token is refreshed every hour by the worker.'],
  ['prose: the secret is out', 'The secret is out: we ship on Tuesday.'],
  ['pass as a verb', 'The tests pass: 42 of 42.'],
  ['bypass key', 'bypass: enabled-for-admins'],
  ['compass', 'compass=north-east-west'],
  ['ssh url with a user', 'Clone ssh://git@github.com/org/repo.git and run make.'],
  ['https url with a user', 'https://deploy@ci.example.com/job/42'],
  ['query without secrets', 'https://example.com/search?q=staging+bucket&page=2'],
  ['placeholder in url', 'postgres://app:${DB_PASSWORD}@db.internal/app'],
  ['masked url password', 'postgres://app:****@db.internal/app'],
  ['spaced letters in prose', 'The steps are a b c d e f g h, in that order.'],
  ['two lines of prose', 'The worker restarts\nautomatically after a crash.'],
  ['numbers', 'Counts: 10 20 30 40 50 60 70 80 90 100 110 120 130 140 150 160.'],
  ['base64 without padding', 'The id is dGVzdA and the tag is v1.2.3.'],
];

describe('secret screen (M8-SPEC §3)', () => {
  for (const [name, text] of POSITIVES) {
    it(`flags: ${name}`, () => {
      expect(screenSecrets(text).length, name).toBeGreaterThan(0);
    });
  }
  for (const [name, text] of NEGATIVES) {
    it(`passes: ${name}`, () => {
      expect(screenSecrets(text), name).toEqual([]);
    });
  }

  it('says what kind of secret, never the secret', () => {
    const secret = `sk_live_${mixed(24)}`;
    const found = screenSecrets(`key ${secret}`);
    expect(found.map((f) => f.kind)).toContain('a Stripe key');
    expect(JSON.stringify(found)).not.toContain(secret);
  });

  it('names every kind, never the text, for the review\'s own cases', () => {
    const found = screenSecrets(`the password is ${mixed(12)}`);
    expect(found.map((f) => f.kind)).toEqual(['a secret stated in words']);
    expect(JSON.stringify(found)).not.toContain(mixed(12));
  });

  it('stays fast on the largest draft, however it is built', () => {
    const inputs = [
      'a '.repeat(16_000),
      'aa:'.repeat(10_000),
      'password is '.repeat(2600),
      `${'x'.repeat(31_999)}=`,
      '//'.repeat(16_000),
      'k=v&'.repeat(8000),
      `${mixed(100)}\n`.repeat(300),
    ];
    const started = Date.now();
    for (const text of inputs) screenSecrets(text);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('screens the structured data too', () => {
    expect(screenDraft('Here is the result.', { rows: [{ note: `ghp_${mixed(36)}` }] }).length).toBeGreaterThan(0);
    expect(screenDraft('Here is the result.', { rows: [{ count: 42 }] })).toEqual([]);
  });
});
