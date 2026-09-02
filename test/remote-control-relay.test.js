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

  // Cleanup lives in finally throughout this file: a failed assertion must not
  // leave servers listening — leaked handles keep the child's event loop alive
  // and hang the whole `node --test` run, not just this file.
  try {
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
  } finally {
    upstream.close();
  }
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
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/code/sessions/abc/worker/events/stream`, {
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString(), /event: hello/);
  } finally {
    controller.abort();
    proxy.close();
    upstream.close();
    // The upstream deliberately never end()s its response, so close() alone
    // would wait on that live connection forever.
    upstream.closeAllConnections();
  }
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
  try {
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
  } finally {
    client.destroy();
    proxy.close();
    upstream.close();
    upstream.closeAllConnections();
  }
});

// Once the 101 fires, Node detaches the upgraded socket from the ClientRequest,
// so upstreamReq's 'error' listener no longer covers it. A dropped link then
// surfaces as an 'error' on that bare socket (write EPIPE / read ECONNRESET) —
// with nothing listening, Node turns an unhandled 'error' event into an
// uncaught exception and the whole proxy dies, taking every other session with
// it. A flapping connection must close one relay, not the process.
test('an upstream socket that dies mid-relay tears down the pair instead of crashing the proxy', async () => {
  const { server: upstream, port: upstreamPort } = await listen(() => {});
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    // RST rather than FIN: what a dropped link looks like to the relay.
    setTimeout(() => socket.resetAndDestroy(), 10);
  });

  const proxy = http.createServer();
  proxy.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, `http://127.0.0.1:${upstreamPort}`, null));
  proxy.listen(0);
  await once(proxy, 'listening');
  const port = proxy.address().port;

  const client = net.connect(port, '127.0.0.1');
  client.on('error', () => {}); // the client end goes away too; that part is expected
  let writer;
  try {
    await once(client, 'connect');
    client.write(
      'GET /v1/session_ingress/ws/abc HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      '\r\n',
    );

    const [handshake] = await once(client, 'data');
    assert.match(handshake.toString(), /101 Switching Protocols/);

    // Keep writing into the now-dead relay: this is the EPIPE path. Waiting
    // for 'close' via events.once would reject on the ECONNRESET the dying
    // relay is EXPECTED to surface (once() rejects whenever 'error' fires
    // first) — that race is exactly what used to abandon the test mid-flight.
    const closed = new Promise(resolve => client.once('close', resolve));
    writer = setInterval(() => client.write('ping'), 5);
    await closed;

    // Still alive and still serving — the proxy survived the upstream's death.
    assert.equal(proxy.listening, true);
  } finally {
    clearInterval(writer);
    client.destroy();
    proxy.close();
    upstream.close();
  }
});

// Production failure mode (2026-08-30): the upstream leg of a live long-poll
// died ("socket hang up" logged by the relay), but the client's response was
// left open — the CLI's Remote Control stream waited on a channel that could
// never deliver another event, and every message queued silently for 45+
// minutes. Once headers have gone out, the only way to tell the client is to
// close its socket; this proves a mid-stream upstream death propagates instead
// of stranding the client.
test('destroys the client stream when the upstream leg dies mid-response', async () => {
  const { server: upstream, port: upstreamPort } = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: hello\n\n');
    // Yank the transport mid-stream — an abrupt FIN/RST, not a clean end().
    setTimeout(() => res.socket.destroy(), 20);
  });

  const accountManager = { getActiveAccount() { throw new Error('must not rotate'); } };
  const listener = createProxyRequestListener({
    accountManager, upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const { server: proxy, port } = await listen(listener);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/code/sessions/abc/worker/events/stream`);
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString(), /event: hello/);

    // Without the fix this read never settles: the proxy keeps the client
    // socket open after the upstream is gone. The race makes the regression
    // fail fast instead of hanging the whole test run.
    const outcome = await Promise.race([
      reader.read().then(({ done }) => (done ? 'closed' : 'data'), () => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('stranded'), 2000)),
    ]);
    assert.equal(outcome, 'closed');
  } finally {
    proxy.close();
    upstream.close();
    upstream.closeAllConnections();
  }
});
