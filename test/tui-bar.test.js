import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bar } from '../src/tui.js';

// The label is overlaid on the bar's background, so its foreground must
// contrast with each fill color: black on green/yellow (both render light in
// many terminal themes), white only on red.
test('green and yellow fills use a black label', () => {
  assert.match(bar(0.5, 10), /\x1b\[42;30m/);
  assert.match(bar(0.8, 10), /\x1b\[43;30m/);
});

test('red fill keeps a white label', () => {
  assert.match(bar(0.95, 10), /\x1b\[41;97m/);
});

test('empty portion keeps gray-on-gray', () => {
  assert.match(bar(0.5, 10), /\x1b\[100;37m/);
});
