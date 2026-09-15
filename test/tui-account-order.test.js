import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { isLocalUpstream } from '../src/provider.js';

// An account served by a local process (a translating proxy in front of another
// vendor, say) is infrastructure, not a seat the fleet rotates between, so it
// belongs at the end of the table instead of wedged among the accounts that do
// rotate. Config order cannot hold that on its own: a newly added account is
// appended after it and puts it back in the middle.
//
// Rendered rather than unit-tested, in the shape tui-name-column.test.js uses —
// the order rows are DRAWN in is the property, and only render() decides it.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const LOCAL = { upstream: 'http://127.0.0.1:18765' };

function makeTUI(entries) {
  const am = new AccountManager(entries, 0.98);
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  tui.render = () => {};
  return { tui, am };
}

/** The manager indices render() actually asked _renderAcct to draw, in order. */
function drawOrder(tui) {
  const drawn = [];
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  try {
    const real = tui._renderAcct.bind(tui);
    tui._renderAcct = (...args) => { drawn.push(args[0]); return real(...args); };
    tui._paint = () => {};
    tui.running = true;
    delete tui.render; // use the real one for this call
    TUI.prototype.render.call(tui, true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return drawn;
}

test('a loopback upstream marks a locally-served account', () => {
  for (const upstream of ['http://127.0.0.1:18765', 'http://localhost:1234', 'http://[::1]:9', 'http://127.5.5.5']) {
    assert.equal(isLocalUpstream({ upstream }), true, upstream);
  }
});

test('a remote third-party backend is not local', () => {
  // The DeepSeek/GLM fallback case: a real upstream, just not Anthropic's.
  assert.equal(isLocalUpstream({ upstream: 'https://api.deepseek.com' }), false);
  assert.equal(isLocalUpstream({ upstream: 'https://open.bigmodel.cn/api/paas/v4' }), false);
  assert.equal(isLocalUpstream({}), false);
  assert.equal(isLocalUpstream(null), false);
  assert.equal(isLocalUpstream({ upstream: 'not a url' }), false);
});

test('the local-upstream row is drawn last, not in the middle', () => {
  const { tui } = makeTUI([oauth('claude-a'), oauth('codex', LOCAL), oauth('claude-b')]);
  assert.deepEqual(drawOrder(tui), [0, 2, 1]);
});

test('accounts added after it still sort above it', () => {
  // The case config order cannot fix by hand: the new account is appended last.
  const { tui } = makeTUI([oauth('claude-a'), oauth('codex', LOCAL), oauth('claude-b'), oauth('claude-c')]);
  assert.deepEqual(drawOrder(tui), [0, 2, 3, 1]);
});

test('a fleet with no local upstream keeps its list order untouched', () => {
  const { tui } = makeTUI([oauth('a'), oauth('b'), oauth('c')]);
  assert.deepEqual(drawOrder(tui), [0, 1, 2]);
});

test('selection walks the rows as drawn but stores a manager index', () => {
  const { tui, am } = makeTUI([oauth('claude-a'), oauth('codex', LOCAL), oauth('claude-b')]);
  tui.mode = 'select';
  tui.selAction = 'switch';
  tui.selIdx = 0;

  // Down from the first row lands on the SECOND ROW DRAWN (claude-b, index 2),
  // skipping the local account that now sits below it.
  tui._key('down');
  assert.equal(tui.selIdx, 2);
  assert.equal(am.accounts[tui.selIdx].name, 'claude-b');

  tui._key('down');
  assert.equal(tui.selIdx, 1);
  assert.equal(am.accounts[tui.selIdx].name, 'codex'); // last row

  tui._key('down'); // already at the bottom
  assert.equal(tui.selIdx, 1);

  tui._key('up');
  assert.equal(am.accounts[tui.selIdx].name, 'claude-b');
  tui._key('up');
  assert.equal(am.accounts[tui.selIdx].name, 'claude-a');
  tui._key('up'); // already at the top
  assert.equal(tui.selIdx, 0);
});
