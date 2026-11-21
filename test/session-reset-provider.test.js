import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { DEFAULT_PROVIDER, canServeProvider, providerOf } from '../src/provider.js';

const H = 3600_000;
const DAY = 24 * H;
const CLAUDE = DEFAULT_PROVIDER;
const CODEX = 'codex';
const MODEL = { [CLAUDE]: 'claude-opus-4-1', [CODEX]: 'gpt-5' };

// Two Claude subscriptions and one Codex subscription. Every reset is set from a
// single clock read, so a window that has rolled over is one whose reset is
// already in the past, and an open window is a day or more away. Nothing here
// waits on the clock.
function fleet({ expiry = false } = {}) {
  const now = Date.now();
  const oauth = (name, extra = {}) => ({
    name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + H, ...extra,
  });
  const opts = { ramp: { enabled: true } };
  if (expiry) opts.expiryRouting = { enabled: true };
  const am = new AccountManager([
    oauth('claude-a1', { accountUuid: 'u1' }),
    oauth('claude-a2', { accountUuid: 'u2' }),
    oauth('codex-c', { provider: CODEX, accountId: 'ic' }),
  ], 0.98, opts);
  const byName = Object.fromEntries(am.accounts.map(a => [a.name, a]));
  const set = (name, { w7d, reset7d, h5 = 0.1, reset5h = now + H }) => {
    Object.assign(byName[name].quota, {
      unified7d: w7d, unified7dReset: reset7d, unified5h: h5, unified5hReset: reset5h,
    });
  };
  set('claude-a1', { w7d: 0.3, reset7d: now + 5 * DAY });
  set('claude-a2', { w7d: 0.1, reset7d: now + 6 * DAY });
  set('codex-c', { w7d: 0.3, reset7d: now + 1 * DAY, h5: 0.5 });
  return { am, byName, now, set };
}

// Roll a window over: its reset is already in the past, so the next pass that
// reads the account consumes the session-reset event.
const rolled = (set, name, now, w7d, reset7d) => set(name, { w7d, reset7d, h5: 0.5, reset5h: now - 1000 });

const noRamp = (acc, label) => assert.equal(acc.rampStartedAt ?? null, null, `${label} was ramped`);

// Every value the walk writes to the cursor, in order. The final position is not
// enough: a walk can move the cursor onto a foreign account and rotate it back,
// and the ramp and the consumed event are left behind by the first move.
function recordCursor(am) {
  const writes = [];
  let value = am.currentIndex;
  Object.defineProperty(am, 'currentIndex', {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (v) => { value = v; writes.push(v); },
  });
  return writes;
}

for (const expiry of [false, true]) {
  const knob = expiry ? 'expiry routing on' : 'expiry routing off (default)';

  test(`[${knob}] a Codex 5h rollover does not move a Claude request onto Codex`, () => {
    const { am, byName, now, set } = fleet({ expiry });
    rolled(set, 'codex-c', now, 0.3, now + 1 * DAY);
    // An automatic placement: these tests are about the session-reset switch, and a
    // manual choice (#668) holds the cursor against it (manual-switch-priority.test.js).
    am._setCurrent(byName['claude-a1']);
    const writes = recordCursor(am);

    const served = am.getActiveAccount(null, MODEL[CLAUDE], null, null, CLAUDE);

    assert.equal(served?.name, 'claude-a1', 'the Claude request was not served by the current Claude account');
    assert.deepEqual(writes.filter(i => providerOf(am.accounts[i]) !== CLAUDE), [],
      'a Claude request moved the fleet cursor onto a Codex account');
    assert.equal(byName['codex-c'].sessionResetPending, true,
      'a Claude request consumed the Codex account\'s session-reset event');
    noRamp(byName['codex-c'], 'the Codex account');
    noRamp(byName['claude-a1'], 'the Claude account');

    // Knob off: the event waits for the Codex request it belongs to, and that request uses it.
    // Knob on spends a request's event only where the cursor sits, so this is asserted off only.
    if (!expiry) {
      am.getActiveAccount(null, MODEL[CODEX], null, null, CODEX);
      assert.equal(byName['codex-c'].sessionResetPending, false,
        'the Codex request did not consume its own session-reset event');
    }
  });

  test(`[${knob}] a Claude 5h rollover does not move a Codex request onto Claude`, () => {
    const { am, byName, now, set } = fleet({ expiry });
    set('codex-c', { w7d: 0.3, reset7d: now + 9 * DAY, h5: 0.5 });
    rolled(set, 'claude-a1', now, 0.3, now + 1 * DAY);
    // An automatic placement: these tests are about the session-reset switch, and a
    // manual choice (#668) holds the cursor against it (manual-switch-priority.test.js).
    am._setCurrent(byName['codex-c']);
    const writes = recordCursor(am);

    const served = am.getActiveAccount(null, MODEL[CODEX], null, null, CODEX);

    assert.equal(served?.name, 'codex-c', 'the Codex request was not served by the current Codex account');
    assert.deepEqual(writes.filter(i => providerOf(am.accounts[i]) !== CODEX), [],
      'a Codex request moved the fleet cursor onto a Claude account');
    assert.equal(byName['claude-a1'].sessionResetPending, true,
      'a Codex request consumed the Claude account\'s session-reset event');
    noRamp(byName['claude-a1'], 'the Claude account');
    noRamp(byName['codex-c'], 'the Codex account');
  });

  // Whatever the fleet looks like, a walk for provider P leaves the cursor either
  // where it started or on an account P can serve. Never on another provider's
  // subscription.
  const states = [
    { name: 'Codex 5h rolled, Codex weekly expires sooner, cursor on Claude',
      cursor: 'claude-a1', overrides: [], rolled: ['codex-c'] },
    { name: 'Claude 5h rolled, Claude weekly expires sooner, cursor on Codex',
      cursor: 'codex-c', overrides: [['codex-c', 9], ['claude-a1', 1]], rolled: ['claude-a1'] },
    { name: 'Codex 5h rolled, Codex weekly later, cursor on Claude',
      cursor: 'claude-a1', overrides: [['codex-c', 9]], rolled: ['codex-c'] },
    { name: 'Claude and Codex 5h both rolled, cursor on Claude',
      cursor: 'claude-a1', overrides: [], rolled: ['codex-c', 'claude-a2'] },
    { name: 'no rollover, Claude weekly expires sooner, cursor on Codex',
      cursor: 'codex-c', overrides: [['codex-c', 9], ['claude-a1', 1]], rolled: [] },
  ];
  for (const s of states) {
    for (const provider of [CLAUDE, CODEX]) {
      test(`[${knob}] invariant: a ${provider} walk never leaves the cursor on a foreign subscription (${s.name})`, () => {
        const { am, byName, now, set } = fleet({ expiry });
        for (const [name, days] of s.overrides) {
          const acc = byName[name];
          set(name, { w7d: acc.quota.unified7d, reset7d: now + days * DAY });
        }
        for (const name of s.rolled) rolled(set, name, now, byName[name].quota.unified7d, byName[name].quota.unified7dReset);
        // An automatic placement: these tests are about the session-reset switch, and a
        // manual choice (#668) holds the cursor against it (manual-switch-priority.test.js).
        am._setCurrent(byName[s.cursor]);
        const start = am.currentIndex;
        const writes = recordCursor(am);

        am.getActiveAccount(null, MODEL[provider], null, null, provider);

        const foreign = writes.filter(i => i !== start && !canServeProvider(am.accounts[i], provider));
        assert.deepEqual(foreign.map(i => am.accounts[i].name), [],
          `a ${provider} walk wrote the cursor onto another provider's subscription`);
      });
    }
  }
}

// A poll - the TUI repaint, GET /teamclaude/quota, get_quota - sees every
// provider's resets with no walk to confine them. Weighed in one field with
// the account the shared cursor rests on, a Codex roll was measured against a
// Claude account's weekly, and a win moved the shared cursor onto Codex and
// the Codex cursor with it, off a Codex account that resets sooner still. Each
// provider's roll is weighed against that provider's own cursor, and only that
// cursor moves. Claude a1/a2 and Codex c1/c2; `days` gives each weekly reset.
function pollFleet(days) {
  const now = Date.now();
  const oauth = (name, extra) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + H, ...extra });
  const am = new AccountManager([
    oauth('claude-a1', { accountUuid: 'u1' }),
    oauth('claude-a2', { accountUuid: 'u2' }),
    oauth('codex-c1', { provider: CODEX, accountId: 'i1' }),
    oauth('codex-c2', { provider: CODEX, accountId: 'i2' }),
  ], 0.98);
  const by = Object.fromEntries(am.accounts.map(a => [a.name, a]));
  for (const [name, d] of Object.entries(days)) {
    Object.assign(by[name].quota, { unified7d: 0.3, unified7dReset: now + d * DAY, unified5h: 0.1, unified5hReset: now + H });
  }
  // Codex's cursor on c1, then the shared cursor on a1: both automatic placements.
  am._setCurrent(by['codex-c1']);
  am._setCurrent(by['claude-a1']);
  return {
    am, by,
    roll: name => Object.assign(by[name].quota, { unified5h: 0.5, unified5hReset: now - 1000 }),
    cursor: provider => am.accounts[am.currentIndexFor(provider)].name,
    next: provider => am.getActiveAccount(null, MODEL[provider], null, null, provider).name,
  };
}

// Both orderings: a Claude account resetting later than the Codex cursor must
// not let a poll move Codex onto a later-resetting account, and one resetting
// sooner must not block a move onto a sooner one.
for (const [claudeDays, incumbentDays, expected] of [[5, 1, 'codex-c1'], [1, 5, 'codex-c2']]) {
  test(`a poll weighs a Codex roll against the Codex cursor, not the shared cursor's Claude account (Claude ${claudeDays}d, Codex cursor ${incumbentDays}d, candidate 2d)`, t => {
    t.mock.method(console, 'log', () => {});
    const { am, roll, cursor, next } = pollFleet({ 'claude-a1': claudeDays, 'claude-a2': 6, 'codex-c1': incumbentDays, 'codex-c2': 2 });
    roll('codex-c2');
    am.refreshExpiredQuotas();
    assert.equal(am.accounts[am.currentIndex].name, 'claude-a1', 'a Codex roll moved the shared cursor');
    assert.equal(cursor(CLAUDE), 'claude-a1');
    assert.equal(cursor(CODEX), expected);
    assert.equal(next(CODEX), expected);
    assert.equal(next(CLAUDE), 'claude-a1');
  });
}

// One poll, a roll on each side: each moves its own provider's cursor, and
// neither is weighed against the other.
test('one poll that rolls a Claude and a Codex account moves each provider\'s own cursor', t => {
  t.mock.method(console, 'log', () => {});
  const { am, roll, cursor, next } = pollFleet({ 'claude-a1': 6, 'claude-a2': 2, 'codex-c1': 5, 'codex-c2': 3 });
  roll('claude-a2');
  roll('codex-c2');
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[am.currentIndex].name, 'claude-a2', 'the Claude roll moved the shared cursor');
  assert.equal(cursor(CLAUDE), 'claude-a2');
  assert.equal(cursor(CODEX), 'codex-c2', 'the Codex roll lost to a Claude account in one field');
  assert.equal(next(CODEX), 'codex-c2');
  assert.equal(next(CLAUDE), 'claude-a2');
});

// An API key tagged for Codex can serve Claude traffic too, but its reset is
// Codex's: a poll weighs it against the Codex cursor and moves only that
// cursor, and the shared cursor stays on the Claude account it rests on.
test('a poll moves only the Codex cursor onto a Codex-tagged API key whose window rolled', t => {
  t.mock.method(console, 'log', () => {});
  const now = Date.now();
  const oauth = (name, extra) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + H, ...extra });
  const am = new AccountManager([
    oauth('claude-a1', { accountUuid: 'u1' }),
    { name: 'codex-key', type: 'apikey', apiKey: 'k', provider: CODEX },
    oauth('codex-c1', { provider: CODEX, accountId: 'i1' }),
  ], 0.98);
  const [a1, key, c1] = am.accounts;
  Object.assign(a1.quota, { unified7d: 0.3, unified7dReset: now + 5 * DAY, unified5h: 0.1, unified5hReset: now + H });
  Object.assign(key.quota, { unified7d: 0.3, unified7dReset: now + 1 * DAY, unified5h: 0.5, unified5hReset: now - 1000 }); // rolled
  Object.assign(c1.quota, { unified7d: 0.3, unified7dReset: now + 3 * DAY, unified5h: 0.1, unified5hReset: now + H });
  am._setCurrent(c1);
  am._setCurrent(a1);
  am.refreshExpiredQuotas(); // a poll
  assert.equal(am.accounts[am.currentIndex].name, 'claude-a1', 'the poll moved the shared cursor onto the Codex-tagged key');
  assert.equal(am.accounts[am.currentIndexFor(CLAUDE)].name, 'claude-a1');
  assert.equal(am.accounts[am.currentIndexFor(CODEX)].name, 'codex-key');
});

// Codex with no cursor of its own, its traffic riding the shared cursor's
// account: an API key, which a Codex walk starts from and records no cursor on,
// since the key reads as Claude's. A request takes a Codex roll there, weighed
// against the key; a poll that spent the roll first and skipped it for want of
// a Codex cursor left the next Codex request on the key. The two orders agree:
// the poll weighs the roll against the key too, moves only the Codex cursor,
// and leaves the shared cursor, and a manual choice of the key, where they are.
for (const manual of [false, true]) {
  for (const [label, keyExtra, keyQuota] of [
    ['its weekly resetting in 5d', () => ({}), days => ({ unified7d: 0.3, unified7dReset: days(5) })],
    ['ending in 4d', days => ({ endsAt: days(4) }), () => ({})],
  ]) {
    test(`a poll and a request agree on a Codex roll while Codex rides the shared key (${manual ? 'manual choice' : 'automatic placement'}, key ${label})`, t => {
      t.mock.method(console, 'log', () => {});
      const outcome = poll => {
        const now = Date.now();
        const days = d => now + d * DAY;
        const oauth = (name, extra) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + H, ...extra });
        const am = new AccountManager([
          oauth('claude-a1', { accountUuid: 'u1' }),
          { name: 'key', type: 'apikey', apiKey: 'k', ...keyExtra(days) },
          oauth('codex-c1', { provider: CODEX, accountId: 'i1' }),
          oauth('codex-c2', { provider: CODEX, accountId: 'i2' }),
        ], 0.98);
        const [a1, key, c1, c2] = am.accounts;
        Object.assign(a1.quota, { unified7d: 0.3, unified7dReset: days(6), unified5h: 0.1, unified5hReset: now + H });
        Object.assign(key.quota, keyQuota(days));
        Object.assign(c1.quota, { unified7d: 0.3, unified7dReset: days(1), unified5h: 0.5, unified5hReset: now - 1000 }); // rolled
        Object.assign(c2.quota, { unified7d: 0.3, unified7dReset: days(3), unified5h: 0.1, unified5hReset: now + H });
        if (manual) assert.equal(am.setCurrentAccount(key.index), true);
        else am._setCurrent(key);
        am.providerCursors.delete(CODEX);
        if (poll) am.refreshExpiredQuotas();
        return {
          codex: am.getActiveAccount(null, MODEL[CODEX], null, null, CODEX).name,
          claude: am.getActiveAccount(null, MODEL[CLAUDE], null, null, CLAUDE).name,
          shared: am.accounts[am.currentIndex].name,
          choice: am._isManualChoice(key),
        };
      };
      const polled = outcome(true);
      assert.deepEqual(polled, outcome(false), 'a poll first sent the next Codex request elsewhere');
      assert.deepEqual(polled, { codex: 'codex-c1', claude: 'key', shared: 'key', choice: manual });
    });
  }
}

// One poll, rolls on both sides, Codex with no cursor of its own: the shared
// cursor's provider is weighed first, and Codex against where that leaves the
// shared cursor. Weighed before the move, a poll held Codex on an account the
// same poll then left, or dropped its roll against a Claude account the shared
// cursor was leaving for a shared key. Each fleet is asked twice: a poll first,
// and a Codex request first; the two must send that Codex request to the same
// account. (Only the first: a Codex walk that a shared key's roll moves onto
// that key hands the shared cursor back, and records no Codex cursor on a key
// that reads as Claude's, so the request after it starts from the old key.)
// `days` gives each weekly reset, `rolled` the accounts whose 5-hour window has
// rolled, `shared` where the shared cursor starts.
function rollBoth(t, accounts, days, rolled, shared) {
  t.mock.method(console, 'log', () => {});
  const outcome = poll => {
    const now = Date.now();
    const am = new AccountManager(accounts.map(([name, kind]) => (kind === 'key'
      ? { name, type: 'apikey', apiKey: 'k-' + name }
      : { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + H,
        ...(kind === CODEX ? { provider: CODEX, accountId: 'i-' + name } : { accountUuid: 'u-' + name }) })), 0.98);
    for (const a of am.accounts) {
      const r = rolled.includes(a.name);
      Object.assign(a.quota, { unified7d: 0.3, unified7dReset: now + days[a.name] * DAY,
        unified5h: r ? 0.5 : 0.1, unified5hReset: r ? now - 1000 : now + H });
    }
    am._setCurrent(am.accounts.find(a => a.name === shared));
    am.providerCursors.delete(CODEX);
    if (poll) am.refreshExpiredQuotas();
    return am.getActiveAccount(null, MODEL[CODEX], null, null, CODEX).name;
  };
  const polled = outcome(true);
  assert.equal(polled, outcome(false), 'a poll first sent Codex elsewhere than a Codex request first');
  return polled;
}

test('a poll weighs Codex against the shared key its own provider\'s roll moved the shared cursor to', t => {
  const codex = rollBoth(t, [['claude-a1'], ['key-k', 'key'], ['key-k2', 'key'], ['codex-c1', CODEX]],
    { 'claude-a1': 5, 'key-k': 6, 'key-k2': 1, 'codex-c1': 3 }, ['key-k2', 'codex-c1'], 'key-k');
  assert.equal(codex, 'key-k2');
});

test('a poll weighs Codex against the shared key a Claude roll moved the shared cursor to from a Claude account', t => {
  const codex = rollBoth(t, [['claude-a1'], ['key-k0', 'key'], ['codex-c1', CODEX], ['codex-c2', CODEX]],
    { 'claude-a1': 7, 'key-k0': 3, 'codex-c1': 1, 'codex-c2': 5 }, ['key-k0', 'codex-c1'], 'claude-a1');
  assert.equal(codex, 'codex-c1');
});

test('a poll weighs Codex against the shared key a Claude roll moved the shared cursor off', t => {
  // codex-c2 resets soonest but has not rolled: where a poll leaves Codex to
  // its walk, the walk picks it on merit; a Codex request first takes the roll.
  const codex = rollBoth(t, [['claude-a1'], ['key-k', 'key'], ['codex-c1', CODEX], ['codex-c2', CODEX]],
    { 'claude-a1': 1, 'key-k': 5, 'codex-c1': 2, 'codex-c2': 1.5 }, ['claude-a1', 'codex-c1'], 'key-k');
  assert.equal(codex, 'codex-c1');
});

// At startup the shared cursor is the constructor's index 0 while
// selectActiveAccount clears what expired, and the start is picked after.
// Here index 0 is an API key, which reads as Claude's, and Codex has no cursor
// of its own: a Codex roll restored at startup is not weighed against that
// key, as a Codex request arriving after the start does not weigh it against
// the key either. The start is claude-a1, so Codex picks on merit, codex-c2.
// Both with an end time and a weekly reading on the key.
for (const [label, extra, quota] of [['an end time', days => ({ endsAt: days(6) }), () => ({})],
  ['a weekly reading', () => ({}), days => ({ unified7d: 0.3, unified7dReset: days(6) })]]) {
  test(`startup takes no account as Codex's before it picks the start (API key at index 0 with ${label})`, t => {
    t.mock.method(console, 'log', () => {});
    const outcome = startup => {
      const now = Date.now();
      const days = d => now + d * DAY;
      const oauth = (name, fields) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + H, ...fields });
      const am = new AccountManager([
        { name: 'key', type: 'apikey', apiKey: 'k', ...extra(days) },
        oauth('claude-a1', { accountUuid: 'u1' }),
        oauth('codex-c1', { provider: CODEX, accountId: 'i1' }),
        oauth('codex-c2', { provider: CODEX, accountId: 'i2' }),
      ], 0.98);
      const [key, a1, c1, c2] = am.accounts;
      Object.assign(key.quota, quota(days));
      Object.assign(a1.quota, { unified7d: 0.3, unified7dReset: days(0.5), unified5h: 0.1, unified5hReset: now + H });
      Object.assign(c1.quota, { unified7d: 0.3, unified7dReset: days(3), unified5h: 0.5, unified5hReset: now - 1000 }); // restored, rolled
      Object.assign(c2.quota, { unified7d: 0.3, unified7dReset: days(1), unified5h: 0.1, unified5hReset: now + H });
      if (startup) am.selectActiveAccount();
      else { am.sweepExpiredQuotas(); am._setCurrent(am._pickBestAvailable()); } // the same start, no poll
      return { start: am.accounts[am.currentIndex].name, codex: [0, 1].map(() => am.getActiveAccount(null, MODEL[CODEX], null, null, CODEX).name) };
    };
    const started = outcome(true);
    assert.deepEqual(started, outcome(false), 'the startup poll sent Codex elsewhere than a Codex request after the start');
    assert.deepEqual(started, { start: 'claude-a1', codex: ['codex-c2', 'codex-c2'] });
  });
}

// Once the start is picked, polls weigh another provider against the shared
// key again: here the start is the key, and codex-c1, spent at startup, rolls
// after it. A poll first and a Codex request first agree on codex-c1.
test('after startup a poll weighs a Codex roll against the shared key the start placed it on', t => {
  t.mock.method(console, 'log', () => {});
  const outcome = poll => {
    const now = Date.now();
    const oauth = (name, fields) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: now + H, ...fields });
    const am = new AccountManager([
      oauth('claude-a1', { accountUuid: 'u1' }),
      { name: 'key', type: 'apikey', apiKey: 'k' },
      oauth('codex-c1', { provider: CODEX, accountId: 'i1' }),
      oauth('codex-c2', { provider: CODEX, accountId: 'i2' }),
    ], 0.98);
    const [a1, key, c1, c2] = am.accounts;
    Object.assign(a1.quota, { unified7d: 0.3, unified7dReset: now + 6 * DAY, unified5h: 0.1, unified5hReset: now + H });
    Object.assign(key.quota, { unified7d: 0.3, unified7dReset: now + 2 * DAY });
    Object.assign(c1.quota, { unified7d: 0.3, unified7dReset: now + 1.5 * DAY, unified5h: 0.99, unified5hReset: now + H }); // spent
    Object.assign(c2.quota, { unified7d: 0.3, unified7dReset: now + 4 * DAY, unified5h: 0.1, unified5hReset: now + H });
    assert.equal(am.selectActiveAccount().name, 'key');
    Object.assign(c1.quota, { unified5h: 0.5, unified5hReset: now - 1000 }); // codex-c1's window rolls
    if (poll) am.refreshExpiredQuotas();
    return am.getActiveAccount(null, MODEL[CODEX], null, null, CODEX).name;
  };
  const polled = outcome(true);
  assert.equal(polled, outcome(false), 'a poll after startup sent Codex elsewhere than a Codex request first');
  assert.equal(polled, 'codex-c1');
});
