import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { relayUpgrade } from '../src/server.js';

// relayUpgrade writes the client's response head by hand, for both the 101 and
// a handshake upstream refuses with a plain response. The head is the status
// line, one CRLF per header line, then a single empty line. When no header
// survives the filters, a blank line must not appear between the status line
// and the rest (it would end the head early and turn the remaining lines into
// body bytes), and no extra CRLF may follow the head (after a 101 it would be
// read as the first bytes of the WebSocket stream).

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// An upstream that answers the handshake with `response` verbatim and then
// closes. On a 101 the close ends the relayed pair, so the client sees the end
// of the stream right after the head instead of waiting for more frames.
async function rawUpstream(response) {
  const upstream = net.createServer((s) => {
    s.on('error', () => {});
    s.once('data', () => s.end(response));
  });
  return { upstream, port: await listen(upstream) };
}

// Drive one handshake through relayUpgrade and return everything the client
// received before the proxy closed the socket. The proxy closes it after a
// refusal, and after a 101 once the upstream side ends, so the read completes
// on 'close'. A bounded timeout turns a hang into a failure that shows what
// arrived.
async function handshake(upstreamPort, timeoutMs = 5000) {
  const proxy = http.createServer();
  proxy.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, `http://127.0.0.1:${upstreamPort}`, null, { log: () => {} }));
  const port = await listen(proxy);
  const client = net.connect(port, '127.0.0.1');
  const chunks = [];
  const received = () => Buffer.concat(chunks).toString('latin1');
  let timer;
  try {
    client.on('data', (c) => chunks.push(c));
    await once(client, 'connect');
    const closed = once(client, 'close');
    client.write(
      'GET /v1/session_ingress/ws/abc HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\nauthorization: Bearer client-own-token\r\n\r\n',
    );
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`proxy did not close within ${timeoutMs} ms; received ${JSON.stringify(received())}`)), timeoutMs);
    });
    await Promise.race([closed, timedOut]);
    return received();
  } finally {
    clearTimeout(timer);
    client.destroy();
    proxy.close();
    proxy.closeAllConnections?.();
  }
}

test('relayUpgrade: a refused handshake whose headers all drop is relayed as a well-formed head', async () => {
  // Connection and Content-Length are the only headers upstream sends, and the
  // refusal writer drops both, so only the status line and its own
  // `Connection: close` remain.
  const { upstream, port } = await rawUpstream('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  try {
    assert.equal(await handshake(port), 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  } finally {
    upstream.close();
  }
});

test('relayUpgrade: a 101 is relayed with one CRLF per header line and a single terminator', async () => {
  // Node reports a response as an upgrade only when it carries Upgrade and
  // Connection, so the 101 writer always has lines; this pins its exact bytes.
  const { upstream, port } = await rawUpstream('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  try {
    assert.equal(await handshake(port), 'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
  } finally {
    upstream.close();
  }
});
