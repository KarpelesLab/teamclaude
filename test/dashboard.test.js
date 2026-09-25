import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  renderDashboardHtml, dashboardCsp, inlineScripts, scopedWeeklyRows, accountTokens,
  accountBadges, thresholdBadgeText,
  sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, routeRows, problems, STARVED_MIN, STARVED_LIST_MAX,
} from '../src/dashboard.js';

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

test('the page ships the same helper implementations it is tested against', () => {
  // The serialization is the contract: if a helper stops being self-contained
  // (closes over module scope), the page would silently ReferenceError.
  const html = renderDashboardHtml();
  for (const fn of [scopedWeeklyRows, accountTokens, thresholdBadgeText, accountBadges, sessionRows, filterSessionRows, sortRows, uniqSorted, switchRequest, switchOutcome, routeRows, problems]) {
    assert.ok(html.includes(fn.toString()), `${fn.name} not serialized into the page`);
  }
  // Both the head bootstrap and the main script must parse, not just the last.
  for (const script of inlineScripts(html)) {
    assert.doesNotThrow(() => new Function(script), 'inline script must parse');
  }
});

// Run the page's whole inline script against a stub DOM, a stub localStorage and
// a fetch the test answers by hand. Elements absorb any method call, so render()
// runs without a real DOM; only the style and text the startup path sets are read.
function bootPage({ storedKey = null, storedTheme = null } = {}) {
  const els = new Map();
  const stubEl = () => {
    // Listeners are recorded rather than absorbed, so a test can fire a click
    // the way the page registered it instead of reaching for an onclick the
    // page never sets.
    const listeners = new Map();
    const target = {
      style: {}, value: '', textContent: '', className: '', disabled: false,
      addEventListener: (type, fn) => listeners.set(type, fn),
    };
    const proxy = new Proxy(target, { get: (t, p) => (p in t ? t[p] : () => stubEl()) });
    // Fire with the proxy as `this`, the way the page sees the element, so a
    // handler that touches an unstubbed property gets the absorbing stub.
    target.fire = type => listeners.get(type)?.call(proxy);
    return proxy;
  };
  const byId = id => { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); };
  const store = new Map([
    ...(storedKey ? [['teamclaude-dashboard-key', storedKey]] : []),
    ...(storedTheme ? [['teamclaude-dashboard-theme', storedTheme]] : []),
  ]);
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const requests = [];
  const fetch = (url, init) => new Promise(resolve => requests.push({ url, init, resolve }));
  // documentElement is real enough to record the theme attribute, so a test can
  // assert what the page actually sets rather than that it merely did not throw.
  const rootAttrs = new Map();
  const documentElement = {
    setAttribute: (k, v) => rootAttrs.set(k, String(v)),
    removeAttribute: k => rootAttrs.delete(k),
    getAttribute: k => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
  };
  const document = { getElementById: byId, createElement: () => stubEl(), documentElement };
  const html = renderDashboardHtml();
  const script = inlineScripts(html).at(-1);
  new Function('document', 'localStorage', 'fetch', 'setInterval', 'clearInterval', script)(
    document, localStorage, fetch, () => 1, () => {});
  const answer = async (status, body = {}) => {
    requests.shift().resolve({ status, ok: status >= 200 && status < 300, json: async () => body });
    await new Promise(r => setImmediate(r));
  };
  return { byId, store, requests, answer, rootAttrs };
}

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
  assert.match(html, /fetch\('\/teamclaude\/status'/);
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
    assert.match(html, /TeamClaude/);

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
