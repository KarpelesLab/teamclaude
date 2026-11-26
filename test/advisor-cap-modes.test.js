import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyRequestListener } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

// What docs/routing.md says a `maxUsage` cap on the advisor's family does when
// no other account can serve the request (#761), through the real request
// path: under "strict" it is a cap and nothing is sent, under "prefer" the
// request is routed by its main model and a pin stays where it is pinned.

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

const H = 3600_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

/** @param {http.Server} server @returns {Promise<number>} */
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)));
}

/**
 * One account, at its Fable cap, behind the proxy and a stub upstream that
 * answers 200 and records which account each request reached.
 * @param {import('node:test').TestContext} t
 * @param {'strict'|'prefer'} mode
 * @param {(h: { hits: string[], send: (path?: string) => Promise<{ status: number, text: string }> }) => Promise<void>} fn
 */
async function withCappedFleet(t, mode, fn) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  /** @type {string[]} */
  const hits = [];
  const stub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(String(req.headers.authorization).replace('Bearer t-', ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const am = new AccountManager([
    { name: 'capped', type: 'oauth', accessToken: 't-capped', refreshToken: 'r', expiresAt: Date.now() + 12 * H, maxUsage: { unified7dFable: 0.8 } },
  ], 0.98, { advisorEligibility: mode });
  Object.assign(am.accounts[0].quota, { unified7dFable: 0.85, unified7dFableReset: Date.now() + 48 * H });
  const stubPort = await listen(stub);
  const server = http.createServer(createProxyRequestListener({ accountManager: am, upstream: `http://127.0.0.1:${stubPort}`, config: { advisorEligibility: mode }, hooks: {} }));
  const port = await listen(server);
  const send = async (path = '/v1/messages') => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OPUS, max_tokens: 16, tools: [{ type: 'advisor_20260301', name: 'advisor', model: FABLE }], messages: [{ role: 'user', content: 'hi' }] }),
      signal: t.signal,
    });
    return { status: res.status, text: await res.text() };
  };
  try {
    await fn({ hits, send });
  } finally {
    server.closeAllConnections(); server.close();
    stub.closeAllConnections(); stub.close();
  }
}

test('strict: with no other account, a request whose advisor family is capped is not sent', async (t) => {
  await withCappedFleet(t, 'strict', async ({ hits, send }) => {
    const answer = await send();
    assert.equal(answer.status, 429);
    assert.match(answer.text, /No account can serve this request/);
    assert.deepEqual(hits, [], 'nothing reached the capped account');
  });
});

test('strict: a TC_ACCT pin to the capped account gets the exhausted answer', async (t) => {
  await withCappedFleet(t, 'strict', async ({ hits, send }) => {
    const answer = await send('/tc-acct/capped/v1/messages');
    assert.equal(answer.status, 429);
    assert.match(answer.text, /Pinned account is unavailable/);
    assert.deepEqual(hits, []);
  });
});

test('prefer: with no other account, the request is routed by its main model', async (t) => {
  await withCappedFleet(t, 'prefer', async ({ hits, send }) => {
    assert.equal((await send()).status, 200);
    assert.deepEqual(hits, ['capped']);
  });
});

test('prefer: a TC_ACCT pin to the capped account stays where it is pinned', async (t) => {
  await withCappedFleet(t, 'prefer', async ({ hits, send }) => {
    assert.equal((await send('/tc-acct/capped/v1/messages')).status, 200);
    assert.deepEqual(hits, ['capped']);
  });
});
