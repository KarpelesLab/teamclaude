import { Activity as ActivityIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Card, controlClass, EmptyState, PageHeader, Rich, type Tone } from '../components/ui';
import type { ActivityEvent } from '../../shared/activity';
import { activityText } from '../format';
import { t, type MessageKey } from '../i18n';
import { useStore } from '../store';

// The backend's own log is English; these words pick out its routing lines.
const ROUTING_LINE = /switch|rotat|exhaust|threshold|rate.?limit|throttl|quota|priority|disabled account|enabled account|sign(ed)? in again|refresh/i;

const KIND_TONE: Record<ActivityEvent['kind'], Tone> = { phase: 'info', switch: 'accent', account: 'muted', error: 'bad' };

export function Activity() {
  const { activity, logs, backend } = useStore();
  const [kind, setKind] = useState<'' | ActivityEvent['kind']>('');
  const [provider, setProvider] = useState('');
  const [search, setSearch] = useState('');
  const providers = useMemo(() => [...new Set(activity.map(e => e.provider).filter((p): p is string => !!p))], [activity]);
  const needle = search.toLowerCase();
  const worded = useMemo(() => activity.map(e => ({ ...e, text: activityText(e) })), [activity]);
  const events = worded.filter(e => (!kind || e.kind === kind) && (!provider || e.provider === provider) && (!needle || e.text.toLowerCase().includes(needle)));
  const routingLines = logs.filter(l => l.stream !== 'desktop' && ROUTING_LINE.test(l.text) && (!needle || l.text.toLowerCase().includes(needle))).slice(-200).reverse();

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('activity.title')}
        subtitle={t('activity.subtitle')}
        actions={(
          <>
            <select aria-label={t('activity.eventType')} className={`${controlClass} w-40`} value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
              <option value="">{t('activity.all')}</option>
              <option value="switch">{t('activity.switches')}</option>
              <option value="account">{t('activity.accountChanges')}</option>
              <option value="error">{t('activity.errors')}</option>
              <option value="phase">{t('activity.proxyState')}</option>
            </select>
            <select aria-label={t('activity.provider')} className={`${controlClass} w-36`} value={provider} onChange={e => setProvider(e.target.value)}>
              <option value="">{t('activity.allProviders')}</option>
              {providers.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <input aria-label={t('common.search')} className={`${controlClass} w-48`} placeholder={t('common.search')} value={search} onChange={e => setSearch(e.target.value)} />
          </>
        )}
      />
      <Card title={t('activity.observed')}>
        {events.length === 0 ? (
          <EmptyState icon={<ActivityIcon className="size-8" aria-hidden />} title={t('activity.emptyTitle')}>{t('activity.emptyBody')}</EmptyState>
        ) : (
          <ol className="divide-y divide-border">
            {events.map(e => (
              <li key={e.id} className="flex items-start gap-3 py-1.5 text-[12.5px]">
                <time className="w-20 shrink-0 tabular-nums text-muted">{new Date(e.at).toLocaleTimeString()}</time>
                <Badge tone={KIND_TONE[e.kind]}>{t(`kind.${e.kind}` as MessageKey)}</Badge>
                <span className="min-w-0 break-words text-fg">{e.text}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card title={t('activity.routingLog')}>
        {backend?.ownership !== 'owned' && <p className="mb-2 text-[12px] text-muted"><Rich text={t('activity.externalNote')} /></p>}
        {routingLines.length === 0 ? <p className="text-[13px] text-muted">{t('activity.noLines')}</p> : (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted">
            {routingLines.map(l => `${new Date(l.at).toLocaleTimeString()}  ${l.text}`).join('\n')}
          </pre>
        )}
      </Card>
    </div>
  );
}
