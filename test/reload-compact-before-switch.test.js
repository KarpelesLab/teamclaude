import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { spawnServer, closedPort } from '../test-helpers/spawn-server.js';

// Live reload (POST /teamclaude/reload) must hot-apply `compactBeforeSwitch`
// (issue #709). The request path resolves the setting per request off the
// shared config object, and status resolves it off that same object, so the
// status echo is the witness that a reload reached the object the gate reads.
// That the gate follows the object from one request to the next is shown
// in-process, in compact-before-switch-server.test.js.
//
// The echo rather than a request that gets asked: only a Claude subscription
// account is ever asked, and a spawned server with an OAuth account would call
// the real profile endpoint at startup.

/** @param {number} port */
async function compactStatus(port) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
  assert.equal(res.status, 200);
  return (await res.json()).compactBeforeSwitch;
}

/**
 * @param {number} port
 * @param {string} configPath
 * @param {(config: Record<string, any>) => void} mutate
 */
async function reloadWith(port, configPath, mutate) {
  const edited = JSON.parse(await readFile(configPath, 'utf8'));
  mutate(edited);
  await writeFile(configPath, JSON.stringify(edited));
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' });
  const text = await res.text();
  assert.equal(res.status, 200, text);
}

test('reload hot-applies a compactBeforeSwitch edit, in both directions', async () => {
  // Nothing here sends a request upstream; a closed port makes sure of it.
  const deadPort = await closedPort();
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${deadPort}`,
      upstreamProxy: false,
      accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
    }),
  });
  const { port, configPath } = server;
  try {
    assert.deepEqual(await compactStatus(port), { enabled: false, asked: 0 }, 'off unless set');

    await reloadWith(port, configPath, c => { c.compactBeforeSwitch = true; });
    assert.deepEqual(await compactStatus(port), { enabled: true, margin: 0.04, minBodyBytes: 400000, cooldownSeconds: 1800, asked: 0 });

    await reloadWith(port, configPath, c => { c.compactBeforeSwitch = { margin: 0.1, minBodyBytes: 'big', cooldownSeconds: 60 }; });
    assert.deepEqual(await compactStatus(port), { enabled: true, margin: 0.1, minBodyBytes: 400000, cooldownSeconds: 60, asked: 0 }, 'a bad field takes its default');

    await reloadWith(port, configPath, c => { c.compactBeforeSwitch = 'yes'; });
    assert.deepEqual(await compactStatus(port), { enabled: false, asked: 0 }, 'an invalid value is off, not an error');

    await reloadWith(port, configPath, c => { c.compactBeforeSwitch = true; });
    assert.equal((await compactStatus(port)).enabled, true);
    await reloadWith(port, configPath, c => { delete c.compactBeforeSwitch; });
    assert.deepEqual(await compactStatus(port), { enabled: false, asked: 0 }, 'removing the key turns it off');
  } finally {
    await server.stop();
  }
});
