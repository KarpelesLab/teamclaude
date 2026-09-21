import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

// The settings screen's "Account proxy" row: pick an account, type a URL (or
// `none`), and the account's routing changes in the running fleet and on disk.
// Driven through _key, the way a keypress arrives, against a real manager — the
// cooldown reset and the config pairing are the manager's and the pairing
// module's own code, and a stub would only restate what this expects of them.

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeTUI({ testRouting = async () => ({ ok: true, host: 'api.anthropic.com', ms: 12 }) } = {}) {
  const entries = [
    { id: 'id-a', name: 'alice@example.com', type: 'apikey', apiKey: 'sk-a' },
    { id: 'id-b', name: 'bob@example.com', type: 'apikey', apiKey: 'sk-b', routing: 'socks5://old.example.com:1080' },
  ];
  const am = new AccountManager(entries, 0.98);
  const config = { proxy: { port: 1 }, accounts: entries.map(e => ({ ...e })), routes: [], blockedModels: [] };
  const saves = [];
  const tested = [];
  const tui = new TUI({
    accountManager: am, config,
    saveConfig: async (c) => { saves.push(JSON.parse(JSON.stringify(c.accounts))); },
    syncAccounts: async () => 0, onQuit: () => {},
    testRouting: async (routing, url) => { tested.push({ routing, url }); return testRouting(routing, url); },
  });
  tui.render = () => {};
  return { tui, am, config, saves, tested };
}

const type = (tui, text) => { for (const ch of text) tui._key(ch); };
const logged = tui => tui.log.map(l => stripAnsi(l.msg));

// Settings → the Account proxy row → Enter, landing in the account picker.
function openPicker(tui) {
  tui.mode = 'settings';
  tui.setIdx = tui._settingsFields().findIndex(f => f.id === 'accountProxy');
  assert.ok(tui.setIdx >= 0, 'the row exists');
  tui._key('enter');
}

// Settle the async setter the Enter key fired without awaiting.
const settle = () => new Promise(r => setTimeout(r, 10));

test('the row sits under the fleet proxy, says how many accounts are routed, and is drawn', () => {
  const { tui } = makeTUI();
  const ids = tui._settingsFields().map(f => f.id);
  assert.equal(ids[ids.indexOf('upstreamProxy') + 1], 'accountProxy', 'the two egress settings are neighbours');

  tui.setIdx = ids.indexOf('accountProxy');
  const lines = [];
  tui._renderSettings(lines);
  const text = lines.map(stripAnsi).join('\n');
  assert.match(text, /▸ Account proxy\s+1 of 2 routed/);
  assert.ok(text.indexOf('Upstream proxy') < text.indexOf('Account proxy'));
  assert.match(text, /socks5h:\/\/user:pass@host:1080/, 'the accepted shape is on screen before the prompt asks for it');
});

test('pick an account, type a URL: tested, applied live, saved canonical, logged masked', async () => {
  const { tui, am, config, saves, tested } = makeTUI();
  openPicker(tui);
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selAction, 'routing');
  // The footer is the only place that says what Enter will do to the row under
  // the cursor, and the default for an action it does not know is "remove".
  assert.match(stripAnsi(tui._renderFooter()), /Enter set its proxy\s+Esc cancel/);

  tui._key('enter'); // first row: alice
  assert.equal(tui.mode, 'input');
  assert.match(tui.inputPrompt, /^Proxy for alice@example\.com \(URL\)$/, 'nothing to clear yet, so the prompt does not offer it');

  type(tui, 'socks5h://alice:s3cret@proxy.example.com');
  tui._key('enter');
  await settle();

  assert.equal(tui.mode, 'settings', 'back where the operator started');
  assert.equal(tested.length, 1);
  assert.equal(tested[0].url, 'https://api.anthropic.com', 'tested against the account\'s own upstream');
  assert.equal(am.accounts[0].routing.protocol, 'socks5h');
  assert.equal(am.accounts[0].routing.password, 's3cret');
  assert.equal(config.accounts[0].routing, 'socks5h://alice:s3cret@proxy.example.com:1080', 'canonical: the default port spelled out');
  assert.equal(saves.length, 1);
  assert.equal(saves[0][0].routing, 'socks5h://alice:s3cret@proxy.example.com:1080');
  assert.equal(saves[0][1].routing, 'socks5://old.example.com:1080', 'the other account is untouched');

  const lines = logged(tui);
  assert.ok(lines.some(l => l.includes('"alice@example.com" now leaves through socks5h://alice:***@proxy.example.com:1080')), lines.join('\n'));
  assert.equal(lines.some(l => l.includes('s3cret')), false, 'the password never reaches the activity log');
});

test('Enter in the routing picker never reaches the remove branch', async () => {
  // _keySelect sends an action it does not list to _doRemove.
  const { tui, am } = makeTUI();
  openPicker(tui);
  tui._key('enter');
  tui._key('esc');
  await settle();
  assert.equal(am.accounts.length, 2);
  assert.equal(tui.mode, 'settings');
});

test('a proxy that fails its test changes nothing, and the log says why', async () => {
  const { tui, am, config, saves } = makeTUI({
    testRouting: async () => ({ ok: false, host: 'api.anthropic.com', error: 'account routing proxy socks5://alice:***@127.0.0.1:9: SOCKS5 authentication failed' }),
  });
  openPicker(tui);
  tui._key('down');  // bob, who has a working routing to lose
  tui._key('enter');
  assert.match(tui.inputPrompt, /^Proxy for bob@example\.com \(URL, or none to clear\)$/);
  type(tui, 'socks5://alice:wrong@127.0.0.1:9');
  tui._key('enter');
  await settle();

  assert.equal(am.accounts[1].routing.host, 'old.example.com', 'still on the routing it had');
  assert.equal(config.accounts[1].routing, 'socks5://old.example.com:1080');
  assert.equal(saves.length, 0);
  assert.ok(logged(tui).some(l => l.includes('Proxy not set: account routing proxy socks5://alice:***@127.0.0.1:9: SOCKS5 authentication failed')));
});

test('none clears it, without a test, and lifts a cooldown the old proxy earned', async () => {
  const { tui, am, config, saves, tested } = makeTUI();
  am.markRoutingFailed(1);
  assert.equal(am.unavailableReason(am.accounts[1]), 'routing');

  openPicker(tui);
  tui._key('down');
  tui._key('enter');
  type(tui, 'none');
  tui._key('enter');
  await settle();

  assert.equal(am.accounts[1].routing, null);
  assert.equal(am.unavailableReason(am.accounts[1]), null, 'the hold described a proxy the account no longer uses');
  assert.equal(config.accounts[1].routing, null, 'an explicit null: the save merges over the on-disk entry');
  assert.equal(saves.length, 1);
  assert.equal(tested.length, 0);
  assert.ok(logged(tui).some(l => l.includes('Cleared the proxy for "bob@example.com"')));
});

test('an unusable URL is refused before any test, its password masked', async () => {
  const { tui, am, saves, tested } = makeTUI();
  openPicker(tui);
  tui._key('enter');
  type(tui, 'https://alice:s3cret@proxy.example.com:443');
  tui._key('enter');
  await settle();

  assert.equal(am.accounts[0].routing, null);
  assert.equal(saves.length, 0);
  assert.equal(tested.length, 0);
  const lines = logged(tui);
  assert.ok(lines.some(l => /Invalid proxy: unsupported routing protocol "https"/.test(l)), lines.join('\n'));
  assert.equal(lines.some(l => l.includes('s3cret')), false);
});

test('a blank entry and Esc both leave everything as it was', async () => {
  const { tui, am, saves } = makeTUI();
  openPicker(tui);
  tui._key('down');
  tui._key('enter');
  tui._key('enter'); // blank
  await settle();
  assert.equal(tui.mode, 'settings');
  assert.equal(am.accounts[1].routing.host, 'old.example.com');

  openPicker(tui);
  tui._key('esc');
  assert.equal(tui.mode, 'settings');
  assert.equal(saves.length, 0);
});

// ── pasted input ─────────────────────────────────────────────

test('a pasted URL fills the prompt: stdin hands a paste over as one chunk', async () => {
  // Nobody types socks5h://user:long-password@host:1080 by hand. The key
  // parser used to drop any chunk longer than one character without a sign.
  const { tui, am } = makeTUI();
  openPicker(tui);
  tui._key('enter');
  assert.equal(tui.mode, 'input');

  // The clipboard's trailing newline does not submit on the operator's behalf.
  tui._onData('socks5h://alice:s3cret@proxy.example.com:1080\n');
  assert.equal(tui.inputBuf, 'socks5h://alice:s3cret@proxy.example.com:1080');
  assert.equal(tui.mode, 'input', 'still waiting for Enter');

  tui._onData('\r');
  await settle();
  assert.equal(am.accounts[0].routing?.host, 'proxy.example.com');
});

test('a multi-character chunk is text only inside a prompt, and never when it holds an escape', () => {
  const { tui } = makeTUI();
  tui.mode = 'settings';
  tui._onData('qqq');
  assert.equal(tui.mode, 'settings', 'outside a prompt a burst is not replayed as keypresses');

  tui._promptInput('Anything', () => {});
  tui._onData('ab\x1b[Acd');
  assert.equal(tui.inputBuf, '', 'an unknown key sequence is not text');
  tui._onData('a\x00b\x07c\x7fd');
  assert.equal(tui.inputBuf, 'abcd', 'control characters never reach the buffer');
});
