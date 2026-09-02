import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig, quotaProbeSeconds, DEFAULT_QUOTA_PROBE_SECONDS } from '../src/config.js';

// The probe reads the zero-spend usage endpoint, and it is the only path that
// can refresh a family (Fable/Sonnet) weekly bucket without sending a request of
// that family — so it is on unless the operator turns it off. The distinction
// that matters is absent (take the default) vs. an explicit 0 (stay off).

test('an absent setting takes the default interval', () => {
  assert.equal(quotaProbeSeconds({}), DEFAULT_QUOTA_PROBE_SECONDS);
  assert.equal(quotaProbeSeconds({ switchThreshold: 0.9 }), DEFAULT_QUOTA_PROBE_SECONDS);
  assert.equal(quotaProbeSeconds(undefined), DEFAULT_QUOTA_PROBE_SECONDS);
  assert.ok(DEFAULT_QUOTA_PROBE_SECONDS >= 30, 'must respect the documented 30s floor');
});

test('an explicit 0 keeps the probe off — `teamclaude probe off` must stick', () => {
  assert.equal(quotaProbeSeconds({ quotaProbeSeconds: 0 }), 0);
});

test('an explicit interval wins over the default', () => {
  assert.equal(quotaProbeSeconds({ quotaProbeSeconds: 60 }), 60);
  assert.equal(quotaProbeSeconds({ quotaProbeSeconds: 3600 }), 3600);
});

test('a fresh config writes the default out explicitly', () => {
  assert.equal(createDefaultConfig().quotaProbeSeconds, DEFAULT_QUOTA_PROBE_SECONDS);
});
