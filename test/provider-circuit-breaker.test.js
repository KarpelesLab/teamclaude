import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function request(port, model = 'claude-sonnet-5') {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: res.status, body: await res.text() };
}

// A custom adapter is an independent failure domain. A 503 from it should not
// escape while another eligible account can serve the request; the adapter's
// circuit opens and selection skips it on the next request.
test('custom adapter 503 opens circuit and fails over before client headers', async () => {
  let badHits = 0;
  let goodHits = 0;
  const bad = http.createServer((_req, res) => {
    badHits++;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'adapter unavailable' }));
  });
  const good = http.createServer((_req, res) => {
    goodHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'ok', type: 'message', model: 'served-good' }));
  });
  const badPort = await listen(bad);
  const goodPort = await listen(good);

  const am = new AccountManager([
    { name: 'bad', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${badPort}`, priority: 0 },
    { name: 'good', type: 'apikey', apiKey: 'k2', upstream: `http://127.0.0.1:${goodPort}`, priority: 1 },
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const proxyPort = await listen(proxy);
  try {
    const first = await request(proxyPort);
    assert.equal(first.status, 200);
    assert.match(first.body, /served-good/);
    assert.equal(badHits, 1);
    assert.equal(goodHits, 1);
    assert.equal(am.accounts[0].consecutiveFailures, 1);
    assert.ok(am.accounts[0].circuitOpenUntil > Date.now());

    const second = await request(proxyPort);
    assert.equal(second.status, 200);
    assert.equal(badHits, 1, 'open circuit excludes bad adapter before selection');
    assert.equal(goodHits, 2);
  } finally {
    await close(proxy); await close(bad); await close(good);
  }
});

// ECONNREFUSED to a custom adapter is also account-specific. This is the minimum
// HA promise: one dead microservice does not take down the data plane or client.
test('custom adapter connection refusal fails over to a healthy provider', async () => {
  const unused = http.createServer();
  const deadPort = await listen(unused);
  await close(unused); // port is now guaranteed unused

  let goodHits = 0;
  const good = http.createServer((_req, res) => {
    goodHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'ok', type: 'message', model: 'served-good' }));
  });
  const goodPort = await listen(good);
  const am = new AccountManager([
    { name: 'dead', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${deadPort}`, priority: 0 },
    { name: 'good', type: 'apikey', apiKey: 'k2', upstream: `http://127.0.0.1:${goodPort}`, priority: 1 },
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const proxyPort = await listen(proxy);
  try {
    const out = await request(proxyPort);
    assert.equal(out.status, 200);
    assert.equal(goodHits, 1);
    assert.equal(am.accounts[0].consecutiveFailures, 1);
    assert.ok(am.accounts[0].circuitOpenUntil > Date.now());
  } finally {
    await close(proxy); await close(good);
  }
});

// An arbitrary provider 400 remains non-retryable. A circuit breaker must not
// hide a real request/model defect by spraying it across every provider.
test('custom adapter 400 is relayed and heals transport health; it never fails over', async () => {
  let badHits = 0;
  let goodHits = 0;
  const bad = http.createServer((_req, res) => {
    badHits++;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad model' }));
  });
  const good = http.createServer((_req, res) => {
    goodHits++;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  const badPort = await listen(bad);
  const goodPort = await listen(good);
  const am = new AccountManager([
    { name: 'bad', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${badPort}`, priority: 0 },
    { name: 'good', type: 'apikey', apiKey: 'k2', upstream: `http://127.0.0.1:${goodPort}`, priority: 1 },
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const proxyPort = await listen(proxy);
  try {
    const out = await request(proxyPort);
    assert.equal(out.status, 400);
    assert.equal(badHits, 1);
    assert.equal(goodHits, 0);
    assert.equal(am.accounts[0].consecutiveFailures, 0, 'reachable 400 is not provider-health failure');
    assert.ok(am.accounts[0].lastSuccessAt, 'transport path is healthy even though request is bad');
  } finally {
    await close(proxy); await close(bad); await close(good);
  }
});

// A custom-upstream 500 is provider failure, not health. Scoring it as ok resets
// consecutiveFailures and pins the advertised 2s→60s backoff at its 2s floor.
test('custom adapter 500 opens circuit and fails over (never scored as health)', async () => {
  let badHits = 0;
  let goodHits = 0;
  const bad = http.createServer((_req, res) => {
    badHits++;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal' }));
  });
  const good = http.createServer((_req, res) => {
    goodHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'ok', type: 'message', model: 'served-good' }));
  });
  const badPort = await listen(bad);
  const goodPort = await listen(good);
  const am = new AccountManager([
    { name: 'bad', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${badPort}`, priority: 0 },
    { name: 'good', type: 'apikey', apiKey: 'k2', upstream: `http://127.0.0.1:${goodPort}`, priority: 1 },
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const proxyPort = await listen(proxy);
  try {
    const out = await request(proxyPort);
    assert.equal(out.status, 200);
    assert.equal(badHits, 1);
    assert.equal(goodHits, 1);
    assert.equal(am.accounts[0].consecutiveFailures, 1, '500 must not reset the breaker');
    assert.ok(am.accounts[0].circuitOpenUntil > Date.now());
  } finally {
    await close(proxy); await close(bad); await close(good);
  }
});

test('consecutive custom-upstream 500s escalate openUntil toward the 60s cap', async () => {
  const bad = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"internal"}');
  });
  const badPort = await listen(bad);
  const am = new AccountManager([
    { name: 'solo', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${badPort}` },
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const proxyPort = await listen(proxy);
  const openMs = [];
  try {
    for (let i = 0; i < 7; i++) {
      // Allow the next trial: clear an open circuit as if its window elapsed.
      am.accounts[0].circuitOpenUntil = null;
      const before = Date.now();
      await request(proxyPort);
      const until = am.accounts[0].circuitOpenUntil;
      assert.ok(until > before, `failure #${i + 1} must open the circuit`);
      openMs.push(until - before);
      assert.equal(am.accounts[0].consecutiveFailures, i + 1);
    }
    // 2s, 4s, 8s, 16s, 32s, 60s, 60s — allow ±500ms clock skew on the wall measurement.
    const expected = [2000, 4000, 8000, 16000, 32000, 60000, 60000];
    for (let i = 0; i < expected.length; i++) {
      assert.ok(Math.abs(openMs[i] - expected[i]) < 800,
        `openMs[${i}]=${openMs[i]} want ~${expected[i]}`);
    }
    assert.ok(openMs[5] >= 50_000, 'backoff must leave the 2s floor and approach 60s');
  } finally {
    await close(proxy); await close(bad);
  }
});

test('noteProviderResult backoff formula hits the 60s cap and stays there', () => {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k', upstream: 'http://127.0.0.1:9' },
  ]);
  const opens = [];
  for (let i = 0; i < 8; i++) opens.push(am.noteProviderResult(0, { ok: false, status: 500 }));
  assert.deepEqual(opens, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test('failed route upstreams return temporary 503 with circuit retry, not fleet quota exhaustion', async () => {
  for (const disconnect of [false, true]) {
    const bad = http.createServer((req, res) => {
      if (disconnect) { req.socket.destroy(); return; }
      res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"unavailable"}');
    });
    const port = await listen(bad);
    const am = new AccountManager([
      { name: 'a', type: 'apikey', apiKey: 'test', upstream: `http://127.0.0.1:${port}` },
      { name: 'b', type: 'apikey', apiKey: 'test', upstream: `http://127.0.0.1:${port}` },
      { name: 'unrelated', type: 'apikey', apiKey: 'test' },
    ]);
    am.setRoutes([{ name: 'deepseek', match: ['deepseek-*'], accounts: ['a', 'b'] }]);
    am.accounts[2].quota.unified7d = 1;
    am.accounts[2].quota.unified7dReset = Date.now() + 604800000;
    const proxy = createProxyServer(am, { proxy: { apiKey: 'test' }, upstream: 'http://invalid' });
    const proxyPort = await listen(proxy);
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-pro', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(response.status, 503, `disconnect=${disconnect}`);
      assert.ok(Number(response.headers.get('retry-after')) >= 1);
      assert.ok(Number(response.headers.get('retry-after')) <= 2);
      const body = await response.json();
      assert.equal(body.error.type, 'api_error');
      assert.doesNotMatch(body.error.message, /quota|exhausted|3600/);
      assert.equal(am.accounts[0].consecutiveFailures, 1);
      assert.equal(am.accounts[1].consecutiveFailures, 1);
    } finally {
      proxy.closeAllConnections(); bad.closeAllConnections();
      await close(proxy); await close(bad);
    }
  }
});
