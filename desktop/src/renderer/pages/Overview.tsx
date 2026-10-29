import { ExternalLink, Play, RefreshCw, RotateCw, ScrollText, Square } from 'lucide-react';
import type { AccountView, BackendState } from '../../shared/types';
import { call } from '../api';
import { useNow } from '../clock';
import { phaseTone } from '../components/BackendBanner';
import { FiveHourBar, RefreshQuotasButton, WeeklyBar } from '../components/QuotaBar';
import { Sparkline } from '../components/Sparkline';
import { soonestRunout } from '../../shared/forecast';
import { runoutText } from '../components/Runout';
import { ActionButton, Badge, Banner, Button, Card, CopyButton, Dot, PageHeader, Stat } from '../components/ui';
import { ago, duration, phaseText, unavailableText, unknown, until } from '../format';
import { t } from '../i18n';
import { useStore } from '../store';

function earliest(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? Math.min(...known) : null;
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function ProxyCard({ state }: { state: BackendState }) {
  const { run, setPage } = useStore();
  const running = state.phase === 'running';
  const busy = state.phase === 'starting' || state.phase === 'stopping';
  const owned = state.ownership === 'owned';
  const server = state.status?.server;
  const startedBy = state.ownership === 'none' ? '—'
    : owned ? t('overview.byApp') : state.serviceInstalled ? t('overview.byService') : t('overview.byOther');
  return (
    <Card
      title={t('overview.proxy')}
      actions={(
        <>
          {!running && <ActionButton variant="primary" disabled={busy} icon={<Play className="size-3.5" aria-hidden />} onAction={() => run(() => call('backend.start'))}>{t('common.start')}</ActionButton>}
          {running && owned && <ActionButton icon={<Square className="size-3.5" aria-hidden />} onAction={() => run(() => call('backend.stop'))}>{t('common.stop')}</ActionButton>}
          {running && owned && <ActionButton icon={<RotateCw className="size-3.5" aria-hidden />} onAction={() => run(() => call('backend.restart'))}>{t('common.restart')}</ActionButton>}
          <ActionButton variant="ghost" icon={<RefreshCw className="size-3.5" aria-hidden />} onAction={() => call('backend.refresh')}>{t('common.refresh')}</ActionButton>
          <ActionButton variant="ghost" disabled={!running} icon={<ExternalLink className="size-3.5" aria-hidden />} onAction={() => run(() => call('system.openDashboard'))}>{t('overview.webDashboard')}</ActionButton>
          <Button variant="ghost" icon={<ScrollText className="size-3.5" aria-hidden />} onClick={() => setPage('logs')}>{t('common.logs')}</Button>
        </>
      )}
    >
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-6 gap-y-3 text-[13px]">
        <Term label={t('overview.state')}><span className="flex items-center gap-2"><Dot tone={phaseTone(state.phase)} pulse={busy} />{phaseText(state.phase)}</span></Term>
        <Term label={t('overview.startedBy')}>{startedBy}</Term>
        <Term label={t('overview.endpoint')}>
          <span className="flex items-center gap-1">
            <span className="truncate font-mono text-[12px]">{state.endpoint}</span>
            <CopyButton text={state.endpoint} label="" onCopy={text => call('system.copyText', { text })} />
          </span>
        </Term>
        <Term label={t('overview.backend')}>
          {server?.version ?? unknown()}{server?.updateAvailable && <> <Badge tone="info">{t('overview.update', { v: server.updateAvailable })}</Badge></>}
        </Term>
        <Term label={t('overview.uptime')}>{server?.uptimeSeconds != null ? duration(server.uptimeSeconds * 1000) : '—'}</Term>
      </dl>
    </Card>
  );
}

function AccountQuotaRow({ account, now, threshold }: { account: AccountView; now: number; threshold: number | null }) {
  return (
    <div className="grid grid-cols-[minmax(140px,1.2fr)_1fr_1fr] items-center gap-4 py-2 max-[700px]:grid-cols-1">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Dot tone={account.disabled ? 'muted' : account.unavailable ? 'warn' : 'ok'} />
          <span className="truncate text-[13px] text-fg" title={account.name}>{account.name}</span>
          {account.isCurrent && <Badge tone="accent">{t('common.current')}</Badge>}
        </div>
        <div className="truncate pl-3.5 text-[11px] text-muted">{account.provider} · {unavailableText(account.unavailable)}</div>
      </div>
      <FiveHourBar account={account} now={now} threshold={threshold} />
      <WeeklyBar account={account} now={now} threshold={threshold} />
    </div>
  );
}

export function Overview() {
  const { backend, samples, quota, setPage } = useStore();
  const now = useNow();
  if (!backend) return null;
  const status = backend.status;
  const accounts = status?.accounts ?? [];
  const available = accounts.filter(a => !a.disabled && a.unavailable === null).length;
  const exhausted = accounts.filter(a => a.status === 'exhausted' || a.unavailable === 'exhausted').length;
  const requestCounts = accounts.map(a => a.totalRequests).filter((n): n is number => n !== null);
  const requests = requestCounts.length ? requestCounts.reduce((a, b) => a + b, 0) : null;
  const warnings = accounts.filter(a => a.error || a.unavailable === 'credential');
  const providers = Object.entries(status?.currentAccounts ?? {});

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('overview.title')}
        subtitle={backend.statusAt ? t('overview.updated', { when: ago(backend.statusAt, now) }) : t('overview.noData')}
      />
      <ProxyCard state={backend} />
      {(() => {
        const soonest = status ? soonestRunout(status.accounts, quota, now) : null;
        if (!soonest) return null;
        return (
          <Banner tone="warn" title={t('forecast.bannerTitle', { name: soonest.account.name })} actions={<Button variant="ghost" onClick={() => setPage('accounts')}>{t('forecast.bannerAction')}</Button>}>
            {runoutText(soonest.runout, now)}
          </Banner>
        );
      })()}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        <Stat label={t('overview.accounts')} value={status ? accounts.length : '—'} sub={status ? t('overview.disabledCount', { n: accounts.filter(a => a.disabled).length }) : undefined} />
        <Stat label={t('overview.available')} value={status ? available : '—'} tone={status && available === 0 && accounts.length > 0 ? 'bad' : 'ok'} />
        <Stat label={t('overview.outOfQuota')} value={status ? exhausted : '—'} tone={exhausted > 0 ? 'warn' : undefined} />
        <Stat label={t('overview.sessions')} value={status ? status.sessions.active : '—'} sub={status ? t('overview.knownHour', { n: status.sessions.known }) : undefined} />
        <Stat label={t('overview.requests')} value={requests ?? '—'} sub={t('overview.sinceStart')} />
      </div>

      {status && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">
          <Card title={t('overview.current')}>
            {providers.length === 0 ? <p className="text-[13px] text-muted">{t('overview.noAccounts')}</p> : (
              <ul className="space-y-1.5 text-[13px]">
                {providers.map(([provider, name]) => (
                  <li key={provider} className="flex justify-between gap-3">
                    <span className="text-muted">{provider}</span>
                    <span className="truncate text-fg" title={name ?? ''}>{name ?? t('overview.none')}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 text-[12px]">
              <div><div className="text-muted">{t('overview.next5h')}</div><div className="text-fg">{until(earliest(accounts.map(a => a.fiveHour.resetAt)), now)}</div></div>
              <div><div className="text-muted">{t('overview.nextWeekly')}</div><div className="text-fg">{until(earliest(accounts.map(a => a.weekly.resetAt)), now)}</div></div>
            </div>
          </Card>
          <Card title={t('overview.chart')}>
            <Sparkline values={samples.map(s => s.activeSessions)} label={t('overview.chartLabel')} />
            <p className="mt-2 text-[11px] text-muted">
              {status.probe.enabled ? t('overview.sourceProbe', { s: status.probe.intervalSeconds }) : t('overview.sourceTraffic')}
            </p>
          </Card>
        </div>
      )}

      {warnings.length > 0 && (
        <Card title={t('overview.attention')} actions={<Button onClick={() => setPage('accounts')}>{t('overview.openAccounts')}</Button>}>
          <ul className="space-y-1.5 text-[13px]">
            {warnings.map(a => (
              <li key={`${a.provider}/${a.name}`} className="break-words">
                <span className="font-medium text-fg">{a.name}</span>{' '}
                <span className="text-muted">
                  — {a.error ? `${a.error.detail}${a.error.remedy ? ` (${t('overview.fix', { remedy: a.error.remedy })})` : ''}` : unavailableText(a.unavailable)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {status && accounts.length > 0 && (
        <Card
          title={t('quota.title')}
          actions={(
            <>
              <RefreshQuotasButton />
              <Button variant="ghost" onClick={() => setPage('accounts')}>{t('overview.allDetails')}</Button>
            </>
          )}
        >
          <div className="divide-y divide-border">
            {accounts.map(a => <AccountQuotaRow key={`${a.provider}/${a.name}`} account={a} now={now} threshold={status.switchThreshold} />)}
          </div>
        </Card>
      )}
    </div>
  );
}
