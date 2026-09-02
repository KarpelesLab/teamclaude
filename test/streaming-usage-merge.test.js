import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// A streaming turn reports its usage twice, and the second report is
// CUMULATIVE for the whole message rather than an increment on the first. So
// the two reports cannot both be added: `message_start` carries the input side
// with a placeholder output figure, and `message_delta` supersedes every field
// it carries.
//
// These drive the real proxy rather than the tracker, because the defect this
// pins lives at the call site, not in the tracker: handing the whole object
// over at both events double counts whatever appears in both, and no
// tracker-level fixture can reach that. Each case asserts the record was
// written at all before asserting its contents, so a stream that never reached
// the accounting path fails loudly instead of reading as zero.

const SID = 'sess-merge';
const BUCKET = 'unified7d';
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// The input side is settled at `message_start`; `output_tokens` there is a
// placeholder (upstream's own examples show 1, 2 and 3), not a real count.
const START = {
  input_tokens: 12,
  cache_read_input_tokens: 4000,
  cache_creation_input_tokens: 300,
  output_tokens: 2,
};
// Truth for one such turn, whatever shape the delta takes.
const TRUTH = { cacheRead: 4000, cacheCreation: 300, input: 12, output: 500, context: 4312 };

// Drives one streaming turn through the proxy and returns the session's
// recorded totals. `events` chooses which reports the upstream sends.
async function turn(events, { expectRecord = true } = {}) {
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const e of events) {
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      await new Promise(r => setTimeout(r, 2));
    }
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k-a' }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);

  try {
    await new Promise((resolve, reject) => {
      const rq = http.request({
        host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': SID },
      }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
      rq.on('error', reject);
      rq.end(JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [] }));
    });
    // The record is written in streamResponse's finally, which can land a tick
    // after the client's end event.
    await new Promise(r => setTimeout(r, 60));
    const got = am.sessionTracker.sessions.get(SID)?.tokens?.get(BUCKET);
    if (expectRecord) {
      assert.ok(got, 'nothing was recorded for the session, so this proves nothing');
    }
    return { tokens: got, usage: am.accounts[0].usage, tracker: am.sessionTracker };
  } finally {
    proxy.close();
    upstream.close();
  }
}

const start = (usage = START) => ({ type: 'message_start', message: { usage } });
const delta = (usage) => ({ type: 'message_delta', usage });
const stop = { type: 'message_stop' };

test('a delta carrying output alone does not add the message_start placeholder', async () => {
  const { tokens } = await turn([start(), delta({ output_tokens: 500 }), stop]);
  assert.equal(tokens.output, TRUTH.output,
    "message_start's placeholder output was added to the delta's cumulative count");
  assert.equal(tokens.input, TRUTH.input);
  assert.equal(tokens.cacheRead, TRUTH.cacheRead);
  assert.equal(tokens.reports, 1, 'a streaming turn is one message and must record once');
});

test('a delta repeating the input side does not double it', async () => {
  const { tokens } = await turn([
    start(),
    delta({ ...START, output_tokens: 500 }),
    stop,
  ]);
  assert.equal(tokens.cacheRead, TRUTH.cacheRead,
    'the cache read was counted at both events');
  assert.equal(tokens.cacheCreation, TRUTH.cacheCreation);
  assert.equal(tokens.input, TRUTH.input);
  assert.equal(tokens.output, TRUTH.output);
  assert.equal(tokens.context, TRUTH.context);
});

// The delta's figures are cumulative for the message, so on a turn that ran
// more than one inference (a server-tool turn) its input side EXCEEDS what
// message_start reported. Superseding is right under both readings of
// cumulative; adding is wrong under both, and taking message_start's figure
// alone would silently understate exactly these turns.
test('a cumulative delta supersedes rather than adds to message_start', async () => {
  const { tokens } = await turn([
    start(),
    delta({ ...START, input_tokens: 10682, output_tokens: 500 }),
    stop,
  ]);
  assert.equal(tokens.input, 10682,
    'the cumulative input was added to message_start rather than superseding it');
  assert.equal(tokens.cacheRead, TRUTH.cacheRead);
  assert.equal(tokens.context, 10682 + 4000 + 300,
    'context is a level and must reflect the settled figures, not an increment');
  assert.equal(tokens.reports, 1);
});

// A stream can end after message_start without ever sending a delta. The prompt
// was still processed and billed, so the input side it reported must survive;
// there is simply no authoritative output figure to record.
//
// This is the CLEAN end of that shape: the upstream closes the stream properly.
// The dirty end, where the read throws, is the next test, and the two are not
// interchangeable: this one alone is satisfied by recording on the success path.
test('a stream that ends after message_start still records the input it spent', async () => {
  const { tokens } = await turn([start(), stop]);
  assert.equal(tokens.input, TRUTH.input, 'the input side was dropped');
  assert.equal(tokens.cacheRead, TRUTH.cacheRead);
  assert.equal(tokens.cacheCreation, TRUTH.cacheCreation);
  assert.equal(tokens.output, 2,
    'with no delta the only output figure upstream gave is the placeholder');
  assert.equal(tokens.reports, 1);
});

// THE REASON THE RECORD IS WRITTEN FROM `finally` AND NOT FROM THE SUCCESS PATH.
//
// Upstream writes message_start and then destroys the socket. The body reader
// rejects, streamResponse rethrows to its caller's transient handler, and the
// only code that still runs is the `finally`. Those tokens were spent upstream
// whichever way the stream ended, so the input side has to survive the abort.
//
// Written because moving the record out of the `finally` onto the success path
// passed the whole suite: every other streaming case here ends cleanly, so the
// success path covers them all and nothing reached the throwing path. The
// account assertion sits beside the session one because a single call writes
// both scopes, so a record that never happens loses both.
test('a stream aborted mid-flight still records the input it already spent', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: START } })}\n\n`);
    // Die mid-stream: no delta, no stop, no clean end.
    setTimeout(() => { try { res.socket.destroy(); } catch { /* already gone */ } }, 25);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k-a' }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);

  try {
    // The client sees a broken response by design (a clean res.end() would look
    // like a complete answer and suppress its retry), so every one of these
    // settles the wait rather than only 'end'.
    await new Promise((resolve) => {
      const rq = http.request({
        host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': SID },
      }, (res) => { res.on('data', () => {}); res.on('end', resolve); res.on('error', resolve); });
      rq.on('error', resolve);
      rq.end(JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [] }));
    });
    await new Promise(r => setTimeout(r, 150));

    const t = am.sessionTracker.sessions.get(SID)?.tokens?.get(BUCKET);
    assert.ok(t, 'a stream that died after message_start recorded nothing, so the input it spent was lost');
    assert.equal(t.cacheRead, TRUTH.cacheRead);
    assert.equal(t.input, TRUTH.input);
    assert.equal(t.reports, 1, 'the abort was recorded as more than one observation');
    assert.equal(am.accounts[0].usage.totalCacheReadTokens, TRUTH.cacheRead,
      'the account was not charged for a context it really read');
  } finally {
    proxy.close();
    upstream.close();
  }
});

// Plenty of streams carry no usage at all: a ping, text deltas and nothing
// else, or an upstream error after the headers. Writing the merge unguarded
// would record an all-zero report for them, and the `reports` count on that
// record would say one report arrived. That is precisely the distinction
// `reports` exists to preserve, so an empty merge has to be written nowhere
// rather than written as zeroes.
//
// The guard looks like defensive code and reads as deletable; this names what
// it protects so that deleting it is a red test rather than a silent change of
// meaning.
test('a stream that reports no usage records nothing at all', async () => {
  const { tokens, tracker } = await turn([
    { type: 'ping' },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    stop,
  ], { expectRecord: false });
  assert.equal(tokens, undefined,
    'a stream carrying no usage was recorded as a report of zero tokens');
  assert.ok(tracker.sessions.get(SID),
    'the session itself was never tracked, so this would pass for the wrong reason');
});

// The pre-existing account counter reads the same stream and is not part of
// this change. It stays incremental and per-event, so a regression that
// "fixed" it into the merged path would show up here.
test('the account counters are unchanged by the merge', async () => {
  const { usage } = await turn([
    start(),
    delta({ ...START, output_tokens: 500 }),
    stop,
  ]);
  assert.equal(usage.totalInputTokens, 12, 'the legacy input counter moved');
  assert.equal(usage.totalOutputTokens, 500, 'the legacy output counter moved');
});
