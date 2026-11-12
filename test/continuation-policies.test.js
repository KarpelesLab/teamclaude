import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  keyHashOf, offerKeyRef, parseContinuationPolicies, matchContinuationPolicy,
  recordSeatRejection, CG_SEAT_POLICY_ROOT_PARAGRAPH,
} from '../src/client-routes.js';

// Owner-root continuation policies (IPM fork, AI-1903): the rendered
// `continuationPolicies` config overrides the legacy per-request
// x-teamclaude-seat-policy header for every account of the key's route, offers
// are scoped by root revision and the C9 keyRef, force hops are capped at 8
// and re-check the key before each one, and the C7 owner-wide paragraph rides
// the actionable multi-seat 429 only under `x-teamclaude-cg-contract: root-v1`.

const HOUR = 3600_000;
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sec = (ms) => String(Math.floor(ms / 1000));

const ADMIN = 'admin-key';
const KEYS = { amy: 'amy-key', ben: 'ben-key', carol: 'carol-key' };
const oauth = (name) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + HOUR });

const ROUTES = [
  { name: 's1+s2+s3', clients: ['amy', 'carol'], accounts: ['qa', 'qb', 'qc'] },
  { name: 'seat-r', clients: ['ben'], accounts: ['qr'] },
];

const root = (client, key, mode, revision) => ({ client, keyHash: keyHashOf(key), mode, revision });

const okBody = JSON.stringify({ id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
const ok = (res, extra = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...extra });
  res.end(okBody);
};
const spent = (res) => {
  res.writeHead(429, {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d-status': 'rejected',
    'anthropic-ratelimit-unified-7d-reset': sec(Date.now() + HOUR),
  });
  res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
};

async function withGateway({ handler = (_who, _req, res) => ok(res), routes = ROUTES, accounts = null, policies = undefined, policyErrors = undefined } = {}, fn) {
  const seen = [];
  const attempts = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const who = String(req.headers.authorization || '').replace(/^Bearer t-/, '');
    seen.push(who);
    attempts.push({ who, headers: req.headers });
    handler(who, req, res);
  });
  const upPort = await listen(upstream);
  const list = accounts ?? [oauth('qa'), oauth('qb'), oauth('qc'), oauth('qr')];
  const am = new AccountManager(list, 0.98, {
    clientRoutes: routes,
    continuationPolicies: policies,
    continuationPolicyErrors: policyErrors,
    distributeSessions: true,
    refreshFn: async () => { throw new Error('no refresh'); },
  });
  const config = {
    proxy: { apiKey: ADMIN, clientKeys: Object.entries(KEYS).map(([name, key]) => ({ name, key })), requireClientRoute: true },
    upstream: `http://127.0.0.1:${upPort}`,
  };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  const send = async ({ key = KEYS.amy, session = 's-1', text = 'hello', policy, contract } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'x-claude-code-session-id': session,
        ...(policy === undefined ? {} : { 'x-teamclaude-seat-policy': policy }),
        ...(contract === undefined ? {} : { 'x-teamclaude-cg-contract': contract }),
      },
      body: JSON.stringify({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: text }] }),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* non-JSON stays raw */ }
    return { status: res.status, headers: res.headers, raw, json };
  };
  const control = async (path, key = ADMIN) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-api-key': key } });
    return { status: res.status, json: await res.json() };
  };
  try {
    await fn({ send, control, seen, attempts, am, config });
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
}

// ── parsing units ────────────────────────────────────────────────────────────

test('parseContinuationPolicies: absent, malformed, fail-safe entries and error sanitizing', () => {
  const absent = parseContinuationPolicies(undefined, undefined);
  assert.deepEqual(absent.policies, []);
  assert.deepEqual(absent.errors, []);
  assert.equal(absent.loadError, null);
  assert.equal(absent.failSafeAll, false);
  assert.equal(matchContinuationPolicy(absent, 'amy', keyHashOf('amy-key')), null, 'absent = legacy for everyone');

  const malformed = parseContinuationPolicies('oops', undefined);
  assert.equal(malformed.loadError, 'malformed_list');
  assert.equal(malformed.failSafeAll, true);
  const safe = matchContinuationPolicy(malformed, 'AMY', keyHashOf('amy-key'));
  assert.equal(safe?.mode, 'recommend', 'every client key fails safe to recommend');
  assert.equal(safe?.revision, null);
  assert.equal(matchContinuationPolicy(malformed, 'amy', null), null, 'no keyHash, no root');

  const kh = keyHashOf('amy-key');
  const parsed = parseContinuationPolicies([
    { client: 'amy', keyHash: kh, mode: 'force', revision: 'r_one', quarantine: false },
    { client: 'ben', keyHash: keyHashOf('ben-key'), mode: 'Force', revision: 'r_two' }, // bad mode
    { client: 'carol', keyHash: 'not-a-hash', mode: 'force', revision: 'r_three' },     // dropped
    { keyHash: kh, mode: 'force', revision: 'r_four' },                                  // no client: dropped
    { client: 'amy', keyHash: kh, mode: 'recommend', revision: 'r_dup' },                // duplicate: first wins
  ], [
    { client: 'carol', reason: 'stale_key', carriedForward: true },
    { reason: 'missing client' },
    'garbage',
  ]);
  assert.equal(parsed.loadError, 'malformed_entries');
  assert.equal(parsed.failSafeAll, false);
  assert.equal(parsed.policies.length, 2);
  assert.deepEqual(matchContinuationPolicy(parsed, 'amy', kh), { client: 'amy', keyHash: kh, mode: 'force', revision: 'r_one', quarantine: false });
  const ben = matchContinuationPolicy(parsed, 'ben', keyHashOf('ben-key'));
  assert.equal(ben?.mode, 'recommend', 'a bad mode fails that key safe to recommend');
  assert.equal(ben?.revision, null);
  assert.equal(matchContinuationPolicy(parsed, 'carol', keyHashOf('carol-key')), null, 'a bad keyHash entry is dropped, so carol stays legacy');
  assert.deepEqual(parsed.errors, [{ client: 'carol', reason: 'stale_key', carriedForward: true }], 'errors are shape-sanitized');
});

test('keyHashOf and offerKeyRef shapes (C1/C9)', () => {
  assert.match(keyHashOf('amy-key'), /^[0-9a-f]{64}$/);
  const ref = offerKeyRef(keyHashOf('amy-key'));
  assert.match(ref, /^[0-9a-f]{32}$/);
  assert.notEqual(ref, keyHashOf('amy-key').slice(0, 32), 'the ref is domain-separated, not a truncation');
});

// ── root behavior ────────────────────────────────────────────────────────────

test('a force root hops on every assigned account and ignores the legacy recommend header; contract header stripped', async () => {
  let qaSpent = false;
  const policies = [root('amy', 'amy-key', 'force', 'r_one')];
  await withGateway({
    policies,
    handler: (who, _req, res) => (who === 'qa' && qaSpent
      ? spent(res)
      : ok(res, { 'x-teamclaude-cg-contract': 'spoof', 'x-teamclaude-seat-policy': 'spoof' })),
  }, async ({ send, control, seen, attempts }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const forced = await send({ text: 'hello', policy: '*=recommend', contract: 'root-v1' });
    assert.equal(forced.status, 200, 'the root forces the hop despite the legacy recommend header');
    assert.equal(forced.headers.get('x-teamclaude-seat-failover'), 'from=qa;to=qb;cold-cache=true');
    assert.equal(forced.headers.get('x-teamclaude-cg-contract'), null, 'an upstream-spoofed contract header is discarded');
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
    for (const a of attempts) {
      assert.equal(a.headers['x-teamclaude-seat-policy'], undefined, 'the legacy header must not reach upstream');
      assert.equal(a.headers['x-teamclaude-cg-contract'], undefined, 'the contract header must not reach upstream');
    }
    const status = (await control('/teamclaude/status')).json;
    assert.deepEqual(status.continuationPolicies, [{ client: 'amy', mode: 'force', revision: 'r_one', quarantine: false }], 'status reports revision r_one');
  });
});

test('a recommend root ignores a cached legacy force header', async () => {
  let qaSpent = false;
  const policies = [root('amy', 'amy-key', 'recommend', 'r_two')];
  await withGateway({ policies, handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const stopped = await send({ text: 'hello', policy: '*=force' });
    assert.equal(stopped.status, 429, 'legacy force cannot revive under a recommend root');
    assert.match(stopped.json?.error?.message ?? '', /next prompt confirms/);
    assert.deepEqual(seen, ['qa', 'qa']);
    assert.equal((await send({ text: 'hello', policy: '*=force' })).status, 200, 'the confirmed continuation still works');
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
  });
});

test('a malformed policy list fails safe to recommend and never revives legacy force', async () => {
  let qaSpent = false;
  await withGateway({ policies: 'oops', handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, control, seen }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const stopped = await send({ text: 'hello', policy: '*=force' });
    assert.equal(stopped.status, 429);
    assert.match(stopped.json?.error?.message ?? '', /next prompt confirms/);
    assert.deepEqual(seen, ['qa', 'qa'], 'no hop may happen under the malformed list');
    const status = (await control('/teamclaude/status')).json;
    assert.equal(status.continuationPolicyLoadError, 'malformed_list');
    const amy = (await control('/teamclaude/status', KEYS.amy)).json;
    assert.deepEqual(amy.caller.continuationPolicy, { source: 'root', mode: 'recommend', revision: null }, 'the fail-safe reads as a recommend root');
  });
});

test('a malformed entry fails its own key safe to recommend (malformed_entries)', async () => {
  let qaSpent = false;
  const policies = [{ client: 'amy', keyHash: keyHashOf('amy-key'), mode: 'Force', revision: 'r_bad' }];
  await withGateway({ policies, handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, control, seen }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const stopped = await send({ text: 'hello', policy: '*=force' });
    assert.equal(stopped.status, 429, 'no force under a malformed entry');
    assert.deepEqual(seen, ['qa', 'qa']);
    assert.equal((await control('/teamclaude/status')).json.continuationPolicyLoadError, 'malformed_entries');
  });
});

test('force continuation is capped at 8 upstream attempts, then a non-unified 429', async () => {
  const names = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'];
  const routes = [{ name: 'ten', clients: ['amy'], accounts: names }];
  let allSpent = false;
  const policies = [root('amy', 'amy-key', 'force', 'r_cap')];
  await withGateway({
    routes,
    accounts: names.map(oauth),
    policies,
    handler: (_who, _req, res) => (allSpent ? spent(res) : ok(res)),
  }, async ({ send, seen }) => {
    assert.equal((await send({ session: 'cap-s', text: 'cap' })).status, 200);
    allSpent = true;
    const r = await send({ session: 'cap-s', text: 'cap', contract: 'root-v1' });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('x-should-retry'), 'false');
    assert.equal(r.headers.get('anthropic-ratelimit-unified-7d-reset'), null, 'no unified headers on the cap answer');
    const msg = r.json?.error?.message ?? '';
    assert.match(msg, /limit of 8 automatic continuations/, msg);
    assert.ok(!msg.includes('cg seat-policy force'), 'the cap answer never carries the C7 paragraph');
    assert.equal(seen.length, 10, `1 initial + 1 first turn + 8 hops: ${JSON.stringify(seen)}`);
    assert.deepEqual(seen.slice(1), names.slice(0, 9), 'c9 was never attempted');
  });
});

test('the 8-hop cap and per-hop key re-check also bind a rootless legacy force request', async () => {
  const names = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'];
  const routes = [{ name: 's1+s2+s3+s4+s5+s6+s7+s8+s9+s10', clients: ['amy'], accounts: names }];
  let allSpent = false;
  await withGateway({
    routes,
    accounts: names.map(oauth),
    handler: (_who, _req, res) => (allSpent ? spent(res) : ok(res)),
  }, async ({ send, seen }) => {
    assert.equal((await send({ session: 'cap-legacy', text: 'cap' })).status, 200);
    allSpent = true;
    const r = await send({ session: 'cap-legacy', text: 'cap', policy: '*=force' });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('x-should-retry'), 'false');
    assert.equal(r.headers.get('anthropic-ratelimit-unified-7d-reset'), null, 'no unified headers on the cap answer');
    assert.match(r.json?.error?.message ?? '', /limit of 8 automatic continuations/);
    assert.equal(seen.length, 10, `1 initial + 1 first turn + 8 hops: ${JSON.stringify(seen)}`);
    assert.deepEqual(seen.slice(1), names.slice(0, 9), 'c9 was never attempted');
  });
});

test('a key revoked mid-request stops admitted force hops with a non-unified 429 (E11)', async () => {
  let qaSpent = false;
  let revoke = null;
  const policies = [root('amy', 'amy-key', 'force', 'r_one')];
  await withGateway({
    policies,
    handler: (who, _req, res) => {
      if (who === 'qa' && qaSpent) {
        // The reload lands while the request is in flight: the key is gone by
        // the time its 429 has been recorded and the hop would be armed.
        revoke?.();
        spent(res);
        return;
      }
      ok(res);
    },
  }, async ({ send, seen, config }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    const orig = config.proxy.clientKeys;
    revoke = () => { config.proxy.clientKeys = []; };
    try {
      const r = await send({ text: 'hello' });
      assert.equal(r.status, 429);
      assert.equal(r.headers.get('x-should-retry'), 'false');
      assert.equal(r.headers.get('anthropic-ratelimit-unified-7d-reset'), null);
      assert.match(r.json?.error?.message ?? '', /revoked or rotated/);
      assert.deepEqual(seen, ['qa', 'qa'], 'no hop to the sibling with a revoked key');
    } finally {
      config.proxy.clientKeys = orig;
    }
  });
});

// ── offer revision fencing (AC7 / E13) ───────────────────────────────────────

const offerRecords = (am) => [...am.sessionTracker.sessions.values()].flatMap((s) => [...s.seatContinuations.values()]);

test('an offer recorded under R1 cannot authorize a continuation under R2; it is consumed and fails closed', async () => {
  let qaSpent = false;
  const policies = [root('amy', 'amy-key', 'recommend', 'r_one')];
  await withGateway({ policies, handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send, seen, am }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    assert.equal((await send({ text: 'hello' })).status, 429, 'the R1 offer is recorded');
    assert.equal(offerRecords(am).length, 1);
    assert.equal(offerRecords(am)[0].revision, 'r_one');
    assert.equal(offerRecords(am)[0].keyRef, offerKeyRef(keyHashOf('amy-key')));

    // A reload changes the root revision: the stale offer fails closed.
    am.setContinuationPolicies([root('amy', 'amy-key', 'recommend', 'r_two')], undefined);
    const again = await send({ text: 'hello' });
    assert.equal(again.status, 429, 'the R1 offer cannot authorize the continuation under R2');
    assert.deepEqual(seen, ['qa', 'qa'], 'the pre-send verdict answered without upstream');
    assert.equal(offerRecords(am).length, 1, 'the stale offer was consumed and a fresh one recorded');
    assert.equal(offerRecords(am)[0].revision, 'r_two');

    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
  });
});

test('an in-flight request recording after a revision change is a no-op (E13)', async () => {
  let qaSpent = false;
  let flip = null;
  const policies = [root('amy', 'amy-key', 'recommend', 'r_one')];
  await withGateway({
    policies,
    handler: (who, _req, res) => {
      if (who === 'qa' && qaSpent) {
        // The reload to R2 lands between this request's admission (which
        // snapshotted R1) and the answer that would record the offer.
        flip?.();
        spent(res);
        return;
      }
      ok(res);
    },
  }, async ({ send, seen, am }) => {
    assert.equal((await send({ text: 'hello' })).status, 200);
    qaSpent = true;
    flip = () => am.setContinuationPolicies([root('amy', 'amy-key', 'recommend', 'r_two')], undefined);
    const stopped = await send({ text: 'hello' });
    assert.equal(stopped.status, 429, 'the offer is still disclosed');
    assert.equal(offerRecords(am).length, 0, 'but the R1-admitted request recorded nothing under R2');
    assert.equal((await send({ text: 'hello' })).status, 429, 'with no offer the next prompt gets its own disclosure');
    assert.equal(offerRecords(am).length, 1);
    assert.equal(offerRecords(am)[0].revision, 'r_two');
    assert.equal((await send({ text: 'hello' })).status, 200);
    assert.deepEqual(seen, ['qa', 'qa', 'qb']);
  });
});

// ── the C7 paragraph and the contract header (AC6) ───────────────────────────

test('the C7 paragraph rides the actionable multi-seat 429 only with the contract header', async () => {
  let qaSpent = false;
  await withGateway({ handler: (who, _req, res) => (who === 'qa' && qaSpent ? spent(res) : ok(res)) }, async ({ send }) => {
    // Two conversations, both pinned on qa before it spends out.
    assert.equal((await send({ text: 'hello', session: 's-plain' })).status, 200);
    assert.equal((await send({ text: 'hello', session: 's-gated' })).status, 200);
    assert.equal((await send({ text: 'hello', session: 's-v2' })).status, 200);
    qaSpent = true;
    const plain = await send({ text: 'hello', session: 's-plain' });
    assert.equal(plain.status, 429);
    assert.ok(!(plain.json?.error?.message ?? '').includes('cg seat-policy force'), 'no header: today\'s text');

    const gated = await send({ text: 'hello', session: 's-gated', contract: 'root-v1' });
    assert.equal(gated.status, 429);
    const msg = gated.json?.error?.message ?? '';
    assert.ok(msg.includes(CG_SEAT_POLICY_ROOT_PARAGRAPH), `the verbatim paragraph is missing: ${msg}`);
    assert.ok(msg.includes('next prompt confirms'), 'the paragraph extends the existing offer');

    const other = await send({ text: 'hello', session: 's-v2', contract: 'root-v2' });
    assert.equal(other.status, 429);
    assert.ok(!(other.json?.error?.message ?? '').includes('cg seat-policy force'), 'an unknown contract version must not unlock the paragraph');
  });
});

test('single-seat and no-candidate 429s never carry the C7 paragraph, header or not', async () => {
  let allSpent = false;
  await withGateway({ handler: (_who, _req, res) => (allSpent ? spent(res) : ok(res)) }, async ({ send, am }) => {
    // Single seat: ben's route has one account.
    assert.equal((await send({ key: KEYS.ben, text: 'hello' })).status, 200);
    allSpent = true;
    const single = await send({ key: KEYS.ben, text: 'hello', contract: 'root-v1' });
    assert.equal(single.status, 429);
    assert.ok(!(single.json?.error?.message ?? '').includes('cg seat-policy force'), 'a single seat must not imply force');

    // Multi-seat with no servable candidate: every sibling recorded spent.
    allSpent = false;
    assert.equal((await send({ text: 'multi', session: 's-multi' })).status, 200);
    for (const name of ['qa', 'qb', 'qc']) {
      recordSeatRejection(am.accounts.find((a) => a.name === name), {
        'anthropic-ratelimit-unified-7d-status': 'rejected',
        'anthropic-ratelimit-unified-7d-reset': sec(Date.now() + HOUR),
      }, 'claude-opus-4-1');
    }
    const none = await send({ text: 'multi', session: 's-multi', contract: 'root-v1' });
    assert.equal(none.status, 429);
    const msg = none.json?.error?.message ?? '';
    assert.match(msg, /no other account on this seat can serve now/, msg);
    assert.ok(!msg.includes('cg seat-policy force'), 'no candidate: force must not be implied');
  });
});

// ── status (C5) ──────────────────────────────────────────────────────────────

test('status: capabilities always, admin fields for the operator only, caller policy per key, no keyHash anywhere', async () => {
  const policies = [root('amy', 'amy-key', 'force', 'r_one')];
  const policyErrors = [{ client: 'carol', reason: 'stale_key', carriedForward: true }];
  await withGateway({ policies, policyErrors }, async ({ control }) => {
    const admin = (await control('/teamclaude/status')).json;
    assert.deepEqual(admin.capabilities, { continuationPolicies: 1, workerIdentity: false });
    assert.deepEqual(admin.continuationPolicies, [{ client: 'amy', mode: 'force', revision: 'r_one', quarantine: false }]);
    assert.deepEqual(admin.continuationPolicyErrors, [{ client: 'carol', reason: 'stale_key', carriedForward: true }]);
    assert.equal(admin.continuationPolicyLoadError, null);
    assert.equal(admin.caller.continuationPolicy, undefined, 'the operator has no caller policy');
    assert.ok(!JSON.stringify(admin).includes(keyHashOf('amy-key')), 'the keyHash leaked into status');

    const amy = (await control('/teamclaude/status', KEYS.amy)).json;
    assert.deepEqual(amy.capabilities, { continuationPolicies: 1, workerIdentity: false });
    assert.deepEqual(amy.caller.continuationPolicy, { source: 'root', mode: 'force', revision: 'r_one' });
    assert.ok(!('continuationPolicies' in amy), 'a client key never reads the admin list');
    assert.ok(!('continuationPolicyErrors' in amy));
    assert.ok(!('continuationPolicyLoadError' in amy));
    assert.ok(!JSON.stringify(amy).includes(keyHashOf('amy-key')));

    const ben = (await control('/teamclaude/status', KEYS.ben)).json;
    assert.deepEqual(ben.caller.continuationPolicy, { source: 'legacy', mode: null, revision: null }, 'no root: legacy');
  });
});

test('status without the config fields: capabilities present, empty admin fields', async () => {
  await withGateway({}, async ({ control }) => {
    const admin = (await control('/teamclaude/status')).json;
    assert.deepEqual(admin.capabilities, { continuationPolicies: 1, workerIdentity: false });
    assert.deepEqual(admin.continuationPolicies, []);
    assert.deepEqual(admin.continuationPolicyErrors, []);
    assert.equal(admin.continuationPolicyLoadError, null);
  });
});
