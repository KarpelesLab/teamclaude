import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, rewriteModel, isNativeAnthropicUpstream } from '../src/server.js';
import { stripAdvisorModelField } from '../src/model.js';
import {
  requestModelIds,
  blockedIdInSet,
  accountAcceptsAllIds,
  accountAcceptsModel,
} from '../src/model-namespace.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

const advisorBody = (executor, advisor) => JSON.stringify({
  model: executor,
  max_tokens: 16,
  tools: [
    { name: 'Bash', description: 'x', input_schema: { type: 'object', properties: {} } },
    { type: 'advisor_20260301', name: 'advisor', model: advisor },
  ],
  messages: [{ role: 'user', content: 'hi' }],
});

// ── identifier-set contract (oracle) ──────────────────────────

test('requestModelIds is the set every request-path gate must quantify over', () => {
  assert.deepEqual(requestModelIds({ model: 'a', advisorModel: 'b' }), ['a', 'b']);
  assert.deepEqual(requestModelIds({ model: 'a', advisorModel: 'a' }), ['a'], 'dedupe');
  assert.deepEqual(requestModelIds({ model: 'a' }), ['a']);
  assert.deepEqual(requestModelIds({ advisorModel: 'b' }), ['b']);
  assert.deepEqual(requestModelIds({}), []);
});

test('blockedIdInSet names which id matched, preferring the executor when both hit', () => {
  assert.deepEqual(blockedIdInSet(['*fable*'], ['claude-opus-4-8', 'claude-fable-5']),
    { id: 'claude-fable-5', pattern: '*fable*', role: 'advisor' });
  assert.deepEqual(blockedIdInSet(['*opus*', '*fable*'], ['claude-opus-4-8', 'claude-fable-5']),
    { id: 'claude-opus-4-8', pattern: '*opus*', role: 'executor' });
  assert.equal(blockedIdInSet(['*fable*'], ['claude-opus-4-8']), null);
});

test('accountAcceptsAllIds mirrors AccountManager._acceptsModel over the full id set', () => {
  const account = {
    name: 'closed', strictModelMap: true, acceptsModels: ['exec-native'],
    modelMap: { 'claude-opus-4-8': 'exec-native' },
  };
  assert.equal(accountAcceptsAllIds(account, ['claude-opus-4-8']), true);
  assert.equal(accountAcceptsAllIds(account, ['claude-opus-4-8', 'claude-fable-5']), false);
  assert.equal(accountAcceptsModel(account, 'claude-fable-5'), false);
});

// ── strip helper ──────────────────────────────────────────────

test('stripAdvisorModelField removes tools[].model on advisor entries and keeps the tool', () => {
  const body = Buffer.from(advisorBody('claude-opus-4-8', 'claude-fable-5'));
  const out = stripAdvisorModelField(body);
  assert.notEqual(out, body);
  const obj = JSON.parse(out.toString());
  assert.equal(obj.model, 'claude-opus-4-8');
  assert.equal(obj.tools.length, 2);
  assert.equal(obj.tools[1].type, 'advisor_20260301');
  assert.equal(obj.tools[1].model, undefined);
  assert.equal('model' in obj.tools[1], false);
});

// ── D1: rewriteModel translates advisor ids ───────────────────

test('rewriteModel maps advisor tools[].model through the same modelMap as the executor', () => {
  const map = { 'claude-sonnet-5': 'backend-fast', 'claude-opus-5': 'backend-think' };
  const body = Buffer.from(advisorBody('claude-sonnet-5', 'claude-opus-5'));
  const out = rewriteModel(body, map);
  const obj = JSON.parse(out.toString());
  assert.equal(obj.model, 'backend-fast');
  assert.equal(obj.tools[1].model, 'backend-think');
});

test('rewriteModel leaves an unmapped advisor id intact when stripUnmappedAdvisor is false', () => {
  const map = { 'claude-sonnet-5': 'backend-fast' };
  const body = Buffer.from(advisorBody('claude-sonnet-5', 'claude-opus-5'));
  const out = rewriteModel(body, map);
  const obj = JSON.parse(out.toString());
  assert.equal(obj.model, 'backend-fast');
  assert.equal(obj.tools[1].model, 'claude-opus-5');
});

test('rewriteModel strips an unmapped advisor id when stripUnmappedAdvisor is set', () => {
  const map = { 'claude-sonnet-5': 'backend-fast' };
  const body = Buffer.from(advisorBody('claude-sonnet-5', 'claude-opus-5'));
  let stripped = null;
  const out = rewriteModel(body, map, {
    stripUnmappedAdvisor: true,
    onAdvisorStrip: (id) => { stripped = id; },
  });
  const obj = JSON.parse(out.toString());
  assert.equal(obj.model, 'backend-fast');
  assert.equal('model' in obj.tools[1], false);
  assert.equal(stripped, 'claude-opus-5');
});

test('rewriteModel drops advisor tools when dropAdvisorTools is set, even for a mapped advisor model', () => {
  const map = { 'claude-sonnet-5': 'backend-fast', 'claude-opus-5': 'backend-think' };
  const body = Buffer.from(advisorBody('claude-sonnet-5', 'claude-opus-5'));
  let stripped = null;
  const out = rewriteModel(body, map, {
    dropAdvisorTools: true,
    onAdvisorDrop: (id) => { stripped = id; },
  });
  const obj = JSON.parse(out.toString());
  assert.equal(obj.model, 'backend-fast');
  assert.equal(obj.tools.length, 1, 'a mapped advisor id is still dropped: the tool TYPE is the unsupported part');
  assert.equal(obj.tools[0].name, 'Bash');
  assert.equal(stripped, 'claude-opus-5');
});

// ── D2: blockedModels covers advisor — strip-and-degrade (G9) ─

test('blockedModels matching only the advisor strips it and still forwards the executor', async () => {
  let seenBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    blockedModels: ['*fable*'],
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: advisorBody('claude-opus-4-8', 'claude-fable-5'),
    });
    assert.equal(res.status, 200, 'advisor block must NOT 400 the executor turn');
    await res.text();
    assert.ok(seenBody, 'forwarded');
    const forwarded = JSON.parse(seenBody);
    assert.equal(forwarded.model, 'claude-opus-4-8');
    // The fake upstream is a custom effective upstream, so drop supersedes the
    // blocked-model strip: the whole advisor tool is gone, never just the id.
    assert.equal(forwarded.tools.length, 1, 'blocked advisor must never egress — whole tool dropped on custom upstream');
    assert.equal(forwarded.tools[0].name, 'Bash');
    assert.ok(am.getStatus().advisorDegrades >= 1, 'degrade is observable');
  } finally {
    await close(proxy); await close(upstream);
  }
});

test('blockedModels matching the executor still 400s as today', async () => {
  let hits = 0;
  const upstream = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
    blockedModels: ['*opus*'],
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: advisorBody('claude-opus-4-8', 'claude-fable-5'),
    });
    assert.equal(res.status, 400);
    assert.equal(hits, 0);
  } finally {
    await close(proxy); await close(upstream);
  }
});

// ── D3: /tc-acct pin capability covers advisor — strip (G9) ───

test('pinned closed adapter strips an unservable advisor and rewrites the executor', async () => {
  let seenBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'closed',
    type: 'apikey',
    apiKey: 'k1',
    upstream: `http://127.0.0.1:${upPort}`,
    strictModelMap: true,
    acceptsModels: ['exec-native'],
    modelMap: { 'claude-opus-4-8': 'exec-native' },
  }]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tc-acct/closed/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: advisorBody('claude-opus-4-8', 'claude-fable-5'),
    });
    assert.equal(res.status, 200, 'advisor unservable on pin must NOT 400');
    await res.text();
    const forwarded = JSON.parse(seenBody);
    assert.equal(forwarded.model, 'exec-native');
    assert.equal(forwarded.tools.length, 1, 'pinned custom upstream must not egress the advisor tool type');
    assert.equal(forwarded.tools[0].name, 'Bash');
    assert.ok(am.getStatus().advisorDegrades >= 1);
  } finally {
    await close(proxy); await close(upstream);
  }
});

test('rewriteModel on a custom-upstream account never egresses an unmapped advisor id', async () => {
  let seenBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'mapped',
    type: 'apikey',
    apiKey: 'k1',
    upstream: `http://127.0.0.1:${upPort}`,
    modelMap: { 'claude-sonnet-5': 'backend-fast' },
  }]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: advisorBody('claude-sonnet-5', 'claude-opus-5'),
    });
    assert.equal(res.status, 200);
    await res.text();
    const forwarded = JSON.parse(seenBody);
    assert.equal(forwarded.model, 'backend-fast');
    assert.equal(forwarded.tools.length, 1, 'advisor tool must never egress to a custom upstream');
    assert.equal(forwarded.tools[0].name, 'Bash');
    assert.ok(!JSON.stringify(forwarded).includes('claude-opus-5'));
  } finally {
    await close(proxy); await close(upstream);
  }
});

test('custom-upstream account without a modelMap still drops advisor tools', async () => {
  let seenBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  // codex-gpt56 shape: custom upstream, NO modelMap — the advisor drop must
  // still fire (the call-site gate is `modelMap || upstream`, not `modelMap`).
  const am = new AccountManager([{
    name: 'naked',
    type: 'apikey',
    apiKey: 'k1',
    upstream: `http://127.0.0.1:${upPort}`,
  }]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: advisorBody('claude-sonnet-5', 'claude-opus-5'),
    });
    assert.equal(res.status, 200);
    await res.text();
    const forwarded = JSON.parse(seenBody);
    assert.equal(forwarded.model, 'claude-sonnet-5', 'no modelMap → model name passes through verbatim');
    assert.equal(forwarded.tools.length, 1, 'advisor tool dropped even without a modelMap');
    assert.equal(forwarded.tools[0].name, 'Bash');
  } finally {
    await close(proxy); await close(upstream);
  }
});

test('account inheriting a custom top-level upstream still drops advisor tools', async () => {
  let seenBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  // The account has NEITHER upstream NOR modelMap; it inherits the custom
  // top-level upstream. Effective-upstream classification must drop the tool.
  const am = new AccountManager([{
    name: 'inherits-custom',
    type: 'apikey',
    apiKey: 'k1',
  }]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: advisorBody('claude-sonnet-5', 'claude-opus-5'),
    });
    assert.equal(res.status, 200);
    await res.text();
    const forwarded = JSON.parse(seenBody);
    assert.equal(forwarded.tools.length, 1, 'inherited custom upstream must still drop the advisor tool');
    assert.equal(forwarded.tools[0].name, 'Bash');
    assert.ok(am.getStatus().advisorDegrades >= 1);
  } finally {
    await close(proxy); await close(upstream);
  }
});

test('inherited custom upstream can explicitly opt in to advisor tools', async () => {
  let seenBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'advisor-native-inherited',
    type: 'apikey',
    apiKey: 'k1',
    supportsAdvisorTools: true,
    modelMap: {
      'claude-sonnet-5': 'backend-fast',
      'claude-opus-5': 'backend-think',
    },
  }]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: advisorBody('claude-sonnet-5', 'claude-opus-5'),
    });
    assert.equal(res.status, 200);
    await res.text();
    const forwarded = JSON.parse(seenBody);
    assert.equal(forwarded.tools.length, 2, 'explicit opt-in preserves the advisor tool on an inherited custom upstream');
    assert.equal(forwarded.tools[1].type, 'advisor_20260301');
    assert.equal(forwarded.tools[1].model, 'backend-think');
  } finally {
    await close(proxy); await close(upstream);
  }
});

test('custom upstream can explicitly opt in to advisor tools', async () => {
  let seenBody = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'advisor-native',
    type: 'apikey',
    apiKey: 'k1',
    upstream: `http://127.0.0.1:${upPort}`,
    modelMap: {
      'claude-sonnet-5': 'backend-fast',
      'claude-opus-5': 'backend-think',
    },
    supportsAdvisorTools: true,
  }]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://invalid' });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: advisorBody('claude-sonnet-5', 'claude-opus-5'),
    });
    assert.equal(res.status, 200);
    await res.text();
    const forwarded = JSON.parse(seenBody);
    assert.equal(forwarded.model, 'backend-fast');
    assert.equal(forwarded.tools.length, 2, 'explicit capability opt-in preserves the advisor tool');
    assert.equal(forwarded.tools[1].type, 'advisor_20260301');
    assert.equal(forwarded.tools[1].model, 'backend-think');
  } finally {
    await close(proxy); await close(upstream);
  }
});

// ── D5: isNativeAnthropicUpstream classification ──────────────

test('isNativeAnthropicUpstream accepts exactly the native Anthropic API root', () => {
  assert.equal(isNativeAnthropicUpstream('https://api.anthropic.com'), true);
  assert.equal(isNativeAnthropicUpstream('https://api.anthropic.com/'), true);
  assert.equal(isNativeAnthropicUpstream('https://api.anthropic.com:443'), true);
});

test('isNativeAnthropicUpstream rejects custom upstreams and malformed input', () => {
  assert.equal(isNativeAnthropicUpstream('http://api.anthropic.com'), false, 'http is not the native TLS root');
  assert.equal(isNativeAnthropicUpstream('https://api.deepseek.com/anthropic'), false);
  assert.equal(isNativeAnthropicUpstream('https://api.anthropic.com/v1'), false, 'path prefix is not the raw root');
  assert.equal(isNativeAnthropicUpstream('https://api.anthropic.com?x=1'), false, 'query is not the raw root');
  assert.equal(isNativeAnthropicUpstream('https://api.anthropic.com:8443'), false, 'non-standard port is custom');
  assert.equal(isNativeAnthropicUpstream(null), false);
  assert.equal(isNativeAnthropicUpstream(undefined), false);
  assert.equal(isNativeAnthropicUpstream(''), false);
  assert.equal(isNativeAnthropicUpstream('not-a-url'), false);
});
