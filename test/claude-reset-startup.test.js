import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from '../test-helpers/spawn-server.js';

// The production composition, not a manually wired server: src/index.js restores
// state, registers the operator hook and merges the shutdown write. The pending
// row is deliberately orphaned so the route fails closed without any upstream I/O.
test('real startup restores pending redemption and shutdown preserves every state namespace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-reset-startup-'));
  const statePath = join(dir, 'config.state.json');
  const pending = {
    gone: {
      accountUuid: 'account-gone', orgUuid: 'org-gone',
      grantId: 'grant-gone', requestId: 'request-gone', createdAt: 10,
    },
  };
  await writeFile(statePath, JSON.stringify({
    claudeResetPending: pending,
    clients: { ci: { requests: 7, inputTokens: 11, outputTokens: 13, lastUsed: null } },
    usageDimensions: { project: { alpha: { requests: 5, inputTokens: 17, outputTokens: 19, lastUsed: null } } },
    otherTopLevel: { keep: true },
  }));
  const server = await spawnServer({
    dir,
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: 'http://127.0.0.1:9',
      accounts: [{
        id: 'live', name: 'live@example.com', type: 'oauth', accessToken: 'token-live',
        accountUuid: 'account-live', orgUuid: 'org-live', expiresAt: Date.now() + 3_600_000,
      }],
    }),
  });
  try {
    const status = await (await fetch(`http://127.0.0.1:${server.port}/teamclaude/status`, { headers: { 'x-api-key': 'tc-test' } })).json();
    assert.equal(status.clients.ci.requests, 7);
    assert.equal(status.usageDimensions.project.alpha.requests, 5);

    const res = await fetch(`http://127.0.0.1:${server.port}/teamclaude/claude-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
      body: JSON.stringify({ account: 'live@example.com' }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.outcome, 'unknown');
    assert.equal(body.reason, 'pending_orphan');
    assert.equal(body.mayHaveRedeemed, true);
    assert.doesNotMatch(JSON.stringify(body), /grant-gone|request-gone/);
  } finally {
    await server.stop();
  }

  const saved = JSON.parse(await readFile(statePath, 'utf-8'));
  assert.deepEqual(saved.claudeResetPending, pending);
  assert.equal(saved.clients.ci.requests, 7);
  assert.equal(saved.clients.ci.inputTokens, 11);
  assert.equal(saved.usageDimensions.project.alpha.requests, 5);
  assert.equal(saved.usageDimensions.project.alpha.inputTokens, 17);
  assert.deepEqual(saved.otherTopLevel, { keep: true });
  assert.ok(saved.quota, 'the production shutdown writer still exports quota');
});
