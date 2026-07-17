import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createProxyRequestListener, relayUpgrade } from '../src/server.js';

// Bring up an HTTP server on an ephemeral port and hand back {server, port}.
async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0);
  await once(server, 'listening');
  return { server, port: server.address().port };
}

async function requestThrough(listener, { method = 'GET', path, headers = {}, body } = {}) {
  const { server: proxy, port } = await listen(listener);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
    return { status: res.status, text: await res.text(), headers: res.headers };
  } finally {
    proxy.close();
  }
}

// Remote Control (/v1/code/*) must reach upstream with the client's OWN
// authorization header untouched, never a rotated account token — a fake
// accountManager whose getActiveAccount would throw proves relayStream never
// even consults it for this path.
test('a GET to /v1/code/* forwards the client credential and streams the response back untouched', async () => {
  const { server: upstream, port: upstreamPort } = await listen((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer client-own-token');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: ping\n\n');
    res.end();
  });

  const accountManager = { getActiveAccount() { throw new Error('must not rotate Remote Control'); } };
  const listener = createProxyRequestListener({
    accountManager, upstream: `http://127.0.0.1:${upstreamPort}`,
  });

  const { status, text } = await requestThrough(listener, {
    path: '/v1/code/sessions/abc/worker/events/stream',
    headers: { authorization: 'Bearer client-own-token' },
  });

  assert.equal(status, 200);
  assert.match(text, /event: ping/);
  upstream.close();
});

// The whole point of the rewrite: relayStream must not wait for the request (or
// the response) to fully materialize before starting to move bytes — a
// long-poll upstream that waits before sending headers must not be treated as
// a dead request the way a normal bounded /v1/messages call would be.
test('does not wait for the request to end before the response can start streaming', async () => {
  const { server: upstream, port: upstreamPort } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: hello\n\n');
    // Deliberately never end() — mirrors a held-open worker/events/stream.
  });

  const accountManager = { getActiveAccount() { throw new Error('must not rotate'); } };
  const listener = createProxyRequestListener({
    accountManager, upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const { server: proxy, port } = await listen(listener);

  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/v1/code/sessions/abc/worker/events/stream`, {
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(Buffer.from(value).toString(), /event: hello/);

  controller.abort();
  proxy.close();
  upstream.close();
});

// Remote Control's real-time channel is a WebSocket
// (wss://api.anthropic.com/v1/session_ingress/ws/{session_id}), which is an
// HTTP Upgrade handshake — Node fires 'upgrade' for this, never 'request', so
// relayStream (built on req/res) never even sees it. relayUpgrade is the
// dedicated handler for that event; this proves the handshake and the
// bidirectional byte stream both survive the relay with the client's own
// Authorization header intact (never rewritten to a rotated account token).
test('relays a WebSocket Upgrade handshake and echoes bytes both ways', async () => {
  const { server: upstream, port: upstreamPort } = await listen(() => {});
  upstream.on('upgrade', (req, socket) => {
    assert.equal(req.headers.authorization, 'Bearer client-own-token');
    assert.equal(req.headers.upgrade, 'websocket');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (chunk) => socket.write(chunk)); // echo whatever the client sends
  });

  const proxy = http.createServer();
  proxy.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, `http://127.0.0.1:${upstreamPort}`, null));
  proxy.listen(0);
  await once(proxy, 'listening');
  const port = proxy.address().port;

  const client = net.connect(port, '127.0.0.1');
  await once(client, 'connect');
  client.write(
    'GET /v1/session_ingress/ws/abc HTTP/1.1\r\n' +
    'Host: 127.0.0.1\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'authorization: Bearer client-own-token\r\n' +
    '\r\n',
  );

  const [handshake] = await once(client, 'data');
  assert.match(handshake.toString(), /101 Switching Protocols/);

  client.write('ping');
  const [echoed] = await once(client, 'data');
  assert.equal(echoed.toString(), 'ping');

  client.destroy();
  proxy.close();
  upstream.close();
});
