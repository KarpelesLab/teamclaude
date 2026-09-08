import { performance } from 'node:perf_hooks';

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_WARN_LAG_MS = 500;
const DEFAULT_WARN_COOLDOWN_MS = 30_000;

// A deliberately small watchdog for a failure an HTTP health endpoint cannot
// report: if the event loop is wedged, the endpoint itself cannot run. The
// delayed timer writes one bounded warning after JavaScript becomes schedulable
// again, leaving evidence in the service log without emitting request content.
export function startEventLoopMonitor({
  intervalMs = DEFAULT_INTERVAL_MS,
  warnLagMs = DEFAULT_WARN_LAG_MS,
  warnCooldownMs = DEFAULT_WARN_COOLDOWN_MS,
  now = () => performance.now(),
  schedule = setInterval,
  cancel = clearInterval,
  log = (message) => console.error(message),
} = {}) {
  let expectedAt = now() + intervalMs;
  let lastLagMs = 0;
  let maxLagMs = 0;
  let stallCount = 0;
  let lastStallAt = null;
  let lastWarningClock = -Infinity;

  const timer = schedule(() => {
    const current = now();
    const lag = Math.max(0, current - expectedAt);
    expectedAt = current + intervalMs;
    lastLagMs = Math.round(lag);
    maxLagMs = Math.max(maxLagMs, lastLagMs);
    if (lag < warnLagMs) return;

    stallCount += 1;
    lastStallAt = new Date().toISOString();
    if (current - lastWarningClock < warnCooldownMs) return;
    lastWarningClock = current;
    log(`[TeamClaude] Event loop stalled: lag=${Math.round(lag)}ms (threshold=${warnLagMs}ms, stalls=${stallCount})`);
  }, intervalMs);
  timer.unref?.();

  return {
    status: () => ({ lastLagMs, maxLagMs, stallCount, lastStallAt, warnLagMs }),
    stop: () => cancel(timer),
  };
}
