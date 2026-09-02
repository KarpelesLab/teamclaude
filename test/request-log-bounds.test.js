import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveLogLevel, resolveLogMaxBodyBytes } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeAccounts() {
  return new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
}

// Read the single log file the proxy wrote for one request.
function readOnlyLog(dir) {
  const file = readdirSync(dir).find(f => f.endsWith('.log'));
  assert.ok(file, 'a log file was written');
  return readFileSync(join(dir, file), 'utf8');
}

const REQ_MARKER = 'QQQREQUESTBODYQQQ';
const RES_MARKER = 'ZZZRESPONSEBODYZZZ';

test('logLevel "headers" logs both heads and neither body', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-loglevel-'));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ marker: RES_MARKER }));
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(makeAccounts(), {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir, logLevel: 'headers',
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marker: REQ_MARKER }),
    });
    assert.match(await res.text(), new RegExp(RES_MARKER));
    await new Promise(r => setTimeout(r, 150));

    const content = readOnlyLog(dir);
    assert.match(content, /=== REQUEST \(account: a/);
    assert.match(content, /=== RESPONSE 200 ===/);
    assert.doesNotMatch(content, /=== REQUEST BODY ===/);
    assert.doesNotMatch(content, /=== RESPONSE BODY ===/);
    assert.ok(!content.includes(REQ_MARKER), 'request body must not reach the log');
    assert.ok(!content.includes(RES_MARKER), 'response body must not reach the log');
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

// A complete (non-streamed) body is already held whole in memory, so keeping the
// tail costs nothing — and the tail is where the newest message and the latest
// tool result live.
test('logMaxBodyBytes keeps the head and the tail of a complete body, drops the middle', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-logcap-'));
  const HEAD = 'HHHHEADHHH';
  const MID = 'MMMMIDMMM';
  const TAIL = 'TTTTAILTTT';
  const filler = 'a'.repeat(100_000);
  const payload = JSON.stringify({ head: HEAD, a: filler, mid: MID, b: filler, tail: TAIL });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(makeAccounts(), {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir, logMaxBodyBytes: 4096,
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const relayed = await res.text();
    assert.equal(relayed, payload, 'the client still receives the whole body');
    await new Promise(r => setTimeout(r, 150));

    const content = readOnlyLog(dir);
    assert.ok(content.includes(HEAD), 'head of the body is kept');
    assert.ok(content.includes(TAIL), 'tail of the body is kept');
    assert.ok(!content.includes(MID), 'middle of the body is dropped');
    assert.match(content, /truncated/);
    assert.ok(content.length < 40_000, `log stayed bounded, got ${content.length} bytes`);
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

// The streamed path cannot keep a tail: buffering one would break the property
// that a request blocking mid-stream leaves its partial body readable on disk.
test('logMaxBodyBytes truncates a streamed body from the head only', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-logcap-sse-'));
  const TAIL = 'TTTTAILTTT';
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    for (let i = 0; i < 20; i++) res.write(`event: chunk\ndata: ${'x'.repeat(1000)}\n\n`);
    res.write(`event: message_stop\ndata: ${TAIL}\n\n`);
    res.end();
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(makeAccounts(), {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir, logMaxBodyBytes: 2048,
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stream":true}',
    });
    assert.match(await res.text(), new RegExp(TAIL), 'the client still receives the whole stream');
    await new Promise(r => setTimeout(r, 150));

    const content = readOnlyLog(dir);
    assert.match(content, /=== RESPONSE BODY \(streamed\) ===/);
    assert.match(content, /event: message_start/, 'head of the stream is kept');
    assert.ok(!content.includes(TAIL), 'tail of a streamed body is not buffered to be kept');
    assert.match(content, /truncated/);
    assert.ok(content.length < 20_000, `log stayed bounded, got ${content.length} bytes`);
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

// Regression pin, not a red test: a config that sets only logDir keeps the
// fidelity it has today.
test('a config with only logDir still logs both bodies in full', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-logdefault-'));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ marker: RES_MARKER }));
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(makeAccounts(), {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir,
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marker: REQ_MARKER }),
    });
    await res.text();
    await new Promise(r => setTimeout(r, 150));

    const content = readOnlyLog(dir);
    assert.match(content, /=== REQUEST BODY ===/);
    assert.match(content, /=== RESPONSE BODY ===/);
    assert.ok(content.includes(REQ_MARKER));
    assert.ok(content.includes(RES_MARKER));
    assert.ok(!content.includes('truncated'), 'a body under the cap is written whole');
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('logLevel "off" leaves the directory empty', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-logoff-'));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ marker: RES_MARKER }));
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(makeAccounts(), {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir, logLevel: 'off',
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.match(await res.text(), new RegExp(RES_MARKER), 'the request is still served');
    await new Promise(r => setTimeout(r, 150));
    assert.deepEqual(readdirSync(dir), [], 'no log file is opened');
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveLogLevel accepts the three modes and falls back to body', () => {
  for (const level of ['off', 'headers', 'body']) {
    assert.equal(resolveLogLevel({ logLevel: level }), level);
  }
  assert.equal(resolveLogLevel({}), 'body');
  assert.equal(resolveLogLevel(null), 'body');
  assert.equal(resolveLogLevel({ logLevel: 'verbose' }), 'body');
  assert.equal(resolveLogLevel({ logLevel: 2 }), 'body');
});

test('logLevel "headers" writes no section for a streamed body', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-loghdr-sse-'));
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message_start\ndata: {"marker":"${RES_MARKER}"}\n\n`);
    await new Promise(r => setTimeout(r, 20));
    res.write('event: message_stop\ndata: {}\n\n');
    res.end();
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(makeAccounts(), {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir, logLevel: 'headers',
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stream":true}',
    });
    assert.match(await res.text(), new RegExp(RES_MARKER), 'the client still receives the stream');
    await new Promise(r => setTimeout(r, 150));

    const content = readOnlyLog(dir);
    assert.match(content, /=== RESPONSE 200 ===/);
    // The state this level introduces: the log file is open while the body
    // writer is null, a pairing that previously meant no log file at all.
    assert.doesNotMatch(content, /=== RESPONSE BODY \(streamed\) ===/);
    assert.ok(!content.includes(RES_MARKER), 'streamed body must not reach the log');
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

// Every shape an operator can put in this key, so the effect of each is read
// off the table rather than inferred. A quoted number is a common JSON slip.
test('resolveLogMaxBodyBytes reads each input shape', () => {
  const at = (logMaxBodyBytes) => resolveLogMaxBodyBytes({ logMaxBodyBytes });
  assert.equal(at(0), 0);
  assert.equal(at('0'), 0);
  assert.equal(at(''), 262_144);
  assert.equal(at('   '), 262_144);
  assert.equal(at(65_536), 65_536);
  assert.equal(at('65536'), 65_536);
  assert.equal(at(-1), 262_144);
  assert.equal(at('week'), 262_144);
  assert.equal(at(null), 262_144);
  assert.equal(at(true), 262_144);
  assert.equal(resolveLogMaxBodyBytes({}), 262_144);
  assert.equal(resolveLogMaxBodyBytes(null), 262_144);
});

// streamResponse rethrows a mid-stream read error, so without the finally the
// note describing what the cap dropped would be lost on exactly the path where
// a reader most needs to tell a capped body from a severed one.
test('the truncation note survives a stream that dies mid-body', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-logcap-abort-'));
  const upstream = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < 8; i++) res.write(`event: chunk\ndata: ${'x'.repeat(500)}\n\n`);
    await new Promise(r => setTimeout(r, 20));
    res.socket.destroy();
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(makeAccounts(), {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir, logMaxBodyBytes: 512,
  });
  const proxyPort = await listen(proxy);
  try {
    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stream":true}',
      });
      await res.text();
    } catch { /* the severed upstream reaches the client as a broken response */ }
    await new Promise(r => setTimeout(r, 300));

    const content = readOnlyLog(dir);
    assert.match(content, /=== RESPONSE BODY \(streamed\) ===/);
    assert.match(content, /truncated/, 'the note is written from the finally, not the success path');
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

// The cap applies to the request direction too, which is the headline case:
// Claude Code re-sends the whole context on every turn.
test('logMaxBodyBytes truncates the request body and still forwards it whole', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-logcap-req-'));
  const HEAD = 'HHHHEADHHH';
  const MID = 'MMMMIDMMM';
  const TAIL = 'TTTTAILTTT';
  const filler = 'a'.repeat(100_000);
  const payload = JSON.stringify({ head: HEAD, a: filler, mid: MID, b: filler, tail: TAIL });
  let received = '';
  const upstream = http.createServer((req, res) => {
    req.on('data', (c) => { received += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(makeAccounts(), {
    proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir, logMaxBodyBytes: 4096,
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
    });
    await res.text();
    await new Promise(r => setTimeout(r, 150));

    assert.equal(received, payload, 'upstream still receives the whole request body');
    const content = readOnlyLog(dir);
    assert.match(content, /=== REQUEST BODY ===/);
    assert.ok(content.includes(HEAD), 'head of the request body is kept');
    assert.ok(content.includes(TAIL), 'tail of the request body is kept');
    assert.ok(!content.includes(MID), 'middle of the request body is dropped');
    assert.match(content, /truncated/);
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});
