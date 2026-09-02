import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../src/session-tracker.js';
import { AccountManager } from '../src/account-manager.js';

// Per-session token accounting. Upstream reports what a request cost in a
// `usage` object, and until now only `input_tokens` and `output_tokens` were
// read off it: the two cache fields were discarded, and nothing was attributed
// to the session that caused the spend.
//
// Nothing routes on any of this. These tests pin what is recorded and, just as
// importantly, what is not: the counters are a measurement, and a measurement
// that quietly double counts or resurrects forgotten state is worse than none.

const SID = 'sess-a';
const accounts = (names) => names.map(n => ({ name: n, type: 'apikey', apiKey: `k-${n}` }));

// Totals are per weekly bucket, so every assertion has to name one. These are
// the two families that meter separately, which is the whole reason for the
// split: an Opus point and a Fable point are not the same thing.
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const OPUS_BUCKET = 'unified7d';
const FABLE_BUCKET = 'unified7dFable';
const tokensFor = (t, id, bucket = OPUS_BUCKET) => t.sessions.get(id).tokens.get(bucket);

// The shape upstream sends at `message_start`: the input side, including both
// cache fields, with output present but not yet meaningful.
const startUsage = (over = {}) => ({
  input_tokens: 12,
  cache_read_input_tokens: 4000,
  cache_creation_input_tokens: 300,
  output_tokens: 1,
  ...over,
});

// The shape at `message_delta`: output only.
const deltaUsage = (over = {}) => ({ output_tokens: 500, ...over });

function trackerWith(sessionId = SID) {
  const t = new SessionTracker();
  t.touch(sessionId);
  return t;
}

test('a usage report is attributed to the session that caused it', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  const got = tokensFor(t, SID);
  assert.equal(got.cacheRead, 4000);
  assert.equal(got.cacheCreation, 300);
  assert.equal(got.input, 12);
  assert.equal(got.output, 1);
  assert.equal(got.reports, 1);
});

// The tracker sums every report it is handed: that is what makes a session total
// a total across the turns of a conversation. It follows that the streaming path
// must hand it one report per message rather than one per SSE event, which is
// asserted end to end in streaming-usage-merge.test.js.
test('successive reports accumulate into the session total', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  const got = tokensFor(t, SID);
  assert.equal(got.input, 24, 'a second turn adds to the running total');
  assert.equal(got.cacheRead, 8000);
  assert.equal(got.reports, 2);
});

// `context` is the size of the last context read, not a running total. Summing
// it across a conversation answers a question nobody asks, and a delta report
// carries no input side at all, so it must not reset it either.
test('context tracks the latest input side and survives an output-only report', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  assert.equal(tokensFor(t, SID).context, 4312);
  t.recordTokens(SID, OPUS_BUCKET, deltaUsage());
  assert.equal(tokensFor(t, SID).context, 4312,
    'an output-only report has nothing to say about context size');
  t.recordTokens(SID, OPUS_BUCKET, startUsage({ cache_read_input_tokens: 9000 }));
  assert.equal(tokensFor(t, SID).context, 9312,
    'the next turn read a bigger context, and that is the current one');
});

// The id is a client-supplied header, so a report for a session the tracker is
// not carrying must not create a record: that would let usage reports repopulate
// a map the idle window exists to drain.
test('a report for an untracked session is dropped, not resurrected', () => {
  const t = new SessionTracker();
  assert.equal(t.recordTokens('never-seen', OPUS_BUCKET, startUsage()), null);
  assert.equal(t.sessions.size, 0, 'a usage report created a session record');
  assert.equal(t.recordTokens(null, OPUS_BUCKET, startUsage()), null);
  assert.equal(t.sessions.size, 0);
});

// The totals ride the session record, so they end when it does. This is the read
// path: a report arriving for a session that has idled past the known window
// finds nothing to add to, and takes the dead record out on its way through.
// (A `touch` arriving first revives the record instead, tokens and all — see the
// limitation in the PR body. That is the pre-existing lifecycle and not
// something this change either introduces or repairs.)
test('a report for a session idled past the known window is dropped with it', () => {
  let now = 1000;
  const t = new SessionTracker({ knownTtlMs: 100, now: () => now });
  t.touch(SID);
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  assert.equal(tokensFor(t, SID).cacheRead, 4000);
  now += 500;
  assert.equal(t.recordTokens(SID, OPUS_BUCKET, startUsage()), null,
    'a report landed on a session the tracker had already forgotten');
  assert.equal(t.sessions.has(SID), false, 'the expired record was left behind');
});

// A stream that fails after the first report keeps what was observed: the
// context was read upstream and charged, and the client leaving refunds nothing.
test('a stream that stops after its first report keeps what it spent', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  const got = tokensFor(t, SID);
  assert.equal(got.cacheRead, 4000);
  assert.equal(got.output, 1, 'only what was reported');
  assert.equal(got.reports, 1);
});

test('a malformed report contributes zero rather than poisoning the totals', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  t.recordTokens(SID, OPUS_BUCKET, { input_tokens: null, cache_read_input_tokens: 'lots', output_tokens: undefined });
  const got = tokensFor(t, SID);
  for (const [k, v] of Object.entries(got)) {
    assert.ok(Number.isFinite(v), `${k} is ${v}`);
  }
  assert.equal(got.cacheRead, 4000, 'a non-numeric field added nothing');
});

// ── the families meter separately ────────────────────────────────────────────

// The point of keying by bucket. A session that talks to both families holds two
// contexts and two burn rates, and pooling them destroys a distinction nothing
// downstream can rebuild.
test('a session that spans two families keeps their totals apart', () => {
  const t = trackerWith();
  t.recordTokens(SID, OPUS_BUCKET, startUsage());
  t.recordTokens(SID, FABLE_BUCKET, startUsage({ cache_read_input_tokens: 90, input_tokens: 3 }));
  assert.equal(tokensFor(t, SID, OPUS_BUCKET).cacheRead, 4000);
  assert.equal(tokensFor(t, SID, FABLE_BUCKET).cacheRead, 90);
  assert.equal(tokensFor(t, SID, OPUS_BUCKET).context, 4312);
  assert.equal(tokensFor(t, SID, FABLE_BUCKET).context, 393,
    'the two families reported different context sizes and one overwrote the other');
});

test('a report with no bucket is dropped rather than pooled', () => {
  const t = trackerWith();
  assert.equal(t.recordTokens(SID, null, startUsage()), null);
  assert.equal(t.sessions.get(SID).tokens.size, 0,
    'a report that named no family landed somewhere anyway');
});

// ── the account side ─────────────────────────────────────────────────────────

test('the cache fields are totalled against the account that served them', () => {
  const am = new AccountManager(accounts(['a', 'b']), 0.98);
  am.sessionTracker.touch(SID);
  am.recordTokenUsage(0, SID, OPUS, startUsage());
  am.recordTokenUsage(0, SID, OPUS, startUsage());
  assert.equal(am.accounts[0].usage.totalCacheReadTokens, 8000);
  assert.equal(am.accounts[0].usage.totalCacheCreationTokens, 600);
  assert.equal(am.accounts[1].usage.totalCacheReadTokens, 0, 'the other account was charged');
});

test('an account report with no session still lands on the account', () => {
  const am = new AccountManager(accounts(['a']), 0.98);
  am.recordTokenUsage(0, null, OPUS, startUsage());
  assert.equal(am.accounts[0].usage.totalCacheReadTokens, 4000,
    'a request without a session id is still a real spend by this account');
});

test('recordTokenUsage leaves the existing account totals alone', () => {
  const am = new AccountManager(accounts(['a']), 0.98);
  am.recordTokenUsage(0, null, OPUS, startUsage());
  assert.equal(am.accounts[0].usage.totalInputTokens, 0,
    'the uncached-input total is updateUsage\'s to keep, and this must not touch it');
  assert.equal(am.accounts[0].usage.totalOutputTokens, 0);
});

test('the account totals are split by family and still sum', () => {
  const am = new AccountManager(accounts(['a']), 0.98);
  am.sessionTracker.touch(SID);
  am.recordTokenUsage(0, SID, OPUS, startUsage());
  am.recordTokenUsage(0, SID, FABLE, startUsage({ cache_read_input_tokens: 90 }));
  const u = am.accounts[0].usage;
  assert.equal(u.byBucket[OPUS_BUCKET].cacheReadTokens, 4000);
  assert.equal(u.byBucket[FABLE_BUCKET].cacheReadTokens, 90);
  assert.equal(u.totalCacheReadTokens, 4090, 'the flat total no longer agrees with the split');
});

// An advisor request reports once, and the two inferences inside it are not
// separable in that report. It lands on the executing model's family, and this
// pins that rather than leaving it to be discovered.
test('an advisor request lands on the executing model\'s family', () => {
  const am = new AccountManager(accounts(['a']), 0.98);
  am.sessionTracker.touch(SID);
  am.recordTokenUsage(0, SID, OPUS, startUsage());   // executor Opus, advisor elsewhere
  assert.equal(am.sessionTracker.sessions.get(SID).tokens.get(FABLE_BUCKET), undefined,
    'a bucket the request did not execute on was charged');
  assert.equal(am.sessionTracker.sessions.get(SID).tokens.get(OPUS_BUCKET).cacheRead, 4000);
});

// A `bucket` override on a route is how an operator redirects a model's quota
// accounting, and the totals follow it for the same reason routing does: a
// figure filed under a bucket the request was not gated by describes nothing.
test('a route bucket override files the totals where it files the routing', () => {
  const am = new AccountManager(accounts(['a']), 0.98, {
    routes: [{ name: 'r', match: '*fable*', bucket: 'unified7d' }],
  });
  am.sessionTracker.touch(SID);
  am.recordTokenUsage(0, SID, FABLE, startUsage());
  assert.equal(am.accounts[0].usage.byBucket[FABLE_BUCKET], undefined,
    'the override was ignored and the family default won');
  assert.equal(am.accounts[0].usage.byBucket[OPUS_BUCKET].cacheReadTokens, 4000);
  assert.equal(tokensFor(am.sessionTracker, SID, OPUS_BUCKET).cacheRead, 4000,
    'the session totals and the account totals disagree about the bucket');
});

// ── what the fleet view reports ──────────────────────────────────────────────

test('stats totals the known sessions and the live cached footprint', () => {
  const t = new SessionTracker();
  t.touch('a'); t.touch('b');
  t.recordTokens('a', OPUS_BUCKET, startUsage());
  t.recordTokens('b', OPUS_BUCKET, startUsage({ cache_read_input_tokens: 1000 }));
  const s = t.stats();
  assert.equal(s.tokens.cacheRead, 5000);
  assert.equal(s.tokens.input, 24);
  assert.equal(s.tokens.reports, 2);
  assert.equal(s.tokens.activeContext, 4312 + 1312, 'the footprint sums the ACTIVE sessions');
});

test('an idle session keeps its totals but leaves the live footprint', () => {
  let now = 1000;
  const t = new SessionTracker({ activeTtlMs: 100, now: () => now });
  t.touch('a');
  t.recordTokens('a', OPUS_BUCKET, startUsage());
  assert.equal(t.stats().tokens.activeContext, 4312);
  now += 500;                                   // still known, no longer active
  const s = t.stats();
  assert.equal(s.active, 0);
  assert.equal(s.tokens.cacheRead, 4000, 'a known session still counts toward the totals');
  assert.equal(s.tokens.activeContext, 0, 'an idle session is not part of the live footprint');
});

test('stats reports each family and the total across them', () => {
  const t = new SessionTracker();
  t.touch('a');
  t.recordTokens('a', OPUS_BUCKET, startUsage());
  t.recordTokens('a', FABLE_BUCKET, startUsage({ cache_read_input_tokens: 90, input_tokens: 3 }));
  const s = t.stats();
  assert.equal(s.tokens.byBucket[OPUS_BUCKET].cacheRead, 4000);
  assert.equal(s.tokens.byBucket[FABLE_BUCKET].cacheRead, 90);
  assert.equal(s.tokens.cacheRead, 4090, 'the total across families is not reported');
  assert.equal(s.tokens.byBucket[OPUS_BUCKET].activeContext, 4312);
  assert.equal(s.tokens.byBucket[FABLE_BUCKET].activeContext, 393);
  assert.equal(s.tokens.activeContext, 4705, 'the live footprint sums the families');
});

// ── the status payload ───────────────────────────────────────────────────────

// `teamclaude status --json` is what an operator reads during an incident, and a
// field that has stopped reading its source is worse than a missing one: it
// answers confidently and wrongly. Zero is every one of these fields' default,
// so a fixture that leaves any of them at zero would pass against a constant.
// Every value below is therefore set away from its default AND made distinct
// from every other, so a field wired to the wrong source reads as a different
// number rather than as a coincidence.
//
// Two shapes the fixture needs on purpose, because freezing is not the only way
// a field goes wrong:
//
//   - account 'a' spends TWO families, so its flat total (4200) differs from
//     either of its per-bucket figures (4000, 200). With one family each, a
//     per-bucket figure sourced from the flat total would read correct.
//   - the two families report a DIFFERENT number of times (1 against 2), so a
//     bucket swap that reached `reports` alone is visible. At one apiece the two
//     are interchangeable.
//
// Account 'b' stays on one family, as the contrast.
function payloadFixture() {
  const am = new AccountManager(accounts(['a', 'b']), 0.98);
  am.sessionTracker.touch('s1', 0);
  am.sessionTracker.touch('s2', 1);
  am.recordTokenUsage(0, 's1', OPUS, {
    input_tokens: 11, cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 300, output_tokens: 7,
  });
  // A different family on purpose: the two must not be pooled on the way out.
  am.recordTokenUsage(1, 's2', FABLE, {
    input_tokens: 22, cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 50, output_tokens: 9,
  });
  // The same session and account as the first, in the other family.
  am.recordTokenUsage(0, 's1', FABLE, {
    input_tokens: 5, cache_read_input_tokens: 200,
    cache_creation_input_tokens: 60, output_tokens: 14,
  });
  return am;
}

test('the status payload reports the fleet token totals and the live footprint', () => {
  const s = payloadFixture().getStatus();
  assert.equal(s.sessions.tokens.cacheRead, 5200, 'the cache-read total is not reported');
  assert.equal(s.sessions.tokens.cacheCreation, 410, 'the cache-creation total is not reported');
  assert.equal(s.sessions.tokens.input, 38, 'the per-session input total is not reported');
  assert.equal(s.sessions.tokens.output, 30, 'the per-session output total is not reported');
  assert.equal(s.sessions.tokens.reports, 3,
    'the report count is not published, so no tokens and no observations read alike');
  assert.equal(s.sessions.tokens.activeContext, 4311 + 265 + 1072,
    'the live cached footprint is not reported');
});

test('the status payload splits the fleet totals by weekly family', () => {
  const s = payloadFixture().getStatus();
  const opus = s.sessions.tokens.byBucket[OPUS_BUCKET];
  const fable = s.sessions.tokens.byBucket[FABLE_BUCKET];
  assert.equal(opus.cacheRead, 4000, 'the Opus weekly bucket is not reported on its own');
  assert.equal(fable.cacheRead, 1200,
    'the Fable weekly bucket is not reported on its own, so the families are pooled');
  assert.equal(opus.cacheCreation, 300);
  assert.equal(fable.cacheCreation, 110);
  assert.equal(opus.input, 11);
  assert.equal(fable.input, 27);
  assert.equal(opus.output, 7);
  assert.equal(fable.output, 23);
  assert.equal(opus.reports, 1);
  assert.equal(fable.reports, 2, 'the two families report the same count, so a swap is invisible');
  assert.equal(opus.activeContext, 4311);
  assert.equal(fable.activeContext, 265 + 1072);
});

test('the status payload reports each account\'s cache totals and their split', () => {
  const s = payloadFixture().getStatus();
  assert.equal(s.accounts[0].usage.totalCacheReadTokens, 4200,
    "the account's cache-read total is not reported");
  assert.equal(s.accounts[0].usage.totalCacheCreationTokens, 360,
    "the account's cache-creation total is not reported");
  assert.equal(s.accounts[1].usage.totalCacheReadTokens, 1000,
    'both accounts report the same cache total');
  assert.equal(s.accounts[1].usage.totalCacheCreationTokens, 50);
  // Each of these differs from the flat total above it, so a per-bucket figure
  // sourced from that total is a different number rather than the same one.
  assert.equal(s.accounts[0].usage.byBucket[OPUS_BUCKET].cacheReadTokens, 4000,
    "the account's per-family split is not reported");
  assert.equal(s.accounts[0].usage.byBucket[OPUS_BUCKET].cacheCreationTokens, 300);
  assert.equal(s.accounts[0].usage.byBucket[FABLE_BUCKET].cacheReadTokens, 200,
    "the account's second family is pooled into its first");
  assert.equal(s.accounts[0].usage.byBucket[FABLE_BUCKET].cacheCreationTokens, 60);
  assert.equal(s.accounts[1].usage.byBucket[FABLE_BUCKET].cacheReadTokens, 1000);
  assert.equal(s.accounts[1].usage.byBucket[FABLE_BUCKET].cacheCreationTokens, 50);
});

// The payload is a snapshot. Every other counter under `usage` is a number and
// is copied by the spread; `byBucket` is the one nested value, and left aliased
// it would keep moving while the flat figures beside it on the same object
// stayed frozen. Today's in-process readers serialise it immediately, so this
// pins the property rather than repairing a live defect: an object named for
// being a status snapshot should not be half snapshot and half window.
test('the published per-family split is a snapshot, not a live reference', () => {
  const am = payloadFixture();
  const s = am.getStatus();
  am.recordTokenUsage(0, 's1', OPUS, { cache_read_input_tokens: 777 });
  assert.equal(s.accounts[0].usage.byBucket[OPUS_BUCKET].cacheReadTokens, 4000,
    'the payload moved under its reader');
  assert.equal(s.accounts[0].usage.totalCacheReadTokens, 4200,
    'the flat total moved, so the fixture proves nothing about the nested one');
});
