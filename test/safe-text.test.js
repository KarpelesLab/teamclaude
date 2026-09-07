import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { sanitizeText, safeLine } from '../src/safe-text.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('sanitizeText removes every escape form, not just colour', () => {
  // A colour-only strip (/\x1b\[[0-9;]*m/) lets these through: their final byte
  // is not `m`, which is exactly what makes them able to move the cursor and
  // erase what is already on screen.
  assert.equal(sanitizeText('a\x1b[2Jb'), 'a b');
  assert.equal(sanitizeText('a\x1b[1;1Hb'), 'a b');
  assert.equal(sanitizeText('a\x1b[31mb'), 'a b');
  // C1 CSI, the single-byte form of the same thing.
  assert.equal(sanitizeText('a\x9bb'), 'a b');
  // Newline and carriage return: the line-forging pair.
  assert.equal(sanitizeText('a\nb\r\nc'), 'a b c');
  // Bidi override, which reorders how the rest of the line reads.
  assert.equal(sanitizeText('a‮b'), 'a b');
  assert.equal(sanitizeText('  spaced   out  '), 'spaced out');
  assert.equal(sanitizeText('\x00\x1b\x7f'), '');
});

test('safeLine bounds the result for a fixed-width column', () => {
  assert.equal(safeLine('x'.repeat(300)).length, 120);
  assert.equal(safeLine('x'.repeat(300), 10), 'x'.repeat(10));
  assert.equal(safeLine('short'), 'short');
});

test('an unresolvable pin cannot forge a line in the activity log', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'acct', type: 'api_key', apiKey: 'sk-a' }], 0.98);

  // The activity log's own shape: one line per completed request. Mirrors the
  // headless writer in index.js.
  const lines = [];
  const inFlight = new Map();
  const hooks = {
    onRequestStart: (id, info) => inFlight.set(id, info),
    onRequestEnd: (id, info) => {
      inFlight.delete(id);
      lines.push(`${info.method} ${info.path} → ${info.account} (${info.status})`);
    },
  };
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, hooks);
  const port = await listen(proxy);

  try {
    // The pin segment is percent-decoded by the proxy, so the client controls
    // the bytes that reach the message — including ESC and newline.
    const erase = '%1b%5b2J%1b%5b1;1H';
    const forged = '%0a12:00:00  [someone-else] POST v1 messages';
    for (const pin of [erase, forged]) {
      const res = await fetch(`http://127.0.0.1:${port}/tc-acct/${pin}/v1/messages`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 404);
      await res.text();
    }

    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.doesNotMatch(line, /\x1b/, 'no escape byte reaches the log');
      assert.doesNotMatch(line, /[\r\n]/, 'a log line stays one line');
    }
    // The text survives, only its control bytes are gone — the operator can
    // still see what was attempted.
    assert.match(lines[1], /someone-else/);
  } finally {
    proxy.close();
    upstream.close();
  }
});
