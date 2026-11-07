// The cache figures of one response, as the tail of an activity line:
// `cache r180k w3k in1k` = tokens read from the prompt cache, written to it, and
// sent uncached. Whether the cache held is the one thing a request line did not
// say, and these three numbers decide it (#642, design by @kyjin).

// A figure that is not a count reads as zero rather than as a number nobody sent.
const count = (/** @type {any} */ n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

// 1000 and up in whole k, smaller counts as they are.
const k = (/** @type {any} */ n) => {
  const c = count(n);
  return c >= 1000 ? `${Math.round(c / 1000)}k` : String(c);
};

// Share of the prompt read from the cache at or above which it held, and
// below which it missed; in between is partial.
const HIT_SHARE = 0.9;
const MISS_SHARE = 0.5;

/**
 * Whether the cache held: the share of the prompt that was read from it,
 * r / (r + w + in). A response that neither read nor wrote the cache is not a
 * cached request and has no state to judge.
 * @param {Record<string, any>|null|undefined} usage the response's usage object
 * @returns {'hit'|'partial'|'miss'|'none'}
 */
export function cacheUsageState(usage) {
  if (!usage || typeof usage !== 'object') return 'none';
  const r = count(usage.cache_read_input_tokens);
  const w = count(usage.cache_creation_input_tokens);
  if (r === 0 && w === 0) return 'none';
  const ratio = r / (r + w + count(usage.input_tokens));
  return ratio >= HIT_SHARE ? 'hit' : ratio >= MISS_SHARE ? 'partial' : 'miss';
}

/**
 * A miss ends with MISS: the TUI also paints it red, but its log file and the
 * headless log carry no colour, so the word is what is left there to grep.
 * @param {Record<string, any>|null|undefined} usage the response's usage object
 * @returns {string} '' when the response carried no usage
 */
export function cacheUsageLabel(usage) {
  if (!usage || typeof usage !== 'object' || !Object.keys(usage).length) return '';
  const label = `cache r${k(usage.cache_read_input_tokens)} w${k(usage.cache_creation_input_tokens)} in${k(usage.input_tokens)}`;
  return cacheUsageState(usage) === 'miss' ? `${label} MISS` : label;
}
