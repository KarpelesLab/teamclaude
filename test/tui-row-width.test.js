import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, blockedFamilies } from '../src/tui.js';

// The account row is laid out against a width budget. The budget used to count
// only the first two bars, so the S7/F7 bars a Fable/Sonnet fleet draws ran past
// the terminal edge and fitLine cut them off — taking the reset countdown inside
// them with it. These tests pin both halves of the invariant: a row never
// overflows, and it doesn't leave the terminal half empty either.

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

/** Render the dashboard at `width` and return the account rows, ANSI stripped,
 * exactly as _renderAcct produced them (before fitLine pads or truncates). */
function renderRows(width, { fable = [], sonnet = [], accounts = 6 } = {}) {
  const names = Array.from({ length: accounts }, (_, i) => `acct${i}@example.com`);
  const am = new AccountManager(names.map(oauth), 0.98);
  const h = 3600_000;
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.4;
    a.quota.unified5hReset = Date.now() + 4 * h;
    a.quota.unified7d = 0.3;
    a.quota.unified7dReset = Date.now() + (i + 1) * 24 * h;
    if (fable[i] != null) {
      a.quota.unified7dFable = fable[i];
      a.quota.unified7dFableReset = Date.now() + (i + 1) * 24 * h;
    }
    if (sonnet[i] != null) {
      a.quota.unified7dSonnet = sonnet[i];
      a.quota.unified7dSonnetReset = Date.now() + (i + 1) * 24 * h;
    }
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
    // Capture the arguments render() actually passes, so the test can never
    // diverge from the layout decisions under test.
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

const widest = rows => Math.max(...rows.map(r => r.length));

// Widths worth pinning: the showBoth cutoff, a typical half-screen terminal, and
// wide. Below 70 the layout drops to a single bar, which these also cover.
const WIDTHS = [60, 70, 76, 80, 86, 100, 120, 160];

test('no account row overflows the terminal, with or without family bars', () => {
  for (const w of WIDTHS) {
    for (const fable of [[], [null, 0.29, 0.02, 0.0, 0.11, 0.0]]) {
      const rows = renderRows(w, { fable });
      assert.ok(widest(rows) <= w,
        `W=${w} fable=${fable.length > 0}: widest row is ${widest(rows)} columns`);
    }
  }
});

test('a Sonnet AND Fable fleet still fits — four bars on one row', () => {
  for (const w of WIDTHS) {
    const rows = renderRows(w, {
      fable: [0.1, 0.29, 0.02, 0.0, 0.11, 0.0],
      sonnet: [0.2, 0.3, 0.4, 0.1, 0.2, 0.3],
    });
    assert.ok(widest(rows) <= w, `W=${w}: widest row is ${widest(rows)} columns`);
  }
});

test('the row fills the width instead of stopping short', () => {
  // The tag reserve used to be unconditional, leaving ~10 columns dead on every
  // fleet with nothing blocked. Slack past a bar's worth of rounding means the
  // budget is being spent on something the row does not draw.
  for (const w of [70, 76, 80, 86, 100]) {
    const rows = renderRows(w, { fable: [null, 0.29, 0.02, 0.0, 0.11, 0.0] });
    const unused = w - widest(rows);
    assert.ok(unused <= 3, `W=${w}: ${unused} columns left unused`);
  }
});

test('the ⊘ tag gets its own room rather than being cut off', () => {
  // A blocked family adds a trailing tag. It must be budgeted for, not overrun.
  for (const w of [80, 86, 100, 120]) {
    const rows = renderRows(w, { fable: [0.99, 0.29, 0.02, 0.0, 0.99, 0.0] });
    assert.ok(widest(rows) <= w, `W=${w}: widest row is ${widest(rows)} columns`);
    const tagged = rows.filter(r => r.includes('⊘ Fable'));
    assert.equal(tagged.length, 2, `W=${w}: both blocked accounts keep a whole tag`);
  }
});

test('family bars are dropped, not truncated, when they cannot fit', () => {
  // At 70 columns with a blocked family there is no room for a third bar even at
  // the minimum width. Dropping it keeps the row intact; the tag still says why.
  const rows = renderRows(70, { fable: [0.99, 0.99, 0.99, 0.99, 0.99, 0.99] });
  assert.ok(widest(rows) <= 70, `widest row is ${widest(rows)} columns`);
  assert.ok(!rows.some(r => r.includes('F7')), 'the F7 bar is omitted rather than cut');
  assert.ok(rows.every(r => r.includes('⊘ Fable')), 'the blocked tag still explains the state');
});

test('blockedFamilies reports the families barred by their own weekly bucket', () => {
  assert.deepEqual(blockedFamilies({ unified7dFable: 0.99, unified7dSonnet: 0.2 }, 0.98), ['Fable']);
  assert.deepEqual(blockedFamilies({ unified7dFable: 0.99, unified7dSonnet: 1 }, 0.98), ['Sonnet', 'Fable']);
  assert.deepEqual(blockedFamilies({ unified7dFable: 0.5 }, 0.98), []);
  assert.deepEqual(blockedFamilies({}, 0.98), []);
});
