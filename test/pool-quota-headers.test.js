import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { allowLoopbackForward } from '../src/forward-target.js';
import { createProxyServer, poolQuotaHeaders } from '../src/server.js';

const HOUR = 3600_000;
const now = Date.now();
const P = 'anthropic-ratelimit-unified-';
const sec = (/** @type {number} */ ms) => String(Math.floor(ms / 1000));

const NEAR_CAP = {
  [`${P}status`]: 'allowed_warning',
  [`${P}5h-status`]: 'allowed_warning',
  [`${P}5h-utilization`]: '0.995',
  [`${P}5h-reset`]: sec(now + HOUR),
  [`${P}5h-surpassed-threshold`]: '0.9',
  [`${P}7d-status`]: 'allowed',
  [`${P}7d-utilization`]: '0.4',
  [`${P}7d-reset`]: sec(now + 48 * HOUR),
  [`${P}grace-5h-utilization`]: '0.1',
  [`${P}representative-claim`]: 'five_hour',
};

test('each stated window takes the pool reading, and every warning is cleared', () => {
  const h = { ...NEAR_CAP, 'content-type': 'application/json' };
  poolQuotaHeaders(h, {
    '5h': { utilization: 0.2, resetAt: now + 3 * HOUR },
    '7d': { utilization: 0.1, resetAt: now + 72 * HOUR },
    '7d_oi': { utilization: 0.3, resetAt: now + 72 * HOUR },
  });
  assert.deepEqual(h, {
    'content-type': 'application/json',
    [`${P}status`]: 'allowed',
    [`${P}5h-status`]: 'allowed',
    [`${P}5h-utilization`]: '0.2',
    [`${P}5h-reset`]: sec(now + 3 * HOUR),
    [`${P}7d-status`]: 'allowed',
    [`${P}7d-utilization`]: '0.1',
    [`${P}7d-reset`]: sec(now + 72 * HOUR),
    [`${P}representative-claim`]: 'five_hour',
  }, 'a window the upstream did not state (7d_oi) is not added');
});

test('a stated window no candidate has read loses its reading rather than keeping the near-cap one', () => {
  const h = { ...NEAR_CAP };
  poolQuotaHeaders(h, { '7d': { utilization: 0.1, resetAt: now + 72 * HOUR } });
  assert.equal(h[`${P}5h-utilization`], undefined);
  assert.equal(h[`${P}5h-reset`], undefined);
  assert.equal(h[`${P}5h-status`], 'allowed');
  assert.equal(h[`${P}7d-utilization`], '0.1');
});

test('a rejected overall status is not rewritten', () => {
  const h = { [`${P}status`]: 'rejected' };
  poolQuotaHeaders(h, {});
  assert.equal(h[`${P}status`], 'rejected');
});

function apiAccount(/** @type {string} */ name, /** @type {string} */ upstream, priority = 0) {
  return { name, type: 'apikey', apiKey: `sk-${name}`, upstream, priority };
}

test('poolQuotaReadings: null when no other account could serve, the lowest reading otherwise', () => {
  const am = new AccountManager([apiAccount('a', 'http://127.0.0.1:1'), apiAccount('b', 'http://127.0.0.1:1')], 0.98);
  const [a, b] = am.accounts;
  Object.assign(a.quota, { unified5h: 0.5, unified5hReset: now + HOUR, unified7d: 0.1, unified7dReset: now + 48 * HOUR });
  Object.assign(b.quota, { unified5h: 0.3, unified5hReset: now + 2 * HOUR, unified7d: 0.6, unified7dReset: now + 24 * HOUR });
  assert.deepEqual(am.poolQuotaReadings(a), {
    '5h': { utilization: 0.3, resetAt: now + 2 * HOUR },
    '7d': { utilization: 0.1, resetAt: now + 48 * HOUR },
  }, 'per window, paired with that reading\'s own reset');

  b.quota.unified5h = 0.99;
  assert.equal(am.poolQuotaReadings(a), null, 'b is past the switch threshold, so a is the last account');

  b.quota.unified5h = 0.3;
  a.quota.unified5h = 0.995;
  assert.deepEqual(am.poolQuotaReadings(a)['5h'], { utilization: 0.3, resetAt: now + 2 * HOUR },
    'a spent serving account is not a candidate itself');
});

async function listen(/** @type {http.Server} */ server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(/** @type {any} */ (server.address()).port)));
}

async function through(/** @type {number} */ accountCount, /** @type {Record<string, any>} */ configExtra, path = '/v1/messages') {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', ...NEAR_CAP });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const url = `http://127.0.0.1:${await listen(upstream)}`;
  const am = new AccountManager([apiAccount('a', url, 0), apiAccount('b', url, 1)].slice(0, accountCount), 0.98);
  if (accountCount > 1) {
    Object.assign(am.accounts[1].quota, { unified5h: 0.2, unified5hReset: now + 3 * HOUR, unified7d: 0.1, unified7dReset: now + 72 * HOUR });
  }
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, ...configExtra });
  allowLoopbackForward(proxy);
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
    return { res, am };
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('enabled with another account left: the client sees the pool, quota tracking sees the upstream', async () => {
  const { res, am } = await through(2, { poolQuotaHeaders: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get(`${P}status`), 'allowed');
  assert.equal(res.headers.get(`${P}5h-utilization`), '0.2');
  assert.equal(res.headers.get(`${P}5h-surpassed-threshold`), null);
  assert.equal(res.headers.get(`${P}grace-5h-utilization`), null);
  assert.equal(am.accounts[0].quota.unified5h, 0.995, 'the serving account still records its real reading');
});

test('enabled on the last account: its own headers pass through', async () => {
  const { res } = await through(1, { poolQuotaHeaders: true });
  assert.equal(res.headers.get(`${P}status`), 'allowed_warning');
  assert.equal(res.headers.get(`${P}5h-utilization`), '0.995');
  assert.equal(res.headers.get(`${P}5h-surpassed-threshold`), '0.9');
});

test('off by default: the serving account\'s headers pass through', async () => {
  const { res } = await through(2, {});
  assert.equal(res.headers.get(`${P}status`), 'allowed_warning');
  assert.equal(res.headers.get(`${P}5h-utilization`), '0.995');
});

test('enabled on a pinned request: rotation cannot help, so its own headers pass through', async () => {
  const { res } = await through(2, { poolQuotaHeaders: true }, '/tc-acct/a/v1/messages');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get(`${P}status`), 'allowed_warning');
  assert.equal(res.headers.get(`${P}5h-utilization`), '0.995');
});
