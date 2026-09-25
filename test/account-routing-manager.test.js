import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

// The account side of per-account routing: how accounts[].routing is parsed
// onto the running account, masked for status, threaded into a token refresh,
// and kept in step on a config reload. The proxy protocol itself is covered
// in account-routing.test.js; the live reload of a forwarding path is in
// reload-account-routing.test.js.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r-' + name, expiresAt: Date.now() + 3600_000, ...extra };
}

// Runs `fn` with console.log captured, and returns the lines it printed.
async function logged(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines;
}

test('a valid routing URL is parsed onto the account', () => {
  const am = new AccountManager([oauth('a', { routing: 'socks5h://alice:s3cret@proxy.example.com:1080' })], 0.98);
  assert.deepEqual(am.accounts[0].routing, {
    protocol: 'socks5h', host: 'proxy.example.com', port: 1080, username: 'alice', password: 's3cret',
  });
});

test('an invalid routing URL is ignored with one named log line, never thrown', async () => {
  let am = null;
  const lines = await logged(() => { am = new AccountManager([oauth('a', { routing: 'https://proxy.example.com' })], 0.98); });
  assert.equal(am.accounts[0].routing, null);
  assert.equal(lines.filter(l => l.includes('ignoring routing') && l.includes('"a"')).length, 1);
});

test('a routing that names this server\'s own listener is ignored, with the reason', async () => {
  // The MITM listener intercepts the upstream host, so a request tunnelled
  // through it would come straight back in and go around again.
  const listener = { host: '127.0.0.1', port: 3456 };
  let am = null;
  const lines = await logged(() => {
    am = new AccountManager([
      oauth('a', { routing: 'http://localhost:3456' }),
      oauth('b', { routing: 'socks5://127.0.0.1:1080' }),
    ], 0.98, { listener });
  });
  assert.equal(am.accounts[0].routing, null);
  assert.equal(am.accounts[1].routing.port, 1080, 'another port on loopback is some other proxy');
  assert.equal(lines.filter(l => l.includes('"a"') && l.includes('ignoring routing') && l.includes('that address is this server')).length, 1, lines.join('\n'));

  // The guard follows the manager to accounts added at runtime.
  await logged(() => am.addAccount(oauth('c', { routing: 'http://127.0.0.1:3456' })));
  assert.equal(am.accounts[2].routing, null);

  // A manager built without a config has no address to compare against and
  // second-guesses nothing (the tests build most of theirs this way).
  const bare = new AccountManager([oauth('a', { routing: 'http://localhost:3456' })], 0.98);
  assert.equal(bare.accounts[0].routing.port, 3456);
});

test('reload drops a routing edit that points back at the server\'s own port', async () => {
  const mem = [oauth('a')];
  const am = new AccountManager(mem.map(a => ({ ...a })), 0.98);
  const disk = [{ ...mem[0], routing: 'socks5://localhost:3456' }];
  const lines = await logged(() => syncAccountsFromDisk({ accounts: disk }, { proxy: { port: 3456 }, accounts: mem }, am));
  assert.equal(am.accounts[0].routing, null, 'the running account stays on the fleet path');
  assert.ok(lines.some(l => l.includes('"a"') && l.includes('that address is this server')), lines.join('\n'));
});

test('an account without routing has null, and the status payload masks the password', () => {
  const am = new AccountManager([
    oauth('a'),
    oauth('b', { routing: 'socks5h://alice:s3cret@proxy.example.com:1080' }),
  ], 0.98);
  assert.equal(am.accounts[0].routing, null);

  const status = am.getStatus();
  assert.equal(status.accounts[0].routing, null);
  assert.equal(status.accounts[1].routing, 'socks5h://alice:***@proxy.example.com:1080');
  assert.equal(JSON.stringify(status).includes('s3cret'), false, 'the password never crosses the status boundary');
});

test('a token refresh goes by the account\'s own routing', async () => {
  const calls = [];
  const refreshFn = async (...args) => {
    calls.push(args);
    return { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: Date.now() + 3600_000 };
  };
  const am = new AccountManager([
    oauth('a'),
    oauth('b', { routing: 'socks5://proxy.example.com:1080' }),
  ], 0.98, { refreshFn });
  // Expire both tokens so the refresh actually runs.
  am.accounts[0].expiresAt = Date.now() - 1000;
  am.accounts[1].expiresAt = Date.now() - 1000;

  await am.ensureTokenFresh(0);
  await am.ensureTokenFresh(1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'r-a');
  assert.equal(calls[0][2], null, 'the unrouted account goes by the fleet path');
  assert.equal(calls[1][0], 'r-b');
  assert.deepEqual(calls[1][2], { protocol: 'socks5', host: 'proxy.example.com', port: 1080, username: null, password: null });
});

test('reload picks up a routing edit, and its removal', async () => {
  const mem = [oauth('a'), oauth('b')];
  const am = new AccountManager(mem.map(a => ({ ...a })), 0.98);
  const disk = mem.map(a => ({ ...a }));
  disk[1].routing = 'socks5h://proxy.example.com:1080';

  await syncAccountsFromDisk({ accounts: disk }, { accounts: mem }, am);
  assert.equal(am.accounts[1].routing.protocol, 'socks5h', 'the running account tunnels on the next request');
  assert.equal(mem[1].routing, 'socks5h://proxy.example.com:1080', 'the edit is mirrored onto the config entry');

  delete disk[1].routing;
  await syncAccountsFromDisk({ accounts: disk }, { accounts: mem }, am);
  assert.equal(am.accounts[1].routing, null, 'removal reverts to the fleet path without a restart');
  assert.equal('routing' in mem[1], false, 'the key is deleted, not left behind or set to null');
});
