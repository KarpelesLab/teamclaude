import { distributionLabel } from '../../shared/distribution-label';
import { ListTree } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNow } from '../clock';
import { CodeBlock, Card, controlClass, EmptyState, PageHeader, Rich, Stat } from '../components/ui';
import { ago, truncateMiddle } from '../format';
import { t } from '../i18n';
import { useStore } from '../store';

export function Sessions() {
  const { backend } = useStore();
  const now = useNow();
  const status = backend?.status;
  const [account, setAccount] = useState('');
  const [client, setClient] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const items = status?.sessions.items ?? null;

  const accounts = useMemo(() => [...new Set((items ?? []).flatMap(s => Object.values(s.accounts)))].sort(), [items]);
  const clients = useMemo(() => [...new Set((items ?? []).map(s => s.client).filter((c): c is string => !!c))].sort(), [items]);
  const shown = (items ?? []).filter(s =>
    (!account || Object.values(s.accounts).includes(account))
    && (!client || s.client === client)
    && (!onlyActive || s.active));

  if (!status) {
    return (
      <div>
        <PageHeader title={t('sessions.title')} />
        <Card><EmptyState icon={<ListTree className="size-8" aria-hidden />} title={t('banner.notRunning')}>{t('sessions.notRunningBody')}</EmptyState></Card>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader title={t('sessions.title')} subtitle={t('sessions.subtitle')} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        <Stat label={t('sessions.active')} value={status.sessions.active} />
        <Stat label={t('sessions.known')} value={status.sessions.known} />
        <Stat label={t('sessions.distribution')} value={distributionLabel(status.sessions.distribution, t)} />
        <Stat label={t('sessions.draining')} value={status.sessions.draining} sub={t('sessions.drainingSub')} />
        <Stat label={t('sessions.starved')} value={status.sessions.starvedMax} sub={t('sessions.starvedSub')} tone={status.sessions.starvedMax > 0 ? 'warn' : undefined} />
      </div>
      {items === null ? (
        <Card title={t('sessions.detailOffTitle')}>
          <p className="text-[13px] text-muted"><Rich text={t('sessions.detailOffBody')} /></p>
          <div className="mt-2"><CodeBlock>{'"proxy": { "sessionDetail": true }'}</CodeBlock></div>
          <p className="mt-2 text-[12px] text-muted">{t('sessions.detailOffNote')}</p>
        </Card>
      ) : (
        <Card
          title={t('sessions.count', { shown: shown.length, total: items.length })}
          actions={(
            <>
              <select aria-label={t('sessions.filterAccount')} className={`${controlClass} w-44`} value={account} onChange={e => setAccount(e.target.value)}>
                <option value="">{t('sessions.allAccounts')}</option>
                {accounts.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <select aria-label={t('sessions.filterClient')} className={`${controlClass} w-40`} value={client} onChange={e => setClient(e.target.value)}>
                <option value="">{t('sessions.allClients')}</option>
                {clients.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className="flex items-center gap-1.5 text-[12px] text-muted"><input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} />{t('sessions.activeOnly')}</label>
            </>
          )}
        >
          {shown.length === 0 ? <EmptyState title={t('sessions.noMatch')} /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[12.5px]">
                <thead className="text-[11px] uppercase tracking-wider text-muted">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">{t('sessions.colSession')}</th>
                    <th className="pr-3 font-medium">{t('sessions.colClient')}</th>
                    <th className="pr-3 font-medium">{t('sessions.colFamily')}</th>
                    <th className="pr-3 text-right font-medium">{t('sessions.colRequests')}</th>
                    <th className="pr-3 text-right font-medium">{t('sessions.colInFlight')}</th>
                    <th className="font-medium">{t('sessions.colLastSeen')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.map(s => (
                    <tr key={s.id} className={s.active ? '' : 'text-muted'}>
                      <td className="py-1.5 pr-3 font-mono" title={s.conversation ?? s.id}>{truncateMiddle(s.conversation ?? s.id, 22)}</td>
                      <td className="pr-3">{s.client ?? '—'}</td>
                      <td className="pr-3">{Object.entries(s.accounts).map(([bucket, name]) => <div key={bucket} className="truncate">{bucket} → {name}</div>)}</td>
                      <td className="pr-3 text-right tabular-nums">{s.requests}</td>
                      <td className="pr-3 text-right tabular-nums">{s.inFlight}</td>
                      <td>{ago(s.lastSeen, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
