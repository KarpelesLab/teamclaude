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

// With a known window, color tracks burn rate: usage minus the share of the
// window already elapsed, not raw fill. A half-elapsed window (reset half the
// window away) is the fixed reference point for these.
const WINDOW = 60 * 60 * 1000;
const halfElapsedReset = () => Date.now() + WINDOW / 2; // 50% of the window gone

test('under pace is green even at high fill', () => {
  // 30% used, 50% elapsed -> diff -20 -> green, where raw 0.3 is also green but
  // the point is 0.8 flips too:
  assert.match(bar(0.3, 10, halfElapsedReset(), WINDOW), /\x1b\[42;30m/);
  // 60% used, 90% elapsed -> diff -30 -> green, though raw 0.6 would still be green;
  // use 88% used with 90% elapsed -> diff -2 -> green while raw 0.88 is red.
  assert.match(bar(0.88, 10, Date.now() + WINDOW * 0.1, WINDOW), /\x1b\[42;30m/);
});

test('slightly ahead of pace is yellow', () => {
  // 54% used, 50% elapsed -> diff 4 -> yellow.
  assert.match(bar(0.54, 10, halfElapsedReset(), WINDOW), /\x1b\[43;30m/);
});

test('well ahead of pace is orange (256-color background)', () => {
  // 62% used, 50% elapsed -> diff 12 -> orange.
  assert.match(bar(0.62, 10, halfElapsedReset(), WINDOW), /\x1b\[48;5;208;30m/);
});

test('far ahead of pace is red', () => {
  // 70% used, 50% elapsed -> diff 20 -> red.
  assert.match(bar(0.70, 10, halfElapsedReset(), WINDOW), /\x1b\[41;97m/);
});

test('without a window it falls back to raw utilization', () => {
  // Same 0.88 that read green at 10% elapsed with a window is plain yellow on
  // the raw thresholds here (0.7 <= 0.88 < 0.9), so the window genuinely changes
  // the verdict rather than the fill alone.
  assert.match(bar(0.88, 10), /\x1b\[43;30m/);
});
