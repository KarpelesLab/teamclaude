import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Every error path responds on the socket.
//
// Both of the server's outer catches sit above the 502 that guards
// forwardRequest: one around the control plane (the auth gate, the CSRF gate,
// status/reload/switch), one around the proxied request (pin parsing, body
// buffering, the activity hooks). A throw in either is the last chance to
// respond at all.
//
// Every request here races a timer, so a hang is a failed assertion rather
// than a run that never finishes.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const ACCTS = [{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }];
// Port 1 is never listening, so nothing here can reach a real upstream: these
// tests are about what happens before forwardRequest gets that far.
const NO_UPSTREAM = { proxy: {}, upstream: 'http://127.0.0.1:1' };

// What the client got, as one of three distinguishable outcomes: `{ status }`
// for a reply it could read to the end, `{ hung: true }` if nothing arrived
// before the timer, `{ closed: err }` if the connection was torn down under it.
// The last two are separate on purpose: a torn-down connection is an answer,
// and it is the only one that tells the client its reply is incomplete.
async function outcomeWithin(url, init = {}, ms = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    await res.text();
    return { status: res.status };
  } catch (err) {
    return err.name === 'AbortError' ? { hung: true } : { closed: err };
  } finally {
    clearTimeout(timer);
  }
}

const postMessages = (port) => outcomeWithin(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
});

// Run `fn` with console.error muted: these tests deliberately provoke the
// "[TeamClaude] Unhandled error" log, and the stack traces would drown the run.
async function quietly(fn) {
  const realErr = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = realErr;
  }
}

// ── the proxied request path ─────────────────────────────────────────────────

// Held at the seam rather than through one input that happens to reach it:
// anything that throws in the window above forwardRequest is answered.
// `onRequestStart` fires there.
test('a throw above forwardRequest is answered rather than hanging the client', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  let reached = false;
  const proxy = createProxyServer(am, NO_UPSTREAM, {
    onRequestStart: () => { reached = true; throw new Error('injected failure above forwardRequest'); },
  });
  const port = await listen(proxy);
  try {
    assert.deepEqual(await quietly(() => postMessages(port)), { status: 502 },
      'a throw above forwardRequest left the client waiting forever');
  } finally {
    proxy.close();
  }
  assert.ok(reached, 'the request never reached the injected throw, so this proves nothing');
});

// The other half of that catch: it must not respond a second time. The inner
// `finally` runs `onRequestEnd` after the response has streamed, so a throw
// there reaches the catch with the headers long sent, and a second writeHead
// raises ERR_HTTP_HEADERS_SENT from inside the recovery. The client already has
// its answer in full, and neither arm may take it away.
test('a throw after the response is streamed does not answer a second time', async () => {
  // SSE in several frames, so the reply really goes through streamResponse and
  // the headers are long gone by the time the throw below lands. A buffered
  // JSON reply never reaches that path.
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    await new Promise(r => setTimeout(r, 10));
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');
    await new Promise(r => setTimeout(r, 10));
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(ACCTS, 0.98);
  let reached = false;
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` }, {
    onRequestEnd: () => { reached = true; throw new Error('injected failure after the response'); },
  });
  const port = await listen(proxy);

  // Narrowed to the one rejection this test is about, and attached only for the
  // length of its own request: `unhandledRejection` is process-wide, so a
  // catch-all here would report a stray rejection from anywhere else in the run
  // as this test's failure.
  const rejections = [];
  const onRejection = (err) => { if (err?.code === 'ERR_HTTP_HEADERS_SENT') rejections.push(err); };
  process.on('unhandledRejection', onRejection);
  try {
    assert.deepEqual(await quietly(() => postMessages(port)), { status: 200 },
      'the client did not get the response the upstream already sent');
    // Give a rejection a turn of the loop to surface before we judge.
    await new Promise(r => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', onRejection);
    proxy.close();
    upstream.close();
  }
  assert.ok(reached, 'the request never reached the injected throw, so this proves nothing');
  assert.deepEqual(rejections.map(e => e.code), [],
    'the outer catch tried to answer an already-answered request and threw doing it');
});

// ── the control-plane path ───────────────────────────────────────────────────

// `getStatusExtra` is a hook the application installs, so this throw surface is
// real rather than hypothetical.
test('a throwing status hook is answered, not left hanging', async () => {
  const am = new AccountManager(ACCTS, 0.98);
  let reached = false;
  const proxy = createProxyServer(am, NO_UPSTREAM, {
    getStatusExtra: () => { reached = true; throw new Error('status hook blew up'); },
  });
  const port = await listen(proxy);
  try {
    assert.deepEqual(await quietly(() => outcomeWithin(`http://127.0.0.1:${port}/teamclaude/status`)), { status: 502 },
      'a throwing status hook left the client waiting forever');
  } finally {
    proxy.close();
  }
  assert.ok(reached, 'the request never reached the injected throw, so this proves nothing');
});

// The half that a before-headers guard alone does not cover. The status
// endpoint serializes the hook's value after writeHead, so a value JSON cannot
// represent (a cycle, a BigInt) throws with the 200 already sent, and nothing
// else ends the response.
//
// Not answering at all and ending the response gracefully are both wrong here,
// and only one of them looks wrong: an end() delivers the 200 the client asked
// for, with a body that was never written, and the client has no way to tell it
// from a real one. So this asserts the connection was destroyed, not merely
// that something came back.
test('a status hook returning an unserializable value closes the connection', async () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const [label, extra] of [['a cycle', { cyclic }], ['a BigInt', { big: 1n }]]) {
    const am = new AccountManager(ACCTS, 0.98);
    let reached = false;
    const proxy = createProxyServer(am, NO_UPSTREAM, {
      getStatusExtra: () => { reached = true; return extra; },
    });
    const port = await listen(proxy);
    let outcome;
    try {
      outcome = await quietly(() => outcomeWithin(`http://127.0.0.1:${port}/teamclaude/status`));
    } finally {
      proxy.close();
    }
    assert.ok(reached, `the request never reached the hook returning ${label}`);
    assert.ok(!outcome.hung, `${label}: the client waited forever for a response nobody sent`);
    assert.ok(outcome.closed,
      `${label}: the client read a complete ${outcome.status} whose body was never written`);
  }
});
