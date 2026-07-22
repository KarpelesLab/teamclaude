import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function setup(eventLogging) {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  const shown = { start: [], end: [] };
  const hooks = {
    onRequestStart: (_id, info) => shown.start.push(info.path),
    onRequestEnd: (_id, info) => shown.end.push(info.path),
  };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, eventLogging }, hooks);
  const proxyPort = await listen(proxy);

  return {
    shown,
    get hits() { return upstreamHits; },
    post: (path) => fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"events":[]}',
    }),
    close() { proxy.close(); upstream.close(); },
  };
}

const EVENT_LOG = '/api/event_logging/v2/batch';

test("'block' answers 200 locally without forwarding or displaying", async () => {
  const t = await setup('block');
  try {
    const res = await t.post(EVENT_LOG);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 0, 'must not reach upstream');
    assert.deepEqual(t.shown.start, []);
    assert.deepEqual(t.shown.end, []);
  } finally { t.close(); }
});

test("'hide' forwards upstream but suppresses the activity entry", async () => {
  const t = await setup('hide');
  try {
    const res = await t.post(EVENT_LOG);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1, 'still forwarded');
    assert.deepEqual(t.shown.start, [], 'not displayed');
    assert.deepEqual(t.shown.end, []);
  } finally { t.close(); }
});

test("'show' forwards and displays", async () => {
  const t = await setup('show');
  try {
    const res = await t.post(EVENT_LOG);
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1);
    assert.deepEqual(t.shown.start, [EVENT_LOG]);
    assert.deepEqual(t.shown.end, [EVENT_LOG]);
  } finally { t.close(); }
});

test('non-telemetry requests are always forwarded and displayed, even in block mode', async () => {
  const t = await setup('block');
  try {
    const res = await t.post('/v1/messages');
    await res.text();
    assert.equal(t.hits, 1, 'normal request forwarded');
    assert.deepEqual(t.shown.start, ['/v1/messages']);
    assert.deepEqual(t.shown.end, ['/v1/messages']);
  } finally { t.close(); }
});
