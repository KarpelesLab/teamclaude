import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// `failoverOnAnyError`: one hop on a non-2xx none of the specific branches in
// forwardRequest handles.
//
// Those branches cover the statuses whose meaning is known — 429 is quota, 403
// is the account refused, 401 is a dead credential, 5xx is the provider. An
// upstream that refuses for a reason with no branch (ChatGPT answers "the
// selected model is at capacity" this way) reached the client untouched, on an
// account that might have been the only one refusing.
//
// Bounded to one hop on purpose. A status this cannot classify is as likely the
// request's fault as the account's, and walking the fleet would turn one bad
// request into one failure per account.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 3600_000;

const accounts = () => ([
  { name: 'a', type: 'oauth', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  { name: 'b', type: 'oauth', accessToken: 't-b', refreshToken: 'r', expiresAt: Date.now() + HOUR },
  { name: 'c', type: 'oauth', accessToken: 't-c', refreshToken: 'r', expiresAt: Date.now() + HOUR },
]);

const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

async function post(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-x', messages: [] }),
  });
  return { status: res.status, body: await res.text() };
}

async function withFleet(handler, fn, amOpts = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(tokenOf(req)); handler(req, res, seen); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.98, {
    refreshFn: async () => { throw new Error('no refresh'); }, ...amOpts,
  });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

const refuse = (res, status) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ detail: 'Selected model is at capacity. Please try a different model.' }));
};

test('with the option on, an unclassified refusal hops to a sibling that can serve', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') return refuse(res, 400);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 200, 'the sibling should have served it');
    assert.deepEqual(seen, ['t-a', 't-b']);
  }, { failoverOnAnyError: true });
});

// The bound is the point: without it one malformed request becomes one failure
// per account, and every account in the pool has spent a round trip learning
// what the first one already reported.
test('the hop is bounded to one, so a refusal every account shares is not walked', async () => {
  await withFleet((req, res) => refuse(res, 400), async ({ proxyPort, seen }) => {
    const { status, body } = await post(proxyPort);
    assert.equal(status, 400, "upstream's own status reaches the client");
    assert.match(body, /at capacity/, 'and so does its message, not a proxy substitute');
    assert.equal(seen.length, 2, 'two attempts, not one per account');
  }, { failoverOnAnyError: true });
});

// Off is the default: the handled statuses are the ones whose meaning is known,
// and a blanket hop spends a second account on errors that are not about
// accounts at all.
test('off by default: an unclassified refusal is returned without a hop', async () => {
  await withFleet((req, res) => refuse(res, 400), async ({ proxyPort, seen }) => {
    const { status } = await post(proxyPort);
    assert.equal(status, 400);
    assert.deepEqual(seen, ['t-a'], 'no sibling was spent');
  });
});

// A refusal is not evidence against the account, so the account it happened on
// stays in rotation: the next request may be a perfectly good one.
test('the account a refusal happened on is not taken out of rotation', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') return refuse(res, 400);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async ({ proxyPort, am }) => {
    await post(proxyPort);
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(am.isPaused(0), false);
  }, { failoverOnAnyError: true });
});

// ── A refusal reported inside a 200 ─────────────────────────────────────────

// The Responses API answers 200 and then says the request failed in an event — this is
// how "Selected model is at capacity" arrives. Every failover in this file keys on the
// status, so the refusal used to reach the client as though it were the answer, on an
// account that may be the only one refusing.
const sse = (...events) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const CREATED = { type: 'response.created', response: { id: 'resp_1' } };
const FAILED = { type: 'response.failed', response: { error: { message: 'Selected model is at capacity.' } } };
const ANSWER = [{ type: 'response.output_text.delta', delta: 'hi' }, { type: 'response.completed' }];

function stream(res, body) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end(body);
}

test('a failure reported inside a 200 stream hops to a sibling', async () => {
  await withFleet((req, res) => {
    if (tokenOf(req) === 't-a') return stream(res, sse(CREATED, FAILED));
    stream(res, sse(CREATED, ...ANSWER));
  }, async ({ proxyPort, seen }) => {
    const { status, body } = await post(proxyPort);
    assert.equal(status, 200);
    assert.match(body, /response\.completed/, 'the sibling\'s answer should be what the client reads');
    assert.doesNotMatch(body, /at capacity/, 'the refusal must not reach the client');
    assert.deepEqual(seen, ['t-a', 't-b']);
  }, { failoverOnAnyError: true });
});

// Bounded like every other hop here: a refusal the whole fleet shares is the provider
// talking, and walking it would spend every account to learn the same thing.
test('the in-stream hop is bounded to one', async () => {
  await withFleet((req, res) => stream(res, sse(CREATED, FAILED)), async ({ proxyPort, seen }) => {
    const { status, body } = await post(proxyPort);
    assert.equal(status, 200, 'upstream answered 200, and that is what the client gets');
    assert.match(body, /at capacity/, 'the second refusal is relayed rather than hidden');
    assert.equal(seen.length, 2, 'two attempts, not one per account');
  }, { failoverOnAnyError: true });
});

// Once output has been committed there is no retry behind it: the headers are out and
// bytes may already be on the wire, so a late failure is relayed, not re-routed.
test('a stream that already produced output is relayed, not re-routed', async () => {
  await withFleet((req, res) => stream(res, sse(CREATED, ANSWER[0], FAILED)), async ({ proxyPort, seen }) => {
    const { status, body } = await post(proxyPort);
    assert.equal(status, 200);
    assert.match(body, /at capacity/);
    assert.deepEqual(seen, ['t-a'], 'no sibling was spent on a committed stream');
  }, { failoverOnAnyError: true });
});

// Off by default, like the status-keyed hop beside it.
test('off by default: an in-stream failure is relayed without a hop', async () => {
  await withFleet((req, res) => stream(res, sse(CREATED, FAILED)), async ({ proxyPort, seen }) => {
    const { body } = await post(proxyPort);
    assert.match(body, /at capacity/);
    assert.deepEqual(seen, ['t-a']);
  });
});
