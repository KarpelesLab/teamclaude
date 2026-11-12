import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { ClientUsageTracker } from '../src/client-usage.js';
import { recordSeatRejection } from '../src/client-routes.js';
import { createProxyServer } from '../src/server.js';

const MODEL = 'gemini-3-pro-preview';
const CLAUDE_MODEL = 'claude-haiku-4-5';
const USAGE = { input_tokens: 11, cache_read_tokens: 7, output_tokens: 5, total_tokens: 16 };
const SID = 'sess-openai-chat';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function completion(stream = false, usage = USAGE) {
  return {
    id: 'chatcmpl-native-gemini-id',
    model: 'upstream-model-name',
    choices: [{ message: { role: 'assistant', content: 'final answer' }, finish_reason: 'stop' }],
    usage,
    ...(stream ? { stream: true } : {}),
  };
}

async function fixture({ stream = false, agyHandler = null, claudeHandler = null, clientRoutes = null, extraGemini = false } = {}) {
  const agyRequests = [];
  const agy = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    agyRequests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (agyHandler) return agyHandler(req, res);
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { id: 'chatcmpl-native-gemini-id', choices: [{ delta: { role: 'assistant', content: 'final ' } }] },
        { id: 'chatcmpl-native-gemini-id', choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
        { id: 'chatcmpl-native-gemini-id', choices: [], usage: { input_tokens: 10, cache_read_tokens: 7, output_tokens: 4, total_tokens: 14 } },
        { id: 'chatcmpl-native-gemini-id', choices: [], usage: USAGE },
      ];
      const wire = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      for (let i = 0; i < wire.length; i += 7) {
        res.write(wire.subarray(i, i + 7));
      }
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion()));
  });
  const claudeRequests = [];
  const claude = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    claudeRequests.push(req);
    if (claudeHandler) return claudeHandler(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_claude', type: 'message', role: 'assistant', model: 'claude-x', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const agyPort = await listen(agy);
  const claudePort = await listen(claude);
  const accounts = [
    {
      name: 'gemini', type: 'apikey', apiKey: 'gemini-secret', adapter: 'openai-chat',
      upstream: `http://127.0.0.1:${agyPort}/agy`, modelPrefix: 'gemini-', serverHeader: 'agy-test',
      adapterHeaders: { 'x-bridge-client-ip': '127.0.0.1' },
    },
    { name: 'claude', type: 'apikey', apiKey: 'claude-secret', upstream: `http://127.0.0.1:${claudePort}` },
  ];
  if (extraGemini) {
    accounts.push({
      name: 'gemini-2', type: 'apikey', apiKey: 'gemini-2-secret', adapter: 'openai-chat',
      upstream: `http://127.0.0.1:${agyPort}/agy`, modelPrefix: 'gemini-', serverHeader: 'agy-test',
    });
  }
  const am = new AccountManager(accounts, 0.98, { clientRoutes });
  const clientUsage = new ClientUsageTracker();
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'shared', clientKeys: [{ name: 'alice', key: 'alice-key' }] },
  }, {}, null, clientUsage);
  const port = await listen(proxy);
  return {
    am, clientUsage, agyRequests, claudeRequests,
    async close() { proxy.close(); agy.close(); claude.close(); },
    async post(body, { path = '/v1/messages', headers = {}, rawBody = false, session = SID } = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-api-key': 'alice-key',
          ...(session ? { 'x-claude-code-session-id': session } : {}), ...headers,
        },
        body: rawBody ? body : JSON.stringify(body),
      });
      return { status: res.status, body: await res.text() };
    },
  };
}

const request = (stream = false, extra = {}) => ({
  model: MODEL, messages: [], max_tokens: 50, stream, ...extra,
});

for (const stream of [false, true]) {
  test(`${stream ? 'streaming' : 'buffered'} agy response translates and settles exact usage once in every scope`, async () => {
    const ctx = await fixture({ stream });
    try {
      const res = await ctx.post(request(stream, { output_config: { effort: 'high' } }));
      assert.equal(res.status, 200, res.body);
      assert.equal(ctx.agyRequests.length, 1);
      assert.equal(ctx.claudeRequests.length, 0);
      const upstream = ctx.agyRequests[0];
      assert.equal(upstream.url, '/agy/v1/chat/completions');
      assert.equal(upstream.headers.authorization, 'Bearer gemini-secret');
      assert.equal(upstream.headers['x-api-key'], undefined);
      assert.equal(upstream.headers.server, 'agy-test');
      assert.equal(upstream.headers['x-bridge-client-ip'], '127.0.0.1', 'the server-owned admission header did not reach the sidecar exactly');
      assert.equal(upstream.body.model, MODEL, 'the native ID was prefixed twice');
      assert.equal(upstream.body.reasoning_effort, 'high');
      if (stream) assert.deepEqual(upstream.body.stream_options, { include_usage: true });

      const events = res.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
      const message = stream ? events[0].message : JSON.parse(res.body);
      assert.equal(message.id, 'chatcmpl-native-gemini-id');
      assert.equal(message.model, MODEL);
      assert.equal(res.body.includes('tool_use'), false);
      if (stream) {
        assert.equal(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join(''), 'final answer');
        assert.deepEqual(events.find(event => event.type === 'message_delta').usage, {
          input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 0, output_tokens: 5,
        });
      } else {
        assert.deepEqual(message.content, [{ type: 'text', text: 'final answer' }]);
        assert.deepEqual(message.usage, {
          input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 0, output_tokens: 5,
        });
      }

      const account = ctx.am.accounts[0];
      assert.equal(account.usage.totalInputTokens, 11, 'agy input was changed or booked twice');
      assert.equal(account.usage.totalCacheReadTokens, 7);
      assert.equal(account.usage.totalOutputTokens, 5, 'thinking/output was booked twice');
      assert.equal(account.usage.totalCacheCreationTokens, 0);
      const client = ctx.clientUsage.export().alice;
      assert.equal(client.requests, 1);
      assert.equal(client.inputTokens, 11);
      assert.equal(client.cacheReadTokens, 7);
      assert.equal(client.outputTokens, 5);
      assert.equal(client.cacheCreationTokens, 0);
      const session = ctx.am.sessionTracker.sessions.get(SID)?.tokens.get('unified7d');
      assert.ok(session, 'no session usage was recorded');
      assert.equal(session.input, 11);
      assert.equal(session.cacheRead, 7);
      assert.equal(session.cacheCreation, 0);
      assert.equal(session.output, 5);
      assert.equal(session.context, 18);
      assert.equal(session.reports, 1, 'cumulative chunks became more than one session report');
    } finally {
      await ctx.close();
    }
  });
}

test('Claude Code no-op envelopes reach agy without their client-only fields', async () => {
  const ctx = await fixture({ stream: true });
  try {
    for (const thinking of [{ type: 'adaptive', display: 'omitted' }, { type: 'adaptive' }]) {
      const res = await ctx.post(request(true, {
        tools: [],
        thinking,
        context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
        output_config: { effort: 'high' },
      }));
      assert.equal(res.status, 200, res.body);
    }
    assert.equal(ctx.agyRequests.length, 2);
    for (const upstream of ctx.agyRequests) {
      assert.equal(upstream.body.tools, undefined);
      assert.equal(upstream.body.thinking, undefined);
      assert.equal(upstream.body.context_management, undefined);
      assert.equal(upstream.body.reasoning_effort, 'high');
      assert.equal(upstream.body.stream, true);
      assert.deepEqual(upstream.body.stream_options, { include_usage: true });
    }
    assert.equal(ctx.claudeRequests.length, 0);
  } finally {
    await ctx.close();
  }
});

test('unsupported requests and count_tokens are refused before either upstream', async () => {
  const ctx = await fixture();
  try {
    const invalid = [
      request(false, { tools: [{ name: 'external' }] }),
      request(false, { messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }),
      request(false, { output_config: { effort: 'xhigh' } }),
      request(false, { thinking: { type: 'enabled' } }),
      request(false, { thinking: { type: 'adaptive', display: 'visible' } }),
      request(false, { context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'none' }] } }),
    ];
    for (const body of invalid) {
      const res = await ctx.post(body);
      assert.equal(res.status, 400, res.body);
    }
    const count = await ctx.post(request(), { path: '/v1/messages/count_tokens?beta=true' });
    assert.equal(count.status, 400, count.body);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 0);
  } finally {
    await ctx.close();
  }
});

test('ordinary Claude requests cannot select Gemini and disabled Gemini never falls back to Claude', async () => {
  const ctx = await fixture();
  try {
    const ordinary = await ctx.post(request(false, { model: 'claude-sonnet-4-6' }));
    assert.equal(ordinary.status, 200, ordinary.body);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 1);
    assert.equal(ctx.claudeRequests[0].headers['x-bridge-client-ip'], undefined,
      'an unrelated account emitted the Gemini admission header');

    ctx.am.setDisabled(0, true);
    const gemini = await ctx.post(request());
    assert.notEqual(gemini.status, 200);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 1, 'a disabled Gemini account leaked its model to Claude');
  } finally {
    await ctx.close();
  }
});

test('explicit and session pins enforce model compatibility in both directions', async () => {
  const ctx = await fixture();
  try {
    for (const [path, model] of [
      ['/tc-acct/claude/v1/messages', MODEL],
      ['/tc-acct/gemini/v1/messages', 'claude-sonnet-4-6'],
    ]) {
      const res = await ctx.post(request(false, { model }), { path });
      assert.equal(res.status, 400, res.body);
    }
    ctx.am.sessionPins.set(SID, 'claude');
    const pinned = await ctx.post(request());
    assert.equal(pinned.status, 400, pinned.body);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 0);
  } finally {
    await ctx.close();
  }
});

test('escaped and duplicate model IDs cannot bypass explicit pin compatibility', async () => {
  const ctx = await fixture();
  const escaped = JSON.stringify(request()).replace('gemini-', 'gemini\\u002d');
  const duplicateGemini = JSON.stringify(request()).replace('"model":', '"model":"claude-x","model":');
  const duplicateEscaped = duplicateGemini.replace('gemini-', `${String.fromCharCode(92)}u0067emini-`);
  const duplicateClaude = JSON.stringify(request(false, { model: 'claude-x' }))
    .replace('"model":', `"model":"${MODEL}","model":`);
  const escapedAdvisor = JSON.stringify({
    model: 'claude-x', messages: [],
    tools: [{ type: 'advisor_20260301', name: 'advisor', model: MODEL }],
  }).replace('gemini-', 'gemini\\u002d');
  try {
    for (const [path, body] of [
      ['/tc-acct/claude/v1/messages', escaped],
      ['/tc-acct/claude/v1/messages', duplicateGemini],
      ['/tc-acct/claude/v1/messages', duplicateEscaped],
      ['/tc-acct/gemini/v1/messages', duplicateClaude],
      ['/tc-acct/claude/v1/messages', escapedAdvisor],
    ]) {
      const res = await ctx.post(body, { path, rawBody: true });
      assert.equal(res.status, 400, res.body);
    }
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 0);
  } finally {
    await ctx.close();
  }
});

test('an escaped Gemini model cannot bypass a fixed ordinary seat', async () => {
  const ctx = await fixture({
    clientRoutes: [{ name: 'fixed', clients: ['alice'], accounts: ['claude'] }],
  });
  const escaped = JSON.stringify(request()).replace('gemini-', 'gemini\\u002d');
  try {
    const res = await ctx.post(escaped, { rawBody: true });
    assert.notEqual(res.status, 200, res.body);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 0);
  } finally {
    await ctx.close();
  }
});

test('removing Gemini cannot make a Claude account eligible for its model', async () => {
  const ctx = await fixture();
  try {
    ctx.am.sessionPins.set(SID, 'gemini');
    ctx.am.removeAccount(0);
    const res = await ctx.post(request());
    assert.notEqual(res.status, 200);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 0);
  } finally {
    await ctx.close();
  }
});

test('an agy failure never fails over to an ordinary Claude account', async () => {
  const ctx = await fixture({
    agyHandler: (_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'agy failed' } }));
    },
  });
  try {
    const res = await ctx.post(request());
    assert.equal(res.status, 500, res.body);
    assert.equal(ctx.agyRequests.length, 1);
    assert.equal(ctx.claudeRequests.length, 0);
  } finally {
    await ctx.close();
  }
});

test('a client-sent header can never replace or duplicate a server-owned adapterHeader', async () => {
  const ctx = await fixture();
  try {
    const res = await ctx.post(request(), { headers: { 'X-Bridge-Client-Ip': '10.0.0.99' } });
    assert.equal(res.status, 200, res.body);
    assert.equal(ctx.agyRequests.length, 1);
    // node joins repeated headers with a comma, so strict equality also proves
    // the client's casing did not slip a second copy of the header through.
    assert.equal(ctx.agyRequests[0].headers['x-bridge-client-ip'], '127.0.0.1');
  } finally {
    await ctx.close();
  }
});

test('every upstream attempt carries the adapterHeaders, including a same-account retry', async () => {
  let attempts = 0;
  const ctx = await fixture({
    agyHandler: (_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        // A throttling 429 (retry-after, no quota-rejection headers) is absorbed
        // inline: the proxy waits and retries the SAME account, rebuilding the
        // upstream headers for the second attempt (server.js forwardRequest).
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completion()));
    },
  });
  try {
    const res = await ctx.post(request(), { path: '/tc-acct/gemini/v1/messages' });
    assert.equal(res.status, 200, res.body);
    assert.equal(ctx.agyRequests.length, 2, 'the 429 was not retried on the pinned account');
    for (const attempt of ctx.agyRequests) {
      assert.equal(attempt.headers['x-bridge-client-ip'], '127.0.0.1', 'an attempt reached the sidecar without the exact admission header');
      assert.equal(attempt.headers.authorization, 'Bearer gemini-secret');
    }
    assert.equal(ctx.claudeRequests.length, 0);
  } finally {
    await ctx.close();
  }
});

test('fixed seats reject an incompatible model in both directions without upstream I/O', async () => {
  for (const [account, model] of [['claude', MODEL], ['gemini', 'claude-sonnet-4-6']]) {
    const ctx = await fixture({
      clientRoutes: [{ name: 'fixed', clients: ['alice'], accounts: [account] }],
    });
    try {
      const res = await ctx.post(request(false, { model }));
      assert.notEqual(res.status, 200, res.body);
      assert.equal(ctx.agyRequests.length, 0);
      assert.equal(ctx.claudeRequests.length, 0);
    } finally {
      await ctx.close();
    }
  }
});

for (const first of [MODEL, CLAUDE_MODEL]) {
  const second = first === MODEL ? CLAUDE_MODEL : MODEL;
  test(`a real fixed-seat conversation switches ${first} → ${second} → ${first}`, async () => {
    const ctx = await fixture({
      clientRoutes: [{ name: 'fixed', clients: ['alice'], accounts: ['gemini', 'claude'] }],
    });
    try {
      for (const model of [first, second, first]) {
        const res = await ctx.post(request(false, {
          model,
          messages: [{ role: 'user', content: 'one stable conversation opening' }],
          ...(model === MODEL ? {
            tools: [],
            thinking: { type: 'adaptive', display: 'omitted' },
            context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
          } : {}),
        }));
        assert.equal(res.status, 200, res.body);
      }
      assert.equal(ctx.agyRequests.length, first === MODEL ? 2 : 1);
      assert.equal(ctx.claudeRequests.length, first === CLAUDE_MODEL ? 2 : 1);
    } finally {
      await ctx.close();
    }
  });
}

test('direct mixed-seat requests without a session select either compatible account', async () => {
  const ctx = await fixture({
    clientRoutes: [{ name: 'fixed', clients: ['alice'], accounts: ['gemini', 'claude'] }],
  });
  try {
    for (const model of [MODEL, CLAUDE_MODEL, MODEL, CLAUDE_MODEL]) {
      const res = await ctx.post(request(false, {
        model,
        messages: [{ role: 'user', content: 'one stable conversation opening' }],
      }), { session: null });
      assert.equal(res.status, 200, res.body);
    }
    assert.equal(ctx.agyRequests.length, 2);
    assert.equal(ctx.claudeRequests.length, 2);
    assert.equal(ctx.am.sessionTracker.sessions.size, 0);
  } finally {
    await ctx.close();
  }
});

test('fixed mixed seats check advisor compatibility before a conversation pin', async () => {
  const ctx = await fixture({
    clientRoutes: [{ name: 'fixed', clients: ['alice'], accounts: ['gemini', 'claude'] }],
  });
  const messages = [{ role: 'user', content: 'one stable advisor conversation' }];
  const advisor = model => [{ type: 'advisor_20260301', name: 'advisor', model }];
  try {
    const initial = await ctx.post(request(false, {
      model: CLAUDE_MODEL, messages, tools: advisor(CLAUDE_MODEL),
    }));
    assert.equal(initial.status, 200, initial.body);

    const switched = await ctx.post(request(false, {
      model: MODEL, messages, tools: advisor(MODEL),
    }));
    assert.equal(switched.status, 400, switched.body);
    assert.match(switched.body, /unsupported request fields: tools/);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 1);

    const switchedBack = await ctx.post(request(false, {
      model: CLAUDE_MODEL, messages, tools: advisor(CLAUDE_MODEL),
    }));
    assert.equal(switchedBack.status, 200, switchedBack.body);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 2);

    const incompatible = await ctx.post(request(false, {
      model: CLAUDE_MODEL, messages, tools: advisor(MODEL),
    }));
    assert.equal(incompatible.status, 503, incompatible.body);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 2);
  } finally {
    await ctx.close();
  }
});

test('an incompatible pin cannot mask a compatible account throttle', async () => {
  const ctx = await fixture({
    clientRoutes: [{ name: 'fixed', clients: ['alice'], accounts: ['gemini', 'claude'] }],
  });
  const messages = [{ role: 'user', content: 'one stable throttled conversation' }];
  try {
    const initial = await ctx.post(request(false, { model: CLAUDE_MODEL, messages }));
    assert.equal(initial.status, 200, initial.body);
    ctx.am.accounts[0].status = 'throttled';
    ctx.am.accounts[0].rateLimitedUntil = Date.now() + 60_000;
    ctx.am.accounts[0].throttledAt = Date.now();

    const throttled = await ctx.post(request(false, { model: MODEL, messages }));
    assert.equal(throttled.status, 429, throttled.body);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 1);
  } finally {
    await ctx.close();
  }
});

test('an incompatible pin cannot mask a compatible account spent verdict', async () => {
  const ctx = await fixture({
    clientRoutes: [{ name: 'fixed', clients: ['alice'], accounts: ['gemini', 'claude'] }],
  });
  const messages = [{ role: 'user', content: 'one stable spent conversation' }];
  try {
    const initial = await ctx.post(request(false, { model: CLAUDE_MODEL, messages }));
    assert.equal(initial.status, 200, initial.body);
    recordSeatRejection(ctx.am.accounts[0], {
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-reset': Math.floor((Date.now() + 60_000) / 1000),
    }, MODEL);

    const spent = await ctx.post(request(false, { model: MODEL, messages }));
    assert.equal(spent.status, 429, spent.body);
    assert.equal(ctx.agyRequests.length, 0);
    assert.equal(ctx.claudeRequests.length, 1);
  } finally {
    await ctx.close();
  }
});

test('a model switch keeps the new conversation pin on upstream failure', async () => {
  const ctx = await fixture({
    extraGemini: true,
    agyHandler: (_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'agy failed' } }));
    },
    clientRoutes: [{ name: 'fixed', clients: ['alice'], accounts: ['gemini', 'claude', 'gemini-2'] }],
  });
  const messages = [{ role: 'user', content: 'one stable failing conversation' }];
  try {
    const initial = await ctx.post(request(false, { model: CLAUDE_MODEL, messages }));
    assert.equal(initial.status, 200, initial.body);
    const pinKey = [...ctx.am.sessionTracker.sessions.keys()][0];
    const session = ctx.am.sessionTracker.sessions.get(pinKey);
    const pin = session.pins.get('unified7d');
    session.pins.delete('unified7d');
    ctx.am.sessionTracker.touch(pinKey, pin.idx, 'unified7dFable');
    assert.equal(ctx.am.sessionTracker.pinnedAccount(pinKey, 'unified7d'), null);

    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await ctx.post(request(false, { model: MODEL, messages }));
      assert.equal(failed.status, 500, failed.body);
    }
    assert.equal(ctx.agyRequests.length, 2, 'the existing conversation silently hopped to a compatible sibling');
    for (const request of ctx.agyRequests) {
      assert.equal(request.headers.authorization, 'Bearer gemini-secret');
    }
    assert.equal(ctx.claudeRequests.length, 1);
  } finally {
    await ctx.close();
  }
});

test('a stream without usage completes without inventing a zero-valued report', async () => {
  const ctx = await fixture({
    stream: true,
    agyHandler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'chatcmpl-no-usage', choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    },
  });
  try {
    const res = await ctx.post(request(true));
    assert.equal(res.status, 200, res.body);
    assert.equal(ctx.am.accounts[0].usage.totalInputTokens, 0);
    assert.equal(ctx.am.accounts[0].usage.totalOutputTokens, 0);
    assert.equal(ctx.clientUsage.export().alice.inputTokens, 0);
    assert.equal(ctx.am.sessionTracker.sessions.get(SID)?.tokens.size, 0);
  } finally {
    await ctx.close();
  }
});
