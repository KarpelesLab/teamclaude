import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerFor, hasBackendQuota, fetchBackendQuota } from '../src/backend-quota.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { renderStatus } from '../src/status-renderer.js';

const DS = 'https://api.deepseek.com/anthropic';
const backend = (name, upstream) => ({
  name, type: 'oauth', accessToken: 't-' + name, expiresAt: Date.now() + 3600_000, upstream,
});
const okFetch = (body, status = 200) => async () => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
const BALANCE = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '26.11' }] };

// ── provider lookup ──────────────────────────────────────────

test('a provider is found by host, not by account name', () => {
  assert.ok(providerFor(DS));
  assert.ok(providerFor('https://gateway.api.deepseek.com/anthropic'), 'subdomains count');
  assert.equal(providerFor('https://api.meta.ai'), null, 'a provider we know nothing about');
  assert.equal(providerFor('not a url'), null);
  assert.equal(providerFor(undefined), null);
});

test('only an account with an upstream we recognise has a backend reading', () => {
  assert.equal(hasBackendQuota(backend('a', DS)), true);
  assert.equal(hasBackendQuota(backend('b', 'https://api.meta.ai')), false);
  assert.equal(hasBackendQuota({ name: 'claude', type: 'oauth' }), false);
});

// ── fetching a reading ───────────────────────────────────────

test('a balance is normalized to label + text', async () => {
  const r = await fetchBackendQuota({ upstream: DS, credential: 'k' }, { fetchImpl: okFetch(BALANCE) });
  assert.equal(r.label, 'Balance');
  assert.equal(r.text, '$26.11');
  assert.equal(r.utilization, null);   // a dollar figure is not a fraction
  assert.ok(r.at > 0);
});

test('the request goes to the upstream origin, with the account credential', async () => {
  let seen = null;
  await fetchBackendQuota({ upstream: DS, credential: 'k' }, {
    fetchImpl: async (url, opts) => { seen = { url, auth: opts.headers.Authorization }; return okFetch(BALANCE)(); },
  });
  // Resolved against the configured upstream, so a regional host keeps working.
  assert.equal(seen.url, 'https://api.deepseek.com/user/balance');
  assert.equal(seen.auth, 'Bearer k');
});

test('an account that cannot spend says so beside the number', async () => {
  const body = { ...BALANCE, is_available: false };
  const r = await fetchBackendQuota({ upstream: DS, credential: 'k' }, { fetchImpl: okFetch(body) });
  assert.match(r.text, /\$26\.11 \(unavailable\)/);
});

test('a failure is reported, never guessed', async () => {
  const bad = await fetchBackendQuota({ upstream: DS, credential: 'k' }, { fetchImpl: okFetch({}, 401) });
  assert.equal(bad.error, 'HTTP 401');
  const junk = await fetchBackendQuota({ upstream: DS, credential: 'k' }, { fetchImpl: okFetch({ nope: 1 }) });
  assert.equal(junk.error, 'unrecognized response');
  const threw = await fetchBackendQuota({ upstream: DS, credential: 'k' }, {
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(threw.error, 'ECONNRESET');
  // Nothing to fetch at all: not an error, just no reading.
  assert.equal(await fetchBackendQuota({ upstream: 'https://api.meta.ai', credential: 'k' }), null);
});

// ── scheduling ───────────────────────────────────────────────

test('the prober reads a backend from its provider, never from the Anthropic endpoint', async () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 't-claude', expiresAt: Date.now() + 3600_000 },
    backend('deepseek', DS),
  ], 0.98);
  const anthropic = [];
  const reading = { label: 'Balance', text: '$26.11', utilization: null, at: Date.now() };
  await new Prober(am, {
    intervalMs: 0, log: () => {},
    probeFn: async (token) => { anthropic.push(token); return { sevenDay: { utilization: 0.2, resetAt: 1 } }; },
    backendFn: async () => reading,
  }).probeAll();

  assert.deepEqual(anthropic, ['t-claude']);                    // the key never leaves for the wrong party
  assert.deepEqual(am.accounts[1].quota.backend, reading);
  assert.equal(am.accounts[1].quota.unified7d, null);           // and it is not an Anthropic bucket
});

test('a failed backend read keeps the last value and records the error', async () => {
  const am = new AccountManager([backend('deepseek', DS)], 0.98);
  const good = { label: 'Balance', text: '$26.11', utilization: null, at: 1 };
  am.applyBackendQuota(0, good);
  const prober = new Prober(am, { intervalMs: 0, log: () => {}, backendFn: async () => ({ error: 'HTTP 500' }) });
  await prober.probeAll();

  assert.deepEqual(am.accounts[0].quota.backend, good);   // a failure is not evidence of a new balance
  const row = prober.getStatus().accounts[0];
  assert.equal(row.status, 'error');
  assert.equal(row.error, 'HTTP 500');
});

test('a backend account is probeable, not not-applicable', () => {
  const am = new AccountManager([backend('deepseek', DS), backend('muse', 'https://api.meta.ai')], 0.98);
  const rows = new Prober(am, { intervalMs: 300_000, log: () => {} }).getStatus().accounts;
  assert.equal(rows[0].status, 'never');            // has a provider, first cycle pending
  assert.equal(rows[1].status, 'not-applicable');   // nothing publishes anything for it
});

// ── rendering ────────────────────────────────────────────────

test('status draws whatever the reading says, knowing no provider', () => {
  const acct = (name, quota) => ({ name, type: 'oauth', status: 'active', priority: 100, quota, usage: {} });
  const out = renderStatus({
    currentAccount: 'x', switchThreshold: 0.98, accounts: [
      acct('a', { backend: { label: 'Balance', text: '$25.81', utilization: null, at: Date.now() } }),
      acct('b', { backend: { label: 'Credits', text: '42% used', utilization: 0.42, at: Date.now() } }),
      acct('c', {}),
    ],
  }, { color: false });

  assert.match(out, /Balance\s+\$25\.81/);
  assert.match(out, /Credits\s+\[█+░+\] 42% used/, 'a reported fraction gets a bar');
  assert.match(out, /Quota\s+unknown/, 'a provider that reports nothing is still honest');
});
