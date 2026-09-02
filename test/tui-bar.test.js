import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { RemoteAccountManager } from '../src/tui-remote.js';
import { TUI, bar } from '../src/tui.js';

// The label is overlaid on the bar's background, so its foreground must
// contrast with each fill color: black on green/yellow (both render light in
// many terminal themes), white only on red.
test('green and yellow fills use a black label', () => {
  assert.match(bar(0.5, 10), /\x1b\[42;30m/);
  assert.match(bar(0.8, 10), /\x1b\[43;30m/);
});

test('red fill keeps a white label', () => {
  assert.match(bar(0.95, 10), /\x1b\[41;97m/);
});

test('empty portion keeps gray-on-gray', () => {
  assert.match(bar(0.5, 10), /\x1b\[100;37m/);
});

// With a known window, color tracks burn rate: usage minus the share of the
// window already elapsed, not raw fill. A half-elapsed window (reset half the
// window away) is the fixed reference point for these.
const WINDOW = 60 * 60 * 1000;
const halfElapsedReset = () => Date.now() + WINDOW / 2; // 50% of the window gone

test('under pace is green even at high fill', () => {
  // 30% used, 50% elapsed -> diff -20 -> green, where raw 0.3 is also green but
  // the point is 0.8 flips too:
  assert.match(bar(0.3, 10, halfElapsedReset(), WINDOW), /\x1b\[42;30m/);
  // 60% used, 90% elapsed -> diff -30 -> green, though raw 0.6 would still be green;
  // use 88% used with 90% elapsed -> diff -2 -> green while raw 0.88 is red.
  assert.match(bar(0.88, 10, Date.now() + WINDOW * 0.1, WINDOW), /\x1b\[42;30m/);
});

test('slightly ahead of pace is yellow', () => {
  // 54% used, 50% elapsed -> diff 4 -> yellow.
  assert.match(bar(0.54, 10, halfElapsedReset(), WINDOW), /\x1b\[43;30m/);
});

test('well ahead of pace is orange (256-color background)', () => {
  // 62% used, 50% elapsed -> diff 12 -> orange.
  assert.match(bar(0.62, 10, halfElapsedReset(), WINDOW), /\x1b\[48;5;208;30m/);
});

test('far ahead of pace is red', () => {
  // 70% used, 50% elapsed -> diff 20 -> red.
  assert.match(bar(0.70, 10, halfElapsedReset(), WINDOW), /\x1b\[41;97m/);
});

test('without a window it falls back to raw utilization', () => {
  // Same 0.88 that read green at 10% elapsed with a window is plain yellow on
  // the raw thresholds here (0.7 <= 0.88 < 0.9), so the window genuinely changes
  // the verdict rather than the fill alone.
  assert.match(bar(0.88, 10), /\x1b\[43;30m/);
});

// Routing eligibility outranks pace. `_isNearQuota` bars an account whose bucket
// sits at or above the switch threshold, so a bar reading green there would
// contradict the `exhausted` status cell drawn next to it.
test('a bucket at the switch threshold is red however good the pace', () => {
  const almostOver = Date.now() + WINDOW * 0.01; // 99% of the window elapsed
  // 98% used against 99% elapsed: pace alone calls this green.
  assert.match(bar(0.98, 10, almostOver, WINDOW), /\x1b\[42;30m/);
  assert.match(bar(0.98, 10, almostOver, WINDOW, 0.98), /\x1b\[41;97m/);
});

test('below the threshold the pace still decides', () => {
  // 90% used against 99% elapsed, threshold 98%: still eligible, so pace rules
  // and the top end of the scale does not collapse into red.
  assert.match(bar(0.9, 10, Date.now() + WINDOW * 0.01, WINDOW, 0.98), /\x1b\[42;30m/);
});

// A window length with no reset timestamp is the same dead end as an elapsed
// one: there is no point in the window to measure against, so the raw scale
// decides rather than an elapsed share invented from a missing value.
test('a window with no reset timestamp uses the raw scale', () => {
  assert.match(bar(0.95, 10, undefined, WINDOW), /\x1b\[41;97m/);
  assert.match(bar(0.5, 10, null, WINDOW), /\x1b\[42;30m/);
});

test('the threshold also overrides the windowless raw scale', () => {
  // A token/request bar has no window, and a threshold can be set as low as 1%,
  // so raw fill under 70% can still be past the point of routing.
  assert.match(bar(0.65, 10), /\x1b\[42;30m/);
  assert.match(bar(0.65, 10, undefined, undefined, 0.6), /\x1b\[41;97m/);
});

// The row renderer has to hand the live threshold to every bar it draws, or the
// clamp above never reaches the screen. Rendered, not called directly: the
// argument list is the thing under test.
function renderRow(quota, threshold = 0.98) {
  const am = new AccountManager(
    [{ name: 'acct@example.com', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    threshold);
  Object.assign(am.accounts[0].quota, quota);
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  let drawn = '';
  try {
    const real = tui._renderAcct.bind(tui);
    tui._renderAcct = (...args) => { const out = real(...args); drawn = out; return out; };
    tui._paint = () => {};
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return drawn;
}

test('a spent session bucket renders red on the row, not just in bar()', () => {
  const h = 3600_000;
  // 99% of a 5h bucket with a minute left on the window: pace says green, and
  // the rotation has already stopped routing here.
  const spent = renderRow({ unified5h: 0.99, unified5hReset: Date.now() + 60_000, unified7d: 0.3, unified7dReset: Date.now() + 3 * 24 * h });
  assert.match(spent, /\x1b\[41;97m/);
  // Same window, same elapsed share, one point below the threshold: no red.
  const usable = renderRow({ unified5h: 0.97, unified5hReset: Date.now() + 60_000, unified7d: 0.3, unified7dReset: Date.now() + 3 * 24 * h });
  assert.doesNotMatch(usable, /\x1b\[41;97m/);
});

/** The SGR parameters of the bar drawn immediately after `label` on a row.
 *  Locating the bar by its own label keeps each assertion about one bucket,
 *  so a colour change in a neighbouring bar cannot satisfy it by accident. */
function fillAfter(row, label) {
  const rest = row.slice(row.indexOf(label) + label.length);
  const m = /\x1b\[([\d;]+)m/.exec(rest);
  return m && m[1];
}

// Each bucket is paced against its own window length, and mixing them up is
// invisible without a test: pace a five-hour bucket against a week and the
// elapsed share is always ~100%, so the bar reads green at every fill below the
// threshold — the exact failure the colouring exists to prevent.
test('the session bar is paced against five hours, not the weekly window', () => {
  const h = 3600_000;
  // Half of the session bucket spent an hour into it: 50% used, 20% elapsed,
  // diff 30 -> red. Against a seven-day window the same row reads green.
  const row = renderRow({
    unified5h: 0.5, unified5hReset: Date.now() + 4 * h,
    unified7d: 0.3, unified7dReset: Date.now() + 3 * 24 * h,
  });
  assert.equal(fillAfter(row, 'Ses '), '41;97');
});

test('the weekly bar is paced against seven days, not the session window', () => {
  const h = 3600_000;
  // 10% of the weekly bucket one day in: 14.3% elapsed, diff -4.3 -> green.
  // Against a five-hour window the elapsed share floors at 0 and it turns orange.
  const row = renderRow({
    unified5h: 0.05, unified5hReset: Date.now() + 4 * h,
    unified7d: 0.1, unified7dReset: Date.now() + 6 * 24 * h,
  });
  assert.equal(fillAfter(row, 'Wk  '), '42;30');
});

test('the family weekly bars are paced against seven days too', () => {
  const h = 3600_000;
  // Same shape as the weekly bar above, on the two buckets that carry their
  // window inline at the call site instead of through w1/w2 — and they are two
  // separate call sites, so both are asserted.
  const row = renderRow({
    unified5h: 0.05, unified5hReset: Date.now() + 4 * h,
    unified7d: 0.1, unified7dReset: Date.now() + 6 * 24 * h,
    unified7dSonnet: 0.1, unified7dSonnetReset: Date.now() + 6 * 24 * h,
    unified7dFable: 0.1, unified7dFableReset: Date.now() + 6 * 24 * h,
  });
  assert.equal(fillAfter(row, 'S7  '), '42;30');
  assert.equal(fillAfter(row, 'F7  '), '42;30');
});

// A reset timestamp in the past would give the pace arithmetic a fully-elapsed
// window and colour a nearly-spent bucket calm. In local mode it never gets the
// chance: _render calls refreshExpiredQuotas before it computes anything, so the
// bucket is already null and the bar takes the no-data fill.
test('an expired session window is cleared before the row is drawn', () => {
  const row = renderRow({
    unified5h: 0.95, unified5hReset: Date.now() - 60_000,
    unified7d: 0.3, unified7dReset: Date.now() + 3 * 24 * 3600_000,
  });
  assert.equal(fillAfter(row, 'Ses '), '100');
  assert.doesNotMatch(row, /95%/);
});

/** The same row, drawn from a server status payload instead of a local manager.
 *  Attach mode has no expiry sweep of its own — RemoteAccountManager leaves that
 *  to the server — so this is the path on which a stale window reaches a bar. */
function renderRemoteRow(quota, threshold = 0.98) {
  const am = new RemoteAccountManager();
  am.applyStatus({
    currentAccount: 'acct@example.com',
    switchThreshold: threshold,
    routes: [],
    sessions: { active: 0, known: 0, perAccount: {} },
    accounts: [{ name: 'acct@example.com', type: 'oauth', status: 'active', usage: {}, quota }],
  });
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
    probeQuota: null, remote: true, applySwitch: async () => {},
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  let drawn = '';
  try {
    const real = tui._renderAcct.bind(tui);
    tui._renderAcct = (...args) => { const out = real(...args); drawn = out; return out; };
    tui._paint = () => {};
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return drawn;
}

// An elapsed window carries no pace to measure, which is the same position as a
// bucket with no window at all — so the raw scale decides, as it does there.
// Without that, elapsed time reads as 100% of the window and every fill below
// the threshold comes out green, while the label falls back to the percentage
// because there is no countdown left: a green bar reading 95%, disagreeing with
// itself. The bar and its own label have to tell the same story whether or not
// the number under them is current.
test('an elapsed window falls back to the raw scale instead of reading green', () => {
  const row = renderRemoteRow({
    unified5h: 0.95, unified5hReset: Date.now() - 60_000,
    unified7d: 0.30, unified7dReset: Date.now() + 3 * 24 * 3600_000,
  });
  assert.equal(fillAfter(row, 'Ses '), '41;97');
  assert.match(row, /95%/);
});
