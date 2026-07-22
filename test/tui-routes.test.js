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
  assert.match(tui.inputPrompt, /Accounts/);
  type(tui, 'b'); tui._key('enter');
  assert.match(tui.inputPrompt, /bucket/i);
  tui._key('enter'); // blank bucket → color prompt
  assert.match(tui.inputPrompt, /color/i);
  tui._key('enter'); // blank color → save
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

test('TUI routes editor: edit prefills, and backspace clears a field before retyping', async () => {
  const { tui, config } = makeTUI();
  config.routes = [{ name: 'fable', match: ['*fable*'], accounts: ['b'] }];

  openRoutes(tui); tui.routeIdx = 0; tui._key('e');
  assert.equal(tui.inputBuf, 'fable');          // name prefilled
  tui._key('enter');
  assert.equal(tui.inputBuf, '*fable*');         // glob prefilled
  tui._key('enter');
  assert.equal(tui.inputBuf, 'b');               // accounts prefilled
  tui._key('bs'); type(tui, 'a,b'); tui._key('enter');
  type(tui, 'unified7dFable'); tui._key('enter');
  type(tui, 'magenta'); tui._key('enter'); // color
  await settle();

  assert.deepEqual(config.routes, [
    { name: 'fable', match: ['*fable*'], accounts: ['a', 'b'], bucket: 'unified7dFable', color: 'magenta' },
  ]);
});

test('TUI routes editor: an unknown color is dropped (route still saves)', async () => {
  const { tui, config } = makeTUI();
  openRoutes(tui); tui._key('a');
  type(tui, 'r'); tui._key('enter');           // name
  type(tui, '*opus*'); tui._key('enter');      // glob
  tui._key('enter');                            // accounts (all)
  tui._key('enter');                            // bucket (auto)
  type(tui, 'chartreuse'); tui._key('enter');   // unknown color
  await settle();
  assert.deepEqual(config.routes, [{ name: 'r', match: ['*opus*'] }]); // no color key
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
