import { test } from 'node:test';
import assert from 'node:assert/strict';
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
