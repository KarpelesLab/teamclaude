import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

// Minimal AccountManager stand-in for the routes editor: it only needs the
// surface the editor touches (accounts, setRoutes). render() is stubbed out so
// these tests exercise the editor state machine, not the terminal renderer.
function makeTUI({ routes = [] } = {}) {
  const applied = { routes: null };
  const pins = { calls: [], byName: new Map() };
  const am = {
    accounts: [{ name: 'a', index: 0 }, { name: 'b', index: 1 }],
    currentIndex: 0,
    switchThreshold: 0.98,
    setRoutes(r) { applied.routes = r; },
    getRoutes() { return routes; },
    setRoutePin(name, idx) { pins.calls.push(['set', name, idx]); pins.byName.set(name, this.accounts[idx]); return { ok: true }; },
    clearRoutePin(name) { pins.calls.push(['clear', name]); pins.byName.delete(name); },
    getRoutePin(name) { return pins.byName.get(name) || null; },
  };
  const saved = { routes: null };
  const config = { proxy: { port: 1 }, routes: [] };
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async (c) => { saved.routes = JSON.parse(JSON.stringify(c.routes)); },
    syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {}; // bypass terminal rendering
  return { tui, config, applied, saved, pins };
}

const type = (tui, s) => { for (const ch of s) tui._key(ch); };
const settle = () => new Promise(r => setTimeout(r, 5)); // let async save finish

// Routing lives under the settings screen (g → "Manage routing"): open settings,
// move the cursor to the routes row by id (robust to added fields), press Enter.
function openRoutes(tui) {
  tui._key('g');
  const idx = tui._settingsFields().findIndex(f => f.id === 'routes');
  for (let i = 0; i < idx; i++) tui._key('down');
  tui._key('enter');
}

test('TUI routes editor: add walks name → glob → accounts → bucket and persists', async () => {
  const { tui, config, applied, saved } = makeTUI();

  openRoutes(tui);
  assert.equal(tui.mode, 'routes');
  tui._key('a');
  assert.equal(tui.mode, 'input');
  assert.match(tui.inputPrompt, /Route name/);

  type(tui, 'fable'); tui._key('enter');
  assert.match(tui.inputPrompt, /glob/);
  type(tui, '*fable*'); tui._key('enter');

  // accounts: a checklist now — highlight b (index 1), toggle it on, confirm
  assert.equal(tui.mode, 'pick');
  assert.equal(tui.pick.multi, true);
  tui._key('down'); tui._key(' '); tui._key('enter');

  // bucket: single-select, default "auto" (blank) → Enter keeps it
  assert.equal(tui.mode, 'pick');
  assert.equal(tui.pick.multi, false);
  tui._key('enter');

  // color: single-select, default → Enter keeps it, then saves
  assert.equal(tui.mode, 'pick');
  tui._key('enter');
  await settle();

  assert.deepEqual(config.routes, [{ name: 'fable', match: ['*fable*'], accounts: ['b'] }]);
  assert.deepEqual(applied.routes, config.routes, 'applied to the running rotation live');
  assert.deepEqual(saved.routes, config.routes, 'persisted via saveConfig');
  assert.equal(tui.mode, 'routes');
});

test('TUI routes editor: a blank name cancels without creating a route', async () => {
  const { tui, config } = makeTUI();
  openRoutes(tui); tui._key('a');
  tui._key('enter'); // empty name
  await settle();
  assert.deepEqual(config.routes, []);
  assert.equal(tui.mode, 'routes');
});

test('TUI routes editor: edit prefills the pickers from the existing route', async () => {
  const { tui, config } = makeTUI();
  config.routes = [{ name: 'fable', match: ['*fable*'], accounts: ['b'] }];

  openRoutes(tui); tui.routeIdx = 0; tui._key('e');
  assert.equal(tui.inputBuf, 'fable');          // name prefilled
  tui._key('enter');
  assert.equal(tui.inputBuf, '*fable*');         // glob prefilled
  tui._key('enter');

  // accounts picker preselects the current member (b); add a too
  assert.equal(tui.mode, 'pick');
  assert.deepEqual([...tui.pick.sel], ['b']);
  tui._key(' ');                                 // toggle a (highlighted first) on
  tui._key('enter');

  // bucket picker → choose unified7dFable (index 2)
  tui._key('down'); tui._key('down'); tui._key('enter');

  // color picker → choose magenta
  const ci = tui.pick.items.findIndex(it => it.value === 'magenta');
  for (let i = 0; i < ci; i++) tui._key('down');
  tui._key('enter');
  await settle();

  assert.deepEqual(config.routes, [
    { name: 'fable', match: ['*fable*'], accounts: ['a', 'b'], bucket: 'unified7dFable', color: 'magenta' },
  ]);
});

test('TUI routes editor: defaults (all accounts, auto bucket, no color) omit those keys', async () => {
  const { tui, config } = makeTUI();
  openRoutes(tui); tui._key('a');
  type(tui, 'r'); tui._key('enter');           // name
  type(tui, '*opus*'); tui._key('enter');      // glob
  tui._key('enter');                            // accounts: none selected → all
  tui._key('enter');                            // bucket: auto
  tui._key('enter');                            // color: default
  await settle();
  assert.deepEqual(config.routes, [{ name: 'r', match: ['*opus*'] }]); // no accounts/bucket/color keys
});

test('TUI switch mode: Tab targets a route and Enter pins the highlighted account', () => {
  const routes = [{
    name: 'fable', match: ['*fable*'], color: 'red', autocreated: true, pinned: null,
    accounts: [{ name: 'a', eligible: true }, { name: 'b', eligible: true }],
  }];
  const { tui, pins } = makeTUI({ routes });

  tui._key('s');                       // enter switch mode (selRoute = null = default)
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selRoute, null);
  tui._key('tab');                     // cycle to the fable route
  assert.equal(tui.selRoute?.name, 'fable');
  tui._key('down');                    // highlight account b (index 1)
  tui._key('enter');
  assert.deepEqual(pins.calls, [['set', 'fable', 1]]);
  assert.equal(tui.mode, 'normal');
});

test('TUI switch mode: Enter on the current pin clears it (toggle off)', () => {
  const routes = [{
    name: 'fable', match: ['*fable*'], color: 'red', autocreated: true, pinned: 'a',
    accounts: [{ name: 'a', eligible: true }, { name: 'b', eligible: true }],
  }];
  const { tui, pins } = makeTUI({ routes });
  pins.byName.set('fable', tui.am.accounts[0]); // a is already pinned

  tui._key('s');
  tui._key('tab');                     // target fable
  tui._key('enter');                   // Enter on account a (the current pin)
  assert.deepEqual(pins.calls, [['clear', 'fable']]);
  assert.equal(tui.mode, 'normal');
});

test('TUI switch mode: Tab is inert for remove/toggle actions', () => {
  const routes = [{ name: 'fable', match: ['*fable*'], accounts: [{ name: 'a', eligible: true }] }];
  const { tui } = makeTUI({ routes });
  tui._key('r');                       // remove action
  tui._key('tab');
  assert.equal(tui.selRoute, null);    // unchanged — Tab only cycles in switch mode
});

test('TUI switch mode: ←→ cycle the pin target both ways and wrap', () => {
  const mk = n => ({
    name: n, match: [`*${n}*`], color: 'red', autocreated: true, pinned: null,
    accounts: [{ name: 'a', eligible: true }, { name: 'b', eligible: true }],
  });
  const { tui } = makeTUI({ routes: [mk('fable'), mk('sonnet')] });

  tui._key('s');
  assert.equal(tui.selRoute, null);     // default
  tui._key('right');
  assert.equal(tui.selRoute?.name, 'fable');
  tui._key('right');
  assert.equal(tui.selRoute?.name, 'sonnet');
  tui._key('right');
  assert.equal(tui.selRoute, null);     // wraps forward to the default
  tui._key('left');
  assert.equal(tui.selRoute?.name, 'sonnet'); // wraps backward to the last route
  tui._key('left');
  assert.equal(tui.selRoute?.name, 'fable');
  tui._key('left');
  assert.equal(tui.selRoute, null);
});

test('TUI switch mode: ←→ are inert for remove/toggle actions', () => {
  const routes = [{ name: 'fable', match: ['*fable*'], accounts: [{ name: 'a', eligible: true }] }];
  const { tui } = makeTUI({ routes });
  tui._key('d');                       // toggle action
  tui._key('right'); tui._key('left');
  assert.equal(tui.selRoute, null);
});

test('TUI: the F7 (Fable) marker sits on exactly one account — the routing target', () => {
  const future = Date.now() + 7 * 24 * 3600_000;
  const oauth = n => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: future });
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  for (const acc of am.accounts) {
    acc.quota.unified5h = 0.1; acc.quota.unified5hReset = future;
    acc.quota.unified7d = 0.1; acc.quota.unified7dReset = future;
    acc.quota.unified7dFable = 0.2; acc.quota.unified7dFableReset = future; // all meter Fable → F7 bar shows
  }
  // a's Fable weekly is spent → Fable routes elsewhere, but a stays the default current.
  am.accounts[0].quota.unified7dFable = 1.0;

  const tui = Object.create(TUI.prototype);
  tui.am = am; tui.mode = 'normal'; tui.selIdx = -1;
  const routes = am.getRoutes();
  const familyTarget = { fable: am.previewRouteIndex('claude-fable-5'), sonnet: null };

  const rows = am.accounts.map((_, i) =>
    stripAnsi(tui._renderAcct(i, 8, true, routes, [], familyTarget)));
  const marked = rows.filter(r => /►\s*F7/.test(r));
  assert.equal(marked.length, 1, 'exactly one F7 marker across all accounts');
  // ...and it is NOT the Fable-spent account a (which instead shows the ⊘ tag).
  assert.ok(!/►\s*F7/.test(rows[0]), 'the Fable-spent account carries no F7 marker');
  assert.match(rows[0], /⊘ Fable/, 'the Fable-spent account is tagged blocked');
});

test('TUI routes editor: delete removes the selected route', async () => {
  const { tui, config, applied } = makeTUI();
  config.routes = [{ name: 'fable', match: ['*fable*'] }, { name: 'bulk', match: ['*opus*'] }];

  openRoutes(tui); tui.routeIdx = 0; tui._key('d');
  await settle();
  assert.deepEqual(config.routes, [{ name: 'bulk', match: ['*opus*'] }]);
  assert.deepEqual(applied.routes, config.routes);
});

// Pressing → in switch mode targets the Fable route; the cursor should say so
// where the eye is: in front of the F7 bar, where the pin's ► will land. The
// row start keeps a dim `>` so the row is still easy to find.
test('TUI: targeting a family route moves the cursor to its bar and dims the row-start one', () => {
  const future = Date.now() + 7 * 24 * 3600_000;
  const oauth = n => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: future });
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  for (const acc of am.accounts) {
    acc.quota.unified5h = 0.1; acc.quota.unified5hReset = future;
    acc.quota.unified7d = 0.1; acc.quota.unified7dReset = future;
    acc.quota.unified7dFable = 0.2; acc.quota.unified7dFableReset = future;
    acc.quota.unified7dSonnet = 0.2; acc.quota.unified7dSonnetReset = future;
  }
  const routes = am.getRoutes();
  const fable = routes.find(r => r.name === 'fable');
  const sonnet = routes.find(r => r.name === 'sonnet');
  assert.ok(fable && sonnet, 'auto routes exist');

  const tui = Object.create(TUI.prototype);
  tui.am = am; tui.mode = 'select'; tui.selAction = 'switch'; tui.selIdx = 1;
  const render = (i) => tui._renderAcct(i, 8, true, routes, [], { fable: null, sonnet: null });
  const CYAN_CURSOR = '\x1b[36m>\x1b[0m';
  const DIM_CURSOR = '\x1b[2m>\x1b[0m';

  // Default target: the bright cursor at the row start, nothing at the bars.
  tui.selRoute = null;
  let row = render(1);
  assert.ok(row.startsWith(` ${CYAN_CURSOR}`), 'bright cursor at the row start');
  assert.doesNotMatch(stripAnsi(row), />\s*[►]?\s*F7/, 'no cursor at F7');
  const width = stripAnsi(row).length;

  // Fable target: dim at the start, bright in front of F7, same row width.
  tui.selRoute = fable;
  row = render(1);
  assert.ok(row.startsWith(` ${DIM_CURSOR}`), 'the row-start cursor is dimmed');
  assert.ok(row.includes(`${CYAN_CURSOR} F7`), `bright cursor in front of F7, got: ${JSON.stringify(stripAnsi(row))}`);
  assert.equal(stripAnsi(row).length, width, 'the row does not grow');
  assert.ok(!render(0).includes('>'), 'an unselected row draws no cursor anywhere');

  // Sonnet target: the cursor sits at S7 instead, and F7 is clear again.
  tui.selRoute = sonnet;
  row = render(1);
  assert.ok(row.includes(`${CYAN_CURSOR} S7`), 'bright cursor in front of S7');
  assert.ok(!row.includes(`${CYAN_CURSOR} F7`), 'not at F7');

  // The pin's own ► keeps its place: the cursor takes the separator column, not the marker's.
  row = tui._renderAcct(1, 8, true, routes, [], { fable: 1, sonnet: null });
  tui.selRoute = fable;
  row = tui._renderAcct(1, 8, true, routes, [], { fable: 1, sonnet: null });
  assert.match(stripAnsi(row), />►F7/, 'cursor, then the marker, then the label');

  // A row without the F7 bar keeps the bright cursor at the start: nothing to point at.
  am.accounts[1].quota.unified7dFable = null;
  row = render(1);
  assert.ok(row.startsWith(` ${CYAN_CURSOR}`), 'bright cursor stays at the start when the bar is absent');
});
