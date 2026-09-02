import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function makeStack(upstreamHandler) {
  const upstream = http.createServer(upstreamHandler);
  // Realistic-length token so the 20-char mask actually truncates it.
  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 'sk-ant-oat-SECRETvalue-0123456789', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  return { upstream, am };
}

test('reverse-proxy logs a non-streaming JSON response (pretty, masked)', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-revlog-'));
  const { upstream, am } = makeStack((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', usage: { input_tokens: 3, output_tokens: 5 } }));
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    await new Promise(r => setTimeout(r, 150)); // let the async file write land

    const file = readdirSync(dir).find(f => f.endsWith('.log'));
    assert.ok(file, 'a log file was written');
    const content = readFileSync(join(dir, file), 'utf8');
    assert.match(content, /=== REQUEST \(account: a/);
    assert.match(content, /\/v1\/messages/);
    assert.match(content, /=== REQUEST BODY ===/);
    assert.match(content, /=== RESPONSE 200 ===/);
    assert.match(content, /=== RESPONSE BODY ===/);
    assert.match(content, /"input_tokens": 3/);          // response pretty-printed
    assert.match(content, /authorization: Bearer sk-ant-oat-\S*\.\.\./); // injected token masked (first 20 chars)
    assert.ok(!content.includes('SECRETvalue-0123456789')); // full token tail never logged
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('reverse-proxy streams an SSE response to the log as it arrives', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-revlog-sse-'));
  const { upstream, am } = makeStack(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n');
    await new Promise(r => setTimeout(r, 20));
    res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":11}}\n\n');
    res.end();
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    await res.text();
    await new Promise(r => setTimeout(r, 150));

    const file = readdirSync(dir).find(f => f.endsWith('.log'));
    const content = readFileSync(join(dir, file), 'utf8');
    assert.match(content, /=== RESPONSE BODY \(streamed\) ===/);
    // SSE written verbatim (not JSON-reformatted): the raw "event:"/"data:"
    // lines survive intact, which a JSON pretty-printer would have mangled.
    assert.match(content, /event: message_start\ndata: \{"type":"message_start"/);
    assert.match(content, /event: message_delta/);
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('log files are created 0600 in a 0700 directory', { skip: process.platform === 'win32' }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'tc-logmode-'));
  const dir = join(parent, 'logs'); // created by the server
  const { upstream, am } = makeStack((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir });
  const proxyPort = await listen(proxy);
  try {
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'directory mode');
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: 'POST', body: '{"model":"x"}' });
    await res.text();
    await new Promise(r => setTimeout(r, 150));
    const file = readdirSync(dir).find(f => f.endsWith('.log'));
    assert.ok(file, 'a log file was written');
    assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600, 'file mode');
  } finally {
    proxy.close(); upstream.close(); rmSync(parent, { recursive: true, force: true });
  }
});

test('the logged request body is the one sent upstream, not the one the client sent', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-logsend-'));
  let upstreamSaw = '';
  const upstream = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { upstreamSaw = b; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  // A modelMap rewrite makes sendBody differ from the client body.
  const am = new AccountManager(
    [{ name: 'a', type: 'apikey', apiKey: 'k-a', modelMap: { 'client-model': 'backend-model' } }],
    0.98,
  );
  const upPort = await listen(upstream);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'client-model', messages: [] }),
    });
    await res.text();
    await new Promise(r => setTimeout(r, 150));
    assert.match(upstreamSaw, /"backend-model"/);
    const file = readdirSync(dir).find(f => f.endsWith('.log'));
    const content = readFileSync(join(dir, file), 'utf8');
    assert.match(content, /body rewritten by the proxy before sending/);
    assert.match(content, /"model": "backend-model"/);
    assert.ok(!content.includes('"client-model"'), 'the client copy is not what was logged');
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed JSON response body neither fails the request nor crashes the log', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-logbad-'));
  const bad = '{"a":1}}}]';
  const { upstream, am } = makeStack((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(bad);
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: dir });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: 'POST', body: '{"model":"x"}' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), bad, 'the client gets the upstream bytes untouched');
    await new Promise(r => setTimeout(r, 150));
    const file = readdirSync(dir).find(f => f.endsWith('.log'));
    assert.ok(file, 'a log file was written');
    assert.match(readFileSync(join(dir, file), 'utf8'), /=== RESPONSE BODY ===/);
  } finally {
    proxy.close(); upstream.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('an uncreatable logDir is reported once at startup and requests still flow', { timeout: 20000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), 'tc-lognodir-'));
  const notADir = join(parent, 'file');
  writeFileSync(notADir, 'x'); // a regular file on the path: mkdir cannot succeed
  const { upstream, am } = makeStack((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upPort = await listen(upstream);
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let proxy;
  try {
    proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upPort}`, logDir: notADir });
    const proxyPort = await listen(proxy);
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, { method: 'POST', body: '{"model":"x"}' });
      assert.equal(res.status, 200);
      await res.text();
    }
    await new Promise(r => setTimeout(r, 150));
  } finally {
    console.error = origError;
    proxy?.close(); upstream.close(); rmSync(parent, { recursive: true, force: true });
  }
  const disabled = errors.filter(e => /Request logging disabled: cannot create logDir/.test(e));
  assert.equal(disabled.length, 1, JSON.stringify(errors));
  assert.equal(errors.filter(e => /Failed to write log|abandoned/.test(e)).length, 0, 'no per-request noise');
});
