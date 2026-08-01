import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// End-to-end through the real proxy against a stand-in Codex backend. The
// fixture tests prove the translators; this proves the wiring around them —
// that a codex account rewrites the URL, sends Codex headers, translates the
// request body, and streams back Anthropic events.

function codexAccount(extra = {}) {
  return {
    name: 'codex-1', type: 'oauth', protocol: 'codex', accountId: 'acct-xyz',
    accessToken: 'codex-token', refreshToken: 'r',
    expiresAt: Date.now() + 3600_000, ...extra,
  };
}

const d = obj => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

/** A fake Codex backend that records what it received and replays a script. */
async function startFakeCodex(events, { status = 200 } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'server_error', message: 'boom' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of events) res.write(e);
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, received, url: `http://127.0.0.1:${server.address().port}` };
}

async function startProxy(account) {
  const am = new AccountManager([account], 0.98);
  const server = createProxyServer(am, { proxy: { port: 0 }, upstream: 'https://api.anthropic.com' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { am, server, url: `http://127.0.0.1:${server.address().port}` };
}

function request(url, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

const SCRIPT = [
  d({ type: 'response.created', response: { id: 'resp_e2e', model: 'gpt-5.6-sol' } }),
  d({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm' } }),
  d({ type: 'response.content_part.added', output_index: 0, part: { type: 'output_text' } }),
  d({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello' }),
  d({ type: 'response.output_text.delta', output_index: 0, delta: ' from codex' }),
  d({ type: 'response.content_part.done', output_index: 0, part: { type: 'output_text', text: 'Hello from codex' } }),
  d({ type: 'response.completed', response: { id: 'resp_e2e', usage: { input_tokens: 12, output_tokens: 4 } } }),
];

test('a streaming request round-trips through a codex account', async () => {
  const codex = await startFakeCodex(SCRIPT);
  const proxy = await startProxy(codexAccount({ upstream: codex.url }));

  try {
    const res = await request(proxy.url, {
      model: 'claude-fable-5', max_tokens: 100, stream: true,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(res.status, 200);

    // Upstream saw a Responses API call, not an Anthropic one.
    const sent = codex.received[0];
    assert.equal(sent.url, '/responses');
    assert.equal(sent.headers['authorization'], 'Bearer codex-token');
    assert.equal(sent.headers['chatgpt-account-id'], 'acct-xyz');
    assert.equal(sent.headers['originator'], 'codex-tui');
    assert.match(sent.headers['user-agent'], /^codex-tui\//);
    assert.ok(sent.headers['session_id']);

    const sentBody = JSON.parse(sent.body);
    assert.equal(sentBody.stream, true);
    assert.equal(sentBody.store, false);
    assert.deepEqual(sentBody.input[0], {
      type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: 'Be brief.' }],
    });

    // Client saw Anthropic events, not Responses ones.
    assert.match(res.body, /event: message_start/);
    assert.match(res.body, /event: content_block_start/);
    assert.match(res.body, /"text_delta"/);
    assert.match(res.body, /event: message_stop/);
    assert.doesNotMatch(res.body, /response\.output_text\.delta/);

    const text = [...res.body.matchAll(/"text_delta","text":"([^"]*)"/g)].map(m => m[1]).join('');
    assert.equal(text, 'Hello from codex');
  } finally {
    proxy.server.close();
    codex.server.close();
  }
});

test('usage from a translated stream is credited to the account', async () => {
  const codex = await startFakeCodex(SCRIPT);
  const proxy = await startProxy(codexAccount({ upstream: codex.url }));

  try {
    await request(proxy.url, {
      model: 'claude-fable-5', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Quota accounting reads the translated frames, so it works for codex too.
    const usage = proxy.am.accounts[0].usage;
    assert.equal(usage.totalOutputTokens, 4);
    assert.equal(usage.totalRequests > 0, true);
  } finally {
    proxy.server.close();
    codex.server.close();
  }
});

test('a non-streaming request gets a Messages object, not SSE', async () => {
  const codex = await startFakeCodex(SCRIPT);
  const proxy = await startProxy(codexAccount({ upstream: codex.url }));

  try {
    const res = await request(proxy.url, {
      model: 'claude-fable-5', max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);

    const message = JSON.parse(res.body);
    assert.equal(message.type, 'message');
    assert.equal(message.role, 'assistant');
    assert.equal(message.stop_reason, 'end_turn');
    assert.deepEqual(message.content, [{ type: 'text', text: 'Hello from codex' }]);
    assert.equal(message.usage.output_tokens, 4);

    // Codex is always asked for a stream regardless of what the client wanted.
    assert.equal(JSON.parse(codex.received[0].body).stream, true);
  } finally {
    proxy.server.close();
    codex.server.close();
  }
});

test('a tool call round-trips into an Anthropic tool_use block', async () => {
  const script = [
    d({ type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } }),
    d({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'c1', name: 'get_weather' } }),
    d({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc', delta: '{"city":"NYC"}' }),
    d({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'c1', name: 'get_weather', arguments: '{"city":"NYC"}' } }),
    d({ type: 'response.completed', response: { id: 'r', output: [{ type: 'function_call', id: 'fc', call_id: 'c1', name: 'get_weather', arguments: '{"city":"NYC"}' }], usage: { input_tokens: 5, output_tokens: 9 } } }),
  ];
  const codex = await startFakeCodex(script);
  const proxy = await startProxy(codexAccount({ upstream: codex.url }));

  try {
    const res = await request(proxy.url, {
      model: 'claude-fable-5', max_tokens: 100,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    });

    const message = JSON.parse(res.body);
    assert.equal(message.stop_reason, 'tool_use');
    assert.deepEqual(message.content, [
      { type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'NYC' } },
    ]);
  } finally {
    proxy.server.close();
    codex.server.close();
  }
});

test('modelMap selects the upstream model named in the translated request', async () => {
  const codex = await startFakeCodex(SCRIPT);
  const proxy = await startProxy(codexAccount({
    upstream: codex.url,
    modelMap: { 'claude-fable-5': 'gpt-5.6-sol', 'claude-opus-5': 'gpt-5.6-terra' },
  }));

  try {
    await request(proxy.url, {
      model: 'claude-opus-5', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(JSON.parse(codex.received[0].body).model, 'gpt-5.6-terra');
  } finally {
    proxy.server.close();
    codex.server.close();
  }
});

test('an endpoint with no Responses equivalent is refused, not forwarded', async () => {
  const codex = await startFakeCodex(SCRIPT);
  const proxy = await startProxy(codexAccount({ upstream: codex.url }));

  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${proxy.url}/v1/messages/count_tokens`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
      }, r => {
        let body = '';
        r.on('data', c => { body += c; });
        r.on('end', () => resolve({ status: r.statusCode, body }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ model: 'claude-fable-5', messages: [] }));
    });

    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error.type, 'not_found_error');
    // Nothing reached the backend.
    assert.equal(codex.received.length, 0);
  } finally {
    proxy.server.close();
    codex.server.close();
  }
});

test('a truncated codex stream still closes its content block', async () => {
  // Upstream dies after opening a text block and never sends response.completed.
  const truncated = [
    d({ type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } }),
    d({ type: 'response.content_part.added', output_index: 0, part: { type: 'output_text' } }),
    d({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }),
  ];
  const codex = await startFakeCodex(truncated);
  const proxy = await startProxy(codexAccount({ upstream: codex.url }));

  try {
    const res = await request(proxy.url, {
      model: 'claude-fable-5', max_tokens: 100, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Without the end() flush the client would wait forever on an open block.
    assert.match(res.body, /event: content_block_stop/);
  } finally {
    proxy.server.close();
    codex.server.close();
  }
});
