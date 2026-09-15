import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

// ► read the single `currentIndex`, so a mixed pool marked only the provider that
// moved last. Each pool's current account is marked now, locally and in attach mode.

const HOUR = 3600_000;
const claude = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const codex = (name) => ({ name, type: 'oauth', provider: 'codex', accountId: `acct-${name}`, accessToken: `c-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });
const apikey = (name) => ({ name, type: 'apikey', apiKey: `k-${name}` });

const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/** The names the dashboard marks with ►, drawn from a full render at 120 columns. */
function markedNames(am, { remote = false } = {}) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
    ...(remote ? { remote: {} } : {}),
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let buf = '';
  try {
    tui._paint = (b) => { buf = b; };
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    else delete process.stdout.columns;
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
    else delete process.stdout.rows;
  }
  // The name right after the marker: a Claude row also draws ► before the F7 bar
  // of the account the Fable route targets, which is not this marker.
  return buf.replace(SGR, '').split('\r\n').map(l => l.match(/►\s+(\S+@\S+)/)?.[1]).filter(Boolean);
}

test('a mixed pool marks the current account of each provider', () => {
  const am = new AccountManager([claude('a@x.com'), claude('b@x.com'), codex('k1@x.com'), codex('k2@x.com')], 0.98);
  // An operator switch on each side; currentIndex ends on the Codex account.
  am.setCurrentAccount(1);
  am.setCurrentAccount(3);
  assert.deepEqual(markedNames(am).sort(), ['b@x.com', 'k2@x.com']);
});

test('a single-provider pool keeps its one marker', () => {
  const am = new AccountManager([claude('a@x.com'), claude('b@x.com')], 0.98);
  am.setCurrentAccount(1);
  assert.deepEqual(markedNames(am), ['b@x.com']);
});

test('a shared API-key account is marked when a pool\'s cursor names it', () => {
  // Codex subscriptions all out of rotation: the key, which serves either pool, is
  // where the next Codex request lands, and the status payload says so too.
  const am = new AccountManager([claude('a@x.com'), apikey('key@x.com'), codex('k1@x.com')], 0.98);
  am.accounts[2].disabled = true;
  const status = am.getStatus();
  assert.equal(am.currentIndexFor('codex'), 1);
  assert.equal(status.currentAccounts.codex, 'key@x.com');
  assert.ok(markedNames(am).includes('key@x.com'));
});

test('attach mode marks each pool from the per-provider cursors the server sends', () => {
  const rm = new RemoteAccountManager();
  const status = {
    // The same address on both sides: the lookup has to match the provider too.
    accounts: [
      { name: 'me@x.com', type: 'oauth', provider: 'anthropic', quota: {} },
      { name: 'other@x.com', type: 'oauth', provider: 'anthropic', quota: {} },
      { name: 'me@x.com', type: 'oauth', provider: 'codex', quota: {} },
    ],
    currentAccount: 'other@x.com',
    currentAccounts: { anthropic: 'other@x.com', codex: 'me@x.com' },
  };
  rm.applyStatus(status);
  assert.equal(rm.currentIndexFor('anthropic'), 1);
  assert.equal(rm.currentIndexFor('codex'), 2);
  assert.deepEqual(markedNames(rm, { remote: true }).sort(), ['me@x.com', 'other@x.com']);

  // A name the payload no longer lists marks nothing, as currentIndex does.
  rm.applyStatus({ ...status, currentAccounts: { anthropic: 'other@x.com', codex: 'gone@x.com' } });
  assert.equal(rm.currentIndexFor('codex'), null);

  // A server too old to send currentAccounts has one cursor, for its own pool only.
  rm.applyStatus({ ...status, currentAccounts: undefined });
  assert.equal(rm.currentIndexFor('anthropic'), 1);
  assert.equal(rm.currentIndexFor('codex'), null);
  assert.deepEqual(markedNames(rm, { remote: true }), ['other@x.com']);

  // Anything but an object is treated as absent.
  rm.applyStatus({ ...status, currentAccounts: ['me@x.com'] });
  assert.equal(rm.currentAccounts, null);
});

test('attach mode tells a shared API key from a Codex login with the same address', () => {
  // Same address as an API key and a Codex login; with the login disabled the key
  // is Codex's current account, and only its position tells the two rows apart.
  const am = new AccountManager([claude('a@x.com'), apikey('me@x.com'), codex('me@x.com')], 0.98);
  am.accounts[2].disabled = true;
  const status = JSON.parse(JSON.stringify(am.getStatus()));
  assert.equal(status.currentAccounts.codex, 'me@x.com');
  assert.equal(status.currentIndexes.codex, 1);
  const rm = new RemoteAccountManager();
  rm.applyStatus(status);
  assert.equal(rm.currentIndexFor('codex'), 1, 'the key, not the disabled login');
  // An index outside the list is dropped rather than trusted.
  rm.applyStatus({ ...status, currentIndexes: { codex: 99 } });
  assert.equal(rm.currentIndexFor('codex'), null);
});
