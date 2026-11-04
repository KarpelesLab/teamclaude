import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { SessionPins, MAX_SESSION_PINS } from '../src/session-pins.js';
import { SessionTracker } from '../src/session-tracker.js';
import { renderStatus } from '../src/status-renderer.js';
import { sessionPinsText } from '../src/dashboard.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

// `teamclaude switch <account>` moves the fleet. `--session` moves one session
// (issue #543): a hard pin like TC_ACCT, set at runtime and keyed by the
// session id the client sends, that leaves every other session where it was.

const HOUR = 3600_000;
const listen = (/** @type {any} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const apikey = (/** @type {string} */ name) => ({ name, type: 'apikey', apiKey: `key-${name}` });
const SESSION = '3f2a1b9c-0000-4000-8000-000000000001';
const OTHER = '9d0e4c11-0000-4000-8000-000000000002';

/** Run `fn` with console output captured, so the server's lines stay out of the test output.
 * @param {() => Promise<void>} fn */
async function quietly(fn) {
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

/** @param {any[]} accounts */
async function proxyWith(accounts, proxyConfig = {}) {
  /** @type {string[]} */
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(/** @type {string} */ (req.headers['x-api-key']));
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k', ...proxyConfig }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  return { am, port, seen, close: () => { proxy.close(); upstream.close(); } };
}

/** @param {number} port @param {string|null} sessionId */
const message = (port, sessionId) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k', ...(sessionId ? { 'x-claude-code-session-id': sessionId } : {}) },
  body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
});

/** @param {number} port @param {any} body */
const pin = async (port, body, key = 'k') => {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/session-pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('a pinned session goes to its account; every other session stays with the fleet', async () => {
  const ctx = await proxyWith([apikey('a'), apikey('b')]);
  await quietly(async () => {
    try {
      assert.equal((await message(ctx.port, SESSION)).status, 200);
      const set = await pin(ctx.port, { sessionId: SESSION, account: 'b' });
      assert.equal(set.status, 200);
      assert.equal(set.body.account, 'b');
      assert.equal(set.body.seen, true, 'the session had made a request');
      assert.equal(set.body.eligible, true);

      ctx.seen.length = 0;
      await (await message(ctx.port, SESSION)).text();
      await (await message(ctx.port, OTHER)).text();
      await (await message(ctx.port, null)).text();
      assert.deepEqual(ctx.seen, ['key-b', 'key-a', 'key-a']);
      assert.equal(ctx.am.accounts[ctx.am.currentIndex].name, 'a', 'the fleet did not move');

      const cleared = await pin(ctx.port, { sessionId: SESSION, account: null });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.cleared, true);
      ctx.seen.length = 0;
      await (await message(ctx.port, SESSION)).text();
      assert.deepEqual(ctx.seen, ['key-a'], 'unpinned, it follows the fleet again');
      assert.equal((await pin(ctx.port, { sessionId: SESSION, account: null })).body.cleared, false);
    } finally {
      ctx.close();
    }
  });
});

test('a launch-time TC_ACCT pin wins over a session pin', async () => {
  const ctx = await proxyWith([apikey('a'), apikey('b'), apikey('c')]);
  await quietly(async () => {
    try {
      await pin(ctx.port, { sessionId: SESSION, account: 'b' });
      const res = await fetch(`http://127.0.0.1:${ctx.port}/tc-acct/c/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': SESSION },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [] }),
      });
      await res.text();
      assert.deepEqual(ctx.seen, ['key-c']);
    } finally {
      ctx.close();
    }
  });
});

test('a session pin on an account that has gone is a 404, not a quiet reroute', async () => {
  const ctx = await proxyWith([apikey('a'), apikey('b')]);
  await quietly(async () => {
    try {
      ctx.am.sessionPins.set(SESSION, 'ghost');
      const res = await message(ctx.port, SESSION);
      assert.equal(res.status, 404);
      assert.match((await res.json()).error.message, /Unknown account pin "ghost" \(session pin/);
      assert.deepEqual(ctx.seen, [], 'nothing reached upstream');
    } finally {
      ctx.close();
    }
  });
});

test('the endpoint validates its body and says when it has not seen the session', async () => {
  const ctx = await proxyWith([apikey('a'), apikey('b')]);
  await quietly(async () => {
    try {
      for (const body of [{}, { sessionId: '', account: 'b' }, { sessionId: 'has space', account: 'b' }, { sessionId: 'x'.repeat(129), account: 'b' }, { sessionId: 7, account: 'b' }]) {
        const r = await pin(ctx.port, body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(r.body.error, /sessionId/);
      }
      for (const body of [{ sessionId: SESSION }, { sessionId: SESSION, account: '  ' }, { sessionId: SESSION, account: 3 }]) {
        assert.equal((await pin(ctx.port, body)).status, 400, JSON.stringify(body));
      }
      assert.equal((await pin(ctx.port, '{not json')).status, 400);
      const unknown = await pin(ctx.port, { sessionId: SESSION, account: 'nobody' });
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.body.accounts, ['a', 'b']);

      const unseen = await pin(ctx.port, { sessionId: OTHER, account: 'b' });
      assert.equal(unseen.status, 200);
      assert.equal(unseen.body.seen, false, 'no request has carried this id');
    } finally {
      ctx.close();
    }
  });
});

test('a client key is refused; the shared proxy key is not', async () => {
  const ctx = await proxyWith([apikey('a'), apikey('b')], { clientKeys: [{ name: 'ci', key: 'ci-key' }] });
  await quietly(async () => {
    try {
      const refused = await pin(ctx.port, { sessionId: SESSION, account: 'b' }, 'ci-key');
      assert.equal(refused.status, 403);
      assert.deepEqual(refused.body, { ok: false, error: 'a client key cannot pin sessions' });
      assert.equal(ctx.am.sessionPins.get(SESSION), null);
      assert.equal((await pin(ctx.port, { sessionId: SESSION, account: 'b' })).status, 200);
    } finally {
      ctx.close();
    }
  });
});

test('status lists the pins, with the session id shortened unless sessionDetail is on', async () => {
  const am = new AccountManager([apikey('a'), apikey('b')], 0.98);
  am.sessionPins.set(SESSION, 'b');
  const [row] = am.getStatus().sessionPins;
  assert.equal(row.session, SESSION.slice(0, 8));
  assert.equal(row.account, 'b');
  assert.equal(row.id, undefined);
  assert.equal(am.getStatus({ sessionDetail: true }).sessionPins[0].id, SESSION);

  const text = renderStatus(am.getStatus(), { color: false });
  assert.match(text, new RegExp(`Pinned\\s+${SESSION.slice(0, 8)} → b`));
  assert.doesNotMatch(renderStatus(new AccountManager([apikey('a')], 0.98).getStatus(), { color: false }), /Pinned/);
  assert.equal(sessionPinsText(am.getStatus().sessionPins), `pinned: ${SESSION.slice(0, 8)} → b`);
  assert.equal(sessionPinsText([]), '');
});

test('a pin follows an account renamed on disk', async () => {
  const oauth = (/** @type {string} */ name, /** @type {string} */ uuid) => ({ name, id: `id-${uuid}`, type: 'oauth', accountUuid: uuid, accessToken: `t-${uuid}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
  const am = new AccountManager([oauth('a', 'u1'), oauth('b', 'u2')], 0.98);
  const memConfig = { accounts: [oauth('a', 'u1'), oauth('b', 'u2')] };
  am.sessionPins.set(SESSION, 'b');
  await quietly(async () => { await syncAccountsFromDisk({ accounts: [oauth('a', 'u1'), oauth('b-renamed', 'u2')] }, memConfig, am); });
  assert.equal(am.accounts[1].name, 'b-renamed');
  assert.equal(am.sessionPins.get(SESSION), 'b-renamed');
});

test('SessionPins: set, clear, expiry by idleness, and the cap', () => {
  let now = 1_000;
  const pins = new SessionPins({ ttlMs: HOUR, now: () => now });
  assert.equal(pins.set(SESSION, 'b'), false);
  assert.equal(pins.get(SESSION), 'b');
  now += HOUR; // used at the start of this hour: still held
  assert.equal(pins.get(SESSION), 'b', 'a hit counts as use');
  now += HOUR + 1;
  assert.equal(pins.get(SESSION), null, 'idle past the window: forgotten');
  assert.equal(pins.get(null), null);

  pins.set(SESSION, 'b');
  assert.equal(pins.set(SESSION, null), true);
  assert.equal(pins.get(SESSION), null);

  for (let i = 0; i < MAX_SESSION_PINS + 5; i++) pins.set(`s${i}`, 'a');
  assert.equal(pins.pins.size, MAX_SESSION_PINS);
  assert.equal(pins.get('s0'), null, 'the least recently used went first');
  assert.equal(pins.get(`s${MAX_SESSION_PINS + 4}`), 'a');
});

test('SessionTracker.knowsSession matches the session behind a conversation key', () => {
  const tracker = new SessionTracker();
  assert.equal(tracker.knowsSession(SESSION), false);
  tracker.beginRequest(`${SESSION}#abc`, undefined, { sessionId: SESSION, conversation: 'abc' });
  tracker.endRequest(`${SESSION}#abc`);
  assert.equal(tracker.knowsSession(SESSION), true);
  tracker.touch(OTHER);
  assert.equal(tracker.knowsSession(OTHER), true, 'a key with no conversation is the session id itself');
  assert.equal(tracker.knowsSession(null), false);
});
