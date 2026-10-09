import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Live incident 2026-09-18/19: tangeddie1024 (OAuth) went into `error` (revoked
// grant) while dynamic mode + preserveSessionAffinity:true was live. A session
// pinned to it failed over to deepseek-v4-flash. Re-authing tangeddie1024
// flipped its status back to 'active', but the session stayed on
// deepseek-v4-flash for ~40 minutes — dynrank never pulled it back. Root cause,
// confirmed by reading the code (not guessed from symptoms): the
// error/throttled -> active transitions never signalled recovery at all, and
// `_selectForSession`'s ONLY pull-back check compared `costTier` with a strict
// `<` — with costTier unconfigured (every account defaults to 0, see
// makeAccount), `cheaperEligible` is permanently false regardless of timing.
//
// Fix v1 (initial): four recovery transitions set a one-shot
// `account.requalify` boolean, consumed by the first `_selectForSession` call
// that looked at it, using `dynamicCompare` to rank the recovery against the
// pin. PR #7 review (macroscope + coderabbitai, independently) found this had
// two real defects:
//   (a) the flag was consumed GLOBALLY on the account — a second session
//       pinned to the SAME fallback would never see the same recovery event,
//       because the first session to check already cleared it.
//   (b) two recovery transitions were missing entirely: an ORDINARY
//       disabled->enabled toggle (setDisabled only armed it inside the
//       error-clearing branch), and AUTOMATIC rate-limit expiry
//       (refreshExpiredQuotas, which runs on every getActiveAccount call and
//       is the MOST common recovery trigger in practice — distinct from the
//       manual/probe path clearRateLimited covers).
//
// Fix v2 (this file): `account.requalifiedAt` is a TIMESTAMP, not a consumed
// flag. `sessionTracker` tracks a per-session watermark
// (`lastRecoveryCheckAt`); a session evaluates a recovery iff
// `requalifiedAt > its own watermark`, then advances ITS OWN watermark —
// never touching any other session's. Two sessions on the same fallback each
// get an independent look at the same event. All FOUR recovery transitions
// (setDisabled both branches, clearRateLimited, refreshExpiredQuotas
// automatic expiry, updateAccountTokens) now call the same `_markRequalified`
// helper.

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

function dynamicAffinity(accounts, opts = {}) {
  return new AccountManager(accounts, 0.98, {
    distributeSessions: true,
    routingPolicy: { mode: 'dynamic', preserveSessionAffinity: true },
    ...opts,
  });
}

const NOW = Date.now();
const H = 60 * 60 * 1000;

function measured(am, idx, { u5 = 0.1, r5, u7 = 0.1, r7 } = {}) {
  const q = am.accounts[idx].quota;
  if (u5 != null) q.unified5h = u5;
  if (r5 != null) q.unified5hReset = r5;
  if (u7 != null) q.unified7d = u7;
  if (r7 != null) q.unified7dReset = r7;
}

test('the live incident, reconstructed: an account.status error->active pulls the session home', () => {
  const am = dynamicAffinity([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ]);
  am.recordSession('s1', 0);
  am.accounts[0].status = 'error';
  const during = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(during.name, 'fallback', 'precondition: outage fails over as expected');
  am.recordSession('s1', during.index); // the gateway repins on every served request

  // account.status flips back — this is updateAccountTokens's path (OAuth
  // re-auth), the one that actually fired in the incident.
  am.updateAccountTokens(0, { accessToken: 't-home-2' });
  assert.equal(am.accounts[0].status, 'active');
  assert.ok(am.accounts[0].requalifiedAt > 0, 'updateAccountTokens must stamp requalifiedAt on recovery');

  const after = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(after.name, 'home', 'the session must be pulled back once its home account recovers');
});

test('clearRateLimited (manual/probe path) also stamps recovery and pulls the session back', () => {
  const am = dynamicAffinity([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ]);
  am.recordSession('s1', 0);
  am.markRateLimited(0, 60);
  const during = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(during.name, 'fallback');
  am.recordSession('s1', during.index);

  am.clearRateLimited(0);
  assert.ok(am.accounts[0].requalifiedAt > 0);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home');
});

test('automatic rate-limit EXPIRY (refreshExpiredQuotas) also pulls the session back — the missing path from PR #7 review', () => {
  // This is the AUTOMATIC path (runs on every getActiveAccount call), distinct
  // from clearRateLimited's manual/probe path above. It was NOT covered at all
  // in the first version of this fix (coderabbitai finding).
  const am = dynamicAffinity([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ]);
  am.recordSession('s1', 0);
  am.markRateLimited(0, 1); // 1 second
  const during = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(during.name, 'fallback');
  am.recordSession('s1', during.index);

  am.accounts[0].rateLimitedUntil = Date.now() - 1; // force it already-expired
  // getActiveAccount calls refreshExpiredQuotas internally as its first step —
  // no separate clearRateLimited call, this is the automatic path.
  const after = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.ok(am.accounts[0].requalifiedAt > 0, 'automatic expiry must stamp requalifiedAt too');
  assert.equal(after.name, 'home', 'automatic throttle expiry must pull the session back, not just manual clearRateLimited');
});

test('setDisabled ordinary toggle (status already active, no error involved) also pulls the session back — the other missing path from PR #7 review', () => {
  // Distinct from the error-clearing branch: the account's status is 'active'
  // the whole time, only `disabled` flips. The first version of this fix only
  // armed recovery inside `if (account.status === 'error')` and missed this.
  const am = dynamicAffinity([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ]);
  am.recordSession('s1', 0);
  am.setDisabled(0, true); // operator maintenance toggle, status stays 'active'
  assert.equal(am.accounts[0].status, 'active', 'precondition: disabling does not touch status');
  const during = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(during.name, 'fallback');
  am.recordSession('s1', during.index);

  am.setDisabled(0, false); // re-enable — ordinary toggle, not error-clearing
  assert.ok(am.accounts[0].requalifiedAt > 0, 'ordinary disabled->enabled must stamp requalifiedAt too');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home');
});

test('setDisabled(true) itself does NOT stamp recovery (only the ->false transition is a recovery)', () => {
  const am = dynamicAffinity([oauth('a', { priority: 0, costTier: 0 })]);
  am.setDisabled(0, true);
  assert.equal(am.accounts[0].requalifiedAt || 0, 0, 'disabling is not a recovery event');
});

test('TWO sessions pinned to the SAME fallback each get an independent pull-back — the core PR #7 defect', () => {
  // This is the central bug both reviewers found: a global one-shot flag
  // meant the FIRST session to check a recovered account consumed it, leaving
  // every other session sharing that fallback stuck forever.
  const am = dynamicAffinity([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ]);
  am.recordSession('s1', 0);
  am.recordSession('s2', 0);
  am.accounts[0].status = 'error';

  const s1During = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  am.recordSession('s1', s1During.index);
  const s2During = am.getActiveAccount(null, 'claude-opus-4-8', null, 's2');
  am.recordSession('s2', s2During.index);
  assert.equal(s1During.name, 'fallback');
  assert.equal(s2During.name, 'fallback');

  am.updateAccountTokens(0, { accessToken: 't-2' }); // ONE recovery event

  // s1 checks first and pulls back.
  const s1After = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(s1After.name, 'home', 's1 must be pulled back');

  // s2 must ALSO be pulled back by the SAME recovery event — this is exactly
  // what the global-flag version got wrong (s1 would have consumed it).
  const s2After = am.getActiveAccount(null, 'claude-opus-4-8', null, 's2');
  assert.equal(s2After.name, 'home', 's2 must independently see the SAME recovery event s1 already consumed under the old design');
});

test('a recovery that ranks WORSE than the current pin does NOT pull the session', () => {
  // "recovered" must mean "actually preferred by dynamicCompare", not "any
  // account whose state just changed". A lower-priority/worse account
  // recovering from a transient throttle must not steal a session from a
  // genuinely better-ranked pin.
  const am = dynamicAffinity([
    oauth('best', { priority: 0, costTier: 0 }),
    oauth('worse', { priority: 50, costTier: 0 }),
  ]);
  measured(am, 0, { r7: NOW + H });      // best: resets soon (dynamic-preferred)
  measured(am, 1, { r7: NOW + 96 * H }); // worse: resets far out
  am.recordSession('s1', 0);
  am._markRequalified(am.accounts[1]); // simulate a recovery event on the worse account

  const result = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(result.name, 'best', 'a worse-ranked recovery must not displace a better-ranked pin');
});

test('this session does not re-scan on every subsequent request for a recovery it already evaluated', () => {
  const am = dynamicAffinity([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ]);
  am.recordSession('s1', 0);
  am.accounts[0].status = 'error';
  am.recordSession('s1', am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').index);
  am.updateAccountTokens(0, { accessToken: 't-2' });

  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home');

  // Fail again without a NEW recovery event: must not spuriously pull back a
  // second time off the same already-evaluated watermark.
  am.accounts[0].status = 'error';
  const again = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(again.name, 'fallback');
});

test('preserveSessionAffinity:false is untouched by the recovery path', () => {
  const am = new AccountManager([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('other', { priority: 20, costTier: 0 }),
  ], 0.98, {
    distributeSessions: true,
    routingPolicy: { mode: 'dynamic', preserveSessionAffinity: false },
  });
  am.recordSession('s1', 0);
  am.accounts[0].status = 'error';
  am.recordSession('s1', am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').index);
  am.updateAccountTokens(0, { accessToken: 't-2' });
  // With affinity off, the session-pin branch is skipped entirely, so recovery
  // has nothing to pull back INTO — best-available runs on every request
  // regardless, same as it always did.
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home');
});

test('priority-first mode needs no fix: the very next request re-checks priority live', () => {
  // This is the actual workaround Eddie approved live (mode switched to
  // priority-first). Confirms it was never broken — no recovery plumbing
  // needed on this path.
  const am = new AccountManager([
    oauth('home', { priority: 0, costTier: 0 }),
    oauth('fallback', { priority: 20, costTier: 0 }),
  ], 0.98, { routingPolicy: { mode: 'priority-first' } });
  am.recordSession('s1', 0);
  am.accounts[0].status = 'error';
  const during = am.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(during.name, 'fallback');
  am.recordSession('s1', during.index);

  am.accounts[0].status = 'active'; // no recovery plumbing exercised at all
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'home',
    'betterExists re-derives priority order on every call — recovery is immediate by construction');
});
