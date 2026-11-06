import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, creditTag } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';
import { CreditMonitor } from '../src/api-credit.js';

// An API-key row with prepaid credit (accounts[].credit) draws a Cr bar after
// Tok/Req and a `$X left` tag. Both are width-budgeted (#234): the row must
// never run past the terminal, in-process or attached, whatever else the
// fleet holds, and the tag must survive where the bar has to go.

const strip = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const DAY = 86_400_000;
const H = 3_600_000;
const anchorDate = () => new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10);
const KEY = 'sk-ant-admin01-tui-test-secret-0123456789';

async function buildFleet({ oauth = true } = {}) {
  const entries = [
    ...(oauth ? [
      { name: 'alice.subscription@example.com', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + H },
      { name: 'bob.subscription@example.com', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + H },
    ] : []),
    { name: 'credit-local@example.com', type: 'apikey', apiKey: 'k1', credit: { amount: 200, cycleStart: anchorDate() } },
    { name: 'credit-admin@example.com', type: 'apikey', apiKey: 'k2', disabled: true, credit: { amount: 200, cycleStart: anchorDate(), adminKey: KEY } },
    { name: 'credit-unread@example.com', type: 'apikey', apiKey: 'k3', credit: { amount: 100, cycleStart: anchorDate(), adminKey: `${KEY}-b` } },
    { name: 'credit-over@example.com', type: 'apikey', apiKey: 'k4', credit: { amount: 100, cycleStart: anchorDate(), adminKey: `${KEY}-c` } },
    { name: 'plain-key@example.com', type: 'apikey', apiKey: 'k5' },
  ];
  const log = console.log;
  console.log = () => {};
  const am = new AccountManager(entries, 0.98);
  console.log = log;
  for (const a of am.accounts) {
    if (a.type === 'oauth') {
      Object.assign(a.quota, { unified5h: 0.4, unified5hReset: Date.now() + 4 * H, unified7d: 0.3, unified7dReset: Date.now() + 3 * DAY, unified7dFable: 0.2, unified7dFableReset: Date.now() + 3 * DAY });
    } else {
      Object.assign(a.quota, { tokensLimit: 1_000_000, tokensRemaining: 600_000, requestsLimit: 1000, requestsRemaining: 700, resetsAt: new Date(Date.now() + 60_000).toISOString() });
    }
  }
  const byName = (/** @type {string} */ n) => /** @type {any} */ (am.accounts.find(a => a.name === n));
  am.recordTokenUsage(byName('credit-local@example.com').index, null, 'claude-opus-5-5', { input_tokens: 2_000_000, output_tokens: 500_000, cache_read_input_tokens: 9_000_000 });
  am.recordTokenUsage(byName('credit-local@example.com').index, null, 'claude-unknown-1', { input_tokens: 10 });
  const answers = new Map([
    [KEY, { ok: true, spentMinor: 4567.8, currency: 'USD', buckets: 5, pages: 1 }],
    [`${KEY}-c`, { ok: false, kind: 'credential', status: 401, message: 'Admin API key rejected (HTTP 401)' }],
  ]);
  const monitor = new CreditMonitor(am, { log: () => {}, fetchSpend: async (o) => /** @type {any} */ (answers.get(o.adminKey) ?? { ok: false, kind: 'network', status: null, message: 'unreached' }) });
  await monitor.poll(byName('credit-admin@example.com'));
  await monitor.poll(byName('credit-over@example.com'));
  // An earlier good reading past the amount, then the failure above: a long
  // tag ("$12,345.67 over!").
  const over = byName('credit-over@example.com');
  over.creditState.admin.reading = { spentMinor: 1_244_567, at: Date.now() - 600_000, cycleStart: over.creditState.admin.cycleStart };
  return am;
}

/** Render every account row at `width`, exactly as render() drew it. */
function renderRows(/** @type {any} */ am, /** @type {number} */ width, remote = false) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {}, remote,
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 60, configurable: true });
  /** @type {string[]} */
  const drawn = [];
  try {
    const real = tui._renderAcct.bind(tui);
    tui._renderAcct = (/** @type {any[]} */ ...args) => { const out = real(...args); drawn.push(out); return out; };
    tui._paint = () => {};
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return drawn;
}

// The widths tui-row-width.test.js pins, and wider.
const WIDTHS = [60, 70, 76, 80, 86, 100, 120, 160, 220];
const widest = (/** @type {string[]} */ rows) => Math.max(...rows.map(r => strip(r).length));

for (const oauth of [true, false]) {
  test(`no row overflows with credit rows in the fleet (${oauth ? 'mixed with subscriptions' : 'API keys only'})`, async () => {
    const am = await buildFleet({ oauth });
    for (const w of WIDTHS) {
      const rows = renderRows(am, w);
      assert.ok(rows.length >= 5, `W=${w}: only ${rows.length} rows drawn`);
      assert.ok(widest(rows) <= w, `W=${w}: widest row is ${widest(rows)} columns`);
    }
  });
}

test('a wide row draws the Cr bar and the amount left; the tag outlives the bar when narrow', async () => {
  const am = await buildFleet();
  const find = (/** @type {string[]} */ rows, /** @type {string} */ name) => strip(/** @type {string} */ (rows.find(r => strip(r).includes(name.slice(0, 12)))));
  const wide = renderRows(am, 220);
  assert.match(find(wide, 'credit-local@example.com'), /Tok .*Req .*Cr .*~\$\d+\.\d\d left\?/);
  assert.match(find(wide, 'credit-admin@example.com'), /Cr .*\$154\.32 left/);
  assert.match(find(wide, 'credit-unread@example.com'), /Cr .*cr \?/);
  assert.match(find(wide, 'credit-over@example.com'), /Cr .*\$12,345\.67 over!/);
  assert.doesNotMatch(find(wide, 'plain-key@example.com'), /Cr |left/);
  const narrow = renderRows(am, 76);
  assert.doesNotMatch(find(narrow, 'credit-admin@example.com'), /Cr /);
  assert.match(find(narrow, 'credit-admin@example.com'), /\$154\.32 left/);
});

test('attach mode draws the same credit off the status payload, and fits', async () => {
  const am = await buildFleet();
  const remote = new RemoteAccountManager();
  remote.applyStatus(JSON.parse(JSON.stringify(am.getStatus())));
  for (const w of WIDTHS) {
    const rows = renderRows(remote, w, true);
    assert.ok(widest(rows) <= w, `W=${w}: widest attached row is ${widest(rows)} columns`);
  }
  const tagOf = (/** @type {string} */ r) => r.match(/(~?\$[\d,.]+ (left|over)[^ ]*|cr \?)/)?.[0] ?? null;
  const local = renderRows(am, 220).map(strip).map(tagOf);
  const attached = renderRows(remote, 220, true).map(strip).map(tagOf);
  assert.deepEqual(attached, local);
  assert.ok(local.filter(Boolean).length >= 4);
});

test('a hostile credit payload cannot put an escape sequence into the attached row', async () => {
  const am = await buildFleet({ oauth: false });
  const status = JSON.parse(JSON.stringify(am.getStatus()));
  const row = status.accounts.find((/** @type {any} */ a) => a.credit?.source === 'admin' && a.credit.spentMinor != null);
  row.credit.currency = '\x1b]0;owned\x07EUR';
  row.credit.error = { kind: 'credential\x1b[2J', status: 'x', message: '\x1b[31mred' };
  row.credit.remainingMinor = 'lots';
  const remote = new RemoteAccountManager();
  remote.applyStatus(status);
  for (const r of renderRows(remote, 160, true)) {
    assert.ok(!strip(r).includes('\x1b'), JSON.stringify(strip(r)));
  }
});

test('creditTag: the source, the shortfall and the failure each show', () => {
  const base = { currency: 'USD', exponent: 2, amountMinor: 20000, remainingMinor: 17655, exceededMinor: 0, incomplete: null, error: null };
  assert.equal(creditTag(null), '');
  assert.equal(creditTag({ ...base, source: 'admin' }), '$176.55 left');
  assert.equal(creditTag({ ...base, source: 'local' }), '~$176.55 left');
  assert.equal(creditTag({ ...base, source: 'local', incomplete: { replies: 1, models: [] } }), '~$176.55 left?');
  assert.equal(creditTag({ ...base, source: 'admin', remainingMinor: 0, exceededMinor: 1230 }), '$12.30 over');
  assert.equal(creditTag({ ...base, source: 'local', remainingMinor: 0, exceededMinor: 1230 }), '~$12.30 over');
  assert.equal(creditTag({ ...base, source: 'admin', remainingMinor: 0, exceededMinor: 0 }), '$0.00 left');
  assert.equal(creditTag({ ...base, source: 'admin', remainingMinor: null, error: { kind: 'credential' } }), 'cr key!');
  assert.equal(creditTag({ ...base, source: 'admin', remainingMinor: null, error: { kind: 'http' } }), 'cr err');
  assert.equal(creditTag({ ...base, source: 'admin', remainingMinor: null }), 'cr ?');
  assert.equal(creditTag({ ...base, source: 'admin', error: { kind: 'network' } }), '$176.55 left!');
});
