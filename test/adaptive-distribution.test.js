import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, distributionMode } from '../src/account-manager.js';
import { BurnRateLearner, ConcurrencyLearner, scoreCandidate, validateAdaptiveConfig, ADAPTIVE_DEFAULTS } from '../src/adaptive-distribution.js';

const H = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function mgr(names, opts = {}, threshold = 0.98) {
  return new AccountManager(names.map(n => oauth(n)), threshold, { distributeSessions: 'adaptive', ...opts });
}

// Put an account's shared weekly bucket at `used`, resetting `hours` from now.
function weekly(am, index, used, hours = 72) {
  const q = am.accounts[index].quota;
  q.unified7d = used;
  q.unified7dReset = Date.now() + hours * H;
  am.accounts[index].probing = false;
}

// Route `n` fresh sessions and report how many each account received.
function placeSessions(am, n, model = null) {
  const counts = {};
  for (let i = 0; i < n; i++) {
    const sid = `s-${Math.random()}-${i}`;
    const acc = am.getActiveAccount(null, model, null, sid);
    if (!acc) continue;
    am.recordSession(sid, acc.index, model);
    counts[acc.name] = (counts[acc.name] || 0) + 1;
  }
  return counts;
}

// ── Mode plumbing ───────────────────────────────────────────────────────────

test('distributionMode maps the setting without breaking the boolean forms', () => {
  assert.equal(distributionMode(undefined), 'off');
  assert.equal(distributionMode(false), 'off');
  assert.equal(distributionMode(true), 'even');
  assert.equal(distributionMode('adaptive'), 'adaptive');
  for (const value of ['off', 'false', 'no', '0', ' OFF ']) {
    assert.equal(distributionMode(value), 'off');
  }
  // A typo means "distribute", not "stop distributing".
  assert.equal(distributionMode('addaptive'), 'even');
});

test('adaptive mode reports itself and still counts as distributing', () => {
  const am = mgr(['a', 'b']);
  assert.equal(am.distributionMode, 'adaptive');
  assert.equal(am.distributeSessions, true);
  assert.equal(am.sessionStats().mode, 'adaptive');
  assert.equal(am.getStatus().sessions.mode, 'adaptive');
});

test('switching between even and adaptive does not drain', () => {
  const am = mgr(['a', 'b'], { distributeSessions: true });
  const first = am.getActiveAccount(null, null, null, 's1');
  am.recordSession('s1', first.index);
  am.setDistributeSessions('adaptive');
  assert.equal(am.distributionMode, 'adaptive');
  // No drain: both modes keep a session pinned, so nothing loses its cache.
  assert.equal(am.drainingCount(), 0);
  assert.equal(am.getActiveAccount(null, null, null, 's1').index, first.index);
});

test('turning adaptive off still drains, exactly as even mode does', () => {
  const am = mgr(['a', 'b']);
  const first = am.getActiveAccount(null, null, null, 's1');
  am.recordSession('s1', first.index);
  am.setDistributeSessions(false);
  assert.equal(am.distributionMode, 'off');
  assert.equal(am.drainingCount(), 1);
});

// ── Scenario 1: burn the least-remaining window down first ──────────────────

test('scenario: new sessions concentrate on the account with the least left', () => {
  const am = mgr(['fresh', 'half', 'nearly-spent']);
  weekly(am, 0, 0.10);
  weekly(am, 1, 0.50);
  weekly(am, 2, 0.85); // least remaining, but still well clear of 0.98

  const counts = placeSessions(am, 12);
  // The nearly-spent account should take the clear majority: finishing its
  // window is the whole point, versus leaving three accounts part-spent.
  assert.ok((counts['nearly-spent'] || 0) > (counts['fresh'] || 0),
    `expected nearly-spent to lead, got ${JSON.stringify(counts)}`);
  assert.ok((counts['nearly-spent'] || 0) >= 5,
    `expected a real concentration, got ${JSON.stringify(counts)}`);
});

test('scenario: the freshest account is the least preferred of the tier', () => {
  const am = mgr(['fresh', 'used']);
  weekly(am, 0, 0.05);
  weekly(am, 1, 0.70);
  const counts = placeSessions(am, 8);
  assert.ok((counts['used'] || 0) > (counts['fresh'] || 0),
    `expected 'used' to lead, got ${JSON.stringify(counts)}`);
});

// ── Scenario 2: taper — spend down to the wall, never into it ───────────────

test('scenario: an account inside its reserve yields to a fresher sibling', () => {
  const am = mgr(['at-the-wall', 'roomy']);
  weekly(am, 0, 0.975); // 0.5% from the 0.98 threshold — inside any reserve
  weekly(am, 1, 0.60);
  const counts = placeSessions(am, 10);
  assert.ok((counts['roomy'] || 0) > (counts['at-the-wall'] || 0),
    `taper should hand the share back near the wall, got ${JSON.stringify(counts)}`);
});

test('scenario: the taper is a ramp, not a cliff — preference peaks then falls', () => {
  // Same fleet, walking one account from comfortable to nearly spent. Its share
  // should rise (burn-down) and then fall (taper), rather than only ever rising.
  const shares = [];
  for (const used of [0.30, 0.60, 0.80, 0.90, 0.96, 0.979]) {
    const am = mgr(['probe', 'ref']);
    weekly(am, 0, used);
    weekly(am, 1, 0.30);
    const row = am.adaptiveStats().find(r => r.name === 'probe');
    shares.push(row.weight);
  }
  const peak = Math.max(...shares);
  const peakAt = shares.indexOf(peak);
  assert.ok(peakAt > 0, `share should rise before it falls, got ${JSON.stringify(shares)}`);
  assert.ok(shares[shares.length - 1] < peak,
    `share must fall back near the wall, got ${JSON.stringify(shares)}`);
});

// ── Scenario 3: the operator's own switchThreshold governs the taper ────────

test('scenario: a custom scalar switchThreshold moves the wall', () => {
  // With the threshold at 0.80, an account at 0.79 is AT the wall even though
  // it is nowhere near 0.98. The taper must be measured against the configured
  // value, not the default.
  const am = mgr(['tight', 'roomy'], {}, 0.80);
  weekly(am, 0, 0.79);
  weekly(am, 1, 0.40);
  const rows = am.adaptiveStats();
  const tight = rows.find(r => r.name === 'tight');
  assert.equal(tight.threshold, 0.80);
  assert.ok(Math.abs(tight.headroom - 0.01) < 1e-9, `headroom is to the threshold: ${tight.headroom}`);
  const counts = placeSessions(am, 8);
  assert.ok((counts['roomy'] || 0) > (counts['tight'] || 0),
    `0.80 threshold should protect 'tight', got ${JSON.stringify(counts)}`);
});

test('scenario: a per-bucket switchThreshold applies the weekly value', () => {
  // { default: 0.98, unified7d: 0.85 } — the weekly bucket rotates out at 0.85.
  const am = new AccountManager(
    [oauth('a'), oauth('b')],
    { default: 0.98, unified7d: 0.85 },
    { distributeSessions: 'adaptive' },
  );
  weekly(am, 0, 0.84);
  weekly(am, 1, 0.40);
  const rows = am.adaptiveStats();
  assert.equal(rows.find(r => r.name === 'a').threshold, 0.85);
  const counts = placeSessions(am, 8);
  assert.ok((counts.b || 0) > (counts.a || 0),
    `the 0.85 weekly threshold should protect 'a', got ${JSON.stringify(counts)}`);
});

test('scenario: raising the threshold lets an account be spent further', () => {
  // The same 0.90-utilization account is protected under a 0.92 threshold and
  // freely spent under a 0.99 one. Same fleet, same load, only the config moves.
  const shareAt = (threshold) => {
    const am = mgr(['probe', 'ref'], {}, threshold);
    weekly(am, 0, 0.90);
    weekly(am, 1, 0.50);
    return am.adaptiveStats().find(r => r.name === 'probe').weight;
  };
  assert.ok(shareAt(0.99) > shareAt(0.92),
    'a higher threshold must leave more room to burn the account down');
});

// ── Scenario 4: authoritative subscription tiers ───────────────────────────

test('quota updates feed only the windows refreshed by that response', () => {
  const am = mgr(['a']);
  const observed = [];
  am.burnRateLearner.observeUtilization = (_index, bucket) => observed.push(bucket);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-7d-utilization': '0.10',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.20',
  });
  assert.deepEqual(observed, ['unified7d', 'unified7dFable']);
  observed.length = 0;
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.11' });
  assert.deepEqual(observed, ['unified7d']);
});

test('scenario: a big plan outranks a small one at the same percentage', () => {
  // Both accounts sit at 60%. The Pro account has far less absolute credit
  // behind that 60%, so it is the one to finish off first.
  const am = new AccountManager([
    oauth('pro', { rateLimitTier: 'default_claude_ai' }),
    oauth('max20x', { rateLimitTier: 'default_claude_max_20x' }),
  ], 0.98, { distributeSessions: 'adaptive' });
  weekly(am, 0, 0.60);
  weekly(am, 1, 0.60);
  const counts = placeSessions(am, 10);
  assert.ok((counts.pro || 0) > (counts.max20x || 0),
    `the smaller plan should be finished first, got ${JSON.stringify(counts)}`);
});

test('scenario: an unknown profile tier falls back to fractions rather than guessing', () => {
  const am = new AccountManager([
    oauth('known', { rateLimitTier: 'default_claude_max_20x' }),
    oauth('unknown', { rateLimitTier: 'future_tier' }),
  ], 0.98, { distributeSessions: 'adaptive' });
  weekly(am, 0, 0.20);
  weekly(am, 1, 0.80);
  const rows = am.adaptiveStats();
  // Fraction fallback ⇒ the more-spent account still leads on remaining credit.
  assert.ok(rows.find(r => r.name === 'unknown').weight > rows.find(r => r.name === 'known').weight);
});

// ── Scenario 5: response speed ──────────────────────────────────────────────

test('scenario: a congested account sheds share to an idle sibling', () => {
  const am = mgr(['busy', 'idle']);
  weekly(am, 0, 0.80); // busy is the better burn-down target on quota alone
  weekly(am, 1, 0.30);
  // Bury 'busy' under in-flight work well past its learned concurrency cap.
  am.accounts[0].inFlight = 40;
  const rows = am.adaptiveStats();
  assert.ok(rows.find(r => r.name === 'idle').weight > rows.find(r => r.name === 'busy').weight,
    'congestion must outweigh the burn-down preference');
});

test('scenario: quota preference still wins while the account keeps up', () => {
  const am = mgr(['busy', 'idle']);
  weekly(am, 0, 0.80);
  weekly(am, 1, 0.30);
  am.accounts[0].inFlight = 1; // comfortably inside the cap
  const rows = am.adaptiveStats();
  assert.ok(rows.find(r => r.name === 'busy').weight > rows.find(r => r.name === 'idle').weight,
    'a lightly loaded account should still be burned down first');
});

test('scenario: the concurrency cap backs off on a throttle and creeps back up', () => {
  const c = new ConcurrencyLearner();
  const start = c.cap(0);
  c.noteThrottled(0, 8);
  const backedOff = c.cap(0);
  assert.ok(backedOff < 8, `should retreat below the throttling load: ${backedOff}`);
  for (let i = 0; i < 200; i++) c.noteSuccess(0, Math.ceil(c.cap(0)));
  assert.ok(c.cap(0) > backedOff, 'sustained success should recover the cap');
  assert.ok(start > 0);
});

test('scenario: success below the cap teaches nothing', () => {
  const c = new ConcurrencyLearner();
  const before = c.cap(0);
  c.noteSuccess(0, 1); // one request finishing while six are allowed proves nothing
  assert.equal(c.cap(0), before);
});

test('a 429 pause feeds the depth the account was actually running at', () => {
  // Throttled at a depth INSIDE the current estimate: the estimate was too
  // optimistic and must come down.
  const am = mgr(['a', 'b']);
  am.accounts[0].inFlight = 4;
  const before = am.concurrencyLearner.cap(0);
  assert.ok(before > 4, 'fixture assumes the default cap is above the test load');
  am.pauseAccount(0, 5);
  assert.ok(am.concurrencyLearner.cap(0) < before,
    `a throttle within the cap must lower it: ${before} -> ${am.concurrencyLearner.cap(0)}`);
});

test('a throttle above the current cap leaves the more conservative estimate alone', () => {
  // The ramp admits above the cap during a switch window, so the throttling
  // depth can exceed it. That says the safe level is below 10 — which a cap of
  // 6 already satisfies — so it is not evidence to raise it toward 10.
  const am = mgr(['a', 'b']);
  am.accounts[0].inFlight = 10;
  const before = am.concurrencyLearner.cap(0);
  am.pauseAccount(0, 5);
  assert.ok(am.concurrencyLearner.cap(0) <= before,
    'a throttle must never raise the cap');
});

test('a released 429 still backs off using the admitted depth', async () => {
  const am = mgr(['a']);
  const before = am.concurrencyLearner.cap(0);
  assert.equal(await am.admit(0), true);
  const admittedLoad = am.release(0, { successful: false });
  am.pauseAccount(0, 5, admittedLoad);
  assert.equal(admittedLoad, 1);
  assert.ok(am.concurrencyLearner.cap(0) < before,
    'the release before status handling must not erase the throttled depth');
});

// ── Invariants that must survive the new mode ───────────────────────────────

test('adaptive still pins an existing session to its account', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.10);
  weekly(am, 1, 0.90);
  const first = am.getActiveAccount(null, null, null, 's1');
  am.recordSession('s1', first.index);
  // Even though the other account is the better burn-down target, a session
  // that already has a cache somewhere stays there.
  for (let i = 0; i < 5; i++) {
    assert.equal(am.getActiveAccount(null, null, null, 's1').index, first.index);
  }
});

test('adaptive never routes across a priority tier', () => {
  const am = new AccountManager([
    oauth('primary', { priority: 0 }),
    oauth('backup', { priority: 1 }),
  ], 0.98, { distributeSessions: 'adaptive' });
  weekly(am, 0, 0.90); // the low-priority account looks far better on quota
  weekly(am, 1, 0.05);
  const counts = placeSessions(am, 6);
  assert.equal(counts.backup, undefined, `priority must be absolute, got ${JSON.stringify(counts)}`);
});

test('adaptive skips an unavailable account entirely', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.999); // past the threshold — out of rotation
  weekly(am, 1, 0.20);
  const counts = placeSessions(am, 5);
  assert.equal(counts.a, undefined);
  assert.equal(counts.b, 5);
});

test('adaptive keeps the family buckets independent', () => {
  const am = mgr(['a', 'b']);
  const now = Date.now();
  for (const i of [0, 1]) am.accounts[i].probing = false;
  // A Fable request must be scored on the Fable bucket, not the shared one.
  //
  // The numbers respect #175: a family bucket does NOT stand alone, because
  // family spend meters into the shared weekly too, so the gating utilization
  // is the HIGHER of the two. A fixture that put 'a' at 0.80 shared and 0.10
  // Fable would therefore gate Fable at 0.80 on 'a' as well, and the two
  // accounts would tie rather than demonstrating anything. So the shared
  // weekly is kept below each account's Fable figure, leaving the family
  // bucket as the value that actually governs a Fable request.
  am.accounts[0].quota.unified7d = 0.60;   // Opus gates at 0.60, Fable at 0.60
  am.accounts[0].quota.unified7dReset = now + 72 * H;
  am.accounts[0].quota.unified7dFable = 0.10;
  am.accounts[0].quota.unified7dFableReset = now + 72 * H;
  am.accounts[1].quota.unified7d = 0.20;   // Opus gates at 0.20, Fable at 0.70
  am.accounts[1].quota.unified7dReset = now + 72 * H;
  am.accounts[1].quota.unified7dFable = 0.70;
  am.accounts[1].quota.unified7dFableReset = now + 72 * H;

  const opus = placeSessions(am, 6, OPUS);
  assert.ok((opus.a || 0) > (opus.b || 0), `Opus should burn 'a' down: ${JSON.stringify(opus)}`);
  const am2 = mgr(['a', 'b']);
  for (const i of [0, 1]) am2.accounts[i].probing = false;
  Object.assign(am2.accounts[0].quota, am.accounts[0].quota);
  Object.assign(am2.accounts[1].quota, am.accounts[1].quota);
  const fable = placeSessions(am2, 6, FABLE);
  assert.ok((fable.b || 0) > (fable.a || 0), `Fable should burn 'b' down: ${JSON.stringify(fable)}`);
});

test('adaptive reserve follows the quota window supplying utilization', () => {
  const am = new AccountManager([
    oauth('a', { rateLimitTier: 'default_claude_ai' }),
    oauth('b', { rateLimitTier: 'default_claude_ai' }),
  ], 0.98, { distributeSessions: 'adaptive' });
  const now = Date.now();
  for (const i of [0, 1]) am.accounts[i].probing = false;
  Object.assign(am.accounts[0].quota, {
    unified7d: 0.80, unified7dReset: now + 72 * H,
    unified7dFable: 0.10, unified7dFableReset: now + 72 * H,
  });
  Object.assign(am.accounts[1].quota, {
    unified7d: 0.30, unified7dReset: now + 72 * H,
    unified7dFable: 0.20, unified7dFableReset: now + 72 * H,
  });
  am.burnRateLearner.reserve = (_index, bucket) => bucket === 'unified7d' ? 0.03 : 0.19;
  const row = am.adaptiveStats(FABLE).find(r => r.name === 'a');
  assert.equal(row.window, 'unified7d');
  assert.equal(row.reserve, 0.03);
  assert.equal(row.planWeight, 1);
});

test('removing an account keeps adaptive learning with surviving credentials', () => {
  const am = mgr(['a', 'b', 'c']);
  const t0 = Date.now();
  am.burnRateLearner.observeUtilization(1, 'unified7d', 0.10, t0);
  am.burnRateLearner.observeUtilization(1, 'unified7d', 0.11, t0 + 5 * 60_000);
  am.burnRateLearner.observeUtilization(2, 'unified7d', 0.10, t0);
  am.burnRateLearner.observeUtilization(2, 'unified7d', 0.20, t0 + 5 * 60_000);
  am.concurrencyLearner.caps.set(1, 3);
  am.concurrencyLearner.caps.set(2, 9);
  const bReserve = am.burnRateLearner.reserve(1, 'unified7d');
  const cReserve = am.burnRateLearner.reserve(2, 'unified7d');

  am.removeAccount(0);

  assert.equal(am.accounts[0].name, 'b');
  assert.equal(am.burnRateLearner.reserve(0, 'unified7d'), bReserve);
  assert.equal(am.burnRateLearner.reserve(1, 'unified7d'), cReserve);
  assert.equal(am.concurrencyLearner.cap(0), 3);
  assert.equal(am.concurrencyLearner.cap(1), 9);
});

test('an unknown utilization is not mistaken for a spent window', () => {
  // Nothing is known about 'unknown'. Treating null as "most spent" would send
  // every cold-start session to whichever account happens to be unmeasured.
  const am = mgr(['unknown', 'known']);
  am.accounts[0].probing = false;
  weekly(am, 1, 0.85);
  const rows = am.adaptiveStats();
  assert.ok(rows.find(r => r.name === 'known').weight > rows.find(r => r.name === 'unknown').weight);
});

test('a single-account tier is returned without scoring', () => {
  const am = mgr(['solo']);
  weekly(am, 0, 0.975); // deep inside its reserve, but it is all there is
  const acc = am.getActiveAccount(null, null, null, 's1');
  assert.equal(acc.name, 'solo');
});

test('a tier entirely inside its reserve still serves requests', () => {
  // Every candidate scores zero. That is not a reason to 429 — the switch
  // threshold is what takes an account out, and none of these has crossed it.
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.9795);
  weekly(am, 1, 0.9790);
  const acc = am.getActiveAccount(null, null, null, 's1');
  assert.ok(acc, 'must fall through to the even walk rather than refuse');
});

// ── The status readout ──────────────────────────────────────────────────────

test('adaptiveStats is empty unless adaptive is the active mode', () => {
  assert.deepEqual(mgr(['a', 'b'], { distributeSessions: true }).adaptiveStats(), []);
  assert.deepEqual(mgr(['a', 'b'], { distributeSessions: false }).adaptiveStats(), []);
  assert.equal(mgr(['a', 'b']).adaptiveStats().length, 2);
});

test('adaptiveStats reports the per-account figures an operator gates on', () => {
  const am = new AccountManager([
    oauth('a', { rateLimitTier: 'default_claude_max_20x' }),
    oauth('b', { rateLimitTier: 'default_claude_ai' }),
  ], 0.98, { distributeSessions: 'adaptive' });
  weekly(am, 0, 0.70);
  weekly(am, 1, 0.30);
  am.recordSession('s1', 0);
  const rows = am.adaptiveStats();
  const a = rows.find(r => r.name === 'a');
  assert.equal(a.sessions, 1, 'per-account session count is reported');
  assert.equal(a.competing, true);
  assert.equal(a.planWeight, 20, 'profile plan tier is reported');
  assert.ok(a.concCap > 0);
  assert.ok(Math.abs(a.headroom - (0.98 - 0.70)) < 1e-9);
  // Weights across the competing tier are normalized.
  const total = rows.filter(r => r.competing).reduce((n, r) => n + r.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights should sum to 1, got ${total}`);
});

test('adaptiveStats uses the same expiry-routing candidate band as selection', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.40);
  weekly(am, 1, 0.60);
  am._bandedCandidates = () => [am.accounts[1]];
  const rows = am.adaptiveStats();
  assert.equal(rows.find(r => r.name === 'a').competing, false);
  assert.equal(rows.find(r => r.name === 'b').competing, true);
  assert.equal(rows.find(r => r.name === 'b').next, true);
});

test('adaptiveStats distinguishes score weight from the deterministic next target', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.70);
  weekly(am, 1, 0.30);
  const rows = am.adaptiveStats();
  const nextRows = rows.filter(r => r.next);
  assert.equal(nextRows.length, 1);
  assert.equal(nextRows[0].name, am.getActiveAccount(null, null, null, 'new-session').name);
  assert.ok(rows.every(r => r.weight == null || (r.weight >= 0 && r.weight <= 1)));
});

test('an unknown profile tier is reported without inventing a plan weight', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.50);
  weekly(am, 1, 0.50);
  const row = am.adaptiveStats().find(r => r.name === 'a');
  assert.equal(row.planWeight, null);
});

test('adaptiveStats excludes subscriptions owned by another provider', () => {
  const am = new AccountManager([
    oauth('claude', { rateLimitTier: 'default_claude_ai' }),
    oauth('codex', { provider: 'codex', rateLimitTier: 'default_claude_max_20x' }),
  ], 0.98, { distributeSessions: 'adaptive' });
  weekly(am, 0, 0.4);
  weekly(am, 1, 0.8);
  const rows = am.adaptiveStats(null, 'anthropic');
  assert.equal(rows.find(r => r.name === 'claude').competing, true);
  assert.equal(rows.find(r => r.name === 'claude').weight, 1);
  assert.equal(rows.find(r => r.name === 'codex').competing, false);
  assert.equal(rows.find(r => r.name === 'codex').weight, 0);
});

test('an outranked account is marked as not competing, not as a small share', () => {
  const am = new AccountManager([
    oauth('primary', { priority: 0 }),
    oauth('backup', { priority: 1 }),
  ], 0.98, { distributeSessions: 'adaptive' });
  weekly(am, 0, 0.50);
  weekly(am, 1, 0.50);
  const backup = am.adaptiveStats().find(r => r.name === 'backup');
  assert.equal(backup.competing, false);
  assert.equal(backup.weight, 0);
});

// ── The scoring function itself ─────────────────────────────────────────────

test('scoreCandidate: the taper reaches zero exactly at the threshold', () => {
  const base = { threshold: 0.98, capacity: null, reserve: 0.05, load: 0, concCap: 6, maxRemaining: 0.5 };
  assert.equal(scoreCandidate({ ...base, utilization: 0.98 }).score, 0);
  assert.equal(scoreCandidate({ ...base, utilization: 0.99 }).score, 0);
  assert.ok(scoreCandidate({ ...base, utilization: 0.90 }).score > 0);
});

test('scoreCandidate: the burn boost is capped so the taper can overpower it', () => {
  // Without the cap, 1/remaining grows as fast as the taper shrinks and the two
  // cancel, leaving no protection at the wall at all.
  const near = scoreCandidate({
    utilization: 0.9799, threshold: 0.98, capacity: null,
    reserve: 0.05, load: 0, concCap: 6, maxRemaining: 0.5,
  });
  assert.ok(near.burn <= ADAPTIVE_DEFAULTS.maxBurnBoost);
  assert.ok(near.score < 0.01, `share at the wall must collapse, got ${near.score}`);
});

test('scoreCandidate: load reduces the score monotonically', () => {
  const at = (load) => scoreCandidate({
    utilization: 0.5, threshold: 0.98, capacity: null,
    reserve: 0.05, load, concCap: 4, maxRemaining: 0.5,
  }).score;
  assert.ok(at(0) > at(2));
  assert.ok(at(2) > at(10));
  assert.ok(at(10) > 0, 'load throttles the share but never bans the account');
});

test('the reserve widens with the observed burn rate', () => {
  const l = new BurnRateLearner();
  const t0 = Date.now();
  // A fast burner: 4% of the window in five minutes.
  l.observeUtilization(0, 'unified7d', 0.10, t0);
  l.observeUtilization(0, 'unified7d', 0.14, t0 + 5 * 60_000);
  const fast = l.reserve(0, 'unified7d');
  // A slow one: 0.1% over the same five minutes.
  l.observeUtilization(1, 'unified7d', 0.10, t0);
  l.observeUtilization(1, 'unified7d', 0.101, t0 + 5 * 60_000);
  const slow = l.reserve(1, 'unified7d');
  assert.ok(fast > slow, `fast burner needs the wider margin: ${fast} vs ${slow}`);
  assert.ok(fast <= ADAPTIVE_DEFAULTS.maxReserve && slow >= ADAPTIVE_DEFAULTS.minReserve);
});

// ── End-to-end: the shape the whole thing exists to produce ─────────────────

test('scenario: a week of drift ends with windows finished, not fragmented', () => {
  // Four same-tier accounts at staggered utilization. Placing many sessions
  // should pull the leaders UP toward the threshold rather than lifting all
  // four together — that is the difference from even distribution.
  const am = mgr(['a', 'b', 'c', 'd']);
  weekly(am, 0, 0.20);
  weekly(am, 1, 0.45);
  weekly(am, 2, 0.70);
  weekly(am, 3, 0.88);
  const counts = placeSessions(am, 20);
  const ordered = ['d', 'c', 'b', 'a'].map(n => counts[n] || 0);
  // The two most-spent accounts should together take more than the two freshest.
  assert.ok(ordered[0] + ordered[1] > ordered[2] + ordered[3],
    `expected concentration on the spent end, got ${JSON.stringify(counts)}`);
});

test('scenario: even mode is unchanged by the presence of adaptive', () => {
  // The original behaviour must be bit-for-bit what it was: one session each.
  const am = mgr(['a', 'b', 'c'], { distributeSessions: true });
  weekly(am, 0, 0.20);
  weekly(am, 1, 0.45);
  weekly(am, 2, 0.88);
  const counts = placeSessions(am, 3);
  assert.deepEqual(Object.keys(counts).sort(), ['a', 'b', 'c']);
});

// ── Per-family session breakdown ────────────────────────────────────────────

test('sessions are broken down by the weekly bucket they are pinned on', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.20);
  weekly(am, 1, 0.20);
  // Two Opus sessions and one Fable session, all on account 0.
  am.recordSession('s1', 0, OPUS);
  am.recordSession('s2', 0, OPUS);
  am.recordSession('s3', 0, FABLE);
  const stats = am.sessionTracker.stats();
  assert.deepEqual(stats.perAccountBucket[0], { unified7d: 2, unified7dFable: 1 });
  // The per-account total still counts each SESSION once, not each pin.
  assert.equal(stats.perAccount[0], 3);
});

test('a session spanning two families on one account appears in both', () => {
  const am = mgr(['a', 'b']);
  am.recordSession('s1', 0, OPUS);
  am.recordSession('s1', 0, FABLE); // same session, second family, same account
  const stats = am.sessionTracker.stats();
  assert.deepEqual(stats.perAccountBucket[0], { unified7d: 1, unified7dFable: 1 });
  // ...but is one client, so the account's own total is 1.
  assert.equal(stats.perAccount[0], 1);
});

test('a session split across two accounts is counted on each', () => {
  const am = mgr(['a', 'b']);
  am.recordSession('s1', 0, OPUS);
  am.recordSession('s1', 1, FABLE); // Fable diverted to the sibling
  const stats = am.sessionTracker.stats();
  assert.deepEqual(stats.perAccountBucket[0], { unified7d: 1 });
  assert.deepEqual(stats.perAccountBucket[1], { unified7dFable: 1 });
});

test('the breakdown reaches the status payload per account', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.20);
  weekly(am, 1, 0.20);
  am.recordSession('s1', 0, OPUS);
  am.recordSession('s2', 0, FABLE);
  const status = am.getStatus();
  assert.deepEqual(status.accounts[0].sessionsByBucket, { unified7d: 1, unified7dFable: 1 });
  // An account carrying nothing sends null rather than an empty object.
  assert.equal(status.accounts[1].sessionsByBucket, null);
});

test('adaptiveStats names the requested bucket its weights were computed for', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.20);
  weekly(am, 1, 0.20);
  assert.equal(am.adaptiveStats()[0].bucket, 'unified7d');
  assert.equal(am.adaptiveStats(FABLE)[0].bucket, 'unified7dFable');
});

// ── The `teamclaude distribute` command's mode table ────────────────────────

test('every config value the distribute command writes round-trips to its mode', () => {
  // The command and the router must agree about what a setting means. Writing
  // `true` for a mode that reads back as 'adaptive' (or vice versa) would make
  // `teamclaude distribute` unable to express, or silently unable to leave, a
  // mode — which is exactly what the boolean coercion it replaced did.
  const written = { off: false, even: true, adaptive: 'adaptive' };
  for (const [mode, value] of Object.entries(written)) {
    assert.equal(distributionMode(value), mode,
      `writing ${JSON.stringify(value)} must read back as ${mode}`);
  }
});

// ── Burn rate must be a wall-clock rate, not a per-reading one ──────────────

test('concurrent readings do not inflate the burn rate', () => {
  // Observed live: 27 sessions on one account produced a burn rate of 0.157
  // utilization/second — a weekly window drained in six seconds — because each
  // adjacent pair of readings divided a delta caused by many parallel requests
  // by the milliseconds between two responses landing.
  const l = new BurnRateLearner();
  const t0 = Date.now();
  l.observeUtilization(0, 'unified7d', 0.10, t0);
  // 10 minutes of traffic that moves the window 2%, delivered as bursts of
  // readings a few ms apart — the shape high concurrency actually produces.
  let u = 0.10;
  for (let minute = 1; minute <= 10; minute++) {
    for (let i = 0; i < 12; i++) {
      u += 0.02 / 120;
      l.observeUtilization(0, 'unified7d', u, t0 + minute * 60_000 + i * 3);
    }
  }
  const rate = l.burnRate(0, 'unified7d');
  // The truth is 2% over 10 minutes ≈ 3.3e-8 utilization/ms.
  const truth = 0.02 / (10 * 60_000);
  assert.ok(rate < truth * 3,
    `burn rate must track wall-clock, got ${rate} vs truth ${truth}`);
  // And the reserve it implies must stay a sane margin, not the ceiling.
  assert.ok(l.reserve(0, 'unified7d') < ADAPTIVE_DEFAULTS.maxReserve,
    'a modest real burn rate must not pin the reserve at its ceiling');
});

test('a flat reading is a legitimate zero-rate sample, not a discontinuity', () => {
  // An idle account should learn a LOW burn rate — that is what earns it a
  // narrow reserve and lets it run closer to its threshold. Treating a flat
  // reading as a reset would leave it forever on the cold-start assumption.
  const l = new BurnRateLearner();
  const t0 = Date.now();
  l.observeUtilization(0, 'unified7d', 0.50, t0);
  for (let i = 1; i <= 12; i++) l.observeUtilization(0, 'unified7d', 0.50, t0 + i * 60_000);
  assert.equal(l.burnRate(0, 'unified7d'), 0, 'an idle account burns nothing');
  assert.equal(l.reserve(0, 'unified7d'), ADAPTIVE_DEFAULTS.minReserve);
});

test('a genuinely fast burner still earns a wide reserve', () => {
  // The fix must not simply flatten every rate: real sustained spend has to
  // still widen the margin.
  const l = new BurnRateLearner();
  const t0 = Date.now();
  l.observeUtilization(0, 'unified7d', 0.10, t0);
  let u = 0.10;
  for (let i = 1; i <= 12; i++) { // 30% of the window in 12 minutes
    u += 0.30 / 12;
    l.observeUtilization(0, 'unified7d', u, t0 + i * 60_000);
  }
  assert.ok(l.reserve(0, 'unified7d') > ADAPTIVE_DEFAULTS.minReserve * 5,
    `a real fast burner needs a wide margin, got ${l.reserve(0, 'unified7d')}`);
});

test('a window reset does not leak across the burn measurement', () => {
  const l = new BurnRateLearner();
  const t0 = Date.now();
  l.observeUtilization(0, 'unified7d', 0.90, t0);
  l.observeUtilization(0, 'unified7d', 0.95, t0 + 6 * 60_000);
  const before = l.burnRate(0, 'unified7d');
  l.observeUtilization(0, 'unified7d', 0.02, t0 + 7 * 60_000); // weekly rolled
  l.observeUtilization(0, 'unified7d', 0.03, t0 + 13 * 60_000);
  // The roll must not be measured as a huge negative or positive swing.
  assert.ok(l.burnRate(0, 'unified7d') >= 0 && l.burnRate(0, 'unified7d') < before * 2,
    'the reset must reopen the window rather than be measured across');
});

// ── The config block is checked before anything scores on it ────────────────
//
// Nothing downstream throws on a bad number: a NaN alpha makes every score NaN,
// the adaptive picker returns null, and the even walk takes over in silence.
// So the block is refused at startup, naming the field.

test('validateAdaptiveConfig accepts nothing, an empty block, and in-range overrides', () => {
  assert.deepEqual(validateAdaptiveConfig(undefined), {});
  assert.deepEqual(validateAdaptiveConfig(null), {});
  assert.deepEqual(validateAdaptiveConfig({}), {});
  assert.deepEqual(validateAdaptiveConfig({ burnWindowMs: 60_000, burnAlpha: 1, minReserve: 0, maxReserve: 0.5 }),
    { burnWindowMs: 60_000, burnAlpha: 1, minReserve: 0, maxReserve: 0.5 });
  // Every default passes its own checks.
  assert.deepEqual(validateAdaptiveConfig({ ...ADAPTIVE_DEFAULTS }), { ...ADAPTIVE_DEFAULTS });
});

test('validateAdaptiveConfig rejects NaN, zero, non-numeric and out-of-range values by name', () => {
  const rejects = (block, field) => {
    assert.throws(() => validateAdaptiveConfig(block), err => err.message.includes(`adaptiveDistribution.${field}`),
      `${JSON.stringify(block)} should be refused naming ${field}`);
  };
  rejects({ burnAlpha: NaN }, 'burnAlpha');
  rejects({ burnAlpha: Infinity }, 'burnAlpha');
  rejects({ burnAlpha: 0 }, 'burnAlpha');
  rejects({ burnAlpha: 1.5 }, 'burnAlpha');
  rejects({ burnAlpha: '0.3' }, 'burnAlpha');
  rejects({ burnWindowMs: 0 }, 'burnWindowMs');
  rejects({ burnWindowMs: -1 }, 'burnWindowMs');
  rejects({ lookaheadMs: null }, 'lookaheadMs');
  rejects({ maxSampleAgeMs: true }, 'maxSampleAgeMs');
  rejects({ concBackoff: 0 }, 'concBackoff');
  rejects({ concBackoffTo: 2 }, 'concBackoffTo');
  rejects({ concGrowth: -0.1 }, 'concGrowth');
  rejects({ minReserve: -0.1 }, 'minReserve');
  rejects({ maxReserve: 1.1 }, 'maxReserve');
  // A pair is compared on the merged view, so one side left at its default
  // still catches the other.
  rejects({ minReserve: 0.5 }, 'minReserve');            // above the default maxReserve
  rejects({ maxReserve: 0.001 }, 'minReserve');          // below the default minReserve
  rejects({ initialBurnRate: -1 }, 'initialBurnRate');
  rejects({ minConcCap: 0 }, 'minConcCap');
  rejects({ minConcCap: 100 }, 'minConcCap');            // above the default maxConcCap
  rejects({ initialConcCap: 0.5 }, 'initialConcCap');    // below the default minConcCap
  rejects({ maxConcCap: 2 }, 'initialConcCap');          // the default initial cap no longer fits
  rejects({ maxBurnBoost: 0.5 }, 'maxBurnBoost');
  // A typo in the field name is the same silent failure in a different coat.
  rejects({ burnAlfa: 0.3 }, 'burnAlfa');
  assert.throws(() => validateAdaptiveConfig('adaptive'), /must be an object/);
  assert.throws(() => validateAdaptiveConfig([0.3]), /must be an object/);
});

test('a bad adaptive value names itself and its value in the message', () => {
  assert.throws(() => validateAdaptiveConfig({ burnAlpha: 'lots' }), /adaptiveDistribution\.burnAlpha must be a finite number, got "lots"/);
  assert.throws(() => validateAdaptiveConfig({ burnWindowMs: 0 }), /adaptiveDistribution\.burnWindowMs must be > 0, got 0/);
});
