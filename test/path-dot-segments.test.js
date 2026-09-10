import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyRequestListener, hasDotSegment } from '../src/server.js';
import { classificationPath } from '../src/classification-path.js';

// Every path classification in the listener is a prefix test on the path as
// sent, while the upstream URL is normalised afterwards — so a dot-segment
// passes the check as one path and reaches upstream as another (#285). The
// listener refuses such a path before any classification runs.

test('hasDotSegment catches every spelling the URL parser would resolve', () => {
  for (const p of [
    '/backend-api/codex/../conversations',
    '/backend-api/codex/%2e%2e/conversations',
    '/backend-api/codex/%2E%2E/conversations',
    '/v1/messages/../../api/oauth/profile',
    '/v1/messages/./count_tokens',
    '/v1/messages/%2e/count_tokens',
    '/backend-api/codex\\..\\conversations',      // backslash is a slash to the parser
    '/tc-acct/a/../v1/messages',
    '/v1/..',
  ]) assert.equal(hasDotSegment(p), true, p);
});

test('hasDotSegment leaves ordinary paths alone', () => {
  for (const p of [
    '/v1/messages',
    '/v1/messages/count_tokens',
    '/v1/messages?x=..',                           // query, not path
    '/api/oauth/files/a.b.c',                      // dots inside a segment
    '/v1/code/sessions/abc/worker/events/stream',
    '/backend-api/codex/responses',
    '/tc-acct/%/v1/messages',                      // undecodable pin segment stays as sent
    '/a/...',                                      // three dots is a plain segment
    '', null, undefined,
  ]) assert.equal(hasDotSegment(p), false, String(p));
});

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

function rawRequest(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

// The listener must answer 400 itself: upstream is never reached and the
// account manager is never consulted, on either boundary the issue names.
test('a dot-segment path is refused before the Codex or relay boundary is classified', async () => {
  let upstreamHits = 0;
  const { server: upstream, port: upstreamPort } = await listen((req, res) => { upstreamHits++; res.writeHead(200); res.end('{}'); });
  const accountManager = { getActiveAccount() { throw new Error('must not select an account'); } };
  const listener = createProxyRequestListener({ accountManager, upstream: `http://127.0.0.1:${upstreamPort}` });
  const { server: proxy, port } = await listen(listener);
  try {
    for (const path of [
      '/backend-api/codex/../conversations',
      '/backend-api/codex/%2e%2e/conversations',
      '/v1/messages/../../api/oauth/profile',
    ]) {
      // http.request, not fetch: fetch resolves the dot-segments client-side
      // and would send the normalised path, which is not what a probe sends.
      const { status, body } = await rawRequest(port, path);
      assert.equal(status, 400, path);
      assert.equal(JSON.parse(body).error.type, 'invalid_request_error', path);
    }
    assert.equal(upstreamHits, 0, 'upstream never saw a dot-segment request');
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});

// ── percent-encoded spellings ────────────────────────────────────────────────
//
// Splitting the path on its literal separators and decoding the pieces
// afterwards can promote a segment to `..`, but it can never re-split one. So a
// traversal that hides its own separator behind `%2f` passed the guard as a
// single ordinary segment, while the server that resolved the forwarded path
// saw two. Classification reads the decoded path instead.

test('a dot-segment hidden behind an encoded separator is still a dot-segment', () => {
  for (const p of [
    '/v1/messages/..%2f..%2fapi/oauth/profile',
    '/v1/messages/..%2F..%2Fapi/oauth/profile',   // the escape is case-insensitive
    '/backend-api/codex/..%2fconversations',
    '/v1/messages/.%2fcount_tokens',
    '/a/%2e%2e%2fb',
    '/v1/..%2f',
  ]) assert.equal(hasDotSegment(p), true, p);
});

// One decode deep, which is the depth a receiving server applies to the target
// it routes on. `%252e%252e` decodes to the literal `%2e%2e` — an ordinary
// segment that traverses nothing — so refusing it would reject a path that is
// perfectly well formed.
test('a double-encoded dot-segment is a literal segment, not a traversal', () => {
  for (const p of [
    '/a/%252e%252e/b',
    '/v1/messages/..%252f..%252fapi/oauth/profile',
    '/backend-api/codex/%252e%252e/conversations',
    '/a/%255c..%255cb',                            // a literal `%5c`, not a separator
  ]) assert.equal(hasDotSegment(p), false, p);
});

// A malformed escape has no decoded form and leaves the WHOLE path undecodable,
// though only the one segment is at fault. The rest are still read decoded, so a
// stray '%' cannot shield an encoding sitting beside it.
test('an undecodable segment does not hide an encoded dot-segment beside it', () => {
  assert.equal(hasDotSegment('/tc-acct/%zz/..%2fapi/oauth/profile'), true);
  assert.equal(hasDotSegment('/tc-acct/%/a/%2e%2e/b'), true);
});

test('classificationPath decodes exactly once and drops query and fragment', () => {
  assert.equal(classificationPath('/%61pi/oauth/profile'), '/api/oauth/profile');
  assert.equal(classificationPath('/api/oauth%2fprofile'), '/api/oauth/profile');
  assert.equal(classificationPath('/v1/messages?model=%2e%2e'), '/v1/messages');
  assert.equal(classificationPath('/v1/messages#%2e%2e'), '/v1/messages');
  assert.equal(classificationPath('/a/%252e%252e/b'), '/a/%2e%2e/b');
  // Undecodable as sent, and the segments around it decoded anyway.
  assert.equal(classificationPath('/tc-acct/%/v1/messages'), '/tc-acct/%/v1/messages');
  assert.equal(classificationPath('/tc-acct/%/%61pi'), '/tc-acct/%/api');
  assert.equal(classificationPath(''), '');
  assert.equal(classificationPath(null), '');
  assert.equal(classificationPath(undefined), '');
});

// The same oracle as the literal-spelling refusal above, for the spellings that
// encode the separator: the listener answers 400 itself, so no account is
// selected and nothing is forwarded on either boundary.
test('an encoded dot-segment is refused before any classification runs', async () => {
  let upstreamHits = 0;
  const { server: upstream, port: upstreamPort } = await listen((req, res) => { upstreamHits++; res.writeHead(200); res.end('{}'); });
  const accountManager = { getActiveAccount() { throw new Error('must not select an account'); } };
  const listener = createProxyRequestListener({ accountManager, upstream: `http://127.0.0.1:${upstreamPort}` });
  const { server: proxy, port } = await listen(listener);
  try {
    for (const path of [
      '/v1/messages/..%2f..%2fapi/oauth/profile',
      '/backend-api/codex/..%2fconversations',
      '/v1/messages/.%2fcount_tokens',
    ]) {
      const { status, body } = await rawRequest(port, path);
      assert.equal(status, 400, path);
      assert.equal(JSON.parse(body).error.type, 'invalid_request_error', path);
    }
    assert.equal(upstreamHits, 0, 'upstream never saw a dot-segment request');
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});

// ── the separator spelling ───────────────────────────────────────────────────
//
// A backslash is a separator to the WHATWG URL parser for http(s), so
// `new URL()` folds it while building the outgoing target — in this process,
// before anything is sent. A literal one was already caught here; an encoded
// one was not, because it only becomes a separator once it is decoded.

test('an encoded backslash separator carries a dot-segment like a literal one', () => {
  for (const p of [
    '/backend-api/codex/..%5cconversations',
    '/backend-api/codex/..%5Cconversations',
    '/v1/messages%5c..%5c..%5capi/oauth/profile',
    '/v1/messages/.%5ccount_tokens',
    '/a/%5c..%5cb',
  ]) assert.equal(hasDotSegment(p), true, p);
});

// Decode first, then fold: `%5c` is only a backslash once decoded, so folding
// first would leave it encoded and unseen. The order also keeps the decoding one
// level deep — `%255c` decodes to a literal `%5c` and stays inside its segment.
test('classificationPath folds a backslash separator after decoding, not before', () => {
  assert.equal(classificationPath('/api\\oauth\\profile'), '/api/oauth/profile');
  assert.equal(classificationPath('/%61pi%5coauth/profile'), '/api/oauth/profile');
  assert.equal(classificationPath('/backend-api%5Ccodex/responses'), '/backend-api/codex/responses');
  assert.equal(classificationPath('/api/%255coauth/profile'), '/api/%5coauth/profile');
});
