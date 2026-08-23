import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Who a usage report is charged to. The recording call takes the account that
// served, the session that asked and the model that ran, and each of those can
// be wrong independently: the right numbers on the wrong account, the wrong
// family's weekly bucket, or a total attributed to nobody.
//
// The buffered path is covered here too. It reports once, so it cannot show
// the double count the streaming merge exists to prevent, but it is the same
// seam and nothing drove it end to end before.
//
// Magnitudes are of the order a real turn reports: it reads a large cached
// prefix and sends almost no fresh input, which is why counting `input_tokens`
// alone measured close to nothing. Over 873012 `usage` objects carrying an input
// side in local Claude Code transcripts, the medians are `input_tokens` 2 and
// `cache_read_input_tokens` 199824, and the two cache fields carry 99.95% of all
// input-side tokens.
//
// The same corpus is the reason only the flat `cache_creation_input_tokens`
// appears here: the wire also carries a nested `cache_creation` breaking the
// same quantity down by cache TTL, and over 873391 objects carrying both, the
// nested figures sum to the flat one on all but 51 (those being degenerate rows,
// a flat 0 against a nested sum or the reverse). They are the same tokens
// counted once, not two quantities to add.
//
// Both counts come from `~/.claude/projects` on one machine, so the magnitudes
// are reproducible in shape and the absolute counts are not.
const USAGE = {
  input_tokens: 2,
  cache_read_input_tokens: 377127,
  cache_creation_input_tokens: 1092,
  output_tokens: 714,
};
const CONTEXT = USAGE.cache_read_input_tokens + USAGE.cache_creation_input_tokens + USAGE.input_tokens;

const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const acct = (name) => ({ name, type: 'apikey', apiKey: `k-${name}` });

// A buffered upstream: one JSON body carrying the whole usage object.
function buffered() {
  return http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [], usage: USAGE }));
  });
}

// A streaming upstream, split the way upstream's documented event sequence
// splits it: the input side at `message_start` with a placeholder output, and
// figures cumulative for the message at `message_delta`.
function streaming() {
  return http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { ...USAGE, output_tokens: 1 } } })}\n\n`);
    await new Promise(r => setTimeout(r, 3));
    res.write(`data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: USAGE.output_tokens } })}\n\n`);
    res.end();
  });
}

async function send(port, { sessionId, model, stream }) {
  return new Promise((resolve, reject) => {
    const rq = http.request({
      host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': sessionId },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
    rq.on('error', reject);
    rq.end(JSON.stringify({ model, stream: !!stream, messages: [] }));
  });
}

async function withProxy(upstream, accounts, fn, amOpts = {}) {
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts.map(acct), 0.98, amOpts);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    return await fn(port, am);
  } finally {
    proxy.close();
    upstream.close();
  }
}

const tokensOf = (am, sid, bucket) => am.sessionTracker.sessions.get(sid)?.tokens?.get(bucket);

for (const [label, make, stream] of [['buffered', buffered, false], ['streaming', streaming, true]]) {
  test(`a ${label} response is attributed to the session that asked`, async () => {
    await withProxy(make(), ['a'], async (port, am) => {
      assert.equal(await send(port, { sessionId: 'sess-1', model: OPUS, stream }), 200);
      await new Promise(r => setTimeout(r, 60));
      const t = tokensOf(am, 'sess-1', 'unified7d');
      assert.ok(t, 'nothing was recorded for the session, so this proves nothing');
      assert.equal(t.cacheRead, USAGE.cache_read_input_tokens);
      assert.equal(t.cacheCreation, USAGE.cache_creation_input_tokens);
      assert.equal(t.input, USAGE.input_tokens);
      assert.equal(t.output, USAGE.output_tokens);
      assert.equal(t.context, CONTEXT);
      assert.equal(t.reports, 1, 'one upstream message is one report on either path');
    });
  });

  test(`a ${label} response lands in the weekly bucket of the model that ran`, async () => {
    await withProxy(make(), ['a'], async (port, am) => {
      assert.equal(await send(port, { sessionId: 'sess-f', model: FABLE, stream }), 200);
      await new Promise(r => setTimeout(r, 60));
      const fable = tokensOf(am, 'sess-f', 'unified7dFable');
      assert.ok(fable, 'the Fable turn was not recorded against the Fable bucket');
      assert.equal(fable.cacheRead, USAGE.cache_read_input_tokens);
      assert.equal(tokensOf(am, 'sess-f', 'unified7d'), undefined,
        "a Fable turn was charged to Opus's weekly bucket, which cannot be undone later");
      assert.equal(am.accounts[0].usage.byBucket.unified7dFable.cacheReadTokens,
        USAGE.cache_read_input_tokens, "the account's own split has the same family wrong");
    });
  });
}

// The account a report is charged to is the account that SERVED, which is only
// distinguishable from "whichever account is current now" once the two differ.
// A request is held open upstream; a second request meanwhile exhausts the
// account they are both on and switches the fleet to another one. The held
// request's usage still belongs to the account that did the work, which is no
// longer the current account by the time it lands.
//
// `updateUsage` is the positive control: it takes the same account index and is
// not part of this change, so its per-account output totals say which account
// really served which request, independently of the field under test.
//
// Both paths are held, because they record at different moments: the buffered
// one as soon as the body is parsed, the streaming one in the exit path after
// the last event.
for (const heldStreams of [false, true]) {
  test(`a ${heldStreams ? 'streaming' : 'buffered'} report is charged to the account that served, not the current one`, async () => {
    let release;
    let rejections = 0;
    const held = new Promise(r => { release = r; });
    const upstream = http.createServer(async (req, res) => {
      const sid = req.headers['x-claude-code-session-id'];
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* not JSON */ }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { ...USAGE, output_tokens: 1 } } })}\n\n`);
        if (sid === 'sess-held') await held;
        res.write(`data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: USAGE.output_tokens } })}\n\n`);
        res.end();
        return;
      }
      if (sid === 'sess-held') await held;
      // Reject the second request once, on whichever account is current. That
      // spends the account the held request is also on and moves the fleet off
      // it, which is the only thing that makes the two indices disagree.
      if (sid === 'sess-free' && rejections++ === 0) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '1',
          'anthropic-ratelimit-unified-7d-status': 'rejected',
        });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', content: [], usage: USAGE }));
    });

    await withProxy(upstream, ['a', 'b'], async (port, am) => {
      const first = send(port, { sessionId: 'sess-held', model: OPUS, stream: heldStreams });
      // Let the held request take an account before the second one arrives.
      await new Promise(r => setTimeout(r, 80));
      const served = am.currentIndex;
      assert.equal(await send(port, { sessionId: 'sess-free', model: OPUS, stream: false }), 200);
      assert.notEqual(am.currentIndex, served,
        'the fleet never switched accounts, so the two indices still agree and this proves nothing');
      release();
      assert.equal(await first, 200);
      await new Promise(r => setTimeout(r, 60));

      const out = am.accounts.map(a => a.usage.totalOutputTokens);
      assert.deepEqual(out, [USAGE.output_tokens, USAGE.output_tokens],
        `the two requests were not served by different accounts (${out}), so this proves nothing`);
      const read = am.accounts.map(a => a.usage.totalCacheReadTokens);
      assert.deepEqual(read, [USAGE.cache_read_input_tokens, USAGE.cache_read_input_tokens],
        'a report was charged to the account that happened to be current when it landed');
    });
  });
}

// A usage report for a session the tracker does not have must not create one:
// the id is a client-supplied header and records are capped.
test('a response for an untracked session records nothing for it', async () => {
  await withProxy(buffered(), ['a'], async (port, am) => {
    assert.equal(await send(port, { sessionId: 'sess-real', model: OPUS, stream: false }), 200);
    await new Promise(r => setTimeout(r, 60));
    assert.ok(tokensOf(am, 'sess-real', 'unified7d'), 'the real session was not recorded');
    assert.equal(am.sessionTracker.sessions.get('sess-never-seen'), undefined);
    assert.equal(am.accounts[0].usage.totalCacheReadTokens, USAGE.cache_read_input_tokens,
      "the account total is charged once regardless of the session's fate");
  });
});
