import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// A pin names exactly one account: `/tc-acct/<name>`, TC_ACCT and an operator
// session pin all promise that the request is served by that account or not at
// all. The pinned path in forwardRequest keeps the promise for selection, but
// the three bounded failover hops (rate-limit 429, upstream 5xx/529, a failure
// reported inside a 200 stream) picked their sibling with pickAlternate and sent
// the request there through ctx.hopTo, which bypasses the pin. A pinned request
// that met any of those answers was served by an account nobody chose.
//
// Each test pins account `a`, makes `a` answer with one of the hop triggers,
// and asserts that `b` never sees the request and that the client gets `a`'s
// own answer, as it would on a one-account fleet.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 3600_000;
const SID = 'sess-pin-no-alternate';

const accounts = () => ([
  { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + HOUR },
]);

const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

/** @param {number} port @param {string} path @param {Record<string, string>} [headers] */
async function post(port, path, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': SID, ...headers },
    body: JSON.stringify({ model: 'claude-x', messages: [], stream: true }),
  });
  return { status: res.status, body: await res.text() };
}

async function withFleet(handler, fn) {
  /** @type {string[]} */
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    seen.push(tokenOf(req));
    handler(req, res);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.98, { refreshFn: async () => { throw new Error('no refresh'); } });
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

// `a` answers with the trigger, `b` would answer 200: a leak shows as a 200.
const onlyAFails = (fail) => (req, res) => {
  if (tokenOf(req) === 't-a') return fail(res);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, served: 'b' }));
};

// Over the inline absorb cap, so a pinned request gets the 429 straight back
// instead of waiting it out on its own account.
const rateLimit = (res) => {
  res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'allowed' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }));
};
const serverError = (status) => (res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: status === 529 ? 'overloaded_error' : 'api_error', message: 'upstream' } }));
};
// Anthropic's own in-stream refusal: a 200 that opens the stream and reports
// overloaded_error as its first decisive event.
const streamFailure = (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
};

const cases = [
  ['a rate-limit 429', rateLimit, 429],
  ['an upstream 500', serverError(500), 500],
  ['an upstream 529', serverError(529), 529],
  ['a failure inside a 200 stream', streamFailure, 200],
];

for (const [what, fail, status] of cases) {
  test(`a /tc-acct/ pin is not failed over on ${what}`, async () => {
    await withFleet(onlyAFails(fail), async ({ proxyPort, seen }) => {
      const res = await post(proxyPort, '/tc-acct/a/v1/messages');
      assert.ok(!seen.includes('t-b'), `the pinned request leaked to b: upstream saw ${JSON.stringify(seen)}`);
      assert.ok(seen.length >= 1 && seen.every(t => t === 't-a'));
      assert.equal(res.status, status, "the client gets the pinned account's own answer");
      assert.doesNotMatch(res.body, /"served":"b"/);
    });
  });

  test(`an operator session pin is not failed over on ${what}`, async () => {
    await withFleet(onlyAFails(fail), async ({ am, proxyPort, seen }) => {
      am.sessionPins.set(SID, 'a');
      const res = await post(proxyPort, '/v1/messages');
      assert.ok(!seen.includes('t-b'), `the pinned session leaked to b: upstream saw ${JSON.stringify(seen)}`);
      assert.equal(res.status, status);
    });
  });
}

// The guard is on the pin, not on the hops: an unpinned request still takes its
// one hop to the idle sibling on the same triggers.
for (const [what, fail] of cases) {
  test(`an unpinned request still hops once on ${what}`, async () => {
    await withFleet(onlyAFails(fail), async ({ proxyPort, seen }) => {
      const res = await post(proxyPort, '/v1/messages');
      assert.deepEqual(seen, ['t-a', 't-b']);
      assert.equal(res.status, 200);
      assert.match(res.body, /"served":"b"/);
    });
  });
}
