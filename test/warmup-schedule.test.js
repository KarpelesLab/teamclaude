import { test } from 'node:test';
import assert from 'node:assert/strict';

const scheduleModule = import('../src/warmup-schedule.js');

test('reset schedule chooses today when its warm-up is still in the future', async () => {
  const { resolveWarmupSchedule } = await scheduleModule;
  const result = resolveWarmupSchedule(
    { resetTime: '15:30', timezone: 'Europe/Moscow' },
    Date.parse('2026-09-01T06:00:00.000Z'),
  );

  assert.deepEqual(result, {
    enabled: true,
    mode: 'reset',
    timezone: 'Europe/Moscow',
    resetTime: '15:30',
    warmupTime: '10:30',
    windowSeconds: 18_000,
    nextWarmupAt: '2026-09-01T07:30:00.000Z',
    nextTargetResetAt: '2026-09-01T12:30:00.000Z',
    missedRunPolicy: 'skip',
  });
});

test('reset schedule skips a missed warm-up instead of catching up', async () => {
  const { resolveWarmupSchedule } = await scheduleModule;
  const result = resolveWarmupSchedule(
    { resetTime: '15:30', timezone: 'Europe/Moscow' },
    Date.parse('2026-09-01T08:00:00.000Z'),
  );

  assert.equal(result.nextWarmupAt, '2026-09-02T07:30:00.000Z');
  assert.equal(result.nextTargetResetAt, '2026-09-02T12:30:00.000Z');
});

test('reset schedule returns a strictly future occurrence at the exact boundary', async () => {
  const { resolveWarmupSchedule } = await scheduleModule;
  const result = resolveWarmupSchedule(
    { resetTime: '15:30', timezone: 'Europe/Moscow' },
    Date.parse('2026-09-01T07:30:00.000Z'),
  );

  assert.equal(result.nextWarmupAt, '2026-09-02T07:30:00.000Z');
});

test('reset schedule subtracts an absolute five-hour window across DST', async () => {
  const { resolveWarmupSchedule } = await scheduleModule;
  const result = resolveWarmupSchedule(
    { resetTime: '06:30', timezone: 'America/New_York' },
    Date.parse('2026-03-08T04:00:00.000Z'),
  );

  assert.equal(result.warmupTime, '00:30');
  assert.equal(result.nextWarmupAt, '2026-03-08T05:30:00.000Z');
  assert.equal(result.nextTargetResetAt, '2026-03-08T10:30:00.000Z');
});

test('reset schedule rejects invalid wall times and timezones', async () => {
  const { resolveWarmupSchedule } = await scheduleModule;

  assert.throws(
    () => resolveWarmupSchedule({ resetTime: '25:00', timezone: 'Europe/Moscow' }),
    /HH:MM/,
  );
  assert.throws(
    () => resolveWarmupSchedule({ resetTime: '15:30', timezone: 'Moscow' }),
    /timezone/,
  );
});

test('warm-up config summary reports reset, interval, and off modes', async () => {
  const { resolveWarmupConfig } = await scheduleModule;
  const now = Date.parse('2026-09-01T06:00:00.000Z');

  assert.equal(resolveWarmupConfig({
    warmupSchedule: { resetTime: '15:30', timezone: 'Europe/Moscow' },
  }, now).nextWarmupAt, '2026-09-01T07:30:00.000Z');
  assert.deepEqual(resolveWarmupConfig({ warmupSeconds: 300 }, now), {
    enabled: true,
    mode: 'interval',
    intervalSeconds: 300,
  });
  assert.deepEqual(resolveWarmupConfig({}, now), {
    enabled: false,
    mode: 'off',
  });
});
