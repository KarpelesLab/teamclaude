import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Node closes an idle keep-alive connection after 5s. A client pool that holds
// the same socket longer then writes to a connection the server has already
// closed, and the request dies before it reaches an upstream — observed twice
// as "error sending request" ~130ms in, from the Codex sidecar, whose reqwest
// pool_idle_timeout defaults to 90s. The server has to outlive the pool so the
// client is always the side that closes.

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

test('the server outlives the longest client connection pool', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const server = createProxyServer(am, { proxy: {} });
  try {
    assert.ok(server.keepAliveTimeout > 90_000,
      `keepAliveTimeout ${server.keepAliveTimeout}ms must exceed reqwest's 90s default pool idle`);
    assert.notEqual(server.keepAliveTimeout, 5000, 'the Node default is the bug');
  } finally {
    server.close();
  }
});

test('headersTimeout is left at its default, since it does not bound the idle gap', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  const server = createProxyServer(am, { proxy: {} });
  try {
    // Measured: with keepAlive 3s and headers 1.5s the socket still survived to
    // ~4s, so headersTimeout governs an in-progress request's headers only.
    // Raising it would weaken a slowloris bound for no benefit here.
    assert.equal(server.headersTimeout, 60_000);
  } finally {
    server.close();
  }
});
