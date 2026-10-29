import {
  Activity, ChartBarBig, Gauge, HeartPulse, Info, ListTree, Plug, ScrollText, Settings as SettingsIcon, Split, Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { PageId } from '../../shared/ipc';
import { phaseText } from '../format';
import { t, type MessageKey } from '../i18n';
import { PAGE_ORDER } from '../shortcuts';
import { useStore } from '../store';
import { phaseTone } from './BackendBanner';
import { cx, Dot } from './ui';

const ICONS: Record<PageId, ReactNode> = {
  overview: <Gauge className="size-4" aria-hidden />,
  accounts: <Users className="size-4" aria-hidden />,
  sessions: <ListTree className="size-4" aria-hidden />,
  activity: <Activity className="size-4" aria-hidden />,
  usage: <ChartBarBig className="size-4" aria-hidden />,
  health: <HeartPulse className="size-4" aria-hidden />,
  routing: <Split className="size-4" aria-hidden />,
  integrations: <Plug className="size-4" aria-hidden />,
  settings: <SettingsIcon className="size-4" aria-hidden />,
  logs: <ScrollText className="size-4" aria-hidden />,
  about: <Info className="size-4" aria-hidden />,
};

const ITEMS = PAGE_ORDER.map(id => ({ id, icon: ICONS[id] }));

export function Sidebar() {
  const { page, setPage, backend } = useStore();
  const phase = backend?.phase ?? 'stopped';
  const version = backend?.status?.server.version;
  return (
    <nav aria-label={t('nav.main')} className="flex w-52 shrink-0 flex-col border-r border-border bg-panel max-[900px]:w-14">
      <div className="flex items-center gap-2 px-4 py-4 max-[900px]:justify-center max-[900px]:px-0">
        <div aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-[13px] font-bold text-accent-fg">TC</div>
        <div className="min-w-0 max-[900px]:hidden">
          <div className="truncate text-[13px] font-semibold text-fg">TeamClaude</div>
          <div className="truncate text-[11px] text-muted">{t('app.subtitle')}</div>
        </div>
      </div>
      <ul className="flex-1 space-y-0.5 px-2">
        {ITEMS.map((item, index) => {
          const label = t(`nav.${item.id}` as MessageKey);
          return (
            <li key={item.id}>
              <button
                type="button"
                data-page={item.id}
                onClick={() => setPage(item.id)}
                aria-current={page === item.id ? 'page' : undefined}
                title={index < 9 ? t('nav.shortcut', { label, n: index + 1 }) : label}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors max-[900px]:justify-center',
                  page === item.id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-fg',
                )}
              >
                {item.icon}
                <span className="truncate max-[900px]:hidden">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-border px-4 py-3 max-[900px]:px-0" title={t('sidebar.proxy', { phase: phaseText(phase) })}>
        <div className="flex items-center gap-2 text-[12px] text-fg max-[900px]:justify-center">
          <Dot tone={phaseTone(phase)} pulse={phase === 'starting' || phase === 'stopping'} />
          <span className="truncate max-[900px]:hidden">{phaseText(phase)}</span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted max-[900px]:hidden">
          {version ? t('sidebar.backend', { v: version }) : t('sidebar.backendUnknown')}
        </div>
      </div>
    </nav>
  );
}
