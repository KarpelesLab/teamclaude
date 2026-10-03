import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';

// Sorting the account list by when one of each account's windows resets.
//
// A reset sort (`accountSort`) changes the order the rows are DRAWN in and
// nothing else. The arrangement (`displayOrder`) is still what the reorder
// screen edits and still breaks ties, and provider groups and locally-served
// rows keep their places, exactly as they do in the arranged order.
//
// Same harness shape as tui-reorder.test.js: a minimal AccountManager stand-in
// and a stubbed render(), so these exercise the state machine, not the terminal.

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * `resets` is each account's all-models weekly reset; `quotas` sets any other
 * quota field on top of it.
 *
 * @param {{ names?: string[], resets?: Record<string, number|null>, quotas?: Record<string, Record<string, any>>,
 *   providers?: Record<string, string>, upstreams?: Record<string, string>, accountSort?: string,
 *   save?: (c: any) => Promise<void> }} [opts]
 */
function makeTUI({ names = ['alpha', 'bravo', 'charlie'], resets = {}, quotas = {}, providers = {}, upstreams = {}, accountSort, save } = {}) {
  /** @type {any[]} */
  const saved = [];
  const accounts = names.map((name, index) => ({
    index, id: `entry-${index}`, name, type: 'oauth', credential: 't',
    provider: providers[name], priority: 0, displayOrder: null, upstream: upstreams[name] || null,
    quota: { unified7d: 0.5, unified7dReset: resets[name] ?? null, ...quotas[name] },
  }));
  const am = {
    accounts,
    currentIndex: 0,
    switchThreshold: 0.98,
    getRoutes() { return []; },
  };
  /** @type {any} */
  const config = {
    proxy: { port: 1 },
    accounts: accounts.map(a => ({ id: a.id, name: a.name, type: a.type })),
    routes: [],
    blockedModels: [],
    ...(accountSort ? { accountSort } : {}),
  };
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: save ?? (async (/** @type {any} */ c) => {
      saved.push({ accountSort: c.accountSort, displayOrder: c.accounts.map((/** @type {any} */ a) => a.displayOrder) });
    }),
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  tui.render = () => {};
  return { tui, am, config, saved };
}

/** The account names in the order the list draws them. */
const shown = (/** @type {any} */ tui) => tui._displayOrder().map((/** @type {number} */ i) => tui.am.accounts[i].name);

const field = (/** @type {any} */ tui) => tui._settingsFields().find((/** @type {any} */ f) => f.id === 'accountSort');
const stripAnsi = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── the order ────────────────────────────────────────────────

test('the list stays in the arranged order until the sort is switched on', () => {
  const now = Date.now();
  const { tui } = makeTUI({ resets: { alpha: now + 5 * DAY, bravo: now + 3 * DAY, charlie: now + DAY } });
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
});

test('weekly reset lists the soonest reset first', () => {
  const now = Date.now();
  const { tui } = makeTUI({
    accountSort: 'weekly-reset',
    resets: { alpha: now + 5 * DAY, bravo: now + 3 * DAY, charlie: now + DAY },
  });
  assert.deepEqual(shown(tui), ['charlie', 'bravo', 'alpha']);
});

test('an account with no weekly reading, or one whose reset has passed, lists last', () => {
  const now = Date.now();
  const { tui } = makeTUI({
    names: ['stale', 'none', 'late', 'soon'],
    accountSort: 'weekly-reset',
    resets: { stale: now - HOUR, none: null, late: now + 6 * DAY, soon: now + HOUR },
  });
  // The two with nothing to sort by keep array order behind the two that have one.
  assert.deepEqual(shown(tui), ['soon', 'late', 'stale', 'none']);
});

test('the arranged order breaks ties', () => {
  const now = Date.now();
  const same = now + 2 * DAY;
  const { tui, am } = makeTUI({ accountSort: 'weekly-reset', resets: { alpha: same, bravo: same, charlie: null } });
  am.accounts[0].displayOrder = 2;
  am.accounts[1].displayOrder = 1;
  am.accounts[2].displayOrder = 0;
  // charlie is arranged first but has no reading, so the reset still wins for it.
  assert.deepEqual(shown(tui), ['bravo', 'alpha', 'charlie']);
});

test('session reset lists the soonest five-hour reset first, and an unopened window last', () => {
  const now = Date.now();
  const { tui } = makeTUI({
    accountSort: 'session-reset',
    // The weekly order is the reverse, so a sort that read it would show.
    resets: { alpha: now + DAY, bravo: now + 3 * DAY, charlie: now + 5 * DAY },
    quotas: {
      alpha: { unified5h: null, unified5hReset: null },
      bravo: { unified5h: 0.4, unified5hReset: now + 4 * HOUR },
      charlie: { unified5h: 0.9, unified5hReset: now + HOUR },
    },
  });
  assert.deepEqual(shown(tui), ['charlie', 'bravo', 'alpha']);
});

for (const [sort, family, key] of /** @type {const} */ ([
  ['fable-reset', 'F7', 'unified7dFable'],
  ['sonnet-reset', 'S7', 'unified7dSonnet'],
])) {
  test(`${family} reset reads the family's own weekly bucket, and the weekly on a row without one`, () => {
    const now = Date.now();
    const { tui } = makeTUI({
      names: ['own-late', 'none', 'own-soon'],
      accountSort: sort,
      resets: { 'own-late': now + HOUR, none: now + 2 * DAY, 'own-soon': now + 6 * DAY },
      quotas: {
        // Its own bucket resets late, whatever its weekly says.
        'own-late': { [key]: 0.3, [`${key}Reset`]: now + 4 * DAY },
        // No bucket of its own: the weekly is the window that governs the family.
        none: { [key]: null, [`${key}Reset`]: null },
        'own-soon': { [key]: 0.8, [`${key}Reset`]: now + DAY },
      },
    });
    assert.deepEqual(shown(tui), ['own-soon', 'none', 'own-late']);
  });
}

test('provider groups and locally-served rows keep their places', () => {
  const now = Date.now();
  const { tui } = makeTUI({
    names: ['codex-a', 'claude-a', 'local', 'claude-b'],
    providers: { 'codex-a': 'codex' },
    upstreams: { local: 'http://127.0.0.1:18765' },
    accountSort: 'weekly-reset',
    resets: { 'codex-a': now + HOUR, 'claude-a': now + 4 * DAY, local: now + 2 * HOUR, 'claude-b': now + DAY },
  });
  // Codex has the soonest reset of all and still lists after the Claude group;
  // the local backend's early reset does not pull it out of last place.
  assert.deepEqual(shown(tui), ['claude-b', 'claude-a', 'local', 'codex-a']);
});

test('an unknown sort value reads as arranged', () => {
  const now = Date.now();
  const { tui } = makeTUI({ accountSort: 'sideways', resets: { alpha: now + 5 * DAY, charlie: now + DAY } });
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
  assert.equal(stripAnsi(field(tui).value()), 'arranged');
});

// ── the reorder screen ───────────────────────────────────────

test('the reorder screen shows and edits the arrangement, not the sort', async () => {
  const now = Date.now();
  const { tui, am, saved } = makeTUI({
    accountSort: 'weekly-reset',
    resets: { alpha: now + 5 * DAY, bravo: now + 3 * DAY, charlie: now + DAY },
  });
  assert.deepEqual(shown(tui), ['charlie', 'bravo', 'alpha']);

  tui._key('g');
  const idx = tui._settingsFields().findIndex((/** @type {any} */ f) => f.id === 'orderAccounts');
  for (let i = 0; i < idx; i++) tui._key('down');
  tui._key('enter');
  assert.equal(tui.selAction, 'reorder');
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie'], 'the reorder screen drew the sort');

  tui._key('right');                      // alpha below bravo
  assert.deepEqual(shown(tui), ['bravo', 'alpha', 'charlie']);
  tui._key('enter');
  await tui._flushOrderSave();

  // What was written is the arrangement the screen showed, not the reset order.
  assert.deepEqual(am.accounts.map(a => a.displayOrder), [1, 0, 2]);
  assert.deepEqual(saved.at(-1)?.displayOrder, [1, 0, 2]);
  // And off the screen the sort is back in charge.
  assert.deepEqual(shown(tui), ['charlie', 'bravo', 'alpha']);
});

// ── the setting ──────────────────────────────────────────────

test('the settings row cycles the sort, saves it, and the list follows at once', async () => {
  const now = Date.now();
  const { tui, config, saved } = makeTUI({ resets: { alpha: now + 5 * DAY, bravo: now + 3 * DAY, charlie: now + DAY } });
  assert.equal(stripAnsi(field(tui).value()), 'arranged');

  await field(tui).right();
  await field(tui).right();
  assert.equal(config.accountSort, 'weekly-reset');
  assert.equal(stripAnsi(field(tui).value()), 'weekly reset');
  assert.deepEqual(shown(tui), ['charlie', 'bravo', 'alpha']);
  assert.equal(saved.at(-1)?.accountSort, 'weekly-reset');

  await field(tui).left();
  await field(tui).left();
  assert.equal(config.accountSort, 'arranged');
  assert.deepEqual(shown(tui), ['alpha', 'bravo', 'charlie']);
  assert.equal(saved.at(-1)?.accountSort, 'arranged');
});

test('the row cycles through every sort, and wraps both ways', async () => {
  const { tui, config } = makeTUI();
  /** @type {string[]} */
  const seen = [];
  for (let i = 0; i < 5; i++) { await field(tui).right(); seen.push(config.accountSort); }
  assert.deepEqual(seen, ['session-reset', 'weekly-reset', 'sonnet-reset', 'fable-reset', 'arranged']);
  await field(tui).left();
  assert.equal(config.accountSort, 'fable-reset');
  assert.equal(stripAnsi(field(tui).value()), 'F7 reset');
});

test('a save that fails puts the old sort back', async () => {
  const { tui, config } = makeTUI({ save: async () => { throw new Error('disk full'); } });
  await field(tui).right();
  assert.equal(config.accountSort, undefined);
  assert.equal(stripAnsi(field(tui).value()), 'arranged');
});

test('the sort row appears once there are two accounts, and is drawn', () => {
  assert.equal(field(makeTUI({ names: ['alpha'] }).tui), undefined, 'one account offers a sort');
  const { tui } = makeTUI({ names: ['alpha', 'bravo'] });
  tui.setIdx = tui._settingsFields().findIndex((/** @type {any} */ f) => f.id === 'accountSort');
  /** @type {string[]} */
  const lines = [];
  const selLine = tui._renderSettings(lines);
  assert.match(stripAnsi(lines[selLine]), /Sort accounts\s+arranged/);
});
