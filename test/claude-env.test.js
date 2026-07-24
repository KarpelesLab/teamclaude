import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeEnvLines,
  buildClaudeSettingsEnv,
  buildClaudeSshSetEnvLines,
  CLAUDE_SSH_ACCEPT_ENV,
} from '../src/claude-env.js';

test('MITM mode (default) emits proxy vars + CA cert, and clears ANTHROPIC_BASE_URL', () => {
  const lines = buildClaudeEnvLines({ port: 3456, caPath: '/home/u/.config/teamclaude-ca.pem' });
  assert.deepEqual(lines, [
    'export HTTPS_PROXY=http://127.0.0.1:3456',
    'export HTTP_PROXY=http://127.0.0.1:3456',
    'export https_proxy=http://127.0.0.1:3456',
    'export http_proxy=http://127.0.0.1:3456',
    'export NO_PROXY=localhost,127.0.0.1,::1',
    'export no_proxy=localhost,127.0.0.1,::1',
    'export NODE_EXTRA_CA_CERTS=/home/u/.config/teamclaude-ca.pem',
    'unset ANTHROPIC_BASE_URL',
  ]);
});

test('MITM mode without a caPath omits NODE_EXTRA_CA_CERTS (never emits an empty value)', () => {
  const lines = buildClaudeEnvLines({ port: 3456, useMitm: true, caPath: null });
  assert.ok(!lines.some((l) => l.startsWith('export NODE_EXTRA_CA_CERTS')));
  assert.ok(lines.includes('export HTTPS_PROXY=http://127.0.0.1:3456'));
});

test('--no-mitm (base-URL) mode emits only ANTHROPIC_BASE_URL, no proxy/cert vars', () => {
  const lines = buildClaudeEnvLines({ port: 8080, useMitm: false });
  assert.deepEqual(lines, ['export ANTHROPIC_BASE_URL=http://localhost:8080']);
});

test('no ANTHROPIC_API_KEY is ever emitted (loopback is auth-exempt; keeps subscription mode)', () => {
  const mitm = buildClaudeEnvLines({ port: 3456, useMitm: true, caPath: '/x' });
  const base = buildClaudeEnvLines({ port: 3456, useMitm: false });
  for (const l of [...mitm, ...base]) assert.ok(!l.includes('ANTHROPIC_API_KEY'), l);
});

test('holdSeconds > 0 adds API_TIMEOUT_MS = holdSeconds + 60s, in both modes', () => {
  const mitm = buildClaudeEnvLines({ port: 3456, caPath: '/x', holdSeconds: 3600 });
  assert.ok(mitm.includes('export API_TIMEOUT_MS=3660000'));
  const base = buildClaudeEnvLines({ port: 3456, useMitm: false, holdSeconds: 120 });
  assert.ok(base.includes('export API_TIMEOUT_MS=180000'));
});

test('holdSeconds 0 / unset adds no API_TIMEOUT_MS', () => {
  const lines = buildClaudeEnvLines({ port: 3456, useMitm: false });
  assert.ok(!lines.some((l) => l.startsWith('export API_TIMEOUT_MS')));
});

test('SSH mode emits OpenSSH SetEnv directives for Desktop-launched remote processes', () => {
  assert.deepEqual(buildClaudeSshSetEnvLines({
    port: 3456,
    caPath: '/home/u/.config/teamclaude-ca.pem',
    holdSeconds: 3600,
  }), [
    '  SetEnv HTTPS_PROXY=http://127.0.0.1:3456 HTTP_PROXY=http://127.0.0.1:3456 https_proxy=http://127.0.0.1:3456 http_proxy=http://127.0.0.1:3456 NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 NODE_EXTRA_CA_CERTS=/home/u/.config/teamclaude-ca.pem API_TIMEOUT_MS=3660000',
  ]);
});

test('SSH mode and sshd AcceptEnv names stay in sync', () => {
  const emitted = buildClaudeSshSetEnvLines({ port: 3456, caPath: '/x', holdSeconds: 1 })[0]
    .trim()
    .replace(/^SetEnv /, '')
    .split(' ')
    .map(pair => pair.split('=')[0]);
  assert.deepEqual(emitted, CLAUDE_SSH_ACCEPT_ENV);
});

test('Claude settings mode emits the supported env block for Desktop SSH sessions', () => {
  assert.deepEqual(buildClaudeSettingsEnv({
    port: 3456,
    caPath: '/home/u/.config/teamclaude-ca.pem',
    holdSeconds: 3600,
  }), {
    HTTPS_PROXY: 'http://127.0.0.1:3456',
    HTTP_PROXY: 'http://127.0.0.1:3456',
    https_proxy: 'http://127.0.0.1:3456',
    http_proxy: 'http://127.0.0.1:3456',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    NODE_EXTRA_CA_CERTS: '/home/u/.config/teamclaude-ca.pem',
    API_TIMEOUT_MS: '3660000',
  });
});

test('Claude settings and SSH modes emit the same variable names', () => {
  const settingsNames = Object.keys(buildClaudeSettingsEnv({
    port: 3456,
    caPath: '/x',
    holdSeconds: 1,
  }));
  assert.deepEqual(settingsNames, CLAUDE_SSH_ACCEPT_ENV);
});
