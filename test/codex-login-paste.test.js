import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { parseCodexCallback, startCodexLogin, codexCallbackHandler, listenForCallback } from '../src/codex-auth.js';

// A Codex sign-in finished by hand. OpenAI only redirects this client to
// http://localhost:1455/auth/callback, so a browser on another machine (the
// server reached over SSH) lands on a page that does not load, and the address
// in its bar is what gets pasted back. The token exchange is injected, and the
// listener runs on an ephemeral port: nothing here touches 1455 or OpenAI.

const callback = (params) => `http://localhost:1455/auth/callback?${new URLSearchParams(params)}`;

test('pasted address: the code comes out, under the right state', () => {
  assert.equal(parseCodexCallback(callback({ code: 'ac_123', scope: 'openid', state: 'st' }), 'st'), 'ac_123');
  // Some browsers hide the scheme in the address bar.
  assert.equal(parseCodexCallback(` localhost:1455/auth/callback?code=ac_123&state=st \n`, 'st'), 'ac_123');
});

test('pasted address: a state from another attempt, or none at all, is refused', () => {
  assert.throws(() => parseCodexCallback(callback({ code: 'ac', state: 'other' }), 'st'), /different sign-in attempt/);
  assert.throws(() => parseCodexCallback(callback({ code: 'ac' }), 'st'), /no state/);
});

test('pasted address: anything that is not the redirect says what to paste instead', () => {
  assert.throws(() => parseCodexCallback('ac_123', 'st'), /Paste the whole address/);
  assert.throws(() => parseCodexCallback(callback({ state: 'st' }), 'st'), /Paste the whole address/);
  // The link the TUI put on the clipboard, pasted straight back.
  assert.throws(() => parseCodexCallback('https://auth.openai.com/oauth/authorize?response_type=code&state=st', 'st'), /sign-in link itself/);
  assert.throws(() => parseCodexCallback(callback({ error: 'access_denied', error_description: 'nope', state: 'st' }), 'st'), /refused the sign-in: access_denied \(nope\)/);
});

test('pasted address: an error is reported only under the right state, and as plain text', () => {
  // An OSC 52 clipboard write smuggled into the description.
  const hostile = { error: 'denied', error_description: '\x1b]52;c;YXR0YWNr\x07\x9b2J' };
  assert.throws(() => parseCodexCallback(callback({ ...hostile, state: 'other' }), 'st'), /different sign-in attempt/);
  assert.throws(() => parseCodexCallback(callback(hostile), 'st'), /no state/);
  let message = '';
  try { parseCodexCallback(callback({ ...hostile, state: 'st' }), 'st'); } catch (e) { message = e.message; }
  assert.match(message, /refused the sign-in: denied/);
  assert.doesNotMatch(message, /[\x00-\x1f\x7f-\x9f]/);
});

test('pasted address: nothing pasted is nothing, not an error', () => {
  assert.equal(parseCodexCallback('   ', 'st'), null);
});

/** An exchange that records what it was asked and answers like the real one. */
function fakeExchange() {
  const calls = [];
  const exchange = async (args) => { calls.push(args); return { accessToken: 'at', refreshToken: 'rt', accountId: 'acct' }; };
  return { calls, exchange };
}

test('a paste completes the login, exchanged with this login\'s own verifier', async () => {
  const { calls, exchange } = fakeExchange();
  const flow = await startCodexLogin({ port: 0, exchange, timeoutMs: 0 });
  assert.equal(flow.listening, true);
  const url = new URL(flow.url);
  const state = url.searchParams.get('state');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');

  assert.throws(() => flow.submit(callback({ code: 'ac', state: 'stale' })), /different sign-in attempt/);
  assert.equal(flow.submit(callback({ code: 'ac_123', state })), true);
  assert.deepEqual(await flow.credentials, { accessToken: 'at', refreshToken: 'rt', accountId: 'acct' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].code, 'ac_123');
  const challenge = createHash('sha256').update(calls[0].codeVerifier).digest('base64url');
  assert.equal(challenge, url.searchParams.get('code_challenge'), 'PKCE: the verifier behind the challenge in the link');
});

test('port 1455 taken: the login still runs, and a paste completes it', async () => {
  const squatter = http.createServer((_req, res) => res.end());
  squatter.listen(0, '127.0.0.1');
  await once(squatter, 'listening');
  try {
    const { calls, exchange } = fakeExchange();
    const flow = await startCodexLogin({ port: squatter.address().port, exchange, timeoutMs: 0 });
    assert.equal(flow.listening, false);
    assert.match(flow.listenError.message, /is in use/);
    const state = new URL(flow.url).searchParams.get('state');
    assert.equal(flow.submit(callback({ code: 'ac_123', state })), true);
    await flow.credentials;
    assert.equal(calls[0].code, 'ac_123');
  } finally {
    squatter.close();
  }
});

test('cancelling rejects as AbortError and exchanges nothing', async () => {
  const { calls, exchange } = fakeExchange();
  const controller = new AbortController();
  const flow = await startCodexLogin({ port: 0, exchange, signal: controller.signal, timeoutMs: 0 });
  controller.abort();
  await assert.rejects(flow.credentials, { name: 'AbortError' });
  assert.equal(flow.submit(callback({ code: 'ac', state: new URL(flow.url).searchParams.get('state') })), false);
  assert.equal(calls.length, 0);
});

/** Send a raw request line and return the status line of the answer. */
async function rawRequest(port, line) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`${line}\r\n\r\n`);
  let answer = '';
  socket.on('data', d => { answer += d; });
  await once(socket, 'close');
  return answer.split('\r\n')[0];
}

test('the callback handler answers a request line URL cannot parse with 400, not an exception', async () => {
  // Called directly: the shape a lenient parser hands over.
  const res = { status: 0, writeHead(code) { this.status = code; }, end() {} };
  codexCallbackHandler('st', { resolve() {}, reject() {} })({ url: 'http://[::1' }, res);
  assert.equal(res.status, 400);

  // And over a socket, where an exception would end this process.
  const server = http.createServer(codexCallbackHandler('st', { resolve() {}, reject() {} }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    assert.match(await rawRequest(server.address().port, 'GET http://[::1 HTTP/1.0'), / 400 /);
  } finally {
    server.close();
  }
});

test('a server error after the bind fails the login instead of the process', async () => {
  const { server, code } = await listenForCallback(0, 'st');
  try {
    const failed = assert.rejects(code, /EMFILE/);
    // With no 'error' listener this emit would throw.
    server.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }));
    await failed;
  } finally {
    server.close();
  }
});
