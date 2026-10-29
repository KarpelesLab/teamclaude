// System tray. Created once per app run (a second instance focuses this one
// instead of making another icon). Some Linux desktops have no tray at all;
// then create() returns null and the app works as a plain window — closing
// it quits instead of hiding into a tray nobody can see.

import { Menu, Tray, type NativeImage } from 'electron';
import type { MessageKey, Translate } from '../shared/i18n';
import type { PageId } from '../shared/ipc';
import type { BackendState, RoutingProfile } from '../shared/types';

export interface TrayActions {
  show(page?: PageId): void;
  start(): void;
  stop(): void;
  openDashboard(): void;
  quit(): void;
  applyProfile(id: string): void;
  toggleWidget(): void;
}

export interface TrayExtras {
  profiles: RoutingProfile[];
  widget: boolean;
}

/** Windows cuts tray tooltips at 127 characters. */
const TOOLTIP_MAX = 127;

/** "TeamClaude — Proxy: running" plus one line per current account with its quota. */
export function trayTooltip(state: BackendState, t: Translate): string {
  const lines = [`TeamClaude — ${trayStatusLabel(state, t)}`];
  const status = state.status;
  if (status) {
    for (const name of Object.values(status.currentAccounts)) {
      const a = status.accounts.find(acc => acc.name === name);
      if (!a) continue;
      const pct = (u: number | null) => (u === null ? '—' : `${Math.round(u * 100)}%`);
      lines.push(`${a.name}: 5h ${pct(a.fiveHour.utilization)} · 7d ${pct(a.weekly.utilization)}`);
    }
  }
  const text = lines.join('\n');
  return text.length > TOOLTIP_MAX ? `${text.slice(0, TOOLTIP_MAX - 1)}…` : text;
}

export function trayStatusLabel(state: BackendState, t: Translate): string {
  const phase = t(`phase.${state.phase}` as MessageKey);
  if (state.phase !== 'running') return t('tray.status', { phase });
  return t('tray.statusRunning', { phase, who: t(state.ownership === 'owned' ? 'tray.startedHere' : 'tray.external') });
}

export class AppTray {
  private extras: TrayExtras = { profiles: [], widget: false };
  private last: BackendState | null = null;

  private constructor(private readonly tray: Tray, private readonly actions: TrayActions, private readonly t: () => Translate) {
    tray.setToolTip('TeamClaude Desktop');
    // Linux trays usually ignore click; Windows opens the window on click.
    tray.on('click', () => actions.show());
  }

  static create(icon: NativeImage, actions: TrayActions, t: () => Translate): AppTray | null {
    try {
      return new AppTray(new Tray(icon), actions, t);
    } catch {
      return null;
    }
  }

  setExtras(extras: TrayExtras): void {
    this.extras = extras;
    if (this.last) this.update(this.last);
  }

  update(state: BackendState): void {
    // A state or settings event can still arrive while the app quits.
    if (this.tray.isDestroyed()) return;
    this.last = state;
    const t = this.t();
    const running = state.phase === 'running';
    const busy = state.phase === 'starting' || state.phase === 'stopping';
    const canStop = running && state.ownership === 'owned';
    const status = trayStatusLabel(state, t);
    this.tray.setToolTip(trayTooltip(state, t));
    const profiles = this.extras.profiles.map(p => ({ label: p.name, enabled: running, click: () => this.actions.applyProfile(p.id) }));
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: t('tray.open'), click: () => this.actions.show() },
      { label: status, enabled: false },
      { type: 'separator' },
      { label: t('tray.start'), enabled: !running && !busy, click: () => this.actions.start() },
      { label: t('tray.stop'), enabled: canStop && !busy, click: () => this.actions.stop() },
      { label: t('tray.dashboard'), enabled: running, click: () => this.actions.openDashboard() },
      { label: t('tray.logs'), click: () => this.actions.show('logs') },
      { label: t('tray.settings'), click: () => this.actions.show('settings') },
      { type: 'separator' },
      ...(profiles.length ? [{ label: t('tray.profiles'), submenu: profiles }] : []),
      { label: t('tray.widget'), type: 'checkbox', checked: this.extras.widget, click: () => this.actions.toggleWidget() },
      { type: 'separator' },
      { label: t('tray.quit'), click: () => this.actions.quit() },
    ]));
  }

  destroy(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}
