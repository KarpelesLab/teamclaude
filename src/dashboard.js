// The status dashboard: a single self-contained HTML page served at
// GET /teamclaude/dashboard, rendering /teamclaude/status for humans.
//
// The page itself contains NO data — it is a static asset whose script fetches
// /teamclaude/status (same origin) with the proxy key and re-renders every few
// seconds. That split is what lets the asset be served without the key (a
// browser address bar cannot send x-api-key) while every byte of actual status
// stays behind the existing gate. The key is asked for only when the server
// refuses the page without one (401/403; loopback browsers are exempt), and is
// kept in localStorage; a later refusal (wrong or rotated key) asks again.
//
// Self-contained on purpose: no external scripts, styles, or fonts, so the
// page works on air-gapped deployments and adds no third-party surface. All
// rendering uses textContent — status fields (account names, client names) are
// operator/OAuth-derived, but they still never reach innerHTML.

import { createHash } from 'node:crypto';
import { UNAVAILABLE_TEXT, RESET_CREDIT_MAX_AGE_MS, outsideSpendText, forecastText, fleetForecastText, showSessionRow, showWeeklyRow, creditText } from './status-renderer.js';
import { USAGE_WINDOWS } from './client-usage.js';
import { EVENT_LOG_CAPACITY } from './event-log.js';
import { CREDIT_EXPIRY_WINDOW_MS } from './codex-reset-credits.js';
import { logoDataUrl, logoMarkup } from './logo.js';

export function renderDashboardHtml() {
  return PAGE;
}

/**
 * The body of every `<script>` in the page, in order. Attribute-free tags only,
 * which is all this page has and all the hash policy can admit anyway.
 *
 * @param {string} html
 */
export function inlineScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/**
 * Content-Security-Policy for the dashboard, sent by the server with the page.
 *
 * The page holds the proxy key in localStorage, so the policy is the backstop
 * for a script that should never run there: nothing loads from anywhere
 * (`default-src 'none'`), each inline script (the theme bootstrap in `<head>`
 * and the main script) is admitted by its hash rather than by
 * `'unsafe-inline'` — the page is static, so the hashes are stable — and the
 * only network the script may touch is this origin, for status and switch.
 * Styles need `'unsafe-inline'` because the layout uses `style=` attributes,
 * which hashes do not cover; CSSOM writes (`el.style.width = …`) are not
 * governed by CSP at all. `img-src data:` admits embedded images for the tab icon,
 * which is the logo inlined as a `data:` URL in `<head>`: a `data:` image can
 * carry no script and reach no network, and nothing from `'self'` or any
 * other origin is allowed. `frame-ancestors 'none'` keeps the page out of
 * another site's iframe, where a click on "switch" could be overlaid.
 */
export function dashboardCsp(html = PAGE) {
  // Every inline script, not just the first: the theme is applied by a short
  // script in <head> so the page does not paint dark and then flip to light,
  // and a hash that covered only the main script would leave that one blocked.
  const hashes = inlineScripts(html)
    .map(script => `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`)
    .join(' ');
  return [
    "default-src 'none'",
    `script-src ${hashes}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// The page's pure logic lives here, not in the script string: these functions
// close over nothing and touch no DOM, so they are serialized into the page
// with toString() below AND exported for the test suite. One implementation,
// tested and served — a test against the string would only be a source grep.

// Model-scoped weekly buckets, one row per family upstream actually metered.
// `scopedWeekly` is learned from the usage payload's `limits` array, so it is
// the complete list when present; the two dedicated fields are the fallback for
// a payload that reported `seven_day_sonnet` without a `limits` array.
export function scopedWeeklyRows(quota) {
  var q = quota || {};
  var scoped = q.scopedWeekly || {};
  var rows = [];
  Object.keys(scoped).forEach(function (family) {
    var b = scoped[family] || {};
    rows.push({ family: family, label: family.charAt(0).toUpperCase() + family.slice(1), utilization: b.utilization, resetAt: b.resetAt });
  });
  [{ family: 'fable', label: 'Fable', u: q.unified7dFable, r: q.unified7dFableReset },
    { family: 'sonnet', label: 'Sonnet', u: q.unified7dSonnet, r: q.unified7dSonnetReset }].forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(scoped, f.family) || f.u == null) return;
    rows.push({ family: f.family, label: f.label, utilization: f.u, resetAt: f.r });
  });
  rows.sort(function (a, b) { return a.family < b.family ? -1 : a.family > b.family ? 1 : 0; });
  return rows;
}

// Whether a card gets a refresh button: the probe has a quota to read for the
// account and would probe it (the server applies the same rule and says why
// when it refuses). `probeEntry` is the account's row in status.probe.accounts.
/** @param {any} account @param {any} probeEntry */
export function canRefreshQuota(account, probeEntry) {
  if (!account || account.disabled) return false;
  return !!probeEntry && probeEntry.status !== 'not-applicable';
}

// The POST a card's refresh button sends: the fleet probe, narrowed to one
// account. Provider and org ride along because a name alone can belong to two
// cards (one email with a Claude and a Codex login, or seats in two orgs).
/** @param {any} account  one entry of status.accounts @param {string|null} key */
export function refreshQuotaRequest(account, key) {
  /** @type {{ account: any, provider?: any, org?: any }} */
  var body = { account: account.name };
  if (account.provider) body.provider = account.provider;
  if (account.orgName) body.org = account.orgName;
  return {
    url: '/teamclaude/probe',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/** @param {any} res */
export function refreshQuotaOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'quota refresh failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: 'quota refreshed' };
}

// How many free rate-limit resets a Codex account has left, as the page shows
// it: null when there is nothing to go on (not a Codex account, no usage
// reading yet, or one past RESET_CREDIT_MAX_AGE_MS, the badge's own cut-off),
// else the count. Zero is a reading too, and the page says so.
/** @param {any} account @param {number|null} [now] */
export function codexResetsLeft(account, now) {
  var a = account || {};
  if (a.provider !== 'codex') return null;
  var reading = (a.quota || {}).resetCredits;
  if (!reading || !Number.isFinite(reading.available)) return null;
  var at = now == null ? Date.now() : now;
  if (Number.isFinite(reading.seenAt) && at - reading.seenAt > RESET_CREDIT_MAX_AGE_MS) return null;
  if (Number.isFinite(reading.expiresAt) && reading.expiresAt <= at) return 0;
  return Math.max(0, reading.available);
}

// The resets a set of Codex accounts holds between them, for the quota page's
// Codex card: null when none of them has a reading.
/** @param {any[]} accounts @param {number|null} [now] */
export function codexResetsSummary(accounts, now) {
  var left = 0;
  var read = 0;
  (accounts || []).forEach(function (a) {
    var n = codexResetsLeft(a, now);
    if (n == null) return;
    read++;
    left += n;
  });
  return read ? { left: left, accounts: read } : null;
}

// Whether a row gets a "Reset usage" button: a Codex account rotation can use,
// holding a credit, and a key the server would let spend it.
/** @param {any} account @param {any} caller @param {number|null} [now] */
export function canRedeemReset(account, caller, now) {
  if (!account || account.disabled) return false;
  return (codexResetsLeft(account, now) || 0) > 0 && callerCan(caller, '/teamclaude/reset-credits/redeem');
}

// The POST the button sends. Same body as refreshQuotaRequest, for the same
// reason: a name alone can belong to two cards.
/** @param {any} account @param {string|null} key */
export function redeemResetRequest(account, key) {
  var r = refreshQuotaRequest(account, key);
  r.url = '/teamclaude/reset-credits/redeem';
  return r;
}

// What a click on "Reset usage" does, decided when the click lands rather than
// when the button was drawn: a button armed and then left (the poll that would
// redraw it can be late, or failing) must not spend a reset on a click long
// after the window it offered has closed. Out of that window the click arms it
// again; a second click too soon after the first is a double-click.
/** @param {number|null|undefined} armedAt @param {number} now @param {number} confirmMs @param {number} doubleClickMs */
export function resetClickStep(armedAt, now, confirmMs, doubleClickMs) {
  if (armedAt == null || now - armedAt >= confirmMs) return 'arm';
  if (now - armedAt < doubleClickMs) return 'wait';
  return 'redeem';
}

// What the row says after a reset. A declined reset spent nothing and says
// why; one with no verdict to read — the server said it never heard back, or
// the answer itself was lost on the way to the page — may have spent a credit,
// and says that rather than reporting a failure that invites a second one.
/** @param {any} res  the server's answer, or null when none could be read */
export function redeemResetOutcome(res) {
  if (!res) return { kind: 'error', text: REDEEM_UNCERTAIN_TEXT };
  var r = res;
  if (r.ok) {
    var n = r.windowsReset || 0;
    return { kind: 'ok', text: 'usage reset' + (n ? ': ' + n + ' limit window' + (n === 1 ? '' : 's') + ' cleared' : '') };
  }
  // `unreachable` is the linked-instance relay (peers.js) losing the peer
  // mid-request: it cannot say whether the peer acted before the connection
  // went, so it is no more a "no" than an unread verdict here.
  if (r.uncertain || r.unreachable) return { kind: 'error', text: REDEEM_UNCERTAIN_TEXT };
  if (r.code === 'nothing_to_reset') return { kind: 'warn', text: 'nothing to reset yet: no limit on this account is spent, so no reset was used' };
  if (r.code === 'no_credit') return { kind: 'warn', text: 'no resets left on this account' };
  return { kind: 'error', text: 'reset failed' + (r.error ? ': ' + r.error : '') };
}

// When the soonest of a Codex account's reset credits expires, or null when the
// page cannot say: no credit, no dates read yet (the quota refresh reads them),
// the count changed since they were read (a credit granted, spent or expired),
// or the rows read did not match the count.
/** @param {any} account @param {number|null} [now] */
export function codexResetExpiry(account, now) {
  var at = now == null ? Date.now() : now;
  if (!codexResetsLeft(account, at)) return null;
  var r = (account.quota || {}).resetCredits || {};
  if (!Array.isArray(r.expiries) || r.expiriesFor !== r.available || r.expiries.length !== r.available) return null;
  /** @type {number|null} */
  var soonest = null;
  r.expiries.forEach(function (/** @type {any} */ t) {
    if (typeof t === 'number' && isFinite(t) && t > at && (soonest == null || t < soonest)) soonest = t;
  });
  return soonest;
}

/** @param {number} ts */
function shortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// "2 resets left", with the soonest expiry when the page knows it.
/** @param {number} n @param {number|null} [expiry] */
export function resetsLeftText(n, expiry) {
  var text = n ? n + (n === 1 ? ' reset left' : ' resets left') : 'no resets left';
  return n && expiry != null ? text + ' \u00b7 expires ' + shortDate(expiry) : text;
}

// The Quota page's reset-credit banner: a Codex account that got a credit in
// the last RESET_ALERT_NEW_MS, and one whose soonest credit expires within
// CREDIT_EXPIRY_WINDOW_MS (the same window autoRedeemResets treats as "use it
// or lose it"). Each has a key naming the event, so dismissing one hides that
// event and not the next one like it.
/** @param {any[]} accounts @param {string[]|null} [dismissed] @param {number|null} [now] */
export function resetCreditAlerts(accounts, dismissed, now) {
  var at = now == null ? Date.now() : now;
  var hidden = dismissed || [];
  /** @type {{kind: string, key: string, text: string}[]} */
  var out = [];
  var day = 24 * 60 * 60 * 1000;
  (accounts || []).forEach(function (a) {
    var left = codexResetsLeft(a, at);
    if (!left) return;
    var r = a.quota.resetCredits;
    var expiry = codexResetExpiry(a, at);
    if (expiry != null && expiry - at <= CREDIT_EXPIRY_WINDOW_MS) {
      var days = Math.ceil((expiry - at) / day);
      out.push({
        kind: 'warn', key: 'expiring:' + a.name + ':' + expiry,
        text: a.name + ': a free reset credit expires ' + (days <= 1 ? 'within a day' : 'in ' + days + ' days') + ' (' + shortDate(expiry) + '). Use it before then.',
      });
    }
    if (typeof r.grantedAt === 'number' && isFinite(r.grantedAt) && r.grantedAt <= at && at - r.grantedAt < RESET_ALERT_NEW_MS) {
      out.push({
        kind: 'ok', key: 'granted:' + a.name + ':' + r.grantedAt,
        text: a.name + ' got a new free reset credit on ' + shortDate(r.grantedAt) + ': ' + resetsLeftText(left, expiry) + '.',
      });
    }
  });
  return out.filter(function (x) { return hidden.indexOf(x.key) < 0; });
}

// The rows a third-party backend's own reading draws on its card (#530). The
// probe stores it as `quota.backend` (backend-quota.js): per-window fractions
// when the provider reports distinct windows, else one fraction, else text
// alone. A window past its reset is left out — the reading predates the reset,
// so its fraction no longer describes anything. `text` is what is left to say
// when no bar can be drawn: a balance has no fraction to fill a bar with.
/** @param {any} backend @param {number} [now] */
export function backendQuotaRows(backend, now) {
  var b = backend || {};
  var at = now == null ? Date.now() : now;
  var w = b.windows || {};
  var rows = [];
  [{ key: 'fiveHour', label: 'Session' }, { key: 'weekly', label: 'Weekly' }, { key: 'monthly', label: 'Monthly' }].forEach(function (d) {
    var win = w[d.key];
    if (!win || win.utilization == null) return;
    if (win.resetAt != null && win.resetAt <= at) return;
    rows.push({ label: d.label, utilization: win.utilization, resetAt: win.resetAt == null ? null : win.resetAt });
  });
  // The aggregate was measured with these windows: once they expire it must
  // not turn back into a timeless reading that keeps the account hidden.
  if (!Object.keys(w).length && b.utilization != null) rows.push({ label: b.label || 'Quota', utilization: b.utilization, resetAt: null });
  return { rows: rows, text: !rows.length && b.text ? (b.label || 'Quota') + ': ' + b.text : null };
}

// What an account has spent, cache included. `totalInputTokens` counts uncached
// input only, which on Claude Code traffic is ~0.05% of the input side — a
// total without the cache fields understates the account by orders of magnitude.
export function accountTokens(usage) {
  var u = usage || {};
  return (u.totalInputTokens || 0) + (u.totalOutputTokens || 0)
    + (u.totalCacheReadTokens || 0) + (u.totalCacheCreationTokens || 0);
}

// A model id as a person would say it: claude-opus-5-5 -> "Opus 5.5",
// claude-haiku-4-5-20251001 -> "Haiku 4.5", gpt-6.1-sol -> "GPT 6.1 Sol".
// A context suffix ("[1m]") is dropped; any other shape is shown as sent.
export function modelLabel(/** @type {string} */ id) {
  var s = String(id);
  var br = s.indexOf('[');
  if (br > 0) s = s.slice(0, br);
  var parts = s.split('-');
  var isNum = function (/** @type {string} */ p) { return p !== '' && !isNaN(Number(p)); };
  var cap = function (/** @type {string} */ w) { return w.charAt(0).toUpperCase() + w.slice(1); };
  if (parts[0] === 'claude' && parts.length >= 3) {
    // Date stamps (8 digits) are a snapshot id, not part of the version.
    var nums = parts.slice(2).filter(function (p) { return isNum(p) && p.length < 8; });
    if (nums.length) return cap(parts[1]) + ' ' + nums.slice(0, 2).join('.');
  }
  if (parts[0] === 'gpt' && parts.length >= 2) {
    return 'GPT ' + parts[1] + (parts.length > 2 ? ' ' + parts.slice(2).map(cap).join(' ') : '');
  }
  // xAI writes a version either way, `grok-4.1-fast` or `grok-4-1-fast`, and
  // dates a snapshot with four digits (`grok-4-0709`): the version reads 4.1
  // both ways and the date is dropped, as for Claude. Only a part of digits
  // alone is a date: `4.20` is four characters long and a version.
  if (parts[0] === 'grok' && parts.length >= 2) {
    /** @type {string[]} */
    var words = [];
    parts.slice(1).forEach(function (p) {
      if (/^\d{4,}$/.test(p)) return;
      var last = words.length - 1;
      if (isNum(p) && last >= 0 && isNum(words[last]) && words[last].indexOf('.') < 0) words[last] += '.' + p;
      else words.push(cap(p));
    });
    return 'Grok ' + words.join(' ').replace(/\bNon /g, 'Non-');
  }
  return s;
}

// The models an account served in the last 15 minutes, newest first, at most
// three. Haiku is what Claude Code uses for side requests (titles, summaries),
// so it is listed only when nothing else ran — otherwise it would crowd out
// the model the sessions on that account are actually working with.
export function recentModelLabels(/** @type {any} */ usage, /** @type {number} */ now) {
  /** @type {Record<string, number>} */
  var seen = (usage && usage.recentModels) || {};
  var at = now == null ? Date.now() : now;
  var ids = Object.keys(seen).filter(function (k) { return at - seen[k] < 15 * 60 * 1000; })
    .sort(function (x, y) { return seen[y] - seen[x]; });
  var main = ids.filter(function (k) { return k.toLowerCase().indexOf('haiku') < 0; });
  return (main.length ? main : ids).slice(0, 3).map(modelLabel);
}

export function providerLabel(provider) {
  if (provider === 'codex') return 'Codex';
  if (provider === 'grok') return 'Grok';
  if (provider === 'anthropic') return 'Claude';
  return provider || 'Unknown';
}

// Every bucket switchThreshold can be keyed by, plus the short names the
// threshold badge shows them under. Mirrors THRESHOLD_BUCKET_KEYS in model.js
// and THRESHOLD_BUCKET_LABELS in status-renderer.js — duplicated rather than
// imported, because the browser never runs an import. It does not see this
// module's scope either: a helper reaches the page as its own source text, so
// these two are written into the page by SHARED_CONSTS below. Without that the
// first table-form override throws a ReferenceError inside render() and takes
// the accounts pane with it.
export var THRESHOLD_BUCKET_KEYS = ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable', 'tokens', 'requests'];
/** @type {Object<string, string>} */
export var THRESHOLD_BUCKET_LABELS = {
  unified5h: '5h', unified7d: '7d', unified7dSonnet: 'sonnet', unified7dFable: 'fable',
  tokens: 'tokens', requests: 'requests',
};

/**
 * "switch at 100%" / "switch 7d 90%, fable 80%" — an account's OWN
 * switchThreshold (issue #409), or '' when it has none or every override it
 * carries merely repeats what the fleet already resolves to. `fleetThreshold`
 * and `fleetThresholds` are the status payload's own top-level fields
 * (`status.switchThreshold` / `status.switchThresholds`), so the comparison
 * uses the exact fleet value the live server is gating on.
 * @param {number|Object<string, number>|null|undefined} accountThreshold
 * @param {number|null|undefined} fleetThreshold
 * @param {Object<string, number>|null|undefined} fleetThresholds
 * @returns {string}
 */
export function thresholdBadgeText(accountThreshold, fleetThreshold, fleetThresholds) {
  /** @param {string} bucket */
  function fleetFor(bucket) {
    if (fleetThresholds && typeof fleetThresholds === 'object') {
      var v = fleetThresholds[bucket];
      if (v == null) v = fleetThresholds.default;
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return typeof fleetThreshold === 'number' && isFinite(fleetThreshold) ? fleetThreshold : 0.98;
  }
  /** @param {number} v */
  function pct(v) { return (Math.round(v * 1000) / 10) + '%'; }
  /** @param {unknown} v */
  function valid(v) { return typeof v === 'number' && isFinite(v); }
  /** @type {string[]} */
  var parts = [];
  /** @type {Object<string, any>} */
  var table = {};
  /** @type {any} */
  var ownDefault = null;
  if (typeof accountThreshold === 'number') {
    if (!valid(accountThreshold)) return '';
    ownDefault = accountThreshold;
    if (accountThreshold !== fleetFor('default')) parts.push('at ' + pct(accountThreshold));
  } else if (accountThreshold && typeof accountThreshold === 'object' && !Array.isArray(accountThreshold)) {
    table = accountThreshold;
    ownDefault = table.default;
    Object.keys(table).forEach(function (key) {
      var v = table[key];
      if (!valid(v)) return;
      if (key !== 'default' && THRESHOLD_BUCKET_KEYS.indexOf(key) === -1) return;
      if (v !== fleetFor(key)) parts.push((key === 'default' ? 'at' : (THRESHOLD_BUCKET_LABELS[key] || key)) + ' ' + pct(v));
    });
  }
  // As switchThresholdDiffs in model.js: the account's own default outranks a
  // bucket entry in the FLEET table, so a default equal to the fleet's can
  // still move a bucket the fleet names (fleet 7d at 85%, account 0.98 puts
  // that account's 7d at 98%). When the defaults differ, "at N%" already
  // covers every bucket the account does not list.
  if (valid(ownDefault) && ownDefault === fleetFor('default')) {
    THRESHOLD_BUCKET_KEYS.forEach(function (key) {
      if (valid(table[key])) return;
      if (ownDefault !== fleetFor(key)) parts.push(THRESHOLD_BUCKET_LABELS[key] + ' ' + pct(ownDefault));
    });
  }
  return parts.length ? 'switch ' + parts.join(', ') : '';
}

/**
 * `now` keeps the fourth slot master's reset-credit callers already use; the
 * fleet threshold pair (#409) follows it.
 * @param {Record<string, any>|null|undefined} account
 * @param {string|null} [current]
 * @param {Record<string, string>|null} [currentAccounts]
 * @param {number|null} [now]  ms epoch a reset-credit reading's age is measured from
 * @param {number|null|undefined} [fleetThreshold]
 * @param {Object<string, number>|null|undefined} [fleetThresholds]
 */
export function accountBadges(account, current, currentAccounts, now, fleetThreshold, fleetThresholds) {
  var a = account || {};
  var isCurrent = currentAccounts
    ? currentAccounts[a.provider] === a.name
    : a.name === current;
  var status = a.disabled ? 'disabled' : (a.status || 'unknown');
  var recent = Number.isFinite(a.sessions) ? a.sessions : 0;
  var known = Number.isFinite(a.knownSessions) ? a.knownSessions : 0;
  var badges = [
    { cls: 'provider ' + (a.provider || 'unknown'), text: providerLabel(a.provider) },
    { cls: 'meta', text: a.type || 'unknown' },
    { cls: 'meta priority', text: 'prio ' + (a.priority || 0) },
  ];
  if (isCurrent) badges.push({ cls: 'current', text: 'current' });
  badges.push({ cls: status, text: status });
  // Cordoned: no new conversation goes here while the ones on it stay, with
  // how many are left — what an operator waits to see reach 0 before a
  // disable or a removal.
  if (a.cordoned === true) badges.push({ cls: 'cordoned', text: 'cordoned' + (Number.isFinite(a.cordonRemaining) ? ' · ' + a.cordonRemaining + ' left' : '') });
  if (recent) badges.push({ cls: 'sessions', text: recent + ' recent' });
  if (known > recent) badges.push({ cls: 'sessions known', text: known + ' known' });
  // Free Codex rate-limit reset credits this account holds — what it could
  // spend to undo an exhausted window rather than wait one out. The count is
  // the account's holdings, not what upstream would apply this instant.
  // A reading past RESET_CREDIT_MAX_AGE_MS is dropped, as it is on the status
  // screen and the TUI row: only the usage probe refreshes the count, so an old
  // one may describe a credit that has since been redeemed or has expired.
  var reading = (a.quota || {}).resetCredits || {};
  var credits = reading.available;
  var at = now == null ? Date.now() : now;
  var stale = Number.isFinite(reading.seenAt) && at - reading.seenAt > RESET_CREDIT_MAX_AGE_MS;
  // A Claude banked reset states when it lapses: drop it past then, and say
  // the date while it stands (the claude.ai Resets page names it the same way).
  var expired = Number.isFinite(reading.expiresAt) && reading.expiresAt <= at;
  if (Number.isFinite(credits) && credits > 0 && !stale && !expired) {
    var expires = Number.isFinite(reading.expiresAt)
      ? ' \u00b7 expires ' + new Date(reading.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '';
    // Fable resets (oauth.js bankedResets) clear the Fable weekly only, so they
    // are named apart from the resets that put every model back.
    var fable = Number.isFinite(reading.fable) ? Math.min(Math.max(reading.fable, 0), credits) : 0;
    var general = credits - fable;
    var held = [];
    if (general > 0) held.push(general + ' reset credit' + (general === 1 ? '' : 's'));
    if (fable > 0) held.push(fable + ' Fable reset' + (fable === 1 ? '' : 's'));
    badges.push({ cls: 'meta resets', text: held.join(', ') + expires });
  }
  // Arguments 5/6 are optional (the pre-#409 unit test above omits them): with
  // no account switchThreshold at all — the common case — thresholdBadgeText
  // returns '' regardless of what the fleet args are, so an old caller sees no
  // new badge. A caller that DOES set switchThreshold on the account is
  // expected to pass the fleet's own value too, the way `render()` does below,
  // or the comparison falls back to thresholdBadgeText's own 0.98 default.
  var thresholdText = thresholdBadgeText(a.switchThreshold, fleetThreshold, fleetThresholds);
  if (thresholdText) badges.push({ cls: 'meta threshold', text: thresholdText });
  // Extra-usage fallback: one badge, the louder state winning. Strict `true`
  // so a missing field on an older server's payload shows nothing.
  if (a.onExtraUsage === true) badges.push({ cls: 'extra-usage billing', text: 'on extra usage \u2014 billing' });
  else if (a.allowExtraUsage === true) badges.push({ cls: 'extra-usage', text: 'extra usage allowed' });
  // The account's own egress proxy, as the status payload carries it: already
  // password-masked (describeRouting), and absent for an account on the fleet
  // path, which is the default and earns no badge.
  if (typeof a.routing === 'string' && a.routing) badges.push({ cls: 'meta routing', text: 'via ' + a.routing });
  // Stays past the entitlement cooldown, until the account serves again.
  var denial = a.entitlementDenial;
  if (denial) badges.push({ cls: 'throttled', text: 'OAuth denied' + (denial.count > 1 ? ' \u00d7' + denial.count : '') });
  return badges;
}

// One row per CONVERSATION, from `sessions.items` (proxy.sessionDetail). A
// Claude Code session that fans out to nine subagents is nine rows, because a
// conversation is what holds a pin and a prompt cache.
//
// `id` is the pin key those rows are keyed by — a session id narrowed to one
// conversation — which is an identity for routing, not one to read: a composite
// nobody recognises, and identical between siblings but for its tail. So the
// visible identity is split in two, the session an operator knows and the
// conversation that tells its siblings apart. A record labelled by no request
// (touch() alone) has no session name, and falls back to the key it is under.
//
// The token columns are #192's numbers — what each response actually reported,
// cache included — summed across the weekly buckets the conversation touched.
// `pins` is a bucket→account map rather than one index, because a conversation
// spending two model families is served by two accounts at the same time.
export function sessionRows(sessions) {
  var items = (sessions && sessions.items) || [];
  return items.map(function (s) {
    var buckets = s.tokens || {};
    var row = {
      id: s.id,
      session: s.session || s.id || '',
      // Enough of the digest to separate one session's live conversations; the
      // whole of it is a column read to the end by nobody.
      conversation: String(s.conversation || '').slice(0, 8),
      client: s.client || '',
      project: (s.dimensions || {}).project || '',
      active: !!s.active,
      requests: s.requests || 0,
      starved: s.starved || 0,
      cacheRead: 0, cacheCreation: 0, input: 0, output: 0, context: 0,
      accounts: Object.keys(s.pins || {}).map(function (b) { return s.pins[b]; }).join(', '),
      lastSeen: s.lastSeen || 0,
    };
    Object.keys(buckets).forEach(function (b) {
      var t = buckets[b] || {};
      row.cacheRead += t.cacheRead || 0;
      row.cacheCreation += t.cacheCreation || 0;
      row.input += t.input || 0;
      row.output += t.output || 0;
      row.context += t.context || 0;
    });
    row.total = row.cacheRead + row.cacheCreation + row.input + row.output;
    return row;
  });
}

// "pinned: 3f2a1b9c → api-1, 9d0e4c11 → work" — the sessions an operator held
// on one account (`teamclaude switch --session`), or '' when there are none.
/** @param {any} pins */
export function sessionPinsText(pins) {
  if (!Array.isArray(pins) || !pins.length) return '';
  return 'pinned: ' + pins.map(function (p) { return (p && p.session || '?') + ' \u2192 ' + (p && p.account || '?'); }).join(', ');
}

export function filterSessionRows(rows, filters) {
  var f = filters || {};
  return (rows || []).filter(function (r) {
    if (f.project && r.project !== f.project) return false;
    if (f.client && r.client !== f.client) return false;
    return true;
  });
}

// Text sorts alphabetically, numbers numerically. A missing value sorts as
// empty/zero rather than dropping the row.
export function sortRows(rows, key, dir) {
  var sign = dir === 'asc' ? 1 : -1;
  return (rows || []).slice().sort(function (a, b) {
    var x = a[key], y = b[key];
    if (typeof x === 'string' || typeof y === 'string') {
      return sign * String(x == null ? '' : x).localeCompare(String(y == null ? '' : y));
    }
    return sign * ((x || 0) - (y || 0));
  });
}

export function uniqSorted(values) {
  var seen = Object.create(null);
  (values || []).forEach(function (v) { if (v) seen[v] = true; });
  return Object.keys(seen).sort();
}

// The request the switch button sends: POST /teamclaude/switch with the same
// key the status poll uses. Pure, so the test suite can send exactly this
// through a real proxy and prove the same-origin CSRF gate lets the page in.
export function switchRequest(name, key) {
  return {
    url: '/teamclaude/switch',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ account: name }),
    },
  };
}

// The request the threshold control sends. The number goes as typed: what
// counts as a percentage is the server's rule (1–100, kept to tenths), and a
// second opinion here would only disagree with it on the edges.
/**
 * @param {number|string} percent
 * @param {string|null|undefined} key
 */
export function thresholdRequest(percent, key) {
  return {
    url: '/teamclaude/threshold',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ percent: percent }),
    },
  };
}

// The stored 0–1 ratio as the number the control shows. Tenths, and no trailing
// zero: the setting is quantised to tenths of a percent, so 0.98 must read back
// as "98" rather than "98.0" for a re-save to be a no-op the operator can see.
/** @param {unknown} value */
export function thresholdPercentText(value) {
  /** @type {any} */ var ratio = value;
  // A per-bucket table: the control sets one number for every bucket, so what it
  // shows is the default the table falls back to.
  if (ratio && typeof ratio === 'object' && !Array.isArray(ratio)) ratio = ratio.default;
  if (typeof ratio !== 'number' || !isFinite(ratio)) return '';
  return String(Math.round(ratio * 1000) / 10);
}

// What to tell the operator after a threshold change. `dropped` is the part a
// bare "saved" would hide: one number replaces a per-bucket table rather than
// hiding one behind it, and the operator who set those buckets should hear it.
/**
 * @param {any} res
 * @returns {{ kind: string, text: string }}
 */
export function thresholdOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'threshold change failed' + (res && res.error ? ': ' + res.error : '') };
  var pct = thresholdPercentText(res.switchThreshold);
  var dropped = res.dropped || [];
  if (dropped.length) return { kind: 'warn', text: 'switch threshold set to ' + pct + '% — dropped the per-bucket thresholds (' + dropped.join(', ') + ')' };
  return { kind: 'ok', text: 'switch threshold set to ' + pct + '%' };
}

// The Quota refresh picker's choices: off, or 5 to 120 seconds. An interval set
// elsewhere (CLI, TUI, a hand edit) that is not on the list is added as its own
// choice, so the picker always shows what the proxy is really doing instead of
// snapping to a neighbour and inviting a save that changes the setting.
/** @param {unknown} current  status.probe.intervalSeconds */
export function probeIntervalOptions(current) {
  var choices = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
  var cur = typeof current === 'number' && isFinite(current) && current >= 0 ? Math.round(current) : 0;
  if (choices.indexOf(cur) < 0) choices.push(cur);
  choices.sort(function (a, b) { return a - b; });
  return choices.map(function (v) { return { value: v, label: v ? 'every ' + v + 's' : 'off' }; });
}

/**
 * @param {number} seconds  0 turns the probe off
 * @param {string|null|undefined} key
 */
export function probeIntervalRequest(seconds, key) {
  return {
    url: '/teamclaude/probe-interval',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ seconds: seconds }),
    },
  };
}

/**
 * @param {any} res
 * @returns {{ kind: string, text: string }}
 */
export function probeIntervalOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'quota refresh change failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: res.quotaProbeSeconds > 0 ? 'quota refreshes every ' + res.quotaProbeSeconds + 's' : 'quota refresh turned off' };
}

/**
 * @param {string} name  '' goes back to the host name
 * @param {string|null|undefined} key
 */
export function instanceNameRequest(name, key) {
  return {
    url: '/teamclaude/instance-name',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ name: name }),
    },
  };
}

/**
 * @param {any} res
 * @returns {{ kind: string, text: string }}
 */
export function instanceNameOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'instance name change failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: res.custom ? 'this instance is now called ' + res.name : 'instance name cleared; it goes by its host name, ' + res.name };
}

/**
 * The key box's password sign-in. A right password is answered with the proxy
 * key, which the page then keeps like a typed one.
 * @param {string} username
 * @param {string} password
 */
export function passwordLoginRequest(username, password) {
  return {
    url: '/teamclaude/auth/login',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: username, password: password }),
    },
  };
}

/**
 * @param {number} status
 * @param {any} res
 * @returns {{ key: string } | { error: string }}
 */
export function passwordLoginOutcome(status, res) {
  if (res && res.ok && typeof res.key === 'string' && res.key) return { key: res.key };
  if (status === 401) return { error: 'Wrong username or password.' };
  if (status === 429) return { error: 'Too many wrong tries. Wait ' + ((res && res.retryAfterSec) || 60) + ' seconds and try again.' };
  if (status === 404) return { error: 'This proxy has no dashboard password. Enter the proxy key instead.' };
  if (status === 403 && res && res.error) return { error: 'Refused: ' + res.error + '.' };
  return { error: 'Sign-in failed' + (res && res.error ? ': ' + res.error : ' (status ' + status + ')') + '.' };
}

/**
 * Set the dashboard password, or turn it off with both fields empty.
 * @param {string} username
 * @param {string} password
 * @param {string|null|undefined} key
 */
export function dashboardLoginRequest(username, password, key) {
  return {
    url: '/teamclaude/dashboard-login',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ username: username, password: password }),
    },
  };
}

/**
 * @param {any} res
 * @returns {{ kind: string, text: string }}
 */
export function dashboardLoginOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'dashboard password change failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: res.username ? 'dashboard password set for ' + res.username : 'dashboard password turned off' };
}

/**
 * @param {string} address  '' goes back to the guess
 * @param {string|null|undefined} key
 */
export function instanceAddressRequest(address, key) {
  return {
    url: '/teamclaude/instance-address',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ address: address }),
    },
  };
}

/**
 * @param {any} res
 * @returns {{ kind: string, text: string }}
 */
export function instanceAddressOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'instance address change failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: res.address ? 'other machines are now given ' + res.address : 'instance address cleared; the link uses a guess again' };
}

/**
 * @param {number} percent  0 shows every share
 * @param {string|null|undefined} key
 */
export function outsideSpendHideRequest(percent, key) {
  return {
    url: '/teamclaude/outside-spend-hide',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ percent: percent }),
    },
  };
}

/**
 * @param {any} res
 * @returns {{ kind: string, text: string }}
 */
export function outsideSpendHideOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'outside spend change failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: res.outsideSpendHidePercent > 0
    ? 'outside spend at or below ' + res.outsideSpendHidePercent + '% is now hidden'
    : 'outside spend is now shown at every share' };
}

// What the Instance picker calls the machine the page was opened on: its
// name, or "This machine" from a proxy too old to say.
/** @param {any} self  { name } from /teamclaude/peers, or status.instance */
export function selfInstanceLabel(self) {
  return self && typeof self.name === 'string' && self.name ? self.name : 'This machine';
}

// What to tell the operator afterwards. The endpoint answers `ok` for the choice
// being recorded and `eligible` for whether traffic will actually follow it —
// two different things, and a bare "done" would be a lie for a spent target.
/**
 * POST for an account control. `spec` is {place}/{priority} for a priority
 * move, or {disabled} to take an account out of rotation or put it back.
 *
 * @param {any} name
 * @param {{ place?: string, priority?: number, disabled?: boolean, cordoned?: boolean }} spec
 * @param {string|null} key
 */
export function accountControlRequest(name, spec, key) {
  var isCordon = spec.cordoned !== undefined;
  var isPriority = spec.disabled === undefined && !isCordon;
  /** @type {{ account: any, place?: any, priority?: any, disabled?: any, cordoned?: any }} */
  var body = { account: name };
  if (isPriority) {
    if (spec.place) body.place = spec.place;
    else body.priority = spec.priority;
  } else if (isCordon) {
    body.cordoned = spec.cordoned;
  } else {
    body.disabled = spec.disabled;
  }
  return {
    url: isPriority ? '/teamclaude/priority' : isCordon ? '/teamclaude/account-cordon' : '/teamclaude/disable',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/**
 * What to tell the operator afterwards. A priority move reports the number it
 * landed on, which is the part the caller did not choose when it asked for
 * 'first' or 'last'.
 *
 * @param {any} res
 * @param {{ place?: string, priority?: number, disabled?: boolean, cordoned?: boolean }} spec
 */
export function accountControlOutcome(res, spec) {
  if (!res || !res.ok) return { kind: 'error', text: 'change failed' + (res && res.error ? ': ' + res.error : '') };
  if (spec.disabled !== undefined) {
    return { kind: 'ok', text: (res.disabled ? 'disabled ' : 'enabled ') + res.name };
  }
  // A cordon reports what it leaves running, which is what an operator waits
  // on, and warns when no other account is left to take new conversations.
  if (spec.cordoned !== undefined) {
    if (!res.cordoned) return { kind: 'ok', text: 'uncordoned ' + res.name + ': it takes new conversations again' };
    var left = Number.isFinite(res.remaining) ? res.remaining : null;
    var text = 'cordoned ' + res.name + ': no new conversations'
      + (left == null ? '' : ', ' + left + ' still on it' + (left === 0 ? ', so disabling or removing it ends nothing running' : ''));
    if (res.inService === 0) return { kind: 'warn', text: text + '; no other account takes new conversations now' };
    return { kind: 'ok', text: text };
  }
  return { kind: 'ok', text: res.name + ' priority ' + res.priority };
}

/**
 * The colour family a provider group is drawn in, so a Claude login and a
 * ChatGPT (Codex) login never look alike: the class on its badge, its tab and
 * its section.
 *
 * @param {string} group  accountGroup()
 */
export function providerTone(group) {
  if (group === 'anthropic') return 'claude';
  if (group === 'codex') return 'codex';
  if (group === 'grok') return 'grok';
  return 'backend';
}

/**
 * The provider a "Sign in again" button would sign in, or null when there is
 * nothing to sign in: only an OAuth login the upstream has signed out
 * (status `error`) needs one. A key is replaced, not signed in.
 *
 * @param {any} account  one entry of status.accounts
 * @returns {'claude'|'codex'|'grok'|null}
 */
export function needsSignIn(account) {
  var a = account || {};
  if (a.type !== 'oauth' || a.status !== 'error' || a.backend) return null;
  // Its tokens come from a file (importFrom) on every reload, so a sign-in
  // here would be stored and never used: fileSignInHint says where to go.
  if (a.credentialsFromFile) return null;
  return a.provider === 'codex' || a.provider === 'grok' ? a.provider : 'claude';
}

/**
 * What to do instead, for a signed-out account whose tokens are read from a
 * credentials file (importFrom): sign in with the tool that owns the file,
 * then reload. Null for every other account.
 *
 * @param {any} account  one entry of status.accounts
 * @returns {string|null}
 */
export function fileSignInHint(account) {
  var a = account || {};
  if (a.type !== 'oauth' || a.status !== 'error' || !a.credentialsFromFile) return null;
  var tool = a.provider === 'codex' ? 'the Codex CLI (codex login)' : a.provider === 'grok' ? 'Grok Build (grok login)' : 'Claude Code (claude /login)';
  return 'Its sign-in is read from a credentials file. Sign in again in ' + tool + ', then Reload config on the Settings page.';
}

/**
 * Whether the page itself was opened on the proxy's machine. Only then can the
 * browser reach a loopback listener there and finish a sign-in by itself.
 *
 * @param {string} hostname  location.hostname
 */
export function isLoopbackHost(hostname) {
  var h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/**
 * POST for one step of a dashboard sign-in: 'start' {provider}, 'code'
 * {id, code}, 'status' {id} or 'cancel' {id}.
 *
 * @param {string} step
 * @param {Record<string, any>} body
 * @param {string|null} key
 */
export function signInRequest(step, body, key) {
  return {
    url: '/teamclaude/login/' + step,
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/**
 * What the sign-in panel offers for a started sign-in: the link to open, and
 * what to do once the provider is done with the browser.
 *
 * Claude hands back two links. The loopback one finishes by itself, but only
 * for a browser on the proxy's machine; the code-page one works from anywhere
 * and ends on a page showing a code to paste. Codex has one link whose
 * redirect names localhost:1455: it finishes by itself on the proxy's machine,
 * and anywhere else lands on an address that does not load, which is the
 * thing to paste. Grok's is a device sign-in: one link that works anywhere,
 * a code to check on xAI's page, and nothing to paste.
 *
 * @param {any} start  the reply to 'start'
 * @param {string} hostname  location.hostname
 * @returns {{ href: string, auto: boolean, ask: string, note: string|null, code?: string }}
 */
export function signInPlan(start, hostname) {
  var s = start || {};
  var local = isLoopbackHost(hostname);
  if (s.provider === 'grok') {
    return {
      href: s.url,
      auto: true,
      ask: 'Check that xAI\'s page shows this code, then approve the sign-in. This finishes by itself.',
      note: s.note || null,
      code: s.userCode || '',
    };
  }
  if (s.provider === 'codex') {
    var auto = local && !!s.listening;
    return {
      href: s.url,
      auto: auto,
      ask: auto
        ? 'Approve the sign-in in the new tab and this finishes by itself. If the tab ends on a page that does not load, copy its whole address and paste it here.'
        : 'Approve the sign-in in the new tab. It then goes to a localhost:1455 address that does not load: copy that whole address from the address bar and paste it here.',
      note: s.note || null,
    };
  }
  var loop = local && !!s.browserUrl;
  return {
    href: loop ? s.browserUrl : s.url,
    auto: loop,
    ask: loop
      ? 'Approve the sign-in in the new tab and this finishes by itself.'
      : 'Approve the sign-in in the new tab. The page then shows a code: copy it and paste it here.',
    note: s.note || null,
  };
}

/**
 * Where a polled sign-in stands, as the panel says it. `done` closes the
 * panel's wait: success, failure, a cancel, or a sign-in the server no longer
 * knows (it was replaced, or the server restarted).
 *
 * @param {any} res  the reply to 'status'
 * @param {string} label  the provider as the page names it
 * @returns {{ done: boolean, kind: string, text: string }}
 */
export function signInStatusOutcome(res, label) {
  var r = res || {};
  if (r.ok !== true) return { done: true, kind: 'error', text: label + ' sign-in failed' + (r.error ? ': ' + r.error : '') };
  if (r.state === 'succeeded' && r.fileBacked) {
    return {
      done: true, kind: 'warn',
      text: 'Signed in' + (r.account ? ' as ' + r.account : '') + ', but that account reads its sign-in from a credentials file, which TeamClaude keeps using. Sign in again in '
        + (label === 'Codex' ? 'the Codex CLI' : label === 'Grok' ? 'Grok Build' : 'Claude Code') + ', then Reload config.',
    };
  }
  if (r.state === 'succeeded') {
    var who = r.account ? ' as ' + r.account : '';
    return { done: true, kind: 'ok', text: (r.action === 'updated' ? 'Signed in to ' + label + ' again' : 'Added the ' + label + ' account') + who };
  }
  if (r.state === 'failed') return { done: true, kind: 'error', text: label + ' sign-in failed' + (r.error ? ': ' + r.error : '') };
  if (r.state === 'cancelled') return { done: true, kind: 'warn', text: label + ' sign-in cancelled' };
  if (r.state === 'unknown') return { done: true, kind: 'warn', text: label + ' sign-in is no longer running; start it again' };
  if (r.state === 'finishing') return { done: false, kind: '', text: 'Code accepted, finishing the sign-in…' };
  return { done: false, kind: '', text: 'Waiting for you to sign in…' };
}

/**
 * POST to remove one account. The provider and org go with the name, so the
 * button removes the account it sits on and not a namesake.
 *
 * @param {any} account  one entry of status.accounts
 * @param {string|null} key
 */
export function removeRequest(account, key) {
  /** @type {{ account: any, provider?: any, org?: any }} */
  var body = { account: account.name };
  if (account.provider) body.provider = account.provider;
  if (account.orgName) body.org = account.orgName;
  return {
    url: '/teamclaude/remove',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/** @param {any} res */
export function removeOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'remove failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: 'Removed ' + res.name + '. TeamClaude no longer holds its sign-in; you stay signed in everywhere else.' };
}

// The start of a failed client-key step's message. A page constant too: see SHARED_CONSTS.
const CLIENT_KEY_FAILED = { create: 'could not create the key', revoke: 'could not revoke the key', show: 'could not read the key' };

/**
 * POST to create, revoke or show a client key (proxy.clientKeys) by name.
 *
 * @param {'create'|'revoke'|'show'} step
 * @param {string} name
 * @param {string|null} key  the proxy key the page holds, not the client key
 */
export function clientKeyRequest(step, name, key) {
  return {
    url: '/teamclaude/client-keys/' + step,
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ name: name }),
    },
  };
}

/**
 * What to tell the operator after a create or revoke. A first key closes a gate
 * that admitted everybody until now, which is worth saying at the moment it
 * happens rather than when a client elsewhere starts getting 401s.
 *
 * @param {any} res
 * @param {'create'|'revoke'|'show'} step
 */
export function clientKeyOutcome(res, step) {
  if (!res || !res.ok) {
    return { kind: 'error', text: CLIENT_KEY_FAILED[step] + (res && res.error ? ': ' + res.error : '') };
  }
  // The panel that opens is the answer to a show; a line above it would repeat it.
  if (step === 'show') return { kind: 'ok', text: '' };
  if (step === 'revoke') return { kind: 'ok', text: 'Revoked ' + res.name + '. Its usage so far stays in the table.' };
  if (res.firstKey) return { kind: 'warn', text: 'Created ' + res.name + '. It is the proxy\'s first key, so callers on other machines now need a key too.' };
  return { kind: 'ok', text: 'Created ' + res.name + '.' };
}

/**
 * What to paste into a client to use a new key: Claude Code's environment, the
 * Codex CLI's provider block and Grok Build's base URL. `origin` is the address
 * this page was opened at, which is the proxy as this browser reaches it.
 *
 * Grok Build gets no key: it sends its own sign-in as the bearer, and its
 * `extra_headers` setting rides only on some inference calls (checked against
 * grok 1.0.77: never on /v1/models, /v1/settings or /v1/user), so a key in it
 * would still leave most of its requests refused. It can only use the loopback
 * exemption, so its address is not `origin` but the one the proxy reports for
 * a direct loopback connection (`grokLocal`, server.js grokLocalBase). Null
 * when the proxy has none (or is too old to say): no Grok line then.
 *
 * @param {string} origin
 * @param {string} key
 * @param {string|null} [grokLocal]
 */
export function clientKeySetup(origin, key, grokLocal) {
  // Show details hands back keys written into the file by hand, which may hold
  // `$`, quotes or spaces: single-quote those for the shell, and let JSON's
  // escapes (a subset of TOML's basic-string escapes) quote them for Codex.
  var sh = function (/** @type {string} */ v) { return /^[A-Za-z0-9._\/:@%+=,-]+$/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'"; };
  return {
    claude: 'export ANTHROPIC_BASE_URL=' + sh(origin) + '\nexport ANTHROPIC_API_KEY=' + sh(key),
    codex: 'model_provider = "teamclaude"\n\n[model_providers.teamclaude]\nname = "teamclaude"\nbase_url = ' + JSON.stringify(origin + '/backend-api/codex') + '\n'
      + 'wire_api = "responses"\nhttp_headers = { "x-api-key" = ' + JSON.stringify(key) + ' }',
    grok: typeof grokLocal === 'string' && grokLocal ? 'export GROK_CLI_CHAT_PROXY_BASE_URL=' + sh(grokLocal) : null,
  };
}

/**
 * The request behind a Connect your tools button: connect or disconnect the
 * named clients (client-connect.js). `replace` is sent only after the second
 * click on a client that points elsewhere.
 *
 * @param {string[]} clients
 * @param {'connect'|'disconnect'} action
 * @param {boolean} replace
 * @param {string|null} key
 */
export function connectRequest(clients, action, replace, key) {
  /** @type {{ clients: string[], action: string, replace?: boolean }} */
  var body = { clients: clients, action: action };
  if (replace) body.replace = true;
  return {
    url: '/teamclaude/clients/connect',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/**
 * One row of the Connect your tools card: the pill, the lines under the
 * name, and the button (null when there is nothing a click can do).
 * `armed`: the row's Connect was clicked once over a setting that points
 * elsewhere, so the button now replaces it.
 *
 * @param {any} c  a client status from /teamclaude/clients/connect
 * @param {boolean} armed
 */
export function connectRowView(c, armed) {
  /** @type {Record<string, { cls: string, text: string }>} */
  var pills = {
    connected: { cls: 'badge active', text: 'Connected' },
    disconnected: { cls: 'badge', text: 'Not connected' },
    elsewhere: { cls: 'badge throttled', text: 'Uses another setting' },
    unreadable: { cls: 'badge error', text: 'Cannot read' },
  };
  var lines = [c.where];
  if (c.state === 'elsewhere' && c.current) lines.push('Now set to ' + c.current);
  if (c.state === 'unreadable' && c.problem) lines.push(c.problem);
  if (c.note) lines.push(c.note);
  var action = null;
  if (c.state === 'connected') action = { label: 'Disconnect', cls: 'btn', action: 'disconnect', replace: false, title: 'Take out the setting Connect wrote' };
  else if (c.state === 'disconnected') action = { label: 'Connect', cls: 'btn primary', action: 'connect', replace: false, title: 'Point ' + c.label + ' at this proxy' };
  else if (c.state === 'elsewhere') {
    action = armed
      ? { label: 'Replace', cls: 'btn danger', action: 'connect', replace: true, title: 'Click again: overwrite ' + c.current + ' with this proxy' }
      : { label: 'Connect', cls: 'btn', action: 'connect', replace: false, title: 'It points somewhere else now; a second click replaces that' };
  }
  return { pill: pills[c.state] || pills.unreadable, lines: lines, button: action };
}

/**
 * What to say after a connect or disconnect: the errors when any client was
 * left as it was, else what was done and what still has to happen.
 *
 * @param {any} res  the POST reply
 * @param {'connect'|'disconnect'} action
 */
export function connectOutcome(res, action) {
  if (!res || (!res.ok && !Array.isArray(res.errors))) return { kind: 'error', text: (res && res.error) || 'The change failed.' };
  if (res.errors.length) return { kind: 'warn', text: res.errors.map(function (/** @type {any} */ e) { return e.replaceable ? e.error + ' To replace it, press Connect on its row, then Replace.' : e.error; }).join(' ') };
  var done = action === 'connect' ? 'Connected. Sessions started from now on go through the proxy.' : 'Disconnected.';
  var notes = (res.clients || []).filter(function (/** @type {any} */ c) { return c.note; }).map(function (/** @type {any} */ c) { return c.note; });
  return { kind: 'ok', text: [done].concat(notes).join(' ') };
}

/**
 * Whether a status read made with the new key came back as that client. A
 * loopback browser is admitted without a key, so a 200 alone proves nothing:
 * the caller the server reports has to be the key's name.
 *
 * @param {number} httpStatus
 * @param {any} body  the parsed /teamclaude/status reply, or null
 * @param {string} name
 */
export function clientKeyCheckOutcome(httpStatus, body, name) {
  if (httpStatus === 401) return { kind: 'error', text: 'The proxy refused the key.' };
  var caller = body && body.caller;
  if (httpStatus === 200 && caller && caller.kind === 'client' && caller.client === name) {
    return { kind: 'ok', text: 'The key works: the proxy counts its requests under ' + name + '.' };
  }
  return { kind: 'error', text: 'The proxy did not recognise the key as ' + name + (httpStatus === 200 ? '.' : ' (status ' + httpStatus + ').') };
}

// The start of a failed linked-instance step's message. A page constant too: see SHARED_CONSTS.
const PEER_LINK_FAILED = { test: 'could not test the link', add: 'could not link the instance', remove: 'could not remove the link', key: 'could not read the key' };

/**
 * POST one step of the Linked instances card: `test` {url, apiKey}, `add`
 * {name, url, apiKey, linkBack?}, `remove` {name} or `key` {}.
 *
 * @param {'test'|'add'|'remove'|'key'} step
 * @param {Record<string, any>} body
 * @param {string|null} key  the proxy key the page holds
 */
export function peerLinkRequest(step, body, key) {
  return {
    url: '/teamclaude/peer-links/' + step,
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    },
  };
}

/**
 * What to tell the operator after an add or a remove. An add that linked one
 * way only says so: the other machine's dashboard will not show this one yet.
 * One that linked both ways also names the instances each side already
 * listed that were linked across too (`mesh`), and the ones that were not.
 *
 * @param {any} res
 * @param {'add'|'remove'} step
 */
export function peerLinkOutcome(res, step) {
  if (!res || !res.ok) return { kind: 'error', text: PEER_LINK_FAILED[step] + (res && res.error ? ': ' + res.error : '') };
  if (step === 'remove') return { kind: 'ok', text: 'Removed ' + res.name + '. If it lists this machine too, remove that link from its own dashboard.' };
  var back = res.linkBack;
  if (back && back.ok) {
    var text = 'Linked ' + res.name + ' both ways: each dashboard now shows the other in the Instance picker.';
    var mesh = res.mesh;
    if (!mesh) return { kind: 'ok', text: text };
    // A pair is linked one direction at a time; both directions read as one.
    /** @type {string[]} */
    var also = [];
    (Array.isArray(mesh.linked) ? mesh.linked : []).forEach(function (/** @type {any} */ l) {
      var i = also.indexOf(l.to + ' → ' + l.from);
      if (i >= 0) also[i] = l.to + ' ↔ ' + l.from;
      else also.push(l.from + ' → ' + l.to);
    });
    var missed = (Array.isArray(mesh.skipped) ? mesh.skipped : []).map(function (/** @type {any} */ l) { return l.error; });
    if (also.length) text += ' Also linked the instances they already listed: ' + also.join(', ') + '.';
    if (missed.length) text += ' Not linked: ' + missed.join('; ') + '.';
    return { kind: missed.length ? 'warn' : 'ok', text: text };
  }
  if (back) return { kind: 'warn', text: 'Linked ' + res.name + ', but it did not link back: ' + back.error + '.' };
  return { kind: 'ok', text: 'Linked ' + res.name + '. Pick it in the Instance picker to see it.' };
}

/**
 * What a test of an address and key found (peers.js testPeerLink).
 *
 * @param {any} res
 */
export function peerTestOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: PEER_LINK_FAILED.test + (res && res.error ? ': ' + res.error : '') };
  if (res.state === 'refused' && res.clientKey) return { kind: 'error', text: 'That is one of its client keys, which cannot manage it. Linking needs its proxy key: on its dashboard, Settings, Linked instances, Show key.' };
  if (res.state === 'refused') return { kind: 'error', text: 'It refused that key. Copy the key again from its dashboard: Settings, Linked instances, Show key.' };
  if (res.state !== 'online') return { kind: 'error', text: 'Nothing answered at ' + res.url + '. Check the address, and that it listens beyond its own machine (proxy.host).' };
  if (!res.linkable) return { kind: 'warn', text: 'It answers to that key, but it runs a version that cannot link back from here. Update it, or link this machine from its own dashboard.' };
  return { kind: 'ok', text: 'It answers to that key' + (res.name ? ' and calls itself ' + res.name : '') + '.' };
}

// The scheme of an instance link. The old spelling is read too (issue #72).
const INSTANCE_LINK_SCHEMES = ['teamrouter:', 'teamclaude:'];

/**
 * One line to copy from a machine's dashboard to another's, carrying the
 * address the other machine reaches it at and its proxy key, so the form there
 * fills in both from one paste. It carries no name: the machine it is pasted
 * into is where the link is named. The key is in it, so the link is as secret
 * as the key.
 *
 * @param {string} address  e.g. http://100.64.0.2:3456
 * @param {string} key  the proxy key
 * @returns {string}  '' when either is missing
 */
export function instanceLink(address, key) {
  if (!address || !key) return '';
  return 'teamrouter://link?address=' + encodeURIComponent(address) + '&key=' + encodeURIComponent(key);
}

/**
 * Read a link made by instanceLink. Anything else, including a link whose
 * address is not an http(s) URL, is null.
 *
 * @param {string} text
 * @returns {{ url: string, apiKey: string } | null}
 */
export function parseInstanceLink(text) {
  var u;
  try { u = new URL(String(text || '').trim()); } catch { return null; }
  if (INSTANCE_LINK_SCHEMES.indexOf(u.protocol) < 0 || u.hostname !== 'link') return null;
  var address = (u.searchParams.get('address') || '').trim();
  var key = (u.searchParams.get('key') || '').trim();
  if (!address || !key) return null;
  try {
    var a = new URL(address);
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return null;
  } catch { return null; }
  return { url: address, apiKey: key };
}

/**
 * What stops the Link button, or null when nothing does. A missing name has a
 * message of its own: it is the field a pasted link leaves empty, and the
 * address and key the form already holds stay where they are.
 *
 * @param {{ name: string, url: string, apiKey: string }} body
 * @returns {string | null}
 */
export function linkAddMissing(body) {
  if (!body.url || !body.apiKey) return 'Fill in its address and its proxy key, or paste its link.';
  if (!body.name) return 'You need to name this machine: enter a name under Name it, then click Link again.';
  return null;
}

/**
 * The addresses to offer for "this machine, as the other one reaches it",
 * best first: the address set on the Settings page (`instanceAddress`), then
 * the address this page was opened at, when that is not this machine's
 * loopback and the page shows this machine, then what the server found on its
 * own interfaces.
 *
 * @param {any} self  the `self` of GET /teamclaude/peer-links
 * @param {string} origin  location.origin, or '' when the page shows a linked instance
 */
export function linkSelfOptions(self, origin) {
  /** @type {string[]} */
  var out = [];
  var host = '';
  try { host = origin ? new URL(origin).hostname : ''; } catch { host = ''; }
  if (self && typeof self.address === 'string' && self.address) out.push(self.address);
  if (host && !isLoopbackHost(host) && out.indexOf(origin) < 0) out.push(origin);
  (self && Array.isArray(self.addresses) ? self.addresses : []).forEach(function (/** @type {string} */ a) { if (out.indexOf(a) < 0) out.push(a); });
  return out;
}

/**
 * The `self` of GET /teamclaude/peer-links as it is once `instanceAddress` is
 * `address`, so the page can offer a new address the moment it is saved or a
 * status reports it, without waiting for a fresh read. The old address set
 * leaves the list; the guesses stay.
 *
 * @param {any} self  the `self` of GET /teamclaude/peer-links
 * @param {string} address  '' when none is set
 */
export function linkSelfWithAddress(self, address) {
  if (!self) return self;
  var old = typeof self.address === 'string' ? self.address : '';
  var rest = (Array.isArray(self.addresses) ? self.addresses : []).filter(function (/** @type {string} */ a) { return a !== old && a !== address; });
  return Object.assign({}, self, { address: address, addresses: address ? [address].concat(rest) : rest });
}

/**
 * What stands in the way of linking the instance shown back from the other
 * machine, or null when nothing does. Without a proxy key nothing can get in,
 * so that one blocks. Listening on loopback only is a warning: a reverse
 * proxy or Tailscale Serve in front of it is still an address the other
 * machine can use, and the page may well have been opened through one.
 *
 * @param {any} self  the `self` of GET /teamclaude/peer-links
 * @returns {{ block: boolean, text: string } | null}
 */
export function linkBackNotice(self) {
  if (!self) return null;
  if (!self.hasKey) return { block: true, text: 'It has no proxy key (proxy.apiKey) for the other machine to use, so it cannot be linked back.' };
  if (!self.offBox) return { block: false, text: 'It listens on its own machine only. Link back works only through something that forwards to it, such as a reverse proxy or Tailscale Serve: enter that address. Otherwise set proxy.host (or TEAMCLAUDE_HOST) to 0.0.0.0 or its Tailscale address.' };
  return null;
}

// The start of a failed account-sync step's message. A page constant too: see SHARED_CONSTS.
const ACCOUNT_SYNC_FAILED = { view: 'could not read account sync', start: 'could not start the sign-in', status: 'could not check the sign-in', cancel: 'could not cancel the sign-in', sync: 'could not sync', 'sign-out': 'could not sign out', mode: 'could not change account sync' };

/**
 * One request of the Account sync card: `view` is the GET of
 * /teamclaude/account-sync, the other steps POST to it. The page sends it to
 * the instance shown (at()) or, for a row of Linked instances, through the
 * relay to that one.
 *
 * @param {'view'|'start'|'status'|'cancel'|'sync'|'sign-out'|'mode'} step
 * @param {Record<string, any>|null} body
 * @param {string|null} key  the proxy key the page holds
 */
export function accountSyncRequest(step, body, key) {
  if (step === 'view') return { url: '/teamclaude/account-sync', init: { headers: { 'x-api-key': key || '' } } };
  return {
    url: '/teamclaude/account-sync/' + step,
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    },
  };
}

/**
 * The callback.net user a view names, as one line, or null.
 *
 * @param {any} view  GET /teamclaude/account-sync
 */
export function accountSyncUser(view) {
  var u = view && view.user;
  if (!u) return null;
  if (u.email && u.name && u.name !== u.email) return u.name + ' (' + u.email + ')';
  return u.email || u.name || null;
}

/**
 * The store of your own instances a view names: 'host' (the instance keeps
 * it), 'follow' (it uses a linked one's), 'cluster' (a master and backups
 * keep it), or '' when none.
 *
 * @param {any} view  GET /teamclaude/account-sync
 */
export function accountSyncOwnMode(view) {
  var m = view && view.instance && view.instance.mode;
  return m === 'host' || m === 'follow' || m === 'cluster' ? m : '';
}

/**
 * The members of a master and backups, in order, as the instance shown sees
 * them: one line each, for the card.
 *
 * @param {any} view  GET /teamclaude/account-sync
 * @returns {{ name: string, kind: string, text: string }[]}
 */
export function accountSyncMembers(view) {
  var cl = view && view.instance && view.instance.cluster;
  if (!cl || !Array.isArray(cl.memberStates)) return [];
  return cl.memberStates.map(function (/** @type {any} */ m, /** @type {number} */ i) {
    var where = m.self ? ' (this machine)' : '';
    var place = i === 0 ? 'first in line' : 'backup ' + i;
    if (m.state === 'down') return { name: m.name, kind: 'error', text: m.name + where + ': down, ' + place };
    if (m.state === 'unplaced') return { name: m.name, kind: 'error', text: m.name + ': not a linked instance of this machine' };
    if (m.state === 'unknown') return { name: m.name, kind: '', text: m.name + where + ': not heard from yet, ' + place };
    if (m.name === cl.master) return { name: m.name, kind: 'ok', text: m.name + where + ': master' };
    return { name: m.name, kind: '', text: m.name + where + ': up, ' + place };
  });
}

/**
 * What the card says about the instance shown.
 *
 * @param {any} view  GET /teamclaude/account-sync, or a failed read's `{ ok: false, error }`
 * @param {string} where  'this machine', or the linked instance's name
 */
export function accountSyncLine(view, where) {
  if (!view || !view.ok) return { kind: 'error', text: ACCOUNT_SYNC_FAILED.view + (view && view.error ? ': ' + view.error : '') };
  var own = accountSyncOwnMode(view);
  var on;
  if (own === 'host') {
    on = 'On: ' + where + ' keeps the accounts for your other machines.';
  } else if (own === 'cluster') {
    var cl = view.instance.cluster || {};
    if (!cl.master) return { kind: 'warn', text: 'On, with a master and backups, but there is no master right now' + (cl.reason ? ': ' + cl.reason : '') + '. Sign-ins that run out wait until there is one.' };
    var self = cl.master === view.instance.self;
    on = 'On: ' + (self ? where + ' is the master' : cl.master + ' is the master')
      + (self ? '.' : cl.role === 'follower' ? ', and ' + where + ' follows it.' : ', and ' + where + ' keeps a copy to take over with.');
  } else if (own === 'follow') {
    var linked = Array.isArray(view.instance.peers) ? view.instance.peers : [];
    if (linked.indexOf(view.instance.peer) < 0) return { kind: 'error', text: 'On, but ' + where + ' follows ' + view.instance.peer + ', which is no longer a linked instance: nothing is synced, and a sign-in that runs out is not renewed. Link it again, or turn this off.' };
    on = 'On: ' + where + ' follows the accounts kept on ' + view.instance.peer + '.';
  } else {
    if (!view.signedIn) return { kind: '', text: 'Off: ' + where + ' keeps its own sign-ins.' };
    var who = accountSyncUser(view);
    on = 'On' + (who ? ', as ' + who : '') + '.';
    if (view.userError) return { kind: 'warn', text: 'On, but callback.net did not say who is signed in: ' + view.userError };
  }
  var s = view.sync || {};
  if (s.lastError) return { kind: 'error', text: on + ' The last sync failed: ' + s.lastError };
  if (!s.lastSyncAt) return { kind: 'ok', text: on + ' The first sync is under way.' };
  var n = s.rows || 0;
  var text = on + ' ' + n + ' account' + (n === 1 ? '' : 's') + ' in the store.';
  if (s.signInNeeded) return { kind: 'warn', text: text + ' ' + s.signInNeeded + (s.signInNeeded === 1 ? ' needs' : ' need') + ' a sign-in on one of your machines.' };
  return { kind: 'ok', text: text };
}

/**
 * The Account sync cell of a Linked instances row. `setUp` offers to start
 * the sign-in on that instance from here. An instance signed in as someone
 * else syncs with another store, so it shares nothing with this machine,
 * and the cell says so.
 *
 * @param {any} view  that instance's GET through the relay, or null while unread
 * @param {number} httpStatus  the status of that read (0 while unread)
 * @param {any} own  this machine's GET /teamclaude/account-sync
 */
export function peerSyncCell(view, httpStatus, own) {
  if (httpStatus === 404 || httpStatus === 501) return { kind: 'warn', text: 'needs an update', setUp: false };
  if (!view) return { kind: '', text: '…', setUp: false };
  if (!view.ok) return { kind: 'error', text: 'unknown', setUp: false };
  var mode = accountSyncOwnMode(view);
  if (mode === 'host') return { kind: 'ok', text: 'keeps the accounts', setUp: false };
  if (mode === 'follow') return { kind: 'ok', text: 'follows ' + view.instance.peer, setUp: false };
  if (mode === 'cluster') {
    var cl = view.instance.cluster || {};
    if (!cl.master) return { kind: 'warn', text: 'master and backups: no master right now', setUp: false };
    var role = cl.role === 'master' ? 'the master' : cl.role === 'backup' ? 'a backup' : 'follows ' + cl.master;
    return { kind: 'ok', text: 'master and backups: ' + role + (cl.role === 'backup' ? ' (master: ' + cl.master + ')' : ''), setUp: false };
  }
  // Off there. A callback.net sign-in is offered only while this machine
  // syncs that way too: beside a store of your own it would be a second one.
  if (!view.signedIn) return { kind: '', text: 'off', setUp: !accountSyncOwnMode(own) };
  var who = accountSyncUser(view);
  var theirs = view.user && (view.user.email || view.user.name);
  var mine = own && own.ok && own.signedIn && own.user ? (own.user.email || own.user.name) : null;
  if (theirs && mine && theirs !== mine) return { kind: 'warn', text: 'on, as ' + who + ': another callback.net account, so it shares nothing with this machine', setUp: false };
  if (own && own.ok && !own.signedIn) return { kind: 'ok', text: 'on' + (who ? ', as ' + who : '') + ' (this machine is off)', setUp: false };
  return { kind: 'ok', text: 'on' + (who ? ', as ' + who : ''), setUp: false };
}

/**
 * The approval link `start` answered with, if it is one the page may open:
 * https, or plain http to this machine (a test stand-in for callback.net, as
 * callback-auth.js allows). A linked instance's answer reaches the page
 * through the relay, so a `javascript:` or other link is never put in an href.
 *
 * @param {unknown} url
 * @returns {string|null}
 */
export function accountSyncApprovalHref(url) {
  if (typeof url !== 'string' || /[\s"'<>]/.test(url)) return null;
  if (/^https:\/\/[^/]/i.test(url)) return url;
  return /^http:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d+)?\//i.test(url) ? url : null;
}

/**
 * Where a dashboard sign-in to callback.net stands, from `status`.
 *
 * @param {any} res  POST /teamclaude/account-sync/status
 */
export function accountSyncSignInOutcome(res) {
  if (!res || !res.ok) return { done: false, kind: 'warn', text: ACCOUNT_SYNC_FAILED.status + (res && res.error ? ': ' + res.error : '') + '. Still trying.' };
  if (res.state === 'waiting') return { done: false, kind: '', text: 'Waiting for the approval at callback.net. This finishes by itself.' };
  if (res.state === 'finishing') return { done: false, kind: '', text: 'Approved. Finishing the sign-in…' };
  if (res.state === 'succeeded') return { done: true, kind: 'ok', text: 'Signed in. Account sync is on, and the first sync is running.' };
  if (res.state === 'failed') return { done: true, kind: 'error', text: 'The sign-in failed' + (res.error ? ': ' + res.error : '.') };
  if (res.state === 'cancelled') return { done: true, kind: '', text: 'Cancelled.' };
  return { done: true, kind: 'warn', text: 'The server no longer knows this sign-in (it may have restarted). Start it again.' };
}

/**
 * What to tell the operator after a Cancel, or null when there is nothing to
 * say: the sign-in stopped, or had already ended without signing in. One
 * already approved went through, and only Sign out undoes it.
 *
 * @param {any} res  POST /teamclaude/account-sync/cancel
 * @param {string} where  'this machine', or the linked instance's name
 */
export function accountSyncCancelOutcome(res, where) {
  if (!res || !res.ok) return { kind: 'error', text: ACCOUNT_SYNC_FAILED.cancel + ' on ' + where + (res && res.error ? ': ' + res.error : '') + '. If its link is approved, it still signs in.' };
  if (res.cancelled) return null;
  if (res.state === 'finishing' || res.state === 'succeeded') return { kind: 'warn', text: 'The sign-in on ' + where + ' had already been approved, so it went through. Sign out there to undo it.' };
  return null;
}

/**
 * What to tell the operator after Sync now, Sign out, or a switch of the
 * store of your own instances (`mode`).
 *
 * @param {any} res
 * @param {'sync'|'sign-out'|'mode'} step
 * @param {string} [where]  for `mode`: 'this machine', or the linked instance's name
 */
export function accountSyncOutcome(res, step, where) {
  if (!res || !res.ok) return { kind: 'error', text: ACCOUNT_SYNC_FAILED[step] + (res && res.error ? ': ' + res.error : '') };
  if (step === 'mode') {
    if (res.mode === 'host') return { kind: 'ok', text: 'On: ' + where + ' keeps the accounts. On each of your other machines, choose Follow ' + (where === 'this machine' ? 'it' : where) + ' here.' };
    if (res.mode === 'follow') return { kind: 'ok', text: 'On: ' + where + ' follows ' + res.peer + '. The accounts arrive with the first sync, in a moment.' };
    if (res.mode === 'cluster') return { kind: 'ok', text: 'On: master and backups ' + (res.members || []).join(', ') + '. Set the same list, in the same order, on each of them. The first one up is the master.' };
    return { kind: 'ok', text: 'Off. The accounts stay where they are.' };
  }
  if (step === 'sign-out') {
    if (!res.wasSignedIn) return { kind: 'ok', text: 'It was not signed in.' };
    return { kind: 'ok', text: res.revoked
      ? 'Signed out. Account sync is off; the accounts stay where they are.'
      : 'Signed out here, but callback.net could not be told, so that session runs out on its own. Account sync is off.' };
  }
  var r = res.result || {};
  if (r.signedIn === false) return { kind: 'warn', text: 'Not signed in to callback.net, so there was nothing to sync.' };
  /** @type {string[]} */
  var parts = [];
  function plural(/** @type {number} */ n, /** @type {string} */ one) { return n + ' ' + one + (n === 1 ? '' : 's'); }
  if (r.added) parts.push('added ' + plural(r.added, 'account') + ' from your other machines');
  if (r.adopted) parts.push('took ' + plural(r.adopted, 'newer sign-in'));
  if ((r.pushed || 0) + (r.created || 0)) parts.push('shared ' + plural((r.pushed || 0) + (r.created || 0), 'sign-in'));
  if (r.evicted) parts.push('removed ' + plural(r.evicted, 'account') + ' removed on another machine');
  return { kind: 'ok', text: parts.length ? 'Synced: ' + parts.join(', ') + '.' : 'Synced: everything already matched.' };
}

/**
 * Whether the caller may use the control behind `path`. A status without the
 * `caller` field keeps every control: the server still refuses what it must.
 *
 * @param {any} caller  status.caller
 * @param {string} path
 */
export function callerCan(caller, path) {
  var refused = caller && caller.refused;
  return !Array.isArray(refused) || refused.indexOf(path) < 0;
}

/**
 * The one line that explains the hidden controls, or null when nothing is
 * hidden. Said once at the top instead of on every card.
 *
 * @param {any} caller  status.caller
 */
export function callerNotice(caller) {
  if (!caller || !Array.isArray(caller.refused) || !caller.refused.length) return null;
  return 'Signed in with the client key "' + caller.client + '". Changes to accounts and settings need the proxy key (proxy.apiKey), or the page opened without a key on the proxy\'s own machine, so those controls are hidden.';
}

/**
 * Which card a note belongs to. One email can hold accounts in several orgs,
 * and providers may reuse a name, so the name alone can match two cards.
 *
 * @param {any} account  one entry of status.accounts
 */
export function cardNoteKey(account) {
  return [account.name, account.orgName || '', account.provider || ''].join('\n');
}

/**
 * The email line under an account's name, or null for none. An account named
 * after its email already shows it; a renamed one ("work", "account-1") would
 * otherwise hide whose login it is.
 *
 * @param {any} account  one entry of status.accounts
 * @returns {string|null}
 */
export function accountEmailLine(account) {
  var email = account && account.email;
  if (typeof email !== 'string' || !email) return null;
  return email === account.name ? null : email;
}

/**
 * The result of the last action on one account card, while it is recent
 * enough to show. Kept outside the card, which the poll rebuilds every few
 * seconds.
 *
 * @param {any} notes  { [cardNoteKey]: { kind, text, at } }
 * @param {string} key  cardNoteKey of the card
 * @param {number} now
 */
export function cardNoteFor(notes, key, now) {
  var n = notes && Object.prototype.hasOwnProperty.call(notes, key) ? notes[key] : null;
  if (!n || now - n.at > CARD_NOTE_MAX_AGE_MS) return null;
  return n;
}

export function switchOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'switch failed' + (res && res.error ? ': ' + res.error : '') };
  if (res.eligible === false) return { kind: 'warn', text: 'switched to ' + res.account + ', but rotation will not use it' + (res.reason ? ': ' + res.reason : '') };
  return { kind: 'ok', text: 'switched to ' + res.account };
}

// One row per route the server reports — each model family the fleet meters
// separately, autocreated or configured — plus a trailing row for everything
// else, which goes to the current account. `target` is the server's own answer
// to "where does a request for this family land right now", so the page does
// not re-derive routing from quota bars; the eligible split says why a family
// is where it is.
export function routeRows(status) {
  var s = status || {};
  var blockedModels = s.blockedModels || [];
  var rows = (s.routes || []).map(function (r) {
    var accounts = r.accounts || [];
    var name = r.name || '';
    var match = r.match || [];
    var target = r.target || null;
    var pinned = r.pinned || null;
    return {
      kind: 'route',
      name: name,
      provider: r.provider || 'anthropic',
      label: name.charAt(0).toUpperCase() + name.slice(1),
      match: match.join(', '),
      target: target,
      pinned: pinned,
      // A pin the server is not honouring (its account cannot serve the
      // family right now): routing went elsewhere, and the row must say so
      // rather than let "pinned" read as "this is the pin".
      pinMismatch: !!pinned && pinned !== target,
      // The blocklist answers 400 before selection, so a route whose every
      // glob is blocked has a target no request will reach. A literal glob
      // comparison covers the common case; the server's overlap logic is not
      // shipped to the page.
      blocked: match.length > 0 && match.every(function (g) { return blockedModels.indexOf(g) !== -1; }),
      autocreated: !!r.autocreated,
      eligible: accounts.filter(function (a) { return a.eligible; }).map(function (a) { return a.name; }),
      ineligible: accounts.filter(function (a) { return !a.eligible; }).map(function (a) { return a.name; }),
    };
  });
  if (rows.length) {
    // The server reports one default per provider. A mixed Claude/Codex fleet
    // has two independent cursors, so collapsing these into one global row is
    // the exact ambiguity this table exists to remove. Older servers retain
    // the original single-row fallback.
    var defaults = s.defaultTargets || null;
    var providers = defaults ? Object.keys(defaults).sort(function (a, b) {
      if (a === 'anthropic') return -1;
      if (b === 'anthropic') return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    }) : [];
    if (!providers.length) providers = [rows[0].provider || 'anthropic'];
    providers.forEach(function (provider) {
      var current = (s.currentAccounts && s.currentAccounts[provider]) || s.currentAccount || null;
      var cur = (s.accounts || []).filter(function (a) { return a.name === current; })[0];
      rows.push({
        kind: 'default', name: '',
        label: defaults ? providerLabel(provider) + ' default' : 'Everything else',
        provider: provider, match: '',
        target: defaults ? defaults[provider] : (s.defaultTarget || current), current: current,
        currentUnavailable: (cur && cur.unavailable) || null,
        pinned: null, pinMismatch: false, blocked: false, autocreated: false, eligible: [], ineligible: [],
      });
    });
  }
  return rows;
}

// Consecutive client requests that ended with nothing usable. Claude Code has
// its own retry loop, so two or three in a row are ordinary during a seconds-long
// upstream wobble; five with no success in between is past any blip and past the
// client's own budget. No age floor is needed — unlike a token-based guess, a
// streak of five is true of no healthy session at any age, so a floor would only
// delay a true positive.
export var STARVED_MIN = 5;
// The failure that makes this fire is usually fleet-wide, so every active
// conversation starves at once — and one fan-out is a dozen of them under one
// session's name. Naming all of them would bury the dashboard at the moment it
// matters most; the count carries the scale, three names carry enough to go and
// ask someone.
export var STARVED_LIST_MAX = 3;

/**
 * What is wrong right now, worst first, or an empty list. Only states that are
 * actionable and not ordinary operation: a spent weekly bucket, a rate-limit
 * back-off and an upstream refusal are rotation and back-off working, and
 * saying so every day would teach the reader to ignore the banner on the day it
 * matters.
 */
export function problems(status) {
  var s = status || {};
  var out = [];

  // Named when proxy.sessionDetail is on; otherwise the aggregate still says
  // that something is starving, which is the half that must not be opt-in.
  // When nothing can serve, every session starves and "it is failing" sends the
  // operator hunting for a broken token. Say which, if the fleet agrees on why.
  var accounts = s.accounts || [];
  var stalled = accounts.filter(function (a) { return a.unavailable === 'quota' || a.unavailable === 'throttled'; });
  var reasons = {};
  stalled.forEach(function (a) { reasons[a.unavailable] = true; });
  var why = accounts.length && stalled.length === accounts.length
    ? ' — every account is ' + (reasons.quota && reasons.throttled ? 'over its quota threshold or in a rate-limit hold'
      : reasons.quota ? 'over its quota threshold' : 'in a rate-limit hold') + '.'
    : ' — it is failing, not idle.';

  var sessions = s.sessions || {};
  var named = (sessions.items ? sessionRows(sessions) : []).filter(function (r) {
    return r.active && r.starved >= STARVED_MIN;
  }).sort(function (a, b) { return b.starved - a.starved; });
  named.slice(0, STARVED_LIST_MAX).forEach(function (r) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      // The session first, since that is the name an operator can go and find,
      // and the conversation after it, because a streak belongs to one agent of
      // a fan-out: without it three lines of one session read as the same line
      // three times. Omitted when the record carries no conversation.
      text: (r.client ? r.client + "'s session " : 'Session ') + r.session.slice(0, 8)
        + (r.conversation ? ', conversation ' + r.conversation + ',' : '')
        + ' has had ' + r.starved + ' requests in a row come back with nothing'
        + (r.project ? ' (' + r.project + ')' : '') + why,
    });
  });
  if (named.length > STARVED_LIST_MAX) {
    out.push({
      severity: 'bad', kind: 'starved-more',
      text: 'and ' + (named.length - STARVED_LIST_MAX) + ' more conversations are getting nothing back.',
    });
  }
  if (!named.length && (sessions.starvedMax || 0) >= STARVED_MIN) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      // A conversation, not a session: the streak is counted per conversation,
      // and a session whose other agents are answering fine is not starving.
      text: 'A conversation has had ' + sessions.starvedMax + ' requests in a row come back with nothing.'
        + ' Turn on proxy.sessionDetail to see which.',
    });
  }

  // Only the two states that do not clear themselves. `entitlement` is a
  // cooldown of at most an hour and `upstream-rejected` is upstream's way of saying a
  // shared bucket is spent — both expire on their own, like `quota` and
  // `throttled`, and none of them wants a person.
  var ATTENTION = { error: 'needs a re-login', disabled: 'is disabled' };
  (s.accounts || []).forEach(function (a) {
    // A refusal from upstream (account-refusal.js) is not cured by a re-login
    // alone; any error code other than the two dead-token ones is one.
    var code = a.errorReason && a.errorReason.code;
    var refused = a.unavailable === 'error' && code && code !== 'refresh_rejected' && code !== 'credential_rejected';
    var why = refused ? 'was refused by upstream' : ATTENTION[a.unavailable];
    if (why) out.push({ severity: 'warn', kind: 'account', text: 'Account ' + a.name + ' ' + why + '.' });
  });

  // Deliberately no spend line. `usedMinor` is month-to-date overage, so on a
  // fleet that has overage switched on it is non-zero for most of the month —
  // an always-lit banner, which is the thing this is trying not to be. The
  // account card and `teamclaude status` both carry it, with the amount.

  return out;
}

// How a quota window reads, as the colour its bar is drawn in. The cut-offs
// are the ones the card bars always used (70% and 90% used); the rows now show
// the remaining side, so under 30% left is amber and under 10% left is red.
/** @param {number|null|undefined} used */
export function meterTone(used) {
  if (used == null || !isFinite(Number(used))) return 'unknown';
  var u = Number(used);
  if (u >= 0.9) return 'bad';
  if (u >= 0.7) return 'warn';
  return 'ok';
}

// One quota column: its label, the fraction used and left (null when the
// window has not reported), when it resets, and its tone.
/** @param {string} label @param {any} utilization @param {any} resetAt */
export function quotaMeter(label, utilization, resetAt) {
  var known = utilization != null && isFinite(Number(utilization));
  var used = known ? Math.max(0, Math.min(1, Number(utilization))) : null;
  return { label: label, used: used, left: used == null ? null : 1 - used, resetAt: resetAt == null ? null : resetAt, tone: meterTone(used) };
}

// An old, spent reading stops hiding an account once its window resets.
/** @param {any} meter @param {number} now */
export function exhaustedMeter(meter, now) {
  return !!meter && meter.left === 0 && (meter.resetAt == null || meter.resetAt > now);
}

// The Fable model the fleet served most recently, as a person names it
// ("Fable 5.1"), for the Fable column's label. Upstream meters the family, not
// the version, so this only names the column: the newest Fable id any account
// lists in usage.recentModels, or plain "Fable" before one has been seen.
/** @param {any[]} accounts */
export function fableLabel(accounts) {
  /** @type {string|null} */
  var best = null;
  var bestAt = -Infinity;
  (accounts || []).forEach(function (a) {
    var seen = (a && a.usage && a.usage.recentModels) || {};
    Object.keys(seen).forEach(function (id) {
      if (id.toLowerCase().indexOf('fable') < 0 || !(seen[id] > bestAt)) return;
      bestAt = seen[id];
      best = id;
    });
  });
  var label = best ? modelLabel(best) : '';
  return /^Fable\b/.test(label) ? label : 'Fable';
}

// The three quota columns of an account row, in the order the operator reads
// them: the Fable weekly bucket, the five-hour window, then the shared weekly.
// A slot is null where the account has no such window — a Codex account has no
// Fable bucket, a plan that states no session window no five-hour row — so the
// columns line up from one row to the next. Any other model-scoped weekly
// bucket (Sonnet) goes to `extra`, behind the row's Show control. An account
// metered some other way fills from the left: a token budget, or a third-party
// backend's own reading (#530), whose text is all there is to say when no bar
// can be drawn.
/** @param {any} account @param {string} [fable] @param {number} [now] */
export function accountMeters(account, fable, now) {
  var a = account || {};
  var q = a.quota || {};
  var at = now == null ? Date.now() : now;
  /** @type {Array<any>} */
  var slots = [null, null, null];
  /** @type {Array<any>} */
  var extra = [];
  /** @type {string|null} */
  var text = null;
  // Codex and Grok plans have no Fable bucket, and a session row only when a
  // reading states one.
  var otherPlan = a.provider === 'codex' || a.provider === 'grok';
  if (q.unified5h != null || q.unified7d != null) {
    if (!otherPlan) {
      scopedWeeklyRows(q).forEach(function (r) {
        if (r.family === 'fable') slots[0] = quotaMeter('7-day ' + (fable || 'Fable'), r.utilization, r.resetAt);
        else extra.push(quotaMeter('7-day ' + r.label, r.utilization, r.resetAt));
      });
    }
    if (otherPlan ? q.unified5h != null : showSessionRow(q)) slots[1] = quotaMeter('5-hour limit', q.unified5h, q.unified5hReset);
    if (showWeeklyRow(q)) slots[2] = quotaMeter(q.planPeriod === 'monthly' ? 'Monthly limit' : '7-day limit', q.unified7d, q.unified7dReset);
    // Show usable session capacity: a fresh session cannot bypass an empty
    // weekly bucket. Keep upstream's reading intact for routing and persistence.
    var weekly = [slots[0], slots[2]].filter(function (m) { return exhaustedMeter(m, at); });
    if (slots[1] && weekly.length) {
      slots[1] = quotaMeter(slots[1].label, 1, null);
      slots[1].note = 'Weekly limit empty';
    }
  } else if (q.tokensLimit != null && q.tokensRemaining != null) {
    slots[0] = quotaMeter('Tokens', 1 - q.tokensRemaining / q.tokensLimit, q.resetsAt);
  } else if (q.backend && (q.backend.text || q.backend.utilization != null)) {
    var bq = backendQuotaRows(q.backend, now);
    bq.rows.slice(0, 3).forEach(function (r, i) { slots[i] = quotaMeter(r.label, r.utilization, r.resetAt); });
    text = bq.text;
  } else {
    // Grok's replies carry no quota headers, so traffic never fills its bars:
    // only the zero-spend usage read does, the row's Refresh quota or the
    // background Quota refresh.
    text = a.provider === 'grok' ? 'quota unknown: Grok states it only when asked (Refresh quota)'
      : 'quota unknown (no traffic observed yet)';
  }
  // An API key's prepaid credit (accounts[].credit): the share spent this
  // cycle, counting down to its renewal. Money, not rate-limit headroom, so it
  // is a column of its own beside Tokens.
  if (a.credit) {
    var credit = quotaMeter('Prepaid credit', a.credit.usedFraction, a.credit.cycleEnd);
    var free = slots.indexOf(null);
    if (free >= 0) slots[free] = credit; else extra.push(credit);
  }
  return { slots: slots, extra: extra, text: text };
}

// Hide only rows with a known empty main window, keeping unknown quota and
// model-specific buckets behind Show from making an account disappear.
/** @param {any} account @param {number} [now] */
export function accountQuotaExhausted(account, now) {
  var at = now == null ? Date.now() : now;
  var meters = accountMeters(account, undefined, at);
  return meters.slots.some(function (m) { return exhaustedMeter(m, at); });
}

// One provider's quota pooled, for its summary card: how much of one column is
// left across the accounts that report it (five accounts at 80% left read
// "400% of 500%"), a segment per account, and the soonest reset among them.
// `slot` is an accountMeters column. A disabled account is left out, since
// nothing will spend it; one with no reading for the column is counted as
// unknown, not guessed at.
/** @param {any[]} accounts @param {number} slot @param {string} [fable] @param {number} [now] */
export function poolSummary(accounts, slot, fable, now) {
  var at = now == null ? Date.now() : now;
  /** @type {{ label: string|null, count: number, left: number, segments: Array<any>, soonest: any, unknown: number }} */
  var out = { label: null, count: 0, left: 0, segments: [], soonest: null, unknown: 0 };
  (accounts || []).forEach(function (a) {
    if (!a || a.disabled) return;
    var m = accountMeters(a, fable, at).slots[slot];
    if (!m) return;
    // Accounts whose plans run on different periods (a weekly Grok plan
    // beside a monthly one) share no window name, so the card takes a neutral
    // one rather than whichever account happens to come first.
    out.label = out.label == null || out.label === m.label ? m.label : 'Plan allowance';
    if (m.left == null) { out.unknown++; return; }
    out.count++;
    out.left += m.left;
    out.segments.push({ name: a.name, left: m.left, tone: m.tone });
    var r = typeof m.resetAt === 'number' ? m.resetAt : NaN;
    if (isFinite(r) && r > at && (!out.soonest || r < out.soonest.resetAt)) out.soonest = { name: a.name, resetAt: r };
  });
  return out;
}

// Which tab an account is listed under: Claude, Codex, or one tab per
// third-party backend host (status.accounts[].backend), so a DeepSeek key does
// not sit among the Claude logins it shares a provider with.
/** @param {any} account */
export function accountGroup(account) {
  var a = account || {};
  if (a.backend) return 'backend:' + a.backend;
  return a.provider === 'codex' || a.provider === 'grok' ? a.provider : 'anthropic';
}

/** @param {string} group */
export function groupLabel(group) {
  if (group === 'anthropic') return 'Claude';
  if (group === 'codex') return 'Codex';
  if (group === 'grok') return 'Grok';
  var host = String(group || '').replace(/^backend:/, '');
  /** @type {Record<string, string>} */
  var known = {
    'api.deepseek.com': 'DeepSeek', 'api.z.ai': 'z.ai', 'open.bigmodel.cn': 'GLM',
    'api.nano-gpt.com': 'NanoGPT', 'api.kimi.com': 'Kimi', 'api.kimi.ai': 'Kimi',
  };
  return Object.prototype.hasOwnProperty.call(known, host) ? known[host] : (host || 'Backend');
}

// The tab bar over the quota page: All, then Claude, Codex and each backend
// in that order, each with how many accounts it holds.
/** @param {any[]} accounts */
export function providerTabs(accounts) {
  var list = accounts || [];
  /** @type {Record<string, number>} */
  var counts = {};
  list.forEach(function (a) { var g = accountGroup(a); counts[g] = (counts[g] || 0) + 1; });
  /** @param {string} g */
  var rank = function (g) { return g === 'anthropic' ? 0 : g === 'codex' ? 1 : g === 'grok' ? 2 : 3; };
  var groups = Object.keys(counts).sort(function (x, y) {
    return rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0);
  });
  return [{ key: 'all', label: 'All', count: list.length }].concat(groups.map(function (g) {
    return { key: g, label: groupLabel(g), count: counts[g] };
  }));
}

// The Logs page's filter chips: one per event kind the proxy records
// (event-log.js EVENT_KINDS), under the names the page shows them by.
export var LOG_KINDS = [
  { key: 'all', label: 'All' }, { key: 'usage', label: 'Usage' }, { key: 'signin', label: 'Sign-in' },
  { key: 'auth', label: 'Auth' }, { key: 'rotation', label: 'Rotation' }, { key: 'control', label: 'Changes' },
  { key: 'credits', label: 'Resets' },
];

// Fold one GET /teamclaude/logs reply into what the page holds: the log's
// generation and its entries, oldest first, at most `cap`. A reply from another
// generation means the server restarted with a fresh log. What is held
// describes a process that is gone, and the reply only carries what is newer
// than an id from that process, so the new log's first entries are missing:
// the state empties and `refetch` says to ask again from the start. A server
// that names no generation is read the old way, a lastId behind the newest
// entry held being the same restart.
/** @param {{ generation: string|null, events: any[] }|null} held @param {any} page @param {number} cap */
export function mergeLogEvents(held, page, cap) {
  var h = held || { generation: null, events: [] };
  var have = h.events || [];
  var p = page || {};
  /** @type {any[]} */
  var incoming = Array.isArray(p.events) ? p.events : [];
  var gen = typeof p.generation === 'string' && p.generation ? p.generation : null;
  var newest = have.length ? have[have.length - 1].id : 0;
  if (gen ? (h.generation != null && gen !== h.generation) : (typeof p.lastId === 'number' && p.lastId < newest)) {
    return { generation: gen, events: [], refetch: true };
  }
  var merged = have.concat(incoming.filter(function (e) { return e && typeof e.id === 'number' && e.id > newest; }));
  var max = cap > 0 ? cap : merged.length;
  return { generation: gen || h.generation, events: merged.length > max ? merged.slice(merged.length - max) : merged, refetch: false };
}

/** @param {any[]} events @param {{ kind?: string, provider?: string, account?: string }} filters */
export function filterLogEvents(events, filters) {
  var f = filters || {};
  return (events || []).filter(function (e) {
    if (f.kind && f.kind !== 'all' && e.kind !== f.kind) return false;
    if (f.provider && e.provider !== f.provider) return false;
    if (f.account && e.account !== f.account) return false;
    return true;
  });
}

// The Details column of a log row: what a request carried — model, status,
// tokens, latency — or, for any other event, its reason code.
/** @param {any} event */
export function logEventDetail(event) {
  var e = event || {};
  /** @param {number} n */
  var tok = function (n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); };
  var parts = [];
  if (e.model) parts.push(modelLabel(e.model));
  if (e.status != null) parts.push(String(e.status));
  if (e.inputTokens != null || e.outputTokens != null) parts.push(tok(e.inputTokens || 0) + ' in / ' + tok(e.outputTokens || 0) + ' out');
  if (e.ms != null) parts.push(e.ms >= 1000 ? (e.ms / 1000).toFixed(1) + 's' : e.ms + 'ms');
  if (!parts.length && e.reason) parts.push(e.reason);
  return parts.join(' · ');
}

// The Client column of a log row: the client key that sent a request and the
// program it named itself as (`claude-cli/2.1.3`). Empty for any other event.
/** @param {any} event */
export function logEventClient(event) {
  var e = event || {};
  return [e.client, e.agent].filter(Boolean).join(' · ');
}

// How loudly a log row is drawn: red for what lost an account or a request,
// amber for what will clear on its own or is about to be lost (a reset credit
// expiring), green for a sign-in that worked or a reset credit granted.
/** @param {any} event */
export function logEventTone(event) {
  var e = event || {};
  if (['signin_failed', 'signed_out', 'credential_rejected', 'exhausted'].indexOf(e.type) >= 0) return 'bad';
  if (['rate_limited', 'signin_timeout', 'hold', 'credit_expiring'].indexOf(e.type) >= 0) return 'warn';
  if (e.type === 'signin_succeeded' || e.type === 'credit_granted') return 'ok';
  if (typeof e.status === 'number') return e.status >= 500 ? 'bad' : e.status >= 400 ? 'warn' : '';
  return '';
}

// The usage views the page offers, derived from the windows the tracker
// actually keeps rather than listed again here: a window added or renamed in
// client-usage.js must not leave a button behind that reads zero for everyone.
// `total` is first because it is the lifetime counter the status payload has
// always carried, and the view the page opens on.
export const USAGE_VIEWS = [{ key: 'total', label: 'Total' }].concat(
  Object.keys(USAGE_WINDOWS).map(key => ({ key, label: 'Last ' + key })));

// Which counters one usage row shows. Every usage table reads the selected
// window through this, rather than each renderer reaching into `windows`
// itself — the Clients table and the per-dimension tables carry the same shape
// and must not drift into answering the same question differently.
/** @param {any} entry @param {string} [view] */
export function usageFor(entry, view) {
  var e = entry || {};
  var src = !view || view === 'total' ? e : ((e.windows || {})[view] || {});
  return {
    requests: src.requests || 0,
    connections: src.connections || 0,
    inputTokens: src.inputTokens || 0,
    outputTokens: src.outputTokens || 0,
  };
}

// ---- Insights page ---------------------------------------------------------
//
// The page draws GET /teamclaude/insights (usage-history.js). It is built
// around the two numbers a person reads it for, the estimated API cost and
// the tokens: two headlines that pick which one every chart draws, the pace
// it is on, then that number per day, by calendar day, by month and by where
// it went. What follows is its arithmetic: number formats, axis tops, the
// series each "split by" choice stacks, the legend's statistics, the
// headlines, the projection, the calendar and the ranked list. The drawing
// itself is in the page script, which only turns these numbers into SVG.

// Token counts as the page prints them: 4.48B, 340M, 12.3k. Three significant
// figures at most, since the axis and the tiles are read at a glance and the
// table view carries the exact number.
/** @param {unknown} n */
export function fmtTokens(n) {
  var v = Number(n) || 0;
  var a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e11 ? 0 : a >= 1e10 ? 1 : 2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

// A dollar figure as the page prints it: $1,234 from a thousand up, cents
// below that, and "<$0.01" for a cost that rounds to nothing but is not zero.
/** @param {unknown} n */
export function fmtUsd(n) {
  var v = Number(n) || 0;
  if (v <= 0) return '$0';
  if (v < 0.01) return '<$0.01';
  if (v >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
  return '$' + v.toFixed(2);
}

// A dollar figure for an axis or over a bar, where room is short: $0.50,
// $25, $12.50, $433, $1.2k. Cents stay under $100 unless the figure is
// whole: an axis of $6.25 steps rounded to $13 and $19 would misread.
/** @param {unknown} n */
export function fmtUsdShort(n) {
  var v = Number(n) || 0;
  if (v <= 0) return '$0';
  if (v >= 1000) return '$' + fmtTokens(v);
  if (v >= 100) return '$' + Math.round(v);
  if (Math.abs(v - Math.round(v)) < 0.005) return '$' + Math.round(v);
  return fmtUsd(v);
}

// The top of a value axis: the first 1, 2, 2.5 or 5 times a power of ten at or
// above `v`, so the four gridlines under it land on round numbers.
/** @param {number} v */
export function niceCeil(v) {
  if (!(v > 0)) return 1;
  var p = Math.pow(10, Math.floor(Math.log10(v)));
  var f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// The range as a phrase: "last 30 days", "all time".
/** @param {string} range */
export function insightsRangeText(range) {
  if (range === '24h') return 'last 24 hours';
  if (range === 'all') return 'all time';
  var n = parseInt(range, 10);
  return n > 0 ? 'last ' + n + ' days' : String(range);
}

// A headline against the period before it, as the hero prints it: a pill
// ("▲ 12%") and the words after it ("vs the previous 30 days"). Null when
// there is nothing to compare with: no earlier period on record, or one that
// spent nothing (a percentage of zero is not a number anyone can read). The
// arrow carries the direction and is not coloured, since more usage is not
// good or bad in itself.
/**
 * @param {number} cur
 * @param {number|null|undefined} prev
 * @param {string} range
 */
export function insightsChange(cur, prev, range) {
  if (prev == null || !(prev > 0)) return null;
  var pct = Math.round((cur / prev - 1) * 100);
  var span = range === '24h' ? '24 hours' : parseInt(range, 10) + ' days';
  return { pill: (pct > 0 ? '▲ ' : pct < 0 ? '▼ ' : '') + Math.abs(pct) + '%', vs: 'vs the previous ' + span };
}

// A day bucket ("2026-10-29") or an hour bucket (epoch ms) as an axis label,
// and in the longer form the tooltip and table use.
/**
 * @param {string|number} bucket
 * @param {string} unit
 * @param {boolean} long
 */
export function insightsBucketLabel(bucket, unit, long) {
  if (unit === 'hour') {
    var h = new Date(Number(bucket));
    // The hour's own minutes, not ':00': buckets are epoch hours, which start
    // at :30 or :45 local time in a zone with a fractional offset (India, Nepal).
    var hh = String(h.getHours()).padStart(2, '0') + ':' + String(h.getMinutes()).padStart(2, '0');
    return long ? h.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + hh : hh;
  }
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(bucket));
  if (!m) return String(bucket);
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString([], long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}

// The series the timeline stacks for one "split by" choice, bottom first, each
// with its colour as a CSS variable so the theme decides the shade.
//
// Colour follows the thing, never its rank, so a range change cannot repaint
// a series. Providers use their own colours (all third-party backends share
// one, and are one series). A history row's `provider` is the account's group
// (accountGroup): `anthropic`, `codex` or `backend:<host>`. Accounts take the chart palette by their place in
// the config (`accounts` is status.accounts, which keeps config order), so an
// account keeps its colour whatever the range; past the palette's eight, and
// for an account no longer configured, they are summed into one grey "Other".
//
// `metric` picks what is stacked: tokens (the default), requests or estimated
// cost. Only a provider or account split can stack the last two, since token
// types have no requests of their own and machines send only their tokens per
// bucket. Those, and a reply from a proxy too old to send the per-bucket
// arrays, give no series, and the page draws one total instead.
/**
 * @param {any} data  a GET /teamclaude/insights reply
 * @param {string} split  'provider' | 'account' | 'kind' | 'instance'
 * @param {any[]} accounts  status.accounts
 * @param {string} [metric]  'tokens' | 'requests' | 'cost'
 * @returns {{ key: string, label: string, color: string, values: number[], total: number }[]}
 */
export function insightsSeries(data, split, accounts, metric) {
  var n = (data && data.buckets ? data.buckets.length : 0);
  var m = metric || 'tokens';
  var pick = function (/** @type {any} */ row) { return m === 'requests' ? row.requestValues : m === 'cost' ? row.costValues : row.values; };
  var tot = function (/** @type {any} */ row) { return (m === 'requests' ? row.requests : m === 'cost' ? row.cost : row.tokens) || 0; };
  if (data && m !== 'tokens') {
    if (split === 'kind' || split === 'instance' || data.splitDetail === false) return [];
    var rows = split === 'account' ? data.accounts : data.providers;
    if ((rows || []).some(function (/** @type {any} */ r) { return !Array.isArray(pick(r)); })) return [];
  }
  var zeros = function () { /** @type {number[]} */ var a = []; for (var i = 0; i < n; i++) a.push(0); return a; };
  var sum = function (/** @type {number[]} */ vals) { return vals.reduce(function (x, y) { return x + y; }, 0); };
  /** @type {{ key: string, label: string, color: string, values: number[], total: number }[]} */
  var out = [];
  if (!data) return out;
  if (split === 'kind') {
    [['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write'], ['input', 'Input'], ['output', 'Output']].forEach(function (k) {
      var vals = (data.kinds && data.kinds[k[0]]) || zeros();
      out.push({ key: k[0], label: k[1], color: 'var(--ik-' + k[0] + ')', values: vals, total: sum(vals) });
    });
    return out;
  }
  if (split === 'instance') {
    // This machine first, then the linked ones in config order, which is the
    // order the reply lists them in, so a machine keeps its colour.
    (data.instances || []).forEach(function (/** @type {any} */ m, /** @type {number} */ i) {
      if (m.state !== 'ok') return;
      out.push({ key: 'instance/' + m.name, label: m.name, color: i < 8 ? 'var(--is' + (i + 1) + ')' : 'var(--dim)', values: (m.values || zeros()).slice(), total: m.tokens || 0 });
    });
    return out;
  }
  if (split === 'account') {
    var known = (accounts || []).map(function (a) { return accountGroup(a) + '/' + a.name; });
    // Every machine at once: the accounts only a linked machine has come
    // after this one's, by name, so they too keep a colour across ranges.
    if (data.scope === 'all') {
      (data.accounts || []).map(function (/** @type {any} */ a) { return a.provider + '/' + a.account; })
        .filter(function (/** @type {string} */ k) { return known.indexOf(k) < 0; })
        .sort()
        .forEach(function (/** @type {string} */ k) { known.push(k); });
    }
    /** @type {Record<number, { key: string, label: string, color: string, values: number[], total: number }>} */
    var bySlot = {};
    /** @type {{ key: string, label: string, color: string, values: number[], total: number }|null} */
    var other = null;
    (data.accounts || []).forEach(function (/** @type {any} */ a) {
      var slot = known.indexOf(a.provider + '/' + a.account);
      if (slot >= 0 && slot < 8) {
        bySlot[slot] = { key: a.provider + '/' + a.account, label: a.account, color: 'var(--is' + (slot + 1) + ')', values: pick(a).slice(), total: tot(a) };
      } else {
        if (!other) other = { key: 'other', label: 'Other', color: 'var(--dim)', values: zeros(), total: 0 };
        for (var i = 0; i < n; i++) other.values[i] += pick(a)[i] || 0;
        other.total += tot(a);
      }
    });
    Object.keys(bySlot).map(Number).sort(function (x, y) { return x - y; }).forEach(function (s) { out.push(bySlot[s]); });
    if (other) out.push(other);
    return out;
  }
  /** @type {Record<string, { key: string, label: string, color: string, values: number[], total: number, members: number }>} */
  var tones = {};
  (data.providers || []).forEach(function (/** @type {any} */ p) {
    var tone = providerTone(p.provider);
    if (!tones[tone]) {
      tones[tone] = { key: tone, label: groupLabel(p.provider), color: 'var(--ip-' + tone + ')', values: zeros(), total: 0, members: 0 };
    }
    var t = tones[tone];
    t.members++;
    if (tone === 'backend' && t.members > 1) t.label = 'Backends';
    for (var i = 0; i < n; i++) t.values[i] += pick(p)[i] || 0;
    t.total += tot(p);
  });
  ['claude', 'codex', 'grok', 'backend'].forEach(function (tone) {
    if (!tones[tone]) return;
    var t = tones[tone];
    out.push({ key: t.key, label: t.label, color: t.color, values: t.values, total: t.total });
  });
  return out;
}

// Where each series sits in the stack at each bucket: `[bottom, top]`.
/**
 * @param {{ values: number[] }[]} series
 * @param {number} n
 */
export function stackSeries(series, n) {
  /** @type {number[][][]} */
  var cols = [];
  for (var i = 0; i < n; i++) {
    var acc = 0;
    /** @type {number[][]} */
    var col = [];
    for (var s = 0; s < series.length; s++) {
      var v = series[s].values[i] || 0;
      col.push([acc, acc + v]);
      acc += v;
    }
    cols.push(col);
  }
  return cols;
}

// What a series' legend row says: its total, its average bucket, its busiest
// bucket and its latest. The latest is the bucket still filling (this hour,
// today), which is why the page heads that column "Now".
//
// The average is of full buckets: from `from`, the first bucket recording
// covers (recordedFrom), so a 30-day range on a history three days old
// averages three days, not thirty; and without the bucket still filling,
// which would pull it down. That matches the chart's line only while the line
// is the flat average of those buckets; a 7-day average is another figure.
// With no full bucket yet it is the one there is.
/** @param {number[]|null|undefined} values @param {number} [from] */
export function seriesStats(values, from) {
  var v = values || [];
  var start = Math.min(Math.max(0, from || 0), v.length);
  var total = 0;
  var max = 0;
  var full = 0;
  for (var i = 0; i < v.length; i++) {
    var x = Number(v[i]) || 0;
    total += x;
    if (x > max) max = x;
    if (i >= start && i < v.length - 1) full += x;
  }
  var n = v.length - 1 - start;
  var last = v.length ? Number(v[v.length - 1]) || 0 : 0;
  return { total: total, avg: n > 0 ? full / n : start < v.length ? last : 0, max: max, last: last };
}

// The first bucket of a reply that recording covers: the one holding
// `since`. Buckets before it were not idle, they were not recorded. Never
// later than the first bucket that holds any usage: a machine in another time
// zone, on a version that does not say its first day, can put usage on a day
// this clock calls the day before, and an average that left that day out of
// its count but not its total would read above the peak.
/** @param {any} data  a GET /teamclaude/insights reply */
export function recordedFrom(data) {
  var d = data || {};
  var b = d.buckets || [];
  var k = d.kinds || {};
  var first = b.length;
  for (var j = 0; j < b.length && first === b.length; j++) {
    if (((k.input || [])[j] || 0) + ((k.output || [])[j] || 0) + ((k.cacheRead || [])[j] || 0) + ((k.cacheWrite || [])[j] || 0) > 0) first = j;
  }
  if (d.since == null) return first;
  for (var i = 0; i < b.length; i++) {
    if (d.unit === 'hour' ? Number(b[i]) + 3600000 > d.since : String(b[i]) >= (d.sinceDay || insightsDayKey(d.since))) return Math.min(i, first);
  }
  return first;
}

// The local calendar day of a time, as the history keys its days.
/** @param {number} ts */
export function insightsDayKey(ts) {
  var t = new Date(ts);
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

// Which bucket a pointer at `x` pixels into the plot is over: every panel
// gives bucket i the same band, so one x is one bucket on all of them.
/** @param {number} x @param {number} band @param {number} n */
export function bucketAt(x, band, n) {
  return Math.max(0, Math.min(n - 1, Math.floor(x / band)));
}

// Every how many buckets an axis label goes, so labels about `chars` long
// never touch: about 6.5px a character and 18px between them.
/** @param {number} chars @param {number} band */
export function labelStep(chars, band) {
  return Math.max(1, Math.ceil((chars * 6.5 + 18) / band));
}

// Requests to models with a known price, by provider tone and in all. A cost
// per request divides priced cost by these, not by every request: a request
// to an unpriced model costs nothing in the estimate, and counting it would
// pull the figure down (or to $0 for a provider priced not at all).
/** @param {any[]|null|undefined} models  insights.models */
export function pricedRequests(models) {
  /** @type {Record<string, number>} */
  var out = { all: 0 };
  (models || []).forEach(function (/** @type {any} */ m) {
    if (typeof m.cost !== 'number') return;
    // A fleet sum says how many of a model's requests were priced; a reply
    // from before that field prices all of a priced model's.
    var n = typeof m.pricedRequests === 'number' ? m.pricedRequests : (m.requests || 0);
    var tone = providerTone(m.provider);
    out[tone] = (out[tone] || 0) + n;
    out.all += n;
  });
  return out;
}

// The share of prompt tokens the prompt cache served: cache reads over every
// prompt token (input, cache reads, cache writes). Output is never served
// from the cache, so it is not in the denominator. Null with no prompt tokens.
/** @param {{ input?: number, cacheRead?: number, cacheWrite?: number }|null|undefined} t */
export function cacheHitRate(t) {
  var x = t || {};
  var prompt = (x.input || 0) + (x.cacheRead || 0) + (x.cacheWrite || 0);
  return prompt > 0 ? (x.cacheRead || 0) / prompt : null;
}

// The busiest bucket: which one, its value, and how many average buckets it
// is worth. Null when the range spent nothing.
/** @param {number[]|null|undefined} values @param {number} [from]  see seriesStats */
export function peakBucket(values, from) {
  var v = values || [];
  var st = seriesStats(v, from);
  if (!(st.max > 0)) return null;
  var index = 0;
  for (var i = 0; i < v.length; i++) if ((Number(v[i]) || 0) === st.max) { index = i; break; }
  return { index: index, value: st.max, ratio: st.avg > 0 ? st.max / st.avg : null };
}

// One row per provider for the Providers table, in the timeline's order and
// colours: what it spent, its share of the range's tokens, the estimated cost
// per request and its cache hit rate. All third-party backends are one row.
/** @param {any} data  a GET /teamclaude/insights reply */
export function providerRows(data) {
  /** @type {Record<string, any>} */
  var by = {};
  var total = 0;
  var d = data || {};
  // A machine on the previous version (read on its own, "This one") sends a
  // provider's tokens and cost only. Its models carry the requests and token
  // kinds, as mergeInsights uses for the fleet sum.
  /** @type {Record<string, Record<string, number>>} */
  var fromModels = {};
  (d.models || []).forEach(function (/** @type {any} */ m) {
    var t = fromModels[m.provider] || (fromModels[m.provider] = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    Object.keys(t).forEach(function (k) { t[k] += Number(m[k]) || 0; });
  });
  (d.providers || []).forEach(function (/** @type {any} */ p) {
    var tone = providerTone(p.provider);
    var counts = typeof p.requests === 'number' ? p : (fromModels[p.provider] || {});
    var r = by[tone];
    if (!r) r = by[tone] = { key: tone, label: groupLabel(p.provider), color: 'var(--ip-' + tone + ')', members: 0, accounts: 0, tokens: 0, cost: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    r.members++;
    if (tone === 'backend' && r.members > 1) r.label = 'Backends';
    r.tokens += Number(p.tokens) || 0;
    r.cost += Number(p.cost) || 0;
    ['requests', 'input', 'output', 'cacheRead', 'cacheWrite'].forEach(function (k) { r[k] += Number(counts[k]) || 0; });
    total += Number(p.tokens) || 0;
  });
  (d.accounts || []).forEach(function (/** @type {any} */ a) {
    var r = by[providerTone(a.provider)];
    if (r) r.accounts++;
  });
  var priced = pricedRequests(d.models);
  return ['claude', 'codex', 'grok', 'backend'].filter(function (k) { return by[k]; }).map(function (k) {
    var r = by[k];
    r.share = total > 0 ? r.tokens / total : 0;
    r.hit = cacheHitRate(r);
    r.perRequest = priced[k] > 0 ? r.cost / priced[k] : null;
    return r;
  });
}

// The ranked model list: dated snapshots of one model ("…-20251001") are one
// model to a reader, so models are grouped by the name modelLabel gives them,
// per provider, before ranking.
/**
 * @param {any[]|null|undefined} models  insights.models
 * @param {number} [limit]
 */
export function topModels(models, limit) {
  /** @type {Record<string, { label: string, provider: string, tokens: number, requests: number, input: number, output: number, cacheRead: number, cacheWrite: number, cost: number|null }>} */
  var groups = {};
  /** @type {string[]} */
  var order = [];
  (models || []).forEach(function (/** @type {any} */ m) {
    var label = m.model === '(unknown)' || m.model === '(other)' ? m.model : modelLabel(m.model);
    var key = m.provider + '/' + label;
    if (!groups[key]) { groups[key] = { label: label, provider: m.provider, tokens: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }; order.push(key); }
    var g = groups[key];
    g.tokens += m.tokens;
    g.requests += m.requests;
    g.input += m.input || 0;
    g.output += m.output || 0;
    g.cacheRead += m.cacheRead || 0;
    g.cacheWrite += m.cacheWrite || 0;
    // Null (no price known) only while every snapshot in the group is.
    if (typeof m.cost === 'number') g.cost = (g.cost || 0) + m.cost;
  });
  return order.map(function (k) { return groups[k]; })
    .sort(function (x, y) { return y.tokens - x.tokens; })
    .slice(0, limit || 6);
}

// Whether the reply has a cost estimate to show at all: a proxy too old to
// estimate it sends none, and a range whose every token was on a model with
// no list price comes to $0, which is not the same as costing nothing. Either
// way the page treats the cost as absent rather than draw it as $0.
/** @param {any} data  a GET /teamclaude/insights reply */
export function costEstimated(data) {
  var c = data && data.cost;
  return !!c && !(!(c.total > 0) && c.unpricedTokens > 0);
}

// The two numbers the page is built around, per bucket: every token (cache
// included, as the history counts them) or the estimated API cost. Null for
// cost with no estimate (costEstimated), so "no estimate" never reads as $0.
/**
 * @param {any} data  a GET /teamclaude/insights reply
 * @param {string} metric  'tokens' | 'cost'
 * @returns {number[]|null}
 */
export function insightsTotals(data, metric) {
  var d = data || {};
  var n = (d.buckets || []).length;
  /** @type {number[]} */
  var out = [];
  if (metric === 'cost') {
    if (!costEstimated(d) || !Array.isArray(d.cost.values)) return null;
    for (var i = 0; i < n; i++) out.push(Number(d.cost.values[i]) || 0);
    return out;
  }
  var k = d.kinds || {};
  for (var j = 0; j < n; j++) {
    out.push(((k.input || [])[j] || 0) + ((k.output || [])[j] || 0) + ((k.cacheRead || [])[j] || 0) + ((k.cacheWrite || [])[j] || 0));
  }
  return out;
}

// Each bucket's total since the start of the range: what the "Running total"
// view draws, so its last point is the headline figure.
/** @param {(number|null|undefined)[]|null|undefined} values */
export function runningTotals(values) {
  var acc = 0;
  return (values || []).map(function (v) { acc += Number(v) || 0; return acc; });
}

// Each bucket's average over the `window` buckets ending at it, and null
// wherever a whole window of buckets from..to-1 does not end there: before
// recording began there is nothing to average, the bucket still filling would
// drag the line down every morning, and a shorter window labelled as the full
// one would be a different number under the same name.
/**
 * @param {(number|null|undefined)[]|null|undefined} values
 * @param {number} window
 * @param {number} [from]  the first bucket recorded (recordedFrom)
 * @param {number} [to]  the first bucket left out; every one after `from` when omitted
 * @returns {(number|null)[]}
 */
export function rollingAverage(values, window, from, to) {
  var v = values || [];
  var w = Math.max(1, Math.floor(window) || 1);
  var start = Math.max(0, from || 0);
  var end = to == null ? v.length : Math.min(v.length, to);
  return v.map(function (_, i) {
    if (i - w + 1 < start || i >= end) return null;
    var sum = 0;
    for (var j = i - w + 1; j <= i; j++) sum += Number(v[j]) || 0;
    return sum / w;
  });
}

// The line the Per day / Per hour view draws over the bars, from full buckets
// only (never the one still filling, never one before recording began).
// With seven full days or more, days get a rolling 7-day average, drawn only
// where a whole week of full days ends: it follows a trend while smoothing
// the weekends out. With fewer (a 7-day range, a young history) they get one
// flat average of the full days there are, named for how many. Hours always
// get one flat average of the full hours: a rolling window of hours would
// mostly trace the day-and-night cycle, which the bars already show, and read
// as a trend that is not there. Null with no full bucket to average.
/**
 * @param {number[]|null|undefined} values  the bars' totals, one per bucket
 * @param {string} unit  'hour' | 'day'
 * @param {number} from  the first bucket recorded (recordedFrom)
 * @returns {{ values: (number|null)[], label: string, last: number }|null}
 */
export function insightsTrend(values, unit, from) {
  var v = values || [];
  var n = v.length;
  var full = n - 1 - from;
  if (full < 1) return null;
  if (unit === 'hour' || full < 7) {
    var sum = 0;
    for (var i = from; i < n - 1; i++) sum += Number(v[i]) || 0;
    var avg = sum / full;
    var label = unit === 'hour' ? 'average full hour' : full === 1 ? 'the last full day' : 'average of ' + full + ' full days';
    return { values: v.map(function (_, k) { return k >= from && k < n - 1 ? avg : null; }), label: label, last: avg };
  }
  var r = rollingAverage(v, 7, from, n - 1);
  return { values: r, label: '7-day average', last: /** @type {number} */ (r[n - 2]) };
}

// When the page leaves out the calendar and the months, the one line it shows
// instead, or null when it draws them. They need four weeks of days: a week
// is one column of calendar and part of a month, and hours have neither. On a
// young history the line counts the days recorded rather than suggest a range
// that would show no more, which may be the one already picked.
/** @param {any} data  a GET /teamclaude/insights reply */
export function calendarNote(data) {
  var d = data || {};
  var n = (d.buckets || []).length;
  var min = 28;
  if (d.unit === 'hour') return 'The calendar and the months are drawn by day: pick 30d, 90d or All.';
  var recorded = n - recordedFrom(d);
  if ((d.range === 'all' || recorded < n) && recorded < min) {
    return 'The calendar and the months need four weeks of history (' + recorded + (recorded === 1 ? ' day' : ' days') + ' so far).';
  }
  if (n < min) return 'The calendar and the months need four weeks or more: pick 30d, 90d or All.';
  return null;
}

// The day "All" counts from, with its year when that is not the year of the
// latest bucket (today, by the proxy's clock).
/** @param {string} day  YYYY-MM-DD @param {string} today  the latest bucket */
export function sinceText(day, today) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  var dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dt.toLocaleDateString([], m[1] === today.slice(0, 4) ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// One of the hero's two headlines: the range's estimated API cost or its
// tokens, against the period before. The cost one says what it left out
// (tokens on models with no list price), since its figure does not include
// them; the tokens one carries the request count the old tiles had.
//
// Whether there is an earlier period is the reply's `previous` alone, which
// the server sends exactly when the history covers it, so the two headlines
// can never disagree about it. A covered period that spent nothing (or
// nothing priced) says so, rather than that it was not recorded.
/**
 * @param {any} data  a GET /teamclaude/insights reply
 * @param {string} metric  'tokens' | 'cost'
 * @returns {{ label: string, value: number|null, text: string, change: string|null, vs: string, note: string }}
 */
export function insightsHeadline(data, metric) {
  var d = data || {};
  var t = d.totals || {};
  var p = d.previous;
  var range = d.range || '30d';
  var span = 'the previous ' + (range === '24h' ? '24 hours' : parseInt(range, 10) + ' days');
  var empty = d.since == null ? 'nothing recorded yet'
    : range === 'all' ? 'since ' + sinceText(d.sinceDay || insightsDayKey(d.since), String((d.buckets || [])[(d.buckets || []).length - 1] || ''))
      : 'no earlier period on record';
  if (metric === 'cost') {
    var c = d.cost;
    if (!c) return { label: 'Est. API cost', value: null, text: '—', change: null, vs: 'this proxy is too old to estimate it', note: '' };
    // Tokens, none of them on a model with a list price: no estimate, not $0.
    if (!costEstimated(d)) return { label: 'Est. API cost', value: null, text: 'not priced', change: null, vs: fmtTokens(c.unpricedTokens) + ' tokens, none at a known list price', note: '' };
    var cc = p == null ? null : insightsChange(c.total, c.previous, range);
    return { label: 'Est. API cost', value: c.total, text: fmtUsd(c.total), change: cc ? cc.pill : null,
      vs: cc ? cc.vs : p == null ? empty : c.previous == null ? 'no estimate for ' + span : 'no priced cost in ' + span,
      note: c.unpricedTokens > 0 ? fmtTokens(c.unpricedTokens) + ' tokens not priced' : 'at API list prices' };
  }
  var tokens = (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
  var prev = p ? (p.input || 0) + (p.output || 0) + (p.cacheRead || 0) + (p.cacheWrite || 0) : null;
  var tc = insightsChange(tokens, prev, range);
  var reqs = t.requests || 0;
  return { label: 'Tokens', value: tokens, text: fmtTokens(tokens), change: tc ? tc.pill : null,
    vs: tc ? tc.vs : p == null ? empty : 'no tokens in ' + span,
    note: reqs.toLocaleString('en-US') + (reqs === 1 ? ' request' : ' requests') };
}

// The hero's third figure: where the chosen metric is heading. On days, when
// the range reaches the 1st of this month (or the day recording began, if
// that was this month), it is the month projected: the month so far, plus
// the average of the last seven full days for each day after today.
// Otherwise it is that daily average over 30 days. Today is still filling, so
// it is never one of the full days, and the rest of it is not projected: the
// figure leans low rather than high. On hours it is the busiest hour instead,
// since a day of hours projects nothing a person would plan by. Null with no
// full day (or no hour with usage) to go on, and for a cost with no estimate.
//
// A projection is not good to the cent, so the figure is whole dollars (or
// tokens to the precision fmtTokens would print the figure at). It is built
// from the parts the sum on screen prints, each rounded the same way, so the
// sum adds up to it exactly: "$97 so far + $205 for the 20 days left" is $302.
/**
 * @param {any} data  a GET /teamclaude/insights reply
 * @param {string} metric  'tokens' | 'cost'
 * @param {number} [days]  how many recent full days set the pace (7)
 * @returns {{ kind: 'month'|'run'|'peak', label: string, value: number, text: string, sub: string, how: string, rate: number|null, soFar: number|null, left: number|null, month: string|null, against: string|null }|null}
 */
export function insightsPace(data, metric, days) {
  var d = data || {};
  var v = insightsTotals(d, metric);
  var b = d.buckets || [];
  var n = b.length;
  if (!v || !n || d.since == null) return null;
  var cost = metric === 'cost';
  var fmt = cost ? fmtUsd : fmtTokens;
  var from = recordedFrom(d);
  if (d.unit === 'hour') {
    var peak = peakBucket(v, from);
    if (!peak) return null;
    return { kind: 'peak', label: 'Busiest hour', value: peak.value, text: fmt(peak.value),
      sub: insightsBucketLabel(b[peak.index], 'hour', true) + (peak.index === n - 1 ? ' (so far)' : '') + (peak.ratio ? ' · ' + peak.ratio.toFixed(1) + '× the average full hour' : ''),
      how: 'The hour with the most, against the average full hour.', rate: null, soFar: null, left: null, month: null, against: null };
  }
  var want = days || 7;
  /** @type {number[]} */
  var full = [];
  for (var i = Math.max(from, n - 1 - want); i < n - 1; i++) full.push(v[i]);
  if (!full.length) return null;
  var span = full.length === 1 ? 'the last full day' : 'the last ' + full.length + ' full days';
  var rate = full.reduce(function (x, y) { return x + y; }, 0) / full.length;
  // The unit the projection is printed in: whole dollars, or fmtTokens' unit
  // and decimals for a figure the size of `x`.
  /** @param {number} x */
  var unitFor = function (x) {
    if (cost) return { scale: 1, dec: 0, pre: '$', suf: '' };
    var a = Math.abs(x);
    if (a >= 1e12) return { scale: 1e12, dec: 2, pre: '', suf: 'T' };
    if (a >= 1e9) return { scale: 1e9, dec: a >= 1e11 ? 0 : a >= 1e10 ? 1 : 2, pre: '', suf: 'B' };
    if (a >= 1e6) return { scale: 1e6, dec: a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2, pre: '', suf: 'M' };
    if (a >= 1e3) return { scale: 1e3, dec: a >= 1e5 ? 0 : 1, pre: '', suf: 'k' };
    return { scale: 1, dec: 0, pre: '', suf: '' };
  };
  /** @param {number} x @param {{ scale: number, dec: number }} u  x in the unit, rounded as printed */
  var inUnit = function (x, u) { return Number((x / u.scale).toFixed(u.dec)); };
  /** @param {number} x  a count of units @param {{ dec: number, pre: string, suf: string }} u */
  var show = function (x, u) { return u.pre + (u.dec ? x.toFixed(u.dec) : Math.round(x).toLocaleString('en-US')) + u.suf; };
  // The rate as the line prints it (fmtUsd's cents, fmtTokens' figures). The
  // projection multiplies this one, not the exact average, so "287k/day" for
  // 20 days reads 5.74M and the printed sum works out by hand.
  var tu = unitFor(rate);
  var shownRate = cost ? (rate >= 1000 ? Math.round(rate) : Math.round(rate * 100) / 100) : inUnit(rate, tu) * tu.scale;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b[n - 1]));
  if (m) {
    var first = m[1] + '-' + m[2] + '-01';
    var sinceDay = d.sinceDay || insightsDayKey(d.since);
    var start = b.indexOf(first);
    // Recording that began after the 1st saw only part of the month: it is
    // counted from that day and says so. When the range itself starts after
    // the 1st, the month is covered only if recording began inside it.
    var began = from < n && String(b[from]) > first && (start >= 0 ? from > start : sinceDay >= String(b[0]));
    if (began) start = from;
    if (start >= 0) {
      var soFar = 0;
      for (var j = start; j < n; j++) soFar += v[j];
      var dayOf = Number(m[3]);
      var left = new Date(Number(m[1]), Number(m[2]), 0).getDate() - dayOf;
      var month = new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString([], { month: 'long' });
      var u = unitFor(soFar + shownRate * left);
      var partSoFar = inUnit(soFar, u);
      var partLeft = inUnit(shownRate * left, u);
      var sum = Number((partSoFar + partLeft).toFixed(u.dec));
      // This month's first full days against the same days of last month,
      // only when every day of last month is in the reply and on record (part
      // of a month is not its total, and a shorter range is not asked again
      // for it). Today is still filling, so it is in neither, and on the 1st
      // there is nothing to compare yet. A month shorter than today's date
      // caps both sides at its length, so the two windows are always alike.
      var prevStart = new Date(Number(m[1]), Number(m[2]) - 2, 1);
      var prevKey = insightsDayKey(prevStart.getTime()).slice(0, 7);
      var prevDays = new Date(Number(m[1]), Number(m[2]) - 1, 0).getDate();
      var alike = Math.min(dayOf - 1, prevDays);
      var prevAt = b.indexOf(prevKey + '-01');
      /** @type {string|null} */
      var against = null;
      if (began === false && alike > 0 && prevAt >= from && prevAt >= 0 && prevAt + prevDays <= n) {
        var these = 0;
        for (var t = start; t < start + alike; t++) these += v[t];
        var those = 0;
        for (var k = prevAt; k < prevAt + alike; k++) those += v[k];
        var ch = insightsChange(these, those, '30d');
        if (ch) {
          against = (alike === 1 ? 'First day ' : 'First ' + alike + ' days ') + ch.pill + ' against '
            + prevStart.toLocaleDateString([], { month: 'long' }) + '’s (' + fmt(those) + ')';
        }
      }
      return { kind: 'month', label: 'On pace for', value: sum * u.scale, text: show(sum, u),
        sub: month + ': ' + show(partSoFar, u) + ' so far' + (left > 0 ? ' + ' + show(partLeft, u) + ' for the ' + (left === 1 ? 'day' : left + ' days') + ' left (' + fmt(rate) + '/day)' : ', its last day'),
        how: 'Projected: ' + month + ' so far' + (began ? ' (recorded from ' + insightsBucketLabel(sinceDay, 'day', false) + ')' : '') + ', plus the average of ' + span + ' for each day after today.',
        rate: rate, soFar: soFar, left: left, month: month, against: against };
    }
  }
  var ru = unitFor(shownRate * 30);
  var run = inUnit(shownRate * 30, ru);
  return { kind: 'run', label: '30-day pace', value: run * ru.scale, text: show(run, ru), sub: '30 days at ' + fmt(rate) + '/day, the average of ' + span,
    how: 'Projected: the average of ' + span + ', times 30.', rate: rate, soFar: null, left: null, month: null, against: null };
}

// The range's days summed by calendar month, oldest first, for the By month
// card. A month the range (or recording) starts part-way through says the
// day it is counted from, so a short bar does not read as a quiet month. The
// month still running carries the pace's projection when there is one, and
// the pace's own text for it, so the bar and the headline print the same figure.
/**
 * @param {any} data  a GET /teamclaude/insights reply
 * @param {string} metric  'tokens' | 'cost'
 * @returns {{ key: string, label: string, long: string, total: number, days: number, from: string|null, current: boolean, projected: number|null, projectedText: string|null }[]}
 */
export function monthTotals(data, metric) {
  var d = data || {};
  if (d.unit !== 'day' || d.since == null) return [];
  var v = insightsTotals(d, metric);
  if (!v) return [];
  var b = d.buckets || [];
  /** @type {{ key: string, label: string, long: string, total: number, days: number, from: string|null, current: boolean, projected: number|null, projectedText: string|null }[]} */
  var out = [];
  for (var i = recordedFrom(d); i < b.length; i++) {
    var day = String(b[i]);
    var key = day.slice(0, 7);
    var row = out.length ? out[out.length - 1] : null;
    if (!row || row.key !== key) {
      var start = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
      row = { key: key, label: start.toLocaleDateString([], { month: 'short' }), long: start.toLocaleDateString([], { month: 'long', year: 'numeric' }),
        total: 0, days: 0, from: day.slice(8) === '01' ? null : day, current: false, projected: null, projectedText: null };
      out.push(row);
    }
    row.total += v[i];
    row.days++;
  }
  if (out.length) {
    var last = out[out.length - 1];
    // A month from an earlier year carries it ("Nov '25"), so a year-long
    // range never shows two bars both named "Nov".
    out.forEach(function (row) { if (row.key.slice(0, 4) !== last.key.slice(0, 4)) row.label += ' ’' + row.key.slice(2, 4); });
    last.current = true;
    var pace = insightsPace(d, metric);
    if (pace && pace.kind === 'month') { last.projected = pace.value; last.projectedText = pace.text; }
  }
  return out;
}

// The range's days as a calendar, a column a week from Monday, the way GitHub
// draws contributions. Each day is shaded by the quarter of the range's
// active days it falls in rather than by its share of the biggest, so one
// huge day does not wash the rest out. The quarters are of full days: today
// is still filling, and would pull the cuts down. With no spread to cut (one
// active day, or all alike) every active day takes the top shade. A day
// before recording began is marked as not recorded (level -1), apart from an
// idle day (level 0). Beside it, each weekday's average full day, for the
// same reason.
/**
 * @param {any} data  a GET /teamclaude/insights reply
 * @param {number[]} values  one per bucket (insightsTotals)
 */
export function calendarGrid(data, values) {
  var d = data || {};
  var b = d.unit === 'day' ? (d.buckets || []) : [];
  var v = values || [];
  var from = recordedFrom(d);
  /** @type {number[]} */
  var active = [];
  for (var i = from; i < b.length - 1; i++) if ((v[i] || 0) > 0) active.push(v[i]);
  active.sort(function (x, y) { return x - y; });
  var q = function (/** @type {number} */ f) { return active.length ? active[Math.floor(f * (active.length - 1))] : 0; };
  var cuts = [q(0.25), q(0.5), q(0.75)];
  var flat = cuts[0] === cuts[2];
  var level = function (/** @type {number} */ x) { return !(x > 0) ? 0 : flat ? 4 : x <= cuts[0] ? 1 : x <= cuts[1] ? 2 : x <= cuts[2] ? 3 : 4; };
  /** @type {({ i: number, key: string, value: number, level: number, today: boolean }|null)[][]} */
  var weeks = [];
  /** @type {({ i: number, key: string, value: number, level: number, today: boolean }|null)[]|null} */
  var week = null;
  /** @type {{ label: string, total: number, days: number, avg: number|null }[]} */
  var weekdays = [];
  for (var w = 0; w < 7; w++) weekdays.push({ label: new Date(2024, 0, 1 + w).toLocaleDateString([], { weekday: 'short' }), total: 0, days: 0, avg: null });
  for (var j = 0; j < b.length; j++) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b[j]));
    if (!m) continue;
    var wd = (new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay() + 6) % 7;
    if (!week || wd === 0) { week = [null, null, null, null, null, null, null]; weeks.push(week); }
    var x = Number(v[j]) || 0;
    week[wd] = { i: j, key: String(b[j]), value: x, level: j < from ? -1 : level(x), today: j === b.length - 1 };
    if (j >= from && j < b.length - 1) { weekdays[wd].total += x; weekdays[wd].days++; }
  }
  weekdays.forEach(function (wk) { wk.avg = wk.days ? wk.total / wk.days : null; });
  return { weeks: weeks, weekdays: weekdays, cuts: cuts };
}

// The "Where it went" list: one row per model, account, provider or (every
// machine at once) machine, ranked by the hero's metric, with what each one's
// tokens cost per million at list price. A row that cannot be priced (a
// third-party backend, a model the price table does not know) has a null cost
// and, ranked by cost, comes after every priced row rather than reading as a
// free $0.
//
// Only a model carries "no price" (a null cost) in the reply. An account,
// provider or machine is summed by the server, so one whose every model is
// unpriced arrives with a cost of 0. It is read as unpriced when it spent
// tokens but no money, or when the reply has models for its provider and
// none of them is priced.
//
// Account rows also carry their own value per bucket (`values`), for the
// small charts that show whether rotation spreads the work evenly.
/**
 * @param {any} data  a GET /teamclaude/insights reply
 * @param {string} by  'model' | 'account' | 'provider' | 'machine'
 * @param {string} metric  'tokens' | 'cost'
 * @returns {{ key: string, label: string, group: string, color: string, tokens: number, requests: number, cost: number|null, perMillion: number|null, share: number|null, hit: number|null, values: number[]|null }[]}
 */
export function breakdownRows(data, by, metric) {
  var d = data || {};
  var byCost = metric === 'cost';
  // By provider and by provider colour: true when one of its models is priced, false when none is.
  /** @type {Record<string, boolean>} */
  var modelPriced = Object.create(null);
  (d.models || []).forEach(function (/** @type {any} */ m) {
    var p = typeof m.cost === 'number';
    [m.provider, 'tone:' + providerTone(m.provider)].forEach(function (k) { modelPriced[k] = modelPriced[k] === true || p; });
  });
  /** @param {any} x @param {string|null} key  the provider (or 'tone:<tone>') whose models say whether it can be priced */
  var costOf = function (x, key) {
    if (typeof x.cost !== 'number') return null;
    if ((Number(x.tokens) || 0) > 0 && !(x.cost > 0)) return null;
    return key != null && modelPriced[key] === false ? null : x.cost;
  };
  /** @type {{ key: string, label: string, group: string, color: string, tokens: number, requests: number, cost: number|null, perMillion: number|null, share: number|null, hit: number|null, values: number[]|null }[]} */
  var rows = [];
  /**
   * @param {string} key @param {string} label @param {string} group @param {string} color
   * @param {any} x  its tokens, requests and token kinds
   * @param {number|null} cost
   * @param {number[]|null} [values]
   */
  var add = function (key, label, group, color, x, cost, values) {
    var tokens = Number(x.tokens) || 0;
    rows.push({ key: key, label: label, group: group, color: color, tokens: tokens, requests: Number(x.requests) || 0, cost: cost,
      perMillion: cost != null && tokens > 0 ? cost / tokens * 1e6 : null, share: null, hit: typeof x.cacheRead === 'number' ? cacheHitRate(x) : null,
      values: values || null });
  };
  if (by === 'model') {
    topModels(d.models, 1000).forEach(function (m) { add(m.provider + '/' + m.label, m.label, groupLabel(m.provider), 'var(--ip-' + providerTone(m.provider) + ')', m, m.cost); });
  } else if (by === 'account') {
    (d.accounts || []).forEach(function (/** @type {any} */ a) {
      var cost = costOf(a, a.provider);
      // A fleet sum missing a machine's per-bucket cost would draw its share as nothing.
      var series = byCost ? (cost != null && d.splitDetail !== false ? a.costValues : null) : a.values;
      add(a.provider + '/' + a.account, a.account, groupLabel(a.provider), 'var(--ip-' + providerTone(a.provider) + ')', a, cost, Array.isArray(series) ? series : null);
    });
  } else if (by === 'machine') {
    (d.instances || []).forEach(function (/** @type {any} */ m, /** @type {number} */ i) {
      if (m.state !== 'ok') return;
      add('instance/' + m.name, m.name + (m.self ? ' (this one)' : ''), '', i < 8 ? 'var(--is' + (i + 1) + ')' : 'var(--dim)', m, costOf(m, null));
    });
  } else {
    providerRows(d).forEach(function (p) { add(p.key, p.label, p.accounts + (p.accounts === 1 ? ' account' : ' accounts'), p.color, p, costOf(p, 'tone:' + p.key)); });
  }
  var sum = rows.reduce(function (s, r) { return s + (byCost ? r.cost || 0 : r.tokens); }, 0);
  rows.forEach(function (r) {
    var x = byCost ? r.cost : r.tokens;
    r.share = x == null || !(sum > 0) ? null : x / sum;
  });
  return rows.sort(function (x, y) {
    if (byCost && (x.cost == null) !== (y.cost == null)) return x.cost == null ? 1 : -1;
    return byCost && x.cost != null && y.cost != null && x.cost !== y.cost ? y.cost - x.cost : y.tokens - x.tokens;
  });
}

// The linked machines an "All machines" reply could not count, as a sentence
// for under the tiles, or null when every one was counted.
/** @param {any} data  a GET /teamclaude/insights?scope=all reply */
export function fleetMissingText(data) {
  var missed = (data && Array.isArray(data.instances) ? data.instances : []).filter(function (/** @type {any} */ m) { return m.state !== 'ok'; });
  if (!missed.length) return null;
  /** @type {Record<string, string>} */
  var why = { unreachable: 'unreachable', refused: 'refused its key', outdated: 'too old to keep a history', error: 'could not be read' };
  return 'Not counted: ' + missed.map(function (/** @type {any} */ m) { return m.name + ' (' + (why[m.state] || m.state) + ')'; }).join(', ') + '.';
}

/** How long the Quota page's banner says a Codex account got a new reset credit. */
export const RESET_ALERT_NEW_MS = 7 * 24 * 60 * 60 * 1000;

/** How long an action's result stays above its account card. */
export const CARD_NOTE_MAX_AGE_MS = 60 * 1000;

/** What a reset with no readable verdict says. A page constant too: see SHARED_CONSTS. */
export const REDEEM_UNCERTAIN_TEXT = 'no answer to the reset; it may still have gone through. Refresh quota to check before trying again.';

const SHARED_HELPERS = [
  scopedWeeklyRows, accountTokens, modelLabel, recentModelLabels, providerLabel, thresholdBadgeText, accountBadges, sessionRows, sessionPinsText, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, accountControlRequest, accountControlOutcome, thresholdRequest, thresholdPercentText, thresholdOutcome, routeRows, problems, usageFor,
  probeIntervalOptions, probeIntervalRequest, probeIntervalOutcome, instanceNameRequest, instanceNameOutcome, instanceAddressRequest, instanceAddressOutcome, linkSelfWithAddress, selfInstanceLabel,
  passwordLoginRequest, passwordLoginOutcome, dashboardLoginRequest, dashboardLoginOutcome,
  outsideSpendHideRequest, outsideSpendHideOutcome, outsideSpendText, forecastText, fleetForecastText, showSessionRow, showWeeklyRow, callerCan, callerNotice, cardNoteKey, accountEmailLine, cardNoteFor, backendQuotaRows,
  canRefreshQuota, refreshQuotaRequest, refreshQuotaOutcome, creditText,
  codexResetsLeft, codexResetsSummary, canRedeemReset, redeemResetRequest, redeemResetOutcome, resetClickStep,
  codexResetExpiry, shortDate, resetsLeftText, resetCreditAlerts,
  meterTone, quotaMeter, exhaustedMeter, fableLabel, accountMeters, accountQuotaExhausted, poolSummary, accountGroup, groupLabel, providerTabs,
  mergeLogEvents, filterLogEvents, logEventDetail, logEventClient, logEventTone,
  providerTone, needsSignIn, fileSignInHint, isLoopbackHost, signInRequest, signInPlan, signInStatusOutcome, removeRequest, removeOutcome,
  clientKeyRequest, clientKeyOutcome, clientKeySetup, clientKeyCheckOutcome,
  connectRequest, connectRowView, connectOutcome,
  peerLinkRequest, peerLinkOutcome, peerTestOutcome, linkSelfOptions, linkBackNotice, instanceLink, parseInstanceLink, linkAddMissing,
  accountSyncRequest, accountSyncUser, accountSyncOwnMode, accountSyncMembers, accountSyncLine, peerSyncCell, accountSyncApprovalHref, accountSyncSignInOutcome, accountSyncCancelOutcome, accountSyncOutcome,
  fmtTokens, fmtUsd, fmtUsdShort, niceCeil, insightsRangeText, insightsChange, insightsBucketLabel, insightsSeries, stackSeries, seriesStats, recordedFrom, insightsDayKey, bucketAt, labelStep, pricedRequests, cacheHitRate, peakBucket, providerRows, topModels, fleetMissingText,
  costEstimated, sinceText, insightsTotals, runningTotals, rollingAverage, insightsTrend, calendarNote, insightsHeadline, insightsPace, monthTotals, calendarGrid, breakdownRows,
].map(fn => fn.toString()).join('\n\n');

// The constants ride along: `problems` closes over the thresholds and
// `accountBadges` over the reset-credit cut-off, so a page without them would
// ReferenceError on first render. The same goes for the two tables
// `thresholdBadgeText` reads. They follow the STARVED pair so the page's
// constants stay in one block ahead of the helpers that use them.
const SHARED_CONSTS = [
  `var STARVED_MIN = ${STARVED_MIN};`,
  `var STARVED_LIST_MAX = ${STARVED_LIST_MAX};`,
  `var RESET_CREDIT_MAX_AGE_MS = ${RESET_CREDIT_MAX_AGE_MS};`,
  `var CREDIT_EXPIRY_WINDOW_MS = ${CREDIT_EXPIRY_WINDOW_MS};`,
  `var RESET_ALERT_NEW_MS = ${RESET_ALERT_NEW_MS};`,
  `var THRESHOLD_BUCKET_KEYS = ${JSON.stringify(THRESHOLD_BUCKET_KEYS)};`,
  `var THRESHOLD_BUCKET_LABELS = ${JSON.stringify(THRESHOLD_BUCKET_LABELS)};`,
  `var USAGE_VIEWS = ${JSON.stringify(USAGE_VIEWS)};`,
  `var CARD_NOTE_MAX_AGE_MS = ${CARD_NOTE_MAX_AGE_MS};`,
  `var REDEEM_UNCERTAIN_TEXT = ${JSON.stringify(REDEEM_UNCERTAIN_TEXT)};`,
  `var LOG_KINDS = ${JSON.stringify(LOG_KINDS)};`,
  `var LOG_CAP = ${EVENT_LOG_CAPACITY};`,
  `var CLIENT_KEY_FAILED = ${JSON.stringify(CLIENT_KEY_FAILED)};`,
  `var PEER_LINK_FAILED = ${JSON.stringify(PEER_LINK_FAILED)};`,
  `var INSTANCE_LINK_SCHEMES = ${JSON.stringify(INSTANCE_LINK_SCHEMES)};`,
  `var ACCOUNT_SYNC_FAILED = ${JSON.stringify(ACCOUNT_SYNC_FAILED)};`,
].join('\n');

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeamRouter</title>
<link rel="icon" type="image/svg+xml" href="${logoDataUrl()}">
<style>
  /* Dark is the default, and stays the default for a viewer whose system says
     nothing. The light palette is applied two ways: by the media query when no
     choice has been stored (data-theme absent), and by the attribute when one
     has. The media rule excludes an explicit dark choice, so choosing dark on a
     light desktop is honoured rather than overridden by the system. */
  :root {
    color-scheme: dark;
    --bg: #0d1117; --side: #0a0e13; --panel: #151b23; --panel2: #1c2430; --line: #262f3b; --track: #252e3a;
    --text: #d7dde4; --dim: #8a949f; --accent: #53b1fd; --accent-bg: rgba(83,177,253,.12);
    --ok: #3fb950; --warn: #d29922; --bad: #f85149;
    --claude: #e0896a; --codex: #2bb88f; --grok: #6cb6c9; --backend: #a58bf0;
    /* Insights charts. Separate from the provider colours above, which are
       tuned for text and dots: a filled area needs a darker, validated step of
       the same hue, and a series palette whose neighbours stay apart for
       colour-blind readers. */
    --ip-claude: #d95926; --ip-codex: #199e70; --ip-grok: #2c8fa8; --ip-backend: #9085e9;
    --ik-cacheRead: #3987e5; --ik-cacheWrite: #c98500; --ik-input: #d55181; --ik-output: #008300;
    --is1: #3987e5; --is2: #d95926; --is3: #199e70; --is4: #c98500; --is5: #d55181; --is6: #008300; --is7: #9085e9; --is8: #e66767;
    --igrid: #222a35; --iaxis: #343e4b;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      color-scheme: light;
      --bg: #f6f8fa; --side: #ffffff; --panel: #ffffff; --panel2: #f3f5f8; --line: #d8dee4; --track: #e4e8ee;
      --text: #1f2328; --dim: #59636e; --accent: #0969da; --accent-bg: rgba(9,105,218,.10);
      --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e;
      --claude: #b8572f; --codex: #0b7d5f; --grok: #1f6f86; --backend: #7a52cc;
      --ip-claude: #eb6834; --ip-codex: #1baf7a; --ip-grok: #3aa3bd; --ip-backend: #6250d6;
      --ik-cacheRead: #2a78d6; --ik-cacheWrite: #eda100; --ik-input: #e87ba4; --ik-output: #008300;
      --is1: #2a78d6; --is2: #eb6834; --is3: #1baf7a; --is4: #eda100; --is5: #e87ba4; --is6: #008300; --is7: #6250d6; --is8: #e34948;
      --igrid: #eceef1; --iaxis: #c3c8cf;
    }
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #f6f8fa; --side: #ffffff; --panel: #ffffff; --panel2: #f3f5f8; --line: #d8dee4; --track: #e4e8ee;
    --text: #1f2328; --dim: #59636e; --accent: #0969da; --accent-bg: rgba(9,105,218,.10);
    --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e;
    --claude: #b8572f; --codex: #0b7d5f; --grok: #1f6f86; --backend: #7a52cc;
    --ip-claude: #eb6834; --ip-codex: #1baf7a; --ip-grok: #3aa3bd; --ip-backend: #6250d6;
    --ik-cacheRead: #2a78d6; --ik-cacheWrite: #eda100; --ik-input: #e87ba4; --ik-output: #008300;
    --is1: #2a78d6; --is2: #eb6834; --is3: #1baf7a; --is4: #eda100; --is5: #e87ba4; --is6: #008300; --is7: #6250d6; --is8: #e34948;
    --igrid: #eceef1; --iaxis: #c3c8cf;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  button { font: inherit; }
  .shell { display: grid; grid-template-columns: 228px minmax(0, 1fr); min-height: 100vh; }
  .side { background: var(--side); border-right: 1px solid var(--line); padding: 18px 12px; display: flex; flex-direction: column; gap: 2px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .brand { display: flex; align-items: center; gap: 9px; color: #ff1300; font: 700 15px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; padding: 0 10px 10px; }
  .brand svg { width: 20px; height: 20px; flex: none; }
  #nav { display: flex; flex-direction: column; gap: 2px; }
  .navsec { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); padding: 14px 10px 4px; }
  .navbtn { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; font-size: 13px; text-align: left; padding: 7px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dim); cursor: pointer; }
  .navbtn:hover { color: var(--text); background: var(--panel); }
  .navbtn.sel { color: var(--text); background: var(--accent-bg); box-shadow: inset 2px 0 0 var(--accent); }
  .count { font-size: 11px; line-height: 18px; min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--panel2); color: var(--dim); text-align: center; font-variant-numeric: tabular-nums; }
  .count.bad { background: var(--bad); color: #fff; }
  #instances { display: flex; flex-direction: column; gap: 4px; padding: 0 10px 6px; }
  #instances label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
  #instances select { width: 100%; font-size: 13px; }
  #instanceNote { font-size: 12px; margin: 8px 0; color: var(--dim); }
  .sidefoot { margin-top: auto; padding: 14px 10px 0; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: var(--dim); }
  .sidefoot button { text-align: left; }
  .content { padding: 22px 28px 40px; min-width: 0; }
  .wrap { max-width: 1260px; margin: 0 auto; }
  .top { margin-bottom: 14px; }
  h1 { font-size: 20px; line-height: 1.3; }
  h2 { font-size: 13px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 22px 0 8px; }
  .sub { color: var(--dim); margin-top: 2px; }
  .sub b { color: var(--text); font-weight: 600; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 16px; }
  .tab { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--dim); cursor: pointer; }
  .tab:hover { color: var(--text); }
  .tab.sel { color: var(--text); border-color: var(--accent); background: var(--accent-bg); }
  .sechead h2 { display: flex; align-items: center; gap: 8px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 540px), 1fr)); gap: 12px; margin-bottom: 8px; }
  .summary-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .scard { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .scard .k { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; margin-bottom: 8px; }
  .scard .k span + span { color: var(--dim); font-weight: 400; font-size: 12px; }
  .pool + .pool { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .pool .pl { font-size: 12px; color: var(--dim); }
  .pool .v { font-size: 24px; font-weight: 650; line-height: 1.25; margin: 2px 0 8px; font-variant-numeric: tabular-nums; }
  .pool .v small { font-size: 13px; color: var(--dim); font-weight: 400; }
  .pool.small .v { font-size: 16px; }
  .seg { display: flex; gap: 3px; height: 8px; }
  .seg span { flex: 1; background: var(--track); border-radius: 3px; overflow: hidden; }
  .seg i, .bar i { display: block; height: 100%; border-radius: 3px; background: var(--ok); }
  .seg i.warn, .bar i.warn { background: var(--warn); }
  .seg i.bad, .bar i.bad { background: var(--bad); }
  .scard .r { font-size: 12px; color: var(--dim); margin-top: 8px; }
  .scard .drain { font-size: 12px; color: var(--accent); margin-top: 8px; }
  .more { font-size: 12px; background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; }
  .sechead { display: flex; align-items: center; gap: 10px; margin: 22px 0 8px; }
  .sechead h2 { margin: 0; }
  .sechead .tag { margin-left: 2px; }
  .rows { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  .arow { display: grid; grid-template-columns: minmax(180px, 1.2fr) repeat(3, minmax(140px, 1fr)) 116px; gap: 8px 20px; align-items: start; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .arow:last-child { border-bottom: 0; }
  .who .name { font-weight: 600; overflow-wrap: anywhere; }
  .who .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .who .usage { margin-top: 6px; }
  .meter .mt { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; font-size: 12px; color: var(--dim); }
  .meter .mt b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .meter .mt b.warn { color: var(--warn); } .meter .mt b.bad { color: var(--bad); } .meter .mt b.ok { color: var(--ok); }
  .bar { height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; margin: 5px 0 4px; }
  .meter .rs { font-size: 11px; color: var(--dim); min-height: 16px; }
  .meter.none { color: var(--dim); font-size: 12px; opacity: .55; }
  .ctl { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
  .ctl .resets { font-size: 12px; color: var(--codex); text-align: center; align-self: center; }
  .ctl .resets.none { color: var(--dim); }
  .btn { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel2); color: var(--text); cursor: pointer; white-space: nowrap; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { color: #fff; filter: brightness(1.08); }
  .btn:disabled { opacity: .5; cursor: default; }
  .rowx { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px; }
  .rowx .more { align-self: flex-start; }
  .xmeters { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 220px)); gap: 8px 20px; margin-top: 4px; }
  .empty { color: var(--dim); padding: 18px 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin-bottom: 10px; }
  .row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .tag { font-size: 12px; color: var(--dim); }
  .badge { font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
  .badge.active { color: var(--ok); border-color: var(--ok); }
  .badge.throttled, .badge.cordoned { color: var(--warn); border-color: var(--warn); }
  .badge.error, .badge.exhausted, .badge.disabled { color: var(--bad); border-color: var(--bad); }
  .badge.current, .badge.drain { color: var(--accent); border-color: var(--accent); }
  .badge.plan { color: var(--text); background: var(--panel2); }
  .badge.provider { color: var(--text); }
  .badge.provider.anthropic { color: var(--claude); border-color: var(--claude); }
  .badge.provider.codex { color: var(--codex); border-color: var(--codex); }
  .badge.provider.grok { color: var(--grok); border-color: var(--grok); }
  /* One colour per provider family (providerTone), on its dot, its section
     and its sign-in button, so a Claude login and a ChatGPT one never look alike. */
  .pdot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; background: var(--backend); }
  .pdot.claude { background: var(--claude); } .pdot.codex { background: var(--codex); } .pdot.grok { background: var(--grok); }
  .rows.claude, .pcard.claude { border-left: 3px solid var(--claude); }
  .rows.codex, .pcard.codex { border-left: 3px solid var(--codex); }
  .rows.grok, .pcard.grok { border-left: 3px solid var(--grok); }
  .rows.backend, .pcard.backend { border-left: 3px solid var(--backend); }
  .btn.claude { color: var(--claude); border-color: var(--claude); background: color-mix(in srgb, var(--claude) 12%, transparent); }
  .btn.codex { color: var(--codex); border-color: var(--codex); background: color-mix(in srgb, var(--codex) 12%, transparent); }
  .btn.grok { color: var(--grok); border-color: var(--grok); background: color-mix(in srgb, var(--grok) 12%, transparent); }
  .btn.claude:hover, .btn.codex:hover, .btn.grok:hover { filter: brightness(1.15); }
  .btn.claude:hover { color: var(--claude); border-color: var(--claude); } .btn.codex:hover { color: var(--codex); border-color: var(--codex); }
  .btn.grok:hover { color: var(--grok); border-color: var(--grok); }
  .btn.rm { min-width: 112px; }
  .btn.danger { color: var(--bad); border-color: var(--bad); }
  .btn.danger:hover { color: #fff; background: var(--bad); border-color: var(--bad); }
  .addbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 14px; }
  .addbar .lbl { color: var(--dim); font-size: 13px; margin-right: 2px; }
  .addbar .btn { font-size: 13px; padding: 6px 14px; display: inline-flex; align-items: center; gap: 8px; }
  /* The table is wider than a phone; it scrolls inside its card rather than
     running past the card's edge with the row's buttons out of reach. */
  .pcard { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 4px 6px; margin-bottom: 18px; overflow-x: auto; }
  .phead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 22px 0 8px; }
  .phead h2 { margin: 0; display: flex; align-items: center; gap: 8px; }
  .phead .tag { flex: 1 1 200px; }
  .signin { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 0 0 16px; }
  .signin.claude { border-color: var(--claude); } .signin.codex { border-color: var(--codex); } .signin.grok { border-color: var(--grok); }
  .signin .code { font: 600 18px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 2px; }
  .signin .sh { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 10px; }
  .signin .sh .sp { flex: 1; }
  .signin ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 10px; }
  .signin .line { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
  .signin input { flex: 1 1 260px; min-width: 0; font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  .signin a.btn { text-decoration: none; display: inline-block; }
  .signin .st { font-size: 12px; color: var(--dim); margin-top: 10px; }
  .signin .st.ok { color: var(--ok); } .signin .st.warn { color: var(--warn); } .signin .st.error { color: var(--bad); }
  .ckeys .ckh { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .ckeys .ckh .hint { margin-left: 0; }
  .ckeys form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0; }
  .ckeys input, .ckeys textarea { flex: 1 1 260px; min-width: 0; font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  .ckeys textarea { width: 100%; box-sizing: border-box; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
  .ckeys .issued { border: 1px solid var(--accent); border-radius: 8px; padding: 10px 12px; margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .ckeys .issued .line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .ckeys .issued .lbl { font-size: 12px; color: var(--dim); margin-top: 4px; }
  .ckeys .st { font-size: 12px; color: var(--dim); }
  .ckeys .st.ok { color: var(--ok); } .ckeys .st.warn { color: var(--warn); } .ckeys .st.error { color: var(--bad); }
  .ckeys table { margin-top: 8px; }
  /* Show details and Revoke stack on a phone; keep them apart there too. */
  .ckeys td .btn + .btn { margin-top: 4px; }
  .connect .crow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 0; border-top: 1px solid var(--line); }
  .connect .crow .who { flex: 1 1 220px; min-width: 0; }
  .connect .crow .hint { display: block; margin: 2px 0 0; overflow-wrap: anywhere; }
  .connect .cfoot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
  /* The Linked instances card reuses the client-key look, with its form as labelled rows. */
  .links { margin-top: 16px; }
  .links form, #linkBackFields { display: flex; flex-direction: column; flex-wrap: nowrap; align-items: stretch; gap: 6px; }
  .links form { margin-top: 12px; }
  .links .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .links .row > label { flex: 0 0 200px; font-size: 12px; color: var(--dim); }
  .links .row > .btn { flex: none; }
  /* An address has no spaces to break at; on a phone it would push Remove off the card. */
  .links td.addr { word-break: break-all; }
  .links td .btn + .btn { margin-top: 4px; }
  .links .check { display: flex; gap: 8px; align-items: center; font-size: 12px; margin-top: 4px; }
  .links .check input { flex: none; margin: 0; }
  .links .sub2 { font-size: 12px; font-weight: 600; margin-top: 4px; }
  .links .syncline { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-top: 10px; }
  .links .syncline .when { font-size: 12px; color: var(--dim); }
  .links .row.acts { margin-top: 10px; }
  .links ol { margin: 6px 0 0; padding-left: 20px; font-size: 13px; }
  .links ol li + li { margin-top: 6px; }
  .links .issued .line input { flex: 1 1 220px; min-width: 0; }
  .links td.sync .btn { margin-left: 6px; }
  /* The store of your own instances, under the callback.net controls. */
  .links .ownsync { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
  .links .ownsync .hint { margin: 4px 0 0; }
  .links .ownsync .cluster { margin-top: 12px; }
  .links .ownsync .cluster input { flex: 1 1 220px; min-width: 0; font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  .links ul.members { list-style: none; margin: 8px 0 0; padding: 0; font-size: 12px; }
  .links ul.members li { padding: 2px 0; }
  .links .ownsync select { flex: 0 1 220px; min-width: 0; font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  .links .own { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 12px; color: var(--dim); }
  .badge.meta { color: var(--dim); }
  .badge.sessions { color: var(--text); }
  .badge.sessions.known { color: var(--dim); }
  .badge.extra-usage { color: var(--warn); border-color: var(--warn); }
  .badge.extra-usage.billing { color: var(--bad); border-color: var(--bad); }
  .badge.model { color: var(--accent); border-color: var(--accent); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 10px; font-variant-numeric: tabular-nums; vertical-align: top; }
  th { color: var(--dim); font-size: 12px; font-weight: 500; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; }
  td .btn + .btn { margin-left: 6px; }
  .usage { color: var(--dim); font-size: 12px; }
  .blocked { color: var(--warn); font-size: 12px; }
  #note { font-size: 12px; margin: 8px 0; display: none; }
  #note.ok, .cardnote.ok { color: var(--ok); } #note.warn, .cardnote.warn { color: var(--warn); } #note.error, .cardnote.error { color: var(--bad); }
  .cardnote { font-size: 12px; }
  #caller { font-size: 12px; margin: 8px 0; color: var(--dim); }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .filters label { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  select { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; font-size: 12px; padding: 4px 8px; }
  .hint { color: var(--dim); font-size: 12px; margin-left: auto; }
  p.hint { margin: 8px 0 0; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0 16px; }
  .actions button, .chip { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--dim); cursor: pointer; }
  .actions button:hover, .chip:hover { color: var(--text); border-color: var(--text); }
  .actions button:disabled { opacity: .5; cursor: default; }
  .actions button.sel, .chip.sel { color: var(--text); border-color: var(--accent); background: var(--accent-bg); }
  .actions .lbl { color: var(--dim); font-size: 12px; }
  .thr { display: flex; align-items: center; gap: 6px; font-size: 13px; max-width: 100%; }
  .thr input { width: 80px; font: inherit; font-size: 13px; padding: 4px 8px; text-align: right; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  .thr input.name { width: 170px; text-align: left; }
  .thr input.addr { width: 220px; min-width: 0; flex: 0 1 auto; text-align: left; }
  .setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .setting + .setting { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .setting .tag { display: block; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text); }
  td.dim { color: var(--dim); }
  .ok { color: var(--ok); }
  .no { color: var(--dim); text-decoration: line-through; }
  .pin { color: var(--accent); font-size: 12px; }
  .warnt { color: var(--warn); font-size: 12px; }
  .badt { color: var(--bad); }
  .logbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
  .logbar label { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  td.when { color: var(--dim); white-space: nowrap; font-size: 12px; }
  td.kind { white-space: nowrap; font-size: 12px; color: var(--dim); }
  tr.bad td.ev { color: var(--bad); } tr.warn td.ev { color: var(--warn); } tr.ok td.ev { color: var(--ok); }
  td.detail { color: var(--dim); font-size: 12px; }
  td.client { color: var(--dim); font-size: 12px; }
  td.ev .prompt { color: var(--dim); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
  .plist div { border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; font-size: 13px; }
  .plist .bad { background: rgba(248,81,73,.12); border: 1px solid var(--bad); color: var(--bad); }
  .plist .warn { background: rgba(210,153,34,.12); border: 1px solid var(--warn); color: var(--warn); }
  .plist .ok { background: rgba(63,185,80,.12); border: 1px solid var(--ok); color: var(--ok); }
  #resetAlerts div { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  #resetAlerts button { flex: none; }
  #err { color: var(--bad); margin: 12px 0; display: none; }
  #problems { display: none; margin: 0 0 16px; }
  #keybox { display: none; margin: 80px auto; max-width: 420px; text-align: center; padding: 0 16px; }
  #keybox input { width: 100%; padding: 10px 12px; margin: 12px 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; }
  #keybox button { padding: 8px 20px; background: var(--accent); border: 0; border-radius: 6px; color: #fff; font-weight: 600; cursor: pointer; }
  #keybox input + input { margin-top: 0; }
  #keybox .or { margin: 28px 0 4px; color: var(--dim); font-size: 13px; }
  #keybox .hint { color: var(--dim); font-size: 13px; margin: 0 0 16px; }
  #keybox .kerr { color: var(--bad); font-size: 13px; min-height: 1.4em; margin: 8px 0 0; }
  .thr input.pw { width: 150px; min-width: 0; text-align: left; }
  #pwSetForm { flex-wrap: wrap; }
  .insbar { display: flex; gap: 8px 14px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  .insbar .lbl { color: var(--dim); font-size: 12px; }
  .insbar .insscope { display: flex; gap: 8px 14px; align-items: center; }
  /* Insights is built around two numbers, the estimated API cost and the
     tokens: a hero card whose headlines are also the tabs that pick which of
     the two every chart on the page draws, then the same number by calendar
     day, by month and by where it went. A dashed edge means projected
     throughout, on the pace headline and on the month bars alike. */
  #insBody { display: flex; flex-direction: column; gap: 12px; margin-bottom: 12px; }
  #insBody .card { margin-bottom: 0; min-width: 0; }
  #insBody > .sub { margin: -4px 0 0; }
  .insgrid { display: grid; gap: 12px; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
  .insgrid.one { grid-template-columns: minmax(0, 1fr); }
  .inshero { padding: 0; overflow: hidden; }
  .insheads { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-bottom: 1px solid var(--line); }
  .inshead { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; min-width: 0; text-align: left; padding: 16px 20px 14px; border: 0; border-right: 1px solid var(--line); background: transparent; color: var(--text); font: inherit; }
  .inshead:last-child { border-right: 0; }
  button.inshead { cursor: pointer; }
  button.inshead:hover { background: var(--panel2); }
  button.inshead:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  /* The chosen headline: a bar in its metric's colour along the top, and a
     wash of it fading down, so the tab and the chart under it read as one. */
  .inshead::before, .inshead::after { content: ''; position: absolute; left: 0; right: 0; top: 0; pointer-events: none; opacity: 0; background: var(--hc, var(--accent)); }
  .inshead::before { height: 3px; }
  .inshead::after { bottom: 0; background: linear-gradient(180deg, var(--hc, var(--accent)), transparent 75%); }
  .inshead.sel::before { opacity: 1; }
  .inshead.sel::after { opacity: .09; }
  .inshead .l { display: flex; align-items: center; gap: 6px; color: var(--dim); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; }
  .inshead .l i { width: 8px; height: 8px; border-radius: 2px; background: var(--hc, var(--dim)); }
  .inshead .v { font-size: 38px; font-weight: 700; letter-spacing: -.03em; line-height: 1.1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .inshead .d { color: var(--dim); font-size: 12px; }
  .inshead .n { color: var(--dim); font-size: 11.5px; opacity: .85; }
  .inspill { display: inline-block; font-weight: 650; color: var(--text); background: var(--panel2); border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; margin-right: 6px; font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .insproj { font-size: 10px; font-weight: 500; letter-spacing: .03em; text-transform: none; border: 1px dashed var(--dim); border-radius: 999px; padding: 0 6px; }
  .inspace .v { color: var(--dim); }
  .insherob { padding: 14px 16px 10px; }
  .insh { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
  .insh b { font-size: 13.5px; }
  .insh .s { display: block; color: var(--dim); font-size: 12px; }
  .instools { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .inseg { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; background: var(--panel2); }
  .inseg button { border: 0; background: transparent; color: var(--dim); font-size: 12px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
  .inseg button + button { border-left: 1px solid var(--line); }
  .inseg button.sel { background: var(--accent-bg); color: var(--text); }
  .inseg button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  svg.inschart { display: block; overflow: visible; touch-action: pan-y; }
  svg.inschart text { fill: var(--dim); font-size: 11px; font-variant-numeric: tabular-nums; }
  /* A reference line's label sits on the bars it crosses: a halo in the card's colour keeps it legible. */
  svg.inschart text.insref { font-size: 10.5px; paint-order: stroke; stroke: var(--panel); stroke-width: 3px; stroke-linejoin: round; }
  .insnow { opacity: .5; }
  /* The busiest bucket's label reads as data, not as a note. */
  svg.inschart text.inspeak { fill: var(--text); font-weight: 600; font-size: 11px; }
  .insshort { margin: 0; }
  .insw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .insl { display: inline-block; width: 14px; height: 3px; border-radius: 2px; margin-right: 8px; vertical-align: 3px; }
  .inslegw { overflow-x: auto; margin-top: 8px; }
  .inslegt { width: 100%; max-width: 760px; border-collapse: collapse; font-size: 12.5px; }
  .inslegt th { color: var(--dim); font-weight: 500; font-size: 11.5px; text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); }
  .inslegt td { padding: 4px 8px; border-bottom: 1px solid var(--igrid); white-space: nowrap; }
  .inslegt .num { text-align: right; font-variant-numeric: tabular-nums; }
  .inslegt tr.tog { cursor: pointer; }
  .inslegt tr.tog:hover td { background: var(--panel2); }
  .inslegb { display: inline-flex; align-items: center; border: 0; background: none; color: inherit; font: inherit; padding: 0; cursor: inherit; text-align: left; }
  .inslegb:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
  .inslegt tr.off td { opacity: .45; }
  .inslegt tr.off .insl { background: var(--dim) !important; }
  /* The calendar: the grid, and each weekday's average full day beside it. */
  .inscal { display: flex; gap: 14px 22px; flex-wrap: wrap; align-items: flex-start; }
  /* The calendar's three lower strengths of the metric's colour (the top is
     solid). Dark is the default theme, and on its dark idle squares the
     faintest needs more colour to stand apart from them. */
  .inscal, .inskey { --ish1: .42; --ish2: .6; --ish3: .8; }
  @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) .inscal, :root:not([data-theme="dark"]) .inskey { --ish1: .22; --ish2: .45; --ish3: .7; } }
  :root[data-theme="light"] .inscal, :root[data-theme="light"] .inskey { --ish1: .22; --ish2: .45; --ish3: .7; }
  .inscal svg rect.day { cursor: default; }
  .inswk { display: grid; grid-template-columns: auto minmax(60px, 1fr) auto; gap: 3px 8px; align-items: center; font-size: 11.5px; flex: 1 1 180px; min-width: 0; max-width: 300px; }
  .inswk .k { color: var(--dim); }
  .inswk .t { height: 8px; background: var(--track); border-radius: 4px; overflow: hidden; }
  .inswk .t i { display: block; height: 100%; border-radius: 4px; }
  .inswk .x { text-align: right; font-variant-numeric: tabular-nums; }
  .inswk .h { grid-column: 1 / -1; color: var(--dim); font-size: 11px; margin-bottom: 2px; }
  .inskey { display: flex; align-items: center; gap: 3px; color: var(--dim); font-size: 11px; margin-top: 8px; flex-wrap: wrap; }
  .inskey i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
  .inskey i.nr { border: 1px dashed var(--iaxis); }
  .inskey span { margin: 0 4px; }
  /* Where it went: a ranked row per model, account, provider or machine. */
  .insrank { display: grid; grid-template-columns: minmax(110px, 26%) minmax(0, 1fr) 84px minmax(0, 170px); grid-template-areas: 'n b v a'; gap: 3px 12px; align-items: center; padding: 6px 2px; border-bottom: 1px solid var(--igrid); font-size: 12.5px; }
  .insrank:last-child { border-bottom: 0; }
  .insrank .n { grid-area: n; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .insrank .n > span { min-width: 0; }
  .insrank .n b { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .insrank .n small { display: block; color: var(--dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .insrank .n i { flex: none; width: 4px; align-self: stretch; border-radius: 2px; }
  .insrank .t { grid-area: b; height: 10px; background: var(--track); border-radius: 5px; overflow: hidden; }
  .insrank .sp { grid-area: b; min-width: 0; height: 26px; }
  .insrank .sp svg { display: block; }
  .insrank .t i { display: block; height: 100%; border-radius: 5px; }
  .insrank .v { grid-area: v; text-align: right; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .insrank .a { grid-area: a; text-align: right; color: var(--dim); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .insrank.np .v { color: var(--dim); font-weight: 500; }
  .instip { position: fixed; z-index: 50; pointer-events: none; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 6px 20px rgba(0,0,0,.25); min-width: 150px; max-width: 300px; }
  .instip .tt { font-weight: 600; margin-bottom: 4px; }
  .instip .insrow { display: flex; justify-content: space-between; gap: 14px; font-variant-numeric: tabular-nums; }
  .instip .insrow span:first-child { color: var(--dim); }
  .instip .insrow.sum { border-top: 1px solid var(--line); margin-top: 3px; padding-top: 3px; font-weight: 600; }
  .instip .insrow.why { display: block; color: var(--dim); font-size: 11px; margin-top: 4px; white-space: normal; }
  .instv { max-height: 320px; overflow: auto; }
  @media (max-width: 1080px) {
    .insgrid { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 760px) {
    .insheads { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .inshead:nth-child(2) { border-right: 0; }
    .inspace { grid-column: 1 / -1; border-top: 1px solid var(--line); }
    .inshead .v { font-size: 30px; }
  }
  @media (max-width: 560px) {
    .inshead { padding: 12px 14px 10px; }
    .inshead .v { font-size: 25px; }
    .insherob { padding: 12px 12px 8px; }
    .insh { flex-wrap: wrap; }
    .inslegt .opt { display: none; }
    .insrank { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'n v' 'b b'; }
    .insrank .a { display: none; }
    /* A row with no price has no bar to draw: its token count takes the line
       instead, so "not priced" never stands alone. */
    .insrank.np { grid-template-areas: 'n v' 'a a'; }
    .insrank.np .t { display: none; }
    .insrank.np .a { display: block; text-align: left; }
  }
  @media (max-width: 1080px) {
    .arow { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .who, .ctl { grid-column: 1 / -1; }
    .ctl { flex-direction: row; flex-wrap: wrap; }
  }
  @media (max-width: 760px) {
    .summary-pair { grid-template-columns: 1fr; }
    .shell { grid-template-columns: 1fr; }
    .side { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 12px; }
    #nav { flex-direction: row; flex-wrap: wrap; }
    .navbtn { width: auto; }
    .navsec { display: none; }
    .sidefoot { flex-direction: row; flex-wrap: wrap; align-items: center; margin-top: 8px; padding-top: 8px; }
    .content { padding: 16px; }
    .arow { grid-template-columns: 1fr; }
    /* The Account sync column has to fit beside the others on a phone. */
    .links td.sync .btn { display: block; margin: 4px 0 0; }
    .links td .btn.rm { min-width: 0; }
    #linkList th, #linkList td { padding-left: 5px; padding-right: 5px; }
  }
</style>
<script>
(function () {
  try {
    var t = localStorage.getItem('teamclaude-dashboard-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage disabled: the media query still decides */ }
})();
</script>
</head>
<body>
<div id="keybox">
  <h1>TeamRouter</h1>
  <form id="pwForm" style="display:none">
    <p class="sub">Sign in to view status.</p>
    <input id="pwUser" placeholder="Username" autocomplete="username" spellcheck="false" autocapitalize="off">
    <input id="pwPass" type="password" placeholder="Password" autocomplete="current-password">
    <button id="pwGo" type="submit">Sign in</button>
    <p id="pwErr" class="kerr"></p>
    <p class="or">Or enter the proxy key.</p>
  </form>
  <p id="pwHere" class="hint" style="display:none">Password sign-in works only at this proxy's own address: its IP address, or the Instance address set on its Settings page.</p>
  <p class="sub" id="keySub">Enter your proxy key to view status.</p>
  <input id="key" type="password" placeholder="tc-..." autocomplete="off">
  <br><button id="go">Connect</button>
</div>
<div id="app" class="shell" style="display:none">
  <aside class="side">
    <div class="brand">${logoMarkup()}TeamRouter</div>
    <div id="instances" style="display:none">
      <label for="instance">Instance</label>
      <select id="instance"></select>
    </div>
    <nav id="nav"></nav>
    <div class="sidefoot">
      <button id="theme" class="more" type="button" title="Switch between following the system, light and dark"></button>
      <span id="foot"></span>
    </div>
  </aside>
  <main class="content">
  <div class="wrap">
    <div class="top">
      <h1 id="pageTitle">Quota</h1>
      <p class="sub" id="summary"></p>
    </div>
    <div id="err"></div>
    <div id="problems" class="plist"></div>
    <div id="note"></div>
    <div id="instanceNote" style="display:none"><span id="instanceText"></span> <button id="instanceBack" class="more" type="button">Back to this machine</button></div>
    <div id="caller" style="display:none"><span id="callerText"></span> <button id="changeKey" class="more" type="button">Change key</button></div>

    <section id="page-quota">
      <div id="tabs" class="tabs"></div>
      <div id="resetAlerts" class="plist"></div>
      <div id="summaryCards" class="cards"></div>
      <div id="quotaVisibility" class="filters"></div>
      <div id="accounts"></div>
    </section>

    <section id="page-sessions" style="display:none">
      <p class="sub" id="sessionsEmpty" style="display:none"></p>
      <div id="sessionsWrap" style="display:none">
        <div class="card" style="padding:0">
          <div class="filters">
            <label>Project <select id="fProject"></select></label>
            <label>Client <select id="fClient"></select></label>
            <span class="hint" id="sessionCount"></span>
          </div>
          <div style="padding:4px 6px"><table id="sessions"></table></div>
        </div>
      </div>
    </section>

    <section id="page-clients" style="display:none">
      <div id="connectCard" class="card ckeys connect" style="display:none">
        <div class="ckh"><b>Connect your tools</b><span class="hint">Points Claude Code, the Codex CLI and Grok Build on this machine at this proxy, by writing their settings for you.</span></div>
        <div id="connectRows"></div>
        <div class="cfoot"><button id="connectAll" class="btn primary" type="button">Connect all</button><span id="connectStatus" class="st" style="display:none"></span></div>
      </div>
      <div id="clientKeys" class="card ckeys" style="display:none">
        <div class="ckh"><b>Client keys</b><span class="hint">One per machine or agent of yours. Requests made with a key are counted here under its name.</span></div>
        <form id="ckForm" autocomplete="off">
          <input id="ckName" maxlength="64" placeholder="Name, e.g. laptop or ci-agent" aria-label="Client key name">
          <button id="ckCreate" class="btn primary" type="submit">Generate key</button>
        </form>
        <div id="ckStatus" class="st" style="display:none"></div>
        <div id="ckIssued" class="issued" style="display:none"></div>
        <table id="ckList"></table>
      </div>
      <p class="sub" id="clientsEmpty" style="display:none">No client usage yet. Requests made with a client key are counted here under the key's name, and per configured usage dimension (proxy.usageDimensions).</p>
      <div id="usageViewWrap" class="actions" style="display:none"></div>
      <div id="clientsWrap" style="display:none">
        <h2 id="clientsHeading">Clients</h2>
        <div class="card" style="padding:4px 6px"><table id="clients"></table></div>
      </div>
      <div id="dimensionsWrap"></div>
    </section>

    <section id="page-insights" style="display:none">
      <div class="insbar">
        <span id="insScopeWrap" class="insscope" style="display:none"><span class="lbl">Machines</span><div id="insScope" class="chips"></div></span>
        <span class="lbl">Range</span><div id="insRange" class="chips"></div>
        <span class="lbl">Split by</span><div id="insSplit" class="chips"></div>
      </div>
      <p class="sub" id="insNote" style="display:none"></p>
      <div id="insBody"></div>
      <p class="hint">The API cost is an estimate: what these tokens would cost at the providers' list prices, with cache writes at the 5-minute rate. Third-party backends and unknown models are not priced. Anything marked projected, or drawn with a dashed edge, is a projection from recent full days, not a measurement. Tokens include cache reads and writes. Days follow each proxy's clock; a year of days and the last 48 hours are kept in its state file.</p>
    </section>

    <section id="page-accounts" style="display:none">
      <div id="addBar" class="addbar"></div>
      <div id="signIn" class="signin" style="display:none"></div>
      <div id="accountGroups"></div>
    </section>

    <section id="page-logs" style="display:none">
      <div class="logbar">
        <div id="logKinds" class="chips"></div>
        <label>Provider <select id="logProvider"></select></label>
        <label>Account <select id="logAccount"></select></label>
        <span class="hint" id="logCount"></span>
      </div>
      <div class="card" style="padding:4px 6px"><table id="logs"></table></div>
      <p class="hint">Requests, sign-ins, sign-outs, rotation, changes and Codex reset credits, newest first. Kept in the proxy's memory (the last ${EVENT_LOG_CAPACITY} events); a restart starts a fresh log.</p>
    </section>

    <section id="page-problems" style="display:none">
      <div id="problemList" class="plist"></div>
    </section>

    <section id="page-routing" style="display:none">
      <div class="card" id="modeCard"></div>
      <div id="routesWrap" style="display:none">
        <h2>Routes</h2>
        <div class="card" style="padding:4px 6px"><table id="routes"></table></div>
      </div>
    </section>

    <section id="page-settings" style="display:none">
      <div class="card">
        <div class="setting" id="nameRow" style="display:none">
          <div><b>Instance name</b><span class="tag">What the Instance picker calls this machine. Empty uses the host name. Saved to the config file.</span></div>
          <span class="thr">
            <label for="nameVal">Name</label>
            <input id="nameVal" class="name" maxlength="64" spellcheck="false" autocomplete="off">
            <button id="nameSet" class="btn" type="button">Save</button>
          </span>
        </div>
        <div class="setting" id="addrRow" style="display:none">
          <div><b>Instance address</b><span class="tag">The address the link gives other machines. Set it in a Docker container. Empty uses a guess.</span></div>
          <span class="thr">
            <label for="addrVal">Address</label>
            <input id="addrVal" class="addr" spellcheck="false" autocomplete="off" placeholder="http://100.64.0.2:3456">
            <button id="addrSet" class="btn" type="button">Save</button>
          </span>
        </div>
        <div class="setting">
          <div><b>Switch threshold</b><span class="tag">The share of a quota window at which rotation leaves an account. Saved to the config file.</span></div>
          <span class="thr">
            <label for="thrVal">Switch at</label>
            <input id="thrVal" type="number" min="1" max="100" step="0.1" inputmode="decimal">
            <span>%</span>
            <button id="thrSet" class="btn" type="button">Set</button>
          </span>
        </div>
        <div class="setting">
          <div><b>Config</b><span class="tag">Re-read the config file, as after a hand edit or a sign-in in another terminal.</span></div>
          <button id="reload" class="btn" type="button">Reload config</button>
        </div>
        <div class="setting">
          <div><b>Quota refresh</b><span class="tag">How often the proxy re-reads every account's quota in the background. Saved to the config file.</span></div>
          <span class="thr">
            <label for="probeEvery">Refresh</label>
            <select id="probeEvery"></select>
          </span>
        </div>
        <div class="setting" id="ospRow" style="display:none">
          <div><b>Outside spend</b><span class="tag">Hide an account's "outside" share when it is at or below this. 0 shows every share. Saved to the config file.</span></div>
          <span class="thr">
            <label for="ospVal">Hide at or below</label>
            <input id="ospVal" type="number" min="0" max="100" step="0.1" inputmode="decimal">
            <span>%</span>
            <button id="ospSet" class="btn" type="button">Set</button>
          </span>
        </div>
        <div class="setting">
          <div><b>Quota</b><span class="tag">Read every account's quota now. Zero-spend: it asks the usage endpoints, not the model.</span></div>
          <button id="probe" class="btn" type="button">Probe quotas</button>
        </div>
        <div class="setting" id="pwRow" style="display:none">
          <div><b>Dashboard password</b><span class="tag" id="pwTag">Sign in from another machine with a username and password instead of the proxy key. Saved to the config file as a hash.</span></div>
          <form class="thr" id="pwSetForm">
            <input id="pwSetUser" class="pw" placeholder="Username" maxlength="64" spellcheck="false" autocomplete="username" autocapitalize="off" aria-label="Username">
            <input id="pwSetPass" class="pw" type="password" placeholder="New password" autocomplete="new-password" aria-label="New password">
            <button id="pwSet" class="btn" type="submit">Save</button>
            <button id="pwOff" class="btn" type="button" style="display:none">Turn off</button>
          </form>
        </div>
        <div class="setting">
          <div><b>Proxy key</b><span class="tag">Forget the key this browser stored and enter another.</span></div>
          <button id="forgetKey" class="btn" type="button">Change key</button>
        </div>
      </div>
      <div id="acctSync" class="card ckeys links" style="display:none">
        <div class="ckh"><b>Account sync</b><span class="hint">Share Claude, Codex and Grok sign-ins between your own machines: an account signed in on one is then signed in on all of them, and they take turns renewing it so none signs another out. Either one of your machines keeps the sign-ins for the others, or they go through your callback.net account.</span></div>
        <div id="syncBody"></div>
        <div id="syncSignIn"></div>
        <p class="hint" id="syncHint"></p>
      </div>
      <div id="links" class="card ckeys links" style="display:none">
        <div class="ckh"><b>Linked instances</b><span class="hint">TeamClaude on your other machines. Each one linked here is in the Instance picker at the top of the sidebar, where every page shows that machine.</span></div>
        <table id="linkList"></table>
        <p class="hint" id="linkEmpty" style="display:none">No machine is linked yet.</p>
        <p class="st warn" id="linkUnsupported" style="display:none">This instance runs a version that cannot be linked from the dashboard. Update it to manage its links here.</p>
        <form id="linkForm" autocomplete="off">
          <div class="sub2">Link another machine</div>
          <div class="row"><label for="linkPaste">Its link</label><input id="linkPaste" type="password" placeholder="From its dashboard: Settings, Linked instances, Show key, Copy link" spellcheck="false"></div>
          <div class="row"><label for="linkUrl">Its address</label><input id="linkUrl" placeholder="http://100.64.0.2:3456" spellcheck="false"></div>
          <div class="row"><label for="linkKey">Its proxy key</label><input id="linkKey" type="password" placeholder="From its dashboard: Settings, Linked instances, Show key" spellcheck="false"><button id="linkTest" class="btn" type="button">Test</button></div>
          <div class="row"><label for="linkName">Name it</label><input id="linkName" maxlength="64" placeholder="e.g. desktop" spellcheck="false"></div>
          <label class="check"><input id="linkBack" type="checkbox" checked><span id="linkBackText">Link back too: list this machine on it, so its dashboard shows this one</span></label>
          <div id="linkBackFields">
            <div class="row"><label for="linkSelfUrl" id="linkSelfUrlLabel">This machine, as it reaches it</label><input id="linkSelfUrl" list="linkSelfUrls" placeholder="http://100.64.0.1:3456" spellcheck="false"><datalist id="linkSelfUrls"></datalist></div>
            <div class="row"><label for="linkSelfName" id="linkSelfNameLabel">Name for this machine there</label><input id="linkSelfName" maxlength="64" spellcheck="false"></div>
          </div>
          <div id="linkBackBlocked" class="st warn" style="display:none"></div>
          <div class="row"><button id="linkAdd" class="btn primary" type="submit">Link</button><span id="linkStatus" class="st"></span></div>
        </form>
        <div class="own" id="ownKey"><span id="ownKeyLabel">This machine's link, or its proxy key and address, for linking it from another machine's dashboard.</span><button id="ownKeyShow" class="btn" type="button">Show key</button></div>
        <div id="ownKeyBox" class="issued" style="display:none"></div>
      </div>
    </section>
  </div>
  </main>
</div>
<script>
(function () {
  'use strict';
  var KEY = 'teamclaude-dashboard-key';
  var THEME_KEY = 'teamclaude-dashboard-theme';
  var POLL_MS = 5000;
  var timer = null;
  var lastStatus = null;
  var sessionFilters = { project: '', client: '' };
  var sortState = { sessions: { key: 'lastSeen', dir: 'desc' } };
  // The usage window applies to every table the usage trackers feed (Clients
  // and each configured dimension), so it is page state rather than per-table:
  // two controls left on different windows would invite reading one table's
  // number against the other's. Like the sort, it survives the poll.
  var usageView = 'total';
  var usageButtons = [];
  var UNAVAILABLE_TEXT = ${JSON.stringify(UNAVAILABLE_TEXT)};

  // The sidebar, in the order an operator reaches for things. Every page is
  // rendered on each poll and only shown or hidden, so switching pages never
  // waits on the network and a page left open keeps up with the fleet.
  var PAGES = [
    { key: 'quota', label: 'Quota', section: 'Overview' },
    { key: 'sessions', label: 'Sessions', section: 'Overview' },
    { key: 'clients', label: 'Clients', section: 'Overview' },
    { key: 'insights', label: 'Insights', section: 'Overview' },
    { key: 'accounts', label: 'Accounts', section: 'Accounts' },
    { key: 'logs', label: 'Logs', section: 'Observe' },
    { key: 'problems', label: 'Problems', section: 'Observe' },
    { key: 'routing', label: 'Routing', section: 'Control' },
    { key: 'settings', label: 'Settings', section: 'Control' },
  ];
  var currentPage = 'quota';
  // The linked instance this page shows (peers.js), or '' for the machine it
  // was opened on. Every request goes through at(), so each page, button and
  // sign-in acts on the instance shown. Switching reloads the page: nothing
  // one instance's page holds (its logs, its notes) carries over to another.
  var INSTANCE = 'teamclaude-dashboard-instance';
  var peer = localStorage.getItem(INSTANCE) || '';
  var peerUrl = '';
  // Whether this machine has let the page's key reach the linked instance yet.
  // Nothing is relayed before it has: the relay's 403 for a client key would
  // read as a bad key and throw a valid one away.
  var peerChecked = false;
  function at(url) {
    return peer ? '/teamclaude/peers/' + encodeURIComponent(peer) + url.slice('/teamclaude'.length) : url;
  }
  function pickInstance(name) {
    if (name) localStorage.setItem(INSTANCE, name); else localStorage.removeItem(INSTANCE);
    peer = name;
    if (typeof location !== 'undefined') location.reload();
  }
  var navButtons = {};
  var navCounts = {};
  // Which provider tab the quota page is showing; kept across polls.
  var currentTab = 'all';
  var showAllAccounts = false;
  // Open "Show" expanders, by card or row. No prototype: an account named
  // __proto__ would otherwise set it.
  var expanded = Object.create(null);
  // The Logs page's copy of the proxy's event log, fetched only while the page
  // is open, so a dashboard left on Quota costs the server one request a poll.
  var logState = { generation: null, events: [] };
  var logFilters = { kind: 'all', provider: '', account: '' };
  var logChips = [];
  var logError = null;
  var logsInFlight = false;

${SHARED_CONSTS}

${SHARED_HELPERS}

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(cls, text, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  // Status timestamps arrive in both shapes: epoch milliseconds (account
  // quota resets, account usage.lastUsed) and ISO strings (client lastUsed).
  // Date.parse() only handles strings, so numbers must pass through as-is —
  // feeding it a number silently yields NaN and the field just never renders.
  function parseTs(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    return Date.parse(v);
  }

  function fmtAgo(ts) {
    var t = parseTs(ts);
    if (isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function fmtIn(sec) {
    if (sec == null) return '';
    var s = Math.max(0, Math.round(sec));
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return (s / 3600).toFixed(1) + 'h';
    return (s / 86400).toFixed(1) + 'd';
  }

  // How long until a reset, the way the rows say it: "40m", "3h 20m", "1 day",
  // "2.5 days".
  function fmtUntil(sec) {
    var s = Math.max(0, Math.round(sec));
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
    var d = Math.round(s / 8640) / 10;
    return d + (d === 1 ? ' day' : ' days');
  }

  // Absolute wall-clock of a future timestamp: "17:30" today, "Wed 09:00"
  // beyond 24h — the countdown says how long, this says when.
  function fmtClock(ts) {
    var d = new Date(ts);
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (ts - Date.now() >= 86400000) {
      return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    }
    return time;
  }

  function resetText(resetAt) {
    var t = parseTs(resetAt);
    if (isNaN(t) || t <= Date.now()) return '';
    return 'resets in ' + fmtUntil((t - Date.now()) / 1000) + ' · ' + fmtClock(t);
  }

  function pctText(fraction) {
    return Math.round(fraction * 100) + '%';
  }

  // One quota column: the label and what is left on top, the bar, the reset
  // under it. The bar fills with what is LEFT, so a full green bar is an
  // account with its window ahead of it.
  function meterEl(m) {
    var box = el('div', m ? 'meter' : 'meter none');
    if (!m) { box.appendChild(el('div', 'mt', '—')); return box; }
    var top = el('div', 'mt');
    top.appendChild(el('span', '', m.label));
    top.appendChild(el('b', m.tone === 'unknown' ? '' : m.tone, m.left == null ? '?' : pctText(m.left) + ' left'));
    box.appendChild(top);
    var bar = el('div', 'bar');
    var fill = el('i', m.tone === 'warn' || m.tone === 'bad' ? m.tone : '');
    fill.style.width = (m.left == null ? 0 : m.left * 100) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
    box.appendChild(el('div', 'rs', m.note || resetText(m.resetAt)));
    return box;
  }

  function modelBadges(usage, into) {
    recentModelLabels(usage).forEach(function (l) { into.appendChild(el('span', 'badge model', l)); });
  }

  function isCurrentAccount(a, s) {
    return s.currentAccounts ? s.currentAccounts[a.provider] === a.name : a.name === s.currentAccount;
  }

  // One account on the quota page: who it is, its three quota columns, and
  // the controls that act on it. Everything else the old card carried — why it
  // is blocked, outside spend, the forecast, other model buckets — sits on a
  // line under the columns, only when there is something to say.
  function renderAccountRow(a, s, fable, probeEntry) {
    var key = cardNoteKey(a);
    var row = el('div', 'arow');
    var who = el('div', 'who');
    who.appendChild(el('div', 'name', a.name));
    var badges = el('div', 'badges');
    if (a.plan) badges.appendChild(el('span', 'badge plan', a.plan));
    if (a.drainRank) badges.appendChild(el('span', 'badge drain', a.drainRank === 1 ? 'draining' : '#' + a.drainRank + ' in queue'));
    // The first three are provider, type and priority: the section heading
    // already names the provider, and the Accounts page carries the other two.
    // "active" is the state every healthy row would wear, so it is left off.
    // A Codex row says its resets under its controls instead, beside the
    // button that spends them.
    var resetsLeft = codexResetsLeft(a);
    accountBadges(a, s.currentAccount, s.currentAccounts || null, null, s.switchThreshold, s.switchThresholds).slice(3).forEach(function (b) {
      if (b.cls === 'active' || (resetsLeft != null && b.cls === 'meta resets')) return;
      badges.appendChild(el('span', 'badge ' + b.cls, b.text));
    });
    modelBadges(a.usage, badges);
    who.appendChild(badges);
    var u = a.usage || {};
    who.appendChild(el('div', 'usage', (u.totalRequests || 0) + ' req · ' + fmtNum(accountTokens(u)) + ' tok' + (u.lastUsed ? ' · last ' + fmtAgo(u.lastUsed) : '')));
    row.appendChild(who);

    var meters = accountMeters(a, fable);
    meters.slots.forEach(function (m) { row.appendChild(meterEl(m)); });

    var ctl = el('div', 'ctl');
    // Zero-spend, like the fleet-wide probe on the Settings page, so a client
    // key may use it too. Disabled while a probe of this account is in flight,
    // whether this button or a fleet cycle started it.
    if (canRefreshQuota(a, probeEntry)) {
      var refresh = button('btn', probeEntry.status === 'running' ? 'Refreshing…' : 'Refresh quota', function () { doRefreshQuota(a, key, refresh); });
      refresh.disabled = probeEntry.status === 'running';
      ctl.appendChild(refresh);
    }
    if (!isCurrentAccount(a, s) && !a.disabled) {
      var sw = button('btn', 'Switch to', function () { doSwitch(a.name, key, sw); });
      ctl.appendChild(sw);
    }
    if (canRedeemReset(a, s.caller)) ctl.appendChild(resetButton(a, key));
    if (resetsLeft != null) ctl.appendChild(el('div', 'resets' + (resetsLeft ? '' : ' none'), resetsLeftText(resetsLeft, codexResetExpiry(a))));
    row.appendChild(ctl);

    var x = el('div', 'rowx');
    var said = 0;
    var cn = cardNoteFor(cardNotes, key, Date.now());
    if (cn) { x.appendChild(el('div', 'cardnote ' + cn.kind, cn.text)); said++; }
    // A cordon is the badge's to say: the account still serves what is on it.
    if (a.unavailable && a.unavailable !== 'cordoned') { x.appendChild(el('div', 'blocked', 'blocked: ' + (UNAVAILABLE_TEXT[a.unavailable] || a.unavailable))); said++; }
    if (a.entitlementDenial) { x.appendChild(el('div', 'blocked', 'denied: ' + (a.entitlementDenial.detail || 'OAuth entitlement denied') + ' \u00b7 first ' + fmtAgo(a.entitlementDenial.since))); said++; }
    if (meters.text) { x.appendChild(el('div', 'usage', meters.text)); said++; }
    // Prepaid API credit (accounts[].credit): its bar is one of the meters,
    // and this is the amount left with where the figure comes from, in the
    // words the status command prints.
    var creditLine = a.credit ? creditText(a.credit, Date.now()) : null;
    if (creditLine) { x.appendChild(el('div', 'usage', 'credit: ' + creditLine)); said++; }
    var q = a.quota || {};
    // Spend on this account that did not come through the proxy (#475).
    var outside = outsideSpendText(q.outsideSpend, s.outsideSpendHidePercent, q.planPeriod);
    if (outside) { x.appendChild(el('div', 'usage', 'outside: ' + outside)); said++; }
    var forecast = forecastText(q.forecast, Date.now(), q.planPeriod);
    if (forecast) { x.appendChild(el('div', 'usage', 'forecast: ' + forecast)); said++; }
    if (meters.extra.length) {
      var open = !!expanded['row:' + key];
      var names = meters.extra.map(function (m) { return m.label; }).join(', ');
      x.appendChild(button('more', (open ? 'Hide ' : 'Show ') + names, function () {
        expanded['row:' + key] = !open;
        if (lastStatus) render(lastStatus);
      }));
      if (open) {
        var grid = el('div', 'xmeters');
        meters.extra.forEach(function (m) { grid.appendChild(meterEl(m)); });
        x.appendChild(grid);
      }
      said++;
    }
    if (said) row.appendChild(x);
    return row;
  }

  // Which account in a group holds its provider's cursor. Backends share the
  // Claude provider's cursor, so a backend group has a current account only
  // when that cursor is on one of its own.
  function currentIn(s, group, members) {
    var provider = group === 'codex' || group === 'grok' ? group : 'anthropic';
    var name = s.currentAccounts ? s.currentAccounts[provider] : s.currentAccount;
    return members.some(function (a) { return a.name === name; }) ? name : null;
  }

  function poolBlock(p, small) {
    var box = el('div', small ? 'pool small' : 'pool');
    box.appendChild(el('div', 'pl', p.label));
    var v = el('div', 'v');
    v.appendChild(el('span', '', p.count ? pctText(p.left) : '?'));
    v.appendChild(el('small', '', p.count ? ' of ' + (p.count * 100) + '% left' : ' no reading yet'));
    box.appendChild(v);
    var seg = el('div', 'seg');
    p.segments.forEach(function (sg) {
      var cell = el('span');
      cell.title = sg.name + ': ' + pctText(sg.left) + ' left';
      var fill = el('i', sg.tone === 'warn' || sg.tone === 'bad' ? sg.tone : '');
      fill.style.width = (sg.left * 100) + '%';
      cell.appendChild(fill);
      seg.appendChild(cell);
    });
    box.appendChild(seg);
    var line = p.soonest ? 'soonest reset: ' + p.soonest.name + ' · ' + resetText(p.soonest.resetAt).replace('resets ', '') : '';
    if (p.unknown) line += (line ? ' · ' : '') + p.unknown + ' without a reading';
    if (line) box.appendChild(el('div', 'r', line));
    return box;
  }

  // A provider's summary card: its headline column pooled across its accounts
  // (Fable weekly for Claude, the weekly limit for Codex), and the rest behind
  // Show, the way the rows put the less used buckets behind theirs. The
  // adjacent session card uses the same display for just the five-hour pool.
  function summaryCard(s, group, members, fable, session) {
    var card = el('div', 'scard');
    var head = el('div', 'k');
    var title = el('span', '', groupLabel(group));
    title.insertBefore(el('span', 'pdot ' + providerTone(group)), title.firstChild);
    title.style.display = 'flex';
    title.style.alignItems = 'center';
    title.style.gap = '8px';
    head.appendChild(title);
    head.appendChild(el('span', '', members.length + (members.length === 1 ? ' account' : ' accounts')));
    card.appendChild(head);
    var order = session ? [1] : (group === 'codex' || group === 'grok' ? [2, 1] : [0, 1, 2]);
    var pools = order.map(function (i) { return poolSummary(members, i, fable); }).filter(function (p) { return p.label; });
    if (!pools.length) {
      if (session) card.appendChild(poolBlock({ label: '5-hour limit', count: 0, segments: [] }, false));
      else card.appendChild(el('div', 'r', 'no quota reading yet'));
    } else {
      card.appendChild(poolBlock(pools[0], false));
      var rest = pools.slice(1);
      if (rest.length) {
        var k = 'card:' + group;
        var open = !!expanded[k];
        var line = el('div', 'r');
        line.appendChild(el('span', '', rest.map(function (p) { return p.label + ' ' + (p.count ? pctText(p.left) + ' left' : '?'); }).join(' · ') + '  '));
        line.appendChild(button('more', open ? 'Hide' : 'Show', function () {
          expanded[k] = !open;
          if (lastStatus) render(lastStatus);
        }));
        card.appendChild(line);
        if (open) rest.forEach(function (p) { card.appendChild(poolBlock(p, true)); });
      }
    }
    // The free resets the Codex accounts hold between them: what could be
    // spent to clear a spent limit rather than wait it out.
    var resets = !session && group === 'codex' ? codexResetsSummary(members) : null;
    if (resets) card.appendChild(el('div', 'r', 'Resets left: ' + resets.left + ' across ' + resets.accounts + (resets.accounts === 1 ? ' account' : ' accounts')));
    // Drain mode's queue, when the server reports one: the account being spent
    // first and when it resets, so "why this account" reads off the card.
    var provider = group === 'codex' || group === 'grok' ? group : 'anthropic';
    var queue = !session && s.drainQueue && s.drainQueue[provider];
    var head0 = queue && queue.length ? members.filter(function (a) { return a.name === queue[0]; })[0] : null;
    if (head0) {
      var weekly = accountMeters(head0, fable).slots[2];
      var when = weekly ? resetText(weekly.resetAt) : '';
      card.appendChild(el('div', 'drain', 'Draining: ' + head0.name + (when ? ' · ' + when : '')));
    }
    return card;
  }

  // Dismissed reset-credit alerts, by event key (resetCreditAlerts). Kept in
  // the browser, so a dismissal holds across reloads; the newest are kept.
  var RESET_ALERTS_KEY = 'teamclaude-dashboard-reset-alerts';
  function dismissedResetAlerts() {
    try {
      var list = JSON.parse(localStorage.getItem(RESET_ALERTS_KEY) || '[]');
      return Array.isArray(list) ? list.filter(function (k) { return typeof k === 'string'; }) : [];
    } catch (e) { return []; }
  }

  function renderResetAlerts(accounts) {
    var box = document.getElementById('resetAlerts');
    box.textContent = '';
    resetCreditAlerts(accounts, dismissedResetAlerts()).forEach(function (x) {
      var row = el('div', x.kind);
      row.appendChild(el('span', '', x.text));
      row.appendChild(button('more', 'Dismiss', function () {
        localStorage.setItem(RESET_ALERTS_KEY, JSON.stringify(dismissedResetAlerts().concat([x.key]).slice(-50)));
        renderResetAlerts(accounts);
      }));
      box.appendChild(row);
    });
  }

  function renderQuota(s) {
    var accounts = s.accounts || [];
    var tabs = providerTabs(accounts);
    if (!tabs.some(function (t) { return t.key === currentTab; })) currentTab = 'all';
    var tabBox = document.getElementById('tabs');
    tabBox.textContent = '';
    tabs.forEach(function (t) {
      var b = button(t.key === currentTab ? 'tab sel' : 'tab', t.label, function () {
        currentTab = t.key;
        if (lastStatus) render(lastStatus);
      });
      if (t.key !== 'all') b.insertBefore(el('span', 'pdot ' + providerTone(t.key)), b.firstChild);
      b.appendChild(el('span', 'count', String(t.count)));
      tabBox.appendChild(b);
    });
    var fable = fableLabel(accounts);
    var groups = tabs.slice(1).map(function (t) { return t.key; }).filter(function (g) { return currentTab === 'all' || g === currentTab; });
    var at = Date.now();
    var selected = accounts.filter(function (a) { return currentTab === 'all' || accountGroup(a) === currentTab; });
    var hidden = selected.filter(function (a) { return accountQuotaExhausted(a, at); }).length;
    var visibility = document.getElementById('quotaVisibility');
    visibility.textContent = '';
    if (hidden || showAllAccounts) {
      visibility.appendChild(el('span', 'hint', hidden + ' exhausted account' + (hidden === 1 ? '' : 's') + (showAllAccounts ? ' shown' : ' hidden')));
      var toggle = button('btn', showAllAccounts ? 'Hide exhausted' : 'Show all', function () {
        showAllAccounts = !showAllAccounts;
        if (lastStatus) render(lastStatus);
      });
      toggle.setAttribute('aria-pressed', String(showAllAccounts));
      visibility.appendChild(toggle);
    }
    renderResetAlerts(accounts);
    var cards = document.getElementById('summaryCards');
    cards.textContent = '';
    var acc = document.getElementById('accounts');
    acc.textContent = '';
    if (!accounts.length) {
      acc.appendChild(el('div', 'card empty', 'No accounts yet. Sign one in on the Accounts page, or run teamclaude login. Next: connect your tools on the Clients page.'));
      return;
    }
    var probeAccounts = (s.probe || {}).accounts || [];
    groups.forEach(function (g) {
      var members = [];
      accounts.forEach(function (a, i) { if (accountGroup(a) === g) members.push({ a: a, i: i }); });
      var list = members.map(function (m) { return m.a; });
      if (g === 'anthropic' || g === 'codex') {
        var pair = el('div', 'summary-pair');
        pair.appendChild(summaryCard(s, g, list, fable));
        pair.appendChild(summaryCard(s, g, list, fable, true));
        cards.appendChild(pair);
      } else cards.appendChild(summaryCard(s, g, list, fable));
      var head = el('div', 'sechead');
      head.appendChild(groupHeading(g, groupLabel(g)));
      var visible = members.filter(function (m) { return showAllAccounts || !accountQuotaExhausted(m.a, at); });
      head.appendChild(el('span', 'count', visible.length + ' of ' + members.length));
      var cur = currentIn(s, g, list);
      if (cur) head.appendChild(el('span', 'tag', 'current: ' + cur));
      acc.appendChild(head);
      var rows = el('div', 'rows ' + providerTone(g));
      if (!visible.length) rows.appendChild(el('div', 'empty', 'All accounts in this group have an exhausted limit. Use Show all to see them.'));
      visible.forEach(function (m) {
        // The probe's list is the fleet in the same order; the name check keeps a
        // payload that ever differs from pairing a row with another account's entry.
        var pe = probeAccounts[m.i] && probeAccounts[m.i].name === m.a.name ? probeAccounts[m.i] : null;
        rows.appendChild(renderAccountRow(m.a, s, fable, pe));
      });
      acc.appendChild(rows);
    });
  }

  function statusText(a) {
    if (a.disabled) return 'disabled';
    if (a.unavailable) return UNAVAILABLE_TEXT[a.unavailable] || a.unavailable;
    return a.status || 'unknown';
  }

  // What each provider section on the Accounts page says it holds.
  var GROUP_BLURB = {
    anthropic: 'Claude Pro and Max sign-ins, and Anthropic API keys. Claude Code uses these.',
    codex: 'ChatGPT sign-ins (Plus, Pro, Business). The Codex CLI uses these.',
    grok: 'xAI sign-ins (SuperGrok, X subscriptions). Grok Build uses these.',
  };

  // The heading over one provider's accounts, wherever they are listed.
  function groupHeading(group, text) {
    var h = el('h2');
    h.appendChild(el('span', 'pdot ' + providerTone(group)));
    h.appendChild(el('span', '', text));
    return h;
  }

  // The accounts, one section per provider, with the controls that change
  // where rotation may reach each one. A control this key would be refused is
  // not drawn at all; the line at the top of the page says why, once
  // (callerNotice). Claude, Codex and Grok always get a section, empty or not, so
  // the page says where a sign-in will land before there is one.
  function renderAccountsPage(s) {
    var canSignIn = callerCan(s.caller, '/teamclaude/login/start');
    var canRemove = callerCan(s.caller, '/teamclaude/remove');
    renderAddBar(canSignIn);
    var box = document.getElementById('accountGroups');
    box.textContent = '';
    var accounts = s.accounts || [];
    var groups = ['anthropic', 'codex', 'grok'].concat(providerTabs(accounts).slice(1).map(function (t) { return t.key; })
      .filter(function (g) { return g !== 'anthropic' && g !== 'codex' && g !== 'grok'; }));
    groups.forEach(function (g) {
      var members = accounts.filter(function (a) { return accountGroup(a) === g; });
      var head = el('div', 'phead');
      head.appendChild(groupHeading(g, g === 'codex' ? 'Codex (ChatGPT) accounts' : groupLabel(g) + ' accounts'));
      head.appendChild(el('span', 'count', String(members.length)));
      head.appendChild(el('span', 'tag', GROUP_BLURB[g] || 'A third-party backend, reached with an API key.'));
      box.appendChild(head);
      var card = el('div', 'pcard ' + providerTone(g));
      box.appendChild(card);
      if (!members.length) {
        card.appendChild(el('div', 'empty', canSignIn
          ? 'No ' + groupLabel(g) + ' accounts yet. Use Sign in to ' + groupLabel(g) + ' above to add one.'
          : 'No ' + groupLabel(g) + ' accounts yet.'));
        return;
      }
      var table = el('table');
      card.appendChild(table);
      var hr = el('tr');
      // Codex accounts carry a free-reset count the others do not.
      var heads = ['Account', 'Plan', 'Status', 'Priority', 'Conversations', 'Requests', 'Tokens', 'Last request'];
      if (g === 'codex') heads.push('Resets left');
      heads.push('');
      heads.forEach(function (h, i) {
        hr.appendChild(el('th', i >= 3 && i < heads.length - 1 ? 'num' : '', h));
      });
      table.appendChild(hr);
      members.forEach(function (a) { table.appendChild(accountTableRow(a, s, canSignIn, canRemove, g === 'codex')); });
    });
  }

  function accountTableRow(a, s, canSignIn, canRemove, withResets) {
    var key = cardNoteKey(a);
    var tr = el('tr');
    var name = el('td');
    name.appendChild(el('div', 'name', a.name));
    if (a.orgName) name.appendChild(el('div', 'tag', a.orgName));
    var emailLine = accountEmailLine(a);
    if (emailLine) name.appendChild(el('div', 'tag', emailLine));
    var cn = cardNoteFor(cardNotes, key, Date.now());
    if (cn) name.appendChild(el('div', 'cardnote ' + cn.kind, cn.text));
    var fileHint = fileSignInHint(a);
    if (fileHint) name.appendChild(el('div', 'cardnote warn', fileHint));
    tr.appendChild(name);
    tr.appendChild(el('td', '', a.plan || a.type || '—'));
    var st = el('td');
    // A cordon is a routine state, so its badge stays one word: the full reason
    // would widen the Status column until the row's controls overflow the card.
    var cordonBadge = !a.disabled && a.unavailable === 'cordoned';
    var badge = el('span', 'badge ' + (a.disabled ? 'disabled' : cordonBadge ? 'cordoned' : (a.status || '')), cordonBadge ? 'cordoned' : statusText(a));
    if (cordonBadge) badge.title = statusText(a);
    st.appendChild(badge);
    if (isCurrentAccount(a, s)) { st.appendChild(el('span', '', ' ')); st.appendChild(el('span', 'badge current', 'current')); }
    tr.appendChild(st);
    tr.appendChild(el('td', 'num', String(a.priority || 0)));
    tr.appendChild(el('td', 'num', (a.sessions || 0) + ' / ' + (a.knownSessions || 0)));
    var u = a.usage || {};
    tr.appendChild(el('td', 'num', fmtNum(u.totalRequests)));
    tr.appendChild(el('td', 'num', fmtNum(accountTokens(u))));
    tr.appendChild(el('td', 'num', u.lastUsed ? fmtAgo(u.lastUsed) : '—'));
    if (withResets) {
      var left = codexResetsLeft(a);
      var expiry = codexResetExpiry(a);
      tr.appendChild(el('td', 'num', left == null ? '—' : String(left) + (expiry == null ? '' : ' \u00b7 expires ' + shortDate(expiry))));
    }
    var act = el('td', 'num');
    // Signed out upstream: the one thing that brings it back is a sign-in,
    // so it comes first. The tokens go to whichever account the browser
    // signs in as, which the panel says.
    var again = needsSignIn(a);
    if (again && canSignIn) {
      act.appendChild(button('btn ' + again, 'Sign in again', function () { startSignIn(again, a.email || a.name); }));
    }
    if (!isCurrentAccount(a, s) && !a.disabled) {
      var ctlSwitch = button('btn', 'Switch to', function () { doSwitch(a.name, key, ctlSwitch); });
      act.appendChild(ctlSwitch);
    }
    if (canRedeemReset(a, s.caller)) act.appendChild(resetButton(a, key));
    if (callerCan(s.caller, '/teamclaude/disable')) {
      var ctlDisable = button('btn', a.disabled ? 'Enable' : 'Disable', function () { doControlAccount(a.name, key, { disabled: !a.disabled }, ctlDisable); });
      act.appendChild(ctlDisable);
    }
    // Cordon it, or put it back: no new conversation goes to it while the
    // ones already on it stay, the graceful step before a disable or a
    // removal. Drawn for a disabled account too, so an enable can bring it
    // back cordoned.
    if (callerCan(s.caller, '/teamclaude/account-cordon')) {
      var cordoned = a.cordoned === true;
      var ctlCordon = button('btn', cordoned ? 'Uncordon' : 'Cordon', function () { doControlAccount(a.name, key, { cordoned: !cordoned }, ctlCordon); });
      ctlCordon.title = cordoned ? 'Send new conversations to this account again'
        : 'Send no new conversations to this account; the ones on it stay until they finish';
      act.appendChild(ctlCordon);
    }
    // Only enable/disable (and cordon) for a disabled account: the rest would
    // move an account that nothing will select anyway. Not for a cordoned one
    // either: nothing new goes there, so a move would read as doing something
    // and would not, until the uncordon.
    if (!a.disabled && a.cordoned !== true && callerCan(s.caller, '/teamclaude/priority')) {
      var ctlFirst = button('btn', 'Prioritize', function () { doControlAccount(a.name, key, { place: 'first' }, ctlFirst); });
      act.appendChild(ctlFirst);
      var ctlLast = button('btn', 'Deprioritize', function () { doControlAccount(a.name, key, { place: 'last' }, ctlLast); });
      act.appendChild(ctlLast);
    }
    // Two clicks: the first arms the button for a few seconds, the second
    // removes. There is no undo short of signing in again. Arming changes
    // nothing but this button, which keeps its width, so no other control
    // slides under the pointer between the clicks; and a second click too
    // soon after the first is a double-click, not a decision.
    if (canRemove) {
      var armedAt = removeArmed[key];
      var armed = armedAt != null && Date.now() - armedAt < REMOVE_CONFIRM_MS;
      var ctlRemove = button(armed ? 'btn rm danger' : 'btn rm', armed ? 'Confirm remove' : 'Remove', function () {
        if (!armed) { removeArmed[key] = Date.now(); if (lastStatus) render(lastStatus); return; }
        if (Date.now() - armedAt < REMOVE_DOUBLE_CLICK_MS) return;
        delete removeArmed[key];
        doRemove(a, key, ctlRemove);
      });
      ctlRemove.title = armed ? 'Click again to sign ' + a.name + ' out of TeamClaude' : 'Sign ' + a.name + ' out of TeamClaude';
      act.appendChild(ctlRemove);
    }
    tr.appendChild(act);
    return tr;
  }

  // The buttons that add an account. Rebuilt with the page; the sign-in
  // panel under them is not, so a paste being typed survives the poll.
  function renderAddBar(canSignIn) {
    var bar = document.getElementById('addBar');
    bar.textContent = '';
    bar.style.display = canSignIn ? '' : 'none';
    if (!canSignIn) return;
    bar.appendChild(el('span', 'lbl', 'Add an account:'));
    [['claude', 'Sign in to Claude', 'Sign in with a Claude Pro or Max account'], ['codex', 'Sign in to Codex', 'Sign in with a ChatGPT account, for the Codex CLI'], ['grok', 'Sign in to Grok', 'Sign in with an xAI account, for Grok Build']].forEach(function (p) {
      var b = button('btn ' + p[0], p[1], function () { startSignIn(p[0], null); });
      b.title = p[2];
      b.insertBefore(el('span', 'pdot ' + p[0]), b.firstChild);
      bar.appendChild(b);
    });
  }

  // The window a usage table is showing, in its own heading. The control sits
  // above the Clients table, but the dimension tables are below it and can be
  // scrolled clear of it — and a five-hour figure under a bare "Input tok" is
  // the one way this feature can state a number under the wrong label.
  // Last used is a lifetime figure in a table whose heading may name a window.
  // Under Total that needs no saying; under a window it does, or it reads as
  // the one thing this control must never do — a number under the wrong label.
  function lastUsedLabel() {
    return usageView === 'total' ? 'Last used' : 'Last used (all time)';
  }

  function usageHeading(base) {
    if (usageView === 'total') return base;
    var view = USAGE_VIEWS.filter(function (v) { return v.key === usageView; })[0];
    return view ? base + ' · ' + view.label.toLowerCase() : base;
  }

  function renderClients(clients) {
    var wrap = document.getElementById('clientsWrap');
    var names = Object.keys(clients || {});
    if (!names.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    document.getElementById('clientsHeading').textContent = usageHeading('Clients');
    // Sorted on the window being shown, not on the lifetime total: a table
    // ordered by all-time spend while displaying the last five hours would put
    // the quiet clients on top of the busy one.
    names.sort(function (a, b) {
      var ua = usageFor(clients[a], usageView), ub = usageFor(clients[b], usageView);
      return (ub.inputTokens + ub.outputTokens) - (ua.inputTokens + ua.outputTokens);
    });
    var table = document.getElementById('clients');
    table.textContent = '';
    var hr = el('tr');
    ['Client', 'Requests', 'WebSockets', 'Input tok', 'Output tok', lastUsedLabel()].forEach(function (h, i) {
      hr.appendChild(el('th', i ? 'num' : '', h));
    });
    table.appendChild(hr);
    names.forEach(function (n) {
      var c = clients[n];
      var u = usageFor(c, usageView);
      var tr = el('tr');
      tr.appendChild(el('td', '', n));
      tr.appendChild(el('td', 'num', fmtNum(u.requests)));
      tr.appendChild(el('td', 'num', fmtNum(u.connections)));
      tr.appendChild(el('td', 'num', fmtNum(u.inputTokens)));
      tr.appendChild(el('td', 'num', fmtNum(u.outputTokens)));
      // Last used stays the lifetime figure under every window: it answers
      // when this client was last seen at all, which a window cannot.
      tr.appendChild(el('td', 'num', c.lastUsed ? fmtAgo(c.lastUsed) : '—'));
      table.appendChild(tr);
    });
  }

  // Connect your tools. Read when the Clients page opens, not on every poll
  // (on Windows each read starts PowerShell). The server answers only a
  // caller on its own machine, so a refusal hides the card for good; a page
  // showing a linked instance never asks, since it would edit this machine.
  var connectState = 'unasked'; // 'unasked' | 'asking' | 'done' | 'hidden'
  var connectClients = [];
  // Rows whose Connect was clicked once over another address. No prototype.
  var connectArmed = Object.create(null);

  function loadConnect() {
    connectState = 'asking';
    fetch('/teamclaude/clients/connect', { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        // 404: a proxy from before this card. 403 and 409: not this machine,
        // or no loopback address to point the tools at.
        if (res.status === 403 || res.status === 404 || res.status === 409) return null;
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (j) {
        connectState = j ? 'done' : 'hidden';
        if (j) connectClients = j.clients || [];
        if (lastStatus) renderConnect(lastStatus);
      })
      // Asked again on a later render, as the linked-instance card does.
      .catch(function () { connectState = 'unasked'; });
  }

  function renderConnect(s) {
    var card = document.getElementById('connectCard');
    var can = !peer && callerCan(s.caller, '/teamclaude/clients/connect');
    if (can && connectState === 'unasked' && currentPage === 'clients') loadConnect();
    // A re-read on a later visit keeps the rows it is about to refresh on screen.
    var shown = can && connectState !== 'hidden' && connectClients.length > 0;
    card.style.display = shown ? '' : 'none';
    if (!shown) return;
    var rows = document.getElementById('connectRows');
    rows.textContent = '';
    connectClients.forEach(function (c) {
      var armedAt = connectArmed[c.id];
      var armed = armedAt != null && Date.now() - armedAt < REMOVE_CONFIRM_MS;
      var view = connectRowView(c, armed);
      var row = el('div', 'crow');
      var who = el('div', 'who');
      who.appendChild(el('b', '', c.label));
      view.lines.forEach(function (line) { who.appendChild(el('span', 'hint', line)); });
      row.appendChild(who);
      row.appendChild(el('span', view.pill.cls, view.pill.text));
      if (view.button) {
        var act = view.button;
        var b = button(act.cls, act.label, function () {
          if (c.state === 'elsewhere' && !armed) { connectArmed[c.id] = Date.now(); renderConnect(s); return; }
          if (armed && Date.now() - armedAt < REMOVE_DOUBLE_CLICK_MS) return;
          delete connectArmed[c.id];
          doConnect([c.id], act.action, act.replace, b);
        });
        b.title = act.title;
        row.appendChild(b);
      }
      rows.appendChild(row);
    });
    var all = document.getElementById('connectAll');
    all.style.display = connectClients.some(function (c) { return c.state === 'disconnected'; }) ? '' : 'none';
  }

  function connectStatusLine(kind, text) {
    var st = document.getElementById('connectStatus');
    st.className = 'st ' + kind;
    st.textContent = text;
    st.style.display = text ? '' : 'none';
  }

  function doConnect(ids, action, replace, btn) {
    btn.disabled = true;
    var r = connectRequest(ids, action, replace, localStorage.getItem(KEY));
    fetch(r.url, r.init)
      .then(function (res) { return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; }); })
      .then(function (json) {
        var out = connectOutcome(json, action);
        connectStatusLine(out.kind, out.text);
        (json.clients || []).forEach(function (c) {
          connectClients = connectClients.map(function (old) { return old.id === c.id ? c : old; });
        });
        if (lastStatus) renderConnect(lastStatus);
      })
      .catch(function (e) { connectStatusLine('error', 'The change did not reach the proxy: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  document.getElementById('connectAll').addEventListener('click', function (e) {
    doConnect(['all'], 'connect', false, e.currentTarget);
  });

  // Client keys: the form and the panel holding a new key are static, so a name
  // being typed and a key not yet copied survive the poll; only the list of
  // configured names is rebuilt. Revoke is armed by a first click, like Remove.
  // No prototype: a key named __proto__ would otherwise set it.
  var ckRevokeArmed = Object.create(null);

  function renderClientKeys(s) {
    var card = document.getElementById('clientKeys');
    var can = callerCan(s.caller, '/teamclaude/client-keys/create');
    card.style.display = can ? '' : 'none';
    if (!can) return;
    var names = Array.isArray(s.clientKeys) ? s.clientKeys : [];
    var clients = s.clients || {};
    var table = document.getElementById('ckList');
    table.textContent = '';
    if (!names.length) return;
    var hr = el('tr');
    ['Key name', 'Last used', ''].forEach(function (h, i) { hr.appendChild(el('th', i ? 'num' : '', h)); });
    table.appendChild(hr);
    names.forEach(function (name) {
      var tr = el('tr');
      tr.appendChild(el('td', '', name));
      var used = clients[name] && clients[name].lastUsed;
      tr.appendChild(el('td', 'num', used ? fmtAgo(used) : 'not used yet'));
      var armedAt = ckRevokeArmed[name];
      var armed = armedAt != null && Date.now() - armedAt < REMOVE_CONFIRM_MS;
      var td = el('td', 'num');
      var open = issuedName === name;
      var d = button('btn', open ? 'Hide details' : 'Show details', function () {
        if (open) hideIssuedKey(); else doClientKey('show', name, d);
      });
      d.title = 'The key and the setup for Claude Code, the Codex CLI and Grok Build';
      td.appendChild(d);
      var b = button(armed ? 'btn rm danger' : 'btn rm', armed ? 'Confirm revoke' : 'Revoke', function () {
        if (!armed) { ckRevokeArmed[name] = Date.now(); if (lastStatus) render(lastStatus); return; }
        if (Date.now() - armedAt < REMOVE_DOUBLE_CLICK_MS) return;
        delete ckRevokeArmed[name];
        doClientKey('revoke', name, b);
      });
      b.title = armed ? 'Click again: clients using this key are refused from now on' : 'Stop accepting this key';
      td.appendChild(b);
      tr.appendChild(td);
      table.appendChild(tr);
    });
  }

  function ckStatus(kind, text) {
    var st = document.getElementById('ckStatus');
    st.className = 'st ' + kind;
    st.textContent = text;
    st.style.display = text ? '' : 'none';
  }

  function doClientKey(step, name, btn) {
    btn.disabled = true;
    var r = clientKeyRequest(step, name, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = clientKeyOutcome(json, step);
        ckStatus(out.kind, out.text);
        if (json.ok && step === 'show') { showIssuedKey(json.name, json.key, true, json.grokLocal); if (lastStatus) render(lastStatus); return; }
        if (json.ok && step === 'create') {
          document.getElementById('ckName').value = '';
          // The proxy's first key closes a gate this page may have come in
          // through without a key. Its next poll would then be refused and
          // the key box would cover the panel before the key was copied, so
          // polling waits for Done.
          holdPoll = !!json.firstKey && !localStorage.getItem(KEY);
          showIssuedKey(json.name, json.key, false, json.grokLocal);
        }
        // A revoked key's panel would offer setup for a key that no longer works.
        if (json.ok && step === 'revoke' && issuedName === json.name) hideIssuedKey();
        poll();
      })
      .catch(function (e) { ckStatus('error', CLIENT_KEY_FAILED[step] + ': ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  // A key is shown in this panel only: the status endpoint never returns keys.
  // A new one opens it on create; Show details reads a key back on request.
  var issuedName = null;
  // Set while a first key's panel is open on a page that holds no key: see doClientKey.
  var holdPoll = false;

  function hideIssuedKey() {
    issuedName = null;
    var box = document.getElementById('ckIssued');
    box.textContent = '';
    box.style.display = 'none';
    if (holdPoll) { holdPoll = false; poll(); } else if (lastStatus) render(lastStatus);
  }

  function copyField(field, btn) {
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
    // The async clipboard needs a secure context, which a dashboard opened at
    // a plain-http LAN address is not; selecting the text still leaves it one
    // keystroke away.
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(field.value).then(done, function () { field.focus(); field.select(); });
      return;
    }
    field.focus();
    field.select();
    try { if (document.execCommand('copy')) done(); } catch (e) { /* the text stays selected */ }
  }

  function snippet(box, label, text, rows) {
    box.appendChild(el('div', 'lbl', label));
    var line = el('div', 'line');
    var field = rows ? el('textarea') : el('input');
    field.readOnly = true;
    field.value = text;
    if (rows) field.rows = rows;
    line.appendChild(field);
    var copy = button('btn', 'Copy', function () { copyField(field, copy); });
    line.appendChild(copy);
    box.appendChild(line);
  }

  function showIssuedKey(name, key, existing, grokLocal) {
    issuedName = name;
    var box = document.getElementById('ckIssued');
    box.textContent = '';
    var head = el('div', 'line');
    head.appendChild(el('b', '', 'Key for ' + name));
    head.appendChild(el('span', 'hint', existing ? 'Anyone who can see this screen can use the key.' : 'Copy it now, or come back with Show details.'));
    box.appendChild(head);
    var origin = peer ? peerUrl : typeof location !== 'undefined' ? location.origin : '';
    var setup = clientKeySetup(origin, key, grokLocal);
    snippet(box, 'Key', key, 0);
    snippet(box, 'Claude Code: run in the shell that starts claude', setup.claude, 2);
    snippet(box, 'Codex CLI: add to ~/.codex/config.toml', setup.codex, 7);
    // Grok Build cannot send the key (clientKeySetup), so it gets the
    // proxy's own loopback address, or a line saying why it has none.
    if (setup.grok) {
      snippet(box, 'Grok Build: run in the shell that starts grok, on the machine the proxy runs on. Grok Build cannot send this key, so it must connect straight to the proxy, which lets that in without one (not through a Docker port mapping or a reverse proxy)', setup.grok, 1);
    } else if (grokLocal === null) {
      box.appendChild(el('div', 'lbl', 'Grok Build cannot send this key, and this proxy lets no connection in without one (proxy.trustLoopback is false, or it does not listen on its own machine\u2019s loopback address), so Grok Build cannot use it.'));
    }
    if (isLoopbackHost(pageHost())) {
      box.appendChild(el('div', 'lbl', 'This page is open at ' + origin + '. A client on another machine needs an address of this one it can reach instead.'));
    }
    if (holdPoll) {
      box.appendChild(el('div', 'st warn', 'The proxy now asks every caller off its own machine for a key, this page included. Copy the key before you press Done: the page will then ask for one. To manage keys from here again, set proxy.apiKey.'));
    }
    var actions = el('div', 'line');
    var check = el('span', 'st');
    var test = button('btn', 'Test key', function () {
      test.disabled = true;
      check.className = 'st';
      check.textContent = 'Testing…';
      // Its own fetch, with the new key and not the page's: a 401 here says
      // the new key is refused and must not throw away the key the page holds.
      fetch('/teamclaude/status', { headers: { 'x-api-key': key } })
        .then(function (res) {
          return res.json().catch(function () { return null; }).then(function (body) { return clientKeyCheckOutcome(res.status, body, name); });
        })
        .catch(function (e) { return { kind: 'error', text: 'The test could not reach the proxy: ' + e.message }; })
        .then(function (out) { check.className = 'st ' + out.kind; check.textContent = out.text; test.disabled = false; });
    });
    // The test asks with the new key itself, which only the instance that
    // issued it accepts; a linked one is reached with this machine's key.
    if (!peer) actions.appendChild(test);
    actions.appendChild(button('btn', 'Done', hideIssuedKey));
    actions.appendChild(check);
    box.appendChild(actions);
    box.style.display = '';
  }

  // Linked instances (Settings). The list comes with every status; what the
  // instance shown can offer another machine (a name for itself, its
  // addresses, whether it can be linked back) is asked once per page load,
  // since it does not change while the proxy runs. Like everything else on
  // the page it is the shown instance's: picking a linked one manages ITS links.
  // Remove is armed by a first click, like Revoke.
  var linkSelf = null;
  var linkSelfState = 'unasked'; // 'unasked' | 'asking' | 'done' | 'unsupported'
  var linkSelfPrefill = '';
  // Saves of the Instance address so far. A status or /peer-links read that
  // was asked before the latest one may answer after it, with the address it
  // replaced, so such a read is not let near the address.
  var addrSaves = 0;
  var statusAddrStale = false;
  var linkRemoveArmed = Object.create(null);

  // The address this page was opened at, which is this machine as the browser
  // reaches it; nothing when the page shows a linked instance.
  function pageOrigin() {
    return !peer && typeof location !== 'undefined' ? location.origin : '';
  }

  function val(id) { return document.getElementById(id).value.trim(); }

  function renderLinks(s) {
    var card = document.getElementById('links');
    var can = Array.isArray(s.peers) && callerCan(s.caller, '/teamclaude/peer-links/add');
    card.style.display = can ? '' : 'none';
    if (!can) return;
    // Asked only once the card is on screen: every other page has no use for it.
    if (linkSelfState === 'unasked' && currentPage === 'settings') loadLinkSelf();
    var unsupported = linkSelfState === 'unsupported';
    document.getElementById('linkUnsupported').style.display = unsupported ? '' : 'none';
    document.getElementById('linkForm').style.display = unsupported ? 'none' : '';
    document.getElementById('ownKey').style.display = unsupported ? 'none' : '';
    document.getElementById('linkEmpty').style.display = s.peers.length ? 'none' : '';
    var table = document.getElementById('linkList');
    table.textContent = '';
    if (!s.peers.length) return;
    var hr = el('tr');
    // Account sync per linked instance, read through the relay; a linked
    // instance's page cannot reach its own links, so it has no such column.
    var heads = peer ? ['Name', 'Address', 'State', ''] : ['Name', 'Address', 'State', 'Account sync', ''];
    heads.forEach(function (h, i) { hr.appendChild(el('th', i === heads.length - 1 ? 'num' : '', h)); });
    var canSync = callerCan(s.caller, '/teamclaude/account-sync/start');
    table.appendChild(hr);
    s.peers.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('td', '', p.name));
      tr.appendChild(el('td', 'addr', p.url));
      var td = el('td');
      td.appendChild(el('span', 'st ' + (p.state === 'online' ? 'ok' : p.state === 'checking' ? '' : 'error'), p.state));
      tr.appendChild(td);
      if (!peer) {
        var ps = peerSync[p.name];
        var cell = p.state !== 'online' ? { kind: '', text: '—', setUp: false } : peerSyncCell(ps ? ps.view : null, ps ? ps.status : 0, syncView);
        var std = el('td', 'sync');
        std.appendChild(el('span', 'st ' + cell.kind, cell.text));
        if (cell.setUp && canSync && !syncSigningIn()) {
          var setUp = button('btn', 'Set up', function () { startSyncSignIn(p.name); });
          setUp.title = 'Sign ' + p.name + ' in to callback.net from here';
          std.appendChild(setUp);
        }
        tr.appendChild(std);
      }
      var actions = el('td', 'num');
      // The picker lists this machine's links, so only those can be opened from here.
      if (!peer) actions.appendChild(button('btn', 'Open', function () { pickInstance(p.name); }));
      if (!unsupported) {
        var armedAt = linkRemoveArmed[p.name];
        var armed = armedAt != null && Date.now() - armedAt < REMOVE_CONFIRM_MS;
        var b = button(armed ? 'btn rm danger' : 'btn rm', armed ? 'Confirm remove' : 'Remove', function () {
          if (!armed) { linkRemoveArmed[p.name] = Date.now(); if (lastStatus) render(lastStatus); return; }
          if (Date.now() - armedAt < REMOVE_DOUBLE_CLICK_MS) return;
          delete linkRemoveArmed[p.name];
          doRemoveLink(p.name, b);
        });
        b.title = armed ? 'Click again: it leaves the Instance picker' : 'Stop showing this machine here';
        actions.appendChild(b);
      }
      tr.appendChild(actions);
      table.appendChild(tr);
    });
  }

  function loadLinkSelf() {
    linkSelfState = 'asking';
    var saves = addrSaves;
    fetch(at('/teamclaude/peer-links'), { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        // An instance from before this card: no such route.
        if (res.status === 404) return { unsupported: true };
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (j) {
        // Asked before a save: it may offer the address that save replaced.
        if (saves !== addrSaves) { linkSelfState = 'unasked'; if (lastStatus) renderLinks(lastStatus); return; }
        linkSelfState = j.unsupported ? 'unsupported' : 'done';
        linkSelf = j.self || null;
        fillLinkSelf();
        if (lastStatus) renderLinks(lastStatus);
      })
      // Asked again on a later render, not now: a loop on a proxy that keeps failing helps no one.
      .catch(function () { linkSelfState = 'unasked'; });
  }

  // Brings what this instance offers in line with the address set for it,
  // and closes a shown link that still carries the old one.
  // Then asks for it again: the address set may also have been the one guess
  // the server found, which the swap dropped along with it.
  function useInstanceAddress(address) {
    if (!linkSelf || linkSelf.address === address) return;
    linkSelf = linkSelfWithAddress(linkSelf, address);
    fillLinkSelf();
    if (ownKeyOpen) toggleOwnKey(document.getElementById('ownKeyShow'));
    linkSelfState = 'unasked';
  }

  // Prefills what this machine would be called and reached at from the other
  // one, and says up front what stands in the way of linking it back.
  function fillLinkSelf() {
    var opts = linkSelfOptions(linkSelf, pageOrigin());
    var list = document.getElementById('linkSelfUrls');
    list.textContent = '';
    opts.forEach(function (o) { var op = el('option'); op.value = o; list.appendChild(op); });
    var url = document.getElementById('linkSelfUrl');
    // A prefill nobody has typed over follows a new Instance address.
    if ((!url.value || url.value === linkSelfPrefill) && opts.length) url.value = linkSelfPrefill = opts[0];
    var name = document.getElementById('linkSelfName');
    if (!name.value && linkSelf && linkSelf.name) name.value = linkSelf.name;
    var notice = linkBackNotice(linkSelf);
    var blocked = document.getElementById('linkBackBlocked');
    blocked.textContent = notice ? notice.text : '';
    blocked.style.display = notice ? '' : 'none';
    var cb = document.getElementById('linkBack');
    var block = !!(notice && notice.block);
    // Ticked only with an address to offer; with none it is still the
    // operator's to tick after typing one in.
    if (block || !opts.length) cb.checked = false;
    cb.disabled = block;
    syncLinkBack();
  }

  function syncLinkBack() {
    document.getElementById('linkBackFields').style.display = document.getElementById('linkBack').checked ? '' : 'none';
  }

  // The card says "this machine" for the machine it manages, which is the
  // linked one when the page shows one.
  function labelLinkCard() {
    if (!peer) return;
    document.getElementById('linkBackText').textContent = 'Link back too: list ' + peer + ' on it, so its dashboard shows ' + peer;
    document.getElementById('linkSelfUrlLabel').textContent = peer + ', as it reaches it';
    document.getElementById('linkSelfNameLabel').textContent = 'Name for ' + peer + ' there';
    document.getElementById('ownKeyLabel').textContent = peer + "'s link, or its proxy key and address, for linking it from another machine's dashboard.";
  }

  function linkStatus(kind, text) {
    var st = document.getElementById('linkStatus');
    st.className = 'st ' + kind;
    st.textContent = text;
  }

  function postPeerLink(step, body) {
    var r = peerLinkRequest(step, body, localStorage.getItem(KEY));
    return fetch(at(r.url), r.init).then(function (res) {
      if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
      return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
    });
  }

  function doTestLink(btn) {
    var url = val('linkUrl');
    var apiKey = val('linkKey');
    if (!url || !apiKey) { linkStatus('error', 'Enter its address and its proxy key first.'); return; }
    btn.disabled = true;
    linkStatus('', 'Testing…');
    postPeerLink('test', { url: url, apiKey: apiKey })
      .then(function (j) {
        if (!j) return;
        var out = peerTestOutcome(j);
        linkStatus(out.kind, out.text);
        // Its own name is only a suggestion: naming the link is left to the operator.
        if (j.ok && j.name) document.getElementById('linkName').placeholder = 'e.g. ' + j.name;
        // It cannot take this machine's link, so the form should not offer to send one.
        if (j.ok && j.state === 'online' && !j.linkable) { document.getElementById('linkBack').checked = false; syncLinkBack(); }
      })
      .catch(function (e) { linkStatus('error', PEER_LINK_FAILED.test + ': ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function doAddLink() {
    var body = { name: val('linkName'), url: val('linkUrl'), apiKey: val('linkKey') };
    // The form keeps what it holds, so naming it and clicking Link again is all it takes.
    var missing = linkAddMissing(body);
    if (missing) {
      linkStatus('error', missing);
      if (body.url && body.apiKey) document.getElementById('linkName').focus();
      return;
    }
    var cb = document.getElementById('linkBack');
    if (cb.checked && !cb.disabled) body.linkBack = { name: val('linkSelfName'), url: val('linkSelfUrl') };
    var btn = document.getElementById('linkAdd');
    btn.disabled = true;
    linkStatus('', body.linkBack ? 'Linking both ways…' : 'Linking…');
    postPeerLink('add', body)
      .then(function (j) {
        if (!j) return;
        var out = peerLinkOutcome(j, 'add');
        linkStatus(out.kind, out.text);
        if (j.ok) {
          ['linkPaste', 'linkUrl', 'linkKey', 'linkName'].forEach(function (id) { document.getElementById(id).value = ''; });
          document.getElementById('linkName').placeholder = 'e.g. desktop';
          poll();
        }
      })
      .catch(function (e) { linkStatus('error', PEER_LINK_FAILED.add + ': ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  // A pasted link fills in the address and key; the name is left to the operator.
  // Typing is quiet until the field is left: a half-typed link is not an error yet.
  function useInstanceLink(quiet) {
    var text = val('linkPaste');
    if (!text) return;
    var got = parseInstanceLink(text);
    if (!got && quiet) return;
    if (!got) { linkStatus('error', 'That is not a link from the Linked instances card. Copy it again from the other machine: Settings, Linked instances, Show key, Copy link.'); return; }
    if (val('linkUrl') === got.url && val('linkKey') === got.apiKey) return;
    document.getElementById('linkUrl').value = got.url;
    document.getElementById('linkKey').value = got.apiKey;
    linkStatus('ok', 'Filled in its address and key from the link. Name it, then click Link.');
    document.getElementById('linkName').focus();
  }

  function doRemoveLink(name, btn) {
    btn.disabled = true;
    postPeerLink('remove', { name: name })
      .then(function (j) {
        if (!j) return;
        var out = peerLinkOutcome(j, 'remove');
        linkStatus(out.kind, out.text);
        poll();
      })
      .catch(function (e) { linkStatus('error', PEER_LINK_FAILED.remove + ': ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  // The key and a best-guess address, which is what the other machine's form asks for.
  var ownKeyOpen = false;
  function toggleOwnKey(btn) {
    var box = document.getElementById('ownKeyBox');
    if (ownKeyOpen) { ownKeyOpen = false; box.textContent = ''; box.style.display = 'none'; btn.textContent = 'Show key'; return; }
    btn.disabled = true;
    postPeerLink('key', {})
      .then(function (j) {
        if (!j) return;
        box.textContent = '';
        if (!j.ok) {
          box.appendChild(el('div', 'st error', PEER_LINK_FAILED.key + (j.error ? ': ' + j.error : '')));
        } else {
          box.appendChild(el('div', 'lbl', 'Anyone who can see this screen, or has the link, can use the key. On the other machine, under Link another machine, paste the link or enter the address and key.'));
          var opts = linkSelfOptions(linkSelf, pageOrigin());
          var link = opts.length ? instanceLink(opts[0], j.key) : '';
          if (link) snippet(box, 'Link (the address below and the key): paste it under Its link on the other machine', link, 0);
          var addrSet = !!(linkSelf && linkSelf.address && linkSelf.address === opts[0]);
          if (opts.length) snippet(box, addrSet ? 'Address (set under Instance address above)' : 'Address (a best guess: use one the other machine can reach, or set Instance address above)', opts[0], 0);
          snippet(box, 'Proxy key', j.key, 0);
        }
        box.style.display = '';
        ownKeyOpen = true;
        btn.textContent = 'Hide key';
      })
      .catch(function (e) { box.textContent = ''; box.appendChild(el('div', 'st error', PEER_LINK_FAILED.key + ': ' + e.message)); box.style.display = ''; ownKeyOpen = true; btn.textContent = 'Hide key'; })
      .finally(function () { btn.disabled = false; });
  }

  // Account sync (Settings): callback.net (credential-sync.js) for the
  // instance shown and, through the relay, for each machine linked to this
  // one. Read when the card is on screen, then once a minute and after every
  // step rather than on every poll: a read may ask callback.net who is signed
  // in. A sign-in started here is polled until it settles. Sign out is armed
  // by a first click, like Remove.
  var SYNC_READ_MS = 60000;
  var SYNC_POLL_MS = 2000;
  var syncView = null;
  var syncReadAt = 0;
  var syncReading = false;
  var syncUnsupported = false;
  // A linked instance's read, by name: { status, view }.
  var peerSync = Object.create(null);
  // The sign-in in progress: { target, id, url, done, seq, status }. target
  // is a linked instance's name, or '' for the instance the page shows.
  var syncSignIn = null;
  var syncSignInSeq = 0;
  var syncSignInTimer = null;
  var syncBusy = '';
  var syncNote = null;
  var syncSignOutArmedAt = null;

  function syncWhere(target) { return target || peer || 'this machine'; }

  // One sign-in at a time, on whichever instance: a second would leave the
  // first one's link live with nothing on the page to cancel it.
  function syncSigningIn() { return !!(syncSignIn && !syncSignIn.done); }

  // '' is the instance the page shows; a name is one of this machine's links.
  function syncAt(target, url) {
    return target ? '/teamclaude/peers/' + encodeURIComponent(target) + url.slice('/teamclaude'.length) : at(url);
  }

  // One step, answered as JSON with the HTTP status beside it. Only the
  // page's own key can be turned away with a 401: the relay answers a linked
  // instance's refusal as 502.
  function syncFetch(step, body, target) {
    var r = accountSyncRequest(step, body, localStorage.getItem(KEY));
    return fetch(syncAt(target, r.url), r.init).then(function (res) {
      if (res.status === 401 && !target) { localStorage.removeItem(KEY); showKeybox(); return null; }
      return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; }).then(function (j) {
        j = j && typeof j === 'object' ? j : { ok: false };
        j.httpStatus = res.status;
        return j;
      });
    });
  }

  function loadSync() {
    if (syncReading) return;
    syncReading = true;
    syncReadAt = Date.now();
    var reads = [syncFetch('view', null, '').then(function (j) {
      if (!j) return;
      syncUnsupported = j.httpStatus === 404 || j.httpStatus === 501;
      syncView = j;
    }, function (e) { syncView = { ok: false, error: e.message }; })];
    // A linked instance's own links are not ours to reach, so the column is
    // only on this machine's page.
    if (!peer && lastStatus && Array.isArray(lastStatus.peers)) {
      lastStatus.peers.forEach(function (p) {
        if (p.state !== 'online') { delete peerSync[p.name]; return; }
        reads.push(syncFetch('view', null, p.name).then(function (j) {
          if (j) peerSync[p.name] = { status: j.httpStatus, view: j };
        }, function () { peerSync[p.name] = { status: 0, view: { ok: false } }; }));
      });
    }
    Promise.all(reads).then(function () {
      syncReading = false;
      if (lastStatus) { renderSync(lastStatus); renderLinks(lastStatus); }
    });
  }

  // A read is due: never made, a minute old, or a linked instance that came
  // online since the last one.
  function syncReadDue(s) {
    if (Date.now() - syncReadAt >= SYNC_READ_MS) return true;
    return !peer && Array.isArray(s.peers) && s.peers.some(function (p) { return p.state === 'online' && !(p.name in peerSync); });
  }

  function renderSync(s) {
    var card = document.getElementById('acctSync');
    var can = callerCan(s.caller, '/teamclaude/account-sync/start');
    card.style.display = can ? '' : 'none';
    if (!can) return;
    if (currentPage === 'settings' && !syncReading && syncReadDue(s)) loadSync();
    var body = document.getElementById('syncBody');
    var hint = document.getElementById('syncHint');
    body.textContent = '';
    if (syncUnsupported) {
      body.appendChild(el('p', 'st warn', syncWhere('') + ' runs a version that cannot set up account sync from the dashboard. Update it, or run teamclaude callback login on it.'));
      hint.textContent = '';
      return;
    }
    if (!syncView) { body.appendChild(el('p', 'st', 'Checking…')); hint.textContent = ''; return; }
    var line = accountSyncLine(syncView, syncWhere(''));
    var row = el('div', 'syncline');
    row.appendChild(el('span', 'st ' + line.kind, line.text));
    var sum = syncView.sync || {};
    var own = accountSyncOwnMode(syncView);
    var on = syncView.signedIn || !!own;
    if (on && sum.lastSyncAt) row.appendChild(el('span', 'when', 'Last synced ' + fmtAgo(sum.lastSyncAt) + '.'));
    body.appendChild(row);
    var members = accountSyncMembers(syncView);
    if (members.length) {
      var list = el('ul', 'members');
      members.forEach(function (m) { list.appendChild(el('li', 'st ' + m.kind, m.text)); });
      body.appendChild(list);
    }
    var notShared = Array.isArray(sum.notShared) ? sum.notShared : [];
    notShared.forEach(function (n) { body.appendChild(el('p', 'st warn', '"' + n.name + '" is not shared: ' + n.reason)); });
    var acts = el('div', 'row acts');
    if (syncView.ok && !on) {
      if (!syncSigningIn()) acts.appendChild(button('btn primary', 'Turn on account sync', function () { startSyncSignIn(''); }));
    } else if (syncView.ok) {
      var now = button('btn', syncBusy === 'sync' ? 'Syncing…' : 'Sync now', function () { doSync('sync'); });
      now.disabled = !!syncBusy;
      now.title = own ? 'Compare with the store now instead of at the next sync, a few minutes away' : 'Compare with callback.net now instead of at the daily sync';
      acts.appendChild(now);
      var armedAt = syncSignOutArmedAt;
      var armed = armedAt != null && Date.now() - armedAt < REMOVE_CONFIRM_MS;
      var label = own ? (armed ? 'Confirm turn off' : 'Turn off') : (armed ? 'Confirm sign out' : 'Sign out');
      var out = button(armed ? 'btn rm danger' : 'btn rm', syncBusy === 'sign-out' ? 'Signing out…' : syncBusy === 'mode' ? 'Turning off…' : label, function () {
        if (!armed) { syncSignOutArmedAt = Date.now(); renderSync(s); return; }
        if (Date.now() - armedAt < REMOVE_DOUBLE_CLICK_MS) return;
        syncSignOutArmedAt = null;
        if (own) doSync('mode', { mode: 'off' });
        else doSync('sign-out');
      });
      out.disabled = !!syncBusy;
      out.title = armed ? 'Click again: ' + syncWhere('') + ' stops sharing sign-ins' : 'Stop sharing sign-ins on ' + syncWhere('');
      acts.appendChild(out);
    }
    if (acts.childNodes.length) body.appendChild(acts);
    var callbackHint = 'You approve the sign-in at callback.net, in any browser. Use the same callback.net account on every machine. callback.net keeps the sign-ins encrypted, readable only with your login.';
    var offer = syncView.ok && !on && !syncSigningIn() && syncView.instance && syncView.instance.supported;
    // Offered both ways, each hint stays under its own button.
    if (offer) {
      body.appendChild(el('p', 'hint', callbackHint));
      body.appendChild(ownSyncBox(syncView.instance));
    }
    if (syncNote) body.appendChild(el('div', 'st ' + syncNote.kind, syncNote.text));
    hint.textContent = own === 'cluster'
      ? 'Each machine shares the Claude, Codex and Grok sign-ins it has and adds the ones the others share. The first member in the list that is up is the master; the backups keep a copy of its store, and the next one up takes over when the master has not answered for 30 seconds. API-key and backend accounts are not shared.'
      : own
      ? 'Each machine shares the Claude, Codex and Grok sign-ins it has and adds the ones the others share, every few minutes or at once with Sync now. A follower reaches ' + (own === 'host' ? syncWhere('') : syncView.instance.peer) + ' over its link, with the key it already holds. API-key and backend accounts are not shared.'
      : syncView.signedIn
        ? 'An account reaches callback.net when a machine signs it in or next renews it. A machine where that account needs a sign-in takes the working one at its next sync, which Sync now runs at once. API-key and backend accounts are not shared.'
        : offer ? '' : callbackHint;
  }

  // The other way to turn it on: no outside account, one of your own
  // machines keeps the sign-ins (instance-sync.js). Keep them here, or follow
  // a linked instance that keeps them.
  function ownSyncBox(inst) {
    var box = el('div', 'ownsync');
    box.appendChild(el('div', 'sub2', 'Or keep them on one of your own machines'));
    box.appendChild(el('p', 'hint', 'No account needed. One machine keeps the sign-ins; each of your other machines follows it over its link (Linked instances, below).'));
    var acts = el('div', 'row acts');
    var host = button('btn', syncBusy === 'mode' ? 'Turning on…' : 'Keep them on ' + syncWhere(''), function () { doSync('mode', { mode: 'host' }); });
    host.disabled = !!syncBusy || !inst.canHost;
    host.title = inst.canHost ? syncWhere('') + ' keeps the sign-ins, and your other machines follow it' : syncWhere('') + ' has no proxy key, so your other machines could not reach it';
    acts.appendChild(host);
    var peers = Array.isArray(inst.peers) ? inst.peers : [];
    if (peers.length) {
      var pick = el('select');
      pick.setAttribute('aria-label', 'Linked instance to follow');
      peers.forEach(function (n) { var o = el('option', '', n); o.value = n; pick.appendChild(o); });
      acts.appendChild(pick);
      var follow = button('btn', 'Follow', function () { doSync('mode', { mode: 'follow', peer: pick.value }); });
      follow.disabled = !!syncBusy;
      follow.title = syncWhere('') + ' uses the sign-ins the chosen machine keeps';
      acts.appendChild(follow);
    }
    box.appendChild(acts);
    if (peers.length) box.appendChild(clusterSyncBox(inst));
    return box;
  }

  // A master and backups (sync-cluster.js): the same ordered list on every
  // machine. Offered with this machine first and its linked instances after,
  // which the operator reorders by editing the line.
  function clusterSyncBox(inst) {
    var box = el('div', 'cluster');
    box.appendChild(el('div', 'sub2', 'Or a master with backups'));
    box.appendChild(el('p', 'hint', 'List the machines by name, the master first, then the backups in the order they take over. Set the same list on every machine. If the master does not answer for 30 seconds, the next one up takes over with the copy it kept.'));
    var acts = el('div', 'row acts');
    var list = el('input');
    list.type = 'text';
    list.setAttribute('aria-label', 'Machines, master first');
    var names = [inst.self].concat(Array.isArray(inst.peers) ? inst.peers : []).filter(function (n) { return !!n; });
    list.value = names.join(', ');
    acts.appendChild(list);
    var use = button('btn', syncBusy === 'mode' ? 'Turning on…' : 'Use master and backups', function () {
      doSync('mode', { mode: 'cluster', members: list.value.split(',').map(function (n) { return n.trim(); }).filter(function (n) { return !!n; }) });
    });
    use.disabled = !!syncBusy;
    use.title = 'The first machine in the list is the master; the others keep a copy and take over in that order';
    acts.appendChild(use);
    box.appendChild(acts);
    return box;
  }

  // Rebuilt only when the sign-in changes, not on every poll, so the link
  // field keeps a selection made to copy it.
  function renderSyncSignIn() {
    var wrap = document.getElementById('syncSignIn');
    wrap.textContent = '';
    if (!syncSignIn) return;
    var where = syncWhere(syncSignIn.target);
    var box = el('div', 'issued');
    box.appendChild(el('div', 'sub2', 'Turn on account sync for ' + where));
    if (!syncSignIn.done && syncSignIn.url) {
      var steps = el('ol');
      var one = el('li', '', 'Open callback.net and approve the sign-in. Use the same callback.net account on every machine.');
      var line = el('div', 'line');
      var open = el('a', 'btn primary', 'Open callback.net');
      open.href = syncSignIn.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      line.appendChild(open);
      // The link itself, to approve from a browser on another device.
      var link = el('input');
      link.readOnly = true;
      link.value = syncSignIn.url;
      link.title = 'The approval link, to open on another device';
      link.addEventListener('focus', function () { this.select(); });
      line.appendChild(link);
      one.appendChild(line);
      steps.appendChild(one);
      steps.appendChild(el('li', '', 'Come back here: the sign-in on ' + where + ' finishes by itself once you approve.'));
      box.appendChild(steps);
    }
    var st = syncSignIn.status || { kind: '', text: '' };
    var foot = el('div', 'line');
    foot.appendChild(el('span', 'st ' + st.kind, st.text));
    foot.appendChild(button('btn', syncSignIn.done ? 'Close' : 'Cancel', closeSyncSignIn));
    box.appendChild(foot);
    wrap.appendChild(box);
  }

  function stopSyncSignInPoll() {
    if (syncSignInTimer) clearTimeout(syncSignInTimer);
    syncSignInTimer = null;
  }

  // Settled: the states shown are read again, so the card and the row of the
  // instance just signed in say so.
  function settleSyncSignIn(out) {
    stopSyncSignInPoll();
    syncSignIn.done = true;
    syncSignIn.status = out;
    renderSyncSignIn();
    syncReadAt = 0;
    if (lastStatus) { renderSync(lastStatus); renderLinks(lastStatus); }
  }

  function startSyncSignIn(target) {
    if (syncSigningIn()) return;
    stopSyncSignInPoll();
    var seq = ++syncSignInSeq;
    var me = { target: target, id: null, url: null, done: false, abandoned: false, seq: seq, status: { kind: '', text: 'Asking callback.net for a sign-in link…' } };
    syncSignIn = me;
    syncNote = null;
    renderSyncSignIn();
    if (lastStatus) { renderSync(lastStatus); renderLinks(lastStatus); }
    var card = document.getElementById('acctSync');
    if (card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
    syncFetch('start', {}, target)
      .then(function (j) {
        if (!j) return;
        // Closed before its link arrived: the server is waiting all the same,
        // so it is cancelled now that there is an id to name.
        if (me.abandoned) { if (j.ok && j.id) cancelSyncSignIn(target, j.id); return; }
        if (syncSignIn !== me) return;
        var href = j.ok ? accountSyncApprovalHref(j.url) : null;
        if (!href) {
          // Not a link this page opens: the server is left waiting for nothing.
          if (j.ok && j.id) cancelSyncSignIn(target, j.id);
          settleSyncSignIn({ kind: 'error', text: ACCOUNT_SYNC_FAILED.start + (j.ok ? ': the link it answered with is not one this page opens' : j.error ? ': ' + j.error : '') });
          return;
        }
        syncSignIn.id = j.id;
        syncSignIn.url = href;
        syncSignIn.status = accountSyncSignInOutcome({ ok: true, state: 'waiting' });
        renderSyncSignIn();
        pollSyncSignIn(seq);
      })
      .catch(function (e) {
        if (syncSignIn !== me) return;
        settleSyncSignIn({ kind: 'error', text: ACCOUNT_SYNC_FAILED.start + ': ' + e.message });
      });
  }

  function pollSyncSignIn(seq) {
    stopSyncSignInPoll();
    syncSignInTimer = setTimeout(function () {
      if (!syncSignIn || syncSignIn.seq !== seq || syncSignIn.done) return;
      syncFetch('status', { id: syncSignIn.id }, syncSignIn.target)
        .then(function (j) { return j; }, function (e) { return { ok: false, error: e.message }; })
        .then(function (j) {
          if (!j || !syncSignIn || syncSignIn.seq !== seq || syncSignIn.done) return;
          var out = accountSyncSignInOutcome(j);
          if (out.done) { settleSyncSignIn(out); if (j.state === 'succeeded') poll(); return; }
          syncSignIn.status = out;
          renderSyncSignIn();
          pollSyncSignIn(seq);
        });
    }, SYNC_POLL_MS);
  }

  function closeSyncSignIn() {
    var cur = syncSignIn;
    stopSyncSignInPoll();
    syncSignIn = null;
    renderSyncSignIn();
    // Still open on the server. One whose link has not arrived yet is
    // cancelled when it does (startSyncSignIn).
    if (cur && !cur.done) {
      if (cur.id) cancelSyncSignIn(cur.target, cur.id);
      else cur.abandoned = true;
    }
    if (lastStatus) { renderSync(lastStatus); renderLinks(lastStatus); }
  }

  // A cancel that did not take is said on the card: its link may still sign
  // the instance in, or already has.
  function cancelSyncSignIn(target, id) {
    var where = syncWhere(target);
    syncFetch('cancel', { id: id }, target)
      .then(function (j) { return j || { ok: false }; }, function (e) { return { ok: false, error: e.message }; })
      .then(function (j) {
        var out = accountSyncCancelOutcome(j, where);
        if (!out) return;
        syncNote = out;
        syncReadAt = 0;
        if (lastStatus) { renderSync(lastStatus); renderLinks(lastStatus); }
      });
  }

  // Sync now, Sign out and the store switch, on the instance shown.
  function doSync(step, body) {
    syncBusy = step;
    syncNote = null;
    if (lastStatus) renderSync(lastStatus);
    syncFetch(step, body || {}, '')
      .then(function (j) { if (j) syncNote = accountSyncOutcome(j, step, syncWhere('')); })
      .catch(function (e) { syncNote = { kind: 'error', text: ACCOUNT_SYNC_FAILED[step] + ': ' + e.message }; })
      .finally(function () {
        syncBusy = '';
        syncReadAt = 0;
        if (lastStatus) renderSync(lastStatus);
        // A sync may have added or revived accounts: the other pages show them now.
        poll();
      });
  }

  // The window buttons, built once: the windows are fixed by the server that
  // served this page. Visibility is decided per render, since the control only
  // means something when there is a usage table under it.
  function buildUsageViews() {
    var wrap = document.getElementById('usageViewWrap');
    wrap.appendChild(el('span', 'lbl', 'Usage window'));
    USAGE_VIEWS.forEach(function (v) {
      var btn = el('button', '', v.label);
      btn.addEventListener('click', function () {
        usageView = v.key;
        markUsageView();
        if (lastStatus) render(lastStatus);
      });
      wrap.appendChild(btn);
      usageButtons.push({ key: v.key, btn: btn });
    });
    markUsageView();
  }

  function markUsageView() {
    usageButtons.forEach(function (b) { b.btn.className = b.key === usageView ? 'sel' : ''; });
  }

  // Header cells that re-sort in place. The sort is state, not a re-fetch, so
  // it survives the 5s poll: re-rendering re-reads sortState below.
  function addSortableHeader(tr, table, label, key, numeric) {
    var th = el('th', (numeric ? 'num ' : '') + 'sortable', label + (sortState[table].key === key ? (sortState[table].dir === 'asc' ? ' ▲' : ' ▼') : ''));
    th.addEventListener('click', function () {
      var st = sortState[table];
      if (st.key === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
      else { st.key = key; st.dir = numeric ? 'desc' : 'asc'; }
      if (lastStatus) render(lastStatus);
    });
    tr.appendChild(th);
  }

  // Session and conversation are two columns rather than one composite: sorting
  // by Session brings a fan-out's rows together (the sort is stable, so they
  // stay in recency order inside it) and Conv is the only column that differs
  // between them. Narrow on purpose — it is a digest, not a name.
  var SESSION_COLUMNS = [
    { key: 'session', label: 'Session' },
    { key: 'conversation', label: 'Conv' },
    { key: 'client', label: 'Client' },
    { key: 'project', label: 'Project' },
    { key: 'accounts', label: 'Accounts' },
    { key: 'requests', label: 'Req', num: true },
    { key: 'cacheRead', label: 'Cache read', num: true },
    { key: 'cacheCreation', label: 'Cache write', num: true },
    { key: 'input', label: 'Input', num: true },
    { key: 'output', label: 'Output', num: true },
    { key: 'context', label: 'Context', num: true },
    { key: 'lastSeen', label: 'Last seen', num: true },
  ];

  function renderSessions(sessions) {
    var wrap = document.getElementById('sessionsWrap');
    var empty = document.getElementById('sessionsEmpty');
    // Absent unless proxy.sessionDetail is on — the aggregate counts in the
    // summary line stay either way.
    if (!sessions || !sessions.items) {
      wrap.style.display = 'none';
      empty.style.display = '';
      empty.textContent = ((sessions && sessions.active) || 0) + ' active / ' + ((sessions && sessions.known) || 0)
        + ' known conversations. Set proxy.sessionDetail to true to list them here.';
      return;
    }
    wrap.style.display = '';
    empty.style.display = 'none';

    var all = sessionRows(sessions);
    var projectSel = document.getElementById('fProject');
    var clientSel = document.getElementById('fClient');
    fillFilter(projectSel, uniqSorted(all.map(function (r) { return r.project; })), sessionFilters.project);
    fillFilter(clientSel, uniqSorted(all.map(function (r) { return r.client; })), sessionFilters.client);
    sessionFilters.project = projectSel.value;
    sessionFilters.client = clientSel.value;

    var rows = sortRows(filterSessionRows(all, sessionFilters), sortState.sessions.key, sortState.sessions.dir);
    // Conversations, not sessions: one client session contributes a row per
    // agent it has in flight, and counting rows as sessions would report a
    // fleet carrying several times the clients it has.
    document.getElementById('sessionCount').textContent = rows.length + ' of ' + all.length + ' conversations';

    var table = document.getElementById('sessions');
    table.textContent = '';
    var hr = el('tr');
    SESSION_COLUMNS.forEach(function (c) { addSortableHeader(hr, 'sessions', c.label, c.key, !!c.num); });
    table.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', r.active ? '' : 'dim', r.session));
      tr.appendChild(el('td', r.active ? '' : 'dim', r.conversation || '—'));
      tr.appendChild(el('td', '', r.client || '—'));
      tr.appendChild(el('td', '', r.project || '—'));
      tr.appendChild(el('td', '', r.accounts || '—'));
      ['requests', 'cacheRead', 'cacheCreation', 'input', 'output', 'context'].forEach(function (k) {
        tr.appendChild(el('td', 'num', fmtNum(r[k])));
      });
      tr.appendChild(el('td', 'num', r.lastSeen ? fmtAgo(r.lastSeen) : '—'));
      table.appendChild(tr);
    });
  }

  function fillFilter(select, values, value) {
    select.textContent = '';
    var all = el('option', '', 'All');
    all.value = '';
    select.appendChild(all);
    values.forEach(function (v) {
      var option = el('option', '', v);
      option.value = v;
      select.appendChild(option);
    });
    select.value = values.indexOf(value) === -1 ? '' : value;
  }

  // One table per configured usage dimension (proxy.usageDimensions).
  function renderDimensions(dimensions) {
    var wrap = document.getElementById('dimensionsWrap');
    wrap.textContent = '';
    Object.keys(dimensions || {}).forEach(function (name) {
      var entries = dimensions[name] || {};
      var rows = Object.keys(entries).map(function (key) {
        var e = entries[key] || {};
        var u = usageFor(e, usageView);
        return {
          name: key,
          requests: u.requests,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          lastUsed: e.lastUsed ? Date.parse(e.lastUsed) : 0,
        };
      });
      if (!rows.length) return;
      sortState[name] = sortState[name] || { key: 'inputTokens', dir: 'desc' };
      rows = sortRows(rows, sortState[name].key, sortState[name].dir);

      wrap.appendChild(el('h2', '', usageHeading(name.charAt(0).toUpperCase() + name.slice(1))));
      var card = el('div', 'card');
      card.style.padding = '4px 6px';
      var table = el('table');
      var hr = el('tr');
      [{ key: 'name', label: name.charAt(0).toUpperCase() + name.slice(1) },
        { key: 'requests', label: 'Req', num: true },
        { key: 'inputTokens', label: 'Input tok', num: true },
        { key: 'outputTokens', label: 'Output tok', num: true },
        { key: 'lastUsed', label: lastUsedLabel(), num: true }].forEach(function (c) {
        addSortableHeader(hr, name, c.label, c.key, !!c.num);
      });
      table.appendChild(hr);
      rows.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', '', r.name));
        tr.appendChild(el('td', 'num', fmtNum(r.requests)));
        tr.appendChild(el('td', 'num', fmtNum(r.inputTokens)));
        tr.appendChild(el('td', 'num', fmtNum(r.outputTokens)));
        tr.appendChild(el('td', 'num', r.lastUsed ? fmtAgo(r.lastUsed) : '—'));
        table.appendChild(tr);
      });
      card.appendChild(table);
      wrap.appendChild(card);
    });
  }

  // How sessions are spread, as the router resolved it, and drain mode's
  // queue when the server reports one.
  var MODE_TEXT = {
    off: 'off: one account at a time, until it reaches its switch threshold',
    even: 'even: new conversations go to the least-loaded account',
    adaptive: 'adaptive: new conversations go where the quota burns slowest',
    affinity: 'affinity: conversations stay on the account holding their cache',
    drain: 'drain: the account whose weekly quota resets soonest is used until it runs out',
    load: 'load: new conversations go to the account that served the fewest requests in the last ten minutes',
  };
  function renderRouting(s) {
    var card = document.getElementById('modeCard');
    card.textContent = '';
    var sess = s.sessions || {};
    var mode = sess.mode || (sess.distribute ? 'even' : 'off');
    var line = el('div', 'setting');
    var d = el('div');
    d.appendChild(el('b', '', 'Session distribution'));
    d.appendChild(el('span', 'tag', MODE_TEXT[mode] || mode));
    line.appendChild(d);
    line.appendChild(el('span', 'tag', 'Set with teamclaude distribute <mode>'));
    card.appendChild(line);
    var thr = el('div', 'setting');
    var t = el('div');
    t.appendChild(el('b', '', 'Switch threshold'));
    t.appendChild(el('span', 'tag', thresholdPercentText(s.switchThreshold) + '% of a quota window' + (s.expiryRouting && s.expiryRouting.enabled ? ' · expiry-pressure routing on' : '')));
    thr.appendChild(t);
    card.appendChild(thr);
    Object.keys(s.drainQueue || {}).forEach(function (provider) {
      var q = s.drainQueue[provider] || [];
      var row = el('div', 'setting');
      var c = el('div');
      c.appendChild(el('b', '', providerLabel(provider) + ' drain order'));
      c.appendChild(el('span', 'tag', q.length ? q.join(' → ') : 'no account can serve right now'));
      row.appendChild(c);
      card.appendChild(row);
    });
    renderRoutes(s);
  }

  // Where each metered family goes right now, and which accounts could take
  // it. The last row is the default: everything without its own route lands
  // on the current account.
  function renderRoutes(s) {
    var wrap = document.getElementById('routesWrap');
    var rows = routeRows(s);
    if (!rows.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var table = document.getElementById('routes');
    table.textContent = '';
    var hr = el('tr');
    ['Family', 'Goes to', 'Can serve it'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    table.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      var fam = el('td', '', r.label + (r.match ? ' ' : ''));
      if (r.match) fam.appendChild(el('span', 'tag', r.match));
      if (r.provider) fam.appendChild(el('span', 'tag', ' ' + providerLabel(r.provider)));
      tr.appendChild(fam);
      var to = el('td', r.blocked ? 'badt' : '', r.blocked ? 'blocked' : (r.target || '—'));
      if (r.pinned) to.appendChild(el('span', 'pin', ' · pinned to ' + r.pinned));
      if (r.pinMismatch) to.appendChild(el('span', 'warnt', ' (not eligible)'));
      if (r.kind === 'default' && r.target !== r.current) {
        to.appendChild(el('span', 'warnt', r.currentUnavailable
          ? ' · current account ' + r.current + ' is blocked: ' + (UNAVAILABLE_TEXT[r.currentUnavailable] || r.currentUnavailable)
          : ' · outranks the current account ' + r.current));
      }
      tr.appendChild(to);
      var can = el('td', r.kind === 'default' ? 'dim' : '');
      if (r.kind === 'default') can.textContent = 'no route of its own';
      else if (r.blocked) can.textContent = '—';
      else if (!r.eligible.length && !r.ineligible.length) can.textContent = '—';
      else {
        can.appendChild(el('span', 'ok', r.eligible.length + ' of ' + (r.eligible.length + r.ineligible.length) + (r.ineligible.length ? ' ' : '')));
        if (r.ineligible.length) can.appendChild(el('span', 'no', r.ineligible.join(', ')));
      }
      tr.appendChild(can);
      table.appendChild(tr);
    });
  }

  // The banner over every page, only when something is wrong — a banner that
  // is always on is a banner nobody reads — and the same list on the Problems
  // page, where it is not repeated as a banner.
  function renderProblems(s) {
    var list = problems(s);
    var wrap = document.getElementById('problems');
    var page = document.getElementById('problemList');
    wrap.textContent = '';
    page.textContent = '';
    list.forEach(function (p) {
      wrap.appendChild(el('div', p.severity, p.text));
      page.appendChild(el('div', p.severity, p.text));
    });
    if (!list.length) page.appendChild(el('p', 'sub', 'Nothing needs attention.'));
    wrap.style.display = list.length && currentPage !== 'problems' ? 'block' : 'none';
    setCount('problems', list.length, true);
  }

  function setCount(page, n, bad) {
    var c = navCounts[page];
    if (!c) return;
    c.textContent = String(n);
    c.className = bad ? 'count bad' : 'count';
    c.style.display = n ? '' : 'none';
  }

  function buildLogFilters() {
    var box = document.getElementById('logKinds');
    LOG_KINDS.forEach(function (k) {
      var chip = button('chip', k.label, function () {
        logFilters.kind = k.key;
        renderLogs();
      });
      box.appendChild(chip);
      logChips.push({ key: k.key, btn: chip });
    });
    var provider = document.getElementById('logProvider');
    fillFilter(provider, [], '');
    [['anthropic', 'Claude'], ['codex', 'Codex'], ['grok', 'Grok']].forEach(function (p) {
      var option = el('option', '', p[1]);
      option.value = p[0];
      provider.appendChild(option);
    });
    provider.addEventListener('change', function () { logFilters.provider = this.value; renderLogs(); });
    document.getElementById('logAccount').addEventListener('change', function () { logFilters.account = this.value; renderLogs(); });
  }

  function fmtWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }

  // Newest first, and at most the newest 500 drawn: the page holds the whole
  // log, but a table of thousands of rows rebuilt every few seconds would make
  // the page the slowest thing on the machine.
  function renderLogs() {
    logChips.forEach(function (c) { c.btn.className = c.key === logFilters.kind ? 'chip sel' : 'chip'; });
    var accSel = document.getElementById('logAccount');
    fillFilter(accSel, uniqSorted(logState.events.map(function (e) { return e.account; })), logFilters.account);
    logFilters.account = accSel.value;
    var rows = filterLogEvents(logState.events, logFilters).slice().reverse();
    document.getElementById('logCount').textContent = (logError ? 'cannot read the log: ' + logError + ' · ' : '')
      + rows.length + ' of ' + logState.events.length + ' events';
    var table = document.getElementById('logs');
    table.textContent = '';
    var hr = el('tr');
    ['Time', 'Kind', 'Account', 'Client', 'Event', 'Details'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    table.appendChild(hr);
    if (!rows.length) {
      var tr0 = el('tr');
      var td0 = el('td', 'dim', logState.events.length ? 'No events match these filters.' : 'No events yet.');
      td0.colSpan = 6;
      tr0.appendChild(td0);
      table.appendChild(tr0);
      return;
    }
    rows.slice(0, 500).forEach(function (e) {
      var tr = el('tr', logEventTone(e));
      tr.appendChild(el('td', 'when', fmtWhen(e.at)));
      var kind = LOG_KINDS.filter(function (k) { return k.key === e.kind; })[0];
      tr.appendChild(el('td', 'kind', (kind ? kind.label : e.kind) + (e.provider ? ' · ' + providerLabel(e.provider) : '')));
      tr.appendChild(el('td', '', e.account || '—'));
      tr.appendChild(el('td', 'client', logEventClient(e) || '—'));
      var ev = el('td', 'ev', e.message);
      if (e.prompt) ev.appendChild(el('div', 'prompt', '“' + e.prompt + '”'));
      tr.appendChild(ev);
      tr.appendChild(el('td', 'detail', logEventDetail(e)));
      table.appendChild(tr);
    });
  }

  function pollLogs() {
    // The status poll asks for the logs again once the check is through.
    if (logsInFlight || (peer && !peerChecked)) return;
    logsInFlight = true;
    var held = logState.events;
    var after = held.length ? held[held.length - 1].id : 0;
    var again = false;
    fetch(at('/teamclaude/logs?after=' + after), { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) { localStorage.removeItem(KEY); showKeybox(); return null; }
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (page) {
        if (!page) return;
        logState = mergeLogEvents(logState, page, LOG_CAP);
        again = logState.refetch;
        logError = null;
        renderLogs();
      })
      .catch(function (e) { logError = e.message; renderLogs(); })
      // A restarted server's log is read again from its start, now rather
      // than at the next poll.
      .finally(function () { logsInFlight = false; if (again) pollLogs(); });
  }

  // ---- Insights page -------------------------------------------------------
  // Fetched only while the page is open, like the log, and then at most once a
  // minute: the history moves by the request, but a day's chart is not read to
  // the second, and each read sums every bucket in the range.
  var INS_RANGES = [{ key: '24h', label: '24h' }, { key: '7d', label: '7d' }, { key: '30d', label: '30d' }, { key: '90d', label: '90d' }, { key: 'all', label: 'All' }];
  var INS_SPLITS = [{ key: 'provider', label: 'Provider', text: 'provider' }, { key: 'account', label: 'Account', text: 'account' }, { key: 'instance', label: 'Machine', text: 'machine', fleet: true }, { key: 'kind', label: 'Token type', text: 'token type' }];
  // Every linked machine summed (GET /teamclaude/insights?scope=all), or only
  // the instance shown. "All" is asked of the machine the page was opened on,
  // whichever instance the picker shows: that is the one whose links reach
  // the rest. Offered only while it has linked instances, and the default then.
  var INS_SCOPES = [{ key: 'all', label: 'All' }, { key: 'local', label: 'This one' }];
  var INS_SCOPE_KEY = 'teamclaude-insights-scope';
  // The page is built around two numbers. The headline picked is the one
  // every chart draws, and is remembered: someone who reads the page for the
  // cost should not have to pick it again on every visit.
  var INS_METRIC_KEY = 'teamclaude-insights-metric';
  var INS_METRICS = {
    cost: { name: 'Est. API cost', color: 'var(--is4)', fmt: fmtUsd, axis: fmtUsdShort },
    tokens: { name: 'Tokens', color: 'var(--is1)', fmt: fmtTokens, axis: fmtTokens },
  };
  var INS_BY = [{ key: 'model', label: 'Models' }, { key: 'account', label: 'Accounts' }, { key: 'provider', label: 'Providers' }, { key: 'machine', label: 'Machines', fleet: true }];
  // Rows "Where it went" draws; the Table view has every one.
  var INS_BY_ROWS = 8;
  var INSIGHTS_REFRESH_MS = 60 * 1000;
  var ins = { charts: [], hidden: Object.create(null), range: '30d', split: 'provider', scope: localStorage.getItem(INS_SCOPE_KEY) === 'local' ? 'local' : 'all', metric: localStorage.getItem(INS_METRIC_KEY) === 'tokens' ? 'tokens' : 'cost', view: 'daily', by: 'model', focus: null, focusables: Object.create(null), dataText: '', linked: 0, asked: '', data: null, error: null, missing: false, pending: false, at: 0, inFlight: false, tables: Object.create(null), chips: [], drawn: '' };

  // The scope the page draws: "all" needs this machine to have linked instances.
  function insightsScope() {
    return ins.scope === 'all' && ins.linked > 0 ? 'all' : 'local';
  }
  // The metric the page draws: the cost needs an estimate (costEstimated):
  // a proxy too old to make one, or a range where nothing had a list price,
  // draws the tokens.
  function insightsMetric(d) {
    return ins.metric === 'cost' && costEstimated(d) ? 'cost' : 'tokens';
  }
  var SVGNS = 'http://www.w3.org/2000/svg';
  var insTip = null;
  var insGrad = 0;

  function buildInsightsControls() {

    var range = document.getElementById('insRange');
    var split = document.getElementById('insSplit');
    INS_RANGES.forEach(function (o) {
      var b = button('chip', o.label, function () {
        if (ins.range === o.key) return;
        // The chart on screen stays, dimmed, until the new range arrives,
        // rather than the page jumping to empty and back.
        ins.range = o.key;
        ins.pending = true;
        markInsightsChips();
        renderInsights();
        pollInsights(true);
      });
      range.appendChild(b);
      ins.chips.push({ group: 'range', key: o.key, btn: b });
    });
    INS_SPLITS.forEach(function (o) {
      var b = button('chip', o.label, function () { ins.split = o.key; markInsightsChips(); renderInsights(); });
      split.appendChild(b);
      ins.chips.push({ group: 'split', key: o.key, btn: b, fleet: !!o.fleet });
    });
    var scope = document.getElementById('insScope');
    INS_SCOPES.forEach(function (o) {
      var b = button('chip', o.label, function () {
        if (ins.scope === o.key) return;
        ins.scope = o.key;
        localStorage.setItem(INS_SCOPE_KEY, o.key);
        ins.pending = true;
        markInsightsChips();
        renderInsights();
        pollInsights(true);
      });
      scope.appendChild(b);
      ins.chips.push({ group: 'scope', key: o.key, btn: b });
    });
    markInsightsChips();
    if (typeof window !== 'undefined' && window.addEventListener) {
      // A tap's reading stays until a tap somewhere that is not a chart.
      window.addEventListener('pointerdown', function (e) {
        if (e.pointerType !== 'touch') return;
        var at = e.target;
        if (at && at.closest && (at.closest('svg.inschart') || at.closest('.insrank'))) return;
        insightsCursor(null);
        hideInsightsTip();
      });
      var t = null;
      window.addEventListener('resize', function () {
        clearTimeout(t);
        t = setTimeout(function () { if (currentPage === 'insights') renderInsights(); }, 150);
      });
    }
  }

  function markInsightsChips() {
    var fleet = !!(ins.data && ins.data.scope === 'all');
    document.getElementById('insScopeWrap').style.display = ins.linked > 0 ? '' : 'none';
    ins.chips.forEach(function (c) {
      var on = c.group === 'range' ? c.key === ins.range : c.group === 'scope' ? c.key === insightsScope() : c.key === insightsSplit();
      c.btn.className = on ? 'chip sel' : 'chip';
      // "Machine" splits a sum of machines; one machine has nothing to split.
      if (c.fleet) c.btn.style.display = fleet ? '' : 'none';
    });
  }

  // The split drawn: "Machine" falls back to provider on one machine's data.
  function insightsSplit() {
    return ins.split === 'instance' && !(ins.data && ins.data.scope === 'all') ? 'provider' : ins.split;
  }

  // This machine's linked instances, from the picker's list. Gaining or
  // losing the first one changes what "All" means, so the page asks again.
  function setInsightsLinked(n) {
    if (ins.linked === n) return;
    ins.linked = n;
    if (ins.chips.length) markInsightsChips();
  }

  function pollInsights(force) {
    var scope = insightsScope();
    if (ins.inFlight || (scope === 'local' && peer && !peerChecked)) return;
    var want = ins.range + '|' + scope;
    // Throttled by when it last ASKED, not when it last succeeded: a proxy that
    // answers 404 or 500 would otherwise be asked again on every status poll.
    // A different range or scope from the last ask is asked for at once.
    if (!force && want === ins.asked && Date.now() - ins.at < INSIGHTS_REFRESH_MS) return;
    ins.at = Date.now();
    ins.asked = want;
    ins.inFlight = true;
    var range = ins.range;
    var url = '/teamclaude/insights?range=' + encodeURIComponent(range);
    fetch(scope === 'all' ? url + '&scope=all' : at(url), { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) { localStorage.removeItem(KEY); showKeybox(); return null; }
        // A linked instance on an older proxy has no history to read.
        if (res.status === 404) { ins.missing = true; return null; }
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (d) {
        if (d) {
          // A reply for a range or scope the page has since left is not
          // drawn; the finally below asks for the one it is on now.
          if (d.range !== ins.range || (d.scope === 'all') !== (insightsScope() === 'all')) return;
          // The minute's refresh usually brings back what is on screen; a
          // redraw then would only drop the tooltip being read.
          var text = JSON.stringify(d);
          if (text === ins.dataText && !ins.pending && !ins.missing && !ins.error) return;
          ins.dataText = text;
          ins.data = d;
          ins.missing = false;
          ins.pending = false;
        }
        ins.error = null;
        markInsightsChips();
        renderInsights();
      })
      .catch(function (e) { ins.error = e.message; ins.pending = false; renderInsights(); })
      .finally(function () { ins.inFlight = false; if (ins.range + '|' + insightsScope() !== want) pollInsights(true); });
  }

  function svgEl(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // Colours are CSS variables, which a presentation attribute does not
  // resolve; a style property does.
  function paint(n, fill, stroke) {
    if (fill) n.style.fill = fill;
    if (stroke) n.style.stroke = stroke;
    return n;
  }

  // A vertical gradient in a series' colour, from opacity top at its top
  // edge to bottom at its foot, as a fill reference. A stop-color attribute
  // does not resolve a CSS variable either, so the stops are styled too.
  function gradient(defs, color, top, bottom) {
    var id = 'insg' + (++insGrad);
    var g = svgEl('linearGradient', { id: id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    [[0, top], [1, bottom]].forEach(function (st) {
      var stop = svgEl('stop', { offset: st[0] }, g);
      stop.style.stopColor = color;
      stop.style.stopOpacity = String(st[1]);
    });
    return 'url(#' + id + ')';
  }

  function showInsightsTip(e, title, rows) {
    if (!insTip) { insTip = el('div', 'instip'); document.body.appendChild(insTip); }
    insTip.textContent = '';
    insTip.appendChild(el('div', 'tt', title));
    rows.forEach(function (r) {
      if (r.why) { insTip.appendChild(el('div', 'insrow why', r.why)); return; }
      var row = el('div', 'insrow' + (r.strong ? ' sum' : ''));
      var l = el('span');
      if (r.color) { var sw = el('i', 'insw'); sw.style.background = r.color; l.appendChild(sw); }
      l.appendChild(el('span', '', r.label));
      row.appendChild(l);
      row.appendChild(el('span', '', r.value));
      insTip.appendChild(row);
    });
    insTip.style.display = 'block';
    var x = e.clientX + 14;
    var y = e.clientY + 14;
    if (x + insTip.offsetWidth > window.innerWidth - 8) x = e.clientX - insTip.offsetWidth - 14;
    if (y + insTip.offsetHeight > window.innerHeight - 8) y = e.clientY - insTip.offsetHeight - 14;
    insTip.style.left = Math.max(4, x) + 'px';
    insTip.style.top = Math.max(4, y) + 'px';
  }

  function hideInsightsTip() { if (insTip) insTip.style.display = 'none'; }

  // One cursor across the page: hovering (or tapping) a day on the hero
  // chart marks it on the calendar, and a day on the calendar marks it on the
  // chart, so a dark square can be read against its stack and back.
  function insightsCursor(i) {
    ins.charts.forEach(function (c) { c.mark(i); });
  }

  // The tooltip handlers every drawn thing shares: a pointer over it shows its
  // reading, a finger lifting keeps it until a tap elsewhere.
  function tipOn(node, show, leave) {
    node.addEventListener('pointermove', show);
    node.addEventListener('pointerdown', show);
    node.addEventListener('pointerleave', function (e) { if (e.pointerType === 'touch') return; if (leave) leave(); hideInsightsTip(); });
  }

  // The legend as a table, the way monitoring tools draw it: each series with
  // its total, average, peak and latest bucket. A row hides or shows its
  // series; the last one shown cannot be hidden.
  function legendTable(host, series, fmt, from) {
    var tbl = el('table', 'inslegt');
    var hr = el('tr');
    ['', 'Total', 'Avg', 'Peak', 'Now'].forEach(function (h, i) { hr.appendChild(el('th', i ? 'num' + (i === 2 || i === 4 ? ' opt' : '') : '', h)); });
    tbl.appendChild(hr);
    var shown = series.filter(function (sr) { return !ins.hidden[sr.key]; }).length;
    series.forEach(function (sr) {
      var off = !!ins.hidden[sr.key];
      var st = seriesStats(sr.values, from);
      var tr = el('tr', off ? 'off' : '');
      var name = el('td', 'n');
      // A real button in the name cell, so the row stays a table row to a
      // screen reader; a click anywhere on the row does the same.
      var btn = el('button', 'inslegb');
      btn.type = 'button';
      btn.setAttribute('data-key', sr.key);
      ins.focusables['legend:' + sr.key] = btn;
      var sw = el('i', 'insl');
      sw.style.background = sr.color;
      btn.appendChild(sw);
      btn.appendChild(el('span', '', sr.label));
      name.appendChild(btn);
      tr.appendChild(name);
      // A series with tokens but no price is not a free one: it says so rather than $0.
      [st.total, st.avg, st.max, st.last].forEach(function (v, i) { tr.appendChild(el('td', 'num' + (i === 1 || i === 3 ? ' opt' : ''), sr.unpriced ? (i ? '—' : 'not priced') : fmt(v))); });
      if (series.length > 1) {
        tr.className += ' tog';
        btn.setAttribute('aria-pressed', off ? 'false' : 'true');
        btn.title = off ? 'Show ' + sr.label : 'Hide ' + sr.label;
        // The last series shown cannot be hidden.
        if (!off && shown <= 1) {
          btn.setAttribute('aria-disabled', 'true');
          btn.title = sr.label + ' stays shown: it is the only series left';
        }
        tr.addEventListener('click', function () {
          if (!off && shown <= 1) return;
          ins.hidden[sr.key] = !off;
          // The table is rebuilt: keep a keyboard user on the row they toggled.
          ins.focus = 'legend:' + sr.key;
          renderInsights();
        });
      } else {
        btn.disabled = true;
      }
      tbl.appendChild(tr);
    });
    var wrap = el('div', 'inslegw');
    wrap.appendChild(tbl);
    host.appendChild(wrap);
  }

  var INS_M = { l: 54, r: 12, t: 16, b: 22 };

  // The hero chart: the chosen metric per hour or day, stacked by the split,
  // or (o.view 'total') each series' running total stacked, so its right
  // edge lands on the headline. Bars carry a gradient that fades toward the
  // axis; the bucket still filling (this hour, today) is drawn faded, since
  // it is not a full one. Buckets before recording began (o.from) are shaded
  // as not recorded rather than drawn as idle. Per bucket, a line follows the
  // trend (insightsTrend) and the busiest bucket is labelled when it stands
  // out; as a running total, a dashed line marks what the whole period before
  // came to, so the line crossing it is the moment this period overtook the last.
  //   o: { view, height, fmt, axis, from, trend, ref: { value, label }|null,
  //        other: number[]|null, otherName, otherFmt, name }
  function drawHero(host, d, series, o) {
    var W = Math.max(260, host.clientWidth || 600);
    var H = o.height;
    var m = INS_M;
    var pw = W - m.l - m.r;
    var ph = H - m.t - m.b;
    var n = d.buckets.length;
    var band = pw / Math.max(1, n);
    var X = function (i) { return m.l + (i + 0.5) * band; };
    var shown = series.filter(function (sr) { return !ins.hidden[sr.key]; });
    if (!shown.length) shown = series;
    var total = o.view === 'total';
    var drawn = total ? shown.map(function (sr) { return { key: sr.key, label: sr.label, color: sr.color, values: runningTotals(sr.values) }; }) : shown;
    var cols = stackSeries(drawn, n);
    var max = 0;
    cols.forEach(function (c) { if (c.length) max = Math.max(max, c[c.length - 1][1]); });
    if (total && o.ref && o.ref.value > max) max = o.ref.value;
    // A range that spent nothing still gets four distinct gridline labels.
    var top = !(max > 0) ? 4 : niceCeil(max);
    var Y = function (v) { return m.t + ph - Math.min(v, top) / top * ph; };
    var s = svgEl('svg', { class: 'inschart', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': o.name }, host);
    var defs = svgEl('defs', {}, s);
    if (o.from > 0) {
      var gw = Math.min(n, o.from) * band;
      paint(svgEl('rect', { x: m.l, y: m.t, width: gw, height: ph, class: 'insnr' }, s), 'var(--panel2)');
      if (gw > 90) svgEl('text', { x: m.l + gw / 2, y: m.t + 14, 'text-anchor': 'middle', class: 'insref' }, s).textContent = 'not recorded';
    }
    // Every series left on show has no price: say so where the bars would be,
    // rather than let an empty plot read as $0.
    if (o.note) svgEl('text', { x: m.l + pw / 2, y: m.t + ph / 2, 'text-anchor': 'middle', class: 'insref' }, s).textContent = o.note;
    // Four bands of grid: dashed and faint, with a solid baseline.
    for (var g = 0; g <= 4; g++) {
      var gy = m.t + ph - ph * g / 4;
      var line = paint(svgEl('line', { x1: m.l, x2: W - m.r, y1: gy, y2: gy, 'stroke-width': 1 }, s), null, g ? 'var(--igrid)' : 'var(--iaxis)');
      if (g) line.setAttribute('stroke-dasharray', '3 3');
      svgEl('text', { x: m.l - 8, y: gy + 4, 'text-anchor': 'end' }, s).textContent = g ? o.axis(top * g / 4) : '0';
    }
    // Labels anchored on the latest bucket and stepped back from it, as far
    // apart as the widest label needs.
    var sample = insightsBucketLabel(d.buckets[n - 1], d.unit, false);
    var step = labelStep(sample.length, band);
    for (var li = n - 1; li >= 0; li -= step) {
      var lx = X(li);
      var half = sample.length * 3.3;
      if (lx - half < 2 || lx + half > W - 2) continue;
      svgEl('text', { x: lx, y: H - 6, 'text-anchor': 'middle' }, s).textContent = insightsBucketLabel(d.buckets[li], d.unit, false);
    }
    // The cursor's column, behind the marks.
    var hl = svgEl('rect', { y: m.t, height: ph, width: Math.max(1, band), rx: 3 }, s);
    paint(hl, 'var(--text)');
    hl.style.opacity = '0.07';
    hl.style.display = 'none';
    var fills = drawn.map(function (sr) { return total ? gradient(defs, sr.color, 0.55, 0.04) : gradient(defs, sr.color, 1, 0.5); });
    if (!total || n === 1) {
      var gap = band >= 6 ? Math.min(8, band * 0.28) : band >= 3 ? 1 : 0;
      // Under a pixel a bucket, a bar is its band: a year on a phone.
      var bw = band >= 1 ? Math.max(1, band - gap) : band;
      for (var bi = 0; bi < n; bi++) {
        var into = bi === n - 1 ? svgEl('g', { class: 'insnow' }, s) : s;
        for (var si = 0; si < drawn.length; si++) {
          var lo = cols[bi][si][0];
          var hi = cols[bi][si][1];
          if (!(hi > lo)) continue;
          var y0 = Y(hi);
          svgEl('rect', { x: m.l + bi * band + gap / 2, y: y0, width: bw, height: Math.max(1, Y(lo) - y0 - (si ? 1 : 0)), fill: fills[si] }, into);
        }
      }
    } else {
      drawn.forEach(function (sr, k) {
        var up = '';
        var down = '';
        for (var i = 0; i < n; i++) {
          up += (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(cols[i][k][1]).toFixed(1);
          down = 'L' + X(i).toFixed(1) + ',' + Y(cols[i][k][0]).toFixed(1) + down;
        }
        svgEl('path', { d: up + down + 'Z', fill: fills[k] }, s);
        paint(svgEl('path', { d: up, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round' }, s), null, sr.color);
      });
      var last = cols[n - 1];
      if (last.length) paint(svgEl('circle', { cx: X(n - 1), cy: Y(last[last.length - 1][1]), r: 3.5, 'stroke-width': 2 }, s), drawn[drawn.length - 1].color, 'var(--panel)');
    }
    var refLine = function (v, text, left) {
      var y = Y(v);
      var ln = paint(svgEl('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, 'stroke-width': 1.25, 'stroke-dasharray': '6 4' }, s), null, 'var(--text)');
      ln.style.opacity = '0.55';
      var tx = svgEl('text', { x: left ? m.l + 6 : W - m.r, y: y - 5, 'text-anchor': left ? 'start' : 'end', class: 'insref' }, s);
      tx.textContent = text;
    };
    if (total && o.ref) refLine(o.ref.value, o.ref.label, true);
    if (!total && o.trend) {
      var tp = '';
      var pen = false;
      o.trend.values.forEach(function (v, i) {
        if (v == null) { pen = false; return; }
        tp += (pen ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1);
        pen = true;
      });
      if (tp) {
        // A halo in the card's colour keeps the line readable across the bars.
        var halo = paint(svgEl('path', { d: tp, fill: 'none', 'stroke-width': 5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, s), null, 'var(--panel)');
        halo.style.opacity = '0.8';
        paint(svgEl('path', { d: tp, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, s), null, 'var(--text)');
        svgEl('text', { x: W - m.r, y: Y(o.trend.last) - 8, 'text-anchor': 'end', class: 'insref' }, s).textContent = o.trend.label + ' ' + o.fmt(o.trend.last);
      }
    }
    // One direct label, on the bucket that stands out; the rest are read off
    // the axis, the tooltip or the table.
    var pk = total ? null : peakBucket(cols.map(function (c) { return c.length ? c[c.length - 1][1] : 0; }), o.from);
    if (pk && n >= 7 && pk.ratio != null && pk.ratio >= 1.5) {
      var px = X(pk.index);
      svgEl('text', { x: px, y: Math.max(m.t + 10, Y(pk.value) - 6), 'text-anchor': px < m.l + 70 ? 'start' : px > W - m.r - 70 ? 'end' : 'middle', class: 'insref inspeak' }, s)
        .textContent = insightsBucketLabel(d.buckets[pk.index], d.unit, false) + ' · ' + o.fmt(pk.value);
    }
    // The shared cursor in the running total: a dot where it crosses each line.
    var dots = total ? drawn.map(function (sr) {
      var c = svgEl('circle', { r: 3, 'stroke-width': 2 }, s);
      paint(c, sr.color, 'var(--panel)');
      c.style.display = 'none';
      return c;
    }) : [];
    ins.charts.push({
      mark: function (i) {
        var off = i == null || i >= n;
        hl.style.display = off ? 'none' : '';
        dots.forEach(function (c, k) {
          c.style.display = off ? 'none' : '';
          if (!off) { c.setAttribute('cx', X(i)); c.setAttribute('cy', Y(cols[i][k][1])); }
        });
        if (!off) hl.setAttribute('x', m.l + i * band);
      },
    });
    var hit = svgEl('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' }, s);
    var at = function (e) {
      var box = s.getBoundingClientRect();
      return bucketAt(e.clientX - box.left - m.l, band, n);
    };
    tipOn(hit, function (e) {
      var i = at(e);
      insightsCursor(i);
      var title = insightsBucketLabel(d.buckets[i], d.unit, true) + (i === n - 1 ? ' (so far)' : '');
      if (i < (o.from || 0)) { showInsightsTip(e, title, [{ why: 'Before recording began: not idle, not recorded.' }]); return; }
      var none = shown.every(function (sr) { return sr.unpriced; });
      // The rows read like the marks under the pointer: each series' own
      // stack, which as a running total is its sum so far, then the total.
      var rows = shown.map(function (sr, k) { return { label: sr.label, value: sr.unpriced ? 'not priced' : o.fmt(drawn[k].values[i] || 0), color: sr.color }; }).reverse();
      var sum = shown.reduce(function (x, sr) { return x + (sr.values[i] || 0); }, 0);
      if (total) {
        rows.push({ label: 'Running total', value: none ? 'not priced' : o.fmt(cols[i].length ? cols[i][cols[i].length - 1][1] : 0), strong: true });
        rows.push({ label: 'This ' + (d.unit === 'hour' ? 'hour' : 'day'), value: none ? 'not priced' : o.fmt(sum) });
      } else if (shown.length > 1) {
        rows.push({ label: 'Total', value: none ? 'not priced' : o.fmt(sum), strong: true });
      }
      if (o.other) rows.push({ label: o.otherName + (total ? ' this ' + (d.unit === 'hour' ? 'hour' : 'day') : ''), value: o.otherFmt(o.other[i] || 0) });
      showInsightsTip(e, title, rows);
    }, function () { insightsCursor(null); });
  }

  // The range's days as a calendar (calendarGrid), each square in the
  // metric's colour at one of four strengths, with each weekday's average
  // full day beside it. The squares are sized to the card, so a week does not
  // sprawl across a monitor; when even the smallest squares would not fit
  // (a year on a phone), the latest weeks that do are drawn and a line says
  // so, rather than the card scrolling sideways. The Table has every day.
  function drawCalendar(host, d, values, mt) {
    var cal = calendarGrid(d, values);
    var wrap = el('div', 'inscal');
    host.appendChild(wrap);
    var room = Math.max(160, host.clientWidth || 600);
    var side = room >= 560 ? 220 : 0;
    var lw = 30;
    // The smallest square is 5px with a 2px gap.
    var fit = Math.max(1, Math.floor((room - side - lw) / 7));
    var shown = cal.weeks.length > fit ? cal.weeks.slice(cal.weeks.length - fit) : cal.weeks;
    var weeks = Math.max(1, shown.length);
    var cell = Math.max(5, Math.min(18, Math.floor((room - side - lw) / weeks) - 3));
    var gap = cell >= 10 ? 3 : 2;
    var stepx = cell + gap;
    var mt0 = 16;
    var W = lw + weeks * stepx;
    var H = mt0 + 7 * stepx;
    var s = svgEl('svg', { class: 'inschart', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'By day' }, wrap);
    [0, 2, 4].forEach(function (r) {
      svgEl('text', { x: 0, y: mt0 + r * stepx + cell - 1 }, s).textContent = cal.weekdays[r].label;
    });
    // Each strength is a CSS variable, so the dark theme can lift the faintest
    // clear of the idle squares' colour.
    var shades = ['var(--ish1)', 'var(--ish2)', 'var(--ish3)', '1'];
    var pos = [];
    // A month's name over the week that holds its 1st (and over the first
    // week drawn, for the month it starts in). They are placed from the latest
    // back, the last one held inside the edge, so on a narrow card the recent
    // months keep their names and an older one gives way when two would touch.
    var marks = [];
    shown.forEach(function (week, wi) {
      var firstOf = week.filter(function (c) { return c && (wi === 0 || c.key.slice(8) === '01'); })[0];
      if (firstOf) marks.push({ x: lw + wi * stepx, key: firstOf.key });
    });
    // The right edge the next label must end before, with its 4px of space.
    var room0 = W + 4;
    marks.reverse().forEach(function (mk, k) {
      var name = new Date(Number(mk.key.slice(0, 4)), Number(mk.key.slice(5, 7)) - 1, 1).toLocaleDateString([], { month: 'short' });
      var wide = name.length * 6.5;
      var x = k === 0 ? Math.min(mk.x, W - wide) : mk.x;
      if (x + wide + 4 > room0 || x < 0) return;
      svgEl('text', { x: x, y: 10 }, s).textContent = name;
      room0 = x;
    });
    shown.forEach(function (week, wi) {
      var x = lw + wi * stepx;
      week.forEach(function (c, r) {
        if (!c) return;
        var y = mt0 + r * stepx;
        var sq = svgEl('rect', { class: 'day', x: x, y: y, width: cell, height: cell, rx: Math.min(3, cell / 4) }, s);
        if (c.level < 0) {
          paint(sq, 'transparent', 'var(--iaxis)');
          sq.setAttribute('stroke-dasharray', '2 2');
        } else if (c.level === 0) {
          paint(sq, 'var(--track)');
        } else {
          paint(sq, mt.color);
          sq.style.fillOpacity = shades[c.level - 1];
        }
        // Today is outlined solid: a dashed edge is what the key uses for not recorded.
        if (c.today) { sq.style.stroke = 'var(--text)'; sq.setAttribute('stroke-width', 1.25); }
        pos[c.i] = { x: x, y: y };
        tipOn(sq, function (e) {
          insightsCursor(c.i);
          showInsightsTip(e, insightsBucketLabel(c.key, 'day', true) + (c.today ? ' (so far)' : ''), c.level < 0
            ? [{ why: 'Before recording began: not idle, not recorded.' }]
            : [{ label: mt.name, value: mt.fmt(c.value), color: mt.color }]);
        }, function () { insightsCursor(null); });
      });
    });
    var ring = svgEl('rect', { width: cell + 2, height: cell + 2, rx: Math.min(4, cell / 3), fill: 'none', 'stroke-width': 1.5 }, s);
    paint(ring, null, 'var(--text)');
    ring.style.display = 'none';
    ring.style.pointerEvents = 'none';
    ins.charts.push({
      mark: function (i) {
        var p = i == null ? null : pos[i];
        ring.style.display = p ? '' : 'none';
        if (p) { ring.setAttribute('x', p.x - 1); ring.setAttribute('y', p.y - 1); }
      },
    });
    var wk = el('div', 'inswk');
    wk.appendChild(el('div', 'h', 'Average full day'));
    var top = cal.weekdays.reduce(function (x, w) { return Math.max(x, w.avg || 0); }, 0);
    cal.weekdays.forEach(function (w) {
      wk.appendChild(el('span', 'k', w.label));
      var t = el('div', 't');
      var f = el('i');
      f.style.width = (top > 0 && w.avg ? Math.max(1, w.avg / top * 100) : 0) + '%';
      f.style.background = mt.color;
      t.appendChild(f);
      wk.appendChild(t);
      wk.appendChild(el('span', 'x', w.avg == null ? '—' : mt.fmt(w.avg)));
    });
    wrap.appendChild(wk);
    var key = el('div', 'inskey');
    key.appendChild(el('span', '', 'Less'));
    var zero = el('i');
    zero.style.background = 'var(--track)';
    key.appendChild(zero);
    shades.forEach(function (op) {
      var sw = el('i');
      sw.style.background = mt.color;
      sw.style.opacity = op;
      key.appendChild(sw);
    });
    key.appendChild(el('span', '', 'More'));
    var nr = el('i', 'nr');
    key.appendChild(nr);
    key.appendChild(el('span', '', 'not recorded'));
    host.appendChild(key);
    if (shown.length < cal.weeks.length) host.appendChild(el('p', 'hint insmore', 'The latest ' + shown.length + ' of ' + cal.weeks.length + ' weeks fit here; the Table has every day.'));
  }

  // Calendar months as bars (monthTotals): what each came to, and for the
  // month still running, a dashed extension up to where it is on pace to end.
  // A month the range or recording starts part-way through says from when.
  function drawMonths(host, months, mt) {
    var W = Math.max(220, host.clientWidth || 400);
    var H = 190;
    var m = { l: 6, r: 6, t: 22, b: 34 };
    var n = months.length;
    var band = (W - m.l - m.r) / Math.max(1, n);
    var bw = Math.max(4, Math.min(64, band * 0.62));
    var max = months.reduce(function (x, mo) { return Math.max(x, mo.total, mo.projected || 0); }, 0);
    var widest = months.reduce(function (x, mo) { return Math.max(x, mo.label.length * 6.5 + 8); }, 0);
    var every = Math.max(1, Math.ceil(widest / band));
    var ph = H - m.t - m.b;
    var Y = function (v) { return m.t + ph - (max > 0 ? v / max * ph : 0); };
    var s = svgEl('svg', { class: 'inschart', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'By month' }, host);
    var defs = svgEl('defs', {}, s);
    var fill = gradient(defs, mt.color, 1, 0.55);
    paint(svgEl('line', { x1: m.l, x2: W - m.r, y1: m.t + ph, y2: m.t + ph, 'stroke-width': 1 }, s), null, 'var(--iaxis)');
    months.forEach(function (mo, i) {
      var cx = m.l + (i + 0.5) * band;
      var x = cx - bw / 2;
      if (mo.projected != null && mo.projected > mo.total) {
        var pr = svgEl('rect', { x: x + 0.5, y: Y(mo.projected), width: bw - 1, height: Math.max(1, Y(mo.total) - Y(mo.projected)), rx: 3, 'stroke-width': 1.25, 'stroke-dasharray': '4 3' }, s);
        paint(pr, mt.color, mt.color);
        pr.style.fillOpacity = '0.12';
      }
      if (mo.total > 0) svgEl('rect', { x: x, y: Y(mo.total), width: bw, height: Math.max(1, Y(0) - Y(mo.total)), rx: 3, fill: fill, class: mo.from ? 'insnow' : '' }, s);
      // Values over the bars where they fit; the tooltip has every one.
      if (band >= 40 || i === n - 1) {
        var lab = svgEl('text', { x: cx, y: Y(Math.max(mo.total, mo.projected || 0)) - 6, 'text-anchor': 'middle' }, s);
        // The pace headline's own text, so the two never disagree.
        lab.textContent = mo.projectedText != null ? '≈ ' + mo.projectedText : mt.axis(mo.total);
        if (mo.projected == null) lab.style.fill = 'var(--text)';
      }
      // A name every few months (every), counted back from the latest, so on a
      // narrow card a year of them thins out instead of running together.
      if ((n - 1 - i) % every === 0) svgEl('text', { x: cx, y: H - 18, 'text-anchor': 'middle' }, s).textContent = mo.label;
      var note = mo.current ? (mo.projected != null ? 'so far' : 'to date') : mo.from ? 'from ' + Number(mo.from.slice(8)) : '';
      if (note && band >= 34) svgEl('text', { x: cx, y: H - 5, 'text-anchor': 'middle', class: 'insref' }, s).textContent = note;
    });
    // Each month's hover area goes on top of its bar, projection and labels,
    // or the marks would take the pointer and the tooltip never open.
    months.forEach(function (mo, i) {
      var hl = svgEl('rect', { x: m.l + i * band + 1, y: m.t - 18, width: Math.max(1, band - 2), height: ph + 18, rx: 4, fill: 'transparent' }, s);
      tipOn(hl, function (e) {
        var rows = [{ label: mo.current ? 'So far' : 'Total', value: mt.fmt(mo.total), color: mt.color }, { label: 'Days counted', value: String(mo.days) }];
        if (mo.projectedText != null) rows.push({ label: 'On pace for', value: mo.projectedText, strong: true }, { why: 'Projected from the last full days; not a measurement.' });
        if (mo.from && !mo.current) rows.push({ why: 'Counted from ' + insightsBucketLabel(mo.from, 'day', false) + ': the range or the history starts there.' });
        showInsightsTip(e, mo.long, rows);
      });
    });
  }

  // A share as it reads at a glance: one decimal under 10%, whole above.
  function pctOf(f) {
    var p = f * 100;
    return (p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)) + '%';
  }

  // One account's bucket-by-bucket bars, on the scale every account in the
  // list shares (max), so a quiet account looks quiet next to a busy one and
  // a lopsided rotation shows at a glance. It carries the page's cursor: the
  // bucket under the pointer is marked on the hero, the calendar and every
  // other account.
  function accountSpark(host, d, r, max, fmt) {
    var W = Math.max(80, host.clientWidth || 200);
    var H = 26;
    var n = d.buckets.length;
    var band = W / Math.max(1, n);
    var bw = band >= 3 ? band - 1 : band;
    var s = svgEl('svg', { class: 'inschart', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true' }, host);
    paint(svgEl('line', { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5, 'stroke-width': 1 }, s), null, 'var(--igrid)');
    var path = '';
    r.values.forEach(function (v, i) {
      if (!(v > 0) || !(max > 0)) return;
      var h = Math.max(1, v / max * (H - 2));
      path += 'M' + (i * band).toFixed(1) + ',' + H + 'v' + (-h).toFixed(1) + 'h' + bw.toFixed(1) + 'v' + h.toFixed(1) + 'Z';
    });
    if (path) paint(svgEl('path', { d: path }, s), r.color);
    var column = paint(svgEl('rect', { y: 0, height: H, width: Math.max(1, band) }, s), 'var(--text)');
    column.style.opacity = '0.16';
    column.style.display = 'none';
    ins.charts.push({
      mark: function (i) {
        column.style.display = i == null || i >= n ? 'none' : '';
        if (i != null) column.setAttribute('x', i * band);
      },
    });
    var from = recordedFrom(d);
    var move = function (e) {
      // The row under it has its own tooltip; this one is the bucket's.
      e.stopPropagation();
      var i = bucketAt(e.clientX - s.getBoundingClientRect().left, band, n);
      insightsCursor(i);
      showInsightsTip(e, insightsBucketLabel(d.buckets[i], d.unit, true) + (i === n - 1 ? ' (so far)' : ''), i < from
        ? [{ why: 'Before recording began: not idle, not recorded.' }]
        : [{ label: r.label, value: fmt(r.values[i] || 0), color: r.color }]);
    };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerdown', move);
    s.addEventListener('pointerleave', function (e) { if (e.pointerType === 'touch') return; insightsCursor(null); hideInsightsTip(); });
  }

  // "Where it went": the top rows of breakdownRows as ranked bars of the
  // chosen metric, each with the other metric and the cost of a million of
  // its tokens beside it. Accounts get their own small chart over the range
  // in place of the bar (accountSpark). Hovering a row shows everything
  // known about it.
  function drawBreakdown(host, d, rows, metric) {
    var byCost = metric === 'cost';
    var fmt = byCost ? fmtUsd : fmtTokens;
    var max = rows.reduce(function (x, r) { return Math.max(x, byCost ? r.cost || 0 : r.tokens); }, 0);
    var top = rows.slice(0, INS_BY_ROWS);
    var sparkMax = 0;
    top.forEach(function (r) { (r.values || []).forEach(function (v) { if (v > sparkMax) sparkMax = v; }); });
    var sparks = [];
    if (!rows.length) host.appendChild(el('p', 'hint', 'Nothing in this range.'));
    top.forEach(function (r) {
      var value = byCost ? r.cost : r.tokens;
      var row = el('div', 'insrank' + (value == null ? ' np' : ''));
      var name = el('div', 'n');
      var sw = el('i');
      sw.style.background = r.color;
      name.appendChild(sw);
      var who = el('span');
      var b = el('b', '', r.label);
      b.title = r.label;
      who.appendChild(b);
      if (r.group) who.appendChild(el('small', '', r.group));
      name.appendChild(who);
      row.appendChild(name);
      if (r.values && d.buckets.length > 1) {
        var sp = el('div', 'sp');
        row.appendChild(sp);
        sparks.push({ host: sp, row: r });
      } else {
        var t = el('div', 't');
        var f = el('i');
        f.style.width = (value != null && max > 0 ? Math.max(0.5, value / max * 100) : 0) + '%';
        f.style.background = r.color;
        t.appendChild(f);
        row.appendChild(t);
      }
      row.appendChild(el('span', 'v', byCost ? (r.cost == null ? 'not priced' : fmtUsd(r.cost)) : fmtTokens(r.tokens)));
      var aux = byCost
        ? fmtTokens(r.tokens) + ' tokens' + (r.perMillion != null ? ' · ' + fmtUsd(r.perMillion) + '/M' : '')
        : (r.share != null ? pctOf(r.share) + ' · ' : '') + (r.cost == null ? 'not priced' : fmtUsd(r.cost));
      row.appendChild(el('span', 'a', aux));
      tipOn(row, function (e) {
        var tip = [
          { label: 'Est. API cost', value: r.cost == null ? 'not priced' : fmtUsd(r.cost) },
          { label: 'Tokens', value: fmtTokens(r.tokens) },
          { label: 'Requests', value: Math.round(r.requests).toLocaleString() },
          { label: 'Per million tokens', value: r.perMillion == null ? '—' : fmtUsd(r.perMillion) },
        ];
        if (r.hit != null) tip.push({ label: 'Cache hit', value: (r.hit * 100).toFixed(1) + '%' });
        if (r.share != null) tip.push({ label: 'Share of the ' + (byCost ? 'cost' : 'tokens'), value: pctOf(r.share), strong: true });
        showInsightsTip(e, r.label + (r.group ? ' · ' + r.group : ''), tip);
      });
      host.appendChild(row);
    });
    // On the page before the small charts go in: each measures its cell.
    sparks.forEach(function (sp) { accountSpark(sp.host, d, sp.row, sparkMax, fmt); });
    if (sparks.length) host.appendChild(el('p', 'hint insmore', 'Each account ' + (d.unit === 'hour' ? 'hour' : 'day') + ' by ' + (d.unit === 'hour' ? 'hour' : 'day') + ', all on one scale.'));
    if (rows.length > INS_BY_ROWS) host.appendChild(el('p', 'hint insmore', (rows.length - INS_BY_ROWS) + ' more in the Table view.'));
  }

  // A row of mutually exclusive buttons inside a card's header. Picking one
  // redraws the page, so the button picked is focused again afterwards.
  function segmented(host, group, options, current, pick) {
    var seg = el('div', 'inseg');
    options.forEach(function (o) {
      var key = 'seg:' + group + ':' + o.key;
      var b = button(o.key === current ? 'sel' : '', o.label, function () { if (o.key === current) return; ins.focus = key; pick(o.key); });
      b.setAttribute('aria-pressed', o.key === current ? 'true' : 'false');
      ins.focusables[key] = b;
      seg.appendChild(b);
    });
    host.appendChild(seg);
  }

  // A chart card with a Table button: every chart can be read as numbers too,
  // which is also what a reader who cannot tell the colours apart falls back
  // on. o.tools adds controls beside the button; o.bare draws into
  // parent without a card of its own (the hero is already one).
  function insightsCard(parent, key, title, sub, draw, table, o) {
    o = o || {};
    var card = el('div', o.bare ? '' : 'card');
    parent.appendChild(card);
    var head = el('div', 'insh');
    var t = el('div');
    t.appendChild(el('b', '', title));
    t.appendChild(el('span', 's', sub));
    head.appendChild(t);
    var tools = el('div', 'instools');
    if (o.tools) o.tools(tools);
    if (table) {
      var tb = button('btn', ins.tables[key] ? 'Chart' : 'Table', function () { ins.tables[key] = !ins.tables[key]; ins.focus = 'table:' + key; renderInsights(); });
      ins.focusables['table:' + key] = tb;
      tools.appendChild(tb);
    }
    head.appendChild(tools);
    card.appendChild(head);
    var body = el('div');
    card.appendChild(body);
    if (!table || !ins.tables[key]) { draw(body); return card; }
    var spec = table();
    var wrap = el('div', 'instv');
    var tbl = el('table');
    var hr = el('tr');
    spec.cols.forEach(function (c, i) { hr.appendChild(el('th', i ? 'num' : '', c)); });
    tbl.appendChild(hr);
    spec.rows.forEach(function (r) {
      var tr = el('tr');
      r.forEach(function (c, i) { tr.appendChild(el('td', i ? 'num' : '', c)); });
      tbl.appendChild(tr);
    });
    wrap.appendChild(tbl);
    body.appendChild(wrap);
    return card;
  }

  // The hero's headlines: the estimated cost and the tokens, each a tab
  // that picks the metric every chart draws, and the pace of the one picked.
  function heroHeads(card, d, metric) {
    var heads = el('div', 'insheads');
    ['cost', 'tokens'].forEach(function (k) {
      var h = insightsHeadline(d, k);
      var mt = INS_METRICS[k];
      // A cost with no estimate (costEstimated) has no tab to pick.
      var can = k === 'tokens' || costEstimated(d);
      var b = el(can ? 'button' : 'div', 'inshead' + (k === metric ? ' sel' : ''));
      b.style.cssText = '--hc: ' + mt.color;
      if (can) {
        b.type = 'button';
        b.setAttribute('aria-pressed', k === metric ? 'true' : 'false');
        b.title = 'Draw the ' + (k === 'cost' ? 'estimated API cost' : 'tokens') + ' on every chart';
        b.addEventListener('click', function () {
          if (ins.metric === k) return;
          ins.metric = k;
          localStorage.setItem(INS_METRIC_KEY, k);
          ins.focus = 'metric:' + k;
          renderInsights();
        });
        ins.focusables['metric:' + k] = b;
      }
      var l = el('span', 'l');
      l.appendChild(el('i'));
      l.appendChild(el('span', '', h.label));
      b.appendChild(l);
      b.appendChild(el('span', 'v', h.text));
      var dl = el('span', 'd');
      if (h.change) dl.appendChild(el('span', 'inspill', h.change));
      dl.appendChild(el('span', '', h.vs));
      b.appendChild(dl);
      if (h.note) b.appendChild(el('span', 'n', h.note));
      heads.appendChild(b);
    });
    var pace = insightsPace(d, metric);
    var pc = el('div', 'inshead inspace');
    pc.style.cssText = '--hc: ' + INS_METRICS[metric].color;
    var pl = el('span', 'l');
    pl.appendChild(el('span', '', pace ? pace.label : 'Pace'));
    if (pace && pace.kind !== 'peak') pl.appendChild(el('span', 'insproj', 'projected'));
    pc.appendChild(pl);
    pc.appendChild(el('span', 'v', pace ? pace.text : '—'));
    pc.appendChild(el('span', 'd', pace ? pace.sub : d.unit === 'hour' ? 'nothing spent in these hours' : 'needs a full day on record'));
    if (pace && pace.against) pc.appendChild(el('span', 'd', pace.against));
    if (pace) pc.appendChild(el('span', 'n', pace.how));
    heads.appendChild(pc);
    card.appendChild(heads);
  }

  // What the page was last drawn against: whether it could measure itself, and
  // the accounts the account split colours by. The status poll redraws when
  // either changes, rather than on every poll, which would drop a tooltip
  // being read.
  function insightsDrawnKey() {
    var body = document.getElementById('insBody');
    var accounts = (lastStatus && lastStatus.accounts) || [];
    return (body.clientWidth > 0 ? 'w' : '-') + '|' + accounts.map(function (a) { return accountGroup(a) + '/' + a.name; }).join('|');
  }

  // Every redraw rebuilds the page's controls, so the one a keyboard user just
  // pressed (ins.focus, a key in ins.focusables) is focused again afterwards,
  // as the legend rows already are.
  function renderInsights() {
    // A redraw nobody asked for (a resize, the minute's refresh, a status
    // change) keeps the focus where it was, if it was on one of these controls.
    var active = typeof document !== 'undefined' ? document.activeElement : null;
    if (!ins.focus && active) for (var k in ins.focusables) if (ins.focusables[k] === active) { ins.focus = k; break; }
    ins.focusables = Object.create(null);
    drawInsights();
    var again = ins.focus ? ins.focusables[ins.focus] : null;
    ins.focus = null;
    if (again && again.focus) again.focus();
  }

  function drawInsights() {
    hideInsightsTip();
    ins.charts = [];
    ins.drawn = insightsDrawnKey();
    var note = document.getElementById('insNote');
    var body = document.getElementById('insBody');
    var d = ins.data;
    var msg = ins.missing ? 'This instance runs an older proxy that keeps no usage history. Update it to see Insights.'
      : ins.error ? 'Could not load insights: ' + ins.error
      : !d ? 'Loading…'
      : d.since == null ? 'Nothing recorded yet. Insights fill in as requests go through the proxy, starting with the first one this version serves.'
      : null;
    note.textContent = msg || '';
    note.style.display = msg ? '' : 'none';
    body.textContent = '';
    body.style.opacity = ins.pending ? '0.55' : '';
    if (!d || ins.missing || d.since == null) return;
    var accounts = (lastStatus && lastStatus.accounts) || [];
    var metric = insightsMetric(d);
    var mt = INS_METRICS[metric];
    var other = metric === 'cost' ? 'tokens' : 'cost';
    var ot = INS_METRICS[other];
    var when = function (b) { return insightsBucketLabel(b, d.unit, true); };
    var num = function (v) { return Math.round(v).toLocaleString(); };
    var rangeText = insightsRangeText(d.range);
    var hourly = d.unit === 'hour';
    var perBucket = hourly ? 'per hour' : 'per day';
    var values = insightsTotals(d, metric) || [];
    var otherValues = insightsTotals(d, other);
    var fleet = d.scope === 'all';
    var from = recordedFrom(d);

    // The hero: the two headlines, then the chosen one over time.
    var hero = el('div', 'card inshero');
    body.appendChild(hero);
    heroHeads(hero, d, metric);
    var hb = el('div', 'insherob');
    hero.appendChild(hb);
    var splitKey = insightsSplit();
    var split = INS_SPLITS.filter(function (o) { return o.key === splitKey; })[0];
    var series = insightsSeries(d, splitKey, accounts, metric);
    // Token types and machines have no cost of their own per bucket, nor
    // does a proxy too old to send it: those draw the total in one colour.
    var oneTotal = !series.length;
    if (oneTotal) series = [{ key: metric, label: mt.name, color: mt.color, values: values, total: values.reduce(function (x, y) { return x + y; }, 0) }];
    // Only the series this split and range have can be hidden, and never all
    // of them: the chart, its legend and the panels under it agree on which.
    var keys = series.map(function (sr) { return sr.key; });
    Object.keys(ins.hidden).forEach(function (k) { if (keys.indexOf(k) < 0) delete ins.hidden[k]; });
    if (keys.length && keys.every(function (k) { return ins.hidden[k]; })) ins.hidden = Object.create(null);
    var anyHidden = keys.some(function (k) { return ins.hidden[k]; });
    if (metric === 'cost' && !oneTotal) {
      var tokenTotals = Object.create(null);
      insightsSeries(d, splitKey, accounts).forEach(function (sr) { tokenTotals[sr.key] = sr.total; });
      series.forEach(function (sr) { sr.unpriced = !(sr.total > 0) && tokenTotals[sr.key] > 0; });
    }
    var running = ins.view === 'total';
    var heroTitle = running ? 'Running total of the ' + (metric === 'cost' ? 'estimated API cost' : 'tokens')
      : (metric === 'cost' ? 'Estimated API cost ' : 'Tokens ') + perBucket;
    var heroSub = (oneTotal ? (splitKey === 'provider' || splitKey === 'account' ? 'one total' : 'one total: ' + split.text + 's have no cost of their own')
      : 'stacked by ' + split.text + (series.length > 1 ? ' · click a row to hide it' : '')) + ' · ' + rangeText;
    var prevTotal = metric === 'cost' ? (d.cost ? d.cost.previous : null)
      : d.previous ? d.previous.input + d.previous.output + d.previous.cacheRead + d.previous.cacheWrite : null;
    // With every priced series hidden, what is left has no cost to draw: no
    // trend (it would read "$0") and a note in the plot instead of bars.
    var nonePriced = metric === 'cost' && series.length > 0 && series.every(function (sr) { return ins.hidden[sr.key] || sr.unpriced; });
    // The trend follows the series shown, so hiding one takes it out of the line too.
    var shownSum = values.map(function (_, i) { return series.reduce(function (x, sr) { return x + (ins.hidden[sr.key] ? 0 : sr.values[i] || 0); }, 0); });
    insightsCard(hb, 'hero', heroTitle, heroSub, function (host) {
      var narrow = (host.clientWidth || 600) < 520;
      drawHero(host, d, series, {
        view: running ? 'total' : 'daily', height: narrow ? 210 : 280, name: heroTitle, fmt: mt.fmt, axis: mt.axis,
        from: from, trend: nonePriced ? null : insightsTrend(shownSum, d.unit, from), note: nonePriced ? 'not priced: no list price for the series shown' : null,
        // The period before, as one figure: only against everything, not a part of it.
        ref: prevTotal != null && prevTotal > 0 && !anyHidden ? { value: prevTotal, label: 'previous ' + (hourly ? '24 hours' : parseInt(d.range, 10) + ' days') + ': ' + mt.fmt(prevTotal) } : null,
        other: otherValues, otherName: ot.name, otherFmt: ot.fmt,
      });
      legendTable(host, series, mt.fmt, from);
    }, function () {
      // The numbers of the view picked: a running total reads as one, and a
      // bucket from before recording began or a series with no price says so.
      var view = function (vals) { return running ? runningTotals(vals) : vals; };
      var many = series.length > 1;
      var cells = series.map(function (sr) { return view(sr.values); });
      var tot = view(values);
      var oth = otherValues ? view(otherValues) : null;
      var suffix = running ? ' (running total)' : '';
      var allUnpriced = series.every(function (sr) { return sr.unpriced; });
      return {
        cols: ['When'].concat(many ? series.map(function (sr) { return sr.label + suffix; }) : [], [mt.name + suffix], oth ? [ot.name + suffix] : []),
        rows: d.buckets.map(function (b, i) {
          if (i < from) return [when(b)].concat(many ? series.map(function () { return 'not recorded'; }) : [], ['not recorded'], oth ? ['not recorded'] : []);
          return [when(b)].concat(many ? series.map(function (sr, k) { return sr.unpriced ? 'not priced' : mt.fmt(cells[k][i] || 0); }) : [],
            [allUnpriced ? 'not priced' : mt.fmt(tot[i])], oth ? [ot.fmt(oth[i])] : []);
        }).reverse(),
      };
    }, { bare: true, tools: function (tools) {
      segmented(tools, 'view', [{ key: 'daily', label: hourly ? 'Per hour' : 'Per day' }, { key: 'total', label: 'Running total' }], running ? 'total' : 'daily', function (k) { ins.view = k; renderInsights(); });
    } });

    var missed = fleet ? fleetMissingText(d) : null;
    if (missed) body.appendChild(el('p', 'sub', missed));

    // By day and by month: patterns over weeks and months, or one line saying
    // what they need (calendarNote).
    var calNote = calendarNote(d);
    if (calNote) {
      body.appendChild(el('p', 'hint insshort', calNote));
    } else {
      var months = monthTotals(d, metric);
      var showMonths = months.length > 1 || (months.length === 1 && months[0].projected != null);
      var row = el('div', 'insgrid' + (showMonths ? '' : ' one'));
      body.appendChild(row);
      insightsCard(row, 'calendar', 'By day', (metric === 'cost' ? 'estimated API cost' : 'tokens') + ' each day, ' + rangeText + ' · shaded by quarter of active days', function (host) {
        drawCalendar(host, d, values, mt);
      }, function () {
        return { cols: ['Day', mt.name].concat(otherValues ? [ot.name] : []),
          rows: d.buckets.map(function (b, i) { return [when(b), i < from ? 'not recorded' : mt.fmt(values[i])].concat(otherValues ? [i < from ? '' : ot.fmt(otherValues[i])] : []); }).reverse() };
      });
      if (showMonths) {
        insightsCard(row, 'months', 'By month', 'calendar months in the range' + (months[months.length - 1].projected != null ? ' · dashed: projected' : ''), function (host) {
          drawMonths(host, months, mt);
        }, function () {
          return { cols: ['Month', mt.name, 'Days counted', 'On pace for'],
            rows: months.slice().reverse().map(function (mo) {
              return [mo.long + (mo.from && !mo.current ? ' (from ' + insightsBucketLabel(mo.from, 'day', false) + ')' : ''), mt.fmt(mo.total), String(mo.days), mo.projectedText == null ? '' : mo.projectedText + ' (projected)'];
            }) };
        });
      }
    }

    // Where it went: by model, account, provider or machine.
    var byOpts = INS_BY.filter(function (o) { return !o.fleet || fleet; });
    var by = byOpts.some(function (o) { return o.key === ins.by; }) ? ins.by : 'model';
    var rows = breakdownRows(d, by, metric);
    var unpriced = d.cost && d.cost.unpricedTokens > 0 ? ' · ' + fmtTokens(d.cost.unpricedTokens) + ' tokens not priced' : '';
    insightsCard(body, 'by', 'Where it went', (metric === 'cost' ? 'estimated API cost' : 'tokens') + ', ' + rangeText + (metric === 'cost' ? unpriced : ''), function (host) {
      drawBreakdown(host, d, rows, metric);
    }, function () {
      return { cols: [byOpts.filter(function (o) { return o.key === by; })[0].label.replace(/s$/, ''), 'Requests', 'Tokens', 'Est. API cost', 'Per million', 'Cache hit', 'Share'],
        rows: rows.map(function (r) {
          return [r.label + (r.group ? ' (' + r.group + ')' : ''), num(r.requests), num(r.tokens), r.cost == null ? 'not priced' : fmtUsd(r.cost),
            r.perMillion == null ? '—' : fmtUsd(r.perMillion), r.hit == null ? '—' : (r.hit * 100).toFixed(1) + '%', r.share == null ? '—' : pctOf(r.share)];
        }) };
    }, { tools: function (tools) {
      segmented(tools, 'by', byOpts, by, function (k) { ins.by = k; renderInsights(); });
    } });
  }

  function render(s) {
    lastStatus = s;
    // The poll owns the threshold field except while it is being typed into:
    // rewriting it every POLL_MS would delete the operator's half-entered
    // number under the cursor. It also means a change made from the CLI, the
    // TUI or another browser shows up here without a refresh.
    var thrInput = document.getElementById('thrVal');
    if (document.activeElement !== thrInput) thrInput.value = thresholdPercentText(s.switchThreshold);
    // Kept visible read-only: the number still tells a client where the fleet switches.
    var canThreshold = callerCan(s.caller, '/teamclaude/threshold');
    thrInput.disabled = !canThreshold;
    document.getElementById('thrSet').style.display = canThreshold ? '' : 'none';
    // Rebuilt from the status unless it is open or saving, like the threshold
    // field, so a change made from the CLI or the TUI shows up here without a
    // refresh.
    var probeSel = document.getElementById('probeEvery');
    // ponytail: a status read that started before a save and lands after it
    // still shows the old interval until the next poll; cosmetic, nothing is lost.
    if (document.activeElement !== probeSel && !probeSaving) {
      var probeSecs = (s.probe || {}).intervalSeconds || 0;
      probeSel.textContent = '';
      probeIntervalOptions(probeSecs).forEach(function (o) {
        var opt = el('option', '', o.label);
        opt.value = String(o.value);
        probeSel.appendChild(opt);
      });
      probeSel.value = String(probeSecs);
    }
    probeSel.disabled = !callerCan(s.caller, '/teamclaude/probe-interval');
    // Like the threshold field. A proxy too old to send the cut-off has no
    // row for it: there is nothing it could save to.
    var hasOsp = typeof s.outsideSpendHidePercent === 'number';
    document.getElementById('ospRow').style.display = hasOsp ? '' : 'none';
    var ospInput = document.getElementById('ospVal');
    if (hasOsp && document.activeElement !== ospInput) ospInput.value = String(s.outsideSpendHidePercent);
    var canOsp = callerCan(s.caller, '/teamclaude/outside-spend-hide');
    ospInput.disabled = !canOsp;
    document.getElementById('ospSet').style.display = canOsp ? '' : 'none';
    // Only the operator is told the name, and a proxy too old to have one
    // says nothing, so the row is there only when there is a name to change.
    var inst = s.instance;
    document.getElementById('nameRow').style.display = inst ? '' : 'none';
    var nameInput = document.getElementById('nameVal');
    if (inst && document.activeElement !== nameInput) {
      nameInput.value = inst.custom ? inst.name : '';
      nameInput.placeholder = inst.host || '';
    }
    // Only the operator is told whether a password is set; the row is for them.
    var hasPw = s.dashboardLogin !== undefined && callerCan(s.caller, '/teamclaude/dashboard-login');
    document.getElementById('pwRow').style.display = hasPw ? '' : 'none';
    if (hasPw) {
      document.getElementById('pwOff').style.display = s.dashboardLogin ? '' : 'none';
      document.getElementById('pwTag').textContent = s.dashboardLogin
        ? 'On for ' + s.dashboardLogin + '. Enter a username and a new password to change it.'
        : 'Sign in from another machine with a username and password instead of the proxy key. Saved to the config file as a hash.';
      var pwUser = document.getElementById('pwSetUser');
      if (document.activeElement !== pwUser && !pwUser.value) pwUser.value = s.dashboardLogin || '';
    }
    // A proxy too old to say its address has no row for it either.
    var hasAddr = !!inst && typeof inst.address === 'string';
    document.getElementById('addrRow').style.display = hasAddr ? '' : 'none';
    var addrInput = document.getElementById('addrVal');
    if (hasAddr && !statusAddrStale) {
      if (document.activeElement !== addrInput) addrInput.value = inst.address;
      // Set from a reload or another browser: the link must not keep the old one.
      useInstanceAddress(inst.address);
    }
    var notice = callerNotice(s.caller);
    document.getElementById('callerText').textContent = notice || '';
    document.getElementById('caller').style.display = notice ? 'block' : 'none';
    var sess = s.sessions || {};
    var up = s.server && s.server.uptimeSeconds != null ? 'up ' + fmtIn(s.server.uptimeSeconds) : '';
    var sum = document.getElementById('summary');
    sum.textContent = '';
    var currentAccounts = s.currentAccounts || null;
    var providerIds = currentAccounts ? Object.keys(currentAccounts).sort(function (a, b) {
      if (a === 'anthropic') return -1;
      if (b === 'anthropic') return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    }) : [];
    sum.appendChild(el('span', '', providerIds.length ? 'active accounts ' : 'active account '));
    if (providerIds.length) {
      providerIds.forEach(function (provider, i) {
        if (i) sum.appendChild(el('span', '', ' · '));
        sum.appendChild(el('span', '', providerLabel(provider) + ': '));
        sum.appendChild(el('b', '', currentAccounts[provider] || 'none'));
      });
    } else {
      sum.appendChild(el('b', '', s.currentAccount || 'none'));
    }
    // Conversations, like the Sessions table and the count above it: one page
    // saying "sessions" here and "conversations" there would read as two
    // different quantities rather than one counted twice.
    sum.appendChild(el('span', '', ' · ' + (sess.active || 0) + ' active / ' + (sess.known || 0) + ' known conversations' + (up ? ' · ' + up : '')));
    var pinsText = sessionPinsText(s.sessionPins);
    if (pinsText) sum.appendChild(el('span', 'pin', ' · ' + pinsText));
    var fleetText = fleetForecastText(s.fleetForecast, Date.now());
    if (fleetText) sum.appendChild(el('span', '', ' · ' + fleetText));
    var probe = s.probe || {};
    var probeBtn = document.getElementById('probe');
    probeBtn.textContent = probe.running ? 'Probe running…' : 'Probe quotas';
    probeBtn.disabled = !!probe.running;
    renderQuota(s);
    renderAccountsPage(s);
    renderProblems(s);
    renderRouting(s);
    renderConnect(s);
    renderClientKeys(s);
    renderLinks(s);
    renderSync(s);
    renderClients(s.clients);
    renderDimensions(s.usageDimensions);
    // The control means nothing with no usage table under it. The payload
    // already answers that: the server omits a dimension with no entries.
    var anyUsage = Object.keys(s.clients || {}).length || Object.keys(s.usageDimensions || {}).length;
    document.getElementById('usageViewWrap').style.display = anyUsage ? '' : 'none';
    document.getElementById('clientsEmpty').style.display = anyUsage ? 'none' : '';
    renderSessions(s.sessions);
    setCount('sessions', sess.active || 0, false);
    setCount('accounts', (s.accounts || []).length, false);
    document.getElementById('foot').textContent = 'refreshes every ' + (POLL_MS / 1000) + 's · ' + new Date().toLocaleTimeString();
  }

  // An account action reports beside its own row, where the click was: the
  // page-wide note sits above everything and is off screen for a row further down.
  // No prototype: an account named __proto__ would otherwise set it.
  var cardNotes = Object.create(null);
  // With now set it re-renders at once, for a failure no poll follows. Otherwise the
  // poll the caller starts shows it: re-rendering the stale status here would
  // rebuild the row and re-enable a switch button that must stay disabled
  // until the poll reports the switch.
  function cardNote(key, kind, text, now) {
    cardNotes[key] = { kind: kind, text: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + text, at: Date.now() };
    if (now && lastStatus) render(lastStatus);
  }

  function note(kind, text) {
    var n = document.getElementById('note');
    n.className = kind;
    n.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + text;
    n.style.display = 'block';
  }

  // One manual switch. The endpoint is a nudge, not a pin: it sets the current
  // account and normal rotation resumes from there (see the handler's comment
  // in server.js for what "eligible" means).
  function doSwitch(name, noteKey, btn) {
    btn.disabled = true;
    var r = switchRequest(name, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = switchOutcome(json);
        cardNote(noteKey, out.kind, out.text, false);
        // Re-enabled on any non-success, whether the server refused or the
        // fetch threw, so the two failure paths leave the button in one state.
        if (out.kind !== 'ok') btn.disabled = false;
        poll();
      })
      .catch(function (e) { cardNote(noteKey, 'error', 'switch failed: ' + e.message, true); btn.disabled = false; });
  }

  function doControlAccount(name, noteKey, spec, btn) {
    btn.disabled = true;
    var r = accountControlRequest(name, spec, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = accountControlOutcome(json, spec);
        cardNote(noteKey, out.kind, out.text, false);
        poll();
      })
      .catch(function (e) { cardNote(noteKey, 'error', 'change failed: ' + e.message, true); })
      // Unlike doSwitch, always re-enabled: the row is rebuilt by the poll
      // above, and a button that stayed dead after a refused change would be
      // the only control an operator could not retry.
      .finally(function () { btn.disabled = false; });
  }

  // Remove armed by a first click, by card, and how long the arming lasts.
  // No prototype: an account named __proto__ would otherwise set it.
  var removeArmed = Object.create(null);
  var REMOVE_CONFIRM_MS = 8000;
  var REMOVE_DOUBLE_CLICK_MS = 400;

  // "Reset usage" armed by a first click, by card, as Remove is: the second
  // click spends a reset, and there is no getting it back. Cards with a reset
  // in flight stay disabled across the polls that rebuild them.
  var resetArmed = Object.create(null);
  var resetBusy = Object.create(null);

  function resetButton(account, key) {
    if (resetBusy[key]) {
      var busy = button('btn codex', 'Resetting…', function () {});
      busy.disabled = true;
      return busy;
    }
    var armedAt = resetArmed[key];
    var armed = armedAt != null && Date.now() - armedAt < REMOVE_CONFIRM_MS;
    var b = button(armed ? 'btn codex danger' : 'btn codex', armed ? 'Confirm reset' : 'Reset usage', function () {
      // Read afresh: what the button showed when it was drawn may be stale.
      var now = Date.now();
      var step = resetClickStep(resetArmed[key], now, REMOVE_CONFIRM_MS, REMOVE_DOUBLE_CLICK_MS);
      if (step === 'wait') return;
      if (step === 'arm') { resetArmed[key] = now; if (lastStatus) render(lastStatus); return; }
      delete resetArmed[key];
      doRedeemReset(account, key);
    });
    b.title = armed
      ? 'Click again to spend one free reset on ' + account.name
      : 'Clear the spent usage limits on this account with one of its free resets';
    return b;
  }

  // Spend one reset now. The request waits for the redemption and the quota
  // re-read after it, so the poll that follows shows the cleared bars.
  function doRedeemReset(account, noteKey) {
    resetBusy[noteKey] = true;
    if (lastStatus) render(lastStatus);
    var r = redeemResetRequest(account, localStorage.getItem(KEY));
    // Every way of NOT reading the server's verdict — the request rejected,
    // the body unreadable — is reported as uncertain: the server may have
    // spent the credit before the answer was lost, and "failed" would invite
    // spending another. Only a refused key (401) is known to have spent nothing.
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return undefined; }
        return res.json().catch(function () { return null; });
      }, function () { return null; })
      .then(function (json) {
        delete resetBusy[noteKey];
        if (json === undefined) { if (lastStatus) render(lastStatus); return; }
        var out = redeemResetOutcome(json);
        cardNote(noteKey, out.kind, out.text, false);
        poll();
      });
  }

  // The account leaves TeamClaude: the running fleet and the config file,
  // credentials included. Nothing is revoked upstream, so the login keeps
  // working wherever else it is signed in.
  function doRemove(account, noteKey, btn) {
    btn.disabled = true;
    var r = removeRequest(account, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = removeOutcome(json);
        // The page-wide note: on success the row this would sit on is gone.
        if (out.kind === 'ok') note(out.kind, out.text);
        else cardNote(noteKey, out.kind, out.text, false);
        poll();
      })
      .catch(function (e) { cardNote(noteKey, 'error', 'remove failed: ' + e.message, true); })
      .finally(function () { btn.disabled = false; });
  }

  // The dashboard's one sign-in (the server runs one at a time): which
  // provider, the server's id for it once started, and what the panel shows.
  // seq tells a reply from a sign-in that has since been replaced.
  var signIn = null;
  var signInSeq = 0;
  var signInTimer = null;
  var SIGN_IN_POLL_MS = 2000;
  var SIGN_IN_LABEL = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };

  function pageHost() {
    // A linked instance is another machine whatever its address says: one
    // reached over an SSH tunnel at 127.0.0.1 still runs its sign-in callback
    // listener over there, out of this browser's reach.
    if (peer) return '';
    return typeof location !== 'undefined' ? location.hostname : '';
  }

  function signInFetch(step, body) {
    var r = signInRequest(step, body, localStorage.getItem(KEY));
    return fetch(at(r.url), r.init).then(function (res) {
      if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
      return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
    });
  }

  function stopSignInPoll() {
    if (signInTimer) { clearInterval(signInTimer); signInTimer = null; }
  }

  // who is the account a Sign in again button stands on, so the panel can
  // say which login to use; null for a new account. A sign-in already under
  // way keeps its panel until the server has taken the new one: it refuses
  // while the last one is finishing, and that one's outcome must still show.
  function startSignIn(provider, who) {
    var prev = signIn && signIn.id && !signIn.done ? signIn : null;
    var seq = ++signInSeq;
    var next = { seq: seq, provider: provider, who: who, id: null, plan: null, done: false, pasteError: null, notice: null, status: { kind: '', text: 'Starting the sign-in…' } };
    showPage('accounts');
    if (!prev) {
      stopSignInPoll();
      signIn = next;
      renderSignIn();
    }
    var refused = function (text) {
      if (seq !== signInSeq) return;
      if (prev && signIn === prev) {
        prev.notice = text;
        renderSignIn();
        return;
      }
      if (signIn !== next) return;
      next.done = true;
      next.status = { kind: 'error', text: text };
      renderSignIn();
    };
    signInFetch('start', { provider: provider })
      .then(function (json) {
        if (!json) return;
        if (json.ok !== true) { refused('The sign-in could not start' + (json.error ? ': ' + json.error : '')); return; }
        if (seq !== signInSeq) return;
        stopSignInPoll();
        signIn = next;
        next.id = json.id;
        next.plan = signInPlan(json, pageHost());
        next.status = { kind: '', text: 'Waiting for you to sign in…' };
        renderSignIn();
        signInTimer = setInterval(pollSignIn, SIGN_IN_POLL_MS);
      })
      .catch(function (e) { refused('The sign-in could not start: ' + e.message); });
  }

  function pollSignIn() {
    if (!signIn || !signIn.id || signIn.done) { stopSignInPoll(); return; }
    var seq = signIn.seq;
    signInFetch('status', { id: signIn.id })
      .then(function (json) {
        if (!json || !signIn || signIn.seq !== seq || signIn.done) return;
        var out = signInStatusOutcome(json, SIGN_IN_LABEL[signIn.provider]);
        if (!out.done) { setSignInStatus(out); return; }
        stopSignInPoll();
        if (out.kind === 'ok') {
          signIn = null;
          renderSignIn();
          note('ok', out.text);
          poll();
          return;
        }
        signIn.done = true;
        signIn.status = out;
        renderSignIn();
      })
      // A missed poll is retried by the next one.
      .catch(function () {});
  }

  function submitSignInCode(input, btn) {
    if (!signIn || !signIn.id) return;
    var code = input.value.trim();
    if (!code) { signIn.pasteError = 'Paste the ' + (signIn.provider === 'codex' ? 'address' : 'code') + ' first.'; renderSignIn(); return; }
    var seq = signIn.seq;
    btn.disabled = true;
    signInFetch('code', { id: signIn.id, code: code })
      .then(function (json) {
        if (!json || !signIn || signIn.seq !== seq) return;
        if (json.ok !== true) {
          signIn.pasteError = json.error || 'that could not be used';
          renderSignIn();
          return;
        }
        signIn.pasteError = null;
        signIn.pasted = true;
        renderSignIn();
        pollSignIn();
      })
      .catch(function (e) {
        if (!signIn || signIn.seq !== seq) return;
        signIn.pasteError = 'could not send it: ' + e.message;
        renderSignIn();
      })
      .finally(function () { btn.disabled = false; });
  }

  // Close the panel, cancelling a sign-in still waiting. One whose code has
  // arrived cannot be cancelled (the server says cancelled: false): the panel
  // stays and follows it to the end, since an account is stored either way.
  function closeSignIn() {
    if (!signIn) return;
    if (!signIn.id || signIn.done) {
      stopSignInPoll();
      signIn = null;
      renderSignIn();
      return;
    }
    var seq = signIn.seq;
    signInFetch('cancel', { id: signIn.id })
      .then(function (json) {
        if (!json || !signIn || signIn.seq !== seq) return;
        if (json.ok === true && json.cancelled === false) {
          signIn.notice = 'The code has already arrived, so this sign-in can no longer be cancelled. It is being finished.';
          renderSignIn();
          pollSignIn();
          return;
        }
        if (json.ok !== true) {
          signIn.notice = 'Could not cancel' + (json.error ? ': ' + json.error : '');
          renderSignIn();
          return;
        }
        stopSignInPoll();
        signIn = null;
        renderSignIn();
      })
      .catch(function (e) {
        if (!signIn || signIn.seq !== seq) return;
        signIn.notice = 'Could not cancel: ' + e.message;
        renderSignIn();
      });
  }

  // Only the status line, while the person may be typing a paste: rebuilding
  // the panel would drop what is in the field.
  var signInStatusEl = null;
  function setSignInStatus(out) {
    if (!signIn) return;
    signIn.status = out;
    if (signInStatusEl) {
      signInStatusEl.className = 'st' + (out.kind ? ' ' + out.kind : '');
      signInStatusEl.textContent = out.text;
    }
  }

  function renderSignIn() {
    var box = document.getElementById('signIn');
    box.textContent = '';
    signInStatusEl = null;
    if (!signIn) { box.style.display = 'none'; return; }
    var p = signIn.provider;
    var label = SIGN_IN_LABEL[p];
    box.className = 'signin ' + p;
    box.style.display = '';
    var head = el('div', 'sh');
    head.appendChild(el('span', 'pdot ' + p));
    head.appendChild(el('span', 'sp', (signIn.who ? 'Sign in to ' + label + ' again' : 'Sign in to ' + label)));
    head.appendChild(button('btn', signIn.done ? 'Close' : 'Cancel', closeSignIn));
    box.appendChild(head);
    var plan = signIn.plan;
    if (plan && !signIn.done) {
      var steps = el('ol');
      var one = el('li', '', signIn.who
        ? 'Open the sign-in page and sign in as ' + signIn.who + '.'
        : 'Open the sign-in page and sign in with the ' + ({ codex: 'ChatGPT', grok: 'xAI' }[p] || 'Claude') + ' account you want to add.');
      var line = el('div', 'line');
      var open = el('a', 'btn ' + p, 'Open sign-in page');
      open.href = plan.href;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      line.appendChild(open);
      // The link itself, to copy to a browser on another device.
      var link = el('input');
      link.readOnly = true;
      link.value = plan.href;
      link.title = 'The sign-in link, to open on another device';
      link.addEventListener('focus', function () { this.select(); });
      line.appendChild(link);
      one.appendChild(line);
      steps.appendChild(one);
      var two = el('li', '', plan.ask);
      if (plan.code != null) {
        // A device sign-in: the code to check on xAI's page, and no paste.
        two.appendChild(el('div', 'line code', plan.code));
      } else {
        var line2 = el('div', 'line');
        var paste = el('input');
        paste.placeholder = p === 'codex' ? 'http://localhost:1455/auth/callback?code=…' : 'Paste the code here';
        paste.autocomplete = 'off';
        paste.spellcheck = false;
        var finish = button('btn primary', 'Finish sign-in', function () { submitSignInCode(paste, finish); });
        paste.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitSignInCode(paste, finish); });
        line2.appendChild(paste);
        line2.appendChild(finish);
        two.appendChild(line2);
        if (signIn.pasteError) two.appendChild(el('div', 'st error', signIn.pasteError));
      }
      steps.appendChild(two);
      box.appendChild(steps);
      if (plan.note) box.appendChild(el('div', 'st warn', plan.note));
      box.appendChild(el('div', 'st', 'Signing in to an account TeamClaude already has refreshes its sign-in instead of adding it twice.'));
    }
    if (signIn.notice) box.appendChild(el('div', 'st warn', signIn.notice));
    var st = signIn.status || { kind: '', text: '' };
    signInStatusEl = el('div', 'st' + (st.kind ? ' ' + st.kind : ''), st.text);
    box.appendChild(signInStatusEl);
    if (signIn.done) {
      var who = signIn.who;
      var provider = p;
      box.appendChild(button('btn ' + p, 'Try again', function () { startSignIn(provider, who); }));
    }
  }

  // One account's quota, read now from the zero-spend usage endpoint. The
  // request waits for the probe, so the poll after it shows the new bars.
  function doRefreshQuota(account, noteKey, btn) {
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    var r = refreshQuotaRequest(account, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = refreshQuotaOutcome(json);
        cardNote(noteKey, out.kind, out.text, false);
        poll();
      })
      .catch(function (e) { cardNote(noteKey, 'error', 'quota refresh failed: ' + e.message, true); });
  }

  // The one control here that writes a setting rather than nudging the running
  // fleet: the server saves it to the config file and reloads, so it holds
  // across a restart. One number governs every quota bucket — a fleet using
  // per-bucket thresholds is told what the save dropped (thresholdOutcome).
  function doThreshold(btn) {
    var input = document.getElementById('thrVal');
    var raw = input.value.trim();
    // Left to the server otherwise: an empty field is the one case it would see
    // as a missing key rather than a bad number, and "invalid request body" is
    // not what an operator who cleared the box needs to read.
    if (!raw) { note('error', 'switch threshold: enter a percentage from 1 to 100'); return; }
    btn.disabled = true;
    var r = thresholdRequest(Number(raw), localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = thresholdOutcome(json);
        note(out.kind, out.text);
        // The stored number, not the typed one: the setting is quantised to
        // tenths, and a field left reading 97.55 after a save of 97.6 invites a
        // re-save that changes nothing.
        if (json.ok) input.value = thresholdPercentText(json.switchThreshold);
        poll();
      })
      .catch(function (e) { note('error', 'switch threshold change failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function doOutsideSpendHide(btn) {
    var input = document.getElementById('ospVal');
    var raw = input.value.trim();
    // As for the threshold: an empty box would reach the server as a missing
    // number, and "enter a percentage" is what the operator needs to read.
    if (!raw) { note('error', 'outside spend: enter a percentage from 0 to 100'); return; }
    btn.disabled = true;
    var r = outsideSpendHideRequest(Number(raw), localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = outsideSpendHideOutcome(json);
        note(out.kind, out.text);
        // The stored number, which is rounded to tenths.
        if (json.ok) input.value = String(json.outsideSpendHidePercent);
        poll();
      })
      .catch(function (e) { note('error', 'outside spend change failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function doInstanceName(btn) {
    var input = document.getElementById('nameVal');
    btn.disabled = true;
    var r = instanceNameRequest(input.value.trim(), localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = instanceNameOutcome(json);
        note(out.kind, out.text);
        if (json.ok) input.value = json.custom ? json.name : '';
        poll();
      })
      .catch(function (e) { note('error', 'instance name change failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function doDashboardLogin(username, password, btn) {
    btn.disabled = true;
    var r = dashboardLoginRequest(username, password, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = dashboardLoginOutcome(json);
        note(out.kind, out.text);
        if (json.ok) {
          document.getElementById('pwSetPass').value = '';
          document.getElementById('pwSetUser').value = json.username || '';
        }
        poll();
      })
      .catch(function (e) { note('error', 'dashboard password change failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function doInstanceAddress(btn) {
    var input = document.getElementById('addrVal');
    btn.disabled = true;
    var r = instanceAddressRequest(input.value.trim(), localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = instanceAddressOutcome(json);
        note(out.kind, out.text);
        if (json.ok) {
          input.value = json.address;
          // At once, so a Show key that answers before the reads below
          // already builds its link from the new address. Then ask again, for
          // guesses the old address may have hidden.
          addrSaves++;
          // The status the page holds was read before the save, so a
          // re-render from it must not bring the old address back either.
          statusAddrStale = true;
          useInstanceAddress(json.address);
        }
        poll();
      })
      .catch(function (e) { note('error', 'instance address change failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  // Saved on pick: a select has no half-entered state to protect, so a Set
  // button would only be a second click. The select is neither disabled nor
  // blurred while it saves: either would drop keyboard focus, and arrowing
  // through the choices fires one change per step. Steps that land while a save
  // is in flight are coalesced into one save of the latest choice, so the
  // requests can't arrive out of order and leave an earlier step on disk. The
  // choice is kept in probeWanted rather than re-read from the select, which a
  // poll may have rewritten by then (render leaves it alone only while it has
  // focus or a save is running).
  var probeSaving = false, probeWanted = null;
  function doProbeInterval(sel) {
    probeWanted = Number(sel.value);
    if (!probeSaving) saveProbeInterval(sel);
  }

  function saveProbeInterval(sel) {
    var seconds = probeWanted;
    probeWanted = null;
    probeSaving = true;
    var r = probeIntervalRequest(seconds, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = probeIntervalOutcome(json);
        note(out.kind, out.text);
        // A focused select is left alone by the poll, so a refused choice would
        // otherwise stay on screen as if it applied. A newer pick waiting to be
        // sent is left showing instead: it is about to be saved.
        if (!json.ok && probeWanted === null) sel.value = String(((lastStatus || {}).probe || {}).intervalSeconds || 0);
      })
      .catch(function (e) { note('error', 'quota refresh change failed: ' + e.message); })
      .finally(function () {
        probeSaving = false;
        if (probeWanted !== null) saveProbeInterval(sel); else poll();
      });
  }

  function doControl(path, label, btn) {
    btn.disabled = true;
    fetch(at(path), { method: 'POST', headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        if (json.ok !== true) { note('error', label + ' failed' + (json.error ? ': ' + json.error : '')); return; }
        note('ok', label + ' complete');
        poll();
      })
      .catch(function (e) { note('error', label + ' failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  // The instance picker: this machine and the linked ones it lists, each with
  // what it last answered. Hidden while there is nothing to pick.
  function renderInstances(list, self) {
    var selfName = selfInstanceLabel(self);
    document.getElementById('instanceBack').textContent = 'Back to ' + (self && self.name ? self.name : 'this machine');
    var peers = Array.isArray(list) ? list : [];
    setInsightsLinked(peers.length);
    var box = document.getElementById('instances');
    box.style.display = peers.length || peer ? '' : 'none';
    var shown = null;
    peers.forEach(function (p) { if (p.name === peer) shown = p; });
    // Gone from the config (or renamed): back to the machine that is certainly here.
    if (peer && Array.isArray(list) && !shown) { pickInstance(''); return; }
    peerUrl = shown ? shown.url : '';
    var sel = document.getElementById('instance');
    if (document.activeElement !== sel) {
      sel.textContent = '';
      var here = el('option', '', selfName);
      here.value = '';
      sel.appendChild(here);
      peers.forEach(function (p) {
        var o = el('option', '', p.name + (p.state === 'online' ? '' : ' (' + p.state + ')'));
        o.value = p.name;
        sel.appendChild(o);
      });
      sel.value = peer;
    }
    var noteBox = document.getElementById('instanceNote');
    noteBox.style.display = peer ? '' : 'none';
    if (peer) document.getElementById('instanceText').textContent = 'Showing ' + peer + (peerUrl ? ' (' + peerUrl + ')' : '') + ', reached through ' + (self && self.name ? self.name : 'this machine') + '.';
  }

  // Showing a linked instance, this machine is asked first: that read is what
  // proves the key the page holds, and it lists the instances to pick from, so
  // the picker (and the way back) is there even while the one shown is down.
  // Resolves whether the instance shown should be asked next.
  function pollInstances() {
    return fetch('/teamclaude/peers', { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return false; }
        // A valid key that may not reach linked instances (a client key), or
        // the loopback exemption refusing a key-less page: either way this
        // machine's own page is the one to show, and it handles the rest.
        if (res.status === 403) { pickInstance(''); return false; }
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json().then(function (j) {
          document.getElementById('keybox').style.display = 'none';
          document.getElementById('app').style.display = '';
          renderInstances(j.peers, j.self);
          peerChecked = !!peer;
          return peerChecked;
        });
      })
      .catch(function (e) {
        var err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = 'Cannot reach the proxy: ' + e.message;
        if (document.getElementById('keybox').style.display !== 'block') document.getElementById('app').style.display = '';
        return false;
      });
  }

  function showKeybox() {
    if (timer) { clearInterval(timer); timer = null; }
    peerChecked = false;
    document.getElementById('app').style.display = 'none';
    document.getElementById('keybox').style.display = 'block';
    document.getElementById('key').focus();
    // Always asked of this machine: the password hands out its own key.
    fetch('/teamclaude/auth/methods')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (j) {
        var on = !!(j && j.password);
        document.getElementById('pwForm').style.display = on ? '' : 'none';
        document.getElementById('pwHere').style.display = j && j.hostRefused ? '' : 'none';
        document.getElementById('keySub').style.display = on ? 'none' : '';
        if (on) document.getElementById('pwUser').focus();
      })
      .catch(function () { /* the key field still works */ });
  }

  function signInWithPassword() {
    var btn = document.getElementById('pwGo');
    var errBox = document.getElementById('pwErr');
    var r = passwordLoginRequest(document.getElementById('pwUser').value.trim(), document.getElementById('pwPass').value);
    btn.disabled = true;
    errBox.textContent = '';
    fetch(r.url, r.init)
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (j) { return passwordLoginOutcome(res.status, j); });
      })
      .then(function (out) {
        if ('error' in out) { errBox.textContent = out.error; return; }
        document.getElementById('pwPass').value = '';
        localStorage.setItem(KEY, out.key);
        start();
      })
      .catch(function (e) { errBox.textContent = 'Cannot reach the proxy: ' + e.message; })
      .finally(function () { btn.disabled = false; });
  }

  function poll() {
    if (holdPoll) return;
    if (peer) { pollInstances().then(function (ok) { if (ok) pollStatus(); }); return; }
    pollStatus();
  }

  function pollStatus() {
    var saves = addrSaves;
    fetch(at('/teamclaude/status'), { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        // 403 is the loopback exemption refusing a key-less request (a Host
        // that does not name this machine, e.g. behind a local reverse proxy
        // that adds no forwarding headers). A valid key clears that gate too.
        if (res.status === 401 || res.status === 403) { localStorage.removeItem(KEY); showKeybox(); return null; }
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || 'status ' + res.status); });
        }
        return res.json();
      })
      .then(function (s) {
        if (!s) return;
        statusAddrStale = saves !== addrSaves;
        // A linked instance's status lists ITS peers; the picker lists ours.
        if (!peer) renderInstances(s.peers, s.instance);
        document.getElementById('keybox').style.display = 'none';
        document.getElementById('app').style.display = '';
        document.getElementById('err').style.display = 'none';
        render(s);
        if (currentPage === 'logs') pollLogs();
        if (currentPage === 'insights') {
          if (ins.data && ins.drawn !== insightsDrawnKey()) renderInsights();
          pollInsights(false);
        }
      })
      .catch(function (e) {
        var err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = peer ? e.message : 'Cannot reach the proxy: ' + e.message;
        // The banner lives inside #app, which stays hidden until a first
        // status lands; without this a first poll that fails is a blank page.
        if (document.getElementById('keybox').style.display !== 'block') document.getElementById('app').style.display = '';
      });
  }

  function start() {
    poll();
    if (!timer) timer = setInterval(poll, POLL_MS);
  }

  function buildNav() {
    var nav = document.getElementById('nav');
    var section = null;
    PAGES.forEach(function (p) {
      if (p.section !== section) {
        section = p.section;
        nav.appendChild(el('div', 'navsec', section));
      }
      var b = button('navbtn', p.label, function () { showPage(p.key); });
      var c = el('span', 'count');
      c.style.display = 'none';
      b.appendChild(c);
      nav.appendChild(b);
      navButtons[p.key] = b;
      navCounts[p.key] = c;
    });
  }

  // The page is in the URL's fragment, so a reload or a bookmark comes back to
  // it; read and written only where there is a location to read (not in the
  // test harness that boots this script).
  function showPage(key) {
    var page = PAGES.filter(function (p) { return p.key === key; })[0] || PAGES[0];
    currentPage = page.key;
    PAGES.forEach(function (p) {
      document.getElementById('page-' + p.key).style.display = p.key === page.key ? '' : 'none';
      navButtons[p.key].className = p.key === page.key ? 'navbtn sel' : 'navbtn';
    });
    document.getElementById('pageTitle').textContent = page.label;
    if (typeof location !== 'undefined' && typeof history !== 'undefined' && location.hash !== '#' + page.key) {
      try { history.replaceState(null, '', '#' + page.key); } catch (e) { /* a sandboxed frame: the page still switches */ }
    }
    if (lastStatus) renderProblems(lastStatus);
    if (page.key === 'logs') { renderLogs(); pollLogs(); }
    hideInsightsTip();
    if (page.key === 'insights') { renderInsights(); pollInsights(false); }
    if (page.key === 'settings' && lastStatus) { renderLinks(lastStatus); renderSync(lastStatus); }
    // Read afresh on each visit: teamclaude connect may have changed a file since.
    if (page.key === 'clients') {
      if (connectState === 'done') connectState = 'unasked';
      if (lastStatus) renderConnect(lastStatus);
    }
  }

  document.getElementById('go').addEventListener('click', function () {
    var v = document.getElementById('key').value.trim();
    if (!v) return;
    localStorage.setItem(KEY, v);
    start();
  });
  document.getElementById('key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('go').click();
  });
  document.getElementById('pwForm').addEventListener('submit', function (e) { e.preventDefault(); signInWithPassword(); });
  document.getElementById('pwSetForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var user = document.getElementById('pwSetUser').value.trim();
    var pass = document.getElementById('pwSetPass').value;
    if (!user || !pass) { note('error', 'Enter a username and a password first.'); return; }
    doDashboardLogin(user, pass, document.getElementById('pwSet'));
  });
  document.getElementById('pwOff').addEventListener('click', function () { doDashboardLogin('', '', this); });
  // Theme: system → light → dark → system. "system" is the absence of a
  // stored choice, so a viewer who never touches this keeps following their
  // desktop, and one who does is not re-decided for by it later.
  var THEMES = ['system', 'light', 'dark'];
  function readTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch (e) { return 'system'; }
  }
  function applyTheme(theme) {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    var btn = document.getElementById('theme');
    // Name the state, not the action: a button reading "Dark" while the page is
    // light is the ambiguity every theme toggle has, and this one says where it
    // is rather than where it would go.
    btn.textContent = theme === 'system' ? 'Theme: system' : theme === 'light' ? 'Theme: light' : 'Theme: dark';
  }
  function storeTheme(theme) {
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch (e) { /* storage disabled: the choice lasts for this page only */ }
  }
  // The current theme lives in a variable rather than being re-read from
  // storage on each click: with storage blocked, readTheme() would always say
  // 'system' and the button would be stuck on 'light' instead of cycling.
  var theme = readTheme();
  applyTheme(theme);
  document.getElementById('theme').addEventListener('click', function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    storeTheme(theme);
    applyTheme(theme);
  });

  document.getElementById('reload').addEventListener('click', function () { doControl('/teamclaude/reload', 'config reload', this); });
  document.getElementById('probe').addEventListener('click', function () { doControl('/teamclaude/probe', 'quota probe', this); });
  document.getElementById('thrSet').addEventListener('click', function () { doThreshold(this); });
  document.getElementById('nameSet').addEventListener('click', function () { doInstanceName(this); });
  document.getElementById('nameVal').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doInstanceName(document.getElementById('nameSet')); }
  });
  document.getElementById('addrSet').addEventListener('click', function () { doInstanceAddress(this); });
  document.getElementById('addrVal').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doInstanceAddress(document.getElementById('addrSet')); }
  });
  document.getElementById('probeEvery').addEventListener('change', function () { doProbeInterval(this); });
  document.getElementById('ospSet').addEventListener('click', function () { doOutsideSpendHide(this); });
  document.getElementById('ospVal').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('ospSet').click(); }
  });
  // A client key is a valid key, so nothing else on the page would ever ask for
  // another one: the operator needs a way back to the key box.
  function forgetKey() { localStorage.removeItem(KEY); document.getElementById('key').value = ''; showKeybox(); }
  document.getElementById('changeKey').addEventListener('click', forgetKey);
  document.getElementById('instance').addEventListener('change', function () { pickInstance(this.value); });
  document.getElementById('instanceBack').addEventListener('click', function () { pickInstance(''); });
  document.getElementById('forgetKey').addEventListener('click', forgetKey);
  document.getElementById('thrVal').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('thrSet').click();
  });
  buildUsageViews();
  document.getElementById('ckForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('ckName').value.trim();
    if (!name) { ckStatus('error', 'Name the key first: the machine or agent that will use it.'); return; }
    doClientKey('create', name, document.getElementById('ckCreate'));
  });
  document.getElementById('linkForm').addEventListener('submit', function (e) { e.preventDefault(); doAddLink(); });
  document.getElementById('linkTest').addEventListener('click', function () { doTestLink(this); });
  document.getElementById('linkPaste').addEventListener('input', function () { useInstanceLink(true); });
  document.getElementById('linkPaste').addEventListener('change', function () { useInstanceLink(false); });
  document.getElementById('linkBack').addEventListener('change', syncLinkBack);
  document.getElementById('ownKeyShow').addEventListener('click', function () { toggleOwnKey(this); });
  labelLinkCard();
  buildLogFilters();
  buildInsightsControls();
  buildNav();

  ['fProject', 'fClient'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', function () {
      sessionFilters[id === 'fProject' ? 'project' : 'client'] = this.value;
      if (lastStatus) render(lastStatus);
    });
  });

  showPage(typeof location !== 'undefined' ? String(location.hash || '').slice(1) : '');
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('hashchange', function () { showPage(String(location.hash || '').slice(1)); });
  }

  // Poll before asking: a loopback browser is key-exempt, so the prompt is
  // shown only once the server refuses the request without a valid key.
  start();
})();
</script>
</body>
</html>
`;
