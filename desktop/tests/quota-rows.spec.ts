import { describe, expect, it } from 'vitest';
import { isStaleReading, showSessionRow, showWeeklyRow, STALE_READING_MS } from '../src/renderer/format';

const reading = (utilization: number | null) => ({ utilization, resetAt: null, seenAt: null });

describe('quota rows, by the server rules', () => {
  it('hides the weekly row only for a plan that meters no shared weekly window and has no reading', () => {
    expect(showWeeklyRow({ weekly: reading(null), weeklyWindowStated: false })).toBe(false);
    expect(showWeeklyRow({ weekly: reading(0.2), weeklyWindowStated: false })).toBe(true);
    expect(showWeeklyRow({ weekly: reading(null), weeklyWindowStated: true })).toBe(true);
    // An older backend says nothing either way: the row stays.
    expect(showWeeklyRow({ weekly: reading(null), weeklyWindowStated: null })).toBe(true);
  });

  it('applies the same rule to the 5-hour row', () => {
    expect(showSessionRow({ fiveHour: reading(null), sessionWindowStated: false })).toBe(false);
    expect(showSessionRow({ fiveHour: reading(0.5), sessionWindowStated: false })).toBe(true);
    expect(showSessionRow({ fiveHour: reading(null), sessionWindowStated: null })).toBe(true);
  });
});

describe('stale quota readings', () => {
  const now = Date.UTC(2026, 9, 22, 12);
  const window = (seenAgoMs: number | null, resetInMs: number | null, utilization: number | null = 0.4) => ({
    utilization,
    seenAt: seenAgoMs === null ? null : now - seenAgoMs,
    resetAt: resetInMs === null ? null : now + resetInMs,
  });

  it('keeps a reading fresh until it is as old as the server keeps a status snapshot', () => {
    expect(isStaleReading(window(STALE_READING_MS - 1, 3_600_000), now)).toBe(false);
    expect(isStaleReading(window(STALE_READING_MS, 3_600_000), now)).toBe(true);
  });

  it('marks a six-day-old weekly reading whose window has not reset as stale', () => {
    expect(isStaleReading(window(6 * 86_400_000, 86_400_000, 0), now)).toBe(true);
  });

  it('never marks a missing reading, or one without a known age, as stale', () => {
    expect(isStaleReading(window(6 * 86_400_000, 86_400_000, null), now)).toBe(false);
    expect(isStaleReading(window(null, 86_400_000), now)).toBe(false);
  });

  it('does not mark a reading whose window has already reset: that is a different state', () => {
    expect(isStaleReading(window(6 * 86_400_000, -1), now)).toBe(false);
  });

  it('still marks an old reading whose reset time is unknown', () => {
    expect(isStaleReading(window(STALE_READING_MS, null), now)).toBe(true);
  });
});
