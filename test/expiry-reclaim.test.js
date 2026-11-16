import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { validateAdaptiveConfig } from '../src/adaptive-distribution.js';

// The reclaim window (expiryRouting.reclaimHours, #643). Expiry pressure places
// new conversations on the account whose weekly quota is about to expire and
// leaves a pinned one alone. With a window set, a conversation pinned outside
// the top pressure band moves to an account inside it whose deadline falls
// within that many hours. Off by default, and off means the pin path is the
// one the router had before.

const H = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const ORG = 'org-one';
// Every fixture and every read below is taken against this one instant, frozen
// per test, so a deadline is inside or outside the window by construction and
// not by how long the run took.
const START = Date.parse('2030-03-10T12:00:00Z');

/** @param {import('node:test').TestContext} t */
function freezeClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
}

/** @param {string} name @param {Record<string, any>} [extra] */
function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: START + 1000 * H, orgUuid: ORG, ...extra };
}

/** `used` of a weekly bucket spent, its window resetting `hours` from START.
 * @param {AccountManager} am @param {number} index @param {number} used @param {number|null} hours */
function weekly(am, index, used, hours, key = 'unified7d') {
  Object.assign(am.accounts[index].quota, { [key]: used, [`${key}Reset`]: hours == null ? null : START + hours * H });
}

/** Run `fn` with console.log captured, returning its result and what was logged.
 * @template T @param {() => T} fn @returns {{ result: T, lines: string[] }} */
function logged(fn) {
  const original = console.log;
  /** @type {string[]} */
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { return { result: fn(), lines }; } finally { console.log = original; }
}

/** One complete request for `sessionId`, in the order the server does it:
 * select, record where it was sent, end. Returns the account's name.
 * @param {AccountManager} am @param {string} sessionId */
function serve(am, sessionId, model = OPUS) {
  return logged(() => {
    am.beginSession(sessionId);
    const account = am.getActiveAccount(null, model, null, sessionId);
    if (account) am.recordSession(sessionId, account.index, model);
    am.endSession(sessionId);
    return account?.name ?? null;
  }).result;
}

const RECLAIM = { enabled: true, tolerance: 1.5, reclaimHours: 6 };

/**
 * The fleet of the issue: `p` holds a conversation and is far from its reset,
 * `a` has most of its week unspent and resets in three hours. `a` is the band
 * by itself, so a new conversation goes there and the pinned one, on master,
 * never does.
 * @param {Record<string, any>|undefined} expiryRouting
 * @param {{ p?: Record<string, any>, a?: Record<string, any>, options?: Record<string, any>, model?: string }} [shape]
 */
function fleet(expiryRouting, { p = {}, a = {}, options = {}, model = OPUS } = {}) {
  const am = new AccountManager([oauth('p', p), oauth('a', a)], 0.98, { distributeSessions: true, expiryRouting, ...options });
  weekly(am, 0, 0.5, 100);
  weekly(am, 1, 0.2, 3);
  // The affinity pin, as a request served by `p` leaves it.
  am.recordSession('s1', 0, model);
  return am;
}

test('with the window off a pinned conversation stays, while new ones go to the expiring account', (t) => {
  freezeClock(t);
  for (const reclaimHours of [undefined, 0, -3, '6', NaN, Infinity, null, true]) {
    const am = fleet({ enabled: true, tolerance: 1.5, reclaimHours });
    assert.equal(am.expiryRouting.reclaimHours, 0, `reclaimHours: ${String(reclaimHours)}`);
    for (let i = 0; i < 4; i++) assert.equal(serve(am, 's1'), 'p', `reclaimHours: ${String(reclaimHours)}`);
    assert.equal(serve(am, 'fresh'), 'a');
  }
});

test('a window does nothing while expiry routing itself is off', (t) => {
  freezeClock(t);
  const am = fleet({ enabled: false, reclaimHours: 6 });
  assert.equal(serve(am, 's1'), 'p');
});

test('inside the window the conversation moves once to the expiring account, then stays', (t) => {
  freezeClock(t);
  for (const preempt of [true, false]) {
    const am = fleet({ ...RECLAIM, preempt });
    const { result, lines } = logged(() => am.getActiveAccount(null, OPUS, null, 's1'));
    assert.equal(result?.name, 'a', `preempt: ${preempt}`);
    const moves = lines.filter(l => l.includes('reclaim'));
    assert.equal(moves.length, 1);
    assert.match(moves[0], /Session pin on "p" released — reclaim: the weekly quota of "a" expires in 3\.0h \(expiryRouting\.reclaimHours\); re-routing to "a"/);
    // Selecting moved nothing yet: the pin follows the route, as for any move.
    assert.equal(am.sessionTracker.pinnedAccount('s1', 'unified7d'), 0);
    am.recordSession('s1', 1, OPUS);
    assert.equal(am.sessionTracker.pinnedAccount('s1', 'unified7d'), 1);
    for (let i = 0; i < 4; i++) {
      const again = logged(() => am.getActiveAccount(null, OPUS, null, 's1'));
      assert.equal(again.result?.name, 'a');
      assert.deepEqual(again.lines.filter(l => l.includes('reclaim')), []);
    }
  }
});

test('the move paces the destination with the storm ramp', (t) => {
  freezeClock(t);
  const am = fleet(RECLAIM, { options: { ramp: { enabled: true } } });
  assert.equal(am.accounts[1].rampStartedAt, null);
  assert.equal(serve(am, 's1'), 'a');
  assert.equal(am.accounts[1].rampStartedAt, START);
});

test('outside the window it stays, and moves once the clock brings the deadline inside', (t) => {
  freezeClock(t);
  const am = fleet({ ...RECLAIM, reclaimHours: 2 });
  assert.equal(serve(am, 's1'), 'p');
  t.mock.timers.setTime(START + 0.5 * H);
  assert.equal(serve(am, 's1'), 'p');
  // 1 h 59 m before the reset.
  t.mock.timers.setTime(START + 1 * H + 60_000);
  assert.equal(serve(am, 's1'), 'a');
});

test('a deadline that has passed is not one to reclaim', (t) => {
  freezeClock(t);
  const am = fleet(RECLAIM);
  // A second account keeps the band from collapsing onto the one candidate.
  weekly(am, 1, 0.2, -1);
  assert.equal(serve(am, 's1'), 'p');
});

test('an expiring account at its switch threshold takes no reclaimed conversation', (t) => {
  freezeClock(t);
  const five = fleet(RECLAIM);
  Object.assign(five.accounts[1].quota, { unified5h: 0.99, unified5hReset: START + 2 * H });
  assert.equal(serve(five, 's1'), 'p');
  // The 5-hour window resets, and the account takes it.
  Object.assign(five.accounts[1].quota, { unified5h: 0, unified5hReset: START + 5 * H });
  assert.equal(serve(five, 's1'), 'a');

  const week = fleet(RECLAIM);
  weekly(week, 1, 0.99, 3);
  assert.equal(serve(week, 's1'), 'p');
});

test('an expiring account at its maxUsage cap, cordoned or disabled takes none', (t) => {
  freezeClock(t);
  const capped = fleet(RECLAIM, { a: { maxUsage: 0.2 } });
  assert.equal(serve(capped, 's1'), 'p');

  const cordoned = fleet(RECLAIM);
  cordoned.setCordoned(1, true);
  assert.equal(serve(cordoned, 's1'), 'p');
  cordoned.setCordoned(1, false);
  assert.equal(serve(cordoned, 's1'), 'a');

  const disabled = fleet(RECLAIM, { a: { disabled: true } });
  assert.equal(serve(disabled, 's1'), 'p');
});

test('a different priority is left to the priority rule', (t) => {
  freezeClock(t);
  // A last-resort account about to expire does not pull a conversation down.
  const lower = fleet(RECLAIM, { a: { priority: 1 } });
  assert.equal(serve(lower, 's1'), 'p');
  // A better priority outranks the pin with the window off, exactly as with it on.
  for (const reclaimHours of [0, 6]) {
    const higher = fleet({ ...RECLAIM, reclaimHours }, { p: { priority: 1 } });
    const { result, lines } = logged(() => higher.getActiveAccount(null, OPUS, null, 's1'));
    assert.equal(result?.name, 'a');
    assert.deepEqual(lines.filter(l => l.includes('reclaim')), [], 'not a reclaim');
  }
});

test('a lower-priority account in the window is not a destination while a peer leads the band', (t) => {
  freezeClock(t);
  // `b` leads the band from another organization, so `p` is outside it, and the
  // only account inside the window is a last resort the band passes through.
  const am = new AccountManager([oauth('p'), oauth('b', { orgUuid: 'elsewhere' }), oauth('a', { priority: 1 })], 0.98,
    { distributeSessions: true, expiryRouting: RECLAIM });
  weekly(am, 0, 0.5, 100);
  weekly(am, 1, 0.2, 3);
  weekly(am, 2, 0.2, 3);
  am.recordSession('s1', 0, OPUS);
  assert.equal(serve(am, 's1'), 'p');
  // At the pinned account's priority the same account takes it.
  am.accounts[2].priority = 0;
  assert.equal(serve(am, 's1'), 'a');
});

test('fiveHourSoftMargin keeps a reclaim off an account it keeps new conversations off', (t) => {
  freezeClock(t);
  const options = { distributeSessions: 'adaptive', adaptive: validateAdaptiveConfig({ scoring: 'pressure', fiveHourSoftMargin: 0.15 }) };
  const am = fleet(RECLAIM, { options });
  Object.assign(am.accounts[1].quota, { unified5h: 0.9, unified5hReset: START + 2 * H });
  assert.equal(serve(am, 's1'), 'p');
  Object.assign(am.accounts[1].quota, { unified5h: 0.8, unified5hReset: START + 2 * H });
  assert.equal(serve(am, 's1'), 'a');
});

test('accounts of different or unknown organizations do not trade a conversation', (t) => {
  freezeClock(t);
  /** @type {Array<[string, Record<string, any>, Record<string, any>]>} */
  const cases = [
    ['different uuid', { orgUuid: 'org-one' }, { orgUuid: 'org-two' }],
    ['different name', { orgUuid: undefined, orgName: 'One' }, { orgUuid: undefined, orgName: 'Two' }],
    ['unknown on the pinned side', { orgUuid: undefined }, {}],
    ['unknown on the expiring side', {}, { orgUuid: undefined }],
    ['unknown on both', { orgUuid: undefined }, { orgUuid: undefined }],
    ['a uuid against a name', { orgUuid: 'org-one' }, { orgUuid: undefined, orgName: 'org-one' }],
  ];
  for (const [label, p, a] of cases) {
    assert.equal(serve(fleet(RECLAIM, { p, a }), 's1'), 'p', label);
    assert.equal(serve(fleet({ ...RECLAIM, reclaimAcrossOrganizations: true }, { p, a }), 's1'), 'a', `${label}, across organizations`);
  }
  // One organization known by name on both sides is one organization.
  const named = { orgUuid: undefined, orgName: 'One' };
  assert.equal(serve(fleet(RECLAIM, { p: named, a: named }), 's1'), 'a');
});

test('reclaimAcrossOrganizations takes only a literal true', (t) => {
  freezeClock(t);
  for (const value of [undefined, null, 'true', 1, {}]) {
    const am = fleet({ ...RECLAIM, reclaimAcrossOrganizations: value }, { a: { orgUuid: 'org-two' } });
    assert.equal(am.expiryRouting.reclaimAcrossOrganizations, false);
    assert.equal(serve(am, 's1'), 'p', `reclaimAcrossOrganizations: ${String(value)}`);
  }
});

test('a conversation whose own account is in the band stays', (t) => {
  freezeClock(t);
  // A tolerance wide enough to admit both.
  const wide = fleet({ ...RECLAIM, tolerance: 1000 });
  assert.equal(serve(wide, 's1'), 'p');
  // No reading is admitted to the band for discovery, so it stays there too.
  const unread = fleet(RECLAIM);
  weekly(unread, 0, 0.5, null);
  assert.equal(serve(unread, 's1'), 'p');
});

test('an expiring account with no reading is not a reason to move', (t) => {
  freezeClock(t);
  // In the band for discovery, with an end time inside the window and nothing
  // measured. A third account gives the band a pressure to exclude `p` on.
  const am = new AccountManager([oauth('p'), oauth('a', { endsAt: START + 3 * H }), oauth('c', { orgUuid: 'elsewhere' })], 0.98,
    { distributeSessions: true, expiryRouting: RECLAIM });
  weekly(am, 0, 0.5, 100);
  weekly(am, 2, 0.2, 3);
  am.recordSession('s1', 0, OPUS);
  assert.equal(serve(am, 's1'), 'p');
});

test('a move is only toward the sooner deadline, so two expiring accounts never trade a conversation back', (t) => {
  freezeClock(t);
  // Both inside the window. `p` resets first with little left; `a` has far the
  // higher pressure and is the band alone.
  const am = fleet(RECLAIM);
  weekly(am, 0, 0.9, 2);
  assert.equal(serve(am, 's1'), 'p');

  // The other way round the conversation moves, and then cannot come back even
  // once the account it left is the band alone.
  const back = fleet(RECLAIM);
  weekly(back, 0, 0.2, 5);
  weekly(back, 1, 0.2, 1);
  assert.equal(serve(back, 's1'), 'a');
  weekly(back, 1, 0.95, 1);
  assert.deepEqual(back._bandedCandidates(null, OPUS, null).map(x => x.name), ['p'], 'the fixture: p is now the band alone');
  for (let i = 0; i < 3; i++) assert.equal(serve(back, 's1'), 'a');
});

test('several expiring accounts: the conversation goes where a new one would be placed', (t) => {
  freezeClock(t);
  for (const mode of ['even', 'adaptive', 'load']) {
    const am = new AccountManager([oauth('p'), oauth('a1'), oauth('a2')], 0.98, { distributeSessions: mode, expiryRouting: RECLAIM });
    weekly(am, 0, 0.5, 100);
    weekly(am, 1, 0.2, 3);
    weekly(am, 2, 0.2, 3);
    am.recordSession('s1', 0, OPUS);
    // Load on a1, so placement prefers a2.
    for (const id of ['x1', 'x2', 'x3']) { am.beginSession(id); am.recordSession(id, 1, OPUS); }
    const placed = logged(() => am.getActiveAccount(null, OPUS, null, 'fresh')).result;
    assert.equal(placed?.name, 'a2', mode);
    assert.equal(serve(am, 's1'), 'a2', mode);
  }
});

test('an account the routes keep off the model takes no reclaimed conversation of it', (t) => {
  freezeClock(t);
  const routes = [{ name: 'opus', match: ['claude-opus*'], accounts: ['p'] }];
  const am = fleet(RECLAIM, { options: { routes } });
  assert.equal(serve(am, 's1'), 'p');
  // The same fleet without the route: the fixture could have moved.
  assert.equal(serve(fleet(RECLAIM), 's1'), 'a');
});

test('a manual route pin is not moved', (t) => {
  freezeClock(t);
  const routes = [{ name: 'opus', match: ['claude-opus*'], accounts: ['p', 'a'] }];
  const am = fleet(RECLAIM, { options: { routes } });
  am.setRoutePin('opus', 0);
  for (let i = 0; i < 3; i++) assert.equal(serve(am, 's1'), 'p');
  am.clearRoutePin('opus');
  assert.equal(serve(am, 's1'), 'a');
});

test('the window is read on the weekly bucket that governs the request', (t) => {
  freezeClock(t);
  // The shared weekly is far from its reset on both; only the Fable bucket of
  // `a` is about to expire.
  const am = new AccountManager([oauth('p'), oauth('a')], 0.98, { distributeSessions: true, expiryRouting: RECLAIM });
  weekly(am, 0, 0.5, 120);
  weekly(am, 1, 0.2, 100);
  weekly(am, 0, 0.5, 120, 'unified7dFable');
  weekly(am, 1, 0.1, 3, 'unified7dFable');
  am.recordSession('s1', 0, OPUS);
  am.recordSession('s1', 0, FABLE);
  assert.equal(serve(am, 's1', OPUS), 'p');
  assert.equal(serve(am, 's1', FABLE), 'a');
  // The Opus pin is its own, and is still where it was.
  assert.equal(serve(am, 's1', OPUS), 'p');
});

test('an end time inside the window reclaims like a weekly reset', (t) => {
  freezeClock(t);
  for (const [reclaimHours, expected] of /** @type {Array<[number, string]>} */ ([[0, 'p'], [2, 'p'], [6, 'a']])) {
    const am = fleet({ ...RECLAIM, reclaimHours }, { a: { endsAt: START + 3 * H } });
    // The weekly reset alone is far outside any of these windows.
    weekly(am, 1, 0.2, 90);
    assert.equal(serve(am, 's1'), expected, `reclaimHours: ${reclaimHours}`);
  }
});

test('an end time on the pinned account counts as its deadline', (t) => {
  freezeClock(t);
  // `p` ends before `a` resets, with little left: out of the band, and the
  // sooner deadline, so the conversation spends what `p` has.
  const am = fleet(RECLAIM, { p: { endsAt: START + 2 * H } });
  weekly(am, 0, 0.9, 100);
  assert.equal(serve(am, 's1'), 'p');
});

test('the window hot-applies on reload, on and off', (t) => {
  freezeClock(t);
  const am = fleet({ enabled: true, tolerance: 1.5 });
  am.recordSession('s2', 0, OPUS);
  assert.equal(serve(am, 's1'), 'p');
  am.setExpiryRouting(RECLAIM);
  assert.equal(am.getStatus().expiryRouting.reclaimHours, 6);
  assert.equal(serve(am, 's1'), 'a');
  am.setExpiryRouting({ enabled: true, tolerance: 1.5 });
  assert.equal(am.getStatus().expiryRouting.reclaimHours, 0);
  assert.equal(serve(am, 's2'), 'p');
  // What already moved is pinned where it went, and stays.
  assert.equal(serve(am, 's1'), 'a');
});

test('a reclaimed conversation leaves at the threshold like any pinned one, and stays off while the account is unavailable', (t) => {
  freezeClock(t);
  const am = fleet(RECLAIM);
  assert.equal(serve(am, 's1'), 'a');
  Object.assign(am.accounts[1].quota, { unified5h: 0.99, unified5hReset: START + 2 * H });
  assert.equal(serve(am, 's1'), 'p');
  assert.equal(serve(am, 's1'), 'p');
});

test('with distribution off there is no pin to reclaim', (t) => {
  freezeClock(t);
  const am = fleet(RECLAIM, { options: { distributeSessions: false } });
  // The cursor starts on `p`, and a window does not move it.
  assert.equal(am.accounts[am.currentIndex].name, 'p');
  for (let i = 0; i < 3; i++) assert.equal(serve(am, 's1'), 'p');
});

// ---------------------------------------------------------------------------
// Through the server: an operator's pin resolves before affinity is read.
// ---------------------------------------------------------------------------

const listen = (/** @type {any} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const SESSION = '3f2a1b9c-0000-4000-8000-0000000006a3';

test('a session pin and a /tc-acct/ pin are never reclaimed', async () => {
  /** @type {string[]} */
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(/** @type {string} */ (req.headers['x-api-key']));
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const key = (/** @type {string} */ name) => ({ name, type: 'apikey', apiKey: `key-${name}`, orgUuid: ORG });
  const am = new AccountManager([key('p'), key('a')], 0.98, { distributeSessions: true, expiryRouting: RECLAIM });
  // Far enough either side of the window that the run's own duration is nothing.
  Object.assign(am.accounts[0].quota, { unified7d: 0.5, unified7dReset: Date.now() + 100 * H });
  Object.assign(am.accounts[1].quota, { unified7d: 0.2, unified7dReset: Date.now() + 3 * H });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const message = (prefix = '') => fetch(`http://127.0.0.1:${port}${prefix}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': SESSION },
    body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  }).then(r => r.text());
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    am.sessionPins.set(SESSION, 'p');
    for (let i = 0; i < 3; i++) await message();
    assert.deepEqual(seen, ['key-p', 'key-p', 'key-p'], 'the session pin holds');
    am.sessionPins.set(SESSION, null);
    seen.length = 0;
    for (let i = 0; i < 3; i++) await message('/tc-acct/p');
    assert.deepEqual(seen, ['key-p', 'key-p', 'key-p'], 'the /tc-acct/ pin holds');
    // Left to affinity, the same conversation is reclaimed: the pins above were
    // what held it.
    seen.length = 0;
    await message();
    await message();
    assert.deepEqual(seen, ['key-a', 'key-a']);
  } finally {
    console.log = original.log;
    console.error = original.error;
    proxy.close();
    upstream.close();
  }
});
