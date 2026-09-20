import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

// One person's ChatGPT and Claude subscriptions are usually the same email, so a mixed
// pool lists that address twice. The name column cannot tell those rows apart, and the
// column beside it said `oauth` on every row — the one thing the operator already knew.
// These pin that the column carries the disambiguating fact when there is one, and is
// left alone when there is not.

const HOUR = 3600_000;
const oauth = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: `t-${name}-${extra.provider ?? 'a'}`,
  refreshToken: 'r', expiresAt: Date.now() + HOUR, ...extra,
});

function tuiFor(accounts) {
  const am = new AccountManager(accounts, 0.98);
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts, routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  tui.render = () => {};
  return tui;
}

// Strip SGR so the assertions read the text, not the colouring.
const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const plain = (s) => s.replace(SGR, '');
// A name column wide enough to hold the addresses, because the case under test is two
// rows carrying the SAME address, told apart only by the column beside it.
const rowOf = (tui, i) => plain(tui._renderAcct(i, 20, false, undefined, undefined, undefined, undefined, 32));

test('a mixed pool names each row provider', () => {
  const tui = tuiFor([
    oauth('someone@example.com'),
    oauth('someone@example.com', { provider: 'codex', accountId: 'acct-1' }),
  ]);
  const claude = rowOf(tui, 0), codex = rowOf(tui, 1);
  assert.match(claude, /Anthropic/);
  assert.match(codex, /Codex/);
  // The same address on both rows is exactly the case the column has to resolve.
  assert.match(claude, /someone@example\.com/);
  assert.match(codex, /someone@example\.com/);
});

// Width follows the labels present, so the longer one is never cut down to fit.
test('the provider label is not truncated', () => {
  const tui = tuiFor([
    oauth('a@example.com'),
    oauth('b@example.com', { provider: 'codex', accountId: 'acct-2' }),
  ]);
  assert.match(rowOf(tui, 0), /Anthropic\s/, 'the longer label keeps all of its characters');
});

// A pool that serves one provider learns nothing from a column repeating its name, so
// it keeps the auth kind it shows today.
test('a single-provider pool keeps showing the auth type', () => {
  const tui = tuiFor([oauth('a@example.com'), oauth('b@example.com')]);
  const row = rowOf(tui, 0);
  assert.match(row, /oauth/);
  assert.doesNotMatch(row, /Anthropic/);
});

test('a codex-only pool also keeps the auth type', () => {
  const tui = tuiFor([
    oauth('a@example.com', { provider: 'codex', accountId: 'acct-3' }),
    oauth('b@example.com', { provider: 'codex', accountId: 'acct-4' }),
  ]);
  const row = rowOf(tui, 0);
  assert.match(row, /oauth/);
  assert.doesNotMatch(row, /Codex/);
});

// The budget reserved 7 columns for `Anthropic` (9), so mixed rows ran 2 past the
// edge. It only shows on a row carrying every reserved tag itself.
test('a mixed pool row never outgrows the terminal', () => {
  const tui = tuiFor([
    oauth('someone@example.com'),
    oauth('someone@example.com', { provider: 'codex', accountId: 'acct-5' }),
  ]);
  const claude = tui.am.accounts[0];
  Object.assign(claude.quota, {
    unified5h: 0.4, unified5hReset: Date.now() + 4 * HOUR,
    unified7d: 0.3, unified7dReset: Date.now() + 48 * HOUR,
    unified7dFable: 0.995, unified7dFableReset: Date.now() + 48 * HOUR,
    spend: { enabled: true, usedMinor: 0 },
  });
  Object.assign(tui.am.accounts[1].quota, { unified5h: 0.1, unified7d: 0.2, unified7dReset: Date.now() + 24 * HOUR });
  for (const width of [70, 80, 100, 120, 160]) {
    for (const row of drawnRows(tui, width)) {
      assert.ok(row.length <= width, `W=${width}: ${row.length} columns: ${row}`);
    }
  }
});

/** The rows render() draws at `width`, ANSI stripped, before fitLine pads or cuts them. */
function drawnRows(tui, width) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  const drawn = [];
  const real = tui._renderAcct;
  try {
    tui._renderAcct = (...args) => { const out = real.apply(tui, args); drawn.push(plain(out)); return out; };
    tui._paint = () => {};
    tui.running = true;
    TUI.prototype.render.call(tui, true);
  } finally {
    tui._renderAcct = real;
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    else delete process.stdout.columns;
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
    else delete process.stdout.rows;
  }
  return drawn;
}
