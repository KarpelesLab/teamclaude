import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { autoRedeemLine, renderStatus } from '../src/status-renderer.js';
import { ResetCreditRedeemer, redeemPreconditions, shouldRedeemReset } from '../src/codex-reset-credits.js';

// The spending strategy, through the redeemer and the control plane: the
// minimum-days floor, the cohort share cap and the per-day cap deciding which
// account a dry pool spends on; the operator's own `redeem` and `--plan`; and
// the policy's standing on every status surface. Nothing here reaches the
// network — both endpoints are faked, as in codex-reset-credits.test.js.

const DAY = 24 * 60 * 60 * 1000;
const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function codex(name, extra = {}) {
  return { name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name, accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

/** Spent weekly window, natural reset `days` away (null = unknown). */
function spent(account, days, now = Date.now()) {
  account.quota.unified7d = 1;
  account.quota.unified7dReset = days == null ? null : now + days * DAY;
  account.quota.unified5h = 0.1;
  return account;
}

function credit(extra = {}) {
  return { id: 'RateLimitResetCredit_1', status: 'available', supportedByPlan: true, expiresAt: Date.now() + 30 * DAY, title: 'Full reset', ...extra };
}

/**
 * A redeemer over a pool of spent Codex accounts whose resets are `days` away
 * each, with both endpoints faked and the log captured.
 */
function harness({ days = [3, 3], config = { autoRedeemResets: true }, code = 'reset', credits = null, caughtUp = true } = {}) {
  const now = Date.now();
  const am = new AccountManager(days.map((_, i) => codex(String.fromCharCode(97 + i))), 0.98);
  am.accounts.forEach((account, i) => spent(account, days[i], now));
  const calls = { consume: [], details: [] };
  const log = [];
  const redeemer = new ResetCreditRedeemer(am, {
    config,
    log: line => log.push(line),
    detailsFn: async account => { calls.details.push(account.name); const rows = credits?.[account.name] ?? [credit({ id: `${account.name}-1` })]; return { credits: rows, availableCount: rows.length }; },
    consumeFn: async account => { calls.consume.push(account.name); return typeof code === 'function' ? code(account.name) : { code, windowsReset: 1, credit: null }; },
    usageFn: async () => ({ sevenDay: { utilization: caughtUp ? 0 : 1, resetAt: Date.now() + 7 * DAY } }),
  });
  return { am, redeemer, calls, log, now };
}

// ── the preconditions ───────────────────────────────────────────────────────

test('the floor is a precondition with its own reason, and off by default', () => {
  const account = spent({ ...codex('a'), quota: {} }, 1);
  assert.equal(redeemPreconditions({ account, autoRedeemResets: true }).ok, true, 'no floor passed: as before');
  const floored = redeemPreconditions({ account, autoRedeemResets: true, minDaysToReset: 2 });
  assert.equal(floored.ok, false);
  assert.match(floored.reason, /natural weekly reset is 1d away, under the 2d minimum/);
  // The exhaustion check comes first: a healthy window is "not exhausted",
  // never "too close to reset".
  const healthy = { ...codex('h'), quota: { unified7d: 0.2, unified7dReset: Date.now() + DAY } };
  assert.equal(redeemPreconditions({ account: healthy, autoRedeemResets: true, minDaysToReset: 2 }).reason, 'weekly window is not exhausted');
  // And the policy function carries it through.
  const verdict = shouldRedeemReset({ account, autoRedeemResets: true, minDaysToReset: 2, pool: [], credits: [credit()] });
  assert.equal(verdict.redeem, false);
  assert.match(verdict.reason, /under the 2d minimum/);
});

// ── the floor at the refusal ────────────────────────────────────────────────

test('with no key set a dry pool spends exactly as before', async () => {
  const { am, redeemer, calls } = harness({ days: [0.5, 0.2] });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, true);
  assert.equal(calls.consume.length, 1);
});

test('the floor skips the account whose credit would buy too little, logs why, and spends on one that clears it', async () => {
  const { am, redeemer, calls, log } = harness({ days: [1, 4], config: { autoRedeemResets: true, autoRedeemMinDaysToReset: 2 } });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, true);
  assert.deepEqual(calls.consume, ['b']);
  assert.deepEqual(calls.details, ['b'], 'the floored account never had its rows read');
  const skipped = log.find(line => /skipped/.test(line));
  assert.match(skipped, /^\[TeamClaude\] Codex rate-limit reset on "a" skipped — natural weekly reset is 1d away, under the 2d minimum \(the credit would buy 0\.14 of a week\)$/);
});

test('a whole pool under the floor spends nothing and states the floor as the reason', async () => {
  const { am, redeemer, calls } = harness({ days: [1, 0.5], config: { autoRedeemResets: true, autoRedeemMinDaysToReset: 2 } });
  const result = await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /under the 2d minimum/);
  assert.deepEqual(calls.consume, []);
});

test('an unchanged skip is logged once, not once per refused request', async () => {
  const { am, redeemer, log } = harness({ days: [1], config: { autoRedeemResets: true, autoRedeemMinDaysToReset: 2 } });
  for (let i = 0; i < 5; i++) await redeemer.maybeRedeemForPool(am.accounts);
  assert.equal(log.filter(line => /skipped/.test(line)).length, 1);
});

// ── the share cap at the refusal ────────────────────────────────────────────

test('a half share of one cohort redeems two of four and then holds, however dry the pool stays', async () => {
  // Four accounts resetting within the same day; the fleet hold after each
  // success is stepped past by moving the clock, as a real week would.
  const { am, redeemer, calls, log } = harness({ days: [3, 3.1, 3.2, 3.3], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
  let clock = Date.now();
  redeemer.now = () => clock;
  // The accounts a redemption has not touched: the ones still on their natural
  // phase, which a real re-read would leave spent while the redeemed ones serve.
  const untouched = () => am.accounts.filter(a => !redeemer.ledger.some(r => r.account === a));
  const dry = async () => {
    const result = await redeemer.maybeRedeemForPool(untouched());
    clock += 7 * 60 * 60 * 1000;
    return result;
  };
  assert.equal((await dry()).redeemed, true);
  assert.equal((await dry()).redeemed, true);
  assert.equal(untouched().length, 2);
  const third = await dry();
  assert.equal(third.redeemed, false);
  assert.match(third.reason, /cohort of 4 already had 2 redeemed, the 50% share cap allows 2/);
  assert.equal((await dry()).redeemed, false, 'however many refusals follow, the other half keeps its phase');
  assert.equal(calls.consume.length, 2);
  assert.ok(log.some(line => /skipped — its reset cohort of 4 already had 2 redeemed/.test(line)));
});

test('under a share cap the cohort slot goes to the most exhausted, not the soonest-expiring credit', async () => {
  const now = Date.now();
  const { am, redeemer, calls } = harness({
    days: [3, 3],
    config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 },
    credits: { a: [credit({ id: 'a-1', expiresAt: now + 2 * DAY })], b: [credit({ id: 'b-1', expiresAt: now + 20 * DAY })] },
  });
  // `a` holds the credit about to be lost; `b` is further past its window.
  am.accounts[1].quota.unified7d = 1.3;
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.consume, ['b']);
});

test('without a share cap the soonest-expiring credit is still spent first', async () => {
  const now = Date.now();
  const { am, redeemer, calls } = harness({
    days: [3, 3],
    credits: { a: [credit({ id: 'a-1', expiresAt: now + 2 * DAY })], b: [credit({ id: 'b-1', expiresAt: now + 20 * DAY })] },
  });
  am.accounts[1].quota.unified7d = 1.3;
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.deepEqual(calls.consume, ['a']);
});

test('accounts in different cohorts are capped separately', async () => {
  const { am, redeemer, calls } = harness({ days: [2, 5], config: { autoRedeemResets: true, autoRedeemMaxShare: 0.5 }, caughtUp: false });
  let clock = Date.now();
  redeemer.now = () => clock;
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  for (const account of am.accounts) { account.quota.unified7d = 1; const s = redeemer.state.get(account); if (s) s.cooldownUntil = 0; }
  assert.equal((await redeemer.maybeRedeemForPool(am.accounts)).redeemed, true);
  assert.equal(calls.consume.length, 2, 'a cohort of one allows one, twice over');
});

// ── the per-day cap at the refusal ──────────────────────────────────────────

test('the per-day cap stops the fleet after N automatic redemptions in 24 hours, and lifts afterwards', async () => {
  const { am, redeemer, calls, log } = harness({ days: [3, 5, 6], config: { autoRedeemResets: true, autoRedeemMaxPerDay: 1 }, caughtUp: false });
  let clock = Date.now();
  redeemer.now = () => clock;
  const dry = async () => {
    const result = await redeemer.maybeRedeemForPool(am.accounts);
    for (const account of am.accounts) { account.quota.unified7d = 1; const s = redeemer.state.get(account); if (s) s.cooldownUntil = 0; }
    return result;
  };
  assert.equal((await dry()).redeemed, true);
  clock += 7 * 60 * 60 * 1000;
  const capped = await dry();
  assert.equal(capped.redeemed, false);
  assert.match(capped.reason, /daily cap of 1 auto-redemption is reached \(1 in the last 24h\)/);
  assert.ok(log.some(line => /skipped — the daily cap of 1/.test(line)));
  clock += 18 * 60 * 60 * 1000;
  assert.equal((await dry()).redeemed, true, 'a day later the cap has room again');
  assert.equal(calls.consume.length, 2);
});

// ── the operator's own hand ─────────────────────────────────────────────────

test('redeemOne spends on a named account regardless of the fleet switch, but never on a healthy window', async () => {
  const { am, redeemer, calls } = harness({ days: [3], config: { autoRedeemResets: false } });
  const result = await redeemer.redeemOne(am.accounts[0]);
  assert.equal(result.redeemed, true, 'the switch governs the automatic policy, not the operator');
  assert.deepEqual(calls.consume, ['a']);
  assert.match(result.reason, /requested by the operator \(worth 0\.43 of a week\)/);

  const healthy = harness({ days: [3] });
  healthy.am.accounts[0].quota.unified7d = 0.4;
  const refused = await healthy.redeemer.redeemOne(healthy.am.accounts[0]);
  assert.equal(refused.redeemed, false);
  assert.equal(refused.reason, 'weekly window is not exhausted');
  assert.deepEqual(healthy.calls.consume, []);
});

test('redeemOne honours the floor unless forced, and force reaches past nothing else', async () => {
  const { am, redeemer, calls } = harness({ days: [1], config: { autoRedeemResets: true, autoRedeemMinDaysToReset: 2 } });
  const floored = await redeemer.redeemOne(am.accounts[0]);
  assert.equal(floored.redeemed, false);
  assert.match(floored.reason, /under the 2d minimum.*pass --force/);
  assert.deepEqual(calls.consume, []);

  const forced = await redeemer.redeemOne(am.accounts[0], { force: true });
  assert.equal(forced.redeemed, true);
  assert.match(forced.reason, /floor overridden/);

  const healthy = harness({ days: [1] });
  healthy.am.accounts[0].quota.unified7d = 0.4;
  assert.equal((await healthy.redeemer.redeemOne(healthy.am.accounts[0], { force: true })).reason, 'weekly window is not exhausted');
});

test('redeemOne refuses an Anthropic account and an account holding nothing', async () => {
  const { redeemer } = harness();
  const am = new AccountManager([{ name: 'claude', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  assert.equal((await redeemer.redeemOne(am.accounts[0])).reason, 'not a Codex account');

  const empty = harness({ days: [3], credits: { a: [] } });
  const result = await empty.redeemer.redeemOne(empty.am.accounts[0]);
  assert.equal(result.redeemed, false);
  assert.equal(result.reason, 'holds no redeemable credit');
});

test('a manual redemption is counted in the ledger and holds the automatic pool like any other', async () => {
  const { am, redeemer } = harness({ days: [3, 3] });
  assert.equal((await redeemer.redeemOne(am.accounts[0])).redeemed, true);
  assert.equal(redeemer.ledger.length, 1);
  assert.equal(redeemer.ledger[0].manual, true);
  assert.equal(redeemer.policyStatus().redeemedLast24h, 1);
  const next = await redeemer.maybeRedeemForPool([am.accounts[1]]);
  assert.equal(next.redeemed, false);
  assert.match(next.reason, /cooling down after a recent redemption attempt/);
});

// ── the dry run ─────────────────────────────────────────────────────────────

test('the plan states every account and names the one a refusal would reach first, spending nothing', async () => {
  const { am, redeemer, calls } = harness({ days: [1, 4], config: { autoRedeemResets: true, autoRedeemMinDaysToReset: 2, autoRedeemMaxShare: 0.5 } });
  am.accounts[0].quota.resetCredits = { available: 1, applicable: 1, seenAt: Date.now() };
  const plan = redeemer.plan();
  assert.deepEqual(calls, { consume: [], details: [] });
  assert.equal(plan.wouldRedeem, 'b');
  assert.deepEqual(plan.policy, { minDaysToReset: 2, maxShare: 0.5, maxPerDay: 0, redeemedLast24h: 0 });
  const [a, b] = plan.accounts;
  assert.equal(a.armed, false);
  assert.match(a.verdict, /^exempt — natural weekly reset is 1d away/);
  assert.equal(a.creditsHeld, 1);
  assert.equal(b.armed, true);
  assert.equal(b.verdict, 'would redeem when the pool is dry');
  assert.equal(b.creditValueWeeks, 0.57);
  assert.equal(b.daysToReset, 4);
});

test('the plan says when an armed account is simply not exhausted, or could still serve', () => {
  const { am, redeemer } = harness({ days: [3] });
  am.accounts[0].quota.unified7d = 0.3;
  const plan = redeemer.plan();
  assert.equal(plan.wouldRedeem, null);
  assert.equal(plan.accounts[0].verdict, 'armed — weekly window is not exhausted');
});

// ── the status payload ──────────────────────────────────────────────────────

test('describe answers for a Codex row and null for any other', () => {
  const { am, redeemer } = harness({ days: [3.5], config: { autoRedeemResets: true } });
  assert.deepEqual(redeemer.describe(am.accounts[0]), { armed: true, exemptReason: null, creditValueWeeks: 0.5 });
  assert.equal(redeemer.describe({ name: 'claude', type: 'oauth', quota: {} }), null);
  assert.deepEqual(redeemer.policyStatus(), { minDaysToReset: 0, maxShare: 1, maxPerDay: 0, redeemedLast24h: 0 });
});

test('the status screen prints a Redeem line per Codex account, and nothing where the payload has none', () => {
  const paint = { dim: s => s, green: s => s, yellow: s => s, gray: s => s };
  assert.equal(autoRedeemLine({ quota: {} }, paint), null);
  assert.equal(autoRedeemLine({ autoRedeem: null }, paint), null);
  const armed = autoRedeemLine({ autoRedeem: { armed: true, exemptReason: null, creditValueWeeks: 0.43 } }, paint);
  assert.match(armed, /^Redeem\s+armed, credit worth 0\.43 of a week \(3\.0d to reset\)$/);
  const exempt = autoRedeemLine({ autoRedeem: { armed: false, exemptReason: 'auto-redeem is switched off', creditValueWeeks: null } }, paint);
  assert.match(exempt, /^Redeem\s+exempt — auto-redeem is switched off, credit value unknown \(no reset time\)$/);

  const row = { name: 'a', type: 'oauth', provider: 'codex', status: 'active', quota: { unified5h: 0.2, unified7d: 1 }, usage: {}, sessions: 0, autoRedeem: { armed: true, exemptReason: null, creditValueWeeks: 0.5 } };
  const out = renderStatus({ currentAccount: 'a', switchThreshold: 0.98, routes: [], sessions: {}, accounts: [row] }, { color: false });
  assert.match(out, /Redeem\s+armed, credit worth 0\.50 of a week/);
  const plain = renderStatus({ currentAccount: 'a', switchThreshold: 0.98, routes: [], sessions: {}, accounts: [{ ...row, autoRedeem: undefined }] }, { color: false });
  assert.equal(/Redeem/.test(plain), false);
});

// ── the control plane ───────────────────────────────────────────────────────

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** The real proxy server over a faked redeemer, wired the way index.js wires it. */
async function controlPlane({ days = [3], config = { autoRedeemResets: true }, withHooks = true } = {}) {
  const h = harness({ days, config });
  const hooks = withHooks ? {
    redeemCodexReset: (account, opts) => h.redeemer.redeemOne(account, opts),
    planCodexRedeem: () => h.redeemer.plan(),
    describeAutoRedeem: account => h.redeemer.describe(account),
    getStatusExtra: () => ({ redeemPolicy: h.redeemer.policyStatus() }),
  } : {};
  const serverConfig = { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'tenant', key: 'tc-tenant' }] }, upstream: 'https://api.anthropic.com', ...config };
  const proxy = createProxyServer(h.am, serverConfig, hooks);
  const port = await listen(proxy);
  const call = (path, { method = 'GET', body, key = 'tc-test' } = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body),
  }).then(async res => ({ status: res.status, data: await res.json() }));
  return { ...h, proxy, port, call, close: () => { proxy.closeAllConnections?.(); proxy.close(); } };
}

test('/teamclaude/status carries each Codex account\'s standing and the fleet policy', async () => {
  const cp = await controlPlane({ days: [3.5], config: { autoRedeemResets: true, autoRedeemMaxPerDay: 2 } });
  try {
    const { status, data } = await cp.call('/teamclaude/status');
    assert.equal(status, 200);
    assert.deepEqual(data.accounts[0].autoRedeem, { armed: true, exemptReason: null, creditValueWeeks: 0.5 });
    assert.deepEqual(data.redeemPolicy, { minDaysToReset: 0, maxShare: 1, maxPerDay: 2, redeemedLast24h: 0 });
  } finally {
    cp.close();
  }
});

test('a server built without the hooks answers status as before and the redeem routes with 501', async () => {
  const cp = await controlPlane({ withHooks: false });
  try {
    const { data } = await cp.call('/teamclaude/status');
    assert.equal('autoRedeem' in data.accounts[0], false);
    assert.equal('redeemPolicy' in data, false);
    assert.equal((await cp.call('/teamclaude/redeem', { method: 'POST', body: { account: 'a' } })).status, 501);
    assert.equal((await cp.call('/teamclaude/redeem/plan')).status, 501);
  } finally {
    cp.close();
  }
});

test('POST /teamclaude/redeem spends on the named account and reports a policy "no" as a 200 that says so', async () => {
  const cp = await controlPlane({ days: [1], config: { autoRedeemResets: false, autoRedeemMinDaysToReset: 2 } });
  try {
    const floored = await cp.call('/teamclaude/redeem', { method: 'POST', body: { account: 'a' } });
    assert.equal(floored.status, 200);
    assert.equal(floored.data.redeemed, false);
    assert.match(floored.data.reason, /under the 2d minimum/);
    assert.deepEqual(cp.calls.consume, []);

    const forced = await cp.call('/teamclaude/redeem', { method: 'POST', body: { account: 'a', force: true } });
    assert.equal(forced.status, 200);
    assert.equal(forced.data.redeemed, true);
    assert.equal(forced.data.account, 'a');
    assert.equal(forced.data.code, 'reset');
    assert.equal(forced.data.windowsReset, 1);
    assert.deepEqual(cp.calls.consume, ['a']);
  } finally {
    cp.close();
  }
});

test('POST /teamclaude/redeem refuses a missing or unknown account, a bad body, and a client key', async () => {
  const cp = await controlPlane();
  try {
    const missing = await cp.call('/teamclaude/redeem', { method: 'POST', body: {} });
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.data.accounts, ['a']);
    const unknown = await cp.call('/teamclaude/redeem', { method: 'POST', body: { account: 'nobody' } });
    assert.equal(unknown.status, 404);
    assert.match(unknown.data.error, /no such account "nobody"/);
    const bad = await fetch(`http://127.0.0.1:${cp.port}/teamclaude/redeem`, { method: 'POST', headers: { 'x-api-key': 'tc-test' }, body: '{not json' });
    assert.equal(bad.status, 400);
    await bad.text();
    const tenant = await cp.call('/teamclaude/redeem', { method: 'POST', body: { account: 'a' }, key: 'tc-tenant' });
    assert.equal(tenant.status, 403);
    assert.match(tenant.data.error, /cannot spend reset credits/);
    assert.deepEqual(cp.calls.consume, []);
  } finally {
    cp.close();
  }
});

test('GET /teamclaude/redeem/plan is the dry run, with the switch beside it', async () => {
  const cp = await controlPlane({ days: [4] });
  try {
    const { status, data } = await cp.call('/teamclaude/redeem/plan');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.autoRedeemResets, true);
    assert.equal(data.wouldRedeem, 'a');
    assert.equal(data.accounts[0].verdict, 'would redeem when the pool is dry');
    assert.deepEqual(cp.calls, { consume: [], details: [] });
  } finally {
    cp.close();
  }
});

// ── the CLI ─────────────────────────────────────────────────────────────────

async function writeConfig(port) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-redeem-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ proxy: { port, apiKey: 'tc-test' }, upstream: 'https://api.anthropic.com', upstreamProxy: false, accounts: [] }));
  return path;
}

function runCli(configPath, cliArgs) {
  const child = spawn(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 20_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('teamclaude redeem <name> and --plan drive the running server', async () => {
  const cp = await controlPlane({ days: [1, 4], config: { autoRedeemResets: true, autoRedeemMinDaysToReset: 2 } });
  const configPath = await writeConfig(cp.port);
  try {
    const plan = await runCli(configPath, ['redeem', '--plan']);
    assert.equal(plan.code, 0, plan.stderr);
    assert.match(plan.stdout, /Auto-redeem: on\s+min days to reset: 2\s+max share per cohort: off\s+max per day: off\s+redeemed last 24h: 0/);
    assert.match(plan.stdout, /a: exempt — natural weekly reset is 1d away.*credit worth 0\.14 of a week \(1d to reset\)/);
    assert.match(plan.stdout, /b: would redeem when the pool is dry — credit worth 0\.57 of a week \(4d to reset\)/);
    assert.match(plan.stdout, /Would redeem first: b/);
    assert.deepEqual(cp.calls.consume, []);

    const floored = await runCli(configPath, ['redeem', 'a']);
    assert.equal(floored.code, 1);
    assert.match(floored.stderr, /Not redeemed on "a": natural weekly reset is 1d away.*pass --force/);

    const forced = await runCli(configPath, ['redeem', 'a', '--force']);
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, /Redeemed a reset credit on "a" — 1 window\(s\) reset \(reset\)/);
    assert.deepEqual(cp.calls.consume, ['a']);

    const unknown = await runCli(configPath, ['redeem', 'nobody']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no such account "nobody"/);
    assert.match(unknown.stderr, /Known accounts:/);

    const usage = await runCli(configPath, ['redeem']);
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /Usage: teamclaude redeem/);
  } finally {
    cp.close();
  }
});
