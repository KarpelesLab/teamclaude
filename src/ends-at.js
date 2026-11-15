// An account's end time (accounts[].endsAt): the moment the operator knows the
// account stops being usable, which no usage response reports — a cancelled
// subscription running to the end of its paid month, a trial. One parser, so
// the config loader, the reload and `teamclaude ends` cannot read the same
// text as two different instants.

// A calendar date with no time. Parsed here rather than by Date.parse, which
// reads this form as midnight UTC: an operator who types the day their
// subscription ends means their own day, as a date-time without an offset
// already does.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// ISO 8601 date-time: seconds, fraction and offset optional. Anything looser
// ("Dec 1", "tomorrow") is left to Date.parse's implementation-defined
// fallbacks on other runtimes, so it is refused rather than guessed at.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/i;

const EPOCH_MS = /^\d{1,16}$/;

/**
 * An end time as epoch milliseconds, or null when the value is not one.
 *
 * Accepts epoch milliseconds (a positive number, or a string of digits) and an
 * ISO 8601 string. A bare date (`2026-12-01`) is the start of that day in
 * local time, and so is a date-time written without an offset.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseEndsAt(value) {
  // 8.64e15 is the last instant a Date can hold.
  if (typeof value === 'number') return value > 0 && value <= 8.64e15 ? Math.trunc(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (EPOCH_MS.test(text)) {
    const ms = Number(text);
    return ms > 0 ? ms : null;
  }
  const date = DATE_ONLY.exec(text);
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const local = new Date(year, month - 1, day);
    // The Date constructor rolls an impossible day over into the next month
    // (Feb 31 becomes Mar 3), which would quietly end the account on a day
    // nobody wrote.
    if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) return null;
    return local.getTime();
  }
  if (!DATE_TIME.test(text)) return null;
  const ms = Date.parse(text.replace(' ', 'T'));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** @param {number} n @param {string} unit */
const count = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * An end time for a status row: the local date, the time when it is not
 * midnight, and how far off it is — `2026-12-01 (in 6 days)`, or
 * `2026-12-01 (ended)` once it has passed.
 *
 * @param {number} endsAt  epoch ms
 * @param {number} now     epoch ms
 */
export function describeEndsAt(endsAt, now) {
  const d = new Date(endsAt);
  /** @param {number} n */
  const two = n => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const atMidnight = d.getHours() === 0 && d.getMinutes() === 0;
  const when = atMidnight ? day : `${day} ${two(d.getHours())}:${two(d.getMinutes())}`;
  const left = endsAt - now;
  if (left <= 0) return `${when} (ended)`;
  const span = left >= DAY_MS ? count(Math.floor(left / DAY_MS), 'day')
    : left >= HOUR_MS ? count(Math.floor(left / HOUR_MS), 'hour')
      : left >= MINUTE_MS ? count(Math.floor(left / MINUTE_MS), 'minute')
        : 'under a minute';
  return `${when} (in ${span})`;
}
