import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleBounds, accountCredit } from '../src/api-credit.js';

// The billing cycle behind accounts[].credit: monthly from the anchor's day of
// the month, at 00:00 UTC, and an anchor past a month's last day lands on that
// last day for that month only. These pin the parse of fixed instants, not an
// ordering against the clock, so they cannot go stale.

const at = (/** @type {string} */ s) => Date.parse(s);
const day = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10);

test('the cycle runs from the anchor day to the same day next month', () => {
  const { start, end } = cycleBounds(2, at('2026-11-06T12:00:00Z'));
  assert.equal(new Date(start).toISOString(), '2026-11-02T00:00:00.000Z');
  assert.equal(new Date(end).toISOString(), '2026-12-02T00:00:00.000Z');
});

test('before the anchor day the cycle is the one that began last month', () => {
  const { start, end } = cycleBounds(2, at('2026-11-01T23:59:59.999Z'));
  assert.equal(day(start), '2026-10-02');
  assert.equal(day(end), '2026-11-02');
});

test('the anchor instant itself starts the new cycle', () => {
  const { start } = cycleBounds(2, at('2026-11-02T00:00:00Z'));
  assert.equal(new Date(start).toISOString(), '2026-11-02T00:00:00.000Z');
});

test('an anchor of the 31st falls on the last day of a shorter month, then returns', () => {
  assert.deepEqual([cycleBounds(31, at('2026-02-15T00:00:00Z'))].map(c => [day(c.start), day(c.end)]), [['2026-01-31', '2026-02-28']]);
  assert.deepEqual([cycleBounds(31, at('2026-03-10T00:00:00Z'))].map(c => [day(c.start), day(c.end)]), [['2026-02-28', '2026-03-31']]);
  assert.deepEqual([cycleBounds(31, at('2026-05-01T00:00:00Z'))].map(c => [day(c.start), day(c.end)]), [['2026-04-30', '2026-05-31']]);
});

test('a leap year gives February its 29th', () => {
  const { start, end } = cycleBounds(31, at('2028-03-01T00:00:00Z'));
  assert.equal(day(start), '2028-02-29');
  assert.equal(day(end), '2028-03-31');
  assert.equal(day(cycleBounds(30, at('2028-02-29T12:00:00Z')).start), '2028-02-29');
});

test('the cycle crosses the year', () => {
  assert.deepEqual(Object.values(cycleBounds(15, at('2026-12-20T00:00:00Z'))).map(day), ['2026-12-15', '2027-01-15']);
  assert.deepEqual(Object.values(cycleBounds(15, at('2027-01-03T00:00:00Z'))).map(day), ['2026-12-15', '2027-01-15']);
});

test('cycles chain end to start with no gap and no drift, for every anchor day', () => {
  for (let anchor = 1; anchor <= 31; anchor++) {
    let now = at('2026-01-01T00:00:00Z');
    let prevEnd = null;
    for (let i = 0; i < 30; i++) {
      const { start, end } = cycleBounds(anchor, now);
      if (prevEnd != null) assert.equal(start, prevEnd, `anchor ${anchor}: a gap before ${day(start)}`);
      const d = new Date(start);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      assert.equal(d.getUTCDate(), Math.min(anchor, last), `anchor ${anchor}: ${day(start)} drifted`);
      assert.equal(d.getUTCHours() + d.getUTCMinutes(), 0);
      assert.ok(start <= now && now < end);
      prevEnd = end;
      now = end;
    }
  }
});

/** Run fn with console.log captured. @param {() => any} fn */
function quiet(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try { return { value: fn(), lines }; } finally { console.log = real; }
}

const KEY = 'sk-ant-admin01-cycle-test-secret-0123456789';
const apikey = (/** @type {any} */ credit, extra = {}) => ({ name: 'credit', type: 'apikey', apiKey: 'k', credit, ...extra });

test('a valid credit setting is normalized to minor units and an anchor day', () => {
  const { value } = quiet(() => accountCredit(apikey({ amount: 200, currency: 'usd', cycleStart: '2026-11-02', adminKey: KEY, refreshMinutes: 30 })));
  assert.deepEqual(value, {
    amountMinor: 20000, currency: 'USD', exponent: 2, anchorDay: 2, cycleStart: '2026-11-02', adminKey: KEY, refreshMs: 30 * 60_000,
  });
  const plain = quiet(() => accountCredit(apikey({ amount: 100, cycleStart: '2026-01-31' }))).value;
  assert.equal(plain.currency, 'USD');
  assert.equal(plain.adminKey, null);
  assert.equal(plain.refreshMs, 15 * 60_000);
  assert.equal(plain.anchorDay, 31);
});

test('a credit setting that cannot be used is dropped with a line saying why, never naming the key', () => {
  const cases = [
    ['not an object', apikey(200)],
    ['an OAuth account', { name: 'o', type: 'oauth', accessToken: 't', credit: { amount: 200, cycleStart: '2026-11-02', adminKey: KEY } }],
    ['a third-party upstream', apikey({ amount: 200, cycleStart: '2026-11-02', adminKey: KEY }, { upstream: 'https://api.deepseek.com/anthropic' })],
    ['no amount', apikey({ cycleStart: '2026-11-02', adminKey: KEY })],
    ['a negative amount', apikey({ amount: -5, cycleStart: '2026-11-02', adminKey: KEY })],
    ['another currency', apikey({ amount: 200, currency: 'EUR', cycleStart: '2026-11-02', adminKey: KEY })],
    ['an impossible date', apikey({ amount: 200, cycleStart: '2026-02-30', adminKey: KEY })],
    ['a non-date', apikey({ amount: 200, cycleStart: 'monthly', adminKey: KEY })],
  ];
  for (const [label, acct] of cases) {
    const { value, lines } = quiet(() => accountCredit(acct));
    assert.equal(value, null, label);
    assert.equal(lines.length, 1, `${label}: one line`);
    assert.match(lines[0], /ignoring credit/, label);
    assert.ok(!lines[0].includes(KEY), `${label}: the line names the admin key`);
  }
  assert.equal(quiet(() => accountCredit(apikey(undefined))).value, null);
  assert.equal(quiet(() => accountCredit(apikey(undefined))).lines.length, 0);
});

test('a key that is not an admin key is kept, with a warning that does not print it', () => {
  const notAdmin = 'sk-ant-api03-not-an-admin-key-0123456789';
  const { value, lines } = quiet(() => accountCredit(apikey({ amount: 200, cycleStart: '2026-11-02', adminKey: notAdmin })));
  assert.equal(value.adminKey, notAdmin);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(notAdmin));
});
