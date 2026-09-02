import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  resolveUpstreamProxy, setUpstreamProxy, resetUpstreamProxy, proxyForHost,
  isSelfProxy, localListener, describeSelfProxy,
} from '../src/upstream-proxy.js';
import { upstreamFetch } from '../src/upstream-fetch.js';

test.afterEach(() => resetUpstreamProxy());

// The shape of the bug: `teamclaude env` exports HTTPS_PROXY pointing at
// TeamClaude, so a server or CLI started from that shell proxies itself. The
// call succeeds against whichever account the proxy happens to select, which is
// why it never surfaced as an error — a usage probe just reports the active
// account's quota under every account.
const MITM_SHELL = { HTTPS_PROXY: 'http://127.0.0.1:3456', NO_PROXY: 'localhost,127.0.0.1,::1' };

test('a proxy pointing at our own listener is ignored, not honoured', () => {
  const r = resolveUpstreamProxy({ proxy: { port: 3456 } }, MITM_SHELL);
  assert.equal(r.proxy, null);
  assert.equal(r.source, 'self');
  // The rejected value is kept so the startup line can say what was dropped.
  assert.equal(r.ignored.proxy.port, 3456);
  assert.equal(r.ignored.source, 'env:HTTPS_PROXY');
  assert.match(describeSelfProxy(r), /ignored http:\/\/127\.0\.0\.1:3456 from HTTPS_PROXY/);
});

test('every spelling of our own loopback listener is recognised', () => {
  const listener = { host: '127.0.0.1', port: 3456 };
  for (const host of ['127.0.0.1', 'localhost', 'LocalHost.', '[::1]', '::1', '127.0.0.2']) {
    assert.equal(isSelfProxy({ host, port: 3456 }, listener), true, host);
  }
});

test('a real proxy that merely resembles ours is left alone', () => {
  const listener = { host: '127.0.0.1', port: 3456 };
  // A local corporate proxy (cntlm, px) on another port is a legitimate egress.
  assert.equal(isSelfProxy({ host: '127.0.0.1', port: 3128 }, listener), false);
  // Same port, but somewhere else entirely.
  assert.equal(isSelfProxy({ host: 'proxy.corp.example', port: 3456 }, listener), false);
  // A LAN address on our port is not claimed: nothing here has established
  // which interfaces this host owns, and a loopback bind does not answer there.
  assert.equal(isSelfProxy({ host: '192.168.1.10', port: 3456 }, listener), false);
});

// A wildcard bind accepts connections on every local address, so loopback
// reaches it — that is a property of the bind, not a guess about interfaces.
test('a wildcard bind still recognises loopback as itself', () => {
  assert.equal(isSelfProxy({ host: '127.0.0.1', port: 3456 }, { host: '0.0.0.0', port: 3456 }), true);
  assert.equal(isSelfProxy({ host: '::1', port: 3456 }, { host: '::', port: 3456 }), true);
  // A non-loopback address is still not claimed, even under a wildcard bind.
  assert.equal(isSelfProxy({ host: '10.0.0.4', port: 3456 }, { host: '0.0.0.0', port: 3456 }), false);
});

test('the listener follows the same expression the server binds with', () => {
  assert.deepEqual(localListener({ proxy: { port: 3456 } }, {}), { host: '127.0.0.1', port: 3456 });
  assert.deepEqual(localListener({ proxy: { port: 3456, host: '0.0.0.0' } }, {}), { host: '0.0.0.0', port: 3456 });
  // TEAMCLAUDE_HOST overrides the config, exactly as serverCommand reads it.
  assert.deepEqual(localListener({ proxy: { port: 3456, host: '0.0.0.0' } }, { TEAMCLAUDE_HOST: '127.0.0.1' }),
    { host: '127.0.0.1', port: 3456 });
});

// Without a port we cannot know what "ourselves" means, and assuming the
// default would drop a legitimate proxy that happens to sit on 3456.
test('a config with no port makes no self claim', () => {
  assert.equal(localListener({}, {}), null);
  assert.equal(isSelfProxy({ host: '127.0.0.1', port: 3456 }, null), false);
  const r = resolveUpstreamProxy({}, MITM_SHELL);
  assert.equal(r.source, 'env:HTTPS_PROXY');
  assert.equal(r.proxy.port, 3456);
});

test('a self-pointing value typed into the config is dropped too', () => {
  const r = resolveUpstreamProxy({ proxy: { port: 3456 }, upstreamProxy: 'http://localhost:3456' }, {});
  assert.equal(r.proxy, null);
  assert.equal(r.source, 'self');
  assert.match(describeSelfProxy(r), /from the config/);
});

test('an ordinary resolution has nothing to report', () => {
  assert.equal(describeSelfProxy(resolveUpstreamProxy({ proxy: { port: 3456 } }, { HTTPS_PROXY: 'http://p:3128' })), null);
  assert.equal(describeSelfProxy({ proxy: null, source: 'none' }), null);
});

test('proxyForHost goes direct once the self-proxy is dropped', () => {
  setUpstreamProxy(resolveUpstreamProxy({ proxy: { port: 3456 } }, MITM_SHELL));
  assert.equal(proxyForHost('api.anthropic.com'), null);
});

// ── End to end ───────────────────────────────────────────────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Stands in for TeamClaude's own listener: it would happily tunnel for us, and
// every byte would come back through the account-rewriting request path.
function connectProxy() {
  const targets = [];
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSock, head) => {
    targets.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      clientSock.pipe(upstream);
      upstream.pipe(clientSock);
    });
    upstream.on('error', () => clientSock.destroy());
    clientSock.on('error', () => upstream.destroy());
  });
  return { server, targets };
}

test('an upstream request does not loop back through our own port', async () => {
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const originPort = await listen(origin);
  const { server: self, targets } = connectProxy();
  const selfPort = await listen(self);

  // The environment says "proxy through 127.0.0.1:selfPort"; the config says we
  // ARE 127.0.0.1:selfPort. Resolution happens with an explicit env so the
  // developer's own HTTP(S)_PROXY / NO_PROXY cannot decide the outcome.
  setUpstreamProxy(resolveUpstreamProxy(
    { proxy: { port: selfPort } },
    { HTTPS_PROXY: `http://127.0.0.1:${selfPort}` },
  ));

  try {
    const res = await upstreamFetch(`http://127.0.0.1:${originPort}/v1/messages`, { method: 'GET', headersTimeoutMs: 8000 });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(await res.text()), { ok: true, path: '/v1/messages' });
    assert.deepEqual(targets, []);   // never tunneled through ourselves
  } finally {
    self.close();
    origin.close();
  }
});
