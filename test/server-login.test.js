import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, callerView } from '../src/server.js';
import { startOAuthLogin } from '../src/oauth.js';
import { createDashboardLogin } from '../src/dashboard-login.js';

// POST /teamclaude/login/{start,finish,cancel} are what the dashboard's Add
// account control drives (#765). The server owns only the HTTP contract and
// the gates; the sign-in lives in dashboard-login.js, stubbed here except in
// the one end-to-end test, whose token exchange is a stub of its own.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PROXY_KEY = 'tc-test';
const CLIENT_KEY = 'tc-client';
const CONFIG = {
  proxy: { apiKey: PROXY_KEY, clientKeys: [{ name: 'ci', key: CLIENT_KEY }] },
  upstream: 'http://127.0.0.1:9',
};
const ROUTES = ['/teamclaude/login/start', '/teamclaude/login/finish', '/teamclaude/login/cancel'];
const LINK = 'https://claude.ai/oauth/authorize?state=s1';

function stubLogin({ start, finish } = {}) {
  const calls = { start: 0, finish: [], cancel: [] };
  const login = {
    start: async () => { calls.start++; return start ? start() : { ok: true, id: 'id-1', url: LINK, expiresAt: 42 }; },
    finish: async (id, code) => { calls.finish.push([id, code]); return finish ? finish(id, code) : { ok: true, account: 'alice@example.com', action: 'added' }; },
    cancel: (id) => { calls.cancel.push(id); return { ok: true, cancelled: id === 'id-1' }; },
  };
  return { login, calls };
}

async function withServer(hooks, fn, config = CONFIG) {
  const am = new AccountManager([{ name: 'bob@example.com', type: 'apikey', apiKey: 'k' }], 0.98);
  const proxy = createProxyServer(am, config, hooks);
  const port = await listen(proxy);
  const logs = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => { logs.push(a.join(' ')); };
  console.error = (...a) => { logs.push(a.join(' ')); };
  try {
    await fn(port, logs);
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    proxy.close();
  }
}

const post = (port, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': PROXY_KEY, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
});

test('without the sign-in hook every login route answers 501', async () => {
  await withServer({}, async (port) => {
    for (const path of ROUTES) {
      const res = await post(port, path, { id: 'id-1', code: 'c' });
      assert.equal(res.status, 501, path);
      assert.deepEqual(await res.json(), { ok: false, error: 'sign-in not supported' });
    }
  });
});

test('start answers the link, the id and when the sign-in stops waiting', async () => {
  const { login, calls } = stubLogin();
  await withServer({ dashboardLogin: login }, async (port) => {
    const res = await post(port, '/teamclaude/login/start');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, id: 'id-1', url: LINK, expiresAt: 42 });
    assert.equal(calls.start, 1);
  });
});

test('a start overtaken by a newer one answers 409, and one that cannot start 500', async () => {
  const answers = [
    { ok: false, code: 'replaced', error: 'a newer sign-in replaced this one' },
    { ok: false, code: 'failed', error: 'could not start the sign-in: boom' },
  ];
  const { login } = stubLogin({ start: () => answers.shift() });
  await withServer({ dashboardLogin: login }, async (port) => {
    const replaced = await post(port, '/teamclaude/login/start');
    assert.equal(replaced.status, 409);
    assert.deepEqual(await replaced.json(), { ok: false, error: 'a newer sign-in replaced this one' });
    assert.equal((await post(port, '/teamclaude/login/start')).status, 500);
  });
});

test('finish reports the saved account and logs it, without the code', async () => {
  const { login, calls } = stubLogin({ finish: async () => ({ ok: true, account: 'alice@example.com', action: 'updated' }) });
  await withServer({ dashboardLogin: login }, async (port, logs) => {
    const res = await post(port, '/teamclaude/login/finish', { id: 'id-1', code: 'secret-code#state' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, account: 'alice@example.com', action: 'updated' });
    assert.deepEqual(calls.finish, [['id-1', 'secret-code#state']]);
    assert.deepEqual(logs, ['[TeamClaude] Dashboard sign-in updated account "alice@example.com"']);
    assert.ok(!logs.join('\n').includes('secret-code'));
  });
});

// The account name is a profile's email or an operator's --name: it is kept
// to one line on the way into a log that is read a line at a time.
test('the log line keeps a hostile account name to one line', async () => {
  const { login } = stubLogin({ finish: async () => ({ ok: true, account: 'eve\n[TeamClaude] forged line', action: 'added' }) });
  await withServer({ dashboardLogin: login }, async (port, logs) => {
    assert.equal((await post(port, '/teamclaude/login/finish', { id: 'id-1', code: 'c' })).status, 200);
    assert.equal(logs.length, 1);
    assert.ok(!/[\x00-\x1f]/.test(logs[0]), JSON.stringify(logs[0]));
  });
});

test('finish answers 400 for an unusable paste, 404 for an unknown id, 409 while busy and 502 for a failed exchange', async () => {
  const outcomes = {
    unusable: [400, 'That is not the whole code'],
    unknown: [404, 'that sign-in has expired or was replaced; start again'],
    busy: [409, 'that sign-in is already being finished'],
    failed: [502, 'Token exchange failed (400)'],
  };
  for (const [code, [status, error]] of Object.entries(outcomes)) {
    const { login } = stubLogin({ finish: async () => ({ ok: false, code, error }) });
    await withServer({ dashboardLogin: login }, async (port, logs) => {
      const res = await post(port, '/teamclaude/login/finish', { id: 'id-1', code: 'pasted-code' });
      assert.equal(res.status, status, code);
      assert.deepEqual(await res.json(), { ok: false, error });
      // Only the failure that ended a sign-in is logged; a mistyped paste is
      // between the page and the person.
      assert.deepEqual(logs, code === 'failed' ? [`[TeamClaude] Dashboard sign-in failed: ${error}`] : [], code);
      assert.ok(!logs.join('\n').includes('pasted-code'));
    });
  }
});

test('finish and cancel need an id, finish needs a code, and a bad body is refused before the hook', async () => {
  const { login, calls } = stubLogin();
  await withServer({ dashboardLogin: login }, async (port) => {
    const expectError = async (path, body, status, error) => {
      const res = await post(port, path, body);
      assert.equal(res.status, status, `${path} ${JSON.stringify(body).slice(0, 40)}`);
      assert.deepEqual(await res.json(), { ok: false, error });
    };
    await expectError('/teamclaude/login/finish', { code: 'c' }, 400, 'missing "id"');
    await expectError('/teamclaude/login/finish', { id: 7, code: 'c' }, 400, 'missing "id"');
    await expectError('/teamclaude/login/finish', { id: 'id-1' }, 400, 'missing "code"');
    await expectError('/teamclaude/login/finish', { id: 'id-1', code: '   ' }, 400, 'missing "code"');
    await expectError('/teamclaude/login/cancel', {}, 400, 'missing "id"');
    await expectError('/teamclaude/login/finish', '{not json', 400, 'invalid request body');
    await expectError('/teamclaude/login/start', '{not json', 400, 'invalid request body');
    await expectError('/teamclaude/login/finish', JSON.stringify({ id: 'id-1', code: 'x'.repeat(70 * 1024) }), 413, 'request body too large');
    assert.deepEqual(calls, { start: 0, finish: [], cancel: [] });
  });
});

test('cancel ends the named sign-in and answers the same for one already gone', async () => {
  const { login, calls } = stubLogin();
  await withServer({ dashboardLogin: login }, async (port) => {
    const first = await post(port, '/teamclaude/login/cancel', { id: 'id-1' });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, cancelled: true });
    const gone = await post(port, '/teamclaude/login/cancel', { id: 'id-0' });
    assert.equal(gone.status, 200);
    assert.deepEqual(await gone.json(), { ok: true, cancelled: false });
    assert.deepEqual(calls.cancel, ['id-1', 'id-0']);
  });
});

// A client key names a tenant of the proxy; adding an account is the
// operator's. The dashboard reads the same table to hide the control.
test('a client key is refused every login route, and status lists them as refused', async () => {
  const { login, calls } = stubLogin();
  await withServer({ dashboardLogin: login }, async (port) => {
    for (const path of ROUTES) {
      const res = await post(port, path, { id: 'id-1', code: 'c' }, { 'x-api-key': CLIENT_KEY });
      assert.equal(res.status, 403, path);
      assert.deepEqual(await res.json(), { ok: false, error: 'a client key cannot add accounts' });
    }
    assert.deepEqual(calls, { start: 0, finish: [], cancel: [] });
  });
  for (const path of ROUTES) assert.ok(callerView('ci').refused.includes(path), path);
  assert.deepEqual(callerView(null).refused, []);
});

test('a POST from a page on another origin is refused before the hook', async () => {
  const { login, calls } = stubLogin();
  await withServer({ dashboardLogin: login }, async (port) => {
    for (const path of ROUTES) {
      const res = await post(port, path, { id: 'id-1', code: 'c' }, { origin: 'https://evil.example' });
      assert.equal(res.status, 403, path);
      assert.match((await res.json()).error, /cross-origin request refused/);
    }
    assert.deepEqual(calls, { start: 0, finish: [], cancel: [] });
  });
});

// With no proxy key the gate admits every caller, so the routes hold the
// resets routes' line themselves: this machine only, and a Host that names it.
test('a key-less proxy serves the login routes to this machine only', async () => {
  const { login, calls } = stubLogin();
  const keyless = { proxy: {}, upstream: CONFIG.upstream };
  // fetch() refuses to set Host, so these drive http.request.
  const send = (port, path, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ id: 'id-1', code: 'c' }));
  });
  await withServer({ dashboardLogin: login }, async (port) => {
    const local = { host: `127.0.0.1:${port}` };
    for (const path of ROUTES) {
      assert.equal((await send(port, path, { host: 'attacker.example' })).status, 403, path);
      const forwarded = await send(port, path, { ...local, 'x-forwarded-for': '203.0.113.9' });
      assert.equal(forwarded.status, 403, path);
      assert.match(forwarded.body.error, /the dashboard sign-in serves only this machine/);
    }
    assert.deepEqual(calls, { start: 0, finish: [], cancel: [] });
    assert.equal((await send(port, '/teamclaude/login/start', local)).status, 200);
    assert.equal(calls.start, 1);
  }, keyless);
});

test('the routes answer under /teamrouter/ too', async () => {
  const { login, calls } = stubLogin();
  await withServer({ dashboardLogin: login }, async (port) => {
    assert.equal((await post(port, '/teamrouter/login/start')).status, 200);
    assert.equal((await post(port, '/teamrouter/login/finish', { id: 'id-1', code: 'c' })).status, 200);
    assert.equal((await post(port, '/teamrouter/login/cancel', { id: 'id-1' })).status, 200);
    assert.deepEqual(calls, { start: 1, finish: [['id-1', 'c']], cancel: ['id-1'] });
    const client = await post(port, '/teamrouter/login/start', {}, { 'x-api-key': CLIENT_KEY });
    assert.equal(client.status, 403);
  });
});

// The whole path a page takes, over HTTP, against the real sign-in flow: only
// the token exchange and the config write are stubs.
test('start then finish over HTTP signs the account in through the real flow', async () => {
  const saved = [];
  let reloads = 0;
  const login = createDashboardLogin({
    startLogin: opts => startOAuthLogin({
      ...opts,
      tokenEndpoint: 'http://127.0.0.1:9/token',
      exchange: async code => ({ accessToken: `at-${code}`, refreshToken: 'rt', expiresAt: 1 }),
    }),
    upsert: async (tokens) => { saved.push(tokens); return { action: 'added', name: 'carol@example.com' }; },
    reload: async () => { reloads++; },
  });
  await withServer({ dashboardLogin: login }, async (port, logs) => {
    const started = await (await post(port, '/teamclaude/login/start')).json();
    const state = new URL(started.url).searchParams.get('state');

    const wrong = await post(port, '/teamclaude/login/finish', { id: started.id, code: 'ac_9#not-this-state' });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /different sign-in attempt/);

    const done = await post(port, '/teamclaude/login/finish', { id: started.id, code: `ac_9#${state}` });
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { ok: true, account: 'carol@example.com', action: 'added' });
    assert.deepEqual(saved, [{ accessToken: 'at-ac_9', refreshToken: 'rt', expiresAt: 1 }]);
    assert.equal(reloads, 1);
    // The flow's own "Exchanging…" line and the route's; neither carries the
    // code, the state or a token.
    const text = logs.join('\n');
    for (const secret of ['ac_9', state, 'at-ac_9']) assert.ok(!text.includes(secret), secret);

    const again = await post(port, '/teamclaude/login/finish', { id: started.id, code: `ac_9#${state}` });
    assert.equal(again.status, 404);
    assert.deepEqual(await again.json(), { ok: false, error: 'that sign-in has expired or was replaced; start again' });
  });
});
