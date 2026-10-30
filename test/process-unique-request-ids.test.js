import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyRequestListener } from '../src/server.js';

// The internal request id keys the activity hooks: the TUI holds one row per id
// in `active`, and the headless consumer keeps one `inFlight` entry per id. A
// proxy hosts several listeners at once (the base listener, and one per cached
// MITM pin/client server), so an id handed out per listener restarts at 1 in
// each of them, and a second listener's start or end overwrites the other's row.
// Two listeners must therefore never hand out the same id.

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

// A dot-segment path is refused before any account selection, and the refusal
// reports its request id through `onRequestEnd`, so each request yields one id
// without needing a live upstream.
function rawPost(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('two listeners hand out distinct request ids', async () => {
  const accountManager = { getActiveAccount() { throw new Error('must not select an account'); } };
  const seen = [];
  const hooks = { onRequestEnd: (reqId) => { seen.push(reqId); } };
  const first = createProxyRequestListener({ accountManager, upstream: 'http://127.0.0.1:1', hooks });
  const second = createProxyRequestListener({ accountManager, upstream: 'http://127.0.0.1:1', hooks });
  const { server: proxyA, port: portA } = await listen(first);
  const { server: proxyB, port: portB } = await listen(second);
  try {
    for (const port of [portA, portB, portA, portB]) {
      assert.equal(await rawPost(port, '/v1/messages/../../x'), 400);
    }
    assert.equal(seen.length, 4);
    assert.equal(new Set(seen).size, 4, `request ids collided across listeners: ${seen.join(', ')}`);
  } finally {
    proxyA.closeAllConnections?.(); proxyA.close();
    proxyB.closeAllConnections?.(); proxyB.close();
  }
});
