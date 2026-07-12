import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdvisorModel, AdvisorModelFinder } from '../src/model.js';
import { AccountManager } from '../src/account-manager.js';

// Claude Code's advisor tool (issue #98): the request keeps the EXECUTOR in the
// top-level `model` field and nests the advisor's model inside tools[] —
// `{ type: "advisor_20260301", name: "advisor", model: "claude-fable-5" }`.
// Account selection must treat such a request as needing BOTH models.

const advisorBody = (executor = 'claude-opus-4-8', advisor = 'claude-fable-5') => JSON.stringify({
  model: executor,
  max_tokens: 4096,
  tools: [
    { name: 'Bash', description: 'run advisor commands', input_schema: { type: 'object', properties: { model: { type: 'string' } } } },
    { type: 'advisor_20260301', name: 'advisor', model: advisor },
  ],
  messages: [{ role: 'user', content: 'say {"model":"claude-haiku-4-5"} and "type":"advisor_x"' }],
});

test('parseAdvisorModel extracts the advisor model from tools[]', () => {
  assert.equal(parseAdvisorModel(advisorBody()), 'claude-fable-5');
  assert.equal(parseAdvisorModel(Buffer.from(advisorBody())), 'claude-fable-5');
});

test('parseAdvisorModel ignores requests without an advisor tool', () => {
  assert.equal(parseAdvisorModel(JSON.stringify({ model: 'claude-opus-4-8', tools: [{ name: 'Bash' }] })), null);
  assert.equal(parseAdvisorModel('{"model":"claude-opus-4-8"}'), null);
  assert.equal(parseAdvisorModel(null), null);
  assert.equal(parseAdvisorModel(''), null);
  assert.equal(parseAdvisorModel('not json {'), null);
});

test('parseAdvisorModel never matches nested or decoy fields', () => {
  // "model"/"type" inside a tool's input_schema or inside message text must not match.
  const decoy = JSON.stringify({
    model: 'claude-opus-4-8',
    tools: [{ name: 'x', input_schema: { type: 'advisor_fake', properties: { model: { const: 'claude-haiku-4-5' } } } }],
    messages: [{ role: 'user', content: '{"tools":[{"type":"advisor_20260301","model":"claude-haiku-4-5"}]}' }],
  });
  assert.equal(parseAdvisorModel(decoy), null);
  // A `tools` key nested under another root key is not the root tools array.
  const nested = JSON.stringify({
    model: 'claude-opus-4-8',
    metadata: { tools: [{ type: 'advisor_20260301', model: 'claude-haiku-4-5' }] },
  });
  assert.equal(parseAdvisorModel(nested), null);
});

test('parseAdvisorModel handles field order and chunked feeding', () => {
  // model before type within the tool object.
  const reordered = JSON.stringify({
    model: 'claude-opus-4-8',
    tools: [{ model: 'claude-fable-5', name: 'advisor', type: 'advisor_20260301' }],
  });
  assert.equal(parseAdvisorModel(reordered), 'claude-fable-5');

  // Byte-at-a-time feeding matches whole-buffer parsing.
  const finder = new AdvisorModelFinder();
  const buf = Buffer.from(advisorBody());
  for (let i = 0; i < buf.length; i++) finder.push(buf.subarray(i, i + 1));
  assert.equal(finder.value, 'claude-fable-5');
});

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

test('an advisor request skips accounts whose advisor family bucket is spent', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  // a's Fable weekly bucket is spent; its shared buckets are fine.
  am.accounts[0].quota.unified7dFable = 0.999;
  am.accounts[0].quota.unified7dFableReset = Date.now() + 3600_000;

  // A plain Opus request still lands on a (current account, Fable bucket irrelevant)…
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'a');
  // …but the same request WITH a Fable advisor must go where the advisor can run.
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', 'claude-fable-5').name, 'b');
});

test('an advisor request honors the advisor model route pin when the executor has none', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.setRoutePin('fable', 1); // auto family pin
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'a');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', 'claude-fable-5').name, 'b');
});

test('the executor route pin wins over the advisor model pin', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98, {
    routes: [{ name: 'main', match: ['*opus*'] }],
  });
  am.setRoutePin('main', 2);  // executor pinned to c
  am.setRoutePin('fable', 1); // advisor pinned to b
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', 'claude-fable-5').name, 'c');
});

test('an advisor request respects route exclusivity for the advisor model', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, {
    routes: [{ name: 'fable', match: ['*fable*'], accounts: ['b'] }], // only b may serve Fable
  });
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8').name, 'a');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', 'claude-fable-5').name, 'b');
});

test('selection degrades to executor-only when no account can serve the advisor model', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  for (const acc of am.accounts) {
    acc.quota.unified7dFable = 0.999;
    acc.quota.unified7dFableReset = Date.now() + 3600_000;
  }
  // Nobody can run the Fable advisor — the request must still flow on executor routing.
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-8', 'claude-fable-5').name, 'a');
});
