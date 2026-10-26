import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { buildIdentity, BUILD_FEATURE_TAGS } from '../src/build-identity.js';
// Side-effect imports: each layer appends its tag. Dropping a module from the
// build must change the reported feature set (G1 identity).
import '../src/model-preflight.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

const EXPECTED_FEATURES = [
  'audit-b1-b6',
  'context-overflow-relay',
  'custom-advisor',
  'dynamic-routing',
  'dynrank-model-fidelity',
  'fleet-agent-name',
  'ingress-collision-gate',
  'ingress-thinking-strip',
  'media-prune',
  'model-preflight',
  'plaintext-toolcall',
  'provenance-t7',
  'quota-admission-gate',
  'rotation-gate',
  'serveable-availability',
  'sessions-endpoint',
];

const pkgVersion = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version;

test('buildIdentity reports package version, process startedAt, and the full feature tag set', () => {
  const build = buildIdentity();
  assert.equal(build.version, pkgVersion);
  assert.equal(typeof build.startedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(build.startedAt)), 'startedAt is ISO');
  assert.deepEqual([...build.features].sort(), [...EXPECTED_FEATURES].sort());
  // Registry is additive: the live array matches what buildIdentity snapshots.
  for (const tag of EXPECTED_FEATURES) {
    assert.ok(BUILD_FEATURE_TAGS.includes(tag), `registry missing ${tag}`);
  }
});

test('GET /teamclaude/status exposes build identity for fleet G1 assertion', async () => {
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    assert.equal(res.status, 200);
    const status = await res.json();
    assert.ok(status.build, 'build object present');
    assert.equal(status.build.version, pkgVersion);
    assert.equal(typeof status.build.startedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(status.build.startedAt)));
    assert.deepEqual([...status.build.features].sort(), [...EXPECTED_FEATURES].sort());
    // Pre-existing status fields still present (identity is additive).
    assert.ok(Array.isArray(status.accounts));
  } finally {
    await close(proxy);
  }
});
