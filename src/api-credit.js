// Prepaid API credit on an Anthropic API-key account (`accounts[].credit`).
//
// The Tok/Req bars an API-key row draws are per-minute rate-limit headroom, not
// money. An operator whose key draws on prepaid credit (the monthly API credit
// a Max or Ultra plan grants a linked Console organization, say) wants to know
// how much of it is left before the cycle resets. This module answers that,
// from one of two sources, and every payload says which one and as of when:
//
//   admin  `credit.adminKey` is set: the organization's real spend since the
//          cycle began, read from Anthropic's cost report with an Admin API key
//          (anthropic-cost-report.js). Authoritative, and zero-spend: it sends
//          no message and refreshes no token, so it runs for a DISABLED account
//          too — a key kept out of rotation and reached only by pinning is the
//          case it was written for. The credit is organization-wide ("every API
//          key and workspace in the linked organization draws from the same
//          balance"), so the organization's spend is the right number.
//   local  no admin key: the cost of every reply this proxy served on the
//          account since the cycle began, priced from each reply's `usage`
//          (anthropic-pricing.js). An ESTIMATE: it sees only traffic through
//          this proxy, so the remaining figure is an upper bound. A model the
//          price table does not know marks it incomplete, naming the model.
//
// The two are kept apart rather than summed. The cost report trails requests
// by "typically ... 5 minutes, though delays might occasionally be longer" and
// carries no watermark saying up to when it is complete, so there is no point
// in time after which local spend could be added without counting some of it
// twice or missing some.
//
// The cycle is monthly from the day of month in `cycleStart`, at 00:00 UTC —
// the cost report's buckets are UTC days, so the admin source cannot resolve a
// finer boundary, and Anthropic publishes no time of day for the refresh. An
// anchor past a month's last day falls on that last day for that month only:
// an anchor of the 31st gives Jan 31, Feb 28 (29), Mar 31, Apr 30, never
// drifting to the 28th for good.

import { fetchOrgSpend, scrubSecret } from './anthropic-cost-report.js';
import { priceUsage } from './anthropic-pricing.js';
import { providerOf } from './provider.js';
import { safeLine } from './safe-text.js';

export const DEFAULT_REFRESH_MINUTES = 15;
const MIN_REFRESH_MINUTES = 1;
const MAX_REFRESH_MINUTES = 24 * 60;
// Consecutive failures double the wait from the refresh interval up to this.
export const MAX_CREDIT_BACKOFF_MS = 6 * 60 * 60 * 1000;
// Distinct unpriced models a ledger names before it folds the rest together:
// the model string comes from the client's request body.
const MAX_UNPRICED_MODELS = 16;
const OTHER_MODELS = '(other models)';

/**
 * @typedef {{
 *   amountMinor: number, currency: 'USD', exponent: 2, anchorDay: number,
 *   cycleStart: string, adminKey: string|null, refreshMs: number,
 * }} CreditConfig  `adminKey` is a secret: it lives here and nowhere else
 * @typedef {{
 *   cycleStart: number, cycleEnd: number, since: number, spentMinor: number,
 *   replies: number, unpricedReplies: number,
 *   unpriced: Record<string, { replies: number, reason: string }>, lastAt: number|null,
 * }} CreditLedger
 * @typedef {{ kind: string, status: number|null, message: string, at: number }} CreditError
 * @typedef {{
 *   cycleStart: number, reading: { spentMinor: number, at: number, cycleStart: number }|null,
 *   error: CreditError|null, failures: number, nextAt: number|null,
 * }} AdminCreditState
 * @typedef {{ local: CreditLedger|null, admin: AdminCreditState|null }} CreditState
 */

/** @returns {CreditState} */
export function emptyCreditState() {
  return { local: null, admin: null };
}

/** @param {number} y @param {number} m 0-based month */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** @param {number} y @param {number} m @param {number} day */
function cycleStartIn(y, m, day) {
  return Date.UTC(y, m, Math.min(day, daysInMonth(y, m)));
}

/**
 * The billing cycle `now` falls in, for a monthly anchor day (1-31): `start`
 * inclusive, `end` exclusive, both ms at 00:00 UTC.
 * @param {number} anchorDay
 * @param {number} now
 * @returns {{ start: number, end: number }}
 */
export function cycleBounds(anchorDay, now) {
  const d = new Date(now);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  let start = cycleStartIn(y, m, anchorDay);
  if (start > now) {
    if (m === 0) { y--; m = 11; } else m--;
    start = cycleStartIn(y, m, anchorDay);
  }
  const ny = m === 11 ? y + 1 : y;
  const nm = m === 11 ? 0 : m + 1;
  return { start, end: cycleStartIn(ny, nm, anchorDay) };
}

/**
 * The account's `credit` setting, validated and normalized, or null. A value
 * that cannot be used is dropped with one line saying why, the way
 * accountSwitchThreshold and accountRouting do; the constructor and the config
 * reload both come through here. Never prints the admin key.
 * @param {Record<string, any>} acct
 * @returns {CreditConfig|null}
 */
export function accountCredit(acct) {
  const raw = acct?.credit;
  if (raw == null) return null;
  const say = (/** @type {string} */ why) => {
    console.log(`[TeamClaude] Account "${safeLine(acct?.name, 64)}": ignoring credit — ${why}`);
    return null;
  };
  if (typeof raw !== 'object' || Array.isArray(raw)) return say('it must be an object like { "amount": 200, "currency": "USD", "cycleStart": "2026-11-02" }');
  if (acct.type !== 'apikey' || providerOf(acct) !== 'anthropic' || acct.upstream) {
    return say('it applies to Anthropic API-key accounts only (no `upstream`): the price table and the Admin API are Anthropic\'s');
  }
  const amount = typeof raw.amount === 'number' ? raw.amount : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return say('`amount` must be a positive number in the currency (200 is $200.00)');
  const currency = raw.currency == null ? 'USD' : String(raw.currency).toUpperCase();
  if (currency !== 'USD') return say('only `"currency": "USD"` is supported — Anthropic prices and reports cost in USD');
  const text = typeof raw.cycleStart === 'string' ? raw.cycleStart.trim() : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const day = m ? Number(m[3]) : NaN;
  const valid = m && day >= 1 && Number(m[2]) >= 1 && Number(m[2]) <= 12 && day <= daysInMonth(Number(m[1]), Number(m[2]) - 1);
  if (!valid) return say('`cycleStart` must be a date like "2026-11-02" (its day of the month is when the credit renews)');
  let adminKey = null;
  if (raw.adminKey != null && raw.adminKey !== '') {
    if (typeof raw.adminKey !== 'string') return say('`adminKey` must be a string');
    adminKey = raw.adminKey.trim();
    if (!adminKey.startsWith('sk-ant-admin')) {
      console.log(`[TeamClaude] Account "${safeLine(acct?.name, 64)}": credit.adminKey does not look like an Admin API key (sk-ant-admin…); the cost report will say whether it is one`);
    }
  }
  let minutes = DEFAULT_REFRESH_MINUTES;
  if (raw.refreshMinutes != null) {
    const n = Number(raw.refreshMinutes);
    if (!Number.isFinite(n) || n <= 0) {
      console.log(`[TeamClaude] Account "${safeLine(acct?.name, 64)}": credit.refreshMinutes must be a positive number of minutes; using ${DEFAULT_REFRESH_MINUTES}`);
    } else {
      minutes = Math.min(MAX_REFRESH_MINUTES, Math.max(MIN_REFRESH_MINUTES, n));
    }
  }
  return {
    amountMinor: Math.round(amount * 100),
    currency: 'USD',
    exponent: 2,
    anchorDay: day,
    cycleStart: text,
    adminKey,
    refreshMs: Math.round(minutes * 60_000),
  };
}

/**
 * Point the local ledger at the cycle `now` falls in, starting a fresh one when
 * the cycle has turned over (or there is none yet). `since` is when this
 * ledger began watching: the cycle's start when it carries straight on from the
 * previous cycle's ledger, otherwise now — spend before it was never seen.
 * @param {Record<string, any>} account
 * @param {number} now
 */
export function rollCreditCycle(account, now) {
  /** @type {CreditConfig|null} */
  const cfg = account?.creditConfig ?? null;
  if (!cfg) return;
  if (!account.creditState) account.creditState = emptyCreditState();
  const { start, end } = cycleBounds(cfg.anchorDay, now);
  /** @type {CreditLedger|null} */
  const prev = account.creditState.local;
  if (prev && prev.cycleStart === start && prev.cycleEnd === end) return;
  account.creditState.local = {
    cycleStart: start,
    cycleEnd: end,
    since: prev && prev.cycleEnd === start ? start : now,
    spentMinor: 0,
    replies: 0,
    unpricedReplies: 0,
    unpriced: {},
    lastAt: null,
  };
}

/**
 * Book one served reply against the account's local ledger. A reply the price
 * table cannot price adds nothing to the spend and is counted as unpriced,
 * under the model it named.
 * @param {Record<string, any>} account
 * @param {unknown} model
 * @param {Record<string, any>|null|undefined} usage
 * @param {number} [now]
 */
export function recordCreditUsage(account, model, usage, now = Date.now()) {
  if (!account?.creditConfig || !usage) return;
  rollCreditCycle(account, now);
  const ledger = /** @type {CreditLedger} */ (account.creditState.local);
  ledger.replies++;
  ledger.lastAt = now;
  const priced = priceUsage(model, usage);
  if (priced.ok) {
    ledger.spentMinor += priced.costMinor;
    return;
  }
  const miss = /** @type {import('./anthropic-pricing.js').Unpriced} */ (priced);
  ledger.unpricedReplies++;
  let key = safeLine(miss.model, 64) || '(no model)';
  if (!ledger.unpriced[key] && Object.keys(ledger.unpriced).length >= MAX_UNPRICED_MODELS) key = OTHER_MODELS;
  const entry = ledger.unpriced[key] || (ledger.unpriced[key] = { replies: 0, reason: miss.reason });
  entry.replies++;
}

/**
 * Store the outcome of one cost-report read. A success replaces the reading
 * and schedules the next read one refresh interval out; a failure keeps the
 * last good reading (the view shows it only while its cycle is current), says
 * what failed, and waits the interval doubled per consecutive failure, up to
 * MAX_CREDIT_BACKOFF_MS. A 401 or 403 is recorded as a credential failure — it
 * is never a reading of zero spend.
 * @param {Record<string, any>} account
 * @param {import('./anthropic-cost-report.js').SpendReading|import('./anthropic-cost-report.js').SpendFailure} result
 * @param {{ cycleStart: number, refreshMs: number, now: number }} at
 */
export function applyCreditReport(account, result, { cycleStart, refreshMs, now }) {
  if (!account.creditState) account.creditState = emptyCreditState();
  /** @type {AdminCreditState|null} */
  const prev = account.creditState.admin;
  if (result.ok) {
    account.creditState.admin = {
      cycleStart,
      reading: { spentMinor: result.spentMinor, at: now, cycleStart },
      error: null,
      failures: 0,
      nextAt: now + refreshMs,
    };
    return;
  }
  const failure = /** @type {import('./anthropic-cost-report.js').SpendFailure} */ (result);
  const failures = (prev?.failures ?? 0) + 1;
  const wait = Math.min(MAX_CREDIT_BACKOFF_MS, refreshMs * 2 ** (failures - 1));
  account.creditState.admin = {
    // The current cycle, whatever the reading's: otherwise a failure at a
    // cycle's turn would read as "new cycle, read now" on every tick.
    cycleStart,
    reading: prev?.reading ?? null,
    // Scrubbed here as well as by the fetcher: this is the one place every
    // failure passes through on its way to a payload or a log line.
    error: { kind: failure.kind, status: failure.status ?? null, message: safeLine(scrubSecret(String(failure.message ?? ''), account.creditConfig?.adminKey), 200), at: now },
    failures,
    nextAt: now + wait,
  };
}

/** @param {number|null|undefined} ms */
const iso = ms => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * The credit as status, quota and MCP payloads carry it, or null when the
 * account has no `credit` setting. Amounts are in minor units (cents) beside
 * their currency and exponent, the shape `normalizeSpend` gives a subscription's
 * spend. Never carries the admin key.
 *
 * `spentMinor` and `remainingMinor` are null when the admin source has no
 * reading for the current cycle yet. `remainingMinor` stops at 0 and
 * `exceededMinor` says by how much the spend went past the amount.
 * @param {Record<string, any>} account
 * @param {number} [now]
 */
export function creditView(account, now = Date.now()) {
  /** @type {CreditConfig|null} */
  const cfg = account?.creditConfig ?? null;
  if (!cfg) return null;
  const { start, end } = cycleBounds(cfg.anchorDay, now);
  /** @type {CreditState} */
  const state = account.creditState || emptyCreditState();
  const source = cfg.adminKey ? 'admin' : 'local';
  /** @type {number|null} */
  let spent = null;
  /** @type {string|null} */
  let asOf = null;
  /** @type {{ replies: number, models: { model: string, replies: number, reason: string }[] }|null} */
  let incomplete = null;
  /** @type {{ kind: string, status: number|null, message: string, at: string|null }|null} */
  let error = null;
  let trackedSince = null;
  let lastReplyAt = null;
  let replies = null;
  let nextRefreshAt = null;
  if (source === 'admin') {
    const admin = state.admin;
    const reading = admin?.reading && admin.reading.cycleStart === start ? admin.reading : null;
    if (reading) {
      spent = reading.spentMinor;
      asOf = iso(reading.at);
    }
    if (admin?.error) error = { kind: admin.error.kind, status: admin.error.status, message: admin.error.message, at: iso(admin.error.at) };
    nextRefreshAt = iso(admin?.nextAt ?? null);
  } else {
    const ledger = state.local && state.local.cycleStart === start ? state.local : null;
    spent = ledger ? ledger.spentMinor : 0;
    asOf = iso(now);
    trackedSince = iso(ledger ? ledger.since : now);
    lastReplyAt = iso(ledger?.lastAt ?? null);
    replies = ledger ? ledger.replies : 0;
    if (ledger && ledger.unpricedReplies > 0) {
      incomplete = {
        replies: ledger.unpricedReplies,
        models: Object.entries(ledger.unpriced).map(([model, v]) => ({ model, replies: v.replies, reason: v.reason })),
      };
    }
  }
  const spentMinor = spent == null ? null : Math.round(spent);
  return {
    source,
    // The local figure only counts what this proxy served, so the money it
    // says is left is the most that can be left.
    estimate: source === 'local',
    upperBound: source === 'local',
    currency: cfg.currency,
    exponent: cfg.exponent,
    amountMinor: cfg.amountMinor,
    spentMinor,
    remainingMinor: spentMinor == null ? null : Math.max(0, cfg.amountMinor - spentMinor),
    exceededMinor: spentMinor == null ? null : Math.max(0, spentMinor - cfg.amountMinor),
    usedFraction: spentMinor == null ? null : spentMinor / cfg.amountMinor,
    cycleStart: iso(start),
    cycleEnd: iso(end),
    asOf,
    trackedSince,
    lastReplyAt,
    replies,
    nextRefreshAt,
    incomplete,
    error,
  };
}

/**
 * The part of the credit state that survives a restart: the local ledger.
 * The admin reading is not kept — it is re-read at start, spends nothing, and
 * a stored one could belong to an admin key that has since been replaced.
 * @param {Record<string, any>} account
 */
export function exportCreditState(account) {
  const ledger = account?.creditConfig ? account.creditState?.local : null;
  return ledger ? { local: { ...ledger, unpriced: { ...ledger.unpriced } } } : null;
}

/** @param {unknown} v */
const finite = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Restore a ledger saved by exportCreditState. Anything malformed is dropped
 * rather than half-restored; a ledger from an earlier cycle is replaced by the
 * next rollCreditCycle.
 * @param {Record<string, any>} account
 * @param {any} saved
 */
export function restoreCreditState(account, saved) {
  const l = saved?.local;
  if (!account?.creditConfig || !l || typeof l !== 'object') return;
  if (![l.cycleStart, l.cycleEnd, l.since, l.spentMinor, l.replies, l.unpricedReplies].every(finite)) return;
  if (l.spentMinor < 0 || l.cycleEnd <= l.cycleStart) return;
  /** @type {Record<string, { replies: number, reason: string }>} */
  const unpriced = {};
  for (const [model, v] of Object.entries(l.unpriced && typeof l.unpriced === 'object' ? l.unpriced : {}).slice(0, MAX_UNPRICED_MODELS + 1)) {
    if (!finite(v?.replies)) continue;
    unpriced[safeLine(model, 64)] = { replies: v.replies, reason: safeLine(v.reason, 80) };
  }
  if (!account.creditState) account.creditState = emptyCreditState();
  account.creditState.local = {
    cycleStart: l.cycleStart,
    cycleEnd: l.cycleEnd,
    since: l.since,
    spentMinor: l.spentMinor,
    replies: l.replies,
    unpricedReplies: l.unpricedReplies,
    unpriced,
    lastAt: finite(l.lastAt) ? l.lastAt : null,
  };
}

/**
 * A credit view that crossed a process boundary (the attach-mode TUI), fit to
 * be drawn: numbers that are not finite read as unknown, strings are stripped
 * of controls and capped, and anything that is not one of the known values
 * reads as absent.
 * @param {any} raw
 */
export function sanitizeCreditView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (/** @type {unknown} */ v) => (finite(v) ? /** @type {number} */ (v) : null);
  const str = (/** @type {unknown} */ v, /** @type {number} */ max) => (typeof v === 'string' ? safeLine(v, max) : null);
  const err = raw.error && typeof raw.error === 'object' ? raw.error : null;
  const inc = raw.incomplete && typeof raw.incomplete === 'object' ? raw.incomplete : null;
  return {
    source: raw.source === 'admin' || raw.source === 'local' ? raw.source : null,
    estimate: raw.estimate === true,
    upperBound: raw.upperBound === true,
    currency: str(raw.currency, 8),
    exponent: num(raw.exponent),
    amountMinor: num(raw.amountMinor),
    spentMinor: num(raw.spentMinor),
    remainingMinor: num(raw.remainingMinor),
    exceededMinor: num(raw.exceededMinor),
    usedFraction: num(raw.usedFraction),
    cycleStart: str(raw.cycleStart, 40),
    cycleEnd: str(raw.cycleEnd, 40),
    asOf: str(raw.asOf, 40),
    trackedSince: str(raw.trackedSince, 40),
    lastReplyAt: str(raw.lastReplyAt, 40),
    replies: num(raw.replies),
    nextRefreshAt: str(raw.nextRefreshAt, 40),
    incomplete: inc ? {
      replies: num(inc.replies) ?? 0,
      models: (Array.isArray(inc.models) ? inc.models : []).slice(0, MAX_UNPRICED_MODELS + 1).map((/** @type {any} */ m) => ({
        model: str(m?.model, 64) ?? '?', replies: num(m?.replies) ?? 0, reason: str(m?.reason, 80) ?? '',
      })),
    } : null,
    error: err ? { kind: str(err.kind, 16) ?? 'error', status: num(err.status), message: str(err.message, 200) ?? '', at: str(err.at, 40) } : null,
  };
}

/**
 * Reads the cost report for every account with `credit.adminKey`, each on its
 * own `refreshMinutes` with backoff on failure. Disabled accounts included, on
 * purpose: the read spends nothing (see the header). Accounts without an admin
 * key are never touched.
 */
export class CreditMonitor {
  /**
   * @param {{ accounts: Record<string, any>[] }} accountManager
   * @param {{
   *   fetchSpend?: typeof fetchOrgSpend,
   *   tickMs?: number,
   *   timeoutMs?: number,
   *   log?: (line: string) => void,
   * }} [opts]
   */
  constructor(accountManager, { fetchSpend = fetchOrgSpend, tickMs = 60_000, timeoutMs = 15_000, log = line => console.log(line) } = {}) {
    this.am = accountManager;
    this.fetchSpend = fetchSpend;
    this.tickMs = tickMs;
    this.timeoutMs = timeoutMs;
    this.log = log;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
    /** @type {WeakSet<object>} */
    this.inFlight = new WeakSet();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.tickMs);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @param {Record<string, any>} account @param {number} now */
  due(account, now) {
    /** @type {CreditConfig|null} */
    const cfg = account.creditConfig ?? null;
    if (!cfg?.adminKey) return false;
    const admin = account.creditState?.admin;
    if (!admin) return true;
    // A new cycle is read at once rather than at the next interval.
    if (admin.cycleStart !== cycleBounds(cfg.anchorDay, now).start) return true;
    return admin.nextAt == null || now >= admin.nextAt;
  }

  /** Read every account that is due. @param {number} [now] */
  async tick(now = Date.now()) {
    const due = this.am.accounts.filter(a => this.due(a, now));
    await Promise.all(due.map(a => this.poll(a)));
  }

  /** Read one account's organization spend now. @param {Record<string, any>} account */
  async poll(account) {
    /** @type {CreditConfig|null} */
    const cfg = account.creditConfig ?? null;
    if (!cfg?.adminKey || this.inFlight.has(account)) return;
    this.inFlight.add(account);
    try {
      const startedAt = Date.now();
      const { start, end } = cycleBounds(cfg.anchorDay, startedAt);
      const result = await this.fetchSpend({ adminKey: cfg.adminKey, startMs: start, endMs: end, routing: account.routing ?? null, timeoutMs: this.timeoutMs })
        .catch((/** @type {any} */ err) => /** @type {import('./anthropic-cost-report.js').SpendFailure} */ ({ ok: false, kind: 'network', status: null, message: err?.message || String(err) }));
      // A reload that replaced the key (or removed the setting) while this read
      // was out owns the state now.
      if (account.creditConfig?.adminKey !== cfg.adminKey) return;
      const hadError = !!account.creditState?.admin?.error;
      applyCreditReport(account, result, { cycleStart: start, refreshMs: cfg.refreshMs, now: Date.now() });
      const name = safeLine(account.name, 64);
      if (!result.ok && !hadError) {
        const admin = account.creditState.admin;
        const wait = Math.round(((admin?.nextAt ?? Date.now()) - Date.now()) / 60_000);
        this.log(`[TeamClaude] Account "${name}": credit cost report failed — ${admin?.error?.message ?? 'unknown error'}; next try in ${wait}m`);
      } else if (result.ok && hadError) {
        this.log(`[TeamClaude] Account "${name}": credit cost report read again`);
      }
    } finally {
      this.inFlight.delete(account);
    }
  }
}
