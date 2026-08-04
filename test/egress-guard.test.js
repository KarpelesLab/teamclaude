import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EgressGuard, createEgressGuard } from '../src/egress-guard.js';

// A probe whose answer the test controls, and which counts how often it ran.
function fakeProbe(ips) {
  const state = { calls: 0 };
  const fetchImpl = async () => {
    const ip = Array.isArray(ips) ? (ips[Math.min(state.calls, ips.length - 1)]) : ips;
    state.calls++;
    if (ip instanceof Error) throw ip;
    return { text: async () => `${ip}\n` };
  };
  return { fetchImpl, state };
}

test('with no pin configured the guard is not built at all', () => {
  assert.equal(createEgressGuard({}, () => {}), null);
  assert.equal(createEgressGuard({ egress: {} }, () => {}), null);
  assert.equal(createEgressGuard({ egress: { pin: 'auto' } }, () => {})?.enabled(), true);
});

test('an explicit pin allows only that address', async () => {
  const { fetchImpl } = fakeProbe('203.0.113.7');
  const guard = new EgressGuard({ pin: '203.0.113.7', fetchImpl });
  assert.deepEqual(await guard.check(), { ok: true, ip: '203.0.113.7', expected: ['203.0.113.7'] });

  const other = new EgressGuard({ pin: '198.51.100.9', fetchImpl });
  const state = await other.check();
  assert.equal(state.ok, false);
  assert.equal(state.ip, '203.0.113.7');
});

test('several pinned addresses are all accepted', async () => {
  const { fetchImpl } = fakeProbe('198.51.100.9');
  const guard = new EgressGuard({ pin: ['203.0.113.7', '198.51.100.9'], fetchImpl });
  assert.equal((await guard.check()).ok, true);
});

// 'auto' exists so the common case needs no configuration: the server starts
// with the tunnel up, so whatever it sees first is the address to hold for.
test('auto latches onto the first address it sees and holds it', async () => {
  const { fetchImpl } = fakeProbe(['203.0.113.7', '192.0.2.55']);
  const guard = new EgressGuard({ pin: 'auto', ttlMs: 0, fetchImpl });

  assert.equal((await guard.check()).ok, true);          // pins 203.0.113.7
  const after = await guard.check({ force: true });      // VPN dropped
  assert.equal(after.ok, false);
  assert.equal(after.ip, '192.0.2.55');
  assert.deepEqual(after.expected, ['203.0.113.7']);
});

// A probe that cannot answer must not become an outage of our own: the point is
// to block a KNOWN-wrong address, not to require the check service to be up.
test('a failed probe is treated as unknown, not as wrong', async () => {
  const { fetchImpl } = fakeProbe(new Error('getaddrinfo ENOTFOUND'));
  const guard = new EgressGuard({ pin: '203.0.113.7', fetchImpl });
  const state = await guard.check();
  assert.equal(state.ip, null);
  assert.equal(state.ok, true);
});

test('the observed address is cached for its ttl', async () => {
  const { fetchImpl, state } = fakeProbe('203.0.113.7');
  const guard = new EgressGuard({ pin: '203.0.113.7', ttlMs: 60_000, fetchImpl });
  await guard.check();
  await guard.check();
  await guard.check();
  assert.equal(state.calls, 1);
  await guard.check({ force: true });
  assert.equal(state.calls, 2);
});

test('concurrent checks share one probe', async () => {
  const { fetchImpl, state } = fakeProbe('203.0.113.7');
  const guard = new EgressGuard({ pin: '203.0.113.7', ttlMs: 0, fetchImpl });
  await Promise.all([guard.check(), guard.check(), guard.check()]);
  assert.equal(state.calls, 1);
});

// The whole point: a request must wait out a flap instead of going out from the
// wrong address.
test('waiting returns as soon as the pinned address is back', async () => {
  const { fetchImpl } = fakeProbe(['192.0.2.55', '192.0.2.55', '203.0.113.7']);
  const guard = new EgressGuard({ pin: '203.0.113.7', ttlMs: 0, holdMs: 5_000, pollMs: 5, fetchImpl });
  const state = await guard.waitUntilPinned();
  assert.equal(state.ok, true);
  assert.equal(state.ip, '203.0.113.7');
});

test('waiting gives up when the hold budget runs out', async () => {
  const { fetchImpl } = fakeProbe('192.0.2.55');
  const guard = new EgressGuard({ pin: '203.0.113.7', ttlMs: 0, holdMs: 30, pollMs: 5, fetchImpl });
  const state = await guard.waitUntilPinned();
  assert.equal(state.ok, false);
  assert.equal(state.ip, '192.0.2.55');
});

test('a client that hangs up stops the wait', async () => {
  const { fetchImpl } = fakeProbe('192.0.2.55');
  const guard = new EgressGuard({ pin: '203.0.113.7', ttlMs: 0, holdMs: 60_000, pollMs: 5, fetchImpl });
  let gone = false;
  setTimeout(() => { gone = true; }, 20);
  const state = await guard.waitUntilPinned({ isAborted: () => gone });
  assert.equal(state.ok, false);
  assert.ok(state.waitedMs < 5_000);                     // returned early, not at the budget
});
