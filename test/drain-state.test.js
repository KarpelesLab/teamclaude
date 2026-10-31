import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDrainState, resolveDrainTimeoutSeconds } from '../src/drain.js';

// The drain state in isolation: the flag, the in-flight count the listener
// keeps, and the wait that graceful shutdown blocks on. The server-level
// behaviour is in server-drain.test.js and server-drain-shutdown.test.js.

test('a new drain state admits everything and has nothing in flight', () => {
  assert.deepEqual(createDrainState().status(), { draining: false, since: null, inFlight: 0 });
});

test('start and stop flip the flag, and since is the moment the drain began', () => {
  const drain = createDrainState();
  drain.start();
  const { since } = drain.status();
  assert.equal(drain.status().draining, true);
  assert.ok(!Number.isNaN(Date.parse(since)), `since ${since} is a timestamp`);
  drain.start();
  assert.equal(drain.status().since, since, 'a second start keeps the original time');
  drain.stop();
  assert.deepEqual(drain.status(), { draining: false, since: null, inFlight: 0 });
});

test('enter counts a request, and its release uncounts it exactly once', () => {
  const drain = createDrainState();
  const a = drain.enter();
  const b = drain.enter();
  assert.equal(drain.status().inFlight, 2);
  a();
  a();
  assert.equal(drain.status().inFlight, 1, 'a second release of the same request is a no-op');
  b();
  assert.equal(drain.status().inFlight, 0);
});

test('waitForIdle resolves at once when nothing is in flight', async () => {
  assert.equal(await createDrainState().waitForIdle(Infinity), true);
});

test('waitForIdle resolves when the last request leaves', async () => {
  const drain = createDrainState();
  const a = drain.enter();
  const b = drain.enter();
  const idle = drain.waitForIdle(Infinity);
  a();
  b();
  assert.equal(await idle, true);
});

test('waitForIdle gives up at its deadline with requests still in flight', async () => {
  // Controlled time, not the wall clock: the deadline fires when the test says so.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const drain = createDrainState();
    drain.enter();
    const idle = drain.waitForIdle(30_000);
    mock.timers.tick(30_000);
    assert.equal(await idle, false);
  } finally {
    mock.timers.reset();
  }
});

test('the drain timeout is a positive number of seconds, and anything else leaves graceful shutdown off', () => {
  assert.equal(resolveDrainTimeoutSeconds({ proxy: { drainTimeoutSeconds: 30 } }), 30);
  assert.equal(resolveDrainTimeoutSeconds({ proxy: { drainTimeoutSeconds: '45' } }), 45);
  assert.equal(resolveDrainTimeoutSeconds({ proxy: { drainTimeoutSeconds: 2.5 } }), 2.5);
  for (const raw of [undefined, null, 0, '0', -1, '', '  ', 'soon', NaN, Infinity, true, [30], {}]) {
    assert.equal(resolveDrainTimeoutSeconds({ proxy: { drainTimeoutSeconds: raw } }), null, `raw ${JSON.stringify(raw)}`);
  }
  assert.equal(resolveDrainTimeoutSeconds({}), null);
  assert.equal(resolveDrainTimeoutSeconds(undefined), null);
});
