import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { McpError, handleMcpMessage, serveMcp } from '../src/mcp.js';

const MODERN = '2026-07-28';
const SERVER_INFO = { name: 'teamclaude', version: '0.0.0-test' };

const tools = {
  list: () => [{ name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object' } }],
  call: async (name, args) => {
    if (name !== 'echo') throw new McpError(-32602, `Unknown tool: ${name}`);
    return { content: [{ type: 'text', text: JSON.stringify(args) }] };
  },
};

const send = (message, headers = {}) => handleMcpMessage({
  bodyText: typeof message === 'string' ? message : JSON.stringify(message),
  headers,
  tools,
  serverInfo: SERVER_INFO,
  instructions: 'test server',
});

const modernMeta = (version = MODERN) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

/** A request as a client on the stateless revision sends it: metadata in the
 *  body, mirrored into the headers. */
function modern(method, params = {}, headerOverrides = {}) {
  const headers = { 'mcp-protocol-version': MODERN, 'mcp-method': method };
  if (params.name) headers['mcp-name'] = params.name;
  return send(
    { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: modernMeta() } },
    { ...headers, ...headerOverrides },
  );
}

test('initialize answers in a revision the client asked for when it is a known one', async () => {
  const reply = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.id, 1);
  assert.equal(reply.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(reply.body.result.capabilities, { tools: {} });
  assert.deepEqual(reply.body.result.serverInfo, SERVER_INFO);
  assert.equal(reply.body.result.instructions, 'test server');
});

test('initialize falls back to the newest handshake revision for an unknown request', async () => {
  for (const asked of ['1999-01-01', MODERN, undefined]) {
    const reply = await send({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: asked } });
    assert.equal(reply.body.result.protocolVersion, '2025-11-25', `asked for ${asked}`);
  }
});

test('a notification is accepted without a body', async () => {
  const reply = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.deepEqual(reply, { status: 202, body: null });
});

test('ping is answered', async () => {
  const reply = await send({ jsonrpc: '2.0', id: 7, method: 'ping' });
  assert.deepEqual(reply, { status: 200, body: { jsonrpc: '2.0', id: 7, result: {} } });
});

test('a handshake-era client lists and calls tools without per-request metadata', async () => {
  const list = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.result, { tools: tools.list() });

  const call = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
  assert.deepEqual(call.body.result, { content: [{ type: 'text', text: '{"a":1}' }] });
});

test('a stateless-revision request is answered with a complete result', async () => {
  const list = await modern('tools/list');
  assert.equal(list.status, 200);
  assert.equal(list.body.result.resultType, 'complete');
  assert.deepEqual(list.body.result.tools, tools.list());
  // Caching hints are mandatory on a list result in this revision; a client
  // that validates the result refuses the whole list without them.
  assert.ok(Number.isInteger(list.body.result.ttlMs) && list.body.result.ttlMs >= 0, 'ttlMs');
  assert.equal(list.body.result.cacheScope, 'public');

  const call = await modern('tools/call', { name: 'echo', arguments: { b: 2 } });
  assert.equal(call.body.result.resultType, 'complete');
  assert.deepEqual(call.body.result.content, [{ type: 'text', text: '{"b":2}' }]);
  assert.equal('ttlMs' in call.body.result, false, 'a call result is not cacheable');
  // With no session to remember it from, every result says who answered.
  for (const reply of [list, call]) {
    assert.deepEqual(reply.body.result._meta, { 'io.modelcontextprotocol/serverInfo': SERVER_INFO });
  }
});

test('a stateless-revision request without its client capabilities is malformed', async () => {
  const meta = modernMeta();
  delete meta['io.modelcontextprotocol/clientCapabilities'];
  const reply = await send(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } },
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
  );
  assert.equal(reply.status, 400);
  assert.equal(reply.body.error.code, -32602);
  assert.match(reply.body.error.message, /clientCapabilities/);
});

test('server/discover names the revisions, the capabilities and the server', async () => {
  const reply = await modern('server/discover');
  assert.equal(reply.status, 200);
  const { result } = reply.body;
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.supportedVersions, [MODERN, '2025-11-25', '2025-06-18', '2025-03-26']);
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.deepEqual(result._meta, { 'io.modelcontextprotocol/serverInfo': SERVER_INFO });
  assert.equal(result.instructions, 'test server');
  assert.ok(Number.isInteger(result.ttlMs) && result.ttlMs >= 0, 'ttlMs');
  assert.equal(result.cacheScope, 'public');
});

test('a tool name that cannot travel as a plain header arrives base64-wrapped', async () => {
  const encoded = `=?base64?${Buffer.from('echo').toString('base64')}?=`;
  const reply = await modern('tools/call', { name: 'echo', arguments: {} }, { 'mcp-name': encoded });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.result.resultType, 'complete');
});

test('headers that disagree with the body are refused as a header mismatch', async () => {
  const cases = [
    ['a different method', () => modern('tools/list', {}, { 'mcp-method': 'tools/call' })],
    ['a different tool', () => modern('tools/call', { name: 'echo' }, { 'mcp-name': 'other' })],
    ['no tool header', () => modern('tools/call', { name: 'echo' }, { 'mcp-name': undefined })],
    ['no method header', () => modern('tools/list', {}, { 'mcp-method': undefined })],
    ['no version header', () => modern('tools/list', {}, { 'mcp-protocol-version': undefined })],
    ['a different version', () => modern('tools/list', {}, { 'mcp-protocol-version': '2025-06-18' })],
  ];
  for (const [what, run] of cases) {
    const reply = await run();
    assert.equal(reply.status, 400, what);
    assert.equal(reply.body.error.code, -32020, what);
    assert.equal(reply.body.id, 1, what);
  }
});

test('a version header for the stateless revision without the body metadata is a mismatch', async () => {
  const reply = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' });
  assert.equal(reply.status, 400);
  assert.equal(reply.body.error.code, -32020);
});

test('an unsupported revision is refused with the list of supported ones', async () => {
  const reply = await send(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta('2031-01-01') } },
    { 'mcp-protocol-version': '2031-01-01', 'mcp-method': 'tools/list' },
  );
  assert.equal(reply.status, 400);
  assert.equal(reply.body.error.code, -32022);
  assert.deepEqual(reply.body.error.data, {
    supported: [MODERN, '2025-11-25', '2025-06-18', '2025-03-26'],
    requested: '2031-01-01',
  });
});

test('an unknown method is a 404 on the stateless revision and a plain error before it', async () => {
  const stateless = await modern('resources/list');
  assert.equal(stateless.status, 404);
  assert.equal(stateless.body.error.code, -32601);

  const handshake = await send({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
  assert.equal(handshake.status, 200);
  assert.equal(handshake.body.error.code, -32601);
  assert.equal(handshake.body.id, 9);
});

test('the handshake does not exist on the stateless revision', async () => {
  const reply = await modern('initialize');
  assert.equal(reply.status, 404);
  assert.equal(reply.body.error.code, -32601);
});

test('an unknown tool and malformed call parameters are protocol errors', async () => {
  const unknown = await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.error.code, -32602);
  assert.match(unknown.body.error.message, /Unknown tool: nope/);

  for (const params of [undefined, {}, { name: 5 }, { name: 'echo', arguments: [] }, { name: 'echo', arguments: 'x' }]) {
    const reply = await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    assert.equal(reply.body.error.code, -32602, JSON.stringify(params));
  }
});

test('a tool that throws something unexpected is an internal error with no detail', async () => {
  const broken = { list: tools.list, call: async () => { throw new Error('secret path /home/op/.config'); } };
  const reply = await handleMcpMessage({
    bodyText: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }),
    headers: {},
    tools: broken,
    serverInfo: SERVER_INFO,
  });
  assert.equal(reply.body.error.code, -32603);
  assert.doesNotMatch(JSON.stringify(reply.body), /secret path/);
});

test('text that is not JSON is a parse error', async () => {
  const reply = await send('{not json');
  assert.equal(reply.status, 400);
  assert.deepEqual(reply.body, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
});

test('a batch, a non-object and a message without a method are invalid requests', async () => {
  for (const message of [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], 'null', '5', { jsonrpc: '2.0', id: 1 }, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 5 }]) {
    const reply = await send(message);
    assert.equal(reply.status, 400, JSON.stringify(message));
    assert.equal(reply.body.error.code, -32600, JSON.stringify(message));
  }
});

// ── over HTTP ───────────────────────────────────────────────

async function readBody(req, limit = 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function withMcpServer(fn) {
  const server = http.createServer((req, res) => {
    serveMcp(req, res, { readBody, tools, serverInfo: SERVER_INFO });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('only POST is served', async () => {
  await withMcpServer(async url => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(url, { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'POST', method);
      await res.arrayBuffer();
    }
  });
});

test('a request is answered as JSON and a notification with an empty 202', async () => {
  await withMcpServer(async url => {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 1, result: {} });

    const note = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(note.status, 202);
    assert.equal(await note.text(), '');
  });
});

test('a body past the cap is refused before it is parsed', async () => {
  await withMcpServer(async url => {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(4096) } }) });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, -32600);
  });
});
