import type { ActivityEvent } from '../../shared/activity';
import type { AccountView } from '../../shared/types';
import { useNow } from '../clock';
import { Sparkline } from '../components/Sparkline';
import { Badge, Card, PageHeader, Stat, type Tone } from '../components/ui';
import { ago, duration, isoUntil, phaseText, unavailableText, unknown } from '../format';
import { t } from '../i18n';
import { useStore } from '../store';

const DAY_MS = 24 * 60 * 60_000;

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? null;
}

const ms = (value: number | null | undefined) => (value === null || value === undefined ? unknown() : `${Math.round(value)} ms`);

function accountHealth(a: AccountView): { tone: Tone; label: string } {
  if (a.disabled) return { tone: 'muted', label: t('health.disabled') };
  if (a.error) return { tone: 'bad', label: t('health.error') };
  if (a.unavailable) return { tone: 'warn', label: t('health.resting') };
  return { tone: 'ok', label: t('health.ok') };
}

/** Errors and switches per account over the last day, from the activity timeline. */
function eventCounts(activity: ActivityEvent[], now: number) {
  const counts = new Map<string, { errors: number; switches: number; lastError: number | null }>();
  const get = (name: string) => {
    let c = counts.get(name);
    if (!c) counts.set(name, (c = { errors: 0, switches: 0, lastError: null }));
    return c;
  };
  for (const e of activity) {
    if (now - e.at > DAY_MS) continue;
    if (e.detail.type === 'error' && e.account) {
      const c = get(e.account);
      c.errors++;
      c.lastError = Math.max(c.lastError ?? 0, e.at);
    }
    if (e.detail.type === 'switch' && e.detail.to) get(e.detail.to).switches++;
  }
  return counts;
}

export function Health() {
  const { backend, samples, activity } = useStore();
  const now = useNow();
  const status = backend?.status;
  const latencies = samples.map(s => s.latencyMs).filter((v): v is number => typeof v === 'number');
  const counts = eventCounts(activity, now);
  const uptime = status?.server.uptimeSeconds;
  const average = latencies.length ? latencies.reduce((x, y) => x + y, 0) / latencies.length : null;

  return (
    <div className="space-y-4">
      <PageHeader title={t('health.title')} subtitle={t('health.subtitle')} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4">
        <Stat label={t('health.proxy')} value={phaseText(backend?.phase ?? 'stopped')} tone={backend?.phase === 'running' ? 'ok' : 'warn'} />
        <Stat label={t('health.uptime')} value={uptime === null || uptime === undefined ? unknown() : duration(uptime * 1000)} />
        <Stat label={t('health.latency')} value={ms(backend?.statusLatencyMs)} sub={t('health.latencySub', { avg: ms(average), p95: ms(percentile(latencies, 0.95)) })} />
        <Stat label={t('health.restarts')} value={String(backend?.restartCount ?? 0)} tone={backend?.restartCount ? 'warn' : undefined} />
      </div>
      {latencies.length > 1 && (
        <Card title={t('health.latencyTitle')}>
          <Sparkline values={latencies} label={t('health.latencyTitle')} />
          <p className="mt-1 text-[11px] text-muted">{t('health.latencyNote')}</p>
        </Card>
      )}
      <Card title={t('health.accounts')}>
        {!status?.accounts.length ? (
          <p className="text-[13px] text-muted">{t('health.noAccounts')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[12px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="py-1.5 pr-3 font-medium">{t('usage.account')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('health.state')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('health.reason')}</th>
                  <th className="py-1.5 pr-3 text-right font-medium">{t('health.errors24h')}</th>
                  <th className="py-1.5 pr-3 text-right font-medium">{t('health.switches24h')}</th>
                  <th className="py-1.5 font-medium">{t('health.lastError')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {status.accounts.map(a => {
                  const health = accountHealth(a);
                  const c = counts.get(a.name);
                  const limited = isoUntil(a.rateLimitedUntil, now) ?? isoUntil(a.credentialRejectedUntil, now) ?? isoUntil(a.pausedUntil, now);
                  const reason = a.error ? `${a.error.code}: ${a.error.detail}` : a.unavailable ? unavailableText(a.unavailable) : '';
                  return (
                    <tr key={`${a.provider}/${a.name}`}>
                      <td className="py-1.5 pr-3"><span className="text-fg">{a.name}</span> <span className="text-muted">· {a.provider}</span></td>
                      <td className="py-1.5 pr-3"><Badge tone={health.tone}>{health.label}</Badge></td>
                      <td className="max-w-[280px] py-1.5 pr-3 text-muted" title={reason}>
                        <span className="line-clamp-2">{reason}{limited ? ` · ${t('health.until', { when: limited })}` : ''}</span>
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{c?.errors ?? 0}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{c?.switches ?? 0}</td>
                      <td className="py-1.5 text-muted">{c?.lastError ? ago(c.lastError, now) : t('common.none')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted">{t('health.note')}</p>
      </Card>
    </div>
  );
}
