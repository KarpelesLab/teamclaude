import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { SessionTracker } from '../src/session-tracker.js';

// `starved` counts CONSECUTIVE client requests that ended without a usable
// answer. The point of it is everything the token counters cannot see:
// `reports` is zero on three healthy shapes (count_tokens, a 4xx, a
// third-party upstream that returns no usage object) and non-zero on the worst
// failing one (a stream that emits message_start and then dies), while `count`
// counts forward attempts rather than client requests — and is not incremented
// at all when no account was available, which is the case that starves a
// session hardest.
//
// Most of these drive the real proxy rather than the tracker, because every
// defect in the first attempt at this signal lived at the call site.

const SID = 'sess-starved';
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
// A stub that deliberately never ends its response leaves a live connection,
// and `close()` waits for it — which hangs the file on Node 20/22 where the
// runtime does not tear it down for us. Close the sockets explicitly rather
// than relying on version-specific behaviour.
function shutdown(...servers) {
  for (const srv of servers) { srv.closeAllConnections?.(); srv.close(); }
}
const fleet = (n = 1) => new AccountManager(
  Array.from({ length: n }, (_, i) => ({ name: `a${i}`, type: 'api_key', apiKey: `sk-${i}` })), 0.98);

function item(am, id = SID) {
  return (am.sessionTracker.stats(undefined, { detail: true }).items || []).find(r => r.id === id);
}
async function post(port, body = { model: 'claude-opus-5', messages: [] }, path = '/v1/messages') {
  // A stream the proxy tears down breaks the client's fetch — that is the
  // symptom under test, not a harness failure, so it is caught rather than
  // thrown. Callers assert on the session record, never on this return.
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': SID },
      body: JSON.stringify(body),
    });
    await res.text().catch(() => {});
    return res.status;
  } catch { return null; }
}
/** Drive the proxy against `handler`, N client requests, and return the session row. */
async function run(handler, n, { accounts = 1, before } = {}) {
  const upstream = http.createServer(handler);
  const upstreamPort = await listen(upstream);
  const am = fleet(accounts);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    before?.(am);
    for (let i = 0; i < n; i++) await post(port);
    return { row: item(am), am };
  } finally { shutdown(proxy, upstream); }
}

/** Drive the session to a known non-zero streak, so a later assertion of 0
 *  proves a RESET rather than merely the initial value: every healthy-shape
 *  test here previously passed on the default and survived deleting the
 *  feature outright. */
async function prime(port, n = 2) { for (let i = 0; i < n; i++) await post(port); }

const json = (status, body) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// ── the counter itself ──────────────────────────────────────

test('the streak advances on failure and is reset by one usable answer', () => {
  const st = new SessionTracker();
  st.beginRequest(SID);
  for (let i = 0; i < 5; i++) st.recordOutcome(SID, false);
  assert.equal(item({ sessionTracker: st }).starved, 5);
  assert.equal(st.recordOutcome(SID, true), 0, 'one answer clears the streak');
  for (let i = 0; i < 5; i++) st.recordOutcome(SID, false);
  assert.equal(item({ sessionTracker: st }).starved, 5, 'and it climbs again');
});

test('an outcome for a session the tracker has forgotten creates nothing', () => {
  const st = new SessionTracker();
  assert.equal(st.recordOutcome('never-seen', false), null);
  assert.equal(st.sessions.has('never-seen'), false, 'a client-supplied id cannot resurrect a record');
});

// ── the healthy shapes the first attempt accused ────────────

test('count_tokens is invisible to the streak — it neither starves nor rescues', async () => {
  // Claude Code sends count_tokens under the SAME session id as the completions
  // it is sizing up, and that endpoint keeps working when completions do not.
  // Counting it either way is wrong: as a failure it accuses a healthy session,
  // as a success it rescues a starving one.
  let completionsFail = false;
  const upstream = http.createServer((req, res) =>
    (req.url.includes('count_tokens') ? json(200, { input_tokens: 42 })
      : completionsFail ? json(500, { error: 'boom' }) : json(200, { ok: true }))(req, res));
  const upstreamPort = await listen(upstream);
  const am = fleet();
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    for (let i = 0; i < 6; i++) await post(port, { model: 'claude-opus-5' }, '/v1/messages/count_tokens');
    assert.equal(item(am).starved, 0, 'a healthy count_tokens session is not starving');

    // THE case this counter exists for: failing completions interleaved with the
    // successful count_tokens calls that accompany them. Before the guard this
    // reported a streak of one, and the banner would never have fired.
    completionsFail = true;
    for (let i = 0; i < 6; i++) {
      await post(port, { model: 'claude-opus-5' }, '/v1/messages/count_tokens');
      await post(port);
    }
    assert.equal(item(am).starved, 6, 'a good count_tokens must not reset the streak');
  } finally { shutdown(proxy, upstream); }
});

test('a repeated 4xx is an answer about the request, and clears a streak', async () => {
  let bad = true;
  const upstream = http.createServer((req, res) => (bad ? json(500, { error: 'boom' })
    : json(400, { type: 'error', error: { type: 'invalid_request_error' } }))(req, res));
  const upstreamPort = await listen(upstream);
  const am = fleet();
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    await prime(port);
    assert.equal(item(am).starved, 2, 'primed');
    bad = false;
    for (let i = 0; i < 6; i++) await post(port);
    assert.equal(item(am).starved, 0, 'a 400 tells the client something true about what it sent');
  } finally { shutdown(proxy, upstream); }
});

test('a 401 is not an answer: it is about a credential the client never sees', async () => {
  // A fleet whose keys have all been rotated out answers 401 to everything,
  // forever — the canonical starving session, and one the client cannot act on.
  const { row } = await run(json(401, { type: 'error', error: { type: 'authentication_error' } }), 3);
  assert.equal(row.starved, 3);
});

test('a 200 carrying no usage object — a third-party upstream — answers and clears', async () => {
  let bad = true;
  const upstream = http.createServer((req, res) => (bad ? json(500, { error: 'boom' }) : json(200, { ok: true }))(req, res));
  const upstreamPort = await listen(upstream);
  const am = fleet();
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    await prime(port);
    bad = false;
    for (let i = 0; i < 6; i++) await post(port);
    const row = item(am);
    assert.equal(row.starved, 0, 'answered');
    assert.equal(Object.keys(row.tokens).length, 0, 'while reporting no usage: different questions');
  } finally { shutdown(proxy, upstream); }
});

test('a stream that dies after message_start starves, though it reported usage', async () => {
  const { row } = await run((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n');
    // Let the event actually reach the proxy's SSE parser before the socket
    // dies — the real shape is a stream that reports and THEN fails, which is
    // precisely what makes the usage counter blind to it.
    setTimeout(() => res.destroy(), 60);
  }, 3);
  assert.equal(row.starved, 3, 'the client got nothing usable');
  const reports = Object.values(row.tokens).reduce((n, t) => n + t.reports, 0);
  assert.equal(reports, 3, 'while the usage counter says it heard from upstream — the old false negative');
});

test('a persistent 5xx starves once per client request, not once per attempt', async () => {
  const { row } = await run(json(500, { error: 'boom' }), 3, { accounts: 2 });
  assert.equal(row.starved, 3, 'three client requests');
  assert.ok(row.requests > 3, `attempts (${row.requests}) exceed client requests — why the count cannot be used`);
});

test('a fleet with nothing available starves a session that never reaches an account', async () => {
  const { row } = await run(json(200, { ok: true }), 3, {
    accounts: 2,
    before: (am) => am.accounts.forEach((_, i) => am.setDisabled(i, true)),
  });
  assert.equal(row.starved, 3);
  assert.equal(row.requests, 0, 'recordSession is never reached — invisible to any count-based signal');
});

// ── the third state ─────────────────────────────────────────

test('a client that walks away mid-stream is not counted as starved', async () => {
  // The upstream keeps emitting, so streamResponse's next read resolves and the
  // departure is observed promptly. (A silent upstream is not seen until the
  // body-idle timeout — see the known limit in the PR.)
  const open = [];
  const upstream = http.createServer((req, res) => {
    open.push(res);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n');
    const t = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(t); } }, 20);
    res.on('close', () => clearInterval(t));
  });
  const upstreamPort = await listen(upstream);
  const am = fleet();
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    // Primed, so asserting 0 later proves the departure RESET nothing and
    // ADDED nothing — rather than merely matching the initial value.
    am.beginSession(SID); am.endSession(SID, false);
    am.beginSession(SID); am.endSession(SID, false);
    assert.equal(item(am).starved, 2, 'primed');

    for (let i = 0; i < 3; i++) {
      const ac = new AbortController();
      const p = fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': SID },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 80));
      ac.abort();
      await p;
      await new Promise(r => setTimeout(r, 120));
    }
    assert.equal(item(am).starved, 2, 'leaving is neither an answer nor starvation');
  } finally {
    for (const res of open) res.destroy();
    shutdown(proxy, upstream);
  }
});
test('the fleet-level maximum is reported, and clears when the session goes quiet', () => {
  let t = 1_000_000;
  const st = new SessionTracker({ now: () => t });
  for (let i = 0; i < 4; i++) {
    st.beginRequest(SID);
    st.recordOutcome(SID, false);
    st.endRequest(SID);
  }
  assert.equal(st.stats().starvedMax, 4, 'visible without proxy.sessionDetail');
  t += 5 * 60 * 1000; // past the active window
  assert.equal(st.stats().starvedMax, 0, 'a session that stopped trying is not still starving');
});

// An exit before beginSession (blocked model, unknown pin, egress unpinned)
// records its outcome without an in-flight hold to close. Routing it through
// endSession would release a hold it never took — another request's, when the
// session has one in flight — and the pin-ageing branch would fire under it.
test('an early outcome leaves a concurrent in-flight hold in place', () => {
  const am = fleet();
  am.beginSession(SID, 'claude-opus-5');
  am.recordOutcome(SID, false);
  assert.equal(am.sessionTracker.sessions.get(SID).inFlight, 1, 'the open request keeps its hold');
  assert.equal(am.sessionTracker.sessions.get(SID).starved, 1, 'the outcome is still recorded');
  am.recordOutcome(SID, null);
  assert.equal(am.sessionTracker.sessions.get(SID).starved, 1, 'null records nothing');
  am.endSession(SID, true);
  assert.equal(am.sessionTracker.sessions.get(SID).inFlight, 0);
  assert.equal(am.sessionTracker.sessions.get(SID).starved, 0);
});
