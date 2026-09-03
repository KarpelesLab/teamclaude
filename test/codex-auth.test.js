import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCodexCredentials } from '../src/codex-auth.js';

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (claims) => `${b64u({ alg: 'none' })}.${b64u(claims)}.sig`;

async function writeAuth(contents) {
  const home = await mkdtemp(join(tmpdir(), 'tc-codex-'));
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify(contents));
  return home;
}

test('reads the token pair and account id from the Codex CLI file', async () => {
  const home = await writeAuth({
    tokens: {
      access_token: 'at', refresh_token: 'rt', account_id: 'acct-stored',
      id_token: jwt({
        email: 'user@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-claim', chatgpt_plan_type: 'pro' },
      }),
    },
  });
  const creds = await importCodexCredentials('~/.codex/auth.json', { home });
  assert.equal(creds.accessToken, 'at');
  assert.equal(creds.refreshToken, 'rt');
  assert.equal(creds.email, 'user@example.com');
  assert.equal(creds.planType, 'pro');
  // The id_token claim is what the server itself issued, so it wins over the
  // value mirrored into tokens.account_id.
  assert.equal(creds.accountId, 'acct-claim');
});

test('falls back to the stored account id when the id_token has no claim', async () => {
  const home = await writeAuth({ tokens: { access_token: 'at', refresh_token: 'rt', account_id: 'acct-stored' } });
  const creds = await importCodexCredentials('~/.codex/auth.json', { home });
  assert.equal(creds.accountId, 'acct-stored');
});

// Cosmetic claims must never be load-bearing: a malformed id_token still has
// to yield a usable credential.
test('a malformed id_token does not break the import', async () => {
  const home = await writeAuth({ tokens: { access_token: 'at', refresh_token: 'rt', account_id: 'a', id_token: 'not-a-jwt' } });
  const creds = await importCodexCredentials('~/.codex/auth.json', { home });
  assert.equal(creds.accessToken, 'at');
  assert.equal(creds.email, undefined);
});

test('a file with no tokens yields no access token, so the account is skipped', async () => {
  const home = await writeAuth({});
  const creds = await importCodexCredentials('~/.codex/auth.json', { home });
  assert.equal(creds.accessToken, undefined);
});

// ── Browser login ───────────────────────────────────────────────────────────

import { buildCodexAuthUrl, credentialsFromTokenResponse } from '../src/codex-auth.js';

test('the authorize URL carries the parameters OpenAI requires', () => {
  const url = new URL(buildCodexAuthUrl({ state: 'st', codeChallenge: 'cc' }));
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  // `api` here is rejected live with invalid_scope — this client may not
  // request it, so the assertion pins the scope set that actually works.
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('code_challenge'), 'cc');
  // PKCE must be S256: a public client has no secret, so `plain` would leave
  // the exchange bound to nothing.
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  // OpenAI registered exactly one redirect for this client.
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
});

test('a token response becomes the same credential shape as an import', () => {
  const creds = credentialsFromTokenResponse({
    access_token: 'at',
    refresh_token: 'rt',
    expires_in: 600,
    id_token: jwt({
      email: 'user@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'pro' },
    }),
  });
  assert.equal(creds.accessToken, 'at');
  assert.equal(creds.refreshToken, 'rt');
  assert.equal(creds.accountId, 'acct-1');
  assert.equal(creds.email, 'user@example.com');
  assert.equal(creds.planType, 'pro');
  assert.ok(creds.expiresAt > Date.now());
});

test('a token response with no id_token still yields usable credentials', () => {
  const creds = credentialsFromTokenResponse({ access_token: 'at', refresh_token: 'rt' });
  assert.equal(creds.accessToken, 'at');
  assert.equal(creds.accountId, undefined);
});
