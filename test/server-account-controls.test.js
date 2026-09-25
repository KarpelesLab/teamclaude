import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { ConfigOpError } from '../src/config-ops.js';

// POST /teamclaude/priority and /teamclaude/disable are what the dashboard's
// enable/disable and prioritize/deprioritize buttons call. The server owns the
// contract between the page and the hooks `teamclaude server` installs: the
// write goes through the hook, the reload after it is the server's job, and
// each failure class has its own status so the page can tell "refused" from
// "broken" from "landed on disk but not live".

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PROXY_KEY = 'tc-test';
const CLIENT_KEY = 'tc-client';
const CONFIG = {
  proxy: { apiKey: PROXY_KEY, clientKeys: [{ name: 'ci', key: CLIENT_KEY }] },
  upstream: 'http://127.0.0.1:9',
};
const ACCTS = [
  { name: 'alice@example.com', type: 'apikey', apiKey: 'k1' },
  { name: 'bob@example.com', type: 'apikey', apiKey: 'k2' },
];

async function withServer(hooks, fn) {
  const am = new AccountManager(ACCTS, 0.98);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try {
    await fn(port);
  } finally {
    proxy.close();
  }
}

// The request the page sends: a same-origin browser POST. The test runs on
// loopback, which the key gate exempts, so no key is sent unless a test is
// about the key itself.
const post = (port, path, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

// Hooks that record what they were asked and answer the shape the real ones
// do (config-ops' setAccountPriority / setAccountDisabled results).
function stubHooks() {
  const calls = { priority: [], disabled: [], reload: 0 };
  const hooks = {
    setAccountPriority: async (account, spec) => {
      calls.priority.push([account, spec]);
      return { name: account, priority: spec.place === 'first' ? -1 : spec.priority };
    },
    setAccountDisabled: async (account, disabled, spec) => {
      calls.disabled.push([account, disabled, spec]);
      return { name: account, disabled };
    },
    reload: async () => { calls.reload++; return 0; },
  };
  return { hooks, calls };
}

test('a priority move echoes the account as it now stands, and reloads', async () => {
  const { hooks, calls } = stubHooks();
  await withServer(hooks, async (port) => {
    const res = await post(port, '/teamclaude/priority', { account: 'alice@example.com', place: 'first' });
    assert.equal(res.status, 200);
    // `priority: -1` is the number the caller did not send; the reply is how
    // the page learns it.
    assert.deepEqual(await res.json(), { ok: true, name: 'alice@example.com', priority: -1 });
    assert.equal(calls.priority.length, 1);
    assert.equal(calls.priority[0][0], 'alice@example.com');
    assert.equal(calls.priority[0][1].place, 'first');
    assert.equal(calls.reload, 1, 'the write is on disk; the reload is what makes it live');

    // An explicit number and an org filter pass straight through, and the
    // account is trimmed the way /teamclaude/switch trims it.
    const exact = await post(port, '/teamclaude/priority', { account: '  bob@example.com ', priority: 3, org: 'acme' });
    assert.equal(exact.status, 200);
    assert.deepEqual(await exact.json(), { ok: true, name: 'bob@example.com', priority: 3 });
    assert.equal(calls.priority[1][0], 'bob@example.com');
    assert.equal(calls.priority[1][1].priority, 3);
    assert.equal(calls.priority[1][1].orgFilter, 'acme');
    assert.equal(calls.reload, 2);
  });
});

test('disable and enable go through the hook and reload', async () => {
  const { hooks, calls } = stubHooks();
  await withServer(hooks, async (port) => {
    const off = await post(port, '/teamclaude/disable', { account: 'bob@example.com', disabled: true });
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { ok: true, name: 'bob@example.com', disabled: true });
    assert.equal(calls.disabled[0][0], 'bob@example.com');
    assert.equal(calls.disabled[0][1], true);

    const on = await post(port, '/teamclaude/disable', { account: 'bob@example.com', disabled: false, org: 'acme' });
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { ok: true, name: 'bob@example.com', disabled: false });
    assert.equal(calls.disabled[1][1], false);
    assert.equal(calls.disabled[1][2].orgFilter, 'acme');
    assert.equal(calls.reload, 2);
    assert.equal(calls.priority.length, 0, 'the disable endpoint never touches priority');
  });
});

// A ConfigOpError is the caller's own input — unknown or ambiguous account,
// a priority that is not an integer — and is safe to echo. Nothing was
// written, so nothing is reloaded.
test('a refused change is a 400 carrying the reason, and no reload', async () => {
  const { hooks, calls } = stubHooks();
  hooks.setAccountPriority = async () => { throw new ConfigOpError('no account matches "zed"'); };
  hooks.setAccountDisabled = async () => { throw new ConfigOpError('"a@x" matches 2 accounts (one, two) — name the org too'); };
  await withServer(hooks, async (port) => {
    const res = await post(port, '/teamclaude/priority', { account: 'zed', place: 'last' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'no account matches "zed"' });

    const amb = await post(port, '/teamclaude/disable', { account: 'a@x', disabled: true });
    assert.equal(amb.status, 400);
    assert.match((await amb.json()).error, /name the org too/);
    assert.equal(calls.reload, 0, 'a refused write has nothing to reload');
  });
});

// Anything else is ours (a config file that cannot be written, a bug) and its
// message may name paths or accounts, so it goes to the log, not the reply.
test('an unexpected hook failure is a generic 500', async () => {
  const { hooks, calls } = stubHooks();
  hooks.setAccountDisabled = async () => { throw new Error('EACCES: /etc/teamclaude/config.json'); };
  await withServer(hooks, async (port) => {
    const res = await post(port, '/teamclaude/disable', { account: 'bob@example.com', disabled: true });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'account change failed; see the proxy log');
    assert.doesNotMatch(body.error, /EACCES|config\.json/, 'the reason stays in the log');
    assert.equal(calls.reload, 0);
  });
});

// The write landed; only the reload after it broke. That is a different
// outcome from a refused change — the file did change — and the page is told
// so in the same words the MCP changeSetting tool uses.
test('a write whose reload fails says the file changed but the server did not', async () => {
  const { hooks, calls } = stubHooks();
  hooks.reload = async () => { throw new Error('token refresh failed for alice'); };
  await withServer(hooks, async (port) => {
    const res = await post(port, '/teamclaude/priority', { account: 'alice@example.com', place: 'first' });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: 'saved to the config file, but the reload failed; see the proxy log',
    });
    assert.equal(calls.priority.length, 1, 'the write did happen');
  });
});

// A server with no reload hook has nothing to make a config write take
// effect, so it refuses up front rather than leaving the file changed and the
// running server stale. Same for a server that has no account hooks at all.
test('a server that cannot reload, or has no account hooks, answers 501 before any write', async () => {
  const { hooks, calls } = stubHooks();
  delete hooks.reload;
  await withServer(hooks, async (port) => {
    for (const [path, body] of [
      ['/teamclaude/priority', { account: 'alice@example.com', place: 'first' }],
      ['/teamclaude/disable', { account: 'alice@example.com', disabled: true }],
    ]) {
      const res = await post(port, path, body);
      assert.equal(res.status, 501, path);
      assert.deepEqual(await res.json(), { ok: false, error: 'reload not supported' });
    }
    assert.equal(calls.priority.length + calls.disabled.length, 0, 'nothing may be written without a reload');
  });

  await withServer({ reload: async () => 0 }, async (port) => {
    const p = await post(port, '/teamclaude/priority', { account: 'alice@example.com', place: 'first' });
    assert.equal(p.status, 501);
    assert.match((await p.json()).error, /priority not supported/);
    const d = await post(port, '/teamclaude/disable', { account: 'alice@example.com', disabled: true });
    assert.equal(d.status, 501);
    assert.match((await d.json()).error, /enable\/disable not supported/);
  });
});

test('a body without an account, or that is not an object, is a 400 and reaches no hook', async () => {
  const { hooks, calls } = stubHooks();
  await withServer(hooks, async (port) => {
    for (const body of [{}, { account: '' }, { account: '   ' }, { account: 42 }, 'null', '']) {
      const res = await post(port, '/teamclaude/priority', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { ok: false, error: 'missing "account"' });
    }
    const bad = await post(port, '/teamclaude/disable', '{not json');
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { ok: false, error: 'invalid request body' });
    assert.equal(calls.priority.length + calls.disabled.length + calls.reload, 0);
  });
});

// A client key is a credential for using the fleet, not for shaping it: a CI
// job holding one may switch and reload, but must not be able to rewrite
// which accounts the config lets rotation reach. The shared proxy key, and the
// key-less loopback exemption the other tests here rely on, still may.
test('a client key cannot change accounts; the shared proxy key can', async () => {
  const { hooks, calls } = stubHooks();
  await withServer(hooks, async (port) => {
    for (const [path, body] of [
      ['/teamclaude/priority', { account: 'alice@example.com', place: 'first' }],
      ['/teamclaude/disable', { account: 'alice@example.com', disabled: true }],
    ]) {
      const res = await post(port, path, body, { 'x-api-key': CLIENT_KEY });
      assert.equal(res.status, 403, path);
      assert.deepEqual(await res.json(), { ok: false, error: 'a client key cannot change accounts' });
    }
    assert.equal(calls.priority.length + calls.disabled.length + calls.reload, 0, 'a refused request reaches no hook');

    const ok = await post(port, '/teamclaude/disable', { account: 'alice@example.com', disabled: true }, { 'x-api-key': PROXY_KEY });
    assert.equal(ok.status, 200);
    assert.equal(calls.disabled.length, 1);
  });
});
