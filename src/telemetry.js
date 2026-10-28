// Opt-in OTLP/HTTP JSON trace export, on Node built-ins only.
//
// Off unless `telemetry.otlp.endpoint` is set, or TEAMCLAUDE_OTLP_ENDPOINT (or
// the TEAMROUTER_ spelling) is in the environment; the environment wins. Each
// data-plane request becomes one request span, with one child span per upstream
// attempt. The request span carries the request's single usage record, when one
// was reported. Nothing from a prompt, a body, a header, a credential or an
// account email is ever exported. docs/telemetry.md has the schema.
//
// Spans are queued in memory, bounded by QUEUE_LIMIT, and sent in batches of
// BATCH_SIZE by a timer that is unref'd, so an idle exporter never holds the
// process open. A span that does not fit is dropped and counted, and so is a
// batch the collector refuses or fails to answer in time. Export never throws
// into the request path and never waits on it.

import { randomBytes } from 'node:crypto';
import { envVar, LEGACY_NAME } from './brand.js';

export const QUEUE_LIMIT = 512;
export const BATCH_SIZE = 64;
const FLUSH_INTERVAL_MS = 1000;
const EXPORT_TIMEOUT_MS = 1200;
const SHUTDOWN_TIMEOUT_MS = 1500;
const SCOPE_NAME = 'teamclaude.proxy';
const SPAN_KIND_SERVER = 2;
const SPAN_KIND_CLIENT = 3;
const STATUS_ERROR = 2;
const BASIS = 'uncached_input_excluding_cache_read_and_creation';
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const OUTCOMES = new Set(['completed', 'failed', 'abandoned']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ERROR_CLASS_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

// Data-plane paths only. The value is the API shape, not the execution origin.
const ROUTES = new Map([
  ['/v1/messages', 'anthropic.messages'],
  ['/v1/responses', 'openai.responses'],
  ['/backend-api/codex/responses', 'codex.responses'],
]);

/**
 * The telemetry route for a classified path, or null when the path is not a
 * model route. Callers pass classificationPath(req.url).
 * @param {string} path
 * @returns {string|null}
 */
export function telemetryRouteFor(path) {
  return ROUTES.get(path) ?? null;
}

/**
 * @typedef {object} RequestOptions
 * @property {string} [method]
 * @property {string} [path]
 * @property {number} [internalId]
 * @property {string} [callerId]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string} [client]
 */

/**
 * @typedef {object} RequestHandle
 * @property {(account: {name?: string, id?: string}|null|undefined) => { end: (result?: { status?: number, error?: unknown }) => void }} startAttempt
 * @property {(values: any, source: string) => void} recordUsage
 * @property {(result?: { status?: number, outcome?: string }) => void} finish
 */

/**
 * @typedef {object} Health
 * @property {boolean} enabled
 * @property {number} queued
 * @property {number} exported
 * @property {number} dropped
 * @property {number} failures
 * @property {string|null} lastError
 */

/**
 * Create the exporter. Returns a disabled stand-in when no endpoint is set.
 * @param {any} config the loaded config object
 * @param {NodeJS.ProcessEnv} [env]
 */
export function createTelemetry(config, env = process.env) {
  const otlp = config?.telemetry?.otlp ?? {};
  const rawEndpoint = envVar('OTLP_ENDPOINT', env) || otlp.endpoint;
  if (!rawEndpoint) return disabledTelemetry();
  const url = exportUrl(rawEndpoint);
  if (!url) {
    console.error('[TeamClaude] telemetry: the OTLP endpoint must be an http(s) URL without credentials; export stays off');
    return disabledTelemetry();
  }
  return exporter(url, cleanHeaders(otlp.headers));
}

function disabledTelemetry() {
  return {
    enabled: false,
    /** @param {RequestOptions} [_opts] @returns {RequestHandle|null} */
    startRequest: (_opts) => null,
    flush: async () => {},
    /** @returns {Health} */
    getHealth: () => ({ enabled: false, queued: 0, exported: 0, dropped: 0, failures: 0, lastError: null }),
    shutdown: async () => {},
  };
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 */
function exporter(url, headers) {
  /** @type {{ queue: Record<string, any>[], exported: number, dropped: number, failures: number, lastError: string|null, closing: boolean, exporting: Promise<void>|null }} */
  const state = { queue: [], exported: 0, dropped: 0, failures: 0, lastError: null, closing: false, exporting: null };
  const timer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  timer.unref();

  /** @param {Record<string, any>} span */
  function enqueue(span) {
    if (state.closing || state.queue.length >= QUEUE_LIMIT) { state.dropped++; return; }
    state.queue.push(span);
    if (state.queue.length >= BATCH_SIZE) void flush();
  }

  // One drain at a time. The budget is what was queued when the drain began, so
  // spans queued meanwhile wait for the next flush instead of extending this one.
  /** @returns {Promise<void>} */
  function flush() {
    state.exporting ??= drain().finally(() => { state.exporting = null; });
    return state.exporting;
  }

  /** @returns {Promise<void>} */
  async function drain() {
    let budget = state.queue.length;
    while (budget > 0) {
      const batch = state.queue.splice(0, Math.min(BATCH_SIZE, budget));
      budget -= batch.length;
      if (!await send(batch)) {
        // The collector is not taking spans now. The rest of this flush is dropped
        // and counted, not retried, so a collector that is down costs one timeout
        // per flush rather than one per batch.
        state.dropped += state.queue.splice(0, budget).length;
        budget = 0;
      }
    }
  }

  /**
   * @param {Record<string, any>[]} batch
   * @returns {Promise<boolean>}
   */
  async function send(batch) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload(batch)),
        signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
      });
      const ok = res.ok;
      await res.body?.cancel().catch(() => {});
      if (!ok) return fail(batch.length, `HTTP ${res.status}`);
      state.exported += batch.length;
      return true;
    } catch (err) {
      return fail(batch.length, errorLabel(err));
    }
  }

  /**
   * @param {number} count
   * @param {string} reason
   * @returns {false}
   */
  function fail(count, reason) {
    state.failures++;
    state.dropped += count;
    state.lastError = reason;
    return false;
  }

  /**
   * @param {RequestOptions} [opts]
   * @returns {RequestHandle|null}
   */
  function startRequest(opts = {}) {
    const { method, path, internalId, callerId, provider, model, client } = opts;
    const route = telemetryRouteFor(path ?? '');
    if (!route || state.closing) return null;
    const traceId = newId(16);
    const spanId = newId(8);
    const startNs = nowNs();
    /** @type {Record<string, unknown>} */
    const base = {
      'teamclaude.request.internal_id': Number.isSafeInteger(internalId) ? internalId : undefined,
      'teamclaude.request.caller_id': text(callerId, 128),
      'teamclaude.route': route,
      'teamclaude.provider': text(provider, 32),
      'teamclaude.model': typeof model === 'string' && MODEL_RE.test(model) ? model : undefined,
      'teamclaude.client': clientLabel(client),
      'http.request.method': text(method, 16),
    };
    let attemptCount = 0;
    /** @type {{ fields: Record<string, number>, source: string } | null} */
    let usage = null;
    let finished = false;
    return {
      /** @param {{name?: string, id?: string}|null|undefined} account */
      startAttempt(account) {
        attemptCount++;
        const number = attemptCount;
        const attemptSpanId = newId(8);
        const attemptStartNs = nowNs();
        const accountName = label(account?.name, 64);
        const accountId = text(account?.id, 64);
        let ended = false;
        return {
          /** @param {{ status?: number, error?: unknown }} [result] */
          end(result = {}) {
            if (ended) return;
            ended = true;
            const { status, error } = result;
            const failed = Boolean(error) || (Number.isInteger(status) && status !== undefined && status >= 500);
            enqueue(otlpSpan({
              name: 'teamclaude.attempt', kind: SPAN_KIND_CLIENT, traceId, spanId: attemptSpanId, parentSpanId: spanId,
              startNs: attemptStartNs, endNs: nowNs(), failed,
              attributes: {
                'teamclaude.attempt.number': number,
                'teamclaude.account': accountName,
                'teamclaude.account.id': accountId,
                'http.response.status_code': Number.isInteger(status) ? status : undefined,
                'teamclaude.attempt.error': error ? errorLabel(error) : undefined,
              },
            }));
          },
        };
      },
      // The one usage record for the request. A later report replaces an earlier
      // one, so the record is always the last attempt that reported, which is the
      // one whose response the client read: a stream that hopped never reports.
      /**
       * @param {any} values
       * @param {string} source
       */
      recordUsage(values, source) {
        if (finished || !values || typeof values !== 'object') return;
        /** @type {Record<string, number>} */
        const fields = {};
        for (const key of USAGE_FIELDS) {
          const value = /** @type {Record<string, unknown>} */ (values)[key];
          if (Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0) fields[`teamclaude.usage.${key}`] = /** @type {number} */ (value);
        }
        if (Object.keys(fields).length === 0) return;
        usage = { fields, source: text(source, 64) ?? 'unknown' };
      },
      /** @param {{ status?: number, outcome?: string }} [result] */
      finish(result = {}) {
        if (finished) return;
        finished = true;
        const { status, outcome } = result;
        const finalOutcome = outcome !== undefined && OUTCOMES.has(outcome) ? outcome : 'failed';
        /** @type {Record<string, unknown>} */
        const usageAttributes = usage
          ? { ...usage.fields, 'teamclaude.usage.source': usage.source, 'teamclaude.usage.input_tokens_basis': BASIS }
          : {};
        enqueue(otlpSpan({
          name: 'teamclaude.request', kind: SPAN_KIND_SERVER, traceId, spanId, startNs, endNs: nowNs(),
          failed: finalOutcome === 'failed',
          attributes: {
            ...base,
            'http.response.status_code': Number.isInteger(status) ? status : undefined,
            'teamclaude.outcome': finalOutcome,
            'teamclaude.attempts': attemptCount,
            ...usageAttributes,
          },
        }));
      },
    };
  }

  /** @param {number} [timeoutMs] */
  async function shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS) {
    if (!state.closing) {
      state.closing = true;
      clearInterval(timer);
    }
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline;
    const bound = new Promise(resolve => { deadline = setTimeout(resolve, timeoutMs); deadline.unref(); });
    await Promise.race([flush(), bound]);
    clearTimeout(deadline);
    // Whatever did not make it out is counted, so health cannot show a stale queue.
    state.dropped += state.queue.length;
    state.queue.length = 0;
  }

  return {
    enabled: true,
    startRequest,
    flush,
    /** @returns {Health} */
    getHealth: () => ({
      enabled: true,
      queued: state.queue.length,
      exported: state.exported,
      dropped: state.dropped,
      failures: state.failures,
      lastError: state.lastError,
    }),
    shutdown,
  };
}

// --- encoding ---------------------------------------------------------------

/** @param {Record<string, any>[]} spans */
function payload(spans) {
  return {
    resourceSpans: [{
      resource: { attributes: attributeList({ 'service.name': LEGACY_NAME }) },
      scopeSpans: [{ scope: { name: SCOPE_NAME }, spans }],
    }],
  };
}

/** @param {Record<string, any>} args */
function otlpSpan({ name, kind, traceId, spanId, parentSpanId, startNs, endNs, attributes, failed }) {
  /** @type {Record<string, any>} */
  const span = {
    traceId,
    spanId,
    name,
    kind,
    startTimeUnixNano: String(startNs),
    endTimeUnixNano: String(endNs),
    attributes: attributeList(attributes),
  };
  if (parentSpanId) span.parentSpanId = parentSpanId;
  if (failed) span.status = { code: STATUS_ERROR };
  return span;
}

/**
 * @param {Record<string, unknown>} object
 * @returns {{ key: string, value: Record<string, unknown> }[]}
 */
function attributeList(object) {
  return Object.entries(object)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({ key, value: otlpValue(value) }));
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function otlpValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (Number.isSafeInteger(value)) return { intValue: String(value) };
  return { stringValue: String(value) };
}

// --- values -----------------------------------------------------------------

/** @param {number} bytes */
function newId(bytes) {
  return randomBytes(bytes).toString('hex');
}

/** @returns {bigint} */
function nowNs() {
  return BigInt(Date.now()) * 1_000_000n;
}

/**
 * Control characters stripped, then cut to `max`. Undefined when nothing is left.
 * @param {unknown} value
 * @param {number} max
 * @returns {string|undefined}
 */
function text(value, max) {
  if (typeof value !== 'string') return undefined;
  return value.replace(CONTROL_RE, '').slice(0, max) || undefined;
}

/**
 * A name exported as it is, unless it contains an '@', in which case it is not
 * exported at all: an address is neither sent nor hashed, since a hash of a
 * guessable address can be confirmed. The check runs on the whole name, before
 * any cut, so a long address cannot hide its '@' past the limit.
 * @param {unknown} name
 * @param {number} max
 * @returns {string|undefined}
 */
function label(name, max) {
  if (typeof name !== 'string') return undefined;
  const clean = name.replace(CONTROL_RE, '');
  if (!clean || clean.includes('@')) return undefined;
  return clean.slice(0, max);
}

/**
 * The client's name, 'none' when there is no client, or 'redacted' when the
 * name is an address.
 * @param {unknown} client
 * @returns {string}
 */
function clientLabel(client) {
  if (typeof client === 'string' && client.includes('@')) return 'redacted';
  return label(client, 64) ?? 'none';
}

/**
 * @param {any} err
 * @returns {string}
 */
function errorLabel(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && ERROR_CLASS_RE.test(code) ? code : 'transport error';
}

/**
 * The OTLP/HTTP traces URL for a configured base, or null when it is not admissible.
 * @param {unknown} value
 * @returns {string|null}
 */
function exportUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
  return url.toString();
}

/**
 * Only well-formed string headers survive. Values are never logged.
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function cleanHeaders(value) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  let ignored = 0;
  for (const [name, headerValue] of Object.entries(value)) {
    if (/^[A-Za-z0-9-]{1,64}$/.test(name) && typeof headerValue === 'string' && headerValue.length <= 4096 && !/[\r\n\0]/.test(headerValue)) {
      out[name] = headerValue;
    } else {
      ignored++;
    }
  }
  if (ignored) console.error(`[TeamClaude] telemetry: ${ignored} invalid telemetry.otlp.headers entr${ignored === 1 ? 'y' : 'ies'} ignored`);
  return out;
}
