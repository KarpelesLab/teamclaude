import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { parseSSEUsage } from '../src/server.js';

test('late input tokens reach account and session usage without double-counting cumulative deltas', () => {
  const am = new AccountManager([{ name: 'cursor', type: 'apikey', apiKey: 'test' }]);
  const ctx = { sessionId: 'grok-live-pattern', model: 'grok-4.7', pathClass: 'messages' };
  const state = {}, attempt = {};
  const send = event => parseSSEUsage(`data: ${JSON.stringify(event)}`, 0, am, ctx, attempt, state);
  am.beginSession(ctx.sessionId, { semantic: true, model: ctx.model, pathClass: 'messages' });
  send({ type: 'message_start', message: { model: 'grok-4.7', usage: { input_tokens: 0, output_tokens: 0 } } });
  send({ type: 'message_delta', usage: { output_tokens: 100 } });
  send({ type: 'message_delta', usage: { input_tokens: 131, output_tokens: 157 } });
  send({ type: 'message_delta', usage: { input_tokens: 131, output_tokens: 157 } });
  assert.equal(am.accounts[0].usage.totalInputTokens, 131);
  assert.equal(am.accounts[0].usage.totalOutputTokens, 157);
  assert.equal(am.sessionTracker.evidence.get(ctx.sessionId).ctxByModel.get(ctx.model).contextTokens, 131);
  assert.deepEqual(attempt.usage, { input: 131, output: 157 });
  assert.equal(attempt.response_reported_model, 'grok-4.7');
});
