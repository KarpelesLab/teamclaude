import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthCode } from '../src/oauth.js';

// The pasted-code login (`teamclaude login --token`) and the browser flow's
// paste fallback both go through parseAuthCode, the TUI's login panel too.
// Three input shapes; the two that carry a state must carry the right one.

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

test('a URL without a code is refused, not sent as one', () => {
  // It used to go to the token endpoint as the code and fail there, after the
  // TUI's panel had already closed on it.
  assert.throws(() => parseAuthCode('https://example.test/cb?foo=1', 'st1'), /carries no code/);
});

test('a form that carries a state must carry it', () => {
  assert.throws(() => parseAuthCode('https://example.test/cb?code=abc', 'st1'), /no state/);
  assert.throws(() => parseAuthCode('abc#', 'st1'), /not the whole code/);
  assert.throws(() => parseAuthCode('#st1', 'st1'), /not the whole code/);
});

test('a loopback address without its scheme is still an address', () => {
  assert.deepEqual(parseAuthCode('localhost:54321/callback?code=abc&state=st1', 'st1'), { code: 'abc', state: 'st1' });
});

test('an error in the address is reported after the state checks out, as plain text', () => {
  const desc = encodeURIComponent('\x1b]52;c;YXR0YWNr\x07');
  assert.throws(() => parseAuthCode(`https://example.test/cb?error=denied&error_description=${desc}&state=other`, 'st1'), /OAuth state mismatch/);
  assert.throws(() => parseAuthCode(`https://example.test/cb?error=denied&error_description=${desc}&state=st1`, 'st1'),
    err => /refused: denied/.test(err.message) && !/[\x00-\x1f\x7f-\x9f]/.test(err.message));
});

test('empty input yields null', () => {
  assert.equal(parseAuthCode('   ', 'st1'), null);
});
