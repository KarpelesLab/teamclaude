import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { priceUsage, priceKey } from '../src/anthropic-pricing.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The local source of accounts[].credit: with no admin key, the proxy prices
// every reply it serves on the account from the reply's own usage block and
// keeps the running sum, across restarts. Prices are the pricing page's, read
// 2026-11-06 (see src/anthropic-pricing.js); the expected figures below are
// worked out by hand from that table, in US cents.

const close = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 1e-9;
const DAY = 86_400_000;
// The anchor sits ten days back, so the cycle boundary is weeks from any run.
const anchorDate = () => new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10);

test('price keys: dated snapshots, context suffixes and -0 aliases fold onto the table row', () => {
  assert.equal(priceKey('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(priceKey('claude-opus-4-5-20251101'), 'claude-opus-4-5');
  assert.equal(priceKey('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(priceKey('Claude-Sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(priceKey('claude-opus-4-0'), 'claude-opus-4');
  assert.equal(priceKey(''), null);
  assert.equal(priceKey(null), null);
});

test('a reply is priced per token type, the 5m and 1h cache writes apart', () => {
  // Opus 5.5: $4 in, $20 out, $5 5m write, $8 1h write, $0.20 read, per MTok.
  const got = priceUsage('claude-opus-5-5', {
    input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100_000,
    cache_creation_input_tokens: 6000, cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 2000 },
  });
  // (1000*4 + 2000*20 + 100000*0.2 + 4000*5 + 2000*8) / 1e6 = $0.10
  assert.equal(got.ok, true);
  assert.ok(close(got.costMinor, 10), String(got.costMinor));
});

test('cache-creation tokens the split leaves out are priced at the 5-minute rate', () => {
  const got = priceUsage('claude-sonnet-5-5', { cache_creation_input_tokens: 1_000_000 });
  assert.ok(got.ok && close(got.costMinor, 250)); // $2.50 per MTok
});

test('fast mode, US-only inference, batch and web search each move the price as documented', () => {
  const base = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
  // Fast Opus 5.5: $8 in, $40 out, and the 0.05x read multiplier on the fast input price.
  const fast = priceUsage('claude-opus-5-5', { ...base, speed: 'fast' });
  assert.ok(fast.ok && close(fast.costMinor, (8 + 40 + 0.4) * 100), String(fast.ok && fast.costMinor));
  const us = priceUsage('claude-sonnet-5-5', { ...base, inference_geo: 'us' });
  assert.ok(us.ok && close(us.costMinor, (2 + 10 + 0.1) * 1.1 * 100));
  const batch = priceUsage('claude-sonnet-5-5', { ...base, service_tier: 'batch' });
  assert.ok(batch.ok && close(batch.costMinor, (2 + 10 + 0.1) * 0.5 * 100));
  const search = priceUsage('claude-sonnet-5-5', { server_tool_use: { web_search_requests: 3, web_fetch_requests: 9 } });
  assert.ok(search.ok && close(search.costMinor, 3)); // $10 per 1,000 searches; fetch is free
});

test('Haiku 5.5 over 100,000 prompt tokens pays the long-context row for the whole request', () => {
  const short = priceUsage('claude-haiku-5-5', { input_tokens: 50_000, cache_read_input_tokens: 50_000, output_tokens: 1000 });
  assert.ok(short.ok && close(short.costMinor, (50_000 * 0.1 + 50_000 * 0.01 + 1000 * 0.5) / 1e6 * 100));
  const long = priceUsage('claude-haiku-5-5', { input_tokens: 50_000, cache_read_input_tokens: 50_001, output_tokens: 1000 });
  assert.ok(long.ok && close(long.costMinor, (50_000 * 0.5 + 50_001 * 0.05 + 1000 * 2.5) / 1e6 * 100));
});

test('an unknown model, a fast reply without a fast price, and Priority Tier are unpriced, never zero', () => {
  for (const [model, usage, reason] of [
    ['claude-nonexistent-9', { input_tokens: 10 }, /no price/],
    ['claude-sonnet-5-5', { input_tokens: 10, speed: 'fast' }, /fast-mode/],
    ['claude-opus-5-5', { input_tokens: 10, service_tier: 'priority' }, /Priority/],
  ]) {
    const got = priceUsage(model, usage);
    assert.equal(got.ok, false, model);
    assert.equal(got.model, model);
    assert.match(got.reason, reason);
    assert.ok(!('costMinor' in got));
  }
});

// ----- through the real proxy -----

const listen = (/** @type {http.Server} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(/** @type {any} */ (s.address()).port)));

function creditManager(/** @type {Record<string, any>} */ credit = {}) {
  const log = console.log;
  console.log = () => {};
  try {
    return new AccountManager([{ name: 'credit-key', type: 'apikey', apiKey: 'sk-ant-api03-k', credit: { amount: 200, cycleStart: anchorDate(), ...credit } }], 0.98);
  } finally { console.log = log; }
}

/**
 * Serve `replies` from a stub upstream through a real proxy on `am`, one
 * request per reply, and wait for each response to end. The usage record is
 * written before the proxy ends the client's response (streamResponse's
 * finally, extractUsageFromBody before res.end), so no wait follows.
 * @param {AccountManager} am
 * @param {Array<{ model: string, stream?: boolean, body?: any, events?: any[] }>} replies
 */
async function serve(am, replies) {
  let i = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const r = replies[i++];
    if (r.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of r.events || []) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    }
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    for (const r of replies) {
      await new Promise((resolve, reject) => {
        const rq = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } },
          (res) => { res.on('data', () => {}); res.on('end', resolve); });
        rq.on('error', reject);
        rq.end(JSON.stringify({ model: r.model, stream: !!r.stream, max_tokens: 10, messages: [] }));
      });
    }
  } finally {
    proxy.close();
    upstream.close();
  }
}

const NON_STREAMED = {
  model: 'claude-opus-5-5',
  body: {
    type: 'message', id: 'msg_1', model: 'claude-opus-5-5', content: [],
    usage: {
      input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 6000, cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 2000 },
    },
  },
};
// 10 cents, as above.
const NON_STREAMED_CENTS = 10;

const STREAMED = {
  model: 'claude-sonnet-5-5',
  stream: true,
  events: [
    { type: 'message_start', message: { id: 'msg_2', usage: {
      input_tokens: 500, output_tokens: 1, cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 10_000, cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 0 },
    } } },
    // Cumulative for the message: supersedes the placeholder 1 above.
    { type: 'message_delta', usage: { output_tokens: 3000 } },
    { type: 'message_stop' },
  ],
};
// Sonnet 5.5: (500*2 + 3000*10 + 200000*0.1 + 10000*2.5) / 1e6 = $0.076
const STREAMED_CENTS = 7.6;

test('a non-streamed and a streamed reply are both priced into the local estimate, cache tokens included', async () => {
  const am = creditManager();
  const a = am.accounts[0];
  await serve(am, [NON_STREAMED]);
  assert.ok(a.creditState.local, 'the reply never reached the credit ledger, so this proves nothing');
  assert.ok(close(a.creditState.local.spentMinor, NON_STREAMED_CENTS), String(a.creditState.local.spentMinor));
  await serve(am, [STREAMED]);
  assert.ok(close(a.creditState.local.spentMinor, NON_STREAMED_CENTS + STREAMED_CENTS), String(a.creditState.local.spentMinor));
  const credit = am.creditStatus(a);
  assert.equal(credit.source, 'local');
  assert.equal(credit.estimate, true);
  assert.equal(credit.upperBound, true);
  assert.equal(credit.replies, 2);
  assert.equal(credit.spentMinor, 18); // 17.6 cents, rounded
  assert.equal(credit.remainingMinor, 20000 - 18);
  assert.equal(credit.incomplete, null);
  assert.equal(credit.error, null);
  assert.ok(credit.asOf && credit.trackedSince && credit.lastReplyAt);
});

test('a reply on a model the table does not know marks the estimate incomplete, naming the model', async () => {
  const am = creditManager();
  const a = am.accounts[0];
  await serve(am, [NON_STREAMED, { ...NON_STREAMED, model: 'claude-nonexistent-9' }, { ...NON_STREAMED, model: 'claude-nonexistent-9' }]);
  const credit = am.creditStatus(a);
  assert.equal(credit.replies, 3);
  assert.equal(credit.spentMinor, NON_STREAMED_CENTS, 'the unknown model was priced at something');
  assert.deepEqual(credit.incomplete, { replies: 2, models: [{ model: 'claude-nonexistent-9', replies: 2, reason: 'no price for this model' }] });
});

test('the local estimate survives a restart', async () => {
  const am = creditManager();
  await serve(am, [NON_STREAMED, STREAMED, { ...NON_STREAMED, model: 'claude-nonexistent-9' }]);
  const before = am.creditStatus(am.accounts[0]);
  // What index.js writes to the state file and reads back at the next start.
  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));
  const restarted = creditManager();
  assert.equal(restarted.creditStatus(restarted.accounts[0]).spentMinor, 0, 'a fresh manager already held the spend');
  restarted.restoreQuotaState(saved);
  const after = restarted.creditStatus(restarted.accounts[0]);
  assert.ok(close(restarted.accounts[0].creditState.local.spentMinor, NON_STREAMED_CENTS + STREAMED_CENTS));
  for (const k of ['spentMinor', 'remainingMinor', 'replies', 'trackedSince', 'lastReplyAt', 'cycleStart', 'cycleEnd']) {
    assert.deepEqual(after[k], before[k], k);
  }
  assert.deepEqual(after.incomplete, before.incomplete);
  // And it keeps counting from there.
  await serve(restarted, [NON_STREAMED]);
  assert.ok(close(restarted.accounts[0].creditState.local.spentMinor, 2 * NON_STREAMED_CENTS + STREAMED_CENTS));
});

test('a ledger from an earlier cycle is not restored as this cycle\'s spend', () => {
  const am = creditManager();
  const a = am.accounts[0];
  am.creditStatus(a);
  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));
  saved[0].credit.local.spentMinor = 5000;
  saved[0].credit.local.cycleStart -= 31 * DAY;
  saved[0].credit.local.cycleEnd -= 31 * DAY;
  const restarted = creditManager();
  restarted.restoreQuotaState(saved);
  assert.equal(restarted.creditStatus(restarted.accounts[0]).spentMinor, 0);
});

test('an account without a credit setting books nothing and reports no credit', async () => {
  const am = new AccountManager([{ name: 'plain', type: 'apikey', apiKey: 'k' }], 0.98);
  await serve(am, [NON_STREAMED]);
  assert.equal(am.accounts[0].creditState.local, null);
  assert.equal(am.creditStatus(am.accounts[0]), null);
  assert.ok(!('credit' in am.getStatus().accounts[0]));
  assert.ok(!('credit' in am.getQuotaSummary().accounts[0]));
});
