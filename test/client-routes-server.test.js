import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Client routes (fixed seats, IPM fork AI-1552) through the direct HTTP path,
// against a stub upstream. The acceptance criteria of the fixed-seat plan
// (claude-gateway _bmad-output/arch/fixed-seat.arch-plan.md) are named on the
// tests: AC1-AC8 and AC13. The MITM entry path and the WebSocket upgrade are in
// client-routes-mitm.test.js.

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sec = (ms) => String(Math.floor(ms / 1000));
const tick = () => new Promise(r => setTimeout(r, 30));

const ADMIN = 'admin-key';
const KEYS = { ana: 'ana-key', bob: 'bob-key', uma: 'uma-key' };
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const codex = (name, port) => ({
  name: `codex:${name}`, type: 'oauth', provider: 'codex', accountId: `acct-${name}`,
  accessToken: `t-codex-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR, upstream: `http://127.0.0.1:${port}`,
});

// ana → seat-a (account sa), bob → seat-b (account sb). sc is on no route,
// uma has a key and no seat.
const ROUTES = [
  { name: 'seat-a', clients: ['ana'], accounts: ['sa'] },
  { name: 'seat-b', clients: ['bob'], accounts: ['sb'] },
];

const ok = (res, extra = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
};

/**
 * @param {{ handler?: (who: string, req: any, res: any) => void, routes?: any, require?: boolean, accounts?: (port: number) => any[] }} opts
 * @param {(ctx: any) => Promise<void>} fn
 */
async function withGateway({ handler = (_who, _req, res) => ok(res), routes = ROUTES, require = false, accounts } = {}, fn) {
  /** @type {{ who: string, path: string }[]} */
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    const who = req.headers['chatgpt-account-id']
      ? String(req.headers['chatgpt-account-id']).replace(/^acct-/, 'codex:')
      : String(req.headers.authorization || req.headers['x-api-key'] || '').replace(/^Bearer t-/, '');
    seen.push({ who, path: req.url, caller: req.headers['x-tc-caller'] ?? null });
    handler(who, req, res);
  });
  const upPort = await listen(upstream);
  /** @type {string[]} */
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  const list = accounts ? accounts(upPort) : [oauth('sa'), oauth('sb'), oauth('sc'), codex('c1', upPort), codex('c2', upPort)];
  const am = new AccountManager(list, 0.98, { clientRoutes: routes, refreshFn: async () => { throw new Error('no refresh'); } });
  const config = {
    proxy: { apiKey: ADMIN, clientKeys: Object.entries(KEYS).map(([name, key]) => ({ name, key })), requireClientRoute: require },
    upstream: `http://127.0.0.1:${upPort}`,
  };
  /** @type {any[]} */
  const ends = [];
  const proxy = createProxyServer(am, config, { onRequestEnd: (_id, info) => ends.push(info) });
  const port = await listen(proxy);
  /**
   * @param {{ key?: string|null, path?: string, method?: string, model?: string, session?: string, headers?: Record<string, string> }} [o]
   */
  const send = async ({ key = null, path = '/v1/messages', method = 'POST', model = 'claude-opus-4-1', session = undefined, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
        ...(session ? { 'x-claude-code-session-id': session } : {}),
        ...headers,
      },
      body: method === 'GET' ? undefined : JSON.stringify(path.includes('/codex/') ? { model: 'gpt-5.6-sol', input: [] } : { model, messages: [] }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, headers: res.headers, json };
  };
  const control = async (path, body, key = ADMIN) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  try {
    await fn({ am, config, port, seen, lines, ends, send, control });
  } finally {
    console.log = origLog;
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

const whos = (seen) => [...new Set(seen.map(s => s.who))];

// ── AC1, AC2 ─────────────────────────────────────────────────────────────────

test('AC1: every request from a key on seat S is served by S', async () => {
  await withGateway({}, async ({ send, seen, ends }) => {
    for (let i = 0; i < 50; i++) {
      const r = await send({ key: KEYS.ana, session: `s-${i % 5}` });
      assert.equal(r.status, 200);
    }
    assert.equal(seen.length, 50);
    assert.deepEqual(whos(seen), ['sa']);
    await tick();
    assert.equal(ends.filter(e => e.account === 'sa' && e.client === 'ana').length, 50, 'the activity line names S for every one');
  });
});

for (const [what, fail] of [
  ['a rate-limit 429', (res) => { res.writeHead(429, { 'retry-after': '300', 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'allowed' }); res.end('{"type":"error","error":{"type":"rate_limit_error"}}'); }],
  ['a 500', (res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"api_error"}}'); }],
  ['a 529', (res) => { res.writeHead(529, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"overloaded_error"}}'); }],
]) {
  test(`AC2: ${what} on S is never retried on another account`, async () => {
    await withGateway({ handler: (who, _req, res) => (who === 'sa' ? fail(res) : ok(res)) }, async ({ send, seen }) => {
      const r = await send({ key: KEYS.ana });
      assert.notEqual(r.status, 200);
      assert.deepEqual(whos(seen), ['sa'], `upstream saw ${JSON.stringify(seen)}`);
    });
  });
}

// ── AC3 spent ────────────────────────────────────────────────────────────────

test('AC3: a spent seat answers 429 with upstream\'s unified headers and x-should-retry false, then without upstream', async () => {
  const reset = Date.now() + 3 * HOUR;
  const spent = (res) => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': sec(reset),
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
      'retry-after': '3600',
    });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
  };
  await withGateway({ handler: (who, _req, res) => (who === 'sa' ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    const first = await send({ key: KEYS.ana });
    assert.equal(first.status, 429);
    assert.equal(first.headers.get('x-should-retry'), 'false');
    assert.equal(first.headers.get('anthropic-ratelimit-unified-5h-status'), 'rejected');
    assert.equal(first.headers.get('anthropic-ratelimit-unified-5h-reset'), sec(reset));
    assert.match(first.json.error.message, /out of quota until .*cg kimi on/);
    assert.deepEqual(whos(seen), ['sa']);

    const again = await send({ key: KEYS.ana, model: 'claude-fable-5-1' });
    assert.equal(again.status, 429);
    assert.equal(again.headers.get('x-should-retry'), 'false');
    assert.equal(again.headers.get('anthropic-ratelimit-unified-5h-reset'), sec(reset));
    assert.equal(seen.length, 1, 'the recorded reading answers the next request without touching upstream');
  });
});

test('AC3: a success on the seat (an operator probe) clears the spent reading', async () => {
  let spentNow = true;
  const handler = (who, _req, res) => {
    if (who === 'sa' && spentNow) {
      res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': sec(Date.now() + HOUR) });
      res.end('{}');
      return;
    }
    ok(res);
  };
  await withGateway({ handler }, async ({ send, seen }) => {
    assert.equal((await send({ key: KEYS.ana })).status, 429);
    assert.equal((await send({ key: KEYS.ana })).status, 429);
    assert.equal(seen.length, 1);
    spentNow = false;
    assert.equal((await send({ key: ADMIN, path: '/tc-acct/sa/v1/messages' })).status, 200);
    assert.equal((await send({ key: KEYS.ana })).status, 200, 'the window turned over early; the seat serves again');
    assert.deepEqual(whos(seen), ['sa']);
  });
});

test('AC3: a Fable request on a seat whose Fable bucket is spent gets the spent answer; Opus is still served', async () => {
  const fableSpent = (res) => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
      'anthropic-ratelimit-unified-7d_oi-reset': sec(Date.now() + 40 * HOUR),
    });
    res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
  };
  await withGateway({ handler: (who, req, res) => (req.headers['x-test-fable'] ? fableSpent(res) : ok(res)) }, async ({ send, seen }) => {
    const fable = await send({ key: KEYS.ana, model: 'claude-fable-5-1', headers: { 'x-test-fable': '1' } });
    assert.equal(fable.status, 429);
    assert.equal(fable.headers.get('x-should-retry'), 'false');
    assert.equal(fable.headers.get('anthropic-ratelimit-unified-7d_oi-status'), 'rejected');
    const fable2 = await send({ key: KEYS.ana, model: 'claude-fable-5-1' });
    assert.equal(fable2.status, 429, 'answered from the recording');
    const opus = await send({ key: KEYS.ana, model: 'claude-opus-4-1' });
    assert.equal(opus.status, 200);
    assert.deepEqual(whos(seen), ['sa']);
    assert.equal(seen.length, 2);
  });
});

test('count_tokens and GET /v1/models from a bound key go to its own seat', async () => {
  await withGateway({}, async ({ send, seen }) => {
    assert.equal((await send({ key: KEYS.bob, path: '/v1/messages/count_tokens' })).status, 200);
    assert.equal((await send({ key: KEYS.bob, path: '/v1/models', method: 'GET' })).status, 200);
    assert.deepEqual(whos(seen), ['sb']);
  });
});

// ── AC4 throttled ────────────────────────────────────────────────────────────

test('AC4: a throttled (not spent) seat answers a retryable 429 with retry-after', async () => {
  await withGateway({}, async ({ am, send, seen }) => {
    const sa = am.accounts.find(a => a.name === 'sa');
    sa.status = 'throttled';
    sa.rateLimitedUntil = Date.now() + 20_000;
    const r = await send({ key: KEYS.ana });
    assert.equal(r.status, 429);
    const after = Number(r.headers.get('retry-after'));
    assert.ok(after >= 19 && after <= 20, String(after));
    assert.equal(r.headers.get('x-should-retry'), null);
    assert.equal(seen.length, 0, 'answered from the seat state, nothing sent, nothing sent elsewhere');
  });
});

test('AC4: an upstream rate-limit 429 on the seat comes back retryable, never on another account', async () => {
  const throttle = (res) => { res.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'allowed' }); res.end('{}'); };
  await withGateway({ handler: (who, _req, res) => (who === 'sa' ? throttle(res) : ok(res)) }, async ({ send, seen }) => {
    const r = await send({ key: KEYS.ana });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '120');
    assert.equal(r.headers.get('x-should-retry'), null);
    assert.deepEqual(whos(seen), ['sa']);
  });
});

// ── AC5 unavailable ──────────────────────────────────────────────────────────

test('AC5: a disabled seat answers 503 x-should-retry false and no other account is used', async () => {
  await withGateway({}, async ({ am, send, seen }) => {
    am.accounts.find(a => a.name === 'sa').disabled = true;
    const r = await send({ key: KEYS.ana });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('x-should-retry'), 'false');
    assert.equal(seen.length, 0);
  });
});

test('AC5: a seat in error answers 503', async () => {
  await withGateway({}, async ({ am, send, seen }) => {
    am.accounts.find(a => a.name === 'sa').status = 'error';
    const r = await send({ key: KEYS.ana });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('x-should-retry'), 'false');
    assert.equal(seen.length, 0);
  });
});

test('AC5: an unknown or duplicated seat name is unresolved: 503 and a warning naming the route', async () => {
  const routes = [{ name: 'seat-x', clients: ['ana'], accounts: ['gone@x'] }, { name: 'seat-d', clients: ['bob'], accounts: ['dup'] }];
  await withGateway({ routes, accounts: () => [oauth('sa'), oauth('dup'), oauth('dup')] }, async ({ send, seen, lines, control }) => {
    const a = await send({ key: KEYS.ana });
    assert.equal(a.status, 503);
    assert.equal(a.headers.get('x-should-retry'), 'false');
    const b = await send({ key: KEYS.bob });
    assert.equal(b.status, 503);
    assert.equal(seen.length, 0);
    assert.ok(lines.some(l => /Seat gate: client "ana" seat "seat-x" → unavailable \(503\) — account "gone@x" is not configured/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /seat "seat-d" → unavailable \(503\) — account name "dup" is shared by 2 accounts/.test(l)), lines.join('\n'));
    const status = (await control('/teamclaude/status')).json;
    assert.deepEqual(status.clientRoutes.map(r => [r.name, r.resolved]), [['seat-x', false], ['seat-d', false]]);
  });
});

test('AC5: a key on two routes is ambiguous: 503, warned at load', async () => {
  const routes = [{ name: 'one', clients: ['ana'], accounts: ['sa'] }, { name: 'two', clients: ['ana'], accounts: ['sb'] }];
  await withGateway({ routes }, async ({ send, seen, lines }) => {
    const r = await send({ key: KEYS.ana });
    assert.equal(r.status, 503);
    assert.equal(seen.length, 0);
    assert.ok(lines.some(l => /client "ana" is on 2 routes/.test(l)), lines.join('\n'));
  });
});

// ── AC6 the switch ───────────────────────────────────────────────────────────

test('AC6: with the switch on, a key with no seat gets 403 for Claude and keeps Codex and the model list', async () => {
  await withGateway({ require: true }, async ({ send, seen }) => {
    const r = await send({ key: KEYS.uma });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.type, 'permission_error');
    assert.equal((await send({ key: KEYS.uma, path: '/v1/messages/count_tokens' })).status, 403);
    assert.equal(seen.length, 0);
    assert.equal((await send({ key: KEYS.uma, path: '/backend-api/codex/responses' })).status, 200);
    assert.equal((await send({ key: KEYS.uma, path: '/v1/models', method: 'GET' })).status, 200);
    assert.equal(seen.length, 2);
    assert.match(seen[0].who, /^codex:/);
  });
});

test('AC6: with the switch off, a key with no seat still rotates, and owned seats stay bound', async () => {
  await withGateway({ require: false }, async ({ send, seen }) => {
    assert.equal((await send({ key: KEYS.uma })).status, 200);
    assert.equal((await send({ key: KEYS.ana })).status, 200);
    assert.equal(seen[1].who, 'sa');
  });
});

test('AC6: with the switch on, the admin key and key-less loopback need an explicit pin', async () => {
  await withGateway({ require: true }, async ({ send, seen, lines }) => {
    const admin = await send({ key: ADMIN });
    assert.equal(admin.status, 403);
    assert.equal(admin.json.error.type, 'permission_error');
    const loop = await send({ key: null });
    assert.equal(loop.status, 403);
    assert.equal(seen.length, 0);
    assert.equal((await send({ key: ADMIN, path: '/v1/models', method: 'GET' })).status, 200, 'the catalog is never refused');
    seen.length = 0;
    const pinned = await send({ key: ADMIN, path: '/tc-acct/sb/v1/messages', headers: { 'x-tc-caller': 'console-probe' } });
    assert.equal(pinned.status, 200);
    const loopPinned = await send({ key: null, path: '/tc-acct/sa/v1/messages' });
    assert.equal(loopPinned.status, 200);
    assert.deepEqual(seen.map(s => s.who), ['sb', 'sa']);
    assert.equal(seen[0].caller, null, 'the caller hint is not forwarded upstream');
    assert.ok(lines.some(l => /Operator inference pinned to "sb" \(path pin, caller hint: console-probe, from /.test(l)), lines.join('\n'));
  });
});

// ── AC7 Codex ────────────────────────────────────────────────────────────────

test('AC7: a key on a Claude seat still rotates over the Codex seats', async () => {
  const handler = (who, _req, res) => {
    if (who === 'codex:c1') { res.writeHead(529, { 'content-type': 'application/json' }); res.end('{}'); return; }
    ok(res);
  };
  await withGateway({ require: true, handler }, async ({ send, seen }) => {
    const r = await send({ key: KEYS.ana, path: '/backend-api/codex/responses' });
    assert.equal(r.status, 200);
    assert.deepEqual(seen.map(s => s.who), ['codex:c1', 'codex:c2'], 'Codex is not bound: its 529 hops to the other Codex seat');
  });
});

// ── AC8 pins and overrides ───────────────────────────────────────────────────

test('AC8: a key pinning an account off its seat gets 403; its own seat by pin is fine', async () => {
  await withGateway({}, async ({ send, seen }) => {
    const r = await send({ key: KEYS.ana, path: '/tc-acct/sb/v1/messages' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.type, 'permission_error');
    assert.equal(seen.length, 0);
    assert.equal((await send({ key: KEYS.ana, path: '/tc-acct/sa/v1/messages' })).status, 200);
    assert.deepEqual(whos(seen), ['sa']);
  });
});

test('AC8: a client key cannot POST /teamclaude/switch or /teamclaude/session-pin', async () => {
  await withGateway({}, async ({ control }) => {
    assert.equal((await control('/teamclaude/switch', { account: 'sb' }, KEYS.ana)).status, 403);
    assert.equal((await control('/teamclaude/session-pin', { sessionId: 'sess-ana-1', account: 'sb' }, KEYS.ana)).status, 403);
    assert.equal((await control('/teamclaude/switch', { account: 'sb' })).status, 200, 'the operator still can');
  });
});

test('AC8: an admin session pin moves only that key\'s session, and is logged; another key with the same id gets its own seat', async () => {
  const SID = 'sess-ana-override';
  await withGateway({ require: true }, async ({ send, seen, control, lines, ends }) => {
    assert.equal((await send({ key: KEYS.ana, session: SID })).status, 200);
    const pin = await control('/teamclaude/session-pin', { sessionId: SID, account: 'sc' });
    assert.equal(pin.status, 200);
    assert.equal(pin.json.client, 'ana', 'bound to the key the session was seen with');
    seen.length = 0;
    assert.equal((await send({ key: KEYS.ana, session: SID })).status, 200);
    assert.equal((await send({ key: KEYS.ana, session: SID, path: '/tc-acct/sb/v1/messages' })).status, 200, 'the admin pin wins over the key\'s own pin');
    assert.equal((await send({ key: KEYS.ana, session: 'sess-ana-other' })).status, 200);
    assert.equal((await send({ key: KEYS.bob, session: SID })).status, 200);
    assert.equal((await send({ key: KEYS.uma, session: SID })).status, 403, 'a seat-less key reusing the id gets its own gate');
    assert.deepEqual(seen.map(s => s.who), ['sc', 'sc', 'sa', 'sb']);
    await tick();
    assert.ok(ends.some(e => e.client === 'ana' && e.gate === 'admin-pin' && e.account === 'sc' && e.seat === 'seat-a'), JSON.stringify(ends));
    assert.ok(lines.some(l => /Session sess-ana pinned to account "sc" \(manual\) for client "ana"/.test(l)), lines.join('\n'));
  });
});

test('AC8: an admin session pin for an unseen session names its client in the body; a session seen with two keys must', async () => {
  await withGateway({ require: true }, async ({ send, seen, control }) => {
    const bad = await control('/teamclaude/session-pin', { sessionId: 'sess-new-1', account: 'sc', client: 'nobody' });
    assert.equal(bad.status, 400);
    const pin = await control('/teamclaude/session-pin', { sessionId: 'sess-new-1', account: 'sc', client: 'UMA' });
    assert.equal(pin.status, 200);
    assert.equal(pin.json.client, 'uma');
    assert.equal((await send({ key: KEYS.uma, session: 'sess-new-1' })).status, 200, 'the override rescues a seat-less key');
    assert.equal(seen.at(-1).who, 'sc');

    await send({ key: KEYS.ana, session: 'sess-shared' });
    await send({ key: KEYS.bob, session: 'sess-shared' });
    const twice = await control('/teamclaude/session-pin', { sessionId: 'sess-shared', account: 'sc' });
    assert.equal(twice.status, 409);
    assert.deepEqual(twice.json.clients.sort(), ['ana', 'bob']);
  });
});

test('with no client routes and the switch off, a session pin keeps upstream behaviour', async () => {
  await withGateway({ routes: [] }, async ({ send, seen, control }) => {
    await send({ key: KEYS.ana, session: 'sess-plain' });
    await send({ key: KEYS.bob, session: 'sess-plain' });
    const pin = await control('/teamclaude/session-pin', { sessionId: 'sess-plain', account: 'sc' });
    assert.equal(pin.status, 200, 'no 409 when no binding is enforced');
    seen.length = 0;
    await send({ key: KEYS.ana, session: 'sess-plain' });
    await send({ key: KEYS.uma, session: 'sess-plain' });
    assert.deepEqual(seen.map(s => s.who), ['sc', 'sc'], 'the pin applies to every key presenting the id, as upstream');
  });
});

// ── multi-account seats ──────────────────────────────────────────────────────

test('a seat with two accounts hops only inside itself', async () => {
  const routes = [{ name: 'pair', clients: ['ana'], accounts: ['sa', 'sb'] }];
  const handler = (who, _req, res) => {
    if (who === 'sa' || who === 'sb') { res.writeHead(529, { 'content-type': 'application/json' }); res.end('{}'); return; }
    ok(res);
  };
  await withGateway({ routes, handler }, async ({ send, seen, am }) => {
    const r = await send({ key: KEYS.ana });
    assert.equal(r.status, 529);
    assert.deepEqual(seen.map(s => s.who).sort(), ['sa', 'sb']);
    am.accounts.find(a => a.name === 'sa').disabled = true;
    am.accounts.find(a => a.name === 'sb').disabled = true;
    seen.length = 0;
    const down = await send({ key: KEYS.ana });
    assert.equal(down.status, 503);
    assert.equal(seen.length, 0);
  });
});

test('a bound request never moves the fleet\'s current account', async () => {
  await withGateway({}, async ({ am, send }) => {
    const before = am.currentIndex;
    await send({ key: KEYS.bob });
    await send({ key: KEYS.bob });
    assert.equal(am.currentIndex, before);
  });
});

// ── status ───────────────────────────────────────────────────────────────────

test('status: clientRoutes and requireClientRoute always present; caller.seat for a client key', async () => {
  await withGateway({ require: true }, async ({ control, am }) => {
    const admin = (await control('/teamclaude/status')).json;
    assert.equal(admin.requireClientRoute, true);
    assert.deepEqual(admin.clientRoutes.map(r => ({ name: r.name, clients: r.clients, accounts: r.accounts, resolved: r.resolved })), [
      { name: 'seat-a', clients: ['ana'], accounts: ['sa'], resolved: true },
      { name: 'seat-b', clients: ['bob'], accounts: ['sb'], resolved: true },
    ]);
    assert.equal(admin.caller.kind, 'operator');
    assert.equal(admin.caller.seat, undefined, 'the admin poll never carries a seat');
    am.accounts.find(a => a.name === 'sa').quota.unified5hReset = Date.now() + HOUR;
    const ana = (await control('/teamclaude/status', undefined, KEYS.ana)).json;
    assert.equal(ana.caller.seat.name, 'seat-a');
    assert.equal(typeof ana.caller.seat.resetsAt, 'number');
    assert.ok(ana.caller.refused.includes('/teamclaude/switch'));
    const uma = (await control('/teamclaude/status', undefined, KEYS.uma)).json;
    assert.equal(uma.caller.seat, null);
  });
  await withGateway({ routes: [] }, async ({ control }) => {
    const s = (await control('/teamclaude/status')).json;
    assert.deepEqual(s.clientRoutes, []);
    assert.equal(s.requireClientRoute, false);
  });
});

// ── AC13 the activity log ────────────────────────────────────────────────────

test('AC13: every refusal and override is logged with client, seat and reason', async () => {
  await withGateway({ require: true }, async ({ am, send, lines, ends, control }) => {
    await send({ key: KEYS.uma });                                      // no-seat
    await send({ key: KEYS.ana, path: '/tc-acct/sb/v1/messages' });     // foreign-pin
    am.accounts.find(a => a.name === 'sb').status = 'error';
    await send({ key: KEYS.bob });                                      // unavailable
    const sa = am.accounts.find(a => a.name === 'sa');
    sa.status = 'throttled'; sa.rateLimitedUntil = Date.now() + 30_000;
    await send({ key: KEYS.ana });                                      // throttled
    sa.status = 'active'; sa.rateLimitedUntil = null;
    const { recordSeatRejection } = await import('../src/client-routes.js');
    recordSeatRejection(sa, { 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-reset': sec(Date.now() + HOUR) }, null);
    await send({ key: KEYS.ana });                                      // spent
    await control('/teamclaude/session-pin', { sessionId: 'sess-log', account: 'sc', client: 'ana' });
    await send({ key: KEYS.ana, session: 'sess-log' });                 // admin override
    await tick();
    const want = [
      ['uma', null, 'no-seat', 403],
      ['ana', 'seat-a', 'foreign-pin', 403],
      ['bob', 'seat-b', 'unavailable', 503],
      ['ana', 'seat-a', 'throttled', 429],
      ['ana', 'seat-a', 'spent', 429],
    ];
    for (const [client, seat, reason, status] of want) {
      assert.ok(ends.some(e => e.client === client && e.seat === seat && e.gate === reason && e.status === status), `request line for ${reason}: ${JSON.stringify(ends)}`);
      const seatText = seat ? `"${seat}"` : '\\(none\\)';
      assert.ok(lines.some(l => new RegExp(`Seat gate: client "${client}" seat ${seatText} → ${reason} \\(${status}\\)`).test(l)), `log line for ${reason}:\n${lines.join('\n')}`);
    }
    assert.ok(ends.some(e => e.client === 'ana' && e.seat === 'seat-a' && e.gate === 'admin-pin' && e.account === 'sc' && e.status === 200));
  });
});
