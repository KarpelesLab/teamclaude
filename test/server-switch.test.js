import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// POST /teamclaude/switch is the headless equivalent of picking an account with
// 's' in the TUI: both only move the manager's currentIndex. The TUI is not
// reachable when the proxy runs as a background service, which is what this
// endpoint exists for.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const CONFIG = { proxy: { apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com' };
const ACCTS = [
  { name: 'alice@example.com', type: 'apikey', apiKey: 'k1', accountUuid: 'aaaaaaaa-0000-0000-0000-000000000001' },
  { name: 'bob@example.com (Acme)', type: 'apikey', apiKey: 'k2', accountUuid: 'bbbbbbbb-0000-0000-0000-000000000002' },
];

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return { status: res.status, body: await res.json() };
}

async function withServer(fn, hooks = {}) {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try {
    await fn(am, port, proxy);
  } finally {
    proxy.close();
  }
}

test('switch moves currentIndex and answers with the resolved account name', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: 'bob@example.com (Acme)' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.account, 'bob@example.com (Acme)');
    assert.equal(am.currentIndex, 1);
  });
});

test('switch accepts the same account forms as a pin (uuid, bare email)', async () => {
  await withServer(async (am, port) => {
    assert.equal((await post(port, JSON.stringify({ account: 'bbbbbbbb-0000-0000-0000-000000000002' }))).status, 200);
    assert.equal(am.currentIndex, 1);
    assert.equal((await post(port, JSON.stringify({ account: 'alice@example.com' }))).status, 200);
    assert.equal(am.currentIndex, 0);
  });
});

test('the status endpoint reports the switched account', async () => {
  await withServer(async (am, port) => {
    await post(port, JSON.stringify({ account: 'bob@example.com (Acme)' }));
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    const status = await res.json();
    assert.equal(status.currentAccount, 'bob@example.com (Acme)');
    assert.equal(am.currentIndex, 1);
  });
});

test('an unknown account is refused with 404 and the valid names', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: 'nobody@example.com' }));
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /nobody@example\.com/);
    assert.deepEqual(res.body.accounts, ['alice@example.com', 'bob@example.com (Acme)']);
    assert.equal(am.currentIndex, 0, 'a refused switch must not move the current account');
  });
});

// The rotation index is array position, so accepting it would silently repoint a
// script at a DIFFERENT account after a removal. resolveAccountPin refuses it and
// the endpoint inherits that.
test('a numeric rotation index is not an account name', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: '1' }));
    assert.equal(res.status, 404);
    assert.equal(am.currentIndex, 0);
  });
});

test('a missing or blank account field is a 400, not a switch', async () => {
  await withServer(async (am, port) => {
    for (const body of ['{}', JSON.stringify({ account: '' }), JSON.stringify({ account: '   ' }), JSON.stringify({ account: 7 })]) {
      const res = await post(port, body);
      assert.equal(res.status, 400, body);
      assert.equal(res.body.ok, false, body);
    }
    assert.equal(am.currentIndex, 0);
  });
});

test('a malformed body is a 400, not a crash', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, 'not json');
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.equal(am.currentIndex, 0);
  });
});

// Loopback is exempt from the proxy-key gate (that is what makes the fetch-based
// tests above work), so the gate itself has to be exercised with a remote peer.
function remoteRequest(server, { headers = {}, body = '{}' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.url = '/teamclaude/switch';
  req.headers = headers;
  req.socket = { remoteAddress: '203.0.113.9' };

  const res = {
    status: null,
    chunks: '',
    writeHead(status) { this.status = status; return this; },
    end(chunk) { if (chunk) this.chunks += chunk; this._done(); },
  };
  const finished = new Promise(resolve => { res._done = resolve; });
  server.emit('request', req, res);
  return finished.then(() => ({ status: res.status, body: JSON.parse(res.chunks || '{}') }));
}

test('a remote client without the proxy key cannot switch', async () => {
  await withServer(async (am, port, server) => {
    const res = await remoteRequest(server, { body: JSON.stringify({ account: 'bob@example.com (Acme)' }) });
    assert.equal(res.status, 401);
    assert.equal(am.currentIndex, 0);
  });
});

test('a remote client with the proxy key can switch', async () => {
  await withServer(async (am, port, server) => {
    const res = await remoteRequest(server, {
      headers: { 'x-api-key': 'tc-test' },
      body: JSON.stringify({ account: 'bob@example.com (Acme)' }),
    });
    assert.equal(res.status, 200);
    assert.equal(am.currentIndex, 1);
  });
});
