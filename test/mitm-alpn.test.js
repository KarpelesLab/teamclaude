import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectHandler } from '../src/mitm.js';

// A WebSocket over HTTP/2 needs RFC 8441 extended CONNECT, which this proxy does
// not relay — so a client that negotiates h2 has its Upgrade dropped with no
// error anywhere. Remote Control then reports itself connected and delivers
// nothing, which is why #164 presented as "messages stay grey" rather than as a
// failure. mitm.http1Only takes h2 off the table so the Upgrade reaches the
// relay.

function handlerFor(config) {
  return createConnectHandler({
    config,
    accountManager: { accounts: [], getActiveAccount: () => null },
    ensureLeaf: async () => ({ key: 'k', cert: 'c' }),
    log: () => {},
  });
}

test('the option is off unless asked for, and is read from config', () => {
  // Construction alone must not throw either way; the ALPN choice is internal,
  // so this pins the config plumbing rather than the socket.
  assert.equal(typeof handlerFor({ upstream: 'https://api.anthropic.com' }), 'function');
  assert.equal(typeof handlerFor({ upstream: 'https://api.anthropic.com', mitm: { http1Only: true } }), 'function');
});

test('only an explicit true turns it on', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/mitm.js', import.meta.url), 'utf8');
  // Strict equality, so a stray "false"/"0"/"" string in a hand-edited config
  // cannot silently enable it.
  assert.match(src, /config\.mitm\?\.http1Only === true/);
  assert.match(src, /ALPNProtocols: \['http\/1\.1'\]/);
});
