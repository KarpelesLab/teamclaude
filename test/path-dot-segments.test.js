import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyRequestListener, hasDotSegment } from '../src/server.js';

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
