import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, createProxyRequestListener } from '../src/server.js';
import { AdmissionGate } from '../src/admission-gate.js';

async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await delay(5); }
  assert.fail('condition did not settle within 1s');
}

async function fixture(t, overrides = {}) {
  const vars = {
    TEAMCLAUDE_INGRESS_CONCURRENCY: '1', TEAMCLAUDE_INGRESS_QUEUE: '1',
    TEAMCLAUDE_INGRESS_QUEUE_TIMEOUT_MS: '150', TEAMCLAUDE_REQUEST_BODY_TIMEOUT_MS: '300',
    TEAMCLAUDE_REQUEST_BODY_MAX_BYTES: '1024', ...overrides,
  };
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  t.after(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  let forwarded = 0, upstreamClosed = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    forwarded++;
    if (req.headers['x-test-response']) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
      if (req.headers['x-test-response'] === 'large') res.end('x'.repeat(2048));
      return;
    }
    if (req.headers['x-test-stall']) {
      req.socket.once('close', () => upstreamClosed++);
      return;
    }
    res.end('{}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const started = [], ended = [];
  const am = new AccountManager([{ name: 'test', type: 'apikey', apiKey: 'fake' }], .98);
  const proxy = createProxyServer(am,
    { proxy: {}, holdSeconds: 120, upstream: `http://127.0.0.1:${upstream.address().port}` },
    { onRequestStart: id => started.push(id), onRequestEnd: (id, info) => ended.push({ id, ...info }) });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const url = `http://127.0.0.1:${proxy.address().port}`;
  function upload(headers = {}) {
    const req = http.request(`${url}/v1/messages`, { method: 'POST', headers });
    const outcome = new Promise(resolve => {
      req.once('response', res => { res.resume(); res.once('end', () => resolve(res.statusCode)); res.once('error', () => resolve('truncated')); });
      req.once('error', () => resolve('closed'));
    });
    t.after(() => req.destroy());
    req.flushHeaders();
    return { req, outcome };
  }
  return { am, url, upload, started, ended, forwarded: () => forwarded, upstreamClosed: () => upstreamClosed };
}

test('disconnect during a quota hold clears activity without waiting for the retry timer', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  f.am.getActiveAccount = () => null;
  const client = f.upload(); client.req.end('{}');
  await until(() => f.started.length === 1);
  await delay(20);
  client.req.destroy();
  await until(() => f.ended.length === 1);
  assert.equal(f.ended[0].status, 499);
  assert.equal(f.forwarded(), 0);
});

test('silent or oversized buffered upstream responses are truncated, not held or reported complete', { timeout: 4000 }, async t => {
  const f = await fixture(t, { TEAMCLAUDE_RESPONSE_BODY_MAX_BYTES: '1024', TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS: '50' });
  for (const mode of ['silent', 'large']) {
    const client = f.upload({ 'x-test-response': mode }); client.req.end('{}');
    const result = await Promise.race([client.outcome, delay(500, 'hung')]);
    assert.ok(result === 'closed' || result === 'truncated', `${mode}: ${result}`);
  }
  await until(() => f.ended.length === 2);
  const good = f.upload(); good.req.end('{}');
  assert.equal(await good.outcome, 200);
});

test('disconnect before upstream headers cancels upstream and closes activity promptly', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  const client = f.upload({ 'x-test-stall': '1' }); client.req.end('{}');
  await until(() => f.forwarded() === 1);
  client.req.destroy();
  await until(() => f.upstreamClosed() === 1);
  await until(() => f.ended.length === 1);
  assert.equal(f.ended[0].status, 499);
});

test('overload and queued disconnect close activity entries; control plane bypasses admission', { timeout: 4000 }, async t => {
  const f = await fixture(t, { TEAMCLAUDE_REQUEST_BODY_TIMEOUT_MS: '2000', TEAMCLAUDE_INGRESS_QUEUE_TIMEOUT_MS: '1000' });
  const first = f.upload(); first.req.write('{');
  await until(() => f.started.length === 1);
  const queued = f.upload(); queued.req.write('{');
  await until(() => f.started.length === 2);
  const rejected = f.upload(); rejected.req.end('{}');
  assert.equal(await rejected.outcome, 503);
  await until(() => f.ended.some(e => e.status === 503));
  assert.equal((await fetch(`${f.url}/teamclaude/status`, { signal: AbortSignal.timeout(500) })).status, 200);
  queued.req.destroy();
  await until(() => f.ended.some(e => e.status === 499));
  // The cancelled request must free the queue immediately, not on admission.
  const replacement = f.upload(); replacement.req.end('{}');
  await until(() => f.started.length === 4);
  first.req.end('}');
  assert.equal(await first.outcome, 200);
  assert.equal(await replacement.outcome, 200);
  await until(() => f.ended.length === 4);
  assert.equal(new Set(f.ended.map(e => e.id)).size, 4);
  assert.equal(f.forwarded(), 2);
});

test('queue and trickling-body deadlines return errors and recover permits', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  const slow = f.upload(); slow.req.write('{');
  const trickle = setInterval(() => slow.req.write(' '), 25);
  t.after(() => clearInterval(trickle));
  await until(() => f.started.length === 1);
  const queued = f.upload(); queued.req.end('{}');
  assert.equal(await queued.outcome, 503);
  assert.equal(await slow.outcome, 408);
  clearInterval(trickle);
  const good = f.upload(); good.req.end('{}');
  assert.equal(await good.outcome, 200);
  await until(() => f.ended.length === 3);
  assert.equal(f.forwarded(), 1);
});

test('declared and chunked oversized bodies get 413 without upstream traffic; boundary body succeeds', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  const declared = f.upload({ 'content-length': '1025' });
  assert.equal(await declared.outcome, 413);
  const chunked = f.upload(); chunked.req.write('x'.repeat(1025));
  assert.equal(await chunked.outcome, 413);
  assert.equal(f.forwarded(), 0);
  const good = f.upload(); good.req.end(JSON.stringify({ x: 'a'.repeat(1016) }));
  assert.equal(await good.outcome, 200);
  await until(() => f.ended.length === 3);
  assert.deepEqual(f.ended.map(e => e.status), [413, 413, 200]);
});

test('disconnect mid-upload releases its permit and closes activity exactly once', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  const broken = f.upload(); broken.req.write('{');
  await until(() => f.started.length === 1);
  broken.req.destroy();
  await until(() => f.ended.length === 1);
  assert.equal(f.ended[0].status, 499);
  const next = f.upload(); next.req.end('{}');
  assert.equal(await next.outcome, 200);
  await until(() => f.ended.length === 2);
  assert.equal(f.forwarded(), 1);
});

test('h2 upload rejection closes only its stream; another stream on the session succeeds', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  const gate = new AdmissionGate(1, 1);
  // Exercise the same compatibility request listener used by MITM, without
  // generating certificates or contacting a real account.
  const h2 = http2.createServer(createProxyRequestListener({ accountManager: f.am, upstream: f.url, ingressGate: gate }));
  await new Promise(r => h2.listen(0, '127.0.0.1', r));
  const client = http2.connect(`http://127.0.0.1:${h2.address().port}`);
  t.after(() => { client.destroy(); h2.close(); });
  const post = body => new Promise((resolve, reject) => {
    const req = client.request({ ':method': 'POST', ':path': '/v1/messages' });
    let status;
    req.on('response', headers => { status = headers[':status']; });
    req.on('error', reject); req.resume();
    req.on('end', () => resolve(status));
    req.end(body);
  });
  assert.equal(await post('x'.repeat(1025)), 413);
  assert.equal(client.destroyed, false);
  assert.equal(await post('{}'), 200);
  assert.deepEqual(gate.status(), { active: 0, queued: 0, limit: 1, maxQueue: 1 });
});

test('repeated large-body bursts preserve status responsiveness and drain admission', { timeout: 15000 }, async t => {
  const f = await fixture(t, { TEAMCLAUDE_INGRESS_CONCURRENCY: '2', TEAMCLAUDE_INGRESS_QUEUE: '4',
    TEAMCLAUDE_REQUEST_BODY_MAX_BYTES: String(2 * 1024 * 1024), TEAMCLAUDE_REQUEST_BODY_TIMEOUT_MS: '5000',
    TEAMCLAUDE_INGRESS_QUEUE_TIMEOUT_MS: '2000' });
  const body = JSON.stringify({ model: 'claude-test', messages: [{ content: 'x'.repeat(1024 * 1024) }] });
  const latencies = [];
  let successes = 0, rejected = 0;
  for (let round = 0; round < 5; round++) {
    const clients = Array.from({ length: 12 }, () => {
      const client = f.upload(); client.req.write(body.slice(0, 128)); return client;
    });
    const burst = Promise.all(clients.map(c => c.outcome));
    await until(() => f.started.length === (round + 1) * 12);
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const r = await fetch(`${f.url}/teamclaude/status`, { signal: AbortSignal.timeout(1000) });
      assert.equal(r.status, 200);
      const { ingress } = await r.json();
      latencies.push(performance.now() - start);
      assert.ok(ingress.active <= 2 && ingress.queued <= 4);
    }
    for (const client of clients) if (!client.req.destroyed) client.req.end(body.slice(128));
    for (const status of await burst) {
      assert.ok(status === 200 || status === 503, `unexpected burst status ${status}`);
      if (status === 200) successes++; else rejected++;
    }
    await until(() => f.ended.length === (round + 1) * 12);
    const { ingress } = await (await fetch(`${f.url}/teamclaude/status`)).json();
    assert.equal(ingress.active, 0); assert.equal(ingress.queued, 0);
  }
  assert.ok(successes > 0 && rejected > 0);
  assert.equal(f.forwarded(), successes);
  assert.equal(new Set(f.ended.map(e => e.id)).size, 60);
  latencies.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ requests: 60, successes, rejected, statusProbes: latencies.length,
    medianMs: latencies[12], p95Ms: latencies[23], maxMs: latencies[24] }));
});
