import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectAuthorized } from '../src/mitm.js';
import { safeKeyEqual, isLoopbackAddr } from '../src/server.js';

// The CONNECT auth gate is the fix for the unauthenticated-MITM token-theft /
// open-relay hole: without it, a remote client can CONNECT api.anthropic.com and
// have an account token injected, or blind-tunnel anywhere.

const sock = (remoteAddress) => ({ remoteAddress });
const req = (auth) => ({ headers: auth ? { 'proxy-authorization': auth } : {} });

test('no proxy key configured → CONNECT is open (matches the HTTP path)', () => {
  assert.equal(connectAuthorized(req(), sock('203.0.113.9'), null), true);
});

test('loopback clients are exempt even when a key is set', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(connectAuthorized(req(), sock(a), 'secret'), true, a);
  }
});

test('a remote client with no Proxy-Authorization is denied', () => {
  assert.equal(connectAuthorized(req(), sock('203.0.113.9'), 'secret'), false);
});

test('a remote client with the correct Bearer key is allowed', () => {
  assert.equal(connectAuthorized(req('Bearer secret'), sock('203.0.113.9'), 'secret'), true);
});

test('a remote client with a wrong key is denied', () => {
  assert.equal(connectAuthorized(req('Bearer nope'), sock('203.0.113.9'), 'secret'), false);
});

test('Basic auth carrying the key as username or password is accepted', () => {
  const asUser = 'Basic ' + Buffer.from('secret:').toString('base64');  // curl http://secret@host
  const asPass = 'Basic ' + Buffer.from('x:secret').toString('base64'); // curl http://x:secret@host
  assert.equal(connectAuthorized(req(asUser), sock('10.0.0.5'), 'secret'), true);
  assert.equal(connectAuthorized(req(asPass), sock('10.0.0.5'), 'secret'), true);
});

test('safeKeyEqual is value-correct and length/type-safe', () => {
  assert.equal(safeKeyEqual('abc', 'abc'), true);
  assert.equal(safeKeyEqual('abc', 'abd'), false);
  assert.equal(safeKeyEqual('abc', 'abcd'), false); // different length, no throw
  assert.equal(safeKeyEqual(undefined, 'abc'), false);
  assert.equal(safeKeyEqual('abc', null), false);
});

test('isLoopbackAddr recognizes the three loopback forms only', () => {
  assert.equal(isLoopbackAddr('127.0.0.1'), true);
  assert.equal(isLoopbackAddr('::1'), true);
  assert.equal(isLoopbackAddr('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddr('10.0.0.1'), false);
  assert.equal(isLoopbackAddr(undefined), false);
});
