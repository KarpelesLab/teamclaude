import { test } from 'node:test';
import assert from 'node:assert/strict';

import { limitCostMicro, priceUsage } from '../src/anthropic-pricing.js';

const MTOK = 1_000_000;
const UNKNOWN = 'claude-nonesuch-9';
const both = (extra = {}) => ({ input_tokens: MTOK, output_tokens: MTOK, ...extra });

test('a priced model costs its list price, in micro-dollars', () => {
  const usage = both({ cache_read_input_tokens: 500_000, server_tool_use: { web_search_requests: 3 } });
  const listed = priceUsage('claude-sonnet-5-5', usage);
  assert.equal(listed.ok, true);
  assert.equal(limitCostMicro('claude-sonnet-5-5', usage), Math.round(/** @type {any} */ (listed).costMinor * 10_000));
});

test('an unpriceable reply is charged the dearest rate the table has in each category', () => {
  // Opus 4 and 4.1 hold every maximum today: $15 in, $75 out, $1.50 cache read,
  // $18.75 and $30 for 5-minute and 1-hour cache writes; a search is $0.01.
  const cases = [
    [{ input_tokens: MTOK }, 15_000_000],
    [{ output_tokens: MTOK }, 75_000_000],
    [{ cache_read_input_tokens: MTOK }, 1_500_000],
    [{ cache_creation_input_tokens: MTOK }, 18_750_000],
    [{ cache_creation_input_tokens: MTOK, cache_creation: { ephemeral_1h_input_tokens: MTOK } }, 30_000_000],
    [{ server_tool_use: { web_search_requests: 2 } }, 20_000],
  ];
  for (const [usage, micro] of cases) assert.equal(limitCostMicro(UNKNOWN, usage), micro, JSON.stringify(usage));
});

test('a reply the caller made unpriceable is not free', () => {
  const ceiling = limitCostMicro(UNKNOWN, both());
  assert.equal(limitCostMicro('claude-sonnet-5-5', both({ service_tier: 'priority' })), ceiling);
  assert.equal(limitCostMicro('claude-sonnet-5-5', both({ speed: 'fast' })), ceiling);
  assert.equal(limitCostMicro(UNKNOWN, both({ service_tier: 'batch' })), ceiling, 'no batch discount on the charge');
  assert.equal(limitCostMicro(UNKNOWN, both({ inference_geo: 'us' })), Math.round(ceiling * 1.1));
});

test('a reply with no usage costs nothing, whatever its model label', () => {
  for (const model of [UNKNOWN, '__proto__', null, 42]) {
    assert.equal(limitCostMicro(model, {}), 0);
    assert.equal(limitCostMicro(model, null), 0);
  }
});
