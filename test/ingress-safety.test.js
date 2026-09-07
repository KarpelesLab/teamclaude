import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

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
  let forwarded = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    forwarded++;
    res.end('{}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const started = [], ended = [];
  const proxy = createProxyServer(new AccountManager([{ name: 'test', type: 'apikey', apiKey: 'fake' }], .98),
    { proxy: {}, upstream: `http://127.0.0.1:${upstream.address().port}` },
    { onRequestStart: id => started.push(id), onRequestEnd: (id, info) => ended.push({ id, ...info }) });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const url = `http://127.0.0.1:${proxy.address().port}`;
  function upload(headers = {}) {
    const req = http.request(`${url}/v1/messages`, { method: 'POST', headers });
    const outcome = new Promise(resolve => {
      req.once('response', res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      req.once('error', () => resolve('closed'));
    });
    t.after(() => req.destroy());
    req.flushHeaders();
    return { req, outcome };
  }
  return { url, upload, started, ended, forwarded: () => forwarded };
}

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
