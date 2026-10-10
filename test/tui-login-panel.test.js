import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, displayWidth } from '../src/tui.js';
import { clipboardSequence } from '../src/osc.js';

// The login panel: what `l` opens once an account is picked. The sign-in may be
// running on a machine whose browser nobody can see (the server reached over
// SSH), so the panel shows the link, copies it, and takes the pasted answer
// back. The flow itself is the injected loginAccount callback, so everything
// here runs without a browser, a listener or a network.

const URL_ = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s0123456789abcdef0123456789abcdef&code_challenge=c0123456789abcdef0123456789abcdef';
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
// An OSC 8 hyperlink: open (params;uri), visible text, close.
const OSC8 = /\x1b\]8;([^;\x1b]*);([^\x1b]+)\x1b\\(.*?)\x1b\]8;;\x1b\\/g;
const withoutLinks = s => s.replace(OSC8, '$3');

function makeTUI({ loginAccount, env = {} } = {}) {
  const am = {
    accounts: [{ name: 'dead@example.com', index: 0, type: 'oauth', status: 'error', credential: 't', quota: {} }],
    currentIndex: 0, switchThreshold: 0.98,
    getRoutes() { return []; },
    sessionStats() { return { active: 0, known: 0 }; },
    refreshExpiredQuotas() {},
    thresholdFor() { return 0.98; },
  };
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, loginAccount, env,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  return tui;
}

/** A flow that hands the panel `prompt` at once and settles when told to.
 *  Aborting the signal rejects it the way the real flows do. */
function fakeFlow(prompt = {}) {
  const flow = { calls: 0, submits: [], signal: null, settle: null, fail: null };
  flow.loginAccount = (_acct, { signal, onPrompt }) => {
    flow.calls++;
    flow.signal = signal;
    return new Promise((resolve, reject) => {
      flow.settle = () => resolve({ action: 'updated', name: 'dead@example.com' });
      flow.fail = reject;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Login cancelled'), { name: 'AbortError' })));
      onPrompt({
        provider: 'codex', url: URL_, remote: true, listening: true, note: null,
        submit: text => { flow.submits.push(text); return true; },
        ...prompt,
      });
    });
  };
  return flow;
}

/** Run `fn` with process.stdout swapped for a recorder. Synchronous on purpose:
 *  the test runner reports over the real stdout, so the swap must never span
 *  an await. */
function captureStdout(fn, { columns = 100, rows = 30 } = {}) {
  const writes = [];
  const real = Object.getOwnPropertyDescriptor(process, 'stdout');
  Object.defineProperty(process, 'stdout', {
    value: { columns, rows, writableNeedDrain: false, write(s) { writes.push(s); return true; }, removeListener() {} },
    configurable: true,
  });
  try { fn(); } finally { Object.defineProperty(process, 'stdout', real); }
  return writes;
}

/** Open the panel for the one account: `l`, then Enter on the picker. */
function openPanel(tui) {
  tui._key('l');
  tui._key('enter');
}

/** One whole frame as painted. */
function frame(tui, { columns = 100, rows = 30 } = {}) {
  let painted = '';
  const restore = tui.render;
  delete tui.render;
  tui._paint = buf => { painted = buf; };
  captureStdout(() => tui._render(true), { columns, rows });
  tui.render = restore;
  return painted;
}

const logged = tui => tui.log.map(e => stripAnsi(e.msg));

test('login panel: the full URL is drawn from the left edge, one link across its pieces, and the frame keeps its width', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  tui.running = true;
  captureStdout(() => openPanel(tui));
  assert.equal(tui.mode, 'login');

  const painted = frame(tui, { columns: 80, rows: 30 });
  assert.match(stripAnsi(withoutLinks(painted)), /Open the OpenAI sign-in page:/);
  const links = [...painted.matchAll(OSC8)];
  assert.ok(links.length > 1, 'the URL takes more than one row at 80 columns');
  assert.equal(new Set(links.map(m => m[1])).size, 1, 'one id joins the pieces into one link');
  assert.match(links[0][1], /^id=/);
  assert.ok(links.every(m => m[2] === URL_), 'every piece opens the whole URL');
  assert.equal(links.map(m => stripAnsi(m[3])).join(''), URL_, 'the pieces spell the URL');
  // Selected by hand, the rows give the URL and nothing else: each piece
  // starts at column 0, and every one but the last fills the row.
  const rows = painted.replace(/^\x1b\[H/, '').replace(/\x1b\[\?25[hl]$/, '').split('\r\n').map(r => stripAnsi(withoutLinks(r)));
  const first = rows.findIndex(r => r.startsWith(URL_.slice(0, 20)));
  assert.ok(first > 0);
  const n = Math.ceil(URL_.length / 80);
  assert.equal(rows.slice(first, first + n).join('').trimEnd(), URL_);
  for (const row of painted.replace(/^\x1b\[H/, '').replace(/\x1b\[\?25[hl]$/, '').split('\r\n')) {
    assert.equal(displayWidth(withoutLinks(row)), 80);
  }
});

test('login panel: the link goes to the clipboard when the panel opens, and again on `c`', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  tui.running = true;
  const opened = captureStdout(() => openPanel(tui));
  assert.ok(opened.includes(clipboardSequence(URL_)), 'copied once the flow handed over its link');
  assert.ok(opened.includes('\x1b[?2004h'), 'bracketed paste on while the panel is open');

  const again = captureStdout(() => tui._key('c'));
  assert.deepEqual(again, [clipboardSequence(URL_)]);
  assert.match(stripAnsi(withoutLinks(frame(tui))), /Sent again/);
});

test('login panel: inside tmux the clipboard write is wrapped for passthrough as well', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount, env: { TMUX: '/tmp/tmux-501/default,1,0' } });
  tui.running = true;
  const writes = captureStdout(() => openPanel(tui));
  assert.ok(writes.includes(clipboardSequence(URL_, { tmux: true })));
  assert.ok(writes.some(w => w.includes('\x1bPtmux;')));
});

test('login panel: `c` is text once the field has something in it', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  openPanel(tui);
  tui._key('x');
  tui._key('c');
  tui._key('u');
  assert.equal(tui.login.buf, 'xcu');
  tui._key('bs');
  assert.equal(tui.login.buf, 'xc');
});

test('login panel: a bracketed paste is text however it is chunked, and a new one replaces the field', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  openPanel(tui);
  tui._key('z');
  // Split across reads, with a lone `c` among them that would otherwise be the copy key.
  tui._onData('\x1b[200~http://localhost:1455/auth/');
  tui._onData('c');
  tui._onData('allback?code=abc&state=s\r\n\x1b[201~');
  assert.equal(tui.login.buf, 'http://localhost:1455/auth/callback?code=abc&state=s');
  assert.equal(tui.login.pasting, false);

  tui._onData('\x1b[200~second\x1b[201~');
  assert.equal(tui.login.buf, 'second');
});

test('login panel: without bracketed paste, a pasted chunk and typing both fill the field', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  openPanel(tui);
  tui._onData('abc#st\n');
  tui._key('x');
  assert.equal(tui.login.buf, 'abc#stx');
});

test('login panel: no control character reaches the field, C1 included', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  openPanel(tui);
  tui._onData('\x1b[200~ab\x9b2Jc\u200bd\x07\x1b[201~');
  tui._onData('e\x9bf');
  tui._onData('\x9b');
  // What follows a stripped CSI is inert text without it.
  assert.equal(tui.login.buf, 'ab2Jcdef');
});

test('login panel: Enter submits; a refused paste keeps the panel open with the reason', async () => {
  const flow = fakeFlow({
    submit: text => {
      flow.submits.push(text);
      if (text === 'bad') throw new Error('That address is from a different sign-in attempt');
      return true;
    },
  });
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  openPanel(tui);
  tui._key('enter');
  assert.deepEqual(flow.submits, [], 'nothing typed, nothing submitted');

  tui._onData('bad');
  tui._key('enter');
  assert.equal(tui.mode, 'login');
  assert.equal(tui.login.buf, '', 'emptied for the next paste');
  assert.match(tui.login.error, /different sign-in attempt/);

  tui._onData('http://localhost:1455/auth/callback?code=abc&state=s');
  tui._key('enter');
  assert.equal(tui.mode, 'normal', 'a taken paste closes the panel');
  assert.deepEqual(flow.submits, ['bad', 'http://localhost:1455/auth/callback?code=abc&state=s']);

  flow.settle();
  await new Promise(r => setImmediate(r));
  assert.ok(logged(tui).some(m => m === 'Logged in "dead@example.com"'));
});

test('login panel: Esc cancels the flow and says so in one line', async () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  tui.running = true;
  captureStdout(() => openPanel(tui));
  const closed = captureStdout(() => tui._key('esc'));
  assert.equal(flow.signal.aborted, true, 'the flow is told to stop listening');
  assert.equal(tui.mode, 'normal');
  assert.equal(tui.login, null);
  assert.ok(closed.includes('\x1b[?2004l'), 'bracketed paste off again');

  await new Promise(r => setImmediate(r));
  const lines = logged(tui);
  assert.deepEqual(lines.filter(m => /cancel|fail/i.test(m)), ['Sign-in cancelled for "dead@example.com"']);
  assert.equal(tui._loggingIn, null);
});

test('login panel: a flow that fails while the panel is open closes it with the reason', async () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  openPanel(tui);
  flow.fail(new Error('Login timed out after 5 minutes'));
  await new Promise(r => setImmediate(r));
  assert.equal(tui.mode, 'normal');
  assert.ok(logged(tui).some(m => m === 'Login failed for "dead@example.com": Login timed out after 5 minutes'));
});

test('login panel: a prompt that arrives after Esc is ignored', () => {
  let late;
  const tui = makeTUI({ loginAccount: (_a, { onPrompt }) => { late = onPrompt; return new Promise(() => {}); } });
  tui.running = true;
  captureStdout(() => openPanel(tui));
  assert.equal(tui.login.prompt, null, 'the panel opens before the flow is listening');
  captureStdout(() => tui._key('esc'));
  const writes = captureStdout(() => late({ provider: 'claude', url: URL_, remote: true, listening: false, note: null, submit: () => true }));
  assert.deepEqual(writes, [], 'nothing copied for a panel that is gone');
  assert.equal(tui.mode, 'normal');
});

test('login panel: the hint says what the session can do', () => {
  const remoteCodex = makeTUI({ loginAccount: fakeFlow().loginAccount });
  openPanel(remoteCodex);
  const a = stripAnsi(withoutLinks(frame(remoteCodex)));
  assert.match(a, /clipboard/);
  assert.match(a, /ssh -L 1455:localhost:1455/);

  const busy = makeTUI({ loginAccount: fakeFlow({ listening: false, note: 'Port 1455 is in use (a running `codex login` holds it)' }).loginAccount });
  openPanel(busy);
  const b = stripAnsi(withoutLinks(frame(busy)));
  assert.match(b, /Port 1455 is in use/);
  assert.doesNotMatch(b, /ssh -L/, 'no tip for a listener that is not there');

  const localClaude = makeTUI({ loginAccount: fakeFlow({ provider: 'claude', remote: false, listening: true }).loginAccount });
  openPanel(localClaude);
  const c = stripAnsi(withoutLinks(frame(localClaude)));
  // Said as what was done here, not as what the person sees: a terminal that
  // only looks local opened it where nobody is.
  assert.match(c, /browser was opened on this machine/);
  assert.match(c, /Not at this machine/);
  assert.match(c, /paste the code/);
  assert.doesNotMatch(c, /ssh -L/);
});

test('login panel: quitting cancels a waiting login and turns bracketed paste off', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  tui.running = true;
  captureStdout(() => openPanel(tui));
  // stop() touches stdin as well; only its stdout writes matter here.
  const stdin = { removeListener() {}, setRawMode() {}, pause() {} };
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  let writes;
  try { writes = captureStdout(() => tui.stop()); } finally { Object.defineProperty(process, 'stdin', realIn); }
  assert.equal(flow.signal.aborted, true);
  assert.ok(writes.some(w => w.startsWith('\x1b[?2004l')));
});

// ── Reads split anywhere ──────────────────────────────────────

/** Timers the test fires by hand, so the ESC wait and the paste watchdog are
 *  driven without a clock. */
function handTimers(tui) {
  const pending = [];
  tui._setTimeout = (fn, ms) => { pending.push({ fn, ms }); return { unref() {} }; };
  return {
    pending,
    fire() { for (const t of pending.splice(0)) t.fn(); },
  };
}

const PASTE = '\x1b[200~abc#state\x1b[201~';

test('login panel: a paste split at any byte, either marker included, then Enter, submits the whole paste', () => {
  const input = `${PASTE}\r`;
  for (let i = 1; i < input.length; i++) {
    const flow = fakeFlow();
    const tui = makeTUI({ loginAccount: flow.loginAccount });
    const timers = handTimers(tui);
    openPanel(tui);
    tui._onData(input.slice(0, i));
    tui._onData(input.slice(i));
    // Whatever was armed along the way is stale by now and must do nothing.
    timers.fire();
    assert.deepEqual(flow.submits, ['abc#state'], `split at ${i}`);
    assert.equal(tui.mode, 'normal', `split at ${i}`);
    assert.equal(flow.signal.aborted, false, `split at ${i}: a held ESC is not the Esc key`);
  }
});

test('login panel: a paste delivered one byte per read still submits whole', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  handTimers(tui);
  openPanel(tui);
  for (const ch of `${PASTE}\r`) tui._onData(ch);
  assert.deepEqual(flow.submits, ['abc#state']);
  assert.equal(flow.signal.aborted, false);
});

test('login panel: Esc after the closing marker cancels, split or not', () => {
  for (let i = 0; i < PASTE.length; i++) {
    const flow = fakeFlow();
    const tui = makeTUI({ loginAccount: flow.loginAccount });
    const timers = handTimers(tui);
    openPanel(tui);
    if (i) tui._onData(PASTE.slice(0, i));
    tui._onData(PASTE.slice(i));
    tui._onData('\x1b');
    assert.equal(tui.login.buf, 'abc#state', `split at ${i}`);
    assert.equal(flow.signal.aborted, false, 'a lone ESC waits to see whether a marker follows');
    timers.fire();
    assert.equal(flow.signal.aborted, true, `split at ${i}: nothing followed, so it was the Esc key`);
    assert.equal(tui.mode, 'normal');
  }
});

test('login panel: a held ESC followed by anything but a marker is the Esc key, at once', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  handTimers(tui);
  openPanel(tui);
  tui._onData('\x1b');
  tui._onData('x');
  assert.equal(flow.signal.aborted, true);
  assert.equal(tui.mode, 'normal');
});

test('login panel: a paste whose closing marker never comes gives the keyboard back', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  const timers = handTimers(tui);
  openPanel(tui);
  tui._onData('\x1b[200~abc#state');
  tui._onData('\r');
  assert.deepEqual(flow.submits, [], 'inside a paste, Enter is part of it');
  assert.ok(timers.pending.some(t => t.ms >= 1000), 'a watchdog is armed');
  timers.fire();
  assert.equal(tui.login.pasting, false);
  tui._onData('\r');
  assert.deepEqual(flow.submits, ['abc#state']);
});

test('login panel: a closing marker with no opening one keeps what came before it', () => {
  const flow = fakeFlow();
  const tui = makeTUI({ loginAccount: flow.loginAccount });
  handTimers(tui);
  openPanel(tui);
  tui._onData('abc#state\x1b[201~');
  assert.equal(tui.login.buf, 'abc#state');
  assert.equal(tui.login.pasting, false);
});
