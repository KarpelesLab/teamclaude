// A pool with both providers is drawn as two panes, one per provider; one column,
// grouped by provider, when the panes cannot draw every bar the rows have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const h = 3600_000;
const GUTTER = ' │ ';

const claude = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + h });
const codex = (name) => ({ name, type: 'oauth', provider: 'codex', accountId: `acct-${name}`, accessToken: `c-${name}`, refreshToken: 'r', expiresAt: Date.now() + h });
const apikey = (name) => ({ name, type: 'apikey', apiKey: `k-${name}` });

/** Readings on every account: a Claude row also gets a Fable bucket, an API key its metered pair. */
function fill(am) {
  am.accounts.forEach((a, i) => {
    if (a.type === 'apikey') {
      Object.assign(a.quota, { tokensLimit: 1000, tokensRemaining: 600, requestsLimit: 100, requestsRemaining: 70, resetsAt: new Date(Date.now() + h).toISOString() });
      return;
    }
    Object.assign(a.quota, { unified5h: 0.2, unified5hReset: Date.now() + 3 * h, unified7d: 0.3 + i / 20, unified7dReset: Date.now() + (i + 1) * 24 * h });
    if (a.provider !== 'codex') Object.assign(a.quota, { unified7dFable: 0.4, unified7dFableReset: Date.now() + 2 * 24 * h });
  });
  return am;
}
const fleet = (accounts, opts = {}) => fill(new AccountManager(accounts, 0.98, opts));
// The budget a row is drawn from: the layout keys its budgets by this category.
const rowCategoryOf = (a) => (a.type === 'oauth' || a.quota.unified5h != null || a.quota.unified7d != null ? 'unified' : 'metered');

/** Render at `width`: the frame's lines, and each row before fitLine cuts it, since the
 *  frame is always exactly `width` wide and only raw rows can show an overrun. */
function screen(am, width, { remote = false } = {}) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
    remote,
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  let buf = '';
  const drawn = [];
  try {
    const real = tui._renderRow.bind(tui);
    tui._renderRow = (idx, L, current) => {
      const out = real(idx, L, current);
      const b = L.budgets.get(rowCategoryOf(am.accounts[idx]));
      drawn.push({ idx, pane: L.compact, width: L.width, nameW: L.nameW, bw: b.bw, text: strip(out) });
      return out;
    };
    tui._paint = (b) => { buf = b; };
    tui.running = true;
    tui.render(true);
  } finally {
    // A non-TTY stdout has no own size properties: remove the mocked ones rather
    // than leave them for the next test to read.
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    else delete process.stdout.columns;
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
    else delete process.stdout.rows;
  }
  const lines = strip(buf).replace(/^\x1b\[H/, '').split('\r\n').map(l => l.replace(/\x1b\[\?25[hl]$/, ''));
  return { lines, drawn, tui };
}

const listLines = (lines) => lines.slice(2, lines.findIndex(l => /^ (Activity|Messages)/.test(l)));
const accountRows = (lines) => listLines(lines).slice(1).filter(l => l.trim());
const halves = (row) => [row.slice(0, row.indexOf(GUTTER)), row.slice(row.indexOf(GUTTER) + GUTTER.length)];
// The name the current-account ► sits in front of. A Claude row also draws ► before
// the F7 bar of the account the Fable route targets, which is not this marker.
const currentNames = (rows) => rows.map(r => r.match(/►\s+(\S+@\S+)/)?.[1]).filter(Boolean);
const splits = (am, width) => listLines(screen(am, width).lines)[0].includes('│');

test('a mixed pool at a wide terminal is two panes, as tall as the larger pool', () => {
  const am = fleet([claude('a@x.com'), claude('b@x.com'), claude('c@x.com'), codex('k1@x.com'), codex('k2@x.com')]);
  const { lines } = screen(am, 160);
  assert.match(listLines(lines)[0], /^ Anthropic ─+ │  Codex ─+\s*$/);
  const rows = accountRows(lines);
  assert.equal(rows.length, 3, 'three rows: the larger pool');
  const [left, right] = halves(rows[0]);
  assert.match(left, /a@x\.com +active +Ses .*Wk .*F7/, 'no type cell; the Anthropic pane keeps its family bar');
  assert.match(right, /k1@x\.com +active +Ses .*Wk /);
  assert.doesNotMatch(right, /F7/);
  assert.match(rows[2], /c@x\.com/);
  assert.equal(halves(rows[2])[1].trim(), '', 'the shorter pane leaves its rows blank');
});

test('every row puts the gutter in the same column as the title line', () => {
  const am = fleet([claude('a-long-name@example.com'), claude('b@x.com'), codex('k1@x.com')]);
  // Wide enough that the left rows end short of their pane, where only padding holds the gutter.
  for (const width of [140, 170, 240]) {
    const list = listLines(screen(am, width).lines).filter(l => l.trim());
    const at = list[0].indexOf(GUTTER);
    assert.ok(at > 0, `W=${width} splits`);
    for (const l of list) assert.equal(l.indexOf(GUTTER), at, `W=${width}: ${l}`);
  }
});

test('the split costs no height: the titles sit in the spacer line', () => {
  const activityAt = ({ lines }) => lines.findIndex(l => /^ Activity/.test(l));
  assert.equal(
    activityAt(screen(fleet([claude('a@x.com'), codex('k1@x.com')]), 160)),
    activityAt(screen(fleet([claude('a@x.com')]), 160)),
  );
});

test('it splits only when both panes draw every bar the one-column list draws', () => {
  const am = fleet([claude('a@x.com'), claude('b@x.com'), codex('k1@x.com'), codex('k2@x.com')]);
  am.accounts[1].quota.unified7dFable = 0.995; // a blocked family: F7 bar plus a `⊘ Fable` tag
  let first = null;
  for (let w = 100; w <= 200; w++) {
    const { lines, drawn } = screen(am, w);
    if (!listLines(lines)[0].includes('│')) {
      assert.equal(first, null, `W=${w} went back to one column after splitting at ${first}`);
      continue;
    }
    first ??= w;
    for (const row of drawn.filter(r => am.accounts[r.idx].provider !== 'codex')) {
      assert.match(row.text, /F7/, `W=${w}: the pane dropped a family bar the list draws: ${row.text}`);
    }
    // And never so narrow that a bar cuts its reset label (`10h23m` needs 6 plus a cell).
    for (const row of drawn) assert.ok(row.bw >= 8, `W=${w}: a pane bar is ${row.bw} wide: ${row.text}`);
  }
  assert.ok(first != null && first < 200, 'some width in the sweep splits');
});

test('no row outgrows its pane or the terminal, across widths', () => {
  const routes = [{ name: 'fast', match: ['claude-opus-*'], accounts: ['a-long-name@example.com', 'b@x.com'] }];
  const am = fleet([
    claude('a-long-name@example.com'), claude('b@x.com'), apikey('key@x.com'),
    codex('k1-long-name@example.com'), codex('k2@x.com'),
  ], { routes });
  // Every reserved tag on ONE row, so no other row's reservation hides an overrun.
  Object.assign(am.accounts[1].quota, { unified7dFable: 0.995, spend: { enabled: true, usedMinor: 0 } });
  let paned = 0;
  for (let w = 60; w <= 240; w += 3) {
    const { drawn } = screen(am, w);
    for (const row of drawn) {
      assert.ok(row.text.length <= row.width, `W=${w} ${row.pane ? 'pane' : 'list'} row is ${row.text.length} > ${row.width}: ${row.text}`);
    }
    const panes = drawn.filter(r => r.pane);
    if (panes.length) {
      paned++;
      const widths = [...new Set(panes.map(r => r.width))];
      assert.ok(widths.reduce((s, x) => s + x, 0) <= w - GUTTER.length, `W=${w}: panes ${widths} overrun the terminal`);
    }
  }
  assert.ok(paned > 0, 'the sweep reached widths that split');
});

test('the width goes to whole names before wider bars, and to the pane that needs it', () => {
  // Three bars and a blocked tag on the left, two bars on the right: an even split
  // cut the left names while the right pane padded.
  const am = fleet([
    claude('someone.long@example.com'), claude('another.long@example.com'),
    codex('someone.long@example.com'), codex('k2@x.com'),
  ]);
  am.accounts[1].quota.unified7dFable = 0.995;
  // 158 columns hold both panes' whole names, but not two halves of 77.
  const rows = accountRows(screen(am, 158).lines);
  for (const r of rows) {
    for (const side of halves(r)) {
      if (side.trim()) assert.match(side, /(someone|another)\.long@example\.com|k2@x\.com/, `a name was cut: ${side}`);
    }
  }
});

test('a width short of whole names on both sides is shared, not given to one pane', () => {
  const am = fleet([
    claude('someone.long@example.com'), claude('another.long@example.com'),
    codex('someone.longer.name@example.com'), codex('k2@x.com'),
  ]);
  am.accounts[1].quota.unified7dFable = 0.995;
  // Neither pane's names fit whole at 150. The Codex pane's 62-column minimum
  // already leaves its name cell 20 wide, so it has to end up wider than that.
  const { drawn } = screen(am, 150);
  const [left, right] = [drawn.find(r => r.pane && r.idx === 0), drawn.find(r => r.pane && r.idx === 2)];
  assert.ok(left && right, 'it splits');
  assert.ok(left.nameW < 24 && right.nameW < 31, `the stage is only partly met: ${left.nameW} / ${right.nameW}`);
  assert.ok(left.nameW > 12, `the Anthropic pane got name columns: ${left.nameW}`);
  assert.ok(right.nameW > 20, `the Codex pane got name columns past its minimum: ${right.nameW}`);
});

test('each pane marks the account its own provider cursor names', () => {
  const am = fleet([claude('a@x.com'), claude('b@x.com'), codex('k1@x.com'), codex('k2@x.com')]);
  am.setCurrentAccount(1);
  am.setCurrentAccount(3);
  const rows = accountRows(screen(am, 160).lines);
  assert.deepEqual(currentNames(rows.map(r => halves(r)[0])), ['b@x.com']);
  assert.deepEqual(currentNames(rows.map(r => halves(r)[1])), ['k2@x.com']);
});

test('an API-key account sits in its provider\'s pane, metered, and route cells stay in that pane', () => {
  const routes = [{ name: 'fast', match: ['claude-opus-*'], accounts: ['key@x.com'] }];
  const am = fleet([claude('a@x.com'), apikey('key@x.com'), codex('k1@x.com')], { routes });
  const rows = accountRows(screen(am, 170).lines);
  const [left, right] = halves(rows[1]);
  assert.match(left, /key@x\.com +active +Tok .*Req /);
  assert.equal(right.trim(), '');
  // The route's marker cell is reserved on the Anthropic side only: the Codex row
  // starts right after its selection and current markers.
  assert.match(halves(rows[0])[1], /^ {2}[► ] k1@x\.com/, halves(rows[0])[1]);
});

test('a narrow terminal keeps one column, grouped by provider, each row named', () => {
  const am = fleet([codex('k1@x.com'), claude('a@x.com'), claude('b@x.com')]);
  const { lines } = screen(am, 100);
  assert.equal(listLines(lines)[0].trim(), '', 'no pane titles');
  const rows = accountRows(lines);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /a@x\.com\s+Anthropic/);
  assert.match(rows[1], /b@x\.com\s+Anthropic/);
  assert.match(rows[2], /k1@x\.com\s+Codex/);
  assert.ok(!rows.some(r => r.includes('│')));
  assert.equal(currentNames(rows).length, 2, 'both pools mark their current account');
});

test('a single-provider pool is unchanged: one column, no titles, one marker', () => {
  for (const accounts of [[claude('a@x.com'), claude('b@x.com')], [codex('k1@x.com'), codex('k2@x.com')]]) {
    const am = fleet(accounts);
    assert.equal(splits(am, 200), false);
    const rows = accountRows(screen(am, 200).lines);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /oauth/, 'the type column keeps the auth kind');
    assert.equal(currentNames(rows).length, 1);
  }
});

test('a Codex pane whose accounts state no five-hour window drops Ses; Wk takes the first slot', () => {
  const am = fleet([claude('a@x.com'), codex('k1@x.com'), codex('k2@x.com')]);
  for (const i of [1, 2]) { am.accounts[i].quota.unified5h = null; am.accounts[i].quota.unified5hReset = null; }
  const [left, right] = halves(accountRows(screen(am, 160).lines)[0]);
  assert.match(left, /Ses .*Wk .*F7/, 'the Anthropic pane is unchanged');
  assert.doesNotMatch(right, /Ses/);
  assert.match(right, /k1@x\.com +active +Wk /);
  // One account stating the window brings the column back for the pane.
  am.accounts[2].quota.unified5h = 0.1;
  assert.match(halves(accountRows(screen(am, 160).lines)[0])[1], /Ses .*Wk /);
});

test('an account that has not reported yet keeps the Ses column, so it does not come and go at startup', () => {
  const am = fleet([claude('a@x.com'), codex('k1@x.com'), codex('k2@x.com')]);
  am.accounts[1].quota.unified5h = null;
  am.accounts[2].quota = {};
  const rows = accountRows(screen(am, 160).lines).map(r => halves(r)[1]).filter(r => r.trim());
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(r, /active +Ses .*Wk /, r);
});

test('without a five-hour window a Codex-only list drops Ses, and a mixed single column keeps it', () => {
  const only = fleet([codex('k1@x.com'), codex('k2@x.com')]);
  for (const a of only.accounts) a.quota.unified5h = null;
  for (const r of accountRows(screen(only, 120).lines)) { assert.doesNotMatch(r, /Ses/); assert.match(r, /Wk /); }
  const mixed = fleet([claude('a@x.com'), codex('k1@x.com')]);
  mixed.accounts[1].quota.unified5h = null;
  const narrow = accountRows(screen(mixed, 100).lines);
  assert.equal(narrow.length, 2);
  for (const r of narrow) assert.match(r, /Ses /);
});

test('selection walks the Anthropic pane, then the Codex pane, and stores manager indices', () => {
  const am = fleet([codex('k1@x.com'), claude('a@x.com'), codex('k2@x.com'), claude('b@x.com')]);
  const { tui } = screen(am, 160);
  assert.deepEqual(tui._displayOrder(), [1, 3, 0, 2]);
  tui.render = () => {};
  tui.mode = 'select';
  tui.selAction = 'toggle';
  tui.selIdx = 1;
  const seen = [tui.selIdx];
  for (let i = 0; i < 3; i++) { tui._keySelect('down'); seen.push(tui.selIdx); }
  assert.deepEqual(seen, [1, 3, 0, 2]);
});

test('attach mode draws the same panes from a status payload', () => {
  const am = fleet([claude('me@x.com'), claude('b@x.com'), codex('me@x.com'), codex('k2@x.com')]);
  am.setCurrentAccount(1);
  am.setCurrentAccount(2);
  const rm = new RemoteAccountManager();
  rm.applyStatus(JSON.parse(JSON.stringify(am.getStatus())));
  const { lines } = screen(rm, 160, { remote: true });
  assert.match(listLines(lines)[0], /Anthropic ─+ │  Codex/);
  const rows = accountRows(lines);
  assert.deepEqual(currentNames(rows.map(r => halves(r)[0])), ['b@x.com']);
  assert.deepEqual(currentNames(rows.map(r => halves(r)[1])), ['me@x.com'], 'the Codex namesake, not the Claude one');
});
