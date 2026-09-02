import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveClientAuth } from '../src/server.js';
import { resolveConnectAuth, resolveConnectPin } from '../src/mitm.js';
import { ClientUsageTracker } from '../src/client-usage.js';

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
