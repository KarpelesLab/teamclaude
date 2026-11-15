// The organization's spend since a moment, read from Anthropic's Admin API.
//
// The authoritative source behind `accounts[].credit` (api-credit.js). It
// spends nothing: it is a report read with an Admin API key, which sends no
// message, refreshes no token and touches no quota. That is why it may run for
// a disabled account.
//
// Legacy Usage and Cost API, `GET /v1/organizations/cost_report`
// (https://platform.claude.com/docs/en/manage-claude/usage-cost-api, and the
// reference at /docs/en/api/beta/organization/cost_report/retrieve, both read
// 2026-11-06):
//   - `x-api-key: <admin key>` and `anthropic-version`;
//   - `starting_at` (RFC 3339; buckets are snapped to the UTC day), `bucket_width`
//     `1d` (the only width the cost report offers), `limit` 1-31 buckets, `page`
//     = the previous reply's `next_page`;
//   - reply `{ data: [{ starting_at, ending_at, results: [{ amount, currency, ... }] }],
//     has_more, next_page }`, oldest bucket first, empty days included;
//   - `amount` is a decimal string in cents ("123.78912"), `currency` "USD".
// Data "typically appears within 5 minutes of API request completion, though
// delays might occasionally be longer", and the reply carries no watermark.
//
// Chosen over the newer Usage and Cost Analytics API
// (`/v1/organizations/analytics/cost`) for freshness: that one refreshes
// "within 4 hours ... up to 24 hours". Swapping is this one file: anything with
// the same `fetchOrgSpend` contract plugs into api-credit.js unchanged.

import { proxyFetch } from './upstream-fetch.js';
import { readJsonBounded } from './backend-quota.js';
import { safeLine } from './safe-text.js';

export const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
// The version the cost report's own reference is written against.
export const ADMIN_API_VERSION = '2026-10-21';
// 31 one-day buckets cover any billing cycle, so a cycle is normally one page.
const PAGE_LIMIT = 31;
// A cycle of at most 31 days cannot need more pages than this; a reply that
// keeps saying `has_more` past it is not paging through a cycle.
const MAX_PAGES = 8;
const RESPONSE_LIMIT = 1024 * 1024;

/**
 * @typedef {{ ok: true, spentMinor: number, currency: 'USD', buckets: number, pages: number }} SpendReading
 *   `spentMinor` is US cents, unrounded, summed over every bucket from `startMs` on
 * @typedef {{ ok: false, kind: 'credential'|'http'|'network'|'parse', status: number|null, message: string }} SpendFailure
 *   `credential` is a 401 or 403: the key, not the spend, is the problem
 */

/**
 * Replace every occurrence of `secret` in `text`. A reply or an error that
 * quotes the key back must not carry it into a log or a status payload.
 * @param {string} text
 * @param {string|null|undefined} secret
 */
export function scrubSecret(text, secret) {
  if (!secret || typeof secret !== 'string' || secret.length < 8) return text;
  return text.split(secret).join('[admin key]');
}

/**
 * Sum the organization's cost from `startMs` (a UTC day boundary) up to now.
 * Never answers zero for a failure: every failure is a `SpendFailure`.
 *
 * @param {{
 *   adminKey: string,
 *   startMs: number,
 *   endMs?: number|null,
 *   routing?: any,
 *   fetchImpl?: (url: string, opts: Record<string, any>) => Promise<any>,
 *   url?: string,
 *   timeoutMs?: number,
 * }} opts  `endMs` drops any bucket starting at or after it; `routing` is the
 *   account's own egress proxy (account-routing.js)
 * @returns {Promise<SpendReading|SpendFailure>}
 */
export async function fetchOrgSpend({ adminKey, startMs, endMs = null, routing = null, fetchImpl = proxyFetch, url = COST_REPORT_URL, timeoutMs = 15_000 }) {
  const fail = (/** @type {SpendFailure['kind']} */ kind, /** @type {number|null} */ status, /** @type {string} */ message) =>
    /** @type {SpendFailure} */ ({ ok: false, kind, status, message: safeLine(scrubSecret(message, adminKey), 200) });
  if (!adminKey || !Number.isFinite(startMs)) return fail('parse', null, 'no admin key or start');

  let spentMinor = 0;
  let buckets = 0;
  let page = null;
  const seen = new Set();
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const query = new URL(url);
    query.searchParams.set('starting_at', new Date(startMs).toISOString());
    query.searchParams.set('bucket_width', '1d');
    query.searchParams.set('limit', String(PAGE_LIMIT));
    if (page) query.searchParams.set('page', page);

    let res;
    try {
      res = await fetchImpl(query.toString(), {
        headers: { 'x-api-key': adminKey, 'anthropic-version': ADMIN_API_VERSION, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        routing,
      });
    } catch (/** @type {any} */ err) {
      return fail('network', null, err?.message || String(err));
    }

    let body;
    try {
      body = await readJsonBounded(res, RESPONSE_LIMIT);
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = body?.error?.message ? `: ${String(body.error.message)}` : '';
      if (res.status === 401 || res.status === 403) {
        return fail('credential', res.status, `Admin API key rejected (HTTP ${res.status})${detail}`);
      }
      return fail('http', res.status, `cost report answered HTTP ${res.status}${detail}`);
    }
    if (body === undefined) return fail('parse', res.status, 'cost report reply too large');
    if (!body || !Array.isArray(body.data)) return fail('parse', res.status, 'cost report reply has no data list');

    for (const bucket of body.data) {
      const at = Date.parse(bucket?.starting_at);
      // The query already starts at the cycle; this only keeps a bucket that
      // names a day outside it out of the sum. An unreadable stamp is kept:
      // the query asked for this range.
      if (Number.isFinite(at) && (at < startMs || (endMs != null && at >= endMs))) continue;
      buckets++;
      // A bucket with no results list is no reading of that day: summed as an
      // empty day, it would replace the last good reading with zero or a part.
      // A day that really spent nothing answers `results: []`.
      if (!Array.isArray(bucket?.results)) return fail('parse', res.status, 'cost report bucket without a results list');
      for (const row of bucket.results) {
        if (row?.currency != null && row.currency !== 'USD') {
          return fail('parse', res.status, `cost report row in ${safeLine(row.currency, 8)}, not USD`);
        }
        const raw = row?.amount;
        const amount = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        // A row whose amount does not parse is not a zero: the sum would be
        // short by an unknown amount, so there is no sum.
        if (!Number.isFinite(amount)) return fail('parse', res.status, 'cost report row with an unreadable amount');
        spentMinor += amount;
      }
    }

    if (body.has_more !== true) return { ok: true, spentMinor, currency: 'USD', buckets, pages };
    const next = typeof body.next_page === 'string' && body.next_page ? body.next_page : null;
    if (!next || seen.has(next)) return fail('parse', res.status, 'cost report says has_more without a new next_page');
    seen.add(next);
    page = next;
  }
  return fail('parse', null, `cost report still has_more after ${MAX_PAGES} pages`);
}
