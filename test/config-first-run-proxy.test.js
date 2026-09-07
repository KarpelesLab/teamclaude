import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveUpstreamProxy, localListener } from '../src/upstream-proxy.js';

// The self-proxy guard needs the config's own listener to compare against.
// Resolving from an EMPTY config — which is what the lazy fallback does when no
// command has installed the setting — cannot fire it, so an operator whose
// HTTPS_PROXY points at their own TeamClaude proxies back into it and times out.
test('the self-proxy guard needs a config, and silently cannot fire without one', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:3456' };

  const withConfig = resolveUpstreamProxy({ proxy: { port: 3456 } }, env);
  assert.equal(withConfig.source, 'self');
  assert.equal(withConfig.proxy, null, 'a proxy addressing our own listener must be dropped');

  const withoutConfig = resolveUpstreamProxy({}, env);
  assert.equal(withoutConfig.source, 'env:HTTPS_PROXY');
  assert.ok(withoutConfig.proxy, 'without a listener the guard cannot fire — hence the bug');
  assert.equal(localListener({}), null);
});

// A first run creates the config; the proxy setting must be applied to it, not
// skipped because loadConfig returned early on ENOENT.
test('loadOrCreateConfig applies the proxy setting to a config it creates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-firstrun-'));
  const path = join(dir, 'teamclaude.json');
  process.env.TEAMCLAUDE_CONFIG = path;
  const prevProxy = process.env.HTTPS_PROXY;

  try {
    const { loadOrCreateConfig } = await import('../src/config.js');
    const { getUpstreamProxy } = await import('../src/upstream-proxy.js');

    const config = await loadOrCreateConfig();
    // The file must exist, and the resolved setting must have been installed
    // from it rather than left for the config-less fallback.
    assert.ok(JSON.parse(await readFile(path, 'utf-8')).proxy.port);
    assert.ok(getUpstreamProxy(), 'a resolved proxy setting must be installed after a first run');
    assert.equal(typeof config.proxy.port, 'number');
  } finally {
    delete process.env.TEAMCLAUDE_CONFIG;
    if (prevProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prevProxy;
  }
});
