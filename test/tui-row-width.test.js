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
function renderRows(width, { fable = [], sonnet = [], accounts = 6, routes = [], apikey = [] } = {}) {
  const names = Array.from({ length: accounts }, (_, i) => `acct${i}@example.com`);
  const entries = names.map((name, i) => apikey.includes(i)
    ? { name, type: 'apikey', apiKey: `k-${i}` }
    : oauth(name));
  const am = new AccountManager(entries, 0.98, routes.length ? { routes } : {});
  const h = 3600_000;
  am.accounts.forEach((a, i) => {
    if (apikey.includes(i)) {
      // A metered account: the row draws Tok/Req, never a family bar.
      a.quota.tokensLimit = 1_000_000; a.quota.tokensRemaining = 600_000;
      a.quota.requestsLimit = 1000; a.quota.requestsRemaining = 700;
      a.quota.resetsAt = new Date(Date.now() + h).toISOString();
      return;
    }
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
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes }, sx: null,
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

// The `⊘ Sonnet Fable` tag is 16 columns, and until #234 nothing checked that
// what the reservations left could still afford BAR_MIN per bar: `showBoth` was
// a bare `W >= 70`, and the bar-width floor then overrode the budget. The
// fixtures above never produce this because every family bucket in them is far
// below the threshold — they only ever draw the 9-column `⊘ Fable`.
const SPENT = 0.99;   // over the 0.98 switch threshold, so the family is barred

test('a row blocked on BOTH families does not overflow', () => {
  // #234's first repro: two accounts, no routes, W=70 drew 72 columns.
  for (const w of [70, 72, 73, 76, 80, 100]) {
    const rows = renderRows(w, {
      accounts: 2,
      fable: [SPENT, SPENT],
      sonnet: [SPENT, SPENT],
    });
    assert.ok(widest(rows) <= w, `W=${w}: widest row is ${widest(rows)} columns`);
  }
});

test('a blocked row with general routes does not overflow', () => {
  // #234's second repro: two accounts, three shared routes, W=73 drew 76.
  const routes = [
    { match: ['claude-opus-*'], accounts: ['acct0@example.com'] },
    { match: ['claude-haiku-*'], accounts: ['acct1@example.com'] },
    { match: ['claude-3-*'], accounts: ['acct0@example.com'] },
  ];
  for (const w of [70, 73, 76, 80, 90, 120]) {
    const rows = renderRows(w, {
      accounts: 2, routes,
      fable: [SPENT, SPENT],
      sonnet: [SPENT, SPENT],
    });
    assert.ok(widest(rows) <= w, `W=${w}: widest row is ${widest(rows)} columns`);
  }
});

// The blocked tag is the point of the row at that moment, so dropping a bar to
// make room must not drop the tag with it.
test('the blocked tag survives the narrowing', () => {
  const rows = renderRows(70, { accounts: 2, fable: [SPENT, SPENT], sonnet: [SPENT, SPENT] });
  assert.ok(rows.some(r => r.includes('⊘')), 'the blocked tag was dropped to fit');
});

// #234's two remaining cases were about a MIXED fleet. The budget was fleet-wide,
// so an API-key row — which draws Tok/Req and never a family bar — was sized
// for the S7/F7 columns its subscription neighbours draw, and paid for a
// blocked-family tag only they can carry. The budget is per row category now:
// subscription rows share one, API-key rows another.
const isMetered = r => r.includes(' Tok ');

// Widths at which two bars are still under BAR_MAX, so an API-key row CAN fill
// the width: past 86 columns its Tok/Req bars are capped at 20 and the row
// stops short by design (a wider bar carries no more information), exactly as a
// two-bar subscription fleet does.
const UNCAPPED = [70, 76, 80, 86];

test('an API-key row fills its width instead of reserving family columns it never draws', () => {
  for (const w of [...UNCAPPED, 100, 120]) {
    const rows = renderRows(w, { fable: [null, 0.29, 0.02, null, 0.11, 0.0], sonnet: [null, 0.3, 0.4, null, 0.2, 0.3], apikey: [0, 3] });
    const metered = rows.filter(isMetered);
    const unified = rows.filter(r => !isMetered(r));
    assert.equal(metered.length, 2);
    assert.ok(widest(rows) <= w, `W=${w}: widest row is ${widest(rows)} columns`);
    if (!UNCAPPED.includes(w)) continue;
    assert.ok(w - widest(metered) <= 3, `W=${w}: API-key rows leave ${w - widest(metered)} columns unused`);
    assert.ok(w - widest(unified) <= 3, `W=${w}: subscription rows leave ${w - widest(unified)} columns unused`);
  }
});

test('rows line up within their category, not across categories', () => {
  for (const w of [80, 100, 120]) {
    const rows = renderRows(w, { fable: [null, 0.29, 0.02, null, 0.11, 0.0], apikey: [0, 3] });
    const metered = rows.filter(isMetered).map(r => r.length);
    const unified = rows.filter(r => !isMetered(r)).map(r => r.length);
    assert.equal(new Set(metered).size, 1, `W=${w}: API-key rows differ: ${metered.join(', ')}`);
    assert.equal(new Set(unified).size, 1, `W=${w}: subscription rows differ: ${unified.join(', ')}`);
  }
});

test('a blocked family on a subscription row does not shorten the API-key rows', () => {
  for (const w of UNCAPPED) {
    const rows = renderRows(w, { fable: [null, 0.99, 0.02, null, 0.11, 0.0], apikey: [0, 3] });
    assert.ok(rows.some(r => r.includes('⊘ Fable')), 'the fixture blocks a family');
    assert.ok(widest(rows) <= w, `W=${w}: widest row is ${widest(rows)} columns`);
    const metered = rows.filter(isMetered);
    assert.ok(w - widest(metered) <= 3, `W=${w}: the tag cost the API-key rows ${w - widest(metered)} columns`);
  }
});
