import { Download } from 'lucide-react';
import { cacheHitRate, usageRows, usageTotals } from '../../shared/usage';
import { call } from '../api';
import { ActionButton, Card, EmptyState, PageHeader, Stat } from '../components/ui';
import { pct } from '../format';
import { t } from '../i18n';
import { useStore } from '../store';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat();
const n = (value: number) => compact.format(value);

/** Token counts per account as the proxy has counted them since it started. */
export function Usage() {
  const { backend, run } = useStore();
  const accounts = backend?.status?.accounts ?? [];
  const rows = usageRows(accounts).sort((a, b) => b.total - a.total);
  const totals = usageTotals(rows);
  const hit = cacheHitRate(totals);
  const exportCsv = () => run(() => call('usage.exportCsv'));

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('usage.title')}
        subtitle={t('usage.subtitle')}
        actions={<ActionButton icon={<Download className="size-3.5" aria-hidden />} disabled={!rows.length} onAction={exportCsv}>{t('usage.export')}</ActionButton>}
      />
      {!rows.length ? (
        <EmptyState title={t('usage.empty')}>{t('usage.emptyBody')}</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4">
            <Stat label={t('usage.totalTokens')} value={n(totals.total)} sub={full.format(totals.total)} />
            <Stat label={t('usage.requests')} value={n(totals.requests)} />
            <Stat label={t('usage.output')} value={n(totals.output)} />
            <Stat label={t('usage.cacheHit')} value={pct(hit)} sub={t('usage.cacheHitSub')} />
          </div>
          <Card title={t('usage.byAccount')}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[12px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                    <th className="py-1.5 pr-3 font-medium">{t('usage.account')}</th>
                    <th className="py-1.5 pr-3 text-right font-medium">{t('usage.requests')}</th>
                    <th className="py-1.5 pr-3 text-right font-medium">{t('usage.input')}</th>
                    <th className="py-1.5 pr-3 text-right font-medium">{t('usage.cacheRead')}</th>
                    <th className="py-1.5 pr-3 text-right font-medium">{t('usage.cacheWrite')}</th>
                    <th className="py-1.5 pr-3 text-right font-medium">{t('usage.output')}</th>
                    <th className="py-1.5 font-medium">{t('usage.share')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map(r => {
                    const share = totals.total ? r.total / totals.total : 0;
                    return (
                      <tr key={`${r.provider}/${r.account}`} className="tabular-nums">
                        <td className="py-1.5 pr-3"><span className="text-fg">{r.account}</span> <span className="text-muted">· {r.provider}</span></td>
                        <td className="py-1.5 pr-3 text-right">{full.format(r.requests)}</td>
                        <td className="py-1.5 pr-3 text-right" title={full.format(r.input)}>{n(r.input)}</td>
                        <td className="py-1.5 pr-3 text-right" title={full.format(r.cacheRead)}>{n(r.cacheRead)}</td>
                        <td className="py-1.5 pr-3 text-right" title={full.format(r.cacheWrite)}>{n(r.cacheWrite)}</td>
                        <td className="py-1.5 pr-3 text-right" title={full.format(r.output)}>{n(r.output)}</td>
                        <td className="w-40 py-1.5">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={t('usage.share')}>
                              <div className="h-full rounded-full bg-accent" style={{ width: `${share * 100}%` }} />
                            </div>
                            <span className="w-9 text-right text-muted">{pct(share)}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-muted">{t('usage.note')}</p>
          </Card>
        </>
      )}
    </div>
  );
}
