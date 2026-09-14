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
