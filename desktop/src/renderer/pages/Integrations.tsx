import { CircleCheck, CircleX, FolderOpen, Link2, Unlink2, SquareTerminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IdeTarget, IntegrationInfo } from '../../shared/types';
import { call } from '../api';
import { ActionButton, Badge, Banner, Card, CodeBlock, CopyButton, PageHeader, Rich } from '../components/ui';
import { t } from '../i18n';
import { useStore } from '../store';

const copy = (text: string) => call('system.copyText', { text });

const codexToml = (port: number) => [
  'model_provider = "teamclaude"',
  '',
  '[model_providers.teamclaude]',
  'name = "teamclaude"',
  `base_url = "http://127.0.0.1:${port}/backend-api/codex"`,
  'wire_api = "responses"',
].join('\n');

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) {
  return (
    <li className="flex items-start gap-2 py-1 text-[13px]">
      {ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden /> : <CircleX className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />}
      <span className="min-w-0"><span className="text-fg">{label}</span>{detail && <span className="block break-all font-mono text-[11px] text-muted">{detail}</span>}</span>
    </li>
  );
}

function ideStatus(ide: IdeTarget): { tone: 'ok' | 'warn' | 'bad' | 'muted'; text: string } {
  if (ide.status === 'connected') return { tone: 'ok', text: t('int.ideConnected') };
  if (ide.status === 'other') return { tone: 'warn', text: t('int.ideOther', { url: ide.current ?? '' }) };
  if (ide.status === 'unreadable') return { tone: 'bad', text: t('int.ideUnreadable') };
  return { tone: 'muted', text: t('int.ideNotConnected') };
}

/** One-click connect for Claude Code's own settings and the VS Code-family editors found here. */
function IdeCard({ info, onChanged }: { info: IntegrationInfo; onChanged: () => void }) {
  const { run } = useStore();
  const ides = info.ides.filter(ide => ide.installed);
  const change = (ide: IdeTarget, connect: boolean) => async () => {
    await run(() => call(connect ? 'ide.connect' : 'ide.disconnect', { id: ide.id }));
    onChanged();
  };
  return (
    <Card title={t('int.ideTitle')}>
      <p className="mb-2 text-[12px] text-muted">{t('int.ideBody', { url: info.endpoint.replace('127.0.0.1', 'localhost') })}</p>
      {ides.length === 0 && <p className="text-[13px] text-muted">{t('int.ideNone')}</p>}
      <ul className="divide-y divide-border">
        {ides.map(ide => {
          const status = ideStatus(ide);
          return (
            <li key={ide.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13px] text-fg">
                  {ide.id === 'claude' ? t('int.ideClaudeName') : ide.name}
                  <Badge tone={status.tone}>{ide.status === 'unreadable' ? '!' : status.text}</Badge>
                </div>
                {ide.id === 'claude' && <p className="text-[11px] text-muted">{t('int.ideClaudeDesc')}</p>}
                {ide.via && <p className="text-[11px] text-muted">{t('int.ideVia')}</p>}
                {ide.status === 'unreadable' && <p className="text-[11px] text-bad">{status.text}</p>}
                <p className="break-all font-mono text-[11px] text-muted">{ide.settingsPath}</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {ide.launcher && (
                  <ActionButton icon={<FolderOpen className="size-3.5" aria-hidden />} title={t('int.ideOpenFolderHint')} onAction={() => run(() => call('ide.openFolder', { id: ide.id }))}>{t('int.ideOpenFolder')}</ActionButton>
                )}
                {ide.status !== 'connected' && ide.status !== 'unreadable' && (
                  <ActionButton variant="primary" icon={<Link2 className="size-3.5" aria-hidden />} onAction={change(ide, true)}>{t('int.ideConnect')}</ActionButton>
                )}
                {(ide.status === 'connected' || ide.status === 'other') && (
                  <ActionButton icon={<Unlink2 className="size-3.5" aria-hidden />} onAction={change(ide, false)}>{t('int.ideDisconnect')}</ActionButton>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const SHELL_LABEL = { posix: 'bash / zsh', powershell: 'PowerShell', cmd: 'cmd.exe' } as const;

export function Integrations() {
  const { backend, run } = useStore();
  const [info, setInfo] = useState<IntegrationInfo | null>(null);
  const phase = backend?.phase;
  const load = () => { void call('system.integrations').then(setInfo); };
  useEffect(load, [phase]);
  if (!info) return null;
  const isWindows = navigator.userAgent.includes('Windows');
  const shells = isWindows ? (['powershell', 'cmd', 'posix'] as const) : (['posix', 'powershell', 'cmd'] as const);
  const toml = codexToml(backend?.port ?? 3456);

  return (
    <div className="space-y-4">
      <PageHeader title={t('int.title')} subtitle={t('int.subtitle')} />
      <Card title={t('int.check')}>
        <ul>
          <Check ok={info.proxyReady} label={t(info.proxyReady ? 'int.proxyOk' : 'int.proxyNo', { endpoint: info.endpoint })} />
          <Check ok={info.claude.found} label={t(info.claude.found ? 'int.claudeOk' : 'int.claudeNo')} detail={info.claude.path} />
          <Check ok={info.codex.found} label={t(info.codex.found ? 'int.codexOk' : 'int.codexNo')} detail={info.codex.path} />
        </ul>
      </Card>
      <IdeCard info={info} onChanged={load} />
      <Card title={t('int.terminalTitle')} actions={<ActionButton icon={<SquareTerminal className="size-3.5" aria-hidden />} onAction={() => run(() => call('system.openTerminal'))}>{t('int.openTerminal')}</ActionButton>}>
        <p className="mb-3 text-[12px] text-muted"><Rich text={t('int.terminalBody')} /></p>
        <div className="space-y-2">
          {shells.map(shell => (
            <div key={shell}>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">{SHELL_LABEL[shell]}</div>
              <CodeBlock actions={<CopyButton text={info.env[shell]} onCopy={copy} />}>{info.env[shell]}</CodeBlock>
            </div>
          ))}
        </div>
      </Card>
      <Card title={t('int.codexTitle')}>
        <p className="mb-3 text-[12px] text-muted"><Rich text={t('int.codexBody')} /></p>
        <CodeBlock actions={<CopyButton text={toml} onCopy={copy} />}>{toml}</CodeBlock>
      </Card>
      <Card title={<span className="flex items-center gap-2">VS Code <Badge tone="warn">{t('int.vscodeBadge')}</Badge></span>}>
        <Banner tone="info" title={t('int.vscodeBannerTitle')}>{t('int.vscodeBannerBody')}</Banner>
        <div className="mt-3"><CodeBlock actions={<CopyButton text={info.vscodeSettingsSnippet} onCopy={copy} />}>{info.vscodeSettingsSnippet}</CodeBlock></div>
        <p className="mt-2 text-[12px] text-muted"><Rich text={t('int.vscodeNote')} /></p>
      </Card>
    </div>
  );
}
