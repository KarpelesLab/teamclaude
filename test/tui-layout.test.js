import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnLayout } from '../src/tui.js';

test('a wide terminal shows the full name and caps bars at 20', () => {
  const { nameW, bw } = columnLayout(160, true, 1, 25);
  assert.equal(nameW, 25);
  assert.equal(bw, 20);
});

test('a narrow terminal truncates the name to the 12-column floor', () => {
  const { nameW, bw } = columnLayout(70, true, 0, 25);
  assert.equal(nameW, 12);
  assert.ok(bw >= 5 && bw <= 20);
});

test('short names do not shrink the column below the floor', () => {
  const { nameW } = columnLayout(200, true, 0, 8);
  assert.equal(nameW, 12);
});

test('bars never drop below 5, even when a long name eats the row', () => {
  const { nameW, bw } = columnLayout(50, true, 0, 30);
  assert.equal(bw, 5);
  assert.equal(nameW, 12); // floor wins over the shrinking budget
});

test('single-bar layout leaves room for the name to grow', () => {
  const { nameW, bw } = columnLayout(120, false, 0, 20);
  assert.equal(nameW, 20);
  assert.ok(bw >= 5 && bw <= 20);
});

// Chrome for a row with S7/F7 present: markers + type/status/labels + the Ses
// and Wk prefixes + one ` X7  ` prefix per family bar.
const rowWidth = (W, genRoutes, familyBars, nameW, bw) =>
  4 + (genRoutes ? genRoutes + 1 : 0) + 24 + 6 + familyBars * 6 + nameW + (2 + familyBars) * bw;

test('reserving the S7/F7 bars keeps the row inside the terminal', () => {
  for (const W of [80, 100, 120, 160]) {
    const { nameW, bw } = columnLayout(W, true, 0, 20, 2);
    assert.ok(rowWidth(W, 0, 2, nameW, bw) <= W, `overflow at W=${W}`);
  }
});

test('family bars only count in the two-bar layout', () => {
  // showBoth false: familyBars is ignored, so this matches the plain single-bar case.
  assert.deepEqual(columnLayout(60, false, 0, 20, 2), columnLayout(60, false, 0, 20, 0));
});
