import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeEnvLines, directLaunchEnvPlan, redactUrlUserinfo, MITM_NO_PROXY } from '../src/claude-env.js';

test('MITM mode (default) emits proxy vars + CA cert, and clears ANTHROPIC_BASE_URL', () => {
  const lines = buildClaudeEnvLines({ port: 3456, caPath: '/home/u/.config/teamclaude-ca.pem' });
  assert.deepEqual(lines, [
    'export HTTPS_PROXY=http://127.0.0.1:3456',
    'export HTTP_PROXY=http://127.0.0.1:3456',
    'export https_proxy=http://127.0.0.1:3456',
    'export http_proxy=http://127.0.0.1:3456',
    `export NO_PROXY=${MITM_NO_PROXY}`,
    `export no_proxy=${MITM_NO_PROXY}`,
    'export NODE_EXTRA_CA_CERTS=/home/u/.config/teamclaude-ca.pem',
    'unset ANTHROPIC_BASE_URL',
  ]);
});

test('MITM NO_PROXY bypasses GitHub and keeps the Anthropic upstream interceptable', () => {
  assert.match(MITM_NO_PROXY, /(?:^|,)github\.com(?:,|$)/);
  assert.match(MITM_NO_PROXY, /(?:^|,)\.github\.com(?:,|$)/);
  assert.match(MITM_NO_PROXY, /(?:^|,)localhost(?:,|$)/);
  assert.doesNotMatch(MITM_NO_PROXY, /api\.anthropic\.com/);
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

// ── directLaunchEnvPlan ───────────────────────────────────────
//
// `--auto-fallback` promises a launch that bypasses the proxy. The child
// inherits its parent's environment, and a teamclaude session's parent shell is
// usually one teamclaude set up, so without this the promise is silently false.

test('a proxy var pointing at the dead port is cleared', () => {
  const env = {
    HTTPS_PROXY: 'http://127.0.0.1:3456', HTTP_PROXY: 'http://127.0.0.1:3456',
    https_proxy: 'http://127.0.0.1:3456', http_proxy: 'http://127.0.0.1:3456',
  };
  const plan = directLaunchEnvPlan(env, 3456);
  assert.deepEqual(plan.clear.sort(), ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].sort());
  assert.deepEqual(plan.remaining, []);
});

test('localhost and ::1 spellings of our own port are recognized too', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const plan = directLaunchEnvPlan({ HTTPS_PROXY: `http://${host}:3456` }, 3456);
    assert.deepEqual(plan.clear, ['HTTPS_PROXY'], host);
  }
});

test('a proxy var pointing somewhere ELSE is left alone and reported', () => {
  // The nested case: another live teamclaude, or a corporate egress proxy.
  // Deleting it behind the operator's back would break deliberate configuration.
  const plan = directLaunchEnvPlan({ HTTPS_PROXY: 'http://127.0.0.1:3456' }, 41999);
  assert.deepEqual(plan.clear, [], 'not ours — not deleted');
  assert.equal(plan.remaining.length, 1);
  assert.equal(plan.remaining[0].value, 'http://127.0.0.1:3456');
  assert.deepEqual(plan.remaining[0].names, ['HTTPS_PROXY']);
});

test('remaining vars are grouped by value, so one destination is one row', () => {
  const env = {
    HTTPS_PROXY: 'http://corp:8080', HTTP_PROXY: 'http://corp:8080',
    https_proxy: 'http://corp:8080', http_proxy: 'http://corp:8080',
  };
  const plan = directLaunchEnvPlan(env, 3456);
  assert.equal(plan.remaining.length, 1, 'four variables, one destination, one row');
  assert.equal(plan.remaining[0].names.length, 4);
});

test('a port that is a prefix of another does not match by accident', () => {
  // :34560 must not be mistaken for :3456.
  const plan = directLaunchEnvPlan({ HTTPS_PROXY: 'http://127.0.0.1:34560' }, 3456);
  assert.deepEqual(plan.clear, []);
  assert.equal(plan.remaining.length, 1);
});

test('ANTHROPIC_BASE_URL pointing at the dead port is cleared, including a /tc-acct pin', () => {
  const plan = directLaunchEnvPlan({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456/tc-acct/fugu' }, 3456);
  assert.ok(plan.clear.includes('ANTHROPIC_BASE_URL'));
});

test('a base URL pointing at a real upstream is NOT cleared', () => {
  const plan = directLaunchEnvPlan({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, 3456);
  assert.deepEqual(plan.clear, []);
});

test('NODE_EXTRA_CA_CERTS is dropped with the proxy it belonged to, but not on its own', () => {
  const withProxy = directLaunchEnvPlan(
    { HTTPS_PROXY: 'http://127.0.0.1:3456', NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }, 3456);
  assert.ok(withProxy.clear.includes('NODE_EXTRA_CA_CERTS'), 'our MITM leaf is useless without our proxy');

  const alone = directLaunchEnvPlan({ NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }, 3456);
  assert.deepEqual(alone.clear, [], 'nothing of ours was cleared, so the trust anchor is not ours to drop');
});

// D11-T1: BASE_URL-only match must not discard a corporate trust bundle.
test('NODE_EXTRA_CA_CERTS survives when only ANTHROPIC_BASE_URL matched the dead port', () => {
  const plan = directLaunchEnvPlan({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/corp-bundle.pem',
  }, 3456);
  assert.ok(plan.clear.includes('ANTHROPIC_BASE_URL'));
  assert.ok(!plan.clear.includes('NODE_EXTRA_CA_CERTS'),
    'a corporate CA is not teamclaude\'s MITM leaf — do not drop it on a base-URL-only match');
});

// D11-T2: teamclaude's own pinned MITM URL carries userinfo; both forms must clear.
test('dead-port match tolerates userinfo URLs (pinned MITM form) and bare host form', () => {
  const bare = 'http://127.0.0.1:3456';
  const withUserinfo = 'http://fugu:secret@127.0.0.1:3456';
  for (const value of [bare, withUserinfo]) {
    const plan = directLaunchEnvPlan({ HTTPS_PROXY: value, NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }, 3456);
    assert.ok(plan.clear.includes('HTTPS_PROXY'), `must clear proxy for ${value}`);
    assert.ok(plan.clear.includes('NODE_EXTRA_CA_CERTS'), `MITM leaf drops with proxy for ${value}`);
    assert.deepEqual(plan.remaining, [], value);
  }
  // userinfo on BASE_URL (unusual, but same host matcher) also clears.
  const base = directLaunchEnvPlan(
    { ANTHROPIC_BASE_URL: 'http://pin:key@127.0.0.1:3456/tc-acct/fugu' }, 3456);
  assert.ok(base.clear.includes('ANTHROPIC_BASE_URL'));
});

test('directLaunchEnvPlan mutates nothing and tolerates junk', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:3456' };
  const before = JSON.stringify(env);
  directLaunchEnvPlan(env, 3456);
  assert.equal(JSON.stringify(env), before, 'pure: the caller deletes, not us');
  for (const junk of [null, undefined, {}, { HTTPS_PROXY: 7 }, { HTTPS_PROXY: '' }]) {
    assert.doesNotThrow(() => directLaunchEnvPlan(junk, 3456));
  }
});

// ── D12c: redactUrlUserinfo (SECRET_IN_PANE / B62) ────────────
//
// --auto-fallback diagnostics print inherited proxy URLs. Those URLs carry
// credentials in userinfo (teamclaude's own MITM pin embeds its API key). The
// logged form must keep host:port and drop userinfo.

test('D12c (a): URL with userinfo logs host:port only, no credentials', () => {
  assert.equal(
    redactUrlUserinfo('http://pin:super-secret-api-key@127.0.0.1:3456'),
    'http://127.0.0.1:3456',
  );
  assert.equal(
    redactUrlUserinfo('http://user:pass@corp.example:8080/path?q=1'),
    'http://corp.example:8080/path?q=1',
  );
  assert.doesNotMatch(
    redactUrlUserinfo('http://pin:super-secret-api-key@127.0.0.1:3456'),
    /super-secret-api-key|pin@/,
  );
});

test('D12c (b): URL without userinfo is unchanged', () => {
  assert.equal(redactUrlUserinfo('http://127.0.0.1:3456'), 'http://127.0.0.1:3456');
  assert.equal(redactUrlUserinfo('https://api.anthropic.com'), 'https://api.anthropic.com');
  assert.equal(redactUrlUserinfo('http://corp.example:8080/proxy'), 'http://corp.example:8080/proxy');
});

test('D12c (c): redaction regex handles https and http', () => {
  assert.equal(
    redactUrlUserinfo('https://pin:key@proxy.example:443'),
    'https://proxy.example:443',
  );
  assert.equal(
    redactUrlUserinfo('HTTP://PIN:KEY@Proxy.Example:8080'),
    'HTTP://Proxy.Example:8080',
  );
  assert.equal(
    redactUrlUserinfo('Https://a:b@host'),
    'Https://host',
  );
});
