// Graceful drain: the state behind POST /teamclaude/drain and the opt-in wait
// on SIGTERM (proxy.drainTimeoutSeconds).
//
// A draining proxy refuses NEW requests through the forwarding listener with a
// 503 and leaves the ones already in flight alone, so a long streaming answer
// finishes. It is not the upstream admission gate (admission-gate.js), which
// bounds how many upstream requests run at once; this one is about whether the
// proxy takes new work at all.
//
// What is counted: each request the forwarding listener admits, from the moment
// it is admitted until the listener is done with it. That covers MITM-intercepted
// requests too, since they run through the same listener. Not counted: blind
// CONNECT tunnels (passthrough), the WebSocket relay used by Remote Control, and
// absolute-form forward-proxy requests. None of those is refused either.

/**
 * @typedef {{ draining: boolean, since: string|null, inFlight: number }} DrainStatus
 */

// The Retry-After on a refused request: long enough that a client does not hammer a
// proxy that is going away, short enough that a restart is picked up quickly.
export const DRAIN_RETRY_AFTER_SECONDS = 5;

/** @typedef {ReturnType<typeof createDrainState>} DrainState */

/**
 * @returns {{
 *   isDraining: () => boolean,
 *   start: () => void,
 *   stop: () => void,
 *   status: () => DrainStatus,
 *   enter: () => () => void,
 *   waitForIdle: (timeoutMs: number) => Promise<boolean>,
 * }}
 */
export function createDrainState() {
  let draining = false;
  /** @type {string|null} */
  let since = null;
  let inFlight = 0;
  /** @type {Set<() => void>} */
  const idleWaiters = new Set();

  function notifyIfIdle() {
    if (inFlight !== 0) return;
    for (const wake of [...idleWaiters]) wake();
  }

  return {
    isDraining: () => draining,

    // A second start keeps the first moment, so `since` says when the drain began.
    start() {
      if (draining) return;
      draining = true;
      since = new Date().toISOString();
    },

    stop() {
      draining = false;
      since = null;
    },

    status() {
      return { draining, since, inFlight };
    },

    // Counts one request. The returned release uncounts it, and only the first
    // call does anything, so a path that releases twice cannot drive the count
    // below what is really in flight.
    enter() {
      inFlight++;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        inFlight--;
        notifyIfIdle();
      };
    },

    // Resolves true once nothing is in flight, or false when the deadline passes
    // first. Infinity means no deadline. The deadline is a timer, not a poll.
    waitForIdle(timeoutMs) {
      if (inFlight === 0) return Promise.resolve(true);
      return new Promise(resolve => {
        /** @type {ReturnType<typeof setTimeout>|null} */
        let timer = null;
        const finish = (/** @type {boolean} */ idle) => {
          idleWaiters.delete(onIdle);
          if (timer) clearTimeout(timer);
          resolve(idle);
        };
        const onIdle = () => finish(true);
        idleWaiters.add(onIdle);
        if (Number.isFinite(timeoutMs)) timer = setTimeout(() => finish(false), timeoutMs);
      });
    },
  };
}

/**
 * The drain window in seconds, from `proxy.drainTimeoutSeconds`, or null when
 * graceful shutdown is off. Only a positive finite number turns it on. A quoted
 * number counts, as with the other proxy numeric settings, and a blank string,
 * 0, a negative number, a boolean, an object or a non-number is treated as unset.
 *
 * @param {any} config
 * @returns {number|null}
 */
export function resolveDrainTimeoutSeconds(config) {
  const raw = config?.proxy?.drainTimeoutSeconds;
  const seconds = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
