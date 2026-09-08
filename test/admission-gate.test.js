import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AdmissionGate } from '../src/admission-gate.js';

test('admission gate bounds active work, queues FIFO, and rejects overflow', async () => {
  const gate = new AdmissionGate(2, 2);
  assert.equal(await gate.enter(), true);
  assert.equal(await gate.enter(), true);
  const third = gate.enter();
  const fourth = gate.enter();
  assert.equal(await gate.enter(), false);
  assert.deepEqual(gate.status(), { active: 2, queued: 2, limit: 2, maxQueue: 2 });

  gate.leave();
  assert.equal(await third, true);
  assert.deepEqual(gate.status(), { active: 2, queued: 1, limit: 2, maxQueue: 2 });
  gate.leave();
  assert.equal(await fourth, true);
  gate.leave();
  gate.leave();
  assert.equal(gate.active, 0);
});

test('queued cancellation removes the waiter immediately without stealing a permit', async () => {
  const gate = new AdmissionGate(1, 1);
  await gate.enter();
  const ac = new AbortController();
  const waiting = gate.enter({ signal: ac.signal });
  ac.abort();
  assert.equal(await Promise.race([waiting, delay(100, 'hung')]), false);
  assert.equal(gate.status().queued, 0);
  assert.equal(gate.status().active, 1);
  const next = gate.enter();
  gate.leave();
  assert.equal(await next, true);
  gate.leave();
  assert.equal(gate.status().active, 0);
});

test('queue deadline removes only its own waiter and allows recovery', async () => {
  const gate = new AdmissionGate(1, 2);
  await gate.enter();
  const expired = gate.enter({ timeoutMs: 20 });
  const next = gate.enter({ timeoutMs: 1000 });
  assert.equal(await Promise.race([expired, delay(100, 'hung')]), false);
  assert.equal(gate.status().queued, 1);
  gate.leave();
  assert.equal(await next, true);
  gate.leave();
  assert.equal(gate.status().active, 0);
});

test('already cancelled entry never acquires a permit; zero-length queue rejects', async () => {
  const gate = new AdmissionGate(1, 0);
  assert.equal(await gate.enter({ signal: AbortSignal.abort() }), false);
  assert.equal(gate.active, 0);
  assert.equal(await gate.enter(), true);
  assert.equal(await gate.enter(), false);
  gate.leave();
});
