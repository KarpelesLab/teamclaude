import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  renderDashboardHtml, scopedWeeklyRows, accountTokens,
  sessionRows, filterSessionRows, sortRows, uniqSorted,
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

test('the page ships the same helper implementations it is tested against', () => {
  // The serialization is the contract: if a helper stops being self-contained
  // (closes over module scope), the page would silently ReferenceError.
  const html = renderDashboardHtml();
  for (const fn of [scopedWeeklyRows, accountTokens, sessionRows, filterSessionRows, sortRows, uniqSorted]) {
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
