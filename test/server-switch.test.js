import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// POST /teamclaude/switch is the headless equivalent of picking an account with
// 's' in the TUI: both only move the manager's currentIndex. The TUI is not
// reachable when the proxy runs as a background service, which is what this
// endpoint exists for. currentIndex is a weak preference — selection drops it
// when the account is unavailable and also when an available account has a
// lower priority value — so "recorded" and "in effect" are tested separately.

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

// A switch that cannot take effect must not report a bare success. currentIndex
// still moves (that is the TUI's behaviour), but selection skips an unavailable
// account on the very next request, so the answer says whether traffic will
// actually follow the choice.
test('switching to a disabled account succeeds but reports it as ineligible', async () => {
  const am = new AccountManager([
    { name: 'live@example.com', type: 'apikey', apiKey: 'k1' },
    { name: 'off@example.com', type: 'apikey', apiKey: 'k2', disabled: true },
  ], 0.98);
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  try {
    const res = await post(port, JSON.stringify({ account: 'off@example.com' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, 'the switch is still recorded, as in the TUI');
    assert.equal(res.body.account, 'off@example.com');
    assert.equal(res.body.eligible, false);
    assert.match(res.body.reason, /disabled/);
    assert.equal(am.currentIndex, 1, 'currentIndex moves even when ineligible');
    // Proof the report is not pedantic: the next selection abandons the choice.
    assert.equal(am.getActiveAccount().name, 'live@example.com');
  } finally {
    proxy.close();
  }
});

test('switching to a usable account reports it as eligible', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: 'bob@example.com (Acme)' }));
    assert.equal(res.body.eligible, true);
    assert.equal(res.body.reason, undefined, 'no reason when nothing is wrong');
    assert.equal(am.getActiveAccount().name, 'bob@example.com (Acme)');
  });
});

// Unavailability is not the only way a switch gets undone. A perfectly healthy
// account is dropped just as fast when another available account outranks it on
// priority, so "eligible" has to answer the real question — would a request go
// here — rather than only "is this account usable at all".
test('a switch that priority will immediately override is reported as ineligible', async () => {
  const am = new AccountManager([
    { name: 'high@example.com', type: 'apikey', apiKey: 'k1', priority: 0 },
    { name: 'low@example.com', type: 'apikey', apiKey: 'k2', priority: 1 },
  ], 0.98);
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  try {
    const res = await post(port, JSON.stringify({ account: 'low@example.com' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, 'the switch is still recorded');
    assert.equal(res.body.eligible, false, 'a preempted target is not where traffic will go');
    assert.match(res.body.reason, /priority/i);
    assert.match(res.body.reason, /high@example\.com/, 'name the account that wins');
    assert.equal(am.currentIndex, 1, 'currentIndex still moves');
    // Proof the report is not pedantic: selection hands it straight back.
    assert.equal(am.getActiveAccount().name, 'high@example.com');
  } finally {
    proxy.close();
  }
});

test('switching to the highest-priority account is eligible', async () => {
  const am = new AccountManager([
    { name: 'high@example.com', type: 'apikey', apiKey: 'k1', priority: 0 },
    { name: 'low@example.com', type: 'apikey', apiKey: 'k2', priority: 1 },
  ], 0.98);
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  try {
    am.currentIndex = 1;
    const res = await post(port, JSON.stringify({ account: 'high@example.com' }));
    assert.equal(res.body.eligible, true);
    assert.equal(res.body.reason, undefined);
    assert.equal(am.getActiveAccount().name, 'high@example.com');
  } finally {
    proxy.close();
  }
});

// Equal priority must NOT read as preemption, or every default fleet would
// report its own current account as ineligible.
test('accounts at the same priority do not preempt each other', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: 'bob@example.com (Acme)' }));
    assert.equal(res.body.eligible, true);
    assert.equal(am.getActiveAccount().name, 'bob@example.com (Acme)');
  });
});

test('an over-limit body is refused as 413 without echoing parser internals', async () => {
  await withServer(async (am, port) => {
    const res = await post(port, JSON.stringify({ account: 'a'.repeat(70_000) }));
    assert.equal(res.status, 413);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /too large/);
    assert.equal(am.currentIndex, 0);
  });
});

// The log line is the only record of a manual switch on a headless server, so a
// refactor that drops it must fail something.
test('a successful switch is logged, and says so when the target is ineligible', async () => {
  const am = new AccountManager([
    { name: 'live@example.com', type: 'apikey', apiKey: 'k1' },
    { name: 'off@example.com', type: 'apikey', apiKey: 'k2', disabled: true },
  ], 0.98);
  const proxy = createProxyServer(am, CONFIG, {});
  const port = await listen(proxy);
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await post(port, JSON.stringify({ account: 'live@example.com' }));
    await post(port, JSON.stringify({ account: 'off@example.com' }));
  } finally {
    console.log = origLog;
    proxy.close();
  }
  assert.ok(lines.some(l => l.includes('live@example.com') && /switch/i.test(l)), lines.join(' | '));
  const offLine = lines.find(l => l.includes('off@example.com'));
  assert.ok(offLine, lines.join(' | '));
  assert.match(offLine, /disabled/, 'the log must not claim a clean switch to an unusable account');
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
