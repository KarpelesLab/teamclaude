import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';

// The settings screen keeps two lists in step: _settingsFields() drives the
// cursor (↑↓ walk it, ←→/Enter act on the current entry) and _renderSettings()
// draws the rows. A field present in the first but missing from the second is
// invisible yet reachable: the cursor lands on nothing and ←→ silently change a
// setting the operator can't see.

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeTUI({ sx = null } = {}) {
  const am = {
    accounts: [{ name: 'a', index: 0, type: 'oauth', credential: 't' }],
    currentIndex: 0,
    switchThreshold: 0.98,
    getRoutes() { return []; },
  };
  const config = { proxy: { port: 1 }, accounts: [{ name: 'a', type: 'oauth' }], routes: [], blockedModels: [] };
  const tui = new TUI({
    accountManager: am, config, sx,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  return tui;
}

function renderWithCursorAt(tui, idx) {
  tui.setIdx = idx;
  const lines = [];
  tui._renderSettings(lines);
  return lines.map(stripAnsi).join('\n');
}

test('settings: every navigable row is drawn, and the cursor stays visible on it', () => {
  const tui = makeTUI();
  const fields = tui._settingsFields();
  assert.ok(fields.length > 0);

  for (let i = 0; i < fields.length; i++) {
    const text = renderWithCursorAt(tui, i);
    assert.ok(text.includes(fields[i].label),
      `"${fields[i].label}" is reachable with the cursor but never drawn`);
    assert.ok(text.includes('▸'),
      `the cursor vanishes while "${fields[i].label}" is selected`);
  }
});

test('settings: sx.org rows are drawn once an sx client exists', () => {
  const sx = {
    getMode: () => 'always',
    getProxy: () => ({ host: '203.0.113.7', port: 8080 }),
    isProvisioned: () => true,
  };
  const tui = makeTUI({ sx });
  tui.config.sx = { apiKey: 'sx-abcd1234' };
  const fields = tui._settingsFields();

  for (let i = 0; i < fields.length; i++) {
    const text = renderWithCursorAt(tui, i);
    assert.ok(text.includes(fields[i].label),
      `"${fields[i].label}" is reachable with the cursor but never drawn`);
  }
});
