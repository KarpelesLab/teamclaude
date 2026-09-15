import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, displayWidth } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

// The header is one line built from three pieces that must add up to exactly
// the terminal width: the title, a centred version label, and the port block
// pinned to the right edge. Every case below is really the same assertion —
// the arithmetic holds, or the right edge drifts and fitLine eats the liveness
// marker.

function fakeAm(sessions) {
  return {
    accounts: [],
    currentIndex: -1, switchThreshold: 0.98,
    getRoutes() { return []; },
    sessionStats() { return { active: sessions, known: sessions }; },
    refreshExpiredQuotas() {},
    thresholdFor() { return 0.98; },
  };
}

function makeTUI({ am = fakeAm(0), ...opts } = {}) {
  return new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: null,
    ...opts,
  });
}

/** One full frame at a given width, ANSI left in place. */
function renderRaw(tui, W) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: W, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let frame = '';
  try {
    tui._paint = buf => { frame = buf; };
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return frame;
}

const stripSgr = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const cursorCodes = /\x1b\[H|\x1b\[\?25[hl]/g;
const header = (tui, W) => stripSgr(renderRaw(tui, W)).replace(cursorCodes, '').split('\r\n')[0];
const count = (s, ch) => [...s].filter(c => c === ch).length;

const WIDTHS = [40, 44, 50, 60, 80, 100, 120, 200];

test('the header is exactly the terminal width at every size, with or without a label', () => {
  for (const W of WIDTHS) {
    for (const sessions of [0, 3]) {
      for (const updateAvailable of [false, true]) {
        for (const versionLabel of ['', 'v1.2.3', '1.1.20-pr378']) {
          const line = header(makeTUI({ am: fakeAm(sessions), versionLabel, updateAvailable }), W);
          const where = `W=${W} sess=${sessions} upd=${updateAvailable} label=${versionLabel || '(none)'}`;
          assert.equal(displayWidth(line), W, `${where}: width ${displayWidth(line)}`);
          assert.ok(line.endsWith('Port 1 ▲ '), `${where}: right block clipped — ${JSON.stringify(line.slice(-12))}`);
        }
      }
    }
  }
});

test('the label is centred on the line and does not move when sessions appear', () => {
  const at = sessions => header(makeTUI({ am: fakeAm(sessions), versionLabel: 'v1.2.3' }), 100).indexOf('v1.2.3');
  assert.equal(at(0), Math.floor((100 - 'v1.2.3'.length) / 2));
  assert.equal(at(3), at(0));
});

test('the update marker is a second triangle, drawn only when an update is known', () => {
  const on = header(makeTUI({ versionLabel: 'v1.2.3', updateAvailable: true }), 100);
  assert.match(on, /v1\.2\.3 ▲/);
  assert.equal(count(on, '▲'), 2);

  const off = header(makeTUI({ versionLabel: 'v1.2.3', updateAvailable: false }), 100);
  assert.match(off, /v1\.2\.3(?! ▲)/);
  assert.equal(count(off, '▲'), 1);
});

test('a header too narrow for the label drops it whole, falling back verbatim', () => {
  const narrow = header(makeTUI({ am: fakeAm(3), versionLabel: '1.1.20-pr378', updateAvailable: true }), 40);
  assert.doesNotMatch(narrow, /1\.1\.20/);
  assert.equal(count(narrow, '▲'), 1);
  assert.equal(narrow, header(makeTUI({ am: fakeAm(3) }), 40));
});

test('a TUI given no label renders the header it rendered before there was one', () => {
  assert.equal(header(makeTUI(), 80), header(makeTUI({ versionLabel: '' }), 80));
});

// ── attach mode ──────────────────────────────────────────────

function remoteTUI(server, opts = {}) {
  const am = new RemoteAccountManager();
  am.applyStatus({
    currentAccount: 'a@example.com', switchThreshold: 0.98, routes: [],
    sessions: { active: 0, known: 0, perAccount: {} },
    accounts: [{ name: 'a@example.com', type: 'oauth', status: 'active', usage: {}, quota: {} }],
    ...(server ? { server } : {}),
  });
  return makeTUI({ am, remote: true, applySwitch: async () => {}, ...opts });
}

test('the attached dashboard names the server build, not its own', () => {
  const line = header(remoteTUI(
    { version: '1.0.0', versionLabel: 'v9.9.9', updateAvailable: true },
    { versionLabel: 'ignored-local', updateAvailable: false },
  ), 100);
  assert.match(line, /v9\.9\.9 ▲/);
  assert.doesNotMatch(line, /ignored-local/);
});

test('a server that only sends version still gets a label, and no update marker', () => {
  const line = header(remoteTUI({ version: '1.0.0' }), 100);
  assert.match(line, /1\.0\.0/);
  assert.equal(count(line, '▲'), 1);
});

test('a server that sends no version block leaves the header as it was', () => {
  const line = header(remoteTUI(null), 100);
  assert.equal(displayWidth(line), 100);
  assert.equal(count(line, '▲'), 1);
});

test('a version label off the wire cannot put an escape sequence in the frame', () => {
  const frame = renderRaw(remoteTUI({ versionLabel: 'v1\x1b[2J\x1b]52;c;aGk=\x07evil' }), 100);
  const rest = stripSgr(frame).replace(cursorCodes, '');
  assert.doesNotMatch(rest, /[\x1b\x07\x9b]/);
  assert.match(rest, /v1/);
});
