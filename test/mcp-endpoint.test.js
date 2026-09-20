import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, keylessMcpRefusal } from '../src/server.js';

// The MCP endpoint is one more control-plane route, so it has to sit behind
// every gate the others sit behind — and, unlike them, it is off until the
// operator asks for it, in a mode that says how much it may do.

const ACCT_SECRET = 'sk-ant-account-secret';
const PROXY_KEY = 'tc-proxy-secret';
const CLIENT_KEY = 'tc-client-secret';
const SX_KEY = 'sx-secret';

const accounts = () => [
  { name: 'alice@example.com', type: 'apikey', apiKey: ACCT_SECRET, priority: 2 },
  { name: 'bob@example.com', type: 'apikey', apiKey: `${ACCT_SECRET}-2`, disabled: true, orgName: 'Acme\u00a0Labs' },
];

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withServer(proxy, fn, hooks = {}) {
  const am = new AccountManager(accounts(), 0.98);
  const config = {
    proxy,
    // Nothing listens there: a request that falls through to the forwarder
    // fails at once instead of reaching a real API.
    upstream: 'http://127.0.0.1:1',
    switchThreshold: 0.9,
    quotaProbeSeconds: 300,
    blockedModels: ['claude-opus-*'],
    routes: [{ name: 'opus', match: ['claude-opus-*'], accounts: ['alice@example.com'] }],
    sx: { apiKey: SX_KEY, mode: 'always' },
    upstreamProxy: 'http://user:proxy-password@proxy.example:3128',
    accounts: accounts(),
  };
  const server = createProxyServer(am, config, hooks);
  const port = await listen(server);
  try {
    await fn({ port, am, config });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const KEYED = { apiKey: PROXY_KEY, clientKeys: [{ name: 'ci', key: CLIENT_KEY }] };

function rpc(port, method, params, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/teamclaude/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
}

async function callTool(port, name, args = {}) {
  const res = await rpc(port, 'tools/call', { name, arguments: args });
  assert.equal(res.status, 200, name);
  return (await res.json());
}

// fetch() refuses to set Host, so the rebinding case drives http.request.
function postWithHost(port, host, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/teamclaude/mcp', method: 'POST',
      headers: { host, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('the endpoint answers 404 itself until proxy.mcp turns it on', async () => {
  for (const mcp of [undefined, 'off', false, true, 'write', 'FULL']) {
    await withServer({ ...KEYED, mcp }, async ({ port }) => {
      const res = await rpc(port, 'ping');
      assert.equal(res.status, 404, `proxy.mcp = ${JSON.stringify(mcp)}`);
      // Our own refusal, not whatever the upstream says about an unknown path:
      // falling through would forward the request with a fleet credential.
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(body.error, /proxy\.mcp/);
    });
  }
});

test('a trailing slash or a query string is still this endpoint, never the forwarder', async () => {
  const ping = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) };
  const spellings = ['/teamclaude/mcp/', '/teamclaude/mcp?session=1', '/teamclaude/mcp/?x=1'];
  await withServer({ ...KEYED, mcp: 'read' }, async ({ port }) => {
    for (const path of spellings) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, ping);
      assert.equal(res.status, 200, path);
      assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 1, result: {} }, path);
    }
    // A longer path is somebody else's, not a spelling of this one. Whatever
    // the forwarder makes of it against a dead upstream, it is not a pong.
    const other = await fetch(`http://127.0.0.1:${port}/teamclaude/mcpx`, ping).then(res => res.status, () => 'not served');
    assert.notEqual(other, 200);
  });
  await withServer({ ...KEYED }, async ({ port }) => {
    for (const path of spellings) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, ping);
      assert.equal(res.status, 404, path);
      assert.match((await res.json()).error, /proxy\.mcp/, path);
    }
  });
});

test('a client completes the handshake and lists tools', async () => {
  await withServer({ ...KEYED, mcp: 'read' }, async ({ port }) => {
    const init = await rpc(port, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.status, 200);
    const { result } = await init.json();
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.equal(result.serverInfo.name, 'teamclaude');
    assert.equal(typeof result.serverInfo.version, 'string');

    const note = await fetch(`http://127.0.0.1:${port}/teamclaude/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(note.status, 202);

    const list = await (await rpc(port, 'tools/list')).json();
    assert.deepEqual(list.result.tools.map(t => t.name), ['get_status', 'get_quota', 'get_settings']);
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      assert.ok(tool.description.length > 20, tool.name);
    }
  });
});

test('only POST is served', async () => {
  await withServer({ ...KEYED, mcp: 'read' }, async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/mcp`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
    await res.arrayBuffer();
  });
});

test('a web page cannot reach it', async () => {
  await withServer({ ...KEYED, mcp: 'full' }, async ({ port }) => {
    const res = await rpc(port, 'tools/list', undefined, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /cross-origin/);
  });
});

test('it takes the proxy key wherever the rest of the proxy does', async () => {
  await withServer({ ...KEYED, mcp: 'read', trustLoopback: false }, async ({ port }) => {
    assert.equal((await rpc(port, 'ping')).status, 401);
    assert.equal((await rpc(port, 'ping', undefined, { 'x-api-key': 'wrong' })).status, 401);
    assert.equal((await rpc(port, 'ping', undefined, { 'x-api-key': PROXY_KEY })).status, 200);
    assert.equal((await rpc(port, 'ping', undefined, { 'x-api-key': CLIENT_KEY })).status, 200);
  });
});

test('with no key configured at all, the Host header still has to name this machine', async () => {
  await withServer({ mcp: 'full' }, async ({ port }) => {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const rebound = await postWithHost(port, 'attacker.example', ping);
    assert.equal(rebound.status, 403);
    assert.match(rebound.text, /Host header/);

    const local = await postWithHost(port, `localhost:${port}`, ping);
    assert.equal(local.status, 200);
  });
});

// A config with no key admits everybody at the key gate. On a bind that is not
// loopback, anything that is not a browser can write `Host: localhost` itself,
// so the Host check cannot be what stands between the network and the tools.
test('with no key configured at all, only this machine is served', async () => {
  const localHost = { host: 'localhost:3456' };
  for (const remote of ['192.168.1.20', '::ffff:10.0.0.5', '203.0.113.7', undefined]) {
    assert.match(keylessMcpRefusal(localHost, remote, { mcp: 'full', host: '0.0.0.0' }), /no proxy key configured/, String(remote));
  }
  for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(keylessMcpRefusal(localHost, remote, { mcp: 'full' }), null, remote);
  }
  // A reverse proxy on this host makes every caller loopback-sourced.
  assert.match(keylessMcpRefusal({ ...localHost, 'x-real-ip': '203.0.113.7' }, '127.0.0.1', { mcp: 'full' }), /no proxy key configured/);
  // With the exemption switched off there is nothing left to tell callers apart by.
  assert.match(keylessMcpRefusal(localHost, '127.0.0.1', { mcp: 'full', trustLoopback: false }), /no proxy key configured/);
  // An entry with no name is not a usable key, so this config is key-less too.
  assert.match(keylessMcpRefusal(localHost, '203.0.113.7', { mcp: 'full', clientKeys: [{ key: 'orphan' }] }), /no proxy key configured/);
  // Once a key exists the key gate has decided, and this check stands aside.
  assert.equal(keylessMcpRefusal(localHost, '203.0.113.7', { ...KEYED, mcp: 'full' }), null);

  await withServer({ mcp: 'full' }, async ({ port }) => {
    for (const header of ['X-Forwarded-For', 'X-Real-IP', 'Forwarded']) {
      const res = await rpc(port, 'tools/list', undefined, { [header]: header === 'Forwarded' ? 'for=203.0.113.7' : '203.0.113.7' });
      assert.equal(res.status, 403, header);
      assert.match((await res.json()).error, /no proxy key configured/, header);
    }
    assert.equal((await rpc(port, 'tools/list')).status, 200);
  });
});

// A client key is handed to whoever uses the fleet. Elsewhere in the control
// plane it can switch, reload and probe; it must not become the right to delete
// an account's credentials or to block a model for everyone.
test('a named client key is served read-only even in full mode', async () => {
  await withServer({ ...KEYED, mcp: 'full', trustLoopback: false }, async ({ port, am }) => {
    const names = async headers => (await (await rpc(port, 'tools/list', undefined, headers)).json()).result.tools.map(t => t.name);

    assert.deepEqual(await names({ 'x-api-key': CLIENT_KEY }), ['get_status', 'get_quota', 'get_settings']);
    assert.ok((await names({ 'x-api-key': PROXY_KEY })).includes('remove_account'), 'the shared key keeps the write tools');

    // Not merely unlisted: to this caller the write tools do not exist.
    const before = am.accounts.map(a => a.name);
    const res = await rpc(port, 'tools/call', { name: 'remove_account', arguments: { account: 'alice@example.com' } }, { 'x-api-key': CLIENT_KEY });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).error.code, -32602);
    assert.deepEqual(am.accounts.map(a => a.name), before);

    const read = await rpc(port, 'tools/call', { name: 'get_settings', arguments: {} }, { 'x-api-key': CLIENT_KEY });
    assert.equal((await read.json()).result.structuredContent.mcp, 'full');
  });

  // A caller on this machine that needed no key is the operator, and keeps full
  // access; one that presents a client key anyway is served as that client.
  await withServer({ ...KEYED, mcp: 'full' }, async ({ port }) => {
    const list = await (await rpc(port, 'tools/list')).json();
    assert.ok(list.result.tools.some(t => t.name === 'remove_account'));
    const asClient = await (await rpc(port, 'tools/list', undefined, { 'x-api-key': CLIENT_KEY })).json();
    assert.equal(asClient.result.tools.length, 3);
  });
});

test('a body past the control-plane cap is refused', async () => {
  await withServer({ ...KEYED, mcp: 'read' }, async ({ port }) => {
    const res = await rpc(port, 'ping', { pad: 'x'.repeat(70 * 1024) });
    assert.equal(res.status, 413);
  });
});

test('get_status is a summary of the fleet, not the raw status payload', async () => {
  const hooks = {
    getStatusExtra: () => ({
      clients: { ci: { requests: 5 } },
      usageDimensions: { team: { core: { requests: 1 } } },
      server: { version: '9.9.9', versionLabel: '9.9.9', startedAt: '2026-01-01T00:00:00.000Z', uptimeSeconds: 12, port: 3456, upstream: 'https://user:pw@gateway.example' },
      probe: { enabled: true, intervalSeconds: 300, running: false, accounts: [{ name: 'alice@example.com', error: 'ECONNRESET at /home/op/secret' }] },
      warm: { enabled: false, intervalSeconds: 0, running: false, accounts: [] },
    }),
  };
  await withServer({ ...KEYED, mcp: 'read' }, async ({ port }) => {
    const reply = await callTool(port, 'get_status');
    assert.notEqual(reply.result.isError, true);
    const status = reply.result.structuredContent;
    assert.deepEqual(JSON.parse(reply.result.content[0].text), status);

    assert.deepEqual(status.server, { version: '9.9.9', startedAt: '2026-01-01T00:00:00.000Z', uptimeSeconds: 12, port: 3456 });
    assert.equal(status.currentAccount, 'alice@example.com');
    assert.deepEqual(status.probe, { enabled: true, intervalSeconds: 300, running: false });
    assert.deepEqual(status.warm, { enabled: false, intervalSeconds: 0, running: false });
    assert.deepEqual(Object.keys(status.sessions).sort(), ['active', 'draining', 'known', 'mode']);

    assert.deepEqual(status.accounts.map(a => a.name), ['alice@example.com', 'bob@example.com']);
    const [alice, bob] = status.accounts;
    assert.equal(alice.current, true);
    assert.equal(alice.priority, 2);
    assert.equal(alice.disabled, false);
    assert.equal(alice.eligible, true);
    assert.equal(bob.disabled, true);
    // Verbatim, non-breaking space included: the write tools match on it.
    assert.equal(bob.orgName, 'Acme\u00a0Labs');
    assert.equal(bob.eligible, false);
    assert.equal(typeof bob.reason, 'string');
    // Nothing observed yet: no quota key at all, rather than a bucket with
    // nothing in it, so the summary stays as short as what is known.
    assert.equal('quota' in alice, false);

    for (const dropped of ['clients', 'usageDimensions', 'routes', 'adaptive']) {
      assert.equal(dropped in status, false, dropped);
    }
  }, hooks);
});

test('get_quota is the fleet quota summary', async () => {
  const hooks = { getQuotaExtra: () => ({ warmup: { mode: 'off' } }) };
  await withServer({ ...KEYED, mcp: 'read' }, async ({ port, am }) => {
    const reply = await callTool(port, 'get_quota');
    assert.deepEqual(reply.result.structuredContent, JSON.parse(JSON.stringify({ ...am.getQuotaSummary(), warmup: { mode: 'off' } })));
  }, hooks);
});

test('get_settings reads the tunable settings and nothing else', async () => {
  await withServer({ ...KEYED, mcp: 'read' }, async ({ port }) => {
    const reply = await callTool(port, 'get_settings');
    assert.deepEqual(reply.result.structuredContent, {
      switchThreshold: 0.9,
      distribution: 'off',
      quotaProbeSeconds: 300,
      warmupSeconds: 0,
      warmupSchedule: null,
      routes: [{ name: 'opus', match: ['claude-opus-*'], accounts: ['alice@example.com'] }],
      blockedModels: ['claude-opus-*'],
      defaultClientMode: 'mitm',
      mcp: 'read',
    });
  });
});

test('no read tool lets a credential out', async () => {
  const hooks = {
    getStatusExtra: () => ({ server: { version: '1', upstream: `https://user:${SX_KEY}@gateway.example` } }),
  };
  await withServer({ ...KEYED, mcp: 'full' }, async ({ port }) => {
    const list = await (await rpc(port, 'tools/list')).json();
    const readTools = list.result.tools.filter(t => t.annotations.readOnlyHint);
    assert.equal(readTools.length, 3);
    for (const tool of readTools) {
      const text = JSON.stringify(await callTool(port, tool.name));
      for (const secret of [ACCT_SECRET, PROXY_KEY, CLIENT_KEY, SX_KEY, 'proxy-password']) {
        assert.equal(text.includes(secret), false, `${tool.name} leaked ${secret}`);
      }
    }
  }, hooks);
});

test('arguments a tool does not take come back as a tool error, an unknown tool as a protocol one', async () => {
  await withServer({ ...KEYED, mcp: 'read' }, async ({ port }) => {
    const reply = await callTool(port, 'get_settings', { verbose: true });
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /verbose/);

    const unknown = await callTool(port, 'switch_account', { account: 'alice@example.com' });
    assert.equal(unknown.error.code, -32602);
  });
});

test('the mode is read per request, so a reload can change it', async () => {
  await withServer({ ...KEYED, mcp: 'read' }, async ({ port, config }) => {
    assert.equal((await rpc(port, 'ping')).status, 200);
    config.proxy.mcp = 'off';
    assert.equal((await rpc(port, 'ping')).status, 404);
  });
});
