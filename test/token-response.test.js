import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  tokenPairFromResponse, normalizeExpiresAt, isTokenExpired, isTokenExpiringSoon, refreshAccessToken,
} from '../src/oauth.js';
import { credentialsFromTokenResponse, refreshCodexToken } from '../src/codex-auth.js';

// A 200 from the token endpoint is not proof its body is usable. One without
// an access_token used to be stored as `accessToken: undefined` (sent upstream
// as `Bearer undefined`), and a non-numeric expiry was stored as-is, where the
// expiry checks never fired on it.

const NOW = 1_700_000_000_000;

test('a token response without a usable access_token is an error, not undefined', () => {
  for (const body of [{}, { access_token: '' }, { access_token: 42 }, { access_token: null }, null]) {
    assert.throws(() => tokenPairFromResponse(body, { now: NOW }), /no access_token/, JSON.stringify(body));
  }
});

test('the refresh token is taken only as a non-empty string, else the previous one is kept', () => {
  const prev = 'old-rt';
  assert.equal(tokenPairFromResponse({ access_token: 'at', refresh_token: 'new-rt' }, { previousRefreshToken: prev }).refreshToken, 'new-rt');
  for (const rt of [undefined, '', 7, null]) {
    assert.equal(tokenPairFromResponse({ access_token: 'at', refresh_token: rt }, { previousRefreshToken: prev }).refreshToken, prev);
  }
  // The code-exchange path has no previous token to fall back to.
  assert.equal(tokenPairFromResponse({ access_token: 'at' }).refreshToken, undefined);
});

test('the expiry is a number: expires_at in seconds or ms, else expires_in, else an hour', () => {
  const at = (body) => tokenPairFromResponse({ access_token: 'at', ...body }, { now: NOW }).expiresAt;
  assert.equal(at({ expires_at: 1_700_003_600 }), 1_700_003_600_000);        // seconds → ms
  assert.equal(at({ expires_at: 1_700_003_600_000 }), 1_700_003_600_000);    // already ms
  assert.equal(at({ expires_at: '1700003600' }), 1_700_003_600_000);         // numeric string coerced
  assert.equal(at({ expires_in: 600 }), NOW + 600_000);
  assert.equal(at({ expires_in: '600' }), NOW + 600_000);
  // Absent or garbage: one hour, so the next refresh merely happens early.
  assert.equal(at({}), NOW + 3_600_000);
  assert.equal(at({ expires_at: 'soon' }), NOW + 3_600_000);
  assert.equal(at({ expires_at: 'soon', expires_in: 'later' }), NOW + 3_600_000);
  assert.equal(at({ expires_in: -5 }), NOW + 3_600_000);
  assert.equal(at({ expires_at: {}, expires_in: NaN }), NOW + 3_600_000);
  for (const body of [{}, { expires_at: 'x' }, { expires_in: 'y' }]) {
    assert.equal(typeof at(body), 'number', JSON.stringify(body));
  }
});

test('normalizeExpiresAt yields null, not the input, for a value that is not a number', () => {
  assert.equal(normalizeExpiresAt('soon'), null);
  assert.equal(normalizeExpiresAt(undefined), null);
  assert.equal(normalizeExpiresAt(null), null);
  assert.equal(normalizeExpiresAt(-1), null);
  assert.equal(normalizeExpiresAt(1_700_000_000), 1_700_000_000_000);
  assert.equal(normalizeExpiresAt('1700000000000'), 1_700_000_000_000);
});

test('an expiry that is present but unusable counts as reached; a missing one as unknown', () => {
  // Before, `Date.now() >= 'soon'` was false forever, so the token was never refreshed.
  assert.equal(isTokenExpired('soon'), true);
  assert.equal(isTokenExpiringSoon('soon'), true);
  assert.equal(isTokenExpired(undefined), false);
  assert.equal(isTokenExpiringSoon(null), false);
  assert.equal(isTokenExpired(Date.now() + 60_000), false);
  assert.equal(isTokenExpired(Date.now() - 60_000), true);
});

test('a Codex token response is checked the same way', () => {
  assert.throws(() => credentialsFromTokenResponse({ refresh_token: 'rt' }), /no access_token/);
  const creds = credentialsFromTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 'bogus' });
  assert.equal(creds.accessToken, 'at');
  assert.equal(typeof creds.expiresAt, 'number');
  assert.ok(creds.expiresAt > Date.now());
});

// The live refresh paths: a 200 with an empty body rejects instead of handing
// back a credential with no token in it.
async function tokenServer(body) {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, endpoint: `http://127.0.0.1:${srv.address().port}/token` };
}

test('refreshAccessToken rejects a 200 that carries no access_token', async () => {
  const { srv, endpoint } = await tokenServer({ token_type: 'Bearer' });
  try {
    await assert.rejects(refreshAccessToken('r', endpoint), /no access_token/);
  } finally {
    srv.close();
  }
});

test('refreshAccessToken keeps the previous refresh token and numbers the expiry', async () => {
  const { srv, endpoint } = await tokenServer({ access_token: 'AT', expires_in: '120' });
  try {
    const t = await refreshAccessToken('r', endpoint);
    assert.equal(t.accessToken, 'AT');
    assert.equal(t.refreshToken, 'r');
    assert.ok(Number.isFinite(t.expiresAt) && t.expiresAt > Date.now());
  } finally {
    srv.close();
  }
});

test('refreshCodexToken rejects a 200 that carries no access_token', async () => {
  const { srv, endpoint } = await tokenServer({});
  try {
    await assert.rejects(refreshCodexToken('r', endpoint), /no access_token/);
  } finally {
    srv.close();
  }
});
