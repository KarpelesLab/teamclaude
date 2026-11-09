import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { closeUsageStore, openUsageStore, USAGE_STORE_AVAILABLE } from '../src/usage/db.js';

// node:sqlite needs Node 22.5+; on an older Node these skip.
const test = USAGE_STORE_AVAILABLE ? nodeTest : nodeTest.skip;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function usageRows(store) {
  return store.db.prepare(`
    SELECT dc.label AS caller, da.label AS account, u.status, u.input, u.cache_read AS cacheRead, u.cache_write AS cacheWrite, u.output
    FROM usage u JOIN dim dc ON dc.id = u.caller_id AND dc.kind = 'caller'
    JOIN dim da ON da.id = u.account_id AND da.kind = 'account'
  `).all().map((r) => ({ ...r }));
}

// The pool-exhausted 429 (no account ever selected — distinct from an upstream
// 429 surfaced past the inline-absorb cap) is a row of its own, so refusal
// counts include the one an operator most needs: the pool ran dry. An empty account list makes
// getActiveAccount return null on the very first call, with retryAfter (60s,
// no accounts to compute a sooner reset from) over the inline-retry cap, so
// this reaches the terminal branch with no upstream call at all — exercised
// through the SAME finally block every other completed request goes through
// (createProxyRequestListener), not a special-cased record call.
test('an exhausted pool writes exactly one usage row with status 429 and no tokens', async () => {
  const am = new AccountManager([], 0.98);
  const usageStore = openUsageStore({ path: ':memory:' });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' }, {}, null, null, null, { usageStore });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 429);
    assert.deepEqual(usageRows(usageStore), [
      // Loopback is exempt from the proxy-key check regardless of a configured
      // apiKey (see usageCallerLabel), hence '(local)' rather than '(shared)'.
      // No account served it, so the activity log's placeholder is not booked as one.
      { caller: '(local)', account: '(unknown)', status: 429, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    ]);
  } finally {
    proxy.close();
    closeUsageStore(usageStore);
  }
});

test('a stream that dies after its 200 head is booked as a 502 on the account that served it', async () => {
  // The stream is cut only once the client holds the 200 head, and the row is
  // read once the request has ended: no timers.
  /** @type {http.ServerResponse|null} */
  let upstreamRes = null;
  const upstream = http.createServer((req, res) => {
    upstreamRes = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k-a' }], 0.98);
  const usageStore = openUsageStore({ path: ':memory:' });
  /** @type {() => void} */
  let ended = () => {};
  const requestEnded = new Promise((resolve) => { ended = () => resolve(undefined); });
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, { onRequestEnd: () => ended() }, null, null, null, { usageStore });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    /** @type {any} */ (upstreamRes).destroy();
    await res.text().catch(() => {});
    // onRequestEnd fires just before the row is written, in the same tick.
    await requestEnded;
    const rows = usageRows(usageStore);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account, 'a');
    assert.equal(rows[0].status, 502);
  } finally {
    proxy.close();
    upstream.close();
    closeUsageStore(usageStore);
  }
});
