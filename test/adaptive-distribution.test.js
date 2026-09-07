import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, distributionMode } from '../src/account-manager.js';
import { CapacityLearner, ConcurrencyLearner, scoreCandidate, ADAPTIVE_DEFAULTS } from '../src/adaptive-distribution.js';

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

// Teach the capacity learner a window size directly, the way live traffic
// would: spend `tokens`, then report the utilization those tokens moved.
function teachCapacity(am, index, bucket, tokens, deltaU, base = 0) {
  const t0 = Date.now();
  am.capacityLearner.observeUtilization(index, bucket, base, t0);
  am.capacityLearner.recordTokens(index, bucket, { input_tokens: tokens, output_tokens: 0 });
  am.capacityLearner.observeUtilization(index, bucket, base + deltaU, t0 + 60_000);
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
    shares.push(row.share);
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
    return am.adaptiveStats().find(r => r.name === 'probe').share;
  };
  assert.ok(shareAt(0.99) > shareAt(0.92),
    'a higher threshold must leave more room to burn the account down');
});

// ── Scenario 4: plan tier, learned rather than configured ───────────────────

test('scenario: the learner recovers a window size from tokens and utilization', () => {
  const l = new CapacityLearner();
  const t0 = Date.now();
  l.observeUtilization(0, 'unified7d', 0.10, t0);
  l.recordTokens(0, 'unified7d', { input_tokens: 800_000, output_tokens: 200_000 });
  // 1M metered tokens moved the window 1% ⇒ the window holds ~100M.
  l.observeUtilization(0, 'unified7d', 0.11, t0 + 60_000);
  const cap = l.capacity(0, 'unified7d');
  assert.ok(cap > 50_000_000 && cap < 200_000_000, `implausible capacity: ${cap}`);
});

test('scenario: a cache READ does not inflate the learned tier', () => {
  // Cache reads meter at a fraction upstream does not publish, so counting them
  // would make a cache-heavy session look like more spend than it was.
  const l = new CapacityLearner();
  const t0 = Date.now();
  l.observeUtilization(0, 'unified7d', 0, t0);
  l.recordTokens(0, 'unified7d', { input_tokens: 1000, cache_read_input_tokens: 9_000_000 });
  l.observeUtilization(0, 'unified7d', 0.01, t0 + 1000);
  assert.ok(l.capacity(0, 'unified7d') < 1_000_000, 'cache reads must not be priced as spend');
});

test('scenario: a window reset is not learned as negative spend', () => {
  const l = new CapacityLearner();
  const t0 = Date.now();
  l.observeUtilization(0, 'unified7d', 0.90, t0);
  l.recordTokens(0, 'unified7d', { input_tokens: 1_000_000 });
  l.observeUtilization(0, 'unified7d', 0.02, t0 + 1000); // weekly rolled over
  assert.equal(l.capacity(0, 'unified7d'), null, 'a reset must not produce a sample');
});

test('scenario: a stale gap re-baselines instead of pricing unrelated tokens', () => {
  const l = new CapacityLearner();
  const t0 = Date.now();
  l.observeUtilization(0, 'unified7d', 0.10, t0);
  l.recordTokens(0, 'unified7d', { input_tokens: 1_000_000 });
  // Longer than maxSampleAgeMs: the tokens and the move are different intervals.
  l.observeUtilization(0, 'unified7d', 0.20, t0 + ADAPTIVE_DEFAULTS.maxSampleAgeMs + 1);
  assert.equal(l.capacity(0, 'unified7d'), null);
});

test('scenario: a big plan outranks a small one at the same percentage', () => {
  // Both accounts sit at 60%. The Pro account has far less absolute credit
  // behind that 60%, so it is the one to finish off first.
  const am = mgr(['pro', 'max20x']);
  weekly(am, 0, 0.60);
  weekly(am, 1, 0.60);
  teachCapacity(am, 0, 'unified7d', 1_000_000, 0.10, 0.50);  // ~10M window
  teachCapacity(am, 1, 'unified7d', 20_000_000, 0.10, 0.50); // ~200M window
  const counts = placeSessions(am, 10);
  assert.ok((counts.pro || 0) > (counts.max20x || 0),
    `the smaller plan should be finished first, got ${JSON.stringify(counts)}`);
});

test('scenario: an unlearned tier falls back to fractions rather than mixing units', () => {
  // Only one account has a learned capacity. Comparing its tokens against the
  // other's bare fraction would rank on the unit, not the account.
  const am = mgr(['learned', 'unlearned']);
  weekly(am, 0, 0.20);
  weekly(am, 1, 0.80);
  teachCapacity(am, 0, 'unified7d', 5_000_000, 0.10, 0.10);
  const rows = am.adaptiveStats();
  // Fraction fallback ⇒ the more-spent account still leads on remaining credit.
  assert.ok(rows.find(r => r.name === 'unlearned').share > rows.find(r => r.name === 'learned').share);
});

// ── Scenario 5: response speed ──────────────────────────────────────────────

test('scenario: a congested account sheds share to an idle sibling', () => {
  const am = mgr(['busy', 'idle']);
  weekly(am, 0, 0.80); // busy is the better burn-down target on quota alone
  weekly(am, 1, 0.30);
  // Bury 'busy' under in-flight work well past its learned concurrency cap.
  am.accounts[0].inFlight = 40;
  const rows = am.adaptiveStats();
  assert.ok(rows.find(r => r.name === 'idle').share > rows.find(r => r.name === 'busy').share,
    'congestion must outweigh the burn-down preference');
});

test('scenario: quota preference still wins while the account keeps up', () => {
  const am = mgr(['busy', 'idle']);
  weekly(am, 0, 0.80);
  weekly(am, 1, 0.30);
  am.accounts[0].inFlight = 1; // comfortably inside the cap
  const rows = am.adaptiveStats();
  assert.ok(rows.find(r => r.name === 'busy').share > rows.find(r => r.name === 'idle').share,
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

test('an unknown utilization is not mistaken for a spent window', () => {
  // Nothing is known about 'unknown'. Treating null as "most spent" would send
  // every cold-start session to whichever account happens to be unmeasured.
  const am = mgr(['unknown', 'known']);
  am.accounts[0].probing = false;
  weekly(am, 1, 0.85);
  const rows = am.adaptiveStats();
  assert.ok(rows.find(r => r.name === 'known').share > rows.find(r => r.name === 'unknown').share);
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
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.70);
  weekly(am, 1, 0.30);
  teachCapacity(am, 0, 'unified7d', 2_000_000, 0.05, 0.65);
  teachCapacity(am, 1, 'unified7d', 2_000_000, 0.05, 0.25);
  am.recordSession('s1', 0);
  const rows = am.adaptiveStats();
  const a = rows.find(r => r.name === 'a');
  assert.equal(a.sessions, 1, 'per-account session count is reported');
  assert.equal(a.competing, true);
  assert.ok(a.capacity > 0, 'learned plan tier is reported');
  assert.ok(a.tokensPerSecond > 0, 'throughput is reported once the tier is known');
  assert.ok(a.concCap > 0);
  assert.ok(Math.abs(a.headroom - (0.98 - 0.70)) < 1e-9);
  // Shares across the competing tier are a distribution.
  const total = rows.filter(r => r.competing).reduce((n, r) => n + r.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares should sum to 1, got ${total}`);
});

test('tok/s is withheld until the tier is known, rather than reported in the wrong unit', () => {
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.50);
  weekly(am, 1, 0.50);
  const row = am.adaptiveStats().find(r => r.name === 'a');
  assert.equal(row.capacity, null);
  assert.equal(row.tokensPerSecond, null);
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
  assert.equal(backup.share, 0);
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
  const l = new CapacityLearner();
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
