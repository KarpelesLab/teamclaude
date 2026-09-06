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

// A one-shot signal with a DEADLINE, and the deadline is the point.
//
// These tests wait for the upstream to be reached before releasing it, and an
// unbounded wait turns "the request never got there" into a hung process rather
// than a failed assertion: the body never reaches its expectations, the
// `finally` never runs, the listeners stay open, and the whole file outlives the
// runner's own timeout. Rejecting inside the test body makes it an ordinary red.
function deferred(what, ms = 5000) {
  let resolve, reject, timer;
  const promise = new Promise((res, rej) => {
    resolve = v => { clearTimeout(timer); res(v); };
    reject = rej;
    timer = setTimeout(() => rej(new Error(`timed out after ${ms}ms waiting for: ${what}`)), ms);
    timer.unref?.();
  });
  // Nothing awaits the rejection until the body does, and an unobserved
  // rejection would take the process down before the assertion can report it.
  promise.catch(() => {});
  return { promise, resolve, reject };
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
  const send = (session = null, model = OPUS) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { 'x-claude-code-session-id': session } : {}) },
    body: JSON.stringify({ model, messages: [] }),
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

// Upstream refusing THIS account for THIS request. The server adds it to the
// request's tried set and fails over, and — unlike a quota or transport verdict
// — leaves the account healthy for every later request, which is what lets these
// tests ask where the NEXT request goes.
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
    const reached = deferred('the upstream to be reached');
    const held = deferred('the suspension to be released');
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
    // flight, and THIS IS WHERE THE AIM WINDOW SHOWS. The preemption AIMS at b
    // and takes no reading there, because the request may never arrive; the
    // reading is taken by the first request that finds the choice resting on b.
    // A roll landing inside that gap has never been read, so it is a first sight
    // and the retry stays. What is gated is the half that does hold: once a
    // request HAS rested on b, b's roll moves the traffic.
    test(`${path} path: ${retry.name} first-sights a roll that lands inside the aim window`, async () => {
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

        // Nothing read b before it rolled, so the retry has nothing to measure
        // the week it gained against and stays.
        assert.equal(await send(sid), 'b',
          'a roll nothing had read moved the traffic anyway');
        retry.assertReached(seen);

        // And the gap closes: this request rests on b and reads it, so b's NEXT
        // roll is caught.
        assert.equal(await send(sid), 'b');
        am.accounts[1].quota.unified7dReset += WEEK;
        assert.notEqual(await send(sid), 'b',
          'b was never read, so its roll after the aim window was missed too');
      } finally {
        await close();
      }
    });
  }

  // A CHAIN THAT RETURNS TO A DESTINATION IT ROLLED UNDER. The request is pushed
  // off a, sent to b, b rolls under it and throttles, it is pushed off b to c, c
  // refuses it, and the only account left is b. Nothing rides the request and
  // nothing had read b before it rolled, so the return to b is a first sight.
  // What is gated is that the chain still answers the roll it STARTED with: a is
  // not where it ends up, and b's own later roll is caught once b has been
  // rested on.
  test(`${path} path: a chain answers the roll that started it`, async () => {
    const seen = [];
    let am;
    const handle = await fleet(['a', 'b', 'c'], async (name, res) => {
      if (name === 'b' && !seen.includes('b')) {
        seen.push('b');
        am.accounts[1].quota.unified7dReset = Date.now() + 400 * H;  // b rolls under the request
        res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
        return;
      }
      if (name === 'c' && !seen.includes('c')) {
        seen.push('c');
        return refuses(res);
      }
      return serves(res, name);
    }, { distribute, hours: [10, 20, 30] });
    ({ am } = handle);
    const { send, close } = handle;

    try {
      assert.equal(await send(sid), 'a', 'the fixture must start on a');
      am.accounts[0].quota.unified7dReset = Date.now() + 500 * H;

      assert.equal(await send(sid), 'b', 'the chain should have ended on b');
      // The roll landed inside the aim window and is a first sight, so the
      // throttle's retry stays on b: the chain is a -> b -> b, c never reached.
      assert.deepEqual(seen, ['b'], 'the chain must have gone a -> b -> b');

      // The roll that started the chain is answered: the traffic left a and did
      // not drift back to it.
      assert.notEqual(await send(sid), 'a',
        'the chain settled back onto the account its rollover pushed it off');
      // And b, now that a request has rested on it, is measured from here on.
      am.accounts[1].quota.unified7dReset += WEEK;
      assert.notEqual(await send(sid), 'b', 'b was never read once the chain settled there');
    } finally {
      await close();
    }
  });
}

// ---------------------------------------------------------------------------
// What an excursion off an account may do to the reading it leaves behind
// ---------------------------------------------------------------------------

const HAIKU = 'claude-haiku-4-5';

test('a fail-back onto a rolled SCOPED window still finds the roll owed', async () => {
  // Two families on one account, and the roll is on the window only ONE of them
  // is governed by. The Opus request is pushed off a by a roll of a's scoped Opus
  // window and suspends on b; while it hangs there a's shared weekly rolls too
  // and a Haiku request, governed by that shared window, is routed to a. Then b
  // refuses and it falls back to a. Nothing in that excursion may spend a's roll:
  // the comparison is over every window the reading holds, so which family rolled
  // cannot decide whether the aim may discard it.
  const reached = deferred('the upstream to be reached');
  const held = deferred('the suspension to be released');
  let refused = 0;
  let am;

  const handle = await fleet(['a', 'b', 'c'], async (name, res) => {
    if (name === 'b' && refused === 0) {
      refused++;
      reached.resolve();
      await held.promise;
      return refuses(res);
    }
    return serves(res, name);
  }, { hours: [10, 20, 30] });
  ({ am } = handle);
  const { send, close } = handle;

  try {
    // a is current and carries a scoped Opus window alongside the shared weekly.
    // Spent further than the shared one so it is the window that BINDS for Opus
    // — the governing read takes the tighter of the two, and a scoped window
    // that does not bind is not the window an Opus roll would be measured on.
    am.accounts[0].quota.scopedWeekly = { opus: { utilization: 0.9, resetAt: Date.now() + 15 * H } };
    assert.equal(am.setCurrentAccount(0), true);
    assert.equal(await send(null, HAIKU), 'a', 'the fixture must start Haiku on a');
    assert.equal(am._governingWindow(am.accounts[0], OPUS).window, 'scoped:opus',
      'the fixture must have the scoped window governing Opus on a');
    const readOnA = new Map(am._currentObs.windows);

    // The Opus window rolls; the Opus request is pushed off a and hangs on b.
    am.accounts[0].quota.scopedWeekly.opus.resetAt += WEEK;
    const opus = send(null, OPUS).catch(() => null);
    await reached.promise;

    // b holds the cursor and c is the only other candidate, so take both out of
    // Haiku's reach — the sibling has to reach a for this to be about a's
    // windows at all.
    am.accounts[1].quota.unified7d = 0.99;
    am.accounts[2].quota.unified7d = 0.99;
    // a's SHARED window rolls too, and a Haiku request — governed by that window
    // — is routed back to a while the Opus request is still suspended on b. A
    // different window, a different request, and neither of them evidence that
    // the traffic came to rest anywhere.
    am.accounts[0].quota.unified7dReset += WEEK;
    assert.equal(await send(null, HAIKU), 'a', 'the sibling must have reached a');

    held.resolve();
    await opus;

    // THE ROLL IS STILL OWED: the reading is the one taken on a before either
    // window moved, so the next Opus request moves off a rather than settling
    // onto the week it just gained.
    assert.equal(am._currentObs.idx, 0, 'the reading no longer describes a');
    assert.deepEqual(am._currentObs.windows, readOnA,
      'the excursion rewrote the reading taken on a');
    assert.equal(am._currentRolledOver(am.accounts[0], OPUS), true,
      'the aim at b spent the scoped Opus rollover');
  } finally {
    held.resolve();
    await close();
  }
});

// ---------------------------------------------------------------------------
// The paths that move the cursor without routing a request
// ---------------------------------------------------------------------------

test('the exhausted-fleet probe prices the account it makes current', async () => {
  // Every account over threshold, so selection falls through to the probe. It
  // moves the cursor without taking a reading, so until a request rests on the
  // probed account its first roll is first-sighted and the traffic parks on the
  // week it gained.
  const { am, send, close } = await fleet(['a', 'b'], async (name, res) => serves(res, name),
    { hours: [10, 20] });

  try {
    assert.equal(await send(), 'a', 'the fixture must start on a');
    // Both accounts over the switch threshold: nothing is selectable and the
    // probe is the only thing that answers. b is the less spent of the two, so
    // the probe picks it — the cursor has to MOVE for this to be about the move.
    am.accounts[0].quota.unified7d = 0.99;
    am.accounts[1].quota.unified7d = 0.985;
    const probed = await send();
    assert.equal(probed, 'b', 'the probe should have moved the cursor to b');

    // The probe learned real quota, and later that account's window rolls.
    am.accounts[am.currentIndex].quota.unified7d = 0.4;
    am.accounts[1 - am.currentIndex].quota.unified7d = 0.4;
    am.accounts[am.currentIndex].quota.unified7dReset += WEEK;

    assert.notEqual(await send(), probed,
      'the probe moved the cursor without pricing it, so the roll was first-sighted');
  } finally {
    await close();
  }
});

test('a roll that happens while the knob is OFF is not owed when it comes on', async () => {
  // Off means there is no state at all: the readings are dropped when preemption
  // stops, none is written while it is off, and the transition back on takes a
  // fresh first sight. The cost is the one roll nobody was watching for; the
  // gain is that "off is inert" is a lifetime rather than a rule every reader
  // has to remember.
  const { am, send, close } = await fleet(['a', 'b'], async (name, res) => serves(res, name),
    { hours: [10, 20] });

  try {
    am.setExpiryRouting({ enabled: false });
    assert.equal(await send(), 'a', 'the fixture must start on a');
    am.accounts[0].quota.unified7dReset += WEEK;
    // Traffic keeps flowing across the roll with the feature off.
    assert.equal(await send(), 'a');
    assert.equal(await send(), 'a');

    am.setExpiryRouting({ enabled: true, preempt: true });
    assert.equal(await send(), 'a',
      'a roll nothing was watching for moved the traffic when the knob came on');

    // And the first roll AFTER the knob came on IS caught, so the transition is
    // a reset rather than a silencing.
    am.accounts[0].quota.unified7dReset += WEEK;
    assert.notEqual(await send(), 'a',
      'the first roll after the knob came on was missed');
  } finally {
    await close();
  }
});
