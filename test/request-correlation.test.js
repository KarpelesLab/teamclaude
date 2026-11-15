import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyRequestListener, createProxyServer } from '../src/server.js';

// A caller correlates its request through `x-request-id`. The proxy accepts that
// value only when it is a plain token, generates one otherwise, and echoes the
// result as `x-teamclaude-request-id` on every response from the forwarding
// listener: the synthetic refusals as well as the forwarded answer. It is
// correlation only. The inbound header still goes upstream as it always did, and
// a response `x-request-id` (Codex sends its own) is left alone.
//
// Every test runs real HTTP on an ephemeral port, and cleans up in `finally`.

const ECHO = 'x-teamclaude-request-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOT_PATH = '/v1/messages/../x';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const closeAll = (...servers) => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } };

// One request with a body read to its end, so the echoed header is read from the
// response the client actually got. A string or array header value goes out as
// given, which is how a duplicated header reaches the proxy.
function send(port, { path = '/v1/messages', headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// The dot-segment refusal answers before any account is selected, so a listener
// with a manager that cannot select one exercises the earliest refusal.
async function withRefusingListener(run) {
  const accountManager = { getActiveAccount() { throw new Error('must not select an account'); } };
  const listener = createProxyRequestListener({ accountManager, upstream: 'http://127.0.0.1:1', hooks: {} });
  const server = http.createServer(listener);
  const port = await listen(server);
  try {
    return await run(port);
  } finally {
    closeAll(server);
  }
}

// A proxy in front of a fake upstream. `respond(req, res)` answers each upstream
// request after its body has been read. `seen` collects the headers the upstream
// received, so a test can check what was forwarded.
async function withFleet({ accounts, respond, am = null, hooks = {} }, run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers);
      respond(req, res);
    });
  });
  const upstreamPort = await listen(upstream);
  const accountManager = am ?? new AccountManager(accounts, 0.98);
  const proxy = createProxyServer(accountManager, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, hooks);
  const port = await listen(proxy);
  const origError = console.error;
  console.error = () => {};
  try {
    return await run({ port, seen, accountManager });
  } finally {
    console.error = origError;
    closeAll(proxy, upstream);
  }
}

// Collects what a hook reported. `reached` resolves once `n` calls have arrived.
// The end hook runs in the server's `finally`, which can land after the client
// has read the whole response, so a test waits on this rather than reading early.
function gate(n) {
  const items = [];
  let open;
  const reached = new Promise((resolve) => { open = resolve; });
  return {
    items,
    reached,
    push(item) { items.push(item); if (items.length === n) open(); },
  };
}

const OK = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
};
const apikey = (name) => ({ name, type: 'apikey', apiKey: `${name}-key` });
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });

// ── the caller id is accepted when it is a plain token ─────────────────────

test('a valid x-request-id is echoed as x-teamclaude-request-id on a refusal', async () => {
  await withRefusingListener(async (port) => {
    for (const id of ['Req.abc:123-XYZ', 'req_1', 'a'.repeat(128)]) {
      const res = await send(port, { path: DOT_PATH, headers: { 'x-request-id': id } });
      assert.equal(res.status, 400);
      assert.equal(res.headers[ECHO], id);
    }
  });
});

// ── anything else is replaced by a generated UUID ──────────────────────────

test('an invalid, oversized or duplicated x-request-id is replaced by a generated UUID', async () => {
  const cases = [
    { label: 'a space', value: 'bad id' },
    { label: 'a slash', value: 'a/b' },
    { label: 'a plus sign (not in the accepted set)', value: 'req+1' },
    { label: 'one byte over the length cap', value: 'x'.repeat(129) },
    { label: 'the same value twice', value: ['Req.abc', 'Req.abc'] },
    { label: 'two different values', value: ['Req.abc', 'Req.def'] },
  ];
  await withRefusingListener(async (port) => {
    for (const { label, value } of cases) {
      const res = await send(port, { path: DOT_PATH, headers: { 'x-request-id': value } });
      const echoed = res.headers[ECHO];
      assert.match(echoed, UUID, `${label}: expected a generated UUID, got ${echoed}`);
      assert.ok(!String(value).includes(echoed), `${label}: the caller's value leaked into the id`);
    }
  });
});

test('a request without x-request-id is given a generated UUID', async () => {
  await withRefusingListener(async (port) => {
    const res = await send(port, { path: DOT_PATH });
    assert.match(res.headers[ECHO], UUID);
  });
});

// ── every response from the forwarding listener carries the id ─────────────

test('the all-exhausted 429 carries the id', async () => {
  // The one account is capped and spent for a week. A cap is not overridden by
  // the exhausted-fleet probe, so nothing is sent upstream and the refusal is
  // the 429 the client gets back.
  const am = new AccountManager([oauth('alpha', { maxUsage: { unified7d: 0.6 } })], 0.98);
  am.accounts[0].quota.unified7d = 0.7;
  am.accounts[0].quota.unified7dReset = Date.now() + 6 * 24 * 3600_000;
  await withFleet({ am, respond: OK }, async ({ port, seen }) => {
    const res = await send(port, { headers: { 'x-request-id': 'exhausted-1', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5', messages: [] }) });
    assert.equal(res.status, 429);
    assert.equal(res.headers[ECHO], 'exhausted-1');
    assert.deepEqual(seen, [], 'nothing should have been sent upstream');
  });
});

test('a streamed SSE response carries the id from its first byte', async () => {
  const sse = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  };
  await withFleet({ accounts: [apikey('a')], respond: sse }, async ({ port }) => {
    const res = await send(port, {
      headers: { 'x-request-id': 'stream.1' },
      body: JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.equal(res.headers[ECHO], 'stream.1');
    assert.match(res.body, /message_stop/);
  });
});

// ── the upstream's own headers ─────────────────────────────────────────────

test('a Codex-style upstream x-request-id reaches the client unchanged, beside ours', async () => {
  const withUpstreamId = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'upstream-req-7f3a' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  };
  await withFleet({ accounts: [apikey('a')], respond: withUpstreamId }, async ({ port }) => {
    const res = await send(port, { headers: { 'x-request-id': 'caller-1' }, body: JSON.stringify({ model: 'claude-opus-5', messages: [] }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-request-id'], 'upstream-req-7f3a');
    assert.equal(res.headers[ECHO], 'caller-1');
  });
});

test('an upstream that sends its own x-teamclaude-request-id does not replace ours', async () => {
  const impostor = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', [ECHO]: 'impostor' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  };
  await withFleet({ accounts: [apikey('a')], respond: impostor }, async ({ port }) => {
    const res = await send(port, { headers: { 'x-request-id': 'caller-2' }, body: JSON.stringify({ model: 'claude-opus-5', messages: [] }) });
    assert.equal(res.headers[ECHO], 'caller-2');
  });
});

test('the inbound x-request-id is still forwarded upstream as it was sent', async () => {
  await withFleet({ accounts: [apikey('a')], respond: OK }, async ({ port, seen }) => {
    const res = await send(port, { headers: { 'x-request-id': 'forward.me-1' }, body: JSON.stringify({ model: 'claude-opus-5', messages: [] }) });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]['x-request-id'], 'forward.me-1');
  });
});

// ── one number per upstream attempt ────────────────────────────────────────

test('a failover is two upstream attempts under one request id; a clean request is one', async () => {
  const routed = [];
  const endedFirst = gate(1);
  const endedAll = gate(2);
  const ended = endedAll.items;
  const hooks = {
    onRequestRouted: (id, info) => routed.push({ id, account: info.account }),
    onRequestEnd: (id, info) => { endedFirst.push({ id, attempts: info.attempts }); endedAll.push({ id, attempts: info.attempts }); },
  };
  // The dead key is refused with a 401, which fails over to the live account and
  // takes the dead one out of rotation for the next request.
  const answer = (req, res) => {
    if (req.headers['x-api-key'] === 'dead-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid' } }));
      return;
    }
    OK(req, res);
  };
  const body = JSON.stringify({ model: 'claude-opus-5', messages: [] });
  await withFleet({ accounts: [apikey('dead'), apikey('live')], respond: answer, hooks }, async ({ port, seen }) => {
    const failed = await send(port, { body });
    assert.equal(failed.status, 200);
    await endedFirst.reached;
    assert.deepEqual(routed.map(r => r.account), ['dead', 'live'], 'the failover should route twice');
    assert.equal(new Set(routed.map(r => r.id)).size, 1, 'both attempts belong to one request id');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].id, routed[0].id);
    assert.equal(ended[0].attempts, 2);

    const clean = await send(port, { body });
    assert.equal(clean.status, 200);
    await endedAll.reached;
    assert.equal(ended.length, 2);
    assert.notEqual(ended[1].id, ended[0].id);
    assert.equal(ended[1].attempts, 1, 'a request that goes straight through is one attempt');
    assert.equal(seen.filter(h => h['x-api-key'] === 'dead-key').length, 1, 'the dead key was not retried');
  });
});

// ── the caller id is reported with the request's activity ──────────────────

test('the caller id reaches the activity hooks on start and end', async () => {
  const started = gate(2);
  const ended = gate(2);
  const hooks = {
    onRequestStart: (id, info) => started.push({ id, callerRequestId: info.callerRequestId }),
    onRequestEnd: (id, info) => ended.push({ id, callerRequestId: info.callerRequestId }),
  };
  const body = JSON.stringify({ model: 'claude-opus-5', messages: [] });
  await withFleet({ accounts: [apikey('a')], respond: OK, hooks }, async ({ port }) => {
    const valid = await send(port, { headers: { 'x-request-id': 'corr-9' }, body });
    assert.equal(valid.headers[ECHO], 'corr-9');
    const invalid = await send(port, { headers: { 'x-request-id': 'bad id' }, body });
    const generated = invalid.headers[ECHO];
    assert.match(generated, UUID);

    await Promise.all([started.reached, ended.reached]);
    assert.deepEqual(started.items.map(s => s.callerRequestId), ['corr-9', generated]);
    assert.deepEqual(ended.items.map(e => e.callerRequestId), ['corr-9', generated]);
    assert.notEqual(started.items[0].id, started.items[1].id, 'each request keeps its own internal id');
  });
});
