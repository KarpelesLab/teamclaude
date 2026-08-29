import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { renderStatus } from '../src/status-renderer.js';

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeTUI(threshold = 0.98) {
  const am = {
    accounts: [{ name: 'a', index: 0, type: 'oauth', credential: 't' }],
    currentIndex: 0,
    switchThreshold: threshold,
    getRoutes() { return []; },
  };
  const saved = [];
  const tui = new TUI({
    accountManager: am,
    config: { proxy: { port: 1 }, accounts: [{ name: 'a', type: 'oauth' }], routes: [], blockedModels: [], switchThreshold: threshold },
    sx: null,
    saveConfig: async (c) => { saved.push(c.switchThreshold); },
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  tui.render = () => {};
  return { tui, am, saved };
}

const shown = (tui) => plain(tui._settingsFields().find((f) => f.id === 'threshold').value());

test('a whole percent is stored as its fraction', async () => {
  const { tui, am, saved } = makeTUI();
  await tui._doSetThreshold('95');
  assert.equal(am.switchThreshold, 0.95);
  assert.equal(saved.at(-1), 0.95);
  assert.equal(shown(tui), '95%');
});

test('a fraction of a percent survives instead of rounding to the nearest whole', async () => {
  const { tui, am } = makeTUI();
  await tui._doSetThreshold('99.5');
  assert.equal(am.switchThreshold, 0.995);
  assert.equal(shown(tui), '99.5%');
});

test('a whole percent shows no decimal point', async () => {
  const { tui } = makeTUI();
  await tui._doSetThreshold('100');
  assert.equal(shown(tui), '100%');
});

test('input finer than a tenth is quantised, so the stored value is the one shown', async () => {
  const { tui, am } = makeTUI();
  await tui._doSetThreshold('99.55');
  assert.equal(am.switchThreshold, 0.996);
  assert.equal(shown(tui), '99.6%');
});

test('an out-of-range or non-numeric entry changes nothing', async () => {
  for (const bad of ['0', '0.5', '101', 'abc', '']) {
    const { tui, am, saved } = makeTUI(0.98);
    await tui._doSetThreshold(bad);
    assert.equal(am.switchThreshold, 0.98, `"${bad}" was accepted`);
    assert.equal(saved.length, 0, `"${bad}" was saved`);
  }
});

test('nudging keeps the fraction instead of snapping to a whole percent', async () => {
  const { tui, am } = makeTUI(0.995);
  await tui._nudgeThreshold(-1);
  assert.equal(am.switchThreshold, 0.985);
  assert.equal(shown(tui), '98.5%');
});

test('nudging up stops at 100%', async () => {
  const { tui, am } = makeTUI(0.995);
  await tui._nudgeThreshold(+1);
  assert.equal(am.switchThreshold, 1);
  assert.equal(shown(tui), '100%');
});

test('nudging down stops at 1%', async () => {
  const { tui, am } = makeTUI(0.01);
  await tui._nudgeThreshold(-1);
  assert.equal(am.switchThreshold, 0.01);
});

test('status prints the threshold as it was set', () => {
  const status = { currentAccount: 'a', switchThreshold: 0.995, accounts: [], blockedModels: [] };
  assert.match(plain(renderStatus(status, { color: false })), /Switch at\s+99\.5%/);
});

test('status keeps whole percentages whole', () => {
  const status = { currentAccount: 'a', switchThreshold: 0.98, accounts: [], blockedModels: [] };
  assert.match(plain(renderStatus(status, { color: false })), /Switch at\s+98%/);
});
