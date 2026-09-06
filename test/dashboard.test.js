import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  renderDashboardHtml, scopedWeeklyRows, accountTokens,
  sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, routeRows, problems, STUCK_MIN_REQUESTS,
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

// The shape /teamclaude/status reports per route: the server's own target for
// the family, and every account with whether it could serve it.
const ROUTED = {
  currentAccount: 'a',
  routes: [{
    name: 'fable', match: ['*fable*'], autocreated: true, pinned: null, target: 'b',
    accounts: [{ name: 'a', eligible: false }, { name: 'b', eligible: true }, { name: 'c', eligible: true }],
  }],
};

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

// A session whose requests never come back with a usage report reads as zero on
// every token column, exactly like an idle one. That is the case the banner exists
// for, so the tests are about telling those two apart.
const NOW = 1_000_000_000;
const OLD = NOW - 10 * 60_000;

function withSession(extra) {
  return {
    currentAccount: 'a', defaultTarget: 'a', accounts: [{ name: 'a', unavailable: null, quota: {} }],
    routes: [{ name: 'fable', match: ['*fable*'], accounts: [{ name: 'a', eligible: true }], target: 'a' }],
    sessions: { items: [Object.assign({ id: 'deadbeef1234', client: 'alice', firstSeen: OLD, requests: 0, pins: {}, tokens: {} }, extra)] },
  };
}

test('a session that gets nothing back is reported; an idle one is not', () => {
  const stuck = problems(withSession({ requests: 20, tokens: { unified7d: { reports: 0 } } }), NOW);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].kind, 'stuck-session');
  assert.equal(stuck[0].severity, 'bad');
  assert.match(stuck[0].text, /alice's session deadbeef/);
  assert.match(stuck[0].text, /20 requests/);

  // Same zero token columns, but upstream answered: idle, not stuck.
  assert.deepEqual(problems(withSession({ requests: 20, tokens: { unified7d: { reports: 20 } } }), NOW), []);
  // Nothing sent yet at all.
  assert.deepEqual(problems(withSession({ requests: 0, tokens: {} }), NOW), []);
});

test('a young or barely-used session is not accused', () => {
  // Below the request floor.
  assert.deepEqual(problems(withSession({ requests: STUCK_MIN_REQUESTS - 1, tokens: { unified7d: { reports: 0 } } }), NOW), []);
  // Old enough by requests, but only seconds old: its first report has not landed.
  assert.deepEqual(problems(withSession({ requests: 20, firstSeen: NOW - 1000, tokens: { unified7d: { reports: 0 } } }), NOW), []);
});

test('a wedged fleet and accounts that need a human are reported; ordinary rotation is not', () => {
  const base = withSession({ requests: 1, tokens: { unified7d: { reports: 1 } } });

  // Nothing can serve an unrouted request.
  const wedged = problems({ ...base, defaultTarget: null }, NOW);
  assert.deepEqual(wedged.map(p => p.kind), ['no-target']);

  // A spent bucket or a back-off is the policy working — silence.
  for (const reason of ['quota', 'throttled']) {
    assert.deepEqual(problems({ ...base, accounts: [{ name: 'a', unavailable: reason, quota: {} }] }, NOW), []);
  }
  // A broken token needs a person.
  const broken = problems({ ...base, accounts: [{ name: 'a', unavailable: 'error', quota: {} }] }, NOW);
  assert.deepEqual(broken.map(p => p.kind), ['account']);
  assert.match(broken[0].text, /re-login/);

  // Real money is not a quota bar.
  const billing = problems({ ...base, accounts: [{ name: 'a', unavailable: null, quota: { spend: { enabled: true, usedMinor: 250 } } }] }, NOW);
  assert.deepEqual(billing.map(p => p.kind), ['spend']);
  // Able to bill but hasn't: nothing to say yet.
  assert.deepEqual(problems({ ...base, accounts: [{ name: 'a', unavailable: null, quota: { spend: { enabled: true, usedMinor: 0 } } }] }, NOW), []);
});

test('a healthy fleet reports nothing at all', () => {
  assert.deepEqual(problems(withSession({ requests: 30, tokens: { unified7d: { reports: 30 } } }), NOW), []);
  assert.deepEqual(problems({}, NOW), []);
  assert.deepEqual(problems(null, NOW), []);
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
    assert.match(await page.text(), /TeamClaude/);

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
