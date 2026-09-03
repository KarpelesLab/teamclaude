import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// ---------------------------------------------------------------------------
// The rollover through the SERVER, not the manager
// ---------------------------------------------------------------------------
//
// A manager-level fixture chooses an interleaving; these choose none. The server
// pins a request before its token is refreshed, awaits the refresh and the fetch
// with other requests selected inside them, and re-enters selection recursively
// on failure. Which account served is read off the credential the proxy injected.

const H = 3600_000;
const WEEK = 7 * 24 * H;
const OPUS = 'claude-opus-5';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function deferred() {
  let resolve;
  return { promise: new Promise(r => { resolve = r; }), resolve: (...a) => resolve(...a) };
}

// A live proxy in front of a live upstream. `handler(name, res)` decides what
// upstream does to the request carrying `name`'s credential and may await for
// as long as it likes — that suspension is the one other requests run inside.
async function fleet(names, handler, { distribute = false, hours = null, refreshFn = null } = {}) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    const name = String(req.headers['authorization'] || '').replace(/^Bearer t-/, '');
    Promise.resolve(handler(name, res)).catch(() => { try { res.destroy(); } catch { /* gone */ } });
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    names.map(n => ({ name: n, type: 'oauth', accessToken: 't-' + n, refreshToken: 'r-' + n, expiresAt: Date.now() + H })),
    0.98,
    { distributeSessions: distribute, expiryRouting: { enabled: true, preempt: true }, ...(refreshFn ? { refreshFn } : {}) },
  );
  names.forEach((_, i) => {
    am.accounts[i].quota.unified5h = 0.1;
    am.accounts[i].quota.unified7d = 0.4;
    am.accounts[i].quota.unified7dReset = Date.now() + (hours ? hours[i] : 10 + i * 10) * H;
    am.accounts[i].probing = false;
  });
  // What index.js does before the listener accepts anything, and what gives the
  // sticky walk a reading to measure against.
  am.selectActiveAccount();

  const proxy = createProxyServer(am, { upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);

  // The name the upstream answered with — i.e. the account that actually served
  // the client, after every failover the server performed on the way.
  const send = (session = null) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { 'x-claude-code-session-id': session } : {}) },
    body: JSON.stringify({ model: OPUS, messages: [] }),
  }).then(async r => (await r.json()).account);

  return {
    am, send,
    // Sockets first, then the listeners. `fetch` keeps its connections alive, so
    // both servers still hold established sockets when a test ends and
    // `close()` alone waits for them forever — the file's tests all pass and the
    // run never finishes, because a leaked handle keeps the child's event loop
    // alive rather than failing anything.
    close: () => new Promise(done => {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      proxy.close(() => upstream.close(done));
    }),
  };
}

const serves = (res, name) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ account: name }));
};

// Upstream refusing THIS account for THIS request. server.js:1625 adds it to
// the request's tried set and fails over, and — unlike a quota or transport
// verdict — leaves the account healthy for every later request, which is what
// lets these tests ask where the NEXT request goes.
// The two upstream verdicts that make the server retry WITHOUT adding the
// account to the request's tried set, so selection is free to hand the same
// account straight back. `seen` records that the path was actually taken —
// an arm covering a branch has to prove it reached it.
const SAME_ACCOUNT_RETRIES = [
  {
    name: 'a rate-limit 429',
    options: () => ({}),
    reject(seen, res) {
      seen.push('429');
      // No `anthropic-ratelimit-*-status: rejected`, so this is the transient
      // throttle rather than a quota rejection: the server pauses the account,
      // absorbs the wait inline and retries it, never rotating.
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
    },
    assertReached(seen) {
      assert.deepEqual(seen, ['429'], 'the fixture must have throttled b exactly once');
    },
  },
  {
    name: 'a 401',
    // A refresh that succeeds and mints the same access token, so the retry is
    // still identifiable upstream as the same account. Without it the forced
    // refresh fails, the account is errored, and the retry rotates — a
    // different path from the one being covered.
    options: seen => ({
      refreshFn: async rt => {
        seen.push('refresh:' + rt);
        return { accessToken: 't-' + rt.slice(2), refreshToken: rt, expiresAt: Date.now() + H };
      },
    }),
    reject(seen, res) {
      seen.push('401');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
    },
    assertReached(seen) {
      // The forced refresh is what makes this the :1654 path rather than an
      // ordinary failover, so assert it happened, once, and on b.
      assert.deepEqual(seen, ['401', 'refresh:r-b'],
        'the 401 did not force exactly one refresh of b');
    },
  },
];

const refuses = res => {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'no' } }));
};

for (const distribute of [false, true]) {
  const path = distribute ? 'session' : 'current';
  // distributeSessions is off by default, so the current-account walk is what an
  // operator who turns expiry routing on alone actually runs.
  const sid = distribute ? 's1' : null;

  test(`${path} path: a request selected inside the preemption's suspension cannot spend its rollover`, async () => {
    const reached = deferred();
    const held = deferred();
    let refusals = 0;

    const { am, send, close } = await fleet(['a', 'b'], async (name, res) => {
      if (name === 'b' && refusals === 0) {
        refusals++;
        reached.resolve();
        await held.promise;
        return refuses(res);
      }
      return serves(res, name);
    }, { distribute });

    try {
      assert.equal(await send(sid), 'a', 'the fixture must start on a');
      am.accounts[0].quota.unified7dReset += WEEK;

      // The preempted request. It is pinned to b and then suspends on the fetch,
      // which is where server.js leaves it while other requests are selected.
      const preempted = send(sid);
      await reached.promise;

      // A second request, selected and served entirely inside that suspension.
      // It finds itself on b and settles there — it did nothing wrong, and it
      // must not be able to spend a rollover another request is still owed.
      assert.equal(await send(sid), 'b', 'the sibling should have been served by b');

      held.resolve();
      assert.equal(await preempted, 'a', 'the refused request should have fallen back onto a');

      // a's window still owes its rollover: the request that went to b came
      // back, and the sibling that settled on b was never on a to answer for it.
      assert.equal(await send(sid), 'b',
        'the rollover was spent by a request that did not carry it');
    } finally {
      await close();
    }
  });

  test(`${path} path: a retry chain through two destinations still owes its rollover`, async () => {
    // A request that fails through two accounts names a third that neither the
    // origin nor the first destination describes, and the chain is the server's
    // own recursion.
    const refused = new Set();

    const { am, send, close } = await fleet(['a', 'b', 'c'], async (name, res) => {
      if (name !== 'a' && !refused.has(name)) {
        refused.add(name);
        return refuses(res);
      }
      return serves(res, name);
    }, { distribute });

    try {
      assert.equal(await send(sid), 'a', 'the fixture must start on a');
      am.accounts[0].quota.unified7dReset += WEEK;

      assert.equal(await send(sid), 'a', 'the chain should end back on the rolled account');
      assert.equal(refused.size, 2, 'both destinations should have been tried');

      assert.notEqual(await send(sid), 'a',
        'the chain erased the rollover the preemption that started it was owed');
    } finally {
      await close();
    }
  });

  // THE RETRIES THAT DO NOT MOVE THE REQUEST. Everything above fails over and so
  // adds the account to the request's tried set; these two hand the SAME account
  // back — the short-wait 429 at server.js:1596 and the 401 forced-refresh at
  // :1654 — and neither touches that set.
  for (const retry of SAME_ACCOUNT_RETRIES) {
    // Nothing changes underneath the request, so the retry must be invisible:
    // it neither leaves anything owed that should not be (the request after it
    // stays put rather than bouncing back to the rolled account) nor loses what
    // should have been recorded (rolling the destination then moves traffic off
    // it). Two questions from opposite sides, which together pin the state.
    test(`${path} path: ${retry.name} retried on the same account moves no rollover state`, async () => {
      const seen = [];
      const { am, send, close } = await fleet(['a', 'b'], async (name, res) => {
        if (name === 'b' && seen.length === 0) return retry.reject(seen, res);
        return serves(res, name);
      }, { distribute, ...retry.options(seen) });

      try {
        assert.equal(await send(sid), 'a', 'the fixture must start on a');
        am.accounts[0].quota.unified7dReset += WEEK;

        assert.equal(await send(sid), 'b', 'the retried request should have been served by b');
        retry.assertReached(seen);

        // The rollover was resolved by moving, so nothing is owed on a any more.
        assert.equal(await send(sid), 'b',
          'the request after the retry bounced back to the rolled account');

        // And b was measured, so b's own roll is still seen.
        am.accounts[1].quota.unified7dReset += WEEK;
        assert.notEqual(await send(sid), 'b', 'the same-account retry left b with no reading');
      } finally {
        await close();
      }
    });

    // The same path with the destination rolling WHILE the request to it is in
    // flight. The arm above cannot fail on its own — nothing moves underneath
    // it, so every reading of the destination is the same number and any way of
    // arriving at one passes. Rolling the window in between makes the retry's
    // selection answerable: it re-prices the destination against what was
    // recorded when the preemption sent the request there, so the week gained
    // under the request is a rollover and the retry leaves rather than settling
    // on the freshest account in the fleet. Removing the write that records the
    // destination at the preemption turns both of these red.
    test(`${path} path: ${retry.name} sees a destination that rolled while in flight`, async () => {
      const seen = [];
      let am;
      const fleetHandle = await fleet(['a', 'b'], async (name, res) => {
        if (name === 'b' && seen.length === 0) {
          // The window gains a week between the aim and the retry's selection.
          am.accounts[1].quota.unified7dReset += WEEK;
          return retry.reject(seen, res);
        }
        return serves(res, name);
      }, { distribute, ...retry.options(seen) });
      ({ am } = fleetHandle);
      const { send, close } = fleetHandle;

      try {
        assert.equal(await send(sid), 'a', 'the fixture must start on a');
        am.accounts[0].quota.unified7dReset += WEEK;

        // b rolled under the request. Measured against what was recorded when
        // the preemption sent the request there, that is a rollover, so the
        // retry leaves b. Measured against b as it stands at the retry it is
        // nothing at all, and the request parks on the week b just gained.
        assert.notEqual(await send(sid), 'b',
          'the retry priced b on what it reads now instead of what was recorded when it was sent there');
        retry.assertReached(seen);
      } finally {
        await close();
      }
    });
  }
}
