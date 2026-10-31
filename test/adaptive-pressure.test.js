// adaptiveDistribution.scoring "pressure": rank new placements by
//
//   score = P / (1 + load)
//
// where P is the expiry pressure the band already computes (room under the
// account's caps, per second to the governing weekly reset) and load is
// sessions + requests in flight. Expected values below are worked out by hand
// from that formula, not read back from the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { renderStatus } from '../src/status-renderer.js';
import { ADAPTIVE_DEFAULTS, scoreCandidate, validateAdaptiveConfig } from '../src/adaptive-distribution.js';

const H = 3600_000;
const WEEK_S = 7 * 24 * 3600;
const START = Date.parse('2026-01-01T00:00:00Z');
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';

// Pressure is a function of the instant it is read at, and the pickers read
// their own Date.now(). The clock is frozen for each test, as in
// apikey-401-cooldown.test.js, so a fixture and the read that prices it see the
// same instant however long the run takes. Call it first, before any fixture.
function freezeClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  return START;
}

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const cap = c => ({ maxUsage: { unified5h: c, unified7d: c, unified7dFable: c } });

// `scoring: undefined` leaves the key out, which is what a config without it is.
function fleet(accounts, { scoring, tolerance = 100, preempt = false, expiry = true, mode = 'adaptive' } = {}) {
  return new AccountManager(accounts, 0.98, {
    distributeSessions: mode,
    adaptive: validateAdaptiveConfig(scoring ? { scoring } : {}),
    expiryRouting: { enabled: expiry, tolerance, preempt },
  });
}

// The governing weekly window: `used` now, resetting `hours` from now. A null
// `used` leaves no reading; a null `hours` leaves no reset time.
function weekly(am, index, used, hours, key = 'unified7d') {
  const q = am.accounts[index].quota;
  q[key] = used;
  q[`${key}Reset`] = hours == null ? null : Date.now() + hours * H;
  am.accounts[index].probing = false;
}

function place(am, n, model = OPUS) {
  const landed = [];
  for (let i = 0; i < n; i++) {
    const sid = `new-${i}`;
    const account = am.getActiveAccount(null, model, null, sid);
    am.recordSession(sid, account.index, model);
    landed.push(account.name);
  }
  return landed;
}

const tally = names => names.reduce((t, n) => ({ ...t, [n]: (t[n] ?? 0) + 1 }), {});

// Float rounding only (0.7 - 0.5 is not 0.2): the clock is frozen, so no time
// passes between a fixture and the read that prices it.
function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-9, `${label}: ${actual} vs ${expected}`);
}

// Two accounts, same band. A has the larger pressure (0.5 left, 10 h out:
// 1.389e-5 per s) and B the smaller (0.2 left, 27 h out: 2.058e-6), a ratio of
// 6.75. B is also the one with less room, which is what burndown prefers.
function twoAccounts(options) {
  const am = fleet([oauth('A'), oauth('B')], options);
  weekly(am, 0, 0.5, 10);
  weekly(am, 1, 0.8, 27);
  return am;
}

// ── config ────────────────────────────────────────────────────────────────────

test('scoring defaults to burndown and validates "burndown" | "pressure" only', () => {
  assert.equal(ADAPTIVE_DEFAULTS.scoring, 'burndown');
  assert.deepEqual(validateAdaptiveConfig({ scoring: 'pressure' }), { scoring: 'pressure' });
  assert.deepEqual(validateAdaptiveConfig({ scoring: 'burndown', maxBurnBoost: 2 }), { scoring: 'burndown', maxBurnBoost: 2 });
  for (const bad of ['proportional', 'Pressure', '', 1, true, null]) {
    assert.throws(() => validateAdaptiveConfig({ scoring: bad }),
      /adaptiveDistribution\.scoring must be "burndown" or "pressure"/, `accepted ${JSON.stringify(bad)}`);
  }
});

// ── the score ─────────────────────────────────────────────────────────────────

test('scoreCandidate under "pressure" is P / (1 + load) and reads nothing else', () => {
  const opts = { ...ADAPTIVE_DEFAULTS, scoring: 'pressure' };
  const base = { pressure: 6e-6, load: 0, utilization: 0.97, threshold: 0.98, reserve: 0.2, concCap: 1, maxRemaining: 1 };
  assert.equal(scoreCandidate(base, opts).score, 6e-6);
  assert.equal(scoreCandidate({ ...base, load: 2 }, opts).score, 2e-6);
  // Head, reserve and concurrency cap do not enter, though they decide a burndown score.
  const other = { ...base, utilization: 0, threshold: 0.5, reserve: 0.01, concCap: 64, maxRemaining: 0.01 };
  assert.equal(scoreCandidate(other, opts).score, 6e-6);
  assert.notEqual(scoreCandidate(other, ADAPTIVE_DEFAULTS).score, scoreCandidate(base, ADAPTIVE_DEFAULTS).score);
  for (const bad of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(scoreCandidate({ ...base, pressure: bad }, opts).score, 0, `pressure ${bad}`);
  }
});

// ── placement ─────────────────────────────────────────────────────────────────

test('inside the band sessions land in proportion to P / (1 + load)', t => {
  freezeClock(t);
  // P ratio 6.75. Greedy by P / (1 + load): A takes 6, B the 7th, A the next 7,
  // B the 15th, A the rest: 18 and 2 of 20.
  const landed = place(twoAccounts({ scoring: 'pressure' }), 20);
  assert.deepEqual(landed.slice(0, 8), ['A', 'A', 'A', 'A', 'A', 'A', 'B', 'A']);
  assert.deepEqual(tally(landed), { A: 18, B: 2 });
});

test('the default is unchanged: burndown still prefers the account with less room', t => {
  freezeClock(t);
  const burndown = place(twoAccounts({ scoring: 'burndown' }), 20);
  assert.equal(burndown[0], 'B');
  assert.notDeepEqual(tally(burndown), { A: 18, B: 2 });
  // No `scoring` key is the same as "burndown", pick for pick.
  assert.deepEqual(place(twoAccounts(), 20), burndown);
});

test('with expiryRouting off the band passes everyone and only the score changes', t => {
  freezeClock(t);
  // A tolerance of 1.5 keeps B, whose pressure is 6.75 times lower, outside the band.
  const band = { tolerance: 1.5 };
  assert.deepEqual(tally(place(twoAccounts({ scoring: 'pressure', ...band }), 20)), { A: 20 },
    'control: with expiryRouting on, B is outside the band');
  // Off, the same fleet places as it does with every account in the band.
  assert.deepEqual(tally(place(twoAccounts({ scoring: 'pressure', expiry: false, ...band }), 20)), { A: 18, B: 2 });
  // And the default scoring is the burndown pick, with or without the key.
  const burndown = place(twoAccounts({ scoring: 'burndown', expiry: false, ...band }), 20);
  assert.equal(burndown[0], 'B');
  assert.deepEqual(place(twoAccounts({ expiry: false, ...band }), 20), burndown);
});

test('with expiryRouting off a pinned session stays put, whatever the scoring', t => {
  freezeClock(t);
  // The same rolled fleet as below, where it does move with expiryRouting on.
  assert.equal(rolledFleet({ scoring: 'pressure' }).getActiveAccount(null, OPUS, null, 's1').name, 'C',
    'control: with expiryRouting on, the session moves');
  for (const scoring of [undefined, 'burndown', 'pressure']) {
    const am = rolledFleet({ scoring, expiry: false });
    assert.equal(am.getActiveAccount(null, OPUS, null, 's1').name, 'A', `scoring ${scoring}`);
  }
});

test('load reverses the order: P / (1 + load) turns on the sessions an account already carries', t => {
  freezeClock(t);
  // A has 6.75x B's pressure: with 5 sessions on it that is 6.75 / 6 = 1.125 against
  // B's 1, with 6 it is 0.964.
  const loaded = n => {
    const am = twoAccounts({ scoring: 'pressure' });
    for (let i = 0; i < n; i++) am.recordSession(`held-${i}`, 0, OPUS);
    return place(am, 1)[0];
  };
  assert.equal(loaded(0), 'A');
  assert.equal(loaded(5), 'A');
  assert.equal(loaded(6), 'B');
});

test('pressure is the room under the cap, as the band counts it', t => {
  const now = freezeClock(t);
  const am = fleet([oauth('capped', cap(0.7)), oauth('open')], { scoring: 'pressure' });
  weekly(am, 0, 0.5, 20);
  weekly(am, 1, 0.5, 20);
  // 0.2 under the cap against 0.5 under 1, over the same 20 h.
  near(am._placementPressure(am.accounts[0], OPUS, now), 0.2 / (20 * 3600), 'capped');
  near(am._placementPressure(am.accounts[1], OPUS, now), 0.5 / (20 * 3600), 'open');
  // Priced on 1 - used the two would tie and the capped one (first) would win.
  assert.equal(place(am, 1)[0], 'open');
});

test('a Fable request is priced on the window that governs it, under the cap', t => {
  const now = freezeClock(t);
  const am = fleet([oauth('capped', cap(0.8)), oauth('open')], { scoring: 'pressure' });
  weekly(am, 0, 0.1, 100);
  weekly(am, 1, 0.1, 100);
  weekly(am, 0, 0.5, 40, 'unified7dFable');
  weekly(am, 1, 0.5, 40, 'unified7dFable');
  // Fable window: 0.8 - 0.5 under the cap, bounded by the weekly's 0.8 - 0.1.
  near(am._placementPressure(am.accounts[0], FABLE, now), 0.3 / (40 * 3600), 'capped');
  near(am._placementPressure(am.accounts[1], FABLE, now), 0.5 / (40 * 3600), 'open');
});

// ── the states the band leaves open ──────────────────────────────────────────

test('a passed reset or no reading is priced as a fresh window: cap, or 1, over a week', t => {
  const now = freezeClock(t);
  const am = fleet([oauth('stale'), oauth('blank'), oauth('blankCapped', cap(0.7)), oauth('live')],
    { scoring: 'pressure' });
  weekly(am, 0, 0.9, -1 / 60);   // reset a minute ago
  weekly(am, 1, null, null);
  weekly(am, 2, null, null);
  weekly(am, 3, 0.5, 100);
  const P = i => am._placementPressure(am.accounts[i], OPUS, now);
  near(P(0), 1 / WEEK_S, 'passed reset');
  near(P(1), 1 / WEEK_S, 'no reading');
  near(P(2), 0.7 / WEEK_S, 'no reading under a 0.7 cap');
  near(P(3), 0.5 / (100 * 3600), 'live');
  // 1.65e-6 > 1.39e-6 > 1.16e-6: the uncapped fresh windows, the live one, the capped fresh one.
  assert.deepEqual(place(am, 3).slice(0, 2), ['stale', 'blank']);
});

test('a fresh window is bounded by the lower of the weekly and family caps', t => {
  const now = freezeClock(t);
  const am = fleet([oauth('a', { maxUsage: { unified7d: 0.9, unified7dFable: 0.6 } })], { scoring: 'pressure' });
  weekly(am, 0, null, null);
  near(am._placementPressure(am.accounts[0], FABLE, now), 0.6 / WEEK_S, 'Fable');
  near(am._placementPressure(am.accounts[0], OPUS, now), 0.9 / WEEK_S, 'Opus');
});

test('a reading with no reset time is priced at the band\'s lower bound', t => {
  const now = freezeClock(t);
  const am = fleet([oauth('A'), oauth('B')], { scoring: 'pressure' });
  weekly(am, 0, 0.5, 100);
  weekly(am, 1, 0.5, null);
  near(am._placementPressure(am.accounts[0], OPUS, now), 0.5 / (100 * 3600), 'measured');
  // Room over the longest a weekly window can be: below any measured account of the same use.
  near(am._placementPressure(am.accounts[1], OPUS, now), 0.5 / WEEK_S, 'lower bound');
  // 1.39e-6 against 8.27e-7: A, then B (0.83 > 0.69), then A twice (0.69 > 0.41, 0.46 > 0.41).
  assert.deepEqual(place(am, 4), ['A', 'B', 'A', 'A']);
});

test('nothing left under the caps prices 0', t => {
  const now = freezeClock(t);
  const am = fleet([oauth('capped', cap(0.7)), oauth('spent')], { scoring: 'pressure' });
  weekly(am, 0, 0.7, 20);
  weekly(am, 1, 1.0, 20);
  assert.equal(am._placementPressure(am.accounts[0], OPUS, now), 0);
  assert.equal(am._placementPressure(am.accounts[1], OPUS, now), 0);
});

test('when every score is 0 the even walk places the session, as under burndown', t => {
  freezeClock(t);
  const am = fleet([oauth('A'), oauth('B'), oauth('C')], { scoring: 'pressure' });
  for (let i = 0; i < 3; i++) weekly(am, i, NaN, 20);   // a reading nothing can be priced from
  for (const i of [0, 1]) am.recordSession(`held-${i}`, i, OPUS);
  assert.equal(am._pickAdaptive(null, OPUS), null, 'every score should be 0');
  assert.equal(place(am, 1)[0], 'C', 'the least loaded of them');
});

// ── rollover ─────────────────────────────────────────────────────────────────

// A pinned to s1; its window then rolls a week. After the roll A is fresh
// (nothing used, 178 h out: 1.6e-6 per s), B is mostly spent far out (1.4e-7)
// and C half spent nearer (4.6e-7). Burndown prefers the most spent account, B;
// pressure prefers C among the others.
function rolledFleet(options) {
  const am = fleet([oauth('A'), oauth('B'), oauth('C')], { tolerance: 1000, preempt: true, ...options });
  weekly(am, 0, 0.3, 10);
  weekly(am, 1, 0.8, 400);
  weekly(am, 2, 0.5, 300);
  am.recordSession('s1', 0, OPUS);
  am.accounts[0].quota.unified7d = 0;
  am.accounts[0].quota.unified7dReset += 168 * H;
  return am;
}

test('a decided rollover move re-picks its destination by pressure, never the account being left', t => {
  const now = freezeClock(t);
  const am = rolledFleet({ scoring: 'pressure' });
  // Priced with A in the running it is the leader (1.6e-6 against C's 4.6e-7).
  const p = i => am._placementPressure(am.accounts[i], OPUS, now);
  assert.ok(p(0) > p(2) && p(2) > p(1));
  const moved = am.getActiveAccount(null, OPUS, null, 's1');
  assert.equal(moved.name, 'C');
});

test('the decision to move stays on burndown: its pick is the destination under burndown', t => {
  freezeClock(t);
  const burndown = rolledFleet({ scoring: 'burndown' }).getActiveAccount(null, OPUS, null, 's1');
  assert.equal(burndown.name, 'B');
  // And under pressure the pinned session still moves only when burndown says so:
  // with preempt off nothing moves it.
  const held = rolledFleet({ scoring: 'pressure', preempt: false }).getActiveAccount(null, OPUS, null, 's1');
  assert.equal(held.name, 'A');
});

test('with one other account left, the re-pick names the account the decision named', t => {
  freezeClock(t);
  const am = rolledFleet({ scoring: 'pressure' });
  // C is gone, so among the others only B is left: the same account the decision named.
  am.accounts[2].disabled = true;
  assert.equal(am.getActiveAccount(null, OPUS, null, 's1').name, 'B');
});

// A fleet where leaving A out of the candidates CHANGES the band: A's fresh window
// sets the floor (1.6e-6 / 1.5 = 1.04e-6) that keeps C (9.0e-7) out, and without A
// the floor drops to B's (1.20e-6 / 1.5 = 8.0e-7) and C is in. A carries two
// sessions, B one, C none, so an even walk over {A, B} names B and one over {B, C}
// names C. Under burndown B is also the most spent, so every mode's decision is B.
function bandedRollover(mode, scoring) {
  const am = fleet([oauth('A'), oauth('B'), oauth('C')], { mode, scoring, tolerance: 1.5, preempt: true });
  weekly(am, 0, 0.3, 10);
  weekly(am, 1, 0.5, 116);
  weekly(am, 2, 0.5, 154);
  am.recordSession('s1', 0, OPUS);
  am.recordSession('s2', 0, OPUS);
  am.recordSession('b1', 1, OPUS);
  am.accounts[0].quota.unified7d = 0;
  am.accounts[0].quota.unified7dReset += 168 * H;
  return am.getActiveAccount(null, OPUS, null, 's1').name;
}

test('outside adaptive mode the scoring does not touch a rollover destination, even where excluding the leaver would change the band', t => {
  freezeClock(t);
  for (const mode of ['even', 'load']) {
    assert.equal(bandedRollover(mode, undefined), 'B', `${mode}, no key`);
    assert.equal(bandedRollover(mode, 'pressure'), 'B', `${mode}, pressure`);
  }
  // The same fleet under adaptive is where the re-pick is meant to act.
  assert.equal(bandedRollover('adaptive', undefined), 'B');
  assert.equal(bandedRollover('adaptive', 'pressure'), 'C');
});

test('when the decision keeps the pin, pressure does not move it, though it would place elsewhere', t => {
  freezeClock(t);
  // After the roll A has the least room (a 0.5 cap) and B and C carry two sessions each,
  // so burndown's decision names A itself: stay. Priced by pressure, a placement among
  // the others would name C (9.3e-7 against B's 6.9e-7).
  for (const scoring of [undefined, 'burndown', 'pressure']) {
    const am = fleet([oauth('A', { maxUsage: { unified7d: 0.5 } }), oauth('B'), oauth('C')],
      { scoring, tolerance: 1000, preempt: true });
    weekly(am, 0, 0.3, 10);
    weekly(am, 1, 0, 400);
    weekly(am, 2, 0, 300);
    am.recordSession('s1', 0, OPUS);
    for (const [sid, i] of [['b1', 1], ['b2', 1], ['c1', 2], ['c2', 2]]) am.recordSession(sid, i, OPUS);
    am.accounts[0].quota.unified7d = 0;
    am.accounts[0].quota.unified7dReset += 168 * H;
    assert.equal(am._pickLeastLoaded(null, OPUS, null, 'decision').name, 'A', `decision, scoring ${scoring}`);
    if (scoring === 'pressure') assert.equal(am._pickLeastLoaded(new Set([0]), OPUS).name, 'C', 'control: pressure would place it on C');
    assert.equal(am.getActiveAccount(null, OPUS, null, 's1').name, 'A', `scoring ${scoring}`);
  }
});

// ── status ───────────────────────────────────────────────────────────────────

test('status rows carry the placement pressure under "pressure" and nothing new otherwise', t => {
  freezeClock(t);
  const am = twoAccounts({ scoring: 'pressure' });
  const rows = am.adaptiveStats(OPUS);
  assert.ok(rows.every(r => r.scoring === 'pressure'));
  near(rows[0].placementPressure, 0.5 / (10 * 3600), 'A');
  near(rows[1].placementPressure, 0.2 / (27 * 3600), 'B');
  // Weights are shares of P / (1 + load): 6.75 / 7.75 and 1 / 7.75.
  near(rows[0].weight, 6.75 / 7.75, 'A weight');
  assert.equal(rows.find(r => r.next).name, 'A');
  for (const r of twoAccounts().adaptiveStats(OPUS)) {
    assert.ok(!('scoring' in r) && !('placementPressure' in r), 'a burndown row grew a field');
  }
});

test('the Adaptive line shows P in place of head, plan and conc', t => {
  const now = freezeClock(t);
  const am = twoAccounts({ scoring: 'pressure' });
  am.recordSession('s', 0, OPUS);
  const out = renderStatus(am.getStatus(), { color: false, now });
  assert.match(out, /Adaptive\s+next · weight \d+% of [^\s]+\s+·\s+1 sess \/ 0 inflight\s+·\s+P \d\.\d\de-\d+$/m);
  assert.doesNotMatch(out, /Adaptive[^\n]*\b(head|plan|conc)\b/);
});

test('with every score 0 the Adaptive line says "all zero", not "all reserved"', t => {
  const now = freezeClock(t);
  const am = fleet([oauth('A'), oauth('B')], { scoring: 'pressure' });
  weekly(am, 0, NaN, 20);
  weekly(am, 1, NaN, 20);
  const out = renderStatus(am.getStatus(), { color: false, now });
  assert.match(out, /weight n\/a \(all zero, /);
  assert.doesNotMatch(out, /all reserved/);
});
