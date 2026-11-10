import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

test('a rejected route pin reports the reason and leaves the embedded picker open', () => {
  const am = new AccountManager([
    { name: 'allowed', type: 'apikey', apiKey: 'key-a' },
    { name: 'outside', type: 'apikey', apiKey: 'key-b' },
  ], 0.98, { routes: [{ name: 'fable', match: ['claude-fable*'], accounts: ['allowed'] }] });
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] },
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  tui._key('s');
  tui._key('down');
  tui._key('tab');
  assert.equal(tui.selRoute.name, 'fable');
  tui._key('enter');
  assert.equal(tui.mode, 'select');
  assert.match(tui.log.at(-1).msg, /Can't pin:.*does not allow/);
  assert.equal(am.getRoutePin('fable'), null);
  assert.equal(am.currentIndex, 0);
});
