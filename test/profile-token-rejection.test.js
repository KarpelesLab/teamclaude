import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchProfile, isTokenRejection } from '../src/oauth.js';
import { canUpsertOAuthAccount } from '../src/identity.js';

// The guard in canUpsertOAuthAccount is only as good as the status fetchProfile
// reports: if the status stopped coming back, isTokenRejection would answer
// "not a rejection" for every dead token and the refusal would quietly stop
// happening. These drive the real function with a stubbed global fetch, which
// is what proxyFetch calls when no upstream proxy is configured.

function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return (async () => { try { return await fn(); } finally { globalThis.fetch = real; } })();
}

const responding = (status, body = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

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
});

test('a successful profile still carries no status and is importable', async () => {
  const ok = await withFetch(responding(200, { account: { uuid: 'u-1', email: 'a@example.com' } }),
    () => fetchProfile('tok'));
  assert.equal(ok.error, undefined);
  assert.equal(isTokenRejection(ok), false);
  assert.equal(canUpsertOAuthAccount(ok, false), true);
});
