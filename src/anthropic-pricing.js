// What one Anthropic reply cost, priced from the `usage` block it carried.
//
// Used by the local credit estimate (api-credit.js) for an API-key account
// that has no Admin API key to read the organization's real spend with. The
// figure is an estimate in two ways the payload says out loud: it sees only the
// replies this proxy served, and it is only as current as this table.
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing, read
// 2026-11-06. USD per million tokens, standard (global) routing, standard tier.
// The cache columns are the page's own figures ("5m writes", "1h writes",
// "Hits and refreshes"), not a multiplier applied here: the read multiplier is
// 0.1x on most models but 0.05x on Opus 5.5 and Sonnet 5.5 and 0.025x on
// Fable 5.1 and Mythos 5.1, so deriving it would be one more thing to get wrong.
//
// A model missing from this table is never priced as zero or guessed from a
// sibling: the reply is counted as unpriced and the estimate is marked
// incomplete, naming the model.

/**
 * @typedef {{ input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number }} PriceRow
 * @typedef {PriceRow & { longContext?: PriceRow & { over: number }, fast?: { input: number, output: number } }} ModelPrice
 */

/** @type {Record<string, ModelPrice>} */
const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, fast: { input: 8, output: 40 } },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
  // Priced by prompt length: a prompt over 100,000 tokens (input, cache reads
  // and cache writes together) pays the second row for the whole request.
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01,
    longContext: { over: 100_000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 },
  },
  'claude-mythos-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, fast: { input: 10, output: 50 } },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, fast: { input: 10, output: 50 } },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
};

// Older aliases that name a snapshot without its date.
/** @type {Record<string, string>} */
const ALIASES = {
  'claude-opus-4-0': 'claude-opus-4',
  'claude-sonnet-4-0': 'claude-sonnet-4',
};

// Web search: $10 per 1,000 searches (same page, "Web search tool"). Web
// fetch has no charge beyond its tokens. Code execution is billed by container
// time with 1,550 free hours a month per organization, which a reply's usage
// block cannot price; see docs/quota.md for that and the other known limits.
const WEB_SEARCH_USD = 10 / 1000;
// "inference_geo": "us" on Claude 4.6 and later: 1.1x on every token price.
// Earlier models reject the parameter, so a reply naming it is one of those.
const US_GEO_MULTIPLIER = 1.1;
// The Batch API: half price on every token category, cache multipliers stacked.
const BATCH_MULTIPLIER = 0.5;

/**
 * The price table's key for a model id as the proxy sees it: lowercased, a
 * context suffix (`[1m]`) and a snapshot date (`-20251001`) dropped, and an old
 * `-0` alias folded onto its model. Null for anything that is not a string.
 * @param {unknown} model
 * @returns {string|null}
 */
export function priceKey(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  let id = model.trim().toLowerCase();
  const br = id.indexOf('[');
  if (br > 0) id = id.slice(0, br);
  id = id.replace(/-\d{8}$/, '').replace(/-latest$/, '');
  return ALIASES[id] || id;
}

/** True when the table can price this model id. @param {unknown} model */
export function hasPrice(model) {
  const key = priceKey(model);
  return key != null && Object.prototype.hasOwnProperty.call(PRICES, key);
}

/** A non-negative finite count, else 0. @param {unknown} v */
const count = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * @typedef {{ ok: true, costMinor: number }} Priced  cost in US cents (fractional)
 * @typedef {{ ok: false, model: string, reason: string }} Unpriced
 */

/**
 * Price one reply's usage block. `costMinor` is US cents, unrounded: a reply on
 * a cheap model costs a small fraction of a cent, and rounding each one would
 * lose the sum.
 *
 * Reads every field the Messages API reports that changes the price:
 * `input_tokens`, `output_tokens`, `cache_read_input_tokens`, the 5-minute and
 * 1-hour split under `cache_creation`, `server_tool_use.web_search_requests`,
 * and the `speed`, `inference_geo` and `service_tier` the reply was served at.
 * Cache-creation tokens the split does not account for (a usage block that
 * carries only `cache_creation_input_tokens`) are priced at the 5-minute rate,
 * the default TTL.
 *
 * @param {unknown} model  the model the request named
 * @param {Record<string, any>|null|undefined} usage
 * @returns {Priced|Unpriced}
 */
export function priceUsage(model, usage) {
  const key = priceKey(model);
  const shown = typeof model === 'string' && model.trim() ? model.trim() : '(no model)';
  const row = key ? PRICES[key] : undefined;
  if (!row || !Object.prototype.hasOwnProperty.call(PRICES, /** @type {string} */ (key))) {
    return { ok: false, model: shown, reason: 'no price for this model' };
  }
  const u = usage || {};
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  const read = count(u.cache_read_input_tokens);
  const split = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
  const write1h = count(split.ephemeral_1h_input_tokens);
  const write5mSplit = count(split.ephemeral_5m_input_tokens);
  const writeTotal = count(u.cache_creation_input_tokens);
  const write5m = write5mSplit + Math.max(0, writeTotal - write5mSplit - write1h);

  /** @type {PriceRow} */
  let price = row;
  const prompt = input + read + write5m + write1h;
  if (row.longContext && prompt > row.longContext.over) price = row.longContext;

  if (u.speed === 'fast') {
    if (!row.fast) return { ok: false, model: shown, reason: 'no fast-mode price for this model' };
    // Fast mode replaces the base input and output prices; the cache
    // multipliers apply on top of the fast input price.
    const inScale = row.fast.input / row.input;
    price = {
      input: row.fast.input,
      output: row.fast.output,
      cacheWrite5m: price.cacheWrite5m * inScale,
      cacheWrite1h: price.cacheWrite1h * inScale,
      cacheRead: price.cacheRead * inScale,
    };
  }

  let multiplier = 1;
  if (u.inference_geo === 'us') multiplier *= US_GEO_MULTIPLIER;
  if (u.service_tier === 'batch') multiplier *= BATCH_MULTIPLIER;
  else if (u.service_tier === 'priority') return { ok: false, model: shown, reason: 'Priority Tier is not priced' };

  const tokenUsd = (input * price.input + output * price.output + read * price.cacheRead
    + write5m * price.cacheWrite5m + write1h * price.cacheWrite1h) / 1_000_000;
  const searches = count(u.server_tool_use?.web_search_requests);
  const usd = tokenUsd * multiplier + searches * WEB_SEARCH_USD;
  return { ok: true, costMinor: usd * 100 };
}
