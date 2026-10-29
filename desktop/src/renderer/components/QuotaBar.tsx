// One quota window: utilization bar, reset countdown, age of the reading.
// With no reading it says "Unknown" and draws an empty bar — it never
// guesses a number. A reading too old to stand for now is drawn as the floor
// it is ("≥ 40%"), dimmed, with its age in the warning colour.

import { RefreshCw } from 'lucide-react';
import type { AccountView, QuotaWindow } from '../../shared/types';
import { call } from '../api';
import { ago, isStaleReading, pct, showSessionRow, showWeeklyRow, until } from '../format';
import { t } from '../i18n';
import { useStore } from '../store';
import { ActionButton, cx } from './ui';

export function QuotaBar({ label, window, now, threshold, emptyHint }: {
  label: string;
  window: QuotaWindow;
  now: number;
  threshold: number | null;
  /** What to say instead of the reset/age line when there is no reading. */
  emptyHint?: string;
}) {
  const u = window.utilization;
  const known = u !== null;
  const width = known ? Math.max(0, Math.min(1, u)) * 100 : 0;
  const stale = isStaleReading(window, now);
  const shown = stale ? t('quota.atLeast', { pct: pct(u) }) : pct(u);
  const staleTitle = stale ? t('quota.staleTitle', { when: ago(window.seenAt, now) }) : undefined;
  const tone = !known ? 'bg-muted/30' : u >= 1 ? 'bg-bad' : threshold !== null && u >= threshold ? 'bg-warn' : 'bg-ok';
  // Two "Unknown"s under an "Unknown" say nothing the bar does not.
  const hint = known ? null : emptyHint ?? (window.resetAt === null && window.seenAt === null ? t('quota.noReading') : null);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate font-medium text-muted">{label}</span>
        <span className={cx('tabular-nums', known && !stale ? 'text-fg' : 'text-muted')} title={staleTitle}>{shown}</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-panel-2"
        role="meter"
        aria-label={t('quota.used', { label })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(width) : undefined}
        aria-valuetext={known ? shown : t('common.unknown')}
      >
        <div className={cx('h-full rounded-full transition-[width] duration-500', tone, stale && 'opacity-40')} style={{ width: `${width}%` }} />
      </div>
      {hint !== null ? (
        <div className="mt-1 truncate text-[11px] text-muted" title={hint}>{hint}</div>
      ) : (
        <div className="mt-1 flex justify-between gap-2 text-[11px] text-muted">
          <span className="truncate">{t('quota.resets', { when: until(window.resetAt, now) })}</span>
          {stale
            ? <span className="truncate text-warn" title={staleTitle}>{t('quota.stale')} · {t('quota.seen', { when: ago(window.seenAt, now) })}</span>
            : <span className="truncate" title={t('quota.seenTitle')}>{t('quota.seen', { when: ago(window.seenAt, now) })}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The 5-hour bar, by the server's own rule (showSessionRow in
 * status-renderer.js): a plan that meters no session window gets no row, and
 * a reading still present is drawn whatever the flag says. The server clears
 * the reading when the window ends, so an empty bar on a plan that does meter
 * one means "ended, the next request opens a new one" — not 0%, since the
 * account may be in use outside the proxy.
 */
export function FiveHourBar({ account, now, threshold }: { account: AccountView; now: number; threshold: number | null }) {
  if (!showSessionRow(account)) return null;
  const empty = account.fiveHour.utilization === null;
  return (
    <QuotaBar
      label={t('quota.fiveHour')}
      window={account.fiveHour}
      now={now}
      threshold={threshold}
      emptyHint={empty && account.sessionWindowStated === true ? t('quota.windowEnded') : undefined}
    />
  );
}

/**
 * The shared weekly bar, by the server's showWeeklyRow rule: a plan with no
 * shared weekly window (a Team seat) gets no row, a reading still present is
 * drawn whatever the flag says, and the reading the server clears at a weekly
 * reset reads as an ended window, not as 0%.
 */
export function WeeklyBar({ account, now, threshold }: { account: AccountView; now: number; threshold: number | null }) {
  if (!showWeeklyRow(account)) return null;
  const empty = account.weekly.utilization === null;
  return (
    <QuotaBar
      label={t('quota.weekly')}
      window={account.weekly}
      now={now}
      threshold={threshold}
      emptyHint={empty && account.weeklyWindowStated === true ? t('quota.windowEnded') : undefined}
    />
  );
}

/**
 * One zero-spend read of every account's quota from the usage endpoint
 * (POST /teamclaude/probe, the TUI's `p`), then a status read so the bars
 * show it at once. Only on a press: nothing here calls out on its own.
 */
export function RefreshQuotasButton({ disabled }: { disabled?: boolean }) {
  const { run } = useStore();
  return (
    <ActionButton
      variant="ghost"
      disabled={disabled}
      title={t('quota.refreshTitle')}
      icon={<RefreshCw className="size-3.5" aria-hidden />}
      onAction={() => run(async () => {
        const result = await call('backend.probe');
        await call('backend.refresh');
        return result;
      })}
    >
      {t('quota.refresh')}
    </ActionButton>
  );
}
