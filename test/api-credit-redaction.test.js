import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { createToolSet } from '../src/mcp-tools.js';
import { CreditMonitor } from '../src/api-credit.js';
import { renderStatus } from '../src/status-renderer.js';

// `credit.adminKey` is an Admin API key: full admin access to the organization.
// It must reach Anthropic's cost report and nothing else — no status or quota
// payload, no MCP tool, no state file, no log line, and not even when an
// upstream error quotes it back. Each payload below is checked as raw text, so
// a field added later under any name is caught too.

const KEY = 'sk-ant-admin01-redaction-test-SECRET-9f8e7d6c5b4a';
const DAY = 86_400_000;
const listen = (/** @type {http.Server} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(/** @type {any} */ (s.address()).port)));

async function fleet() {
  const entries = [{
    name: 'credit-key', type: 'apikey', apiKey: 'sk-ant-api03-k', disabled: true,
    credit: { amount: 200, cycleStart: new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10), adminKey: KEY },
  }];
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const am = new AccountManager(entries, 0.98);
    // One good read, then a failure whose upstream text quotes the key back.
    const answers = [
      { ok: true, spentMinor: 2345, currency: 'USD', buckets: 4, pages: 1 },
      { ok: false, kind: 'credential', status: 401, message: `Admin API key rejected (HTTP 401): invalid x-api-key ${KEY}` },
    ];
    const monitor = new CreditMonitor(am, { log: (l) => lines.push(l), fetchSpend: async () => /** @type {any} */ (answers.shift()) });
    await monitor.poll(am.accounts[0]);
    await monitor.poll(am.accounts[0]);
    return { am, config: { proxy: { mcp: 'read' }, accounts: entries, routes: [] }, lines };
  } finally { console.log = log; }
}

/** @param {string} label @param {unknown} payload */
function assertNoKey(label, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  assert.ok(!text.includes(KEY), `${label} carries the admin key`);
  assert.ok(!text.includes('SECRET-9f8e'), `${label} carries part of the admin key`);
  assert.ok(!/adminKey/i.test(text), `${label} names an adminKey field`);
}

test('the admin key is in no in-process payload, and the credit is', async () => {
  const { am, lines } = await fleet();
  const status = am.getStatus();
  assert.equal(status.accounts[0].credit.source, 'admin');
  assert.equal(status.accounts[0].credit.spentMinor, 2345);
  assert.equal(status.accounts[0].credit.error.kind, 'credential');
  assert.match(status.accounts[0].credit.error.message, /\[admin key\]/);
  assertNoKey('getStatus', status);
  const quota = am.getQuotaSummary();
  assert.equal(quota.accounts[0].credit.spentMinor, 2345);
  assertNoKey('getQuotaSummary', quota);
  assertNoKey('exportQuotaState (the state file)', am.exportQuotaState());
  assertNoKey('renderStatus', renderStatus({ ...status, accounts: status.accounts }, { color: false }));
  assert.ok(lines.length > 0, 'nothing was logged, so the log check proves nothing');
  for (const line of lines) assertNoKey(`log line "${line}"`, line);
});

test('the admin key is in neither HTTP endpoint', async () => {
  const { am, config } = await fleet();
  const upstream = http.createServer((_q, r) => { r.writeHead(500); r.end(); });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(am, { ...config, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    for (const path of ['/teamclaude/status', '/teamclaude/quota']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await res.text();
      assert.equal(res.status, 200, path);
      assert.match(text, /"credit"/, `${path} carries no credit, so this proves nothing`);
      assertNoKey(path, text);
    }
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('the admin key is in no MCP tool result', async () => {
  const { am, config } = await fleet();
  const tools = createToolSet('read', { accountManager: am, config, hooks: {}, client: 'ci' });
  const status = await tools.call('get_status', {});
  assert.notEqual(status.isError, true);
  assert.equal(status.structuredContent.accounts[0].credit.spentMinor, 2345);
  assertNoKey('get_status', status);
  const quota = await tools.call('get_quota', {});
  assert.equal(quota.structuredContent.accounts[0].credit.spentMinor, 2345);
  assertNoKey('get_quota', quota);
  assertNoKey('get_settings', await tools.call('get_settings', {}));
});
