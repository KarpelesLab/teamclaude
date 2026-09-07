export const DEFAULT_INGRESS_CONCURRENCY = 4;
export const DEFAULT_INGRESS_QUEUE = 64;

// Small FIFO semaphore used only while request bodies are being ingested and
// parsed. Long upstream streams and quota holds do not retain a permit.
export class AdmissionGate {
  constructor(limit = DEFAULT_INGRESS_CONCURRENCY, maxQueue = DEFAULT_INGRESS_QUEUE) {
    this.limit = positiveInt(limit, DEFAULT_INGRESS_CONCURRENCY);
    this.maxQueue = positiveInt(maxQueue, DEFAULT_INGRESS_QUEUE);
    this.active = 0;
    this.queue = [];
  }

  enter() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(true);
    }
    if (this.queue.length >= this.maxQueue) return Promise.resolve(false);
    return new Promise(resolve => this.queue.push(resolve));
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
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
