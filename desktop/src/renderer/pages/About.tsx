import { Download, ExternalLink, RefreshCw, RotateCw, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ExternalLink as ExternalLinkTarget } from '../../shared/ipc';
import type { AppUpdateState, CoreUpdateState, SystemInfo, UpdateCheckResult } from '../../shared/types';
import { call } from '../api';
import { ActionButton, Banner, Button, Card, PageHeader } from '../components/ui';
import { phaseText, unknown } from '../format';
import { t, type MessageKey } from '../i18n';
import { useStore } from '../store';

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-[13px]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-right text-fg">{value ?? unknown()}</dd>
    </div>
  );
}

type Link = ExternalLinkTarget;

function appUpdateText(s: AppUpdateState): string {
  if (s.unsupported) return t(`about.appUnsupported.${s.unsupported}` as MessageKey);
  const latest = s.latest ?? '';
  switch (s.phase) {
    case 'idle': return t('about.appIdle');
    case 'checking': return t('about.appChecking');
    case 'up-to-date': return t('about.appUpToDate');
    case 'available': return t('about.appAvailable', { latest });
    case 'downloading': return t('about.appDownloading', { latest, progress: s.progress ?? 0 });
    case 'ready': return t('about.appReady', { latest });
    case 'error': return t('about.appError', { error: s.error ?? '' });
  }
}

/** This app's own updates from the fork's releases. */
function AppUpdateCard() {
  const { appUpdate, run } = useStore();
  if (!appUpdate) return null;
  const busy = appUpdate.phase === 'checking' || appUpdate.phase === 'downloading';
  const releases = () => run(() => call('system.openExternal', { target: 'desktopReleases' }));
  return (
    <Card title={t('about.appTitle')}>
      <div className="text-[13px] text-fg">{t('about.appCurrent', { version: appUpdate.current })}</div>
      <p className={`mt-1 text-[12px] ${appUpdate.phase === 'error' ? 'text-bad' : 'text-muted'}`}>{appUpdateText(appUpdate)}</p>
      {appUpdate.phase === 'downloading' && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={appUpdate.progress ?? 0}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${appUpdate.progress ?? 0}%` }} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {appUpdate.phase === 'ready' ? (
          <ActionButton variant="primary" icon={<RotateCw className="size-3.5" aria-hidden />} onAction={() => run(() => call('appUpdate.install'))}>{t('about.appInstall')}</ActionButton>
        ) : appUpdate.phase === 'available' ? (
          <ActionButton variant="primary" icon={<Download className="size-3.5" aria-hidden />} onAction={async () => { await call('appUpdate.download'); }}>{t('about.appDownload')}</ActionButton>
        ) : !appUpdate.unsupported && (
          <ActionButton disabled={busy} icon={<RefreshCw className="size-3.5" aria-hidden />} onAction={async () => { await call('appUpdate.check'); }}>{t('about.appCheck')}</ActionButton>
        )}
        <ActionButton icon={<ExternalLink className="size-3.5" aria-hidden />} onAction={releases}>{t('about.appReleases')}</ActionButton>
      </div>
    </Card>
  );
}

function coreUpdateText(s: CoreUpdateState): string {
  if (s.unsupported === 'development') return t('about.coreUnsupported');
  if (s.rolledBack) return t('about.coreRolledBack', s.rolledBack);
  const latest = s.latest ?? '';
  switch (s.phase) {
    case 'idle': return t('about.coreIdle');
    case 'checking': return t('about.coreChecking');
    case 'up-to-date': return t('about.coreUpToDate');
    case 'available': return t('about.coreAvailable', { latest });
    case 'installing': return t('about.coreInstalling', { latest });
    case 'error': return t('about.coreError', { error: s.error ?? '' });
  }
}

/** The TeamClaude core the proxy runs, kept current from npm. */
function CoreUpdateCard() {
  const { coreUpdate: core, run } = useStore();
  if (!core || core.unsupported === 'no-backend') return null;
  const busy = core.phase === 'checking' || core.phase === 'installing';
  const source = core.source === 'downloaded'
    ? t('about.coreSource.downloaded', { bundled: core.bundled ?? unknown() })
    : core.source ? t(`about.coreSource.${core.source}` as MessageKey) : '';
  return (
    <Card title={t('about.coreTitle')}>
      <div className="text-[13px] text-fg">{t('about.coreCurrent', { version: core.active ?? unknown() })}</div>
      <p className="mt-0.5 text-[12px] text-muted">{source}</p>
      <p className={`mt-1 text-[12px] ${core.phase === 'error' ? 'text-bad' : 'text-muted'}`}>{coreUpdateText(core)}</p>
      {core.phase === 'installing' && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-busy>
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
        </div>
      )}
      {!core.unsupported && (
        <div className="mt-3 flex flex-wrap gap-2">
          {core.phase === 'available' ? (
            <ActionButton variant="primary" icon={<Download className="size-3.5" aria-hidden />} onAction={async () => { await call('coreUpdate.install'); }}>{t('about.coreInstall', { latest: core.latest ?? '' })}</ActionButton>
          ) : (
            <ActionButton disabled={busy} icon={<RefreshCw className="size-3.5" aria-hidden />} onAction={async () => { await call('coreUpdate.check'); }}>{t('about.coreCheck')}</ActionButton>
          )}
          {core.source === 'downloaded' && (
            <ActionButton disabled={busy} icon={<Undo2 className="size-3.5" aria-hidden />} onAction={() => run(() => call('coreUpdate.revert'))}>{t('about.coreRevert')}</ActionButton>
          )}
        </div>
      )}
    </Card>
  );
}

/** One line for the bundled backend and one for an attached external one. */
function UpdateVerdicts({ update, onNotes }: { update: UpdateCheckResult; onNotes: () => void }) {
  if (update.error) return <p className="mt-2 text-[12px] text-bad">{t('about.checkFailed', { error: update.error })}</p>;
  const latest = update.latest ?? '';
  const lines: Array<{ key: string; text: string; old: boolean }> = [];
  if (update.bundled) {
    const { current, updateAvailable } = update.bundled;
    lines.push({ key: 'bundled', old: updateAvailable, text: updateAvailable ? t('about.bundledOld', { current, latest }) : t('about.bundledCurrent', { current }) });
  }
  if (update.external) {
    const { current, updateAvailable } = update.external;
    lines.push({ key: 'external', old: updateAvailable, text: updateAvailable ? t('about.externalOld', { current, latest }) : t('about.externalCurrent', { current }) });
  }
  if (!lines.length) lines.push({ key: 'none', old: false, text: t('about.latestOnly', { latest }) });
  return (
    <div className="mt-2 space-y-1 text-[12px] text-fg">
      {lines.map(line => <p key={line.key}>{line.text}</p>)}
      {lines.some(line => line.old) && <Button variant="ghost" onClick={onNotes}>{t('about.notes')}</Button>}
    </div>
  );
}

export function About() {
  const { backend, run } = useStore();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const phase = backend?.phase;
  useEffect(() => {
    void call('system.info').then(setInfo);
  }, [phase]);
  const open = (target: Link) => () => run(() => call('system.openExternal', { target }));

  return (
    <div className="space-y-4">
      <PageHeader title={t('about.title')} />
      <Banner tone="warn" title={t('about.unofficialTitle')}>{t('about.unofficialBody')}</Banner>
      <Banner tone="info" title={t('about.communityTitle')}>{t('about.communityBody')}</Banner>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">
        <AppUpdateCard />
        <CoreUpdateCard />
        <Card title={t('about.versions')}>
          {info && (
            <dl className="divide-y divide-border">
              <Row label={t('about.desktop')} value={info.desktopVersion} />
              <Row label={t('about.bundled')} value={info.bundledBackendVersion} />
              <Row label={t('about.running')} value={info.backendVersion} />
              <Row label="Electron" value={info.electronVersion} />
              <Row label={t('about.node')} value={info.nodeVersion} />
              <Row label={t('about.os')} value={`${info.os} (${info.arch})`} />
              <Row label={t('about.proxy')} value={phaseText(info.proxyPhase)} />
              <Row label={t('about.lastError')} value={info.lastError?.split('\n')[0] ?? t('common.none')} />
              <Row label={t('about.configDir')} value={info.configDir} />
              <Row label={t('about.appData')} value={info.userDataDir} />
            </dl>
          )}
        </Card>
        <Card title={t('about.project')}>
          <p className="text-[13px] text-muted">{t('about.projectBody')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <ActionButton icon={<ExternalLink className="size-3.5" aria-hidden />} onAction={open('repository')}>{t('about.repository')}</ActionButton>
            <ActionButton icon={<ExternalLink className="size-3.5" aria-hidden />} onAction={open('docs')}>{t('about.docs')}</ActionButton>
            <ActionButton icon={<ExternalLink className="size-3.5" aria-hidden />} onAction={open('issues')}>{t('about.issue')}</ActionButton>
            <ActionButton icon={<ExternalLink className="size-3.5" aria-hidden />} onAction={open('license')}>{t('about.license')}</ActionButton>
          </div>
          <div className="mt-4 border-t border-border pt-3">
            <div className="text-[13px] font-medium text-fg">{t('about.updates')}</div>
            <p className="mt-1 text-[12px] text-muted">{t('about.updatesBody')}</p>
            <ActionButton className="mt-2" icon={<RefreshCw className="size-3.5" aria-hidden />} onAction={async () => setUpdate(await call('system.checkForUpdates'))}>{t('about.check')}</ActionButton>
            {update && <UpdateVerdicts update={update} onNotes={() => void open('releases')()} />}
            <p className="mt-2 text-[12px] text-muted">{t('about.desktopChannel')}</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
