import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const H = 3600_000;

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

function mgr(expiryRouting) {
  return new AccountManager([oauth('a'), oauth('b')], 0.98, { expiryRouting });
}

test('the knob is off unless the config says exactly true', () => {
  // A hand-edited "false" is a truthy string, and reading it as one would turn
  // the feature on for an operator who wrote it down to turn it off.
  for (const enabled of [undefined, null, false, 0, 1, 'true', 'false', 'yes', {}]) {
    assert.equal(mgr({ enabled }).expiryRouting.enabled, false, `enabled: ${JSON.stringify(enabled)}`);
  }
  assert.equal(mgr({ enabled: true }).expiryRouting.enabled, true);
});

test('an absent config is the same as an absent knob', () => {
  assert.deepEqual(mgr(undefined).expiryRouting, { enabled: false, tolerance: 1.5, preempt: true });
  assert.deepEqual(mgr(null).expiryRouting, mgr(undefined).expiryRouting);
  assert.deepEqual(mgr({}).expiryRouting, mgr(undefined).expiryRouting);
});

test('only a real finite tolerance counts; everything else takes the default', () => {
  // Coercing instead would read null as 0, and 0 is a MEANINGFUL setting: it
  // clamps to 1, the strictest band. Landing there from an unset key looks like
  // the feature is disabled rather than tuned.
  for (const tolerance of [undefined, null, '', '2', NaN, Infinity, -Infinity, {}]) {
    assert.equal(mgr({ tolerance }).expiryRouting.tolerance, 1.5, `tolerance: ${JSON.stringify(tolerance)}`);
  }
  assert.equal(mgr({ tolerance: 3 }).expiryRouting.tolerance, 3);
});

test('a tolerance below 1 clamps to the strictest band rather than emptying it', () => {
  // Below 1 asks for accounts strictly better than the best there is.
  for (const tolerance of [0, 0.5, -4]) {
    assert.equal(mgr({ tolerance }).expiryRouting.tolerance, 1, `tolerance: ${tolerance}`);
  }
});

test('preempt defaults on and takes only a real boolean', () => {
  assert.equal(mgr({}).expiryRouting.preempt, true);
  assert.equal(mgr({ preempt: false }).expiryRouting.preempt, false);
  for (const preempt of [undefined, null, 'false', 0, 1]) {
    assert.equal(mgr({ preempt }).expiryRouting.preempt, true, `preempt: ${JSON.stringify(preempt)}`);
  }
});

test('the knob hot-applies, and re-normalises what it is given', () => {
  const am = mgr({ enabled: true, tolerance: 4 });
  am.setExpiryRouting({ enabled: false, tolerance: 0.25 });
  assert.deepEqual(am.expiryRouting, { enabled: false, tolerance: 1, preempt: true });
  am.setExpiryRouting(undefined);
  assert.deepEqual(am.expiryRouting, { enabled: false, tolerance: 1.5, preempt: true });
});

test('status echoes the resolved knob, not the config that was written', () => {
  const am = mgr({ enabled: true, tolerance: 0.25 });
  const status = am.getStatus();
  assert.deepEqual(status.expiryRouting, { enabled: true, tolerance: 1, preempt: true });
  // A copy: mutating the payload must not reconfigure the router.
  status.expiryRouting.enabled = false;
  assert.equal(am.expiryRouting.enabled, true);
});

test('status publishes each account\'s pressure, and null while it is unknown', () => {
  const am = mgr({ enabled: true });
  am.accounts[0].quota.unified7d = 0.25;
  am.accounts[0].quota.unified7dReset = Date.now() + 4 * H;
  const [a, b] = am.getStatus().accounts;
  assert.ok(a.pressure > 0);
  assert.equal(b.pressure, null);
});

test('pressure is published whether or not the knob is on', () => {
  // It is a measurement of the fleet, not a report of the feature's state, and
  // that is what `expiryRouting.enabled` on the same payload is for.
  const am = mgr(undefined);
  am.accounts[0].quota.unified7d = 0.25;
  am.accounts[0].quota.unified7dReset = Date.now() + 4 * H;
  const status = am.getStatus();
  assert.equal(status.expiryRouting.enabled, false);
  assert.ok(status.accounts[0].pressure > 0);
});
