import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { renderDashboardHtml } from '../src/dashboard.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

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
