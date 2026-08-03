import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { CodexTokenRefresher } from '../src/codex/token-refresher.js';

const HOUR = 3600_000;

function codexAcct(name, expiresInMs, extra = {}) {
  return {
    name, type: 'oauth', protocol: 'codex', accountId: 'a',
    accessToken: 'old', refreshToken: 'r',
    expiresAt: Date.now() + expiresInMs, ...extra,
  };
}

function anthropicAcct(name, expiresInMs) {
  return {
    name, type: 'oauth', accessToken: 'old', refreshToken: 'r',
    expiresAt: Date.now() + expiresInMs,
  };
}

/** AccountManager with both refreshers stubbed, recording which fired. */
function managerWith(accounts) {
  const calls = { codex: 0, anthropic: 0 };
  const am = new AccountManager(accounts, 0.98, {
    codexRefreshFn: async () => {
      calls.codex++;
      return { accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 10 * 24 * HOUR, accountId: 'a' };
    },
    refreshFn: async () => {
      calls.anthropic++;
      return { accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + HOUR };
    },
  });
  return { am, calls };
}

function refresher(am, opts = {}) {
  // intervalMs is irrelevant when checkAll is driven manually; start() is only
  // used in the timer tests below.
  return new CodexTokenRefresher(am, { log: () => {}, ...opts });
}

test('a token expiring inside the lookahead window is refreshed', async () => {
  const { am, calls } = managerWith([codexAcct('cx', 10 * 60_000)]); // 10 min left
  await refresher(am).checkAll();
  assert.equal(calls.codex, 1);
  assert.equal(am.accounts[0].credential, 'new');
});

test('a token with plenty of life left is left alone', async () => {
  // The whole point of a lookahead rather than a fixed cadence: with a ~10-day
  // token this refreshes about once per token, not once per tick.
  const { am, calls } = managerWith([codexAcct('cx', 10 * 24 * HOUR)]);
  await refresher(am).checkAll();
  assert.equal(calls.codex, 0);
  assert.equal(am.accounts[0].credential, 'old');
});

test('an already-expired token is refreshed', async () => {
  const { am, calls } = managerWith([codexAcct('cx', -HOUR)]);
  await refresher(am).checkAll();
  assert.equal(calls.codex, 1);
});

test('the boundary of the lookahead window is respected', async () => {
  const { am: amIn, calls: cIn } = managerWith([codexAcct('cx', 29 * 60_000)]);
  await refresher(amIn, { refreshAheadMs: 30 * 60_000 }).checkAll();
  assert.equal(cIn.codex, 1);

  const { am: amOut, calls: cOut } = managerWith([codexAcct('cx', 31 * 60_000)]);
  await refresher(amOut, { refreshAheadMs: 30 * 60_000 }).checkAll();
  assert.equal(cOut.codex, 0);
});

test('anthropic accounts are never touched by this refresher', async () => {
  // They already refresh via the request path, the prober and the warmer. The
  // codebase deliberately avoids being an extra holder rotating that token
  // family, so this must not add itself as one.
  const { am, calls } = managerWith([anthropicAcct('claude', 60_000)]);
  await refresher(am).checkAll();
  assert.equal(calls.anthropic, 0);
  assert.equal(calls.codex, 0);
});

test('only the expiring codex account in a mixed fleet is refreshed', async () => {
  const { am, calls } = managerWith([
    anthropicAcct('claude', 60_000),
    codexAcct('cx-fresh', 10 * 24 * HOUR),
    codexAcct('cx-stale', 60_000),
  ]);
  await refresher(am).checkAll();
  assert.equal(calls.codex, 1);
  assert.equal(calls.anthropic, 0);
  assert.equal(am.accounts[1].credential, 'old');
  assert.equal(am.accounts[2].credential, 'new');
});

test('a disabled account is not refreshed', async () => {
  const { am, calls } = managerWith([codexAcct('cx', 60_000, { disabled: true })]);
  await refresher(am).checkAll();
  assert.equal(calls.codex, 0);
});

test('an account with no refresh token is skipped', async () => {
  const { am, calls } = managerWith([codexAcct('cx', 60_000, { refreshToken: null })]);
  await refresher(am).checkAll();
  assert.equal(calls.codex, 0);
});

test('an account with no recorded expiry is left to the request path', async () => {
  // Refreshing on every tick would hammer the token endpoint; a 401 on the
  // request path recovers it instead.
  const { am, calls } = managerWith([codexAcct('cx', 0, { expiresAt: null })]);
  await refresher(am).checkAll();
  assert.equal(calls.codex, 0);
});

test('a dead refresh token sidelines the account rather than looping', async () => {
  const am = new AccountManager([codexAcct('cx', 60_000)], 0.98, {
    codexRefreshFn: async () => {
      const err = new Error('invalid_grant');
      err.status = 400; // genuine auth rejection
      throw err;
    },
  });
  const r = refresher(am);
  await r.checkAll();
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am._isAvailable(am.accounts[0]), false);
});

test('a transient refresh failure leaves the account serving', async () => {
  // A network blip must not drop a healthy account out of rotation.
  let attempts = 0;
  const am = new AccountManager([codexAcct('cx', 60_000)], 0.98, {
    codexRefreshFn: async () => {
      attempts++;
      if (attempts === 1) throw new Error('fetch failed');
      return { accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 10 * 24 * HOUR };
    },
  });
  const r = refresher(am);

  await r.checkAll();
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].credential, 'old');

  // Next tick retries and succeeds.
  await r.checkAll();
  assert.equal(am.accounts[0].credential, 'new');
});

test('overlapping runs do not double-refresh', async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const am = new AccountManager([codexAcct('cx', 60_000)], 0.98, {
    codexRefreshFn: async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      return { accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 10 * 24 * HOUR };
    },
  });
  const r = refresher(am);
  await Promise.all([r.checkAll(), r.checkAll(), r.checkAll()]);
  assert.equal(maxConcurrent, 1);
});

test('start() refreshes immediately rather than waiting a full interval', async () => {
  // A proxy started after days idle would otherwise serve its first request on
  // an expired token and pay a synchronous refresh.
  const { am, calls } = managerWith([codexAcct('cx', -HOUR)]);
  const r = refresher(am, { intervalMs: HOUR });
  r.start();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  r.stop();
  assert.equal(calls.codex, 1);
});

test('the periodic timer refreshes a token that ages into the window', async () => {
  const { am, calls } = managerWith([codexAcct('cx', 10 * 24 * HOUR)]);
  const r = refresher(am, { intervalMs: 10, refreshAheadMs: 60_000 });
  r.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.codex, 0); // still far from expiry

  // Token now expires inside the window; the next tick should catch it.
  am.accounts[0].expiresAt = Date.now() + 30_000;
  await new Promise(resolve => setTimeout(resolve, 40));
  r.stop();
  assert.equal(calls.codex, 1);
});

test('stop() halts further refreshes', async () => {
  const { am, calls } = managerWith([codexAcct('cx', 10 * 24 * HOUR)]);
  const r = refresher(am, { intervalMs: 10, refreshAheadMs: 60_000 });
  r.start();
  r.stop();
  am.accounts[0].expiresAt = Date.now() + 30_000;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls.codex, 0);
});

test('status reports what is scheduled and what is due', async () => {
  const { am } = managerWith([codexAcct('cx', 10 * 60_000), anthropicAcct('claude', 60_000)]);
  const r = refresher(am);
  const before = r.status();
  assert.equal(before.enabled, false);
  assert.equal(before.accounts.length, 1); // codex only
  assert.equal(before.accounts[0].due, true);

  await r.checkAll();
  assert.equal(r.status().refreshCount, 1);
  assert.equal(r.status().accounts[0].due, false);
});
