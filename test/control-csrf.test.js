import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, isSameOriginControlRequest } from '../src/server.js';

// The control plane exempts loopback from the proxy API key, which is what makes
// it usable from the CLI with no configuration. The cost is that a web page the
// operator happens to visit is also "loopback": a cross-origin
// fetch(..., {mode:'no-cors'}) with a text/plain body is a CORS simple request,
// so it is sent with no preflight and lands on the endpoint. The page cannot
// read the reply, but for a mutation that does not matter — forcing the fleet
// onto one named account is a targeted quota drain.
//
// Origin and Sec-Fetch-Site are set by the browser and cannot be forged from
// page JavaScript, so they are what separates a page from curl.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };
const ACCTS = [
  { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
  { name: 'bob@example.com', type: 'apikey', apiKey: 'k2' },
];

async function withServer(fn, hooks = {}) {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try {
    await fn(am, port);
  } finally {
    proxy.close();
  }
}

const switchTo = (port, account, headers = {}) =>
  fetch(`http://127.0.0.1:${port}/teamclaude/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ account }),
  });

test('a page cannot switch the account cross-origin', async () => {
  await withServer(async (am, port) => {
    assert.equal(am.currentIndex, 0);

    const res = await switchTo(port, 'bob@example.com', { Origin: 'https://evil.example' });

    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /cross-origin/);
    // The point of the test: refused means nothing moved, not merely that the
    // caller was told off after the fact.
    assert.equal(am.currentIndex, 0, 'a refused request must not have switched the account');
  });
});

test('Sec-Fetch-Site is honoured when the browser sends it', async () => {
  await withServer(async (am, port) => {
    const res = await switchTo(port, 'bob@example.com', { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(res.status, 403);
    assert.equal(am.currentIndex, 0);
  });
});

// reload is reachable by the identical route and predates the switch endpoint,
// so the guard has to cover it too or the hole is merely moved.
test('reload is refused cross-origin as well', async () => {
  let reloads = 0;
  await withServer(async (_am, port) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.equal(reloads, 0, 'a refused reload must not have run');
  }, { reload: async () => { reloads++; return 0; } });
});

// The guard is worthless if it also blocks the CLI. curl and teamclaude attach
// send neither header.
test('a request with no browser headers still works', async () => {
  await withServer(async (am, port) => {
    const res = await switchTo(port, 'bob@example.com');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(am.currentIndex, 1);
  });
});

test('a same-origin browser request is allowed through', async () => {
  await withServer(async (am, port) => {
    const res = await switchTo(port, 'bob@example.com', {
      'Sec-Fetch-Site': 'same-origin',
      Origin: `http://127.0.0.1:${port}`,
    });
    assert.equal(res.status, 200);
    assert.equal(am.currentIndex, 1);
  });
});

// Reading status cross-origin is already prevented by the same-origin policy —
// the page issues the request but cannot see the answer — so the guard is
// deliberately scoped to mutations and does not break anyone polling status.
test('the guard applies to mutations, not to reads', async () => {
  await withServer(async (_am, port) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 200);
  });
});

test('isSameOriginControlRequest: Sec-Fetch-Site wins, Origin is the fallback', () => {
  const req = (headers) => ({ headers });
  // Explicit browser signal.
  assert.equal(isSameOriginControlRequest(req({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(isSameOriginControlRequest(req({ 'sec-fetch-site': 'none' })), true);       // typed in the URL bar
  assert.equal(isSameOriginControlRequest(req({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isSameOriginControlRequest(req({ 'sec-fetch-site': 'same-site' })), false);
  // A browser that sends Sec-Fetch-Site is trusted over a stale Origin.
  assert.equal(isSameOriginControlRequest(req({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' })), true);
  // Fallback: any Origin on a control POST means a page issued it.
  assert.equal(isSameOriginControlRequest(req({ origin: 'https://evil.example' })), false);
  // curl and the CLI.
  assert.equal(isSameOriginControlRequest(req({})), true);
});
