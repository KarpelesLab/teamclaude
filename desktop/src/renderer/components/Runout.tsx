// Forecast lines: when an account reaches its limit at the current pace, if
// that comes before the window resets. Nothing is shown without a forecast.

import { TrendingUp } from 'lucide-react';
import { runouts, type Runout } from '../../shared/forecast';
import type { AccountView } from '../../shared/types';
import { useNow } from '../clock';
import { pct, until } from '../format';
import { t } from '../i18n';
import { useStore } from '../store';

export function runoutWindow(r: Runout): string {
  if (r.window === 'fiveHour') return t('forecast.fiveHour');
  return r.family ? t('forecast.model', { model: r.family }) : t('forecast.weekly');
}

export function runoutText(r: Runout, now: number): string {
  return t('forecast.line', { window: runoutWindow(r), when: until(r.at, now), level: pct(r.level) });
}

export function RunoutLines({ account }: { account: AccountView }) {
  const { quota } = useStore();
  const now = useNow();
  const list = runouts(account, quota, now);
  if (!list.length) return null;
  return (
    <ul className="mt-2 space-y-0.5">
      {list.map(r => (
        <li key={`${r.window}-${r.family ?? ''}`} className="flex items-center gap-1.5 text-[11px] text-warn">
          <TrendingUp className="size-3 shrink-0" aria-hidden />
          <span>{runoutText(r, now)}</span>
        </li>
      ))}
    </ul>
  );
}
