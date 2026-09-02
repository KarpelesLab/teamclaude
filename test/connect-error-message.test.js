import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, describeConnectError } from '../src/server.js';
import { createConnectHandler } from '../src/mitm.js';

// A failed connect has its reason in one of two places, and the interesting one
// is not where you would look.
//
// Node's happy-eyeballs dialer (`autoSelectFamily`, on by default across the
// versions this package supports; `package.json` declares `node >=20`, measured
// here on 24) reports a connect where every address failed as an AggregateError.
// Node builds that error with an empty `message`; the per-address reasons are in
// `.errors`. Any multi-address host reaches this, and the Anthropic upstream is
// one.
//
// A single-address failure carries its reason in `message` and would satisfy
// every assertion below against the unfixed code, so the tests that depend on
// the aggregated shape skip when the host does not produce one rather than
// asserting it. The platform is not the thing under test.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// `localhost` resolves to both ::1 and 127.0.0.1 on a dual-stack host, and port
// 1 refuses on both, so this is a real all-addresses-failed connect rather than
// a constructed one.
function dialRefused(opts = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: 'localhost', port: 1, ...opts });
    s.on('error', resolve);
    s.on('connect', () => { s.destroy(); reject(new Error('port 1 accepted a connection')); });
  });
}

// Probed once, at load, so every test below can be gated on the same answer.
const probe = await dialRefused();
const AGGREGATED = probe.constructor.name === 'AggregateError' && Array.isArray(probe.errors);
const NOT_DUAL_STACK = !AGGREGATED
  && 'this host does not produce an all-addresses-failed connect, so nothing here would be measuring the fix';
// The exact per-address reasons a connect to localhost:1 produces here. The
// end-to-end tests below look for all of them, joined, rather than for a
// substring that a single-address failure would also satisfy.
const REASONS = AGGREGATED ? probe.errors.map(e => e.message) : [];

test('a connect where every address failed is described by its parts', { skip: NOT_DUAL_STACK }, async () => {
  const err = await dialRefused();
  assert.equal(err.message, '', 'an AggregateError with its own message would not exercise the defect');
  assert.ok(err.errors.length >= 2, `expected several per-address reasons, got ${err.errors.length}`);

  const described = describeConnectError(err);
  for (const e of err.errors) {
    assert.ok(described.includes(e.message), `"${e.message}" is missing from the description`);
  }
});

// The other shape, and why the fallback is required: with the dialer off, and
// on every single-address failure, the reason arrives as a plain Error in
// `message`.
test('a connect failure that is not aggregated is described by its message', async () => {
  const err = await dialRefused({ autoSelectFamily: false });
  assert.notEqual(err.constructor.name, 'AggregateError',
    'this was still aggregated, so it does not exercise the fallback');
  assert.ok(err.message.length > 0, 'a plain connect error should carry its reason');
  assert.equal(describeConnectError(err), err.message);
});

test('a wrapper around a single-address cause is described by the cause', () => {
  // Global fetch wraps a plain (non-aggregated) connect error in
  // TypeError('fetch failed'); the reason lives on `cause`.
  const cause = new Error('connect ECONNREFUSED 127.0.0.1:1');
  cause.code = 'ECONNREFUSED';
  const err = new TypeError('fetch failed', { cause });
  assert.equal(describeConnectError(err), 'connect ECONNREFUSED 127.0.0.1:1');
});

test('describeConnectError leaves nothing to print only when there is nothing', () => {
  assert.equal(describeConnectError(undefined), undefined);
  assert.equal(describeConnectError(new Error('boom')), 'boom');
});

// End to end: the log an operator actually reads when the upstream is down.
test('an upstream whose every address refuses is logged with its reasons', { skip: NOT_DUAL_STACK }, async () => {
  const am = new AccountManager([{ name: 'alice', type: 'apikey', apiKey: 'k1' }], 0.98);
  const logged = [];
  const realErr = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  const proxy = createProxyServer(am, { proxy: {}, upstream: 'http://localhost:1' });
  const port = await listen(proxy);
  try {
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);          // a refused upstream closes the client connection
      setTimeout(resolve, 8000);
      req.end(JSON.stringify({ model: 'claude-opus-5', messages: [] }));
    });
  } finally {
    console.error = realErr;
    proxy.close();
  }
  const line = logged.find(l => l.includes('Upstream error'));
  assert.ok(line, `no upstream error was logged at all (saw ${logged.length} lines)`);
  for (const reason of REASONS) {
    assert.ok(line.includes(reason),
      `the log is missing "${reason}", so it is not reporting every address: ${JSON.stringify(line)}`);
  }
  assert.ok(line.includes('; '), `the reasons were not joined: ${JSON.stringify(line)}`);
});

// The same log on the forward-proxy path, which an absolute-form request line
// reaches. One of four sibling handlers in this file with the identical shape;
// they are all the same one-word substitution, and this is the one an ordinary
// request can drive end to end.
test('a forward-proxy target whose every address refuses is logged with its reasons', { skip: NOT_DUAL_STACK }, async () => {
  const am = new AccountManager([{ name: 'alice', type: 'apikey', apiKey: 'k1' }], 0.98);
  const logged = [];
  const realErr = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  const proxy = createProxyServer(am, { proxy: {}, upstream: 'https://api.anthropic.com' });
  const port = await listen(proxy);
  try {
    await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET http://localhost:1/x HTTP/1.1\r\nHost: localhost:1\r\n\r\n');
      });
      // The 502 arriving means the handler has already logged; waiting for the
      // socket to close instead would sit out the server's keep-alive timeout.
      const done = () => { sock.destroy(); resolve(); };
      sock.on('data', done);
      sock.on('close', resolve);
      sock.on('error', resolve);
      setTimeout(done, 8000);
    });
  } finally {
    console.error = realErr;
    proxy.close();
  }
  const line = logged.find(l => l.includes('HTTP forward'));
  assert.ok(line, `no forward-proxy failure was logged at all (saw ${JSON.stringify(logged)})`);
  for (const reason of REASONS) {
    assert.ok(line.includes(reason),
      `the log is missing "${reason}", so it is not reporting every address: ${JSON.stringify(line)}`);
  }
  assert.ok(line.includes('; '), `the reasons were not joined: ${JSON.stringify(line)}`);
});

// The MITM tunnel's identical log, which is why the helper is shared rather than
// copied. A blind-tunnel target that refuses on every address gets here.
test('a tunnel whose every address refuses is logged with its reasons', { skip: NOT_DUAL_STACK }, async () => {
  const logged = [];
  const am = new AccountManager([{ name: 'alice', type: 'apikey', apiKey: 'k1' }], 0.98);
  const server = http.createServer();
  server.on('connect', createConnectHandler({
    config: { proxy: {}, upstream: 'https://api.anthropic.com' },
    accountManager: am,
    ensureLeaf: async () => { throw new Error('not reached: this target is blind-tunneled'); },
    log: (...a) => logged.push(a.map(String).join(' ')),
  }));
  const port = await listen(server);
  try {
    await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('CONNECT localhost:1 HTTP/1.1\r\nHost: localhost:1\r\n\r\n');
      });
      sock.on('data', () => {});
      sock.on('close', resolve);
      sock.on('error', resolve);
      setTimeout(() => { sock.destroy(); resolve(); }, 8000);
    });
  } finally {
    server.close();
  }
  const line = logged.find(l => l.includes('tunnel localhost:1 failed'));
  assert.ok(line, `no tunnel failure was logged at all (saw ${JSON.stringify(logged)})`);
  for (const reason of REASONS) {
    assert.ok(line.includes(reason),
      `the log is missing "${reason}", so it is not reporting every address: ${JSON.stringify(line)}`);
  }
  assert.ok(line.includes('; '), `the reasons were not joined: ${JSON.stringify(line)}`);
});

// The documented escape hatch, TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH, routes through
// global fetch, which wraps the same connect failure in a TypeError whose own
// message is "fetch failed". The reasons are still there, one level down.
//
// A child, because the flag is read once at module load, so flipping it in
// process cannot reach the code path.
const SERVER_PATH = fileURLToPath(new URL('../src/server.js', import.meta.url));
const FETCH_PATH = fileURLToPath(new URL('../src/upstream-fetch.js', import.meta.url));

function describeThroughGlobalFetch() {
  // Port 65534 rather than 1: fetch refuses to dial port 1 at all, and would
  // raise "bad port" instead of the connect failure this is about.
  const source = `
    import { describeConnectError } from ${JSON.stringify(SERVER_PATH)};
    import { upstreamFetch } from ${JSON.stringify(FETCH_PATH)};
    try {
      await upstreamFetch('http://localhost:65534/v1/messages', { method: 'POST', body: '{}' }, null, false);
      process.stdout.write(JSON.stringify({ error: 'the port unexpectedly accepted a connection' }));
    } catch (err) {
      process.stdout.write(JSON.stringify({
        name: err.constructor.name,
        ownMessage: err.message,
        described: describeConnectError(err),
      }));
    }
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH: '1' },
    });
    const out = [];
    child.stdout.on('data', d => out.push(String(d)));
    child.stderr.on('data', () => {});
    // The parent gives up, so a child that never exits fails this test instead
    // of holding the runner until the suite timeout.
    const kill = setTimeout(() => child.kill('SIGKILL'), 25000);
    child.on('close', () => {
      clearTimeout(kill);
      try { resolve(JSON.parse(out.join(''))); } catch { resolve({ error: out.join('') || 'child produced nothing' }); }
    });
  });
}

test('a connect failure through the global-fetch path is described by its parts', { skip: NOT_DUAL_STACK }, async () => {
  const got = await describeThroughGlobalFetch();
  assert.equal(got.name, 'TypeError',
    `the escape hatch did not take effect, so this proves nothing: ${JSON.stringify(got)}`);
  assert.equal(got.ownMessage, 'fetch failed',
    'the wrapper no longer hides the reason, so this test is measuring something else');
  for (const address of ['::1:65534', '127.0.0.1:65534']) {
    assert.ok(got.described.includes(address),
      `"${address}" is missing from ${JSON.stringify(got.described)}`);
  }
});
