import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { refusesThreadContinue, createProxyRequestListener } from '../src/server.js';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

// Claude Code keeps the conversation on Anthropic's side once a thread exists:
// the first /v1/messages request carries thread:{type:"create"} with the whole
// messages array, and every later one carries thread:{type:"continue"} with only
// the new delta. A third-party upstream ignores the unknown field and answers
// the delta alone, so the model stops seeing the conversation from the second
// turn on. Anthropic answers 400 when a thread cannot be continued and the
// client then resends everything as a fresh create, so refusing the continue is
// what puts those upstreams back on a complete conversation.

const buf = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
const thirdParty = { type: 'apikey', apiKey: 'k', upstream: 'https://zen.example' };
const anthropic = { type: 'apikey', apiKey: 'k' };
const MESSAGES_URL = '/v1/messages?beta=true';

const withThread = (thread) => buf({ model: 'k3', thread, messages: [{ role: 'user' }] });

test('a continue bound for a third-party upstream is refused', () => {
  const body = withThread({ type: 'continue', previous_message_id: 'msg_1' });
  assert.equal(refusesThreadContinue(body, thirdParty, MESSAGES_URL), true);
});

// A create already carries the full conversation, so it needs no repair.
test('a create is forwarded', () => {
  assert.equal(refusesThreadContinue(withThread({ type: 'create' }), thirdParty, MESSAGES_URL), false);
});

test('a body without a thread is forwarded', () => {
  const body = buf({ model: 'k3', messages: [{ role: 'user' }] });
  assert.equal(refusesThreadContinue(body, thirdParty, MESSAGES_URL), false);
});

// Anthropic implements threads, so a continue there is valid and must reach it.
test('a continue bound for Anthropic is forwarded', () => {
  const body = withThread({ type: 'continue', previous_message_id: 'msg_1' });
  assert.equal(refusesThreadContinue(body, anthropic, MESSAGES_URL), false);
});

// The scope is the per-account binding, not the effective upstream: a fleet
// sent to a third party through the global `upstream` is documented as not
// covered. Pinned so switching the predicate to upstreamFor() is a deliberate
// change with a release note, not a quiet one.
test('an account without its own upstream is forwarded whatever the fleet points at', () => {
  const body = withThread({ type: 'continue', previous_message_id: 'msg_1' });
  assert.equal(refusesThreadContinue(body, { type: 'apikey', apiKey: 'k' }, MESSAGES_URL), false);
});

// A Responses API body has no Anthropic thread semantics to repair.
test('a continue bound for a non-Anthropic provider is forwarded', () => {
  const codex = { type: 'apikey', apiKey: 'k', provider: 'codex', upstream: 'https://zen.example' };
  const body = withThread({ type: 'continue', previous_message_id: 'msg_1' });
  assert.equal(refusesThreadContinue(body, codex, MESSAGES_URL), false);
});

// A refusal on count_tokens would be unrecoverable: there is no conversation to
// resend as a create for a token count, and the body has the same shape.
test('only a completion is inspected', () => {
  const body = withThread({ type: 'continue', previous_message_id: 'msg_1' });
  assert.equal(refusesThreadContinue(body, thirdParty, '/v1/complete'), false);
  assert.equal(refusesThreadContinue(body, thirdParty, '/v1/messages/count_tokens'), false);
  assert.equal(refusesThreadContinue(body, thirdParty, '/v1/messages/batches'), false);
});

// The outgoing address is built with `new URL`, which folds a backslash to a
// slash, so a completion spelled either of these ways reaches the upstream as
// /v1/messages and has to be classified as one here too.
test('a completion is recognized through separator folding and one decode', () => {
  const body = withThread({ type: 'continue', previous_message_id: 'msg_1' });
  assert.equal(refusesThreadContinue(body, thirdParty, '\\v1\\messages'), true);
  assert.equal(refusesThreadContinue(body, thirdParty, '/v1/%6d%65ssages'), true);
  // and the same folding must not turn count_tokens into a completion
  assert.equal(refusesThreadContinue(body, thirdParty, '/v1/messages%2Fcount_tokens'), false);
});

// A relay that reaches Anthropic keeps working threads, so the operator can say
// so and keep the delta.
test('an upstream declaring thread support is forwarded', () => {
  const relay = { ...thirdParty, messageThreads: true };
  const body = withThread({ type: 'continue', previous_message_id: 'msg_1' });
  assert.equal(refusesThreadContinue(body, relay, MESSAGES_URL), false);
});

// An `upstream` naming Anthropic itself is a region pin or a mirror, not a
// different backend: it reaches the real thread store, so refusing there would
// be overhead an operator has to discover and opt out of by hand.
test('an upstream pointing at Anthropic keeps its threads without a flag', () => {
  const body = withThread({ type: 'continue', previous_message_id: 'msg_1' });
  for (const upstream of ['https://api.anthropic.com', 'https://api.anthropic.com/v1', 'https://api.anthropic.com:443']) {
    assert.equal(refusesThreadContinue(body, { ...thirdParty, upstream }, MESSAGES_URL), false, upstream);
  }
  // The host is what decides it. A third-party API that serves the Anthropic
  // shape under a path keeps no thread state.
  assert.equal(refusesThreadContinue(body, { ...thirdParty, upstream: 'https://api.deepseek.com/anthropic' }, MESSAGES_URL), true);
  // An upstream we cannot parse is not evidence of a thread store.
  assert.equal(refusesThreadContinue(body, { ...thirdParty, upstream: 'not a url' }, MESSAGES_URL), true);
});

// Every non-messages endpoint reaches this path too, so a body we cannot read
// must be forwarded rather than refused.
test('a non-JSON body is forwarded', () => {
  assert.equal(refusesThreadContinue(Buffer.from('not json', 'utf8'), thirdParty, MESSAGES_URL), false);
});

test('an empty body is forwarded', () => {
  assert.equal(refusesThreadContinue(Buffer.alloc(0), thirdParty, MESSAGES_URL), false);
});

// thread:{} and a thread of the wrong shape are neither a continue nor grounds
// to reject a request the upstream might well accept.
test('a thread without a recognized type is forwarded', () => {
  assert.equal(refusesThreadContinue(withThread({}), thirdParty, MESSAGES_URL), false);
  assert.equal(refusesThreadContinue(withThread('continue'), thirdParty, MESSAGES_URL), false);
});

test('the account carries its config through', () => {
  const am = new AccountManager([
    { name: 'zen', type: 'apikey', apiKey: 'k', upstream: 'https://zen.example' },
    { name: 'relay', type: 'apikey', apiKey: 'k', upstream: 'https://relay.example', messageThreads: true },
    { name: 'anthropic', type: 'apikey', apiKey: 'k2' },
  ], 0.98);
  const body = withThread({ type: 'continue', previous_message_id: 'msg_1' });
  assert.equal(refusesThreadContinue(body, am.accounts[0], MESSAGES_URL), true);
  assert.equal(refusesThreadContinue(body, am.accounts[1], MESSAGES_URL), false);
  assert.equal(refusesThreadContinue(body, am.accounts[2], MESSAGES_URL), false);
});

// The operator line is printed once per account, so it has to be re-armed when
// the setting it reports on changes — otherwise someone who tries
// messageThreads: true, finds it wrong, and takes it back off gets no signal at
// all that continues are being refused again.
test('a change to messageThreads re-arms the one-shot operator line', async () => {
  const entry = (messageThreads) => ({ name: 'zen', type: 'apikey', apiKey: 'k', upstream: 'https://zen.example', ...(messageThreads ? { messageThreads } : {}) });
  const am = new AccountManager([entry(false)], 0.98);
  const mem = { accounts: [entry(false)] };
  am.accounts[0].threadRefusalReported = true;

  await syncAccountsFromDisk({ accounts: [entry(true)] }, mem, am);
  assert.equal(am.accounts[0].messageThreads, true);
  assert.equal(am.accounts[0].threadRefusalReported, false, 'turning the setting on must re-arm the line');
  // The save stencil rebuilds the disk entry as { ...diskAcct, ...live }, so a
  // memConfig entry left behind would win the spread and overwrite the very edit
  // that was just read from disk.
  assert.equal(mem.accounts[0].messageThreads, true, 'the memConfig entry must mirror the disk edit');

  am.accounts[0].threadRefusalReported = true;
  await syncAccountsFromDisk({ accounts: [entry(false)] }, mem, am);
  assert.equal(am.accounts[0].messageThreads, false);
  assert.equal(am.accounts[0].threadRefusalReported, false, 'taking it back off must re-arm it too');
  assert.equal('messageThreads' in mem.accounts[0], false, 'and removal must delete it there, not leave a stale true');

  // A reload that changes nothing must not re-print on every reload either.
  am.accounts[0].threadRefusalReported = true;
  await syncAccountsFromDisk({ accounts: [entry(false)] }, mem, am);
  assert.equal(am.accounts[0].threadRefusalReported, true);
});

// Moving the account to a different backend re-arms it too: the line names the
// account, and the operator has no other way to learn the new upstream keeps no
// thread state either.
test('a change of upstream re-arms the one-shot operator line', async () => {
  const at = (upstream) => ({ name: 'zen', type: 'apikey', apiKey: 'k', upstream });
  const am = new AccountManager([at('https://zen.example')], 0.98);
  const mem = { accounts: [at('https://zen.example')] };

  am.accounts[0].threadRefusalReported = true;
  await syncAccountsFromDisk({ accounts: [at('https://other.example')] }, mem, am);
  assert.equal(am.accounts[0].threadRefusalReported, false);

  // Round trip through an Anthropic host and back: the account refuses again,
  // and the operator gets told again.
  am.accounts[0].threadRefusalReported = true;
  await syncAccountsFromDisk({ accounts: [at('https://api.anthropic.com')] }, mem, am);
  assert.equal(am.accounts[0].threadRefusalReported, false);
  am.accounts[0].threadRefusalReported = true;
  await syncAccountsFromDisk({ accounts: [at('https://other.example')] }, mem, am);
  assert.equal(am.accounts[0].threadRefusalReported, false);
});

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

const SESSION = 'session-under-test';

async function post(accounts, body, pickUpstream) {
  const seen = [];
  const { server: upstream, port } = await listen((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const am = new AccountManager(accounts.map(a => pickUpstream(a, port)), 0.98);
  const listener = createProxyRequestListener({ accountManager: am, upstream: `http://127.0.0.1:${port}` });
  const { server: proxy, port: proxyPort } = await listen(listener);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}${MESSAGES_URL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': SESSION },
      body,
    });
    const text = await res.text();
    return {
      status: res.status, text, headers: res.headers,
      reachedUpstream: seen.length,
      starved: am.sessionTracker.sessions.get(SESSION)?.starved ?? 0,
    };
  } finally {
    proxy.close();
    upstream.close();
  }
}

const continueBody = JSON.stringify({
  model: 'k3', thread: { type: 'continue', previous_message_id: 'msg_1' }, messages: [{ role: 'user', content: 'hi' }],
});

// The client stops threading a model after the first refusal, so a line per
// refusal would be a line per agent rather than per turn — still repetition an
// operator has to read past to find the one that matters.
test('the operator line is printed once per account, not once per refusal', async () => {
  const am = new AccountManager([{ name: 'zen', type: 'apikey', apiKey: 'k', upstream: 'https://zen.example' }], 0.98);
  const listener = createProxyRequestListener({ accountManager: am, upstream: 'https://zen.example' });
  const { server: proxy, port } = await listen(listener);
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${port}${MESSAGES_URL}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: continueBody,
      });
      await res.text();
      assert.equal(res.status, 400);
    }
  } finally {
    console.error = realError;
    proxy.close();
  }
  const refusals = lines.filter(l => l.includes('refusing message-thread continues'));
  assert.equal(refusals.length, 1, `expected one line for three refusals, got ${refusals.length}`);
  assert.match(refusals[0], /zen/, 'the line must name the account so the operator knows which one to fix');
});

// A 4xx is an answer, so the session is working rather than getting nothing —
// counting the refusal as starvation would raise the dashboard's starved-session
// alert at exactly the moment the proxy is repairing the conversation.
test('the proxy answers a third-party continue itself, without forwarding it', async () => {
  const { status, text, headers, reachedUpstream, starved } = await post(
    [{ name: 'zen', type: 'apikey', apiKey: 'k' }],
    continueBody,
    (a, port) => ({ ...a, upstream: `http://127.0.0.1:${port}` }),
  );
  assert.equal(status, 400);
  // The code is what makes the client stop threading this model for the rest of
  // the session instead of retrying the same turn: one refusal, not one a turn.
  assert.equal(JSON.parse(text).error.details.error_code, 'thread_unsupported_request');
  // The SDK retries a 400 it is told to; this one is the answer, not a blip.
  assert.equal(headers.get('x-should-retry'), 'false');
  assert.equal(reachedUpstream, 0, 'the refused request must not reach the upstream');
  assert.equal(starved, 0, 'an answered request is not a starved one');
});

// The counterpart: Anthropic implements threads, so its continues must still go
// through. Without this the test above would also pass if the proxy refused
// every continue.
test('an Anthropic continue is forwarded untouched', async () => {
  const { status, reachedUpstream } = await post(
    [{ name: 'anthropic', type: 'apikey', apiKey: 'k' }],
    continueBody,
    (a) => a,
  );
  assert.equal(status, 200);
  assert.equal(reachedUpstream, 1);
});
