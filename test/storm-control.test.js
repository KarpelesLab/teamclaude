import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

test('admit caps concurrency to a freshly-switched account; release frees a slot', async () => {
  const am = new AccountManager([oauth('a')], 0.98, {
    ramp: { startConc: 1, stepConc: 1, stepMs: 10_000, windowMs: 60_000, pollMs: 5 },
  });
  am._beginRamp(am.accounts[0]); // cap pinned at 1 for the length of this test

  assert.equal(await am.admit(0), true);
  assert.equal(am.accounts[0].inFlight, 1);

  // A second request must wait — the cap is 1 and a slot is taken.
  let second = false;
  const p = am.admit(0).then(() => { second = true; });
  await sleep(30);
  assert.equal(second, false, 'second admit blocked by the ramp cap');

  am.release(0);       // free the slot
  await p;
  assert.equal(second, true, 'second admit proceeds once a slot frees');
  assert.equal(am.accounts[0].inFlight, 1);
});

test('admit is fail-open: aborts (returns false) if the client goes away while waiting', async () => {
  const am = new AccountManager([oauth('a')], 0.98, {
    ramp: { startConc: 1, stepConc: 1, stepMs: 10_000, windowMs: 60_000, pollMs: 5 },
  });
  am._beginRamp(am.accounts[0]);
  await am.admit(0); // take the only slot

  let gone = false;
  const p = am.admit(0, () => gone); // waits: cap 1, inFlight 1
  await sleep(20);
  gone = true;                        // client disconnects
  assert.equal(await p, false, 'aborted admit returns false, takes no slot');
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

test('admit holds a request during a pause, then admits once it lifts', async () => {
  const am = new AccountManager([oauth('a')], 0.98, {
    ramp: { startConc: 10, stepConc: 1, stepMs: 10, windowMs: 60_000, pollMs: 5 },
  });
  am.accounts[0].pausedUntil = Date.now() + 120; // ~120ms pause

  const start = Date.now();
  const admitted = await am.admit(0);
  const waited = Date.now() - start;

  assert.equal(admitted, true);
  assert.ok(waited >= 100, `admit should wait out the pause, waited ${waited}ms`);
  assert.equal(am.accounts[0].inFlight, 1);
});

test('admit aborts (returns false) if the client disconnects during a pause', async () => {
  const am = new AccountManager([oauth('a')], 0.98, { ramp: { pollMs: 5 } });
  am.accounts[0].pausedUntil = Date.now() + 10_000; // long pause
  let gone = false;
  const p = am.admit(0, () => gone);
  await sleep(20);
  gone = true;
  assert.equal(await p, false, 'aborted admit returns false');
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
