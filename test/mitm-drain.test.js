import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler } from '../src/mitm.js';
import { allowLoopbackForward } from '../src/forward-target.js';
import { AccountManager } from '../src/account-manager.js';
import { createDrainState } from '../src/drain.js';

// Drain covers MITM too. Claude Code reaches the proxy through a CONNECT
// tunnel that the proxy terminates, and those requests run through the same
// forwarding listener as plain ones, so a draining proxy refuses them with the
// same 503. The tunnel setup mirrors mitm-integration.test.js.

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

function connectThroughProxy(proxyPort, target, caCertPem) {
  return new Promise((resolve, reject) => {
    const raw = net.connect(proxyPort, '127.0.0.1');
    raw.once('error', reject);
    raw.once('connect', () => raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.includes('\r\n\r\n')) {
        raw.removeListener('data', onData);
        const sock = tls.connect({ socket: raw, servername: 'localhost', ca: [caCertPem], ALPNProtocols: ['http/1.1'] }, () => resolve(sock));
        sock.once('error', reject);
      }
    };
    raw.on('data', onData);
  });
}

test('a draining proxy refuses an intercepted request with the 503, and never reaches the upstream', async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => { upstreamHits++; req.resume(); res.end('{}'); });
  const upPort = await listen(upstream);
  const drain = createDrainState();
  const am = new AccountManager([{ name: 'acct', type: 'apikey', apiKey: 'sk-fake' }], 0.98);
  const proxy = http.createServer();
  allowLoopbackForward(proxy);
  proxy.on('connect', createConnectHandler({
    config: { upstream: `http://127.0.0.1:${upPort}` },
    accountManager: am,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    logDir: null, hooks: {}, log: () => {}, sx: null, drain,
  }));
  const proxyPort = await listen(proxy);
  const tlsSock = await connectThroughProxy(proxyPort, `127.0.0.1:${upPort}`, caCertPem);
  try {
    drain.start();
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        createConnection: () => tlsSock, method: 'POST', path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      }, r => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', c => { text += c; });
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, text }));
      });
      req.on('error', reject);
      req.end('{"model":"x","messages":[]}');
    });
    assert.equal(res.status, 503);
    assert.match(res.headers['retry-after'] ?? '', /^\d+$/);
    assert.equal(res.headers.connection, 'close');
    const body = JSON.parse(res.text);
    assert.equal(body.error.type, 'overloaded_error');
    assert.equal(body.error.details.error_code, 'draining');
    assert.equal(upstreamHits, 0, 'the refused request never reached the upstream');
    assert.equal(drain.status().inFlight, 0, 'a refused request is not counted');
  } finally {
    tlsSock.destroy();
    proxy.closeAllConnections?.();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  }
});
