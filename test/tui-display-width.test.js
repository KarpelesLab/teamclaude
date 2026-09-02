import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, truncate, fitLine } from '../src/tui.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('ASCII width is the character count', () => {
  assert.equal(displayWidth('hello@example.com'), 17);
});

test('CJK characters are two columns each', () => {
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('한글'), 4); // Hangul syllables
  assert.equal(displayWidth('あ'), 2);   // Hiragana
});

test('fullwidth forms are two columns', () => {
  assert.equal(displayWidth('ＡＢ'), 4); // Ａ Ｂ
});

test('combining marks add no width', () => {
  assert.equal(displayWidth('é'), 1); // e + combining acute
  assert.equal(displayWidth('àb'), 2);
});

test('a variation selector is zero width', () => {
  assert.equal(displayWidth('❤️'), 1); // heart (BMP, width 1) + VS-16
});

test('an emoji outside the BMP is two columns, not two units', () => {
  assert.equal(displayWidth('\u{1F7E2}'), 2); // green circle, a surrogate pair
});

test('ANSI escapes do not count toward width', () => {
  assert.equal(displayWidth('\x1b[42;30mok\x1b[0m'), 2);
});

test('truncate stops before a wide glyph that would overflow', () => {
  // Budget 3: one CJK char (2 cols) fits, the second would reach 4, so it drops.
  assert.equal(strip(truncate('中文中', 3)), '中');
});

test('truncate keeps a wide glyph that fits exactly', () => {
  assert.equal(strip(truncate('中文', 4)), '中文');
});

test('fitLine pads the column a dropped wide glyph leaves empty', () => {
  // Budget 3: '中' (2 cols) fits, the next '文' would overflow and is dropped,
  // so the line must be padded back to exactly 3 columns.
  const out = fitLine('中文中', 3);
  assert.equal(displayWidth(out), 3);
  assert.equal(strip(out), '中 ');
});

test('fitLine leaves an exact-width line alone and pads a short one', () => {
  assert.equal(strip(fitLine('ab', 2)), 'ab');
  assert.equal(strip(fitLine('中', 4)), '中  ');
});
