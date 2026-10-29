// The quota widget: a small always-on-top window (main/window.ts, #mini) with
// each account's 5-hour and weekly use. The title bar drags the window.

import { X } from 'lucide-react';
import { soonestRunout } from '../../shared/forecast';
import type { AccountView } from '../../shared/types';
import { call } from '../api';
import { useNow } from '../clock';
import { runoutText } from '../components/Runout';
import { cx } from '../components/ui';
import { pct } from '../format';
import { t } from '../i18n';
import { useStore } from '../store';

function Bar({ value, threshold }: { value: number | null; threshold: number | null }) {
  const width = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  const tone = value === null ? 'bg-muted/30' : value >= 1 ? 'bg-bad' : threshold !== null && value >= threshold ? 'bg-warn' : 'bg-ok';
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-panel-2">
      <div className={cx('h-full rounded-full', tone)} style={{ width: `${width}%` }} />
    </div>
  );
}

function Row({ account, threshold }: { account: AccountView; threshold: number | null }) {
  return (
    <li className={cx('py-1', (account.disabled || account.unavailable) && 'opacity-50')}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className={cx('truncate', account.isCurrent ? 'font-semibold text-accent' : 'text-fg')}>{account.name}</span>
        <span className="shrink-0 tabular-nums text-muted">5h {pct(account.fiveHour.utilization)} · 7d {pct(account.weekly.utilization)}</span>
      </div>
      <div className="mt-0.5 grid grid-cols-2 gap-1.5">
        <Bar value={account.fiveHour.utilization} threshold={threshold} />
        <Bar value={account.weekly.utilization} threshold={threshold} />
      </div>
    </li>
  );
}

export function Mini() {
  const { backend, quota } = useStore();
  const now = useNow();
  const status = backend?.status;
  const accounts = status?.accounts ?? [];
  const soonest = soonestRunout(accounts, quota, now);
  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <div className="flex items-center justify-between border-b border-border px-2.5 py-1 [-webkit-app-region:drag]">
        <span className="text-[11px] font-medium text-muted">TeamClaude</span>
        <button
          type="button"
          className="rounded p-0.5 text-muted hover:bg-panel-2 hover:text-fg [-webkit-app-region:no-drag]"
          aria-label={t('widget.close')}
          title={t('widget.close')}
          onClick={() => void call('settings.update', { widget: false })}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-1">
        {backend?.phase !== 'running' ? (
          <p className="py-2 text-[11px] text-muted">{t('widget.notRunning')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {accounts.map(a => <Row key={`${a.provider}/${a.name}`} account={a} threshold={status?.switchThreshold ?? null} />)}
          </ul>
        )}
        {soonest && <p className="pb-1 pt-1 text-[10px] text-warn">{soonest.account.name}: {runoutText(soonest.runout, now)}</p>}
      </div>
    </div>
  );
}
