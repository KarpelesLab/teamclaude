import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveClientAuth } from '../src/server.js';
import { resolveConnectAuth, resolveConnectPin } from '../src/mitm.js';
import {
  ClientUsageTracker,
  UsageDimensionTracker,
  OVERFLOW_KEY,
  DEFAULT_USAGE_DIMENSION_MAX_KEYS,
  resolveUsageDimensions,
  usageDimensionHeaderNames,
  sanitizeUsageDimensionValue,
  createUsageRecorder,
} from '../src/client-usage.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PROXY = { apiKey: 'shared-key', clientKeys: [{ name: 'alice', key: 'alice-key' }, { name: 'bob', key: 'bob-key' }] };

// ── ClientUsageTracker ──────────────────────────────────────

test('tracker aggregates per name and drops unattributed records', () => {
  const t = new ClientUsageTracker({ now: () => 1000 });
  t.record('alice', { requests: 1 });
  t.record('alice', { inputTokens: 7, outputTokens: 3 });
  t.record(null, { requests: 1, inputTokens: 99 });   // unattributed → dropped
  t.record('', { requests: 1 });                       // ditto
  assert.deepEqual(t.export(), {
    alice: { requests: 1, inputTokens: 7, outputTokens: 3, lastUsed: new Date(1000).toISOString() },
  });
});

test('restore is additive and survives malformed entries', () => {
  const t = new ClientUsageTracker({ now: () => 5000 });
  t.record('alice', { requests: 2, inputTokens: 10, outputTokens: 5 });
  t.restore({
    alice: { requests: 3, inputTokens: 1, outputTokens: 1, lastUsed: new Date(2000).toISOString() },
    bob: { requests: 1, inputTokens: 4, outputTokens: 2, lastUsed: 'not-a-date' },
    '': { requests: 9 },              // unnamed → skipped
    mallory: 'not-an-object',         // malformed → skipped
  });
  const out = t.export();
  assert.equal(out.alice.requests, 5);
  assert.equal(out.alice.inputTokens, 11);
  // live lastUsed (5000) is newer than the restored one (2000) and must win
  assert.equal(out.alice.lastUsed, new Date(5000).toISOString());
  assert.deepEqual(out.bob, { requests: 1, inputTokens: 4, outputTokens: 2, lastUsed: null });
  assert.equal(out.mallory, undefined);
  assert.equal(Object.keys(out).length, 2);
});

// ── resolveClientAuth (HTTP gate) ───────────────────────────

test('resolveClientAuth maps keys to identities', () => {
  assert.deepEqual(resolveClientAuth(PROXY, 'alice-key'), { ok: true, client: 'alice' });
  assert.deepEqual(resolveClientAuth(PROXY, 'shared-key'), { ok: true, client: null });
  assert.deepEqual(resolveClientAuth(PROXY, 'wrong'), { ok: false, client: null });
  assert.deepEqual(resolveClientAuth(PROXY, undefined), { ok: false, client: null });
  // no keys configured at all → open (unchanged pre-clientKeys behavior)
  assert.deepEqual(resolveClientAuth({}, undefined), { ok: true, client: null });
  assert.deepEqual(resolveClientAuth(undefined, 'anything'), { ok: true, client: null });
  // clientKeys-only config (no shared key) still gates
  assert.equal(resolveClientAuth({ clientKeys: PROXY.clientKeys }, 'nope').ok, false);
  assert.deepEqual(resolveClientAuth({ clientKeys: PROXY.clientKeys }, 'bob-key'), { ok: true, client: 'bob' });
});

test('a clientKeys entry duplicating the shared key still yields its name', () => {
  const cfg = { apiKey: 'k', clientKeys: [{ name: 'carol', key: 'k' }] };
  assert.deepEqual(resolveClientAuth(cfg, 'k'), { ok: true, client: 'carol' });
});

// ── resolveConnectAuth (CONNECT gate) ───────────────────────

const basic = (user, pass) => ({ headers: { 'proxy-authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } });
const remote = { remoteAddress: '203.0.113.7' };
const local = { remoteAddress: '127.0.0.1' };

test('resolveConnectAuth resolves client keys in either Basic slot and Bearer', () => {
  assert.deepEqual(resolveConnectAuth(basic('alice-key', ''), remote, PROXY), { ok: true, client: 'alice' });
  assert.deepEqual(resolveConnectAuth(basic('x', 'alice-key'), remote, PROXY), { ok: true, client: 'alice' });
  assert.deepEqual(resolveConnectAuth({ headers: { 'proxy-authorization': 'Bearer bob-key' } }, remote, PROXY), { ok: true, client: 'bob' });
  assert.deepEqual(resolveConnectAuth(basic('shared-key', ''), remote, PROXY), { ok: true, client: null });
  assert.equal(resolveConnectAuth(basic('wrong', ''), remote, PROXY).ok, false);
  assert.equal(resolveConnectAuth({ headers: {} }, remote, PROXY).ok, false);
});

test('resolveConnectAuth: loopback is exempt but a valid key still names it', () => {
  assert.deepEqual(resolveConnectAuth({ headers: {} }, local, PROXY), { ok: true, client: null });
  assert.deepEqual(resolveConnectAuth(basic('alice-key', ''), local, PROXY), { ok: true, client: 'alice' });
});

// ── resolveConnectPin back-compat + clientKeys awareness ────

test('resolveConnectPin: any configured key in the username is auth, not a pin', () => {
  const am = new AccountManager([{ name: 'alice', type: 'api_key', apiKey: 'sk-x' }], 0.98);
  // legacy string form still works, and the key wins over the same-named account
  assert.deepEqual(resolveConnectPin(basic('shared-key', ''), am, 'shared-key'), { pin: null, error: null });
  // a clientKeys key must not be mistaken for an (unknown) account pin
  assert.deepEqual(resolveConnectPin(basic('bob-key', ''), am, PROXY), { pin: null, error: null });
  // a real account name still pins
  assert.deepEqual(resolveConnectPin(basic('alice', ''), am, PROXY), { pin: 'alice', error: null });
});

// ── end to end: responses book tokens against the presenting client ──

function usageUpstream() {
  return http.createServer((req, res) => {
    if ((req.headers.accept || '').includes('text/event-stream') || req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100}}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":40}}\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 7, output_tokens: 3 } }));
  });
}

async function postAs(port, key, path = '/v1/messages') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  await res.text();
  return res.status;
}

test('per-client usage: tokens are booked against the key that authenticated', async () => {
  const upstream = usageUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'acct', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  const tracker = new ClientUsageTracker();
  const proxy = createProxyServer(am, { proxy: PROXY, upstream: `http://127.0.0.1:${upstreamPort}` }, {}, null, tracker);
  const proxyPort = await listen(proxy);

  try {
    assert.equal(await postAs(proxyPort, 'alice-key'), 200);          // JSON body
    assert.equal(await postAs(proxyPort, 'alice-key', '/stream'), 200); // SSE
    assert.equal(await postAs(proxyPort, 'shared-key'), 200);         // unattributed
    assert.equal(await postAs(proxyPort, null), 200);                 // loopback exemption, unattributed

    const out = tracker.export();
    assert.deepEqual(Object.keys(out), ['alice']);
    assert.equal(out.alice.requests, 2);
    assert.equal(out.alice.inputTokens, 107);   // 7 (json) + 100 (sse message_start)
    assert.equal(out.alice.outputTokens, 43);   // 3 (json) + 40 (sse message_delta)

    // per-ACCOUNT accounting is untouched by attribution: all four requests land on it
    assert.equal(am.accounts[0].usage.totalInputTokens, 7 + 100 + 7 + 7);
    assert.equal(am.accounts[0].usage.totalOutputTokens, 3 + 40 + 3 + 3);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('per-client usage: an invalid key on a loopback call neither fails the request nor mis-attributes it', async () => {
  // The gate itself is exercised through resolveClientAuth (unit-tested above);
  // over real sockets every test connection is loopback and thus exempt. What
  // MUST hold end-to-end is that an invalid key on a loopback call neither
  // fails the request nor mis-attributes it.
  const upstream = usageUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'acct', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  const tracker = new ClientUsageTracker();
  const proxy = createProxyServer(am, { proxy: PROXY, upstream: `http://127.0.0.1:${upstreamPort}` }, {}, null, tracker);
  const proxyPort = await listen(proxy);

  try {
    assert.equal(await postAs(proxyPort, 'wrong-key'), 200); // loopback exemption
    assert.deepEqual(tracker.export(), {});                  // but never attributed
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('resolveClientAuth ignores nameless or keyless entries and keeps the rest', () => {
  const cfg = { clientKeys: [{ key: 'nameless' }, { name: 'ok', key: 'k-ok' }, { name: 'ok', key: 'k-ok2' }] };
  const errors = [];
  const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.deepEqual(resolveClientAuth(cfg, 'nameless'), { ok: false, client: null });
    assert.deepEqual(resolveClientAuth(cfg, 'k-ok'), { ok: true, client: 'ok' });
    assert.deepEqual(resolveClientAuth(cfg, 'k-ok2'), { ok: true, client: 'ok' });
    resolveClientAuth(cfg, 'k-ok'); // same array: no second round of warnings
  } finally { console.error = orig; }
  assert.equal(errors.filter(e => /without a name and a key/.test(e)).length, 1);
  assert.equal(errors.filter(e => /duplicate name "ok"/.test(e)).length, 1);
});

test('export() keeps a hostile client name as a plain key', () => {
  const t = new ClientUsageTracker();
  t.record('__proto__', { requests: 1 });
  const out = t.export();
  assert.ok(Object.hasOwn(out, '__proto__'), 'an own key, not the prototype');
  assert.equal(out['__proto__'].requests, 1);
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'still a plain object for deepEqual/JSON');
});

// --- usage dimensions (proxy.usageDimensions) -------------------------------

test('per-client accounting stays uncapped: clientKeys is bounded by the config', () => {
  const t = new ClientUsageTracker();
  for (let i = 0; i < DEFAULT_USAGE_DIMENSION_MAX_KEYS + 50; i++) t.record(`c${i}`, { requests: 1 });
  assert.equal(Object.keys(t.export()).length, DEFAULT_USAGE_DIMENSION_MAX_KEYS + 50);
});

test('an over-cap dimension value folds into (other) and never evicts a row', () => {
  const t = new ClientUsageTracker({ maxKeys: 3 });
  t.record('a', { requests: 1, inputTokens: 10 });
  t.record('b', { requests: 1 });
  t.record('c', { requests: 1 });
  // Three more distinct values arrive. Eviction would delete `a` — whose
  // counters are cumulative and persisted — making the loss permanent at the
  // next save. The fold must leave every existing row untouched.
  t.record('d', { requests: 1, inputTokens: 5 });
  t.record('e', { requests: 1, inputTokens: 5 });
  t.record('f', { requests: 1, inputTokens: 5 });

  const out = t.export();
  assert.deepEqual(Object.keys(out).sort(), ['(other)', 'a', 'b', 'c']);
  assert.equal(out.a.inputTokens, 10, 'the first value keeps its lifetime total');
  assert.equal(out[OVERFLOW_KEY].requests, 3, 'the overflow is summed, not dropped');
  assert.equal(out[OVERFLOW_KEY].inputTokens, 15);

  // A value already known is still booked to itself, cap or no cap.
  t.record('a', { requests: 1 });
  assert.equal(t.export().a.requests, 2);
});

test('a restored snapshot cannot be evicted by later traffic either', () => {
  const t = new ClientUsageTracker({ maxKeys: 2 });
  t.restore({ old: { requests: 7, inputTokens: 70, lastUsed: '2020-01-01T00:00:00.000Z' } });
  t.record('new', { requests: 1 });
  t.record('newer', { requests: 1 });
  const out = t.export();
  assert.equal(out.old.requests, 7, 'the least-recently-used row survives');
  assert.equal(out[OVERFLOW_KEY].requests, 1);
});

test('a caller-supplied dimension value of __proto__ lands as an own key', () => {
  // Dimension NAMES are operator config and validated, but VALUES come from a
  // request header: `X-Teamclaude-Project: __proto__` passes sanitization, so
  // the row must survive the export rather than vanish onto the prototype.
  const t = new UsageDimensionTracker();
  assert.equal(sanitizeUsageDimensionValue('__proto__'), '__proto__', 'the value is not filtered');
  t.record('project', '__proto__', { requests: 1 });
  const project = t.export().project;
  assert.ok(Object.hasOwn(project, '__proto__'), 'an own key, not the prototype');
  assert.equal(project['__proto__'].requests, 1);
  assert.equal(Object.getPrototypeOf(t.export()), Object.prototype, 'plain object for JSON');
});

test('a dimension name that is not a valid identifier is refused', () => {
  const t = new UsageDimensionTracker();
  t.record('__proto__', 'v', { requests: 1 });
  t.record('bad name!', 'v', { requests: 1 });
  assert.deepEqual(t.export(), {});
});

test('dimensions are resolved from configured headers only', () => {
  const proxy = {
    usageDimensions: [
      { name: 'project', header: 'X-Teamclaude-Project' },
      { name: 'ref', header: 'x-teamclaude-ref' },
      { name: 'bad name!', header: 'x-ignored' },
      { name: 'creds', header: 'authorization' },
      { name: 'creds2', header: 'cookie' },
    ],
  };
  const headers = {
    'x-teamclaude-project': 'skaile-dev',
    'x-claude-code-session-id': 'sess-1',
    authorization: 'Bearer secret',
    cookie: 'a=b',
  };
  // No session dimension: per-session cost comes from SessionTracker, which
  // meters the response usage including cache tokens.
  assert.deepEqual(resolveUsageDimensions(proxy, headers), [{ name: 'project', key: 'skaile-dev' }]);
  // A dimension pointed at a credential header is refused outright, so the
  // credential can never become a persisted counter name.
  assert.deepEqual(
    [...usageDimensionHeaderNames(proxy)].sort(),
    ['x-teamclaude-project', 'x-teamclaude-ref'],
  );
  assert.deepEqual(resolveUsageDimensions({}, headers), []);
  assert.deepEqual(resolveUsageDimensions(null, headers), []);
});

test('dimension values are sanitized at ingest and length-capped', () => {
  assert.equal(sanitizeUsageDimensionValue('  my [31mproject\n '), 'my project');
  assert.equal(sanitizeUsageDimensionValue('x'.repeat(500)).length, 200);
  assert.equal(sanitizeUsageDimensionValue(['a', 'b']), 'a, b');
  assert.equal(sanitizeUsageDimensionValue('   '), null);
  assert.equal(sanitizeUsageDimensionValue(undefined), null);
});

test('the recorder books one request and its tokens to every target', () => {
  const clientUsage = new ClientUsageTracker();
  const dimensionUsage = new UsageDimensionTracker();
  const rec = createUsageRecorder({
    client: 'ci',
    clientUsage,
    dimensions: [{ name: 'project', key: 'skaile-dev' }],
    dimensionUsage,
  });
  rec.recordRequest();
  rec.onUsage(100, 20);
  assert.equal(clientUsage.export().ci.requests, 1);
  assert.equal(clientUsage.export().ci.inputTokens, 100);
  assert.equal(dimensionUsage.export().project['skaile-dev'].outputTokens, 20);

  // Nothing to attribute means no work and no onUsage hook to install.
  const none = createUsageRecorder({ client: null, clientUsage, dimensions: [], dimensionUsage });
  assert.equal(none.onUsage, null);
});

test('a dimension header is booked here and NOT forwarded upstream', async () => {
  let seen = null;
  const upstream = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 7, output_tokens: 3 } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'acct', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  const dimensionUsage = new UsageDimensionTracker();
  const proxy = createProxyServer(am, {
    proxy: { ...PROXY, usageDimensions: [{ name: 'project', header: 'x-teamclaude-project' }] },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  }, {}, null, new ClientUsageTracker(), dimensionUsage);
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-teamclaude-project': 'skaile-dev',
        'x-teamclaude-other': 'kept',
      },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();

    assert.equal(dimensionUsage.export().project['skaile-dev'].inputTokens, 7);
    // The header labels traffic for THIS proxy. Forwarding it would hand the
    // operator's internal project names to the upstream vendor for no benefit.
    assert.equal(seen['x-teamclaude-project'], undefined, 'dimension header must not reach upstream');
    // Only the configured ones are stripped — this is not a general filter.
    assert.equal(seen['x-teamclaude-other'], 'kept');
  } finally {
    proxy.close();
    upstream.close();
  }
});
