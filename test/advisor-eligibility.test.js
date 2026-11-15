import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { AccountManager, advisorEligibilityMode } from '../src/account-manager.js';
import { spawnServer, closedPort } from '../test-helpers/spawn-server.js';

// Issue #479. Claude Code declares the advisor tool on EVERY request, so the
// advisor's eligibility is paid by all of a client's traffic. With exactly one
// account routed for the advisor's family, strict filtering (#98) confines the
// whole fleet's traffic to it — and said nothing, because the only diagnostic
// fired at zero eligible accounts. These cover the line that now says so, and
// the `advisorEligibility: "prefer"` mode that routes such a request on its own
// model instead.

const OPUS = 'claude-opus-4-8';
const FABLE = 'claude-fable-5-1';

// The issue's repro: the advisor's family is routed to one account, everything
// else to the whole pool.
const ROUTES = [{ name: 'fable', match: ['claude-fable-*'], accounts: ['b'] }];

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function fleet(opts = {}) {
  return new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, { routes: ROUTES, ...opts });
}

// Everything logged while `fn` runs, console.warn included.
function capture(fn) {
  const lines = [];
  const { log, warn } = console;
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.warn = (...args) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines;
}

const narrowingLines = lines => lines.filter(l => /Advisor model/.test(l));

function spendFable(account) {
  account.quota.unified7dFable = 0.999;
  account.quota.unified7dFableReset = Date.now() + 3600_000;
}

test('advisorEligibilityMode accepts the two modes and falls back to strict', () => {
  assert.equal(advisorEligibilityMode(undefined), 'strict');
  assert.equal(advisorEligibilityMode(null), 'strict');
  assert.equal(advisorEligibilityMode('strict'), 'strict');
  assert.equal(advisorEligibilityMode('prefer'), 'prefer');
  assert.equal(advisorEligibilityMode(' Prefer '), 'prefer');
  const lines = capture(() => {
    assert.equal(advisorEligibilityMode('preferred-zz'), 'strict');
    assert.equal(advisorEligibilityMode('preferred-zz'), 'strict');
    assert.equal(advisorEligibilityMode(true), 'strict');
  });
  // Said once per value, not once per reload.
  assert.equal(lines.filter(l => l.includes('preferred-zz')).length, 1);
  assert.match(lines[0], /advisorEligibility: unrecognised value "preferred-zz", using "strict"/);
});

test('strict mode still pins an advisor request to the advisor-eligible account', () => {
  const am = fleet();
  assert.equal(am.advisorEligibility, 'strict');
  capture(() => {
    for (let i = 0; i < 5; i++) assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'b');
  });
  // A request that declares no advisor is untouched by any of this.
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
});

test('the narrowing is logged once per throttle window', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const am = fleet();
  let lines = narrowingLines(capture(() => {
    for (let i = 0; i < 10; i++) am.getActiveAccount(null, OPUS, FABLE);
  }));
  assert.deepEqual(lines, [
    `[TeamClaude] Advisor model "${FABLE}" narrows selection to 1 of 3 accounts — set advisorEligibility to "prefer" to route by request model instead`,
  ]);

  t.mock.timers.tick(59_000);
  lines = narrowingLines(capture(() => { am.getActiveAccount(null, OPUS, FABLE); }));
  assert.equal(lines.length, 0, 'still inside the window');

  t.mock.timers.tick(1_000);
  lines = narrowingLines(capture(() => {
    am.getActiveAccount(null, OPUS, FABLE);
    am.getActiveAccount(null, OPUS, FABLE);
  }));
  assert.equal(lines.length, 1, 'the next window says it again, once');
});

test('nothing is logged when every candidate can serve the advisor', () => {
  // No route: all three accounts serve Fable, so the advisor narrows nothing.
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  const lines = capture(() => {
    assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'a');
    assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
  });
  assert.deepEqual(narrowingLines(lines), []);
  assert.equal(am.getStatus().advisorNarrowing, null);
});

test('the counts leave out accounts that cannot serve the request itself', () => {
  const am = fleet();
  am.accounts[2].disabled = true;
  const lines = narrowingLines(capture(() => { am.getActiveAccount(null, OPUS, FABLE); }));
  assert.match(lines[0], /narrows selection to 1 of 2 accounts/);
});

test('the advisor model name is stripped before it reaches the log', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'fable', match: ['claude-fable-*'], accounts: ['b'] }],
  });
  const lines = narrowingLines(capture(() => {
    am.getActiveAccount(null, OPUS, 'claude-fable-5\x1b[2J\x07 forged');
  }));
  assert.equal(lines.length, 1);
  assert.ok(!/[\x00-\x1f]/.test(lines[0]), JSON.stringify(lines[0]));
});

test('the narrowing is logged on the session-distribution paths too', () => {
  // Tagged: _selectForSession answers, and the _select walk is never reached.
  let am = fleet({ distributeSessions: true });
  let lines = narrowingLines(capture(() => {
    assert.equal(am.getActiveAccount(null, OPUS, FABLE, 'session-1').name, 'b');
  }));
  assert.equal(lines.length, 1);

  // Untagged: _selectUntagged answers.
  am = fleet({ distributeSessions: true });
  lines = narrowingLines(capture(() => {
    assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'b');
  }));
  assert.equal(lines.length, 1);
});

test('status reports the mode and the last narrowing', () => {
  const am = fleet();
  assert.equal(am.getStatus().advisorEligibility, 'strict');
  assert.equal(am.getStatus().advisorNarrowing, null);

  capture(() => { am.getActiveAccount(null, OPUS, FABLE); });
  const { advisorNarrowing } = am.getStatus();
  assert.equal(advisorNarrowing.model, FABLE);
  assert.equal(advisorNarrowing.eligible, 1);
  assert.equal(advisorNarrowing.of, 3);
  assert.equal(typeof advisorNarrowing.at, 'number');

  // Cleared by the first advisor request the fleet serves whole.
  am.setRoutes([]);
  capture(() => { am.getActiveAccount(null, OPUS, FABLE); });
  assert.equal(am.getStatus().advisorNarrowing, null);
});

test('prefer mode routes a narrowed advisor request like a plain one', () => {
  const am = fleet({ advisorEligibility: 'prefer' });
  assert.equal(am.getStatus().advisorEligibility, 'prefer');
  const lines = capture(() => {
    // The current account serves it, exactly as it serves a plain Opus request…
    assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'a');
    assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
    // …and a request that has tried `a` moves on in fleet order, not to `b`
    // because it is the advisor's account.
    assert.equal(am.getActiveAccount(new Set([0, 1]), OPUS, FABLE).name, 'c');
  });
  assert.deepEqual(narrowingLines(lines), [
    `[TeamClaude] Advisor model "${FABLE}" is served by 1 of 3 accounts — advisorEligibility is "prefer", routing by request model only`,
  ]);
  // What would have been narrowed is still reported.
  assert.equal(am.getStatus().advisorNarrowing.eligible, 1);
});

test('prefer mode spreads sessions across every account that can serve the request', () => {
  const spread = (advisorEligibility) => {
    const am = fleet({ distributeSessions: true, advisorEligibility });
    const used = new Set();
    capture(() => {
      for (let i = 0; i < 6; i++) {
        const account = am.getActiveAccount(null, OPUS, FABLE, `session-${i}`);
        am.recordSession(`session-${i}`, account.index, OPUS);
        used.add(account.name);
      }
    });
    return [...used].sort();
  };
  assert.deepEqual(spread('strict'), ['b']);
  assert.deepEqual(spread('prefer'), ['a', 'b', 'c']);
});

test('prefer mode spreads untagged requests too', () => {
  const am = fleet({ distributeSessions: true, advisorEligibility: 'prefer' });
  const used = new Set();
  capture(() => {
    for (let i = 0; i < 6; i++) used.add(am.getActiveAccount(null, OPUS, FABLE).name);
  });
  assert.deepEqual([...used].sort(), ['a', 'b', 'c']);
});

test('prefer mode keeps the advisor model where it narrows nothing', () => {
  // No route, so both accounts serve Fable and the advisor leaves nobody out.
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { advisorEligibility: 'prefer' });
  const lines = capture(() => {
    // The advisor's route pin still applies, as it does in strict.
    am.setRoutePin('fable', 1);
    assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'b');
  });
  assert.deepEqual(narrowingLines(lines), []);
});

test('a failover hop reads the advisor model the way selection did', () => {
  const strict = fleet();
  const prefer = fleet({ advisorEligibility: 'prefer' });
  capture(() => {
    // Off `a`: strict may only hop to the advisor's account. Prefer takes what
    // can serve the request, the advisor's account gone or not.
    assert.equal(strict.pickAlternate(new Set([0]), OPUS, FABLE).name, 'b');
    assert.equal(strict.pickAlternate(new Set([0, 1]), OPUS, FABLE), null);
    assert.equal(prefer.pickAlternate(new Set([0, 1]), OPUS, FABLE).name, 'c');
  });
});

test('no eligible account still degrades to the request model, in both modes', () => {
  for (const advisorEligibility of ['strict', 'prefer']) {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { advisorEligibility });
    for (const account of am.accounts) spendFable(account);
    const lines = capture(() => {
      assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'a');
    });
    assert.deepEqual(narrowingLines(lines), [], advisorEligibility);
    assert.deepEqual(lines.filter(l => /No account eligible for advisor model/.test(l)), [
      `[TeamClaude] No account eligible for advisor model "${FABLE}" — routing by request model only`,
    ], advisorEligibility);
  }
});

test('the degrade line does not claim a route when the request model finds no account either', () => {
  for (const advisorEligibility of ['strict', 'prefer']) {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { advisorEligibility });
    for (const account of am.accounts) {
      spendFable(account);
      account.status = 'throttled';
      account.rateLimitedUntil = Date.now() + 3600_000;
    }
    let picked;
    const lines = capture(() => { picked = am.getActiveAccount(new Set([0, 1]), OPUS, FABLE); });
    assert.equal(picked, null, advisorEligibility);
    assert.deepEqual(lines.filter(l => /No account eligible for advisor model/.test(l)), [
      `[TeamClaude] No account eligible for advisor model "${FABLE}" — and no account is available for the request model either, so no account was selected`,
    ], advisorEligibility);
  }
});

test('setAdvisorEligibility switches a running manager both ways', () => {
  const am = fleet();
  capture(() => {
    assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'b');
    am.setAdvisorEligibility('prefer');
    assert.equal(am.getActiveAccount(new Set([1]), OPUS, FABLE).name, 'a');
    // Removed from the config: strict again.
    am.setAdvisorEligibility(undefined);
    assert.equal(am.advisorEligibility, 'strict');
    assert.equal(am.getActiveAccount(null, OPUS, FABLE).name, 'b');
  });
});

// --- Live reload, against the real server ------------------------------------

async function statusOf(port) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
  assert.equal(res.status, 200);
  return res.json();
}

async function reloadWith(port, configPath, mutate) {
  const edited = JSON.parse(await readFile(configPath, 'utf8'));
  mutate(edited);
  await writeFile(configPath, JSON.stringify(edited));
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
  const text = await res.text();
  assert.equal(res.status, 200, text);
}

test('reload hot-applies an advisorEligibility edit', async () => {
  // Nothing here sends a request upstream; a closed port makes sure of it.
  const deadPort = await closedPort();
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${deadPort}`,
      upstreamProxy: false,
      advisorEligibility: 'prefer',
      accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
    }),
  });
  const { port, configPath } = server;
  try {
    assert.equal((await statusOf(port)).advisorEligibility, 'prefer', 'read at startup');

    await reloadWith(port, configPath, c => { c.advisorEligibility = 'strict'; });
    assert.equal((await statusOf(port)).advisorEligibility, 'strict');

    await reloadWith(port, configPath, c => { c.advisorEligibility = 'prefer'; });
    assert.equal((await statusOf(port)).advisorEligibility, 'prefer');

    // Removed from disk: the default, not the last value held in memory.
    await reloadWith(port, configPath, c => { delete c.advisorEligibility; });
    assert.equal((await statusOf(port)).advisorEligibility, 'strict');
  } finally {
    await server.stop();
  }
});
