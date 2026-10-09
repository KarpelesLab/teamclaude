import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

test('request log records the post-rewrite body after advisor-tool drop', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-revlog-advisor-'));
  let seenBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  // No per-account upstream/modelMap: this account inherits the custom global
  // upstream and exercises the effective-upstream compatibility gate.
  const am = new AccountManager([{ name: 'inherited-custom', type: 'apikey', apiKey: 'provider-k' }]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    logDir: dir,
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 16,
        tools: [
          { name: 'Bash', description: 'x', input_schema: { type: 'object', properties: {} } },
          { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    await res.text();
    await new Promise(r => setTimeout(r, 150));

    const forwarded = JSON.parse(seenBody);
    assert.equal(forwarded.tools.length, 1, 'advisor tool is absent from actual egress');
    assert.equal(forwarded.tools[0].name, 'Bash');

    const file = readdirSync(dir).find(f => f.endsWith('.log'));
    assert.ok(file, 'a log file was written');
    const content = readFileSync(join(dir, file), 'utf8');
    const requestSection = content.match(/=== REQUEST BODY ===\n([\s\S]*?)\n\n=== RESPONSE 200 ===/);
    assert.ok(requestSection, 'request body section is delimited before the response');
    const logged = JSON.parse(requestSection[1]);
    assert.deepEqual(logged, forwarded, 'audit log must equal the post-rewrite body that egressed');
    assert.ok(!requestSection[1].includes('advisor_20260301'));
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
