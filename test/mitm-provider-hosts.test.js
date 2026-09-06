import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostMode, mitmHosts, ensureCerts, TEST_HOST } from '../src/mitm.js';
import { providerForHost, isNeverIntercepted, interceptHostsFor } from '../src/provider.js';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// MITM is the mode that works without the client cooperating: a CLI that honours
// only HTTPS_PROXY has no base URL to redirect. So a provider the proxy will not
// intercept is a provider it does not support in its main mode. Codex was that
// case — chatgpt.com fell through to a blind tunnel.

const claude = (name) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
const codex = (name) => ({ ...claude(name), provider: 'codex' });

test('a Codex fleet intercepts chatgpt.com', () => {
  const config = { accounts: [claude('a'), codex('c')] };
  assert.equal(hostMode('chatgpt.com', config), 'rewrite');
  assert.equal(hostMode('api.anthropic.com', config), 'rewrite');
});

// The safety half: a fleet with no Codex account must not have its ChatGPT
// traffic terminated. Intercepting a host nobody asked us to read is not a
// neutral default.
test('an Anthropic-only fleet still tunnels chatgpt.com', () => {
  const config = { accounts: [claude('a')] };
  assert.equal(hostMode('chatgpt.com', config), 'tunnel');
  assert.equal(hostMode('api.anthropic.com', config), 'rewrite');
});

// ab.chatgpt.com is OpenAI's telemetry endpoint: no inference, nothing to
// rewrite, and terminating it would present our leaf for a host we have no
// reason to read.
test('ab.chatgpt.com is never intercepted, even with Codex accounts', () => {
  const config = { accounts: [codex('c')] };
  assert.equal(hostMode('ab.chatgpt.com', config), 'tunnel');
  assert.equal(isNeverIntercepted('ab.chatgpt.com'), true);
});

test('host matching is exact, never a suffix', () => {
  assert.equal(providerForHost('chatgpt.com'), 'codex');
  assert.equal(providerForHost('api.anthropic.com'), 'anthropic');
  assert.equal(providerForHost('ab.chatgpt.com'), null);
  assert.equal(providerForHost('evil-chatgpt.com'), null);
  assert.equal(providerForHost('chatgpt.com.evil.test'), null);
  assert.equal(providerForHost(null), null);
});

test('unrelated hosts still tunnel, and the test host is still answered locally', () => {
  const config = { accounts: [codex('c')] };
  assert.equal(hostMode('example.com', config), 'tunnel');
  assert.equal(hostMode(TEST_HOST, config), 'test');
});

test('interceptHostsFor only adds a provider an account actually uses', () => {
  assert.deepEqual(interceptHostsFor([claude('a')]), ['api.anthropic.com']);
  assert.deepEqual(interceptHostsFor([claude('a'), codex('c')]).sort(),
    ['api.anthropic.com', 'chatgpt.com']);
});

// The leaf has to NAME every host we intercept, or the CONNECT fails the
// handshake instead of being served — which is the failure this whole change
// exists to avoid.
test('mitmHosts covers the Anthropic upstream and every used provider host', () => {
  assert.deepEqual(mitmHosts({ accounts: [claude('a')] }), ['api.anthropic.com']);
  assert.deepEqual(mitmHosts({ accounts: [claude('a'), codex('c')] }).sort(),
    ['api.anthropic.com', 'chatgpt.com']);
  // A custom upstream is still covered alongside the provider hosts.
  assert.deepEqual(
    mitmHosts({ upstream: 'https://proxy.internal.test', accounts: [codex('c')] }).sort(),
    ['api.anthropic.com', 'chatgpt.com', 'proxy.internal.test'].sort(),
  );
});

test('the minted leaf is valid for every intercepted host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cert-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
  try {
    const hosts = mitmHosts({ accounts: [claude('a'), codex('c')] });
    const { leafCertPem } = await ensureCerts(hosts);
    const names = (new X509Certificate(leafCertPem).subjectAltName || '')
      .split(',').map(s => s.trim());
    for (const h of [...hosts, TEST_HOST]) {
      assert.ok(names.includes(`DNS:${h}`), `the leaf does not name ${h}: ${names.join(', ')}`);
    }
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

// A single host string must keep working — every existing caller passed one.
test('ensureCerts still accepts a single host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-cert-'));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'teamclaude.json');
  try {
    const { leafCertPem } = await ensureCerts('api.anthropic.com');
    const names = (new X509Certificate(leafCertPem).subjectAltName || '').split(',').map(s => s.trim());
    assert.ok(names.includes('DNS:api.anthropic.com'));
    assert.ok(names.includes(`DNS:${TEST_HOST}`));
  } finally {
    if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
