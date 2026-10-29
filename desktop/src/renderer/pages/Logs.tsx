import { Copy, Download, Eraser, FileWarning } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LogStream } from '../../shared/types';
import { call } from '../api';
import { ActionButton, Button, Card, controlClass, PageHeader } from '../components/ui';
import { t } from '../i18n';
import { useStore } from '../store';

const STREAM_CLASS: Record<LogStream, string> = { stdout: 'text-fg', stderr: 'text-warn', desktop: 'text-info' };

export function Logs() {
  const { logs, clearLogs, run, backend, toast } = useStore();
  const [stream, setStream] = useState<'' | LogStream>('');
  const [search, setSearch] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const [crashLog, setCrashLog] = useState<string | null | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const needle = search.toLowerCase();
  const shown = logs.filter(l =>
    (!stream || l.stream === stream)
    && (!needle || l.text.toLowerCase().includes(needle))
    && (!errorsOnly || l.stream === 'stderr' || /error|fail|crash|refused|denied/i.test(l.text)));

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, follow]);

  const copyVisible = () => {
    const text = shown.map(l => `${new Date(l.at).toISOString()} [${l.stream}] ${l.text}`).join('\n');
    call('system.copyText', { text }).then(r => toast(r.ok, t('logs.copied', { n: shown.length }))).catch((err: Error) => toast(false, err.message));
  };
  const hasProcessOutput = backend?.ownership === 'owned' || logs.some(l => l.stream !== 'desktop');

  return (
    <div className="flex h-full flex-col gap-4">
      <PageHeader
        title={t('logs.title')}
        subtitle={t(hasProcessOutput ? 'logs.subtitleOwned' : 'logs.subtitleExternal')}
        actions={(
          <>
            <select aria-label={t('logs.stream')} className={`${controlClass} w-40`} value={stream} onChange={e => setStream(e.target.value as typeof stream)}>
              <option value="">{t('logs.all')}</option>
              <option value="stdout">stdout</option>
              <option value="stderr">stderr</option>
              <option value="desktop">{t('logs.notes')}</option>
            </select>
            <input aria-label={t('common.search')} className={`${controlClass} w-48`} placeholder={t('common.search')} value={search} onChange={e => setSearch(e.target.value)} />
            <label className="flex items-center gap-1.5 text-[12px] text-muted"><input type="checkbox" checked={errorsOnly} onChange={e => setErrorsOnly(e.target.checked)} />{t('logs.errors')}</label>
            <label className="flex items-center gap-1.5 text-[12px] text-muted"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />{t('logs.follow')}</label>
            <Button icon={<Copy className="size-3.5" aria-hidden />} onClick={copyVisible} disabled={shown.length === 0}>{t('common.copy')}</Button>
            <Button icon={<Eraser className="size-3.5" aria-hidden />} onClick={clearLogs}>{t('logs.clear')}</Button>
            <ActionButton icon={<Download className="size-3.5" aria-hidden />} onAction={() => run(() => call('system.exportDiagnostics'))}>{t('logs.report')}</ActionButton>
          </>
        )}
      />
      <div
        ref={box}
        role="log"
        aria-live="off"
        tabIndex={0}
        className="min-h-64 flex-1 overflow-auto rounded-lg border border-border bg-panel p-3 font-mono text-[11.5px] leading-relaxed"
        onScroll={e => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {shown.length === 0 ? <div className="text-muted">{t('logs.empty')}</div> : shown.map(l => (
          <div key={l.seq} className={`whitespace-pre-wrap break-words ${STREAM_CLASS[l.stream]}`}>
            <span className="select-none text-muted">{new Date(l.at).toLocaleTimeString()} </span>{l.text}
          </div>
        ))}
      </div>
      <Card
        title={t('logs.crashTitle')}
        actions={<ActionButton icon={<FileWarning className="size-3.5" aria-hidden />} onAction={async () => setCrashLog(await call('logs.readCrashLog'))}>{t('logs.crashShow')}</ActionButton>}
      >
        {crashLog === undefined && <p className="text-[12px] text-muted">{t('logs.crashIntro')}</p>}
        {crashLog === null && <p className="text-[12px] text-muted">{t('logs.crashNone')}</p>}
        {crashLog && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-muted">{crashLog}</pre>}
      </Card>
    </div>
  );
}
