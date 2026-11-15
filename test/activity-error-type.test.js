import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { upstreamErrorType, statusLabel } from '../src/error-type.js';

// A request line that ends in a bare 404 does not say why. For a non-2xx
// response the line now names the upstream's error type, and nothing else from
// the body: the body can quote the conversation.

const body = (/** @type {unknown} */ v) => Buffer.from(JSON.stringify(v));

test('the type comes from details.error_code, then error.type', () => {
  assert.equal(upstreamErrorType(body({ type: 'error', error: { type: 'not_found_error', message: 'No thread state', details: { error_code: 'thread_not_found' } } })), 'thread_not_found');
  assert.equal(upstreamErrorType(body({ type: 'error', error: { type: 'rate_limit_error', message: 'x' } })), 'rate_limit_error');
  assert.equal(upstreamErrorType(body({ type: 'error', error: { type: 'overloaded_error' } })), 'overloaded_error');
  assert.equal(upstreamErrorType(body({ type: 'error', error: { type: 'invalid_request_error', details: { error_code: 5 } } })), 'invalid_request_error', 'a non-string code is skipped');
});

test('no type, no label', () => {
  assert.equal(upstreamErrorType(null), null);
  assert.equal(upstreamErrorType(Buffer.alloc(0)), null);
  assert.equal(upstreamErrorType(Buffer.from('<html>502 Bad Gateway</html>')), null);
  assert.equal(upstreamErrorType(body({ detail: 'a bare Codex detail' })), null);
  assert.equal(upstreamErrorType(body({ error: 'text' })), null);
  assert.equal(upstreamErrorType(body([])), null);
});

test('only a short identifier gets through, never prose from the body', () => {
  assert.equal(upstreamErrorType(body({ error: { type: 'Please summarise my private notes' } })), null);
  assert.equal(upstreamErrorType(body({ error: { type: 'bad\nTHREAD', details: { error_code: 'x y' } } })), null);
  assert.equal(upstreamErrorType(body({ error: { type: '\x1b[2Jerror' } })), null);
  assert.equal(upstreamErrorType(body({ error: { type: 'a'.repeat(100) } })), 'a'.repeat(32));
  assert.equal(upstreamErrorType(body({ error: { type: '' } })), null);
});

test('the status label adds the type only when there is one', () => {
  assert.equal(statusLabel(404, 'thread_not_found'), '404 thread_not_found');
  assert.equal(statusLabel(200, null), '200');
  assert.equal(statusLabel(404, undefined), '404');
});

const listen = (/** @type {http.Server} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(/** @type {any} */ (s.address()).port)));

async function requestEnd(/** @type {(res: http.ServerResponse) => void} */ respond) {
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => respond(res)); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k-a' }], 0.98);
  const ends = [];
  const hooks = { onRequestEnd: (/** @type {any} */ _id, /** @type {any} */ info) => ends.push(info) };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` }, hooks);
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify({ model: 'claude-x', messages: [] }),
    });
    const text = await res.text();
    return { info: /** @type {any} */ (ends.at(-1)), status: res.status, text };
  } finally {
    proxy.close();
    upstream.close();
  }
}

const json = (/** @type {number} */ status, /** @type {unknown} */ payload, /** @type {Record<string, string>} */ headers = {}) =>
  (/** @type {http.ServerResponse} */ res) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(payload)); };

test('a 404 thread_not_found says so, and the client gets the same bytes', async () => {
  const payload = { type: 'error', error: { type: 'not_found_error', message: 'No thread state', details: { error_code: 'thread_not_found' } } };
  const { info, status, text } = await requestEnd(json(404, payload, { 'content-type': 'application/json; charset=utf-8' }));
  assert.equal(info.status, 404);
  assert.equal(info.errorType, 'thread_not_found');
  assert.equal(status, 404);
  assert.equal(text, JSON.stringify(payload));
});

for (const [code, type, headers] of /** @type {const} */ ([
  [400, 'invalid_request_error', {}],
  [429, 'rate_limit_error', { 'x-should-retry': 'false' }],  // relayed as sent; a throttle the proxy absorbs or answers itself is not the upstream's body
  [529, 'overloaded_error', {}],
])) {
  test(`a ${code} names ${type}`, async () => {
    const { info } = await requestEnd(json(code, { type: 'error', error: { type, message: 'm' } }, headers));
    assert.equal(info.status, code);
    assert.equal(info.errorType, type);
  });
}

test('a non-JSON or empty error leaves the line as it was', async () => {
  const html = await requestEnd((res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>Bad Gateway</html>'); });
  assert.equal(html.info.status, 502);
  assert.equal(html.info.errorType ?? null, null);
  const empty = await requestEnd((res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(); });
  assert.equal(empty.info.errorType ?? null, null);
  const mislabeled = await requestEnd((res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end(JSON.stringify({ error: { type: 'not_found_error' } })); });
  assert.equal(mislabeled.info.errorType ?? null, null);
});

test('a 2xx is never labelled, whatever its body holds', async () => {
  const { info } = await requestEnd(json(200, { type: 'message', error: { type: 'not_found_error' }, usage: { input_tokens: 1 } }));
  assert.equal(info.status, 200);
  assert.equal(info.errorType ?? null, null);
});

test('a body past the inspection limit is relayed whole and not labelled', async () => {
  const payload = { error: { type: 'not_found_error' }, pad: 'x'.repeat(70 * 1024) };
  const { info, text } = await requestEnd(json(404, payload));
  assert.equal(info.errorType ?? null, null);
  assert.equal(text, JSON.stringify(payload));
});

test('the conversation text in an error body does not reach the hook', async () => {
  const secret = 'MY-PRIVATE-DIARY-ENTRY';
  const { info } = await requestEnd(json(400, { type: 'error', error: { type: 'invalid_request_error', message: `messages.0: ${secret}` } }));
  assert.equal(info.errorType, 'invalid_request_error');
  assert.doesNotMatch(JSON.stringify(info), new RegExp(secret));
});
