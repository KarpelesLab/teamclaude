// Codex rate-limit headers.
//
// A Codex response carries its quota the way Anthropic does, just under a
// different spelling. The shape observed on a live response (values here are
// illustrative):
//
//   x-codex-primary-used-percent: 42
//   x-codex-primary-window-minutes: 10080
//   x-codex-primary-reset-at: <epoch seconds>
//   x-codex-secondary-used-percent: 0
//   x-codex-secondary-window-minutes: 0
//   x-codex-<name>-primary-used-percent: 0
//   x-codex-<name>-primary-window-minutes: 300
//   x-codex-<name>-secondary-window-minutes: 10080
//   x-codex-<name>-limit-name: <model family>
//
// Two things follow from that shape.
//
// First, limits arrive in FAMILIES: an unnamed one that is the account-wide
// limit, and named ones (carrying `-limit-name`) that are model-scoped — the
// direct counterpart of Anthropic's `7d_oi` Fable bucket.
//
// Second, `primary` and `secondary` are positions, not durations. The
// account-wide family above puts the 7-day window in `primary` while the
// model-scoped family puts a 5-hour window there. So windows are classified by
// their stated `window-minutes`, never by position — reading `primary` as
// "the 5h bucket" would file a weekly reading as a session one and rotate on
// the wrong number.

/** Window durations we recognise, in minutes, with a tolerance for rounding. */
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10080;
const WINDOW_TOLERANCE = 0.1;

const near = (value, target) => Math.abs(value - target) <= target * WINDOW_TOLERANCE;

const HEADER_RE = /^x-codex-(?:(.+)-)?(primary|secondary)-(used-percent|window-minutes|reset-at)$/;
const LIMIT_NAME_RE = /^x-codex-(.+)-limit-name$/;

/**
 * Group `x-codex-*` headers into families keyed by slug ('' for the
 * account-wide family), each holding its primary/secondary window readings.
 */
function collectFamilies(headers) {
  const families = new Map();
  const family = (slug) => {
    if (!families.has(slug)) families.set(slug, { slug, name: null, windows: {} });
    return families.get(slug);
  };

  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase();
    const value = String(rawValue ?? '').trim();
    if (value === '') continue;

    const named = LIMIT_NAME_RE.exec(key);
    if (named) { family(named[1]).name = value; continue; }

    const m = HEADER_RE.exec(key);
    if (!m) continue;
    const [, slug = '', position, field] = m;
    const w = (family(slug).windows[position] ??= {});
    if (field === 'used-percent') w.usedPercent = Number(value);
    else if (field === 'window-minutes') w.windowMinutes = Number(value);
    else w.resetAt = Number(value);
  }
  return families;
}

/**
 * One window reading: utilization as a 0-1 fraction, reset as ms epoch or null.
 *
 * @typedef {{utilization: number, resetAt: number|null}} QuotaWindow
 */

/**
 * Turn one family's windows into `{ fiveHour, weekly }` readings, keyed by the
 * window's own duration rather than its primary/secondary position.
 *
 * A window with no `window-minutes`, a zero duration, or an unparseable
 * utilization is dropped: a zeroed window is how this API says "not
 * applicable", and treating that as 0% used would look like full headroom.
 *
 * @param {Record<string, {usedPercent?: number, windowMinutes?: number, resetAt?: number}>} windows
 * @returns {{fiveHour?: QuotaWindow, weekly?: QuotaWindow}}
 */
function classify(windows) {
  /** @type {{fiveHour?: QuotaWindow, weekly?: QuotaWindow}} */
  const out = {};
  for (const w of Object.values(windows)) {
    const minutes = Number(w.windowMinutes);
    const percent = Number(w.usedPercent);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    if (!Number.isFinite(percent)) continue;

    const bucket = near(minutes, FIVE_HOUR_MINUTES) ? 'fiveHour'
      : near(minutes, SEVEN_DAY_MINUTES) ? 'weekly'
        : null;
    if (!bucket) continue;

    out[bucket] = {
      // Anthropic reports utilization as a 0-1 fraction and the rest of the
      // manager compares against `switchThreshold` in those units, so convert
      // here rather than teaching every consumer about percentages.
      utilization: percent / 100,
      // Epoch seconds upstream, milliseconds everywhere in this codebase.
      resetAt: Number.isFinite(w.resetAt) && w.resetAt > 0 ? w.resetAt * 1000 : null,
    };
  }
  return out;
}

/**
 * Parse Codex rate-limit headers into the fields `account.quota` already uses.
 *
 * Returns only what the headers actually stated, so a caller can assign over
 * an existing quota without blanking readings this response did not mention.
 * An empty object means "this response carried no quota", which is normal:
 * the catalog fetch (`/models`) has none.
 */
export function parseCodexQuota(headers) {
  const families = collectFamilies(headers);
  const quota = {};

  const account = classify(families.get('')?.windows || {});
  if (account.fiveHour) {
    quota.unified5h = account.fiveHour.utilization;
    if (account.fiveHour.resetAt) quota.unified5hReset = account.fiveHour.resetAt;
  }
  if (account.weekly) {
    quota.unified7d = account.weekly.utilization;
    if (account.weekly.resetAt) quota.unified7dReset = account.weekly.resetAt;
  }

  // Model-scoped families. Their weekly reading is the family bucket, carried
  // alongside the name upstream gave it. Their 5-hour one is picked up below:
  // on a subscription it is the only 5h this API ever states.
  /** @type {QuotaWindow|null} */
  let scopedFiveHour = null;
  for (const fam of families.values()) {
    if (!fam.slug) continue;
    const scoped = classify(fam.windows);
    // Tightest wins, so the reading is taken before the weekly guard below
    // drops a family that states a 5h window and no weekly one.
    if (scoped.fiveHour && (!scopedFiveHour || scoped.fiveHour.utilization > scopedFiveHour.utilization)) {
      scopedFiveHour = scoped.fiveHour;
    }
    if (!scoped.weekly) continue;
    (quota.modelBuckets ??= []).push({
      slug: fam.slug,
      name: fam.name || fam.slug,
      utilization: scoped.weekly.utilization,
      resetAt: scoped.weekly.resetAt,
    });
  }

  // A subscription's account-wide family states no 5-hour window at all: it
  // puts the 7-day one in `primary` and zeroes `secondary`, which classify()
  // drops, correctly, because a zero-length window is how this API says "not
  // applicable". The only 5h it states sits in a named family, and upstream
  // returns the same one whatever model was asked for — it is the account's
  // session window wearing a model's name. So fill the shared bucket from it
  // when the account-wide family left it empty, and never overwrite a reading
  // the account-wide family did give: a family bucket barring models it does
  // not meter would be the one-way ratchet the weekly buckets take such care
  // to avoid.
  if (quota.unified5h == null && scopedFiveHour) {
    quota.unified5h = scopedFiveHour.utilization;
    if (scopedFiveHour.resetAt) quota.unified5hReset = scopedFiveHour.resetAt;
  }

  return quota;
}

/** The subscription plan upstream reports, for status output. Null when absent. */
export function parseCodexPlanType(headers) {
  const value = headers?.['x-codex-plan-type'];
  return value ? String(value).trim() || null : null;
}
