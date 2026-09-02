import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, displayWidth } from '../src/tui.js';

// The name cell holds the one piece of arbitrary user text in the account row,
// so it is where a display-width slip surfaces: CJK characters take two columns
// per UTF-16 unit and combining marks take none, so a cell cut and padded on
// .length pushes everything after it out of line. Rendered rather than
// unit-tested, in the shape tui-row-width.test.js uses — the row lining up is
// the property, and only the renderer knows how wide the cell is.

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function oauth(name) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
}

/** Render the dashboard at `width` with these account names and return the
 * account rows, ANSI stripped, exactly as _renderAcct produced them. */
function renderRows(width, names) {
  const am = new AccountManager(names.map(oauth), 0.98);
  const h = 3600_000;
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.4;
    a.quota.unified5hReset = Date.now() + 4 * h;
    a.quota.unified7d = 0.3;
    a.quota.unified7dReset = Date.now() + (i + 1) * 24 * h;
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
    // Capture what render() actually passed, so the test cannot drift from the
    // layout decisions under test.
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

// A name whose display width and UTF-16 length disagree in each direction: ten
// CJK characters measure twenty columns, and a decomposed 'ñ' carries a
// combining mark that measures none.
const WIDE_NAME = '帳號名字中文帳號名字';
const COMBINING_NAME = 'señor@example.com';
const PLAIN_NAME = 'ascii@example.com';

// The showBoth cutoff, a couple of half-screen terminals, and wide — a sweep so
// the cell is exercised at several widths rather than one lucky one.
const WIDTHS = [60, 70, 76, 80, 86, 100, 120, 160];

test('a name measured in columns keeps every row the same width', () => {
  for (const w of WIDTHS) {
    const rows = renderRows(w, [WIDE_NAME, COMBINING_NAME, PLAIN_NAME]);
    const widths = rows.map(displayWidth);
    assert.equal(new Set(widths).size, 1,
      `W=${w}: rows should all be one width, got ${widths.join(', ')}`);
    assert.ok(widths[0] <= w, `W=${w}: row is ${widths[0]} columns`);
  }
});
