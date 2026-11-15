import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, accountEndsAt } from '../src/account-manager.js';
import { parseEndsAt, describeEndsAt } from '../src/ends-at.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { mergeAccountsForSave, syncRefreshedTokens } from '../src/account-pairing.js';
import { setAccountEndsAt, ConfigOpError } from '../src/config-ops.js';
import { renderStatus, endsAtLine } from '../src/status-renderer.js';
import { endsTag } from '../src/tui.js';

// An account's end time (accounts[].endsAt, #676): quota left when a
// subscription ends is lost as quota left at a weekly reset is, so selection
// ranks the account by the earlier of the two. It only ranks: nothing here may
// change which accounts are available.

const H = 3600_000;
const DAY = 24 * H;
const OPUS = 'claude-opus-5';
// Every fixture and every read below is taken against this one instant, frozen
// per test, so a deadline is ahead or behind by construction and not by how
// long the run took.
const START = Date.parse('2030-03-10T12:00:00Z');

function freezeClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  return START;
}

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: START + 3600_000, ...extra };
}

/** `used` of the shared weekly spent, the window resetting `hours` from START. */
function weekly(am, index, used, hours) {
  Object.assign(am.accounts[index].quota, { unified7d: used, unified7dReset: hours == null ? null : START + hours * H });
}

/** Run `fn` with console.log captured, returning what was logged. */
function logged(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { fn(); } finally { console.log = original; }
  return lines;
}

// ── the parser ───────────────────────────────────────────────

test('parseEndsAt reads epoch milliseconds and ISO 8601, and nothing else', () => {
  assert.equal(parseEndsAt(START), START);
  assert.equal(parseEndsAt(String(START)), START);
  assert.equal(parseEndsAt('2030-03-10T12:00:00Z'), START);
  assert.equal(parseEndsAt('2030-03-10T21:00:00+09:00'), START);
  assert.equal(parseEndsAt(' 2030-03-10T12:00:00.000Z '), START);
  // No offset: local time, as a bare date is.
  assert.equal(parseEndsAt('2030-03-10T08:30'), new Date(2030, 2, 10, 8, 30).getTime());
  assert.equal(parseEndsAt('2030-03-10 08:30'), new Date(2030, 2, 10, 8, 30).getTime());

  for (const bad of [null, undefined, '', 'soon', 'Dec 1 2030', '2030-13-01', '2030-02-31', '2030-03-10T25:00:00Z',
    NaN, Infinity, -1, 0, true, {}, [], '12:00']) {
    assert.equal(parseEndsAt(bad), null, `${JSON.stringify(bad)} is not a time`);
  }
});

test('a bare date is the start of that day in local time', () => {
  assert.equal(parseEndsAt('2030-12-01'), new Date(2030, 11, 1).getTime());
});

test('describeEndsAt gives the local date and how far off it is', () => {
  const end = new Date(2030, 11, 1).getTime();
  assert.equal(describeEndsAt(end, end - 6 * DAY - H), '2030-12-01 (in 6 days)');
  assert.equal(describeEndsAt(end, end - DAY), '2030-12-01 (in 1 day)');
  assert.equal(describeEndsAt(end, end - 5 * H), '2030-12-01 (in 5 hours)');
  assert.equal(describeEndsAt(end, end - 90_000), '2030-12-01 (in 1 minute)');
  assert.equal(describeEndsAt(end, end - 1000), '2030-12-01 (in under a minute)');
  assert.equal(describeEndsAt(end, end), '2030-12-01 (ended)');
  assert.equal(describeEndsAt(end, end + DAY), '2030-12-01 (ended)');
  // A time of day is shown when there is one.
  assert.equal(describeEndsAt(new Date(2030, 11, 1, 9, 5).getTime(), end - DAY), '2030-12-01 09:05 (in 1 day)');
});

// ── the helper ───────────────────────────────────────────────

test('_deadline is the earlier of the weekly reset and a future end time', () => {
  const am = new AccountManager([oauth('plain'), oauth('ending', { endsAt: START + 10 * H })], 0.98);
  const [plain, ending] = am.accounts;
  const reset = START + 50 * H;

  // Weekly only: the argument comes back untouched, unknown included.
  assert.equal(am._deadline(plain, reset, START), reset);
  assert.equal(am._deadline(plain, null, START), null);
  // End time only.
  assert.equal(am._deadline(ending, null, START), START + 10 * H);
  // Both: whichever comes first.
  assert.equal(am._deadline(ending, reset, START), START + 10 * H);
  assert.equal(am._deadline(ending, START + 2 * H, START), START + 2 * H);
  // Passed, or passing this instant: no effect.
  assert.equal(am._deadline(ending, reset, START + 10 * H), reset);
  assert.equal(am._deadline(ending, reset, START + 11 * H), reset);
  assert.equal(am._deadline(ending, null, START + 11 * H), null);
});

test('an end time is normalised to epoch ms once, and an invalid one is ignored with one line', () => {
  assert.equal(accountEndsAt({ name: 'a' }), null);
  assert.equal(accountEndsAt({ name: 'a', endsAt: null }), null);
  assert.equal(accountEndsAt({ name: 'a', endsAt: START }), START);
  assert.equal(accountEndsAt({ name: 'a', endsAt: '2030-03-10T12:00:00Z' }), START);

  for (const bad of ['next \x1b[2Jweek', NaN, Infinity, {}, false]) {
    let am;
    const lines = logged(() => { am = new AccountManager([oauth('odd', { endsAt: bad })], 0.98); });
    assert.equal(am.accounts[0].endsAt, null);
    const mine = lines.filter(l => l.includes('endsAt'));
    assert.equal(mine.length, 1, `one line for ${String(bad)}`);
    assert.match(mine[0], /Account "odd": ignoring endsAt /);
    assert.equal(mine[0].includes('\x1b'), false, 'the value is cleaned before it reaches the log');
    // Ranked as if the key were absent.
    assert.equal(am._deadline(am.accounts[0], START + H, START), START + H);
  }
  // Nothing is said about an account that sets none.
  assert.deepEqual(logged(() => new AccountManager([oauth('quiet')], 0.98)).filter(l => l.includes('endsAt')), []);
});

// ── selection ────────────────────────────────────────────────

test('the equal-priority tiebreak prefers an end time sooner than the other account\'s weekly reset', t => {
  freezeClock(t);
  const build = extra => {
    const am = new AccountManager([oauth('resets-soon'), oauth('ending', extra)], 0.98);
    weekly(am, 0, 0.2, 20);
    weekly(am, 1, 0.2, 100);
    return am;
  };
  // As before without an end time: the sooner weekly reset.
  assert.equal(build({})._pickBestAvailable(null, OPUS).name, 'resets-soon');
  // Ending in 5h, it has the sooner deadline.
  assert.equal(build({ endsAt: START + 5 * H })._pickBestAvailable(null, OPUS).name, 'ending');
  // Ending after its own reset and after the other's, the end time decides nothing.
  assert.equal(build({ endsAt: START + 200 * H })._pickBestAvailable(null, OPUS).name, 'resets-soon');
  // Ended: no effect on the ranking, and the account is still a candidate.
  const ended = build({ endsAt: START - H });
  assert.equal(ended._pickBestAvailable(null, OPUS).name, 'resets-soon');
  assert.equal(ended._isAvailable(ended.accounts[1], OPUS), true, 'a passed end time does not take the account out');
  assert.equal(ended.unavailableReason(ended.accounts[1]), null);
});

test('an account with no weekly reading has its end time as its deadline', t => {
  freezeClock(t);
  const am = new AccountManager([oauth('known'), oauth('unread', { endsAt: START + 30 * H })], 0.98);
  weekly(am, 0, 0.2, 20);
  assert.equal(am._rankingReset(am.accounts[1], OPUS, START), START + 30 * H);
  // 20h is sooner than 30h, so the read account goes first; move the end time
  // inside that and the unread one does.
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'known');
  am.accounts[1].endsAt = START + 10 * H;
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'unread');
});

test('session distribution breaks its last tie on the deadline', t => {
  freezeClock(t);
  const am = new AccountManager([oauth('resets-soon'), oauth('ending', { endsAt: START + 5 * H })], 0.98,
    { distributeSessions: true });
  weekly(am, 0, 0.2, 20);
  weekly(am, 1, 0.2, 100);
  assert.equal(am._pickLeastLoadedEven(null, OPUS).name, 'ending');
});

test('preferSoonestWeeklyReset moves traffic to the account that ends soonest', t => {
  freezeClock(t);
  const build = (prefer, extra = {}) => {
    const am = new AccountManager([oauth('current'), oauth('ending', extra)], 0.98, { preferSoonestWeeklyReset: prefer });
    weekly(am, 0, 0.1, 10);
    weekly(am, 1, 0.1, 60);
    return am;
  };
  // Off, or with no end time, traffic stays where it is.
  assert.equal(build(false, { endsAt: START + 3 * H }).getActiveAccount(null, OPUS).name, 'current');
  assert.equal(build(true).getActiveAccount(null, OPUS).name, 'current');

  const am = build(true, { endsAt: START + 3 * H });
  assert.equal(am.getActiveAccount(null, OPUS).name, 'ending');
  assert.equal(am.getActiveAccount(null, OPUS).name, 'ending');
  assert.match(am.eligibility(0).reason, /outranked by "ending", which ends sooner \(preferSoonestWeeklyReset\)/);

  // An end time that has passed preempts nothing.
  assert.equal(build(true, { endsAt: START - H }).getActiveAccount(null, OPUS).name, 'current');
});

test('the wording for a weekly-reset preemption is unchanged', t => {
  freezeClock(t);
  const am = new AccountManager([oauth('late'), oauth('soon')], 0.98, { preferSoonestWeeklyReset: true });
  weekly(am, 0, 0.1, 100);
  weekly(am, 1, 0.1, 10);
  assert.match(am.eligibility(0).reason, /outranked by "soon", whose weekly quota resets sooner \(preferSoonestWeeklyReset\)/);
});

test('expiry pressure is the headroom over the time left to the deadline', t => {
  const now = freezeClock(t);
  const am = new AccountManager([oauth('plain'), oauth('ending', { endsAt: START + 10 * H })], 0.98,
    { expiryRouting: { enabled: true, tolerance: 1.5 } });
  weekly(am, 0, 0.5, 100);
  weekly(am, 1, 0.5, 100);
  const [plain, ending] = am.accounts;
  assert.equal(am._expiryPressure(plain, OPUS, now), 0.5 / (100 * 3600));
  assert.equal(am._expiryPressure(ending, OPUS, now), 0.5 / (10 * 3600));
  // Same quota, a tenth of the time to spend it: outside the 1.5x band, so the
  // ending account is the one selection spends.
  assert.deepEqual(am._bandedCandidates(null, OPUS).map(a => a.name), ['ending']);
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'ending');
  // The status payload's pressure is that same figure.
  assert.equal(am.getStatus().accounts[1].pressure, 0.5 / (10 * 3600));

  // Once passed it is priced on its weekly window again.
  assert.equal(am._expiryPressure(ending, OPUS, START + 11 * H), 0.5 / (89 * 3600));
  // And the window's own clock, which rollover detection compares, never moved.
  assert.equal(am._governingWindow(ending, OPUS).resetAt, START + 100 * H);
});

test('with expiry routing on, a utilization with no reset time is priced to the end time', t => {
  const now = freezeClock(t);
  const am = new AccountManager([oauth('clockless', { endsAt: START + 10 * H })], 0.98, { expiryRouting: { enabled: true } });
  weekly(am, 0, 0.25, null);
  assert.equal(am._expiryPressure(am.accounts[0], OPUS, now), 0.75 / (10 * 3600));
});

test('placement pressure prices a fresh window over the time left, not a full week', t => {
  const now = freezeClock(t);
  const am = new AccountManager([oauth('plain'), oauth('ending', { endsAt: START + 12 * H })], 0.98);
  const [plain, ending] = am.accounts;
  // Neither has a reading: a whole window each, one of them with 12h to spend it.
  assert.equal(am._placementPressure(plain, OPUS, now), 1 / (7 * 24 * 3600));
  assert.equal(am._placementPressure(ending, OPUS, now), 1 / (12 * 3600));
  // An end time past the week changes nothing.
  ending.endsAt = START + 30 * DAY;
  assert.equal(am._placementPressure(ending, OPUS, now), 1 / (7 * 24 * 3600));
});

test('the session-reset switch compares deadlines', t => {
  freezeClock(t);
  const build = extra => {
    const am = new AccountManager([oauth('current'), oauth('ending', extra)], 0.98);
    weekly(am, 0, 0.1, 50);
    weekly(am, 1, 0.1, 100);
    return am;
  };
  const quiet = fn => { logged(fn); };
  // Its weekly resets later than the current account's: no switch.
  const plain = build({});
  quiet(() => plain._switchOnSessionReset([plain.accounts[1]], OPUS));
  assert.equal(plain.currentIndex, 0);
  // It ends before the current account resets: its quota expires sooner.
  const ending = build({ endsAt: START + 5 * H });
  quiet(() => ending._switchOnSessionReset([ending.accounts[1]], OPUS));
  assert.equal(ending.currentIndex, 1);
});

test('priority still wins over a sooner end time', t => {
  freezeClock(t);
  for (const opts of [{}, { preferSoonestWeeklyReset: true }, { expiryRouting: { enabled: true } }, { distributeSessions: true }]) {
    const am = new AccountManager([oauth('preferred'), oauth('ending', { priority: 5, endsAt: START + 2 * H })], 0.98, opts);
    weekly(am, 0, 0.1, 150);
    weekly(am, 1, 0.1, 100);
    assert.equal(am._pickBestAvailable(null, OPUS).name, 'preferred', JSON.stringify(opts));
    assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'preferred', JSON.stringify(opts));
  }
});

test('an end time changes nothing about availability, caps or cordons', t => {
  freezeClock(t);
  const am = new AccountManager([
    oauth('spent', { endsAt: START + H }),
    oauth('cordoned', { endsAt: START + H, cordoned: true }),
    oauth('disabled', { endsAt: START + H, disabled: true }),
    oauth('open'),
  ], 0.98, { preferSoonestWeeklyReset: true });
  weekly(am, 0, 0.99, 100);
  weekly(am, 1, 0.1, 100);
  weekly(am, 2, 0.1, 100);
  weekly(am, 3, 0.1, 100);
  am._setCurrent(am.accounts[3]);
  assert.equal(am.getActiveAccount(null, OPUS).name, 'open');
  assert.equal(am._pickBestAvailable(null, OPUS).name, 'open');
});

// ── reload and save ──────────────────────────────────────────

const entry = extra => ({ id: 'x', name: 'x@example.com', type: 'oauth', accessToken: 'at', refreshToken: 'rt', expiresAt: START + H, ...extra });

test('a reload applies an end time set on disk, moves it, and clears it', async () => {
  const memConfig = { accounts: [entry({})] };
  const am = new AccountManager(memConfig.accounts.map(a => ({ ...a })), 0.98);
  assert.equal(am.accounts[0].endsAt, null);

  await syncAccountsFromDisk({ accounts: [entry({ endsAt: '2030-03-10T12:00:00Z' })] }, memConfig, am);
  assert.equal(am.accounts[0].endsAt, START);
  assert.equal(memConfig.accounts[0].endsAt, '2030-03-10T12:00:00Z', 'the entry keeps the text as written');

  await syncAccountsFromDisk({ accounts: [entry({ endsAt: START + DAY })] }, memConfig, am);
  assert.equal(am.accounts[0].endsAt, START + DAY);

  await syncAccountsFromDisk({ accounts: [entry({})] }, memConfig, am);
  assert.equal(am.accounts[0].endsAt, null);
  assert.equal('endsAt' in memConfig.accounts[0], false);
});

test('a reload ignores an invalid end time, saying so, and the entry keeps it', async () => {
  const memConfig = { accounts: [entry({ endsAt: START })] };
  const am = new AccountManager(memConfig.accounts.map(a => ({ ...a })), 0.98);
  let pending;
  const lines = logged(() => { pending = syncAccountsFromDisk({ accounts: [entry({ endsAt: 'whenever' })] }, memConfig, am); });
  await pending;
  assert.equal(am.accounts[0].endsAt, null);
  assert.equal(lines.filter(l => /ignoring endsAt "whenever"/.test(l)).length, 1);
  assert.equal(memConfig.accounts[0].endsAt, 'whenever');
});

test('a token-refresh save keeps the end time exactly as written', () => {
  const written = '2030-03-10T12:00:00Z';
  const memConfig = { accounts: [entry({ endsAt: written })] };
  const am = new AccountManager(memConfig.accounts.map(a => ({ ...a })), 0.98);
  // What the refresh handler does: new tokens on the account and its entry,
  // then the account half of a save over the file as it is on disk.
  const fresh = { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: START + 2 * H };
  am.updateAccountTokens(0, fresh);
  syncRefreshedTokens(memConfig.accounts, am.accounts, 0, fresh);
  const [saved] = mergeAccountsForSave(memConfig.accounts, am.accounts, [entry({ endsAt: written })]);
  assert.equal(saved.refreshToken, 'rt-2');
  assert.equal(saved.endsAt, written, 'not rewritten as the parsed number');
});

test('a save between `teamclaude ends` and the reload follows the file, both ways', () => {
  // Set on disk, not yet reloaded: the save must not drop it.
  const before = { accounts: [entry({})] };
  const am = new AccountManager(before.accounts.map(a => ({ ...a })), 0.98);
  const [set] = mergeAccountsForSave(before.accounts, am.accounts, [entry({ endsAt: START })]);
  assert.equal(set.endsAt, START);

  // Cleared on disk, not yet reloaded: the save must not put it back.
  const stale = { accounts: [entry({ endsAt: START })] };
  const am2 = new AccountManager(stale.accounts.map(a => ({ ...a })), 0.98);
  const [cleared] = mergeAccountsForSave(stale.accounts, am2.accounts, [entry({})]);
  assert.equal('endsAt' in cleared, false);

  // An entry with no row on disk yet (added in memory, save pending) keeps its own.
  const [added] = mergeAccountsForSave(stale.accounts, am2.accounts, []);
  assert.equal(added.endsAt, START);
});

// ── the config operation ─────────────────────────────────────

test('setAccountEndsAt sets, replaces and clears the end time', () => {
  const config = { accounts: [{ name: 'a@example.com', type: 'oauth' }, { name: 'b@example.com', type: 'oauth' }] };

  assert.deepEqual(setAccountEndsAt(config, 'a@example.com', '2030-03-10T21:00:00+09:00'), { name: 'a@example.com', endsAt: START });
  assert.equal(config.accounts[0].endsAt, '2030-03-10T12:00:00.000Z', 'a date is stored as the UTC instant');
  assert.equal('endsAt' in config.accounts[1], false);

  // A bare date is that local day, pinned to its instant when written.
  const localDay = new Date(2030, 11, 1).getTime();
  assert.deepEqual(setAccountEndsAt(config, 'a@example.com', '2030-12-01'), { name: 'a@example.com', endsAt: localDay });
  assert.equal(config.accounts[0].endsAt, new Date(localDay).toISOString());

  // Epoch milliseconds stay a number, typed as one or as digits.
  setAccountEndsAt(config, 'a@example.com', START);
  assert.equal(config.accounts[0].endsAt, START);
  setAccountEndsAt(config, 'a@example.com', String(START + 1));
  assert.equal(config.accounts[0].endsAt, START + 1);

  assert.deepEqual(setAccountEndsAt(config, 'a@example.com', null), { name: 'a@example.com', endsAt: null });
  assert.equal('endsAt' in config.accounts[0], false);
});

test('setAccountEndsAt refuses a bad time or a bad account, changing nothing', () => {
  const config = { accounts: [
    { name: 'a@example.com', type: 'oauth', endsAt: START },
    { name: 'dup@example.com', type: 'oauth', orgName: 'One', orgUuid: 'o1', accountUuid: 'u' },
    { name: 'dup@example.com', type: 'oauth', orgName: 'Two', orgUuid: 'o2', accountUuid: 'u' },
  ] };
  const before = JSON.stringify(config);
  for (const bad of ['soon', '', '2030-02-31', NaN, undefined, {}]) {
    assert.throws(() => setAccountEndsAt(config, 'a@example.com', bad), ConfigOpError, String(bad));
  }
  assert.throws(() => setAccountEndsAt(config, 'nobody@example.com', START), /no account matches/);
  assert.throws(() => setAccountEndsAt(config, 'dup@example.com', START), /matches 2 accounts/);
  assert.throws(() => setAccountEndsAt(config, '', null), ConfigOpError);
  assert.equal(JSON.stringify(config), before);

  // --org picks one of two accounts under the same address.
  assert.equal(setAccountEndsAt(config, 'dup@example.com', START, { orgFilter: 'Two' }).endsAt, START);
  assert.equal(config.accounts[2].endsAt, START);
  assert.equal('endsAt' in config.accounts[1], false);
});

// ── visibility ───────────────────────────────────────────────

test('the status payload carries endsAt as epoch ms, null when unset', () => {
  const am = new AccountManager([oauth('plain'), oauth('ending', { endsAt: '2030-03-10T12:00:00Z' })], 0.98);
  const [plain, ending] = am.getStatus().accounts;
  assert.equal(plain.endsAt, null);
  assert.equal(ending.endsAt, START);
  // And survives the trip `status --json` and GET /teamclaude/status make.
  assert.equal(JSON.parse(JSON.stringify(am.getStatus())).accounts[1].endsAt, START);
});

test('teamclaude status shows the end date on the account, and "ended" once past', () => {
  const end = new Date(2030, 11, 1).getTime();
  const status = endsAt => ({
    currentAccount: 'a',
    switchThreshold: 0.98,
    accounts: [{ name: 'a', type: 'oauth', priority: 0, status: 'active', quota: {}, usage: {}, endsAt }],
  });
  assert.match(renderStatus(status(end), { color: false, now: end - 6 * DAY - H }), /^ {2}Ends {5}2030-12-01 \(in 6 days\)$/m);
  assert.match(renderStatus(status(end), { color: false, now: end + H }), /^ {2}Ends {5}2030-12-01 \(ended\)$/m);
  assert.doesNotMatch(renderStatus(status(null), { color: false, now: end }), /Ends/);
  assert.doesNotMatch(renderStatus(status(undefined), { color: false, now: end }), /Ends/);
  // The payload can come from another process: only a real instant is drawn.
  const plain = { dim: s => s, yellow: s => s, gray: s => s };
  for (const bad of ['2030-12-01', NaN, 0, -5, {}]) assert.equal(endsAtLine({ endsAt: bad }, end, plain), null);
});

test('the TUI row tag counts down to the end time', () => {
  assert.equal(endsTag({}, START), '');
  assert.equal(endsTag({ endsAt: null }, START), '');
  assert.equal(endsTag({ endsAt: 'soon' }, START), '');
  assert.equal(endsTag({ endsAt: START + 6 * DAY + H }, START), 'ends 6d');
  assert.equal(endsTag({ endsAt: START + 5 * H }, START), 'ends 5h');
  assert.equal(endsTag({ endsAt: START + 12 * 60_000 }, START), 'ends 12m');
  assert.equal(endsTag({ endsAt: START + 1000 }, START), 'ends 1m');
  assert.equal(endsTag({ endsAt: START }, START), 'ended');
  assert.equal(endsTag({ endsAt: START - DAY }, START), 'ended');
});

test('with no weekly reset known, an end time more than a week out is not a deadline', () => {
  const am = new AccountManager([oauth('unread', { endsAt: START + 30 * DAY }), oauth('soon', { endsAt: START + 2 * DAY })], 0.98);
  assert.equal(am._deadline(am.accounts[0], null, START), null, 'an unknown reset is at most a week away');
  assert.equal(am._deadline(am.accounts[1], null, START), START + 2 * DAY);
  assert.equal(am._deadline(am.accounts[0], START + 3 * DAY, START), START + 3 * DAY, 'a known reset still stands');
});

test('a number no date can hold is not an end time', () => {
  assert.equal(parseEndsAt(1e300), null);
  assert.equal(parseEndsAt(Infinity), null);
  assert.equal(parseEndsAt(8.64e15), 8.64e15);
});
