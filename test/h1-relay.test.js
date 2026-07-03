import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { h1Relay } from '../src/h2/relay.js';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }

test('h1 relay peeks the top-level model before binding, relays body intact', { timeout: 30000 }, async () => {
  // Upstream: read the full content-length request, echo the body + the auth it saw.
  const upstream = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = buf.subarray(0, i).toString('latin1');
      const need = parseInt(/content-length:\s*(\d+)/i.exec(head)?.[1] || '0', 10);
      if (buf.length < i + 4 + need) return;
      const body = buf.subarray(i + 4, i + 4 + need).toString('utf8');
      const auth = /authorization:\s*(.+)\r\n/i.exec(head)?.[1] || 'none';
      sock.write(`HTTP/1.1 200 OK\r\nx-saw-auth: ${auth}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  });
  const upPort = await listen(upstream);

  let sawModel = 'UNSET';
  const conns = [];
  const front = net.createServer((clientSock) => {
    conns.push(clientSock);
    const upSock = net.connect(upPort, '127.0.0.1', () => {
      h1Relay(clientSock, upSock, {
        peekModel: true,
        rewriteHead: (head, _id, model) => {
          sawModel = model;
          const acct = model === 'claude-fable-5' ? 'Bearer FABLE' : 'Bearer OTHER';
          return head.replace(/authorization:.*\r\n/i, `authorization: ${acct}\r\n`);
        },
        makeBodyPatcher: () => null,
        onResponseHeaders: () => {},
      });
    });
    conns.push(upSock);
  });
  const frontPort = await listen(front);

  // Decoy "model" inside message content; the real field is top-level.
  const reqBody = JSON.stringify({ messages: [{ role: 'user', content: '{"model":"DECOY"}' }], model: 'claude-fable-5' });
  const raw = `POST /v1/messages HTTP/1.1\r\nhost: api\r\nauthorization: Bearer FAKE\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(reqBody)}\r\n\r\n${reqBody}`;

  const client = net.connect(frontPort, '127.0.0.1');
  let resp = '';
  client.setEncoding('utf8');
  await new Promise((resolve) => {
    client.on('data', (d) => { resp += d; if (resp.endsWith(reqBody)) resolve(); });
    client.on('connect', () => client.write(raw));
    setTimeout(resolve, 3000); // safety net so a regression fails fast, not hangs
  });

  assert.equal(sawModel, 'claude-fable-5');           // top-level, not the decoy
  assert.match(resp, /x-saw-auth: Bearer FABLE/);     // routed on the peeked model
  assert.ok(resp.endsWith(reqBody));                  // body relayed intact

  try { client.destroy(); } catch { /* */ }
  for (const c of conns) { try { c.destroy(); } catch { /* */ } }
  front.close(); upstream.close();
});
