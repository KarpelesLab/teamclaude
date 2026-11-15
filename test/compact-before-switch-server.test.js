import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxyRequestListener } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { CompactAsks, SESSION_GAP_MS } from '../src/compact-before-switch.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

// compactBeforeSwitch (issue #709) through the real request path, against a
// stub upstream. The stub is the witness: a request answered here never reaches
// it, and the token it sees says which account a forwarded request went to.

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

const HOUR = 3600_000;
const OPUS = 'claude-opus-4-5';
const oauth = (/** @type {string} */ name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 12 * HOUR, ...extra });

/** @param {http.Server} server @returns {Promise<number>} */
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)));
}

/**
 * A fleet behind `listeners` request listeners that share one AccountManager,
 * as the base listener and the MITM tunnel listeners do, in front of a stub
 * upstream. `quota[name]` is what the stub reports for that account's 5-hour
 * and weekly windows on every response, so a reading arrives the way a real
 * one does.
 *
 * @param {Object} opts
 * @param {Record<string, any>} opts.config
 * @param {any[]} [opts.accounts]
 * @param {Record<string, { five?: number, week?: number }>} [opts.quota]
 * @param {boolean} [opts.distribute]
 * @param {number} [opts.listeners]
 * @param {(h: any) => Promise<void>} fn
 */
async function withFleet({ config, accounts = [oauth('a'), oauth('b')], quota = { a: { five: 0.95 } }, distribute = false, listeners = 1 }, fn) {
  /** @type {{ url: string, account: string, bytes: number }[]} */
  const hits = [];
  const stub = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', c => { bytes += c.length; });
    req.on('end', () => {
      const account = String(req.headers.authorization || req.headers['x-api-key'] || '').replace(/^(Bearer )?t-/, '');
      hits.push({ url: String(req.url), account, bytes });
      const q = quota[account] || {};
      const reset = String(Math.floor((Date.now() + 4 * HOUR) / 1000));
      /** @type {Record<string, string>} */
      const headers = { 'content-type': 'application/json' };
      if (q.five != null) Object.assign(headers, { 'anthropic-ratelimit-unified-5h-utilization': String(q.five), 'anthropic-ratelimit-unified-5h-reset': reset });
      if (q.week != null) Object.assign(headers, { 'anthropic-ratelimit-unified-7d-utilization': String(q.week), 'anthropic-ratelimit-unified-7d-reset': reset });
      res.writeHead(200, headers);
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const stubPort = await listen(stub);
  const clock = { t: 1_000_000 };
  const am = new AccountManager(accounts, 0.98, { distributeSessions: distribute });
  am.compactAsks = new CompactAsks({ now: () => clock.t });
  /** @type {any[]} */
  const activity = [];
  const hooks = { onRequestEnd: (/** @type {number} */ _id, /** @type {any} */ info) => activity.push(info) };
  const servers = [];
  const ports = [];
  for (let i = 0; i < listeners; i++) {
    const server = http.createServer(createProxyRequestListener({ accountManager: am, upstream: `http://127.0.0.1:${stubPort}`, config, hooks }));
    servers.push(server);
    ports.push(await listen(server));
  }
  /**
   * One request. `opening` is the conversation's first message, which is what
   * names the conversation; `pad` sizes the body.
   * @param {{ session?: string|null, opening?: string, pad?: number, model?: string, path?: string, listener?: number }} [r]
   */
  const send = async ({ session = 'sess-1', opening = 'first task', pad = 6000, model = OPUS, path = '/v1/messages', listener = 0 } = {}) => {
    const res = await fetch(`http://127.0.0.1:${ports[listener]}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(session ? { 'x-claude-code-session-id': session } : {}) },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: opening }, { role: 'assistant', content: 'x'.repeat(pad) }] }),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
  };
  try {
    await fn({ am, hits, send, clock, config, activity });
  } finally {
    for (const s of servers) { s.closeAllConnections(); s.close(); }
    stub.closeAllConnections();
    stub.close();
  }
}

const ON = { compactBeforeSwitch: { minBodyBytes: 2000 } };
const TOO_LONG = /^prompt is too long: (\d+) tokens > (\d+) maximum$/;

test('a long conversation near the threshold gets the 400, upstream sees nothing, and the compaction runs on the same account', async () => {
  const logged = [];
  const original = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); };
  try {
    await withFleet({ config: ON }, async ({ am, hits, send, activity }) => {
      // The first turn has no account on record yet, and no reading either.
      assert.equal((await send()).status, 200);
      assert.deepEqual(hits.map(h => h.account), ['a']);
      assert.equal(am.accounts[0].quota.unified5h, 0.95, 'setup: the stub put the account inside the margin');

      const load = () => JSON.stringify([am.currentIndex, am.sessionTracker.livePins(), am.sessionTracker.recentRequestsFor(0), am.accounts[0].quota]);
      const before = load();
      const asked = await send({ pad: 8000 });
      assert.equal(asked.status, 400);
      assert.equal(hits.length, 1, 'nothing was sent upstream');
      assert.equal(load(), before, 'no cursor or pin moved, nothing counted as load, no quota reading changed');
      assert.equal(asked.headers.get('content-type'), 'application/json');
      assert.equal(asked.headers.get('x-should-retry'), 'false');
      assert.equal(asked.headers.get('request-id'), null, 'no upstream request id is invented');
      assert.deepEqual(Object.keys(asked.json), ['type', 'error']);
      assert.equal(asked.json.type, 'error');
      assert.deepEqual(Object.keys(asked.json.error), ['type', 'message']);
      assert.equal(asked.json.error.type, 'invalid_request_error');
      const m = TOO_LONG.exec(asked.json.error.message);
      assert.ok(m, asked.json.error.message);
      const bytes = Buffer.byteLength(JSON.stringify({ model: OPUS, max_tokens: 16, messages: [{ role: 'user', content: 'first task' }, { role: 'assistant', content: 'x'.repeat(8000) }] }));
      assert.equal(Number(m[1]), Math.ceil(bytes / 4));
      assert.ok(Number(m[2]) < Number(m[1]));

      // The compaction request: the same conversation, a little larger. It is
      // forwarded, to the account that holds the cache.
      assert.equal((await send({ pad: 8200 })).status, 200);
      assert.deepEqual(hits.map(h => h.account), ['a', 'a']);
      // The retried turn opens with the summary, so it is a new conversation.
      assert.equal((await send({ opening: 'summary of the above', pad: 3000 })).status, 200);
      assert.deepEqual(hits.map(h => h.account), ['a', 'a', 'a']);

      assert.equal(am.compactAsks.asked, 1);
      const row = activity.find(a => a.status === 400);
      assert.equal(row?.account, '(compact before switch: a)');
      assert.equal(row?.sessionId, 'sess-1');
    });
  } finally {
    console.log = original;
  }
  const lines = logged.filter(l => l.includes('compactBeforeSwitch'));
  assert.equal(lines.length, 1, 'one log line per request answered this way');
  assert.match(lines[0], /Asked session sess-1 to compact before "a" switches: unified5h is at 95%, switch threshold 98%/);
});

test('the weekly window asks too, and an account not within the margin forwards', async () => {
  await withFleet({ config: ON, quota: { a: { five: 0.2, week: 0.96 } } }, async ({ hits, send }) => {
    await send();
    assert.equal((await send({ pad: 8000 })).status, 400);
    assert.equal(hits.length, 1);
  });
  await withFleet({ config: ON, quota: { a: { five: 0.9, week: 0.9 } } }, async ({ hits, send }) => {
    await send();
    assert.equal((await send({ pad: 8000 })).status, 200);
    assert.equal(hits.length, 2);
  });
});

test('a request under minBodyBytes forwards', async () => {
  await withFleet({ config: ON }, async ({ hits, send }) => {
    await send();
    assert.equal((await send({ pad: 500 })).status, 200);
    assert.equal(hits.length, 2);
  });
});

test('an account already at its threshold is not asked: the request rotates as it always did', async () => {
  await withFleet({ config: ON, quota: { a: { five: 0.99 } } }, async ({ hits, send }) => {
    await send();
    assert.equal((await send({ pad: 8000 })).status, 200);
    assert.deepEqual(hits.map(h => h.account), ['a', 'b']);
  });
});

test('pinned requests are never asked: /tc-acct/, and an operator session pin', async () => {
  await withFleet({ config: ON }, async ({ am, hits, send }) => {
    await send();
    assert.equal((await send({ pad: 8000, path: '/tc-acct/a/v1/messages' })).status, 200);
    assert.equal(hits.length, 2);
    am.sessionPins.set('sess-1', 'a');
    assert.equal((await send({ pad: 8000 })).status, 200);
    assert.equal(hits.length, 3);
    am.sessionPins.set('sess-1', null);
    assert.equal((await send({ pad: 8000 })).status, 400, 'the same request without the pin is asked');
    assert.equal(hits.length, 3);
  });
});

test('count_tokens, a request with no session id, and an API-key account are never asked', async () => {
  await withFleet({ config: ON }, async ({ hits, send }) => {
    await send();
    assert.equal((await send({ pad: 8000, path: '/v1/messages/count_tokens' })).status, 200);
    assert.equal((await send({ pad: 8000, session: null })).status, 200);
    assert.equal(hits.length, 3);
    assert.equal((await send({ pad: 8000 })).status, 400, 'the completion itself is asked');
    assert.equal(hits.length, 3);
  });
  const apikey = [{ name: 'a', type: 'apikey', apiKey: 't-a' }, { name: 'b', type: 'apikey', apiKey: 't-b' }];
  await withFleet({ config: ON, accounts: apikey }, async ({ am, hits, send }) => {
    await send();
    assert.equal(am.accounts[0].quota.unified5h, 0.95, 'setup: the key reads as inside the margin');
    assert.equal((await send({ pad: 8000 })).status, 200);
    assert.equal(hits.length, 2);
  });
});

test('off by default, and the live config turns it on and off for the next request', async () => {
  /** @type {Record<string, any>} */
  const config = {};
  await withFleet({ config }, async ({ am, hits, send }) => {
    await send();
    assert.equal((await send({ pad: 8000 })).status, 200, 'unset: forwarded');
    assert.equal(hits.length, 2);
    for (const off of [false, 'yes', 1, null]) {
      config.compactBeforeSwitch = off;
      assert.equal((await send({ pad: 8000 })).status, 200, `${JSON.stringify(off)}: forwarded`);
    }
    assert.equal(hits.length, 6);
    assert.equal(am.compactAsks.conversations.size, 0, 'off keeps no record');

    config.compactBeforeSwitch = { minBodyBytes: 2000 };
    assert.equal((await send({ pad: 8000 })).status, 400);
    assert.equal(hits.length, 6);

    // Another conversation of another session, with the setting removed again.
    await send({ session: 'sess-2', opening: 'second task' });
    delete config.compactBeforeSwitch;
    assert.equal((await send({ session: 'sess-2', opening: 'second task', pad: 8000 })).status, 200);
    assert.equal(hits.length, 8);
  });
});

test('the cooldowns: the conversation, then the client session, then asked again', async () => {
  await withFleet({ config: { compactBeforeSwitch: { minBodyBytes: 2000, cooldownSeconds: 600 } } }, async ({ hits, send, clock }) => {
    await send();
    assert.equal((await send({ pad: 8000 })).status, 400);
    // Within the cooldown the same conversation is forwarded however large.
    assert.equal((await send({ pad: 20_000 })).status, 200);
    // The compacted conversation is forwarded once to be placed, and from then
    // on is held to the session rules.
    assert.equal((await send({ opening: 'summary', pad: 9000 })).status, 200);
    assert.equal((await send({ opening: 'summary', pad: 9000 })).status, 200, 'inside the two-minute gap');
    clock.t += SESSION_GAP_MS;
    assert.equal((await send({ opening: 'summary', pad: 5000 })).status, 200, 'smaller than the body that was asked');
    assert.equal(hits.length, 5);
    assert.equal((await send({ opening: 'summary', pad: 9000 })).status, 400, 'as large as the body that was asked');
    assert.equal(hits.length, 5);
    clock.t += 600_000;
    assert.equal((await send({ pad: 8000 })).status, 400, 'the first conversation again, after its cooldown');
    assert.equal(hits.length, 5);
  });
});

test('distributeSessions: only the conversation whose own account is near the threshold is asked', async () => {
  await withFleet({ config: ON, distribute: true, quota: { a: { five: 0.2 }, b: { five: 0.96 } } }, async ({ am, hits, send }) => {
    // Two concurrent conversations, so distribution places them apart: the
    // first is still in flight (held by the tracker) when the second arrives.
    am.beginSession((await placed(am, send, { session: 'sess-1', opening: 'one' })));
    await send({ session: 'sess-2', opening: 'two' });
    const where = Object.fromEntries(hits.map((h, i) => [i === 0 ? 'one' : 'two', h.account]));
    assert.notEqual(where.one, where.two, 'setup: the two conversations sit on different accounts');
    const near = where.one === 'b' ? { session: 'sess-1', opening: 'one' } : { session: 'sess-2', opening: 'two' };
    const far = where.one === 'b' ? { session: 'sess-2', opening: 'two' } : { session: 'sess-1', opening: 'one' };

    assert.equal((await send({ ...far, pad: 8000 })).status, 200);
    assert.deepEqual(hits.map(h => h.account).slice(2), ['a']);
    assert.equal((await send({ ...near, pad: 8000 })).status, 400);
    assert.equal(hits.length, 3);
    // Its compaction request keeps its pin.
    assert.equal((await send({ ...near, pad: 8200 })).status, 200);
    assert.deepEqual(hits.map(h => h.account).slice(3), ['b']);
  });
});

/**
 * Send a conversation's first request and answer the pin key it was filed
 * under, so the caller can hold it in flight.
 * @param {any} am @param {Function} send @param {{ session: string, opening: string }} r
 */
async function placed(am, send, r) {
  await send(r);
  const pin = am.sessionTracker.livePins().find((/** @type {any} */ p) => p.sessionId.startsWith(r.session));
  assert.ok(pin, 'setup: the conversation was pinned');
  return pin.sessionId;
}

test('one record per fleet: a second listener sharing the account manager sees what the first asked', async () => {
  await withFleet({ config: ON, listeners: 2 }, async ({ hits, send }) => {
    await send({ listener: 0 });
    assert.equal((await send({ pad: 8000, listener: 0 })).status, 400);
    // The compaction request arrives through the other listener.
    assert.equal((await send({ pad: 8200, listener: 1 })).status, 200);
    assert.deepEqual(hits.map(h => h.account), ['a', 'a']);
  });
});

test('an error inside the decision forwards the request', async () => {
  const original = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    await withFleet({ config: ON }, async ({ am, hits, send }) => {
      await send();
      am.conversationHost = () => { throw new Error('boom'); };
      assert.equal((await send({ pad: 8000 })).status, 200);
      assert.equal(hits.length, 2);
    });
  } finally {
    console.error = original;
  }
  assert.ok(errors.some(e => e.includes('compactBeforeSwitch') && e.includes('forwarding the request')), errors.join('\n'));
});

test('unset: the request path does not consult the account manager for it at all', async () => {
  await withFleet({ config: {} }, async ({ am, hits, send }) => {
    let calls = 0;
    const host = am.conversationHost.bind(am);
    am.conversationHost = (/** @type {any[]} */ ...args) => { calls++; return host(...args); };
    const windows = am.switchWindows.bind(am);
    am.switchWindows = (/** @type {any[]} */ ...args) => { calls++; return windows(...args); };
    await send();
    await send({ pad: 8000 });
    assert.equal(hits.length, 2);
    assert.equal(calls, 0);
  });
});
