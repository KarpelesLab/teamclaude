import { describe, expect, it } from 'vitest';
import { PAGE_ORDER, shortcutFor, type KeyLike } from '../src/renderer/shortcuts';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe('keyboard shortcuts', () => {
  it('opens the page at that place in the sidebar with Ctrl+number', () => {
    expect(shortcutFor(key('1', { ctrlKey: true }))).toEqual({ type: 'page', page: 'overview' });
    expect(shortcutFor(key('9', { ctrlKey: true }))).toEqual({ type: 'page', page: PAGE_ORDER[8] });
  });

  it('refreshes the status with F5 or Ctrl+R', () => {
    expect(shortcutFor(key('F5'))).toEqual({ type: 'refresh' });
    expect(shortcutFor(key('r', { ctrlKey: true }))).toEqual({ type: 'refresh' });
    expect(shortcutFor(key('R', { ctrlKey: true }))).toEqual({ type: 'refresh' });
  });

  it('leaves everything else to the page', () => {
    expect(shortcutFor(key('1'))).toBeNull();
    expect(shortcutFor(key('r'))).toBeNull();
    expect(shortcutFor(key('0', { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key('1', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(key('1', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(shortcutFor(key('F5', { ctrlKey: true }))).toBeNull();
  });
});
