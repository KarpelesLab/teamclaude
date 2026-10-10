import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hyperlink, clipboardSequence, tmuxPassthrough } from '../src/osc.js';

// The two OSC sequences the login panel writes on purpose. Both carry a URL
// several hundred characters long out of a terminal that may be on another
// machine, so the encodings are pinned byte for byte.

const URL_ = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz';

test('hyperlink: OSC 8 open, the text, OSC 8 close, each ended by ST', () => {
  assert.equal(hyperlink(URL_, 'Open'), `\x1b]8;;${URL_}\x1b\\Open\x1b]8;;\x1b\\`);
});

test('hyperlink: an id joins pieces into one link', () => {
  assert.equal(hyperlink(URL_, 'a', { id: 'login-1' }), `\x1b]8;id=login-1;${URL_}\x1b\\a\x1b]8;;\x1b\\`);
  // `:` and `;` separate params, so they cannot be in one.
  assert.match(hyperlink(URL_, 'a', { id: 'x;y:z' }), /^\x1b\]8;id=xyz;/);
});

test('hyperlink: nothing in the URL can end the sequence early', () => {
  const seq = hyperlink('https://example.test/a b\x1b\\\x07é', 'x');
  const uri = seq.slice('\x1b]8;;'.length, seq.indexOf('\x1b\\'));
  assert.equal(uri, 'https://example.test/a%20b%1B\\%07%C3%A9');
  // Exactly two ESCs (each OSC's ST) before the text, two after: none from the URL.
  assert.equal((seq.match(/\x1b/g) || []).length, 4);
});

test('clipboard: OSC 52 to the clipboard selection, base64, ended by BEL', () => {
  const seq = clipboardSequence(URL_);
  assert.equal(seq, `\x1b]52;c;${Buffer.from(URL_).toString('base64')}\x07`);
});

test('clipboard: inside tmux the plain sequence and the passthrough-wrapped one are both sent', () => {
  const plain = clipboardSequence(URL_);
  const seq = clipboardSequence(URL_, { tmux: true });
  assert.ok(seq.startsWith(plain), 'plain first, for set-clipboard on');
  const wrapped = seq.slice(plain.length);
  assert.equal(wrapped, `\x1bPtmux;\x1b${plain}\x1b\\`, 'the one ESC inside is doubled');
});

test('tmux passthrough: every ESC inside is doubled, and the DCS is ended by ST', () => {
  assert.equal(tmuxPassthrough('\x1b]8;;u\x1b\\'), '\x1bPtmux;\x1b\x1b]8;;u\x1b\x1b\\\x1b\\');
});
