// distributeSessions "surplus": the load mode, except that an account spending
// a weekly window faster than a straight line to its limit waits behind the
// accounts that are not. Expected picks are worked out by hand from that rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, distributionMode } from '../src/account-manager.js';

const H = 3600_000;
const START = Date.parse('2026-01-01T00:00:00Z');
const SONNET = 'claude-sonnet-5';
const FABLE = 'claude-fable-5';

function freezeClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
}

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function fleet(accounts, opts = {}, threshold = 0.98) {
  const am = new AccountManager(accounts.map(a => (typeof a === 'string' ? oauth(a) : a)), threshold, { distributeSessions: 'surplus', ...opts });
  for (const a of am.accounts) a.probing = false;
  return am;
}

// A weekly window `used` now, resetting `hours` from now (null: no reset time).
function weekly(am, index, used, hours, key = 'unified7d') {
  const q = am.accounts[index].quota;
  q[key] = used;
  q[`${key}Reset`] = hours == null ? null : Date.now() + hours * H;
}

function busy(am, index, requests) {
  for (let i = 0; i < requests; i++) am.sessionTracker.noteRouted(index);
}

const place = (am, model = null) => am.getActiveAccount(null, model, null, 'new').name;

test('distributionMode: "surplus" is its own mode', () => {
  assert.equal(distributionMode('surplus'), 'surplus');
  assert.equal(distributionMode(' Surplus'), 'surplus');
  assert.equal(fleet(['a']).distributionMode, 'surplus');
});

// Half the week gone (84 h to the reset): the straight line to a 0.98 threshold
// stands at 0.49. A at 0.6 is ahead of it, B at 0.3 is not.
test('an account ahead of its weekly course waits behind one that is not, whatever the load', t => {
  freezeClock(t);
  const am = fleet(['a', 'b']);
  weekly(am, 0, 0.6, 84);
  weekly(am, 1, 0.3, 84);
  busy(am, 1, 50);
  assert.equal(place(am), 'b');
});

test('the load mode is unchanged: the same fleet goes by requests alone', t => {
  freezeClock(t);
  const am = fleet(['a', 'b'], { distributeSessions: 'load' });
  weekly(am, 0, 0.6, 84);
  weekly(am, 1, 0.3, 84);
  // A holds more sessions, B more requests: only a request count picks A.
  am.recordSession('s-a1', 0); am.recordSession('s-a2', 0);
  am.recordSession('s-b', 1); busy(am, 1, 50);
  assert.equal(place(am), 'a');
});

test('when every account is ahead, the load order decides', t => {
  freezeClock(t);
  const am = fleet(['a', 'b']);
  weekly(am, 0, 0.7, 84);
  weekly(am, 1, 0.6, 84);
  // A holds more sessions, B more requests: requests decide, as in load.
  am.recordSession('s-a1', 0); am.recordSession('s-a2', 0);
  am.recordSession('s-b', 1); busy(am, 1, 50);
  assert.equal(place(am), 'a');
});

test('a window with no reading, no reset time, or a clock outside one week is never held back', t => {
  freezeClock(t);
  for (const [used, hours] of [[null, 84], [0.6, null], [NaN, 84], [0.6, 169]]) {
    const am = fleet(['a', 'b']);
    weekly(am, 0, used, hours);
    weekly(am, 1, 0.3, 84);
    busy(am, 1, 50);
    assert.equal(place(am), 'a', `used ${used}, reset in ${hours} h`);
  }
});

test('the line is drawn from the window\'s first instant, and only spend above it is ahead', t => {
  freezeClock(t);
  // A window opening now has a line at 0, so any spend is ahead; spend exactly
  // on the line (0.49 halfway) is not.
  for (const [used, hours, expected] of [[0.01, 168, 'b'], [0.49, 84, 'a']]) {
    const am = fleet(['a', 'b']);
    weekly(am, 0, used, hours);
    weekly(am, 1, 0.1, 84);
    busy(am, 1, 50);
    assert.equal(place(am), expected, `used ${used}, reset in ${hours} h`);
  }
});

test('the limit is the lower of the switch threshold and the maxUsage cap', t => {
  freezeClock(t);
  // At 0.3 halfway, A is behind a 0.98 line (0.49) but ahead of a 0.5 cap's (0.25).
  for (const [extra, expected] of [[{}, 'a'], [{ maxUsage: 0.5 }, 'b'], [{ switchThreshold: 0.5 }, 'b']]) {
    const am = fleet([oauth('a', extra), 'b']);
    weekly(am, 0, 0.3, 84);
    weekly(am, 1, 0.1, 84);
    busy(am, 1, 50);
    assert.equal(place(am), expected, JSON.stringify(extra));
  }
});

test('the threshold is the requested family\'s, even when its window falls back to the shared weekly', t => {
  freezeClock(t);
  // No Sonnet window, so the shared weekly governs: 0.4 halfway is behind the
  // fleet's 0.49 line and ahead of the Sonnet threshold's 0.3.
  const am = fleet(['a', 'b'], {}, { default: 0.98, unified7dSonnet: 0.6 });
  weekly(am, 0, 0.4, 84);
  weekly(am, 1, 0.1, 84);
  busy(am, 1, 50);
  assert.equal(place(am, SONNET), 'b');
  assert.equal(place(am), 'a', 'an unrouted request reads the default threshold');
});

test('a family window on course does not hide a shared weekly ahead of its own', t => {
  freezeClock(t);
  const am = fleet(['a', 'b']);
  // A's Fable window: 0.6 with a day left, well behind its line. Its shared
  // weekly: 0.5 with six days left, ahead of a line at 0.14.
  weekly(am, 0, 0.6, 24, 'unified7dFable');
  weekly(am, 0, 0.5, 144);
  weekly(am, 1, 0.1, 84, 'unified7dFable');
  weekly(am, 1, 0.1, 84);
  busy(am, 1, 50);
  assert.equal(place(am, FABLE), 'b');
});

test('a shared weekly on course does not hide a family window ahead of its own', t => {
  freezeClock(t);
  const am = fleet(['a', 'b']);
  // A's Fable window: 0.5 with six days left, ahead of a line at 0.14. Its
  // shared weekly: 0.6 with a day left, behind its line at 0.84.
  weekly(am, 0, 0.5, 144, 'unified7dFable');
  weekly(am, 0, 0.6, 24);
  weekly(am, 1, 0.1, 84, 'unified7dFable');
  weekly(am, 1, 0.1, 84);
  busy(am, 1, 50);
  assert.equal(place(am, FABLE), 'b');
});

test('a family window is limited by the room its shared weekly cap leaves', t => {
  freezeClock(t);
  // A's shared weekly sits at 0.7 under a 0.9 cap, a day left: behind its line
  // (0.77). The cap leaves the Fable window 0.3 + 0.2 = 0.5, whose line halfway
  // is 0.25, so A's Fable window at 0.3 is ahead; on the 0.98 threshold alone
  // it would not be (0.49).
  const am = fleet([oauth('a', { maxUsage: { unified7d: 0.9 } }), 'b']);
  weekly(am, 0, 0.3, 84, 'unified7dFable');
  weekly(am, 0, 0.7, 24);
  weekly(am, 1, 0.1, 84, 'unified7dFable');
  weekly(am, 1, 0.1, 84);
  busy(am, 1, 50);
  assert.equal(place(am, FABLE), 'b');
});

test('priority still outranks the course', t => {
  freezeClock(t);
  const am = fleet([oauth('a', { priority: 0 }), oauth('b', { priority: 1 })]);
  weekly(am, 0, 0.6, 84);
  weekly(am, 1, 0.3, 84);
  assert.equal(place(am), 'a');
});

test('inside the expiry-routing band the course still decides', t => {
  freezeClock(t);
  const am = fleet(['a', 'b'], { expiryRouting: { enabled: true, tolerance: 100 } });
  weekly(am, 0, 0.6, 84);
  weekly(am, 1, 0.3, 84);
  // B carries more of everything the load keys count.
  am.recordSession('s-b1', 1); am.recordSession('s-b2', 1); busy(am, 1, 50);
  assert.equal(place(am), 'b');
});

test('the band and its floor come before the course', t => {
  freezeClock(t);
  // Band: B, capped at 0.1 and on its line, has a seventh of A's pressure, so a
  // tolerance of 2 leaves only A, which is ahead.
  const banded = fleet(['a', oauth('b', { maxUsage: 0.1 })], { expiryRouting: { enabled: true, tolerance: 2 } });
  weekly(banded, 0, 0.6, 84);
  weekly(banded, 1, 0.05, 84);
  assert.equal(place(banded), 'a');
  // Floor: A has no reset time, so it is not ahead, but at 0.95 its bound sits
  // under the floor; B is ahead and above it, and the floor decides first.
  const floored = fleet(['a', 'b'], { expiryRouting: { enabled: true, tolerance: 2 } });
  weekly(floored, 0, 0.95, null);
  weekly(floored, 1, 0.6, 84);
  busy(floored, 1, 50);
  assert.equal(place(floored), 'b');
});

test('a rollover move under preempt goes behind the course too', t => {
  freezeClock(t);
  const am = fleet(['a', 'b'], { expiryRouting: { enabled: true, tolerance: 1000, preempt: true } });
  weekly(am, 0, 0.3, 1);
  weekly(am, 1, 0.3, 84);
  busy(am, 1, 50);
  am.recordSession('s-1', 0);
  // A's window rolls and its new week opens spent: ahead of a line near 0.
  weekly(am, 0, 0.2, 167);
  assert.equal(am.getActiveAccount(null, null, null, 's-1').name, 'b');
});

test('a placed session keeps its pin when its account falls ahead of course', t => {
  freezeClock(t);
  const am = fleet(['a', 'b']);
  weekly(am, 0, 0.3, 84);
  weekly(am, 1, 0.3, 84);
  busy(am, 1, 5);
  const first = am.getActiveAccount(null, null, null, 's-1');
  am.recordSession('s-1', first.index);
  assert.equal(first.name, 'a');
  weekly(am, 0, 0.7, 84);
  assert.equal(am.getActiveAccount(null, null, null, 's-1').name, 'a');
});
