import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker, SESSION_KNOWN_TTL_MS, SESSION_ACTIVE_TTL_MS } from '../src/session-tracker.js';

// The weekly buckets a pin is keyed by (see model.js weeklyBucketForModel).
const SHARED = 'unified7d';
const FABLE = 'unified7dFable';

// A tracker whose clock we drive by hand.
function fixedClock(start = 1_000_000) {
  const c = { t: start };
  return { clock: c, now: () => c.t };
}

test('touch records a session and pins it to the serving account', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 2, SHARED, clock.t);
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 2);
  assert.equal(st.pinnedAccount('unknown', SHARED, clock.t), null);
});

test('a later touch re-pins the session (failover moves it)', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 0, SHARED, clock.t);
  st.touch('s1', 3, SHARED, clock.t);
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 3);
});

test('a pin is per bucket: re-pinning one leaves the others alone', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 0, SHARED, clock.t);
  st.touch('s1', 1, FABLE, clock.t);
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 0);
  assert.equal(st.pinnedAccount('s1', FABLE, clock.t), 1);
  st.touch('s1', 2, FABLE, clock.t); // the Fable pin fails over
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 0, 'the shared pin moved with it');
  assert.equal(st.pinnedAccount('s1', FABLE, clock.t), 2);
});

test('a bucket with no pin reads as unpinned', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), null);
  st.touch('s1', 0, SHARED, clock.t);
  assert.equal(st.pinnedAccount('s1', FABLE, clock.t), null);
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 0);
});

// A pin needs both halves to name anything. The bucket comes from a route's
// `bucket` override on the way in, which nothing validates, so a bad one has to
// leave the request path alone: the visit is recorded, no pin is written, and
// the session keeps routing as if it had never been pinned.
test('a touch with no usable bucket records the session and pins nothing', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 2, null, clock.t);
  st.touch('s2', 2, 7, clock.t);
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), null);
  assert.equal(st.pinnedAccount('s2', SHARED, clock.t), null);
  assert.equal(st.stats(clock.t).known, 2, 'both are still tracked as running sessions');
});

test('touch with no session id is a no-op', () => {
  const st = new SessionTracker();
  assert.equal(st.touch(null, 1, SHARED), null);
  assert.equal(st.touch(undefined, 1, SHARED), null);
});

test('a session is forgotten after the known (1h) idle window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, SHARED, clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), null);
  assert.equal(st.stats(clock.t).known, 0);
});

test('a session stays known but goes inactive past the active window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, SHARED, clock.t);
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  const stats = st.stats(clock.t);
  assert.equal(stats.known, 1);
  assert.equal(stats.active, 0);
  assert.equal(st.activeCountFor(1, clock.t), 0);
});

test('an in-flight request keeps a session active well past the active window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.touch('s1', 1, SHARED, clock.t); // routed to account 1
  // A 5-minute completion — far longer than the 2-min active window.
  clock.t += SESSION_ACTIVE_TTL_MS * 3;
  assert.equal(st.stats(clock.t).active, 1, 'still active while in flight');
  assert.equal(st.activeCountFor(1, clock.t), 1, 'still counts as load on its account');
  // Request finishes; recency now governs and it stays active a bit longer.
  st.endRequest('s1', clock.t);
  assert.equal(st.stats(clock.t).active, 1);
  // Then idles out of the active window.
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  assert.equal(st.stats(clock.t).active, 0);
});

test('an in-flight session is never expired, even past the 1h known window', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.touch('s1', 0, SHARED, clock.t);
  clock.t += SESSION_KNOWN_TTL_MS * 2; // a 2h+ stream
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 0, 'pin survives while in flight');
  assert.equal(st.stats(clock.t).known, 1);
  // Only after it finishes and idles out does it get forgotten.
  st.endRequest('s1', clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), null);
});

test('concurrent requests on one session balance in/out via inFlight', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.beginRequest('s1', clock.t);
  st.touch('s1', 2, SHARED, clock.t);
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  st.endRequest('s1', clock.t); // one still in flight
  assert.equal(st.activeCountFor(2, clock.t), 1);
  st.endRequest('s1', clock.t); // now idle
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  assert.equal(st.activeCountFor(2, clock.t), 0);
});

test('activeCountFor counts only recently-active sessions on that account', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('a', 0, SHARED, clock.t);
  st.touch('b', 0, SHARED, clock.t);
  st.touch('c', 1, SHARED, clock.t);
  assert.equal(st.activeCountFor(0, clock.t), 2);
  assert.equal(st.activeCountFor(1, clock.t), 1);
  assert.equal(st.activeCountFor(2, clock.t), 0);
});

test('a session spending two accounts is load on both, counted once each', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('split', 0, SHARED, clock.t);
  st.touch('split', 1, FABLE, clock.t);
  st.touch('whole', 0, SHARED, clock.t);
  st.touch('whole', 0, FABLE, clock.t); // both buckets on one account
  assert.equal(st.activeCountFor(0, clock.t), 2, 'split + whole, each once');
  assert.equal(st.activeCountFor(1, clock.t), 1);
  assert.deepEqual(st.stats(clock.t).perAccount, { 0: 2, 1: 1 });
});

// Load is what the fleet is doing NOW. A pin outlives the active window by
// design (it holds the cache affinity for the whole known hour), so a session
// whose Fable turn was diverted well outside that window must not still read as
// load on that account — the whole point of the metric is to spread new
// sessions onto the accounts that are actually idle.
test('a pin stops counting as load once its bucket goes quiet', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, FABLE, clock.t);                   // one Fable turn on account 1
  clock.t += SESSION_ACTIVE_TTL_MS * 2;                // four minutes, twice the window
  st.touch('s1', 0, SHARED, clock.t);                  // Opus turns keep going on 0
  assert.equal(st.activeCountFor(0, clock.t), 1);
  assert.equal(st.activeCountFor(1, clock.t), 0, 'a four-minute-old Fable pin still reads as load');
  assert.deepEqual(st.stats(clock.t).perAccount, { 0: 1 });
  // Still pinned, though — the affinity is intact and a Fable turn goes back there.
  assert.equal(st.pinnedAccount('s1', FABLE, clock.t), 1);
});

// `pin.at` is stamped when a request is ROUTED and `lastSeen` moves again when
// it ENDS, so a request that outruns the active window would leave its session
// inside that window holding a pin that had already aged out: the account that
// did the work reads as carrying nothing the moment it finishes. Finishing ages
// the pin too.
test('an account still counts as load the moment its long request ends', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.touch('s1', 0, SHARED, clock.t);
  clock.t += SESSION_ACTIVE_TTL_MS * 3;                // a 6-minute completion
  st.endRequest('s1', clock.t);
  assert.equal(st.stats(clock.t).active, 1, 'the session is still active');
  assert.equal(st.activeCountFor(0, clock.t), 1, 'the account that served it dropped out');
  assert.deepEqual(st.stats(clock.t).perAccount, { 0: 1 });
  // And it ages out of the load metric on the same schedule as any other pin.
  clock.t += SESSION_ACTIVE_TTL_MS + 1;
  assert.equal(st.activeCountFor(0, clock.t), 0);
});

// The refresh takes the newest pin, which is the one whichever request was
// ROUTED last was spending. Two concurrent requests on different families break
// that: the short one routed second finishes first, so the long one's account
// reads as idle the moment it finishes. Narrower than the session going
// unattributed everywhere, since it is still counted on the other account,
// exactly once. Asserted so the residual is pinned rather than described.
test('two concurrent requests on different families refresh the wrong pin', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t);
  st.touch('s1', 0, SHARED, clock.t);            // a long Opus stream on account 0
  clock.t += 10_000;
  st.beginRequest('s1', clock.t);
  st.touch('s1', 1, FABLE, clock.t);             // a short Fable request on account 1
  clock.t += 30_000;
  st.endRequest('s1', clock.t);                  // Fable finishes; Opus still streaming
  clock.t += SESSION_ACTIVE_TTL_MS * 3;
  st.endRequest('s1', clock.t);                  // Opus finishes six minutes later
  assert.equal(st.activeCountFor(0, clock.t), 0, 'the account that carried the stream');
  assert.equal(st.activeCountFor(1, clock.t), 1, 'the refresh landed on the one that finished first');
  // What holds regardless: counted somewhere, once, rather than nowhere.
  assert.equal(st.stats(clock.t).active, 1);
  assert.deepEqual(st.stats(clock.t).perAccount, { 1: 1 });
});

// Which pin a request was spending is not recorded, so the refresh takes the
// newest. A pin the session has not touched since well before the request is
// not revived by it.
test('a finished request does not revive a pin it was not spending', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, FABLE, clock.t);                   // an old Fable turn on 1
  clock.t += SESSION_ACTIVE_TTL_MS * 2;
  st.beginRequest('s1', clock.t);
  st.touch('s1', 0, SHARED, clock.t);                  // the Opus request being served
  clock.t += SESSION_ACTIVE_TTL_MS * 3;
  st.endRequest('s1', clock.t);
  assert.equal(st.activeCountFor(0, clock.t), 1, 'the account it was spending');
  assert.equal(st.activeCountFor(1, clock.t), 0, 'the quiet Fable pin stays quiet');
});

// The in-flight arm of the freshness rule reads the session's counter, which
// says a request is outstanding but not which pin it is spending. So a live
// request holds up every pin the session owns, including a stale one on another
// account. Deliberate: the alternative is under-counting the account carrying a
// long stream, which is the funnelling this metric exists to prevent. Telling
// the two apart needs per-request attribution, which this change does not add.
test('a live request holds up every pin the session owns, not just the one it spends', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 1, FABLE, clock.t);
  clock.t += SESSION_ACTIVE_TTL_MS * 2;
  st.beginRequest('s1', clock.t);
  st.touch('s1', 0, SHARED, clock.t);
  clock.t += SESSION_ACTIVE_TTL_MS * 3;                // a 6-minute completion
  assert.equal(st.activeCountFor(0, clock.t), 1, 'the account serving the live request lost its load');
  assert.equal(st.activeCountFor(1, clock.t), 1, 'the quiet Fable pin is held up with it');
  st.endRequest('s1', clock.t);
  assert.equal(st.activeCountFor(1, clock.t), 0, 'and released when the request ends');
});

test('remapAccounts renumbers pins above a removal and drops those on it', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('s1', 0, SHARED, clock.t);
  st.touch('s1', 2, FABLE, clock.t);
  st.touch('s2', 1, SHARED, clock.t);
  st.remapAccounts(idx => (idx === 1 ? null : idx > 1 ? idx - 1 : idx));
  assert.equal(st.pinnedAccount('s1', SHARED, clock.t), 0, 'below the removal, unmoved');
  assert.equal(st.pinnedAccount('s1', FABLE, clock.t), 1, 'above it, shifted down');
  assert.equal(st.pinnedAccount('s2', SHARED, clock.t), null, 'on it, dropped');
});

test('stats reports known, active, and per-account active distribution', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('a', 0, SHARED, clock.t);
  st.touch('b', 0, SHARED, clock.t);
  st.touch('c', 1, SHARED, clock.t);
  const stats = st.stats(clock.t);
  assert.equal(stats.known, 3);
  assert.equal(stats.active, 3);
  assert.deepEqual(stats.perAccount, { 0: 2, 1: 1 });
});

test('stats sweeps forgotten sessions out of the map', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('old', 0, SHARED, clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.touch('new', 1, SHARED, clock.t);
  st.stats(clock.t);
  assert.equal(st.sessions.has('old'), false);
  assert.equal(st.sessions.has('new'), true);
});

test('pinnedSessionIds lists pinned sessions and skips unpinned ones', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('pinned-a', 0, 'unified7d', clock.t);
  st.touch('pinned-b', 1, 'unified7dFable', clock.t);
  st.beginRequest('no-pin', clock.t); // seen, but never served by an account
  assert.deepEqual(st.pinnedSessionIds(clock.t).sort(), ['pinned-a', 'pinned-b']);
});

test('pinnedSessionIds drops forgotten sessions as it reads', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('old', 0, 'unified7d', clock.t);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.touch('fresh', 1, 'unified7d', clock.t);
  assert.deepEqual(st.pinnedSessionIds(clock.t), ['fresh']);
  assert.equal(st.sessions.has('old'), false);
});

// --- per-session detail (proxy.sessionDetail) -------------------------------

test('stats() carries no per-session rows unless detail is asked for', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t, { client: 'alice', dimensions: { project: 'skaile-dev' } });
  // Any holder of any proxy key can read status, so the default must not name
  // sessions, clients, or project values.
  assert.equal('items' in st.stats(clock.t), false);
  assert.equal(Array.isArray(st.stats(clock.t, { detail: true }).items), true);
  // The aggregate counts are unaffected either way.
  assert.equal(st.stats(clock.t).known, st.stats(clock.t, { detail: true }).known);
});

test('a detail row carries the labels and the per-bucket tokens the responses reported', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t, { client: 'alice', dimensions: { project: 'skaile-dev' } });
  st.touch('s1', 0, SHARED, clock.t);
  st.touch('s1', 1, FABLE, clock.t);
  st.recordTokens('s1', SHARED, {
    cache_read_input_tokens: 900, cache_creation_input_tokens: 50,
    input_tokens: 10, output_tokens: 5,
  }, clock.t);

  const [row] = st.stats(clock.t, { detail: true }).items;
  assert.equal(row.id, 's1');
  assert.equal(row.client, 'alice');
  assert.deepEqual(row.dimensions, { project: 'skaile-dev' });
  // A session holds one pin per weekly bucket and can be served by two accounts
  // at once, which a single accountIndex could not express.
  assert.deepEqual(row.pins, { [SHARED]: 0, [FABLE]: 1 });
  // Cost comes from the response usage, cache included: input+output alone
  // would report 15 for a turn that actually read 965 tokens of context.
  assert.equal(row.tokens[SHARED].cacheRead, 900);
  assert.equal(row.tokens[SHARED].context, 960);
  assert.equal(row.inFlight, 1);
  assert.equal(row.active, true);
});

test('detail rows are newest-first, and a forgotten session is absent', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.touch('old', 0, SHARED, clock.t);
  clock.t += 1000;
  st.touch('new', 0, SHARED, clock.t);
  assert.deepEqual(st.stats(clock.t, { detail: true }).items.map(r => r.id), ['new', 'old']);
  clock.t += SESSION_KNOWN_TTL_MS + 1;
  st.touch('newest', 0, SHARED, clock.t);
  assert.deepEqual(st.stats(clock.t, { detail: true }).items.map(r => r.id), ['newest']);
});

test('a request without labels does not erase the ones the session already has', () => {
  const { clock, now } = fixedClock();
  const st = new SessionTracker({ now });
  st.beginRequest('s1', clock.t, { client: 'alice', dimensions: { project: 'p1' } });
  st.beginRequest('s1', clock.t, null);
  st.beginRequest('s1', clock.t, { dimensions: {} });
  const [row] = st.stats(clock.t, { detail: true }).items;
  assert.equal(row.client, 'alice');
  assert.deepEqual(row.dimensions, { project: 'p1' });
});
