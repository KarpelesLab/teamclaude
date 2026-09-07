export const DEFAULT_INGRESS_CONCURRENCY = 4;
export const DEFAULT_INGRESS_QUEUE = 64;
export const DEFAULT_QUEUE_TIMEOUT_MS = 5_000;

export class IngressError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function ingressOptions(env = process.env) {
  return {
    queueTimeoutMs: positiveInt(env.TEAMCLAUDE_INGRESS_QUEUE_TIMEOUT_MS, DEFAULT_QUEUE_TIMEOUT_MS),
    bodyTimeoutMs: positiveInt(env.TEAMCLAUDE_REQUEST_BODY_TIMEOUT_MS, 120_000),
    maxBodyBytes: positiveInt(env.TEAMCLAUDE_REQUEST_BODY_MAX_BYTES, 32 * 1024 * 1024),
  };
}

// An absolute deadline, not an idle timer: a trickling peer cannot renew it.
// Do not destroy the request here; the caller must first send its 408/413.
export function readRequestBody(req, { maxBodyBytes, bodyTimeoutMs, signal, onChunk }) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', end);
      req.off('error', error);
      req.off('aborted', abort);
      signal?.removeEventListener('abort', abort);
    };
    const error = err => { req.pause(); cleanup(); reject(err); };
    const abort = () => error(new IngressError(499, 'Client disconnected during upload.'));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)); };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        error(new IngressError(413, 'Request body exceeds TeamClaude byte limit.'));
        return;
      }
      chunks.push(chunk);
      try { onChunk?.(chunk); } catch (err) { error(err); }
    };
    if (signal?.aborted || req.destroyed) { abort(); return; }
    if (Number(req.headers['content-length']) > maxBodyBytes) {
      error(new IngressError(413, 'Request body exceeds TeamClaude byte limit.'));
      return;
    }
    timer = setTimeout(() => error(new IngressError(408, 'Request body upload deadline exceeded.')), bodyTimeoutMs);
    timer.unref?.();
    req.on('data', data);
    req.once('end', end);
    req.once('error', error);
    req.once('aborted', abort);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// FIFO semaphore shared by ingestion and upstream admission. Each caller owns
// its permit lifetime: ingestion releases after parsing, upstream after close.
export class AdmissionGate {
  constructor(limit = DEFAULT_INGRESS_CONCURRENCY, maxQueue = DEFAULT_INGRESS_QUEUE) {
    this.limit = positiveInt(limit, DEFAULT_INGRESS_CONCURRENCY);
    this.maxQueue = Number.isSafeInteger(Number(maxQueue)) && Number(maxQueue) >= 0 ? Number(maxQueue) : DEFAULT_INGRESS_QUEUE;
    this.active = 0;
    this.queue = [];
  }

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
