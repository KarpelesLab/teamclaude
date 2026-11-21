import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { SessionPins } from '../src/session-pins.js';
import { SessionTracker, SESSION_ACTIVE_TTL_MS } from '../src/session-tracker.js';
import { affinityAccounts } from '../test-helpers/affinity-fixtures.js';
import { decideAdvice, normalizeSessionAdvice, SESSION_ADVICE_DEFAULTS } from '../src/session-advice.js';

// AccountManager.sessionAccount: which account a client session is on, and the
// conversation a move would cost the most to re-read. AccountManager.sessionAdvice
// and decideAdvice: whether to suggest moving it.

const SESSION = '3f2a1b9c-0000-4000-8000-000000000001';
const OPUS = 'claude-opus-4-1';
const SONNET = 'claude-sonnet-4-6';
const apikey = (/** @type {string} */ name) => ({ name, type: 'apikey', apiKey: `key-${name}` });

/** @param {{ accounts?: any[], start?: number, [opt: string]: any }} [opts] */
function fleet({ accounts = [apikey('a'), apikey('b')], start = 1_000_000, ...opts } = {}) {
  const clock = { t: start };
  const now = () => clock.t;
  const tracker = new SessionTracker({ now });
  const am = new AccountManager(accounts, 0.98, { sessionTracker: tracker, ...opts });
  am.sessionPins = new SessionPins({ now });
  return { am, tracker, clock };
}

/** One routed request on conversation `conv` of SESSION, reporting `input` tokens (or that usage).
 * @param {ReturnType<typeof fleet>} f @param {string} conv @param {string} model @param {number} account @param {number|Record<string, number>} input */
function request({ am, tracker }, conv, model, account, input, session = SESSION) {
  const key = `${session}#${conv}`;
  am.beginSession(key, { sessionId: session, conversation: conv });
  am.recordSession(key, account, model);
  // Without session affinity a request is served where the fleet walk rests,
  // so the walk rests on the account that served this one.
  if (!am.distributeSessions) am.currentIndex = account;
  tracker.recordTokens(key, am._weeklyBucketFor(model), typeof input === 'number' ? { input_tokens: input } : input);
  am.endSession(key);
}

test('recordSession records the routed model on the conversation', () => {
  const f = fleet();
  request(f, 'x', OPUS, 0, 10);
  f.am.recordSession(`${SESSION}#x`, 0, null);
  assert.equal(f.tracker.conversationsOf(SESSION)[0].model, OPUS, 'a request naming no model keeps the last one');
});

test('the cost conversation is the largest context; the shown account follows the newest (AC6b)', () => {
  const f = fleet();
  const big = 120_000;
  request(f, 'x', OPUS, 0, big);
  f.clock.t += 30_000;
  request(f, 'y', OPUS, 1, 800); // /compact re-keys: a small conversation on the same session

  assert.deepEqual(f.am.sessionAccount(SESSION, f.clock.t), {
    shown: { index: 1, name: 'b', via: 'affinity' },
    cost: { model: OPUS, bucket: 'unified7d', context: big },
    served: 1,
  }, 'within the window the old conversation still prices the move');

  f.clock.t += SESSION_ACTIVE_TTL_MS;
  request(f, 'y', OPUS, 1, 900);
  assert.deepEqual(f.am.sessionAccount(SESSION, f.clock.t), {
    shown: { index: 1, name: 'b', via: 'affinity' },
    cost: { model: OPUS, bucket: 'unified7d', context: 900 },
    served: 1,
  }, 'past the window of the last request the old conversation is no candidate');

  f.clock.t += 10 * SESSION_ACTIVE_TTL_MS;
  assert.equal(f.am.sessionAccount(SESSION, f.clock.t)?.cost?.context, 900,
    'the window is anchored at the last request, not at now');
});

test('a later small subagent neither lowers the cost nor moves the shown bucket', () => {
  const f = fleet();
  request(f, 'main', OPUS, 0, 50_000);
  f.clock.t += 1_000;
  request(f, 'side', SONNET, 1, 50);
  assert.deepEqual(f.am.sessionAccount(SESSION, f.clock.t), {
    shown: { index: 0, name: 'a', via: 'affinity' },
    cost: { model: OPUS, bucket: 'unified7d', context: 50_000 },
    served: 0,
  });
});

test('a manual pin overrides the shown account and is only peeked', () => {
  const f = fleet();
  request(f, 'x', OPUS, 0, 700);
  f.am.sessionPins.set(SESSION, 'b', f.clock.t);
  f.clock.t += 5_000;
  assert.deepEqual(f.am.sessionAccount(SESSION, f.clock.t), {
    shown: { index: 1, name: 'b', via: 'manual' },
    cost: { model: OPUS, bucket: 'unified7d', context: 700 },
    served: 0,
  });
  assert.equal(f.am.sessionPins.pins.get(SESSION)?.lastUsed, 1_000_000, 'reading it is not use');
});

test('a manual pin with no live conversation answers shown alone; neither answers null', () => {
  const f = fleet();
  assert.equal(f.am.sessionAccount(SESSION, f.clock.t), null);
  f.am.sessionPins.set(SESSION, 'a', f.clock.t);
  assert.deepEqual(f.am.sessionAccount(SESSION, f.clock.t), {
    shown: { index: 0, name: 'a', via: 'manual' },
    cost: null,
    served: null,
  });
});

// ---------------------------------------------------------------------------
// decideAdvice: the ten rules, on hand-built snapshots
// ---------------------------------------------------------------------------

/** A snapshot every rule passes but the last: out of band with somewhere to go.
 * @param {Partial<import('../src/session-advice.js').AdviceSnapshot>} [over]
 * @returns {import('../src/session-advice.js').AdviceSnapshot} */
const snap = (over = {}) => ({
  now: 1_000, enabled: true, maxContextTokens: 150_000, expiryOn: true,
  account: 'a', via: 'affinity', context: 20_000, currentAvailable: true,
  routerMoves: false, inBand: false, destination: 'b', cooldownUntil: null, ...over,
});

test('decideAdvice: out of band with a destination recommends it (rule 10)', () => {
  assert.deepEqual(decideAdvice(snap()), { recommendation: { to: 'b', reread: 20_000 }, reason: 'out-of-band' });
});

test('decideAdvice: five snapshots that recommend nothing (AC1b)', () => {
  const cases = /** @type {const} */ ([
    [{ enabled: false }, 'disabled'],
    [{ account: null, via: null }, 'unknown-session'],
    [{ expiryOn: false }, 'expiry-routing-off'],
    [{ destination: null }, 'no-destination'],
    [{ via: 'manual', currentAvailable: false, destination: null }, 'pinned-unavailable'],
  ]);
  for (const [over, reason] of cases) {
    assert.deepEqual(decideAdvice(snap(over)), { recommendation: null, reason }, reason);
  }
});

test('decideAdvice: rules 5 to 9 each hold the advice', () => {
  assert.equal(decideAdvice(snap({ cooldownUntil: 1_001 })).reason, 'cooldown');
  assert.equal(decideAdvice(snap({ cooldownUntil: 1_000 })).reason, 'out-of-band', 'a cooldown ends at its instant');
  assert.equal(decideAdvice(snap({ context: 150_001 })).reason, 'context-over-ceiling');
  assert.equal(decideAdvice(snap({ context: 150_000 })).reason, 'out-of-band', 'the ceiling itself is allowed');
  assert.equal(decideAdvice(snap({ currentAvailable: false })).reason, 'current-unavailable');
  assert.equal(decideAdvice(snap({ currentAvailable: false, routerMoves: true })).reason, 'current-unavailable');
  assert.equal(decideAdvice(snap({ routerMoves: true })).reason, 'router-moves');
  assert.equal(decideAdvice(snap({ routerMoves: true, inBand: true })).reason, 'router-moves', 'ahead of in-band');
  assert.equal(decideAdvice(snap({ inBand: true })).reason, 'in-band');
});

test('decideAdvice: an unusable manual pin is advised ahead of expiry, cooldown and ceiling', () => {
  const pinned = snap({ via: 'manual', currentAvailable: false, inBand: true,
    expiryOn: false, cooldownUntil: 9_999, context: 900_000 });
  assert.deepEqual(decideAdvice(pinned), { recommendation: { to: 'b', reread: 900_000 }, reason: 'pinned-unavailable' });
  assert.deepEqual(decideAdvice({ ...pinned, context: null }),
    { recommendation: { to: 'b', reread: null }, reason: 'pinned-unavailable' });
  assert.equal(decideAdvice({ ...pinned, enabled: false }).reason, 'disabled', 'off is off');
});

test('normalizeSessionAdvice: only a literal true turns a switch on; numbers must be positive', () => {
  assert.deepEqual(normalizeSessionAdvice(undefined), SESSION_ADVICE_DEFAULTS);
  assert.deepEqual(normalizeSessionAdvice({ enabled: 'true', ask: 1, maxContextTokens: -5, cooldownMinutes: Infinity }),
    SESSION_ADVICE_DEFAULTS);
  assert.deepEqual(normalizeSessionAdvice({ enabled: true, ask: true, maxContextTokens: 9, cooldownMinutes: 0.5 }),
    { enabled: true, ask: true, maxContextTokens: 9, cooldownMinutes: 0.5 });
});

// ---------------------------------------------------------------------------
// AccountManager.sessionAdvice: the snapshot gathered from a live fleet
// ---------------------------------------------------------------------------

const H = 3600_000;
const ADVICE_ON = { enabled: true };
/** @param {string} name */
const oauth = name => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + H });

/** Set `account`'s shared weekly: `used` spent, resetting in `hours` (relative to now, never pinned).
 * @param {AccountManager} am @param {number} index @param {number} used @param {number} hours */
function weekly(am, index, used, hours) {
  const q = am.accounts[index].quota;
  q.unified7d = used;
  q.unified7dReset = Date.now() + hours * H;
  am.accounts[index].probing = false;
}

/** Three OAuth accounts with expiry routing and advice on, a ample and soonest-reset (in band). */
function adviceFleet({ expiry = /** @type {any} */ ({ enabled: true }), advice = /** @type {any} */ (ADVICE_ON), ...opts } = {}) {
  const f = fleet({ accounts: [oauth('a'), oauth('b'), oauth('c')], expiryRouting: expiry, sessionAdvice: advice, ...opts });
  weekly(f.am, 0, 0.1, 10);
  weekly(f.am, 1, 0.2, 10);
  weekly(f.am, 2, 0.2, 12);
  return f;
}

/** Push account a far out of the band: spent and resetting late. @param {AccountManager} am */
const pushOut = am => weekly(am, 0, 0.9, 150);

/** Cap `index` below its weekly use, which bars even a pinned request. @param {AccountManager} am @param {number} index */
const capOut = (am, index) => { am.accounts[index].maxUsage = am.accounts[index].quota.unified7d / 2; };

test('the session\'s account in the top band is told to stay (AC1)', () => {
  const f = adviceFleet();
  request(f, 'main', OPUS, 0, 20_000);
  const advice = f.am.sessionAdvice(SESSION, f.clock.t);
  assert.deepEqual(advice, {
    account: 'a', via: 'affinity', context: 20_000, advice: { enabled: true, ask: false },
    recommendation: null, reason: 'in-band',
  });
});

test('out of the band, the move goes to a band account and re-reads the whole prompt (AC2)', () => {
  const f = adviceFleet();
  const usage = { input_tokens: 300, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000 };
  request(f, 'main', OPUS, 0, usage);
  pushOut(f.am);
  const { recommendation, reason } = f.am.sessionAdvice(SESSION, f.clock.t);
  assert.equal(reason, 'out-of-band');
  assert.ok(recommendation && ['b', 'c'].includes(recommendation.to), `a band account, got ${recommendation?.to}`);
  assert.equal(recommendation?.reread, 300 + 40_000 + 2_000);
});

test('in load mode the destination is the band account that carried the fewest requests (AC2)', () => {
  /** @param {any} distributeSessions */
  const destination = distributeSessions => {
    const f = adviceFleet({ distributeSessions, start: Date.now() });
    request(f, 'main', OPUS, 0, 1_000);
    pushOut(f.am);
    // b ranks ahead of c on every key the even walk reads; only the request count is against it.
    for (let i = 0; i < 3; i++) f.tracker.noteRouted(1);
    return f.am.sessionAdvice(SESSION, f.clock.t).recommendation?.to;
  };
  assert.equal(destination(true), 'b', 'the even walk does not count requests');
  assert.equal(destination('load'), 'c');
});

test('in adaptive mode the destination is the account adaptive placement picks', () => {
  /** @param {any} distributeSessions */
  const destination = distributeSessions => {
    const f = adviceFleet({ distributeSessions });
    request(f, 'main', OPUS, 0, 1_000);
    pushOut(f.am);
    weekly(f.am, 1, 0.2, 12);
    weekly(f.am, 2, 0.5, 10);
    const to = f.am.sessionAdvice(SESSION, f.clock.t).recommendation?.to;
    assert.equal(to, f.am._pickLeastLoaded(new Set([0]), OPUS)?.name, 'the router\'s own placement');
    return to;
  };
  assert.equal(destination(true), 'b', 'the even walk');
  assert.equal(destination('adaptive'), 'c');
});

test('an affinity session the reclaim window moves gets no recommendation (router-moves)', () => {
  /** @param {any} expiry @param {any} distributeSessions */
  const reason = (expiry, distributeSessions) => {
    const f = adviceFleet({ expiry: { enabled: true, ...expiry }, distributeSessions });
    request(f, 'main', OPUS, 0, 1_000);
    pushOut(f.am);
    return f.am.sessionAdvice(SESSION, f.clock.t);
  };
  const reclaim = { reclaimHours: 24, reclaimAcrossOrganizations: true };
  assert.deepEqual([reason(reclaim, true).reason, reason(reclaim, true).recommendation], ['router-moves', null]);
  assert.equal(reason(reclaim, false).reason, 'out-of-band', 'without distributeSessions the router never asks reclaim');
  assert.equal(reason({}, true).reason, 'out-of-band', 'no reclaim window');
  const f = adviceFleet({ expiry: { enabled: true, ...reclaim }, distributeSessions: true });
  request(f, 'main', OPUS, 0, 1_000);
  pushOut(f.am);
  f.am.sessionPins.set(SESSION, 'a', f.clock.t);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'out-of-band', 'reclaim never moves a manual pin');
});

test('a cordoned session the router keeps in place reads out-of-band even with a reclaim window', () => {
  const f = adviceFleet({ expiry: { enabled: true, reclaimHours: 24, reclaimAcrossOrganizations: true }, distributeSessions: true });
  request(f, 'main', OPUS, 0, 1_000);
  pushOut(f.am);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'router-moves', 'the fixture is one reclaim moves');
  f.am.accounts[0].cordoned = true;
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'out-of-band', '_keepOnCordoned returns ahead of reclaim');
});

test('a session the router preempts for a higher-priority account gets no recommendation (router-moves)', () => {
  for (const distributeSessions of [true, false]) {
    const f = adviceFleet({ distributeSessions });
    request(f, 'main', OPUS, 0, 1_000);
    f.am.accounts[0].priority = 1;
    const advice = f.am.sessionAdvice(SESSION, f.clock.t);
    assert.deepEqual([advice.reason, advice.recommendation], ['router-moves', null], `distributeSessions ${distributeSessions}`);
    f.am.accounts[1].disabled = true;
    f.am.accounts[2].disabled = true;
    assert.notEqual(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'router-moves', 'no available account outranks it');
  }
  const f = adviceFleet();
  request(f, 'main', OPUS, 0, 1_000);
  f.am.accounts[0].priority = 1;
  f.am.sessionPins.set(SESSION, 'a', f.clock.t);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'out-of-band', 'a manual pin is never preempted');
});

test('a route pin decides router-moves in the router\'s order: route pin, cordon keep, affinity', () => {
  const reclaim = { enabled: true, reclaimHours: 24, reclaimAcrossOrganizations: true };
  const routes = [{ name: 'main', match: ['*opus*'] }];
  /** @param {(f: ReturnType<typeof adviceFleet>) => void} arrange @param {any} [opts] */
  const reason = (arrange, opts = {}) => {
    const f = adviceFleet({ routes, distributeSessions: true, ...opts });
    request(f, 'main', OPUS, 0, 1_000);
    arrange(f);
    return f.am.sessionAdvice(SESSION, f.clock.t);
  };
  assert.equal(reason(f => pushOut(f.am), { expiry: reclaim }).reason, 'router-moves', 'the fixture, with no route pin');
  assert.equal(reason(f => { f.am.accounts[0].priority = 1; }).reason, 'router-moves', 'the fixture, with no route pin');
  // Pinned by route to the session's own account: neither priority nor reclaim moves it.
  const kept = reason(f => { f.am.setRoutePin('main', 0); f.am.accounts[0].priority = 1; });
  assert.equal(kept.reason, 'out-of-band', 'priority preemption does not reach a route-pinned session');
  assert.ok(kept.recommendation && kept.recommendation.to !== 'a', 'a session pin, which outranks the route pin, can move it');
  assert.equal(reason(f => { f.am.setRoutePin('main', 0); pushOut(f.am); }, { expiry: reclaim }).reason, 'out-of-band',
    'reclaim does not reach a route-pinned session');
  // Pinned by route to another available account: the router sends the session there.
  assert.equal(reason(f => f.am.setRoutePin('main', 1)).reason, 'router-moves');
  // A route pin that cannot serve: affinity is still skipped, so reclaim does not apply...
  assert.equal(reason(f => { f.am.setRoutePin('main', 1); f.am.accounts[1].disabled = true; pushOut(f.am); }, { expiry: reclaim }).reason,
    'out-of-band');
  // ...and the cordon keep is skipped too, so a cordoned account is left by the fleet walk.
  assert.equal(reason(f => { f.am.setRoutePin('main', 1); f.am.accounts[1].disabled = true; f.am.accounts[0].cordoned = true; }).reason,
    'router-moves');
  // A route pin to a cordoned account leaves the cordon keep in place.
  assert.equal(reason(f => { f.am.setRoutePin('main', 1); f.am.accounts[1].cordoned = true; f.am.accounts[0].cordoned = true; }).reason,
    'out-of-band');
});

test('a manual pin on an unusable account is advised past cooldown, ceiling and expiry routing (AC2b)', () => {
  const f = adviceFleet({ advice: { enabled: true, maxContextTokens: 1_000 } });
  request(f, 'main', OPUS, 0, 50_000);
  f.am.sessionPins.set(SESSION, 'b', f.clock.t);
  capOut(f.am, 1);
  assert.equal(f.am.pinBars(f.am.accounts[1], OPUS), 'unified7d', 'the fixture bars a pin to b');

  // (1), and (2): a cooldown is running and the context is over the ceiling.
  f.am.noteAdviceCooldown(SESSION, f.clock.t);
  const pinned = f.am.sessionAdvice(SESSION, f.clock.t);
  assert.equal(pinned.via, 'manual');
  assert.equal(pinned.reason, 'pinned-unavailable');
  assert.ok(pinned.recommendation && pinned.recommendation.to !== 'b');
  assert.equal(pinned.recommendation?.reread, 50_000);

  // (3) the same with expiry routing off.
  f.am.setExpiryRouting(undefined);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'pinned-unavailable');
  assert.ok(f.am.sessionAdvice(SESSION, f.clock.t).recommendation);
});

test('a manual pin the forward path still sends upstream is judged by the band, not as unavailable', () => {
  for (const [label, bar] of /** @type {[string, (a: any) => void][]} */ ([
    ['disabled', a => { a.disabled = true; }],
    ['over the threshold', a => { a.quota.unified7d = 0.99; }],
  ])) {
    const f = adviceFleet();
    request(f, 'main', OPUS, 1, 5_000);
    f.am.sessionPins.set(SESSION, 'b', f.clock.t);
    bar(f.am.accounts[1]);
    assert.ok(f.am.unavailableReason(f.am.accounts[1], OPUS), `${label}: the router skips b`);
    assert.equal(f.am.pinBars(f.am.accounts[1], OPUS), null, `${label}: a pin to b is forwarded`);
    const advice = f.am.sessionAdvice(SESSION, f.clock.t);
    assert.equal(advice.reason, 'out-of-band', `${label}: the band leaves b out`);
    assert.ok(advice.recommendation && advice.recommendation.to !== 'b', label);
  }
});

// An accepted move is a pin, and a pin never fails over. When the account it
// names then reaches its limit, every request of the session fails there: said
// at once, past the cooldown the move itself started and the context ceiling.
test('a manual pin on an account upstream has stopped serving is advised past the cooldown of the move that made it', () => {
  for (const [label, stop] of /** @type {[string, (a: any) => void][]} */ ([
    ['throttled', a => { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + H; }],
    ['exhausted', a => { a.status = 'exhausted'; }],
    ['in error', a => { a.status = 'error'; }],
  ])) {
    const f = adviceFleet({ advice: { enabled: true, maxContextTokens: 1_000 } });
    request(f, 'main', OPUS, 1, 50_000);
    f.am.sessionPins.set(SESSION, 'b', f.clock.t);
    f.am.noteAdviceCooldown(SESSION, f.clock.t);
    stop(f.am.accounts[1]);
    assert.equal(f.am.pinBars(f.am.accounts[1], OPUS), null, `${label}: the pin gate still forwards to b`);
    const advice = f.am.sessionAdvice(SESSION, f.clock.t);
    assert.equal(advice.reason, 'pinned-unavailable', label);
    assert.ok(advice.recommendation && advice.recommendation.to !== 'b', label);
  }
});

// With distribution off a session has no affinity: its next request goes where
// the fleet walk rests. Once that is another account (a manual switch, or
// rotation), the router has moved the session, and advice to move would pin it.
test('without distributeSessions a session the fleet walk has already left gets no recommendation', () => {
  const f = adviceFleet();
  request(f, 'main', OPUS, 0, 5_000);
  pushOut(f.am);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'out-of-band', 'while the walk rests on a');
  f.am.currentIndex = 1;
  assert.deepEqual([f.am.sessionAdvice(SESSION, f.clock.t).reason, f.am.sessionAdvice(SESSION, f.clock.t).recommendation], ['router-moves', null]);
});

// A subscription of another provider cannot take the session: it neither sets
// the band the session's account is judged against nor is named as the move.
test('a subscription of another provider is neither the band nor the destination', () => {
  const f = adviceFleet();
  // b, the Codex seat, has the best pressure of all: nearly unused, resetting soonest.
  f.am.accounts[1].provider = 'codex';
  weekly(f.am, 1, 0.01, 1);
  request(f, 'main', OPUS, 0, 5_000);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'in-band', 'a is the best Claude account, whatever b offers');
  pushOut(f.am);
  const advice = f.am.sessionAdvice(SESSION, f.clock.t);
  assert.deepEqual([advice.reason, advice.recommendation?.to], ['out-of-band', 'c']);
});

test('a manual pin to a subscription of another provider is not forwarded', () => {
  const f = adviceFleet();
  request(f, 'main', OPUS, 0, 5_000);
  f.am.accounts[1].provider = 'codex';
  f.am.sessionPins.set(SESSION, 'b', f.clock.t);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'pinned-unavailable');
});

test('the same unusable account reached by affinity is left to the router (AC2b)', () => {
  const f = adviceFleet();
  request(f, 'main', OPUS, 1, 5_000);
  f.am.accounts[1].status = 'exhausted';
  const advice = f.am.sessionAdvice(SESSION, f.clock.t);
  assert.equal(advice.via, 'affinity');
  assert.deepEqual([advice.reason, advice.recommendation], ['current-unavailable', null]);
});

test('a cordoned account keeps its session, so the advice judges it as serving', () => {
  const f = adviceFleet();
  request(f, 'main', OPUS, 0, 5_000);
  f.am.accounts[0].cordoned = true;
  assert.equal(f.am.unavailableReason(f.am.accounts[0]), 'cordoned', 'the fixture cordons a and nothing else');
  const advice = f.am.sessionAdvice(SESSION, f.clock.t);
  assert.equal(advice.reason, 'out-of-band', 'the band admits no cordoned account');
  assert.ok(advice.recommendation && advice.recommendation.to !== 'a');
  f.am.sessionPins.set(SESSION, 'a', f.clock.t);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'out-of-band', 'a manual pin is served on a cordoned account too');
});

test('a manual pin with no conversation on record is still advised, with nothing to re-read (AC1c)', () => {
  const f = adviceFleet();
  f.am.sessionPins.set(SESSION, 'b', f.clock.t);
  capOut(f.am, 1);
  const advice = f.am.sessionAdvice(SESSION, f.clock.t);
  assert.equal(advice.reason, 'pinned-unavailable');
  assert.equal(advice.context, null);
  assert.equal(advice.recommendation?.reread, null);
  assert.ok(advice.recommendation?.to);
});

test('a context over the ceiling holds the advice, priced on the main conversation (AC3)', () => {
  const f = adviceFleet({ advice: { enabled: true, maxContextTokens: 100_000 } });
  request(f, 'main', OPUS, 0, 120_000);
  pushOut(f.am);
  assert.deepEqual(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'context-over-ceiling', '(1)');

  f.clock.t += 1_000;
  request(f, 'sub', OPUS, 0, 400); // a later, smaller subagent in the same bucket
  const advice = f.am.sessionAdvice(SESSION, f.clock.t);
  assert.deepEqual([advice.reason, advice.context], ['context-over-ceiling', 120_000], '(2)');
});

test('a conversation restored across a restart shows its pin and no context until it reports one', () => {
  const before = fleet({ accounts: affinityAccounts() });
  request(before, 'x', OPUS, 1, 90_000);
  const after = fleet({ accounts: affinityAccounts(), start: before.clock.t + 60_000 });
  after.am.restoreAffinityState(JSON.parse(JSON.stringify(before.am.exportAffinityState())));
  assert.deepEqual(after.am.sessionAccount(SESSION, after.clock.t), {
    shown: { index: 1, name: 'b', via: 'affinity' },
    cost: { model: null, bucket: 'unified7d', context: null },
    served: 1,
  }, 'the saved snapshot carries the pin, not the model or the token figures');
  request(after, 'x', OPUS, 1, 91_000);
  assert.deepEqual(after.am.sessionAccount(SESSION, after.clock.t)?.cost, { model: OPUS, bucket: 'unified7d', context: 91_000 });
});

test('a restored conversation is placed in the bucket of its newest pin, not the shared one', () => {
  const before = fleet({ accounts: affinityAccounts() });
  request(before, 'x', SONNET, 2, 90_000);
  const after = fleet({ accounts: affinityAccounts(), start: before.clock.t + 60_000 });
  after.am.restoreAffinityState(JSON.parse(JSON.stringify(before.am.exportAffinityState())));
  assert.deepEqual(after.am.sessionAccount(SESSION, after.clock.t), {
    shown: { index: 2, name: 'c', via: 'affinity' },
    cost: { model: null, bucket: 'unified7dSonnet', context: null },
    served: 2,
  });
});

test('a restored conversation with no context is judged without the ceiling and re-reads an unknown amount', () => {
  const advice = { enabled: true, maxContextTokens: 1_000 };
  const before = adviceFleet({ advice });
  const after = adviceFleet({ advice, start: before.clock.t + 60_000 });
  for (const f of [before, after]) f.am.accounts.forEach((a, i) => { a.id = `id-${i}`; });
  request(before, 'main', OPUS, 0, 50_000);
  after.am.restoreAffinityState(JSON.parse(JSON.stringify(before.am.exportAffinityState())));
  pushOut(after.am);
  const answer = after.am.sessionAdvice(SESSION, after.clock.t);
  assert.deepEqual([answer.account, answer.context, answer.reason], ['a', null, 'out-of-band']);
  assert.equal(answer.recommendation?.reread, null);
});

test('a restored conversation whose model would decide the destination names none', () => {
  /** @param {string} model @param {any} [opts] */
  const restored = (model, opts = {}) => {
    const before = adviceFleet(opts);
    const after = adviceFleet({ ...opts, start: before.clock.t + 60_000 });
    for (const f of [before, after]) f.am.accounts.forEach((a, i) => { a.id = `id-${i}`; });
    request(before, 'main', model, 0, 50_000);
    after.am.restoreAffinityState(JSON.parse(JSON.stringify(before.am.exportAffinityState())));
    pushOut(after.am);
    return after.am.sessionAdvice(SESSION, after.clock.t);
  };
  assert.equal(restored(OPUS).reason, 'out-of-band', 'the shared bucket, no routes: the model changes nothing');
  assert.deepEqual([restored(SONNET).reason, restored(SONNET).recommendation], ['no-destination', null], 'a family bucket');
  const routes = [{ match: ['*opus*'], accounts: ['a', 'b'] }];
  assert.equal(restored(OPUS, { routes }).reason, 'no-destination', 'a route could exclude the destination');
});

test('a later side conversation in another bucket does not change the account shown (AC3)', () => {
  const f = adviceFleet();
  request(f, 'main', OPUS, 0, 20_000);
  f.clock.t += 1_000;
  request(f, 'side', SONNET, 2, 50);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).account, 'a', '(3)');
});

test('a move or a decline holds the session\'s advice for cooldownMinutes, and only that session\'s (AC4)', () => {
  const OTHER = '9d0e4c11-0000-4000-8000-000000000002';
  const f = adviceFleet({ advice: { enabled: true, cooldownMinutes: 30 } });
  request(f, 'main', OPUS, 0, 1_000);
  request(f, 'main', OPUS, 0, 1_000, OTHER);
  pushOut(f.am);
  assert.equal(f.am.noteAdviceCooldown(SESSION, f.clock.t), true);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'cooldown');
  assert.equal(f.am.sessionAdvice(OTHER, f.clock.t).reason, 'out-of-band', 'another session is not held');
  f.clock.t += 30 * 60_000 - 1;
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'cooldown');
  f.clock.t += 1;
  request(f, 'main', OPUS, 0, 1_000); // the session is still alive past the cooldown
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'out-of-band');
});

test('with the feature off nothing is held and every session answers disabled (AC4)', () => {
  const f = adviceFleet({ advice: null });
  request(f, 'main', OPUS, 0, 1_000);
  pushOut(f.am);
  assert.equal(f.am.noteAdviceCooldown(SESSION, f.clock.t), false);
  assert.equal(f.am.adviceCooldowns.size, 0);
  const advice = f.am.sessionAdvice(SESSION, f.clock.t);
  assert.deepEqual([advice.reason, advice.recommendation, advice.account], ['disabled', null, 'a']);
  assert.deepEqual(advice.advice, { enabled: false, ask: false });
});

test('the ask flag is carried only when it is a literal true (AC10)', () => {
  assert.equal(adviceFleet({ advice: { enabled: true, ask: true } }).am.sessionAdvice(SESSION).advice.ask, true);
  assert.equal(adviceFleet({ advice: { enabled: true, ask: 'yes' } }).am.sessionAdvice(SESSION).advice.ask, false);
});

test('a reload applies the advice block in place', () => {
  const f = adviceFleet({ advice: null });
  request(f, 'main', OPUS, 0, 1_000);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'disabled');
  f.am.setSessionAdvice(ADVICE_ON);
  assert.equal(f.am.sessionAdvice(SESSION, f.clock.t).reason, 'in-band');
});
