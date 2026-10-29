import { Play, Save, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DistributionMode, RoutingProfile } from '../../shared/types';
import { distributionLabel } from '../../shared/distribution-label';
import { call } from '../api';
import { JobPanel } from '../components/JobPanel';
import { ActionButton, Badge, Banner, Button, Card, controlClass, EmptyState, Field, inputClass, PageHeader, Rich } from '../components/ui';
import { pct, REASON_CODES, unavailableText, unknown } from '../format';
import { t } from '../i18n';
import { useStore } from '../store';

function ThresholdCard() {
  const { backend, run } = useStore();
  const status = backend?.status;
  const current = status?.switchThreshold ?? null;
  const [value, setValue] = useState(current === null ? '' : String(Math.round(current * 1000) / 10));
  useEffect(() => {
    if (current !== null) setValue(String(Math.round(current * 1000) / 10));
  }, [current]);
  const percent = Number(value);
  const valid = value !== '' && Number.isFinite(percent) && percent >= 1 && percent <= 100;
  return (
    <Card title={t('threshold.title')}>
      <p className="mb-3 text-[12px] text-muted">{t('threshold.body', { value: pct(current) })}</p>
      {status?.perBucketThresholds && (
        <div className="mb-3"><Banner tone="warn" title={t('threshold.perBucketTitle')}>{t('threshold.perBucketBody')}</Banner></div>
      )}
      <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); if (valid) void run(() => call('routing.setThreshold', { percent })); }}>
        <div className="w-32"><Field label={t('threshold.percent')}><input className={inputClass} inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} /></Field></div>
        <input type="range" min={1} max={100} step={1} value={valid ? percent : 90} onChange={e => setValue(e.target.value)} className="w-48 accent-[var(--tc-accent)]" aria-label={t('threshold.slider')} />
        <Button type="submit" variant="primary" disabled={!valid || status?.readOnly}>{t('common.apply')}</Button>
      </form>
    </Card>
  );
}

function DistributionCard() {
  const { backend } = useStore();
  const status = backend?.status;
  const mode = status?.sessions.distribution ?? null;
  // A backend that has the load mode reports recentRequests for every account,
  // in every mode; an older one would refuse `distribute load`.
  const loadSupported = status?.accounts.some(a => a.recentRequests !== null) ?? false;
  const set = (m: DistributionMode) => void call('routing.setDistribution', { mode: m });
  return (
    <Card title={t('dist.title')}>
      <p className="mb-3 text-[12px] text-muted">{t('dist.body', { mode: distributionLabel(mode, t) })}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant={mode === 'off' ? 'primary' : 'secondary'} onClick={() => set('off')}>{t('dist.off')}</Button>
        <Button variant={mode === 'even' ? 'primary' : 'secondary'} onClick={() => set('on')}>{t('dist.even')}</Button>
        <Button variant={mode === 'adaptive' ? 'primary' : 'secondary'} onClick={() => set('adaptive')}>{t('dist.adaptive')}</Button>
        <Button
          variant={mode === 'load' ? 'primary' : 'secondary'}
          disabled={!loadSupported && mode !== 'load'}
          title={loadSupported ? t('dist.loadHint') : t('dist.loadUnsupported')}
          onClick={() => set('load')}
        >
          {t('dist.load')}
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-muted"><Rich text={t('dist.note')} /></p>
    </Card>
  );
}

/** The mode name `distribute` takes for what status reports ("even" is `on`). */
function modeArg(mode: string | null): DistributionMode | null {
  if (mode === 'even' || mode === 'on') return 'on';
  return mode === 'off' || mode === 'adaptive' || mode === 'load' ? mode : null;
}

function ProfilesCard() {
  const { backend, settings, run } = useStore();
  const [name, setName] = useState('');
  const status = backend?.status;
  const profiles = settings?.profiles ?? [];
  const threshold = status?.switchThreshold;
  const mode = modeArg(status?.sessions.distribution ?? null);
  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const profile: RoutingProfile = {
      id: `p-${Date.now().toString(36)}`,
      name: trimmed.slice(0, 40),
      threshold: typeof threshold === 'number' ? Math.min(100, Math.max(1, Math.round(threshold * 100))) : null,
      distribution: mode,
    };
    await call('settings.update', { profiles: [...profiles.filter(p => p.name !== profile.name), profile].slice(-20) });
    setName('');
  };
  const remove = (id: string) => call('settings.update', { profiles: profiles.filter(p => p.id !== id) });
  return (
    <Card title={t('profiles.title')}>
      <p className="mb-3 text-[12px] text-muted">{t('profiles.body')}</p>
      {profiles.length > 0 && (
        <ul className="mb-3 divide-y divide-border">
          {profiles.map(p => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <div className="text-[13px] text-fg">{p.name}</div>
                <div className="text-[11px] text-muted">
                  {t('profiles.summary', { threshold: p.threshold === null ? '—' : `${p.threshold}%`, mode: distributionLabel(p.distribution, t) })}
                </div>
              </div>
              <div className="flex gap-2">
                <ActionButton variant="primary" icon={<Play className="size-3.5" aria-hidden />} onAction={() => run(() => call('profiles.apply', { id: p.id }))}>{t('profiles.apply')}</ActionButton>
                <ActionButton variant="ghost" icon={<Trash2 className="size-3.5" aria-hidden />} onAction={() => remove(p.id)}>{t('profiles.delete')}</ActionButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-56"><Field label={t('profiles.name')}><input className={inputClass} maxLength={40} value={name} onChange={e => setName(e.target.value)} placeholder={t('profiles.placeholder')} /></Field></div>
        <ActionButton icon={<Save className="size-3.5" aria-hidden />} disabled={!name.trim() || profiles.length >= 20} onAction={save}>{t('profiles.saveCurrent')}</ActionButton>
      </div>
      <p className="mt-2 text-[11px] text-muted">{t('profiles.note')}</p>
    </Card>
  );
}

function PreferredCard() {
  const { backend, run } = useStore();
  const status = backend?.status;
  if (!status) return null;
  return (
    <Card title={t('pref.title')}>
      <p className="mb-3 text-[12px] text-muted">{t('pref.body')}</p>
      <div className="space-y-2">
        {Object.keys(status.currentAccounts).map(provider => (
          <div key={provider} className="flex flex-wrap items-center gap-2">
            <span className="w-20 text-[12px] text-muted">{provider}</span>
            <select
              aria-label={t('pref.aria', { provider })}
              className={`${controlClass} w-72 max-w-full`}
              value={status.currentAccounts[provider] ?? ''}
              onChange={e => void run(() => call('accounts.switch', { account: e.target.value }))}
            >
              {status.accounts.filter(a => a.provider === provider).map(a => (
                <option key={a.name} value={a.name}>{a.name}{a.unavailable ? ` — ${unavailableText(a.unavailable)}` : ''}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PrioritiesCard() {
  const { backend, run } = useStore();
  const status = backend?.status;
  if (!status || status.accounts.length === 0) return null;
  const sorted = [...status.accounts].sort((a, b) => a.priority - b.priority || a.index - b.index);
  const hasRecent = status.accounts.some(a => a.recentRequests !== null);
  return (
    <Card title={t('prio.title')}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[12.5px]">
          <thead className="text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th className="py-1.5 pr-3 font-medium">{t('prio.colPriority')}</th>
              <th className="pr-3 font-medium">{t('prio.colAccount')}</th>
              <th className="pr-3 font-medium">{t('prio.colProvider')}</th>
              {hasRecent && <th className="pr-3 font-medium" title={t('prio.colRecentTitle')}>{t('prio.colRecent')}</th>}
              <th className="font-medium">{t('prio.colWhy')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map(a => (
              <tr key={`${a.provider}/${a.name}`}>
                <td className="py-1.5 pr-3">
                  <input
                    aria-label={t('prio.aria', { name: a.name })}
                    className={`${controlClass} w-20`}
                    type="number"
                    min={-1000}
                    max={1000}
                    defaultValue={a.priority}
                    disabled={status.readOnly}
                    onBlur={e => {
                      const p = Number(e.target.value);
                      if (Number.isInteger(p) && p !== a.priority) void run(() => call('accounts.setPriority', { account: a.name, priority: p }));
                    }}
                  />
                </td>
                <td className="max-w-64 truncate pr-3 text-fg" title={a.name}>{a.name}{a.isCurrent && <> <Badge tone="accent">{t('common.current')}</Badge></>}</td>
                <td className="pr-3">{a.provider}</td>
                {hasRecent && <td className="pr-3 tabular-nums">{a.recentRequests ?? unknown()}</td>}
                <td className={a.unavailable ? 'text-warn' : 'text-ok'}>{unavailableText(a.unavailable)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="mt-3 text-[12px] text-muted">
        <summary className="cursor-pointer">{t('prio.reasons')}</summary>
        <ul className="mt-2 space-y-0.5">
          {REASON_CODES.map(code => <li key={code}><code className="font-mono">{code}</code> — {unavailableText(code)}</li>)}
        </ul>
      </details>
    </Card>
  );
}

function RoutesCard() {
  const { backend } = useStore();
  const routes = backend?.status?.routes ?? [];
  const blocked = backend?.status?.blockedModels ?? [];
  return (
    <Card title={t('routes.title')}>
      {routes.length === 0 ? <EmptyState title={t('routes.emptyTitle')}><Rich text={t('routes.emptyBody')} /></EmptyState> : (
        <ul className="divide-y divide-border text-[12.5px]">
          {routes.map(r => (
            <li key={`${r.provider}/${r.name}`} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="font-medium text-fg">{r.name}</span>
              {r.autocreated && <Badge>{t('routes.detected')}</Badge>}
              <span className="font-mono text-muted">{r.match.join(', ')}</span>
              <span className="ml-auto text-muted">→ {r.target ?? t('routes.noTarget')}{r.pinned ? ` ${t('routes.pinned', { name: r.pinned })}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {blocked.length > 0 && <p className="mt-2 text-[12px] text-muted">{t('routes.blocked')} <span className="font-mono">{blocked.join(', ')}</span></p>}
      <p className="mt-2 text-[11px] text-muted"><Rich text={t('routes.note')} /></p>
    </Card>
  );
}

function BackgroundJobsCard() {
  const { backend, run } = useStore();
  const status = backend?.status;
  const [probe, setProbe] = useState('300');
  const [warm, setWarm] = useState('600');
  const [warmAck, setWarmAck] = useState(false);
  if (!status) return null;
  const every = (s: number) => t('common.every', { s });
  return (
    <Card title={t('bg.title')}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-5">
        <div>
          <div className="text-[13px] font-medium text-fg">{t('bg.probeState', { state: status.probe.enabled ? every(status.probe.intervalSeconds) : t('common.off') })}</div>
          <p className="mt-1 text-[12px] text-muted">{t('bg.probeBody')}</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="w-28"><Field label={t('common.seconds')}><input className={inputClass} inputMode="numeric" value={probe} onChange={e => setProbe(e.target.value.replace(/\D/g, ''))} /></Field></div>
            <Button onClick={() => void call('routing.setProbe', { seconds: Number(probe) })} disabled={!(Number(probe) >= 30)}>{t('common.enable')}</Button>
            <Button variant="ghost" onClick={() => void call('routing.setProbe', { seconds: 0 })} disabled={!status.probe.enabled}>{t('common.turnOff')}</Button>
            <ActionButton variant="ghost" onAction={() => run(() => call('backend.probe'))}>{t('bg.probeOnce')}</ActionButton>
          </div>
        </div>
        <div>
          <div className="text-[13px] font-medium text-fg">{t('bg.warmState', { state: status.warm.enabled ? every(status.warm.intervalSeconds) : t('common.off') })}</div>
          <div className="mt-1 flex gap-2 text-[12px] text-warn"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>{t('bg.warmWarn')}</span></div>
          <label className="mt-2 flex items-center gap-1.5 text-[12px] text-muted"><input type="checkbox" checked={warmAck} onChange={e => setWarmAck(e.target.checked)} />{t('bg.warmAck')}</label>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="w-28"><Field label={t('common.seconds')}><input className={inputClass} inputMode="numeric" value={warm} onChange={e => setWarm(e.target.value.replace(/\D/g, ''))} /></Field></div>
            <Button onClick={() => void call('routing.setWarmup', { seconds: Number(warm) })} disabled={!warmAck || !(Number(warm) >= 60)}>{t('common.enable')}</Button>
            <Button variant="ghost" onClick={() => void call('routing.setWarmup', { seconds: 0 })} disabled={!status.warm.enabled}>{t('common.turnOff')}</Button>
          </div>
          <p className="mt-2 text-[11px] text-muted"><Rich text={t('bg.warmNote')} /></p>
        </div>
      </div>
    </Card>
  );
}

export function Routing() {
  const { backend } = useStore();
  if (!backend?.status) {
    return <div><PageHeader title={t('routing.title')} /><Card><EmptyState title={t('banner.notRunning')}>{t('routing.notRunningBody')}</EmptyState></Card></div>;
  }
  return (
    <div className="space-y-4">
      <PageHeader title={t('routing.title')} subtitle={t('routing.subtitle')} />
      <JobPanel kinds={['distribute', 'probe', 'warmup']} limit={2} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-4">
        <ThresholdCard />
        <DistributionCard />
      </div>
      <ProfilesCard />
      <PreferredCard />
      <PrioritiesCard />
      <RoutesCard />
      <BackgroundJobsCard />
    </div>
  );
}
