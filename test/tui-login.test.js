import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';

// The `l` key: a browser sign-in for an account whose refresh token upstream
// has rejected. The TUI owns the key, the cursor and what it tells the operator;
// the login itself is an injected callback (index.js wires the real one), so
// everything here runs without a browser or a network.

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeTUI({ accounts, loginAccount, remote = false } = {}) {
  const am = {
    accounts: accounts ?? [
      { name: 'ok@example.com', index: 0, type: 'oauth', status: 'active', credential: 't' },
      { name: 'dead@example.com', index: 1, type: 'oauth', status: 'error', credential: 't' },
      { name: 'key', index: 2, type: 'apikey', status: 'active', credential: 'k' },
    ],
    currentIndex: 0,
    switchThreshold: 0.98,
    getRoutes() { return []; },
  };
  const config = { proxy: { port: 1 }, accounts: am.accounts.map(a => ({ name: a.name, type: a.type })), routes: [], blockedModels: [] };
  const tui = new TUI({
    accountManager: am, config, remote, loginAccount,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  return tui;
}

const logged = tui => tui.log.map(e => stripAnsi(e.msg));

test('login: the footer offers the key only where a login can actually run', () => {
  assert.match(stripAnsi(makeTUI({ loginAccount: async () => ({}) })._renderFooter()), /login/);
  // No callback wired (an embedder that cannot log in): no dead key on screen.
  assert.doesNotMatch(stripAnsi(makeTUI()._renderFooter()), /login/);
  // Attach mode edits nothing local; the server's own TUI is where this lives.
  assert.doesNotMatch(stripAnsi(makeTUI({ loginAccount: async () => ({}), remote: true })._renderFooter()), /login/);
});

test('login: `l` opens the picker on the first account that needs a sign-in', () => {
  const tui = makeTUI({ loginAccount: async () => ({}) });
  tui._key('l');
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selAction, 'login');
  assert.equal(tui.am.accounts[tui.selIdx].name, 'dead@example.com');
  assert.match(stripAnsi(tui._renderFooter()), /sign in via browser/);
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
});

test('login: `l` does nothing without the callback, and nothing in attach mode', () => {
  const bare = makeTUI();
  bare._key('l');
  assert.equal(bare.mode, 'normal');
  const attached = makeTUI({ loginAccount: async () => ({}), remote: true });
  attached._key('l');
  assert.equal(attached.mode, 'normal');
});

test('login: Enter runs the login for the picked account and reports it', async () => {
  const seen = [];
  const tui = makeTUI({ loginAccount: async a => { seen.push(a.name); return { action: 'updated', name: a.name }; } });
  tui._key('l');
  tui._key('enter');
  assert.equal(tui.mode, 'normal', 'the dashboard comes back while the browser flow waits');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, ['dead@example.com']);
  assert.ok(logged(tui).some(m => m.includes('Logged in "dead@example.com"')));
  assert.equal(tui._loggingIn, null);
});

test('login: signing in as someone else is said plainly, not reported as success', async () => {
  const tui = makeTUI({ loginAccount: async () => ({ action: 'updated', name: 'ok@example.com' }) });
  tui._key('l');
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  const lines = logged(tui);
  assert.ok(lines.some(m => m.includes('Signed in as "ok@example.com"') && m.includes('"dead@example.com"')));
  assert.ok(!lines.some(m => m.includes('Logged in "dead@example.com"')));
});

test('login: a failed or timed-out flow is a log line, and the key works again', async () => {
  let calls = 0;
  const tui = makeTUI({ loginAccount: async () => { calls++; throw new Error('Login timed out after 2 minutes'); } });
  tui._key('l'); tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.ok(logged(tui).some(m => m.includes('Login failed for "dead@example.com": Login timed out')));
  tui._key('l'); tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2);
});

test('login: one browser flow at a time', async () => {
  let release;
  let calls = 0;
  const tui = makeTUI({ loginAccount: () => { calls++; return new Promise(r => { release = () => r({ action: 'updated', name: 'dead@example.com' }); }); } });
  tui._key('l'); tui._key('enter');
  tui._key('l'); tui._key('enter');
  assert.equal(calls, 1);
  assert.ok(logged(tui).some(m => m.includes('Still waiting on the sign-in')));
  release();
  await new Promise(r => setImmediate(r));
  assert.equal(tui._loggingIn, null);
});

test('login: an API-key account has nothing to sign in to', async () => {
  let calls = 0;
  const tui = makeTUI({ loginAccount: async () => { calls++; return {}; } });
  tui._key('l');
  tui.selIdx = 2;
  tui._key('enter');
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 0);
  assert.ok(logged(tui).some(m => m.includes('not an OAuth account')));
});
