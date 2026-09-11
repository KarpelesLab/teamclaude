import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  renderDashboardHtml, dashboardCsp, scopedWeeklyRows, accountTokens,
  accountBadges,
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

test('provider badges use the Anthropic and Codex brand colors', () => {
  const html = renderDashboardHtml();
  assert.match(html, /--anthropic:\s*#d97757/);
  assert.match(html, /--codex:\s*#10a37f/);
  assert.match(html, /\.badge\.provider\.anthropic\s*\{[^}]*var\(--anthropic\)/);
  assert.match(html, /\.badge\.provider\.codex\s*\{[^}]*var\(--codex\)/);
});

const SESSIONS = {
  items: [
    {
      id: 's-old', client: 'bob', dimensions: { project: 'p2' }, active: false,
      requests: 2, lastSeen: 200, pins: { unified7d: 1 },
      tokens: { unified7d: { cacheRead: 5, cacheCreation: 1, input: 2, output: 1, context: 8 } },
    },
    {
      id: 's-new', client: 'alice', dimensions: { project: 'p1' }, active: true,
      requests: 1, lastSeen: 100, pins: { unified7d: 0, unified7dFable: 1 },
      tokens: {
        unified7d: { cacheRead: 900, cacheCreation: 50, input: 10, output: 5, context: 960 },
        unified7dFable: { cacheRead: 0, cacheCreation: 0, input: 4, output: 2, context: 4 },
      },
    },
  ],
};

test('a session row totals what the responses reported, cache included', () => {
  const rows = sessionRows(SESSIONS);
  const row = rows.find(r => r.id === 's-new');
  // input+output alone would say 21 for a session that actually cost 971.
  assert.equal(row.input + row.output, 21);
  assert.equal(row.total, 971);
  assert.equal(row.cacheRead, 900);
  // Summed across every weekly bucket the session touched.
  assert.equal(row.context, 964);
  // A session spending two model families is served by two accounts at once,
  // which is why this is a pin map and not one index.
  assert.equal(row.accounts, '0, 1');
  assert.equal(row.client, 'alice');
  assert.equal(row.project, 'p1');
});

test('session rows tolerate a payload with nothing in it', () => {
  assert.deepEqual(sessionRows({}), []);
  assert.deepEqual(sessionRows(null), []);
  const [bare] = sessionRows({ items: [{ id: 'x' }] });
  assert.deepEqual(
    { id: bare.id, client: bare.client, project: bare.project, total: bare.total, accounts: bare.accounts },
    { id: 'x', client: '', project: '', total: 0, accounts: '' },
  );
});

test('filters narrow by project and client, and combine', () => {
  const rows = sessionRows(SESSIONS);
  assert.deepEqual(filterSessionRows(rows, { project: 'p1' }).map(r => r.id), ['s-new']);
  assert.deepEqual(filterSessionRows(rows, { client: 'bob' }).map(r => r.id), ['s-old']);
  assert.deepEqual(filterSessionRows(rows, { project: 'p1', client: 'bob' }), []);
  // An empty filter is "All", not a match against the empty string.
  assert.equal(filterSessionRows(rows, { project: '', client: '' }).length, 2);
  assert.equal(filterSessionRows(rows, {}).length, 2);
});

test('sorting handles both text and number columns, and does not mutate', () => {
  const rows = sessionRows(SESSIONS);
  const before = rows.map(r => r.id);
  assert.deepEqual(sortRows(rows, 'total', 'desc').map(r => r.id), ['s-new', 's-old']);
  assert.deepEqual(sortRows(rows, 'total', 'asc').map(r => r.id), ['s-old', 's-new']);
  assert.deepEqual(sortRows(rows, 'client', 'asc').map(r => r.id), ['s-new', 's-old']);
  assert.deepEqual(sortRows(rows, 'client', 'desc').map(r => r.id), ['s-old', 's-new']);
  assert.deepEqual(rows.map(r => r.id), before, 'the caller\'s array is untouched');
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
/** Drive a session to `n` consecutive no-answer outcomes on a real tracker. */
function starve(am, id, n, client = 'alice') {
  for (let i = 0; i < n; i++) {
    am.beginSession(id, { client, dimensions: {} });
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
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return problems;`)();
  const payload = { sessions: { items: [{ id: 'deadbeef1234', client: 'alice', active: true, starved: 9, requests: 9, pins: {}, tokens: {} }] } };
  assert.deepEqual(isolated(payload), problems(payload), 'the page runs what the tests exercise');
});

test('the page ships the same helper implementations it is tested against', () => {
  // The serialization is the contract: if a helper stops being self-contained
  // (closes over module scope), the page would silently ReferenceError.
  const html = renderDashboardHtml();
  for (const fn of [scopedWeeklyRows, accountTokens, sessionRows, filterSessionRows, sortRows, uniqSorted, switchRequest, switchOutcome, routeRows, problems]) {
    assert.ok(html.includes(fn.toString()), `${fn.name} not serialized into the page`);
  }
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  assert.doesNotThrow(() => new Function(script), 'inline script must parse');
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

test('GET /teamclaude/dashboard serves HTML without a key; other methods take the normal path', async () => {
  const upstream = http.createServer((req, res) => {
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
    const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    assert.match(csp, new RegExp(`script-src 'sha256-${hash.replace(/[+/=]/g, '\\$&')}'`));
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

    // The asset route is GET + exact path only — a POST to the same path must
    // NOT hit the dashboard handler but flow down the normal (gated, then
    // proxied) pipeline like any other request. Loopback is key-exempt, so
    // over a real socket the observable is that it reaches the upstream.
    const post = await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard`, { method: 'POST' });
    assert.deepEqual(await post.json(), { upstream: true });
  } finally {
    proxy.close();
    upstream.close();
  }
});
