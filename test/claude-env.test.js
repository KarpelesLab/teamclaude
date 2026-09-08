import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
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
    "export NODE_EXTRA_CA_CERTS='/home/u/.config/teamclaude-ca.pem'",
    'unset ANTHROPIC_BASE_URL',
  ]);
});

// NODE_EXTRA_CA_CERTS is a path under $HOME, and $HOME can carry a space or a
// quote. The line is eval'd, so it has to survive the shell intact.
test('the CA path is shell-quoted: a space and a quote survive eval', () => {
  for (const caPath of ['/home/first last/.config/teamclaude-ca.pem', "/home/o'brien/.config/tc-ca.pem", '/h/a b\'c"d$e/ca.pem']) {
    const lines = buildClaudeEnvLines({ port: 3456, caPath });
    const result = spawnSync('/bin/sh', ['-c', `${lines.join('\n')}\nprintf %s "$NODE_EXTRA_CA_CERTS"`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, caPath);
  }
});

// The port is interpolated unquoted into URLs. A config value that is not a
// port used to be emitted verbatim — "3456; touch /tmp/x" included.
test('a port that is not an integer in 1..65535 is refused, not emitted', () => {
  for (const port of ['3456; touch /tmp/x', 'abc', '', null, undefined, 0, 65536, -1, 3456.5, '0x1000', ' 3456 ; x']) {
    assert.throws(() => buildClaudeEnvLines({ port, caPath: '/x' }), /proxy\.port must be an integer between 1 and 65535/, String(port));
    assert.throws(() => buildClaudeEnvLines({ port, useMitm: false }), /proxy\.port/, String(port));
  }
});

test('a numeric string port is accepted as the number it spells', () => {
  assert.deepEqual(buildClaudeEnvLines({ port: '8080', useMitm: false }), ['export ANTHROPIC_BASE_URL=http://localhost:8080']);
  assert.deepEqual(buildClaudeEnvLines({ port: 65535, useMitm: false }), ['export ANTHROPIC_BASE_URL=http://localhost:65535']);
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
      // The pin rides unquoted in the URL lines; the CA path line is quoted separately.
      for (const l of lines.filter(l => !l.startsWith('export NODE_EXTRA_CA_CERTS='))) {
        assert.ok(!/[()'!*]/.test(l), `${l} (from ${name})`);
      }
    }
  }
});
