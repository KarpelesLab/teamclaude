import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchProfile, profileForCredentials } from '../src/oauth.js';
import { canUpsertOAuthAccount, isTokenRejection } from '../src/identity.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

// The guard in canUpsertOAuthAccount is only as good as the status fetchProfile
// reports: if the status stopped coming back, isTokenRejection would answer
// "not a rejection" for every dead token and the refusal would quietly stop
// happening. These drive the real functions with a stubbed global fetch, which
// is what proxyFetch calls when no upstream proxy is configured — hence the
// opt-out below, so an exported HTTPS_PROXY cannot route around the stub.

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return (async () => { try { return await fn(); } finally { globalThis.fetch = real; } })();
}

const reply = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const responding = (status, body = {}) => async () => reply(status, body);

const identified = () => reply(200, {
  account: { uuid: 'u-1', email: 'a@example.com' },
  organization: { uuid: 'o-1', name: 'Acme' },
});

// A fake upstream: the profile endpoint answers per bearer token (anything not
// listed gets a 401, as a stale token does), the token endpoint per refresh
// request. Every call is recorded so a test can say which token went where.
function upstream({ profiles = {}, refresh = () => reply(400, { error: 'invalid_grant' }) } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === PROFILE_URL) {
      const bearer = String(init.headers?.Authorization || '').replace(/^Bearer /, '');
      return profiles[bearer] ? profiles[bearer]() : reply(401, { error: { message: 'invalid bearer token' } });
    }
    if (url === TOKEN_URL) return refresh(JSON.parse(init.body));
    throw new Error(`unexpected fetch of ${url}`);
  };
  return {
    fetch,
    bearers: () => calls.filter(c => c.url === PROFILE_URL).map(c => c.init.headers.Authorization),
    refreshes: () => calls.filter(c => c.url === TOKEN_URL).map(c => JSON.parse(c.init.body)),
  };
}

test('fetchProfile reports the status, not just the message', async () => {
  for (const status of [401, 403, 500, 503]) {
    const profile = await withFetch(responding(status, { error: { message: 'nope' } }),
      () => fetchProfile('tok'));
    assert.equal(profile.status, status, `status ${status} survives to the caller`);
    assert.ok(profile.error, 'and the human-readable message is still there');
  }
});

test('a thrown fetch is reported as status null, not as a rejection', async () => {
  const profile = await withFetch(async () => { throw new Error('ECONNRESET'); },
    () => fetchProfile('tok'));
  assert.equal(profile.status, null);
  assert.match(profile.error, /ECONNRESET/);
  // The distinction this whole change rests on: unreachable is not refused.
  assert.equal(isTokenRejection(profile), false);
  assert.equal(canUpsertOAuthAccount(profile, true), true);
});

test('end to end: a 401 from the profile endpoint blocks the named import', async () => {
  const refused = await withFetch(responding(401, { error: { message: 'invalid bearer token' } }),
    () => fetchProfile('dead-token'));
  assert.equal(isTokenRejection(refused), true);
  assert.equal(canUpsertOAuthAccount(refused, true), false, '--name does not override a refusal');

  // A 5xx on the same path stays importable, so an upstream blip cannot lock an
  // operator out of adding a perfectly good account.
  const blip = await withFetch(responding(503), () => fetchProfile('good-token'));
  assert.equal(isTokenRejection(blip), false);
  assert.equal(canUpsertOAuthAccount(blip, true), true);

  // So does a 403: that is the answer a valid token gets from an unexpected
  // region or under an org policy, not a verdict on the token.
  const region = await withFetch(responding(403, { error: { message: 'Request not allowed' } }),
    () => fetchProfile('good-token'));
  assert.equal(isTokenRejection(region), false);
  assert.equal(canUpsertOAuthAccount(region, true), true);
  assert.equal(canUpsertOAuthAccount(region, false), false, 'unnamed still needs an identity');
});

test('a successful profile still carries no status and is importable', async () => {
  const ok = await withFetch(responding(200, { account: { uuid: 'u-1', email: 'a@example.com' } }),
    () => fetchProfile('tok'));
  assert.equal(ok.error, undefined);
  assert.equal(isTokenRejection(ok), false);
  assert.equal(canUpsertOAuthAccount(ok, false), true);
});

// ── a stale credentials file is refreshed, not refused ─────────────

test('an expired access token is refreshed first, the profile fetched with the new one, and the new pair is what comes back', async () => {
  const up = upstream({
    profiles: { 'new-at': identified },
    refresh: () => reply(200, { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }),
  });
  // What Claude Code leaves on disk an hour after its last request: a dead
  // access token beside a live refresh token, plus fields of its own.
  const creds = { accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: Date.now() - 60_000, rateLimitTier: 'default_claude_max_5x' };
  const { creds: saved, profile } = await withFetch(up.fetch, () => profileForCredentials(creds));

  assert.deepEqual(up.refreshes().map(b => [b.grant_type, b.refresh_token]), [['refresh_token', 'old-rt']]);
  assert.deepEqual(up.bearers(), ['Bearer new-at'], 'the token the clock wrote off never went to the profile endpoint');
  assert.equal(profile.email, 'a@example.com');
  assert.equal(isTokenRejection(profile), false);
  assert.equal(canUpsertOAuthAccount(profile, false), true);
  // The saved row is written from these: the renewed pair over every other field.
  assert.equal(saved.accessToken, 'new-at');
  assert.equal(saved.refreshToken, 'new-rt');
  assert.ok(saved.expiresAt > Date.now(), 'the expiry is the new token\'s');
  assert.equal(saved.rateLimitTier, 'default_claude_max_5x');
  assert.equal(creds.accessToken, 'old-at', 'the input set is left alone');
});

test('a 401 on a token the clock still trusts is refreshed too', async () => {
  const up = upstream({
    profiles: { 'new-at': identified },
    refresh: () => reply(200, { access_token: 'new-at', expires_in: 3600 }),
  });
  const creds = { accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: Date.now() + 3_600_000 };
  const { creds: saved, profile } = await withFetch(up.fetch, () => profileForCredentials(creds));

  assert.deepEqual(up.bearers(), ['Bearer old-at', 'Bearer new-at']);
  assert.equal(profile.email, 'a@example.com');
  assert.equal(saved.accessToken, 'new-at');
  assert.equal(saved.refreshToken, 'old-rt', 'a refresh that rotated nothing keeps the refresh token');
});

test('a 401 with no refresh token is a rejection, with nothing to try', async () => {
  const up = upstream();
  const creds = { accessToken: 'dead-at', expiresAt: Date.now() + 3_600_000 };
  const { creds: saved, profile } = await withFetch(up.fetch, () => profileForCredentials(creds));

  assert.deepEqual(up.refreshes(), []);
  assert.equal(profile.status, 401);
  assert.match(profile.error, /HTTP 401.*no refresh token/);
  assert.equal(isTokenRejection(profile), true);
  assert.equal(canUpsertOAuthAccount(profile, true), false, '--name does not override a refusal');
  assert.equal(saved, creds);
});

test('a refresh the token endpoint rejects makes the 401 final', async () => {
  // invalid_grant is what a revoked or already-rotated refresh token gets: the
  // same 400 that account-manager reads as "needs re-login".
  const up = upstream({ refresh: () => reply(400, { error: 'invalid_grant' }) });
  const creds = { accessToken: 'dead-at', refreshToken: 'dead-rt', expiresAt: Date.now() - 60_000 };
  const { profile } = await withFetch(up.fetch, () => profileForCredentials(creds));

  assert.deepEqual(up.refreshes().map(b => b.refresh_token), ['dead-rt']);
  // The upstream keeps the last word on the access token itself: the one the
  // clock wrote off is still presented once, and it is the 401 that refuses.
  assert.deepEqual(up.bearers(), ['Bearer dead-at']);
  assert.equal(profile.status, 401);
  assert.match(profile.error, /HTTP 401.*token refresh rejected.*400/);
  assert.equal(isTokenRejection(profile), true);
  assert.equal(canUpsertOAuthAccount(profile, true), false);
});

test('a refresh that merely failed leaves the credential unreachable, not refused', async () => {
  // A thrown fetch on the token endpoint. (A 5xx goes through the refresh's
  // own retries first and lands in the same place, carrying that status.)
  const up = upstream({ refresh: () => { throw new Error('ECONNRESET'); } });
  const creds = { accessToken: 'stale-at', refreshToken: 'maybe-good-rt', expiresAt: Date.now() + 3_600_000 };
  const { creds: saved, profile } = await withFetch(up.fetch, () => profileForCredentials(creds));

  assert.deepEqual(up.refreshes().map(b => b.refresh_token), ['maybe-good-rt']);
  assert.equal(profile.status, null);
  assert.match(profile.error, /HTTP 401.*token refresh failed.*ECONNRESET/);
  assert.equal(isTokenRejection(profile), false);
  // Exactly as before: --name gets it in from a restricted network, and an
  // unnamed import still needs an identity.
  assert.equal(canUpsertOAuthAccount(profile, true), true);
  assert.equal(canUpsertOAuthAccount(profile, false), false);
  assert.equal(saved, creds, 'nothing was renewed, so nothing changes');
});

test('a 403 is not refreshed and not refused', async () => {
  const up = upstream({
    profiles: { 'good-at': () => reply(403, { error: { message: 'Request not allowed' } }) },
  });
  const creds = { accessToken: 'good-at', refreshToken: 'good-rt', expiresAt: Date.now() + 3_600_000 };
  const { profile } = await withFetch(up.fetch, () => profileForCredentials(creds));

  assert.deepEqual(up.refreshes(), [], 'a new token would meet the same 403');
  assert.equal(profile.status, 403);
  assert.equal(isTokenRejection(profile), false);
  assert.equal(canUpsertOAuthAccount(profile, true), true);
});
