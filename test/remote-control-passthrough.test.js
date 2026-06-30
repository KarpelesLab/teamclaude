import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteH1Auth } from '../src/h2/relay.js';

const CRLF = '\r\n';
const head = (requestLine, headers) => [requestLine, ...headers, '', ''].join(CRLF);

const ROTATED = 'Bearer sk-ant-oat01-ROTATED';

test('rewriteH1Auth injects the account token on a normal request', () => {
  const input = head('POST /v1/messages?beta=true HTTP/1.1', [
    'host: api.anthropic.com',
    'authorization: Bearer sk-ant-oat01-CLIENT',
  ]);
  const out = rewriteH1Auth(input, { authorization: ROTATED });
  assert.match(out, /authorization: Bearer sk-ant-oat01-ROTATED/);
  assert.doesNotMatch(out, /sk-ant-oat01-CLIENT/);
});

// Remote Control's control channel (/v1/code/*) is bound to the session's paired
// claude.ai identity. If the rotated account's token is injected, the upstream
// rejects the worker event stream with 403 and Remote Control drops. The proxy
// must leave these requests untouched so Claude's own credential reaches the server.
test('rewriteH1Auth passes Remote Control (/v1/code/*) through untouched', () => {
  const input = head('GET /v1/code/sessions/cse_abc/worker/events/stream HTTP/1.1', [
    'host: api.anthropic.com',
    'authorization: Bearer sk-ant-oat01-CLIENT',
  ]);
  const out = rewriteH1Auth(input, { authorization: ROTATED });
  assert.equal(out, input);
  assert.match(out, /sk-ant-oat01-CLIENT/);
  assert.doesNotMatch(out, /ROTATED/);
});
