// A FIFO semaphore with a bounded queue and a bounded wait.
//
// `enter()` resolves `true` once the caller holds a permit and `false` when it
// never will: the queue was already full, its wait deadline passed, or the
// caller's signal aborted while it was waiting. A waiter that gives up leaves
// the queue at once — it does not sit there until a permit would have reached
// it — so a departed client frees its slot for whoever is behind it. Every
// admitted caller must `leave()` exactly once; `leave()` hands the permit
// straight to the oldest waiter when there is one.
export const DEFAULT_MAX_QUEUE = 64;
export const DEFAULT_QUEUE_TIMEOUT_MS = 5_000;

export class AdmissionGate {
  constructor(limit, maxQueue = DEFAULT_MAX_QUEUE) {
    this.limit = positiveInt(limit, 1);
    this.maxQueue = Number.isSafeInteger(Number(maxQueue)) && Number(maxQueue) >= 0 ? Number(maxQueue) : DEFAULT_MAX_QUEUE;
    this.active = 0;
    this.queue = [];
  }

  /** @param {{ signal?: AbortSignal, timeoutMs?: number }} [opts] */
  enter({ signal, timeoutMs = DEFAULT_QUEUE_TIMEOUT_MS } = {}) {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(true);
    }
    if (this.queue.length >= this.maxQueue) return Promise.resolve(false);
    return new Promise(resolve => {
      let timer;
      const settle = admitted => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        const index = this.queue.indexOf(settle);
        if (index !== -1) this.queue.splice(index, 1);
        resolve(admitted);
      };
      const cancel = () => settle(false);
      this.queue.push(settle);
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(cancel, positiveInt(timeoutMs, DEFAULT_QUEUE_TIMEOUT_MS));
      timer.unref?.();
    });
  }

  leave() {
    const next = this.queue.shift();
    if (next) next(true); // transfer this permit; active does not change
    else if (this.active > 0) this.active -= 1;
  }

  status() {
    return { active: this.active, queued: this.queue.length, limit: this.limit, maxQueue: this.maxQueue };
  }
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 2 ** 31 - 1 ? n : fallback;
}
