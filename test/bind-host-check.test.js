import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// The address the server binds is `TEAMCLAUDE_HOST || proxy.host || 127.0.0.1`,
// but the DNS-rebinding Host check was handed `proxy.host` alone. Bound off-box
// through the env var, with nothing in the config, a key-less loopback caller
// naming the bind address was refused as though it named a stranger (#423).

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

function statusWithHost(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/teamclaude/status', headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the Host check accepts the address the server was actually bound to', async () => {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const config = { proxy: { apiKey: 'tc-key' }, upstream: 'http://127.0.0.1:9' };

  const plain = createProxyServer(am, config);
  const plainPort = await listen(plain);
  const bound = createProxyServer(am, config, {}, null, null, null, { bindHost: '192.168.7.5' });
  const boundPort = await listen(bound);
  try {
    assert.equal(await statusWithHost(plainPort, `192.168.7.5:${plainPort}`), 403, 'unknown to a server that did not bind it');
    assert.equal(await statusWithHost(boundPort, `192.168.7.5:${boundPort}`), 200);
    assert.equal(await statusWithHost(boundPort, `localhost:${boundPort}`), 200, 'the loopback names keep working');
    assert.equal(await statusWithHost(boundPort, `attacker.example:${boundPort}`), 403, 'a rebound name is still refused');
  } finally {
    plain.closeAllConnections?.(); plain.close();
    bound.closeAllConnections?.(); bound.close();
  }
});
