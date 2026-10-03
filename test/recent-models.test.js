import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { renderDashboardHtml, inlineScripts, modelLabel, recentModelLabels } from '../src/dashboard.js';

const claudeAccount = (name) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });

test('updateQuota remembers the models an account served, per account', () => {
  const am = new AccountManager([claudeAccount('a'), claudeAccount('b')], 0.98);
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.1' }, 'claude-opus-5-5');
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.1' }, 'claude-haiku-4-5-20251001');
  const [a, b] = am.getStatus().accounts;
  assert.deepEqual(Object.keys(a.usage.recentModels).sort(), ['claude-haiku-4-5-20251001', 'claude-opus-5-5']);
  assert.equal(b.usage.recentModels, undefined);
});

test('a request without a model, or a hostile one, records nothing unsafe', () => {
  const am = new AccountManager([claudeAccount('a')], 0.98);
  am.updateQuota(0, {}, null);
  assert.equal(am.getStatus().accounts[0].usage.recentModels, undefined);
  am.updateQuota(0, {}, 'evil\x1b[2J\nmodel');
  assert.deepEqual(Object.keys(am.getStatus().accounts[0].usage.recentModels), ['evil model']);
});

test('the table is bounded to the most recently seen models', () => {
  const am = new AccountManager([claudeAccount('a')], 0.98);
  for (let i = 0; i < 50; i++) am.updateQuota(0, {}, `m${i}`);
  assert.equal(Object.keys(am.getStatus().accounts[0].usage.recentModels).length, 8);
});

test('modelLabel names models the way people say them', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-opus-5-5[1m]'), 'Opus 5.5');
  assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelLabel('gpt-6.1-sol'), 'GPT 6.1 Sol');
  assert.equal(modelLabel('gpt-6.0-astra'), 'GPT 6.0 Astra');
  assert.equal(modelLabel('some-other-model'), 'some-other-model');
});

test('recentModelLabels: last 15 minutes, newest first, haiku only as a fallback', () => {
  const now = 1_000_000_000;
  const usage = { recentModels: {
    'claude-opus-5-5': now - 60_000,
    'claude-fable-5-1': now - 5_000,
    'claude-haiku-4-5-20251001': now - 1_000,
    'claude-sonnet-5': now - 16 * 60_000,
  } };
  assert.deepEqual(recentModelLabels(usage, now), ['Fable 5.1', 'Opus 5.5']);
  assert.deepEqual(recentModelLabels({ recentModels: { 'claude-haiku-4-5-20251001': now - 1_000 } }, now), ['Haiku 4.5']);
  assert.deepEqual(recentModelLabels({}, now), []);
  assert.deepEqual(recentModelLabels(undefined, now), []);
});

test('the page carries the model helpers it calls', () => {
  const script = inlineScripts(renderDashboardHtml()).join('\n');
  assert.match(script, /function modelLabel\(/);
  assert.match(script, /function recentModelLabels\(/);
});
