import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpend, normalizeUsagePayload, formatMoney } from '../src/oauth.js';
import { AccountManager } from '../src/account-manager.js';
import { renderStatus, spendLine } from '../src/status-renderer.js';
import { TUI, spendTag } from '../src/tui.js';

// An account with paid overage enabled does not stop at its weekly limit — it
// keeps serving and bills. The quota bars cannot express that, so rotation onto
// such an account spends money with nothing on screen saying so. These tests pin
// the whole path: parse it off the probe payload, carry it on the quota, and say
// it in both dashboards.

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const paint = new Proxy({}, { get: () => (v) => String(v) });

// Payload shapes taken verbatim from /api/oauth/usage on live accounts.
const BILLABLE = {
  extra_usage: {
    is_enabled: true, monthly_limit: 1000000, used_credits: 0, utilization: null,
    currency: 'USD', decimal_places: 2, disabled_reason: null, user_disabled: false,
    spend_limit_reached: false, credits_ever_enabled: true,
  },
  spend: {
    used: { amount_minor: 0, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 1000000, currency: 'USD', exponent: 2 },
    percent: 0, severity: 'normal', enabled: true,
  },
};
const OUT_OF_CREDITS = {
  extra_usage: {
    is_enabled: false, monthly_limit: 2000, used_credits: 0, utilization: 0,
    currency: 'EUR', decimal_places: 2, disabled_reason: 'out_of_credits',
    user_disabled: false, spend_limit_reached: false, credits_ever_enabled: true,
  },
  spend: {
    used: { amount_minor: 1500, currency: 'EUR', exponent: 2 },
    limit: { amount_minor: 2000, currency: 'EUR', exponent: 2 },
  },
};
const NEVER_ENABLED = {
  extra_usage: {
    is_enabled: false, monthly_limit: null, used_credits: null, currency: null,
    decimal_places: null, disabled_reason: null, user_disabled: false,
    credits_ever_enabled: false,
  },
  spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, enabled: false },
};

test('normalizeSpend reads whether the account can bill, not just whether an org provisioned it', () => {
  assert.equal(normalizeSpend(BILLABLE).enabled, true);
  // The decisive case: the org has overage, but this account cannot draw on it.
  // Reading `spend.enabled` or the profile's has_extra_usage_enabled would call
  // this billable and warn about money that cannot move.
  assert.equal(normalizeSpend(OUT_OF_CREDITS).enabled, false);
  assert.equal(normalizeSpend(OUT_OF_CREDITS).disabledReason, 'out_of_credits');
  assert.equal(normalizeSpend(NEVER_ENABLED).enabled, false);
  assert.equal(normalizeSpend({}), null);
});

test('normalizeSpend keeps the payload currency and exponent rather than assuming cents', () => {
  const s = normalizeSpend(OUT_OF_CREDITS);
  assert.equal(s.currency, 'EUR');
  assert.equal(s.usedMinor, 1500);
  assert.equal(s.limitMinor, 2000);
  const jpy = normalizeSpend({
    extra_usage: { is_enabled: true, currency: 'JPY', decimal_places: 0 },
    spend: { used: { amount_minor: 500, currency: 'JPY', exponent: 0 } },
  });
  assert.equal(formatMoney(jpy), '¥500');
});

test('normalizeSpend separates a member switching it off from upstream refusing', () => {
  const mine = normalizeSpend({ extra_usage: { is_enabled: false, user_disabled: true }, spend: {} });
  assert.equal(mine.userDisabled, true);
  assert.equal(normalizeSpend(OUT_OF_CREDITS).userDisabled, false);
});

test('formatMoney renders amount and cap, and stays readable for an unknown currency', () => {
  assert.equal(formatMoney({ usedMinor: 0, limitMinor: 1000000, currency: 'USD', exponent: 2 }), '$0.00 of $10,000.00');
  assert.equal(formatMoney({ usedMinor: 4237, limitMinor: null, currency: 'USD', exponent: 2 }), '$42.37');
  assert.equal(formatMoney({ usedMinor: 42, limitMinor: 100, currency: 'XYZ', exponent: 2 }), '0.42 XYZ of 1.00 XYZ');
  assert.equal(formatMoney(null), 'unknown');
});

test('the probe carries spend onto the quota and announces the transition once', () => {
  const am = new AccountManager([{ name: 'work', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  const said = [];
  const realLog = console.log;
  console.log = (m) => said.push(String(m));
  try {
    am.applyUsageData(0, normalizeUsagePayload({ ...NEVER_ENABLED, limits: [] }));
    assert.equal(am.accounts[0].quota.spend.enabled, false);
    assert.equal(said.filter(l => /bill real money/.test(l)).length, 0);

    am.applyUsageData(0, normalizeUsagePayload({ ...BILLABLE, limits: [] }));
    assert.equal(am.accounts[0].quota.spend.enabled, true);
    assert.equal(said.filter(l => /can bill real money/.test(l)).length, 1);

    // Still enabled on the next probe — the operator is told once, not every 5m.
    am.applyUsageData(0, normalizeUsagePayload({ ...BILLABLE, limits: [] }));
    assert.equal(said.filter(l => /can bill real money/.test(l)).length, 1);

    // Money actually moves: that is its own event, and it is worth saying.
    const spent = { ...BILLABLE, spend: { ...BILLABLE.spend, used: { amount_minor: 4237, currency: 'USD', exponent: 2 } } };
    am.applyUsageData(0, normalizeUsagePayload({ ...spent, limits: [] }));
    const started = said.filter(l => /started spending real money/.test(l));
    assert.equal(started.length, 1);
    assert.match(started[0], /\$42\.37 of \$10,000\.00/);
  } finally {
    console.log = realLog;
  }
});

test('the status screen warns while it can bill, and louder once it has', () => {
  const acct = (spend) => ({ quota: { spend } });
  assert.equal(spendLine(acct(null), paint), null);
  assert.equal(spendLine(acct(normalizeSpend(NEVER_ENABLED)), paint), null);

  const canBill = spendLine(acct(normalizeSpend(BILLABLE)), paint);
  assert.match(canBill, /can bill real money/);
  assert.match(canBill, /\$0\.00 of \$10,000\.00/);

  const billing = spendLine(acct(normalizeSpend({
    ...BILLABLE, spend: { ...BILLABLE.spend, used: { amount_minor: 4237, currency: 'USD', exponent: 2 } },
  })), paint);
  assert.match(billing, /billing real money/);

  // Spent this month but switched off since: still reported, with the reason.
  const past = spendLine(acct(normalizeSpend(OUT_OF_CREDITS)), paint);
  assert.match(past, /€15\.00 of €20\.00 spent this month/);
  assert.match(past, /out_of_credits/);
});

test('the status screen stays silent for accounts that cannot bill', () => {
  const mk = (name, spend) => ({ name, type: 'oauth', status: 'active', quota: { unified5h: 0.2, unified7d: 0.3, spend }, usage: {}, sessions: 0 });
  const out = renderStatus({
    currentAccount: 'a', switchThreshold: 0.98, routes: [], sessions: {},
    accounts: [mk('plain', normalizeSpend(NEVER_ENABLED)), mk('noprobe', null)],
  }, { color: false });
  assert.equal(/Spend/.test(out), false);
});

test('spendTag marks only what billing costs now', () => {
  assert.equal(spendTag({ spend: normalizeSpend(BILLABLE) }), '$');
  assert.equal(spendTag({ spend: normalizeSpend({
    ...BILLABLE, spend: { ...BILLABLE.spend, used: { amount_minor: 1, currency: 'USD', exponent: 2 } },
  }) }), '$!');
  // Spent-then-disabled is history, not a cost of routing here now.
  assert.equal(spendTag({ spend: normalizeSpend(OUT_OF_CREDITS) }), '');
  assert.equal(spendTag({ spend: null }), '');
  assert.equal(spendTag({}), '');
});

// The row is budgeted to the terminal cell. #228 fixed an overflow caused by a
// column the budget did not know about; the money tag is another such column,
// so it gets the same treatment and the same guard.
function renderRows(width, spends) {
  const am = new AccountManager(spends.map((_, i) => ({
    name: `acct${i}@example.com`, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
  })), 0.98);
  const h = 3600_000;
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.4; a.quota.unified5hReset = Date.now() + 4 * h;
    a.quota.unified7d = 0.3; a.quota.unified7dReset = Date.now() + (i + 1) * 24 * h;
    a.quota.unified7dFable = 0.2; a.quota.unified7dFableReset = Date.now() + (i + 1) * 24 * h;
    a.quota.spend = spends[i];
  });
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  const drawn = [];
  try {
    const real = tui._renderAcct.bind(tui);
    tui._renderAcct = (...args) => { const out = real(...args); drawn.push(strip(out)); return out; };
    tui._paint = () => {};
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return drawn;
}

test('the money tag never pushes an account row past the terminal edge', () => {
  const billing = normalizeSpend({ ...BILLABLE, spend: { ...BILLABLE.spend, used: { amount_minor: 4237, currency: 'USD', exponent: 2 } } });
  const spends = [null, normalizeSpend(BILLABLE), billing, normalizeSpend(NEVER_ENABLED), null, billing];
  for (const w of [60, 70, 76, 80, 86, 100, 120, 160]) {
    const rows = renderRows(w, spends);
    const widest = Math.max(...rows.map(r => r.length));
    assert.ok(widest <= w, `W=${w}: widest row is ${widest} columns`);
    assert.ok(rows.some(r => /\$/.test(r)), `W=${w}: the tag was budgeted but never drawn`);
  }
});

test('a fleet with nothing billable spends no columns reserving for the tag', () => {
  // The reserve is conditional: with nothing to mark, those columns go to the
  // bars instead of sitting empty at the end of every row (the mistake #228 was
  // about, in the opposite direction).
  const none = [null, null, null, null, null, null];
  for (const w of [80, 100, 120]) {
    const widest = Math.max(...renderRows(w, none).map(r => r.length));
    assert.ok(w - widest <= 3, `W=${w}: ${w - widest} columns left unused with no tag to draw`);
  }
});
