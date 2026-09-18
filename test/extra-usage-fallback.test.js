import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { unavailableLine } from '../src/status-renderer.js';

// `accounts[].allowExtraUsage`: an account with paid overage on upstream may be
// leaned on once every account is past its quota, instead of the fleet
// answering a synthetic 429. Rotation itself is untouched — these tests pin
// both halves: nothing changes while any account has headroom, and once none
// does, the paid account serves unless a hard gate says it must not.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

function setQuota(account, q) {
  Object.assign(account.quota, q);
}

// Every account past the 0.98 switch threshold, and the probe slot spent, so
// the walk reaches the point where today it answers null.
function spentFleet(accounts) {
  const am = new AccountManager(accounts, 0.98);
  for (const a of am.accounts) setQuota(a, { unified7d: 0.99 });
  am._nextProbeAt = Date.now() + 60_000;
  return am;
}

// Silence the transition lines for the unit tests; the one test about logging
// captures them itself.
function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

// ── selection ────────────────────────────────────────────────

test('with every account spent, the opted-in account serves instead of null', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  am.currentIndex = 0;
  const picked = quietly(() => am.getActiveAccount(null, OPUS));
  assert.equal(picked?.name, 'paid');
  // It is not a normal pick: the account still reads as out of quota.
  assert.equal(am.unavailableReason(picked, OPUS), 'quota');
});

test('without the opt-in the spent fleet still answers null', () => {
  const am = spentFleet([oauth('a'), oauth('b')]);
  assert.equal(am.getActiveAccount(null, OPUS), null);
});

test('rotation is unchanged: an opted-in account still rotates away at the threshold', () => {
  const am = new AccountManager([oauth('paid', { allowExtraUsage: true }), oauth('b')], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.99 });
  setQuota(am.accounts[1], { unified7d: 0.5 });
  am.currentIndex = 0;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'b');
});

test('never chosen while any normal account has headroom, even a lower-priority one', () => {
  const am = new AccountManager([
    oauth('paid', { allowExtraUsage: true, priority: 0 }),
    oauth('last-resort', { priority: 9 }),
  ], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.99 });
  setQuota(am.accounts[1], { unified7d: 0.5 });
  am._nextProbeAt = Date.now() + 60_000;
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'last-resort');
});

test('the free revalidation probe goes first when it is due', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true, priority: 1 })], 0.98);
  for (const a of am.accounts) setQuota(a, { unified7d: 0.99 });
  // Probe due: it may find stale headroom on `a`, which costs nothing.
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'a');
  // The probed account refused, so this request retries with it tried and the
  // probe slot spent: the fallback takes it rather than a 429.
  assert.equal(quietly(() => am.getActiveAccount(new Set([0]), OPUS)).name, 'paid');
});

test('priority orders several fallback accounts, then least utilization', () => {
  const am = spentFleet([
    oauth('a'),
    oauth('paid-low', { allowExtraUsage: true, priority: 5 }),
    oauth('paid-hi', { allowExtraUsage: true, priority: 1 }),
    oauth('paid-hi-deeper', { allowExtraUsage: true, priority: 1 }),
  ]);
  setQuota(am.accounts[2], { unified7d: 1.10 });
  setQuota(am.accounts[3], { unified7d: 1.40 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid-hi');
  // With the preferred tier excluded (it just failed this request), the lower one.
  assert.equal(quietly(() => am.getActiveAccount(new Set([2, 3]), OPUS)).name, 'paid-low');
});

test('a stale upstream `rejected` verdict is overridden like the threshold', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  setQuota(am.accounts[1], { unified7d: 0.5, unifiedStatus: 'rejected', unifiedStatusSeenAt: Date.now() });
  assert.equal(am.unavailableReason(am.accounts[1], OPUS), 'upstream-rejected');
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
});

test('a spent family bucket falls back for that family only', () => {
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], 0.98);
  for (const a of am.accounts) setQuota(a, { unified7d: 0.3, unified7dFable: 0.99 });
  am._nextProbeAt = Date.now() + 60_000;
  am.currentIndex = 0;
  assert.equal(quietly(() => am.getActiveAccount(null, FABLE)).name, 'paid');
  // Opus is under every limit: it stays where the fleet was, and the cursor
  // was not dragged onto the paid account by a Fable-only diversion.
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'a');
});

// ── hard gates still bind ────────────────────────────────────

test('hard gates are not overridden', async (t) => {
  const cases = {
    disabled: a => { a.disabled = true; },
    'live 429 hold': a => { a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 60_000; a.throttledAt = Date.now(); },
    error: a => { a.status = 'error'; },
    'maxUsage cap': a => { a.maxUsage = 1.2; setQuota(a, { unified7d: 1.25 }); },
    'entitlement cooldown': a => { a.entitlementDeniedUntil = Date.now() + 60_000; },
    'overage off upstream': a => { a.quota.spend = { enabled: false }; },
  };
  for (const [name, arm] of Object.entries(cases)) {
    await t.test(name, () => {
      const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
      arm(am.accounts[1]);
      assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
    });
  }
});

test('a maxUsage above 1.0 is a spend limit: overage serves until it binds', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true, maxUsage: 1.5 })]);
  setQuota(am.accounts[1], { unified7d: 1.2 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
  setQuota(am.accounts[1], { unified7d: 1.5 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
});

test('unknown spend is allowed, known-enabled spend is allowed', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  assert.equal(am.accounts[1].quota.spend, null);
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
  am.accounts[1].quota.spend = { enabled: true };
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
});

test('route ownership still binds the fallback', () => {
  const am = spentFleet([
    oauth('owner', { models: [FABLE] }),
    oauth('paid', { allowExtraUsage: true }),
  ]);
  // A model owned by another account never lands on the paid one.
  assert.equal(quietly(() => am.getActiveAccount(null, FABLE)), null);
});

test('the provider partition still binds the fallback', () => {
  const am = spentFleet([oauth('claude'), oauth('codex-paid', { provider: 'codex', allowExtraUsage: true })]);
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
});

// ── automatic return ─────────────────────────────────────────

test('selection returns to a normal account once its window resets', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  setQuota(am.accounts[0], { unified7dReset: Date.now() + 5_000 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');
  assert.equal(am.getStatus().accounts[1].onExtraUsage, true);

  // The window rolls over: _clearExpiredQuotas drops the spent reading.
  setQuota(am.accounts[0], { unified7dReset: Date.now() - 1 });
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'a');
  assert.equal(am.getStatus().accounts[1].onExtraUsage, false);
});

test('the switch onto and off extra usage is logged once each, not per request', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    for (let i = 0; i < 5; i++) am.getActiveAccount(null, OPUS);
    setQuota(am.accounts[0], { unified7d: 0.1 });
    for (let i = 0; i < 3; i++) am.getActiveAccount(null, OPUS);
  } finally {
    console.log = log;
  }
  assert.equal(lines.filter(l => l.includes('on extra usage')).length, 1);
  assert.equal(lines.filter(l => l.includes('leaving extra usage')).length, 1);
});

// ── pickAlternate (the failover hops) ────────────────────────

test('pickAlternate reaches the fallback when the fleet is spent, moving nothing', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  am.currentIndex = 0;
  const alt = am.pickAlternate(new Set([0]), OPUS);
  assert.equal(alt?.name, 'paid');
  // A detour, not a decision about where the fleet rests (#286).
  assert.equal(am.currentIndex, 0);
  assert.equal(am._extraUsageIndex, null);
});

test('pickAlternate does not start billing to skip a wait on a healthy account', () => {
  // `a` is under threshold and merely paused by a per-minute 429 — it is still
  // available, so the hop must not land on the paid account.
  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true })], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.5 });
  setQuota(am.accounts[1], { unified7d: 0.99 });
  assert.equal(am.pickAlternate(new Set([0]), OPUS), null);
});

// ── status and config ────────────────────────────────────────

test('the flag and the serving state are visible in status output', () => {
  const am = spentFleet([oauth('a'), oauth('paid', { allowExtraUsage: true })]);
  quietly(() => am.getActiveAccount(null, OPUS));
  const [a, paid] = am.getStatus().accounts;
  assert.equal(a.allowExtraUsage, false);
  assert.equal(paid.allowExtraUsage, true);
  assert.equal(paid.onExtraUsage, true);
  const paint = new Proxy({}, { get: () => v => String(v) });
  assert.match(unavailableLine(paid, paint), /serving on extra usage/);
  assert.doesNotMatch(unavailableLine(a, paint), /extra usage/);
});

test('only a literal true opts in', () => {
  const am = new AccountManager([oauth('a', { allowExtraUsage: 'yes' }), oauth('b', { allowExtraUsage: true })], 0.98);
  assert.equal(am.accounts[0].allowExtraUsage, false);
  assert.equal(am.accounts[1].allowExtraUsage, true);
});

test('a config reload applies the opt-in live, both ways', async () => {
  const config = [oauth('a'), oauth('paid')];
  const am = spentFleet(config.map(c => ({ ...c })));
  assert.equal(am.getActiveAccount(null, OPUS), null);

  const disk = [oauth('a'), oauth('paid', { allowExtraUsage: true })];
  await quietly(() => syncAccountsFromDisk({ accounts: disk }, { accounts: config }, am));
  assert.equal(am.accounts[1].allowExtraUsage, true);
  assert.equal(config[1].allowExtraUsage, true);
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)).name, 'paid');

  // Turning it off must stop the spending now, not at the next restart.
  await quietly(() => syncAccountsFromDisk({ accounts: [oauth('a'), oauth('paid')] }, { accounts: config }, am));
  assert.equal(am.accounts[1].allowExtraUsage, false);
  assert.equal('allowExtraUsage' in config[1], false);
  assert.equal(quietly(() => am.getActiveAccount(null, OPUS)), null);
});

// ── through the server ───────────────────────────────────────

// The recommended ordering end to end: the due probe lands on the spent normal
// account, upstream rejects it on quota, and the retry reaches the paid account
// instead of answering the client with a 429.
async function throughProxy(respondToA) {
  const { createProxyServer } = await import('../src/server.js');
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const who = String(req.headers.authorization || '').replace('Bearer t-', '');
    seen.push(who);
    req.resume();
    if (who === 'a') return respondToA(res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"type":"message","content":[]}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));

  const am = new AccountManager([oauth('a'), oauth('paid', { allowExtraUsage: true, priority: 1 })], 0.98);
  for (const a of am.accounts) setQuota(a, { unified7d: 0.99 });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const log = console.log;
  console.log = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    return { status: res.status, seen };
  } finally {
    console.log = log;
    proxy.close();
    proxy.closeAllConnections?.();
    upstream.close();
    upstream.closeAllConnections?.();
  }
}

test('server: a quota-rejected probe is retried on the extra-usage account', async () => {
  const { status, seen } = await throughProxy(res => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '3600',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
      'anthropic-ratelimit-unified-7d-utilization': '1.0',
    });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"quota"}}');
  });
  assert.equal(status, 200);
  assert.deepEqual(seen, ['a', 'paid']);
});

test('server: a rate-limited probe hops to the extra-usage account', async () => {
  const { status, seen } = await throughProxy(res => {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': '30',
      'anthropic-ratelimit-unified-status': 'allowed',
    });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
  });
  assert.equal(status, 200);
  assert.deepEqual(seen, ['a', 'paid']);
});
