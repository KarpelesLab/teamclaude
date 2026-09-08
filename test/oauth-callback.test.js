import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startCallbackServer } from '../src/oauth.js';
import { codexCallbackHandler } from '../src/codex-auth.js';

// The loopback callback listener is open for as long as the user is in the
// browser. A request that does not carry the expected state must be answered
// and otherwise ignored: it used to abort the whole login, so any drive-by GET
// (a page probing localhost ports, a scanner, a stale tab) could deny the login
// by arriving first with `?error=` or with no state at all.

/** Whether `p` settles within `ms`. */
async function settles(p, ms = 50) {
  const pending = Symbol('pending');
  const r = await Promise.race([p.then(() => 'ok', () => 'err'), new Promise(r => setTimeout(() => r(pending), ms))]);
  return r !== pending;
}

test('the Anthropic callback server binds loopback only', async () => {
  const { server } = await startCallbackServer('st');
  try {
    assert.equal(server.address().address, '127.0.0.1');
  } finally {
    server.close();
  }
});

test('an Anthropic callback without the expected state is refused and does not settle the login', async () => {
  const { port, codePromise, server } = await startCallbackServer('st');
  try {
    const base = `http://127.0.0.1:${port}/callback`;
    // `?error=` used to reject the login before the state was even looked at.
    let res = await fetch(`${base}?error=access_denied`);
    assert.equal(res.status, 400);
    res = await fetch(`${base}?error=access_denied&state=other`);
    assert.equal(res.status, 400);
    // A code under the wrong state used to reject too; now it is just ignored.
    res = await fetch(`${base}?code=abc&state=other`);
    assert.equal(res.status, 400);
    res = await fetch(`${base}?code=abc`);
    assert.equal(res.status, 400);
    assert.equal(await settles(codePromise), false, 'the login must still be waiting');

    // The real redirect still completes it.
    res = await fetch(`${base}?code=abc&state=st`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(await codePromise, 'abc');
  } finally {
    server.close();
  }
});

test('an Anthropic callback with the right state still reports an upstream error', async () => {
  const { port, codePromise, server } = await startCallbackServer('st');
  try {
    // Attached before the request: the rejection lands as soon as the handler runs.
    const rejected = assert.rejects(codePromise, /OAuth error: access_denied - nope/);
    const res = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=nope&state=st`);
    assert.equal(res.status, 200);
    await rejected;
  } finally {
    server.close();
  }
});

// The Codex handler is exercised on an ephemeral port: the real flow has to
// bind 1455 (OpenAI's one registered redirect), which a test must not claim.
async function codexServer(state) {
  let resolve, reject;
  const codePromise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const server = http.createServer(codexCallbackHandler(state, { resolve, reject }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, codePromise, base: `http://127.0.0.1:${server.address().port}/auth/callback` };
}

test('a Codex callback without the expected state is refused and does not settle the login', async () => {
  const { server, codePromise, base } = await codexServer('st');
  try {
    for (const q of ['?error=access_denied', '?error=access_denied&state=other', '?code=abc&state=other', '?code=abc']) {
      const res = await fetch(`${base}${q}`);
      assert.equal(res.status, 400, q);
    }
    assert.equal(await settles(codePromise), false, 'the login must still be waiting');

    const res = await fetch(`${base}?code=abc&state=st`);
    assert.equal(res.status, 200);
    assert.equal(await codePromise, 'abc');
  } finally {
    server.close();
  }
});

test('a Codex callback with the right state still reports an upstream error or a missing code', async () => {
  let s = await codexServer('st');
  try {
    const rejected = assert.rejects(s.codePromise, /OAuth error: access_denied/);
    await fetch(`${s.base}?error=access_denied&state=st`);
    await rejected;
  } finally {
    s.server.close();
  }
  s = await codexServer('st');
  try {
    const rejected = assert.rejects(s.codePromise, /carried no code/);
    await fetch(`${s.base}?state=st`);
    await rejected;
  } finally {
    s.server.close();
  }
});
