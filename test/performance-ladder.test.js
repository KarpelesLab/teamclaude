import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERFORMANCE_LADDER,
  ladderIndex,
  nextServeableModel,
  exclusiveRouteHopAllowed,
  replaceRequestModel,
} from '../src/performance-ladder.js';

const live = new Set([
  'claude-opus-5-5',
  'gpt-6-astra',
  'gemini-4-argon',
  'gpt-6.1-sol',
  'claude-sonnet-5-5',
  'gemini-3.8-flash',
  'claude-haiku-4-5',
  'gpt-5.6-terra',
  'gpt-6-luna',
]);
const canServe = (id) => live.has(id);

test('Kimi Code ranks above Kimi Code HighSpeed', () => {
  const code = ladderIndex('kimi-k2.8-code', DEFAULT_PERFORMANCE_LADDER);
  const code27 = ladderIndex('kimi-k2.7-code', DEFAULT_PERFORMANCE_LADDER);
  const fast = ladderIndex('kimi-k2.7-code-highspeed', DEFAULT_PERFORMANCE_LADDER);
  assert.ok(code >= 0 && code27 > code && fast > code27);
  assert.ok(ladderIndex('kimi-code', DEFAULT_PERFORMANCE_LADDER) === code);
  assert.ok(ladderIndex('kimi-code-highspeed', DEFAULT_PERFORMANCE_LADDER) === fast);
});

test('a Sol miss degrades to Kimi Code before HighSpeed when both can serve', () => {
  const both = (id) => id === 'kimi-k2.8-code' || id === 'kimi-k2.7-code-highspeed' || id === 'claude-sonnet-5-5';
  assert.equal(nextServeableModel('gpt-6.1-sol', DEFAULT_PERFORMANCE_LADDER, both), 'kimi-k2.8-code');
});

test('parked Kimi and DeepSeek are skipped down to the next live rung', () => {
  assert.equal(nextServeableModel('gpt-6.1-sol', DEFAULT_PERFORMANCE_LADDER, canServe), 'claude-sonnet-5-5');
  assert.equal(nextServeableModel('claude-opus-5-5', DEFAULT_PERFORMANCE_LADDER, (id) => id === 'gpt-6-astra'), 'gpt-6-astra');
});

test('upward only after every worse rung is unserveable', () => {
  assert.equal(
    nextServeableModel('gpt-6-luna', DEFAULT_PERFORMANCE_LADDER, (id) => id === 'claude-opus-5-5'),
    'claude-opus-5-5',
  );
});

test('exclusive gpt route does not hop to kimi or gemini', () => {
  const routeOf = (id) => {
    if (String(id).includes('gpt') || String(id).includes('sol') || String(id).includes('terra')) return 'gpt';
    if (String(id).includes('kimi')) return 'kimi';
    if (String(id).includes('gemini')) return 'gemini';
    return 'claude';
  };
  assert.equal(exclusiveRouteHopAllowed('gpt-6-astra', 'gpt-6.1-sol', routeOf), true);
  assert.equal(exclusiveRouteHopAllowed('gpt-6-astra', 'kimi-k3', routeOf), false);
  assert.equal(exclusiveRouteHopAllowed('gpt-6-astra', 'gemini-4-argon', routeOf), false);
  assert.equal(exclusiveRouteHopAllowed('claude-opus-5-5', 'gpt-6-astra', () => null), true);
});

test('replaceRequestModel rewrites only the top-level model', () => {
  const body = Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }] }));
  const next = JSON.parse(replaceRequestModel(body, 'kimi-k2.8-code').toString('utf8'));
  assert.equal(next.model, 'kimi-k2.8-code');
  assert.equal(next.messages[0].content, 'hi');
});
