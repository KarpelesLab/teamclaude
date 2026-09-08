import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// A client that goes away while forwardRequest is waiting on something — a
// quota-hold timer, an upstream that has not answered yet — must not keep that
// wait alive: the timer is cleared, the upstream request is torn down, and the
// activity row closes promptly as a 499 (not as a starvation, and not as the
// account's failure).

async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await delay(5); }
  assert.fail('condition did not settle within 1s');
}

async function fixture(t) {
  let forwarded = 0, upstreamClosed = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    forwarded++;
    if (req.headers['x-test-stall']) {
      // Never answer; the proxy's cancellation is what closes this socket.
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
  // No account can serve: with holdSeconds set the proxy holds the connection
  // and sleeps (60s here) before polling again. The sleep must end with the client.
  f.am.getActiveAccount = () => null;
  const client = f.upload(); client.req.end('{}');
  await until(() => f.started.length === 1);
  await delay(20);
  client.req.destroy();
  await until(() => f.ended.length === 1);
  assert.equal(f.ended[0].status, 499);
  assert.equal(f.forwarded(), 0);
});

test('disconnect before upstream headers cancels upstream and closes activity promptly', { timeout: 4000 }, async t => {
  const f = await fixture(t);
  const client = f.upload({ 'x-test-stall': '1' }); client.req.end('{}');
  await until(() => f.forwarded() === 1);
  client.req.destroy();
  await until(() => f.upstreamClosed() === 1);
  await until(() => f.ended.length === 1);
  assert.equal(f.ended[0].status, 499);
  // The account was not blamed: nothing was tried and failed on it.
  assert.equal(f.ended[0].account, 'test');
  assert.ok(!f.am.accounts[0].error);
});
