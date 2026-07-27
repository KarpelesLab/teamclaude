import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeEnvLines } from '../src/claude-env.js';

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

// TC_ACCT parity with `teamclaude run`: the pin must be carried by the routing
// itself, in whichever form the mode uses, and must not survive into the child.
test('an account pin rides in the proxy userinfo under MITM', () => {
  const lines = buildClaudeEnvLines({ port: 3456, account: 'work (Acme)', proxyApiKey: 'secret' });
  const url = 'http://work%20%28Acme%29:secret@127.0.0.1:3456';
  assert.ok(lines.includes(`export HTTPS_PROXY=${url}`), lines.join('\n'));
  assert.ok(lines.includes(`export http_proxy=${url}`));
  assert.ok(lines.includes('unset TC_ACCT'));
});

test('an account pin becomes a /tc-acct/ prefix under --no-mitm', () => {
  const lines = buildClaudeEnvLines({ port: 8080, useMitm: false, account: 'work (Acme)' });
  assert.deepEqual(lines, [
    'export ANTHROPIC_BASE_URL=http://localhost:8080/tc-acct/work%20%28Acme%29',
    'unset TC_ACCT',
  ]);
});

// An email-style name must survive the round trip: encodeURIComponent escapes
// the @, and the client percent-decodes userinfo before base64 (verified against
// Claude Code 2.1.220), so the proxy sees the name exactly as configured.
test('an email-style account name is encoded in the proxy URL', () => {
  const lines = buildClaudeEnvLines({ port: 3456, account: 'me@example.com', proxyApiKey: '' });
  assert.ok(lines.includes('export HTTPS_PROXY=http://me%40example.com:@127.0.0.1:3456'), lines.join('\n'));
});

test('no pin leaves the environment exactly as before', () => {
  assert.deepEqual(
    buildClaudeEnvLines({ port: 8080, useMitm: false }),
    ['export ANTHROPIC_BASE_URL=http://localhost:8080'],
  );
  const mitm = buildClaudeEnvLines({ port: 3456, caPath: '/x' });
  assert.ok(mitm.includes('export HTTPS_PROXY=http://127.0.0.1:3456'));
  assert.ok(!mitm.some((l) => l.includes('TC_ACCT')));
});

// These lines are eval'd by a shell. encodeURIComponent leaves ( ) ' ! * alone,
// which would make `export HTTPS_PROXY=http://work%20(Acme)@...` a syntax error.
test('a pinned line is shell-safe: no unquoted metacharacters survive', () => {
  for (const name of ["work (Acme)", "o'brien", "a!b", "x*y"]) {
    for (const useMitm of [true, false]) {
      const lines = buildClaudeEnvLines({ port: 3456, useMitm, account: name, caPath: '/x' });
      for (const l of lines) assert.ok(!/[()'!*]/.test(l), `${l} (from ${name})`);
    }
  }
});
