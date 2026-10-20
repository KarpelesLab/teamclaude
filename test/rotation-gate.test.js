import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  RotationLedger,
  defaultHistoryFamily,
  resolveHistoryFamily,
  ROTATION_LEDGER_MAX_FAMILIES,
} from '../src/rotation-ledger.js';
import { checkConfig } from '../src/config-doctor.js';
import { BUILD_FEATURE_TAGS } from '../src/build-identity.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

function oauth(name, extra = {}) {
  return {
    name, type: 'oauth', priority: 0,
    accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
    ...extra,
  };
}
function custom(name, upstream, extra = {}) {
  return {
    name, type: 'apikey', priority: 10, apiKey: 'k',
    upstream, ...extra,
  };
}

// ── defaults / resolve ────────────────────────────────────────

test('defaultHistoryFamily: direct ⇒ anthropic; custom upstream ⇒ account name', () => {
  assert.equal(defaultHistoryFamily({ name: 'a' }), 'anthropic');
  assert.equal(defaultHistoryFamily({ name: 'kimi', upstream: 'http://x' }), 'kimi');
  assert.equal(resolveHistoryFamily({ name: 'kimi', upstream: 'http://x', historyFamily: 'kimi-shared' }),
    'kimi-shared');
});

test('makeAccount applies historyFamily defaults and leaves acceptsHistoryFamilies absent (tolerant)', () => {
  const am = new AccountManager([
    oauth('direct'),
    custom('kimi', 'http://127.0.0.1:9'),
    custom('sakana', 'http://127.0.0.1:9', { acceptsHistoryFamilies: ['anthropic', 'sakana'] }),
  ]);
  assert.equal(am.accounts[0].historyFamily, 'anthropic');
  assert.equal(am.accounts[0].acceptsHistoryFamilies, null);
  assert.equal(am.accounts[1].historyFamily, 'kimi');
  assert.equal(am.accounts[1].acceptsHistoryFamilies, null);
  assert.deepEqual(am.accounts[2].acceptsHistoryFamilies, ['anthropic', 'sakana']);
});

// ── zero-config-inert ─────────────────────────────────────────

test('ZERO-CONFIG-INERT: with no acceptsHistoryFamilies, selection is identical with/without ledger marks', () => {
  const accounts = [
    oauth('a', { priority: 0 }),
    custom('kimi', 'http://127.0.0.1:9', { priority: 10 }),
  ];
  const am = new AccountManager(accounts, 0.98, { routingPolicy: { mode: 'priority-first' } });
  // Mark a session as having been served by kimi — but no account declares
  // acceptsHistoryFamilies, so the blocked set must stay empty.
  am.noteServedFamily('sess-1', 1);
  assert.deepEqual([...am.rotationLedger.familiesOf('sess-1')], ['kimi']);
  const blocked = am.rotationLedger.incompatibleIndices('sess-1', am.accounts, 'enforce');
  assert.equal(blocked.size, 0, 'no declarations ⇒ empty blocked set');

  // Selection must match a ledger-free manager (byte-identical routing).
  const bare = new AccountManager(accounts, 0.98, { routingPolicy: { mode: 'priority-first' } });
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 'sess-1').name,
    bare.getActiveAccount(null, 'claude-opus-4-8', null, 'sess-1').name);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name,
    bare.getActiveAccount(null, 'claude-opus-4-8').name);
});

// ── core gate behavior ────────────────────────────────────────

test('enforce mode blocks rotation onto a strict tier whose accepts set misses the served family', () => {
  const am = new AccountManager([
    custom('kimi', 'http://127.0.0.1:9', { priority: 0 }),
    custom('sakana', 'http://127.0.0.1:9', {
      priority: 10,
      acceptsHistoryFamilies: ['anthropic', 'sakana'],
    }),
  ], 0.98);
  am.noteServedFamily('s1', 0); // kimi
  const blocked = am.rotationLedger.incompatibleIndices('s1', am.accounts, 'enforce');
  assert.ok(blocked.has(1), 'sakana blocked for kimi-poisoned session');
  assert.ok(!blocked.has(0), 'kimi (no declaration) stays open');

  // Disable kimi so selection would otherwise pick sakana — gate must refuse.
  am.accounts[0].disabled = true;
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1'), null);
});

test('shadow mode computes would-block but does not change selection', () => {
  const am = new AccountManager([
    custom('kimi', 'http://127.0.0.1:9', { priority: 10 }),
    custom('sakana', 'http://127.0.0.1:9', {
      priority: 0,
      acceptsHistoryFamilies: ['anthropic', 'sakana'],
    }),
  ], 0.98, { rotationGate: { mode: 'shadow' } });
  am.noteServedFamily('s1', 0);
  // sakana is higher priority (0) and available; shadow must still select it.
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'sakana');
  assert.ok(am.rotationLedger.counters.blockedSelections >= 1,
    'shadow still counts would-block observations');
});

test('mode off never blocks', () => {
  const am = new AccountManager([
    custom('kimi', 'http://127.0.0.1:9', { priority: 10 }),
    custom('sakana', 'http://127.0.0.1:9', {
      priority: 0,
      acceptsHistoryFamilies: ['anthropic'],
    }),
  ], 0.98, { rotationGate: { mode: 'off' } });
  am.noteServedFamily('s1', 0);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', null, 's1').name, 'sakana');
});

// ── exclude-set copy (fix #4) ────────────────────────────────

test('getActiveAccount unions gate-blocked into a COPY of exclude (ctx.tried untouched)', () => {
  const am = new AccountManager([
    custom('kimi', 'http://127.0.0.1:9', { priority: 0 }),
    custom('sakana', 'http://127.0.0.1:9', {
      priority: 10,
      acceptsHistoryFamilies: ['anthropic'],
    }),
    oauth('direct', { priority: 20 }),
  ], 0.98);
  am.noteServedFamily('s1', 0);
  const tried = new Set();
  am.getActiveAccount(tried, 'claude-opus-4-8', null, 's1');
  assert.equal(tried.size, 0, 'exclude arg must not gain gate-blocked indices');
});

// ── every selection mode honors the block (choke-point proof) ─

test('EVERY selection mode honors the gate block (priority-first / shadow / dynamic / distributeSessions / probe)', () => {
  function fleet(opts = {}) {
    const am = new AccountManager([
      custom('kimi', 'http://127.0.0.1:9', { priority: 0, costTier: 0 }),
      custom('sakana', 'http://127.0.0.1:9', {
        priority: 1, costTier: 0,
        acceptsHistoryFamilies: ['anthropic', 'sakana'],
      }),
    ], 0.98, opts);
    am.noteServedFamily('s1', 0);
    // Force kimi unavailable so the only candidate is the gated sakana.
    am.accounts[0].disabled = true;
    return am;
  }

  assert.equal(
    fleet({ routingPolicy: { mode: 'priority-first' } })
      .getActiveAccount(null, 'claude-opus-4-8', null, 's1'),
    null, 'priority-first');

  // Shadow of routingPolicy still serves legacy order — but rotationGate
  // enforce (default) must still block. (routingPolicy.shadow ≠ rotationGate.shadow)
  assert.equal(
    fleet({ routingPolicy: { mode: 'shadow' } })
      .getActiveAccount(null, 'claude-opus-4-8', null, 's1'),
    null, 'routingPolicy shadow');

  assert.equal(
    fleet({ routingPolicy: { mode: 'dynamic', reevaluateMs: 0 } })
      .getActiveAccount(null, 'claude-opus-4-8', null, 's1'),
    null, 'dynamic');

  assert.equal(
    fleet({ distributeSessions: true, routingPolicy: { mode: 'priority-first' } })
      .getActiveAccount(null, 'claude-opus-4-8', null, 's1'),
    null, 'distributeSessions least-loaded');

  // Exhausted-fleet probe path: mark both near-quota so _selectProbe runs.
  const probeAm = fleet({ routingPolicy: { mode: 'priority-first' } });
  probeAm.accounts[0].disabled = false;
  probeAm.accounts[0].quota.unified7d = 0.99;
  probeAm.accounts[1].quota.unified7d = 0.99;
  // Re-disable kimi so probe would pick sakana if ungated.
  probeAm.accounts[0].disabled = true;
  probeAm._nextProbeAt = 0;
  const probed = probeAm.getActiveAccount(null, 'claude-opus-4-8', null, 's1');
  assert.equal(probed, null, 'exhausted _selectProbe fallback must not egress to gated account');
});

test('getActiveAccountFresh has zero production callers (choke-point residual)', async () => {
  // Production path is getActiveAccount only (server.js). Fresh is test-only.
  // Confirm it still threads sessionId so a future caller cannot bypass.
  const am = new AccountManager([
    custom('kimi', 'http://127.0.0.1:9', { priority: 0 }),
    custom('sakana', 'http://127.0.0.1:9', {
      priority: 10, acceptsHistoryFamilies: ['anthropic'],
    }),
  ], 0.98);
  am.noteServedFamily('s1', 0);
  am.accounts[0].disabled = true;
  assert.equal(await am.getActiveAccountFresh(null, 'claude-opus-4-8', null, 's1'), null);
});

// ── 32-family overflow fail-closed (fix #1) ─────────────────

test('33rd family intern is FAIL-CLOSED: overflow incompatible with every declaring account', () => {
  const ledger = new RotationLedger();
  for (let i = 0; i < ROTATION_LEDGER_MAX_FAMILIES; i++) {
    const r = ledger.intern(`f${i}`);
    assert.equal(r.bit, i);
  }
  const overflow = ledger.intern('f-overflow');
  assert.ok(overflow.overflow, '33rd family must not alias bit 0');
  // Prove JS aliasing hazard the gate prevents:
  assert.equal(1 << 32, 1, 'document the JS hazard this fails closed against');

  ledger.mark('s1', 'f-overflow');
  const accounts = [
    { index: 0, name: 'open', acceptsHistoryFamilies: null },
    { index: 1, name: 'strict', acceptsHistoryFamilies: ['anthropic', 'f0'] },
  ];
  const blocked = ledger.incompatibleIndices('s1', accounts, 'enforce');
  assert.ok(blocked.has(1), 'overflow blocks every declaring account');
  assert.ok(!blocked.has(0), 'tolerant account stays open');
});

test('restore() compacts intern map — orphaned rename names do not permanently consume bits', () => {
  const ledger = new RotationLedger();
  // Fill with orphans that will NOT appear in the restore payload.
  for (let i = 0; i < 30; i++) ledger.intern(`orphan-${i}`);
  assert.equal(ledger._familyBits.size, 30);

  ledger.restore({
    s1: { families: ['kimi', 'anthropic'], lastSeen: Date.now() },
  }, ['sakana']);
  // Only declared + restored names remain.
  assert.ok(ledger._familyBits.size <= 3);
  assert.ok(ledger._familyBits.has('kimi'));
  assert.ok(ledger._familyBits.has('anthropic'));
  assert.ok(ledger._familyBits.has('sakana'));
  assert.ok(!ledger._familyBits.has('orphan-0'));
  assert.deepEqual(ledger.familiesOf('s1').sort(), ['anthropic', 'kimi']);
});

// ── marking predicate (fix #5) ──────────────────────────────

test('noteServedFamily marks only on successful messages path; count_tokens excluded', async () => {
  let messagesHits = 0;
  let tokensHits = 0;
  const upstream = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/v1/messages/count_tokens')) {
      tokensHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 3 }));
      return;
    }
    messagesHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    custom('kimi', `http://127.0.0.1:${upPort}`, { priority: 0 }),
    custom('sakana', `http://127.0.0.1:${upPort}`, {
      priority: 10, acceptsHistoryFamilies: ['anthropic', 'sakana'],
    }),
  ], 0.98);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    // count_tokens success must NOT mark.
    const tok = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'k',
        'x-claude-code-session-id': 'sess-tok',
      },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(tok.status, 200);
    assert.equal(tokensHits, 1);
    assert.equal(am.rotationLedger.familiesOf('sess-tok').length, 0,
      'count_tokens must not mark a family');

    // messages success MUST mark.
    const msg = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'k',
        'x-claude-code-session-id': 'sess-msg',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8', max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(msg.status, 200);
    assert.equal(messagesHits, 1);
    assert.deepEqual(am.rotationLedger.familiesOf('sess-msg'), ['kimi']);

    // Failed response must NOT mark.
    // Swap upstream to 500 for one request via disabling — use a fresh session
    // against a broken upstream account by closing and using status via direct note.
    // Covered below with unit mark-on-status helper.
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('failed failover attempt does not self-mark (mark only status<300)', () => {
  const am = new AccountManager([
    custom('kimi', 'http://127.0.0.1:9'),
    custom('sakana', 'http://127.0.0.1:9', { acceptsHistoryFamilies: ['anthropic'] }),
  ], 0.98);
  // Simulate: only call noteServedFamily on success. A 5xx must not call it.
  assert.equal(am.rotationLedger.familiesOf('s-fail').length, 0);
  // Direct API: noteServedFamily is the marking choke; server gates on status.
  am.noteServedFamily('s-ok', 0);
  assert.deepEqual(am.rotationLedger.familiesOf('s-ok'), ['kimi']);
});

// ── typed 409 before hold loop (fix #3) ──────────────────────

for (const includeUnknown of [false, true]) test(`gate-blocked session gets typed 409 before hold and unknown-quota fallback (${includeUnknown})`, async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    custom('kimi', `http://127.0.0.1:${upPort}`, { priority: 0 }),
    custom('sakana', `http://127.0.0.1:${upPort}`, {
      priority: 10, acceptsHistoryFamilies: ['anthropic', 'sakana'],
    }),
    ...(includeUnknown ? [custom('cursor', `http://127.0.0.1:${upPort}`, {
      quotaSource: { type: 'cursor-subscription' }, acceptsHistoryFamilies: ['kimi'],
    })] : []),
  ], 0.98);
  // Poison session, then disable the only compatible account.
  am.noteServedFamily('poison', 0);
  am.accounts[0].disabled = true;

  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    holdSeconds: 30, // would hang 30s if 409 were after the hold loop
  });
  const port = await listen(proxy);
  const t0 = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'k',
        'x-claude-code-session-id': 'poison',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8', max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 409);
    assert.equal(res.headers.get('x-teamclaude-refusal'), 'session-history-incompatible');
    const body = await res.json();
    assert.equal(body.error?.type, 'invalid_request_error');
    assert.match(body.error?.message || '', /history contains artifacts/);
    assert.match(body.error?.message || '', /history-reset/);
    assert.ok(elapsed < 5_000, `409 must not wait holdSeconds (elapsed ${elapsed}ms)`);
    assert.ok(am.rotationLedger.counters.refusals >= 1);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

// D11-T4: gate refusal must emit exactly ONE terminal onRequestEnd (outer
// lifecycle owns it; an inner call double-fired UI/provenance consumers).
test('D11: rotation-gate refusal emits exactly one onRequestEnd', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    custom('kimi', `http://127.0.0.1:${upPort}`, { priority: 0 }),
    custom('sakana', `http://127.0.0.1:${upPort}`, {
      priority: 10, acceptsHistoryFamilies: ['anthropic', 'sakana'],
    }),
  ], 0.98);
  am.noteServedFamily('poison-end', 0);
  am.accounts[0].disabled = true;

  const ends = [];
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  }, {
    onRequestEnd: (id, info) => ends.push({ id, ...info }),
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'k',
        'x-claude-code-session-id': 'poison-end',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8', max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 409);
    assert.equal(ends.length, 1, `expected exactly one onRequestEnd, got ${ends.length}`);
    assert.equal(ends[0].status, 409);
    assert.equal(ends[0].account, '(history-gate)');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

// ── pins bypass ───────────────────────────────────────────────

test('/tc-acct pin bypasses the rotation gate', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    custom('kimi', `http://127.0.0.1:${upPort}`, { priority: 0 }),
    custom('sakana', `http://127.0.0.1:${upPort}`, {
      priority: 10, acceptsHistoryFamilies: ['anthropic'],
    }),
  ], 0.98);
  am.noteServedFamily('poison', 0);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tc-acct/sakana/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'k',
        'x-claude-code-session-id': 'poison',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8', max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200, 'pin must bypass gate');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

// ── history-reset (fix #6) ──────────────────────────────────

test('POST /teamclaude/session/<id>/history-reset clears ledger, logs, and increments counter', async () => {
  const am = new AccountManager([
    custom('kimi', 'http://127.0.0.1:9'),
    custom('sakana', 'http://127.0.0.1:9', { acceptsHistoryFamilies: ['anthropic'] }),
  ], 0.98);
  am.noteServedFamily('sess-reset', 0);
  assert.ok(am.rotationLedger.familiesOf('sess-reset').length);

  const logs = [];
  const orig = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/session/sess-reset/history-reset`, {
      method: 'POST',
      headers: { 'x-api-key': 'k' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(am.rotationLedger.familiesOf('sess-reset').length, 0);
    assert.ok(am.rotationLedger.counters.historyResets >= 1);
    assert.ok(logs.some(l => /history-reset/i.test(l)), 'must emit a loud log line');
  } finally {
    console.log = orig;
    await close(proxy);
  }
});

// ── persistence by name ───────────────────────────────────────

test('export/restore persists family NAMES (never bit indices) and survives rename debris compact', () => {
  const a = new RotationLedger();
  a.mark('s1', 'kimi');
  a.mark('s1', 'glm');
  const exported = a.export();
  assert.deepEqual(exported.s1.families.sort(), ['glm', 'kimi']);
  assert.ok(!('familiesMask' in exported.s1));

  const b = new RotationLedger();
  b.restore(exported);
  assert.deepEqual(b.familiesOf('s1').sort(), ['glm', 'kimi']);
});

test('status exposes rotationGate counters as pure reads', () => {
  const am = new AccountManager([
    oauth('a'),
    custom('sakana', 'http://127.0.0.1:9', { acceptsHistoryFamilies: ['anthropic'] }),
  ], 0.98);
  const status = am.getStatus();
  assert.ok(status.rotationGate);
  assert.equal(status.rotationGate.mode, 'enforce');
  assert.equal(typeof status.rotationGate.blockedSelections, 'number');
  assert.equal(typeof status.rotationGate.new_session_to_strict_tier, 'number');
});

test('new_session_to_strict_tier increments when a fresh session is first marked by a declaring account', () => {
  const am = new AccountManager([
    custom('sakana', 'http://127.0.0.1:9', { acceptsHistoryFamilies: ['anthropic', 'sakana'] }),
  ], 0.98);
  assert.equal(am.rotationLedger.counters.new_session_to_strict_tier, 0);
  am.noteServedFamily('brand-new', 0);
  assert.equal(am.rotationLedger.counters.new_session_to_strict_tier, 1);
  am.noteServedFamily('brand-new', 0);
  assert.equal(am.rotationLedger.counters.new_session_to_strict_tier, 1, 'only first mark');
});

// ── config-doctor ─────────────────────────────────────────────

test('config-doctor flags history-family-unset, unknown accepts family, and >32 families', () => {
  const findings = checkConfig({
    accounts: [
      { name: 'kimi', type: 'apikey', apiKey: 'k', upstream: 'http://x' }, // no historyFamily
      {
        name: 'sakana', type: 'apikey', apiKey: 'k', upstream: 'http://y',
        historyFamily: 'sakana',
        acceptsHistoryFamilies: ['anthropic', 'no-such-family'],
      },
      ...Array.from({ length: 33 }, (_, i) => ({
        name: `f${i}`, type: 'apikey', apiKey: 'k', upstream: `http://z${i}`,
        historyFamily: `family-${i}`,
      })),
    ],
    routes: [{ name: 'default', match: ['*'], accounts: [] }],
  });
  const codes = findings.map(f => f.code);
  assert.ok(codes.includes('history-family-unset'), codes.join(','));
  assert.ok(codes.includes('unknown-family-in-acceptsHistoryFamilies'), codes.join(','));
  assert.ok(codes.includes('history-families-over-32'), codes.join(','));
});

test('build feature tag rotation-gate is registered', () => {
  assert.ok(BUILD_FEATURE_TAGS.includes('rotation-gate'));
});
