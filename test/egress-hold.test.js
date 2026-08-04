import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyRequestListener } from '../src/server.js';
import { EgressGuard } from '../src/egress-guard.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Counts what actually reached upstream — the point of the guard is that a
// request made from the wrong address never gets there.
function countingUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen };
}

function probeReturning(ips) {
  let i = 0;
  return async () => {
    const ip = Array.isArray(ips) ? ips[Math.min(i, ips.length - 1)] : ips;
    i++;
    return { text: async () => ip };
  };
}

async function post(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  return { status: res.status, body: await res.text() };
}

async function proxyWith(guard, upstreamPort) {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const listener = createProxyRequestListener({
    accountManager: am, upstream: `http://127.0.0.1:${upstreamPort}`, egress: guard,
  });
  const proxy = http.createServer(listener);
  return { proxy, port: await listen(proxy) };
}

test('with the egress pinned and matching, requests pass through untouched', async () => {
  const { server: upstream, seen } = countingUpstream();
  const upstreamPort = await listen(upstream);
  const guard = new EgressGuard({ pin: '203.0.113.7', fetchImpl: probeReturning('203.0.113.7') });
  const { proxy, port } = await proxyWith(guard, upstreamPort);

  try {
    assert.equal((await post(port)).status, 200);
    assert.equal(seen.length, 1);
  } finally {
    proxy.close();
    upstream.close();
  }
});

// The core guarantee: a VPN that dropped must not leak the account onto the
// machine's own address. Upstream must see nothing at all.
test('an unpinned egress holds the request and never reaches upstream', async () => {
  const { server: upstream, seen } = countingUpstream();
  const upstreamPort = await listen(upstream);
  const guard = new EgressGuard({
    pin: '203.0.113.7', ttlMs: 0, holdMs: 40, pollMs: 5,
    fetchImpl: probeReturning('192.0.2.55'),          // VPN down: home address
  });
  const { proxy, port } = await proxyWith(guard, upstreamPort);

  try {
    const { status, body } = await post(port);
    assert.equal(status, 503);                        // not a 403 — nothing was asked upstream
    assert.match(body, /192\.0\.2\.55/);              // says what it saw
    assert.match(body, /203\.0\.113\.7/);             // and what it expected
    assert.deepEqual(seen, []);                       // upstream never heard from us
  } finally {
    proxy.close();
    upstream.close();
  }
});

// A flap shorter than the hold budget should be invisible to the client beyond
// the delay: the request waits, then goes out from the right address.
test('a request held through a flap is sent once the pinned egress returns', async () => {
  const { server: upstream, seen } = countingUpstream();
  const upstreamPort = await listen(upstream);
  const guard = new EgressGuard({
    pin: '203.0.113.7', ttlMs: 0, holdMs: 5_000, pollMs: 5,
    fetchImpl: probeReturning(['192.0.2.55', '192.0.2.55', '203.0.113.7']),
  });
  const { proxy, port } = await proxyWith(guard, upstreamPort);

  try {
    assert.equal((await post(port)).status, 200);
    assert.equal(seen.length, 1);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('without a guard nothing changes', async () => {
  const { server: upstream, seen } = countingUpstream();
  const upstreamPort = await listen(upstream);
  const { proxy, port } = await proxyWith(null, upstreamPort);

  try {
    assert.equal((await post(port)).status, 200);
    assert.equal(seen.length, 1);
  } finally {
    proxy.close();
    upstream.close();
  }
});
