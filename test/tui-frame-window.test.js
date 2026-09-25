import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

// The frame is header + body + footer, and the footer is where a prompt is
// typed. A body taller than the terminal used to push the footer off the
// bottom. On the settings screen (the tallest one, and the one every prompt
// returns to) the operator typed a value they could not see. These pin the
// fix: the footer is always on the last line, and the body window follows the
// cursor row.

const stripSgr = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const cursorCodes = /\x1b\[H|\x1b\[\?25[hl]/g;

function makeTUI() {
  const entries = [
    { id: 'id-a', name: 'alice@example.com', type: 'apikey', apiKey: 'sk-a' },
    { id: 'id-b', name: 'bob@example.com', type: 'apikey', apiKey: 'sk-b' },
  ];
  const sx = { getMode: () => 'off', getProxy: () => null, isProvisioned: () => false, getBalance: async () => null };
  return new TUI({
    accountManager: new AccountManager(entries, 0.98),
    config: { proxy: { port: 1 }, accounts: entries.map(e => ({ ...e })), routes: [], blockedModels: [] },
    sx, saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: null,
  });
}

/** The frame as the terminal would show it: one string per row. */
function frameAt(tui, H, W = 100) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: W, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: H, configurable: true });
  let frame = '';
  try {
    tui._paint = buf => { frame = buf; };
    tui.running = true;
    tui.render(true);
  } finally {
    tui.running = false;
    if (cols) Object.defineProperty(process.stdout, 'columns', cols); else delete process.stdout.columns;
    if (rows) Object.defineProperty(process.stdout, 'rows', rows); else delete process.stdout.rows;
  }
  return stripSgr(frame).replace(cursorCodes, '').split('\r\n');
}

test('the settings screen keeps its footer on a terminal shorter than the list', () => {
  const tui = makeTUI();
  tui.mode = 'settings';
  const fields = tui._settingsFields();
  for (const H of [24, 30, 40]) {
    for (let i = 0; i < fields.length; i++) {
      tui.setIdx = i;
      const rows = frameAt(tui, H);
      assert.equal(rows.length, H);
      assert.match(rows[0], /TeamClaude/, 'the header holds still');
      assert.match(rows[H - 1], /navigate.*Esc back/, `H=${H}, row "${fields[i].label}": the footer fell off the frame`);
      assert.ok(rows.some(r => r.includes('▸') && r.includes(fields[i].label)),
        `H=${H}: the cursor row "${fields[i].label}" scrolled out of its own window`);
    }
  }
});

test('an open prompt is visible at the bottom of a short terminal, with what was typed', () => {
  const tui = makeTUI();
  tui.mode = 'settings';
  tui.setIdx = tui._settingsFields().findIndex(f => f.id === 'accountProxy');
  tui._key('enter');   // the account picker
  tui._key('enter');   // the prompt, which keeps the settings screen behind it
  tui._onData('socks5h://alice@proxy.example.com:1080');
  const rows = frameAt(tui, 24);
  assert.match(rows[23], /^ Proxy for alice@example\.com \(URL\): socks5h:\/\/alice@proxy\.example\.com:1080█/);
});

test('a body that fits is drawn exactly as before', () => {
  const tui = makeTUI();
  tui.mode = 'settings';
  tui.setIdx = 0;
  const tall = frameAt(tui, 80);
  assert.match(tall[2], /^\s*$/, 'the body starts where it always did');
  assert.ok(tall.some(r => r.includes('Rotation')) && tall.some(r => r.includes('sx.org proxy')), 'the whole list is on screen');
  assert.match(tall[79], /navigate.*Esc back/);
});
