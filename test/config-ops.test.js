import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfigOpError,
  MAX_PROBE_SECONDS,
  resolveConfiguredAccount,
  setAccountDisabled,
  setAccountPriority,
  removeRoute,
  setBlockedModels,
  setBucketThresholds,
  setDefaultClientMode,
  setDistribution,
  setProbeSeconds,
  setThreshold,
  setWarmupSchedule,
  setWarmupSeconds,
  thresholdRatio,
  thresholdTable,
  upsertRoute,
} from '../src/config-ops.js';

const refused = (fn, pattern) => assert.throws(fn, err => err instanceof ConfigOpError && pattern.test(err.message));

test('the probe interval is off, or between the floor and the ceiling', () => {
  const config = {};
  setProbeSeconds(config, 300);
  assert.equal(config.quotaProbeSeconds, 300);
  setProbeSeconds(config, 0);
  assert.equal(config.quotaProbeSeconds, 0);
  setProbeSeconds(config, MAX_PROBE_SECONDS);
  assert.equal(config.quotaProbeSeconds, MAX_PROBE_SECONDS);

  refused(() => setProbeSeconds(config, 29), /Minimum probe interval is 30s/);
  refused(() => setProbeSeconds(config, MAX_PROBE_SECONDS + 1), /Maximum probe interval/);
  refused(() => setProbeSeconds(config, -1), /whole number of seconds/);
  refused(() => setProbeSeconds(config, 1.5), /whole number of seconds/);
  assert.equal(config.quotaProbeSeconds, MAX_PROBE_SECONDS, 'a refused value must not be stored');
});

test('an interval keep-warm replaces a schedule, and the floor is a minute', () => {
  const config = { warmupSchedule: { resetTime: '15:30', timezone: 'Europe/Moscow' } };
  setWarmupSeconds(config, 120);
  assert.equal(config.warmupSeconds, 120);
  assert.equal('warmupSchedule' in config, false);

  refused(() => setWarmupSeconds(config, 59), /Minimum keep-warm interval is 60s/);
  refused(() => setWarmupSeconds(config, -5), /whole number of seconds/);
  assert.equal(config.warmupSeconds, 120);
});

test('a reset schedule stores the normalized target and switches the interval off', () => {
  const config = { warmupSeconds: 300 };
  setWarmupSchedule(config, 'reset', { resetTime: '15:30', timezone: 'Europe/Moscow' });
  assert.deepEqual(config.warmupSchedule, { resetTime: '15:30', timezone: 'Europe/Moscow' });
  assert.equal(config.warmupSeconds, 0);
});

test('a rolling schedule carries its anchor', () => {
  const config = {};
  setWarmupSchedule(config, 'rolling', { resetTime: '15:30', timezone: 'Europe/Moscow' });
  assert.equal(config.warmupSchedule.mode, 'rolling');
  assert.ok(Number.isFinite(Date.parse(config.warmupSchedule.anchorResetAt)));
});

test('a schedule the resolver rejects is refused and leaves the config alone', () => {
  const config = { warmupSeconds: 300 };
  refused(() => setWarmupSchedule(config, 'reset', { resetTime: '15:30', timezone: 'Not/AZone' }), /invalid IANA timezone/);
  refused(() => setWarmupSchedule(config, 'reset', { resetTime: '25:00', timezone: 'Europe/Moscow' }), /HH:MM/);
  refused(() => setWarmupSchedule(config, 'weekly', { resetTime: '15:30', timezone: 'Europe/Moscow' }), /reset or rolling/);
  assert.deepEqual(config, { warmupSeconds: 300 });
});

test('a percentage is stored as a ratio quantised to tenths of a percent', () => {
  assert.equal(thresholdRatio(90), 0.9);
  assert.equal(thresholdRatio('97.25'), 0.973);
  assert.equal(thresholdRatio(0), null);
  assert.equal(thresholdRatio(101), null);
  assert.equal(thresholdRatio('ninety'), null);
  assert.equal(thresholdRatio(null), null);
  assert.equal(thresholdRatio(''), null);
  assert.equal(thresholdRatio(' '), null);
  // Number() would make 1 of `true` and 95 of `[95]`: a caller that is a model,
  // not a person typing, sends exactly such things.
  for (const notANumber of [true, false, [95], {}, undefined]) {
    assert.equal(thresholdRatio(notANumber), null, JSON.stringify(notANumber));
  }
});

test('one threshold replaces a per-bucket table and names what it dropped', () => {
  const config = { switchThreshold: { default: 0.98, unified7d: 0.9 } };
  assert.deepEqual(setThreshold(config, 85), { dropped: ['unified7d'] });
  assert.equal(config.switchThreshold, 0.85);
  assert.deepEqual(setThreshold(config, 80), { dropped: [] });

  refused(() => setThreshold(config, 0), /percentage from 1 to 100/);
  assert.equal(config.switchThreshold, 0.8);
});

test('bucket thresholds build a table that collapses once the last override goes', () => {
  const config = { switchThreshold: 0.95 };
  setBucketThresholds(config, [['unified7d', 90], ['default', 97]]);
  assert.deepEqual(config.switchThreshold, { default: 0.97, unified7d: 0.9 });

  setBucketThresholds(config, [['unified7d', null]]);
  assert.equal(config.switchThreshold, 0.97);
});

test('a bucket threshold is refused as a whole when any pair is bad', () => {
  const config = { switchThreshold: 0.95 };
  refused(() => setBucketThresholds(config, [['unified7d', 90], ['weekly', 80]]), /Unknown quota bucket "weekly"/);
  refused(() => setBucketThresholds(config, [['default', null]]), /default threshold is the fallback/);
  refused(() => setBucketThresholds(config, [['unified7d', 500]]), /percentage from 1 to 100/);
  refused(() => setBucketThresholds(config, [['unified7d', true]]), /percentage from 1 to 100/);
  refused(() => setBucketThresholds(config, [['unified7d', [95]]]), /percentage from 1 to 100/);
  assert.equal(config.switchThreshold, 0.95);
});

test('distribution stores what the router reads and reports whether it changed', () => {
  const config = {};
  assert.equal(setDistribution(config, 'adaptive'), true);
  assert.equal(config.distributeSessions, 'adaptive');
  assert.equal(setDistribution(config, 'adaptive'), false);
  assert.equal(setDistribution(config, 'even'), true);
  assert.equal(config.distributeSessions, true);
  assert.equal(setDistribution(config, 'off'), true);
  assert.equal(config.distributeSessions, false);

  refused(() => setDistribution(config, 'sometimes'), /off, even or adaptive/);
});

test('a route is added, then replaced in place under the same name', () => {
  const config = { accounts: [{ name: 'a' }] };
  const first = { name: 'opus', match: ['claude-opus-*'], accounts: ['a'], color: 'red' };
  assert.deepEqual(upsertRoute(config, { name: ' opus ', match: ['claude-opus-*'], accounts: ['a'], color: 'RED' }), { route: first, updated: false, unknownAccounts: [] });
  assert.deepEqual(config.routes, [first]);

  const second = { name: 'opus', match: ['claude-opus-5'], accounts: ['ghost', '2'], bucket: 'unified7d' };
  assert.deepEqual(upsertRoute(config, { name: 'opus', match: ['claude-opus-5'], accounts: ['ghost', '2'], bucket: 'unified7d' }), { route: second, updated: true, unknownAccounts: ['ghost'] });
  assert.deepEqual(config.routes, [{ name: 'opus', match: ['claude-opus-5'], accounts: ['ghost', '2'], bucket: 'unified7d' }]);
});

test('a route needs a name, a match and a known color', () => {
  const config = { accounts: [] };
  refused(() => upsertRoute(config, { name: '', match: ['x'] }), /needs a name and at least one match/);
  refused(() => upsertRoute(config, { name: 'r', match: [] }), /needs a name and at least one match/);
  refused(() => upsertRoute(config, { name: 'r', match: ['x'], color: 'notacolor' }), /Unknown color "notacolor"/);
  assert.equal(config.routes, undefined);
});

// These strings are drawn on the operator's terminal as stored — the TUI prints
// a route's name raw — so an escape sequence in one is a way to repaint it.
test('a control character is refused in every string a route or the blocklist stores', () => {
  const config = { accounts: [], blockedModels: ['kept'] };
  const ok = { name: 'r', match: ['claude-*'] };
  // ESC, a bare newline, DEL, and the 8-bit CSI that needs no ESC in front.
  for (const bad of ['\x1b[2J', 'a\nb', 'a\x7f', '\x9b31m', 'trailing\n']) {
    refused(() => upsertRoute(config, { ...ok, name: `opus${bad}` }), /route name must not contain control characters/);
    refused(() => upsertRoute(config, { ...ok, match: ['fine', `x${bad}`] }), /route match glob must not contain control characters/);
    refused(() => upsertRoute(config, { ...ok, accounts: [`a${bad}`] }), /route account must not contain control characters/);
    refused(() => upsertRoute(config, { ...ok, bucket: `unified7d${bad}` }), /route bucket must not contain control characters/);
    refused(() => setBlockedModels(config, ['fine', `gpt-${bad}`]), /blocked-model pattern must not contain control characters/);
  }
  assert.equal(config.routes, undefined, 'a refused route must not be stored');
  assert.deepEqual(config.blockedModels, ['kept'], 'a refused blocklist must not be stored');

  // Printable text outside ASCII is not a control character.
  upsertRoute(config, { name: 'opus — équipe', match: ['claude-opus-*'] });
  assert.equal(config.routes[0].name, 'opus — équipe');
});

test('removing a route that is not there is refused', () => {
  const config = { routes: [{ name: 'opus', match: ['x'] }] };
  refused(() => removeRoute(config, 'sonnet'), /Route "sonnet" not found/);
  removeRoute(config, 'opus');
  assert.deepEqual(config.routes, []);
});

test('the model blocklist is replaced as a whole, trimmed and deduplicated', () => {
  const config = { blockedModels: ['old'] };
  setBlockedModels(config, [' claude-opus-* ', 'claude-opus-*', 'gpt-*']);
  assert.deepEqual(config.blockedModels, ['claude-opus-*', 'gpt-*']);
  setBlockedModels(config, []);
  assert.deepEqual(config.blockedModels, []);

  refused(() => setBlockedModels(config, ['ok', '']), /non-empty string/);
  refused(() => setBlockedModels(config, 'claude-*'), /list of model patterns/);
});

test('the default client mode is one of the two the launcher understands', () => {
  const config = {};
  setDefaultClientMode(config, 'base-url');
  assert.equal(config.defaultClientMode, 'base-url');
  setDefaultClientMode(config, 'mitm');
  assert.equal(config.defaultClientMode, 'mitm');
  refused(() => setDefaultClientMode(config, 'socks'), /mitm or base-url/);
});

// A route's `bucket` is stored verbatim and becomes its weekly gating key, so a
// typo named a bucket no account carries and the route was silently never
// weekly-gated (#424).
test('an unknown route bucket is refused, with the valid ones named', () => {
  const config = { routes: [], accounts: [] };
  assert.throws(
    () => upsertRoute(config, { name: 'opus', match: ['claude-opus-*'], bucket: 'unified7dFabel' }),
    (err) => err instanceof ConfigOpError && /Unknown route bucket "unified7dFabel"/.test(err.message) && /unified7dFable/.test(err.message),
  );
  assert.deepEqual(config.routes, [], 'a refused route writes nothing');
  assert.equal(upsertRoute(config, { name: 'opus', match: ['claude-opus-*'], bucket: 'unified7dFable' }).route.bucket, 'unified7dFable');
});

// Only a hand edit produces an array. Spread into the table it became a bucket
// named "0" that nothing asks about (#425).
test('an array switchThreshold is the default table, not numeric bucket keys', () => {
  const origError = console.error;
  const said = [];
  console.error = (...a) => said.push(a.join(' '));
  try {
    assert.deepEqual(thresholdTable([0.9]), { default: 0.98 });
  } finally {
    console.error = origError;
  }
  assert.equal(said.length, 1);
  assert.match(said[0], /switchThreshold is an array/);
});

const acctConfig = () => ({ accounts: [
  { name: 'a@x.com (Acme)', accountUuid: 'u-1', orgName: 'Acme', priority: 0 },
  { name: 'a@x.com (Beta)', accountUuid: 'u-1', orgName: 'Beta', priority: 3 },
  { name: 'solo@x.com', accountUuid: 'u-2', priority: 7 },
] });

test('resolveConfiguredAccount refuses an ambiguous name rather than picking one', () => {
  const config = acctConfig();
  // The same email in two orgs is two different accounts; taking the first
  // would disable or reprioritize the wrong one.
  assert.throws(() => resolveConfiguredAccount(config, 'a@x.com'), ConfigOpError);
  try {
    resolveConfiguredAccount(config, 'a@x.com');
  } catch (err) {
    assert.match(err.message, /matches 2 accounts/);
    assert.match(err.message, /Acme/);
    assert.match(err.message, /Beta/);
  }
  assert.equal(resolveConfiguredAccount(config, 'a@x.com', 'Acme').orgName, 'Acme');
  assert.equal(resolveConfiguredAccount(config, 'solo@x.com').name, 'solo@x.com');
  assert.throws(() => resolveConfiguredAccount(config, 'nobody@x.com'), ConfigOpError);
  assert.throws(() => resolveConfiguredAccount(config, '  '), ConfigOpError);
});

test('setAccountPriority places relative to the rest, or takes an exact number', () => {
  const config = acctConfig();
  // 'first' is one below the lowest, counting 0 even when nothing sits there.
  assert.deepEqual(setAccountPriority(config, 'solo@x.com', { place: 'first' }),
    { name: 'solo@x.com', priority: -1 });
  assert.deepEqual(setAccountPriority(config, 'solo@x.com', { place: 'last' }),
    { name: 'solo@x.com', priority: 4 });
  assert.deepEqual(setAccountPriority(config, 'solo@x.com', { priority: 2 }),
    { name: 'solo@x.com', priority: 2 });
  // Zero is a real priority, not a missing one.
  assert.deepEqual(setAccountPriority(config, 'solo@x.com', { priority: 0 }),
    { name: 'solo@x.com', priority: 0 });
  assert.throws(() => setAccountPriority(config, 'solo@x.com', { priority: 1.5 }), ConfigOpError);
  assert.throws(() => setAccountPriority(config, 'solo@x.com', {}), ConfigOpError);
  assert.throws(() => setAccountPriority(config, 'a@x.com', { place: 'first' }), ConfigOpError);
});

test('setAccountDisabled deletes the key when enabling, as the CLI always has', () => {
  const config = acctConfig();
  assert.deepEqual(setAccountDisabled(config, 'solo@x.com', true), { name: 'solo@x.com', disabled: true });
  assert.equal(config.accounts[2].disabled, true);
  assert.deepEqual(setAccountDisabled(config, 'solo@x.com', false), { name: 'solo@x.com', disabled: false });
  assert.ok(!('disabled' in config.accounts[2]), 'enabling removes the key rather than writing false');
  // A throwing op must not have half-applied.
  assert.throws(() => setAccountDisabled(config, 'solo@x.com', 'yes'), ConfigOpError);
  assert.ok(!('disabled' in config.accounts[2]));
});
