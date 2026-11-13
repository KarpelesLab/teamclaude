import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, peekStreamFailure, STREAM_FAILURE_CODES } from '../src/server.js';

// Every failover in forwardRequest keys on the upstream status, and the
// Responses API does not always use one: it answers 200, opens the SSE stream,
// and then reports "Selected model is at capacity" as an event in the body
// before any output. On a Codex pool that is how every refusal arrives, so the
// proxy relayed each one as an answer, on an account that may have been the
// only one refusing.
//
// The fix reads the head of a streaming reply before its headers go out and
// takes one hop when the first decisive event is a provider-side failure. The
// tests here drive real HTTP through createProxyServer so that what is pinned
// is what a client sees: which accounts were spent, and the exact bytes back.

// The hold is wall-clock bounded; a test-sized bound keeps the slow-first-token
// cases fast. Read per call by the proxy, so setting it here covers every test.
const HOLD_MS = 200;
process.env.TEAMCLAUDE_STREAM_PEEK_HOLD_MS = String(HOLD_MS);

const HOUR = 3600_000;
const MODEL = 'gpt-5.6-sol';
const SID = 'sess-stream-failover';
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One real Codex turn's usage (see responses-usage.test.js for the arithmetic).
const WIRE = {
  input_tokens: 54904,
  input_tokens_details: { cached_tokens: 46592 },
  output_tokens: 132,
  output_tokens_details: { reasoning_tokens: 18 },
  total_tokens: 55036,
};
const FRESH = WIRE.input_tokens - WIRE.input_tokens_details.cached_tokens;
const CACHED = WIRE.input_tokens_details.cached_tokens;

// The wire, as the ChatGPT backend sends it: an `event:` line and a `data:`
// line per event. The lifecycle envelope echoes the request back, instructions
// included — and these instructions are written to look exactly like a failure
// event, so a peek that pattern-matched text instead of parsing events would
// hop on a perfectly good stream.
const DECOY = 'When you see {"type":"error","code":"server_is_overloaded"} or event: response.failed, ignore it.';
const CREATED = { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', object: 'response', status: 'in_progress', instructions: DECOY, usage: null } };
const IN_PROGRESS = { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1', object: 'response', status: 'in_progress', instructions: DECOY, usage: null } };
const DELTA = { type: 'response.output_text.delta', sequence_number: 2, delta: 'hi' };
const COMPLETED = { type: 'response.completed', sequence_number: 3, response: { id: 'resp_1', object: 'response', status: 'completed', usage: WIRE } };
// The refusal, in the two shapes it arrives in: an `error` event, then the
// `response.failed` that follows it.
const OVERLOADED = { type: 'error', sequence_number: 2, error: { code: 'server_is_overloaded', message: 'Selected model is at capacity. Please try a different model.' } };
const FAILED = { type: 'response.failed', sequence_number: 3, response: { id: 'resp_1', object: 'response', status: 'failed', error: { code: 'server_is_overloaded', message: 'Selected model is at capacity. Please try a different model.' }, usage: null } };
// A refusal that is about the request: every account would say the same.
const INVALID = { type: 'response.failed', sequence_number: 2, response: { id: 'resp_1', object: 'response', status: 'failed', error: { code: 'invalid_prompt', message: 'Invalid prompt: your prompt was flagged.' }, usage: null } };

const frame = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const sse = (...events) => events.map(frame).join('');

function sseHead(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
}

const codexAccount = (name, port) => ({
  name: `codex:${name}`, type: 'oauth', provider: 'codex', accountId: `acct-${name}`,
  accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR,
  upstream: `http://127.0.0.1:${port}`,
});
const claudeAccount = (name, port) => ({
  name: `claude:${name}`, type: 'oauth', accountId: `acct-${name}`,
  accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR,
  upstream: `http://127.0.0.1:${port}`,
});

// A fleet of `names` accounts in front of one upstream. `handler(acct, res, seen)`
// answers each upstream request; `seen` is the order accounts were spent in,
// by the ChatGPT-Account-Id (Codex) or bearer token (Anthropic) the proxy sent.
async function withFleet(names, handler, fn, { provider = 'codex' } = {}) {
  /** @type {string[]} */
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const acct = provider === 'codex'
      ? String(req.headers['chatgpt-account-id'])
      : String(req.headers.authorization || '').replace(/^Bearer t-/, '');
    seen.push(acct.replace(/^acct-/, ''));
    handler(acct.replace(/^acct-/, ''), res, seen);
  });
  const upstreamPort = await listen(upstream);
  const make = provider === 'codex' ? codexAccount : claudeAccount;
  const am = new AccountManager(names.map(n => make(n, upstreamPort)), 0.98);
  const proxy = createProxyServer(am, { proxy: {} });
  const proxyPort = await listen(proxy);
  try { await fn({ am, proxyPort, seen }); } finally { proxy.close(); upstream.close(); }
}

async function codexPost(port) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/backend-api/codex/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'session-id': SID },
    body: JSON.stringify({ model: MODEL, input: [], stream: true }),
  });
  const headersAfterMs = Date.now() - t0;
  const body = await res.text();
  // The streaming usage record lands in streamResponse's finally, a tick after
  // the client's last byte.
  await sleep(60);
  return { status: res.status, body, headersAfterMs };
}

const byName = (am, name) => am.accounts.find(a => a.name.endsWith(`:${name}`));

// ---------------------------------------------------------------- the hop

// (a) The case this exists for. The account first spent refuses inside its
// 200; the sibling answers; the client reads the sibling's stream and never
// sees the refusal.
test('a refusal reported inside a 200 stream hops once to a sibling', async () => {
  await withFleet(['one', 'two', 'three'], (acct, res, seen) => {
    sseHead(res);
    // Whichever account went first is the one that refuses.
    if (acct === seen[0]) return res.end(sse(CREATED, OVERLOADED, FAILED));
    res.end(sse(CREATED, IN_PROGRESS, DELTA, COMPLETED));
  }, async ({ proxyPort, seen }) => {
    const { status, body } = await codexPost(proxyPort);
    assert.equal(status, 200);
    assert.equal(seen.length, 2, 'one hop: the refusing account and one sibling');
    assert.notEqual(seen[0], seen[1], 'the hop went to a sibling, not back to the same account');
    assert.equal(body, sse(CREATED, IN_PROGRESS, DELTA, COMPLETED), "the client reads exactly the sibling's stream");
    assert.doesNotMatch(body, /server_is_overloaded"\}/, 'the refusal never reached the client');
  });
});

// (b) One hop, not a walk of the fleet: a second account refusing the same way
// is the provider talking, and every further attempt would only spend another
// account's cache to learn it. The last stream is relayed as upstream sent it.
test('a refusal every account shares is relayed after exactly one hop', async () => {
  await withFleet(['one', 'two', 'three'], (acct, res) => {
    sseHead(res);
    res.end(sse(CREATED, OVERLOADED, FAILED));
  }, async ({ proxyPort, seen }) => {
    const { status, body } = await codexPost(proxyPort);
    assert.equal(status, 200, 'upstream answered 200, and that is what the client gets');
    assert.equal(seen.length, 2, 'two attempts, not one per account');
    assert.equal(body, sse(CREATED, OVERLOADED, FAILED), "the second refusal is relayed byte for byte, not hidden");
  });
});

// (c) Order decides, not presence. A failure that follows a delta is a stream
// that broke after committing, and committed output has no retry behind it.
test('a failure after output is relayed untouched, on one account', async () => {
  await withFleet(['one', 'two'], (acct, res) => {
    sseHead(res);
    res.end(sse(CREATED, DELTA, FAILED));
  }, async ({ proxyPort, seen }) => {
    const { body } = await codexPost(proxyPort);
    assert.equal(seen.length, 1, 'no sibling was spent on a committed stream');
    assert.equal(body, sse(CREATED, DELTA, FAILED));
  });
});

// (d) A refusal about the request is refused identically everywhere, so a hop
// would only pay for a second copy of the same answer.
test('a request-fault failure is relayed without a hop', async () => {
  await withFleet(['one', 'two'], (acct, res) => {
    sseHead(res);
    res.end(sse(CREATED, INVALID));
  }, async ({ proxyPort, seen }) => {
    const { body } = await codexPost(proxyPort);
    assert.equal(seen.length, 1);
    assert.equal(body, sse(CREATED, INVALID));
    assert.equal(STREAM_FAILURE_CODES.has('invalid_prompt'), false);
  });
});

// The decoy instructions in every envelope above spell a failure event out in
// full. A peek that matched text would hop here; one that parses events does
// not, because the decoy is a string inside a `response.created`.
test('failure-shaped text inside the echoed instructions does not trigger a hop', async () => {
  await withFleet(['one', 'two'], (acct, res) => {
    sseHead(res);
    res.end(sse(CREATED, IN_PROGRESS, DELTA, COMPLETED));
  }, async ({ proxyPort, seen }) => {
    const { body } = await codexPost(proxyPort);
    assert.equal(seen.length, 1);
    assert.match(body, /server_is_overloaded/, 'the decoy is still in the body the client reads');
    assert.equal(body, sse(CREATED, IN_PROGRESS, DELTA, COMPLETED));
  });
});

// ---------------------------------------------------------------- the bounds

// (e) A slow first token is not a failure. The hold expires, the headers go
// out, and the bytes the peek held are replayed ahead of the rest of the same
// stream, so the body is unbroken and no sibling is spent.
test('a slow first token releases the stream at the hold and the body is unbroken', async () => {
  await withFleet(['one', 'two'], async (acct, res) => {
    sseHead(res);
    res.write(sse(CREATED, IN_PROGRESS));
    await sleep(HOLD_MS * 3);
    res.end(sse(DELTA, COMPLETED));
  }, async ({ proxyPort, seen }) => {
    const { status, body, headersAfterMs } = await codexPost(proxyPort);
    assert.equal(status, 200);
    assert.equal(seen.length, 1, 'a stream that is merely slow spent no sibling');
    assert.equal(body, sse(CREATED, IN_PROGRESS, DELTA, COMPLETED), 'the held bytes were replayed ahead of the rest');
    assert.ok(headersAfterMs < HOLD_MS * 3, `headers were held for ${headersAfterMs}ms, past the ${HOLD_MS}ms hold`);
  });
});

// (f) When the wall clock wins the race against a read, that read is still
// pending on the reader and the chunk it resolves with is real. Dropping it
// would lose the first bytes after the hold — the ones that arrive exactly
// then, on a slow first token. The replay must consume it first.
test('a chunk that lands just after the deadline still appears in the replayed body', async () => {
  /** @type {ReadableStreamDefaultController<Uint8Array>} */
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  controller.enqueue(Buffer.from(frame(CREATED)));
  const peeked = await peekStreamFailure(stream, { holdMs: 50 });
  assert.equal(peeked.failureCode, null, 'an undecided stream is released, not judged');
  // The peek returned on the clock, so a read is outstanding on the reader.
  // The next chunk settles THAT read, not a fresh one.
  controller.enqueue(Buffer.from(frame(DELTA)));
  controller.enqueue(Buffer.from(frame(COMPLETED)));
  controller.close();
  // Not Array.fromAsync: the suite runs on node 20, which lacks it.
  const chunks = [];
  for await (const chunk of peeked.body) chunks.push(chunk);
  const out = Buffer.concat(chunks).toString();
  assert.equal(out, sse(CREATED, DELTA, COMPLETED), 'the chunk the abandoned read resolved with was dropped');
});

// The same thing through the proxy: the first chunk after the hold reaches
// the client, in order, and the stream is still relayed on one account.
test('bytes arriving right after the hold reach the client in order', async () => {
  await withFleet(['one', 'two'], async (acct, res) => {
    sseHead(res);
    res.write(sse(CREATED));
    await sleep(HOLD_MS + 20);
    res.write(sse(DELTA));
    await sleep(20);
    res.end(sse(COMPLETED));
  }, async ({ proxyPort, seen }) => {
    const { body } = await codexPost(proxyPort);
    assert.equal(seen.length, 1);
    assert.equal(body, sse(CREATED, DELTA, COMPLETED));
  });
});

// The byte budget is the other bound: an envelope bigger than it is released
// as-is, whatever follows. A refusal that arrives after the budget is then a
// relayed stream, which is the cost of not holding an unbounded head.
test('a stream past the byte budget is released untouched', async () => {
  process.env.TEAMCLAUDE_STREAM_PEEK_BUDGET_BYTES = '64';
  try {
    await withFleet(['one', 'two'], async (acct, res) => {
      sseHead(res);
      res.write(sse(CREATED));   // well over 64 bytes on its own
      await sleep(30);
      res.end(sse(OVERLOADED, FAILED));
    }, async ({ proxyPort, seen }) => {
      const { body } = await codexPost(proxyPort);
      assert.equal(seen.length, 1, 'past the budget the peek judges nothing');
      assert.equal(body, sse(CREATED, OVERLOADED, FAILED));
    });
  } finally {
    delete process.env.TEAMCLAUDE_STREAM_PEEK_BUDGET_BYTES;
  }
});

// ---------------------------------------------------------------- accounting

// (g) The relay reads the replayed stream, and the usage parser rides the relay
// (#433). A turn that went through a released peek must still book its tokens
// on the account that served it.
test('a Responses stream still books its usage through the replay', async () => {
  await withFleet(['one', 'two'], (acct, res) => {
    sseHead(res);
    res.end(sse(CREATED, IN_PROGRESS, DELTA, COMPLETED));
  }, async ({ am, proxyPort, seen }) => {
    await codexPost(proxyPort);
    assert.equal(seen.length, 1);
    const u = byName(am, seen[0]).usage;
    assert.equal(u.totalInputTokens, FRESH, 'the uncached input side was not booked');
    assert.equal(u.totalOutputTokens, WIRE.output_tokens);
    assert.equal(u.totalCacheReadTokens, CACHED, 'the cached prefix was not booked as a cache read');
    assert.equal(am.sessionTracker.sessions.get(SID)?.tokens?.get('unified7d')?.reports, 1, 'one turn is one observation');
  });
});

// After a hop, the turn belongs to the sibling that served it, and the account
// that refused booked nothing: its stream carried no usage and was never relayed.
test('after a hop the usage lands on the sibling that served the turn', async () => {
  await withFleet(['one', 'two'], (acct, res, seen) => {
    sseHead(res);
    if (acct === seen[0]) return res.end(sse(CREATED, OVERLOADED, FAILED));
    res.end(sse(CREATED, DELTA, COMPLETED));
  }, async ({ am, proxyPort, seen }) => {
    await codexPost(proxyPort);
    assert.equal(seen.length, 2);
    const refused = byName(am, seen[0]).usage;
    const served = byName(am, seen[1]).usage;
    assert.equal(refused.totalInputTokens, 0, 'the refusing account booked a turn it never served');
    assert.equal(served.totalInputTokens, FRESH);
    assert.equal(served.totalOutputTokens, WIRE.output_tokens);
    assert.equal(served.totalCacheReadTokens, CACHED);
  });
});

// ---------------------------------------------------------------- Anthropic

// (h) An Anthropic stream opens with `message_start`, which is decisive on the
// first chunk: released at once, relayed byte for byte, no sibling spent.
const MESSAGE_START = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-x', usage: { input_tokens: 5, output_tokens: 1 } } };
const TEXT_DELTA = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } };
const MESSAGE_STOP = { type: 'message_stop' };

test('an Anthropic stream starting with message_start is relayed with no added hop', async () => {
  await withFleet(['one', 'two'], (acct, res) => {
    sseHead(res);
    res.end(sse(MESSAGE_START, TEXT_DELTA, MESSAGE_STOP));
  }, async ({ proxyPort, seen }) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [], stream: true }),
    });
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(body, sse(MESSAGE_START, TEXT_DELTA, MESSAGE_STOP));
  }, { provider: 'anthropic' });
});

// Anthropic can report a 529 inside a stream that already opened, as an `error`
// event whose `error.type` is `overloaded_error`. Same hop.
test('an Anthropic overloaded_error as the first event hops once', async () => {
  const OVERLOADED_ERROR = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
  await withFleet(['one', 'two'], (acct, res, seen) => {
    sseHead(res);
    if (acct === seen[0]) return res.end(sse(OVERLOADED_ERROR));
    res.end(sse(MESSAGE_START, TEXT_DELTA, MESSAGE_STOP));
  }, async ({ proxyPort, seen }) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-x', messages: [], stream: true }),
    });
    const body = await res.text();
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0], seen[1]);
    assert.equal(body, sse(MESSAGE_START, TEXT_DELTA, MESSAGE_STOP));
  }, { provider: 'anthropic' });
});

// ---------------------------------------------------------------- headerless

// The ChatGPT backend can answer a Codex stream with no Content-Type at all
// (#456); the relay reads such a reply as a stream because the request asked
// for one. The peek keys on the same reading, so an in-band refusal on a
// headerless stream still hops rather than slipping past as a buffered body.
test('a headerless Codex stream is peeked on the same rule the relay uses', async () => {
  await withFleet(['one', 'two'], (acct, res, seen) => {
    res.writeHead(200);   // no content-type
    if (acct === seen[0]) return res.end(sse(CREATED, OVERLOADED, FAILED));
    res.end(sse(CREATED, DELTA, COMPLETED));
  }, async ({ proxyPort, seen }) => {
    const { status, body } = await codexPost(proxyPort);
    assert.equal(status, 200);
    assert.equal(seen.length, 2, 'the refusal inside a headerless stream was not seen');
    assert.equal(body, sse(CREATED, DELTA, COMPLETED));
  });
});

// A pinned request is never moved (docs/routing.md, "Pin a session to one
// account"): the refusal reaches the client as the pinned account sent it, as
// for the 5xx and 429 hops (bounded-failover.test.js).
test('a refusal inside a 200 stream on a pinned request stays on the pinned account', async () => {
  await withFleet(['one', 'two'], (acct, res) => {
    sseHead(res);
    if (acct === 'one') return res.end(sse(CREATED, OVERLOADED, FAILED));
    res.end(sse(CREATED, IN_PROGRESS, DELTA, COMPLETED));
  }, async ({ proxyPort, seen }) => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/tc-acct/${encodeURIComponent('codex:one')}/backend-api/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'session-id': SID },
      body: JSON.stringify({ model: MODEL, input: [], stream: true }),
    });
    const body = await res.text();
    assert.deepEqual(seen, ['one'], 'only the pinned account is spent');
    // The whole stream, not a match on the code: CREATED's instructions carry
    // the same string as a decoy, so a match would pass with the refusal gone.
    assert.equal(body, sse(CREATED, OVERLOADED, FAILED), 'the pinned account\'s refusal is relayed intact');
  });
});

// A stream that reports its own failure is relayed whole but completed
// nothing, so it is no proof the organization allows OAuth again: the
// entitlement cooldown stays. Both cases are pinned, so the peek is skipped
// whatever the fleet size; the fleet of one is the case master already
// relayed without a hop. The completed stream is the control that the
// cooldown can still be lifted.
for (const [names, answer, kept] of [
  [['one', 'two'], 'refused', true],
  [['one'], 'refused', true],
  [['one', 'two'], 'completed', false],
]) {
  test(`a pinned stream that ${answer} ${kept ? 'keeps' : 'lifts'} the entitlement cooldown (fleet of ${names.length})`, async () => {
    const OVERLOADED_ERROR = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    await withFleet(names, (acct, res) => {
      sseHead(res);
      if (acct === 'one' && answer === 'refused') return res.end(sse(OVERLOADED_ERROR));
      res.end(sse(MESSAGE_START, TEXT_DELTA, MESSAGE_STOP));
    }, async ({ am, proxyPort, seen }) => {
      am.markEntitlementDenied(0, { seconds: 600 });
      const res = await fetch(`http://127.0.0.1:${proxyPort}/tc-acct/${encodeURIComponent('claude:one')}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-x', messages: [], stream: true }),
      });
      assert.equal(res.status, 200);
      await res.text();
      await sleep(60);
      assert.deepEqual(seen, ['one'], 'only the pinned account is spent');
      if (kept) assert.ok(am.accounts[0].entitlementDeniedUntil > Date.now(), 'a refused stream left the cooldown in place');
      else assert.equal(am.accounts[0].entitlementDeniedUntil, null, 'a completed stream lifted the cooldown');
    }, { provider: 'anthropic' });
  });
}

// The rule the relay applies, shape by shape: any failure the stream reports
// (not only the codes worth a hop), wherever it arrives, in either dialect,
// with or without a code - and for the model denial as for the entitlement
// one. Each runs pinned, so the stream reaches the relay as sent.
async function pinnedStream(provider, events, prep, check) {
  await withFleet(['one', 'two'], (acct, res) => {
    sseHead(res);
    res.end(sse(...events));
  }, async ({ am, proxyPort }) => {
    prep(am);
    const codex = provider === 'codex';
    const path = codex ? '/backend-api/codex/responses' : '/v1/messages';
    const res = await fetch(`http://127.0.0.1:${proxyPort}/tc-acct/${encodeURIComponent(`${codex ? 'codex' : 'claude'}:one`)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [codex ? 'session-id' : 'x-claude-code-session-id']: SID },
      body: JSON.stringify(codex ? { model: MODEL, input: [], stream: true } : { model: 'claude-x', messages: [], stream: true }),
    });
    assert.equal(res.status, 200);
    await res.text();
    await sleep(60);
    check(am);
  }, { provider: provider === 'codex' ? 'codex' : 'anthropic' });
}
const liveCooldown = (am) => am.markEntitlementDenied(0, { seconds: 600 });
const cooldownKept = (am) => assert.ok(am.accounts[0].entitlementDeniedUntil > Date.now(), 'a refused stream left the cooldown in place');
// A model denial whose cooldown has run out keeps its record - and with it the
// next cooldown's length - until a completion forgets it.
const expiredModelDenial = (am) => { am.markModelDenied(0, MODEL); am.accounts[0].modelDenials.get(MODEL).until = Date.now() - 1; };
const ANTHROPIC_INVALID = { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } };
const BARE_ERROR = { type: 'error' };

for (const [what, provider, events] of [
  ['a refusal after output', 'anthropic', [MESSAGE_START, TEXT_DELTA, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]],
  ['a request-fault error, not worth a hop', 'anthropic', [ANTHROPIC_INVALID]],
  ['a code-less error event', 'anthropic', [BARE_ERROR]],
  ['a Responses response.failed with no error event', 'codex', [CREATED, INVALID]],
]) {
  test(`${what} keeps the entitlement cooldown`, () => pinnedStream(provider, events, liveCooldown, cooldownKept));
}

test('a refused stream keeps an expired model denial\'s record', () =>
  pinnedStream('codex', [CREATED, INVALID], expiredModelDenial, (am) => assert.ok(am.modelDenial(am.accounts[0], MODEL), 'the model denial was forgotten')));

test('a completed stream forgets an expired model denial (control)', () =>
  pinnedStream('codex', [CREATED, DELTA, COMPLETED], expiredModelDenial, (am) => assert.equal(am.modelDenial(am.accounts[0], MODEL), null)));

// Unpinned, with no sibling to hop to: the refused stream reaches the relay
// too. A live cooldown keeps such a request off the account, but one that has
// run out keeps its escalation count, so the next denial is not the shortest.
// Both kinds of refusal: an overload is also not delivered (below), so only
// the request fault depends on the failure check alone.
for (const [what, refusal] of [
  ['an overload', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
  ['a request fault', ANTHROPIC_INVALID],
]) {
  test(`an unpinned stream refused with ${what} keeps an expired cooldown's escalation count`, async () => {
    await withFleet(['one'], (acct, res) => {
      sseHead(res);
      res.end(sse(refusal));
    }, async ({ am, proxyPort, seen }) => {
      am.markEntitlementDenied(0, { seconds: 600 });
      am.accounts[0].entitlementDeniedUntil = Date.now() - 1;
      const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-x', messages: [], stream: true }),
      });
      await res.text();
      await sleep(60);
      assert.deepEqual(seen, ['one']);
      assert.equal(am.accounts[0].entitlementDenial?.count, 1, 'the refused stream reset the escalation count');
    }, { provider: 'anthropic' });
  });
}

// The session tracker's verdict: a provider-side failure inside a 200 is the
// 5xx or 429 it would have been as a status - nothing came back - while a
// request fault is an answer, as a 4xx is. Both dialects: Anthropic reports
// `overloaded_error`, `api_error` and `rate_limit_error` in-band too.
const anthropicError = (type) => ({ type: 'error', error: { type, message: type } });
for (const [what, provider, events, usable] of [
  ['an in-band overload', 'codex', [CREATED, OVERLOADED, FAILED], false],
  ['an in-band request fault', 'codex', [CREATED, INVALID], true],
  ['a completed stream', 'codex', [CREATED, DELTA, COMPLETED], true],
  ['an Anthropic in-band overload', 'anthropic', [MESSAGE_START, anthropicError('overloaded_error')], false],
  ['an Anthropic in-band api_error', 'anthropic', [MESSAGE_START, anthropicError('api_error')], false],
  ['an Anthropic in-band rate_limit_error', 'anthropic', [MESSAGE_START, anthropicError('rate_limit_error')], false],
  ['an Anthropic in-band request fault', 'anthropic', [MESSAGE_START, anthropicError('invalid_request_error')], true],
]) {
  test(`a pinned stream with ${what} ends its session as ${usable ? 'usable' : 'nothing back'}`, () => {
    const outcomes = [];
    return pinnedStream(provider, events, (am) => {
      const end = am.endSession.bind(am);
      am.endSession = (key, ok) => { outcomes.push(ok); return end(key, ok); };
    }, () => assert.deepEqual(outcomes, [usable]));
  });
}
