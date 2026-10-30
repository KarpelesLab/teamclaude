import { ArrowDown, ArrowUp, Download, KeyRound, LogIn, Pencil, Plus, RefreshCw, Star, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { accountKey } from '../../shared/activity';
import type { AccountView } from '../../shared/types';
import { call } from '../api';
import { useNow } from '../clock';
import { JobPanel } from '../components/JobPanel';
import { ServiceAccount } from '../components/ServiceAccount';
import { FiveHourBar, QuotaBar, RefreshQuotasButton, WeeklyBar } from '../components/QuotaBar';
import { RunoutLines } from '../components/Runout';
import { Sparkline } from '../components/Sparkline';
import {
  ActionButton, Badge, Button, Card, ConfirmDialog, controlClass, EmptyState, Field, inputClass, PageHeader, Toggle, type Tone,
} from '../components/ui';
import { duration, isoUntil, unavailableText } from '../format';
import { t } from '../i18n';
import { useStore } from '../store';

function tokenStatus(a: AccountView, now: number): { text: string; tone: Tone } {
  if (a.type === 'apikey') return { text: t('token.apikey'), tone: 'muted' };
  if (a.error && (a.error.code === 'refresh_rejected' || a.error.code === 'credential_rejected')) return { text: t('token.signIn'), tone: 'bad' };
  const held = isoUntil(a.credentialRejectedUntil, now);
  if (held) return { text: t('token.rejected', { when: held }), tone: 'warn' };
  return { text: t('token.ok'), tone: 'ok' };
}

/** The account's recorded utilization; a window the plan does not meter falls back to weekly. */
function QuotaTrend({ account }: { account: AccountView }) {
  const { quota } = useStore();
  const key = accountKey(account.provider, account.name);
  const fiveHour = account.sessionWindowStated !== false;
  const points = quota.flatMap(p => {
    const value = p.accounts[key];
    const u = value ? (fiveHour ? value.fiveHour : value.weekly) : null;
    return u === null || u === undefined ? [] : [{ at: p.at, u }];
  });
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length < 2 || !first || !last) return <p className="mt-2 text-[11px] text-muted">{t('account.trendNone')}</p>;
  const label = t(fiveHour ? 'account.trend5h' : 'account.trendWeekly', { span: duration(last.at - first.at) });
  return (
    <div className="mt-2">
      <div className="text-[11px] text-muted">{label}</div>
      <Sparkline values={points.map(p => p.u)} label={label} />
    </div>
  );
}

function AccountCard({ account, threshold, readOnly }: { account: AccountView; threshold: number | null; readOnly: boolean }) {
  const { run } = useStore();
  const now = useNow();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(account.name);
  const token = tokenStatus(account, now);
  const throttled = isoUntil(account.rateLimitedUntil, now);
  const paused = isoUntil(account.pausedUntil, now);

  return (
    <article className="rounded-lg border border-border bg-panel p-4" aria-label={t('account.aria', { name: account.name })}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="min-w-0 break-all text-[14px] font-semibold text-fg">{account.name}</h3>
            {account.isCurrent && <Badge tone="accent">{t('common.current')}</Badge>}
            <Badge>{account.provider}</Badge>
            <Badge>{account.type}</Badge>
            <Badge tone={token.tone}>{token.text}</Badge>
            {account.onExtraUsage && <Badge tone="warn" title={t('account.extraUsageTitle')}>{t('account.extraUsage')}</Badge>}
          </div>
          {account.orgName && <div className="mt-0.5 break-all text-[12px] text-muted">{account.orgName}</div>}
          <div className="mt-1 text-[12px]">
            <span className={account.unavailable ? 'text-warn' : 'text-ok'}>{unavailableText(account.unavailable)}</span>
            {throttled && <span className="text-muted"> · {t('account.throttled', { when: throttled })}</span>}
            {paused && <span className="text-muted"> · {t('account.paused', { when: paused })}</span>}
            <span className="text-muted"> · {t('account.sessions', { n: account.sessions })}</span>
          </div>
          {account.error && (
            <div className="mt-2 rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-fg">
              {account.error.detail}
              {account.error.remedy && <span className="text-muted"> — {t('account.fix')} <code className="font-mono">{account.error.remedy}</code></span>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-1 text-[12px] text-muted">
            {t('account.priority')} <span className="min-w-6 text-center font-semibold tabular-nums text-fg">{account.priority}</span>
            <ActionButton variant="ghost" className="px-1.5 py-0.5" disabled={readOnly} aria-label={t('account.raise')} title={t('account.raise')} icon={<ArrowUp className="size-3.5" aria-hidden />}
              onAction={() => run(() => call('accounts.setPriority', { account: account.name, priority: account.priority - 1 }))} />
            <ActionButton variant="ghost" className="px-1.5 py-0.5" disabled={readOnly} aria-label={t('account.lower')} title={t('account.lower')} icon={<ArrowDown className="size-3.5" aria-hidden />}
              onAction={() => run(() => call('accounts.setPriority', { account: account.name, priority: account.priority + 1 }))} />
          </div>
          <div className="text-[11px] text-muted">{account.disabled ? t('account.notInRotation') : t('account.inRotation')}</div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4">
        <FiveHourBar account={account} now={now} threshold={threshold} />
        <WeeklyBar account={account} now={now} threshold={threshold} />
        {account.modelWindows.map(w => <QuotaBar key={w.label} label={t('quota.modelWeekly', { model: w.label })} window={w} now={now} threshold={threshold} />)}
      </div>
      <RunoutLines account={account} />
      <QuotaTrend account={account} />

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Toggle
          checked={!account.disabled}
          disabled={readOnly}
          label={t('account.useInRotation')}
          onChange={enabled => void run(() => call('accounts.setDisabled', { account: account.name, disabled: !enabled }))}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          <ActionButton disabled={account.isCurrent} icon={<Star className="size-3.5" aria-hidden />}
            onAction={() => run(() => call('accounts.switch', { account: account.name }))}>{t('account.prefer')}</ActionButton>
          {account.type === 'oauth' && (
            <ActionButton icon={<LogIn className="size-3.5" aria-hidden />} disabled={readOnly}
              onAction={async () => { await call('accounts.login', { provider: account.provider === 'codex' ? 'codex' : 'claude', name: account.name }); }}>
              {t('account.signInAgain')}
            </ActionButton>
          )}
          <Button icon={<Pencil className="size-3.5" aria-hidden />} disabled={readOnly} onClick={() => setRenaming(v => !v)}>{t('account.rename')}</Button>
          <Button variant="danger" icon={<Trash2 className="size-3.5" aria-hidden />} disabled={readOnly} onClick={() => setConfirmRemove(true)}>{t('account.remove')}</Button>
        </div>
      </div>

      {renaming && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={e => {
            e.preventDefault();
            void call('accounts.rename', { account: account.name, newName: newName.trim() }).then(() => setRenaming(false));
          }}
        >
          <div className="min-w-48 flex-1"><Field label={t('account.newName')}><input className={inputClass} value={newName} onChange={e => setNewName(e.target.value)} autoFocus /></Field></div>
          <Button type="submit" variant="primary" disabled={!newName.trim() || newName.trim() === account.name}>{t('common.save')}</Button>
          <Button onClick={() => setRenaming(false)}>{t('common.cancel')}</Button>
        </form>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title={t('account.removeTitle', { name: `${account.name} (${account.provider})` })}
        confirmLabel={t('account.removeConfirm')}
        danger
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          void call('accounts.remove', { account: account.name, provider: account.provider, ...(account.orgName ? { org: account.orgName } : {}) });
        }}
      >
        {t('account.removeBody')}
      </ConfirmDialog>
    </article>
  );
}

function AddAccount() {
  const { toast } = useStore();
  const [showKey, setShowKey] = useState(false);
  const [showService, setShowService] = useState(false);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [priority, setPriority] = useState('');
  const optionalName = name.trim() || undefined;

  const start = (fn: () => Promise<unknown>) => {
    fn().catch((err: Error) => toast(false, err.message));
  };

  return (
    <Card title={t('add.title')}>
      <p className="mb-3 text-[12px] text-muted">{t('add.intro')}</p>
      <div className="mb-3 max-w-xs">
        <Field label={t('add.name')} hint={t('add.nameHint')}>
          <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="work" />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<LogIn className="size-3.5" aria-hidden />} onClick={() => start(() => call('accounts.login', { provider: 'claude', name: optionalName }))}>{t('add.claude')}</Button>
        <Button icon={<LogIn className="size-3.5" aria-hidden />} onClick={() => start(() => call('accounts.login', { provider: 'codex', name: optionalName }))}>{t('add.codex')}</Button>
        <Button icon={<Download className="size-3.5" aria-hidden />} onClick={() => start(() => call('accounts.import', { name: optionalName }))}>{t('add.import')}</Button>
        <Button icon={<KeyRound className="size-3.5" aria-hidden />} onClick={() => setShowKey(v => !v)}>{t('add.apikey')}</Button>
        <Button icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setShowService(v => !v)}>{t('service.add')}</Button>
      </div>
      {showKey && (
        <form
          className="mt-4 grid grid-cols-[1fr_140px_auto] items-start gap-2 max-[700px]:grid-cols-1"
          onSubmit={e => {
            e.preventDefault();
            const p = priority.trim() === '' ? undefined : Number(priority);
            const key = apiKey;
            setApiKey('');
            start(() => call('accounts.addApiKey', { apiKey: key, ...(optionalName ? { name: optionalName } : {}), ...(p !== undefined ? { priority: p } : {}) }));
          }}
        >
          <Field label={t('add.key')} hint={t('add.keyHint')}>
            <input className={inputClass} type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-…" />
          </Field>
          <Field label={t('add.priority')} hint={t('add.priorityHint')}>
            <input className={inputClass} inputMode="numeric" value={priority} onChange={e => setPriority(e.target.value.replace(/[^-\d]/g, ''))} placeholder={t('add.priorityAuto')} />
          </Field>
          <Button className="mt-5 max-[700px]:mt-0" type="submit" variant="primary" icon={<Plus className="size-3.5" aria-hidden />} disabled={apiKey.length < 8}>{t('add.submit')}</Button>
        </form>
      )}
      {showService && <ServiceAccount />}
    </Card>
  );
}

export function Accounts() {
  const { backend, run } = useStore();
  const [filter, setFilter] = useState('');
  const status = backend?.status;
  const needle = filter.toLowerCase();
  const accounts = (status?.accounts ?? []).filter(a => !needle || `${a.name} ${a.orgName ?? ''} ${a.provider}`.toLowerCase().includes(needle));
  const providers = [...new Set(accounts.map(a => a.provider))];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('accounts.title')}
        subtitle={t('accounts.subtitle')}
        actions={(
          <>
            <input className={`${controlClass} w-56`} placeholder={t('accounts.filter')} aria-label={t('accounts.filter')} value={filter} onChange={e => setFilter(e.target.value)} />
            <ActionButton icon={<RefreshCw className="size-3.5" aria-hidden />} disabled={backend?.phase !== 'running'} onAction={() => run(() => call('backend.reload'))}>{t('accounts.reload')}</ActionButton>
            <RefreshQuotasButton disabled={backend?.phase !== 'running'} />
          </>
        )}
      />
      <AddAccount />
      <JobPanel kinds={['login', 'apikey', 'backend', 'import', 'remove', 'rename']} />
      {!status && (
        <Card><EmptyState icon={<Users className="size-8" aria-hidden />} title={t('banner.notRunning')}>{t('accounts.notRunningBody')}</EmptyState></Card>
      )}
      {status && status.accounts.length === 0 && (
        <Card><EmptyState icon={<Users className="size-8" aria-hidden />} title={t('accounts.emptyTitle')}>{t('accounts.emptyBody')}</EmptyState></Card>
      )}
      {providers.map(provider => (
        <section key={provider} aria-label={t('accounts.group', { provider })}>
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">{provider}</h2>
          <div className="space-y-3">
            {accounts.filter(a => a.provider === provider).map(a => (
              <AccountCard key={`${a.provider}/${a.name}/${a.index}`} account={a} threshold={status?.switchThreshold ?? null} readOnly={status?.readOnly ?? false} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
