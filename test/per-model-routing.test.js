import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { modelFamily, weeklyBucketForModel, modelGlobMatches, TopLevelFieldFinder } from '../src/model.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const OPUS = 'claude-opus-4-6';
const SONNET = 'claude-sonnet-4-6';
const FABLE = 'claude-fable-5';

// ── model family / governing bucket ───────────────────────────

test('modelFamily classifies the known families and falls back to other', () => {
  assert.equal(modelFamily(FABLE), 'fable');
  assert.equal(modelFamily(SONNET), 'sonnet');
  assert.equal(modelFamily(OPUS), 'opus');
  assert.equal(modelFamily('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(modelFamily('deepseek-v4-pro[1m]'), 'other');
  assert.equal(modelFamily(null), 'other');
});

test('weeklyBucketForModel maps each family to the bucket that governs it', () => {
  assert.equal(weeklyBucketForModel(FABLE), 'unified7dFable');
  assert.equal(weeklyBucketForModel(SONNET), 'unified7dSonnet');
  assert.equal(weeklyBucketForModel(OPUS), 'unified7d');       // shared weekly
  assert.equal(weeklyBucketForModel('deepseek-x'), 'unified7d');
});

// ── per-model availability (issue #85) ────────────────────────

test('a spent Fable weekly bucket bars only Fable — Opus/Sonnet still route there', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  q.unified5h = 0.1;          // shared 5h has headroom
  q.unified7d = 0.2;          // shared weekly has headroom
  q.unified7dFable = 1.0;     // Fable weekly is spent

  assert.equal(am._isAvailable(am.accounts[0], FABLE), false, 'Fable is blocked');
  assert.equal(am._isAvailable(am.accounts[0], OPUS), true, 'Opus still available');
  assert.equal(am._isAvailable(am.accounts[0], SONNET), true, 'Sonnet still available');
});

test('a spent Sonnet weekly bucket bars only Sonnet — Opus/Fable unaffected', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  q.unified5h = 0.1;
  q.unified7d = 0.2;
  q.unified7dSonnet = 1.0;    // Sonnet weekly spent

  assert.equal(am._isAvailable(am.accounts[0], SONNET), false);
  assert.equal(am._isAvailable(am.accounts[0], OPUS), true);
  assert.equal(am._isAvailable(am.accounts[0], FABLE), true);
});

test('the shared 5h bucket still gates every model', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.accounts[0].quota.unified5h = 0.99; // over threshold → nothing routes
  for (const m of [OPUS, SONNET, FABLE, null]) {
    assert.equal(am._isAvailable(am.accounts[0], m), false, `blocked for ${m}`);
  }
});

test('a spent family bucket with no shared-weekly value falls back to the shared weekly', () => {
  // When the plan does not expose a Fable-specific bucket, a Fable request must
  // still honor the shared weekly cap rather than sail past it.
  const am = new AccountManager([oauth('a')], 0.98);
  const q = am.accounts[0].quota;
  q.unified5h = 0.1;
  q.unified7d = 1.0;          // shared weekly spent, no unified7dFable reported
  assert.equal(am._isAvailable(am.accounts[0], FABLE), false);
  assert.equal(am._isAvailable(am.accounts[0], OPUS), false);
});

// ── per-model reset ranking ───────────────────────────────────

test('selection spends the account whose GOVERNING weekly resets soonest', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  const a = am.accounts[0].quota, b = am.accounts[1].quota;
  const soon = Date.now() + 60_000, later = Date.now() + 600_000; // future so they aren't cleared as expired
  // a: general weekly resets soonest; b: Fable weekly resets soonest.
  a.unified7d = 0.3; a.unified7dReset = soon;  a.unified7dFable = 0.3; a.unified7dFableReset = later;
  b.unified7d = 0.3; b.unified7dReset = later; b.unified7dFable = 0.3; b.unified7dFableReset = soon;

  assert.equal(am._pickBestAvailable(null, OPUS).name, 'a', 'Opus spends soonest general weekly');
  assert.equal(am._pickBestAvailable(null, FABLE).name, 'b', 'Fable spends soonest Fable weekly');
});

// ── streaming model peek (shown immediately) ──────────────────

test('the top-level model resolves from the first streamed chunk, before the full body', () => {
  // A realistic messages body: `model` is an early top-level field, the bulk is
  // the messages array. The finder must resolve on the first chunk.
  const head = Buffer.from('{"model":"claude-opus-4-6","messages":[');
  const tail = Buffer.from('{"role":"user","content":"' + 'x'.repeat(10_000) + '"}]}');

  const f = new TopLevelFieldFinder('model');
  const found = f.push(head);
  assert.equal(found, 'claude-opus-4-6', 'model known from the first chunk');
  assert.equal(f.done, true, 'no need to read the rest of the body');
  // Feeding the (large) tail changes nothing — we already have the answer.
  assert.equal(f.push(tail), 'claude-opus-4-6');
});

test('a model key nested in conversation content is never mistaken for the request model', () => {
  const body = Buffer.from(JSON.stringify({
    messages: [{ role: 'user', content: 'here is some json: {"model":"decoy"}' }],
    model: 'claude-sonnet-4-6',
  }));
  const f = new TopLevelFieldFinder('model');
  assert.equal(f.push(body), 'claude-sonnet-4-6');
});

// ── configurable routes ───────────────────────────────────────

test('modelGlobMatches supports * and is case-insensitive, literal otherwise', () => {
  assert.ok(modelGlobMatches('*fable*', FABLE));
  assert.ok(modelGlobMatches('claude-opus-*', OPUS));
  assert.ok(modelGlobMatches('CLAUDE-SONNET-4-6', SONNET));
  assert.ok(modelGlobMatches('*', 'anything'));
  assert.ok(!modelGlobMatches('*fable*', OPUS));
  assert.ok(!modelGlobMatches('claude-opus', OPUS));       // no implicit prefix match
  assert.ok(!modelGlobMatches('deepseek.v4', 'deepseekXv4')); // '.' is literal, not any-char
});

test('a route pins a model glob to an exclusive set of accounts', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'fable', match: ['*fable*'], accounts: ['b'] }],
  });
  // Fable is locked to account b; a is ineligible even though it has full quota.
  assert.equal(am._isAvailable(am.accounts[0], FABLE), false, 'a barred from Fable');
  assert.equal(am._isAvailable(am.accounts[1], FABLE), true, 'b serves Fable');
  // Other models are unaffected by the route.
  assert.equal(am._isAvailable(am.accounts[0], OPUS), true);
  assert.equal(am._isAvailable(am.accounts[1], OPUS), true);
  // getActiveAccount honors the route: a Fable request only ever returns b.
  assert.equal(am.getActiveAccount(null, FABLE).name, 'b');
});

test('a route can be matched by account index as well as name', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'fable', match: ['*fable*'], accounts: [1] }],
  });
  assert.equal(am._isAvailable(am.accounts[0], FABLE), false);
  assert.equal(am._isAvailable(am.accounts[1], FABLE), true);
});

test('a route bucket override governs eligibility for a custom model id', () => {
  const am = new AccountManager([oauth('a')], 0.98, {
    routes: [{ name: 'custom', match: ['deepseek-*'], bucket: 'unified7dFable' }],
  });
  const q = am.accounts[0].quota;
  q.unified5h = 0.1; q.unified7d = 0.1; q.unified7dFable = 1.0; // Fable bucket spent
  // The custom model is gated by the overridden bucket, so it's blocked...
  assert.equal(am._isAvailable(am.accounts[0], 'deepseek-v4-pro'), false);
  // ...while a model with no route still uses its own family bucket (unaffected).
  assert.equal(am._isAvailable(am.accounts[0], OPUS), true);
});

test('routes with no account list fall back to the legacy per-account models claim', () => {
  // No route restricts accounts, but account b claims Fable via models[] (PR #74).
  const am = new AccountManager([oauth('a'), oauth('b', { models: ['claude-fable-5'] })], 0.98);
  assert.equal(am._isAvailable(am.accounts[0], FABLE), false, 'a not an owner');
  assert.equal(am._isAvailable(am.accounts[1], FABLE), true, 'b owns Fable');
});

test('setRoutes normalizes shapes and is re-appliable on reload', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  assert.deepEqual(am.routes, []);
  am.setRoutes([{ match: '*fable*', accounts: ['a', 2] }]); // string match, mixed account types
  assert.equal(am.routes.length, 1);
  assert.equal(am.routes[0].name, 'route-1');              // defaulted
  assert.deepEqual(am.routes[0].match, ['*fable*']);        // wrapped to array
  assert.deepEqual(am.routes[0].accounts, ['a', '2']);      // stringified
  am.setRoutes(undefined);                                  // reload with none
  assert.deepEqual(am.routes, []);
});
