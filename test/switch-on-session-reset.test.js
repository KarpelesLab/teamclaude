import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { AccountManager } from '../src/account-manager.js';
import { spawnServer } from '../test-helpers/spawn-server.js';

// switchOnSessionReset: false keeps traffic on a healthy current account when
// another account's 5-hour window resets, instead of moving every conversation
// (and its prompt cache) onto it. The reset still returns that account to
// rotation; it is simply not a reason to leave the current one.

const HOUR = 3600_000;
const OPUS = 'claude-opus-5';
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

// A: 5h window just reset, weekly lapses soon. B: current, healthy, weekly
// resets much later. The same shape as session-reset-race.test.js. With
// `third`, C: healthy, its weekly resetting between the two.
function fleet(opts = {}, aSession = 0.99, third = false) {
  const am = new AccountManager([oauth('a'), oauth('b'), ...(third ? [oauth('c')] : [])], 0.98, opts);
  const [a, b, c] = am.accounts;
  a.quota.unified5h = aSession;
  a.quota.unified5hReset = Date.now() - 1000;
  a.quota.unified7d = 0.5;
  a.quota.unified7dReset = Date.now() + 6 * HOUR;
  b.quota.unified5h = 0.2;
  b.quota.unified5hReset = Date.now() + 4 * HOUR;
  b.quota.unified7d = 0.1;
  b.quota.unified7dReset = Date.now() + 58 * HOUR;
  if (c) {
    c.quota.unified5h = 0.2;
    c.quota.unified5hReset = Date.now() + 4 * HOUR;
    c.quota.unified7d = 0.1;
    c.quota.unified7dReset = Date.now() + 30 * HOUR;
  }
  am.currentIndex = 1;
  return am;
}

test('default: the reset still moves traffic to the sooner weekly', () => {
  const am = fleet();
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'a');
});

test('off: a healthy current account keeps the traffic', () => {
  const am = fleet({ switchOnSessionReset: false });
  for (let turn = 0; turn < 3; turn++) assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
});

test('off: an idle account whose barely used window resets does not pull traffic either', () => {
  // A keep-warm request leaves an idle account with a running window at ~1%;
  // its reset five hours later is the same event.
  const am = fleet({ switchOnSessionReset: false }, 0.01);
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
});

test('off: the reset account is back in rotation, and wins it on the sooner weekly', () => {
  // C's weekly resets later than A's, so rotation has a choice to make once B fills up:
  // with A alone there, any order would pick it.
  const am = fleet({ switchOnSessionReset: false }, 0.99, true);
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
  am.accounts[1].quota.unified7d = 0.99;
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'a');
});

test('off: only a literal false turns it off', () => {
  assert.equal(fleet({ switchOnSessionReset: 'false' }).switchOnSessionReset, true);
  assert.equal(fleet({ switchOnSessionReset: false }).switchOnSessionReset, false);
});

test('setter applies live', () => {
  const am = fleet();
  am.setSwitchOnSessionReset(false);
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
});

test('a reset seen while off is not replayed when it is turned back on', () => {
  const am = fleet({ switchOnSessionReset: false });
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
  am.setSwitchOnSessionReset(true);
  assert.equal(am.getActiveAccount(new Set(), OPUS).name, 'b');
});

// The setting as the server reads it: at startup (the AccountManager options)
// and on POST /teamclaude/reload. The real server against a stub upstream that
// answers each account with its own quota headers: b healthy, its weekly 58
// hours out; a with its weekly 6 hours out and, first, a spent 5-hour window,
// then one whose reset has already passed, so the next unpinned request finds
// a's reset. Requests pinned to `a` (a pin bypasses selection) are what bring
// its readings in. Every reload re-reads the setting, so the startup value is
// asserted before the first one.
test('the server applies switchOnSessionReset at startup and on reload', async t => {
  const seen = [];
  const at = ms => String(Math.floor(ms / 1000));
  const upstream = http.createServer((req, res) => {
    req.resume();
    const name = /t-(\w+)/.exec(req.headers.authorization || '')?.[1];
    if (req.url.endsWith('/v1/messages')) seen.push(name);
    const now = Date.now();
    const first = seen.filter(n => n === 'a').length === 1;
    const quota = name !== 'a'
      ? { u5: '0.2', r5: at(now + 4 * HOUR), u7: '0.1', r7: at(now + 58 * HOUR) }
      : first ? { u5: '0.99', r5: at(now + HOUR), u7: '0.5', r7: at(now + 6 * HOUR) }
        : { u5: '0.5', r5: at(now - 60_000), u7: '0.5', r7: at(now + 6 * HOUR) };
    res.writeHead(200, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': quota.u5,
      'anthropic-ratelimit-unified-5h-reset': quota.r5,
      'anthropic-ratelimit-unified-7d-utilization': quota.u7,
      'anthropic-ratelimit-unified-7d-reset': quota.r7,
    });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let running;
  try {
    running = await spawnServer({ config: () => ({
      proxy: { apiKey: 'test' }, upstream: `http://127.0.0.1:${upstream.address().port}`, upstreamProxy: false,
      quotaProbeSeconds: 0,
      switchOnSessionReset: false,
      accounts: [oauth('b'), oauth('a')],
    }) });
    const post = async path => {
      const res = await fetch(`http://127.0.0.1:${running.port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: OPUS, max_tokens: 1, messages: [] }),
        // A request or reload that never answers ends with the test, so the
        // `finally` still stops the server and closes the stub (test/README.md).
        signal: t.signal,
      });
      assert.equal(res.status, 200, await res.text());
    };
    await post('/tc-acct/a/v1/messages'); // a's 5-hour window is spent
    await post('/v1/messages'); // b's weekly is learned, so the next request re-ranks
    await post('/v1/messages'); // which, with a spent, keeps b
    await post('/tc-acct/a/v1/messages'); // a's 5-hour reset has passed
    await post('/v1/messages'); // read at startup: off, so b keeps the traffic
    const config = JSON.parse(await readFile(running.configPath, 'utf8'));
    delete config.switchOnSessionReset;
    await writeFile(running.configPath, JSON.stringify(config));
    await post('/teamclaude/reload');
    await post('/tc-acct/a/v1/messages');
    await post('/v1/messages'); // reloaded to the default: a's reset moves the traffic
    assert.deepEqual(seen, ['a', 'b', 'b', 'a', 'b', 'a', 'a'], running.output());
  } finally {
    await running?.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
