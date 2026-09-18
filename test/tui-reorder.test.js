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

const settle = () => new Promise(r => setTimeout(r, 5)); // let the async save finish

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
  await settle();
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
  await settle();
});

test('a move off either end of the list does nothing at all', async () => {
  const { tui, saved } = makeTUI();
  openReorder(tui);
  tui._key('left');                       // already at the top
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
  tui._key('down'); tui._key('down');     // cursor to the last row
  tui._key('right');                      // already at the bottom
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
  await settle();
  assert.deepEqual(saved, [], 'a refused move still wrote the config');
});

test('h and l reorder too, the way j and k already navigate', async () => {
  const { tui } = makeTUI();
  openReorder(tui);
  tui._key('l');
  assert.deepEqual(shown(tui), ['bravo', 'alpha', 'charlie']);
  tui._key('h');
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
  await settle();
});

test('Enter and Esc both leave for the settings screen — and Enter removes nothing', async () => {
  for (const key of ['enter', 'esc']) {
    const { tui, am } = makeTUI();
    openReorder(tui);
    tui._key(key);
    assert.equal(tui.mode, 'settings', `${key} did not go back`);
    assert.equal(am.accounts.length, 3, `${key} in reorder mode fell through to remove`);
  }
  await settle();
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
  await settle();

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
  await settle();

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
  await settle();

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
  await settle();

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

// ── it survives the round trip ───────────────────────────────

test('the arrangement is written to the config entries the accounts came from', async () => {
  const { tui, config, saved } = makeTUI();
  openReorder(tui);
  tui._key('right');
  await settle();

  assert.equal(saved.length, 1, 'the move did not save');
  const byName = Object.fromEntries(config.accounts.map((/** @type {any} */ a) => [a.name, a.displayOrder]));
  assert.deepEqual(byName, { alpha: 1, bravo: 0, charlie: 2 });
  assert.deepEqual(saved[0].map((/** @type {any} */ a) => a.displayOrder), [1, 0, 2]);
});

test('the order survives a save through mergeAccountsForSave and a reload off disk', async () => {
  const { tui, am, config } = makeTUI();
  openReorder(tui);
  tui._key('right'); tui._key('right');   // alpha dragged to the bottom
  await settle();
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
