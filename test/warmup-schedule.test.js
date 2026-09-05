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

test('rolling schedule advances from its persisted anchor in absolute five-hour steps', async () => {
  const { resolveWarmupSchedule } = await scheduleModule;
  const result = resolveWarmupSchedule(
    {
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2026-09-01T12:30:00.000Z',
    },
    Date.parse('2026-09-02T08:00:00.000Z'),
  );

  assert.deepEqual(result, {
    enabled: true,
    mode: 'rolling',
    timezone: 'Europe/Moscow',
    resetTime: '15:30',
    anchorResetAt: '2026-09-01T12:30:00.000Z',
    cadenceSeconds: 18_000,
    windowSeconds: 18_000,
    nearResetToleranceSeconds: 120,
    postResetBufferSeconds: 10,
    nextWarmupAt: '2026-09-02T08:30:00.000Z',
    nextTargetResetAt: '2026-09-02T13:30:00.000Z',
    missedRunPolicy: 'skip',
  });
});

test('rolling schedule creation chooses the next attainable reset after today\'s warm-up passed', async () => {
  const { createRollingWarmupSchedule, resolveWarmupSchedule } = await scheduleModule;
  const schedule = createRollingWarmupSchedule(
    { resetTime: '15:30', timezone: 'Europe/Moscow' },
    Date.parse('2026-09-03T08:00:00.000Z'),
  );

  assert.deepEqual(schedule, {
    mode: 'rolling',
    resetTime: '15:30',
    timezone: 'Europe/Moscow',
    anchorResetAt: '2026-09-04T12:30:00.000Z',
  });
  const resolved = resolveWarmupSchedule(schedule, Date.parse('2026-09-03T08:00:00.000Z'));
  assert.equal(resolved.nextWarmupAt, '2026-09-04T07:30:00.000Z');
  assert.equal(resolved.nextTargetResetAt, '2026-09-04T12:30:00.000Z');
});

test('rolling schedule creation treats the exact warm-up boundary as already missed', async () => {
  const { createRollingWarmupSchedule } = await scheduleModule;
  const schedule = createRollingWarmupSchedule(
    { resetTime: '15:30', timezone: 'Europe/Moscow' },
    Date.parse('2026-09-03T07:30:00.000Z'),
  );

  assert.equal(schedule.anchorResetAt, '2026-09-04T12:30:00.000Z');
});

test('rolling confirmation disambiguates every instant across DST transitions', async () => {
  const { formatWarmupScheduleConfirmation } = await scheduleModule;
  const fall = formatWarmupScheduleConfirmation({
    mode: 'rolling',
    resetTime: '06:30',
    timezone: 'America/New_York',
    anchorResetAt: '2026-11-01T11:30:00.000Z',
  }, Date.parse('2026-11-01T04:00:00.000Z'));
  const spring = formatWarmupScheduleConfirmation({
    mode: 'rolling',
    resetTime: '06:30',
    timezone: 'America/New_York',
    anchorResetAt: '2026-03-08T10:30:00.000Z',
  }, Date.parse('2026-03-08T04:00:00.000Z'));

  assert.match(fall, /Next warm-up:\s+2026-11-01 01:30 America\/New_York \(UTC-05:00; 2026-11-01T06:30:00\.000Z\)/);
  assert.match(fall, /Expected reset:\s+2026-11-01 06:30 America\/New_York \(UTC-05:00; 2026-11-01T11:30:00\.000Z\)/);
  assert.match(spring, /Next warm-up:\s+2026-03-08 00:30 America\/New_York \(UTC-05:00; 2026-03-08T05:30:00\.000Z\)/);
  assert.match(spring, /Expected reset:\s+2026-03-08 06:30 America\/New_York \(UTC-04:00; 2026-03-08T10:30:00\.000Z\)/);
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

test('rolling schedule rejects a mismatched anchor and unknown schedule modes', async () => {
  const { resolveWarmupSchedule } = await scheduleModule;

  assert.throws(
    () => resolveWarmupSchedule({
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2026-09-01T12:30:00.999Z',
    }),
    /anchorResetAt must match 15:30 Europe\/Moscow/,
  );
  assert.throws(
    () => resolveWarmupSchedule({
      mode: 'rolling',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
      anchorResetAt: '2026-09-01T12:00:00.000Z',
    }),
    /anchorResetAt must match 15:30 Europe\/Moscow/,
  );
  assert.throws(
    () => resolveWarmupSchedule({
      mode: 'typo',
      resetTime: '15:30',
      timezone: 'Europe/Moscow',
    }),
    /unknown warm-up schedule mode: typo/,
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
