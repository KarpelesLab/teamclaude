const WINDOW_MS = 5 * 60 * 60 * 1000;
const formatterCache = new Map();

function formatter(timezone) {
  let value = formatterCache.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, value);
  }
  return value;
}

function localParts(epochMs, timezone) {
  const values = {};
  for (const part of formatter(timezone).formatToParts(epochMs)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

function timezoneOffset(epochMs, timezone) {
  const p = localParts(epochMs, timezone);
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return localAsUtc - Math.floor(epochMs / 1000) * 1000;
}

function sameLocalMinute(epochMs, wanted, timezone) {
  const actual = localParts(epochMs, timezone);
  return actual.year === wanted.year
    && actual.month === wanted.month
    && actual.day === wanted.day
    && actual.hour === wanted.hour
    && actual.minute === wanted.minute;
}

function localInstant(wanted, timezone) {
  const naiveUtc = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute);
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 3) {
    offsets.add(timezoneOffset(naiveUtc + hours * 60 * 60 * 1000, timezone));
  }
  const matches = [...offsets]
    .map(offset => naiveUtc - offset)
    .filter(epochMs => sameLocalMinute(epochMs, wanted, timezone))
    .sort((a, b) => a - b);
  return matches[0] ?? null;
}

function addCalendarDays(date, days) {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function formatTime(epochMs, timezone) {
  const p = localParts(epochMs, timezone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function normalizeSchedule(schedule) {
  const match = /^(\d{2}):(\d{2})$/.exec(schedule?.resetTime || '');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error('reset time must use HH:MM in the 00:00-23:59 range');
  }
  if (!schedule?.timezone) throw new Error('timezone is required');
  let timezone;
  try {
    timezone = new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone })
      .resolvedOptions().timeZone;
  } catch {
    throw new Error(`invalid IANA timezone: ${schedule.timezone}`);
  }
  if (schedule.mode != null && schedule.mode !== 'rolling') {
    throw new Error(`unknown warm-up schedule mode: ${schedule.mode}`);
  }
  return {
    resetTime: `${match[1]}:${match[2]}`,
    resetHour: Number(match[1]),
    resetMinute: Number(match[2]),
    timezone,
  };
}

/** Create a persisted rolling schedule anchored to the next attainable reset. */
export function createRollingWarmupSchedule(schedule, now = Date.now()) {
  const normalized = normalizeSchedule(schedule);
  const today = localParts(now, normalized.timezone);
  for (let dayOffset = 0; dayOffset < 370; dayOffset++) {
    const date = addCalendarDays(today, dayOffset);
    const resetAt = localInstant({
      ...date,
      hour: normalized.resetHour,
      minute: normalized.resetMinute,
    }, normalized.timezone);
    if (resetAt == null || resetAt - WINDOW_MS <= now) continue;
    return {
      mode: 'rolling',
      resetTime: normalized.resetTime,
      timezone: normalized.timezone,
      anchorResetAt: new Date(resetAt).toISOString(),
    };
  }
  throw new Error('could not resolve the rolling reset anchor');
}

/** Resolve a persisted reset target into the next future warm-up occurrence. */
export function resolveWarmupSchedule(schedule, now = Date.now()) {
  const normalized = normalizeSchedule(schedule);
  if (schedule.mode === 'rolling') {
    const anchorResetAt = Date.parse(schedule.anchorResetAt || '');
    if (!Number.isFinite(anchorResetAt)) throw new Error('rolling schedule requires a valid anchorResetAt');
    const anchorLocal = localParts(anchorResetAt, normalized.timezone);
    if (anchorLocal.hour !== normalized.resetHour
      || anchorLocal.minute !== normalized.resetMinute
      || anchorLocal.second !== 0
      || anchorResetAt % 60_000 !== 0) {
      throw new Error(`anchorResetAt must match ${normalized.resetTime} ${normalized.timezone}`);
    }
    const anchorWarmupAt = anchorResetAt - WINDOW_MS;
    const elapsed = now - anchorWarmupAt;
    const steps = elapsed < 0 ? 0 : Math.floor(elapsed / WINDOW_MS) + 1;
    const nextWarmupAt = anchorWarmupAt + steps * WINDOW_MS;
    return {
      enabled: true,
      mode: 'rolling',
      timezone: normalized.timezone,
      resetTime: normalized.resetTime,
      anchorResetAt: new Date(anchorResetAt).toISOString(),
      cadenceSeconds: WINDOW_MS / 1000,
      windowSeconds: WINDOW_MS / 1000,
      nextWarmupAt: new Date(nextWarmupAt).toISOString(),
      nextTargetResetAt: new Date(nextWarmupAt + WINDOW_MS).toISOString(),
      missedRunPolicy: 'skip',
    };
  }
  const today = localParts(now, normalized.timezone);

  for (let dayOffset = 0; dayOffset < 370; dayOffset++) {
    const date = addCalendarDays(today, dayOffset);
    const resetAt = localInstant({
      ...date,
      hour: normalized.resetHour,
      minute: normalized.resetMinute,
    }, normalized.timezone);
    if (resetAt == null) continue;
    const warmupAt = resetAt - WINDOW_MS;
    if (warmupAt <= now) continue;
    return {
      enabled: true,
      mode: 'reset',
      timezone: normalized.timezone,
      resetTime: normalized.resetTime,
      warmupTime: formatTime(warmupAt, normalized.timezone),
      windowSeconds: WINDOW_MS / 1000,
      nextWarmupAt: new Date(warmupAt).toISOString(),
      nextTargetResetAt: new Date(resetAt).toISOString(),
      missedRunPolicy: 'skip',
    };
  }

  throw new Error('could not resolve the next warm-up occurrence');
}

function timezoneLabel(epochMs, timezone) {
  const value = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).formatToParts(epochMs).find(part => part.type === 'timeZoneName')?.value || 'GMT';
  return value.replace('GMT', 'UTC');
}

function localDateTime(epochMs, timezone) {
  const p = localParts(epochMs, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${formatTime(epochMs, timezone)}`;
}

function zonedInstant(epochMs, timezone) {
  return `${localDateTime(epochMs, timezone)} ${timezone} (${timezoneLabel(epochMs, timezone)}; ${new Date(epochMs).toISOString()})`;
}

/** Format the saved schedule using its local timezone and absolute UTC instants. */
export function formatWarmupScheduleConfirmation(schedule, now = Date.now()) {
  const resolved = resolveWarmupSchedule(schedule, now);
  const warmupAt = Date.parse(resolved.nextWarmupAt);
  const resetAt = Date.parse(resolved.nextTargetResetAt);
  if (resolved.mode === 'rolling') {
    const anchorResetAt = Date.parse(resolved.anchorResetAt);
    return [
      'Rolling warm-up schedule saved',
      `Reset anchor:   ${zonedInstant(anchorResetAt, resolved.timezone)}`,
      'Cadence:        every 5 hours (Anthropic-defined)',
      `Next warm-up:   ${zonedInstant(warmupAt, resolved.timezone)}`,
      `Expected reset: ${zonedInstant(resetAt, resolved.timezone)}`,
      'Missed runs:    skipped',
    ].join('\n');
  }
  const warmupUtc = `${String(new Date(warmupAt).getUTCHours()).padStart(2, '0')}:${String(new Date(warmupAt).getUTCMinutes()).padStart(2, '0')}`;
  return [
    'Warm-up schedule saved',
    `Target reset:   daily at ${resolved.resetTime} ${resolved.timezone} (${timezoneLabel(resetAt, resolved.timezone)})`,
    `Warm-up:        daily at ${resolved.warmupTime} ${resolved.timezone} (${warmupUtc} UTC)`,
    'Quota window:   5 hours (Anthropic-defined)',
    `Next warm-up:   ${localDateTime(warmupAt, resolved.timezone)} ${resolved.timezone}`,
    `Expected reset: ${localDateTime(resetAt, resolved.timezone)} ${resolved.timezone}`,
    'Missed runs:    skipped',
  ].join('\n');
}

/** Resolve either configured warm-up mode for lightweight status consumers. */
export function resolveWarmupConfig(config, now = Date.now()) {
  if (config?.warmupSchedule) return resolveWarmupSchedule(config.warmupSchedule, now);
  const intervalSeconds = Number(config?.warmupSeconds) || 0;
  if (intervalSeconds > 0) {
    return { enabled: true, mode: 'interval', intervalSeconds };
  }
  return { enabled: false, mode: 'off' };
}
