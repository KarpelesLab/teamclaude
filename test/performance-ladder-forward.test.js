import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function post(port, model) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  return { status: res.status, body: await res.text() };
}

const ROUTES = [
  { name: 'gemini', match: ['*gemini*'], accounts: ['antigravity-gemini'] },
  { name: 'kimi', match: ['*kimi*'], accounts: ['cliproxy-kimi'] },
];

// Live tc 2026-10-25: gemini-4-argon 404/503 on antigravity-gemini, then
// forwardRequest's none-available ladder called routeForModel(config?.routes)
// and threw ReferenceError because forwardRequest is a module-level export.
test('exclusive gemini 503 does not 502 ReferenceError: config is not defined', async () => {
  const gemini = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'adapter unavailable' }));
    });
  });
  const kimi = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok', type: 'message', model: 'kimi-k3' }));
    });
  });
  const geminiPort = await listen(gemini);
  const kimiPort = await listen(kimi);

  const accounts = [
    {
      name: 'antigravity-gemini',
      type: 'apikey',
      apiKey: 'k1',
      upstream: `http://127.0.0.1:${geminiPort}`,
      priority: 0,
      strictModelMap: true,
      modelMap: { 'gemini-4-argon': 'gemini-4-argon' },
    },
    {
      name: 'cliproxy-kimi',
      type: 'apikey',
      apiKey: 'k2',
      upstream: `http://127.0.0.1:${kimiPort}`,
      priority: 1,
      strictModelMap: true,
      modelMap: { 'kimi-k3': 'kimi-k3', 'kimi-k2.8-code': 'kimi-k2.8-code' },
    },
  ];
  const am = new AccountManager(accounts, 0.98, { routes: ROUTES });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: 'http://invalid',
    routes: ROUTES,
  });
  const port = await listen(proxy);
  try {
    const out = await post(port, 'gemini-4-argon');
    assert.notEqual(out.status, 502, `must not crash the proxy: ${out.body.slice(0, 200)}`);
    assert.equal(out.body.includes('config is not defined'), false, out.body.slice(0, 300));
    // Exclusive gemini must not hop onto cliproxy-kimi; honest exhaustion is 429/503.
    assert.ok([429, 503].includes(out.status), `expected typed capacity error, got ${out.status} ${out.body.slice(0, 200)}`);
  } finally {
    await close(proxy);
    await close(gemini);
    await close(kimi);
  }
});
