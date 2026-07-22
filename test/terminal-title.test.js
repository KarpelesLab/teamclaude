import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTerminalTitle, titleSequence, TITLE_STACK_PUSH, TITLE_STACK_POP } from '../src/terminal-title.js';

test('formats a 0-based index as a 1-based position out of the total, with the name', () => {
  assert.equal(formatTerminalTitle({ index: 0, total: 4, name: 'work' }), 'teamclaude 1/4 work');
  assert.equal(formatTerminalTitle({ index: 3, total: 4, name: 'personal' }), 'teamclaude 4/4 personal');
});

test('omits the name when absent', () => {
  assert.equal(formatTerminalTitle({ index: 1, total: 2 }), 'teamclaude 2/2');
});

test('handles the no-accounts edge without going negative', () => {
  assert.equal(formatTerminalTitle({ index: 0, total: 0 }), 'teamclaude 0/0');
  assert.equal(formatTerminalTitle({}), 'teamclaude 0/0');
});

test('truncates a long account name so the title stays short', () => {
  const out = formatTerminalTitle({ index: 0, total: 1, name: 'user@example.com (Some Very Long Org Name)' });
  assert.ok(out.length <= 'teamclaude 1/1 '.length + 24, out);
  assert.ok(out.endsWith('…'), out);
});

test('titleSequence wraps in OSC 0 ... BEL', () => {
  assert.equal(titleSequence('teamclaude 1/4 work'), '\x1b]0;teamclaude 1/4 work\x07');
});

test('titleSequence strips control chars so a crafted name cannot break the escape', () => {
  const seq = titleSequence('evil\x07\x1b]0;pwned\x1b[31m');
  // Exactly one OSC opener and one BEL terminator — no injected sequences survive.
  assert.equal(seq.match(/\x1b\]0;/g).length, 1);
  assert.equal(seq.match(/\x07/g).length, 1);
  assert.ok(!seq.includes('\x1b[31m'));
});

test('title stack push/pop are the xterm sequences', () => {
  assert.equal(TITLE_STACK_PUSH, '\x1b[22;2t');
  assert.equal(TITLE_STACK_POP, '\x1b[23;2t');
});
