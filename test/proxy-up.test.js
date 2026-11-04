import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { isProxyUp } from '../src/proxy-up.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('the liveness probe uses the configured bind host', async () => {
  const server = net.createServer();
  const port = await listen(server);
  try {
    assert.equal(await isProxyUp(port, '127.0.0.1'), true);
    assert.equal(await isProxyUp(port, '192.0.2.1'), false, 'loopback is not consulted when the bind host differs');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
