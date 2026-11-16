import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// The waits in admit() are timers, so the tests that watch one run it on a
// mocked clock: nothing below waits on the machine. `mockClock` takes over
// setTimeout and Date for the test (node:test restores them when it ends), and
// `advance` moves that clock and then lets the admit() the timer woke run up to
// its next wait. setImmediate is left real for that reason. What an admit()
// resolved to is read from a variable its `then` sets, after an `advance`,
// rather than awaited: an admit that wrongly kept waiting would have nothing
// left to wake it, and a test awaiting it would end with the event loop.
const mockClock = (t) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
const settle = () => new Promise(resolve => setImmediate(resolve));
const advance = async (t, ms) => { t.mock.timers.tick(ms); await settle(); };

test('_rampCap grows linearly during the window and lifts after it', () => {
  const am = new AccountManager([oauth('a')], 0.98, {
    ramp: { startConc: 1, stepConc: 2, stepMs: 100, windowMs: 1000, pollMs: 5 },
  });
  const acct = am.accounts[0];

  assert.equal(am._rampCap(acct, 0), Infinity, 'no ramp until one starts');
  acct.rampStartedAt = 1000;
  assert.equal(am._rampCap(acct, 1000), 1, 'startConc at t=0');
  assert.equal(am._rampCap(acct, 1000 + 100), 3, '+stepConc after one step');
  assert.equal(am._rampCap(acct, 1000 + 250), 5, '+2*stepConc after two steps');
  assert.equal(am._rampCap(acct, 1000 + 1000), Infinity, 'unbounded past the window');
  assert.equal(acct.rampStartedAt, null, 'window expiry clears the ramp');
});

test('admit caps concurrency to a freshly-switched account; release frees a slot', async (t) => {
  mockClock(t);
  const am = new AccountManager([oauth('a')], 0.98, {
    ramp: { startConc: 1, stepConc: 1, stepMs: 10_000, windowMs: 60_000, pollMs: 5 },
  });
  am._beginRamp(am.accounts[0]); // cap pinned at 1 for the length of this test

  assert.equal(await am.admit(0), true);
  assert.equal(am.accounts[0].inFlight, 1);

  // A second request must wait — the cap is 1 and a slot is taken. It asks
  // isAborted before each look at the cap, so `checks` counts those looks: the
  // cap was read again after every poll below, and refused each time.
  let second = false;
  let checks = 0;
  am.admit(0, () => { checks++; return false; }).then(() => { second = true; });
  await settle();
  for (let polls = 1; polls <= 3; polls++) {
    await advance(t, 5);
    assert.equal(checks, polls + 1, 'the waiting admit looked at the cap again after a poll');
    assert.equal(second, false, 'second admit blocked by the ramp cap');
  }
  assert.equal(am.accounts[0].inFlight, 1, 'the blocked admit took no slot');

  am.release(0);       // free the slot
  await advance(t, 5);
  assert.equal(second, true, 'second admit proceeds once a slot frees');
  assert.equal(am.accounts[0].inFlight, 1);
});

test('admit is fail-open: aborts (returns false) if the client goes away while waiting', async (t) => {
  mockClock(t);
  const am = new AccountManager([oauth('a')], 0.98, {
    ramp: { startConc: 1, stepConc: 1, stepMs: 10_000, windowMs: 60_000, pollMs: 5 },
  });
  am._beginRamp(am.accounts[0]);
  await am.admit(0); // take the only slot

  let gone = false;
  /** @type {boolean|null} */
  let admitted = null;
  am.admit(0, () => gone).then((ok) => { admitted = ok; }); // waits: cap 1, inFlight 1
  await advance(t, 5);
  await advance(t, 5);
  assert.equal(admitted, null, 'the admit is still waiting on the cap while the client is there');
  gone = true;                        // client disconnects
  await advance(t, 5);                // the next poll is where it is noticed
  assert.equal(admitted, false, 'aborted admit returns false, takes no slot');
  assert.equal(am.accounts[0].inFlight, 1, 'no slot leaked to the aborted request');
});

test('ramp disabled → admit is immediate and unbounded', async () => {
  const am = new AccountManager([oauth('a')], 0.98, { ramp: { enabled: false } });
  am._beginRamp(am.accounts[0]);
  assert.equal(am.accounts[0].rampStartedAt, null, 'no ramp window when disabled');
  assert.equal(await am.admit(0), true);
  assert.equal(await am.admit(0), true);
  assert.equal(am.accounts[0].inFlight, 2, 'no concurrency cap when disabled');
});

test('switching to a new account begins a ramp on it', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.accounts[0].status = 'exhausted'; // force selection off the current (index 0)
  const next = am._selectNext();
  assert.equal(next.name, 'b');
  assert.ok(am.accounts[1].rampStartedAt != null, 'the switch armed a ramp on b');
});

test('release never drives inFlight negative', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.release(0);
  am.release(0);
  assert.equal(am.accounts[0].inFlight, 0);
});

// ── rate-limit pause (no-switch on 429) ───────────────────────

test('pauseAccount pauses without throttling — account stays selectable (no rotation)', () => {
  const am = new AccountManager([oauth('a')], 0.98, { ramp: { pollMs: 5 } });
  am.pauseAccount(0, 30);
  const acct = am.accounts[0];
  assert.ok(acct.pausedUntil > Date.now(), 'pausedUntil set');
  assert.notEqual(acct.status, 'throttled', 'pause must not throttle');
  assert.equal(acct.rateLimitedUntil, null, 'pause is not a rate-limit hold');
  assert.equal(am._isAvailable(acct, 'claude-opus-4-6'), true, 'account stays available → selection never rotates away');
});

test('pauseAccount extends an existing pause, never shortens it', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  am.pauseAccount(0, 30);
  const long = am.accounts[0].pausedUntil;
  am.pauseAccount(0, 1); // shorter — must not shorten
  assert.equal(am.accounts[0].pausedUntil, long);
});

// A Retry-After that did not parse reaches here as NaN (Math.max(NaN, 1) is
// NaN). A NaN pause would arm a NaN ramp, _rampCap would return NaN, and admit()
// would spin on `inFlight < NaN` forever.
test('pauseAccount and markRateLimited ignore a non-finite or non-positive duration', async () => {
  const am = new AccountManager([oauth('a')], 0.98, { ramp: { startConc: 1, stepConc: 1, stepMs: 10, windowMs: 100, pollMs: 5 } });
  const acct = am.accounts[0];
  for (const bad of [NaN, Infinity, -Infinity, 0, -5, undefined, 'soon']) {
    am.pauseAccount(0, bad);
    am.markRateLimited(0, bad);
  }
  assert.equal(acct.pausedUntil, null);
  assert.equal(acct.rampStartedAt, null);
  assert.equal(acct.rateLimitedUntil, null);
  assert.equal(acct.status, 'active');
  assert.equal(am._rampCap(acct), Infinity);
  assert.equal(await am.admit(0), true, 'admit is not stuck');
  am.release(0);

  am.markRateLimited(0, 30);
  assert.equal(acct.status, 'throttled', 'a real duration still holds');
});

test('admit holds a request during a pause, then admits once it lifts', async (t) => {
  mockClock(t);
  const am = new AccountManager([oauth('a')], 0.98, {
    ramp: { startConc: 10, stepConc: 1, stepMs: 10, windowMs: 60_000, pollMs: 5 },
  });
  am.accounts[0].pausedUntil = Date.now() + 120; // a 120 ms pause, on the mocked clock

  /** @type {boolean|null} */
  let admitted = null;
  am.admit(0).then((ok) => { admitted = ok; });
  // One millisecond at a time, so every wait admit() schedules inside the
  // pause (pollMs * 4, or what is left of the pause) comes due on the way.
  for (let ms = 1; ms < 120; ms++) await advance(t, 1);
  assert.equal(admitted, null, 'admit returned before the pause lifted');
  assert.equal(am.accounts[0].inFlight, 0, 'no slot is taken during the pause');

  await advance(t, 1); // the pause lifts
  assert.equal(admitted, true, 'admit did not return once the pause lifted');
  assert.equal(am.accounts[0].inFlight, 1);
});

test('admit aborts (returns false) if the client disconnects during a pause', async (t) => {
  mockClock(t);
  const am = new AccountManager([oauth('a')], 0.98, { ramp: { pollMs: 5 } });
  am.accounts[0].pausedUntil = Date.now() + 10_000; // long pause
  let gone = false;
  /** @type {boolean|null} */
  let admitted = null;
  am.admit(0, () => gone).then((ok) => { admitted = ok; });
  await advance(t, 20); // one wait inside the pause: pollMs * 4
  await advance(t, 20);
  assert.equal(admitted, null, 'the admit is still held by the pause while the client is there');
  gone = true;
  await advance(t, 20); // noticed at the next re-check, 9940 ms before the pause would lift
  assert.equal(admitted, false, 'aborted admit returns false');
  assert.equal(am.accounts[0].inFlight, 0, 'no slot taken');
});

test('pauseAccount arms the ramp at pause-end so held requests release staggered', () => {
  const am = new AccountManager([oauth('a')], 0.98, {
    ramp: { startConc: 1, stepConc: 1, stepMs: 250, windowMs: 30_000, pollMs: 5 },
  });
  am.pauseAccount(0, 30);
  const acct = am.accounts[0];
  // Ramp is armed to begin exactly when the pause lifts.
  assert.equal(acct.rampStartedAt, acct.pausedUntil);
  // At the instant the pause lifts, the cap starts low (staggered release).
  assert.equal(am._rampCap(acct, acct.pausedUntil), 1);
  assert.equal(am._rampCap(acct, acct.pausedUntil + 250), 2);
});

test('addAccount initializes storm-control fields so a runtime-added account can admit/release', async () => {
  const am = new AccountManager([oauth('a')], 0.98, {
    ramp: { startConc: 1, stepConc: 1, stepMs: 10_000, windowMs: 60_000, pollMs: 5 },
  });
  const idx = am.addAccount(oauth('b'));
  const acct = am.accounts[idx];

  // Regression: addAccount once omitted inFlight/rampStartedAt/pausedUntil, so
  // `undefined < cap` in admit() was always false and every request routed to a
  // runtime-added account hung forever (and release() was a silent no-op).
  assert.equal(acct.inFlight, 0);
  assert.equal(acct.rampStartedAt, null);
  assert.equal(acct.pausedUntil, null);

  assert.equal(await am.admit(idx), true, 'a fresh added account admits immediately (no ramp started yet)');
  assert.equal(acct.inFlight, 1);
  am.release(idx);
  assert.equal(acct.inFlight, 0, 'release frees the slot on a runtime-added account');
});

// ── stormRamp values the ramp cannot pace by ─────────────────────────────────
// `stormRamp` comes from the config file as written. A value nothing refused
// used to misbehave quietly: a quoted number concatenated, a 0 stalled or spun.

/** Construct with console.log captured; returns the manager and the lines. */
function withRamp(ramp) {
  const lines = [];
  const original = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    return { am: new AccountManager([oauth('a')], 0.98, ramp === undefined ? {} : { ramp }), lines };
  } finally {
    console.log = original;
  }
}
const DEFAULT_RAMP = { enabled: true, startConc: 1, stepConc: 1, stepMs: 250, windowMs: 30_000, pollMs: 50 };

test('a stormRamp value the ramp cannot use falls back to its default, with one line naming it', () => {
  const { am, lines } = withRamp({
    startConc: '1', stepConc: 0, stepMs: -250, windowMs: JSON.parse('1e999'), pollMs: null, enabled: 'false', startconc: 2,
  });
  assert.deepEqual(am.ramp, DEFAULT_RAMP);
  assert.equal(lines.length, 1, lines.join('\n'));
  for (const named of ['startConc "1"', 'stepConc 0', 'stepMs -250', 'windowMs Infinity', 'pollMs null', 'enabled "false" is not true or false, so it is read as true', 'startconc (not a setting)']) {
    assert.ok(lines[0].includes(named), `${named} in: ${lines[0]}`);
  }
});

test('usable stormRamp values are kept as written, and no line is logged', () => {
  const set = { enabled: false, startConc: 0.5, stepConc: 2, stepMs: 100, windowMs: 1000, pollMs: 5 };
  const { am, lines } = withRamp(set);
  assert.deepEqual(am.ramp, set);
  assert.deepEqual(withRamp(undefined).am.ramp, DEFAULT_RAMP, 'no stormRamp: the defaults');
  assert.deepEqual(withRamp(null).am.ramp, DEFAULT_RAMP, 'null: the defaults');
  assert.deepEqual(lines, []);
  assert.deepEqual(withRamp(undefined).lines, [], 'nothing configured, nothing said');
});

test('a stormRamp that is not an object is reported, and storm control keeps its defaults', () => {
  for (const bad of [false, 'off', [1, 2]]) {
    const { am, lines } = withRamp(bad);
    assert.deepEqual(am.ramp, DEFAULT_RAMP, JSON.stringify(bad));
    assert.equal(lines.length, 1, `${JSON.stringify(bad)}: ${lines.join('\n')}`);
    assert.match(lines[0], /stormRamp: ignoring .* it must be an object/);
  }
});

test('a quoted startConc does not loosen the ramp: one request at the instant of a switch', async () => {
  const { am } = withRamp({ startConc: '1', stepMs: 10_000, pollMs: 5 });
  const acct = am.accounts[0];
  am._beginRamp(acct);
  assert.equal(am._rampCap(acct, acct.rampStartedAt), 1);
  let admitted = 0;
  let gone = false;
  const waits = Array.from({ length: 5 }, () => am.admit(0, () => gone).then(ok => { if (ok) admitted++; }));
  // The slot that is free is taken without a timer; the other four are polling.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, 1, 'the cap is 1 at the switch, not "10"');
  gone = true;
  await Promise.all(waits);
});

test('a startConc and stepConc of 0 do not hold an idle account\'s first request for the window', async () => {
  const { am } = withRamp({ startConc: 0, stepConc: 0, windowMs: 2000, pollMs: 5 });
  const acct = am.accounts[0];
  am._beginRamp(acct);
  // A cap of 0 that cannot grow would park the request until the window ran
  // out; the cap is what says it will not, whatever the clock does.
  assert.equal(am._rampCap(acct, acct.rampStartedAt), 1);
  assert.equal(await am.admit(0), true);
});

test('a window of 1e999 with a cap that cannot grow does not hold an idle account for good', async () => {
  const { am } = withRamp({ startConc: 0, stepConc: 0, windowMs: JSON.parse('1e999'), pollMs: 5 });
  const acct = am.accounts[0];
  am._beginRamp(acct);
  assert.equal(am.ramp.windowMs, 30_000, 'a window that never ends is not kept');
  assert.equal(am._rampCap(acct, acct.rampStartedAt), 1);
  assert.equal(await am.admit(0), true);
});

// A value that is not a number is named as it was written in the config.
test('a stormRamp value that is an array or an object is named as written', () => {
  const { lines } = withRamp({ startConc: [1], stepConc: ['2'], stepMs: {} });
  assert.equal(lines.length, 1);
  for (const named of ['startConc [1]', 'stepConc ["2"]', 'stepMs {}']) assert.ok(lines[0].includes(named), `${named} in: ${lines[0]}`);
  assert.match(withRamp([]).lines[0], /stormRamp: ignoring \[\] — it must be an object/);
});

// A timer waits whole milliseconds, never less than 1, and holds no more than
// 2147483647 (admit() waits pollMs * 4 during a pause).
test('a pollMs a timer cannot keep falls back to its default, with a line naming it', () => {
  for (const pollMs of [0, 0.001, 1, 4, 2.5, 7.5, 536_870_912, 3e9]) {
    const { am, lines } = withRamp({ pollMs });
    assert.equal(am.ramp.pollMs, 50, String(pollMs));
    assert.equal(lines.length, 1, String(pollMs));
    assert.ok(lines[0].includes(`pollMs ${pollMs}`), lines[0]);
  }
  for (const pollMs of [5, 536_870_911]) {
    const { am, lines } = withRamp({ pollMs });
    assert.equal(am.ramp.pollMs, pollMs);
    assert.deepEqual(lines, []);
  }
});

// What pollMs is for: how often a waiting admit re-checks the cap. Each
// re-check asks isAborted first, so counting those calls on a mocked clock
// reads the delays admit() schedules rather than how fast the machine is: over
// two waits, none before pollMs and one at it. A 0 or a 1 fell back to 50
// above, and were either kept, a timer would re-check every 1 ms; the kept 5
// shows the wait is read from pollMs, not fixed at the default.
test('a waiting admit waits pollMs between re-checks of the cap, and the default for a pollMs that fell back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  for (const [pollMs, every] of [[0, 50], [1, 50], [5, 5]]) {
    const { am } = withRamp({ pollMs, stepMs: 10_000 });
    am._beginRamp(am.accounts[0]); // cap 1: the mocked clock never reaches a step
    assert.equal(await am.admit(0), true, 'the free slot is taken at once');
    let checks = 0;
    let gone = false;
    const waiting = am.admit(0, () => { checks++; return gone; });
    assert.equal(checks, 1, 'the first check is made at once');
    t.mock.timers.tick(every - 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 1, `pollMs ${pollMs}: re-checked before ${every} ms`);
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 2, `pollMs ${pollMs}: not re-checked at ${every} ms`);
    t.mock.timers.tick(every - 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 2, `pollMs ${pollMs}: re-checked again before another ${every} ms`);
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 3, `pollMs ${pollMs}: not re-checked again after another ${every} ms`);
    gone = true;
    t.mock.timers.tick(every);
    assert.equal(await waiting, false, 'a waiting admit gives up once the client is gone');
  }
});

// `enabled` was read for its truth before it was checked, so a 0, a null or an
// empty string turned storm control off; they still do, and say so.
test('an enabled of 0, null or "" keeps storm control off, as it always did, and is named', () => {
  for (const enabled of [0, null, '']) {
    const { am, lines } = withRamp({ enabled });
    assert.equal(am.ramp.enabled, false, JSON.stringify(enabled));
    am._beginRamp(am.accounts[0]);
    assert.equal(am._rampCap(am.accounts[0]), Infinity, 'no ramp');
    assert.equal(lines.length, 1, JSON.stringify(enabled));
    assert.ok(lines[0].includes(`enabled ${enabled === '' ? '""' : enabled} is not true or false, so it is read as false`), lines[0]);
  }
});
