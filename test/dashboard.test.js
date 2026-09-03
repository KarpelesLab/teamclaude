import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { renderDashboardHtml, scopedWeeklyRows, accountTokens } from '../src/dashboard.js';

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

test('the page ships the same helper implementations it is tested against', () => {
  // The serialization is the contract: if a helper stops being self-contained
  // (closes over module scope), the page would silently ReferenceError.
  const html = renderDashboardHtml();
  for (const fn of [scopedWeeklyRows, accountTokens]) {
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
