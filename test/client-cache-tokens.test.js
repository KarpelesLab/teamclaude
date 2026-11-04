import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { ClientUsageTracker, UsageDimensionTracker, createUsageRecorder } from '../src/client-usage.js';
import { createProxyServer } from '../src/server.js';

// Per-client usage booked only uncached input and output, while the cache
// reads and writes that are most of a cached turn reached the account counters
// alone. A gateway charging people by key had no way to see them, so each
// client record (and each usage dimension) now carries cacheReadTokens and
// cacheCreationTokens beside the other counters, in totals, windows and the
// saved state.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const PROXY = { apiKey: 'shared-key', clientKeys: [{ name: 'alice', key: 'alice-key' }] };

test('the recorder books cache reads and writes per client, window and dimension', () => {
  const clients = new ClientUsageTracker();
  const dims = new UsageDimensionTracker();
  const r = createUsageRecorder({ client: 'alice', clientUsage: clients, dimensions: [{ name: 'project', key: 'web' }], dimensionUsage: dims });
  r.onUsage(2, 7, 900, 40);
  const a = clients.export().alice;
  assert.equal(a.cacheReadTokens, 900);
  assert.equal(a.cacheCreationTokens, 40);
  assert.equal(a.windows['5h'].cacheReadTokens, 900);
  assert.equal(a.windows['24h'].cacheCreationTokens, 40);
  const w = dims.export().project.web;
  assert.equal(w.cacheReadTokens, 900);
  assert.equal(w.cacheCreationTokens, 40);
});

test('a caller passing only input and output books zero cache tokens', () => {
  const clients = new ClientUsageTracker();
  createUsageRecorder({ client: 'alice', clientUsage: clients, dimensions: [], dimensionUsage: null }).onUsage(3, 4);
  const a = clients.export().alice;
  assert.equal(a.inputTokens, 3);
  assert.equal(a.cacheReadTokens, 0);
  assert.equal(a.cacheCreationTokens, 0);
});

test('state saved before the cache counters existed restores with them at zero', () => {
  const t = new ClientUsageTracker();
  t.restore({ bob: { requests: 1, inputTokens: 3 } });
  assert.equal(t.export().bob.cacheReadTokens, 0);
  assert.equal(t.export().bob.cacheCreationTokens, 0);
});

test('cache counters survive an export/restore round trip', () => {
  const t = new ClientUsageTracker();
  t.record('alice', { inputTokens: 1, cacheReadTokens: 50, cacheCreationTokens: 5 });
  const back = new ClientUsageTracker();
  back.restore(t.export());
  assert.equal(back.export().alice.cacheReadTokens, 50);
  assert.equal(back.export().alice.cacheCreationTokens, 5);
});

test('end to end: an SSE and a JSON turn book their cache tokens against the key', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":800,"cache_creation_input_tokens":30}}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 200, cache_creation_input_tokens: 20 } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'acct', type: 'api_key', apiKey: 'sk-a' }], 0.98);
  const tracker = new ClientUsageTracker();
  const proxy = createProxyServer(am, { proxy: PROXY, upstream: `http://127.0.0.1:${upstreamPort}` }, {}, null, tracker);
  const proxyPort = await listen(proxy);
  const post = async (path) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'alice-key' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    await res.text();
  };
  try {
    await post('/stream');
    await post('/v1/messages');
    await new Promise(r => setTimeout(r, 50));
    const a = tracker.export().alice;
    assert.equal(a.cacheReadTokens, 1000);
    assert.equal(a.cacheCreationTokens, 50);
    // Cache is booked once, at message_start; message_delta adds output only.
    assert.equal(a.inputTokens, 17);
    assert.equal(a.outputTokens, 8);
  } finally {
    proxy.close();
    upstream.close();
  }
});
