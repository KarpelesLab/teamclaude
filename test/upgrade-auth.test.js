import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveUpgradeAuth } from '../src/server.js';

// `server.on('upgrade')` is a different event from the one requestHandler
// serves, so it does not inherit the key gate — it has to ask for itself.
// Without that, a WebSocket handshake is an unauthenticated relay to the
// configured upstream: no pooled credential rides along (relayUpgrade forwards
// the client's own headers), but the operator's host and address do.

const PROXY = { apiKey: 'shared-key', clientKeys: [{ name: 'alice', key: 'alice-key' }] };
const sock = (remoteAddress) => ({ remoteAddress });
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('the upgrade gate answers like the other two', () => {
  const remote = sock('203.0.113.7');
  assert.deepEqual(resolveUpgradeAuth({ headers: {} }, remote, PROXY), { ok: false, client: null });
  assert.deepEqual(resolveUpgradeAuth({ headers: { 'x-api-key': 'shared-key' } }, remote, PROXY), { ok: true, client: null });
  assert.deepEqual(resolveUpgradeAuth({ headers: { 'x-api-key': 'alice-key' } }, remote, PROXY), { ok: true, client: 'alice' });
  assert.deepEqual(resolveUpgradeAuth({ headers: { 'x-api-key': 'wrong' } }, remote, PROXY), { ok: false, client: null });
  // Loopback is exempt, as it is on the HTTP and CONNECT gates, so a local
  // `teamclaude attach` keeps working with no key.
  assert.deepEqual(resolveUpgradeAuth({ headers: {} }, sock('127.0.0.1'), PROXY), { ok: true, client: null });
  // A deployment with no keys configured is open by choice, unchanged.
  assert.deepEqual(resolveUpgradeAuth({ headers: {} }, remote, {}), { ok: true, client: null });
});

test('the loopback exemption is refused to a web page: foreign Origin or Host', () => {
  // A page can open a WebSocket to 127.0.0.1 with no CORS check, and the
  // handshake arrives loopback-sourced. Browsers always send Origin on a
  // handshake and CLIs never do; a DNS-rebound page also leaves Host naming
  // the attacker. Same two checks the request path applies to key-less
  // loopback callers.
  const local = sock('127.0.0.1');
  const refused = { ok: false, client: null };
  const exempt = { ok: true, client: null };
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: '127.0.0.1:3456', origin: 'https://attacker.example' } }, local, PROXY), refused);
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: 'attacker.example:3456' } }, local, PROXY), refused);
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: '127.0.0.1:3456', origin: 'http://localhost:3456' } }, local, PROXY), exempt);
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: 'localhost:3456' } }, local, PROXY), exempt);
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: '[::1]:3456', origin: 'http://[::1]:3456' } }, local, PROXY), exempt);
  // A malformed Origin cannot be trusted either way; refuse.
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: '127.0.0.1:3456', origin: 'not a url' } }, local, PROXY), refused);
  // A valid key passes regardless of Origin or Host, and a bound LAN host is local.
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: 'attacker.example', origin: 'https://attacker.example', 'x-api-key': 'alice-key' } }, local, PROXY), { ok: true, client: 'alice' });
  assert.deepEqual(resolveUpgradeAuth({ headers: { host: '192.168.1.5:3456' } }, local, { ...PROXY, host: '192.168.1.5' }), exempt);
});

test('a key offered in Sec-WebSocket-Protocol is NOT accepted', () => {
  // Reading the key out of the subprotocol list would let a browser
  // authenticate — and would leak the operator's key to the upstream, because
  // relayUpgrade forwards that header while deliberately stripping x-api-key.
  // It would also turn one guess per connection into thousands, since the
  // offer list is attacker-sized. Not supporting browsers is the cheaper
  // trade, and this pins it.
  const remote = sock('203.0.113.7');
  assert.deepEqual(
    resolveUpgradeAuth({ headers: { 'sec-websocket-protocol': 'teamclaude, alice-key' } }, remote, PROXY),
    { ok: false, client: null });
  assert.deepEqual(
    resolveUpgradeAuth({ headers: { 'sec-websocket-protocol': 'alice-key' } }, remote, PROXY),
    { ok: false, client: null });
});

// The unit test above cannot show the handler is WIRED. Drive a real socket:
// on loopback the gate is exempt, so an upstream that never answers proves the
// request was relayed, while a refusal proves it was not.
test('an unauthorized handshake is refused on the socket, not silently held', async () => {
  let relayed = false;
  let upstreamHeaders = null;
  // Every socket this test opens is held so teardown can destroy it: an
  // upgraded socket is deliberately never ended, and close() waits for it.
  const open = [];
  const upstream = http.createServer(() => {});
  upstream.on('upgrade', (req, s) => { relayed = true; upstreamHeaders = req.headers; open.push(s); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  const proxy = createProxyServer(am, { proxy: PROXY, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);

  // Force the non-loopback branch: the gate reads socket.remoteAddress, so
  // stub it on the connection the server is about to hand the handler.
  proxy.on('connection', (s) => { Object.defineProperty(s, 'remoteAddress', { value: '203.0.113.7' }); });

  const handshake = (key) => new Promise((resolve) => {
    const c = net.createConnection({ port, host: '127.0.0.1' }, () => {
      open.push(c);
      c.write('GET /v1/messages HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + (key ? `x-api-key: ${key}\r\n` : '') + '\r\n');
    });
    let buf = '';
    const done = setTimeout(() => { c.destroy(); resolve(buf); }, 700);
    c.on('data', (d) => { buf += d; });
    c.on('close', () => { clearTimeout(done); resolve(buf); });
  });

  try {
    const refused = await handshake(null);
    assert.match(refused, /^HTTP\/1\.1 401 Unauthorized/, 'refused, and told so');
    assert.equal(relayed, false, 'and never reached the upstream');

    const allowed = await handshake('alice-key');
    // The stub upstream never completes the handshake, so `allowed` is empty —
    // asserting it lacks "401" would pass vacuously. Reaching the upstream is
    // the real oracle, and it is what a broken gate would prevent.
    assert.equal(allowed, '', 'no status line: the relay took over the socket');
    assert.equal(relayed, true, 'the keyed handshake reached the upstream');
    // The key that authenticated us to the proxy must not travel onward.
    // relayUpgrade strips x-api-key; nothing must smuggle it back in under
    // another name, which is exactly how the first version of this gate broke.
    assert.equal(upstreamHeaders['x-api-key'], undefined, 'the proxy key is stripped');
    for (const [k, v] of Object.entries(upstreamHeaders)) {
      assert.ok(!String(v).includes('alice-key'), `header ${k} carries the proxy key upstream`);
    }
  } finally {
    for (const s of open) s.destroy();
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});
