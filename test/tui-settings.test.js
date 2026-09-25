import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, maskKey } from '../src/tui.js';

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

// first-4 + last-4 of a key eight characters long is the whole key.
test('a short sx.org key is not shown whole by its mask', () => {
  assert.equal(maskKey('sk-ant-api03-abcdefgh'), 'sk-a…efgh');
  assert.equal(maskKey('12345678'), '…5678');
  assert.equal(maskKey('abcd'), '****');
  const sx = { getMode: () => 'always', getBalance: () => null, configure: async () => ({ ok: true }) };
  const tui = makeTUI({ sx });
  tui.config.sx = { apiKey: 'short-key', mode: 'always' };
  const row = tui._settingsFields().find(f => f.id === 'sxkey');
  const shown = stripAnsi(row.value());
  assert.doesNotMatch(shown, /short-key/);
  assert.equal(shown, '…-key');
  // The prompt it opens is a masked one.
  row.enter();
  assert.equal(tui.inputSecret, true);
});

// A config written before the key existed has no value for it, and the row
// reads that as on. The first toggle from there has to reach disk as `false`,
// or the switch appears to do nothing until the setting is toggled twice.
test('the quota-bar percentage toggles off from a config that never had the key', async () => {
  const saved = [];
  const tui = makeTUI();
  tui.saveConfig = async c => { saved.push(c.quotaBarPercent); };
  const row = tui._settingsFields().find(f => f.id === 'quotaBarPercent');
  assert.equal(stripAnsi(row.value()), 'on');

  await row.right();
  assert.equal(tui.config.quotaBarPercent, false);
  assert.equal(stripAnsi(tui._settingsFields().find(f => f.id === 'quotaBarPercent').value()), 'off');

  await row.right();
  assert.equal(tui.config.quotaBarPercent, true);
  assert.deepEqual(saved, [false, true]);
});

// A gate that is read live off the shared config (event logging here) must not
// keep a value disk refused: the running server would act on it while the file,
// and so the next start, said otherwise, and the row would show the new value
// the whole time (#443). On a failed save the old value comes back, and the log
// line names the setting it left alone.
test('a settings toggle whose save fails is put back, on screen and in memory', async () => {
  const tui = makeTUI();
  tui.config.eventLogging = 'hide';
  tui.saveConfig = async () => { throw new Error('EACCES: read-only'); };
  const row = tui._settingsFields().find(f => f.id === 'eventlog');
  await row.right();
  assert.equal(tui.config.eventLogging, 'hide', 'the refused value must not stay in memory');
  assert.equal(stripAnsi(tui._settingsFields().find(f => f.id === 'eventlog').value()), 'hide');
  const line = tui.log.map(l => stripAnsi(l.msg)).find(m => /Failed to save/.test(m));
  assert.match(line, /EACCES/);
  assert.match(line, /event logging left unchanged/);

  // The client-mode toggle: the same rule, from an absent key.
  delete tui.config.defaultClientMode;
  const mode = tui._settingsFields().find(f => f.id === 'clientMode');
  await mode.right();
  assert.equal(tui.config.defaultClientMode, undefined);

  // And once the save works again, the change lands.
  tui.saveConfig = async () => {};
  await row.right();
  assert.equal(tui.config.eventLogging, 'block');
});

// The settings body grows with every account and every setting. Past the
// terminal's height it used to be cut off silently, footer included (#445).
// Now the body scrolls: the cursor row stays on screen and the fold is marked.
test('a short terminal scrolls the settings screen rather than dropping its tail', () => {
  const tui = makeTUI();
  const body = Array.from({ length: 30 }, (_, i) => `row ${i}`);

  // Fits: untouched.
  assert.deepEqual(tui._viewport(body.slice(0, 5), 2, 10), body.slice(0, 5));

  // Cursor at the top: no marker above, one below, and the cursor row is drawn.
  let out = tui._viewport(body, 0, 10);
  assert.equal(out.length, 10);
  assert.equal(out[0], 'row 0');
  assert.match(stripAnsi(out[9]), /↓ 20 more/);

  // Cursor moves down past the window: the window follows, both markers show.
  out = tui._viewport(body, 15, 10);
  assert.equal(out.length, 10);
  assert.match(stripAnsi(out[0]), /↑ \d+ more/);
  assert.match(stripAnsi(out[9]), /↓ \d+ more/);
  assert.ok(out.includes('row 15'), `the cursor row must be on screen: ${out.map(stripAnsi).join('|')}`);
  assert.notEqual(out[0], 'row 15'); assert.notEqual(out[9], 'row 15');

  // Cursor at the very end: no marker below.
  out = tui._viewport(body, 29, 10);
  assert.equal(out[9], 'row 29');
  assert.match(stripAnsi(out[0]), /↑ 20 more/);

  // Stepping back up one row does not jump the window: the scroll is sticky.
  const top = tui.setScroll;
  out = tui._viewport(body, 28, 10);
  assert.equal(tui.setScroll, top);
});

test('the whole settings screen keeps its footer on a short terminal', () => {
  const tui = makeTUI();
  tui.am.refreshExpiredQuotas = () => {};
  tui.am.sessionStats = () => ({ active: 0, known: 0, draining: 0 });
  tui.mode = 'settings';
  tui.setIdx = tui._settingsFields().length - 1;   // the last row, past a 24-row fold
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  let buf = '';
  try {
    tui._paint = b => { buf = b; };
    tui.running = true;
    tui.render = TUI.prototype.render;
    tui._render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols); else delete process.stdout.columns;
    if (rows) Object.defineProperty(process.stdout, 'rows', rows); else delete process.stdout.rows;
  }
  const lines = stripAnsi(buf).split('\r\n');
  assert.equal(lines.length, 24, 'exactly the terminal height is written');
  assert.match(lines[23], /esc|back|quit/i, `the footer is the last line: ${lines[23]}`);
  assert.ok(lines.some(l => /↑ \d+ more/.test(l)), 'the fold above is marked');
  assert.ok(lines.some(l => l.includes('▸')), 'the cursor row is on screen');
});
