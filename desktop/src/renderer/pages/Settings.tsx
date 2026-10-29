import { Download, ExternalLink, FolderOpen, Upload } from 'lucide-react';
import { useState } from 'react';
import type { DesktopSettings, NotificationPrefs } from '../../shared/types';
import { call } from '../api';
import { ActionButton, Button, Card, Field, inputClass, PageHeader, Rich, Toggle } from '../components/ui';
import { LANGUAGES, t, type MessageKey } from '../i18n';
import { useStore } from '../store';

const NOTIFICATIONS: Array<keyof NotificationPrefs> = [
  'proxyCrashed', 'authExpired', 'allUnavailable', 'quotaExhausted', 'backendRecovered', 'updateAvailable', 'appUpdateReady', 'coreUpdated', 'quotaSoon',
];

/** Ctrl/Alt/Shift/Meta plus one key, as an Electron accelerator; null for anything else. */
export function acceleratorFor(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const mods = [e.ctrlKey && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[];
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
  if (!key || !mods.length) return null;
  return [...mods, key].join('+');
}

function HotkeyCard() {
  const { settings, toast } = useStore();
  const [recording, setRecording] = useState(false);
  if (!settings) return null;
  const update = (patch: Partial<DesktopSettings>) => {
    call('settings.update', patch).catch((err: Error) => toast(false, err.message));
  };
  return (
    <Card title={t('hotkey.title')}>
      <Toggle label={t('hotkey.enable')} checked={settings.hotkeyEnabled} onChange={v => update({ hotkeyEnabled: v })} description={t('hotkey.desc')} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          readOnly
          className={`${inputClass} max-w-64 font-mono`}
          aria-label={t('hotkey.shortcut')}
          value={recording ? t('hotkey.press') : settings.hotkey}
          onFocus={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          onKeyDown={e => {
            if (e.key === 'Escape') { setRecording(false); e.currentTarget.blur(); return; }
            const accel = acceleratorFor(e);
            e.preventDefault();
            if (!accel) return;
            update({ hotkey: accel });
            setRecording(false);
            e.currentTarget.blur();
          }}
        />
      </div>
      <p className="mt-2 text-[11px] text-muted">{t('hotkey.note')}</p>
    </Card>
  );
}

function BackupCard() {
  const { run } = useStore();
  const [passphrase, setPassphrase] = useState('');
  const ok = passphrase.length >= 8;
  const act = (method: 'backup.export' | 'backup.import') => async () => {
    const r = await run(() => call(method, { passphrase }));
    if (r.ok) setPassphrase('');
  };
  return (
    <Card title={t('backup.title')}>
      <p className="mb-3 text-[12px] text-muted">{t('backup.body')}</p>
      <Field label={t('backup.passphrase')} hint={t('backup.passphraseHint')}>
        <input type="password" autoComplete="new-password" className={inputClass} value={passphrase} onChange={e => setPassphrase(e.target.value)} />
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton icon={<Download className="size-3.5" aria-hidden />} disabled={!ok} onAction={act('backup.export')}>{t('backup.export')}</ActionButton>
        <ActionButton icon={<Upload className="size-3.5" aria-hidden />} disabled={!ok} onAction={act('backup.import')}>{t('backup.import')}</ActionButton>
      </div>
      <p className="mt-2 text-[11px] text-muted">{t('backup.note')}</p>
    </Card>
  );
}

export function Settings() {
  const { settings, backend, run, setPage, toast } = useStore();
  if (!settings) return null;
  const update = (patch: Partial<DesktopSettings>) => {
    call('settings.update', patch).catch((err: Error) => toast(false, err.message));
  };
  const linux = navigator.userAgent.includes('Linux');

  return (
    <div className="space-y-4">
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-4">
        <Card title={t('settings.general')}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('settings.theme')}>
              <select className={inputClass} value={settings.theme} onChange={e => update({ theme: e.target.value as DesktopSettings['theme'] })}>
                <option value="dark">{t('settings.dark')}</option>
                <option value="light">{t('settings.light')}</option>
                <option value="system">{t('settings.system')}</option>
              </select>
            </Field>
            <Field label={t('settings.language')}>
              {/* Each language is named in itself, so it can be found from any current language. */}
              <select className={inputClass} value={settings.language} onChange={e => update({ language: e.target.value })}>
                {LANGUAGES.map(l => <option key={l.code} value={l.code} lang={l.code}>{l.label}</option>)}
              </select>
            </Field>
          </div>
          <div className="mt-2 divide-y divide-border">
            <Toggle label={t('settings.launchAtLogin')} checked={settings.launchAtLogin} onChange={v => update({ launchAtLogin: v })}
              description={t(linux ? 'settings.launchLinux' : 'settings.launchWindows')} />
            <Toggle label={t('settings.startMinimized')} checked={settings.startMinimized} onChange={v => update({ startMinimized: v })} description={t('settings.startMinimizedDesc')} />
            <Toggle label={t('settings.minimizeToTray')} checked={settings.minimizeToTray} onChange={v => update({ minimizeToTray: v })} />
            <Toggle label={t('settings.widget')} checked={settings.widget} onChange={v => update({ widget: v })} description={t('settings.widgetDesc')} />
          </div>
        </Card>
        <Card title={t('settings.proxy')}>
          <dl className="mb-2 grid grid-cols-2 gap-2 text-[13px]">
            <div><dt className="text-[11px] uppercase tracking-wider text-muted">{t('settings.address')}</dt><dd className="font-mono text-[12px]">{backend?.host}:{backend?.port}</dd></div>
            <div><dt className="text-[11px] uppercase tracking-wider text-muted">{t('settings.backend')}</dt><dd>{backend?.status?.server.version ?? t('common.notRunning')}</dd></div>
          </dl>
          <p className="mb-2 text-[11px] text-muted"><Rich text={t('settings.hostNote')} /></p>
          <div className="divide-y divide-border">
            <Toggle label={t('settings.startOnLaunch')} checked={settings.startProxyOnLaunch} onChange={v => update({ startProxyOnLaunch: v })} description={t('settings.startOnLaunchDesc')} />
            <Toggle label={t('settings.keepRunning')} checked={settings.keepProxyOnWindowClose} onChange={v => update({ keepProxyOnWindowClose: v })} description={t('settings.keepRunningDesc')} />
            <Toggle label={t('settings.restartOnCrash')} checked={settings.restartOnCrash} onChange={v => update({ restartOnCrash: v })} description={t('settings.restartOnCrashDesc')} />
          </div>
        </Card>
        <Card title={t('settings.updates')}>
          <div className="divide-y divide-border">
            <Toggle label={t('settings.autoUpdate')} checked={settings.autoUpdate} onChange={v => update({ autoUpdate: v })} description={t('settings.autoUpdateDesc')} />
            <Toggle label={t('settings.autoUpdateCore')} checked={settings.autoUpdateCore} onChange={v => update({ autoUpdateCore: v })} description={t('settings.autoUpdateCoreDesc')} />
          </div>
          <Button className="mt-2" variant="ghost" onClick={() => setPage('about')}>{t('about.appTitle')}</Button>
        </Card>
        <Card title={t('settings.notifications')}>
          <div className="divide-y divide-border">
            {NOTIFICATIONS.map(key => (
              <Toggle key={key} label={t(`notify.${key}` as MessageKey)} checked={settings.notifications[key]} onChange={v => update({ notifications: { ...settings.notifications, [key]: v } })} />
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">{t('settings.notifyNote')}</p>
        </Card>
        <HotkeyCard />
        <BackupCard />
        <Card title={t('settings.routing')}>
          <p className="text-[13px] text-muted">{t('settings.routingBody')}</p>
          <Button className="mt-3" onClick={() => setPage('routing')}>{t('settings.openRouting')}</Button>
        </Card>
        <Card title={t('settings.advanced')}>
          <div className="flex flex-wrap gap-2">
            <ActionButton icon={<FolderOpen className="size-3.5" aria-hidden />} onAction={() => run(() => call('system.openConfigDir'))}>{t('settings.openConfig')}</ActionButton>
            <ActionButton icon={<Download className="size-3.5" aria-hidden />} onAction={() => run(() => call('system.exportDiagnostics'))}>{t('settings.export')}</ActionButton>
            <ActionButton icon={<ExternalLink className="size-3.5" aria-hidden />} disabled={backend?.phase !== 'running'} onAction={() => run(() => call('system.openDashboard'))}>{t('settings.openDashboard')}</ActionButton>
          </div>
          <p className="mt-2 text-[11px] text-muted">{t('settings.diagNote')}</p>
          <p className="mt-1 text-[11px] text-muted">{t('settings.configFile')} <span className="break-all font-mono">{backend?.configPath}</span></p>
        </Card>
      </div>
    </div>
  );
}
