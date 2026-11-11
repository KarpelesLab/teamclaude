import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { recordSeatRejection, seatVerdict } from '../src/client-routes.js';

// The seat queue (IPM fork): a multi-account seat is a drain queue in config
// order. The first quota failure on a pinned conversation recommends a handoff
// and discloses the cold-cache continuation; the next prompt in that same
// conversation confirms it and moves once. A fresh conversation still advances
// without that ceremony. Quota is spent one account at a time, not spread.

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sec = (ms) => String(Math.floor(ms / 1000));

const ADMIN = 'admin-key';
const KEYS = { amy: 'amy-key', ben: 'ben-key', carol: 'carol-key' };
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

// amy and carol → s1+s2+s3 (qa, qb, then qc); ben → seat-r (qr, outside that route).
const ROUTES = [
  { name: 's1+s2+s3', clients: ['amy', 'carol'], accounts: ['qa', 'qb', 'qc'] },
  { name: 'seat-r', clients: ['ben'], accounts: ['qr'] },
];

const okBody = JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
const ok = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(okBody);
};

// qa spent: a 429 whose unified headers reject the weekly window.
const spent = (res) => {
  res.writeHead(429, {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-7d-reset': sec(Date.now() + HOUR),
  });
  res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
};

async function withGateway({ handler = (_who, res) => ok(res) } = {}, fn) {
  const seen = [];
  const attempts = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const who = String(req.headers.authorization || '').replace(/^Bearer t-/, '');
    seen.push(who);
    attempts.push({ who, headers: req.headers, body: Buffer.concat(chunks).toString() });
    handler(who, res);
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([oauth('qa'), oauth('qb'), oauth('qc'), oauth('qr')], 0.98, {
    clientRoutes: ROUTES,
    distributeSessions: true,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  const config = {
    proxy: { apiKey: ADMIN, clientKeys: Object.entries(KEYS).map(([name, key]) => ({ name, key })), requireClientRoute: true },
    upstream: `http://127.0.0.1:${upPort}`,
  };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  // One turn of one conversation: the body identifies the conversation, so
  // `text` distinguishes conversations under one session id.
  const send = async ({ key = KEYS.amy, session = 's-1', text = 'hello', policy, advisor } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'x-claude-code-session-id': session,
        ...(policy === undefined ? {} : { 'x-teamclaude-seat-policy': policy }),
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1',
        ...(advisor ? { tools: [{ type: 'advisor_20260301', name: 'advisor', model: advisor }] } : {}),
        messages: [{ role: 'user', content: text }],
      }),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* SSE and other non-JSON responses stay raw */ }
    return { status: res.status, headers: res.headers, raw, json };
  };
  try {
    await fn({ send, seen, attempts, am });
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

test('a conversation on a multi-account seat stays on the queue head across turns', async () => {
  await withGateway({}, async ({ send, seen }) => {
    for (let turn = 0; turn < 5; turn++) {
      // One conversation: same session, same opening, growing transcript.
      assert.equal((await send({ text: 'hello' })).status, 200);
    }
    assert.deepEqual([...new Set(seen)], ['qa'], `the conversation spread: ${JSON.stringify(seen)}`);
  });
});

test('fresh conversations drain the queue head too — quota is not spread across the seat', async () => {
  await withGateway({}, async ({ send, seen }) => {
    for (const text of ['conv one', 'conv two', 'conv three']) {
      assert.equal((await send({ text })).status, 200);
    }
    assert.deepEqual([...new Set(seen)], ['qa'], `fresh conversations spread: ${JSON.stringify(seen)}`);
  });
});

test('a spent pin offers handoff first; the next same-conversation prompt continues cold on the sibling', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa']);

    qaSpent = true;
    const stopped = await send({ text: 'hello' });
    assert.equal(stopped.status, 429);
    assert.equal(stopped.json?.error?.type, 'rate_limit_error');
    const msg = stopped.json?.error?.message ?? '';
    assert.ok(msg.startsWith('You can keep working by moving to another assigned account; "qb" appears available. The account "qa", pinned to this conversation, cannot serve this request because its quota is exhausted until '), msg);
    assert.ok(msg.includes('/ipm:handoff'), `the handoff is not recommended: ${msg}`);
    assert.ok(msg.includes('reprocess the full conversation at full input-token cost'), `the cold-cache cost is not disclosed: ${msg}`);
    assert.ok(msg.includes('next prompt confirms'), `the continuation is not disclosed: ${msg}`);
    assert.equal(stopped.headers.get('anthropic-ratelimit-unified-7d-reset'), null, 'the offer must not become the generic plan-limit banner');
    assert.deepEqual(seen, ['qa', 'qa'], `the first failure leaked to the sibling: ${JSON.stringify(seen)}`);

    const continued = await send({ text: 'hello' });
    assert.equal(continued.status, 200);
    assert.equal(continued.raw, okBody, 'the successful assistant body is unchanged');
    assert.equal(continued.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qb;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qb'], `the disclosed continuation did not reach qb: ${JSON.stringify(seen)}`);

    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qb'], 'the conversation did not stay on its new pin');

    const fresh = await send({ text: 'a new conversation' });
    assert.equal(fresh.status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qb', 'qb']);
  });
});

test('a continuation offer requires the next account to serve the advisor model too', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, am }) => {
    Object.assign(am.accounts[1].quota, {
      unified7dFable: 1,
      unified7dFableReset: Date.now() + HOUR,
      unified7dFableSeenAt: Date.now(),
    });
    recordSeatRejection(am.accounts[1], {
      'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
      'anthropic-ratelimit-unified-7d_oi-reset': sec(Date.now() + HOUR),
    }, 'claude-fable-5');
    assert.ok(seatVerdict(am, am.accounts[1], 'claude-opus-4-1', 'claude-fable-5'), 'qb is spent for the advisor');
    assert.equal(am.unavailableReason(am.accounts[1], 'claude-opus-4-1', 'claude-fable-5'), 'advisor-quota');
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const stopped = await send({ text: 'hello', advisor: 'claude-fable-5' });
    assert.equal(stopped.status, 429);
    const msg = stopped.json?.error?.message ?? '';
    assert.ok(msg.includes('currently "qc"'), `the advisor-ineligible qb was offered: ${msg}`);
    assert.ok(!msg.includes('currently "qb"'), msg);
  });
});

test('a recorded rejection offers handoff before the next prompt switches', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    assert.equal((await send({ text: 'first' })).status, 200);
    assert.equal((await send({ text: 'second' })).status, 200);
    qaSpent = true;
    assert.equal((await send({ text: 'second' })).status, 429, 'the second conversation records the rejection upstream');
    assert.deepEqual(seen, ['qa', 'qa', 'qa']);

    const stopped = await send({ text: 'first' });
    assert.equal(stopped.status, 429, 'the first conversation gets its own pre-send offer');
    assert.match(stopped.json?.error?.message ?? '', /next prompt confirms/);
    assert.deepEqual(seen, ['qa', 'qa', 'qa'], 'the recorded rejection went upstream again');
    assert.equal((await send({ text: 'first' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qa', 'qb']);
  });
});

test('a quota failure on the continuation destination needs another confirmation before the third account', async () => {
  let qaSpent = false;
  let qbSpent = false;
  await withGateway({ handler: (who, res) => ((who === 'qa' && qaSpent) || (who === 'qb' && qbSpent) ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    assert.equal((await send({ text: 'hello' })).status, 429);
    qbSpent = true;
    const second = await send({ text: 'hello' });
    assert.equal(second.status, 429);
    assert.match(second.json?.error?.message ?? '', /account "qb", pinned to this conversation/);
    assert.match(second.json?.error?.message ?? '', /currently "qc"/);
    assert.deepEqual(seen, ['qa', 'qa', 'qb'], 'the second quota failure walked silently to qc');
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qc']);
  });
});

test('another client with the same session and opening cannot consume the continuation', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    assert.equal((await send({ text: 'hello' })).status, 429);
    const other = await send({ key: KEYS.carol, text: 'hello' });
    assert.equal(other.status, 429, 'the other client gets its own offer, not amy\'s continuation');
    assert.deepEqual(seen, ['qa', 'qa']);
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb'], 'an unassigned account was used');
  });
});

test('force retries the first upstream quota failure on the sibling with the identical body', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen, attempts }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const forced = await send({ text: 'hello', policy: '*=recommend,s1=force' });
    assert.equal(forced.status, 200);
    assert.equal(forced.raw, okBody);
    assert.equal(forced.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qb;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
    assert.equal(attempts[1].body, attempts[2].body, 'force changed the conversation body');
    assert.equal(attempts[2].headers['x-teamclaude-seat-policy'], undefined, 'the policy header reached upstream');
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qb'], 'force did not leave the conversation pinned to qb');
  });
});

test('force preserves a successful SSE response byte-for-byte', async () => {
  let qaSpent = false;
  const sse = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n'
    + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\n\n'
    + 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
    + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  await withGateway({ handler: (who, res) => {
    if (who === 'qa' && qaSpent) { spent(res); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse);
  } }, async ({ send }) => {
    const first = await send({ text: 'hello' });
    assert.equal(first.raw, sse);
    qaSpent = true;
    const forced = await send({ text: 'hello', policy: 's1=force' });
    assert.equal(forced.status, 200);
    assert.equal(forced.raw, sse, 'the continuation changed the SSE bytes');
    assert.equal(forced.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qb;cold-cache=true');
  });
});

test('pre-send force does not consume an older recommend offer', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen, am }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    assert.equal((await send({ text: 'hello' })).status, 429, 'recommend records the offer');
    am.sessionTracker.takeSeatContinuation = () => { throw new Error('force consumed the old offer'); };
    assert.equal((await send({ text: 'hello', policy: 's1=force' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
  });
});

test('mixed policies stop at a recommend destination until its own confirmation', async () => {
  let qaSpent = false;
  let qbSpent = false;
  await withGateway({ handler: (who, res) => ((who === 'qa' && qaSpent) || (who === 'qb' && qbSpent) ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    const policy = '*=recommend,s1=force,s2=recommend,s3=force';
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    qbSpent = true;
    const stopped = await send({ text: 'hello', policy });
    assert.equal(stopped.status, 429);
    assert.match(stopped.json?.error?.message ?? '', /account "qb", pinned to this conversation/);
    assert.match(stopped.json?.error?.message ?? '', /currently "qc"/);
    assert.deepEqual(seen, ['qa', 'qa', 'qb'], 'A force leaked past B recommend to C');
    assert.equal((await send({ text: 'hello', policy })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qc']);
  });
});

test('all-force walks only the assigned route and preserves every body', async () => {
  let qaSpent = false;
  let qbSpent = false;
  await withGateway({ handler: (who, res) => ((who === 'qa' && qaSpent) || (who === 'qb' && qbSpent) ? spent(res) : ok(res)) }, async ({ send, seen, attempts }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    qbSpent = true;
    const forced = await send({ text: 'hello', policy: '*=force' });
    assert.equal(forced.status, 200);
    assert.equal(forced.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qc;cold-cache=true');
    assert.deepEqual(seen, ['qa', 'qa', 'qb', 'qc']);
    assert.ok(attempts.every(a => a.body === attempts[0].body), 'a force hop changed the body');
    assert.ok(!seen.includes('qr'), 'an unassigned account was used');
  });
});

test('non-quota failures stay on the bound account and internal headers cannot be spoofed', async () => {
  let fail = false;
  await withGateway({ handler: (who, res) => {
    if (who === 'qa' && fail) {
      res.writeHead(500, { 'content-type': 'application/json', 'x-teamclaude-seat-failover': 'spoof', 'x-teamclaude-seat-policy': 'spoof' });
      res.end('{"type":"error","error":{"type":"api_error","message":"no"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-teamclaude-seat-failover': 'spoof', 'x-teamclaude-seat-policy': 'spoof' });
    res.end(okBody);
  } }, async ({ send, seen }) => {
    const first = await send({ text: 'hello' });
    assert.equal(first.headers.get('x-teamclaude-seat-failover'), null);
    assert.equal(first.headers.get('x-teamclaude-seat-policy'), null);
    fail = true;
    const failed = await send({ text: 'hello', policy: '*=force' });
    assert.equal(failed.status, 500);
    assert.deepEqual(seen, ['qa', 'qa'], 'a 500 moved a force conversation to another account');
  });
});

test('a bound credential failure is a seat error, not a login failure or a sibling hop', async () => {
  let denied = false;
  await withGateway({ handler: (who, res) => {
    if (who === 'qa' && denied) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"permission_error","message":"denied"}}');
    } else ok(res);
  } }, async ({ send, seen }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    denied = true;
    const failed = await send({ text: 'hello', policy: '*=force' });
    assert.equal(failed.status, 503);
    assert.match(failed.json?.error?.message ?? '', /seat "s1\+s2\+s3" is unavailable/);
    assert.deepEqual(seen, ['qa', 'qa']);
  });
});

test('a single-account seat is unchanged: spent is a hard stop with no queue hint', async () => {
  await withGateway({ handler: (_who, res) => spent(res) }, async ({ send }) => {
    const r = await send({ key: KEYS.ben });
    assert.equal(r.status, 429);
    const msg = r.json?.error?.message ?? '';
    assert.ok(msg.includes('out of quota'), msg);
    assert.ok(!msg.includes('pinned to'), `a single-seat stop must not name a queue: ${msg}`);
    const forced = await send({ key: KEYS.ben, policy: '*=force' });
    assert.equal(forced.status, 429, 'force cannot invent a sibling for a single-account route');
    assert.ok(forced.headers.get('anthropic-ratelimit-unified-7d-reset'), 'the ordinary spent headers are retained');
  });
});
