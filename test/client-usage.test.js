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
  USAGE_SLOT_MS,
  USAGE_WINDOWS,
} from '../src/client-usage.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// The same counters in every window — what an exact-shape assertion expects
// when all of an entry's traffic is recent enough to sit inside all of them.
// Derived from the tracker's own window list, so adding a window does not
// silently weaken these assertions into ones that skip the new key.
function everyWindow(usage) {
  return Object.fromEntries(Object.keys(USAGE_WINDOWS).map(label => [label, { ...usage }]));
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
    alice: {
      requests: 1, connections: 0, inputTokens: 7, outputTokens: 3, lastUsed: new Date(1000).toISOString(),
      // Recorded at one instant, so every window holds all of it.
      windows: everyWindow({ requests: 1, connections: 0, inputTokens: 7, outputTokens: 3 }),
    },
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
  assert.deepEqual(out.bob, { requests: 1, connections: 0, inputTokens: 4, outputTokens: 2, lastUsed: null });
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

// ── windowed usage ──────────────────────────────────────────
//
// A clock far from the epoch, so a slot number is a realistic magnitude and a
// window boundary does not land on slot 0 by accident.
const T0 = 400 * 24 * 3600_000;

test('a window rolls up only the traffic inside it, and the total keeps everything', () => {
  let now = T0;
  const t = new ClientUsageTracker({ now: () => now });
  t.record('alice', { requests: 1, inputTokens: 100 });
  now += 6 * 3600_000;
  t.record('alice', { requests: 1, inputTokens: 10 });
  now += 3600_000;                                   // 7h after the first record

  const e = t.export().alice;
  assert.equal(e.inputTokens, 110, 'the lifetime counter is unchanged by windowing');
  assert.equal(e.windows['24h'].inputTokens, 110);
  assert.equal(e.windows['24h'].requests, 2);
  assert.equal(e.windows['5h'].inputTokens, 10, 'the 7h-old record is outside the 5h window');
  assert.equal(e.windows['5h'].requests, 1);
});

test('a slot that leaves the longest window is deleted, not merely unsummed', () => {
  let now = T0;
  const t = new ClientUsageTracker({ now: () => now });
  t.record('alice', { requests: 1, inputTokens: 100 });
  now += 25 * 3600_000;
  t.record('alice', { requests: 1, inputTokens: 5 });

  const e = t.export().alice;
  assert.equal(e.inputTokens, 105, 'the lifetime counter still holds both');
  assert.equal(e.windows['24h'].inputTokens, 5);
  assert.deepEqual(Object.keys(t.exportState().alice.slots).length, 1, 'the aged slot is gone from memory');
});

test('the status snapshot ships windows, the state snapshot ships slots', () => {
  const t = new ClientUsageTracker({ now: () => T0 });
  t.record('alice', { requests: 1 });
  // The two have different readers: a dashboard polling every few seconds must
  // not be handed a hundred rows to re-sum, and a state file must not be handed
  // a rollup it cannot resume from.
  assert.ok(t.export().alice.windows, 'status carries the rollups');
  assert.equal(t.export().alice.slots, undefined, 'status does not carry the tally');
  assert.ok(t.exportState().alice.slots, 'state carries the tally');
  assert.equal(t.exportState().alice.windows, undefined, 'state does not carry the rollups');
});

test('a restart resumes the window from the state file', () => {
  let now = T0;
  const before = new ClientUsageTracker({ now: () => now });
  before.record('alice', { requests: 1, inputTokens: 100 });
  const saved = before.exportState();

  now += 3600_000;
  const after = new ClientUsageTracker({ now: () => now });
  after.restore(saved);

  const e = after.export().alice;
  assert.equal(e.windows['5h'].inputTokens, 100, 'an hour-old slot is still inside both windows');
  assert.equal(e.windows['24h'].inputTokens, 100);
});

test('restore drops slots that aged out while the proxy was down', () => {
  let now = T0;
  const before = new ClientUsageTracker({ now: () => now });
  before.record('alice', { requests: 1, inputTokens: 100 });
  const saved = before.exportState();

  now += 48 * 3600_000;
  const after = new ClientUsageTracker({ now: () => now });
  after.restore(saved);

  const e = after.export().alice;
  assert.equal(e.inputTokens, 100, 'the lifetime counters restore in full');
  assert.equal(e.windows, undefined, 'a two-day-old slot leaves nothing in any window');
  assert.equal(after.exportState().alice.slots, undefined, 'and is not carried into the next state file');
});

test('a state file written before slots existed restores without inventing a window', () => {
  const t = new ClientUsageTracker({ now: () => T0 });
  t.restore({ alice: { requests: 2, inputTokens: 5, lastUsed: new Date(T0 - 1000).toISOString() } });
  const e = t.export().alice;
  assert.equal(e.requests, 2);
  assert.equal(e.windows, undefined, 'traffic with no recorded time counts in no window');
});

test('restore ignores a malformed or expired slot key instead of throwing', () => {
  const t = new ClientUsageTracker({ now: () => T0 });
  const current = Math.floor(T0 / USAGE_SLOT_MS);
  t.restore({
    alice: {
      requests: 1,
      slots: {
        'not-a-slot': { requests: 5 },
        [String(current)]: { requests: 1, inputTokens: 9 },
        [String(current - 10_000)]: { requests: 7 },
        [String(current - 1)]: 'nonsense',
      },
    },
  });
  assert.equal(t.export().alice.windows['5h'].requests, 1, 'only the valid current slot lands');
  assert.equal(t.export().alice.windows['5h'].inputTokens, 9);
});

test('a dimension tracker windows and persists its slots the same way', () => {
  const now = T0;
  const before = new UsageDimensionTracker({ now: () => now });
  before.record('project', 'widgets', { requests: 1, inputTokens: 40 });

  const after = new UsageDimensionTracker({ now: () => now });
  after.restore(before.exportState());
  assert.equal(after.export().project['widgets'].windows['24h'].inputTokens, 40);
});

test('a client with traffic in any window carries every window, zeros included', () => {
  let now = T0;
  const t = new ClientUsageTracker({ now: () => now });
  t.record('alice', { requests: 1, inputTokens: 5 });
  now += 6 * 3600_000;   // outside 5h, inside 24h

  const windows = t.export().alice.windows;
  assert.deepEqual(Object.keys(windows).sort(), Object.keys(USAGE_WINDOWS).sort(), 'no window is dropped for being empty');
  assert.deepEqual(windows['5h'], { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0 });
  assert.equal(windows['24h'].inputTokens, 5);
});

test('a client with nothing in any window carries no windows at all', () => {
  let now = T0;
  const t = new ClientUsageTracker({ now: () => now });
  t.record('alice', { requests: 1 });
  now += 30 * 3600_000;
  // The windows nest, so an empty longest window means every window is empty
  // and the key can be left out. On a dimension holding a value per git ref
  // these are the majority, and they were the bulk of the status payload.
  assert.equal(t.export().alice.windows, undefined);
  assert.equal(t.export().alice.requests, 1, 'the lifetime counters are still reported');
});

test('a slot is retained for exactly as long as the longest window still reads it', () => {
  let now = T0;
  const t = new ClientUsageTracker({ now: () => now });
  t.record('alice', { inputTokens: 100 });

  // Exactly 24h on, the first record sits in the oldest slot the window still
  // covers. This is what the +1 in the retention bound buys: without it the
  // slot is evicted one tick before the window stops asking for it, and every
  // other test here advances the clock too far to notice.
  now += 24 * 3600_000;
  t.record('alice', { inputTokens: 1 });
  assert.equal(t.export().alice.windows['24h'].inputTokens, 101, 'the boundary slot is still counted');

  now += USAGE_SLOT_MS;
  t.record('alice', { inputTokens: 1 });
  assert.equal(t.export().alice.windows['24h'].inputTokens, 2, 'one slot later it has left the window');
});

test('restore refuses a slot from the future instead of evicting the window behind it', () => {
  const now = T0;
  const current = Math.floor(now / USAGE_SLOT_MS);
  const slots = {};
  for (let i = 0; i < 96; i++) slots[String(current - i)] = { inputTokens: 1000 };
  // A state file written before the clock was corrected backwards. Eviction
  // anchored on the slot being written would take the cutoff into the future
  // with it and drop all 96 real slots; measured at 1 survivor before the fix.
  slots[String(current + 200)] = { inputTokens: 1 };

  const t = new ClientUsageTracker({ now: () => now });
  t.restore({ alice: { requests: 1, slots } });
  assert.equal(t.export().alice.windows['24h'].inputTokens, 96_000, 'the retained window survives it');
  assert.equal(Object.keys(t.exportState().alice.slots).length, 96, 'and the future slot is not admitted');
});

test('a forward clock step ages the window by the step, and no further', () => {
  let now = T0;
  const t = new ClientUsageTracker({ now: () => now });
  for (let i = 0; i < 96; i++) { t.record('alice', { inputTokens: 1000 }); now += USAGE_SLOT_MS; }
  now -= USAGE_SLOT_MS;

  // A clock that runs 3h fast for one request, then is corrected. Bucketing by
  // wall clock cannot detect this: the request is booked 12 slots ahead and
  // eviction runs against a cutoff 12 slots later than it should be, so the 11
  // oldest slots age out early. That is proportional to the step and heals as
  // the clock advances. It is pinned here so it cannot regress into the
  // disproportionate case the restore guard above covers, where ONE bad slot
  // took the whole window with it.
  now += 3 * 3600_000;
  t.record('alice', { inputTokens: 1 });
  now -= 3 * 3600_000;

  assert.equal(Object.keys(t.exportState().alice.slots).length, 86, '85 of 96 slots survive, plus the misdated one');
  assert.equal(t.export().alice.inputTokens, 96_001, 'the lifetime counter is untouched either way');
});

test('a key that stops recording does not hold its slots for the life of the process', () => {
  let now = T0;
  const t = new ClientUsageTracker({ now: () => now });
  t.record('alice', { requests: 1, inputTokens: 100 });
  t.record('bob', { requests: 1, inputTokens: 100 });

  // Eviction on write alone never runs for a key that has gone quiet, and a
  // dimension keyed on something like a git ref is mostly keys that went quiet
  // for good. Reading has to prune too, or the cost is set by every distinct
  // key seen since the last restart rather than by the window.
  now += 48 * 3600_000;
  t.record('alice', { requests: 1 });

  const state = t.exportState();
  assert.equal(state.bob.slots, undefined, 'the silent key drops its slots when read, and writes none');
  assert.equal(state.bob.requests, 1, 'its lifetime counters are untouched');
  assert.equal(Object.keys(state.alice.slots).length, 1, 'the live key keeps only its current slot');
});
