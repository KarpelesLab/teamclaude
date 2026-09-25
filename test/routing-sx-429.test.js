import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Defense in depth, as in the other in-process server tests: nothing imported
// here reads the config path, and this keeps it that way if one ever does.
const TMP = mkdtempSync(join(tmpdir(), 'tc-routing-sx-'));
process.env.TEAMCLAUDE_CONFIG = join(TMP, 'config.json');

const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer } = await import('../src/server.js');
const { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } = await import('../src/upstream-proxy.js');

const T = { timeout: 30000 };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// Answers a rate-limit 429 (with the headers that make it an account-level
// throttle rather than a request-scoped refusal) `limited` times, then 200.
function startUpstream(limited) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(req.url);
      if (hits.length <= limited) {
        res.writeHead(429, { 'retry-after': '1', 'anthropic-ratelimit-unified-status': 'allowed', 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
    });
  });
  return { srv, hits };
}

// No-auth SOCKS5 relay that records each CONNECT target.
function startSocks5() {
  const connects = [];
  const srv = net.createServer((client) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    client.on('error', () => {});
    client.on('data', (chunk) => {
      if (stage === 'relay') return;
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2 + (buf[1] || 0)) return;
        buf = buf.subarray(2 + buf[1]);
        stage = 'request';
        client.write(Buffer.from([0x05, 0x00]));
      }
      if (stage === 'request') {
        if (buf.length < 10) return;
        const host = [...buf.subarray(4, 8)].join('.');
        const port = buf.readUInt16BE(8);
        buf = buf.subarray(10);
        connects.push(`${host}:${port}`);
        const up = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (buf.length) up.write(buf);
          up.pipe(client); client.pipe(up);
        });
        up.on('error', () => client.destroy());
        stage = 'relay';
      }
    });
  });
  return { srv, connects };
}

// sx in '429' mode, provisioned onto a port nothing listens on: any attempt
// that really went "via sx" would fail to connect, so a 200 proves none did.
function fakeSx(deadPort) {
  const notes = [];
  return {
    notes,
    isProvisioned: () => true,
    getProxy: () => ({ host: '127.0.0.1', port: deadPort, username: 'u', password: 'p' }),
    getMode: () => '429',
    useByDefault: () => false,
    useOn429: () => true,
    useForConnect: () => false,
    noteRateLimited: (s) => { notes.push(s); },
    isRecentlyRateLimited: () => false,
  };
}

function closedPort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function post(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-test-model', max_tokens: 1, messages: [] }),
    signal: AbortSignal.timeout(20000),
  });
  await res.text();
  return res.status;
}

async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines;
}

test.afterEach(() => resetUpstreamProxy());

test('a routed account\'s 429 neither arms sx nor retries "via sx"', T, async () => {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
  const upstream = startUpstream(1);
  const upstreamPort = await listen(upstream.srv);
  const socks = startSocks5();
  const socksPort = await listen(socks.srv);
  const sx = fakeSx(await closedPort());

  const am = new AccountManager([
    { name: 'routed', type: 'apikey', apiKey: 'sk-ant-test', routing: `socks5://127.0.0.1:${socksPort}` },
  ], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, {}, sx);
  const port = await listen(proxy);
  try {
    let status;
    const lines = await captureLogs(async () => { status = await post(port); });
    assert.equal(status, 200, lines.join('\n'));
    assert.equal(upstream.hits.length, 2, 'the 429, then the retry');
    assert.deepEqual(socks.connects, [`127.0.0.1:${upstreamPort}`, `127.0.0.1:${upstreamPort}`], 'both attempts left through the account\'s own proxy');
    assert.deepEqual(sx.notes, [], 'the sticky sx window is not armed by a limit on another exit address');
    assert.equal(lines.some(l => l.includes('retrying via sx.org')), false, lines.join('\n'));
    // What it does instead: the ordinary wait-and-retry on the same account.
    assert.ok(lines.some(l => /waiting 1s, retrying same account/.test(l)), lines.join('\n'));
  } finally {
    proxy.close(); upstream.srv.close(); socks.srv.close();
    proxy.closeAllConnections?.(); upstream.srv.closeAllConnections?.();
  }
});

test('an unrouted account\'s 429 still arms sx and retries through it', T, async () => {
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
  const upstream = startUpstream(1);
  const upstreamPort = await listen(upstream.srv);
  const sx = fakeSx(await closedPort());

  const am = new AccountManager([{ name: 'direct', type: 'apikey', apiKey: 'sk-ant-test' }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, {}, sx);
  const port = await listen(proxy);
  try {
    const lines = await captureLogs(async () => { await post(port).catch(() => null); });
    assert.deepEqual(sx.notes, [1], 'the control: sx is armed exactly as before');
    assert.ok(lines.some(l => l.includes('retrying via sx.org')), lines.join('\n'));
  } finally {
    proxy.close(); upstream.srv.close();
    proxy.closeAllConnections?.(); upstream.srv.closeAllConnections?.();
  }
});
