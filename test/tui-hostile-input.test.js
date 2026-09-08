import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, truncate, scrubLine } from '../src/tui.js';

// Values the dashboard draws that did not come from the operator: the model
// string a client put in its request body, the request path, the session-id
// header. Each is repainted from the activity list every frame for as long as
// the entry lives, so an escape sequence that survives ingress fires again on
// every tick — an OSC 52 clipboard write or a screen clear, two hundred times.

const CLIP = '\x1b]52;c;aGVsbG8=\x07';   // OSC 52: write the clipboard
const CLEAR = '\x1b[2J';                 // CSI: erase the screen
const HOSTILE_MODEL = `claude-${CLIP}${CLEAR}\x9b2J\x07evil`;

export function makeTUI() {
  const am = {
    accounts: [{ name: 'a', index: 0, type: 'oauth', quota: {}, status: 'active' }],
    currentIndex: 0, switchThreshold: 0.98,
    getRoutes() { return []; },
    sessionStats() { return { active: 0, known: 0 }; },
    refreshExpiredQuotas() {},
    thresholdFor() { return 0.98; },
  };
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  return tui;
}

/** One full frame, ANSI colour left in place so the assertions can look for
 * the escapes that must NOT be there. */
export function renderRaw(tui) {
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let frame = '';
  try {
    tui._paint = buf => { frame = buf; };
    tui.running = true;
    tui._render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return frame;
}

const stripSgr = s => s.replace(/\x1b\[[0-9;]*m/g, '');
// Everything the frame is allowed to contain by way of escapes: the cursor-home
// prefix, the SGR colour, and the show/hide-cursor toggle. Anything else is a
// value that leaked through.
const allowedEscapes = frame => stripSgr(frame).replace(/\x1b\[H|\x1b\[\?25[hl]/g, '');

test('a hostile model string is drawn without its escapes, in flight and in the log', () => {
  const tui = makeTUI();
  tui.onRequestStart('r1', { method: 'POST', path: '/v1/messages', sessionId: 'abc123def', pinned: false });
  tui.onRequestModel('r1', { model: HOSTILE_MODEL });

  const live = renderRaw(tui);
  assert.doesNotMatch(allowedEscapes(live), /[\x1b\x07\x9b]/);
  assert.match(live, /claude-/);

  tui.onRequestEnd('r1', { method: 'POST', path: '/v1/messages', account: 'a', status: 200, model: HOSTILE_MODEL, sessionId: 'abc123def' });
  assert.equal(tui.active.size, 0);
  assert.doesNotMatch(stripSgr(tui.log[0].msg), /[\x1b\x07\x9b]/);
  assert.match(tui.log[0].msg, /claude-/);

  const done = renderRaw(tui);
  assert.doesNotMatch(allowedEscapes(done), /[\x1b\x07\x9b]/);
});

test('the request path and method are cut down on ingress too', () => {
  const tui = makeTUI();
  tui.onRequestStart('r1', { method: `POST${CLEAR}`, path: `/v1/${CLIP}messages\r\nforged`, sessionId: null });
  const r = tui.active.get('r1');
  assert.equal(r.method, 'POST');
  assert.doesNotMatch(r.path, /[\x1b\x07\r\n]/);
  assert.match(r.path, /forged/);
  // Long paths are clamped so one request cannot claim the whole row.
  tui.onRequestStart('r2', { method: 'GET', path: '/' + 'x'.repeat(5000), sessionId: null });
  assert.ok(tui.active.get('r2').path.length <= 256);
});

// _addLog is also fed lines the TUI composed itself, colour included. The
// colour has to stay; only the foreign escapes go.
test('_addLog keeps its own colour and drops every other escape', () => {
  const tui = makeTUI();
  tui._addLog(`\x1b[36mtag\x1b[0m ${CLIP}${CLEAR}done`);
  assert.equal(tui.log[0].msg, '\x1b[36mtag\x1b[0m done');
});

test('scrubLine and truncate refuse non-SGR escapes', () => {
  assert.equal(scrubLine(`a${CLIP}b${CLEAR}c\x9bd\x07e`), 'abcde');
  assert.equal(scrubLine('\x1b]0;title\x1b\\x'), 'x');   // OSC with an ST terminator
  const cut = truncate(`\x1b[31m${CLIP}red${CLEAR}\x07`, 20);
  assert.doesNotMatch(stripSgr(cut), /[\x1b\x07]/);
  assert.match(cut, /^\x1b\[31m/);
});

// The session id is a client header. Node's parser passes C1 bytes through, and
// U+009B alone is a CSI introducer, so only an id of the shape Claude Code sends
// is shown as-is.
test('a session id outside the safe shape is not drawn raw', () => {
  const tui = makeTUI();
  tui.onRequestEnd('r1', { method: 'POST', path: '/v1/messages', account: 'a', status: 200, model: null, sessionId: '\x9b2Jab\x1b[2Jcdef' });
  const plain = stripSgr(tui.log[0].msg);
  assert.doesNotMatch(plain, /[\x1b\x9b]/);
  assert.match(plain, /2Jab/);   // what is left of it, shortened, still identifies the row
  // The normal shape is untouched.
  tui.onRequestEnd('r2', { method: 'POST', path: '/v1/messages', account: 'a', status: 200, model: null, sessionId: 'f00dbeef-1234' });
  assert.match(stripSgr(tui.log[0].msg), /f00dbe /);
});
