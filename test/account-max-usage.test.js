import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

// The case the feature exists for: one account in a fleet is allowed to spend
// only part of its quota, and must receive nothing past that point.
function fleet(maxUsage) {
  const am = new AccountManager([oauth('a'), oauth('capped', { maxUsage })], 0.98);
  return am;
}

function setQuota(account, q) {
  Object.assign(account.quota, q);
}

// ── capFor ───────────────────────────────────────────────────

test('a bare number caps every bucket, a map caps the listed ones', () => {
  const am = fleet(0.6);
  const capped = am.accounts[1];
  for (const b of ['unified5h', 'unified7d', 'unified7dFable', 'tokens']) {
    assert.equal(am.capFor(b, capped), 0.6, b);
  }

  const am2 = fleet({ unified7d: 0.6, unified7dFable: 0.8 });
  const c2 = am2.accounts[1];
  assert.equal(am2.capFor('unified7d', c2), 0.6);
  assert.equal(am2.capFor('unified7dFable', c2), 0.8);
  // Not listed and no `default`: uncapped. A cap is only ever what was asked for.
  assert.equal(am2.capFor('unified5h', c2), null);
  // An account with no maxUsage at all is uncapped everywhere.
  assert.equal(am2.capFor('unified7d', am2.accounts[0]), null);
});

test('`default` covers the buckets a map does not list', () => {
  const am = fleet({ default: 0.5, unified7dFable: 0.8 });
  const c = am.accounts[1];
  assert.equal(am.capFor('unified5h', c), 0.5);
  assert.equal(am.capFor('unified7dFable', c), 0.8);
});

// ── capExceeded: model scoping ───────────────────────────────

test('a family cap stops that family and leaves the others alone', () => {
  const am = fleet({ unified7dFable: 0.8 });
  const capped = am.accounts[1];
  setQuota(capped, { unified5h: 0.1, unified7d: 0.2, unified7dFable: 0.8 });

  assert.equal(am.capExceeded(capped, FABLE), 'unified7dFable');
  assert.equal(am.capExceeded(capped, OPUS), null);      // Opus is metered elsewhere
  assert.equal(am.capExceeded(capped, null), null);
});

test('the session and weekly caps stop every model', () => {
  const am = fleet({ unified5h: 0.6, unified7d: 0.6 });
  const capped = am.accounts[1];

  setQuota(capped, { unified5h: 0.6, unified7d: 0.1 });
  assert.equal(am.capExceeded(capped, OPUS), 'unified5h');
  assert.equal(am.capExceeded(capped, FABLE), 'unified5h');

  setQuota(capped, { unified5h: 0.1, unified7d: 0.61 });
  assert.equal(am.capExceeded(capped, OPUS), 'unified7d');
  // Family spend meters into the shared weekly too (#175), so a shared cap that
  // Fable could walk past would not be a cap. This is where a cap parts company
  // with switchThreshold, which gates on the governing bucket alone.
  assert.equal(am.capExceeded(capped, FABLE), 'unified7d');
});

test('the shared and family caps both apply to a family request', () => {
  const am = fleet({ unified7d: 0.6, unified7dFable: 0.8 });
  const capped = am.accounts[1];

  // Under both: serving.
  setQuota(capped, { unified7d: 0.5, unified7dFable: 0.7 });
  assert.equal(am.capExceeded(capped, FABLE), null);

  // Family bucket alone is over: Fable stops, Opus keeps going.
  setQuota(capped, { unified7d: 0.5, unified7dFable: 0.8 });
  assert.equal(am.capExceeded(capped, FABLE), 'unified7dFable');
  assert.equal(am.capExceeded(capped, OPUS), null);

  // Shared bucket alone is over: everything stops, Fable included.
  setQuota(capped, { unified7d: 0.6, unified7dFable: 0.1 });
  assert.equal(am.capExceeded(capped, FABLE), 'unified7d');
  assert.equal(am.capExceeded(capped, OPUS), 'unified7d');
});

// An unreported family bucket used to fall back to the shared VALUE while being
// compared against the FAMILY cap — 60% of the shared weekly read as under an
// 80% Fable cap, and the request went through.
test('an unreported family bucket does not escape the shared cap', () => {
  const am = fleet({ unified7d: 0.6, unified7dFable: 0.8 });
  const capped = am.accounts[1];
  setQuota(capped, { unified7d: 0.6, unified7dFable: null });
  assert.equal(am.capExceeded(capped, FABLE), 'unified7d');
});

// The cap is a ceiling, not a target: at exactly the configured level the
// account is done, matching how switchThreshold reads (>=).
test('the cap binds at the configured level, not past it', () => {
  const am = fleet({ unified7d: 0.6 });
  const capped = am.accounts[1];
  setQuota(capped, { unified7d: 0.59 });
  assert.equal(am.capExceeded(capped, OPUS), null);
  setQuota(capped, { unified7d: 0.6 });
  assert.equal(am.capExceeded(capped, OPUS), 'unified7d');
});

test('a window that has already reset is not capped on a stale reading', () => {
  const am = fleet({ unified7d: 0.6 });
  const capped = am.accounts[1];
  setQuota(capped, { unified7d: 0.9, unified7dReset: Date.now() - 1000 });
  assert.equal(am.capExceeded(capped, OPUS), null);
  assert.equal(capped.quota.unified7d, null);
});

// ── selection: zero requests past the cap ────────────────────

test('a capped account is not selected and says why', () => {
  const am = fleet({ unified7d: 0.6 });
  const capped = am.accounts[1];
  setQuota(capped, { unified7d: 0.7 });
  am.currentIndex = 1;

  assert.equal(am.unavailableReason(capped, OPUS), 'capped');
  assert.equal(am.getActiveAccount(null, OPUS).name, 'a');
});

// The whole point of the setting. switchThreshold is a preference the
// exhausted-fleet probe deliberately overrides; a budget is not.
test('the exhausted-fleet probe does not override a cap', () => {
  const am = fleet({ unified7d: 0.6 });
  const [normal, capped] = am.accounts;
  setQuota(normal, { unified7d: 0.99 });      // over the switch threshold
  setQuota(capped, { unified7d: 0.7 });       // over its own cap

  // Every account is out: the normal one may still be probed, the capped one
  // must not be. With the normal account excluded, nothing is left at all.
  assert.equal(am.getActiveAccount(new Set([normal.index]), OPUS), null);
});

test('a capped account still serves the models its cap does not meter', () => {
  const am = fleet({ unified7dFable: 0.8 });
  const capped = am.accounts[1];
  setQuota(capped, { unified7dFable: 0.9 });
  am.currentIndex = 1;

  assert.equal(am.getActiveAccount(null, FABLE).name, 'a');
  // Selection stays on whichever account it just moved to, so put it back
  // before asking the other question (as the Fable-exhaustion test does).
  am.currentIndex = 1;
  assert.equal(am.getActiveAccount(null, OPUS).name, 'capped');
});

test("an advisor model's cap is checked too", () => {
  const am = fleet({ unified7dFable: 0.8 });
  const capped = am.accounts[1];
  setQuota(capped, { unified7dFable: 0.85 });
  // Executing Opus while advising with Fable still touches the capped bucket.
  assert.equal(am.unavailableReason(capped, OPUS, FABLE), 'advisor-capped');
});

test('an uncapped fleet behaves exactly as before', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  setQuota(am.accounts[0], { unified7d: 0.7, unified7dFable: 0.9 });
  assert.equal(am.capExceeded(am.accounts[0], FABLE), null);
  assert.equal(am.unavailableReason(am.accounts[0], FABLE), null);
});

test('the cap is visible in status output', () => {
  const am = fleet({ unified7d: 0.6 });
  setQuota(am.accounts[1], { unified7d: 0.7 });
  const status = am.getStatus();
  assert.deepEqual(status.accounts[1].maxUsage, { unified7d: 0.6 });
  assert.equal(status.accounts[1].unavailable, 'capped');
  assert.equal(status.accounts[0].maxUsage, null);
});

// ── the pinned path ──────────────────────────────────────────

// A pinned request never enters the selection walk, so the cap has to be
// enforced where the pin is resolved. Without this, `TC_ACCT` (or a
// /tc-acct/<name> URL) would spend straight past a budget.
test('a pinned request to a capped account reaches no upstream at all', async () => {
  const http = await import('node:http');
  const { createProxyServer } = await import('../src/server.js');
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));

  const am = new AccountManager([oauth('alpha'), oauth('beta', { maxUsage: { unified7d: 0.6 } })], 0.98);
  setQuota(am.accounts[1], { unified7d: 0.7 });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstream.address().port}`,
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));

  try {
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/tc-acct/beta/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 429);      // the exhausted answer, as for a spent pin
    assert.deepEqual(seen, []);         // and nothing was sent, to beta or anyone else
  } finally {
    proxy.close();
    upstream.close();
  }
});
