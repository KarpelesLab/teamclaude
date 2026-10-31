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
    am.setCurrentAccount(am.accounts.indexOf(byName['claude-a1']));
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
    am.setCurrentAccount(am.accounts.indexOf(byName['codex-c']));
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
        am.setCurrentAccount(am.accounts.indexOf(byName[s.cursor]));
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
