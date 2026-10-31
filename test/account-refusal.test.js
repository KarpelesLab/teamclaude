import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, exhaustedMessage } from '../src/server.js';
import { accountRefusal } from '../src/account-refusal.js';
import { unavailableLine } from '../src/status-renderer.js';

// Upstream refuses some accounts outright: an identity check, a hold, a disabled
// organization. Retrying another request on the same account cannot succeed, so
// the account leaves rotation and status says why, in upstream's own words.

const HOUR = 3600_000;
const paint = new Proxy({}, { get: () => (v => String(v)) });

function errorBody(type, message, code) {
  return JSON.stringify({
    type: 'error',
    error: { type, message, ...(code ? { details: { error_code: code } } : {}) },
    request_id: 'req_test',
  });
}

const KYC_MESSAGE = 'Identity verification is required to keep using Claude. Verify at https://claude.ai/settings/verify.';
const HOLD_MESSAGE = "Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted";

test('accountRefusal classifies account-level refusals and nothing else', () => {
  const cases = [
    // The structured form: error.details.error_code.
    [403, errorBody('permission_error', KYC_MESSAGE, 'verification_required'),
      { code: 'verification_required', message: KYC_MESSAGE, link: 'https://claude.ai/settings/verify' }],
    [403, errorBody('permission_error', HOLD_MESSAGE, 'account_on_hold'),
      { code: 'account_on_hold', message: HOLD_MESSAGE, link: 'https://claude.ai/restricted' }],
    [403, errorBody('permission_error', 'This organization is on hold.', 'organization_on_hold'),
      { code: 'organization_on_hold', message: 'This organization is on hold.', link: null }],
    [400, errorBody('invalid_request_error', 'This organization has been disabled.', 'organization_disabled'),
      { code: 'organization_disabled', message: 'This organization has been disabled.', link: null }],
    [403, errorBody('permission_error', 'Not available from this endpoint.', 'restricted_regime_endpoint'),
      { code: 'restricted_regime_endpoint', message: 'Not available from this endpoint.', link: null }],
    [403, errorBody('permission_error', 'Your IP is not allowed. See https://platform.claude.com/settings/network', 'ip_not_in_allowed_range'),
      { code: 'ip_not_in_allowed_range', message: 'Your IP is not allowed. See https://platform.claude.com/settings/network', link: 'https://platform.claude.com/settings/network' }],
    [403, errorBody('permission_error', 'Verify (https://portal.anthropic.com/verify)', 'verification_required'),
      { code: 'verification_required', message: 'Verify (https://portal.anthropic.com/verify)', link: 'https://portal.anthropic.com/verify' }],
    // The older form: a 400 with only the message.
    [400, errorBody('invalid_request_error', 'This organization has been disabled.'),
      { code: 'organization_disabled', message: 'This organization has been disabled.', link: null }],
    [400, errorBody('invalid_request_error', 'Identity verification is required to continue.'),
      { code: 'verification_required', message: 'Identity verification is required to continue.', link: null }],
    // A link is taken only from an Anthropic host, over https.
    [403, errorBody('permission_error', 'Verify at https://claude.ai.example.com/verify', 'verification_required'),
      { code: 'verification_required', message: 'Verify at https://claude.ai.example.com/verify', link: null }],
    [403, errorBody('permission_error', 'Verify at https://example.com/claude.ai', 'verification_required'),
      { code: 'verification_required', message: 'Verify at https://example.com/claude.ai', link: null }],
    [403, errorBody('permission_error', 'Verify at http://claude.ai/verify', 'verification_required'),
      { code: 'verification_required', message: 'Verify at http://claude.ai/verify', link: null }],
    // Not account refusals.
    [403, errorBody('permission_error', 'OAuth authentication is currently not allowed for this organization.', 'oauth_not_allowed_for_organization'), null],
    [403, errorBody('permission_error', 'Request not allowed'), null],
    // The older messages count only as a 400 that carries no code at all.
    [403, errorBody('permission_error', 'This organization has been disabled.'), null],
    [400, errorBody('invalid_request_error', 'Identity verification is required to continue.', 'oauth_not_allowed_for_organization'), null],
    [401, errorBody('authentication_error', KYC_MESSAGE, 'verification_required'), null],
    [400, errorBody('invalid_request_error', 'messages: Field required'), null],
    [400, errorBody('invalid_request_error', "messages.0.content: unexpected text 'This organization has been disabled.'"), null],
    [400, '<html>Bad Request</html>', null],
    [400, null, null],
  ];
  for (const [status, body, expected] of cases) {
    assert.deepEqual(accountRefusal(status, body == null ? null : Buffer.from(body)), expected, `${status} ${body}`);
  }
});

test('a long refusal is kept whole, link included', () => {
  const message = `${'Your account needs attention. '.repeat(12)}Verify at https://claude.ai/settings/verify`;
  const refusal = accountRefusal(403, Buffer.from(errorBody('permission_error', message, 'verification_required')));
  assert.equal(refusal?.message, message);
  assert.equal(refusal?.link, 'https://claude.ai/settings/verify');
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function post(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  return { status: res.status, body: await res.text() };
}

// `a-token` gets `refusal` ({ status, body, delayMs, contentType, hold }); every
// other token is served. A held answer stays open until `release()`.
function refusingUpstream(refusal) {
  const seen = [];
  /** @type {http.ServerResponse[]} */
  const held = [];
  const server = http.createServer(async (req, res) => {
    const token = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer /, '');
    seen.push(token);
    if (token === 'a-token') {
      if (refusal.delayMs) await new Promise(resolve => setTimeout(resolve, refusal.delayMs));
      res.writeHead(refusal.status, { 'content-type': refusal.contentType ?? 'application/json' });
      if (refusal.hold) { res.write(refusal.body); held.push(res); return; }
      res.end(refusal.body);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return { server, seen, release: () => held.forEach(res => res.end()) };
}

function accounts(over = {}) {
  return [
    { name: 'a', type: 'oauth', accessToken: 'a-token', refreshToken: 'ra', expiresAt: Date.now() + HOUR, ...over },
    { name: 'b', type: 'oauth', accessToken: 'b-token', refreshToken: 'rb', expiresAt: Date.now() + HOUR },
  ];
}

async function withProxy(refusal, am, fn) {
  const { server: upstream, seen, release } = refusingUpstream(refusal);
  /** @type {http.Server|undefined} */
  let proxy;
  try {
    const upstreamPort = await listen(upstream);
    proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
    await fn(await listen(proxy), seen, release);
  } finally {
    proxy?.close();
    proxy?.closeAllConnections();
    release();
    upstream.close();
    upstream.closeAllConnections();
  }
}

for (const [status, body, code, link, contentType] of [
  [403, errorBody('permission_error', KYC_MESSAGE, 'verification_required'), 'verification_required', 'https://claude.ai/settings/verify'],
  [400, errorBody('invalid_request_error', 'This organization has been disabled.'), 'organization_disabled', null],
  [400, errorBody('permission_error', HOLD_MESSAGE, 'account_on_hold'), 'account_on_hold', 'https://claude.ai/restricted', 'Application/JSON; charset=utf-8'],
]) {
  test(`a ${status} ${code} (${contentType ?? 'application/json'}) takes the account out of rotation and the request fails over`, async () => {
    let refreshes = 0;
    const am = new AccountManager(accounts(), 0.98, { refreshFn: async () => { refreshes++; throw new Error('must not refresh'); } });
    await withProxy({ status, body, contentType }, am, async (port, seen) => {
      const first = await post(port);
      assert.equal(first.status, 200);
      assert.deepEqual(seen, ['a-token', 'b-token']);

      const row = am.getStatus().accounts[0];
      assert.equal(row.status, 'error');
      assert.equal(row.errorReason.code, code);
      assert.equal(row.errorReason.detail, JSON.parse(body).error.message);
      assert.equal(row.errorReason.link, link);
      assert.equal(row.errorReason.remedy, 'teamclaude login');

      am.currentIndex = 0;
      assert.equal((await post(port)).status, 200);
      assert.deepEqual(seen, ['a-token', 'b-token', 'b-token'], 'the refused account is not asked again');
      assert.equal(refreshes, 0, 'a refusal is not a token problem');
    });
  });
}

// The 400 is read before it is relayed, so the relay must still carry every
// byte, including past the size the classifier reads.
for (const size of [0, 1024 * 1024]) {
  test(`an ordinary 400 (${size ? 'large' : 'small'}) still reaches the client unchanged`, async () => {
    const body = errorBody('invalid_request_error', `messages: Field required${' '.repeat(size)}`);
    const am = new AccountManager(accounts(), 0.98);
    await withProxy({ status: 400, body }, am, async (port, seen) => {
      const res = await post(port);
      assert.equal(res.status, 400);
      assert.equal(res.body, body);
      assert.deepEqual(seen, ['a-token']);
      assert.equal(am.getStatus().accounts[0].status, 'active');
    });
  });
}

test('requests queued on an account fail over once another request finds it refused', async () => {
  const am = new AccountManager(accounts(), 0.98, {
    // A cap that cannot step during the test, however slow the first request.
    // The window stays short: a waiter left in admit() polls until it ends,
    // and an hour-long one keeps the test process alive past its timeout.
    ramp: { enabled: true, startConc: 1, stepConc: 1, stepMs: 3_600_000, windowMs: 30_000, pollMs: 5 },
  });
  am.accounts[0].rampStartedAt = Date.now();
  const body = errorBody('permission_error', KYC_MESSAGE, 'verification_required');
  await withProxy({ status: 403, body, delayMs: 30 }, am, async (port, seen) => {
    const [first, second] = await Promise.all([post(port), post(port)]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(seen.filter(token => token === 'a-token').length, 1);
    assert.equal(seen.filter(token => token === 'b-token').length, 2);
  });
});

// A refresh can be in flight when the refusal lands, or fail just before it.
// Either way the refusal is what the owner has to resolve, so status keeps it.
for (const order of ['refusal first', 'refresh first']) {
  test(`a rejected refresh token does not hide the refusal (${order})`, async () => {
    /** @type {(err: Error) => void} */
    let reject = () => {};
    const am = new AccountManager(accounts(), 0.98, {
      refreshFn: () => new Promise((_, no) => { reject = no; }),
    });
    const refresh = am.ensureTokenFresh(0, true);
    const refuse = () => am.markRefused(am.accounts[0], { code: 'account_on_hold', message: HOLD_MESSAGE, link: 'https://claude.ai/restricted' });
    if (order === 'refusal first') refuse();
    reject(Object.assign(new Error('invalid_grant'), { status: 400 }));
    await refresh;
    if (order === 'refresh first') refuse();
    const row = am.getStatus().accounts[0];
    assert.equal(row.status, 'error');
    assert.equal(row.errorReason.code, 'account_on_hold');
    assert.equal(row.errorReason.link, 'https://claude.ai/restricted');
  });
}

// Removing an account renumbers the rest; a refusal still on its way must not
// land on whichever account took the old index.
for (const status of [400, 403]) {
  test(`a ${status} refusal that lands after its account was removed leaves the others alone`, async () => {
    const am = new AccountManager(accounts(), 0.98);
    const body = errorBody('permission_error', HOLD_MESSAGE, 'account_on_hold');
    await withProxy({ status, body, hold: true }, am, async (port, seen, release) => {
      const pending = post(port);
      while (!seen.includes('a-token')) await new Promise(resolve => setTimeout(resolve, 5));
      am.removeAccount(0);
      release();
      await pending;
      const row = am.getStatus().accounts[0];
      assert.equal(row.name, 'b');
      assert.equal(row.status, 'active');
    });
  });
}

test('an account refused again after a re-login records the new refusal', () => {
  const am = new AccountManager(accounts(), 0.98);
  am.markRefused(am.accounts[0], { code: 'account_on_hold', message: HOLD_MESSAGE, link: 'https://claude.ai/restricted' });
  am.updateAccountTokens(0, { accessToken: 'a2', refreshToken: 'ra2', expiresAt: Date.now() + HOUR });
  assert.equal(am.getStatus().accounts[0].status, 'active');
  am.markRefused(am.accounts[0], { code: 'verification_required', message: KYC_MESSAGE, link: 'https://claude.ai/settings/verify' });
  assert.equal(am.getStatus().accounts[0].errorReason?.code, 'verification_required');
});

test('a 429 that lands after the refusal does not turn it into a hold that lapses', () => {
  const am = new AccountManager(accounts(), 0.98);
  am.markRefused(am.accounts[0], { code: 'account_on_hold', message: HOLD_MESSAGE, link: 'https://claude.ai/restricted' });
  am.markRateLimited(0, 60);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.getStatus().accounts[0].errorReason?.code, 'account_on_hold');
});

// A streamed 400 is relayed as it arrives, as before: reading it first would
// hold its headers until the stream ends.
for (const contentType of ['text/event-stream', 'text/event-stream; profile="application/json"']) {
test(`a 400 that is not JSON (${contentType}) reaches the client before its body ends`, async () => {
  const body = `event: error\ndata: ${errorBody('invalid_request_error', 'messages: Field required')}\n\n`;
  const am = new AccountManager(accounts(), 0.98);
  await withProxy({ status: 400, body, contentType, hold: true }, am, async (port, seen, release) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    assert.equal(res.status, 400);
    release();
    assert.equal(await res.text(), body);
    assert.deepEqual(seen, ['a-token']);
    assert.equal(am.getStatus().accounts[0].status, 'active');
  });
});
}

test('a later request names the refused account instead of asking for a re-login', () => {
  const msg = exhaustedMessage([
    { name: 'a', status: 'error', errorReason: { code: 'account_on_hold' } },
    { name: 'b', status: 'error', errorReason: { code: 'refresh_rejected' } },
  ], null, 0);
  assert.match(msg, /account "a" was refused by upstream \(see: teamclaude status\)/);
  assert.match(msg, /account "b" needs re-login/);
  assert.doesNotMatch(msg, /"a"[^;]*re-login/);
});

test('an API-key account is not classified: its 400 reaches the client', async () => {
  const body = errorBody('invalid_request_error', 'This organization has been disabled.');
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'a-token' },
    { name: 'b', type: 'apikey', apiKey: 'b-token' },
  ], 0.98);
  await withProxy({ status: 400, body }, am, async (port) => {
    const res = await post(port);
    assert.equal(res.status, 400);
    assert.equal(am.getStatus().accounts[0].status, 'active');
  });
});

test('with every account refused the client reads upstream\'s reason, not a re-login', async () => {
  const am = new AccountManager([accounts()[0]], 0.98);
  await withProxy({ status: 403, body: errorBody('permission_error', HOLD_MESSAGE, 'account_on_hold') }, am, async (port) => {
    const res = await post(port);
    assert.equal(res.status, 502);
    const { message } = JSON.parse(res.body).error;
    assert.match(message, /"a"/);
    assert.ok(message.includes(HOLD_MESSAGE), message);
    assert.doesNotMatch(message, /Check the account/);
  });
});

test('status prints the refusal in upstream\'s words and how to bring the account back', () => {
  const am = new AccountManager(accounts(), 0.98);
  am.markRefused(am.accounts[0], { code: 'account_on_hold', message: HOLD_MESSAGE, link: 'https://claude.ai/restricted' });
  const line = unavailableLine(am.getStatus().accounts[0], paint) ?? '';
  assert.ok(line.includes(`refused by upstream: ${HOLD_MESSAGE}`), line);
  assert.match(line, /run: teamclaude login/);
  assert.doesNotMatch(line, /needs a re-login/);
});

test('switch names the refusal, not a re-login, for a refused account', () => {
  const am = new AccountManager(accounts(), 0.98);
  am.markRefused(am.accounts[0], { code: 'account_on_hold', message: HOLD_MESSAGE, link: 'https://claude.ai/restricted' });
  assert.deepEqual(am.eligibility(0), { eligible: false, reason: 'refused by upstream' });
  am.accounts[1].status = 'error';
  assert.deepEqual(am.eligibility(1), { eligible: false, reason: 'in an error state and needs a re-login' });
});

// A cap or a cooldown can outrank `error` in `unavailable`; the refusal is
// still what the operator has to act on.
for (const unavailable of ['capped', 'entitlement', 'routing']) {
  test(`status prints the refusal when the account is also ${unavailable}`, () => {
    const am = new AccountManager(accounts(), 0.98);
    am.markRefused(am.accounts[0], { code: 'account_on_hold', message: HOLD_MESSAGE, link: 'https://claude.ai/restricted' });
    const line = unavailableLine({ ...am.getStatus().accounts[0], unavailable }, paint) ?? '';
    assert.ok(line.includes(`refused by upstream: ${HOLD_MESSAGE}`), line);
  });
}

test('status says disabled, not refused, once the operator disables a refused account', () => {
  const am = new AccountManager(accounts(), 0.98);
  am.markRefused(am.accounts[0], { code: 'account_on_hold', message: HOLD_MESSAGE, link: 'https://claude.ai/restricted' });
  const line = unavailableLine({ ...am.getStatus().accounts[0], unavailable: 'disabled' }, paint) ?? '';
  assert.match(line, /disabled by operator/);
  assert.doesNotMatch(line, /refused by upstream/);
});

test('status keeps the whole link when the message is too long to show whole', () => {
  const am = new AccountManager(accounts(), 0.98);
  const link = `https://claude.ai/settings/verify?ticket=${'x'.repeat(250)}`;
  const message = `${'Your account needs attention. '.repeat(12)}Verify at ${link}`;
  am.markRefused(am.accounts[0], { code: 'verification_required', message, link });
  const line = unavailableLine(am.getStatus().accounts[0], paint) ?? '';
  assert.ok(line.includes(`${link} — once resolved`), line);
});
