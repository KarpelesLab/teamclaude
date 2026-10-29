// The global "what is the proxy doing" banner shown above every page when the
// proxy is not plainly running, with the recovery action that fits the state.

import { Play, RefreshCw, ScrollText } from 'lucide-react';
import type { BackendState, ProxyPhase } from '../../shared/types';
import { call } from '../api';
import { t } from '../i18n';
import { useStore } from '../store';
import { ActionButton, Banner, Button, Rich, type Tone } from './ui';

export function phaseTone(phase: ProxyPhase): Tone {
  switch (phase) {
    case 'running': return 'ok';
    case 'starting':
    case 'stopping': return 'info';
    case 'unreachable':
    case 'port-conflict': return 'warn';
    case 'error':
    case 'crash-loop': return 'bad';
    case 'stopped': return 'muted';
  }
}

export function BackendBanner({ state }: { state: BackendState }) {
  const { run, setPage } = useStore();
  const start = <ActionButton variant="primary" icon={<Play className="size-3.5" aria-hidden />} onAction={() => run(() => call('backend.start'))}>{t('banner.start')}</ActionButton>;
  const logs = <Button icon={<ScrollText className="size-3.5" aria-hidden />} onClick={() => setPage('logs')}>{t('banner.viewLogs')}</Button>;
  const retry = <ActionButton icon={<RefreshCw className="size-3.5" aria-hidden />} onAction={() => call('backend.refresh')}>{t('banner.retry')}</ActionButton>;

  if (state.phase === 'running') {
    if (!state.compatibility.ok) return <Banner tone="bad" title={t('banner.incompatible')}>{state.compatibility.message}</Banner>;
    if (state.status?.readOnly) return <Banner tone="warn" title={t('banner.readOnlyTitle')}>{t('banner.readOnlyBody')}</Banner>;
    if (state.compatibility.message) return <Banner tone="info" title={t('banner.version')}>{state.compatibility.message}</Banner>;
    return null;
  }
  switch (state.phase) {
    case 'stopped':
      return (
        <Banner tone="muted" title={t('banner.notRunning')} actions={start}>
          <Rich text={state.configExists ? t('banner.stoppedBody', { endpoint: state.endpoint }) : t('banner.noConfig')} />
        </Banner>
      );
    case 'starting':
      return <Banner tone="info" title={t('banner.starting')}>{t('banner.startingBody', { endpoint: state.endpoint })}</Banner>;
    case 'stopping':
      return <Banner tone="info" title={t('banner.stopping')} />;
    case 'unreachable':
      return <Banner tone="warn" title={t('banner.unreachable')} actions={<>{retry}{logs}</>}>{state.lastError}</Banner>;
    case 'port-conflict':
      return <Banner tone="warn" title={t('banner.portConflict', { port: state.port })} actions={retry}>{state.lastError}</Banner>;
    case 'error':
      return <Banner tone="bad" title={t('banner.notRunning')} actions={<>{start}{logs}</>}>{state.lastError}</Banner>;
    case 'crash-loop':
      return <Banner tone="bad" title={t('banner.crashLoop')} actions={<>{start}{logs}</>}>{state.lastError}</Banner>;
  }
}
