import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { startOAuthLogin, startCallbackServer } from '../src/oauth.js';

// A Claude sign-in has up to two redirects: the loopback listener, which only a
// browser on this machine can reach, and the console's code page, whose code is
// pasted back from any device. The exchange must name the redirect the code
// was issued for, so these pin which one each answer is exchanged under. The
// exchange is injected; nothing here reaches Anthropic.

const MANUAL = 'https://console.anthropic.com/oauth/code/callback';

// The flow narrates its exchange step on the console, for the CLI and the
// TUI's activity pane; here it is only noise.
console.log = () => {};

function fakeExchange() {
  const calls = [];
  const exchange = async (code, state, verifier, redirectUri) => {
    calls.push({ code, state, verifier, redirectUri });
    return { accessToken: 'at', refreshToken: 'rt', expiresAt: 1 };
  };
  return { calls, exchange };
}

/** Whether something accepts connections on 127.0.0.1:port. A raw socket, so
 *  no proxy configuration can answer in the listener's place. */
async function accepting(port) {
  const socket = net.connect(port, '127.0.0.1');
  try {
    await Promise.race([once(socket, 'connect'), once(socket, 'error').then(([e]) => { throw e; })]);
    return true;
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

const params = url => new URL(url).searchParams;

test('remote: no listener, the code page only, and its pasted code#state exchanged under it', async () => {
  const { calls, exchange } = fakeExchange();
  const flow = await startOAuthLogin({ loopback: false, exchange, timeoutMs: 0 });
  assert.equal(flow.browserUrl, null);
  assert.equal(params(flow.url).get('redirect_uri'), MANUAL);
  const state = params(flow.url).get('state');

  assert.equal(flow.submit(`ac_123#${state}`), true);
  await flow.tokens;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].code, 'ac_123');
  assert.equal(calls[0].state, state);
  assert.equal(calls[0].redirectUri, MANUAL);
  assert.equal(createHash('sha256').update(calls[0].verifier).digest('base64url'), params(flow.url).get('code_challenge'));
});

test('local: the two URLs share one challenge and state, and the browser\'s redirect wins under the loopback', async () => {
  const { calls, exchange } = fakeExchange();
  const flow = await startOAuthLogin({ loopback: true, exchange, timeoutMs: 0 });
  const loopback = params(flow.browserUrl).get('redirect_uri');
  assert.match(loopback, /^http:\/\/localhost:\d+\/callback$/);
  assert.equal(params(flow.url).get('redirect_uri'), MANUAL, 'the URL a person is handed is the code page');
  assert.equal(params(flow.browserUrl).get('state'), params(flow.url).get('state'));
  assert.equal(params(flow.browserUrl).get('code_challenge'), params(flow.url).get('code_challenge'));

  const port = Number(new URL(loopback).port);
  const res = await fetch(`http://127.0.0.1:${port}/callback?code=ac_cb&state=${params(flow.url).get('state')}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  await flow.tokens;
  assert.deepEqual(calls.map(c => [c.code, c.redirectUri]), [['ac_cb', loopback]]);
  assert.equal(flow.submit('ac_late'), false, 'a paste after the browser won is ignored');
  assert.equal(await accepting(port), false, 'the listener is closed once the race is decided');
});

test('local: a pasted code-page code wins under the code page, and the listener closes', async () => {
  const { calls, exchange } = fakeExchange();
  const flow = await startOAuthLogin({ loopback: true, exchange, timeoutMs: 0 });
  const port = Number(new URL(params(flow.browserUrl).get('redirect_uri')).port);
  assert.equal(await accepting(port), true);
  flow.submit(`ac_paste#${params(flow.url).get('state')}`);
  await flow.tokens;
  assert.deepEqual(calls.map(c => [c.code, c.redirectUri]), [['ac_paste', MANUAL]]);
  assert.equal(await accepting(port), false);
});

test('local: a pasted loopback address is exchanged under the loopback', async () => {
  const { calls, exchange } = fakeExchange();
  const flow = await startOAuthLogin({ loopback: true, exchange, timeoutMs: 0 });
  const loopback = params(flow.browserUrl).get('redirect_uri');
  flow.submit(`${loopback}?code=ac_addr&state=${params(flow.url).get('state')}`);
  await flow.tokens;
  assert.deepEqual(calls.map(c => [c.code, c.redirectUri]), [['ac_addr', loopback]]);
});

test('local: a loopback address pasted without its scheme is still the loopback\'s', async () => {
  const { calls, exchange } = fakeExchange();
  const flow = await startOAuthLogin({ loopback: true, exchange, timeoutMs: 0 });
  const loopback = params(flow.browserUrl).get('redirect_uri');
  flow.submit(`${loopback.replace('http://', '')}?code=ac_bare&state=${params(flow.url).get('state')}`);
  await flow.tokens;
  assert.deepEqual(calls.map(c => [c.code, c.redirectUri]), [['ac_bare', loopback]]);
});

test('a paste missing its state is refused before the exchange, in either form', async () => {
  const { calls, exchange } = fakeExchange();
  const flow = await startOAuthLogin({ loopback: true, exchange, timeoutMs: 0 });
  const loopback = params(flow.browserUrl).get('redirect_uri');
  assert.throws(() => flow.submit('ac_123#'), /not the whole code/);
  assert.throws(() => flow.submit(`${loopback}?code=ac_123`), /no state/);
  assert.equal(calls.length, 0);
  flow.submit(`ac_ok#${params(flow.url).get('state')}`);
  await flow.tokens;
});

test('a wrong paste is refused with a reason and the login keeps waiting', async () => {
  const { calls, exchange } = fakeExchange();
  const flow = await startOAuthLogin({ loopback: false, exchange, timeoutMs: 0 });
  // The link itself, pasted back from the clipboard: it carries `code=true`,
  // which must not be sent as a code.
  assert.throws(() => flow.submit(flow.url), /sign-in link itself/);
  assert.throws(() => flow.submit('ac#another-state'), /different sign-in attempt/);
  assert.equal(calls.length, 0);
  assert.equal(flow.submit(`ac_ok#${params(flow.url).get('state')}`), true);
  await flow.tokens;
  assert.equal(calls[0].code, 'ac_ok');
});

test('cancelling rejects as AbortError, exchanges nothing, and closes the listener', async () => {
  const { calls, exchange } = fakeExchange();
  const controller = new AbortController();
  const flow = await startOAuthLogin({ loopback: true, exchange, signal: controller.signal, timeoutMs: 0 });
  const port = Number(new URL(params(flow.browserUrl).get('redirect_uri')).port);
  controller.abort();
  await assert.rejects(flow.tokens, { name: 'AbortError' });
  assert.equal(calls.length, 0);
  assert.equal(await accepting(port), false);
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

test('the loopback listener answers a request line URL cannot parse with 400, and keeps waiting', async () => {
  const { port, codePromise, server } = await startCallbackServer('st');
  try {
    assert.match(await rawRequest(port, 'GET http://[::1 HTTP/1.0'), / 400 /);
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=ac&state=st`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(await codePromise, 'ac');
  } finally {
    server.close();
  }
});

test('the loopback listener: a server error after the bind fails the login, and provider text is plain', async () => {
  const one = await startCallbackServer('st');
  try {
    const failed = assert.rejects(one.codePromise, /EMFILE/);
    one.server.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }));
    await failed;
  } finally {
    one.server.close();
  }
  const two = await startCallbackServer('st');
  try {
    const failed = assert.rejects(two.codePromise, err => /OAuth error: denied/.test(err.message) && !/[\x00-\x1f\x7f-\x9f]/.test(err.message));
    await fetch(`http://127.0.0.1:${two.port}/callback?error=denied&error_description=${encodeURIComponent('\x1b]52;c;YXR0YWNr\x07')}&state=st`);
    await failed;
  } finally {
    two.server.close();
  }
});
