import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// One request opens one activity entry, and exactly one path closes it.
//
// The entry is a promise to every consumer of the activity hooks: the TUI holds
// the row in `active` and keeps its animation running while one is open, a
// headless consumer counts it as in flight. Nothing reclaims a row that is
// never closed, so on a daemon that runs for weeks a leak is permanent.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const ACCTS = [{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }];
// Port 1 is never listening. Where a test does not care what upstream says, a
// failed forward is the shortest way to the paths under test.
const NO_UPSTREAM = { proxy: {}, upstream: 'http://127.0.0.1:1' };

const BODY = JSON.stringify({ model: 'claude-opus-5', messages: [] });

// An upstream that answers every request with a small JSON 200, so the inner
// path runs to completion and its `finally` is the site that closes the entry.
function okUpstream() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
}

async function postMessages(port, body = BODY) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  }).catch(() => null);
  await res?.text().catch(() => {});
  return res;
}

// These tests provoke throws the server logs. Mute that so the stack traces do
// not drown the run.
async function quietly(fn) {
  const realErr = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = realErr;
  }
}

// A client that announces a body, sends part of it, and hangs up. This is what
// Ctrl+C in Claude Code does to a request that is still uploading, and it makes
// the server's `for await (const chunk of req)` reject above the inner try.
function abortMidBody(port) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': String(BODY.length + 64) },
    });
    req.on('error', () => {});
    req.write(BODY.slice(0, 24));
    setTimeout(() => { req.destroy(); resolve(); }, 50);
  });
}

test('a request aborted mid-body closes its activity entry', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const started = [];
  const ended = [];
  const proxy = createProxyServer(am, NO_UPSTREAM, {
    onRequestStart: (id) => started.push(id),
    onRequestEnd: (id, info) => ended.push({ id, status: info.status }),
  });
  const port = await listen(proxy);
  try {
    await quietly(async () => {
      await abortMidBody(port);
      await new Promise(r => setTimeout(r, 200));   // let the server-side rejection land
    });
  } finally {
    proxy.close();
  }
  assert.ok(started.length > 0, 'no activity entry was opened, so this proves nothing');
  assert.deepEqual(ended.map(e => e.id), started,
    `an aborted request left ${started.length - ended.length} activity entry(s) open forever`);
  assert.deepEqual(ended.map(e => e.status), [499],
    'an entry closed for a client that went away should say so');
});

// The shipped TUI start hook has exactly this shape: it registers the row and
// then renders, and the render can rethrow. Whether the row survives depends on
// whether the entry was marked open before the hook ran or after it returned.
test('a start hook that registers its row and then throws does not orphan it', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const open = new Set();
  const closed = [];
  const proxy = createProxyServer(am, NO_UPSTREAM, {
    onRequestStart: (id) => { open.add(id); throw new Error('render() rethrew'); },
    onRequestEnd: (id, info) => { open.delete(id); closed.push(info.status); },
  });
  const port = await listen(proxy);
  let status;
  try {
    status = (await quietly(() => postMessages(port)))?.status;
  } finally {
    proxy.close();
  }
  assert.deepEqual([...open], [],
    'a start hook that threw after registering its row left the row open forever');
  // 502, not 499. This client is still connected and still waiting, and the
  // recovery is about to send it exactly that. 499 is for a row closed on
  // behalf of a client that will never read anything.
  assert.equal(status, 502, 'the client did not get the answer the row is reporting');
  assert.deepEqual(closed, [502],
    'the row was closed with a status the client was never sent');
});

// The mirror of the rule above, on the closing side. The inner path owns the
// entry from the moment it starts closing it, so it must give up its claim
// before calling the hook; otherwise a hook that throws still looks open to the
// outer catch, which calls that same hook again for the same request.
test('a throwing end hook is not called twice for one request', async () => {
  const upstream = okUpstream();
  const upPort = await listen(upstream);
  const am = new AccountManager(ACCTS, 0.98);
  const calls = [];
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upPort}` }, {
    onRequestEnd: (id, info) => { calls.push(info.status); throw new Error('the activity pane rethrew'); },
  });
  const port = await listen(proxy);
  try {
    const res = await quietly(() => postMessages(port));
    assert.equal(res?.status, 200, 'the request did not complete normally, so this proves nothing');
  } finally {
    proxy.close();
    upstream.close();
  }
  assert.equal(calls.length, 1,
    `one request closed its activity entry ${calls.length} times (statuses ${calls.join(', ')})`);
});

// The recovery calls a hook, and the throw that sent it there may be that same
// hook. Unguarded, the second throw leaves an async request listener with
// nothing above it to catch it: an unhandled rejection, which src/crash-log.js
// treats as fatal and turns into exit(1). A broken activity hook must not take
// the daemon down with it, and the socket must still get its answer.
//
// Reaching the guarded call needs BOTH hooks to throw: the start hook, so the
// entry is still open when the catch runs, and the end hook, so the call the
// catch makes to close it throws too.
test('a hook that throws on every call cannot bring the process down', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const SENTINEL = 'the activity pane rethrew, every time';
  let ends = 0;
  const proxy = createProxyServer(am, NO_UPSTREAM, {
    onRequestStart: () => { throw new Error('render() rethrew on open'); },
    onRequestEnd: () => { ends += 1; throw new Error(SENTINEL); },
  });
  const port = await listen(proxy);

  // Scoped to this test's own errors: `unhandledRejection` and
  // `uncaughtException` are process-wide, so a catch-all here would report a
  // stray failure from anywhere else in the run as this test's.
  const escaped = [];
  const mine = (e) => e?.message === SENTINEL || e?.message === 'render() rethrew on open';
  const onRejection = (e) => { if (mine(e)) escaped.push(`unhandledRejection: ${e.message}`); };
  const onUncaught = (e) => { if (mine(e)) escaped.push(`uncaughtException: ${e.message}`); };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onUncaught);
  let status;
  try {
    await quietly(async () => {
      status = (await postMessages(port))?.status;
      await new Promise(r => setTimeout(r, 150));   // let any escape surface
    });
  } finally {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onUncaught);
    proxy.close();
  }
  assert.ok(ends > 0, 'the recovery never tried to close the entry, so this proves nothing');
  assert.deepEqual(escaped, [],
    'a throwing activity hook escaped the request listener, where crash-log turns it into exit(1)');
  assert.equal(status, 502, 'the broken hook cost the client its answer');
});

// ── the recovery has to survive its own logging ──────────────────────────────
//
// Under the TUI, `console.error` is the TUI: it appends to the activity log and
// repaints. So the render that made the start hook throw makes the console throw
// too, and the first statement of every recovery path here is a report.
// Everything after it only runs if that report returns.
//
// Its fallback is `writeSync(2, ...)` rather than `process.stderr.write`, and
// the difference is load-bearing: a stderr whose reader is gone makes the stream
// surface EPIPE asynchronously, as an error event that no `try` around the call
// can catch, and crash-log.js treats an uncaught EPIPE as fatal. The helper
// written to keep a broken render from killing the daemon would kill it instead.
// Nothing before this had that exposure, because the global `console.error`
// swallows its own write errors.
//
// These run in a child for two reasons. A raw fd-2 write goes around any stub a
// test could install, so reading the child's stderr is the only honest way to
// assert the report arrived; and taking stderr away, which is the whole point of
// the third one, is not something a test can do to its own runner.

const SERVER_PATH = fileURLToPath(new URL('../src/server.js', import.meta.url));
const AM_PATH = fileURLToPath(new URL('../src/account-manager.js', import.meta.url));

// Run a proxy in a child whose console throws, drive one request at `path`, and
// report back over stdout. `stderr: 'destroy'` removes the reader before the
// request, which is what turns a fallback write into EPIPE.
//
// `hooks` is source, not a value, since it crosses a process boundary.
function recoverInChild({ path = '/v1/messages', method = 'POST', hooks, stderr = 'pipe' }) {
  const source = `
    import http from 'node:http';
    import { AccountManager } from ${JSON.stringify(AM_PATH)};
    import { createProxyServer } from ${JSON.stringify(SERVER_PATH)};
    const say = (s) => process.stdout.write(s + '\\n');
    // Bounded, because whatever escapes ends up inside an assertion message,
    // and an unbounded one is unreadable at the moment someone has to read it.
    const why = (e) => String(e?.code || e?.message).slice(0, 80);
    process.on('uncaughtException', (e) => { say('ESCAPED:uncaughtException:' + why(e)); process.exit(9); });
    process.on('unhandledRejection', (e) => { say('ESCAPED:unhandledRejection:' + why(e)); process.exit(9); });

    const open = new Set();
    const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
    const proxy = createProxyServer(am, { proxy: {}, upstream: 'http://127.0.0.1:1' }, ${hooks});
    proxy.listen(0, '127.0.0.1', () => {
      const port = proxy.address().port;
      console.error = () => { throw new Error('TUI render failed'); };
      const req = http.request({ host: '127.0.0.1', port, method: ${JSON.stringify(method)}, path: ${JSON.stringify(path)},
        headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => {
          say('answered=' + res.statusCode);
          setTimeout(() => { say('rowsStillOpen=' + open.size); say('STILL-ALIVE'); process.exit(0); }, 300);
        });
      });
      req.on('error', (e) => { say('client-error=' + e.code); process.exit(8); });
      req.end(${JSON.stringify(method)} === 'POST' ? JSON.stringify({ model: 'claude-opus-5', messages: [] }) : undefined);
    });
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const errChunks = [];
    child.stdout.on('data', (d) => out.push(...String(d).trim().split('\n').filter(Boolean)));
    child.stderr.on('error', () => {});
    if (stderr === 'destroy') child.stderr.destroy();
    else child.stderr.on('data', (d) => errChunks.push(String(d)));
    child.on('close', (code) => resolve({ code, out, reported: errChunks.join('') }));
  });
}

const LISTENER_HOOKS = `{
  onRequestStart: (id) => { open.add(id); throw new Error('TUI render failed'); },
  // Closes its row and THEN throws, the same way the start hook does. This is
  // what carries the failure into the recovery's own guarded hook call, whose
  // report is the second place a throwing console can stop everything.
  onRequestEnd: (id) => { open.delete(id); throw new Error('TUI render failed'); },
}`;

test('a console that throws does not defeat the recovery', async () => {
  const { out, reported } = await recoverInChild({ hooks: LISTENER_HOOKS });
  assert.ok(!out.some(l => l.startsWith('ESCAPED:')),
    `a throwing console escaped the request listener, where crash-log turns it into exit(1): ${out.join(', ')}`);
  assert.ok(out.includes('rowsStillOpen=0'), `a throwing console left the activity row open forever: ${out.join(', ')}`);
  assert.ok(out.includes('answered=502'), `a throwing console cost the client its answer: ${out.join(', ')}`);
  // Recovering quietly is not the same as recovering. Both reports on this path
  // have to reach somewhere a person can read them, or a render bug is invisible
  // for as long as the TUI is up.
  assert.match(reported, /\[TeamClaude\] Unhandled error:/,
    'the failure that started the recovery was never reported anywhere');
  assert.match(reported, /\[TeamClaude\] activity hook failed while closing a request:/,
    'the hook failure inside the recovery was never reported anywhere');
});

// The same hazard on the control plane, where the report is likewise the first
// statement of the catch.
test('a console that throws does not defeat the control-plane recovery', async () => {
  const { out, reported } = await recoverInChild({
    path: '/teamclaude/status', method: 'GET',
    hooks: `{ getStatusExtra: () => { throw new Error('TUI render failed'); } }`,
  });
  assert.ok(!out.some(l => l.startsWith('ESCAPED:')),
    `a throwing console escaped the control-plane handler, where crash-log turns it into exit(1): ${out.join(', ')}`);
  assert.ok(out.includes('answered=502'), `a throwing console cost the status request its answer: ${out.join(', ')}`);
  assert.match(reported, /\[TeamClaude\] Unhandled error:/,
    'the failure that started the recovery was never reported anywhere');
});

// And the fallback itself, with nobody left to read what it writes.
test('a report to a closed stderr does not kill the process', async () => {
  const { code, out } = await recoverInChild({ hooks: LISTENER_HOOKS, stderr: 'destroy' });
  assert.ok(!out.some(l => l.startsWith('ESCAPED:')),
    `the fallback report escaped and killed the daemon: ${out.join(', ')}`);
  assert.ok(out.includes('answered=502'), `the client was not answered: ${out.join(', ')}`);
  assert.ok(out.includes('STILL-ALIVE'), `the process did not survive the report: ${out.join(', ')}`);
  assert.equal(code, 0, 'the child exited non-zero');
});


// The blocklist answers and returns on its own, so it owns the entry it closes.
// Leaving it marked open means the outer catch closes it a second time, which
// is reachable the moment the hook itself throws.
test('a blocked model closes its activity entry exactly once', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  const ends = [];
  const proxy = createProxyServer(am, { ...NO_UPSTREAM, blockedModels: ['*fable*'] }, {
    onRequestEnd: (id, info) => {
      ends.push(info.status);
      if (ends.length === 1) throw new Error('the activity pane rethrew');
    },
  });
  const port = await listen(proxy);
  try {
    const res = await quietly(() => postMessages(port, JSON.stringify({ model: 'claude-fable-5', messages: [] })));
    assert.equal(res?.status, 400, 'the blocklist did not answer, so this proves nothing');
  } finally {
    proxy.close();
  }
  assert.equal(ends.length, 1,
    `one blocked request closed its activity entry ${ends.length} times (statuses ${ends.join(', ')})`);
});
