import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeJwtClaims,
  extractAccountId,
  extractPlanType,
  extractEmail,
  expiryFromToken,
  importCodexCredentials,
  buildCodexAuthUrl,
} from '../src/codex/oauth.js';

const ACCOUNT_CLAIM = 'https://api.openai.com/auth';

// Build an unsigned JWT with the given payload. Signature is never checked —
// these claims only carry an account id and expiry for a token the issuer
// already handed us.
function jwt(payload) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

async function writeAuthFile(contents) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-auth-'));
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify(contents));
  return path;
}

test('decodeJwtClaims reads the payload, and returns null for junk', () => {
  assert.deepEqual(decodeJwtClaims(jwt({ sub: 'u1' })), { sub: 'u1' });
  assert.equal(decodeJwtClaims('not-a-jwt'), null);
  assert.equal(decodeJwtClaims(''), null);
  assert.equal(decodeJwtClaims(null), null);
});

test('extractAccountId reads the namespaced claim', () => {
  const token = jwt({ [ACCOUNT_CLAIM]: { chatgpt_account_id: 'acct-1' } });
  assert.equal(extractAccountId(token), 'acct-1');
});

test('extractAccountId falls back to the flattened claim spelling', () => {
  const token = jwt({ [`${ACCOUNT_CLAIM}.chatgpt_account_id`]: 'acct-2' });
  assert.equal(extractAccountId(token), 'acct-2');
});

test('extractAccountId returns null when the claim is absent', () => {
  assert.equal(extractAccountId(jwt({ sub: 'u1' })), null);
});

test('extractPlanType and extractEmail read their claims', () => {
  const token = jwt({ [ACCOUNT_CLAIM]: { chatgpt_plan_type: 'pro' }, email: 'a@b.c' });
  assert.equal(extractPlanType(token), 'pro');
  assert.equal(extractEmail(token), 'a@b.c');
});

test('expiryFromToken converts the exp claim from seconds to milliseconds', () => {
  assert.equal(expiryFromToken(jwt({ exp: 1_700_000_000 })), 1_700_000_000_000);
  assert.equal(expiryFromToken(jwt({})), null);
});

test('importCodexCredentials reads a ChatGPT OAuth auth file', async () => {
  const path = await writeAuthFile({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: jwt({ exp: 1_700_000_000 }),
      refresh_token: 'rt.1.abc',
      id_token: jwt({ [ACCOUNT_CLAIM]: { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' }, email: 'a@b.c' }),
      account_id: 'acct-1',
    },
  });

  const creds = await importCodexCredentials(path);
  assert.equal(creds.protocol, 'codex');
  assert.equal(creds.type, 'oauth');
  assert.equal(creds.accountId, 'acct-1');
  assert.equal(creds.planType, 'plus');
  assert.equal(creds.email, 'a@b.c');
  assert.equal(creds.refreshToken, 'rt.1.abc');
  assert.equal(creds.expiresAt, 1_700_000_000_000);
});

test('importCodexCredentials derives the account id from the id_token when the field is absent', async () => {
  const path = await writeAuthFile({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: jwt({ exp: 1 }),
      refresh_token: 'rt.1.abc',
      id_token: jwt({ [ACCOUNT_CLAIM]: { chatgpt_account_id: 'acct-from-jwt' } }),
    },
  });
  assert.equal((await importCodexCredentials(path)).accountId, 'acct-from-jwt');
});

test('importCodexCredentials rejects an API-key auth file', async () => {
  const path = await writeAuthFile({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' });
  await assert.rejects(importCodexCredentials(path), /Unsupported Codex auth_mode "apikey"/);
});

test('importCodexCredentials rejects a file with no OAuth tokens', async () => {
  const path = await writeAuthFile({ auth_mode: 'chatgpt', tokens: {} });
  await assert.rejects(importCodexCredentials(path), /No Codex OAuth tokens/);
});

test('importCodexCredentials rejects a file with no derivable account id', async () => {
  const path = await writeAuthFile({
    auth_mode: 'chatgpt',
    tokens: { access_token: jwt({ exp: 1 }), refresh_token: 'rt.1.abc', id_token: jwt({ sub: 'u' }) },
  });
  await assert.rejects(importCodexCredentials(path), /Could not determine the ChatGPT account id/);
});

// ── independent login flow ──────────────────────────────────
//
// `import --codex` copies the Codex CLI's credential, so both hold one refresh
// token and — since OpenAI rotates it on every refresh — whichever refreshes
// second is left with a dead one. A login performs its own authorization,
// which mints a separate refresh-token lineage. These assertions pin the
// parameters that make that separation real.

test('the authorize URL requests offline_access so a refresh token is issued', () => {
  const url = new URL(buildCodexAuthUrl({ state: 's', codeChallenge: 'c' }));
  assert.ok(url.searchParams.get('scope').split(' ').includes('offline_access'));
});

test('the authorize URL forces a fresh authorization', () => {
  // Without prompt=login the provider may reuse the existing session and hand
  // back a grant tied to it, which is exactly the sharing we are avoiding.
  const url = new URL(buildCodexAuthUrl({ state: 's', codeChallenge: 'c' }));
  assert.equal(url.searchParams.get('prompt'), 'login');
});

test('the authorize URL carries a PKCE S256 challenge and state', () => {
  const url = new URL(buildCodexAuthUrl({ state: 'st8', codeChallenge: 'chal' }));
  assert.equal(url.searchParams.get('code_challenge'), 'chal');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'st8');
  assert.equal(url.searchParams.get('response_type'), 'code');
});

test('the authorize URL targets the registered redirect and OpenAI host', () => {
  // The redirect URI is registered against the Codex CLI client id, so it is
  // not free to change — the callback listener must bind this exact port.
  const url = new URL(buildCodexAuthUrl({ state: 's', codeChallenge: 'c' }));
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
});
