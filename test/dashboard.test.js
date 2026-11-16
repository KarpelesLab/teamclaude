import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveAccountTarget, callerView } from '../src/server.js';
import {
  renderDashboardHtml, dashboardCsp, inlineScripts, scopedWeeklyRows, accountTokens,
  accountBadges, thresholdBadgeText,
  sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, accountControlRequest, accountControlOutcome, routeRows, problems, STARVED_MIN, STARVED_LIST_MAX,
  thresholdRequest, thresholdPercentText, thresholdOutcome,
  probeIntervalOptions, probeIntervalRequest, probeIntervalOutcome, instanceNameRequest, instanceNameOutcome, instanceAddressRequest, instanceAddressOutcome, linkSelfWithAddress, selfInstanceLabel,
  usageFor, USAGE_VIEWS, backendQuotaRows,
  callerCan, callerNotice, cardNoteKey, accountEmailLine, cardNoteFor, CARD_NOTE_MAX_AGE_MS,
  canRefreshQuota, refreshQuotaRequest, refreshQuotaOutcome,
  codexResetsLeft, codexResetsSummary, canRedeemReset, redeemResetRequest, redeemResetOutcome, resetClickStep, REDEEM_UNCERTAIN_TEXT,
  meterTone, quotaMeter, exhaustedMeter, fableLabel, accountMeters, accountQuotaExhausted, poolSummary, accountGroup, groupLabel, providerTabs,
  LOG_KINDS, mergeLogEvents, filterLogEvents, logEventDetail, logEventClient, logEventTone,
  providerTone, needsSignIn, fileSignInHint, isLoopbackHost, signInRequest, signInPlan, signInStatusOutcome, removeRequest, removeOutcome,
  clientKeyRequest, clientKeyOutcome, clientKeySetup, clientKeyCheckOutcome,
  peerLinkRequest, peerLinkOutcome, peerTestOutcome, linkSelfOptions, linkBackNotice, instanceLink, parseInstanceLink, linkAddMissing,
  accountSyncRequest, accountSyncUser, accountSyncLine, peerSyncCell, accountSyncApprovalHref, accountSyncSignInOutcome, accountSyncCancelOutcome, accountSyncOutcome,
} from '../src/dashboard.js';
import { logoDataUrl, logoMarkup } from '../src/logo.js';
import { EVENT_KINDS } from '../src/event-log.js';
import { USAGE_WINDOWS } from '../src/client-usage.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// The page's pure logic is exported and serialized into the script, so these
// exercise the same functions the browser runs.

test('scopedWeekly names the buckets, not a hard-coded pair', () => {
  const rows = scopedWeeklyRows({
    scopedWeekly: {
      sonnet: { utilization: 0.5, resetAt: 100 },
      opus: { utilization: 0.1, resetAt: 200 },
    },
  });
  // A family upstream started metering must appear without a release.
  assert.deepEqual(rows.map(r => r.family), ['opus', 'sonnet']);
  assert.deepEqual(rows[1], { family: 'sonnet', label: 'Sonnet', utilization: 0.5, resetAt: 100 });
});

test('scopedWeekly falls back to the dedicated fields, and never doubles a family', () => {
  // A usage payload with `seven_day_sonnet` but no `limits` array leaves
  // scopedWeekly empty while the dedicated field is set — the bar must still show.
  assert.deepEqual(
    scopedWeeklyRows({ unified7dSonnet: 0.3, unified7dSonnetReset: 9 }),
    [{ family: 'sonnet', label: 'Sonnet', utilization: 0.3, resetAt: 9 }],
  );
  const both = scopedWeeklyRows({
    scopedWeekly: { sonnet: { utilization: 0.5, resetAt: 100 } },
    unified7dSonnet: 0.3,
    unified7dSonnetReset: 9,
  });
  assert.equal(both.length, 1);
  assert.equal(both[0].utilization, 0.5);
  assert.deepEqual(scopedWeeklyRows({}), []);
  assert.deepEqual(scopedWeeklyRows(null), []);
});

const labels = (/** @type {any} */ m) => m.slots.map((/** @type {any} */ x) => x && x.label);

test('a Claude row reads Fable weekly, then the five-hour limit, then the shared weekly', () => {
  const m = accountMeters({
    provider: 'anthropic',
    quota: {
      unified5h: 0.2, unified5hReset: 1, unified7d: 0.4, unified7dReset: 2,
      scopedWeekly: { fable: { utilization: 0.6, resetAt: 3 }, sonnet: { utilization: 0.1, resetAt: 4 } },
    },
  }, 'Fable 5.1');
  assert.deepEqual(labels(m), ['7-day Fable 5.1', '5-hour limit', '7-day limit']);
  assert.deepEqual(m.slots[0], { label: '7-day Fable 5.1', used: 0.6, left: 0.4, resetAt: 3, tone: 'ok' });
  assert.equal(m.slots[1].resetAt, 1);
  assert.equal(m.slots[2].resetAt, 2);
  // Other model-scoped buckets wait behind the row's Show control.
  assert.deepEqual(m.extra.map((/** @type {any} */ x) => x.label), ['7-day Sonnet']);
  assert.equal(m.text, null);
});

test('a column the account has no window for stays empty, so the columns line up', () => {
  // No Fable bucket reported yet.
  assert.deepEqual(labels(accountMeters({ quota: { unified5h: 0.2, unified7d: 0.4 } })), [null, '5-hour limit', '7-day limit']);
  // A plan that states no session window gets no five-hour column (showSessionRow).
  assert.deepEqual(labels(accountMeters({ quota: { unified7d: 0.4, sessionWindowStated: false, unified7dFable: 0.5 } })),
    ['7-day Fable', null, '7-day limit']);
  // Codex has no Fable bucket at all, even if a field of that name turned up.
  assert.deepEqual(labels(accountMeters({ provider: 'codex', quota: { unified5h: 0.1, unified7d: 0.3, unified7dFable: 0.9 } })),
    [null, '5-hour limit', '7-day limit']);
});

test('an empty shared or Fable week makes session capacity zero without changing upstream quota', () => {
  const now = Date.now();
  for (const weekly of [
    { unified7d: 1, unified7dReset: now + 10_000 },
    { unified7d: 0.2, unified7dFable: 1, unified7dFableReset: now + 10_000 },
    { unified7d: 0.2, scopedWeekly: { fable: { utilization: 1, resetAt: now + 10_000 } } },
  ]) {
    const account = { quota: { unified5h: 0, unified5hReset: now + 1_000, ...weekly } };
    const original = JSON.parse(JSON.stringify(account));
    const session = accountMeters(account, undefined, now).slots[1];
    assert.equal(session.left, 0);
    assert.equal(session.tone, 'bad');
    assert.equal(session.note, 'Weekly limit empty');
    assert.equal(session.resetAt, null, 'do not promise the session reset will unblock the week');
    assert.equal(accountQuotaExhausted(account, now), true);
    assert.equal(poolSummary([account], 1, undefined, now).left, 0, 'the pool cannot advertise unusable session quota');
    assert.deepEqual(account, original);
  }
  const codex = { provider: 'codex', quota: { unified5h: 0, unified7d: 1 } };
  assert.equal(accountMeters(codex).slots[1].left, 0);
  assert.equal(accountMeters({ quota: { unified7d: 1, sessionWindowStated: false } }).slots[1], null);
});

test('unknown, unspent, expired and other model weeks do not suppress fresh session capacity', () => {
  const now = Date.now();
  for (const weekly of [
    {}, { unified7d: 0 }, { unified7d: 0.99 },
    { unified7d: 1, unified7dReset: now },
    { unified7dFable: 1, unified7dFableReset: now - 1 },
    { unified7d: 0.1, scopedWeekly: { sonnet: { utilization: 1 } } },
  ]) {
    const account = { quota: { unified5h: 0, ...weekly } };
    assert.equal(accountMeters(account, undefined, now).slots[1].left, 1);
    assert.equal(accountQuotaExhausted(account, now), false);
  }
  assert.equal(accountQuotaExhausted({ quota: {} }, now), false);
  assert.equal(accountQuotaExhausted(null, now), false);
  assert.equal(accountMeters({ provider: 'codex', quota: { unified5h: 0, unified7d: 0.1, unified7dFable: 1 } }).slots[1].left, 1);
});

test('empty primary windows hide rows, while unknown or reset windows stay visible', () => {
  const now = Date.now();
  assert.equal(accountQuotaExhausted({ quota: { unified5h: 1 } }, now), true);
  assert.equal(accountQuotaExhausted({ quota: { unified5h: 1, unified5hReset: now } }, now), false);
  assert.equal(accountQuotaExhausted({ quota: { tokensLimit: 100, tokensRemaining: 0 } }, now), true);
  assert.equal(accountQuotaExhausted({ quota: { backend: { utilization: 1 } } }, now), true);
  assert.equal(accountQuotaExhausted({ quota: { backend: { text: '$0', utilization: null } } }, now), false);
});

test('backend exhaustion clears when all structured windows expire, without a new probe', () => {
  const now = Date.now();
  for (const windows of [
    { fiveHour: { utilization: 1, resetAt: now + 100 } },
    { fiveHour: { utilization: 1, resetAt: now + 50 }, weekly: { utilization: 1, resetAt: now + 100 } },
  ]) {
    const backend = { label: 'Plan', text: 'cached quota reading', utilization: 1, windows };
    const account = { quota: { backend } };
    assert.equal(accountQuotaExhausted(account, now), true);
    assert.equal(accountQuotaExhausted(account, now + 100), false, 'reset alone makes the account visible again');
    assert.deepEqual(accountMeters(account, undefined, now + 100).slots, [null, null, null]);
    assert.deepEqual(backendQuotaRows(backend, now + 100), { rows: [], text: 'Plan: cached quota reading' });
  }
  assert.equal(accountQuotaExhausted({ quota: { backend: {
    utilization: 1, windows: { fiveHour: { utilization: 1, resetAt: now }, weekly: { utilization: 1, resetAt: null } },
  } } }, now), true, 'an unexpired weekly reading still hides the account');
  assert.equal(accountQuotaExhausted({ quota: { backend: { utilization: 1, windows: {} } } }, now), true,
    'aggregate-only backends keep their reading');
});

test('an account metered another way fills from the left, or says why there is nothing', () => {
  assert.deepEqual(labels(accountMeters({ quota: { tokensLimit: 100, tokensRemaining: 25 } })), ['Tokens', null, null]);
  assert.equal(accountMeters({ quota: { tokensLimit: 100, tokensRemaining: 25 } }).slots[0].left, 0.25);
  const backend = accountMeters({ quota: { backend: { label: 'Balance', text: '$4.20', utilization: null } } });
  assert.deepEqual(labels(backend), [null, null, null]);
  assert.equal(backend.text, 'Balance: $4.20');
  assert.match(accountMeters({ quota: {} }).text, /quota unknown/);
});

test('a column\'s tone follows what is used: amber from 70%, red from 90%', () => {
  assert.equal(meterTone(0.69), 'ok');
  assert.equal(meterTone(0.7), 'warn');
  assert.equal(meterTone(0.9), 'bad');
  assert.equal(meterTone(null), 'unknown');
  assert.deepEqual(quotaMeter('x', 1.4, null), { label: 'x', used: 1, left: 0, resetAt: null, tone: 'bad' });
  assert.equal(quotaMeter('x', undefined, null).left, null);
});

test('the Fable column is named for the newest Fable model the fleet served', () => {
  assert.equal(fableLabel([]), 'Fable');
  assert.equal(fableLabel([
    { usage: { recentModels: { 'claude-fable-5-0': 10, 'claude-opus-5-5': 50 } } },
    { usage: { recentModels: { 'claude-fable-5-1': 20 } } },
  ]), 'Fable 5.1');
});

test('a summary card pools one column across the enabled accounts that report it', () => {
  const now = 1_000;
  const pool = poolSummary([
    { name: 'a', quota: { unified7d: 0.2, unified7dReset: now + 5_000 } },
    { name: 'b', quota: { unified7d: 0.9, unified7dReset: now + 2_000 } },
    { name: 'c', disabled: true, quota: { unified7d: 0 } },
    { name: 'd', quota: { unified5h: 0.1 } },
  ], 2, 'Fable', now);
  assert.equal(pool.label, '7-day limit');
  assert.equal(pool.count, 2);
  assert.ok(Math.abs(pool.left - 0.9) < 1e-9);
  assert.deepEqual(pool.segments.map((/** @type {any} */ x) => x.name), ['a', 'b']);
  assert.deepEqual(pool.soonest, { name: 'b', resetAt: now + 2_000 });
  // `d` has a weekly column with no reading: counted, not guessed.
  assert.equal(pool.unknown, 1);
  // A reset already past is not "the soonest".
  assert.equal(poolSummary([{ name: 'a', quota: { unified7d: 0.1, unified7dReset: now - 1 } }], 2, 'Fable', now).soonest, null);
});

test('tabs list Claude, Codex, then each backend host, with counts', () => {
  const tabs = providerTabs([
    { provider: 'codex' }, { provider: 'anthropic' }, { provider: 'anthropic', backend: 'api.deepseek.com' },
    { provider: 'anthropic' }, { provider: 'anthropic', backend: 'example.test' },
  ]);
  assert.deepEqual(tabs.map(t => [t.key, t.label, t.count]), [
    ['all', 'All', 5], ['anthropic', 'Claude', 2], ['codex', 'Codex', 1],
    ['backend:api.deepseek.com', 'DeepSeek', 1], ['backend:example.test', 'example.test', 1],
  ]);
  assert.equal(accountGroup({}), 'anthropic');
  assert.equal(groupLabel('backend:__proto__'), '__proto__');
});

test('the five-hour pool uses session readings and resets independently of weekly quota', () => {
  const now = Date.now();
  const pool = poolSummary([
    { name: 'a', quota: { unified5h: 0.2, unified5hReset: now + 7200000, unified7d: 0.99, unified7dReset: now + 1000 } },
    { name: 'b', quota: { unified5h: 0.75, unified5hReset: now + 3600000, unified7d: 0.01 } },
    { name: 'disabled', disabled: true, quota: { unified5h: 0, unified5hReset: now + 2000 } },
    { name: 'no-session', quota: { unified7d: 0.4, sessionWindowStated: false } },
    { name: 'unknown', provider: 'codex', quota: { unified5h: NaN, unified7d: 0.2 } },
  ], 1, 'Fable', now);
  assert.equal(pool.label, '5-hour limit');
  assert.equal(pool.count, 2);
  assert.equal(pool.left, 1.05);
  assert.deepEqual(pool.segments, [
    { name: 'a', left: 0.8, tone: 'ok' },
    { name: 'b', left: 0.25, tone: 'warn' },
  ]);
  assert.deepEqual(pool.soonest, { name: 'b', resetAt: now + 3600000 });
  assert.equal(pool.unknown, 1);
});

test('the Logs page offers a chip for every kind the proxy records', () => {
  assert.equal(LOG_KINDS[0].key, 'all');
  assert.deepEqual(LOG_KINDS.slice(1).map(k => k.key), [...EVENT_KINDS]);
});

test('log pages merge in order, skip what is held, and keep at most the cap', () => {
  const a = mergeLogEvents(null, { generation: 'g1', events: [{ id: 1 }, { id: 2 }], lastId: 2 }, 10);
  assert.deepEqual(a.events.map(e => e.id), [1, 2]);
  assert.equal(a.generation, 'g1');
  assert.equal(a.refetch, false);
  const b = mergeLogEvents(a, { generation: 'g1', events: [{ id: 2 }, { id: 3 }], lastId: 3 }, 10);
  assert.deepEqual(b.events.map(e => e.id), [1, 2, 3]);
  assert.deepEqual(mergeLogEvents(b, { generation: 'g1', events: [{ id: 4 }, { id: 5 }], lastId: 5 }, 3).events.map(e => e.id), [3, 4, 5]);
});

test('a restarted server is a new log: what is held goes, and the page asks again from the start', () => {
  const held = { generation: 'old', events: [{ id: 1 }, { id: 2 }] };
  // The new process logged three events before the page polled again, so its
  // counter is past the cursor: ids alone would keep 1-2 from the old log and
  // never fetch the new 1-2. The generation says it is another log.
  const next = mergeLogEvents(held, { generation: 'new', events: [{ id: 3 }], lastId: 3 }, 10);
  assert.deepEqual(next, { generation: 'new', events: [], refetch: true });
  // A server that names no generation: a lastId behind what is held is the same restart.
  assert.equal(mergeLogEvents({ generation: null, events: [{ id: 5 }] }, { events: [], lastId: 1 }, 10).refetch, true);
});

test('log filters combine kind, provider and account', () => {
  const events = [
    { id: 1, kind: 'usage', provider: 'anthropic', account: 'a' },
    { id: 2, kind: 'signin', provider: 'codex', account: 'b' },
    { id: 3, kind: 'usage', provider: 'codex', account: 'b' },
  ];
  assert.deepEqual(filterLogEvents(events, { kind: 'usage' }).map(e => e.id), [1, 3]);
  assert.deepEqual(filterLogEvents(events, { kind: 'all', provider: 'codex' }).map(e => e.id), [2, 3]);
  assert.deepEqual(filterLogEvents(events, { kind: 'usage', account: 'b' }).map(e => e.id), [3]);
});

test('a log row\'s details say what a request carried, or the reason code', () => {
  assert.equal(logEventDetail({ model: 'claude-fable-5-1', status: 200, inputTokens: 1500, outputTokens: 7, ms: 1234 }),
    'Fable 5.1 \u00b7 200 \u00b7 1.5k in / 7 out \u00b7 1.2s');
  assert.equal(logEventDetail({ reason: 'refresh_rejected' }), 'refresh_rejected');
  assert.equal(logEventTone({ type: 'signed_out' }), 'bad');
  assert.equal(logEventTone({ type: 'rate_limited' }), 'warn');
  assert.equal(logEventTone({ type: 'request', status: 529 }), 'bad');
  assert.equal(logEventTone({ type: 'request', status: 200 }), '');
});

test('a refresh button is offered only where the probe would read the account', () => {
  assert.equal(canRefreshQuota({ name: 'a' }, { name: 'a', status: 'never' }), true);
  assert.equal(canRefreshQuota({ name: 'a' }, { name: 'a', status: 'running' }), true);
  assert.equal(canRefreshQuota({ name: 'a' }, { name: 'a', status: 'not-applicable' }), false);
  assert.equal(canRefreshQuota({ name: 'a', disabled: true }, { name: 'a', status: 'ok' }), false);
  assert.equal(canRefreshQuota({ name: 'a' }, null), false, 'no probe row, no button');
});

test('refreshQuotaRequest names the card\'s account with its provider and org', () => {
  const r = refreshQuotaRequest({ name: 'me@example.com', provider: 'codex', orgName: 'Acme' }, 'k');
  assert.equal(r.url, '/teamclaude/probe');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'k');
  assert.deepEqual(JSON.parse(r.init.body), { account: 'me@example.com', provider: 'codex', org: 'Acme' });
  // No org on the card, no org in the request: an empty one would match nothing.
  assert.deepEqual(JSON.parse(refreshQuotaRequest({ name: 'a', provider: 'anthropic', orgName: null }, null).init.body),
    { account: 'a', provider: 'anthropic' });
  assert.equal(refreshQuotaRequest({ name: 'a' }, null).init.headers['x-api-key'], '');
  assert.deepEqual(refreshQuotaOutcome({ ok: true, account: 'a', status: 'ok' }), { kind: 'ok', text: 'quota refreshed' });
  assert.deepEqual(refreshQuotaOutcome({ ok: false, error: 'the account is disabled' }),
    { kind: 'error', text: 'quota refresh failed: the account is disabled' });
  assert.equal(refreshQuotaOutcome(null).kind, 'error');
});

// ── Codex reset credits: the count each page shows, and the button ──────────

const NOW = Date.now();
/** @param {any} reading @param {Record<string, any>} [extra] */
const codexWith = (reading, extra = {}) => ({ name: 'c', provider: 'codex', quota: reading === undefined ? {} : { resetCredits: reading }, ...extra });

test('codexResetsLeft reads a fresh count, says zero, and stays silent without a reading', () => {
  assert.equal(codexResetsLeft(codexWith({ available: 2, seenAt: NOW - 60_000 }), NOW), 2);
  assert.equal(codexResetsLeft(codexWith({ available: 0, seenAt: NOW }), NOW), 0, 'zero is a reading, and the page says so');
  assert.equal(codexResetsLeft(codexWith(undefined), NOW), null, 'no usage reading yet');
  assert.equal(codexResetsLeft(codexWith({ available: 2, seenAt: NOW - 8 * 24 * 3600_000 }), NOW), null, 'too old to trust');
  assert.equal(codexResetsLeft(codexWith({ available: 1, seenAt: NOW, expiresAt: NOW - 1 }), NOW), 0, 'past its expiry');
  assert.equal(codexResetsLeft({ name: 'x', provider: 'anthropic', quota: { resetCredits: { available: 1, seenAt: NOW } } }, NOW), null,
    'a Claude banked reset is not a Codex one');
});

test('codexResetsSummary adds up the accounts that have a reading', () => {
  const accounts = [codexWith({ available: 2, seenAt: NOW }), codexWith({ available: 1, seenAt: NOW }), codexWith(undefined), codexWith({ available: 0, seenAt: NOW })];
  assert.deepEqual(codexResetsSummary(accounts, NOW), { left: 3, accounts: 3 });
  assert.equal(codexResetsSummary([codexWith(undefined)], NOW), null);
  assert.equal(codexResetsSummary([], NOW), null);
});

test('the reset button needs a credit, an enabled account and a key allowed to spend it', () => {
  const operator = { kind: 'operator', client: null, refused: [] };
  const client = { kind: 'client', client: 'laptop', refused: ['/teamclaude/reset-credits/redeem'] };
  const holding = codexWith({ available: 1, seenAt: NOW });
  assert.equal(canRedeemReset(holding, operator, NOW), true);
  assert.equal(canRedeemReset(holding, client, NOW), false);
  assert.equal(canRedeemReset({ ...holding, disabled: true }, operator, NOW), false);
  assert.equal(canRedeemReset(codexWith({ available: 0, seenAt: NOW }), operator, NOW), false);
  assert.equal(canRedeemReset(codexWith(undefined), operator, NOW), false);
});

test('redeemResetRequest posts the card\'s account to the redeem route', () => {
  const r = redeemResetRequest({ name: 'me@example.com', provider: 'codex', orgName: 'Acme' }, 'k');
  assert.equal(r.url, '/teamclaude/reset-credits/redeem');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'k');
  assert.deepEqual(JSON.parse(r.init.body), { account: 'me@example.com', provider: 'codex', org: 'Acme' });
});

test('redeemResetOutcome tells a spent reset, a declined one and an unanswered one apart', () => {
  assert.deepEqual(redeemResetOutcome({ ok: true, windowsReset: 2 }), { kind: 'ok', text: 'usage reset: 2 limit windows cleared' });
  assert.deepEqual(redeemResetOutcome({ ok: true, windowsReset: 1 }), { kind: 'ok', text: 'usage reset: 1 limit window cleared' });
  assert.deepEqual(redeemResetOutcome({ ok: true }), { kind: 'ok', text: 'usage reset' });
  assert.equal(redeemResetOutcome({ ok: false, code: 'nothing_to_reset' }).kind, 'warn');
  assert.match(redeemResetOutcome({ ok: false, code: 'nothing_to_reset' }).text, /no reset was used/);
  assert.equal(redeemResetOutcome({ ok: false, code: 'no_credit' }).text, 'no resets left on this account');
  assert.match(redeemResetOutcome({ ok: false, uncertain: true, error: 'x' }).text, /may still have gone through/);
  assert.deepEqual(redeemResetOutcome({ ok: false, error: 'a client key cannot spend reset credits' }),
    { kind: 'error', text: 'reset failed: a client key cannot spend reset credits' });
  // The relay's answer when a linked instance dropped the connection: the
  // peer may have spent the credit before it went.
  assert.deepEqual(redeemResetOutcome({ ok: false, unreachable: true, error: 'laptop is unreachable (socket hang up)' }),
    { kind: 'error', text: REDEEM_UNCERTAIN_TEXT });
  assert.deepEqual(redeemResetOutcome(null), { kind: 'error', text: REDEEM_UNCERTAIN_TEXT },
    'no verdict read is not a failure: the credit may be gone');
});

test('resetClickStep decides on the clock at the click, not when the button was drawn', () => {
  const T = 1_000_000;
  assert.equal(resetClickStep(undefined, T, 8000, 400), 'arm');
  assert.equal(resetClickStep(T, T + 100, 8000, 400), 'wait', 'a double-click is not a decision');
  assert.equal(resetClickStep(T, T + 2000, 8000, 400), 'redeem');
  assert.equal(resetClickStep(T, T + 8000, 8000, 400), 'arm', 'the window has closed: arm again');
  assert.equal(resetClickStep(T, T + 60_000, 8000, 400), 'arm');
});

test('account token total includes the cache fields', () => {
  // totalInputTokens counts uncached input only; omitting the cache fields
  // understates a Claude Code account by orders of magnitude.
  assert.equal(accountTokens({
    totalInputTokens: 1, totalOutputTokens: 2,
    totalCacheReadTokens: 100, totalCacheCreationTokens: 10,
  }), 113);
  assert.equal(accountTokens({}), 0);
  assert.equal(accountTokens(null), 0);
});

test('account metadata and session state are separate badges', () => {
  const badges = accountBadges({
    name: 'corp', provider: 'codex', type: 'oauth', priority: -2,
    status: 'active', sessions: 1, knownSessions: 3,
  }, 'legacy', { anthropic: 'personal', codex: 'corp' });
  assert.deepEqual(badges, [
    { cls: 'provider codex', text: 'Codex' },
    { cls: 'meta', text: 'oauth' },
    { cls: 'meta priority', text: 'prio -2' },
    { cls: 'current', text: 'current' },
    { cls: 'active', text: 'active' },
    { cls: 'sessions', text: '1 recent' },
    { cls: 'sessions known', text: '3 known' },
  ]);
});

// ── per-account switch threshold (#409) ───────────────────────

test('thresholdBadgeText is silent with no override, or one that matches the fleet', () => {
  assert.equal(thresholdBadgeText(null, 0.98, null), '');
  assert.equal(thresholdBadgeText(undefined, 0.98, null), '');
  assert.equal(thresholdBadgeText(0.98, 0.98, null), '');
  assert.equal(thresholdBadgeText({ unified7d: 0.98 }, 0.98, null), '');
  // A hand-edited array is the #425 hazard class — refused, not spread into
  // numeric bucket keys.
  assert.equal(thresholdBadgeText([0.5], 0.98, null), '');
});

test('thresholdBadgeText names a bare-number override "at", and a table by bucket', () => {
  assert.equal(thresholdBadgeText(1.0, 0.98, null), 'switch at 100%');
  assert.equal(thresholdBadgeText({ unified7dFable: 0.8 }, 0.98, null), 'switch fable 80%');
  assert.equal(
    thresholdBadgeText({ unified7d: 0.9, unified7dFable: 0.8 }, 0.98, null),
    'switch 7d 90%, fable 80%',
  );
  // A per-bucket fleet table, not just a bare fleet number: the account's
  // unified7d entry is compared against the fleet's OWN unified7d, not its
  // default — an account that merely matches the fleet's per-bucket override
  // must stay silent on that bucket.
  assert.equal(thresholdBadgeText({ unified7d: 0.9 }, 0.98, { default: 0.98, unified7d: 0.9 }), '');
  assert.equal(thresholdBadgeText({ unified7d: 0.85 }, 0.98, { default: 0.98, unified7d: 0.9 }), 'switch 7d 85%');
});

test('thresholdBadgeText names a bucket the account default moves off the fleet table', () => {
  // The defaults agree, so the old default-to-default comparison said nothing,
  // yet this account's weekly wall really is 98% where the fleet's is 85%.
  const fleetTable = { default: 0.98, unified7d: 0.85 };
  assert.equal(thresholdBadgeText(0.98, 0.98, fleetTable), 'switch 7d 98%');
  assert.equal(thresholdBadgeText({ default: 0.98 }, 0.98, fleetTable), 'switch 7d 98%');
  // An account entry for that bucket answers for it, equal to the fleet's or not.
  assert.equal(thresholdBadgeText({ default: 0.98, unified7d: 0.85 }, 0.98, fleetTable), '');
  // A differing default already covers every unlisted bucket.
  assert.equal(thresholdBadgeText(1.0, 0.98, fleetTable), 'switch at 100%');
});

test('accountBadges names a routed account\'s proxy as the status payload masks it, and stays silent otherwise', () => {
  const routed = accountBadges({ name: 'a', type: 'oauth', routing: 'socks5h://alice:***@proxy.example.com:1080' }, null, null);
  assert.deepEqual(routed.find(b => b.cls === 'meta routing'), { cls: 'meta routing', text: 'via socks5h://alice:***@proxy.example.com:1080' });
  assert.equal(accountBadges({ name: 'a', type: 'oauth' }, null, null).some(b => /routing/.test(b.cls)), false);
  // The payload is masked at the source. A parsed object would mean the live
  // account leaked into it, password and all: draw nothing rather than that.
  const leaked = accountBadges({ name: 'a', type: 'oauth', routing: { host: 'h', password: 'p' } }, null, null);
  assert.equal(leaked.some(b => /routing/.test(b.cls)), false);
});

test('accountBadges adds the threshold badge only when it differs from the fleet', () => {
  const withFleet = accountBadges({ name: 'a', type: 'oauth', switchThreshold: 1.0 }, null, null, null, 0.98, null);
  assert.deepEqual(withFleet[withFleet.length - 1], { cls: 'meta threshold', text: 'switch at 100%' });

  const matching = accountBadges({ name: 'a', type: 'oauth', switchThreshold: 0.98 }, null, null, null, 0.98, null);
  assert.ok(!matching.some(b => b.cls.includes('threshold')), 'an override equal to the fleet stays silent');

  // No `switchThreshold` on the account at all (the common case, and the
  // shape the pre-#409 unit test above still exercises): no badge, whatever
  // the fleet args are, fleet omitted included — never a crash.
  const noOverride = accountBadges({ name: 'a', type: 'oauth' }, null, null);
  assert.ok(!noOverride.some(b => b.cls.includes('threshold')));
});

// The shape the server emits: a row is one CONVERSATION, keyed by the pin key
// routing uses, with the session it belongs to and the conversation's digest
// beside it as separate labels.
const SESSIONS = {
  items: [
    {
      id: 's-old/conv-old-0123456789abc', session: 's-old', conversation: 'conv-old-0123456789abc',
      client: 'bob', dimensions: { project: 'p2' }, active: false,
      requests: 2, lastSeen: 200, pins: { unified7d: 1 },
      tokens: { unified7d: { cacheRead: 5, cacheCreation: 1, input: 2, output: 1, context: 8 } },
    },
    {
      id: 's-new/conv-new-0123456789abc', session: 's-new', conversation: 'conv-new-0123456789abc',
      client: 'alice', dimensions: { project: 'p1' }, active: true,
      requests: 1, lastSeen: 100, pins: { unified7d: 0, unified7dFable: 1 },
      tokens: {
        unified7d: { cacheRead: 900, cacheCreation: 50, input: 10, output: 5, context: 960 },
        unified7dFable: { cacheRead: 0, cacheCreation: 0, input: 4, output: 2, context: 4 },
      },
    },
  ],
};

test('a conversation row totals what the responses reported, cache included', () => {
  const rows = sessionRows(SESSIONS);
  const row = rows.find(r => r.session === 's-new');
  // input+output alone would say 21 for a conversation that actually cost 971.
  assert.equal(row.input + row.output, 21);
  assert.equal(row.total, 971);
  assert.equal(row.cacheRead, 900);
  // Summed across every weekly bucket the conversation touched.
  assert.equal(row.context, 964);
  // A conversation spending two model families is served by two accounts at
  // once, which is why this is a pin map and not one index.
  assert.equal(row.accounts, '0, 1');
  assert.equal(row.client, 'alice');
  assert.equal(row.project, 'p1');
});

test('a fan-out is one row per conversation, under the one session that owns them', () => {
  // The rows of one client session are identical but for the conversation, so
  // the session alone cannot tell them apart — and the key that can is a
  // composite nobody recognises, so it is not what the table shows.
  const rows = sessionRows({
    items: [
      { id: 'sess-7/aaaaaaaaaaaaaaaaaaaaaa', session: 'sess-7', conversation: 'aaaaaaaaaaaaaaaaaaaaaa', client: 'alice', pins: {}, tokens: {} },
      { id: 'sess-7/bbbbbbbbbbbbbbbbbbbbbb', session: 'sess-7', conversation: 'bbbbbbbbbbbbbbbbbbbbbb', client: 'alice', pins: {}, tokens: {} },
    ],
  });
  assert.deepEqual(rows.map(r => r.session), ['sess-7', 'sess-7']);
  // Eight characters of the digest: enough to separate siblings, narrow enough
  // for a column beside the session.
  assert.deepEqual(rows.map(r => r.conversation), ['aaaaaaaa', 'bbbbbbbb']);
});

test('session rows tolerate a payload with nothing in it', () => {
  assert.deepEqual(sessionRows({}), []);
  assert.deepEqual(sessionRows(null), []);
  // A record no request ever labelled (touch() alone) names no session, and
  // falls back to the key it is filed under rather than rendering blank.
  const [bare] = sessionRows({ items: [{ id: 'x' }] });
  assert.deepEqual(
    { id: bare.id, session: bare.session, conversation: bare.conversation, client: bare.client, project: bare.project, total: bare.total, accounts: bare.accounts },
    { id: 'x', session: 'x', conversation: '', client: '', project: '', total: 0, accounts: '' },
  );
});

test('filters narrow by project and client, and combine', () => {
  const rows = sessionRows(SESSIONS);
  assert.deepEqual(filterSessionRows(rows, { project: 'p1' }).map(r => r.session), ['s-new']);
  assert.deepEqual(filterSessionRows(rows, { client: 'bob' }).map(r => r.session), ['s-old']);
  assert.deepEqual(filterSessionRows(rows, { project: 'p1', client: 'bob' }), []);
  // An empty filter is "All", not a match against the empty string.
  assert.equal(filterSessionRows(rows, { project: '', client: '' }).length, 2);
  assert.equal(filterSessionRows(rows, {}).length, 2);
});

test('sorting handles both text and number columns, and does not mutate', () => {
  const rows = sessionRows(SESSIONS);
  const before = rows.map(r => r.session);
  assert.deepEqual(sortRows(rows, 'total', 'desc').map(r => r.session), ['s-new', 's-old']);
  assert.deepEqual(sortRows(rows, 'total', 'asc').map(r => r.session), ['s-old', 's-new']);
  assert.deepEqual(sortRows(rows, 'client', 'asc').map(r => r.session), ['s-new', 's-old']);
  assert.deepEqual(sortRows(rows, 'client', 'desc').map(r => r.session), ['s-old', 's-new']);
  assert.deepEqual(rows.map(r => r.session), before, 'the caller\'s array is untouched');
  assert.deepEqual(sortRows(null, 'total', 'desc'), []);
});

test('filter options are unique, sorted, and drop the unlabelled', () => {
  assert.deepEqual(uniqSorted(['b', 'a', '', 'a', null, undefined]), ['a', 'b']);
  assert.deepEqual(uniqSorted([]), []);
  assert.deepEqual(uniqSorted(null), []);
});

test('switchOutcome separates the choice being recorded from traffic following it', () => {
  assert.deepEqual(switchOutcome({ ok: true, account: 'b', eligible: true }), { kind: 'ok', text: 'switched to b' });
  // A spent or disabled target is still switched to (that is the TUI's behaviour),
  // but saying "done" would hide that rotation skips it on the very next request.
  assert.deepEqual(
    switchOutcome({ ok: true, account: 'b', eligible: false, reason: 'disabled by operator' }),
    { kind: 'warn', text: 'switched to b, but rotation will not use it: disabled by operator' },
  );
  assert.deepEqual(switchOutcome({ ok: false, error: 'no such account "x"' }), { kind: 'error', text: 'switch failed: no such account "x"' });
  assert.deepEqual(switchOutcome(null), { kind: 'error', text: 'switch failed' });
});

test('the switch button\'s request passes the same-origin gate and moves the current account', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'api_key', apiKey: 'sk-a' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  const origin = `http://127.0.0.1:${port}`;
  const status = async () => (await fetch(`${origin}/teamclaude/status`, { headers: { 'x-api-key': 'secret' } })).json();
  try {
    assert.equal((await status()).currentAccount, 'a');

    // The request the page builds, plus the two headers a browser adds to a
    // same-origin fetch. This proves the CSRF gate, not the key: the test runs
    // on loopback, which the key gate exempts, so the key here is inert. Key
    // acceptance is covered in control-csrf.test.js; the gate is what the
    // button depends on, and it runs regardless of loopback.
    const r = switchRequest('b', 'secret');
    const ok = await fetch(origin + r.url, { ...r.init, headers: { ...r.init.headers, origin, 'sec-fetch-site': 'same-origin' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, account: 'b', eligible: true });
    assert.equal((await status()).currentAccount, 'b');

    // The same request from another site is refused — a page the operator
    // happens to visit cannot drive the button.
    const evil = await fetch(origin + r.url, { ...r.init, headers: { ...r.init.headers, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    assert.equal(evil.status, 403);
    assert.match((await evil.json()).error, /cross-origin/);
    assert.equal((await status()).currentAccount, 'b', 'unchanged');
  } finally {
    proxy.close();
  }
});

test('the dashboard exposes reload and one-shot probe controls', () => {
  const html = renderDashboardHtml();
  assert.match(html, /id="reload"/);
  assert.match(html, /id="probe"/);
  assert.match(html, /\/teamclaude\/reload/);
  assert.match(html, /\/teamclaude\/probe/);
});

test('the probe control invokes the server hook', async () => {
  let calls = 0;
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-x' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: 'http://127.0.0.1:9' }, {
    probeQuota: async () => { calls++; },
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/probe`, {
      method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
    });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(calls, 1);
  } finally {
    proxy.close();
  }
});

test('the probe route refreshes one account when the body names it', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'api_key', apiKey: 'sk-a' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  let fleet = 0;
  const single = [];
  const answers = {
    a: { probed: true, status: { status: 'ok', error: null } },
    b: { probed: false, reason: 'the account is disabled' },
  };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: 'http://127.0.0.1:9' }, {
    probeQuota: async () => { fleet++; },
    probeAccountQuota: async (account) => { single.push(account.name); return answers[account.name]; },
  });
  const port = await listen(proxy);
  const post = body => fetch(`http://127.0.0.1:${port}/teamclaude/probe`, {
    method: 'POST', headers: { 'x-api-key': 'secret', 'content-type': 'application/json' }, body,
  });
  try {
    let res = await post(JSON.stringify({ account: 'a' }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, account: 'a', status: 'ok' });
    assert.deepEqual(single, ['a']);
    assert.equal(fleet, 0, 'a named account is not a fleet probe');

    res = await post(JSON.stringify({ account: 'b' }));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, account: 'b', error: 'the account is disabled' });

    answers.a = { probed: true, status: { status: 'error', error: 'usage endpoint said no' } };
    res = await post(JSON.stringify({ account: 'a' }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, account: 'a', status: 'error', error: 'usage endpoint said no' });

    res = await post(JSON.stringify({ account: 'nobody' }));
    assert.equal(res.status, 404);
    assert.deepEqual((await res.json()).accounts, ['a', 'b']);

    res = await post(JSON.stringify({ account: '  ' }));
    assert.equal(res.status, 400);
    res = await post('{not json');
    assert.equal(res.status, 400);
    assert.deepEqual(single, ['a', 'b', 'a'], 'nothing probed for a bad request');

    // No body is still the fleet probe the CLI and the page-wide button send.
    res = await post(undefined);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(fleet, 1);
  } finally {
    proxy.close();
  }
});

test('the probe route refreshes the namesake the card names, not the first match', async () => {
  // One email holding a Claude and a Codex login: the same name on two cards.
  const am = new AccountManager([
    { name: 'me@example.com', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'me@example.com', type: 'oauth', provider: 'codex', accountId: 'acct', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  const probed = [];
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: 'http://127.0.0.1:9' }, {
    probeQuota: async () => {},
    probeAccountQuota: async (account) => { probed.push(account); return { probed: true, status: { status: 'ok' } }; },
  });
  const port = await listen(proxy);
  const post = body => fetch(`http://127.0.0.1:${port}/teamclaude/probe`, {
    method: 'POST', headers: { 'x-api-key': 'secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    let res = await post({ account: 'me@example.com', provider: 'codex' });
    assert.equal(res.status, 200);
    assert.equal(probed.at(-1), am.accounts[1]);
    res = await post({ account: 'me@example.com', provider: 'anthropic' });
    assert.equal(res.status, 200);
    assert.equal(probed.at(-1), am.accounts[0]);
    // The name alone is refused rather than resolved to whichever comes first.
    res = await post({ account: 'me@example.com' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /more than one account/);
    assert.equal(probed.length, 2);
  } finally {
    proxy.close();
  }
});

test('resolveAccountTarget narrows by org, and by uuid without asking', () => {
  const am = { accounts: [
    { name: 'me@example.com (Acme)', orgName: 'Acme', orgUuid: 'org-1', accountUuid: 'u-1' },
    { name: 'me@example.com (Beta)', orgName: 'Beta', orgUuid: 'org-2', accountUuid: 'u-1' },
  ] };
  assert.deepEqual(resolveAccountTarget(am, { account: 'me@example.com', org: 'beta' }), { index: 1 });
  assert.deepEqual(resolveAccountTarget(am, { account: 'me@example.com', org: 'org-1' }), { index: 0 });
  assert.deepEqual(resolveAccountTarget(am, { account: 'me@example.com' }), { ambiguous: true });
  assert.deepEqual(resolveAccountTarget(am, { account: 'me@example.com (Beta)' }), { index: 1 });
  assert.deepEqual(resolveAccountTarget(am, { account: 'u-1/org-2' }), { index: 1 });
  assert.equal(resolveAccountTarget(am, { account: 'me@example.com', org: 'Gamma' }), null);
});

test('a server without a single-account probe says so rather than probing the fleet', async () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  let fleet = 0;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: 'http://127.0.0.1:9' }, {
    probeQuota: async () => { fleet++; },
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/probe`, {
      method: 'POST', headers: { 'x-api-key': 'secret' }, body: JSON.stringify({ account: 'a' }),
    });
    assert.equal(res.status, 501);
    assert.equal(fleet, 0);
  } finally {
    proxy.close();
  }
});

// The shape /teamclaude/status reports per route: the server's own target for
// the family, and every account with whether it could serve it.
const ROUTED = {
  currentAccount: 'a',
  routes: [{
    name: 'fable', match: ['*fable*'], autocreated: true, pinned: null, target: 'b',
    accounts: [{ name: 'a', eligible: false }, { name: 'b', eligible: true }, { name: 'c', eligible: true }],
  }],
};

test('dashboard payload identifies both provider cursors without one false global current', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'codex', type: 'oauth', provider: 'codex', accountId: 'acct', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.98);
  am.getActiveAccount(null, 'gpt-5.6-sol', null, null, 'codex');

  const status = am.getStatus();
  assert.deepEqual(status.currentAccounts, { anthropic: 'claude', codex: 'codex' });
  const html = renderDashboardHtml();
  assert.match(html, /currentAccounts/);
  assert.match(html, /providerLabel/);
});

test('mixed-provider routing reports one default row per provider', () => {
  const rows = routeRows({
    currentAccount: 'codex',
    currentAccounts: { anthropic: 'claude', codex: 'codex' },
    defaultTargets: { anthropic: 'claude', codex: 'codex' },
    accounts: [
      { name: 'claude', provider: 'anthropic', unavailable: null },
      { name: 'codex', provider: 'codex', unavailable: null },
    ],
    routes: [{
      name: 'fable', provider: 'anthropic', match: ['*fable*'], target: 'claude',
      accounts: [{ name: 'claude', eligible: true }],
    }],
  });
  assert.deepEqual(
    rows.map(r => ({ label: r.label, provider: r.provider, target: r.target })),
    [
      { label: 'Fable', provider: 'anthropic', target: 'claude' },
      { label: 'Claude default', provider: 'anthropic', target: 'claude' },
      { label: 'Codex default', provider: 'codex', target: 'codex' },
    ],
  );
});

test('route rows say where each family goes, why, and where everything else goes', () => {
  const rows = routeRows(ROUTED);
  assert.equal(rows.length, 2);
  const [fable, rest] = rows;
  // A family diverted away from the current account shows the server's target,
  // not a re-derivation from quota bars, and names the accounts that cannot
  // take it — that is the reason the family is elsewhere.
  assert.deepEqual(
    { label: fable.label, match: fable.match, target: fable.target, eligible: fable.eligible, ineligible: fable.ineligible },
    { label: 'Fable', match: '*fable*', target: 'b', eligible: ['b', 'c'], ineligible: ['a'] },
  );
  assert.equal(fable.autocreated, true);
  // The default row is the current account: everything without a route lands there.
  assert.deepEqual({ label: rest.label, target: rest.target, match: rest.match }, { label: 'Everything else', target: 'a', match: '' });
});

test('a pinned route carries its pin, and says when routing is not honouring it', () => {
  const honoured = routeRows({ ...ROUTED, routes: [{ ...ROUTED.routes[0], pinned: 'c', target: 'c' }] })[0];
  assert.deepEqual({ pinned: honoured.pinned, target: honoured.target, mismatch: honoured.pinMismatch }, { pinned: 'c', target: 'c', mismatch: false });
  // The server skips a pin whose account cannot serve the family; "b · pinned"
  // would read as b being the pin. The row must carry both names.
  const skipped = routeRows({ ...ROUTED, routes: [{ ...ROUTED.routes[0], pinned: 'c', target: 'b' }] })[0];
  assert.deepEqual({ pinned: skipped.pinned, target: skipped.target, mismatch: skipped.pinMismatch }, { pinned: 'c', target: 'b', mismatch: true });
});

test('the default row is the server\'s defaultTarget, and says why when it is not the current account', () => {
  const blocked = { ...ROUTED, defaultTarget: 'b', accounts: [{ name: 'a', unavailable: 'throttled' }, { name: 'b', unavailable: null }] };
  const row = routeRows(blocked)[1];
  assert.equal(row.kind, 'default');
  assert.equal(row.target, 'b', 'not the current account');
  assert.equal(row.current, 'a');
  assert.equal(row.currentUnavailable, 'throttled');
  // Without defaultTarget (an older server) the row falls back to the current account.
  assert.equal(routeRows(ROUTED)[1].target, 'a');
});

test('a route whose every glob is blocked has no reachable target', () => {
  assert.equal(routeRows({ ...ROUTED, blockedModels: ['*fable*'] })[0].blocked, true);
  assert.equal(routeRows({ ...ROUTED, blockedModels: ['*opus*'] })[0].blocked, false);
  assert.equal(routeRows(ROUTED)[0].blocked, false);
  const empty = routeRows({ ...ROUTED, routes: [{ ...ROUTED.routes[0], target: null, accounts: [] }] })[0];
  assert.deepEqual({ target: empty.target, eligible: empty.eligible, ineligible: empty.ineligible }, { target: null, eligible: [], ineligible: [] });
});

test('route rows read the shape a real AccountManager reports', () => {
  const am = new AccountManager([
    { name: 'a', type: 'api_key', apiKey: 'sk-a' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  const H = 3600_000;
  Object.assign(am.accounts[0].quota, { unified7d: 0.3, unified7dReset: Date.now() + 4 * H, unified7dFable: 0.99, unified7dFableReset: Date.now() + 4 * H });
  Object.assign(am.accounts[1].quota, { unified7d: 0.1, unified7dReset: Date.now() + 90 * H, unified7dFable: 0.1, unified7dFableReset: Date.now() + 90 * H });
  const rows = routeRows(am.getStatus());
  const fable = rows.find(r => r.name === 'fable');
  assert.ok(fable, 'the server autocreates a Fable route once an account meters it');
  assert.deepEqual({ target: fable.target, ineligible: fable.ineligible }, { target: 'b', ineligible: ['a'] });
  assert.deepEqual({ target: rows[rows.length - 1].target, current: rows[rows.length - 1].current }, { target: 'a', current: 'a' });
  // The current account becomes unusable: the default row follows the server,
  // not the stale current name.
  am.setDisabled(0, true);
  const after = routeRows(am.getStatus())[rows.length - 1];
  assert.deepEqual({ target: after.target, current: after.current, why: after.currentUnavailable }, { target: 'b', current: 'a', why: 'disabled' });
});

test('a fleet with no routes renders no section', () => {
  // Without a metered family there is nothing to route: the summary line
  // already names the current account, so no redundant one-row table.
  assert.deepEqual(routeRows({ currentAccount: 'a', routes: [] }), []);
  assert.deepEqual(routeRows({ currentAccount: 'a' }), []);
  assert.deepEqual(routeRows(null), []);
});

// Built from a REAL getStatus() rather than a hand-written object: a previous
// version of this banner was validated against a payload the server can never
// emit, and the impossible fixture hid a false positive.
function fleetStatus(mutate) {
  const am = new AccountManager([
    { name: 'a', type: 'api_key', apiKey: 'sk-a' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  mutate?.(am);
  return am.getStatus({ sessionDetail: true });
}
/**
 * Drive a conversation to `n` consecutive no-answer outcomes on a real tracker.
 * `id` is the pin key; `labels` carries the session and conversation names the
 * request path attaches to it, which most cases here do not need.
 */
function starve(am, id, n, client = 'alice', labels = null) {
  for (let i = 0; i < n; i++) {
    am.beginSession(id, { client, dimensions: {}, ...labels });
    am.endSession(id, false);
  }
}

test('a starving session is named, and a working one is not', () => {
  const named = problems(fleetStatus(am => starve(am, 'deadbeef1234', STARVED_MIN)));
  assert.equal(named.length, 1);
  assert.equal(named[0].kind, 'starved-session');
  assert.equal(named[0].severity, 'bad');
  assert.match(named[0].text, /alice's session deadbeef/);
  assert.match(named[0].text, new RegExp(`${STARVED_MIN} requests in a row`));

  // One usable answer clears the streak — the session is working again.
  assert.deepEqual(problems(fleetStatus(am => {
    starve(am, 'deadbeef1234', STARVED_MIN);
    am.beginSession('deadbeef1234'); am.endSession('deadbeef1234', true);
  })), []);
  // Literals, not STARVED_MIN: written in terms of the constant, these passed
  // with the threshold set to 1 (fires on a single failure) and to 20 (never
  // fires). The value is part of the behaviour, so the test has to name it.
  assert.deepEqual(problems(fleetStatus(am => starve(am, 'deadbeef1234', 4))), [], 'four in a row is a wobble');
  assert.equal(problems(fleetStatus(am => starve(am, 'deadbeef1234', 5))).length, 1, 'five is an alarm');
  // A brand-new session, and a fleet doing nothing.
  assert.deepEqual(problems(fleetStatus(am => am.beginSession('fresh1234', { client: 'bob' }))), []);
  assert.deepEqual(problems(fleetStatus()), []);
});

test('a starving line names the session and the conversation, never the key', () => {
  // A fan-out starves as a group, so lines carrying only the session would read
  // as the same line repeated; the pin key that does separate them is a
  // composite an operator has never seen and cannot look up.
  const out = problems(fleetStatus(am => starve(am, 'deadbeef1234/AbCdEfGhIjKlMnOpQrStUv', STARVED_MIN, 'alice',
    { sessionId: 'deadbeef1234', conversation: 'AbCdEfGhIjKlMnOpQrStUv' })));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /alice's session deadbeef, conversation AbCdEfGh, has had/);
  assert.doesNotMatch(out[0].text, /\//);
});

test('a session that starved and then went quiet stops being reported', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  starve(am, 'deadbeef1234', 9);
  assert.equal(problems(am.getStatus({ sessionDetail: true })).length, 1, 'reported while it is trying');
  // Past the active window: the row survives in items[] with its streak intact,
  // and only `active` keeps it out of the banner — deleting that filter passed
  // every other test in this file.
  const rec = am.sessionTracker.sessions.get('deadbeef1234');
  rec.lastSeen -= 5 * 60 * 1000;
  rec.inFlight = 0;
  const detailed = am.getStatus({ sessionDetail: true });
  assert.equal(detailed.sessions.items[0].starved, 9, 'the streak is still on the record');
  assert.deepEqual(problems(detailed), [], 'but a session that stopped trying is not starving');
  assert.deepEqual(problems(am.getStatus()), [], 'and the aggregate has cleared too');
});

test('many starving sessions are capped, worst first, with the rest counted', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  const depth = { aaaaaaaa1111: 5, bbbbbbbb2222: 9, cccccccc3333: 6, dddddddd4444: 7, eeeeeeee5555: 8 };
  for (const [id, n] of Object.entries(depth)) starve(am, id, n, id.slice(0, 3));
  const out = problems(am.getStatus({ sessionDetail: true }));
  assert.equal(out.length, STARVED_LIST_MAX + 1, 'capped, plus one summary line');
  // Worst first — items[] arrives sorted by recency, which is a different order.
  assert.match(out[0].text, /bbbbbbbb/);
  assert.match(out[1].text, /eeeeeeee/);
  assert.match(out[2].text, /dddddddd/);
  assert.equal(out[3].kind, 'starved-more');
  assert.match(out[3].text, new RegExp(`and ${5 - STARVED_LIST_MAX} more`));
});

test('when the whole fleet is stalled the banner says so instead of blaming the session', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  am.accounts[0].quota.unified5h = 0.99;              // over the switch threshold
  starve(am, 'deadbeef1234', 5);
  const out = problems(am.getStatus({ sessionDetail: true }));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /every account is over its quota threshold/);
  assert.doesNotMatch(out[0].text, /it is failing, not idle/);
});

test('without sessionDetail the banner still fires, unnamed', () => {
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  starve(am, 'deadbeef1234', STARVED_MIN);
  const hidden = am.getStatus();               // sessionDetail off — no items[]
  assert.equal('items' in hidden.sessions, false);
  const out = problems(hidden);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'starved-session');
  assert.match(out[0].text, /proxy.sessionDetail/);
  // And it is not doubled when both the row and the aggregate are available.
  assert.equal(problems(am.getStatus({ sessionDetail: true })).length, 1);
});

test('an account whose organization refused OAuth carries a badge until it serves again', () => {
  const denied = accountBadges({
    name: 'a', type: 'oauth', status: 'active',
    entitlementDenial: { detail: 'OAuth authentication is currently not allowed for this organization.', since: 1, lastAt: 1, count: 3 },
  }, null, null);
  assert.deepEqual(denied.find(b => /denied/.test(b.text)), { cls: 'throttled', text: 'OAuth denied \u00d73' });
  assert.equal(accountBadges({ name: 'a', type: 'oauth', status: 'active' }, null, null).some(b => /denied/.test(b.text)), false);
});

test('only the account states that need a person are reported', () => {
  // These clear themselves — rotation and back-off working.
  // `status = 'exhausted'` is never assigned anywhere in src/, so a fixture that
  // sets it proves nothing. These four are all reachable.
  for (const quiet of [
    am => am.markRateLimited(0, 60),
    am => am.markEntitlementDenied(0),
    am => { am.accounts[0].maxUsage = 0.5; am.accounts[0].quota.unified5h = 0.9; },
    am => { am.accounts[0].quota.unifiedStatus = 'rejected'; am.accounts[0].quota.unifiedStatusSeenAt = Date.now(); },
  ]) assert.deepEqual(problems(fleetStatus(quiet)), [], 'self-clearing state must stay silent');

  // These do not.
  const broken = problems(fleetStatus(am => { am.accounts[0].status = 'error'; }));
  assert.deepEqual(broken.map(p => p.kind), ['account']);
  assert.match(broken[0].text, /re-login/);
  const off = problems(fleetStatus(am => am.setDisabled(0, true)));
  assert.deepEqual(off.map(p => p.kind), ['account']);
  assert.match(off[0].text, /disabled/);
  // An account upstream refused is not cured by a re-login alone.
  const refused = problems(fleetStatus(am => am.markRefused(am.accounts[0], { code: 'account_on_hold', message: 'on hold', link: null })));
  assert.deepEqual(refused.map(p => p.kind), ['account']);
  assert.match(refused[0].text, /refused by upstream/);
  assert.doesNotMatch(refused[0].text, /re-login/);
});

test('overage spend is not a banner line', () => {
  // usedMinor is month-to-date, so once overage is switched on this would be lit
  // for most of the month. The account card and `teamclaude status` carry it,
  // with the amount, which the banner did not.
  assert.deepEqual(problems(fleetStatus(am => { am.accounts[0].quota.spend = { enabled: true, usedMinor: 250 }; })), []);
});

test('the serialized helpers run in the page\'s own scope, not just parse', () => {
  // Parsing and grepping both pass for a helper that closes over a module
  // constant the page never ships — it would ReferenceError at first render.
  // Evaluate ONLY the serialized bundle and call into it.
  const html = renderDashboardHtml();
  const script = inlineScripts(html).at(-1);
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return problems;`)();
  const payload = { sessions: { items: [{ id: 'deadbeef1234', client: 'alice', active: true, starved: 9, requests: 9, pins: {}, tokens: {} }] } };
  assert.deepEqual(isolated(payload), problems(payload), 'the page runs what the tests exercise');
});

// The threshold badge specifically: accountBadges calls thresholdBadgeText by
// NAME, not by reference, so if the two ever land on different sides of the
// `bundle` slice (or thresholdBadgeText is dropped from SHARED_HELPERS while
// accountBadges keeps calling it) this is a page-breaking ReferenceError that
// grepping the source would not catch — only running the bundle does.
test('accountBadges calls thresholdBadgeText inside the same serialized bundle', () => {
  const html = renderDashboardHtml();
  const script = inlineScripts(html).at(-1);
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return accountBadges;`)();
  const account = { name: 'a', type: 'oauth', switchThreshold: 1.0 };
  assert.deepEqual(isolated(account, null, null, null, 0.98, null), accountBadges(account, null, null, null, 0.98, null));
});

// The bare number above never reaches the bucket tables: only a TABLE-form
// override reads THRESHOLD_BUCKET_KEYS and THRESHOLD_BUCKET_LABELS, and those
// are module constants the page does not see unless SHARED_CONSTS writes them
// in. Imported, the helper finds them in module scope and passes; in the page
// it threw a ReferenceError from render() and blanked the accounts pane.
test('a table-form override renders its badge inside the serialized bundle', () => {
  const html = renderDashboardHtml();
  const script = inlineScripts(html).at(-1);
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return accountBadges;`)();
  const account = { name: 'a', type: 'oauth', switchThreshold: { unified7d: 0.9, unified7dFable: 0.8 } };
  const badges = isolated(account, null, null, null, 0.98, null);
  assert.deepEqual(badges[badges.length - 1], { cls: 'meta threshold', text: 'switch 7d 90%, fable 80%' });
  // The inherited-bucket path reads the same two tables.
  const moved = isolated({ name: 'b', type: 'oauth', switchThreshold: 0.98 }, null, null, null, 0.98, { default: 0.98, unified7d: 0.85 });
  assert.deepEqual(moved[moved.length - 1], { cls: 'meta threshold', text: 'switch 7d 98%' });
});

// The "Switch at __ %" control. The stored setting is a 0–1 ratio quantised to
// tenths of a percent; the field shows the percentage, so the two have to agree
// or a re-save of what is on screen would change the setting.
test('thresholdPercentText shows the stored ratio as a percentage', () => {
  assert.equal(thresholdPercentText(0.98), '98');
  // No trailing zero: "98.0" in the box would read as a different number from
  // the 98 the status line and the CLI both print.
  assert.equal(thresholdPercentText(0.9), '90');
  assert.equal(thresholdPercentText(0.915), '91.5');
  assert.equal(thresholdPercentText(1), '100');
});

test('thresholdPercentText shows a per-bucket table as its default', () => {
  // The control sets one number for every bucket, so the default is the only
  // part of a table it can honestly show.
  assert.equal(thresholdPercentText({ default: 0.91, unified7d: 0.8 }), '91');
  // A config with no switchThreshold at all, and the array a hand edit can
  // produce: an empty field is better than a made-up number.
  assert.equal(thresholdPercentText(undefined), '');
  assert.equal(thresholdPercentText(null), '');
  assert.equal(thresholdPercentText([0.9]), '');
});

test('thresholdOutcome says when one number replaced a per-bucket table', () => {
  assert.deepEqual(
    thresholdOutcome({ ok: true, switchThreshold: 0.91, dropped: [] }),
    { kind: 'ok', text: 'switch threshold set to 91%' },
  );
  // A bare "saved" would hide the part the operator most needs to hear.
  const dropped = thresholdOutcome({ ok: true, switchThreshold: 0.9, dropped: ['unified7d', 'tokens'] });
  assert.equal(dropped.kind, 'warn');
  assert.match(dropped.text, /unified7d, tokens/);
  assert.deepEqual(
    thresholdOutcome({ ok: false, error: 'percent must be a number from 1 to 100' }),
    { kind: 'error', text: 'threshold change failed: percent must be a number from 1 to 100' },
  );
  assert.deepEqual(thresholdOutcome(null), { kind: 'error', text: 'threshold change failed' });
});

test('thresholdRequest posts the number to the control endpoint with the key', () => {
  const r = thresholdRequest(91.5, 'secret');
  assert.equal(r.url, '/teamclaude/threshold');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'secret');
  assert.equal(r.init.body, '{"percent":91.5}');
  // A page that has no key yet still sends the header: loopback is exempt from
  // the key gate, and an absent header would be a different request shape.
  assert.equal(thresholdRequest(90, null).init.headers['x-api-key'], '');
});

test('the page carries the threshold control and wires it', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="thrVal"'), 'the percentage field');
  assert.ok(html.includes('id="thrSet"'), 'the Set button');
  assert.ok(html.includes("getElementById('thrSet').addEventListener"), 'the click handler');
  // Enter in the field is the same action: a number typed and left alone would
  // otherwise look applied without being saved.
  assert.ok(html.includes("getElementById('thrVal').addEventListener"), 'the Enter handler');
});

test('the quota refresh picker offers off and 5 to 120 seconds, plus a value set elsewhere', () => {
  const values = cur => probeIntervalOptions(cur).map(o => o.value);
  assert.deepEqual(values(0), [0, 5, 10, 15, 20, 30, 45, 60, 90, 120]);
  assert.deepEqual(probeIntervalOptions(0)[0], { value: 0, label: 'off' });
  assert.deepEqual(probeIntervalOptions(0)[1], { value: 5, label: 'every 5s' });
  // An interval from the CLI or TUI that is not on the list is shown as it is,
  // in order, rather than snapped to a neighbour.
  assert.deepEqual(values(300), [0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 300]);
  assert.deepEqual(values(7), [0, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120]);
  assert.deepEqual(values(undefined), values(0));
});

test('probeIntervalRequest posts the seconds with the key, and the outcome says what was set', () => {
  const r = probeIntervalRequest(15, 'secret');
  assert.equal(r.url, '/teamclaude/probe-interval');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'secret');
  assert.equal(r.init.body, '{"seconds":15}');
  assert.equal(probeIntervalRequest(0, null).init.headers['x-api-key'], '');

  assert.deepEqual(probeIntervalOutcome({ ok: true, quotaProbeSeconds: 15 }), { kind: 'ok', text: 'quota refreshes every 15s' });
  assert.deepEqual(probeIntervalOutcome({ ok: true, quotaProbeSeconds: 0 }), { kind: 'ok', text: 'quota refresh turned off' });
  assert.equal(probeIntervalOutcome({ ok: false, error: 'nope' }).kind, 'error');
  assert.match(probeIntervalOutcome({ ok: false, error: 'nope' }).text, /nope/);
});

test('the page carries the quota refresh picker and wires it', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="probeEvery"'), 'the picker');
  assert.ok(html.includes("getElementById('probeEvery').addEventListener('change'"), 'the change handler');
});

test('the page ships the same helper implementations it is tested against', () => {
  // The serialization is the contract: if a helper stops being self-contained
  // (closes over module scope), the page would silently ReferenceError.
  const html = renderDashboardHtml();
  for (const fn of [scopedWeeklyRows, accountTokens, thresholdBadgeText, accountBadges, sessionRows, filterSessionRows, sortRows, uniqSorted, switchRequest, switchOutcome, accountControlRequest, accountControlOutcome, thresholdRequest, thresholdPercentText, thresholdOutcome, routeRows, problems, usageFor, callerCan, callerNotice, cardNoteKey, cardNoteFor, canRefreshQuota, refreshQuotaRequest, refreshQuotaOutcome,
    meterTone, quotaMeter, exhaustedMeter, fableLabel, accountMeters, accountQuotaExhausted, poolSummary, accountGroup, groupLabel, providerTabs, mergeLogEvents, filterLogEvents, logEventDetail, logEventTone,
    providerTone, needsSignIn, fileSignInHint, isLoopbackHost, signInRequest, signInPlan, signInStatusOutcome, removeRequest, removeOutcome,
    clientKeyRequest, clientKeyOutcome, clientKeySetup, clientKeyCheckOutcome,
    peerLinkRequest, peerLinkOutcome, peerTestOutcome, linkSelfOptions, linkBackNotice, instanceLink, parseInstanceLink, linkAddMissing,
    instanceAddressRequest, instanceAddressOutcome, linkSelfWithAddress,
    accountSyncRequest, accountSyncUser, accountSyncLine, peerSyncCell, accountSyncApprovalHref, accountSyncSignInOutcome, accountSyncCancelOutcome, accountSyncOutcome]) {
    assert.ok(html.includes(fn.toString()), `${fn.name} not serialized into the page`);
  }
  // parseInstanceLink reads it from page scope.
  assert.ok(html.includes('var INSTANCE_LINK_SCHEMES = ["teamrouter:","teamclaude:"];'), 'the instance-link schemes');
  // cardNoteFor reads it from page scope; without it the first render throws.
  assert.ok(html.includes(`var CARD_NOTE_MAX_AGE_MS = ${CARD_NOTE_MAX_AGE_MS};`), 'the card-note age constant');
  // Both the head bootstrap and the main script must parse, not just the last.
  for (const script of inlineScripts(html)) {
    assert.doesNotThrow(() => new Function(script), 'inline script must parse');
  }
});

// Run the page's whole inline script against a stub DOM, a stub localStorage and
// a fetch the test answers by hand. Elements absorb any method call, so render()
// runs without a real DOM; only the style and text the startup path sets are read.
// `autoAnswer(url)` may answer a request at once instead of queueing it (a
// response, or null to queue), for a test about one card that should not
// have to answer another's reads. `manualTimers` hands the page's setTimeout
// to the test (`page.runTimers()`), for a poll it would otherwise wait out.
function bootPage({ storedKey = null, storedTheme = null, storedInstance = null, autoAnswer = null, manualTimers = false } = {}) {
  const els = new Map();
  // Listeners are recorded rather than absorbed, and every element built is
  // kept, so a test can drive a control the page created for itself — the
  // window buttons have no id to look up.
  const built = [];
  const stubEl = () => {
    // Listeners are recorded rather than absorbed, so a test can fire a click
    // the way the page registered it instead of reaching for an onclick the
    // page never sets. Every listener for a type is kept, in registration
    // order, since a page may attach more than one to the same element.
    const listeners = new Map();
    const target = {
      style: {}, value: '', textContent: '', className: '', disabled: false,
      addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      listens: type => (listeners.get(type) || []).length > 0,
    };
    const proxy = new Proxy(target, { get: (t, p) => (p in t ? t[p] : () => stubEl()) });
    // Fire with the proxy as `this`, the way the page sees the element, so a
    // handler that touches an unstubbed property gets the absorbing stub.
    target.fire = (type, event) => { for (const fn of listeners.get(type) || []) fn.call(proxy, event); };
    built.push(proxy);
    return proxy;
  };
  const byId = id => { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); };
  const store = new Map([
    ...(storedKey ? [['teamclaude-dashboard-key', storedKey]] : []),
    ...(storedTheme ? [['teamclaude-dashboard-theme', storedTheme]] : []),
    ...(storedInstance ? [['teamclaude-dashboard-instance', storedInstance]] : []),
  ]);
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const requests = [];
  const fetch = (url, init) => {
    const auto = autoAnswer && autoAnswer(url, init);
    if (auto) return Promise.resolve({ ok: auto.status >= 200 && auto.status < 300, status: auto.status, json: async () => auto.body });
    return new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
  };
  const timers = [];
  const timerFns = manualTimers
    ? [(fn) => { timers.push(fn); return timers.length; }, (id) => { if (id) timers[id - 1] = null; }]
    : [setTimeout, clearTimeout];
  // documentElement is real enough to record the theme attribute, so a test can
  // assert what the page actually sets rather than that it merely did not throw.
  const rootAttrs = new Map();
  const documentElement = {
    setAttribute: (k, v) => rootAttrs.set(k, String(v)),
    removeAttribute: k => rootAttrs.delete(k),
    getAttribute: k => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
  };
  const document = { getElementById: byId, createElement: () => stubEl(), createElementNS: () => stubEl(), documentElement };
  const html = renderDashboardHtml();
  const script = inlineScripts(html).at(-1);
  let poll;
  new Function('document', 'localStorage', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', script)(
    document, localStorage, fetch, fn => { poll = fn; return 1; }, () => {}, ...timerFns);
  const answer = async (status, body = {}) => {
    requests.shift().resolve({ status, ok: status >= 200 && status < 300, json: async () => body });
    await new Promise(r => setImmediate(r));
  };
  // Answer the queued request to this URL, wherever it is in the queue.
  const answerTo = async (url, status, body = {}) => {
    const i = requests.findIndex(r => r.url === url);
    assert.ok(i >= 0, `no request to ${url} (queued: ${requests.map(r => r.url).join(', ')})`);
    requests.splice(i, 1)[0].resolve({ status, ok: status >= 200 && status < 300, json: async () => body });
    await new Promise(r => setImmediate(r));
  };
  const runTimers = () => { const due = timers.splice(0).filter(Boolean); due.forEach(fn => fn()); };
  // Click the control carrying this label, whoever built it. A render replaces
  // a table by building new elements rather than mutating the old ones, so the
  // mark is what keeps `labelled` counting what is on the page now instead of
  // everything ever built.
  let mark = 0;
  const click = label => {
    const el = built.find(e => e.textContent === label && e.listens('click'));
    assert.ok(el, `no clickable element labelled ${label}`);
    mark = built.length;
    el.fire('click');
  };
  const labelled = label => built.slice(mark).filter(e => e.textContent === label).length;
  // The latest element built that matches, for a control with no label to
  // click by (an input the page made for itself).
  const findLast = pred => built.slice().reverse().find(pred);
  return { byId, store, requests, answer, answerTo, runTimers, rootAttrs, click, labelled, findLast, built, poll: () => { mark = built.length; poll(); } };
}

// The Insights page reads /teamclaude/insights only while it is open, like the
// log; a status poll does not ask again while the copy is fresh, a new range
// asks at once, and a linked instance too old to keep history says so.
const INSIGHTS = {
  range: '30d', unit: 'day', buckets: ['2026-01-01', '2026-01-02'], since: 1,
  totals: { requests: 2, input: 1, output: 1, cacheRead: 8, cacheWrite: 0 }, previous: null, requests: [1, 1],
  kinds: { cacheRead: [4, 4], cacheWrite: [0, 0], input: [1, 0], output: [0, 1] },
  providers: [{ provider: 'anthropic', tokens: 10, values: [5, 5] }],
  accounts: [{ provider: 'anthropic', account: 'a', tokens: 10, requests: 2, values: [5, 5] }],
  models: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens: 10, requests: 2 }],
};

test('the Insights page asks for history only while open, once per range, and says when an instance has none', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [{ name: 'a', provider: 'anthropic' }] });
  assert.deepEqual(page.requests, [], 'nothing fetched for a page that is not open');

  page.click('Insights');
  assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/insights?range=30d']);
  await page.answer(200, INSIGHTS);
  assert.equal(page.byId('insNote').style.display, 'none', 'drawn, with no note');

  page.poll();
  assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/status']);
  await page.answer(200, { accounts: [{ name: 'a', provider: 'anthropic' }] });
  assert.deepEqual(page.requests, [], 'a fresh copy is not fetched again on the status poll');

  page.click('7d');
  assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/insights?range=7d']);
  await page.answer(404, {});
  assert.match(page.byId('insNote').textContent, /older proxy that keeps no usage history/);
});

// The headlines pick what every chart draws, and the pick is remembered; the
// hero's view and the "Where it went" tabs redraw without asking again. A
// reply from a proxy too old to estimate the cost draws the tokens.
test('the Insights headlines pick the metric and remember it; the views redraw without a fetch', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [{ name: 'a', provider: 'anthropic' }] });
  page.click('Insights');
  const priced = {
    ...INSIGHTS,
    cost: { total: 2, values: [1, 1], previous: null, unpricedTokens: 0 },
    providers: [{ provider: 'anthropic', tokens: 10, cost: 2, requests: 2, values: [5, 5], requestValues: [1, 1], costValues: [1, 1] }],
    accounts: [{ provider: 'anthropic', account: 'a', tokens: 10, cost: 2, requests: 2, values: [5, 5], requestValues: [1, 1], costValues: [1, 1] }],
    models: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens: 10, requests: 2, cost: 2 }],
  };
  await page.answer(200, priced);
  assert.equal(page.byId('insNote').style.display, 'none');
  // Two days are too few for a calendar or months: one line says what they need.
  assert.ok(page.built.some(e => /need four weeks/.test(String(e.textContent))), 'the short-range line');
  const heads = () => page.built.filter(e => typeof e.className === 'string' && /^inshead( sel)?$/.test(e.className));
  assert.equal(heads().slice(-2)[0].className, 'inshead sel', 'the cost is drawn first');
  heads().slice(-1)[0].fire('click');
  assert.equal(page.store.get('teamclaude-insights-metric'), 'tokens');
  assert.equal(heads().slice(-1)[0].className, 'inshead sel', 'the tokens headline is now the one drawn');
  page.click('Running total');
  page.click('Accounts');
  page.click('Providers');
  assert.deepEqual(page.requests, [], 'a view or a tab is drawn from the copy in hand');

  // A reply with no cost estimate draws the tokens, whatever was picked.
  const old = bootPage();
  await old.answer(200, { accounts: [] });
  old.click('Insights');
  await old.answer(200, INSIGHTS);
  assert.equal(old.byId('insNote').style.display, 'none');
  const oldHeads = old.built.filter(e => typeof e.className === 'string' && /^inshead( sel)?$/.test(e.className));
  assert.deepEqual(oldHeads.map(e => e.className), ['inshead', 'inshead sel'], 'no cost to draw: the tokens are');
});

// The hero's Table says what the chart shows: the view picked (a running
// total adds up), "not recorded" before recording began, and "not priced"
// for cost with no price, whether split by provider or drawn as one total.
test('the Insights hero table follows the view, and says not recorded and not priced rather than $0', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [{ name: 'g', provider: 'grok' }] });
  page.click('Insights');
  // Claude priced, Grok not, and the first day from before recording began.
  const partly = {
    ...INSIGHTS, since: 1, sinceDay: '2026-01-02',
    totals: { requests: 2, input: 15, output: 0, cacheRead: 0, cacheWrite: 0 },
    kinds: { cacheRead: [0, 0], cacheWrite: [0, 0], input: [0, 15], output: [0, 0] },
    cost: { total: 2, values: [0, 2], previous: null, unpricedTokens: 5 },
    providers: [
      { provider: 'anthropic', tokens: 10, cost: 2, requests: 1, values: [0, 10], requestValues: [0, 1], costValues: [0, 2] },
      { provider: 'grok', tokens: 5, cost: 0, requests: 1, values: [0, 5], requestValues: [0, 1], costValues: [0, 0] },
    ],
    accounts: [{ provider: 'grok', account: 'g', tokens: 5, cost: 0, requests: 1, values: [0, 5], requestValues: [0, 1], costValues: [0, 0] }],
    models: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens: 10, requests: 1, cost: 2 }, { provider: 'grok', model: 'grok-4', tokens: 5, requests: 1, cost: null }],
  };
  await page.answer(200, partly);
  const zeroCells = (/** @type {number} */ since) => page.built.slice(since).filter(e => e.className === 'num' && e.textContent === '$0').length;
  const at = page.built.length;
  page.click('Table');
  assert.ok(page.labelled('not recorded') >= 1, 'the day before recording began');
  assert.ok(page.labelled('not priced') >= 1, 'Grok by provider');
  assert.equal(zeroCells(at), 0, 'no $0 for a cost with no price');
  const chartAt = page.built.length;
  page.click('Chart');
  // Hide the one priced series (its legend row, the first the chart built):
  // what is left has no cost, so the plot says so, and no trend line is
  // labelled with a $0 figure.
  const claudeRow = page.built.slice(chartAt).find(e => /\btog\b/.test(String(e.className || '')) && e.listens('click'));
  assert.ok(claudeRow, 'the Claude legend row');
  const notPriced = (/** @type {any[]} */ els) => els.filter(e => e.textContent === 'not priced').length;
  const shownBefore = notPriced(page.built.slice(chartAt));
  const before = page.built.length;
  claudeRow.fire('click');
  // The same page redrawn, plus one: the note in the plot.
  assert.equal(notPriced(page.built.slice(before)), shownBefore + 1, 'a note where the bars would be');
  assert.equal(page.built.slice(before).filter(e => /\$0(?![.\d])/.test(String(e.textContent || ''))).length, 0, 'no $0 anywhere in the redraw');

  const priced = bootPage();
  await priced.answer(200, { accounts: [{ name: 'a', provider: 'anthropic' }] });
  priced.click('Insights');
  await priced.answer(200, {
    ...INSIGHTS,
    cost: { total: 3, values: [1, 2], previous: null, unpricedTokens: 0 },
    providers: [{ provider: 'anthropic', tokens: 10, cost: 3, requests: 2, values: [5, 5], requestValues: [1, 1], costValues: [1, 2] }],
    models: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens: 10, requests: 2, cost: 3 }],
  });
  priced.click('Table');
  assert.ok(priced.labelled('$2.00') >= 1, 'per day: the second day alone');
  priced.click('Running total');
  assert.ok(priced.labelled('$3.00') >= 1, 'running total: both days');
  assert.equal(priced.labelled('$2.00'), 0, 'no day-by-day figure under a running total');
  assert.ok(priced.labelled('Est. API cost (running total)') >= 1, 'the column says which');
});

// In a cost running total an unpriced series has no height: it must not draw
// a line or a dot along the top of the priced stack, where it would repaint
// that edge in its own colour.
test('the Insights running total draws no line or dot for a series with no price', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [{ name: 'g', provider: 'grok' }] });
  page.click('Insights');
  await page.answer(200, {
    ...INSIGHTS,
    totals: { requests: 2, input: 15, output: 0, cacheRead: 0, cacheWrite: 0 },
    kinds: { cacheRead: [0, 0], cacheWrite: [0, 0], input: [5, 10], output: [0, 0] },
    cost: { total: 2, values: [1, 1], previous: null, unpricedTokens: 5 },
    providers: [
      { provider: 'anthropic', tokens: 10, cost: 2, requests: 1, values: [5, 5], requestValues: [0, 1], costValues: [1, 1] },
      { provider: 'grok', tokens: 5, cost: 0, requests: 1, values: [0, 5], requestValues: [0, 1], costValues: [0, 0] },
    ],
    accounts: [{ provider: 'grok', account: 'g', tokens: 5, cost: 0, requests: 1, values: [0, 5], requestValues: [0, 1], costValues: [0, 0] }],
    models: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens: 10, requests: 1, cost: 2 }, { provider: 'grok', model: 'grok-4', tokens: 5, requests: 1, cost: null }],
  });
  const at = page.built.length;
  page.click('Running total');
  const drawn = page.built.slice(at);
  assert.equal(drawn.filter(e => e.style.stroke === 'var(--ip-grok)' || e.style.fill === 'var(--ip-grok)').length, 0, 'no Grok line or dot');
  assert.ok(drawn.some(e => e.style.stroke === 'var(--ip-claude)'), 'the priced series keeps its line');
  assert.ok(drawn.some(e => e.style.fill === 'var(--ip-claude)'), 'the end dot is the top priced series');
});

// A range where nothing had a list price has no cost estimate at all: the
// page draws the tokens, the cost headline says "not priced" and is no tab,
// and no table (the chart's, the calendar's, the months', the list's)
// prints a $0 for it.
test('the Insights page with nothing priced draws the tokens and never prints $0 for the cost', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [{ name: 'g', provider: 'grok' }] });
  page.click('Insights');
  const n = 30;
  const days = Array.from({ length: n }, (_, i) => '2026-10-' + String(i + 1).padStart(2, '0'));
  const zeros = days.map(() => 0);
  const per = days.map(() => 100);
  await page.answer(200, {
    range: '30d', unit: 'day', buckets: days, since: 1, sinceDay: '2026-01-01',
    totals: { requests: n, input: 100 * n, output: 0, cacheRead: 0, cacheWrite: 0 }, previous: null, requests: days.map(() => 1),
    kinds: { cacheRead: zeros, cacheWrite: zeros, input: per, output: zeros },
    cost: { total: 0, values: zeros, previous: null, unpricedTokens: 100 * n },
    providers: [{ provider: 'grok', tokens: 100 * n, cost: 0, requests: n, values: per, requestValues: days.map(() => 1), costValues: zeros }],
    accounts: [{ provider: 'grok', account: 'g', tokens: 100 * n, cost: 0, requests: n, values: per, requestValues: days.map(() => 1), costValues: zeros }],
    models: [{ provider: 'grok', model: 'grok-4', tokens: 100 * n, requests: n, cost: null }],
  });
  const heads = page.built.filter(e => typeof e.className === 'string' && /^inshead( sel)?$/.test(e.className));
  assert.deepEqual(heads.slice(-2).map(e => e.className), ['inshead', 'inshead sel'], 'the tokens are drawn');
  assert.ok(page.built.some(e => e.textContent === 'not priced'), 'the cost headline');
  assert.ok(page.built.some(e => e.textContent === '3.0k tokens, none at a known list price'));
  const dollars = () => page.built.filter(e => typeof e.textContent === 'string' && /^(≈ )?\$0(\.00)?$/.test(e.textContent)).length;
  assert.equal(dollars(), 0, 'no $0 anywhere on the page');
  // Each card's table in turn: the chart's, the calendar's, the months', the list's.
  for (let k = 0; k < 4; k++) {
    const tables = page.built.filter(e => e.textContent === 'Table' && e.listens('click'));
    tables[tables.length - (4 - k)].fire('click');
  }
  assert.ok(page.built.filter(e => e.textContent === 'Chart').length >= 4, 'all four tables open');
  assert.equal(dollars(), 0, 'no $0 in any table');
});

// The minute's refresh usually brings back what is on screen: it is not
// drawn again, which would drop a tooltip being read. A changed reply is.
test('the Insights page does not redraw for a refresh identical to what it shows', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [{ name: 'a', provider: 'anthropic' }] });
  page.click('Insights');
  await page.answer(200, INSIGHTS);
  const realNow = Date.now;
  try {
    let skew = 0;
    Date.now = () => realNow() + skew;
    const refresh = async (/** @type {any} */ reply) => {
      skew += 61_000;
      page.poll();
      await page.answer(200, { accounts: [{ name: 'a', provider: 'anthropic' }] });
      assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/insights?range=30d'], 'a minute on, it asks again');
      const before = page.built.length;
      await page.answer(200, reply);
      return page.built.length - before;
    };
    assert.equal(await refresh(JSON.parse(JSON.stringify(INSIGHTS))), 0, 'the same reply builds nothing');
    assert.ok(await refresh({ ...INSIGHTS, requests: [1, 2] }) > 0, 'a changed reply is drawn');
  } finally {
    Date.now = realNow;
  }
});

// A failed read is throttled like a successful one: a proxy answering 404 or
// 500 must not be asked again on every five-second status poll.
for (const status of [404, 500]) {
  test(`a ${status} from the history is not asked for again on the next status poll`, async () => {
    const page = bootPage();
    await page.answer(200, { accounts: [] });
    page.click('Insights');
    assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/insights?range=30d']);
    await page.answer(status, {});
    for (let i = 0; i < 3; i++) {
      page.poll();
      assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/status']);
      await page.answer(200, { accounts: [] });
      assert.deepEqual(page.requests, [], `poll ${i + 1} asks for status only`);
    }
    // Choosing a range is the person asking: that goes out at once.
    page.click('7d');
    assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/insights?range=7d']);
  });
}

test('the quota refresh picker keeps keyboard focus and coalesces steps made while saving', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], probe: { intervalSeconds: 30 } });
  const sel = page.byId('probeEvery');
  assert.equal(sel.value, '30', 'the picker shows the running interval');
  let blurred = false;
  sel.blur = () => { blurred = true; };

  // Arrowing down three steps: one save goes out, the later steps wait for it.
  sel.value = '45'; sel.fire('change');
  assert.equal(sel.disabled, false, 'a disabled select loses keyboard focus');
  sel.value = '60'; sel.fire('change');
  sel.value = '90'; sel.fire('change');
  assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/probe-interval']);
  assert.equal(page.requests[0].init.body, '{"seconds":45}');

  await page.answer(200, { ok: true, quotaProbeSeconds: 45 });
  // The waiting steps become one save of the latest choice, not two more.
  assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/probe-interval']);
  assert.equal(page.requests[0].init.body, '{"seconds":90}');
  await page.answer(200, { ok: true, quotaProbeSeconds: 90 });
  assert.equal(page.requests[0].url, '/teamclaude/status', 'the page re-polls once the saves settle');
  assert.equal(blurred, false, 'a blur would end keyboard selection');
  await page.answer(200, { accounts: [], probe: { intervalSeconds: 90 } });

  // A refused choice is put back to what the proxy is really doing.
  sel.value = '5'; sel.fire('change');
  await page.answer(400, { ok: false, error: 'nope' });
  assert.equal(sel.value, '90');
});

test('a status poll between quota refresh saves does not replace the queued choice', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], probe: { intervalSeconds: 30 } });
  const sel = page.byId('probeEvery');
  sel.value = '45'; sel.fire('change');
  sel.value = '90'; sel.fire('change');
  // Focus leaves and the 5s poll lands while the first save is still out: it
  // carries the old interval and must not rewrite the select or the queue.
  page.poll();
  assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/probe-interval', '/teamclaude/status']);
  const save = page.requests.shift();
  await page.answer(200, { accounts: [], probe: { intervalSeconds: 30 } });
  assert.equal(sel.value, '90', 'a save in flight keeps the select out of the poll');
  page.requests.unshift(save);
  // The test's select stub reads back whatever is assigned, so pin the case
  // the reviewer reproduced: the DOM says 30 and the queued choice is still sent.
  sel.value = '30';
  await page.answer(200, { ok: true, quotaProbeSeconds: 45 });
  assert.equal(page.requests[0].init.body, '{"seconds":90}');
});

test('Show all reveals exhausted quota rows, survives polls and tabs, and can hide them again', async () => {
  const page = bootPage();
  const fleet = { accounts: [
    { name: 'quota-ready-demo', quota: { unified5h: 0, unified7d: 0.2 } },
    { name: 'quota-spent-demo', quota: { unified5h: 0, unified7d: 1 } },
    { name: 'quota-unknown-demo', provider: 'codex', quota: {} },
  ] };
  await page.answer(200, fleet);
  // Management always builds one name; Quota builds a second only if visible.
  assert.equal(page.labelled('quota-ready-demo'), 2);
  assert.equal(page.labelled('quota-spent-demo'), 1);
  assert.equal(page.labelled('quota-unknown-demo'), 2);
  assert.equal(page.labelled('1 exhausted account hidden'), 1);
  assert.equal(page.labelled('100%'), 2, 'both summaries exclude the weekly-exhausted session capacity');
  assert.equal(page.labelled('200%'), 0);
  page.click('Show all');
  assert.equal(page.labelled('quota-spent-demo'), 2);
  assert.equal(page.labelled('Weekly limit empty'), 1);
  page.poll();
  await page.answer(200, fleet);
  assert.equal(page.labelled('quota-spent-demo'), 2, 'a poll keeps Show all');
  page.click('Claude');
  assert.equal(page.labelled('quota-spent-demo'), 2, 'provider tabs keep Show all');
  assert.equal(page.labelled('quota-unknown-demo'), 1, 'provider tab still filters Quota');
  page.click('Hide exhausted');
  assert.equal(page.labelled('quota-spent-demo'), 1);
  fleet.accounts[0].quota.unified7d = 1;
  page.poll();
  await page.answer(200, fleet);
  assert.equal(page.labelled('quota-ready-demo'), 1, 'new exhaustion hides automatically');
  assert.equal(page.labelled('All accounts in this group have an exhausted limit. Use Show all to see them.'), 1);
  fleet.accounts[1].quota.unified7d = 0;
  page.poll();
  await page.answer(200, fleet);
  assert.equal(page.labelled('quota-spent-demo'), 2, 'recovered quota returns automatically');
  const fresh = bootPage();
  await fresh.answer(200, fleet);
  assert.equal(fresh.labelled('quota-ready-demo'), 1, 'a new page defaults to hiding');
  assert.equal(fresh.labelled('Show all'), 1);
});

test('Claude and Codex get adjacent five-hour cards without changing existing summaries', async () => {
  const page = bootPage();
  await page.answer(200, {
    accounts: [
      { name: 'claude', provider: 'anthropic', quota: { unified5h: 0.2, unified7d: 0.4, unified7dFable: 0.6 } },
      { name: 'codex', provider: 'codex', quota: { unified5h: 0.7, unified7d: 0.1 } },
      { name: 'backend', backend: 'example.test', quota: { tokensLimit: 100, tokensRemaining: 50 } },
    ],
  });
  assert.equal(page.built.filter(e => e.className === 'scard').length, 5);
  assert.equal(page.built.filter(e => e.className === 'summary-pair').length, 2);
  const poolLabels = () => page.built.filter(e => e.className === 'pl').map(e => e.textContent);
  assert.deepEqual(poolLabels(), ['7-day Fable', '5-hour limit', '7-day limit', '5-hour limit', 'Tokens']);
  assert.equal(page.labelled('80%'), 1, 'Claude session quota');
  assert.equal(page.labelled('30%'), 1, 'Codex session quota');
  assert.equal(page.labelled('40%'), 1, 'the original Claude headline stays Fable');
  assert.equal(page.labelled('90%'), 1, 'the original Codex headline stays weekly');
  page.click('Codex');
  assert.equal(page.labelled('5-hour limit'), 2, 'the filtered group has its session card and row');
  assert.equal(page.labelled('80%'), 0, 'Claude cards are filtered out');
});

test('five-hour cards show an unknown reading when no session window is reported', async () => {
  const page = bootPage();
  await page.answer(200, {
    accounts: [
      { name: 'claude', provider: 'anthropic', quota: { unified7d: 0.3, sessionWindowStated: false } },
      { name: 'codex', provider: 'codex', quota: {} },
    ],
  });
  assert.equal(page.built.filter(e => e.className === 'scard').length, 4);
  assert.equal(page.labelled(' no reading yet'), 2);
  assert.equal(page.labelled('?'), 2, 'unknown session capacity is not shown as full');
});

test('the page polls status before asking for a key, so a key-exempt browser is never prompted', async () => {
  const page = bootPage();
  assert.equal(page.requests.length, 1, 'polls on load with no stored key');
  assert.equal(page.requests[0].url, '/teamclaude/status');
  assert.equal(page.requests[0].init.headers['x-api-key'], '');
  assert.notEqual(page.byId('keybox').style.display, 'block', 'no prompt before the server answers');

  await page.answer(200, { accounts: [] });
  assert.notEqual(page.byId('keybox').style.display, 'block');
  assert.equal(page.byId('app').style.display, '');
});

for (const status of [401, 403]) {
  test(`a ${status} on the status poll brings the key prompt up and drops the stored key`, async () => {
    const page = bootPage({ storedKey: 'tc-stale' });
    assert.equal(page.requests[0].init.headers['x-api-key'], 'tc-stale');
    await page.answer(status);
    assert.equal(page.byId('keybox').style.display, 'block');
    assert.equal(page.byId('app').style.display, 'none');
    assert.equal(page.store.size, 0);
  });
}

test('a card\'s refresh button probes that one account, then polls for the new bars', async () => {
  const page = bootPage();
  await page.answer(200, {
    accounts: [{ name: 'a', provider: 'anthropic', quota: { unified7d: 0.1 } }, { name: 'k', quota: {} }],
    probe: { accounts: [{ name: 'a', status: 'never' }, { name: 'k', status: 'not-applicable' }] },
  });
  assert.equal(page.labelled('Refresh quota'), 1, 'only the account the probe can read gets the button');
  page.click('Refresh quota');
  const req = page.requests.shift();
  assert.equal(req.url, '/teamclaude/probe');
  assert.deepEqual(JSON.parse(req.init.body), { account: 'a', provider: 'anthropic' });
  req.resolve({ status: 200, ok: true, json: async () => ({ ok: true, account: 'a', status: 'ok' }) });
  await new Promise(r => setImmediate(r));
  assert.equal(page.requests[0].url, '/teamclaude/status', 'the poll after it shows the new bars');
});

// ── the "Reset usage" button, driven through the page ───────────────────────

const RESET_STATUS = () => ({ accounts: [{ name: 'cx', provider: 'codex', quota: { resetCredits: { available: 2, seenAt: Date.now() } } }] });

/** Run `fn` with Date.now pinned to `at`, the page's only clock. */
function atClock(/** @type {number} */ at, /** @type {() => void} */ fn) {
  const real = Date.now;
  Date.now = () => at;
  try { fn(); } finally { Date.now = real; }
}

test('a confirmed reset posts the card\'s account, then polls for the cleared bars', async () => {
  const page = bootPage();
  await page.answer(200, RESET_STATUS());
  assert.equal(page.labelled('2 resets left'), 1);
  const t = Date.now();
  atClock(t, () => page.click('Reset usage'));
  assert.equal(page.requests.length, 0, 'the first click only arms it');
  atClock(t + 2000, () => page.click('Confirm reset'));
  const req = page.requests.shift();
  assert.equal(req.url, '/teamclaude/reset-credits/redeem');
  assert.deepEqual(JSON.parse(req.init.body), { account: 'cx', provider: 'codex' });
  req.resolve({ status: 200, ok: true, json: async () => ({ ok: true, account: 'cx', windowsReset: 2 }) });
  await new Promise(r => setImmediate(r));
  assert.equal(page.requests[0].url, '/teamclaude/status');
});

test('the Quota page warns of an expiring reset credit and remembers a dismissal', async () => {
  const page = bootPage();
  // One expiry for both polls: the server reports the same date each time, and the date is the alert's identity.
  const expiry = Date.now() + 2 * 24 * 3600_000;
  const status = () => ({ accounts: [{ name: 'cx', provider: 'codex', quota: { resetCredits: { available: 1, seenAt: Date.now(), expiries: [expiry], expiriesFor: 1 } } }] });
  await page.answer(200, status());
  const banner = () => page.built.filter(e => typeof e.textContent === 'string' && /^cx: a free reset credit expires in 2 days/.test(e.textContent));
  assert.equal(banner().length, 1);
  page.click('Dismiss');
  const kept = JSON.parse(page.store.get('teamclaude-dashboard-reset-alerts'));
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^expiring:cx:/);
  const before = banner().length;
  page.poll();
  await page.answer(200, status());
  assert.equal(banner().length, before, 'a dismissed alert is not drawn again');
});

test('a confirmation left past its window arms again instead of spending, even with no render between', async () => {
  const page = bootPage();
  await page.answer(200, RESET_STATUS());
  const t = Date.now();
  atClock(t, () => page.click('Reset usage'));
  // No poll answered in between: the Confirm button drawn at t is still the
  // one on the page a minute later.
  atClock(t + 60_000, () => page.click('Confirm reset'));
  assert.equal(page.requests.length, 0, 'nothing is spent on a stale confirmation');
  // Re-armed: the render after the click draws Confirm (on both the Quota row
  // and the Accounts table, which render together) and no plain Reset usage.
  assert.equal(page.labelled('Reset usage'), 0, 'it is armed afresh instead');
  assert.ok(page.labelled('Confirm reset') > 0);
});

test('a reset whose request is lost says it may have gone through, not that it failed', async () => {
  const page = bootPage();
  await page.answer(200, RESET_STATUS());
  const t = Date.now();
  atClock(t, () => page.click('Reset usage'));
  atClock(t + 2000, () => page.click('Confirm reset'));
  page.requests.shift().reject(new TypeError('Failed to fetch'));
  await new Promise(r => setImmediate(r));
  assert.equal(page.requests[0].url, '/teamclaude/status');
  await page.answer(200, RESET_STATUS());
  assert.ok(page.built.some(e => typeof e.textContent === 'string' && e.textContent.endsWith(REDEEM_UNCERTAIN_TEXT)));
  assert.ok(!page.built.some(e => typeof e.textContent === 'string' && /reset failed/.test(e.textContent)));
});

test('a reset relayed to a linked instance that dropped the connection is reported as uncertain', async () => {
  const page = bootPage();
  await page.answer(200, RESET_STATUS());
  const t = Date.now();
  atClock(t, () => page.click('Reset usage'));
  atClock(t + 2000, () => page.click('Confirm reset'));
  // The shape peers.js relayToPeer answers with when the peer is lost mid-request.
  page.requests.shift().resolve({ status: 502, ok: false, json: async () => ({ ok: false, unreachable: true, error: 'laptop is unreachable (socket hang up)' }) });
  await new Promise(r => setImmediate(r));
  await page.answer(200, RESET_STATUS());
  assert.ok(page.built.some(e => typeof e.textContent === 'string' && e.textContent.endsWith(REDEEM_UNCERTAIN_TEXT)));
  assert.ok(!page.built.some(e => typeof e.textContent === 'string' && /reset failed/.test(e.textContent)));
});

test('a reset whose answer cannot be read is reported as uncertain too', async () => {
  const page = bootPage();
  await page.answer(200, RESET_STATUS());
  const t = Date.now();
  atClock(t, () => page.click('Reset usage'));
  atClock(t + 2000, () => page.click('Confirm reset'));
  page.requests.shift().resolve({ status: 502, ok: false, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  await new Promise(r => setImmediate(r));
  await page.answer(200, RESET_STATUS());
  assert.ok(page.built.some(e => typeof e.textContent === 'string' && e.textContent.endsWith(REDEEM_UNCERTAIN_TEXT)));
});

test('the Logs page fetches the event log only while it is open, and from where it left off', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [] });
  assert.equal(page.requests.length, 0, 'the quota page asks for nothing but status');
  page.click('Logs');
  const first = page.requests.shift();
  assert.equal(first.url, '/teamclaude/logs?after=0');
  first.resolve({ status: 200, ok: true, json: async () => ({
    lastId: 2, capacity: 2000,
    events: [
      { id: 1, at: new Date().toISOString(), kind: 'signin', type: 'signin_succeeded', provider: 'anthropic', account: 'work', message: 'Signed in (dashboard)' },
      { id: 2, at: new Date().toISOString(), kind: 'usage', type: 'request', provider: 'anthropic', account: 'work', message: 'POST /v1/messages', status: 200 },
    ],
  }) });
  await new Promise(r => setImmediate(r));
  assert.equal(page.byId('logCount').textContent, '2 of 2 events');
  // Narrowing to one kind is a re-render, not a re-fetch.
  page.click('Sign-in');
  assert.equal(page.requests.length, 0);
  assert.equal(page.byId('logCount').textContent, '1 of 2 events');
  // The next status poll brings the log along, asking only for what is newer.
  page.click('Logs');
  assert.equal(page.requests.shift().url, '/teamclaude/logs?after=2');
});

test('the Logs page reads a restarted server\'s log again from its start', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [] });
  page.click('Logs');
  const at = new Date().toISOString();
  const ev = (/** @type {number} */ id, /** @type {string} */ message) => ({ id, at, kind: 'control', type: 'switch', provider: null, account: null, message });
  page.requests.shift().resolve({ status: 200, ok: true, json: async () => ({ generation: 'old', lastId: 2, capacity: 2000, events: [ev(1, 'old one'), ev(2, 'old two')] }) });
  await new Promise(r => setImmediate(r));
  page.click('Logs');
  const resumed = page.requests.shift();
  assert.equal(resumed.url, '/teamclaude/logs?after=2');
  resumed.resolve({ status: 200, ok: true, json: async () => ({ generation: 'new', lastId: 3, capacity: 2000, events: [ev(3, 'new three')] }) });
  await new Promise(r => setImmediate(r));
  const again = page.requests.shift();
  assert.equal(again?.url, '/teamclaude/logs?after=0', 'asked again from the start, without waiting for the next poll');
  again.resolve({ status: 200, ok: true, json: async () => ({ generation: 'new', lastId: 3, capacity: 2000, events: [ev(1, 'new one'), ev(2, 'new two'), ev(3, 'new three')] }) });
  await new Promise(r => setImmediate(r));
  // Only the new log's three: the old process's two are gone.
  assert.equal(page.byId('logCount').textContent, '3 of 3 events');
});

test('a provider tab narrows the quota page to that provider\'s accounts', async () => {
  const page = bootPage();
  await page.answer(200, {
    currentAccounts: { anthropic: 'claude-one', codex: 'codex-one' },
    accounts: [
      { name: 'claude-one', provider: 'anthropic', quota: { unified7d: 0.1 } },
      { name: 'codex-one', provider: 'codex', quota: { unified7d: 0.2 } },
    ],
  });
  page.click('Codex');
  // A quota row for the Codex account and none for Claude. Both names are
  // still drawn twice elsewhere: the Accounts page lists every account, and
  // the header names each provider's current account.
  assert.equal(page.labelled('codex-one'), 3);
  assert.equal(page.labelled('claude-one'), 2);
  page.click('Claude');
  assert.equal(page.labelled('claude-one'), 3);
  assert.equal(page.labelled('codex-one'), 2);
});

test('a disabled account offers only Enable: no Switch to on its row or in the Accounts table', async () => {
  const page = bootPage();
  await page.answer(200, {
    currentAccounts: { anthropic: 'a' },
    accounts: [
      { name: 'a', provider: 'anthropic', quota: { unified7d: 0.1 } },
      { name: 'b', provider: 'anthropic', disabled: true, quota: { unified7d: 0.1 } },
      { name: 'c', provider: 'anthropic', quota: { unified7d: 0.1 } },
    ],
  });
  // Only c: a is current and b is disabled, on both the quota row and the table.
  assert.equal(page.labelled('Switch to'), 2);
  assert.equal(page.labelled('Enable'), 1);
});

test('a cordoned account\'s status badge in the Accounts table is short, with the reason on hover', async () => {
  const page = bootPage();
  await page.answer(200, {
    currentAccounts: { anthropic: 'a' },
    accounts: [
      { name: 'a', provider: 'anthropic', quota: { unified7d: 0.1 } },
      { name: 'b', provider: 'anthropic', status: 'active', cordoned: true, cordonRemaining: 1, unavailable: 'cordoned', quota: { unified7d: 0.1 } },
    ],
  });
  // The long reason widened the Status column until the row's controls no longer fit the card.
  assert.equal(page.labelled('cordoned: takes no new conversations'), 0);
  const badge = page.built.filter(e => e.textContent === 'cordoned').at(-1);
  assert.ok(badge, 'the table badge reads cordoned');
  assert.equal(badge.title, 'cordoned: takes no new conversations');
  assert.match(badge.className, /\bcordoned\b/);
});

test('drain mode\'s queue shows on the rows and the card when the server reports it', async () => {
  const page = bootPage();
  await page.answer(200, {
    currentAccounts: { anthropic: 'a' },
    sessions: { mode: 'drain' },
    drainQueue: { anthropic: ['a', 'b'] },
    accounts: [
      { name: 'a', provider: 'anthropic', drainRank: 1, quota: { unified7d: 0.5 } },
      { name: 'b', provider: 'anthropic', drainRank: 2, quota: { unified7d: 0.1 } },
    ],
  });
  assert.equal(page.labelled('draining'), 1);
  assert.equal(page.labelled('#2 in queue'), 1);
  assert.equal(page.labelled('Draining: a'), 1);
});

test('a first poll that fails shows its error instead of a blank page', async () => {
  const page = bootPage();
  await page.answer(500);
  assert.equal(page.byId('err').style.display, 'block');
  assert.match(page.byId('err').textContent, /status 500/);
  assert.equal(page.byId('app').style.display, '');
});

test('dashboard page is self-contained: no external resources', () => {
  const html = renderDashboardHtml();
  assert.match(html, /^<!doctype html>/);
  // The CSP story for a page that holds the proxy key in localStorage depends
  // on nothing external ever loading — no CDN scripts, styles, or fonts.
  assert.doesNotMatch(html, /src\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /href\s*=\s*["']https?:/i);
  assert.doesNotMatch(html, /@import/i);
  // The data fetch targets the gated status endpoint, same origin.
  assert.match(html, /fetch\(at\('\/teamclaude\/status'\)/);
});

test('GET /teamclaude/dashboard serves HTML without a key; other methods are a local 404', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ upstream: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-x' }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'secret' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /<title>TeamRouter<\/title>/);
    assert.match(html, /<h1>TeamRouter<\/h1>/);

    // The page keeps the proxy key in localStorage, so it ships with a policy
    // that lets nothing load from anywhere and admits only its own script —
    // by hash, so a script that is not byte-for-byte this one does not run.
    const csp = page.headers.get('content-security-policy');
    assert.ok(csp, 'the dashboard must carry a Content-Security-Policy');
    assert.equal(csp, dashboardCsp(html));
    assert.match(csp, /(^|; )default-src 'none'(;|$)/);
    assert.match(csp, /(^|; )connect-src 'self'(;|$)/);
    assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    // Every inline script is admitted by hash, not just the first: the theme
    // is applied by a short script in <head>, and a policy covering only the
    // main script would block it and paint the page dark for a light viewer.
    const scripts = inlineScripts(html);
    assert.ok(scripts.length >= 2, 'the page has a head script and a main script');
    for (const script of scripts) {
      const hash = createHash('sha256').update(script, 'utf8').digest('base64');
      assert.match(csp, new RegExp(`'sha256-${hash.replace(/[+/=]/g, '\\$&')}'`));
    }
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

    // The tab icon is the logo inlined as a data: URL, so the page needs no
    // asset route; the policy admits data URLs and no network image source.
    assert.match(csp, /(^|; )img-src data:(;|$)/);
    assert.doesNotMatch(csp, /img-src[^;]*'self'/);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+">/);
    assert.ok(html.includes(`href="${logoDataUrl()}"`), 'the icon is the logo module\'s data URL');
    // The sidebar carries the same mark inline beside the name, decorative
    // so a screen reader announces the name once.
    assert.ok(html.includes(`<div class="brand">${logoMarkup()}TeamRouter</div>`));

    // The asset route is GET + exact path only — a POST to the same path must
    // NOT hit the dashboard handler. It used to flow on to the forwarder and
    // reach the upstream under a fleet credential; an unclaimed path under the
    // proxy's own prefix is now answered here (#420).
    const post = await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard`, { method: 'POST' });
    assert.equal(post.status, 404);
    assert.match((await post.json()).error, /unknown teamclaude control route/);
    assert.equal(upstreamHits, 0);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('the theme starts from what was stored, and system means no attribute', () => {
  // No stored choice: the attribute is absent, so the media query decides and a
  // viewer who never touches this keeps following their desktop.
  assert.equal(bootPage().rootAttrs.get('data-theme'), undefined);
  assert.equal(bootPage({ storedTheme: 'light' }).rootAttrs.get('data-theme'), 'light');
  assert.equal(bootPage({ storedTheme: 'dark' }).rootAttrs.get('data-theme'), 'dark');
  // Junk in storage is not a theme; fall back to following the system rather
  // than writing an attribute no stylesheet matches.
  assert.equal(bootPage({ storedTheme: 'neon' }).rootAttrs.get('data-theme'), undefined);
});

test('the theme button cycles system -> light -> dark and persists each step', () => {
  const page = bootPage();
  const click = () => page.byId('theme').fire('click');
  const stored = () => page.store.get('teamclaude-dashboard-theme');

  assert.equal(page.byId('theme').textContent, 'Theme: system');
  assert.equal(stored(), undefined, 'following the system stores nothing');

  click();
  assert.equal(page.rootAttrs.get('data-theme'), 'light');
  assert.equal(stored(), 'light');
  assert.equal(page.byId('theme').textContent, 'Theme: light');

  click();
  assert.equal(page.rootAttrs.get('data-theme'), 'dark');
  assert.equal(stored(), 'dark');

  // Back to system: the attribute goes away AND the stored value is removed,
  // so the page does not keep re-applying a choice the viewer just dropped.
  click();
  assert.equal(page.rootAttrs.get('data-theme'), undefined);
  assert.equal(stored(), undefined);
  assert.equal(page.byId('theme').textContent, 'Theme: system');
});

test('a stored dark choice survives a reload', () => {
  const first = bootPage();
  first.byId('theme').fire('click');
  first.byId('theme').fire('click');
  assert.equal(first.store.get('teamclaude-dashboard-theme'), 'dark');
  // A fresh page with that storage comes up dark without another click.
  const reloaded = bootPage({ storedTheme: first.store.get('teamclaude-dashboard-theme') });
  assert.equal(reloaded.rootAttrs.get('data-theme'), 'dark');
  assert.equal(reloaded.byId('theme').textContent, 'Theme: dark');
});

test('accountControlRequest picks the endpoint and body from the spec', () => {
  // A relative move sends `place` and no number: the caller has buttons, not a
  // number field, and the server is the one that knows the other priorities.
  const first = accountControlRequest('a@x.com', { place: 'first' }, 'k');
  assert.equal(first.url, '/teamclaude/priority');
  assert.deepEqual(JSON.parse(first.init.body), { account: 'a@x.com', place: 'first' });
  assert.equal(first.init.headers['x-api-key'], 'k');

  const exact = accountControlRequest('a@x.com', { priority: 3 }, 'k');
  assert.deepEqual(JSON.parse(exact.init.body), { account: 'a@x.com', priority: 3 });

  // disabled:false is a real value, not an absent one — it must still route to
  // the disable endpoint rather than being read as a priority change.
  const off = accountControlRequest('a@x.com', { disabled: true }, 'k');
  assert.equal(off.url, '/teamclaude/disable');
  assert.deepEqual(JSON.parse(off.init.body), { account: 'a@x.com', disabled: true });
  const on = accountControlRequest('a@x.com', { disabled: false }, 'k');
  assert.equal(on.url, '/teamclaude/disable');
  assert.deepEqual(JSON.parse(on.init.body), { account: 'a@x.com', disabled: false });

  // No key configured is not an error here; the server decides.
  assert.equal(accountControlRequest('a@x.com', { place: 'last' }, null).init.headers['x-api-key'], '');
});

test('accountControlOutcome reports the number a relative move landed on', () => {
  assert.deepEqual(
    accountControlOutcome({ ok: true, name: 'a@x.com', priority: -1 }, { place: 'first' }),
    { kind: 'ok', text: 'a@x.com priority -1' });
  assert.deepEqual(
    accountControlOutcome({ ok: true, name: 'a@x.com', disabled: true }, { disabled: true }),
    { kind: 'ok', text: 'disabled a@x.com' });
  assert.deepEqual(
    accountControlOutcome({ ok: true, name: 'a@x.com', disabled: false }, { disabled: false }),
    { kind: 'ok', text: 'enabled a@x.com' });
  assert.deepEqual(
    accountControlOutcome({ ok: false, error: 'no account matches "z"' }, { place: 'first' }),
    { kind: 'error', text: 'change failed: no account matches "z"' });
  assert.deepEqual(
    accountControlOutcome(null, { place: 'first' }),
    { kind: 'error', text: 'change failed' });
});

// ── usage windows ───────────────────────────────────────────

const ENTRY = {
  requests: 100, connections: 4, inputTokens: 9000, outputTokens: 500,
  windows: {
    '5h': { requests: 3, connections: 0, inputTokens: 300, outputTokens: 20 },
    '24h': { requests: 12, connections: 1, inputTokens: 1200, outputTokens: 80 },
  },
};

test('the total view reads the lifetime counters', () => {
  assert.deepEqual(usageFor(ENTRY, 'total'), { requests: 100, connections: 4, inputTokens: 9000, outputTokens: 500 });
  // No view at all is the same question, asked before the page has state.
  assert.deepEqual(usageFor(ENTRY), usageFor(ENTRY, 'total'));
});

test('a window view reads that window, not the lifetime counters', () => {
  assert.deepEqual(usageFor(ENTRY, '24h'), { requests: 12, connections: 1, inputTokens: 1200, outputTokens: 80 });
  assert.equal(usageFor(ENTRY, '5h').inputTokens, 300);
});

test('a window the payload does not carry reads as zero, never as the total', () => {
  // The alternative — falling back to the lifetime figure — would label an
  // all-time number as a five-hour one, which is the one answer that misleads
  // rather than merely disappoints.
  assert.deepEqual(usageFor({ requests: 7, inputTokens: 5 }, '24h'), { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(usageFor(null, '5h'), { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(usageFor(undefined, 'total'), { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 });
});

test('every offered view names a window the tracker actually keeps', () => {
  // The buttons are derived from USAGE_WINDOWS rather than listed twice: a
  // renamed window must not leave behind a button that reads zero for everyone.
  assert.equal(USAGE_VIEWS[0].key, 'total');
  assert.deepEqual(USAGE_VIEWS.slice(1).map(v => v.key), Object.keys(USAGE_WINDOWS));
  for (const view of USAGE_VIEWS) assert.ok(view.label, 'every view carries a button label');
});

test('the page ships the view list it renders buttons from', () => {
  assert.ok(renderDashboardHtml().includes(`var USAGE_VIEWS = ${JSON.stringify(USAGE_VIEWS)};`));
});

test('selecting a window relabels every table it governs', async () => {
  const page = bootPage();
  const windows = { '5h': { requests: 1, connections: 0, inputTokens: 10, outputTokens: 2 },
    '24h': { requests: 9, connections: 0, inputTokens: 900, outputTokens: 40 } };
  await page.answer(200, {
    accounts: [],
    clients: { alice: { requests: 99, connections: 0, inputTokens: 9000, outputTokens: 400, lastUsed: new Date().toISOString(), windows } },
    usageDimensions: { project: { widgets: { requests: 99, inputTokens: 9000, outputTokens: 400, windows } } },
  });

  assert.equal(page.byId('clientsHeading').textContent, 'Clients');
  assert.equal(page.labelled('Last used'), 2, 'both tables label the column plainly under Total');
  assert.equal(page.labelled('Project'), 2, 'the dimension heading and its first column');

  page.click('Last 24h');

  // The heading is what stops a windowed figure being read as a lifetime one
  // once the control itself is scrolled out of view.
  assert.equal(page.byId('clientsHeading').textContent, 'Clients · last 24h');
  assert.equal(page.labelled('Project · last 24h'), 1, 'the dimension table names the window too');
  assert.equal(page.labelled('Last used (all time)'), 2, 'and the one lifetime column says so');
  assert.equal(page.labelled('Last used'), 0);

  page.click('Total');
  assert.equal(page.byId('clientsHeading').textContent, 'Clients', 'and back again');
});

// A client key is refused the account controls and the threshold (server.js,
// CLIENT_KEY_REFUSED_PATHS). The page hides what would be refused, and says so
// once, instead of drawing buttons that answer a click with a line off screen.
const CLIENT_CALLER = {
  kind: 'client',
  client: 'ci',
  refused: ['/teamclaude/threshold', '/teamclaude/priority', '/teamclaude/disable', '/teamclaude/account-cordon'],
};

test('callerCan hides exactly the refused controls', () => {
  assert.equal(callerCan(CLIENT_CALLER, '/teamclaude/priority'), false);
  assert.equal(callerCan(CLIENT_CALLER, '/teamclaude/disable'), false);
  assert.equal(callerCan(CLIENT_CALLER, '/teamclaude/threshold'), false);
  // A client key may still switch and reload.
  assert.equal(callerCan(CLIENT_CALLER, '/teamclaude/switch'), true);
  assert.equal(callerCan(CLIENT_CALLER, '/teamclaude/reload'), true);
  assert.equal(callerCan({ kind: 'operator', client: null, refused: [] }, '/teamclaude/priority'), true);
  // No caller field: every control stays, and the server still refuses.
  assert.equal(callerCan(undefined, '/teamclaude/priority'), true);
  assert.equal(callerCan({ kind: 'client', client: 'ci' }, '/teamclaude/priority'), true);
});

test('callerNotice names the client key only when something is hidden', () => {
  const text = callerNotice(CLIENT_CALLER);
  assert.match(text, /client key "ci"/);
  assert.match(text, /proxy\.apiKey/);
  assert.equal(callerNotice({ kind: 'operator', client: null, refused: [] }), null);
  assert.equal(callerNotice({ kind: 'client', client: 'ci', refused: [] }), null);
  assert.equal(callerNotice(undefined), null);
});

test('cardNoteFor shows a result for its own card only, and only while recent', () => {
  const at = 1_000_000;
  const notes = { 'alice@example.com': { kind: 'error', text: 'change failed', at } };
  assert.deepEqual(cardNoteFor(notes, 'alice@example.com', at + 1000), notes['alice@example.com']);
  assert.equal(cardNoteFor(notes, 'bob@example.com', at + 1000), null);
  assert.equal(cardNoteFor(notes, 'alice@example.com', at + CARD_NOTE_MAX_AGE_MS), notes['alice@example.com']);
  assert.equal(cardNoteFor(notes, 'alice@example.com', at + CARD_NOTE_MAX_AGE_MS + 1), null);
  // An account name is operator data: an inherited key is not a note.
  assert.equal(cardNoteFor(notes, 'constructor', at), null);
  // The page's own store has no prototype, so even __proto__ is an ordinary key.
  const bare = Object.create(null);
  bare['__proto__'] = { kind: 'ok', text: 'x', at };
  assert.equal(cardNoteFor(bare, '__proto__', at).text, 'x');
  assert.equal(cardNoteFor(undefined, 'alice@example.com', at), null);
});

test('cardNoteKey tells apart two cards with one name', () => {
  const a = cardNoteKey({ name: 'alice@example.com', orgName: 'org-1', provider: 'anthropic' });
  const b = cardNoteKey({ name: 'alice@example.com', orgName: 'org-2', provider: 'anthropic' });
  const c = cardNoteKey({ name: 'alice@example.com', orgName: 'org-1', provider: 'codex' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, cardNoteKey({ name: 'alice@example.com', orgName: 'org-1', provider: 'anthropic' }));
});

test('a backend account card draws its probed windows, not "quota unknown" (#530)', () => {
  const now = 1_000_000;
  // Per-window fractions draw one bar each, in Session/Weekly/Monthly order.
  assert.deepEqual(backendQuotaRows({
    label: 'Plan', text: '5h 40% · week 10%', utilization: 0.4, at: now,
    windows: { weekly: { utilization: 0.1, resetAt: now + 5000 }, fiveHour: { utilization: 0.4, resetAt: now + 100 }, monthly: { utilization: 0.2, resetAt: null } },
  }, now), {
    rows: [
      { label: 'Session', utilization: 0.4, resetAt: now + 100 },
      { label: 'Weekly', utilization: 0.1, resetAt: now + 5000 },
      { label: 'Monthly', utilization: 0.2, resetAt: null },
    ],
    text: null,
  });
  // A window past its reset predates it, so it describes nothing any more.
  assert.deepEqual(backendQuotaRows({
    label: 'Plan', text: 't', utilization: 0.9,
    windows: { fiveHour: { utilization: 0.9, resetAt: now - 1 }, weekly: { utilization: 0.3, resetAt: now + 1 } },
  }, now).rows.map(r => r.label), ['Weekly']);
  // One fraction and no windows: one bar under the reading's own label.
  assert.deepEqual(backendQuotaRows({ label: 'Plan', text: '50%', utilization: 0.5 }, now),
    { rows: [{ label: 'Plan', utilization: 0.5, resetAt: null }], text: null });
  // A balance has no fraction: its text is the line.
  assert.deepEqual(backendQuotaRows({ label: 'Balance', text: '$4.20', utilization: null }, now),
    { rows: [], text: 'Balance: $4.20' });
  assert.deepEqual(backendQuotaRows(null, now), { rows: [], text: null });
});

test('a renamed account shows its email under the name; one named by its email does not repeat it', () => {
  assert.equal(accountEmailLine({ name: 'work', email: 'me@example.com' }), 'me@example.com');
  assert.equal(accountEmailLine({ name: 'me@example.com', email: 'me@example.com' }), null);
  // Not yet known (an account added before emails were kept), or junk.
  assert.equal(accountEmailLine({ name: 'account-1', email: null }), null);
  assert.equal(accountEmailLine({ name: 'account-1' }), null);
  assert.equal(accountEmailLine({ name: 'account-1', email: 5 }), null);
});

test('the account row\'s email line runs inside the serialized bundle', () => {
  const script = inlineScripts(renderDashboardHtml()).at(-1);
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return accountEmailLine;`)();
  assert.equal(isolated({ name: 'work', email: 'me@example.com' }), 'me@example.com');
  assert.match(script, /accountEmailLine\(a\)/, 'the accounts table calls it');
});

test('the status payload carries each account\'s email, null when none is stored', () => {
  const am = new AccountManager([
    { name: 'work', type: 'api_key', apiKey: 'sk-a', email: 'me@example.com' },
    { name: 'b', type: 'api_key', apiKey: 'sk-b' },
  ], 0.98);
  assert.deepEqual(am.getStatus().accounts.map(a => a.email), ['me@example.com', null]);
});

// ── Accounts page: signing in, removing, and telling the providers apart ──

test('each provider family has its own colour class, and backends share one', () => {
  assert.equal(providerTone('anthropic'), 'claude');
  assert.equal(providerTone('codex'), 'codex');
  assert.equal(providerTone('backend:api.deepseek.com'), 'backend');
});

test('only an OAuth login signed out upstream offers Sign in again, for its own provider', () => {
  assert.equal(needsSignIn({ type: 'oauth', provider: 'anthropic', status: 'error' }), 'claude');
  assert.equal(needsSignIn({ type: 'oauth', provider: 'codex', status: 'error' }), 'codex');
  assert.equal(needsSignIn({ type: 'oauth', provider: 'anthropic', status: 'active' }), null);
  assert.equal(needsSignIn({ type: 'apikey', provider: 'anthropic', status: 'error' }), null, 'a key is replaced, not signed in');
  assert.equal(needsSignIn({ type: 'oauth', status: 'error', backend: 'api.z.ai' }), null);
});

test('a page counts as on the proxy\'s machine only at a loopback address', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['100.64.0.7', 'proxy.lan', '', undefined]) assert.equal(isLoopbackHost(h), false, String(h));
});

test('a sign-in step is a JSON POST carrying the stored key', () => {
  const r = signInRequest('code', { id: 'x', code: 'c' }, 'tc-key');
  assert.equal(r.url, '/teamclaude/login/code');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'tc-key');
  assert.deepEqual(JSON.parse(r.init.body), { id: 'x', code: 'c' });
});

test('Claude\'s loopback link is offered only to a page on the proxy\'s machine', () => {
  const start = { provider: 'claude', url: 'https://claude.ai/oauth/authorize?r=code-page', browserUrl: 'https://claude.ai/oauth/authorize?r=loopback', listening: true };
  const local = signInPlan(start, '127.0.0.1');
  assert.equal(local.href, start.browserUrl);
  assert.equal(local.auto, true);
  const remote = signInPlan(start, '100.64.0.7');
  assert.equal(remote.href, start.url, 'a browser elsewhere cannot reach the loopback listener');
  assert.equal(remote.auto, false);
  assert.match(remote.ask, /code/);
});

test('Codex always opens its one link, and asks for the localhost:1455 address unless it can finish by itself', () => {
  const start = { provider: 'codex', url: 'https://auth.openai.com/oauth/authorize?x=1', browserUrl: null, listening: true };
  assert.equal(signInPlan(start, 'localhost').auto, true);
  const remote = signInPlan(start, 'proxy.lan');
  assert.equal(remote.href, start.url);
  assert.equal(remote.auto, false);
  assert.match(remote.ask, /localhost:1455/);
  const taken = signInPlan({ ...start, listening: false, note: 'Port 1455 is in use' }, 'localhost');
  assert.equal(taken.auto, false, 'nothing listens, so the paste is the only way');
  assert.equal(taken.note, 'Port 1455 is in use');
});

test('a polled sign-in reads as the page says it', () => {
  assert.deepEqual(signInStatusOutcome({ ok: true, state: 'waiting' }, 'Claude'), { done: false, kind: '', text: 'Waiting for you to sign in…' });
  assert.equal(signInStatusOutcome({ ok: true, state: 'finishing' }, 'Claude').done, false);
  assert.deepEqual(signInStatusOutcome({ ok: true, state: 'succeeded', account: 'me@example.com', action: 'added' }, 'Codex'),
    { done: true, kind: 'ok', text: 'Added the Codex account as me@example.com' });
  assert.equal(signInStatusOutcome({ ok: true, state: 'succeeded', account: 'me@example.com', action: 'updated' }, 'Claude').text,
    'Signed in to Claude again as me@example.com');
  assert.deepEqual(signInStatusOutcome({ ok: true, state: 'failed', error: 'the provider answered HTTP 400' }, 'Claude'),
    { done: true, kind: 'error', text: 'Claude sign-in failed: the provider answered HTTP 400' });
  assert.equal(signInStatusOutcome({ ok: true, state: 'cancelled' }, 'Claude').kind, 'warn');
  assert.equal(signInStatusOutcome({ ok: true, state: 'unknown' }, 'Claude').done, true);
  assert.equal(signInStatusOutcome({ ok: false, error: 'a client key cannot sign accounts in' }, 'Claude').kind, 'error');
});

test('Remove names the card\'s provider and org, so a namesake is never the one removed', () => {
  const r = removeRequest({ name: 'me@example.com', provider: 'codex', orgName: 'Acme' }, null);
  assert.equal(r.url, '/teamclaude/remove');
  assert.deepEqual(JSON.parse(r.init.body), { account: 'me@example.com', provider: 'codex', org: 'Acme' });
  assert.deepEqual(JSON.parse(removeRequest({ name: 'k' }, null).init.body), { account: 'k' });
  assert.equal(removeOutcome({ ok: true, name: 'me@example.com' }).kind, 'ok');
  assert.match(removeOutcome({ ok: true, name: 'me@example.com' }).text, /no longer holds its sign-in/);
  assert.deepEqual(removeOutcome({ ok: false, error: 'no such account "x"' }), { kind: 'error', text: 'remove failed: no such account "x"' });
});

test('Sign in to Codex starts the flow, shows the link, and a pasted address finishes it', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [] });
  assert.equal(page.labelled('Sign in to Claude'), 1);
  page.click('Sign in to Codex');
  const start = page.requests[0];
  assert.equal(start.url, '/teamclaude/login/start');
  assert.deepEqual(JSON.parse(start.init.body), { provider: 'codex' });
  await page.answer(200, { ok: true, id: 'abc', provider: 'codex', url: 'https://auth.openai.com/oauth/authorize?x=1', browserUrl: null, listening: true, note: null });
  const open = page.findLast(e => e.textContent === 'Open sign-in page');
  assert.equal(open.href, 'https://auth.openai.com/oauth/authorize?x=1');
  assert.equal(open.target, '_blank');
  assert.equal(open.rel, 'noopener noreferrer');

  const paste = page.findLast(e => typeof e.placeholder === 'string' && e.placeholder.startsWith('http://localhost:1455'));
  paste.value = 'http://localhost:1455/auth/callback?code=c&state=s';
  page.click('Finish sign-in');
  const code = page.requests[0];
  assert.equal(code.url, '/teamclaude/login/code');
  assert.deepEqual(JSON.parse(code.init.body), { id: 'abc', code: 'http://localhost:1455/auth/callback?code=c&state=s' });
  await page.answer(200, { ok: true });
  // Accepted: the page asks at once rather than waiting out the poll interval.
  assert.equal(page.requests[0].url, '/teamclaude/login/status');
  await page.answer(200, { ok: true, state: 'succeeded', provider: 'codex', account: 'me@example.com', action: 'added' });
  assert.match(page.byId('note').textContent, /Added the Codex account as me@example\.com$/);
  assert.equal(page.byId('signIn').style.display, 'none', 'the panel closes');
  assert.equal(page.requests[0].url, '/teamclaude/status', 'and the accounts list is read again');
});

test('a paste the server refuses is shown in the panel, which keeps waiting', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [] });
  page.click('Sign in to Claude');
  await page.answer(200, { ok: true, id: 'abc', provider: 'claude', url: 'https://claude.ai/x', browserUrl: 'http://localhost:9/x', listening: true });
  page.findLast(e => e.placeholder === 'Paste the code here').value = 'stale#state';
  page.click('Finish sign-in');
  await page.answer(400, { ok: false, error: 'OAuth state mismatch: that code is from a different sign-in attempt.' });
  assert.ok(page.findLast(e => /state mismatch/.test(e.textContent)), 'the reason is on the panel');
  assert.notEqual(page.byId('signIn').style.display, 'none');
  assert.equal(page.requests.length, 0, 'nothing else was sent');
});

test('a double-click on Remove does not remove', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [{ name: 'a', provider: 'anthropic', type: 'apikey', quota: {} }, { name: 'b', provider: 'anthropic', type: 'apikey', quota: {} }] });
  page.click('Remove');
  page.click('Confirm remove');
  assert.equal(page.requests.length, 0, 'the second click of a double-click is ignored');
});

test('Remove asks for a second click, then sends the card\'s provider', async () => {
  const page = bootPage();
  await page.answer(200, {
    accounts: [
      { name: 'me@example.com', provider: 'anthropic', type: 'apikey', quota: {} },
      { name: 'me@example.com', provider: 'codex', type: 'oauth', quota: {} },
    ],
  });
  assert.equal(page.labelled('Remove'), 2);
  const removes = [];
  // The Codex row's Remove: the second one built.
  page.findLast(e => e.textContent === 'Remove' && e.listens('click')).fire('click');
  assert.equal(page.requests.length, 0, 'the first click only arms it');
  removes.push(page.findLast(e => e.textContent === 'Confirm remove'));
  assert.ok(removes[0], 'the button now asks to confirm');
  // Confirmed only after the double-click window: the page reads the clock,
  // so the test moves it rather than waiting.
  const realNow = Date.now;
  Date.now = () => realNow() + 1000;
  try {
    removes[0].fire('click');
  } finally {
    Date.now = realNow;
  }
  const req = page.requests[0];
  assert.equal(req.url, '/teamclaude/remove');
  assert.deepEqual(JSON.parse(req.init.body), { account: 'me@example.com', provider: 'codex' });
  await page.answer(200, { ok: true, name: 'me@example.com', provider: 'codex' });
  assert.match(page.byId('note').textContent, /Removed me@example\.com/);
});

test('the Accounts page lists Claude and Codex apart, each under its own heading', async () => {
  const page = bootPage();
  await page.answer(200, {
    accounts: [
      { name: 'claude-one', provider: 'anthropic', quota: {} },
      { name: 'codex-one', provider: 'codex', quota: {} },
    ],
  });
  assert.equal(page.labelled('Claude accounts'), 1);
  assert.equal(page.labelled('Codex (ChatGPT) accounts'), 1);
  assert.ok(page.findLast(e => e.className === 'pcard claude'), 'the Claude section wears the Claude colour');
  assert.ok(page.findLast(e => e.className === 'pcard codex'), 'and the Codex one its own');
});

test('an account signed out upstream offers Sign in again for its own provider', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [{ name: 'work', email: 'me@example.com', provider: 'anthropic', type: 'oauth', status: 'error', quota: {} }] });
  page.click('Sign in again');
  assert.deepEqual(JSON.parse(page.requests[0].init.body), { provider: 'claude' });
  await page.answer(200, { ok: true, id: 'abc', provider: 'claude', url: 'https://claude.ai/x', browserUrl: null, listening: true });
  assert.ok(page.findLast(e => e.textContent === 'Open the sign-in page and sign in as me@example.com.'), 'the panel says which login to use');
});

test('a client key sees neither the sign-in buttons nor Remove', async () => {
  const page = bootPage();
  await page.answer(200, { caller: callerView('ci'), accounts: [{ name: 'a', provider: 'anthropic', type: 'oauth', status: 'error', quota: {} }] });
  assert.equal(page.labelled('Sign in to Claude'), 0);
  assert.equal(page.labelled('Sign in to Codex'), 0);
  assert.equal(page.labelled('Remove'), 0);
  assert.equal(page.labelled('Sign in again'), 0);
  assert.equal(page.byId('addBar').style.display, 'none');
});

test('a signed-out account that reads its sign-in from a file is sent to the tool that owns the file', () => {
  const claude = { type: 'oauth', provider: 'anthropic', status: 'error', credentialsFromFile: true };
  assert.equal(needsSignIn(claude), null, 'a sign-in here would be stored and never used');
  assert.match(fileSignInHint(claude), /Claude Code \(claude \/login\).*Reload config/);
  assert.match(fileSignInHint({ ...claude, provider: 'codex' }), /Codex CLI \(codex login\)/);
  assert.equal(fileSignInHint({ ...claude, status: 'active' }), null);
  assert.equal(fileSignInHint({ ...claude, credentialsFromFile: false }), null);
});

test('a sign-in that landed on a file-backed account says it did not take, rather than claiming success', () => {
  const out = signInStatusOutcome({ ok: true, state: 'succeeded', account: 'me@example.com', action: 'updated', fileBacked: true }, 'Claude');
  assert.equal(out.done, true);
  assert.equal(out.kind, 'warn');
  assert.match(out.text, /credentials file.*Claude Code/);
});

test('the only account can be removed like any other', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [{ name: 'a', provider: 'anthropic', type: 'apikey', quota: {} }] });
  const lone = page.findLast(e => e.textContent === 'Remove');
  assert.equal(lone.disabled, false);
  assert.match(lone.title, /Sign a out of TeamClaude/);
});

test('with no accounts the overview points at the sign-in on the Accounts page', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [] });
  assert.ok(page.findLast(e => /No accounts yet\. Sign one in on the Accounts page/.test(e.textContent)));
});

test('a file-backed account in error shows where to sign in, and no Sign in again', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [
    { name: 'a', provider: 'anthropic', type: 'oauth', status: 'error', credentialsFromFile: true, quota: {} },
    { name: 'b', provider: 'anthropic', type: 'apikey', quota: {} },
  ] });
  assert.equal(page.labelled('Sign in again'), 0);
  assert.ok(page.findLast(e => /credentials file/.test(e.textContent)));
});

test('status says whether an account reads its sign-in from a file, and never which file', () => {
  const am = new AccountManager([
    { name: 'filed', type: 'oauth', importFrom: '/tmp/demo-creds.json', accessToken: 't', refreshToken: 'r', expiresAt: 4102444800000 },
    { name: 'inline', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: 4102444800000 },
  ], 0.98);
  const [filed, inline] = am.getStatus().accounts;
  assert.equal(filed.credentialsFromFile, true);
  assert.equal(inline.credentialsFromFile, false);
  assert.doesNotMatch(JSON.stringify(am.getStatus()), /demo-creds/);
});

// A panel with a Codex sign-in the server has started, id 'abc'.
async function pageWithSignIn() {
  const page = bootPage();
  await page.answer(200, { accounts: [] });
  page.click('Sign in to Codex');
  await page.answer(200, { ok: true, id: 'abc', provider: 'codex', url: 'https://auth.openai.com/oauth/authorize?x=1', browserUrl: null, listening: true });
  return page;
}

test('Cancel on a sign-in whose code has arrived keeps the panel and follows it to the end', async () => {
  const page = await pageWithSignIn();
  page.click('Cancel');
  assert.equal(page.requests[0].url, '/teamclaude/login/cancel');
  await page.answer(200, { ok: true, cancelled: false });
  assert.notEqual(page.byId('signIn').style.display, 'none', 'the panel stays');
  assert.ok(page.findLast(e => /can no longer be cancelled/.test(e.textContent)), 'and says why');
  const status = page.requests[0];
  assert.equal(status.url, '/teamclaude/login/status');
  assert.deepEqual(JSON.parse(status.init.body), { id: 'abc' }, 'still asking about the same sign-in');
  await page.answer(200, { ok: true, state: 'succeeded', provider: 'codex', account: 'me@example.com', action: 'added' });
  assert.match(page.byId('note').textContent, /Added the Codex account as me@example\.com$/);
});

test('Cancel the server honours closes the panel', async () => {
  const page = await pageWithSignIn();
  page.click('Cancel');
  await page.answer(200, { ok: true, cancelled: true });
  assert.equal(page.byId('signIn').style.display, 'none');
});

test('a new sign-in the server refuses leaves the one under way on the panel', async () => {
  const page = await pageWithSignIn();
  page.click('Sign in to Claude');
  assert.deepEqual(JSON.parse(page.requests[0].init.body), { provider: 'claude' });
  await page.answer(400, { ok: false, error: 'the last sign-in is still finishing; it shows in the list in a moment' });
  assert.ok(page.findLast(e => /still finishing/.test(e.textContent)), 'the refusal is on the panel');
  assert.ok(page.findLast(e => e.textContent === 'Sign in to Codex' && e.className === 'sp'), 'which is still the Codex one');
  assert.ok(page.findLast(e => e.textContent === 'Open sign-in page'), 'with its link');
});

test('client key requests post the name to the step, with the page\'s own key', () => {
  const r = clientKeyRequest('create', 'laptop', 'tc-operator');
  assert.equal(r.url, '/teamclaude/client-keys/create');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'tc-operator');
  assert.deepEqual(JSON.parse(r.init.body), { name: 'laptop' });
  assert.equal(clientKeyRequest('revoke', 'ci', null).url, '/teamclaude/client-keys/revoke');
  assert.equal(clientKeyRequest('revoke', 'ci', null).init.headers['x-api-key'], '');
  assert.equal(clientKeyRequest('show', 'ci', null).url, '/teamclaude/client-keys/show');
});

test('client key outcomes say what happened, and a first key warns', () => {
  assert.deepEqual(clientKeyOutcome({ ok: true, name: 'laptop', key: 'tc-x', firstKey: false }, 'create'), { kind: 'ok', text: 'Created laptop.' });
  const first = clientKeyOutcome({ ok: true, name: 'laptop', key: 'tc-x', firstKey: true }, 'create');
  assert.equal(first.kind, 'warn');
  assert.match(first.text, /other machines now need a key/);
  assert.match(clientKeyOutcome({ ok: true, name: 'ci', removed: 1 }, 'revoke').text, /^Revoked ci\./);
  assert.deepEqual(clientKeyOutcome({ ok: false, error: 'a client key named "ci" already exists' }, 'create'),
    { kind: 'error', text: 'could not create the key: a client key named "ci" already exists' });
  assert.equal(clientKeyOutcome(null, 'revoke').text, 'could not revoke the key');
  assert.deepEqual(clientKeyOutcome({ ok: true, name: 'ci', key: 'tc-x' }, 'show'), { kind: 'ok', text: '' });
  assert.equal(clientKeyOutcome({ ok: false, error: 'no client key is named "ci"' }, 'show').text, 'could not read the key: no client key is named "ci"');
});

test('the setup text points Claude Code and Codex at this proxy with the new key', () => {
  const setup = clientKeySetup('http://100.64.0.2:3456', 'tc-abc');
  assert.equal(setup.claude, 'export ANTHROPIC_BASE_URL=http://100.64.0.2:3456\nexport ANTHROPIC_API_KEY=tc-abc');
  assert.match(setup.codex, /^model_provider = "teamclaude"$/m);
  assert.match(setup.codex, /^base_url = "http:\/\/100\.64\.0\.2:3456\/backend-api\/codex"$/m);
  assert.match(setup.codex, /^http_headers = \{ "x-api-key" = "tc-abc" \}$/m);
  // No local address from the proxy: no Grok line, never the page's origin.
  assert.equal(setup.grok, null);
});

test('Grok Build is pointed at the loopback address the proxy reports, never the page\'s, and gets no key', () => {
  // The page is open over Tailscale; Grok Build can only use the loopback exemption.
  const setup = clientKeySetup('http://100.64.0.2:3456', 'tc-abc', 'http://127.0.0.1:3456/grok/v1');
  assert.equal(setup.grok, 'export GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:3456/grok/v1');
  assert.doesNotMatch(setup.grok, /tc-abc|100\.64/);
  assert.equal(clientKeySetup('http://127.0.0.1:3456', 'tc-abc', null).grok, null, 'the proxy has no keyless route');
  assert.equal(clientKeySetup('http://127.0.0.1:3456', 'tc-abc', undefined).grok, null, 'an older proxy says nothing');
});

// Show details returns hand-written keys too, so the snippets must survive any key.
test('the setup text quotes a hand-written key for the shell and for TOML', () => {
  const setup = clientKeySetup('http://127.0.0.1:3456', `a$B 'c"\\`);
  assert.equal(setup.claude.split('\n')[1], `export ANTHROPIC_API_KEY='a$B '\\''c"\\'`);
  assert.match(setup.codex, /^http_headers = \{ "x-api-key" = "a\$B 'c\\"\\\\" \}$/m);
});

test('a key test passes only when the server names the key\'s client', () => {
  assert.equal(clientKeyCheckOutcome(200, { caller: { kind: 'client', client: 'laptop' } }, 'laptop').kind, 'ok');
  // A loopback browser is admitted without a key: a 200 as the operator proves nothing.
  assert.equal(clientKeyCheckOutcome(200, { caller: { kind: 'operator', client: null } }, 'laptop').kind, 'error');
  assert.equal(clientKeyCheckOutcome(200, { caller: { kind: 'client', client: 'other' } }, 'laptop').kind, 'error');
  assert.deepEqual(clientKeyCheckOutcome(401, null, 'laptop'), { kind: 'error', text: 'The proxy refused the key.' });
  assert.match(clientKeyCheckOutcome(500, null, 'laptop').text, /status 500/);
});

test('the Clients page carries the client key form, kept to the operator', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="ckForm"') && html.includes('id="ckName"') && html.includes('id="ckCreate"'));
  assert.ok(html.includes("callerCan(s.caller, '/teamclaude/client-keys/create')"), 'hidden for a caller that would be refused');
  assert.ok(callerView('ci').refused.includes('/teamclaude/client-keys/create'));
  assert.ok(callerView('ci').refused.includes('/teamclaude/client-keys/revoke'));
});

// The proxy's first key closes the gate this page came in through. Its next
// poll would be refused and the key box would cover the one-time key panel
// before the key was copied, so polling waits for Done.
test('creating the proxy\'s first key from a key-less page keeps the key on screen until Done', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], clientKeys: [], caller: { kind: 'operator', client: null, refused: [] } });
  page.byId('ckName').value = 'laptop';
  page.byId('ckForm').fire('submit', { preventDefault() {} });
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, '/teamclaude/client-keys/create');
  await page.answer(200, { ok: true, name: 'laptop', key: 'tc-new', firstKey: true });

  assert.equal(page.requests.length, 0, 'no status poll while the new key is on screen');
  assert.equal(page.byId('ckIssued').style.display, '');
  assert.notEqual(page.byId('keybox').style.display, 'block');
  assert.ok(page.findLast(e => e.value === 'tc-new'), 'the key is shown');
  assert.ok(page.findLast(e => /Copy the key before you press Done/.test(e.textContent)), 'the page says what happens next');

  page.click('Done');
  assert.equal(page.requests.length, 1, 'Done resumes polling');
  assert.equal(page.requests[0].url, '/teamclaude/status');
  await page.answer(401);
  assert.equal(page.byId('keybox').style.display, 'block');
});

test('a key created by a page that already holds one keeps polling', async () => {
  const page = bootPage({ storedKey: 'tc-operator' });
  await page.answer(200, { accounts: [], clientKeys: [], caller: { kind: 'operator', client: null, refused: [] } });
  page.byId('ckName').value = 'laptop';
  page.byId('ckForm').fire('submit', { preventDefault() {} });
  await page.answer(200, { ok: true, name: 'laptop', key: 'tc-new', firstKey: false });
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, '/teamclaude/status');
  assert.equal(page.requests[0].init.headers['x-api-key'], 'tc-operator');
});

// Show details reopens the setup panel for a key whose create panel is long gone.
test('Show details reads a key back into the setup panel, and Hide details closes it', async () => {
  const page = bootPage({ storedKey: 'tc-operator' });
  const status = { accounts: [], clientKeys: ['laptop'], caller: { kind: 'operator', client: null, refused: [] } };
  await page.answer(200, status);
  page.click('Show details');
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, '/teamclaude/client-keys/show');
  assert.deepEqual(JSON.parse(page.requests[0].init.body), { name: 'laptop' });
  assert.equal(page.requests[0].init.headers['x-api-key'], 'tc-operator');
  await page.answer(200, { ok: true, name: 'laptop', key: 'tc-old' });

  assert.equal(page.byId('ckIssued').style.display, '');
  assert.ok(page.findLast(e => e.value === 'tc-old'), 'the key is shown');
  assert.ok(page.findLast(e => typeof e.value === 'string' && e.value.includes('ANTHROPIC_API_KEY=tc-old')), 'with the Claude Code setup');
  assert.ok(page.findLast(e => /Anyone who can see this screen/.test(e.textContent)));
  assert.equal(page.byId('ckStatus').style.display, 'none', 'no status line repeats the panel');

  page.click('Hide details');
  assert.equal(page.byId('ckIssued').style.display, 'none');
  assert.ok(page.findLast(e => e.textContent === 'Show details'), 'the row offers it again');
});

test('a key Show details cannot read leaves the panel shut and says why', async () => {
  const page = bootPage({ storedKey: 'tc-operator' });
  await page.answer(200, { accounts: [], clientKeys: ['laptop'], caller: { kind: 'operator', client: null, refused: [] } });
  page.click('Show details');
  await page.answer(400, { ok: false, error: 'no client key is named "laptop"' });
  assert.notEqual(page.byId('ckIssued').style.display, '', 'the panel never opened');
  assert.match(page.byId('ckStatus').textContent, /could not read the key: no client key is named "laptop"/);
});

test('logEventClient names the client key and the program that sent a request', () => {
  assert.equal(logEventClient({ client: 'laptop', agent: 'claude-cli/2.1.3' }), 'laptop · claude-cli/2.1.3');
  assert.equal(logEventClient({ agent: 'codex_cli_rs/0.46.0' }), 'codex_cli_rs/0.46.0');
  assert.equal(logEventClient({ kind: 'signin' }), '');
});

test('a page showing a linked instance asks it through the relay, and this machine for the picker', async () => {
  const page = bootPage({ storedInstance: 'my server' });
  // This machine first: it proves the key and lists what there is to pick.
  assert.equal(page.requests[0].url, '/teamclaude/peers');
  await page.answer(200, { peers: [{ name: 'my server', url: 'http://100.64.0.2:3456', state: 'online' }] });
  assert.equal(page.requests[0].url, '/teamclaude/peers/my%20server/status');
  await page.answer(200, { accounts: [] });
  assert.equal(page.byId('instances').style.display, '');
  assert.equal(page.byId('instanceNote').style.display, '');
  assert.match(page.byId('instanceText').textContent, /my server \(http:\/\/100\.64\.0\.2:3456\)/);

  // Controls go to the instance shown too.
  page.byId('reload').fire('click');
  assert.equal(page.requests[0].url, '/teamclaude/peers/my%20server/reload');
});

test('a page on this machine hides the picker until a peer is configured', async () => {
  const page = bootPage();
  assert.equal(page.requests[0].url, '/teamclaude/status');
  await page.answer(200, { accounts: [], peers: [] });
  assert.equal(page.byId('instances').style.display, 'none');
  page.poll();
  await page.answer(200, { accounts: [], peers: [{ name: 'desktop', url: 'http://100.64.0.1:3456', state: 'offline' }] });
  assert.equal(page.byId('instances').style.display, '');
  assert.equal(page.byId('instanceNote').style.display, 'none');
  assert.equal(page.requests.length, 0, 'the picker came with the status read');
});

test('the picker calls this machine by its instance name, and the way back names it too', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], peers: [{ name: 'desktop', url: 'http://100.64.0.1:3456', state: 'online' }], instance: { name: 'hermes', host: 'hermes-box', custom: true } });
  assert.ok(page.labelled('hermes') >= 1, 'the option for this machine says hermes');
  assert.equal(page.labelled('This machine'), 0);
  assert.equal(page.byId('instanceBack').textContent, 'Back to hermes');
});

test('a linked instance shown names the machine it is reached through', async () => {
  const page = bootPage({ storedInstance: 'desktop' });
  assert.equal(page.requests[0].url, '/teamclaude/peers');
  await page.answer(200, { self: { name: 'hermes' }, peers: [{ name: 'desktop', url: 'http://100.64.0.1:3456', state: 'online' }] });
  assert.match(page.byId('instanceText').textContent, /^Showing desktop .*, reached through hermes\.$/);
  assert.equal(page.byId('instanceBack').textContent, 'Back to hermes');
});

test('a proxy too old to name itself is still This machine in the picker', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], peers: [{ name: 'desktop', url: 'http://100.64.0.1:3456', state: 'online' }] });
  assert.ok(page.labelled('This machine') >= 1);
  assert.equal(page.byId('instanceBack').textContent, 'Back to this machine');
  assert.equal(page.byId('nameRow').style.display, 'none', 'and has no Instance name row to offer');
});

test('the Instance name row shows the name set, offers the host name, and saves what is typed', async () => {
  const page = bootPage({ storedKey: 'tc-operator' });
  await page.answer(200, { accounts: [], instance: { name: 'hermes-box', host: 'hermes-box', custom: false } });
  assert.equal(page.byId('nameRow').style.display, '');
  assert.equal(page.byId('nameVal').value, '', 'the host name is a placeholder, not a saved name');
  assert.equal(page.byId('nameVal').placeholder, 'hermes-box');

  page.byId('nameVal').value = '  hermes ';
  page.byId('nameSet').fire('click');
  assert.equal(page.requests[0].url, '/teamclaude/instance-name');
  assert.deepEqual(JSON.parse(page.requests[0].init.body), { name: 'hermes' });
  assert.equal(page.requests[0].init.headers['x-api-key'], 'tc-operator');
  await page.answer(200, { ok: true, name: 'hermes', host: 'hermes-box', custom: true });
  assert.match(page.byId('note').textContent, /this instance is now called hermes/);
  assert.equal(page.byId('nameVal').value, 'hermes');
  assert.equal(page.requests[0].url, '/teamclaude/status', 'and the page reads the new name back');
});

test('a linked instance that is down never hides the way back, even across a key prompt', async () => {
  const page = bootPage({ storedInstance: 'server' });
  await page.answer(401, {});
  assert.equal(page.byId('keybox').style.display, 'block');
  assert.equal(page.requests[0].url, '/teamclaude/auth/methods');
  await page.answer(200, { password: false });
  assert.equal(page.byId('pwForm').style.display, 'none', 'no password set: the key field alone');
  page.byId('key').value = 'tc-local';
  page.byId('go').fire('click');
  assert.equal(page.requests[0].url, '/teamclaude/peers');
  await page.answer(200, { peers: [{ name: 'server', url: 'http://100.64.0.2:3456', state: 'offline' }] });
  await page.answer(502, { ok: false, unreachable: true, error: 'server is unreachable (connect ECONNREFUSED)' });
  assert.equal(page.byId('keybox').style.display, 'none');
  assert.equal(page.byId('app').style.display, '');
  assert.equal(page.byId('instances').style.display, '');
  assert.equal(page.byId('instanceNote').style.display, '');
  assert.match(page.byId('err').textContent, /server is unreachable/);
  assert.equal(page.store.get('teamclaude-dashboard-key'), 'tc-local', 'the local key was never at fault');
});

test('the key box offers a password sign-in when the proxy has one, and keeps the key it is answered with', async () => {
  const page = bootPage();
  await page.answer(401, {});
  assert.equal(page.requests[0].url, '/teamclaude/auth/methods');
  await page.answer(200, { password: true });
  assert.equal(page.byId('pwForm').style.display, '');
  assert.equal(page.byId('keySub').style.display, 'none');

  page.byId('pwUser').value = ' me ';
  page.byId('pwPass').value = 'long enough';
  page.byId('pwForm').fire('submit', { preventDefault() {} });
  assert.equal(page.requests[0].url, '/teamclaude/auth/login');
  assert.deepEqual(JSON.parse(page.requests[0].init.body), { username: 'me', password: 'long enough' });
  assert.equal(page.requests[0].init.headers['x-api-key'], undefined, 'no key to send yet');
  await page.answer(401, { ok: false, error: 'wrong username or password' });
  assert.match(page.byId('pwErr').textContent, /Wrong username or password/);
  assert.equal(page.store.has('teamclaude-dashboard-key'), false);

  page.byId('pwForm').fire('submit', { preventDefault() {} });
  await page.answer(200, { ok: true, key: 'tc-from-password' });
  assert.equal(page.store.get('teamclaude-dashboard-key'), 'tc-from-password');
  assert.equal(page.byId('pwPass').value, '', 'the password is not left in the field');
  assert.equal(page.requests[0].url, '/teamclaude/status');
  assert.equal(page.requests[0].init.headers['x-api-key'], 'tc-from-password');
});

test('at a host name the proxy does not take a sign-in at, the key box says to use its address', async () => {
  const page = bootPage();
  await page.answer(401, {});
  await page.answer(200, { password: false, hostRefused: true });
  assert.equal(page.byId('pwForm').style.display, 'none');
  assert.equal(page.byId('pwHere').style.display, '');
});

test('the Dashboard password row saves a username and password with the key, and turns it off', async () => {
  const page = bootPage({ storedKey: 'tc-operator' });
  await page.answer(200, { accounts: [], caller: { kind: 'operator', client: null, refused: [] }, dashboardLogin: null });
  assert.equal(page.byId('pwRow').style.display, '');
  assert.equal(page.byId('pwOff').style.display, 'none', 'nothing to turn off yet');
  page.byId('pwSetUser').value = 'me';
  page.byId('pwSetPass').value = 'long enough';
  page.byId('pwSetForm').fire('submit', { preventDefault() {} });
  assert.equal(page.requests[0].url, '/teamclaude/dashboard-login');
  assert.deepEqual(JSON.parse(page.requests[0].init.body), { username: 'me', password: 'long enough' });
  assert.equal(page.requests[0].init.headers['x-api-key'], 'tc-operator');
  await page.answer(200, { ok: true, username: 'me' });
  assert.match(page.byId('note').textContent, /dashboard password set for me/);
  assert.equal(page.byId('pwSetPass').value, '');
  await page.answer(200, { accounts: [], caller: { kind: 'operator', client: null, refused: [] }, dashboardLogin: 'me' });
  assert.equal(page.byId('pwOff').style.display, '');
  assert.match(page.byId('pwTag').textContent, /On for me/);

  page.byId('pwOff').fire('click');
  assert.deepEqual(JSON.parse(page.requests[0].init.body), { username: '', password: '' });
});

test('a client key sees no Dashboard password row', async () => {
  const page = bootPage({ storedKey: 'tc-client' });
  await page.answer(200, { accounts: [], caller: { kind: 'client', client: 'ci', refused: ['/teamclaude/dashboard-login'] } });
  assert.equal(page.byId('pwRow').style.display, 'none');
});

test('a client key with a linked instance still picked goes back to this machine and keeps its key', async () => {
  const page = bootPage({ storedKey: 'tc-client', storedInstance: 'server' });
  await page.answer(403, { ok: false, error: 'a client key cannot reach linked instances' });
  assert.equal(page.store.has('teamclaude-dashboard-instance'), false);
  assert.equal(page.store.get('teamclaude-dashboard-key'), 'tc-client');
  page.poll();
  assert.equal(page.requests[0].url, '/teamclaude/status');
});

test('a picked name that is gone from the config is never asked for', async () => {
  const page = bootPage({ storedInstance: '..' });
  await page.answer(200, { peers: [{ name: 'server', url: 'http://h:1', state: 'online' }] });
  assert.equal(page.store.has('teamclaude-dashboard-instance'), false);
  assert.equal(page.requests.length, 0, 'nothing went out under the stale name');
});

test('a linked instance at a loopback address still signs in the remote way', async () => {
  const page = bootPage({ storedInstance: 'tunnel' });
  await page.answer(200, { peers: [{ name: 'tunnel', url: 'http://127.0.0.1:9999', state: 'online' }] });
  await page.answer(200, { accounts: [] });
  page.click('Sign in to Claude');
  assert.equal(page.requests[0].url, '/teamclaude/peers/tunnel/login/start');
  await page.answer(200, { ok: true, id: 'abc', provider: 'claude', url: 'https://claude.ai/x?r=code-page', browserUrl: 'http://localhost:9/x', listening: true });
  // The callback listener is on the linked machine, so the code page it is.
  assert.equal(page.findLast(e => e.textContent === 'Open sign-in page').href, 'https://claude.ai/x?r=code-page');
  assert.ok(page.findLast(e => e.placeholder === 'Paste the code here'));
});

test('a page opened on Logs with a linked instance picked relays nothing before this machine allows it', async () => {
  // The page reads its tab from the address; this one opens on Logs.
  globalThis.location = { hash: '#logs', hostname: '', origin: '', reload() {} };
  try {
    const page = bootPage({ storedKey: 'tc-client', storedInstance: 'server' });
    assert.deepEqual(page.requests.map(r => r.url), ['/teamclaude/peers']);
    await page.answer(403, { ok: false, error: 'a client key cannot reach linked instances' });
    assert.equal(page.store.get('teamclaude-dashboard-key'), 'tc-client', 'the valid key is kept');
    assert.equal(page.store.has('teamclaude-dashboard-instance'), false);
    assert.equal(page.requests.length, 0);
  } finally {
    delete globalThis.location;
  }
});

// The Linked instances card on Settings.

test('peerLinkRequest posts each step to its own route with the page key', () => {
  const r = peerLinkRequest('add', { name: 'desk', url: 'http://h:1', apiKey: 'k' }, 'tc-op');
  assert.equal(r.url, '/teamclaude/peer-links/add');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'tc-op');
  assert.deepEqual(JSON.parse(r.init.body), { name: 'desk', url: 'http://h:1', apiKey: 'k' });
  assert.equal(peerLinkRequest('key', null, null).init.body, '{}');
  assert.equal(peerLinkRequest('key', null, null).init.headers['x-api-key'], '');
});

test('peerLinkOutcome says when a link went one way only', () => {
  assert.deepEqual(peerLinkOutcome({ ok: true, name: 'desk', linkBack: { ok: true } }, 'add'),
    { kind: 'ok', text: 'Linked desk both ways: each dashboard now shows the other in the Instance picker.' });
  assert.deepEqual(peerLinkOutcome({ ok: true, name: 'desk', linkBack: { ok: false, error: 'desk refused the key' } }, 'add'),
    { kind: 'warn', text: 'Linked desk, but it did not link back: desk refused the key.' });
  assert.equal(peerLinkOutcome({ ok: true, name: 'desk' }, 'add').kind, 'ok');
  assert.match(peerLinkOutcome({ ok: true, name: 'desk' }, 'remove').text, /^Removed desk\. If it lists this machine too/);
  assert.deepEqual(peerLinkOutcome({ ok: false, error: 'an instance named "desk" is already linked' }, 'add'),
    { kind: 'error', text: 'could not link the instance: an instance named "desk" is already linked' });
  assert.equal(peerLinkOutcome(null, 'remove').text, 'could not remove the link');
});

test('peerLinkOutcome names the instances the join linked across, and the ones it could not', () => {
  const both = 'Linked hub both ways: each dashboard now shows the other in the Instance picker.';
  assert.deepEqual(peerLinkOutcome({ ok: true, name: 'hub', linkBack: { ok: true }, mesh: { linked: [], skipped: [] } }, 'add'),
    { kind: 'ok', text: both });
  // Both directions of a pair read as one; a pair linked one way only keeps its arrow.
  assert.deepEqual(peerLinkOutcome({ ok: true, name: 'hub', linkBack: { ok: true }, mesh: {
    linked: [{ from: 'desk', to: 'server' }, { from: 'server', to: 'desk' }, { from: 'laptop', to: 'hub' }],
    skipped: [],
  } }, 'add'), { kind: 'ok', text: both + ' Also linked the instances they already listed: desk ↔ server, laptop → hub.' });
  assert.deepEqual(peerLinkOutcome({ ok: true, name: 'hub', linkBack: { ok: true }, mesh: {
    linked: [{ from: 'desk', to: 'server' }],
    skipped: [{ from: 'server', to: 'desk', error: 'desk is offline from server' }],
  } }, 'add'), { kind: 'warn', text: both + ' Also linked the instances they already listed: desk → server. Not linked: desk is offline from server.' });
});

test('peerTestOutcome tells a wrong key, a wrong address and an old version apart', () => {
  assert.deepEqual(peerTestOutcome({ ok: true, state: 'online', linkable: true, name: 'desk' }), { kind: 'ok', text: 'It answers to that key and calls itself desk.' });
  assert.equal(peerTestOutcome({ ok: true, state: 'online', linkable: true }).text, 'It answers to that key.');
  assert.equal(peerTestOutcome({ ok: true, state: 'online', linkable: false }).kind, 'warn');
  assert.match(peerTestOutcome({ ok: true, state: 'refused', linkable: false }).text, /refused that key/);
  assert.match(peerTestOutcome({ ok: true, state: 'refused', linkable: false, clientKey: true }).text, /one of its client keys.*needs its proxy key/);
  assert.match(peerTestOutcome({ ok: true, url: 'http://h:1', state: 'offline', linkable: false }).text, /Nothing answered at http:\/\/h:1/);
  assert.equal(peerTestOutcome({ ok: false, error: 'bad' }).text, 'could not test the link: bad');
});

test('linkSelfOptions puts the address the page was opened at first, unless that is loopback', () => {
  const self = { addresses: ['http://100.64.0.1:3456', 'http://10.0.0.5:3456'] };
  assert.deepEqual(linkSelfOptions(self, 'http://100.64.0.1:3456'), ['http://100.64.0.1:3456', 'http://10.0.0.5:3456']);
  assert.deepEqual(linkSelfOptions(self, 'http://hub.tail.ts.net:3456'), ['http://hub.tail.ts.net:3456', 'http://100.64.0.1:3456', 'http://10.0.0.5:3456']);
  assert.deepEqual(linkSelfOptions(self, 'http://localhost:3456'), self.addresses);
  assert.deepEqual(linkSelfOptions(self, ''), self.addresses);
  assert.deepEqual(linkSelfOptions(null, 'not a url'), []);
});

test('linkSelfOptions puts the Instance address set ahead of the page address and the guess', () => {
  // A Docker container guesses its own bridge address; the address set is the host's.
  const self = { address: 'http://100.64.0.9:3456', addresses: ['http://100.64.0.9:3456', 'http://172.30.0.2:3456'] };
  assert.deepEqual(linkSelfOptions(self, 'http://localhost:3456'), ['http://100.64.0.9:3456', 'http://172.30.0.2:3456']);
  assert.deepEqual(linkSelfOptions(self, 'http://hub.lan:3456'), ['http://100.64.0.9:3456', 'http://hub.lan:3456', 'http://172.30.0.2:3456']);
  assert.deepEqual(linkSelfOptions({ ...self, address: '' }, 'http://localhost:3456'), self.addresses);
});

test('linkBackNotice blocks a machine without a key, and only warns about one on loopback', () => {
  assert.equal(linkBackNotice({ offBox: true, hasKey: true }), null);
  assert.equal(linkBackNotice(null), null);
  const loopback = linkBackNotice({ offBox: false, hasKey: true });
  assert.equal(loopback.block, false, 'a reverse proxy or Tailscale Serve can still reach it');
  assert.match(loopback.text, /listens on its own machine only.*reverse proxy or Tailscale Serve/);
  const keyless = linkBackNotice({ offBox: true, hasKey: false });
  assert.equal(keyless.block, true);
  assert.match(keyless.text, /no proxy key/);
  assert.equal(linkBackNotice({ offBox: false, hasKey: false }).block, true);
});

// The Account sync card's reads, answered as by a server without it: the
// Linked instances tests are about that card's own requests.
const NO_ACCOUNT_SYNC = (url) => (url.includes('/account-sync') ? { status: 501, body: { ok: false } } : null);

/** Boot the page on Settings, as opened at `origin`, and run `fn` with it. */
async function onSettings(fn, { origin = 'http://100.64.0.1:3456', autoAnswer = NO_ACCOUNT_SYNC, ...boot } = {}) {
  const hostname = new URL(origin).hostname;
  globalThis.location = { hash: '#settings', hostname, origin, reload() {} };
  try {
    await fn(bootPage({ autoAnswer, ...boot }));
  } finally {
    delete globalThis.location;
  }
}

const OPERATOR = { kind: 'operator', client: null, refused: [] };
const SELF = { name: 'hub', addresses: ['http://100.64.0.1:3456', 'http://10.0.0.5:3456'], offBox: true, hasKey: true };

test('the card links another machine both ways from the form, testing it first', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    assert.equal(page.byId('links').style.display, '');
    assert.equal(page.requests[0].url, '/teamclaude/peer-links', 'what this machine can offer is asked once Settings shows');
    await page.answer(200, { self: SELF, peers: [] });
    assert.equal(page.byId('linkSelfUrl').value, 'http://100.64.0.1:3456', 'prefilled with the address the page was opened at');
    assert.equal(page.byId('linkSelfName').value, 'hub');
    assert.equal(page.byId('linkBackBlocked').style.display, 'none');
    assert.equal(page.byId('linkEmpty').style.display, '');

    page.byId('linkUrl').value = '100.64.0.2:3456';
    page.byId('linkKey').value = 'tc-desk';
    page.byId('linkTest').fire('click');
    assert.equal(page.requests[0].url, '/teamclaude/peer-links/test');
    assert.deepEqual(JSON.parse(page.requests[0].init.body), { url: '100.64.0.2:3456', apiKey: 'tc-desk' });
    await page.answer(200, { ok: true, url: 'http://100.64.0.2:3456', state: 'online', linkable: true, name: 'desk' });
    assert.equal(page.byId('linkName').value, '', 'naming it is left to the operator');
    assert.equal(page.byId('linkName').placeholder, 'e.g. desk', 'the name it calls itself is only suggested');
    assert.equal(page.byId('linkStatus').textContent, 'It answers to that key and calls itself desk.');
    page.byId('linkName').value = 'desk';

    page.byId('linkBack').checked = true;
    page.byId('linkForm').fire('submit', { preventDefault() {} });
    assert.equal(page.requests[0].url, '/teamclaude/peer-links/add');
    assert.deepEqual(JSON.parse(page.requests[0].init.body), {
      name: 'desk', url: '100.64.0.2:3456', apiKey: 'tc-desk', linkBack: { name: 'hub', url: 'http://100.64.0.1:3456' },
    });
    await page.answer(200, { ok: true, name: 'desk', url: 'http://100.64.0.2:3456', linkBack: { ok: true } });
    assert.match(page.byId('linkStatus').textContent, /^Linked desk both ways/);
    assert.equal(page.byId('linkKey').value, '', 'the key does not stay in the form');
    assert.equal(page.requests[0].url, '/teamclaude/status', 'the list and the picker refresh at once');
    await page.answer(200, { accounts: [], peers: [{ name: 'desk', url: 'http://100.64.0.2:3456', state: 'checking' }], caller: OPERATOR });
    assert.equal(page.byId('instances').style.display, '', 'the picker appears');
    assert.ok(page.findLast(e => e.textContent === 'http://100.64.0.2:3456'), 'the list shows the new link');
  });
});

test('a loopback-only machine opened at localhost starts with link back unticked but still offered', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answer(200, { self: { ...SELF, offBox: false, addresses: [] }, peers: [] });
    const cb = page.byId('linkBack');
    assert.equal(cb.checked, false, 'no address to offer the other machine');
    assert.equal(cb.disabled, false, 'an address typed in by hand can still be sent');
    assert.equal(page.byId('linkBackBlocked').style.display, '');
    assert.match(page.byId('linkBackBlocked').textContent, /listens on its own machine only/);
    assert.equal(page.byId('linkSelfUrl').value, '', 'a loopback page address is never offered');
    page.byId('linkUrl').value = 'http://100.64.0.2:3456';
    page.byId('linkKey').value = 'k';
    page.byId('linkName').value = 'desk';
    page.byId('linkForm').fire('submit', { preventDefault() {} });
    assert.equal(JSON.parse(page.requests[0].init.body).linkBack, undefined);
  }, { origin: 'http://localhost:3456' });
});

test('a loopback-only machine behind a reverse proxy links back at the address the page came through', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answer(200, { self: { ...SELF, offBox: false, addresses: [] }, peers: [] });
    const cb = page.byId('linkBack');
    assert.equal(cb.disabled, false);
    assert.notEqual(cb.checked, false, 'left ticked: there is an address to offer');
    assert.equal(page.byId('linkSelfUrl').value, 'https://hub.tail1234.ts.net');
    assert.match(page.byId('linkBackBlocked').textContent, /Tailscale Serve/, 'the warning still says what it depends on');
    page.byId('linkUrl').value = 'http://100.64.0.2:3456';
    page.byId('linkKey').value = 'k';
    page.byId('linkName').value = 'desk';
    page.byId('linkForm').fire('submit', { preventDefault() {} });
    assert.deepEqual(JSON.parse(page.requests[0].init.body).linkBack, { name: 'hub', url: 'https://hub.tail1234.ts.net' });
  }, { origin: 'https://hub.tail1234.ts.net' });
});

test('a machine without a proxy key unticks and locks the link back', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answer(200, { self: { ...SELF, hasKey: false }, peers: [] });
    const cb = page.byId('linkBack');
    assert.equal(cb.checked, false);
    assert.equal(cb.disabled, true);
    assert.match(page.byId('linkBackBlocked').textContent, /no proxy key/);
  });
});

test('a test that finds an older version unticks the link back', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answer(200, { self: SELF, peers: [] });
    page.byId('linkBack').checked = true;
    page.byId('linkUrl').value = 'http://100.64.0.2:3456';
    page.byId('linkKey').value = 'k';
    page.byId('linkTest').fire('click');
    await page.answer(200, { ok: true, url: 'http://100.64.0.2:3456', state: 'online', linkable: false });
    assert.equal(page.byId('linkBack').checked, false);
    assert.equal(page.byId('linkBackFields').style.display, 'none');
    assert.equal(page.byId('linkStatus').className, 'st warn');
  });
});

test('the form asks for what is missing instead of sending it', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answer(200, { self: SELF, peers: [] });
    page.byId('linkTest').fire('click');
    page.byId('linkForm').fire('submit', { preventDefault() {} });
    assert.equal(page.requests.length, 0);
    assert.match(page.byId('linkStatus').textContent, /Fill in its address and its proxy key, or paste its link/);
  });
});

test('instanceLink and parseInstanceLink carry an address and a key, and nothing else', () => {
  const link = instanceLink('http://100.64.0.2:3456', 'tc-a&b=c d');
  assert.equal(link, 'teamrouter://link?address=http%3A%2F%2F100.64.0.2%3A3456&key=tc-a%26b%3Dc%20d');
  assert.deepEqual(parseInstanceLink(link), { url: 'http://100.64.0.2:3456', apiKey: 'tc-a&b=c d' });
  assert.deepEqual(parseInstanceLink('  ' + link + '\n'), { url: 'http://100.64.0.2:3456', apiKey: 'tc-a&b=c d' }, 'pasted with whitespace');
  assert.deepEqual(parseInstanceLink('teamclaude://link?address=https%3A%2F%2Fhub.ts.net&key=k'), { url: 'https://hub.ts.net', apiKey: 'k' }, 'the old spelling');
  assert.equal(instanceLink('', 'k'), '');
  assert.equal(instanceLink('http://h:1', ''), '');
  for (const bad of ['', 'http://100.64.0.2:3456', 'teamrouter://other?address=http%3A%2F%2Fh&key=k', 'teamrouter://link?address=http%3A%2F%2Fh',
    'teamrouter://link?key=k', 'teamrouter://link?address=file%3A%2F%2F%2Fetc&key=k', 'teamrouter://link?address=nope&key=k', 'tc-just-a-key']) {
    assert.equal(parseInstanceLink(bad), null, bad);
  }
});

test('linkAddMissing asks for a name on its own once the address and key are there', () => {
  assert.equal(linkAddMissing({ name: 'desk', url: 'http://h:1', apiKey: 'k' }), null);
  assert.match(linkAddMissing({ name: '', url: 'http://h:1', apiKey: 'k' }), /^You need to name this machine/);
  assert.match(linkAddMissing({ name: 'desk', url: '', apiKey: 'k' }), /address and its proxy key/);
  assert.match(linkAddMissing({ name: '', url: 'http://h:1', apiKey: '' }), /address and its proxy key/);
});

test('a pasted link fills the form, and Link without a name keeps it all until a name is given', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answer(200, { self: SELF, peers: [] });
    page.byId('linkBack').checked = false;
    page.byId('linkPaste').value = 'teamrouter://link?address=http%3A%2F%2F100.64.0.2%3A3456&ke';
    page.byId('linkPaste').fire('input');
    assert.equal(page.byId('linkStatus').textContent, '', 'half a link is not an error while typing');
    page.byId('linkPaste').fire('change');
    assert.match(page.byId('linkStatus').textContent, /not a link from the Linked instances card/);
    assert.equal(page.byId('linkUrl').value, '');

    page.byId('linkPaste').value = instanceLink('http://100.64.0.2:3456', 'tc-desk');
    page.byId('linkPaste').fire('input');
    assert.equal(page.byId('linkUrl').value, 'http://100.64.0.2:3456');
    assert.equal(page.byId('linkKey').value, 'tc-desk');
    assert.equal(page.byId('linkName').value, '', 'the link carries no name');
    assert.match(page.byId('linkStatus').textContent, /Name it, then click Link/);

    page.byId('linkForm').fire('submit', { preventDefault() {} });
    assert.equal(page.requests.length, 0, 'nothing is sent without a name');
    assert.match(page.byId('linkStatus').textContent, /^You need to name this machine/);
    assert.equal(page.byId('linkUrl').value, 'http://100.64.0.2:3456', 'the address stays');
    assert.equal(page.byId('linkKey').value, 'tc-desk', 'the key stays');

    page.byId('linkName').value = 'desk';
    page.byId('linkForm').fire('submit', { preventDefault() {} });
    assert.equal(page.requests[0].url, '/teamclaude/peer-links/add');
    assert.deepEqual(JSON.parse(page.requests[0].init.body), { name: 'desk', url: 'http://100.64.0.2:3456', apiKey: 'tc-desk' });
    await page.answer(200, { ok: true, name: 'desk', url: 'http://100.64.0.2:3456' });
    assert.match(page.byId('linkStatus').textContent, /^Linked desk/);
    for (const id of ['linkPaste', 'linkUrl', 'linkKey', 'linkName']) assert.equal(page.byId(id).value, '', `${id} is cleared once linked`);
  });
});

test('Show key reads this machine\'s key and offers it with an address to copy', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answer(200, { self: SELF, peers: [] });
    page.byId('ownKeyShow').fire('click');
    assert.equal(page.requests[0].url, '/teamclaude/peer-links/key');
    await page.answer(200, { ok: true, key: 'tc-hub' });
    assert.equal(page.byId('ownKeyBox').style.display, '');
    assert.ok(page.findLast(e => e.value === 'tc-hub'), 'the key');
    assert.ok(page.findLast(e => e.value === 'http://100.64.0.1:3456'), 'and where to reach this machine');
    const link = page.findLast(e => String(e.value).startsWith('teamrouter://link?'));
    assert.ok(link, 'and the link that carries both');
    assert.deepEqual(parseInstanceLink(link.value), { url: 'http://100.64.0.1:3456', apiKey: 'tc-hub' });
    assert.equal(page.byId('ownKeyShow').textContent, 'Hide key');
    page.byId('ownKeyShow').fire('click');
    assert.equal(page.byId('ownKeyBox').style.display, 'none');
    assert.equal(page.requests.length, 0, 'hiding asks nothing');
  });
});

test('Remove is armed by a first click and sent by the second', async () => {
  await onSettings(async (page) => {
    const peers = [{ name: 'desk', url: 'http://100.64.0.2:3456', state: 'online' }];
    await page.answer(200, { accounts: [], peers, caller: OPERATOR });
    await page.answer(200, { self: SELF, peers });
    page.click('Remove');
    assert.equal(page.requests.length, 0);
    const realNow = Date.now;
    Date.now = () => realNow() + 1000;
    try { page.click('Confirm remove'); } finally { Date.now = realNow; }
    assert.equal(page.requests[0].url, '/teamclaude/peer-links/remove');
    assert.deepEqual(JSON.parse(page.requests[0].init.body), { name: 'desk' });
    await page.answer(200, { ok: true, name: 'desk', removed: 1 });
    assert.match(page.byId('linkStatus').textContent, /^Removed desk/);
  });
});

test('the card is hidden from a client key, and asks nothing', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], caller: { kind: 'client', client: 'laptop', refused: ['/teamclaude/peer-links/add'] } });
    assert.equal(page.byId('links').style.display, 'none');
    assert.equal(page.requests.length, 0);
  }, { storedKey: 'tc-client' });
});

test('an instance from before the card says so instead of offering a form that cannot work', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { peers: [{ name: 'server', url: 'http://100.64.0.2:3456', state: 'online' }] });
    await page.answer(200, { accounts: [], peers: [{ name: 'hub', url: 'http://100.64.0.1:3456', state: 'online' }], caller: OPERATOR });
    // Managed through the relay, like every other control on a linked instance's page.
    assert.equal(page.requests[0].url, '/teamclaude/peers/server/peer-links');
    await page.answer(404, { error: 'unknown teamclaude control route (check the path and the method)' });
    assert.equal(page.byId('linkUnsupported').style.display, '');
    assert.equal(page.byId('linkForm').style.display, 'none');
    assert.equal(page.byId('ownKey').style.display, 'none');
    page.poll();
    await page.answer(200, { peers: [{ name: 'server', url: 'http://100.64.0.2:3456', state: 'online' }] });
    await page.answer(200, { accounts: [], peers: [{ name: 'hub', url: 'http://100.64.0.1:3456', state: 'online' }], caller: OPERATOR });
    assert.equal(page.requests.length, 0, 'not asked again');
    assert.equal(page.labelled('Remove'), 0);
    assert.equal(page.labelled('Open'), 0, 'its links are not in this machine\'s picker');
  }, { storedInstance: 'server' });
});

test('instanceNameRequest posts the name, and instanceNameOutcome says what it is called now', () => {
  const r = instanceNameRequest('hermes', 'tc-k');
  assert.equal(r.url, '/teamclaude/instance-name');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'tc-k');
  assert.deepEqual(JSON.parse(r.init.body), { name: 'hermes' });
  assert.deepEqual(instanceNameOutcome({ ok: true, name: 'hermes', custom: true }), { kind: 'ok', text: 'this instance is now called hermes' });
  assert.match(instanceNameOutcome({ ok: true, name: 'box', custom: false }).text, /cleared; it goes by its host name, box$/);
  assert.equal(instanceNameOutcome({ ok: false, error: 'bad name' }).text, 'instance name change failed: bad name');
  assert.equal(instanceNameOutcome(null).kind, 'error');
});

test('instanceAddressRequest posts the address, and instanceAddressOutcome says what other machines get', () => {
  const r = instanceAddressRequest('http://100.64.0.9:3456', 'tc-k');
  assert.equal(r.url, '/teamclaude/instance-address');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'tc-k');
  assert.deepEqual(JSON.parse(r.init.body), { address: 'http://100.64.0.9:3456' });
  assert.deepEqual(instanceAddressOutcome({ ok: true, address: 'http://100.64.0.9:3456' }), { kind: 'ok', text: 'other machines are now given http://100.64.0.9:3456' });
  assert.match(instanceAddressOutcome({ ok: true, address: '' }).text, /cleared; the link uses a guess again$/);
  assert.equal(instanceAddressOutcome({ ok: false, error: 'bad' }).text, 'instance address change failed: bad');
  assert.equal(instanceAddressOutcome(null).kind, 'error');
});

test('the Instance address row saves what is typed, and the link handed out then carries it', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR, instance: { name: 'hub', host: 'hub', custom: false, address: '' } });
    assert.equal(page.byId('addrRow').style.display, '');
    assert.equal(page.byId('addrVal').value, '');
    await page.answer(200, { self: { ...SELF, addresses: ['http://172.30.0.2:3456'] }, peers: [] });
    assert.equal(page.byId('linkSelfUrl').value, 'http://172.30.0.2:3456', 'the container guess, before an address is set');
    page.byId('ownKeyShow').fire('click');
    await page.answer(200, { ok: true, key: 'tc-hub' });

    page.byId('addrVal').value = ' 100.64.0.9:3456 ';
    page.byId('addrSet').fire('click');
    assert.equal(page.requests[0].url, '/teamclaude/instance-address');
    assert.deepEqual(JSON.parse(page.requests[0].init.body), { address: '100.64.0.9:3456' });
    await page.answer(200, { ok: true, address: 'http://100.64.0.9:3456' });
    assert.match(page.byId('note').textContent, /other machines are now given http:\/\/100\.64\.0\.9:3456/);
    assert.equal(page.byId('addrVal').value, 'http://100.64.0.9:3456');
    assert.equal(page.byId('ownKeyBox').style.display, 'none', 'the link shown with the old address is closed');
    assert.equal(page.requests[0].url, '/teamclaude/status');
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR, instance: { name: 'hub', host: 'hub', custom: false, address: 'http://100.64.0.9:3456' } });
    assert.equal(page.requests[0].url, '/teamclaude/peer-links', 'what this machine offers is asked again');
    await page.answer(200, { self: { ...SELF, address: 'http://100.64.0.9:3456', addresses: ['http://100.64.0.9:3456', 'http://172.30.0.2:3456'] }, peers: [] });
    assert.equal(page.byId('linkSelfUrl').value, 'http://100.64.0.9:3456', 'the untouched prefill follows it');

    page.byId('ownKeyShow').fire('click');
    await page.answer(200, { ok: true, key: 'tc-hub' });
    const link = page.findLast(e => String(e.value).startsWith('teamrouter://link?'));
    assert.deepEqual(parseInstanceLink(link.value), { url: 'http://100.64.0.9:3456', apiKey: 'tc-hub' });
    assert.ok(page.findLast(e => e.textContent === 'Address (set under Instance address above)'), 'and says it is no guess');
  }, { origin: 'http://localhost:3456', storedKey: 'tc-operator' });
});

test('linkSelfWithAddress swaps the address set and keeps the guesses', () => {
  const self = { name: 'hub', address: 'http://100.64.0.9:3456', addresses: ['http://100.64.0.9:3456', 'http://172.30.0.2:3456'] };
  assert.deepEqual(linkSelfWithAddress(self, 'http://100.64.0.7:3456').addresses, ['http://100.64.0.7:3456', 'http://172.30.0.2:3456']);
  assert.deepEqual(linkSelfWithAddress(self, ''), { ...self, address: '', addresses: ['http://172.30.0.2:3456'] });
  assert.deepEqual(linkSelfWithAddress({ name: 'hub', addresses: ['http://172.30.0.2:3456'] }, 'http://172.30.0.2:3456').addresses, ['http://172.30.0.2:3456'], 'not listed twice');
  assert.equal(self.address, 'http://100.64.0.9:3456', 'the read it came from is left alone');
  assert.equal(linkSelfWithAddress(null, 'x'), null);
});

test('a Show key answered before the reads that follow a save already carries the new address', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR, instance: { name: 'hub', host: 'hub', custom: false, address: '' } });
    await page.answer(200, { self: { ...SELF, address: '', addresses: ['http://172.30.0.2:3456'] }, peers: [] });
    page.byId('addrVal').value = '100.64.0.9:3456';
    page.byId('addrSet').fire('click');
    await page.answerTo('/teamclaude/instance-address', 200, { ok: true, address: 'http://100.64.0.9:3456' });
    assert.equal(page.byId('linkSelfUrl').value, 'http://100.64.0.9:3456', 'the untouched prefill follows at once');
    page.byId('ownKeyShow').fire('click');
    await page.answerTo('/teamclaude/peer-links/key', 200, { ok: true, key: 'tc-hub' });
    const link = page.findLast(e => String(e.value).startsWith('teamrouter://link?'));
    assert.deepEqual(parseInstanceLink(link.value), { url: 'http://100.64.0.9:3456', apiKey: 'tc-hub' });
    assert.ok(page.requests.some(r => r.url === '/teamclaude/status'), 'the status read is still pending');
  }, { origin: 'http://localhost:3456', storedKey: 'tc-operator' });
});

test('an address set by a reload or another browser reaches the link without a page reload', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR, instance: { name: 'hub', host: 'hub', custom: false, address: '' } });
    await page.answer(200, { self: { ...SELF, address: '', addresses: ['http://172.30.0.2:3456'] }, peers: [] });
    page.byId('ownKeyShow').fire('click');
    await page.answer(200, { ok: true, key: 'tc-hub' });
    assert.equal(page.byId('ownKeyBox').style.display, '');

    page.poll();
    await page.answerTo('/teamclaude/status', 200, { accounts: [], peers: [], caller: OPERATOR, instance: { name: 'hub', host: 'hub', custom: false, address: 'http://100.64.0.9:3456' } });
    assert.equal(page.byId('addrVal').value, 'http://100.64.0.9:3456');
    assert.equal(page.byId('ownKeyBox').style.display, 'none', 'the link shown with the container address is closed');
    assert.equal(page.byId('linkSelfUrl').value, 'http://100.64.0.9:3456');
    page.byId('ownKeyShow').fire('click');
    await page.answerTo('/teamclaude/peer-links/key', 200, { ok: true, key: 'tc-hub' });
    const link = page.findLast(e => String(e.value).startsWith('teamrouter://link?'));
    assert.deepEqual(parseInstanceLink(link.value), { url: 'http://100.64.0.9:3456', apiKey: 'tc-hub' });
  }, { origin: 'http://localhost:3456', storedKey: 'tc-operator' });
});

test('a status asked before a save cannot put the old address back', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR, instance: { name: 'hub', host: 'hub', custom: false, address: '' } });
    await page.answer(200, { self: { ...SELF, address: '', addresses: ['http://172.30.0.2:3456'] }, peers: [] });
    page.poll();
    page.byId('addrVal').value = '100.64.0.9:3456';
    page.byId('addrSet').fire('click');
    await page.answerTo('/teamclaude/instance-address', 200, { ok: true, address: 'http://100.64.0.9:3456' });
    // The poll asked before the save answers after it, with the old address.
    await page.answerTo('/teamclaude/status', 200, { accounts: [], peers: [], caller: OPERATOR, instance: { name: 'hub', host: 'hub', custom: false, address: '' } });
    assert.equal(page.byId('addrVal').value, 'http://100.64.0.9:3456');
    assert.equal(page.byId('linkSelfUrl').value, 'http://100.64.0.9:3456');
    page.byId('ownKeyShow').fire('click');
    await page.answerTo('/teamclaude/peer-links/key', 200, { ok: true, key: 'tc-hub' });
    const link = page.findLast(e => String(e.value).startsWith('teamrouter://link?'));
    assert.deepEqual(parseInstanceLink(link.value), { url: 'http://100.64.0.9:3456', apiKey: 'tc-hub' });
  }, { origin: 'http://localhost:3456', storedKey: 'tc-operator' });
});

test('a /peer-links read asked before a save is asked again rather than used', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR, instance: { name: 'hub', host: 'hub', custom: false, address: '' } });
    assert.equal(page.requests[0].url, '/teamclaude/peer-links');
    page.byId('addrVal').value = '100.64.0.9:3456';
    page.byId('addrSet').fire('click');
    await page.answerTo('/teamclaude/instance-address', 200, { ok: true, address: 'http://100.64.0.9:3456' });
    await page.answerTo('/teamclaude/peer-links', 200, { self: { ...SELF, address: '', addresses: ['http://172.30.0.2:3456'] }, peers: [] });
    assert.notEqual(page.byId('linkSelfUrl').value, 'http://172.30.0.2:3456', 'the old read is not used');
    assert.ok(page.requests.some(r => r.url === '/teamclaude/peer-links'), 'it is asked again');
    await page.answerTo('/teamclaude/peer-links', 200, { self: { ...SELF, address: 'http://100.64.0.9:3456', addresses: ['http://100.64.0.9:3456', 'http://172.30.0.2:3456'] }, peers: [] });
    assert.equal(page.byId('linkSelfUrl').value, 'http://100.64.0.9:3456');
  }, { origin: 'http://localhost:3456', storedKey: 'tc-operator' });
});

test('a re-render from the status held before a save cannot put the old address back', async () => {
  await onSettings(async (page) => {
    const peers = [{ name: 'desk', url: 'http://100.64.0.2:3456', state: 'online' }];
    await page.answer(200, { accounts: [], peers, caller: OPERATOR, instance: { name: 'hub', host: 'hub', custom: false, address: '' } });
    await page.answer(200, { self: { ...SELF, address: '', addresses: ['http://172.30.0.2:3456'] }, peers });
    page.byId('addrVal').value = '100.64.0.9:3456';
    page.byId('addrSet').fire('click');
    await page.answerTo('/teamclaude/instance-address', 200, { ok: true, address: 'http://100.64.0.9:3456' });
    // The reads that follow the save stay unanswered; arming Remove re-renders
    // from the status the page already holds, which still has no address.
    page.click('Remove');
    assert.equal(page.byId('linkSelfUrl').value, 'http://100.64.0.9:3456');
    page.byId('ownKeyShow').fire('click');
    await page.answerTo('/teamclaude/peer-links/key', 200, { ok: true, key: 'tc-hub' });
    const link = page.findLast(e => String(e.value).startsWith('teamrouter://link?'));
    assert.deepEqual(parseInstanceLink(link.value), { url: 'http://100.64.0.9:3456', apiKey: 'tc-hub' });
  }, { origin: 'http://localhost:3456', storedKey: 'tc-operator' });
});

test('an address cleared elsewhere that was also the only guess is read back from the server', async () => {
  await onSettings(async (page) => {
    const set = { name: 'hub', host: 'hub', custom: false, address: 'http://172.30.0.2:3456' };
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR, instance: set });
    await page.answer(200, { self: { ...SELF, address: 'http://172.30.0.2:3456', addresses: ['http://172.30.0.2:3456'] }, peers: [] });
    page.poll();
    await page.answerTo('/teamclaude/status', 200, { accounts: [], peers: [], caller: OPERATOR, instance: { ...set, address: '' } });
    assert.ok(page.requests.some(r => r.url === '/teamclaude/peer-links'), 'the guesses are asked for again');
    await page.answerTo('/teamclaude/peer-links', 200, { self: { ...SELF, address: '', addresses: ['http://172.30.0.2:3456'] }, peers: [] });
    page.byId('ownKeyShow').fire('click');
    await page.answerTo('/teamclaude/peer-links/key', 200, { ok: true, key: 'tc-hub' });
    const link = page.findLast(e => String(e.value).startsWith('teamrouter://link?'));
    assert.ok(link, 'Show key still offers a link');
    assert.deepEqual(parseInstanceLink(link.value), { url: 'http://172.30.0.2:3456', apiKey: 'tc-hub' });
  }, { origin: 'http://localhost:3456', storedKey: 'tc-operator' });
});

test('a proxy too old to say its address has no Instance address row', async () => {
  const page = bootPage();
  await page.answer(200, { accounts: [], instance: { name: 'hub', host: 'hub', custom: false } });
  assert.equal(page.byId('addrRow').style.display, 'none');
});

test('selfInstanceLabel falls back to This machine', () => {
  assert.equal(selfInstanceLabel({ name: 'hermes' }), 'hermes');
  assert.equal(selfInstanceLabel(undefined), 'This machine');
  assert.equal(selfInstanceLabel({ name: '' }), 'This machine');
});

// ── Account sync (callback.net) ─────────────────────────────

test('accountSyncRequest: the GET carries the key, a step POSTs its body', () => {
  assert.deepEqual(accountSyncRequest('view', null, 'k'), { url: '/teamclaude/account-sync', init: { headers: { 'x-api-key': 'k' } } });
  const r = accountSyncRequest('status', { id: 'abc' }, null);
  assert.equal(r.url, '/teamclaude/account-sync/status');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], '');
  assert.equal(r.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(r.init.body), { id: 'abc' });
});

test('accountSyncUser names the user by name and email, or whichever there is', () => {
  assert.equal(accountSyncUser({ user: { name: 'Me', email: 'me@example.com' } }), 'Me (me@example.com)');
  assert.equal(accountSyncUser({ user: { name: 'me@example.com', email: 'me@example.com' } }), 'me@example.com');
  assert.equal(accountSyncUser({ user: { name: null, email: 'me@example.com' } }), 'me@example.com');
  assert.equal(accountSyncUser({ user: null }), null);
});

test('accountSyncLine says off, on, failing, or waiting on a sign-in', () => {
  assert.deepEqual(accountSyncLine({ ok: true, signedIn: false }, 'this machine'), { kind: '', text: 'Off: this machine keeps its own sign-ins.' });
  const user = { email: 'me@example.com', name: null };
  assert.deepEqual(accountSyncLine({ ok: true, signedIn: true, user, sync: { lastSyncAt: null } }, 'x'),
    { kind: 'ok', text: 'On, as me@example.com. The first sync is under way.' });
  assert.deepEqual(accountSyncLine({ ok: true, signedIn: true, user, sync: { lastSyncAt: 1, rows: 1 } }, 'x'),
    { kind: 'ok', text: 'On, as me@example.com. 1 account in the store.' });
  assert.deepEqual(accountSyncLine({ ok: true, signedIn: true, user, sync: { lastSyncAt: 1, rows: 3, signInNeeded: 2 } }, 'x'),
    { kind: 'warn', text: 'On, as me@example.com. 3 accounts in the store. 2 need a sign-in on one of your machines.' });
  assert.equal(accountSyncLine({ ok: true, signedIn: true, user, sync: { lastSyncAt: 1, lastError: 'fetch failed' } }, 'x').kind, 'error');
  assert.match(accountSyncLine({ ok: true, signedIn: true, user: null, userError: 'the session has expired', sync: {} }, 'x').text, /did not say who/);
  assert.deepEqual(accountSyncLine({ ok: false, error: 'status 500' }, 'x'), { kind: 'error', text: 'could not read account sync: status 500' });
});

test('peerSyncCell offers Set up only where sync is off, and flags another callback.net account', () => {
  const own = { ok: true, signedIn: true, user: { email: 'me@example.com', name: null } };
  assert.deepEqual(peerSyncCell(null, 0, own), { kind: '', text: '…', setUp: false });
  assert.deepEqual(peerSyncCell({ ok: false }, 404, own), { kind: 'warn', text: 'needs an update', setUp: false });
  assert.deepEqual(peerSyncCell({ ok: false }, 502, own), { kind: 'error', text: 'unknown', setUp: false });
  assert.deepEqual(peerSyncCell({ ok: true, signedIn: false }, 200, own), { kind: '', text: 'off', setUp: true });
  assert.deepEqual(peerSyncCell({ ok: true, signedIn: true, user: { email: 'me@example.com', name: null } }, 200, own),
    { kind: 'ok', text: 'on, as me@example.com', setUp: false });
  const other = peerSyncCell({ ok: true, signedIn: true, user: { email: 'someone@example.com', name: null } }, 200, own);
  assert.equal(other.kind, 'warn');
  assert.match(other.text, /another callback\.net account, so it shares nothing/);
  assert.match(peerSyncCell({ ok: true, signedIn: true, user: null }, 200, { ok: true, signedIn: false }).text, /this machine is off/);
});

test('accountSyncApprovalHref opens https, or http to this machine, and nothing else', () => {
  assert.equal(accountSyncApprovalHref('https://oid.jp/ABC'), 'https://oid.jp/ABC');
  assert.equal(accountSyncApprovalHref('http://127.0.0.1:8080/_rest/OAuth2:auth?x=1'), 'http://127.0.0.1:8080/_rest/OAuth2:auth?x=1');
  for (const bad of ['javascript:alert(1)', 'http://example.com/a', 'https://a b', 'data:text/html,x', '', null, 42]) {
    assert.equal(accountSyncApprovalHref(bad), null, String(bad));
  }
});

test('accountSyncSignInOutcome maps each state, and a failed read keeps polling', () => {
  assert.equal(accountSyncSignInOutcome({ ok: true, state: 'waiting' }).done, false);
  assert.deepEqual(accountSyncSignInOutcome({ ok: true, state: 'succeeded' }), { done: true, kind: 'ok', text: 'Signed in. Account sync is on, and the first sync is running.' });
  assert.deepEqual(accountSyncSignInOutcome({ ok: true, state: 'failed', error: 'denied' }), { done: true, kind: 'error', text: 'The sign-in failed: denied' });
  assert.equal(accountSyncSignInOutcome({ ok: true, state: 'cancelled' }).done, true);
  assert.equal(accountSyncSignInOutcome({ ok: true, state: 'unknown' }).kind, 'warn');
  const lost = accountSyncSignInOutcome({ ok: false, error: 'server is unreachable' });
  assert.equal(lost.done, false);
  assert.match(lost.text, /Still trying/);
});

test('accountSyncOutcome reports what a pass changed, and how a sign-out went', () => {
  assert.deepEqual(accountSyncOutcome({ ok: true, result: { signedIn: true } }, 'sync'), { kind: 'ok', text: 'Synced: everything already matched.' });
  assert.deepEqual(accountSyncOutcome({ ok: true, result: { signedIn: true, added: 2, adopted: 1, pushed: 1, created: 1, evicted: 1 } }, 'sync'),
    { kind: 'ok', text: 'Synced: added 2 accounts from your other machines, took 1 newer sign-in, shared 2 sign-ins, removed 1 account removed on another machine.' });
  assert.equal(accountSyncOutcome({ ok: true, result: { signedIn: false } }, 'sync').kind, 'warn');
  assert.deepEqual(accountSyncOutcome({ ok: false, error: 'callback.net: HTTP 503' }, 'sync'), { kind: 'error', text: 'could not sync: callback.net: HTTP 503' });
  assert.match(accountSyncOutcome({ ok: true, wasSignedIn: true, revoked: true }, 'sign-out').text, /^Signed out\. Account sync is off/);
  assert.match(accountSyncOutcome({ ok: true, wasSignedIn: true, revoked: false }, 'sign-out').text, /could not be told/);
});

test('the Settings page carries the Account sync card', () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes('id="acctSync"'));
  assert.ok(html.includes('var ACCOUNT_SYNC_FAILED = '), 'the failure prefixes ride along');
  assert.ok(html.includes("callerCan(s.caller, '/teamclaude/account-sync/start')"), 'hidden from a caller refused the sign-in');
});

// The Account sync card on the page itself: what it reads, what each button
// sends, and that a link it was handed is opened only if it is one.

const SIGNED_OUT = { ok: true, signedIn: false, user: null, userError: null, sync: {}, signIn: null };
const SIGNED_IN = { ok: true, signedIn: true, user: { email: 'me@example.com', name: null }, userError: null, sync: { lastSyncAt: 1, rows: 2 }, signIn: null };
const shown = (page, re) => page.built.some(e => typeof e.textContent === 'string' && re.test(e.textContent));

test('Account sync: Turn on shows the approval link and finishes by itself', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    assert.equal(page.byId('acctSync').style.display, '');
    await page.answerTo('/teamclaude/peer-links', 200, { self: SELF, peers: [] });
    await page.answerTo('/teamclaude/account-sync', 200, SIGNED_OUT);
    assert.ok(shown(page, /^Off: this machine keeps its own sign-ins\.$/));
    page.click('Turn on account sync');
    const start = page.requests.find(r => r.url === '/teamclaude/account-sync/start');
    assert.equal(start.init.method, 'POST');
    await page.answerTo('/teamclaude/account-sync/start', 200, { ok: true, id: 's1', url: 'https://oid.jp/ABC', lifetimeSeconds: 900 });
    const open = page.findLast(e => e.textContent === 'Open callback.net');
    assert.equal(open.href, 'https://oid.jp/ABC');
    assert.equal(open.rel, 'noopener noreferrer');
    assert.ok(shown(page, /^Waiting for the approval at callback\.net/));

    page.runTimers();
    const st = page.requests.find(r => r.url === '/teamclaude/account-sync/status');
    assert.deepEqual(JSON.parse(st.init.body), { id: 's1' });
    await page.answerTo('/teamclaude/account-sync/status', 200, { ok: true, state: 'succeeded', error: null });
    assert.ok(shown(page, /^Signed in\. Account sync is on/));
    assert.ok(page.requests.some(r => r.url === '/teamclaude/account-sync' && !r.init.method), 'the card is read again');
  }, { autoAnswer: null, manualTimers: true });
});

test('Account sync: a link that is not one to open is refused and the sign-in cancelled', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answerTo('/teamclaude/peer-links', 200, { self: SELF, peers: [] });
    await page.answerTo('/teamclaude/account-sync', 200, SIGNED_OUT);
    page.click('Turn on account sync');
    await page.answerTo('/teamclaude/account-sync/start', 200, { ok: true, id: 's1', url: 'javascript:alert(1)' });
    assert.equal(page.findLast(e => e.textContent === 'Open callback.net'), undefined);
    assert.ok(shown(page, /^could not start the sign-in: the link it answered with is not one this page opens$/));
    const cancel = page.requests.find(r => r.url === '/teamclaude/account-sync/cancel');
    assert.deepEqual(JSON.parse(cancel.init.body), { id: 's1' });
  }, { autoAnswer: null, manualTimers: true });
});

test('Account sync: a linked instance that is off is set up from this page, through the relay', async () => {
  const peers = [{ name: 'desk', url: 'http://100.64.0.2:3456', state: 'online' }];
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers, caller: OPERATOR });
    await page.answerTo('/teamclaude/peer-links', 200, { self: SELF, peers });
    await page.answerTo('/teamclaude/account-sync', 200, SIGNED_IN);
    await page.answerTo('/teamclaude/peers/desk/account-sync', 200, SIGNED_OUT);
    assert.ok(shown(page, /^off$/), 'the row says sync is off there');
    page.click('Set up');
    assert.ok(page.requests.some(r => r.url === '/teamclaude/peers/desk/account-sync/start' && r.init.method === 'POST'));
    await page.answerTo('/teamclaude/peers/desk/account-sync/start', 200, { ok: true, id: 'p1', url: 'https://oid.jp/DESK' });
    assert.ok(shown(page, /^Turn on account sync for desk$/));
    assert.equal(page.findLast(e => e.textContent === 'Open callback.net').href, 'https://oid.jp/DESK');
    page.runTimers();
    assert.ok(page.requests.some(r => r.url === '/teamclaude/peers/desk/account-sync/status'), 'its status is asked of it too');
  }, { autoAnswer: null, manualTimers: true });
});

test('Account sync: Sign out is armed by a first click and sent by the second', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answerTo('/teamclaude/peer-links', 200, { self: SELF, peers: [] });
    await page.answerTo('/teamclaude/account-sync', 200, SIGNED_IN);
    assert.ok(shown(page, /^On, as me@example\.com\. 2 accounts in the store\.$/));
    page.click('Sign out');
    assert.equal(page.requests.length, 0);
    const realNow = Date.now;
    Date.now = () => realNow() + 1000;
    try { page.click('Confirm sign out'); } finally { Date.now = realNow; }
    assert.equal(page.requests[0].url, '/teamclaude/account-sync/sign-out');
    await page.answerTo('/teamclaude/account-sync/sign-out', 200, { ok: true, wasSignedIn: true, revoked: true });
    assert.ok(shown(page, /^Signed out\. Account sync is off/));
  }, { autoAnswer: null, manualTimers: true });
});

test('Account sync: hidden from a client key, and asks nothing', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], caller: { kind: 'client', client: 'laptop', refused: ['/teamclaude/peer-links/add', '/teamclaude/account-sync/start'] } });
    assert.equal(page.byId('acctSync').style.display, 'none');
    assert.equal(page.requests.length, 0);
  }, { storedKey: 'tc-client', autoAnswer: null });
});

test('accountSyncCancelOutcome is quiet when the sign-in stopped, and says when it could not be stopped', () => {
  assert.equal(accountSyncCancelOutcome({ ok: true, cancelled: true, state: 'cancelled' }, 'desk'), null);
  assert.equal(accountSyncCancelOutcome({ ok: true, cancelled: false, state: 'failed' }, 'desk'), null, 'it had ended by itself');
  assert.equal(accountSyncCancelOutcome({ ok: true, cancelled: false, state: 'unknown' }, 'desk'), null);
  const through = accountSyncCancelOutcome({ ok: true, cancelled: false, state: 'finishing' }, 'desk');
  assert.equal(through.kind, 'warn');
  assert.match(through.text, /on desk had already been approved, so it went through\. Sign out there/);
  assert.equal(accountSyncCancelOutcome({ ok: true, cancelled: false, state: 'succeeded' }, 'desk').kind, 'warn');
  const lost = accountSyncCancelOutcome({ ok: false, error: 'desk is unreachable' }, 'desk');
  assert.equal(lost.kind, 'error');
  assert.match(lost.text, /^could not cancel the sign-in on desk: desk is unreachable\. If its link is approved, it still signs in\.$/);
  assert.equal(accountSyncSignInOutcome({ ok: true, state: 'finishing' }).done, false, 'an approved sign-in is still polled');
});

test('Account sync: Cancel before the link arrives cancels it once the server names it', async () => {
  const peers = [{ name: 'desk', url: 'http://100.64.0.2:3456', state: 'online' }];
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers, caller: OPERATOR });
    await page.answerTo('/teamclaude/peer-links', 200, { self: SELF, peers });
    await page.answerTo('/teamclaude/account-sync', 200, SIGNED_IN);
    await page.answerTo('/teamclaude/peers/desk/account-sync', 200, SIGNED_OUT);
    page.click('Set up');
    page.click('Cancel');
    assert.ok(!page.requests.some(r => r.url.endsWith('/cancel')), 'no id to cancel yet');
    await page.answerTo('/teamclaude/peers/desk/account-sync/start', 200, { ok: true, id: 'late', url: 'https://oid.jp/DESK' });
    const cancel = page.requests.find(r => r.url === '/teamclaude/peers/desk/account-sync/cancel');
    assert.ok(cancel, 'the late sign-in is cancelled');
    assert.deepEqual(JSON.parse(cancel.init.body), { id: 'late' });
    assert.equal(page.findLast(e => e.textContent === 'Open callback.net'), undefined, 'its link is never shown');
    await page.answerTo('/teamclaude/peers/desk/account-sync/cancel', 200, { ok: true, cancelled: true, state: 'cancelled' });
  }, { autoAnswer: null, manualTimers: true });
});

test('Account sync: Keep them on this machine is sent while a callback.net sign-in is still waiting', async () => {
  const waiting = {
    ok: true, signedIn: false, user: null, userError: null, sync: {},
    signIn: { id: 'stuck', state: 'waiting' },
    instance: { mode: 'off', peer: null, peers: ['hub'], canHost: true, supported: true },
  };
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answerTo('/teamclaude/peer-links', 200, { self: SELF, peers: [] });
    await page.answerTo('/teamclaude/account-sync', 200, waiting);
    assert.ok(shown(page, /^Off: this machine keeps its own sign-ins\.$/));
    page.click('Keep them on this machine');
    const mode = page.requests.find(r => r.url === '/teamclaude/account-sync/mode');
    assert.ok(mode, 'local sharing is sent without a cancel first');
    assert.equal(page.requests.some(r => String(r.url).endsWith('/cancel')), false);
    assert.deepEqual(JSON.parse(mode.init.body), { mode: 'host' });
    await page.answerTo('/teamclaude/account-sync/mode', 200, { ok: true, mode: 'host', peer: null });
    assert.ok(shown(page, /^On: this machine keeps the accounts\./));
  }, { autoAnswer: null, manualTimers: true });
});

test('Account sync: while one sign-in is open, no other can be started', async () => {
  const peers = [{ name: 'desk', url: 'http://100.64.0.2:3456', state: 'online' }];
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers, caller: OPERATOR });
    await page.answerTo('/teamclaude/peer-links', 200, { self: SELF, peers });
    await page.answerTo('/teamclaude/account-sync', 200, SIGNED_OUT);
    await page.answerTo('/teamclaude/peers/desk/account-sync', 200, SIGNED_OUT);
    page.click('Turn on account sync');
    await page.answerTo('/teamclaude/account-sync/start', 200, { ok: true, id: 's1', url: 'https://oid.jp/ABC' });
    assert.equal(page.labelled('Set up'), 0, 'the linked instance offers no second sign-in');
    assert.equal(page.labelled('Turn on account sync'), 0);
    page.poll();
    await page.answerTo('/teamclaude/status', 200, { accounts: [], peers, caller: OPERATOR });
    assert.equal(page.labelled('Set up'), 0, 'nor after a poll');
  }, { autoAnswer: null, manualTimers: true });
});

test('Account sync: a cancel that does not take is reported', async () => {
  await onSettings(async (page) => {
    await page.answer(200, { accounts: [], peers: [], caller: OPERATOR });
    await page.answerTo('/teamclaude/peer-links', 200, { self: SELF, peers: [] });
    await page.answerTo('/teamclaude/account-sync', 200, SIGNED_OUT);
    page.click('Turn on account sync');
    await page.answerTo('/teamclaude/account-sync/start', 200, { ok: true, id: 's1', url: 'https://oid.jp/ABC' });
    page.click('Cancel');
    await page.answerTo('/teamclaude/account-sync/cancel', 200, { ok: true, cancelled: false, state: 'finishing' });
    assert.ok(shown(page, /^The sign-in on this machine had already been approved, so it went through\./));
  }, { autoAnswer: null, manualTimers: true });
});
