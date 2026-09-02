import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthCode } from '../src/oauth.js';

// The pasted-code login (`teamclaude login --token`) and the browser flow's
// paste fallback both go through parseAuthCode. Four input shapes, one throw.

test('a full callback URL yields its code and state', () => {
  assert.deepEqual(
    parseAuthCode('https://console.anthropic.com/oauth/code/callback?code=abc&state=st1', 'st1'),
    { code: 'abc', state: 'st1' },
  );
});

test('a callback URL whose state does not match throws', () => {
  assert.throws(
    () => parseAuthCode('https://example.test/cb?code=abc&state=other', 'st1'),
    /OAuth state mismatch/,
  );
});

test('the code#state form from the manual success page is split', () => {
  assert.deepEqual(parseAuthCode(' abc#st1 ', 'st1'), { code: 'abc', state: 'st1' });
  assert.throws(() => parseAuthCode('abc#other', 'st1'), /OAuth state mismatch/);
});

test('a bare code takes the expected state', () => {
  assert.deepEqual(parseAuthCode('abc', 'st1'), { code: 'abc', state: 'st1' });
});

test('a URL without a code is treated as a raw code, as before', () => {
  // Matches the browser flow's historical fallback: whatever was pasted is
  // sent as the code and the exchange decides.
  assert.deepEqual(parseAuthCode('https://example.test/cb?foo=1', 'st1'), { code: 'https://example.test/cb?foo=1', state: 'st1' });
});

test('empty input yields null', () => {
  assert.equal(parseAuthCode('   ', 'st1'), null);
});
