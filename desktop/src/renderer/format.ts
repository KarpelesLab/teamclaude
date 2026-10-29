// Display helpers. A missing value is shown as "Unknown" — never estimated.

import type { ActivityEvent } from '../shared/activity';
import type { AccountView, QuotaWindow } from '../shared/types';
import { t, type MessageKey } from './i18n';

export function unknown(): string {
  return t('common.unknown');
}

export function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? unknown() : `${Math.round(value * 100)}%`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${t('time.d', { n: d })} ${t('time.h', { n: h })}`;
  if (h > 0) return `${t('time.h', { n: h })} ${t('time.m', { n: m })}`;
  if (m > 0) return t('time.m', { n: m });
  return t('time.s', { n: s });
}

export function until(at: number | null | undefined, now: number): string {
  if (at === null || at === undefined) return unknown();
  if (at <= now) return t('time.now');
  return t('time.in', { t: duration(at - now) });
}

export function ago(at: number | null | undefined, now: number): string {
  if (at === null || at === undefined) return unknown();
  const ms = now - at;
  if (ms < 5000) return t('time.justNow');
  return t('time.ago', { t: duration(ms) });
}

/**
 * How old a quota reading may be before it is shown as stale: the server's own
 * STATUS_STALE_MS default (account-manager.js). With the probe off nothing
 * revalidates an idle account, and outside spend is invisible to the proxy.
 */
export const STALE_READING_MS = 30 * 60_000;

/**
 * A reading the window has not reset past yet, but too old to stand for now.
 * Usage only grows within a window, so it is a floor, not the current value.
 */
export function isStaleReading(w: QuotaWindow, now: number): boolean {
  if (w.utilization === null || w.seenAt === null) return false;
  if (w.resetAt !== null && w.resetAt <= now) return false;
  return now - w.seenAt >= STALE_READING_MS;
}

export function isoUntil(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : until(at, now);
}

/** The server's `unavailable` reason codes (account-manager.js unavailableReason). */
export const REASON_CODES = [
  'disabled', 'spend-capped', 'capped', 'entitlement', 'routing', 'credential', 'throttled', 'exhausted',
  'error', 'quota', 'upstream-rejected', 'route', 'advisor-capped', 'advisor-quota', 'advisor-route',
] as const;

export function unavailableText(code: string | null): string {
  if (code === null) return t('reason.available');
  return (REASON_CODES as readonly string[]).includes(code) ? t(`reason.${code}` as MessageKey) : code;
}

export function phaseText(phase: string): string {
  return t(`phase.${phase}` as MessageKey);
}

/**
 * The server's own row rules (showSessionRow / showWeeklyRow in
 * status-renderer.js): a window the plan does not meter gets no row, and a
 * reading still present is drawn whatever the flag says.
 */
export function showSessionRow(a: Pick<AccountView, 'fiveHour' | 'sessionWindowStated'>): boolean {
  return a.sessionWindowStated !== false || a.fiveHour.utilization !== null;
}

export function showWeeklyRow(a: Pick<AccountView, 'weekly' | 'weeklyWindowStated'>): boolean {
  return a.weeklyWindowStated !== false || a.weekly.utilization !== null;
}

/** The words for a timeline entry, in the current language. */
export function activityText(event: ActivityEvent): string {
  const d = event.detail;
  const name = event.account ?? '';
  const none = t('overview.none');
  switch (d.type) {
    case 'phase': {
      const text = t('ev.phase', { from: phaseText(d.from), to: phaseText(d.to) });
      return d.error ? `${text}: ${d.error}` : text;
    }
    case 'switch': return t('ev.switch', { provider: event.provider ?? '', from: d.from ?? none, to: d.to ?? none });
    case 'appeared': return t('ev.appeared', { name });
    case 'removed': return t('ev.removed', { name });
    case 'availability': return t('ev.availability', { name, from: unavailableText(d.from), to: unavailableText(d.to) });
    case 'error': return t('ev.error', { name, code: d.code, detail: d.detail });
  }
}

export function truncateMiddle(text: string, max = 24): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}
