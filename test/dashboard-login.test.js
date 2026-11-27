import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startOAuthLogin } from '../src/oauth.js';
import { PANEL_LOGIN_TIMEOUT_MS } from '../src/login-flow.js';
import { createDashboardLogin } from '../src/dashboard-login.js';

// The sign-in behind the dashboard's Add account control (#765): one pending
// Claude sign-in held in memory, started with no loopback listener, finished
// by a pasted code. The real flow (startOAuthLogin) runs here with its token
// exchange injected, so nothing reaches Anthropic; the config write and the
// reload are stubs that record their calls.

// The flow narrates its exchange step on the console; here it is only noise.
console.log = () => {};

const TOKENS = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1 };
const stateOf = url => new URL(url).searchParams.get('state');

function harness({ exchange = async () => TOKENS, upsert = null, ...opts } = {}) {
  const seen = { start: [], flows: [], exchange: [], order: [] };
  const login = createDashboardLogin({
    startLogin: async (startOpts) => {
      seen.start.push(startOpts);
      const flow = await startOAuthLogin({
        ...startOpts,
        // A port nothing listens on: an exchange that slipped past the stub
        // would be refused rather than reach a token endpoint.
        tokenEndpoint: 'http://127.0.0.1:9/token',
        exchange: async (code, state, verifier, redirectUri) => {
          seen.exchange.push({ code, state, redirectUri });
          return exchange(code);
        },
      });
      seen.flows.push(flow);
      return flow;
    },
    upsert: async (tokens) => {
      seen.order.push(['upsert', tokens]);
      return upsert ? upsert(tokens) : { action: 'added', name: 'alice@example.com' };
    },
    reload: async () => { seen.order.push(['reload']); },
    ...opts,
  });
  return { login, seen };
}

test('start hands out the code-page link and an opaque id, with no loopback listener', async () => {
  const { login, seen } = harness({ now: () => 1_000 });
  const started = await login.start();
  assert.equal(started.ok, true);
  assert.match(started.id, /^[A-Za-z0-9_-]{22}$/, '16 random bytes, base64url');
  assert.equal(started.expiresAt, 1_000 + PANEL_LOGIN_TIMEOUT_MS);
  const url = new URL(started.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://console.anthropic.com/oauth/code/callback');
  assert.equal(seen.start.length, 1);
  assert.equal(seen.start[0].loopback, false);
  assert.equal(seen.start[0].timeoutMs, PANEL_LOGIN_TIMEOUT_MS);
  assert.ok(seen.start[0].signal instanceof AbortSignal);
  assert.equal(seen.flows[0].browserUrl, null, 'nothing listens on this machine');
  login.cancel(started.id);
});

test('finish exchanges the pasted code, saves the account, reloads, and reports it', async () => {
  const { login, seen } = harness({ upsert: async () => ({ action: 'updated', name: 'bob@example.com' }) });
  const started = await login.start();
  const done = await login.finish(started.id, `ac_1#${stateOf(started.url)}`);
  assert.deepEqual(done, { ok: true, account: 'bob@example.com', action: 'updated' });
  assert.deepEqual(seen.exchange, [{ code: 'ac_1', state: stateOf(started.url), redirectUri: 'https://console.anthropic.com/oauth/code/callback' }]);
  // The save first, then the reload that brings the saved row into the fleet.
  assert.deepEqual(seen.order, [['upsert', TOKENS], ['reload']]);
  // The sign-in is over: its id names nothing any more.
  assert.equal((await login.finish(started.id, 'again')).code, 'unknown');
});

test('a paste that cannot be used is refused with the reason, and the sign-in can still be finished', async () => {
  const { login, seen } = harness();
  const started = await login.start();
  const wrong = await login.finish(started.id, 'ac_1#state-of-another-attempt');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'unusable');
  assert.match(wrong.error, /different sign-in attempt/);
  const link = await login.finish(started.id, started.url);
  assert.equal(link.code, 'unusable');
  assert.match(link.error, /sign-in link itself/);
  const empty = await login.finish(started.id, '   ');
  assert.equal(empty.code, 'unusable');
  assert.deepEqual(seen.exchange, [], 'no refused paste reached the exchange');
  const done = await login.finish(started.id, `ac_2#${stateOf(started.url)}`);
  assert.equal(done.ok, true);
  assert.equal(seen.exchange.length, 1);
});

test('an id that names no pending sign-in is unknown', async () => {
  const { login, seen } = harness();
  assert.deepEqual(await login.finish('nope', 'ac_1'), { ok: false, code: 'unknown', error: 'that sign-in has expired or was replaced; start again' });
  const started = await login.start();
  assert.equal((await login.finish(`${started.id}x`, 'ac_1')).code, 'unknown');
  assert.equal((await login.finish(undefined, 'ac_1')).code, 'unknown');
  assert.deepEqual(seen.exchange, []);
  login.cancel(started.id);
});

test('a second start aborts the first, whose id is then unknown', async () => {
  const { login, seen } = harness();
  const first = await login.start();
  const second = await login.start();
  assert.notEqual(first.id, second.id);
  assert.equal(seen.start[0].signal.aborted, true);
  await assert.rejects(seen.flows[0].tokens, { name: 'AbortError' });
  assert.equal((await login.finish(first.id, `ac_1#${stateOf(first.url)}`)).code, 'unknown');
  assert.equal((await login.finish(second.id, `ac_2#${stateOf(second.url)}`)).ok, true);
  assert.deepEqual(seen.exchange.map(c => c.code), ['ac_2']);
});

test('two starts at once leave one sign-in pending: the later one', async () => {
  const { login, seen } = harness();
  const [first, second] = await Promise.all([login.start(), login.start()]);
  assert.deepEqual(first, { ok: false, code: 'replaced', error: 'a newer sign-in replaced this one' });
  assert.equal(second.ok, true);
  assert.equal(seen.start[0].signal.aborted, true);
  assert.equal(seen.start[1].signal.aborted, false);
  await assert.rejects(seen.flows[0].tokens, { name: 'AbortError' });
  assert.equal((await login.finish(second.id, `ac_1#${stateOf(second.url)}`)).ok, true);
});

test('cancel aborts the pending sign-in and forgets it, and is idempotent', async () => {
  const { login, seen } = harness();
  const started = await login.start();
  assert.deepEqual(login.cancel('some-other-id'), { ok: true, cancelled: false });
  assert.deepEqual(login.cancel(started.id), { ok: true, cancelled: true });
  assert.equal(seen.start[0].signal.aborted, true);
  await assert.rejects(seen.flows[0].tokens, { name: 'AbortError' });
  assert.equal((await login.finish(started.id, `ac_1#${stateOf(started.url)}`)).code, 'unknown');
  assert.deepEqual(login.cancel(started.id), { ok: true, cancelled: false });
  assert.deepEqual(seen.exchange, []);
});

test('a failed token exchange ends the sign-in: the error is reported and the entry is gone', async () => {
  const { login, seen } = harness({ exchange: async () => { throw new Error('Token exchange failed (400): invalid_grant'); } });
  const started = await login.start();
  const done = await login.finish(started.id, `ac_1#${stateOf(started.url)}`);
  assert.deepEqual(done, { ok: false, code: 'failed', error: 'Token exchange failed (400): invalid_grant' });
  assert.deepEqual(seen.order, [], 'nothing was saved and nothing reloaded');
  assert.equal((await login.finish(started.id, `ac_1#${stateOf(started.url)}`)).code, 'unknown');
});

test('an account the save refuses ends the sign-in without a reload', async () => {
  const { login, seen } = harness({ upsert: async () => { throw new Error('Could not identify OAuth account'); } });
  const started = await login.start();
  const done = await login.finish(started.id, `ac_1#${stateOf(started.url)}`);
  assert.deepEqual(done, { ok: false, code: 'failed', error: 'Could not identify OAuth account' });
  assert.deepEqual(seen.order.map(c => c[0]), ['upsert']);
  assert.equal((await login.finish(started.id, 'ac_1')).code, 'unknown');
});

test('while one finish runs, a second is refused and a cancel changes nothing', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { login, seen } = harness({ exchange: async () => { await gate; return TOKENS; } });
  const started = await login.start();
  const code = `ac_1#${stateOf(started.url)}`;
  const running = login.finish(started.id, code);
  assert.deepEqual(await login.finish(started.id, code), { ok: false, code: 'busy', error: 'that sign-in is already being finished' });
  assert.deepEqual(login.cancel(started.id), { ok: true, cancelled: false });
  release();
  assert.equal((await running).ok, true);
  assert.equal(seen.exchange.length, 1, 'the code was sent to the exchange once');
});

test('a sign-in nobody finishes ends at its timeout, and its entry is dropped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { login, seen } = harness({ timeoutMs: 60_000 });
  const started = await login.start();
  t.mock.timers.tick(59_999);
  // Still pending one millisecond short: an unusable paste is refused as
  // such, which only a pending sign-in does.
  assert.equal((await login.finish(started.id, 'ac_1#wrong-state')).code, 'unusable');
  t.mock.timers.tick(1);
  await seen.flows[0].settled;
  await assert.rejects(seen.flows[0].tokens, /Login timed out after 1 minute/);
  assert.equal((await login.finish(started.id, `ac_1#${stateOf(started.url)}`)).code, 'unknown');
  assert.deepEqual(seen.exchange, []);
});

test('a sign-in that cannot start reports it and leaves nothing pending', async () => {
  const login = createDashboardLogin({
    startLogin: async () => { throw new Error('no entropy'); },
    upsert: async () => ({ action: 'added', name: 'x' }),
    reload: async () => {},
  });
  assert.deepEqual(await login.start(), { ok: false, code: 'failed', error: 'could not start the sign-in: no entropy' });
});
