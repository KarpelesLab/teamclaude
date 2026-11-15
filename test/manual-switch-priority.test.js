import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { createProxyServer } from '../src/server.js';

const MODEL = 'claude-opus-5-5';

function manager(options = {}) {
  return new AccountManager([
    { name: 'automatic', type: 'apikey', apiKey: 'key-a', priority: 0 },
    { name: 'manual', type: 'oauth', accessToken: 'token-m', refreshToken: 'refresh-m', expiresAt: Date.now() + 3600_000, priority: 10, allowExtraUsage: true },
  ], 0.98, options);
}

test('manual selection takes precedence over an available higher-priority account', () => {
  const am = manager();
  assert.equal(am.setCurrentAccount(1), true);
  for (let turn = 0; turn < 3; turn++) {
    assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
    assert.equal(am.previewRouteIndex(MODEL), 1);
    assert.deepEqual(am.eligibility(1), { eligible: true });
  }
});

test('automatic placement still yields to higher priority', () => {
  const am = manager();
  am._setCurrent(am.accounts[1]);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
});

for (const blocked of ['disabled', 'error', 'five-hour quota', 'weekly quota']) {
  test(`manual selection does not bypass ${blocked}`, () => {
    const am = manager();
    am.setCurrentAccount(1);
    if (blocked === 'disabled') am.accounts[1].disabled = true;
    else if (blocked === 'error') am.accounts[1].status = 'error';
    else am.accounts[1].quota[blocked === 'five-hour quota' ? 'unified5h' : 'unified7d'] = 1;
    assert.equal(am.eligibility(1).eligible, false);
    assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
  });
}

test('request exclusions rotate away and release the manual priority preference', () => {
  const am = manager();
  am.setCurrentAccount(1);
  assert.equal(am.getActiveAccount(new Set([1]), MODEL).name, 'automatic');
  am._setCurrent(am.accounts[1]);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
});

test('model-route diversion preserves the manual choice for models it can serve', () => {
  const am = manager({ routes: [
    { name: 'fable', match: ['claude-fable*'], accounts: ['automatic'] },
    { name: 'other', match: ['*'], accounts: ['automatic', 'manual'] },
  ] });
  am.setCurrentAccount(1);
  assert.equal(am.getActiveAccount(null, 'claude-fable-5-1').name, 'automatic');
  assert.equal(am.currentIndex, 1);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('an explicit route pin remains more specific than the manual default', () => {
  const am = manager({ routes: [{ name: 'all', match: ['*'], accounts: ['automatic', 'manual'] }] });
  am.setCurrentAccount(1);
  assert.equal(am.setRoutePin('all', 0).ok, true);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
  am.clearRoutePin('all');
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('removing an earlier account keeps the manual preference on its account', () => {
  const am = manager();
  am.addAccount({ name: 'another', type: 'apikey', apiKey: 'key-b', priority: 0 });
  am.setCurrentAccount(1);
  am.removeAccount(0);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('removing the selected account does not transfer the preference to its replacement', () => {
  const am = manager();
  am.addAccount({ name: 'replacement', type: 'apikey', apiKey: 'key-b', priority: 10 });
  am.setCurrentAccount(1);
  am.removeAccount(1);
  am._setCurrent(am.accounts[1]);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
});

test('a borrowed provider selection does not erase another provider\'s manual choice', () => {
  const am = manager();
  am.addAccount({ name: 'codex', type: 'codex', accessToken: 'token-c', refreshToken: 'refresh-c', expiresAt: Date.now() + 3600_000, priority: -1 });
  am.setCurrentAccount(1);
  assert.equal(am.getActiveAccount(null, 'gpt-6-astra', null, null, 'codex').name, 'codex');
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('a walk that lands on the manual account again keeps the choice', () => {
  const am = manager();
  am.setCurrentAccount(1);
  am._setCurrent(am.accounts[1]);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('learning quota does not undo a healthy manual priority preference', () => {
  const am = manager();
  am.setCurrentAccount(1);
  am.accounts[1].requalify = true;
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
});

test('a shared API key chosen for one provider does not override another provider priority', () => {
  const am = new AccountManager([
    { name: 'shared', type: 'apikey', apiKey: 'key-s', priority: 10 },
    { name: 'codex', type: 'codex', accessToken: 'token-c', expiresAt: Date.now() + 3600_000, priority: 0 },
  ]);
  am.setCurrentAccount(0);
  assert.equal(am.previewRouteIndex('gpt-6-astra', 'codex'), 1);
  assert.equal(am.getActiveAccount(null, 'gpt-6-astra', null, null, 'codex').name, 'codex');
});

test('the embedded TUI switch survives the next request and routing preview', () => {
  const am = manager();
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] },
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  tui._key('s');
  tui._key('down');
  assert.equal(tui.selIdx, 1);
  tui._key('enter');
  assert.equal(tui.mode, 'normal');
  assert.equal(am.currentIndex, 1);
  assert.equal(am.getActiveAccount(null, MODEL).name, 'manual');
  assert.equal(am.previewRouteIndex(MODEL), 1);
});

// With distribution on, a new conversation is placed within the best priority
// tier and never reads the manual choice. The switch endpoints ask for that
// check (`manualSwitch`); the plain flag does not carry it.
const DISTRIBUTION_MODES = [true, 'adaptive', 'load'];

for (const mode of DISTRIBUTION_MODES) {
  test(`distributeSessions ${mode}: a switch to an outranked account is reported as not taking effect`, () => {
    const am = manager({ distributeSessions: mode });
    assert.equal(am.setCurrentAccount(1), true);
    // What the switch endpoint reports must match where new conversations go.
    for (let i = 0; i < 4; i++) assert.equal(am.getActiveAccount(null, MODEL, null, `session-${i}`).name, 'automatic');
    assert.equal(am.getActiveAccount(null, MODEL).name, 'automatic');
    const { eligible, reason } = am.eligibility(1, { manualSwitch: true });
    assert.equal(eligible, false);
    assert.match(reason, /outranked by higher-priority account "automatic".*distributeSessions/);
  });

  test(`distributeSessions ${mode}: a switch to a top-priority account is still eligible`, () => {
    const am = manager({ distributeSessions: mode });
    assert.equal(am.setCurrentAccount(0), true);
    assert.deepEqual(am.eligibility(0, { manualSwitch: true }), { eligible: true });
  });

  test(`distributeSessions ${mode}: another provider's higher-priority account does not outrank a switch`, () => {
    const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + 3600_000, ...extra });
    const am = new AccountManager([
      oauth('cx', { priority: 0, provider: 'codex' }),
      oauth('c1', { priority: 10 }),
      oauth('c2', { priority: 10 }),
    ], 0.98, { distributeSessions: mode });
    am.setCurrentAccount(1);
    // Claude traffic never reaches the Codex account, so nothing outranks c1.
    for (let i = 0; i < 4; i++) assert.notEqual(am.getActiveAccount(null, MODEL, null, `session-${i}`).name, 'cx');
    assert.deepEqual(am.eligibility(1, { manualSwitch: true }), { eligible: true });
  });
}

test('without manualSwitch eligibility does not read distribution, so a pinned session is not reported as failing', () => {
  const am = manager({ distributeSessions: 'adaptive' });
  am.setCurrentAccount(1);
  assert.deepEqual(am.eligibility(1), { eligible: true });
});

async function endpointAnswers() {
  const am = manager({ distributeSessions: 'adaptive' });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify(body),
    });
    return res.json();
  };
  try {
    return {
      switched: await post('/teamclaude/switch', { account: 'manual' }),
      pinned: await post('/teamclaude/session-pin', { sessionId: '3f2a1b9c-0000-4000-8000-000000000001', account: 'manual' }),
    };
  } finally {
    proxy.close();
  }
}

test('the switch endpoint reports the outranked switch, the session-pin endpoint does not', async () => {
  const { switched, pinned } = await endpointAnswers();
  assert.equal(switched.eligible, false);
  assert.match(switched.reason, /outranked by higher-priority account "automatic"/);
  // A hard session pin is routed regardless of priority.
  assert.equal(pinned.eligible, true);
  assert.equal(pinned.reason, undefined);
});
