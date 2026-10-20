import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The selection paths that pick an account without going through
// unavailableReason, and the readings that feed them, checked against an
// account's `maxUsage` cap (#568). Each test is the case where the account
// at its cap would otherwise be handed a request, or priced on quota it may
// not spend.

const H = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// ── The all-unavailable revival ─────────────────────────────

test('a lapsed throttle does not revive an account at its cap', () => {
  const am = new AccountManager([oauth('a'), oauth('capped', { maxUsage: 0.7 })], 0.98);
  const [a, capped] = am.accounts;
  // `a` is out of 5h quota until a future reset; `capped` sits at its cap
  // holding a throttle that has already lapsed, which reads as the soonest
  // reset in the fleet.
  Object.assign(a.quota, { unified5h: 0.99, unified5hReset: Date.now() + H });
  Object.assign(capped.quota, { unified5h: 0.75, unified5hReset: Date.now() + 2 * H });
  capped.status = 'throttled';
  capped.rateLimitedUntil = Date.now() - 1000;

  assert.equal(am._selectNext(null, OPUS), null);
  // Not revived on the way: its throttle state is left as it was.
  assert.equal(capped.status, 'throttled');
});

test('nor an account over its spend cap', () => {
  const am = new AccountManager([oauth('a'), oauth('spent', { maxSpend: 10 })], 0.98);
  const [a, spent] = am.accounts;
  Object.assign(a.quota, { unified5h: 0.99, unified5hReset: Date.now() + H });
  spent.quota.spend = { enabled: true, usedMinor: 1200, limitMinor: 5000, currency: 'USD', exponent: 2 };
  spent.status = 'throttled';
  spent.rateLimitedUntil = Date.now() - 1000;
  assert.equal(am.capExceeded(spent, OPUS), 'spend', 'precondition: the spend cap binds');

  assert.equal(am._selectNext(null, OPUS), null);
});

// ── The re-check after admission ────────────────────────────

test('a request queued in admission does not go out on an account its wait put at the cap', async () => {
  // Upstream reports the capped account's 5h window past its cap on the first
  // response, so the request queued behind that one must move.
  const seen = /** @type {string[]} */ ([]);
  const upstream = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push(token);
    res.writeHead(200, {
      'content-type': 'application/json',
      ...(token === 't-capped' ? { 'anthropic-ratelimit-unified-5h-utilization': '0.75' } : {}),
    });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(/** @type {any} */ (upstream.address()).port)));
  const am = new AccountManager([oauth('capped', { maxUsage: 0.7 }), oauth('b')], 0.98, {
    // One admission at a time on the freshly ramped account, so the second
    // request waits for the first to come back.
    ramp: { enabled: true, startConc: 1, stepConc: 1, stepMs: 1000, windowMs: 30_000, pollMs: 5 },
  });
  am.accounts[0].rampStartedAt = Date.now();
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(/** @type {any} */ (proxy.address()).port)));
  const post = () => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: OPUS, messages: [] }),
  }).then(r => r.status);

  try {
    const statuses = await Promise.all([post(), post()]);
    assert.deepEqual(statuses, [200, 200]);
    assert.equal(seen.filter(t => t === 't-capped').length, 1, `capped served once: ${seen}`);
    assert.equal(seen.filter(t => t === 't-b').length, 1, `b served the queued one: ${seen}`);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// ── A capped family reading ─────────────────────────────────

function staleFleet() {
  // A short staleness floor so a reading can be old enough to revalidate.
  return new AccountManager([
    oauth('plain'),
    oauth('capped', { maxUsage: { unified7dFable: 0.7 }, switchThreshold: { unified7dFable: 0.7 } }),
  ], 0.98, { familyStaleMs: 60_000 });
}

test('a family reading at the cap outlives the staleness floor until its reset', () => {
  const am = staleFleet();
  const [plain, capped] = am.accounts;
  const seen = Date.now() - 10 * 60_000;
  Object.assign(plain.quota, { unified7dFable: 0.99, unified7dFableReset: Date.now() + 48 * H, unified7dFableSeenAt: seen });
  Object.assign(capped.quota, { unified7dFable: 0.72, unified7dFableReset: Date.now() + 48 * H, unified7dFableSeenAt: seen });

  am.sweepExpiredQuotas();

  // The uncapped spent reading is revalidated as before (#167)…
  assert.equal(plain.quota.unified7dFable, null);
  // …the capped one is the operator's decision and stays until the window resets.
  assert.equal(capped.quota.unified7dFable, 0.72);
  assert.equal(am.capExceeded(capped, FABLE), 'unified7dFable');
});

test('with no reset known, a capped family reading is held for one weekly window', () => {
  const am = staleFleet();
  const capped = am.accounts[1];
  Object.assign(capped.quota, { unified7dFable: 0.72, unified7dFableReset: null, unified7dFableSeenAt: Date.now() - 6 * 24 * H });
  am.sweepExpiredQuotas();
  assert.equal(capped.quota.unified7dFable, 0.72, 'six days old: still held');

  capped.quota.unified7dFableSeenAt = Date.now() - 8 * 24 * H;
  am.sweepExpiredQuotas();
  assert.equal(capped.quota.unified7dFable, null, 'past a week: revalidated');
});

// ── The advisor's family cap ────────────────────────────────

test("the exhausted-fleet probe skips an account at the advisor's family cap", () => {
  const am = new AccountManager([
    oauth('a'),
    oauth('capped', { maxUsage: { unified7dFable: 0.7 } }),
  ], 0.98);
  const [a, capped] = am.accounts;
  // Every account past the switch threshold, so only the probe can answer;
  // `capped` is the less utilized and would be probed first.
  Object.assign(a.quota, { unified7d: 0.995, unified7dReset: Date.now() + 48 * H });
  Object.assign(capped.quota, { unified7d: 0.99, unified7dReset: Date.now() + 48 * H, unified7dFable: 0.8, unified7dFableReset: Date.now() + 48 * H });

  assert.equal(am._selectProbe(null, OPUS)?.name, 'capped', 'precondition: without an advisor it is the probe');
  am._nextProbeAt = 0;
  assert.equal(am._selectProbe(null, OPUS, FABLE)?.name, 'a');
});

test("capBars names the advisor's family cap, except under advisorEligibility prefer", () => {
  const caps = { maxUsage: { unified7dFable: 0.7 } };
  const strict = new AccountManager([oauth('capped', caps)], 0.98);
  Object.assign(strict.accounts[0].quota, { unified7dFable: 0.8 });
  assert.equal(strict.capBars(strict.accounts[0], OPUS), null);
  assert.equal(strict.capBars(strict.accounts[0], OPUS, FABLE), 'unified7dFable');

  const prefer = new AccountManager([oauth('capped', caps)], 0.98, { advisorEligibility: 'prefer' });
  Object.assign(prefer.accounts[0].quota, { unified7dFable: 0.8 });
  assert.equal(prefer.capBars(prefer.accounts[0], OPUS, FABLE), null);
  // The executor's own caps bind either way.
  assert.equal(prefer.capBars(prefer.accounts[0], FABLE), 'unified7dFable');
});

// ── Expiry pressure under a cap ─────────────────────────────

test('expiry pressure is the room under the cap, not under 100%', () => {
  const am = new AccountManager([oauth('plain'), oauth('capped', { maxUsage: 0.7 })], 0.98,
    { expiryRouting: { enabled: true } });
  const [plain, capped] = am.accounts;
  const now = Date.now();
  const reset = now + 24 * H;
  for (const acc of [plain, capped]) Object.assign(acc.quota, { unified7d: 0.6, unified7dReset: reset });

  const seconds = (reset - now) / 1000;
  const near = (/** @type {number|null} */ actual, /** @type {number} */ expected) =>
    assert.ok(actual != null && Math.abs(actual - expected) <= expected * 1e-9, `${actual} is not ${expected}`);
  // Uncapped: unchanged, 1 − utilization.
  near(am._expiryPressure(plain, OPUS, now), 0.4 / seconds);
  // Capped at 0.7: only 0.1 is spendable.
  near(am._expiryPressure(capped, OPUS, now), 0.1 / seconds);

  // At or past the cap the room is zero, not negative.
  capped.quota.unified7d = 0.75;
  assert.equal(am._expiryPressure(capped, OPUS, now), 0);
});

test("a family window's room is also bounded by the shared weekly cap", () => {
  const am = new AccountManager([oauth('capped', { maxUsage: { unified7d: 0.7 } })], 0.98,
    { expiryRouting: { enabled: true } });
  const capped = am.accounts[0];
  const now = Date.now();
  const reset = now + 24 * H;
  // Fable has plenty of its own window left, but Fable spend meters into the
  // shared weekly too, and that one has only 0.05 left under its cap.
  Object.assign(capped.quota, {
    unified7d: 0.65, unified7dReset: reset,
    unified7dFable: 0.2, unified7dFableReset: reset,
  });
  const p = am._expiryPressure(capped, FABLE, now);
  const expected = 0.05 / ((reset - now) / 1000);
  assert.ok(p != null && Math.abs(p - expected) <= expected * 1e-9, `${p} is not ${expected}`);
});

// ── maxBurnBoost reaches the score ──────────────────────────

test('the configured maxBurnBoost is the one the adaptive score uses', () => {
  const build = (/** @type {Record<string, any>} */ adaptive) => {
    const am = new AccountManager([oauth('fresh'), oauth('spent')], 0.98, { distributeSessions: 'adaptive', adaptive });
    Object.assign(am.accounts[0].quota, { unified7d: 0.1, unified7dReset: Date.now() + 72 * H });
    Object.assign(am.accounts[1].quota, { unified7d: 0.8, unified7dReset: Date.now() + 72 * H });
    for (const a of am.accounts) a.probing = false;
    return am.adaptiveStats();
  };
  const score = (/** @type {any[]} */ rows, /** @type {string} */ name) => rows.find(r => r.name === name).score;

  // Default boost (4): the account with less left is boosted well above the other.
  const byDefault = build({});
  assert.ok(score(byDefault, 'spent') > 2 * score(byDefault, 'fresh'));
  // A boost of 1 turns burn-down off, and both far-from-the-wall accounts score alike.
  const flat = build({ maxBurnBoost: 1 });
  assert.equal(score(flat, 'spent'), score(flat, 'fresh'));
});
