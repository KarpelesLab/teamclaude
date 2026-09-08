import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startEventLoopMonitor } from '../src/event-loop-monitor.js';

test('event-loop monitor records stalls and rate-limits warnings', () => {
  let clock = 0;
  let tick;
  let cancelled = false;
  const warnings = [];
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const monitor = startEventLoopMonitor({
    intervalMs: 100,
    warnLagMs: 50,
    warnCooldownMs: 1_000,
    now: () => clock,
    schedule(fn) { tick = fn; return timer; },
    cancel(value) { assert.equal(value, timer); cancelled = true; },
    log(message) { warnings.push(message); },
  });

  assert.equal(timer.unrefCalled, true);
  clock = 180; tick(); // 80ms late
  clock = 360; tick(); // another 80ms late, inside warning cooldown
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /lag=80ms/);
  assert.deepEqual(monitor.status(), {
    lastLagMs: 80,
    maxLagMs: 80,
    stallCount: 2,
    lastStallAt: monitor.status().lastStallAt,
    warnLagMs: 50,
  });
  assert.ok(monitor.status().lastStallAt);

  monitor.stop();
  assert.equal(cancelled, true);
});
