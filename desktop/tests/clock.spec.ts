import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readNow, subscribeNow, TICK_MS } from '../src/renderer/clock';

describe('shared clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('notifies every subscriber once per tick from one timer', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeNow(a);
    const offB = subscribeNow(b);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TICK_MS * 3);
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).toHaveBeenCalledTimes(3);
    expect(readNow()).toBe(1_000_000 + TICK_MS * 3);
    offA();
    offB();
  });

  it('stops the timer when the last subscriber leaves', () => {
    const off = subscribeNow(() => {});
    off();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts from the current time after an idle stretch', () => {
    subscribeNow(() => {})();
    vi.setSystemTime(5_000_000);
    const off = subscribeNow(() => {});
    expect(readNow()).toBe(5_000_000);
    off();
  });
});
