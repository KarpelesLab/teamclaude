import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';

// TUI account management (settings screen) + the on-demand quota probe (`p`).
// Same approach as tui-routes.test.js: a minimal AccountManager stand-in and a
// stubbed render() so these exercise the state machine, not the terminal.

function makeTUI({ accounts = [{ name: 'a', index: 0, type: 'oauth', credential: 't' }], probeQuota } = {}) {
  const calls = { added: [], removed: [], probed: 0 };
  const am = {
    accounts,
    currentIndex: 0,
    switchThreshold: 0.98,
    getRoutes() { return []; },
    addAccount(entry) { calls.added.push(entry); this.accounts.push({ ...entry, index: this.accounts.length }); },
    removeAccount(idx) { calls.removed.push(this.accounts[idx]?.name); this.accounts.splice(idx, 1); },
  };
  const config = { proxy: { port: 1 }, accounts: accounts.map(a => ({ name: a.name, type: a.type })), routes: [] };
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
    probeQuota: probeQuota === undefined ? (() => { calls.probed++; }) : probeQuota,
  });
  tui.render = () => {}; // bypass terminal rendering
  return { tui, am, config, calls };
}

const type = (tui, s) => { for (const ch of s) tui._key(ch); };
const settle = () => new Promise(r => setTimeout(r, 5)); // let async handlers finish

// Settings rows: threshold(0), probe(1), routes(2), addAccount(3), removeAccount(4).
function openSettingsRow(tui, row) {
  tui._key('g');
  for (let i = 0; i < row; i++) tui._key('down');
  tui._key('enter');
}

test('the a/r shortcuts are gone from normal mode', () => {
  const { tui } = makeTUI();
  tui._key('a');
  assert.equal(tui.mode, 'normal'); // no add chooser
  tui._key('r');
  assert.equal(tui.mode, 'normal'); // no remove selector
});

test('p probes quota on all accounts and logs the result', async () => {
  const { tui, calls } = makeTUI();
  tui._key('p');
  await settle();
  assert.equal(calls.probed, 1);
  assert.equal(tui.mode, 'normal'); // fire-and-forget, no mode change
  assert.ok(tui.log.some(l => /Refreshing quota on 1 account/.test(l.msg)));
  assert.ok(tui.log.some(l => /Quota refresh complete/.test(l.msg)));
});

test('p reports when there is nothing to probe (no OAuth accounts)', async () => {
  const { tui, calls } = makeTUI({ accounts: [{ name: 'k', index: 0, type: 'apikey' }] });
  tui._key('p');
  await settle();
  assert.equal(calls.probed, 0);
  assert.ok(tui.log.some(l => /No OAuth accounts to probe/.test(l.msg)));
});

test('a probe failure is logged, and a re-press probes again', async () => {
  let n = 0;
  const { tui } = makeTUI({ probeQuota: () => { n++; return Promise.reject(new Error('boom')); } });
  tui._key('p');
  await settle();
  assert.ok(tui.log.some(l => /Quota refresh failed: boom/.test(l.msg)));
  tui._key('p');
  await settle();
  assert.equal(n, 2); // the in-flight guard was released
});

test('settings → Add account → API key adds the account and returns to settings', async () => {
  const { tui, am, config, calls } = makeTUI();
  openSettingsRow(tui, 3);
  assert.equal(tui.mode, 'add');
  tui._key('k'); // API key path
  assert.equal(tui.mode, 'input');
  type(tui, 'sk-test');
  tui._key('enter');
  await settle();
  assert.equal(tui.mode, 'settings'); // input falls back to the launching screen
  assert.equal(calls.added.length, 1);
  assert.equal(am.accounts.length, 2);
  assert.equal(config.accounts.at(-1).type, 'apikey');
});

test('Esc backs out of the add chooser to settings', () => {
  const { tui } = makeTUI();
  openSettingsRow(tui, 3);
  tui._key('esc');
  assert.equal(tui.mode, 'settings');
});

test('settings → Remove account removes the picked account and returns to settings', async () => {
  const { tui, am, config, calls } = makeTUI({
    accounts: [
      { name: 'a', index: 0, type: 'oauth', credential: 't' },
      { name: 'b', index: 1, type: 'oauth', credential: 't' },
    ],
  });
  openSettingsRow(tui, 4);
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selAction, 'remove');
  tui._key('down'); // pick "b"
  tui._key('enter');
  await settle();
  assert.deepEqual(calls.removed, ['b']);
  assert.equal(am.accounts.length, 1);
  assert.equal(config.accounts.length, 1);
  assert.equal(tui.mode, 'settings'); // back where the flow started
});

test('the Remove account row is absent with no accounts, and Esc from remove-select returns to settings', () => {
  const none = makeTUI({ accounts: [] });
  assert.ok(!none.tui._settingsFields().some(f => f.id === 'removeAccount'));
  assert.ok(none.tui._settingsFields().some(f => f.id === 'addAccount')); // add still offered

  const { tui } = makeTUI();
  openSettingsRow(tui, 4);
  tui._key('esc');
  assert.equal(tui.mode, 'settings');
});

test('select mode entered from the dashboard still returns to normal', () => {
  const { tui } = makeTUI();
  tui._key('d'); // enable/disable selector from normal mode
  assert.equal(tui.mode, 'select');
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
});
