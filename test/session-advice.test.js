import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { SessionPins } from '../src/session-pins.js';
import { SessionTracker, SESSION_ACTIVE_TTL_MS } from '../src/session-tracker.js';
import { affinityAccounts } from '../test-helpers/affinity-fixtures.js';

// AccountManager.sessionAccount: which account a client session is on, and the
// conversation a move would cost the most to re-read.

const SESSION = '3f2a1b9c-0000-4000-8000-000000000001';
const OPUS = 'claude-opus-4-1';
const SONNET = 'claude-sonnet-4-6';
const apikey = (/** @type {string} */ name) => ({ name, type: 'apikey', apiKey: `key-${name}` });
const listen = (/** @type {any} */ s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

function fleet() {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const tracker = new SessionTracker({ now });
  const am = new AccountManager([apikey('a'), apikey('b')], 0.98, { sessionTracker: tracker });
  am.sessionPins = new SessionPins({ now });
  return { am, tracker, clock };
}

/** One routed request on conversation `conv` of SESSION, reporting `input` tokens.
 * @param {ReturnType<typeof fleet>} f @param {string} conv @param {string} model @param {number} account @param {number} input */
function request({ am, tracker }, conv, model, account, input) {
  const key = `${SESSION}#${conv}`;
  am.beginSession(key, { sessionId: SESSION, conversation: conv });
  am.recordSession(key, account, model);
  tracker.recordTokens(key, am._weeklyBucketFor(model), { input_tokens: input });
  am.endSession(key);
}

test('recordSession records the routed model on the conversation', () => {
  const f = fleet();
  request(f, 'x', OPUS, 0, 10);
  f.am.recordSession(`${SESSION}#x`, 0, null);
  assert.equal(f.tracker.conversationsOf(SESSION)[0].model, OPUS, 'a request naming no model keeps the last one');
});

test('the cost conversation is the largest context; the shown account follows the newest (AC6b)', () => {
  const f = fleet();
  const big = 120_000;
  request(f, 'x', OPUS, 0, big);
  f.clock.t += 30_000;
  request(f, 'y', OPUS, 1, 800); // /compact re-keys: a small conversation on the same session

  assert.deepEqual(f.am.sessionAccount(SESSION, f.clock.t), {
    shown: { index: 1, name: 'b', via: 'affinity' },
    cost: { model: OPUS, bucket: 'unified7d', context: big },
  }, 'within the window the old conversation still prices the move');

  f.clock.t += SESSION_ACTIVE_TTL_MS;
  request(f, 'y', OPUS, 1, 900);
  assert.deepEqual(f.am.sessionAccount(SESSION, f.clock.t), {
    shown: { index: 1, name: 'b', via: 'affinity' },
    cost: { model: OPUS, bucket: 'unified7d', context: 900 },
  }, 'past the window of the last request the old conversation is no candidate');

  f.clock.t += 10 * SESSION_ACTIVE_TTL_MS;
  assert.equal(f.am.sessionAccount(SESSION, f.clock.t)?.cost?.context, 900,
    'the window is anchored at the last request, not at now');
});

test('a later small subagent neither lowers the cost nor moves the shown bucket', () => {
  const f = fleet();
  request(f, 'main', OPUS, 0, 50_000);
  f.clock.t += 1_000;
  request(f, 'side', SONNET, 1, 50);
  assert.deepEqual(f.am.sessionAccount(SESSION, f.clock.t), {
    shown: { index: 0, name: 'a', via: 'affinity' },
    cost: { model: OPUS, bucket: 'unified7d', context: 50_000 },
  });
});

test('a manual pin overrides the shown account and is only peeked', () => {
  const f = fleet();
  request(f, 'x', OPUS, 0, 700);
  f.am.sessionPins.set(SESSION, 'b', f.clock.t);
  f.clock.t += 5_000;
  assert.deepEqual(f.am.sessionAccount(SESSION, f.clock.t), {
    shown: { index: 1, name: 'b', via: 'manual' },
    cost: { model: OPUS, bucket: 'unified7d', context: 700 },
  });
  assert.equal(f.am.sessionPins.pins.get(SESSION)?.lastUsed, 1_000_000, 'reading it is not use');
});

test('a manual pin with no live conversation answers shown alone; neither answers null', () => {
  const f = fleet();
  assert.equal(f.am.sessionAccount(SESSION, f.clock.t), null);
  f.am.sessionPins.set(SESSION, 'a', f.clock.t);
  assert.deepEqual(f.am.sessionAccount(SESSION, f.clock.t), {
    shown: { index: 0, name: 'a', via: 'manual' },
    cost: null,
  });
});

test('a conversation restored across a restart shows its pin and no context until it reports one', () => {
  const clock = { t: 1_000_000 };
  const make = () => {
    const tracker = new SessionTracker({ now: () => clock.t });
    const am = new AccountManager(affinityAccounts(), 0.98, { sessionTracker: tracker });
    am.sessionPins = new SessionPins({ now: () => clock.t });
    return { am, tracker, clock };
  };
  const before = make();
  request(before, 'x', OPUS, 1, 90_000);
  clock.t += 60_000;
  const after = make();
  after.am.restoreAffinityState(JSON.parse(JSON.stringify(before.am.exportAffinityState())));
  assert.deepEqual(after.am.sessionAccount(SESSION, clock.t), {
    shown: { index: 1, name: 'b', via: 'affinity' },
    cost: { model: null, bucket: 'unified7d', context: null },
  }, 'the saved snapshot carries the pin, not the model or the token figures');
  request(after, 'x', OPUS, 1, 91_000);
  assert.deepEqual(after.am.sessionAccount(SESSION, clock.t)?.cost, { model: OPUS, bucket: 'unified7d', context: 91_000 });
});

test('a restored conversation is placed in the bucket of its newest pin, not the shared one', () => {
  const clock = { t: 1_000_000 };
  const make = () => {
    const tracker = new SessionTracker({ now: () => clock.t });
    const am = new AccountManager(affinityAccounts(), 0.98, { sessionTracker: tracker });
    am.sessionPins = new SessionPins({ now: () => clock.t });
    return { am, tracker, clock };
  };
  const before = make();
  request(before, 'x', SONNET, 2, 90_000);
  clock.t += 60_000;
  const after = make();
  after.am.restoreAffinityState(JSON.parse(JSON.stringify(before.am.exportAffinityState())));
  assert.deepEqual(after.am.sessionAccount(SESSION, clock.t), {
    shown: { index: 2, name: 'c', via: 'affinity' },
    cost: { model: null, bucket: 'unified7dSonnet', context: null },
  });
});

test('through the proxy, without sessionDetail, the main conversation prices the move (AC6)', async () => {
  /** @type {string[]} */
  const served = [];
  const upstream = http.createServer((req, res) => {
    served.push(/** @type {string} */ (req.headers['x-api-key']));
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const input = body.includes('main task') ? 5000 : 50;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg', type: 'message', content: [], usage: { input_tokens: input, output_tokens: 1 } }));
    });
  });
  const am = new AccountManager([apikey('a'), apikey('b')], 0.98, { distributeSessions: true });
  /** @type {any} */
  let proxy = null;
  const log = console.log;
  console.log = () => {};
  try {
    const upstreamPort = await listen(upstream);
    proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
    const port = await listen(proxy);
    for (const content of ['sub task', 'main task']) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-code-session-id': SESSION },
        body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [{ role: 'user', content }] }),
      });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }
    const answer = am.sessionAccount(SESSION);
    assert.equal(answer?.cost?.context, 5000);
    assert.equal(answer?.shown?.via, 'affinity');
    assert.equal(answer?.shown?.name, served[1].replace('key-', ''), 'the account the main conversation went to');
  } finally {
    console.log = log;
    proxy?.close();
    upstream.close();
  }
});
