import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { allowLoopbackForward } from '../src/forward-target.js';
import { createProxyServer, backendQuotaHeaders, reloadedHeaderFlags } from '../src/server.js';

const HOUR = 3600_000;
const now = Date.now();
const FIVE_RESET = now + 2 * HOUR;
const WEEK_RESET = now + 3 * 24 * HOUR;
const WINDOWS = {
  fiveHour: { utilization: 0.52, resetAt: FIVE_RESET },
  weekly: { utilization: 0.12, resetAt: WEEK_RESET },
  monthly: { utilization: 0.05, resetAt: now + 20 * 24 * HOUR },
};

test('each live window becomes a utilization and an epoch-seconds reset', () => {
  assert.deepEqual(backendQuotaHeaders(WINDOWS, now), {
    'anthropic-ratelimit-unified-5h-utilization': '0.52',
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(FIVE_RESET / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': '0.12',
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor(WEEK_RESET / 1000)),
    'anthropic-ratelimit-unified-status': 'allowed',
  });
});

test('a window without a future reset is left out — Claude Code would drop it anyway', () => {
  const h = backendQuotaHeaders({
    fiveHour: { utilization: 0.3, resetAt: null },
    weekly: { utilization: 0.4, resetAt: now - 1 },
  }, now);
  assert.deepEqual(h, {}, 'nothing to state, not even a status');
});

test('any window may be missing, and only the present ones are stated', () => {
  const onlyWeek = backendQuotaHeaders({ weekly: WINDOWS.weekly, monthly: WINDOWS.monthly }, now);
  assert.equal(onlyWeek['anthropic-ratelimit-unified-5h-utilization'], undefined);
  assert.equal(onlyWeek['anthropic-ratelimit-unified-7d-utilization'], '0.12');
  assert.deepEqual(backendQuotaHeaders({ monthly: WINDOWS.monthly }, now), {}, 'a monthly window has no header');
  assert.deepEqual(backendQuotaHeaders(undefined, now), {});
});

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function upstreamWith(headers = {}) {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify({ ok: true }));
    });
  });
}

async function through(configExtra, upstreamHeaders = {}) {
  const upstream = upstreamWith(upstreamHeaders);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(
    [{ name: 'kimi', type: 'apikey', apiKey: 'sk-test', upstream: `http://127.0.0.1:${upstreamPort}` }],
    0.98,
  );
  am.accounts[0].quota.backend = { label: 'Plan', text: '5h 52%', utilization: 0.52, at: now, windows: WINDOWS };
  const seen = [];
  const original = am.updateQuota.bind(am);
  am.updateQuota = (index, headers, model) => { seen.push({ ...headers }); return original(index, headers, model); };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, ...configExtra });
  allowLoopbackForward(proxy);
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    return { res, seen, am };
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('enabled: a backend response carries the synthesized windows, and quota tracking never sees them', async () => {
  const { res, seen, am } = await through({ synthesizeQuotaHeaders: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('anthropic-ratelimit-unified-5h-utilization'), '0.52');
  assert.equal(res.headers.get('anthropic-ratelimit-unified-7d-reset'), String(Math.floor(WEEK_RESET / 1000)));
  assert.equal(res.headers.get('anthropic-ratelimit-unified-status'), 'allowed');
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).filter(k => k.startsWith('anthropic-ratelimit-')), [], 'updateQuota got the upstream originals');
  assert.equal(am.accounts[0].quota.unified5h, null, 'the synthetic reading is not fed back as an Anthropic one');
});

for (const [label, extra] of [['unset (the default)', {}], ['false', { synthesizeQuotaHeaders: false }]]) {
  test(`synthesizeQuotaHeaders ${label}: nothing is added`, async () => {
    const { res } = await through(extra);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('anthropic-ratelimit-unified-5h-utilization'), null);
    assert.equal(res.headers.get('anthropic-ratelimit-unified-status'), null);
  });
}

test('an upstream that states its own unified quota is never overwritten', async () => {
  const own = {
    'anthropic-ratelimit-unified-status': 'allowed_warning',
    'anthropic-ratelimit-unified-5h-utilization': '0.9',
  };
  const { res } = await through({ synthesizeQuotaHeaders: true }, own);
  assert.equal(res.headers.get('anthropic-ratelimit-unified-5h-utilization'), '0.9');
  assert.equal(res.headers.get('anthropic-ratelimit-unified-status'), 'allowed_warning');
  assert.equal(res.headers.get('anthropic-ratelimit-unified-7d-utilization'), null, 'and nothing is mixed in beside it');
});

test('a reload copies both client-header flags off the disk config', () => {
  assert.deepEqual(reloadedHeaderFlags({ synthesizeQuotaHeaders: true }), { stripOverageHeaders: false, synthesizeQuotaHeaders: true });
  assert.deepEqual(reloadedHeaderFlags({ stripOverageHeaders: true }), { stripOverageHeaders: true, synthesizeQuotaHeaders: false });
  assert.deepEqual(reloadedHeaderFlags({ synthesizeQuotaHeaders: 'yes' }), { stripOverageHeaders: false, synthesizeQuotaHeaders: false }, 'only a literal true enables');
  assert.deepEqual(reloadedHeaderFlags({}), { stripOverageHeaders: false, synthesizeQuotaHeaders: false }, 'a removed key turns it off');
});

test('an error response carries no synthesized quota: the proxy did not judge it', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(
    [{ name: 'kimi', type: 'apikey', apiKey: 'sk-test', upstream: `http://127.0.0.1:${upstreamPort}` }],
    0.98,
  );
  am.accounts[0].quota.backend = { label: 'Plan', text: '5h 52%', utilization: 0.52, at: now, windows: WINDOWS };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, synthesizeQuotaHeaders: true });
  allowLoopbackForward(proxy);
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('anthropic-ratelimit-unified-status'), null);
    assert.equal(res.headers.get('anthropic-ratelimit-unified-5h-utilization'), null);
  } finally {
    proxy.close();
    upstream.close();
  }
});
