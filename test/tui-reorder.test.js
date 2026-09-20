import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';
import { mergeAccountsForSave } from '../src/account-pairing.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

// Reordering the account list from the settings screen.
//
// The whole point of the feature is that it moves ROWS and nothing else. A
// manager index addresses an account everywhere it matters — route pins,
// session pins, `currentIndex`, `TC_ACCT`, the disable/switch CLI paths — so
// permuting `am.accounts` would repoint all of them at the wrong account, and
// deriving `priority` from a row's position would re-rank rotation as a side
// effect of tidying the display. Hence a sort key, and hence most of what is
// asserted below: what did NOT change.
//
// Same harness shape as tui-accounts.test.js: a minimal AccountManager stand-in
// and a stubbed render(), so these exercise the state machine, not the terminal.
// These read _displayOrder directly; tui-account-order.test.js is what proves
// render() draws that order.

function makeTUI({ names = ['alpha', 'bravo', 'charlie'], upstreams = {} } = {}) {
  const saved = [];
  const accounts = names.map((name, index) => ({
    index, id: `entry-${index}`, name, type: 'oauth', credential: 't',
    priority: 0, displayOrder: null, upstream: upstreams[name] || null,
  }));
  const am = {
    accounts,
    currentIndex: 0,
    switchThreshold: 0.98,
    getRoutes() { return []; },
  };
  const config = {
    proxy: { port: 1 },
    accounts: accounts.map(a => ({ id: a.id, name: a.name, type: a.type })),
    routes: [],
  };
  const tui = new TUI({
    accountManager: am, config, sx: null,
    // Snapshot each entry, so a later move cannot edit a recorded save.
    saveConfig: async c => { saved.push(c.accounts.map((/** @type {any} */ a) => ({ ...a }))); },
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  tui.render = () => {};
  return { tui, am, config, saved };
}

// A move is written a moment after the keys stop (_doMoveAccount), so a case
// that reads what was saved flushes that wait instead of sleeping through it.
const settle = (/** @type {any} */ tui) => tui._flushOrderSave();

/** The account names in the order the list draws them. */
const shown = (/** @type {any} */ tui) => tui._displayOrder().map((/** @type {number} */ i) => tui.am.accounts[i].name);

/** Open the reorder screen the way the operator does, by its field id, so the
 *  case survives rows being added above it. */
function openReorder(/** @type {any} */ tui) {
  tui._key('g');
  const idx = tui._settingsFields().findIndex((/** @type {any} */ f) => f.id === 'orderAccounts');
  assert.ok(idx >= 0, 'no reorder row on the settings screen');
  for (let i = 0; i < idx; i++) tui._key('down');
  tui._key('enter');
}

// ── the rows move ────────────────────────────────────────────

test('→ moves the selected account down the list, ← moves it back up', async () => {
  const { tui } = makeTUI();
  openReorder(tui);
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selAction, 'reorder');
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);

  tui._key('right');
  assert.deepEqual(shown(tui), ['bravo', 'alpha', 'charlie']);
  tui._key('right');
  assert.deepEqual(shown(tui), ['bravo', 'charlie', 'alpha']);
  tui._key('left');
  assert.deepEqual(shown(tui), ['bravo', 'alpha', 'charlie']);
  await settle(tui);
});

test('the cursor rides with the account it is dragging, not with the row number', async () => {
  const { tui } = makeTUI();
  openReorder(tui);
  const dragged = tui.selIdx;
  tui._key('right');
  tui._key('right');
  // selIdx is a manager index and the account never left its array slot, so the
  // marker is still on the same account — now at the bottom of the list.
  assert.equal(tui.selIdx, dragged);
  assert.equal(tui.am.accounts[tui.selIdx].name, 'alpha');
  assert.equal(shown(tui).at(-1), 'alpha');
  await settle(tui);
});

test('a move off either end of the list does nothing at all', async () => {
  const { tui, saved } = makeTUI();
  openReorder(tui);
  tui._key('left');                       // already at the top
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
  tui._key('down'); tui._key('down');     // cursor to the last row
  tui._key('right');                      // already at the bottom
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
  await settle(tui);
  assert.deepEqual(saved, [], 'a refused move still wrote the config');
});

test('h and l reorder too, the way j and k already navigate', async () => {
  const { tui } = makeTUI();
  openReorder(tui);
  tui._key('l');
  assert.deepEqual(shown(tui), ['bravo', 'alpha', 'charlie']);
  tui._key('h');
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
  await settle(tui);
});

test('Enter and Esc both leave for the settings screen — and Enter removes nothing', async () => {
  for (const key of ['enter', 'esc']) {
    const { tui, am } = makeTUI();
    openReorder(tui);
    tui._key(key);
    assert.equal(tui.mode, 'settings', `${key} did not go back`);
    assert.equal(am.accounts.length, 3, `${key} in reorder mode fell through to remove`);
  }
});

// ── and nothing else does ────────────────────────────────────

test('moving a row leaves every manager index, the current account and a route pin alone', async () => {
  const { tui, am } = makeTUI();
  // A route pin holds a manager index, which is exactly what a permuted array
  // would silently repoint at a different account.
  const pinnedIdx = 2;
  const pinnedName = am.accounts[pinnedIdx].name;
  const before = am.accounts.map((/** @type {any} */ a) => a.name);

  openReorder(tui);
  tui._key('right');
  tui._key('right');
  await settle(tui);

  assert.deepEqual(am.accounts.map((/** @type {any} */ a) => a.name), before, 'the account array was permuted');
  assert.deepEqual(am.accounts.map((/** @type {any} */ a) => a.index), [0, 1, 2], 'an account changed manager index');
  assert.equal(am.currentIndex, 0, 'the current account moved');
  assert.equal(am.accounts[pinnedIdx].name, pinnedName, 'a pinned index now names another account');
});

test('priority is never written, on the account or on its config entry', async () => {
  const { tui, am, config, saved } = makeTUI();
  am.accounts[2].priority = 100;          // a deliberately deprioritised backend
  config.accounts[2].priority = 100;
  openReorder(tui);
  tui._key('right');                      // alpha past bravo
  tui._key('down'); tui._key('left');     // and the deprioritised backend up one
  await settle(tui);

  assert.deepEqual(am.accounts.map((/** @type {any} */ a) => a.priority), [0, 0, 100]);
  assert.deepEqual(config.accounts.map((/** @type {any} */ a) => a.priority), [undefined, undefined, 100]);
  for (const list of saved) {
    assert.deepEqual(list.map((/** @type {any} */ a) => a.priority), [undefined, undefined, 100],
      'a save carried a priority this feature had no business writing');
  }
});

// ── unplaced accounts ────────────────────────────────────────

test('accounts with no order keep config order, stably, render after render', () => {
  const { tui } = makeTUI({ names: ['alpha', 'bravo', 'charlie'] });
  for (let i = 0; i < 5; i++) assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
  // Also with the field absent rather than null: a config written before the
  // field existed reads as unplaced, not as order 0.
  for (const a of tui.am.accounts) delete a.displayOrder;
  for (let i = 0; i < 5; i++) assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
});

test('an account added after an arrangement lands at the bottom, where it always did', async () => {
  const { tui, am, config } = makeTUI();
  openReorder(tui);
  tui._key('right');                      // arrange: bravo, alpha, charlie
  await settle(tui);

  const entry = { id: 'entry-3', name: 'delta', type: 'oauth' };
  config.accounts.push(entry);
  am.accounts.push({ ...entry, index: 3, credential: 't', priority: 0, displayOrder: null });

  assert.deepEqual(shown(tui), ['bravo', 'alpha', 'charlie', 'delta']);
});

test('a hand-written order sorts placed accounts first and unplaced after, in array order', () => {
  const { tui, am } = makeTUI({ names: ['alpha', 'bravo', 'charlie'] });
  am.accounts[2].displayOrder = 0;        // charlie placed first by hand
  assert.deepEqual(shown(tui), ['charlie', 'alpha', 'bravo']);
  // Two accounts sharing a number is a hand-edit, not a state this writes. It
  // has to resolve to one fixed order all the same.
  am.accounts[1].displayOrder = 0;
  assert.deepEqual(shown(tui), ['bravo', 'charlie', 'alpha']);
});

// ── local backends ───────────────────────────────────────────

test('a locally-served account still lists last, whatever the arrangement says', async () => {
  const { tui, am, config } = makeTUI({
    names: ['alpha', 'codex', 'bravo'],
    upstreams: { codex: 'http://127.0.0.1:18765' },
  });
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'codex']);

  openReorder(tui);
  tui._key('right');
  await settle(tui);

  assert.deepEqual(shown(tui), ['bravo', 'alpha', 'codex'], 'the conduit was dragged out of last place');
  assert.equal(am.accounts[1].displayOrder, null, 'the conduit was given a list position');
  assert.equal(config.accounts[1].displayOrder, undefined, 'the conduit entry was written to');
  // Dense over the rows that can be arranged, so the numbers read straight.
  assert.deepEqual([am.accounts[0].displayOrder, am.accounts[2].displayOrder], [1, 0]);
});

test('the reorder cursor never stops on a row it cannot move', () => {
  const { tui, am } = makeTUI({
    names: ['alpha', 'codex', 'bravo'],
    upstreams: { codex: 'http://127.0.0.1:18765' },
  });
  openReorder(tui);
  assert.equal(am.accounts[tui.selIdx].name, 'alpha');
  tui._key('down');
  assert.equal(am.accounts[tui.selIdx].name, 'bravo');
  tui._key('down');                       // the conduit row is drawn below, but is not a stop
  assert.equal(am.accounts[tui.selIdx].name, 'bravo');
});

// ── provider groups ──────────────────────────────────────────

// A mixed fleet is drawn grouped by provider (two panes on a wide terminal, one
// column otherwise), and _displayOrder sorts by provider before it reads the
// arrangement. Rendered rather than read off _displayOrder: the property is
// that the config is never rewritten while no row on screen moved.

const HOUR = 3600_000;
const claude = (/** @type {string} */ name) => ({ id: `id-${name}`, name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const codex = (/** @type {string} */ name) => ({ ...claude(name), provider: 'codex', accountId: `acct-${name}` });

function makeMixedTUI() {
  /** @type {any[][]} */
  const saved = [];
  const entries = [claude('claude-a'), codex('codex-a'), claude('claude-b'), codex('codex-b')];
  const am = new AccountManager(entries.map(e => ({ ...e })), 0.98);
  const config = { proxy: { port: 1 }, accounts: entries.map(e => ({ ...e })), routes: [] };
  /** @type {any} */
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async (/** @type {any} */ c) => { saved.push(c.accounts.map((/** @type {any} */ a) => ({ ...a }))); },
    syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  tui.render = () => {};
  return { tui, am, config, saved };
}

/** The names render() drew, per provider, top to bottom. Per provider because
 *  the two-pane layout draws the panes a line at a time, left row then right. */
function drawnByProvider(/** @type {any} */ tui) {
  /** @type {number[]} */
  const drawn = [];
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 160, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  const realRow = tui._renderRow;
  const realPaint = tui._paint;
  try {
    tui._renderRow = (/** @type {number} */ idx, /** @type {any} */ L, /** @type {any} */ current) => {
      drawn.push(idx);
      return realRow.call(tui, idx, L, current);
    };
    tui._paint = () => {};
    tui.running = true;
    TUI.prototype.render.call(tui, { force: true });
  } finally {
    tui.running = false;
    tui._renderRow = realRow;
    tui._paint = realPaint;
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    else delete (/** @type {any} */ (process.stdout)).columns;
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
    else delete (/** @type {any} */ (process.stdout)).rows;
  }
  const names = (/** @type {string} */ provider) => drawn
    .filter(i => tui.am.accounts[i].provider === provider)
    .map(i => tui.am.accounts[i].name);
  return { anthropic: names('anthropic'), codex: names('codex') };
}

test('a move that would cross into the other provider\'s group moves no row and writes nothing', async () => {
  const { tui, am, config, saved } = makeMixedTUI();
  const before = { anthropic: ['claude-a', 'claude-b'], codex: ['codex-a', 'codex-b'] };
  assert.deepEqual(drawnByProvider(tui), before);

  openReorder(tui);
  tui._key('down');                       // claude-b, the last row of its group
  assert.equal(am.accounts[tui.selIdx].name, 'claude-b');
  tui._key('right');                      // the next row down is codex-a
  tui._key('down');                       // the cursor itself may cross: codex-a
  assert.equal(am.accounts[tui.selIdx].name, 'codex-a');
  tui._key('left');                       // the next row up is claude-b
  await settle(tui);

  assert.deepEqual(drawnByProvider(tui), before, 'a row moved');
  assert.deepEqual(am.accounts.map(a => a.displayOrder), [null, null, null, null], 'a refused move renumbered the list');
  assert.deepEqual(config.accounts.map((/** @type {any} */ a) => 'displayOrder' in a), [false, false, false, false]);
  assert.deepEqual(saved, [], 'the config was rewritten while no row moved');
});

test('a move inside a provider group is drawn, and leaves the other group as it was', async () => {
  const { tui, saved } = makeMixedTUI();
  openReorder(tui);
  tui._key('down'); tui._key('down');     // codex-a
  tui._key('right');                      // below codex-b
  await settle(tui);

  assert.deepEqual(drawnByProvider(tui), { anthropic: ['claude-a', 'claude-b'], codex: ['codex-b', 'codex-a'] });
  assert.equal(saved.length, 1);
});

// ── one write per gesture ────────────────────────────────────

test('a run of moves is written once, and leaving the screen is what writes it', async () => {
  const { tui, saved } = makeTUI();
  openReorder(tui);
  tui._key('right'); tui._key('right'); tui._key('left');
  assert.deepEqual(saved, [], 'a move wrote the config without waiting for the keys to stop');
  tui._key('enter');
  await settle(tui);                      // nothing left to flush: Enter already did
  assert.equal(saved.length, 1, 'a held key is one write, not one per repeat');
  assert.deepEqual(saved[0].map((/** @type {any} */ a) => a.displayOrder), [1, 0, 2]);
});

// ── attach mode ──────────────────────────────────────────────

test('getStatus carries displayOrder, which is all the attached TUI has to sort by', () => {
  const am = new AccountManager([
    { name: 'a', type: 'apikey', apiKey: 'k1', displayOrder: 1 },
    { name: 'b', type: 'apikey', apiKey: 'k2' },
  ], 0.98);
  assert.deepEqual(am.getStatus().accounts.map(a => a.displayOrder), [1, null]);
});

// ── it survives the round trip ───────────────────────────────

test('the arrangement is written to the config entries the accounts came from', async () => {
  const { tui, config, saved } = makeTUI();
  openReorder(tui);
  tui._key('right');
  await settle(tui);

  assert.equal(saved.length, 1, 'the move did not save');
  const byName = Object.fromEntries(config.accounts.map((/** @type {any} */ a) => [a.name, a.displayOrder]));
  assert.deepEqual(byName, { alpha: 1, bravo: 0, charlie: 2 });
  assert.deepEqual(saved[0].map((/** @type {any} */ a) => a.displayOrder), [1, 0, 2]);
});

test('the order survives a save through mergeAccountsForSave and a reload off disk', async () => {
  const { tui, am, config } = makeTUI();
  openReorder(tui);
  tui._key('right'); tui._key('right');   // alpha dragged to the bottom
  await settle(tui);
  const arranged = shown(tui);
  assert.deepEqual(arranged, ['bravo', 'charlie', 'alpha']);

  // What the save actually puts on disk: the merge is what a field the module
  // does not know about gets dropped by, so it is the half worth proving.
  // `disk` carries a stale order and an importFrom, as a real row would.
  const disk = config.accounts.map((/** @type {any} */ a) => ({ ...a, displayOrder: 99, importFrom: '/creds.json' }));
  const written = mergeAccountsForSave(config.accounts, am.accounts, disk);
  assert.deepEqual(written.map((/** @type {any} */ a) => a.displayOrder), [2, 0, 1], 'the merge dropped the order');
  assert.deepEqual(written.map((/** @type {any} */ a) => a.importFrom), Array(3).fill('/creds.json'),
    'the merge stopped carrying disk-only fields');

  // And what a cold start makes of that file: a fresh TUI over accounts rebuilt
  // from the written rows draws the same list.
  const reloaded = makeTUI();
  reloaded.am.accounts.forEach((/** @type {any} */ a, /** @type {number} */ i) => { a.displayOrder = written[i].displayOrder; });
  assert.deepEqual(shown(reloaded.tui), arranged);
});

test('a displayOrder is normalised on load and picked up on reload, like priority beside it', async () => {
  const mem = [
    { name: 'a', type: 'apikey', apiKey: 'k1', displayOrder: 2 },
    { name: 'b', type: 'apikey', apiKey: 'k2', displayOrder: 'first' }, // not a number
    { name: 'c', type: 'apikey', apiKey: 'k3' },                        // predates the field
  ];
  const am = new AccountManager(mem.map(a => ({ ...a })), 0.98);
  assert.deepEqual(am.accounts.map(a => a.displayOrder), [2, null, null]);

  const disk = mem.map(a => ({ ...a }));
  disk[0].displayOrder = 5;
  delete disk[1].displayOrder;
  disk[2].displayOrder = 0;
  await syncAccountsFromDisk({ accounts: disk }, { accounts: mem }, am);
  assert.deepEqual(am.accounts.map(a => a.displayOrder), [5, null, 0],
    'a hand edit to the order waited for a restart');
});

// ── the screens it adds ──────────────────────────────────────

test('the reorder row appears once there are two accounts to arrange', () => {
  const has = (/** @type {any} */ tui) => tui._settingsFields().some((/** @type {any} */ f) => f.id === 'orderAccounts');
  assert.equal(has(makeTUI({ names: ['alpha'] }).tui), false, 'one account offers an arrangement');
  assert.equal(has(makeTUI({ names: ['alpha', 'bravo'] }).tui), true);
  // A lone account beside a conduit is still a lone account.
  assert.equal(has(makeTUI({
    names: ['alpha', 'codex'], upstreams: { codex: 'http://localhost:18765' },
  }).tui), false);
});

test('the reorder footer offers the move keys, and not the remove one', () => {
  const { tui } = makeTUI();
  tui.mode = 'select';
  tui.selAction = 'reorder';
  const foot = tui._renderFooter();
  assert.match(foot, /move/);
  assert.match(foot, /done/);
  assert.doesNotMatch(foot, /remove/, 'the reorder footer fell through to the remove line');
});
