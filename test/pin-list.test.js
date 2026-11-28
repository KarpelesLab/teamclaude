import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyRequestListener, createProxyServer, resolvePinList } from '../src/server.js';

// A pin may name several API-key accounts, in order (`TC_ACCT=a,b,c`, which in
// MITM mode is the proxy URL's username). The first one serves; when upstream
// billing refuses it (no API credit left), that request moves to the next
// listed API-key account, and later requests skip a listed account while its
// billing cooldown lasts. Nothing else moves along the list: not another
// refusal, not a response that has started, never a subscription. A list
// headed by a subscription is covered at the end of this file. A pin that
// names one account behaves exactly as before. The CONNECT side of the pin is
// in mitm-pin.test.js.

const LOW_CREDIT = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  },
};
const PINNED_UNAVAILABLE = {
  type: 'error',
  error: { type: 'rate_limit_error', message: 'Pinned account is unavailable (rate-limited, errored, or already tried). Retry shortly.' },
};
// API-key accounts kept out of rotation and reached only through a pin, the
// setup a list is for.
const credit = (name, extra = {}) => ({ name, type: 'apikey', apiKey: `key-${name}`, priority: 100, disabled: true, ...extra });
const plan = {
  name: 'plan', type: 'oauth', accessToken: 'plan-token',
  expiresAt: Date.now() + 3600_000, allowExtraUsage: true,
};

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// What each account's credential gets back: `depleted` names the ones upstream
// billing refuses; every other one is served, and the answer names it.
const billing = (depleted) => (req, res) => {
  const key = req.headers['x-api-key'] || req.headers.authorization;
  if (depleted.has(key)) json(res, 400, LOW_CREDIT);
  else json(res, 200, { ok: true, key });
};
const served = (key) => ({ status: 200, body: { ok: true, key } });

async function withUpstream(reply, run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    seen.push(req.headers['x-api-key'] || req.headers.authorization);
    reply(req, res);
  });
  const upstreamPort = await listen(upstream);
  try {
    await run({ seen, url: `http://127.0.0.1:${upstreamPort}` });
  } finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
}

async function post(url, body = { model: 'claude-opus-5', max_tokens: 1, messages: [] }) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// The listener a pinned MITM tunnel feeds, minus the TLS: createConnectHandler
// hands it the CONNECT username as `forcedPin`, as here.
async function withPin(accounts, pin, reply, run, amOptions = {}) {
  await withUpstream(reply, async ({ seen, url }) => {
    const am = new AccountManager(accounts, 0.98, amOptions);
    am._nextProbeAt = Date.now() + 60_000;
    const proxy = http.createServer(createProxyRequestListener({ accountManager: am, upstream: url, config: { upstream: url }, forcedPin: pin }));
    const port = await listen(proxy);
    try {
      await run({ am, seen, port, post: () => post(`http://127.0.0.1:${port}/v1/messages`) });
    } finally {
      proxy.closeAllConnections();
      await new Promise(resolve => proxy.close(resolve));
    }
  });
}

test('resolvePinList: one name as before, or every name of a list in order', () => {
  const am = new AccountManager([credit('a'), credit('b'), credit('c (Acme, Inc.)'), plan], 0.98);
  assert.deepEqual(resolvePinList(am, 'b'), [1]);
  assert.deepEqual(resolvePinList(am, 'b,a'), [1, 0]);
  assert.deepEqual(resolvePinList(am, ' a , b '), [0, 1]);
  assert.deepEqual(resolvePinList(am, 'a,b,a'), [0, 1]);
  // A name with a comma in it is still that one account.
  assert.deepEqual(resolvePinList(am, 'c (Acme, Inc.)'), [2]);
  // Every name has to match: a list with a typo in it is refused whole.
  assert.equal(resolvePinList(am, 'a,ghost'), null);
  assert.equal(resolvePinList(am, 'a,'), null);
  assert.equal(resolvePinList(am, 'ghost'), null);
  assert.equal(resolvePinList(am, ''), null);
});

test('a list pin moves a billing-refused request to the next listed API-key account', async () => {
  await withPin([plan, credit('a'), credit('b')], 'a,b', billing(new Set(['key-a'])), async ({ am, seen, post }) => {
    assert.deepEqual(await post(), served('key-b'));
    assert.deepEqual(seen, ['key-a', 'key-b']);
    assert.ok(am.accounts[1].billingRejectedUntil > Date.now());
  });
});

// The move is named once, beside the refusal, by the request that was refused.
test('a billing move is named once in the log, from the account refused to the one moved to', async t => {
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(String(args[0])); });
  await withPin([plan, credit('a'), credit('b')], 'a,b', billing(new Set(['key-a'])), async ({ post }) => {
    assert.deepEqual(await post(), served('key-b'));
  });
  assert.deepEqual(lines.filter(l => l.includes('refused for billing; this request moves')),
    ['[TeamClaude] Pinned account "a" refused for billing; this request moves to "b", the next account its pin names']);
});

test('later requests skip listed accounts while their billing cooldown lasts, then try them again', async () => {
  const depleted = new Set(['key-a', 'key-b']);
  await withPin([plan, credit('a'), credit('b'), credit('c')], 'a,b,c', billing(depleted), async ({ am, seen, post }) => {
    assert.deepEqual(await post(), served('key-c'));
    assert.deepEqual(seen, ['key-a', 'key-b', 'key-c']);
    assert.deepEqual(await post(), served('key-c'));
    assert.deepEqual(seen.slice(3), ['key-c']);

    // The first account's cooldown is over and its credit is still spent: one
    // refusal, and on past the second, which is still cooling.
    am.accounts[1].billingRejectedUntil = Date.now() - 1;
    assert.deepEqual(await post(), served('key-c'));
    assert.deepEqual(seen.slice(4), ['key-a', 'key-c']);

    // Credit bought: the first account serves again.
    am.accounts[1].billingRejectedUntil = Date.now() - 1;
    depleted.delete('key-a');
    assert.deepEqual(await post(), served('key-a'));
    assert.deepEqual(seen.slice(6), ['key-a']);
  });
});

test('a list whose every account billing refuses ends as a pin to its last account does', async () => {
  await withPin([plan, credit('a'), credit('b')], 'a,b', billing(new Set(['key-a', 'key-b'])), async ({ seen, post }) => {
    assert.deepEqual(await post(), { status: 429, body: PINNED_UNAVAILABLE });
    assert.deepEqual(seen, ['key-a', 'key-b']);
  });
});

const BILLING_REFUSED = {
  type: 'error',
  error: { type: 'billing_error', message: 'Upstream billing refused every eligible account. Check billing or purchase credits; TeamClaude retries after the billing cooldown.' },
};

for (const [pin, sent, expected] of [
  ['a,plan', ['key-a'], { status: 429, body: PINNED_UNAVAILABLE }],
  ['a,plan,b', ['key-a', 'key-b'], served('key-b')],
  // Nor away from one: a subscription at the head of a list stays a plain pin.
  ['plan,a', ['Bearer plan-token'], { status: 402, body: BILLING_REFUSED }],
]) {
  test(`a list never moves to or from a subscription (${pin})`, async () => {
    await withPin([plan, credit('a'), credit('b')], pin, billing(new Set(['key-a', 'Bearer plan-token'])), async ({ seen, post }) => {
      assert.deepEqual(await post(), expected);
      assert.deepEqual(seen, sent);
    });
  });
}

// A pin to a capped account gets the exhausted answer, and an account of
// another provider cannot take an Anthropic request, so the move passes both by.
for (const [skipped, label] of [
  [credit('b', { maxUsage: 0.5 }), 'at its usage cap'],
  [credit('b', { provider: 'codex', upstream: 'http://127.0.0.1:9' }), 'of another provider'],
]) {
  test(`the move passes over a listed account ${label}`, async () => {
    await withPin([plan, credit('a'), skipped, credit('c')], 'a,b,c', billing(new Set(['key-a'])), async ({ am, seen, post }) => {
      Object.assign(am.accounts[2].quota, { unified7d: 0.9, unified7dReset: Date.now() + 86_400_000 });
      assert.deepEqual(await post(), served('key-c'));
      assert.deepEqual(seen, ['key-a', 'key-c']);
    });
  });
}

// Removing an account renumbers the rest in place (removeAccount), and the
// first account's round trip is a wait like any other. The list was held as
// indices, so the walk read whichever accounts then sat in those places: here
// the request was sent to y, an account its pin does not name.
const removingOnFirst = (box, name) => (req, res) => {
  const key = req.headers['x-api-key'] || req.headers.authorization;
  if (key !== 'key-a') return json(res, 200, { ok: true, key });
  box.am.removeAccount(box.am.accounts.findIndex(a => a.name === name));
  json(res, 400, LOW_CREDIT);
};

test('a list pin moves to the next listed account when another is removed during the refused request', async () => {
  const box = {};
  await withPin([plan, credit('x'), credit('a'), credit('y'), credit('b')], 'a,b', removingOnFirst(box, 'x'), async ({ am, seen, post }) => {
    box.am = am;
    assert.deepEqual(await post(), served('key-b'));
    assert.deepEqual(seen, ['key-a', 'key-b']);
  });
});

// A listed account removed meanwhile is passed over like one that cannot take
// the request.
test('a list pin passes over a listed account removed during the refused request', async () => {
  const box = {};
  await withPin([plan, credit('a'), credit('x'), credit('b')], 'a,x,b', removingOnFirst(box, 'x'), async ({ am, seen, post }) => {
    box.am = am;
    assert.deepEqual(await post(), served('key-b'));
    assert.deepEqual(seen, ['key-a', 'key-b']);
  });
});

// The move holds for the rest of the request: an answer after it is the answer
// of the account moved to. b refuses the key, and the request ends on that
// refusal, not on a's billing.
test('after a billing move the request ends on the account it moved to', async () => {
  const forbidden = { type: 'error', error: { type: 'permission_error', message: 'Request not allowed' } };
  await withPin([plan, credit('a'), credit('b')], 'a,b', (req, res) => {
    if (req.headers['x-api-key'] === 'key-a') return json(res, 400, LOW_CREDIT);
    json(res, 403, forbidden);
  }, async ({ seen, post }) => {
    const { status, body } = await post();
    assert.equal(status, 502, `answered ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.error.type, 'proxy_error');
    assert.deepEqual(seen, ['key-a', 'key-b']);
  });
});

// The first account in the fleet sits at index 0, a listed account like any
// other (one that has left reads -1).
test('a list pin moves to a listed account that is first in the fleet', async () => {
  await withPin([credit('b'), plan, credit('a')], 'a,b', billing(new Set(['key-a'])), async ({ seen, post }) => {
    assert.deepEqual(await post(), served('key-b'));
    assert.deepEqual(seen, ['key-a', 'key-b']);
  });
});

test('only a billing refusal moves along the list: another 400 goes to the client', async () => {
  const invalid = { type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } };
  await withPin([plan, credit('a'), credit('b')], 'a,b', (_req, res) => json(res, 400, invalid), async ({ seen, post }) => {
    assert.deepEqual(await post(), { status: 400, body: invalid });
    assert.deepEqual(seen, ['key-a']);
  });
});

// Upstream cuts the first account off while its answer is streaming. The client
// has its headers and its first event, so this request has nowhere to go; the
// client's own retry is a new request, and that one moves on.
test('nothing moves once the response has started reaching the client', async () => {
  let streaming = null;
  let refuse = false;
  await withPin([credit('a'), credit('b')], 'a,b', (req, res) => {
    if (req.headers['x-api-key'] !== 'key-a') return json(res, 200, { ok: true, key: req.headers['x-api-key'] });
    if (refuse) return json(res, 400, LOW_CREDIT);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    streaming = res;
  }, async ({ seen, port, post }) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 1, stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
    const first = await reader.read();
    assert.match(Buffer.from(/** @type {Uint8Array} */ (first.value)).toString('utf8'), /message_start/);

    refuse = true;
    streaming.destroy();
    let rest = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += Buffer.from(value).toString('utf8');
      }
    } catch { /* the stream broke off, as upstream's did */ }
    assert.doesNotMatch(rest, /key-b/);
    assert.deepEqual(seen, ['key-a']);

    assert.deepEqual(await post(), served('key-b'));
    assert.deepEqual(seen, ['key-a', 'key-a', 'key-b']);
  });
});

test('a single-name pin is unchanged: it never moves, and its cooldown does not skip it', async () => {
  await withPin([plan, credit('a'), credit('b')], 'a', billing(new Set(['key-a'])), async ({ seen, post }) => {
    assert.deepEqual(await post(), { status: 429, body: PINNED_UNAVAILABLE });
    assert.deepEqual(await post(), { status: 429, body: PINNED_UNAVAILABLE });
    assert.deepEqual(seen, ['key-a', 'key-a']);
  });
});

test('a single name with a comma in it still pins that one account', async () => {
  await withPin([credit('ops'), credit('ops (Acme, Inc.)', { disabled: false })], 'ops (Acme, Inc.)', billing(new Set()), async ({ seen, post }) => {
    assert.deepEqual(await post(), served('key-ops (Acme, Inc.)'));
    assert.deepEqual(seen, ['key-ops (Acme, Inc.)']);
  });
});

test('a list with a name that matches no account is refused, and nothing is sent', async () => {
  await withPin([credit('a'), credit('b')], 'a,ghost', billing(new Set()), async ({ seen, post }) => {
    const { status, body } = await post();
    assert.equal(status, 404);
    assert.equal(body.error.type, 'not_found_error');
    assert.deepEqual(seen, []);
  });
});

// `TC_ACCT` under --no-mitm travels as the `/tc-acct/` path prefix, so a list
// works there too.
test('a list in the /tc-acct/ prefix moves on a billing refusal the same way', async () => {
  await withUpstream(billing(new Set(['key-a'])), async ({ seen, url }) => {
    const am = new AccountManager([plan, credit('a'), credit('b')], 0.98);
    am._nextProbeAt = Date.now() + 60_000;
    const proxy = createProxyServer(am, { proxy: { apiKey: 'test' }, upstream: url });
    const port = await listen(proxy);
    try {
      assert.deepEqual(await post(`http://127.0.0.1:${port}/tc-acct/a,b/v1/messages`), served('key-b'));
      assert.deepEqual(seen, ['key-a', 'key-b']);
    } finally {
      proxy.closeAllConnections();
      await new Promise(resolve => proxy.close(resolve));
    }
  });
});

// A list that names subscriptions of one provider is the same idea for quota
// instead of credit: the request goes to the first listed subscription that
// can serve it, preferring one under its switch threshold, and moves on when
// upstream says a quota window is spent. Never to an account the list does not
// name, and never to an API key it does name.

const sub = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: `tok-${name}`, expiresAt: Date.now() + 3600_000, ...extra,
});
const QUOTA_SPENT = {
  'retry-after': '3600',
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-5h-status': 'rejected',
  'anthropic-ratelimit-unified-5h-utilization': '1.0',
};
const RATE_LIMITED = { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } };
// `spent` names the subscriptions whose quota upstream rejects; every other
// one is served, and the answer names its token.
const quota = (spent) => (req, res) => {
  const token = req.headers.authorization;
  if (spent.has(token)) {
    res.writeHead(429, { 'content-type': 'application/json', ...QUOTA_SPENT });
    return res.end(JSON.stringify(RATE_LIMITED));
  }
  json(res, 200, { ok: true, key: token });
};
const weekly = (am, i, used) => Object.assign(am.accounts[i].quota, { unified7d: used, unified7dReset: Date.now() + 86_400_000 });

test('a subscription list moves a quota-rejected request to the next listed subscription', async () => {
  const spent = new Set(['Bearer tok-b']);
  await withPin([sub('a'), sub('b'), sub('c')], 'b,c', quota(spent), async ({ am, seen, post }) => {
    assert.deepEqual(await post(), served('Bearer tok-c'));
    assert.deepEqual(seen, ['Bearer tok-b', 'Bearer tok-c']);
    // b is held for its reset now, so the next request goes straight to c.
    assert.deepEqual(await post(), served('Bearer tok-c'));
    assert.deepEqual(seen.slice(2), ['Bearer tok-c']);
    // Once b's window is back, it serves first again.
    spent.delete('Bearer tok-b');
    am.clearRateLimited(1);
    Object.assign(am.accounts[1].quota, { unified5h: 0.1, unifiedStatus: 'allowed' });
    assert.deepEqual(await post(), served('Bearer tok-b'));
  });
});

test('a subscription list prefers the first listed account under its switch threshold', async () => {
  await withPin([sub('a'), sub('b'), sub('c')], 'b,c', quota(new Set()), async ({ am, seen, post }) => {
    weekly(am, 1, 0.99);
    assert.deepEqual(await post(), served('Bearer tok-c'));
    assert.deepEqual(seen, ['Bearer tok-c']);
  });
});

// The threshold is a preference: when every listed account is past it, the
// list still serves from the first one that has quota, as a one-name pin does,
// and an unlisted account with room does not take it.
test('a subscription list spends past the switch threshold before giving up, inside the list only', async () => {
  await withPin([sub('a'), sub('b', { maxUsage: 0.9 }), sub('c'), sub('d')], 'b,c,d', quota(new Set()), async ({ am, seen, post }) => {
    weekly(am, 1, 0.95);
    weekly(am, 2, 0.99);
    weekly(am, 3, 0.985);
    // b is at its hard cap, c and d are only past the soft threshold.
    assert.deepEqual(await post(), served('Bearer tok-c'));
    assert.deepEqual(seen, ['Bearer tok-c']);
  });
});

test('a subscription list that is spent ends as a pin does; an unlisted account is never used', async () => {
  await withPin([sub('a'), sub('b'), sub('c')], 'b,c', quota(new Set(['Bearer tok-b', 'Bearer tok-c'])), async ({ seen, post }) => {
    const { status } = await post();
    assert.equal(status, 429);
    assert.deepEqual(seen, ['Bearer tok-b', 'Bearer tok-c']);
  });
});

// The accounts a list is for are often kept out of rotation; a listed one
// serves while disabled or cordoned, as a one-name pin does.
test('a subscription list serves listed accounts that rotation leaves alone', async () => {
  await withPin([sub('a'), sub('b', { disabled: true }), sub('c', { cordoned: true })], 'b,c', quota(new Set(['Bearer tok-b'])), async ({ seen, post }) => {
    assert.deepEqual(await post(), served('Bearer tok-c'));
    assert.deepEqual(seen, ['Bearer tok-b', 'Bearer tok-c']);
  });
});

test('a one-name subscription pin still never moves on a quota rejection', async () => {
  await withPin([sub('a'), sub('b')], 'b', quota(new Set(['Bearer tok-b'])), async ({ seen, post }) => {
    const { status } = await post();
    assert.equal(status, 429);
    assert.deepEqual(seen, ['Bearer tok-b']);
  });
});

// A retry on the same account is not a reason to leave it: a transient 429
// that also reports the account past its threshold is retried where it was, as
// a pin to that account would, and the next listed one never sees it.
test('a subscription list keeps a request on its account through a transient 429', async () => {
  let throttled = 1;
  await withPin([sub('a'), sub('b'), sub('c')], 'b,c', (req, res) => {
    const token = req.headers.authorization;
    if (token === 'Bearer tok-b' && throttled-- > 0) {
      res.writeHead(429, {
        'content-type': 'application/json', 'retry-after': '1',
        'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.99',
      });
      return res.end(JSON.stringify(RATE_LIMITED));
    }
    json(res, 200, { ok: true, key: token });
  }, async ({ seen, post }) => {
    await post();
    assert.ok(!seen.includes('Bearer tok-c'), `sent to ${seen.join(', ')}`);
    assert.equal(seen[0], 'Bearer tok-b');
  });
});

// Past the threshold is spendable; a window that reads spent is not.
test('a subscription list does not spend past the threshold on an account whose window is spent', async () => {
  await withPin([sub('a'), sub('b'), sub('c')], 'b,c', quota(new Set()), async ({ am, seen, post }) => {
    Object.assign(am.accounts[1].quota, { unified5h: 1, unified5hReset: Date.now() + 3600_000 });
    weekly(am, 2, 0.99);
    assert.deepEqual(await post(), served('Bearer tok-c'));
    assert.deepEqual(seen, ['Bearer tok-c']);
  });
});

test('a subscription list moves on from an account whose expired token could not be renewed', async () => {
  const expired = { refreshToken: 'r', expiresAt: Date.now() - 1000 };
  await withPin([sub('a'), sub('b', expired), sub('c')], 'b,c', quota(new Set()), async ({ seen, post }) => {
    assert.deepEqual(await post(), served('Bearer tok-c'));
    assert.deepEqual(seen, ['Bearer tok-c']);
  }, { refreshFn: async () => { throw Object.assign(new Error('refresh 503'), { status: 503 }); } });
});

test('a subscription list moves on from an account removed while its token was renewed', async () => {
  const box = {};
  const expired = { refreshToken: 'r', expiresAt: Date.now() - 1000 };
  await withPin([sub('a'), sub('b', expired), sub('c')], 'b,c', quota(new Set()), async ({ am, seen, post }) => {
    box.am = am;
    assert.deepEqual(await post(), served('Bearer tok-c'));
    assert.deepEqual(seen, ['Bearer tok-c']);
  }, {
    refreshFn: async () => {
      box.am.removeAccount(box.am.accounts.findIndex(a => a.name === 'b'));
      return { accessToken: 'tok-b2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 };
    },
  });
});

// Under advisorEligibility "prefer" the advisor is a preference. When its
// family cap bars every listed account, the list is read again by the main
// model, as rotation is, so a first listed account whose window reads spent is
// passed over for the next one.
test('a subscription list under advisor "prefer" picks by the main model when the advisor bars every listed account', async () => {
  const caps = { maxUsage: { unified7dFable: 0.7 } };
  await withPin([sub('a'), sub('b', caps), sub('c', caps)], 'b,c', quota(new Set()), async ({ am, seen, port }) => {
    for (const i of [1, 2]) {
      Object.assign(am.accounts[i].quota, {
        unified7d: 0.2, unified7dReset: Date.now() + 86_400_000,
        unified7dFable: 0.75, unified7dFableReset: Date.now() + 86_400_000,
      });
    }
    Object.assign(am.accounts[1].quota, { unified5h: 1, unified5hReset: Date.now() + 3600_000 });
    const body = {
      model: 'claude-opus-5', max_tokens: 1, messages: [],
      tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-fable-5-1' }],
    };
    assert.deepEqual(await post(`http://127.0.0.1:${port}/v1/messages`, body), served('Bearer tok-c'));
    assert.deepEqual(seen, ['Bearer tok-c']);
  }, { advisorEligibility: 'prefer' });
});
