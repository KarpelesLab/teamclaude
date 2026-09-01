import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, resolveLogLevel } from '../src/server.js';

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
