import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { createTelemetry } from '../src/telemetry.js';
import { closedPort } from '../test-helpers/spawn-server.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

// Opt-in OTLP export. Each test runs the real proxy in front of a fake upstream
// and a local OTLP/HTTP collector, all on ephemeral ports. Nothing waits on the
// clock: a test awaits the proxy's own onRequestEnd hook and then an explicit
// telemetry.flush(), so the collector has received what the test reads.

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 3600_000;
const PROMPT = 'SECRET PROMPT TEXT 7f3a';
const ACCOUNT_KEY_PREFIX = 'acct-key-';
const CLIENT_KEY = 'client-key-SECRET-44d2';
const COLLECTOR_TOKEN = 'collector-SECRET-TOKEN-5b8d';
const WORKLOAD = 'WORKLOAD-SECRET-3e';
const OWNER = 'pool-owner@example.test';
const USAGE = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 };

// The Codex stream fixtures mirror test/stream-failure-failover.test.js.
const WIRE = {
  input_tokens: 54904,
  input_tokens_details: { cached_tokens: 46592 },
  output_tokens: 132,
  output_tokens_details: { reasoning_tokens: 18 },
  total_tokens: 55036,
};
const frame = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const sse = (...events) => events.map(frame).join('');
const CREATED = { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', object: 'response', status: 'in_progress', usage: null } };
const IN_PROGRESS = { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1', object: 'response', status: 'in_progress', usage: null } };
const DELTA = { type: 'response.output_text.delta', sequence_number: 2, delta: 'hi' };
const COMPLETED = { type: 'response.completed', sequence_number: 3, response: { id: 'resp_1', object: 'response', status: 'completed', usage: WIRE } };
const OVERLOADED = { type: 'error', sequence_number: 2, error: { code: 'server_is_overloaded', message: 'Selected model is at capacity.' } };
const FAILED = { type: 'response.failed', sequence_number: 3, response: { id: 'resp_1', object: 'response', status: 'failed', error: { code: 'server_is_overloaded', message: 'Selected model is at capacity.' }, usage: null } };

// A local OTLP/HTTP collector. Every POST is kept, and `received` resolves on the
// first one. `hang` never answers: a collector that is up but too slow to matter.
async function collector({ hang = false } = {}) {
  const posts = [];
  let onFirst;
  const received = new Promise(resolve => { onFirst = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    posts.push({ url: req.url, headers: req.headers, raw, body: JSON.parse(raw) });
    onFirst();
    if (hang) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    posts,
    received,
    spans: () => posts.flatMap(p => p.body.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans))),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

// OTLP JSON attribute list as a plain object. int64 values arrive as strings.
function attrs(span) {
  return Object.fromEntries(span.attributes.map(({ key, value }) => [
    key, 'intValue' in value ? Number(value.intValue) : Object.values(value)[0],
  ]));
}
const requestSpans = (spans) => spans.filter(s => s.name === 'teamclaude.request');
const attemptSpans = (spans) => spans.filter(s => s.name === 'teamclaude.attempt');
const usageRecords = (spans) => spans.filter(s => 'teamclaude.usage.source' in attrs(s));

// A proxy in front of a fake upstream. `respond(req, res, seen)` answers each
// upstream request after its body has been read; `seen` holds one entry per
// upstream attempt, in order. `whenEnded(n)` resolves once the proxy has run its
// activity-end hook n times, which is where the telemetry request is finished.
async function withProxy({ provider = 'anthropic', accounts = ['pool-a'], respond, telemetry, proxy = {} }, run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { seen.push(req.headers); respond(req, res, seen); });
  });
  const upstreamPort = await listen(upstream);
  const make = (name) => provider === 'codex'
    ? { name: `codex:${name}`, type: 'oauth', provider: 'codex', accountId: `acct-${name}`, accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR, upstream: `http://127.0.0.1:${upstreamPort}` }
    : { name, type: 'apikey', apiKey: `${ACCOUNT_KEY_PREFIX}${name}`, upstream: `http://127.0.0.1:${upstreamPort}` };
  const accountManager = new AccountManager(accounts.map(make), 0.98);
  const ends = [];
  const waiters = [];
  const whenEnded = (n) => new Promise(resolve => {
    const check = () => { if (ends.length >= n) resolve(); else waiters.push(check); };
    check();
  });
  const hooks = {
    telemetry,
    onRequestEnd: (_id, info) => { ends.push(info); for (const w of waiters.splice(0)) w(); },
  };
  const proxyServer = createProxyServer(accountManager, { proxy, upstream: `http://127.0.0.1:${upstreamPort}` }, hooks);
  const port = await listen(proxyServer);
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run({ port, seen, whenEnded });
  } finally {
    console.log = origLog;
    console.error = origErr;
    proxyServer.closeAllConnections();
    proxyServer.close();
    upstream.closeAllConnections();
    upstream.close();
  }
}

function postMessages(port, { stream = false, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, stream, messages: [{ role: 'user', content: PROMPT }] }),
  });
}

function postCodex(port) {
  return fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'session-id': 'sess-otlp' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: [], stream: true }),
  });
}

const anthropicJson = (usage) => JSON.stringify({ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage });

// ------------------------------------------------------------------ acceptance

test('non-streaming: a 500 fails over, one request span, two attempt spans, one usage record from the 200', async () => {
  const col = await collector();
  const telemetry = createTelemetry({ telemetry: { otlp: { endpoint: col.endpoint } } }, {});
  try {
    await withProxy({
      accounts: ['pool-a', 'pool-b'], telemetry,
      respond: (_req, res, seen) => {
        if (seen.length === 1) {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end('{"type":"error","error":{"type":"api_error","message":"boom"}}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(anthropicJson(USAGE));
      },
    }, async ({ port, whenEnded }) => {
      const res = await postMessages(port, { headers: { 'x-request-id': 'caller-nonstream-1' } });
      assert.equal(res.status, 200);
      await res.text();
      await whenEnded(1);
    });
    await telemetry.flush();
  } finally {
    await telemetry.shutdown();
    col.close();
  }

  const spans = col.spans();
  assert.equal(requestSpans(spans).length, 1, 'one request span');
  const [request] = requestSpans(spans);
  const attempts = attemptSpans(spans).sort((a, b) => attrs(a)['teamclaude.attempt.number'] - attrs(b)['teamclaude.attempt.number']);
  assert.equal(attempts.length, 2, 'one span per upstream attempt');
  assert.deepEqual(attempts.map(s => attrs(s)['http.response.status_code']), [500, 200]);
  for (const a of attempts) {
    assert.equal(a.traceId, request.traceId);
    assert.equal(a.parentSpanId, request.spanId, 'attempts are children of the request');
  }
  const r = attrs(request);
  assert.equal(r['teamclaude.attempts'], 2);
  assert.equal(r['teamclaude.outcome'], 'completed');
  assert.equal(r['http.response.status_code'], 200);
  assert.equal(r['teamclaude.route'], 'anthropic.messages');
  assert.equal(r['teamclaude.request.caller_id'], 'caller-nonstream-1');
  assert.equal(typeof r['teamclaude.request.internal_id'], 'number');
  assert.equal(r['teamclaude.client'], 'none');
  assert.equal(r['teamclaude.usage.input_tokens'], USAGE.input_tokens);
  assert.equal(r['teamclaude.usage.output_tokens'], USAGE.output_tokens);
  assert.equal(r['teamclaude.usage.cache_read_input_tokens'], USAGE.cache_read_input_tokens);
  assert.equal(r['teamclaude.usage.cache_creation_input_tokens'], USAGE.cache_creation_input_tokens);
  assert.equal(r['teamclaude.usage.source'], 'anthropic.messages.original');
  assert.equal(usageRecords(spans).length, 1, 'exactly one usage record');
});

test('streaming: a refusal inside the first 200 stream hops once; exactly one usage record, from the delivered stream', async () => {
  const col = await collector();
  const telemetry = createTelemetry({ telemetry: { otlp: { endpoint: col.endpoint } } }, {});
  try {
    await withProxy({
      provider: 'codex', accounts: ['one', 'two'], telemetry,
      respond: (_req, res, seen) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (seen.length === 1) return res.end(sse(CREATED, OVERLOADED, FAILED));
        res.end(sse(CREATED, IN_PROGRESS, DELTA, COMPLETED));
      },
    }, async ({ port, whenEnded }) => {
      const res = await postCodex(port);
      assert.equal(res.status, 200);
      await res.text();
      await whenEnded(1);
    });
    await telemetry.flush();
  } finally {
    await telemetry.shutdown();
    col.close();
  }

  const spans = col.spans();
  assert.equal(requestSpans(spans).length, 1, 'one request span');
  assert.equal(attemptSpans(spans).length, 2, 'two attempts: the refusing stream and its sibling');
  assert.equal(usageRecords(spans).length, 1, 'exactly one usage record');
  const r = attrs(requestSpans(spans)[0]);
  assert.equal(r['teamclaude.route'], 'codex.responses');
  assert.equal(r['teamclaude.attempts'], 2);
  assert.equal(r['teamclaude.outcome'], 'completed');
  assert.equal(r['teamclaude.usage.input_tokens'], WIRE.input_tokens - WIRE.input_tokens_details.cached_tokens);
  assert.equal(r['teamclaude.usage.cache_read_input_tokens'], WIRE.input_tokens_details.cached_tokens);
  assert.equal(r['teamclaude.usage.output_tokens'], WIRE.output_tokens);
  assert.equal(r['teamclaude.usage.source'], 'openai.responses.normalized');
});

test('all attempts fail: outcome failed, two attempt spans, no usage record', async () => {
  const col = await collector();
  const telemetry = createTelemetry({ telemetry: { otlp: { endpoint: col.endpoint } } }, {});
  try {
    await withProxy({
      accounts: ['pool-a', 'pool-b'], telemetry,
      respond: (_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"api_error","message":"down"}}');
      },
    }, async ({ port, whenEnded }) => {
      const res = await postMessages(port);
      assert.equal(res.status, 500);
      await res.text();
      await whenEnded(1);
    });
    await telemetry.flush();
  } finally {
    await telemetry.shutdown();
    col.close();
  }

  const spans = col.spans();
  assert.equal(requestSpans(spans).length, 1);
  assert.equal(attemptSpans(spans).length, 2);
  const r = attrs(requestSpans(spans)[0]);
  assert.equal(r['teamclaude.outcome'], 'failed');
  assert.equal(r['http.response.status_code'], 500);
  assert.equal(usageRecords(spans).length, 0, 'no usage was reported, so none is recorded');
});

test('client disconnect mid-stream: outcome abandoned, at most one usage record, no throw, queue drains', async () => {
  const col = await collector();
  const telemetry = createTelemetry({ telemetry: { otlp: { endpoint: col.endpoint } } }, {});
  try {
    await withProxy({
      accounts: ['pool-a'], telemetry,
      respond: (_req, res, seen) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (seen.length > 1) return res.end(anthropicJson(USAGE));
        // The head and message_start go out; the stream then stays open.
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","usage":{"input_tokens":9,"cache_read_input_tokens":4,"output_tokens":1}}}\n\n');
      },
    }, async ({ port, whenEnded }) => {
      const res = await postMessages(port, { stream: true });
      const reader = res.body.getReader();
      await reader.read();
      await reader.cancel();
      await whenEnded(1);

      // The proxy is still serving after the abandonment.
      const next = await postMessages(port);
      assert.equal(next.status, 200);
      await next.text();
      await whenEnded(2);
    });
    await telemetry.flush();
    assert.equal(telemetry.getHealth().queued, 0, 'the queue drains');
  } finally {
    await telemetry.shutdown();
    col.close();
  }

  const spans = col.spans();
  const outcomes = requestSpans(spans).map(s => attrs(s)['teamclaude.outcome']).sort();
  assert.deepEqual(outcomes, ['abandoned', 'completed']);
  const abandoned = requestSpans(spans).find(s => attrs(s)['teamclaude.outcome'] === 'abandoned');
  assert.ok(usageRecords(spans).filter(s => s.spanId === abandoned.spanId).length <= 1, 'at most one usage record for the abandoned request');
});

test('secrecy: no prompt, credential, client key, email, collector token or workload header reaches the collector', async () => {
  const col = await collector();
  const telemetry = createTelemetry({
    telemetry: { otlp: { endpoint: col.endpoint, headers: { authorization: `Bearer ${COLLECTOR_TOKEN}` } } },
  }, {});
  try {
    await withProxy({
      accounts: [OWNER, 'pool-b'], telemetry,
      proxy: { clientKeys: [{ name: 'ci-runner', key: CLIENT_KEY }] },
      respond: (_req, res, seen) => {
        if (seen.length === 1) {
          res.writeHead(500, { 'content-type': 'application/json' });
          return res.end('{"type":"error"}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(anthropicJson(USAGE));
      },
    }, async ({ port, whenEnded }) => {
      const res = await postMessages(port, {
        headers: { 'x-api-key': CLIENT_KEY, 'x-teamclaude-workload': WORKLOAD },
      });
      assert.equal(res.status, 200);
      await res.text();
      await whenEnded(1);
    });
    await telemetry.flush();

    // The header the collector asked for is sent to it, and never into a payload.
    assert.equal(col.posts[0].headers.authorization, `Bearer ${COLLECTOR_TOKEN}`);
    const everything = col.posts.map(p => p.raw).join('\n');
    for (const secret of [PROMPT, ACCOUNT_KEY_PREFIX, CLIENT_KEY, COLLECTOR_TOKEN, WORKLOAD, OWNER]) {
      assert.equal(everything.includes(secret), false, `payload must not contain ${secret}`);
    }
    // No attribute value carries an '@', and the account that is an email is
    // exported only as a stable hash.
    const spans = col.spans();
    for (const span of spans) {
      for (const value of Object.values(attrs(span))) {
        if (typeof value === 'string') assert.equal(value.includes('@'), false, `attribute value has '@': ${value}`);
      }
    }
    const accounts = attemptSpans(spans).map(s => attrs(s)['teamclaude.account']);
    assert.equal(accounts.filter(a => /^sha256:[0-9a-f]{24}$/.test(a)).length, 1, 'the email account is a hash');
    assert.ok(accounts.includes('pool-b'), 'a plain account name is exported as it is');
    assert.equal(attrs(requestSpans(spans)[0])['teamclaude.client'], 'ci-runner');
  } finally {
    await telemetry.shutdown();
    col.close();
  }
});

test('disabled: no endpoint means no export and status reports enabled:false', async () => {
  const telemetry = createTelemetry({}, {});
  assert.deepEqual(telemetry.getHealth(), { enabled: false, queued: 0, exported: 0, dropped: 0, failures: 0, lastError: null });

  // A proxy request through a disabled exporter sends nothing to any collector.
  const realFetch = globalThis.fetch;
  const traceCalls = [];
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    if (url.includes('/v1/traces')) traceCalls.push(url);
    return realFetch(input, init);
  };
  try {
    await withProxy({
      accounts: ['pool-a'], telemetry,
      respond: (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(anthropicJson(USAGE)); },
    }, async ({ port, whenEnded }) => {
      const res = await postMessages(port);
      assert.equal(res.status, 200);
      await res.text();
      await whenEnded(1);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(traceCalls.length, 0);
  await telemetry.flush();
  assert.equal(telemetry.getHealth().enabled, false);
});

test('disabled and enabled-but-idle exporters do not keep the process alive', async () => {
  const module = new URL('../src/telemetry.js', import.meta.url).href;
  const script = `
    const { createTelemetry } = await import(${JSON.stringify(module)});
    const idle = createTelemetry({ telemetry: { otlp: { endpoint: 'http://127.0.0.1:1' } } }, {});
    const off = createTelemetry({}, {});
    console.log(JSON.stringify([idle.getHealth().enabled, off.getHealth().enabled]));
  `;
  // The child gets an empty environment, so nothing from this shell can turn export on.
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH } });
  assert.equal(stdout.trim(), '[true,false]');
});

test('collector down: requests still succeed, failures and drops are counted, and no endpoint leaks into health', async () => {
  const telemetry = createTelemetry({ telemetry: { otlp: { endpoint: `http://127.0.0.1:${await closedPort()}` } } }, {});
  try {
    await withProxy({
      accounts: ['pool-a'], telemetry,
      respond: (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(anthropicJson(USAGE)); },
    }, async ({ port, whenEnded }) => {
      for (let i = 1; i <= 3; i++) {
        const res = await postMessages(port);
        assert.equal(res.status, 200, 'the request is served regardless of the collector');
        await res.text();
        await whenEnded(i);
      }
    });
    await telemetry.flush();
    const health = telemetry.getHealth();
    assert.equal(health.exported, 0);
    assert.ok(health.failures >= 1, 'the refused export is counted');
    assert.ok(health.dropped >= 1, 'the spans it carried are counted as dropped');
    assert.doesNotMatch(health.lastError ?? '', /127\.0\.0\.1|http/, 'lastError names no endpoint');
  } finally {
    await telemetry.shutdown();
  }
});

test('collector slow: a request completes while its export is still unanswered', { timeout: 30_000 }, async () => {
  const col = await collector({ hang: true });
  const telemetry = createTelemetry({ telemetry: { otlp: { endpoint: col.endpoint } } }, {});
  try {
    await withProxy({
      accounts: ['pool-a'], telemetry,
      respond: (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(anthropicJson(USAGE)); },
    }, async ({ port, whenEnded }) => {
      const first = await postMessages(port);
      assert.equal(first.status, 200);
      await first.text();
      await whenEnded(1);

      // Send the batch now. The collector receives it and never answers.
      const flushing = telemetry.flush();
      await col.received;
      const second = await postMessages(port);
      assert.equal(second.status, 200, 'served while the export is outstanding');
      await second.text();
      await whenEnded(2);
      await flushing;
    });
    assert.ok(telemetry.getHealth().failures >= 1, 'the timed-out export is counted');
  } finally {
    await telemetry.shutdown();
    col.close();
  }
});

test('queue cap: 600 finished requests against a refusing collector stay within 512 queued, and every span is accounted for', async () => {
  // Driven through the exporter directly with no await in between, so the batch
  // in flight and the queue depth are the same on every run.
  const telemetry = createTelemetry({ telemetry: { otlp: { endpoint: `http://127.0.0.1:${await closedPort()}` } } }, {});
  for (let i = 0; i < 600; i++) {
    const req = telemetry.startRequest({ method: 'POST', path: '/v1/messages', provider: 'anthropic', model: 'claude-opus-5', client: null, internalId: i, callerId: `c${i}` });
    req.finish({ status: 200, outcome: 'completed', attempts: 0 });
  }
  // 64 went out in the first batch, 512 are queued, and 24 were refused at the cap.
  const during = telemetry.getHealth();
  assert.equal(during.queued, 512);
  assert.equal(during.dropped, 24);
  await telemetry.shutdown();
  const after = telemetry.getHealth();
  assert.equal(after.queued, 0);
  assert.equal(after.exported, 0);
  assert.equal(after.dropped, 600, 'every span is counted as dropped, none silently');
});
