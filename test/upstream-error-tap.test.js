import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { upstreamErrorFromBody, reportUpstreamError } from '../src/upstream-error-tap.js';

// Two IPM-fork behaviours, one failure: a third-party Anthropic-compatible
// account (Kimi, GLM, OpenCode Zen) answers 400 to a payload a sibling would
// serve, because each backend rejects shapes the others accept. Measured on
// the kimi pool: ten consecutive relayed 400s for one session on one account,
// the request log showing only "(400, 1.8s)" — the reason, which lives in the
// body, never surfaced — while session affinity re-sent every client retry to
// the refusing account.
//
// The tap logs the relayed error's type and message. The hop spends one
// sibling on a custom-upstream account's 400, and the per-attempt
// recordSession re-pins the session on whoever served it.

// ── the detector ─────────────────────────────────────────────────────────────

test('an Anthropic-shaped error body yields its type and message', () => {
  const buf = Buffer.from(JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'messages.0.content.1: image too large' },
  }));
  assert.deepEqual(upstreamErrorFromBody(buf), {
    type: 'invalid_request_error',
    message: 'messages.0.content.1: image too large',
  });
});

test('a flattened error body yields its message; junk yields nothing', () => {
  assert.deepEqual(upstreamErrorFromBody(Buffer.from('{"message":"boom"}')), { type: null, message: 'boom' });
  assert.equal(upstreamErrorFromBody(Buffer.from('<html>Bad Gateway</html>')), null);
  assert.equal(upstreamErrorFromBody(Buffer.from('{}')), null);
  assert.equal(upstreamErrorFromBody(Buffer.alloc(0)), null);
  assert.equal(upstreamErrorFromBody(null), null);
});

test('reportUpstreamError renders one bounded line in the log shape of other account notices', () => {
  const lines = [];
  const log = l => lines.push(l);
  reportUpstreamError(400, 'dev@x', { type: 'invalid_request_error', message: 'bad field' }, log);
  assert.deepEqual(lines, ['[TeamClaude] Upstream 400 on "dev@x" — invalid_request_error: bad field']);
  reportUpstreamError(502, 'dev@x', null, log);
  assert.equal(lines.at(-1), '[TeamClaude] Upstream 502 on "dev@x"');
  reportUpstreamError(400, 'd\n"evil@x', { type: 't\r\n43 on "', message: 'x'.repeat(500) }, log);
  assert.equal(lines.at(-1).split('\n').length, 1, 'no embedded newline survives');
  assert.ok(lines.at(-1).length < 400, 'the message is bounded');
});

// ── wired into the relay and the failover ────────────────────────────────────

const SESSION = 'sess-upstream-400';
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// One account per key, so the key the proxy sent upstream names who served it.
// `ownUpstream` gives every account its own `upstream` — the shape a
// third-party-backend account (Kimi) has; without it accounts ride the pool's
// configured upstream, the first-party shape.
function accounts(n, upstreamPort, ownUpstream) {
  return Array.from({ length: n }, (_, i) => ({
    name: `a${i}`, type: 'apikey', apiKey: `k${i}`,
    ...(ownUpstream ? { upstream: `http://127.0.0.1:${upstreamPort}` } : {}),
  }));
}

// `responder(acct)` answers each upstream request: a number becomes the status
// with an Anthropic-shaped error body, an object is the 200 body.
async function withFleet(n, responder, fn, { ownUpstream = true, opts } = {}) {
  const served = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const acct = String(req.headers['x-api-key'] || '');
    served.push(acct);
    const answer = responder(acct);
    if (typeof answer === 'number') {
      res.writeHead(answer, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `refused by ${acct}` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer ?? { stop_reason: 'end_turn', content: [] }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(n, upstreamPort, ownUpstream), 0.98, opts);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  const logs = { out: [], err: [] };
  const [origOut, origErr] = [console.log, console.error];
  console.log = l => logs.out.push(String(l));
  console.error = l => logs.err.push(String(l));
  try { await fn({ port, served, am, logs }); } finally {
    console.log = origOut; console.error = origErr;
    proxy.close(); upstream.close();
  }
}

// The fleet cursor's first pick is not deterministic, so the responder itself
// decides who refuses: `firstRefusal` marks the first account it sees as the
// refusing one and every other as healthy.
function firstRefusal() {
  let refused = null;
  return (acct) => {
    refused ??= acct;
    return acct === refused ? 400 : { ok: true };
  };
}

// One turn of a conversation. Same body every time so the conversation digest
// (and with it the session pin) stays put across posts.
async function post(port, { session = SESSION, path = '/v1/messages' } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'k',
      'x-claude-code-session-id': session,
    },
    body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { status: res.status, body: await res.text() };
}

test('a relayed 400 from a first-party account is tapped and NOT hopped', async () => {
  await withFleet(2, firstRefusal(), async ({ port, served, logs }) => {
    const r = await post(port);
    assert.equal(r.status, 400);
    assert.match(r.body, new RegExp(`refused by ${served[0]}`));
    // First-party premise: the request is the problem, so no sibling is spent.
    assert.equal(served.length, 1, `a first-party 400 spent a sibling: ${JSON.stringify(served)}`);
    const acct = `a${served[0].slice(1)}`;
    assert.ok(
      logs.err.some(l => l.includes(`Upstream 400 on "${acct}" — invalid_request_error: refused by ${served[0]}`)),
      `tap line missing: ${JSON.stringify(logs.err)}`,
    );
    assert.ok(!logs.out.some(l => l.includes('failing over')), 'a first-party 400 must not hop');
  }, { ownUpstream: false });
});

test('a 400 on a custom-upstream account hops once to a sibling, and the session re-pins', async () => {
  await withFleet(2, firstRefusal(), async ({ port, served, logs }) => {
    const r = await post(port);
    assert.equal(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.equal(served.length, 2, JSON.stringify(served));
    const [refused, savior] = served.map(k => `a${k.slice(1)}`);
    assert.ok(
      logs.out.some(l => l.includes(`Upstream 400 on "${refused}" (invalid_request_error: refused by ${served[0]}) — failing over once to "${savior}"`)),
      `hop line missing: ${JSON.stringify(logs.out)}`,
    );
    // The attempt the hop landed on re-pinned the session: the next turn of
    // the same session goes straight to the sibling instead of paying the
    // refusing account again.
    const saviorKey = served[1];
    served.length = 0;
    const r2 = await post(port);
    assert.equal(r2.status, 200);
    assert.deepEqual(served, [saviorKey], `session did not re-pin to the sibling: ${JSON.stringify(served)}`);
  }, { opts: { distributeSessions: true } });
});

test('a second 400 from the sibling is relayed and tapped — the hop budget is one', async () => {
  await withFleet(3, () => 400, async ({ port, served, logs }) => {
    const r = await post(port);
    assert.equal(r.status, 400);
    // One account refused, one sibling was spent on the hop, the third was not.
    assert.equal(served.length, 2, JSON.stringify(served));
    assert.match(r.body, new RegExp(`refused by ${served[1]}`));
    const second = `a${served[1].slice(1)}`;
    const taps = logs.err.filter(l => l.includes('Upstream 400'));
    assert.ok(taps.some(l => l.includes(`on "${second}"`)), `the relayed second 400 was not tapped: ${JSON.stringify(taps)}`);
  });
});

test('a pinned request keeps its account’s 400 — no hop, tap still fires', async () => {
  await withFleet(2, () => 400, async ({ port, served, logs }) => {
    const r = await post(port, { path: '/tc-acct/a0/v1/messages' });
    assert.equal(r.status, 400);
    assert.deepEqual(served, ['k0']);
    assert.ok(logs.err.some(l => l.includes('Upstream 400 on "a0"')), 'tap line missing');
    assert.ok(!logs.out.some(l => l.includes('failing over')), 'a pinned 400 must not hop');
  });
});
