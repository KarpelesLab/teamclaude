// Application lifecycle: one instance, one window, one tray icon, one
// BackendManager. Wires the services to Electron and nothing more — the logic
// lives in src/services so it can be tested without Electron.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, globalShortcut, nativeImage, Notification, type NativeImage } from 'electron';
import { ActivityLog, isEmptyDelta } from '../shared/activity';
import { runoutAlerts } from '../shared/forecast';
import { nextAccount } from '../shared/usage';
import { languageForLocale, translator, type Translate } from '../shared/i18n';
import { EVENT_CHANNEL, type DesktopEvent, type PageId } from '../shared/ipc';
import type { BackendState, DesktopSettings } from '../shared/types';
import { BackendClient } from '../services/backend-client';
import { readProxySettings, resolveConfigPath, serviceUnitPath } from '../services/backend-config';
import { BackendManager } from '../services/backend-manager';
import { backendSpawnSpec, readBackendVersion, resolveBackendLocation, type BackendLocation } from '../services/backend-runtime';
import { CoreStore, CoreUpdater, type CoreChoice } from '../services/core-updater';
import { AUTOSTART_ARG, setLinuxAutostart } from '../services/autostart';
import { JobRunner } from '../services/job-runner';
import { LogBuffer } from '../services/log-buffer';
import { describeError } from '../services/sanitize';
import { OwnedPidFile, SettingsStore } from '../services/settings-store';
import { applyProfile, createHandlers, openDashboard, type HandlerContext } from './handlers';
import { registerIpc } from './ipc';
import { Notifier } from './notifications';
import { AppTray } from './tray';
import { createAppUpdater } from './updater';
import { createMainWindow, createWidgetWindow, rendererUrl } from './window';

const POLL_VISIBLE_MS = 2000;
const POLL_HIDDEN_MS = 10_000;
const MIN_BACKEND_VERSION = '1.1.0';

let mainWindow: BrowserWindow | null = null;
let widgetWindow: BrowserWindow | null = null;
let tray: AppTray | null = null;
let quitting = false;
let shutdownDone = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(init).catch(err => {
    console.error('TeamClaude Desktop failed to start:', describeError(err));
    app.exit(1);
  });
}

// Defence in depth for any web contents, not only the main window.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
});

function send(event: DesktopEvent): void {
  for (const win of [mainWindow, widgetWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, event);
  }
}

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (onClick) n.on('click', onClick);
  n.show();
}

function showWindow(page?: PageId): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (page) send({ type: 'navigate', page });
}

function resourcePath(...parts: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...parts) : join(app.getAppPath(), 'build', ...parts);
}

function loadIcon(): NativeImage | undefined {
  const path = resourcePath('icon.png');
  if (!existsSync(path)) return undefined;
  const image = nativeImage.createFromPath(path);
  return image.isEmpty() ? undefined : image;
}

function applyLoginItem(enabled: boolean): void {
  try {
    if (process.platform === 'linux') setLinuxAutostart(enabled, process.execPath);
    else app.setLoginItemSettings({ openAtLogin: enabled, args: [AUTOSTART_ARG] });
  } catch (err) {
    console.error('Could not change launch-at-login:', describeError(err));
  }
}

async function init(): Promise<void> {
  const userData = app.getPath('userData');
  // On first run the UI follows the system language when it is one we ship.
  const settings = new SettingsStore(join(userData, 'settings.json'), undefined, { language: languageForLocale(app.getLocale()) });
  const t = (): Translate => translator(settings.get().language);
  const logs = new LogBuffer();
  const bundledLocation = resolveBackendLocation({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  const bundledBackendVersion = bundledLocation ? readBackendVersion(bundledLocation.root) : null;
  if (!bundledLocation) logs.note('The bundled backend was not found; only attaching to a running proxy is possible.');
  const bundledCore: CoreChoice | null = bundledLocation
    ? { location: bundledLocation, version: bundledBackendVersion, source: bundledLocation.source === 'checkout' ? 'checkout' : 'bundled' }
    : null;
  // A core downloaded from npm replaces the bundled one while it is the newer of the two.
  const coreStore = new CoreStore(join(userData, 'core'));
  const downloaded = bundledCore?.source === 'bundled' ? coreStore.usable(bundledBackendVersion) : null;
  const initialCore: CoreChoice | null = downloaded ? { ...downloaded, source: 'downloaded' } : bundledCore;
  let location: BackendLocation | null = initialCore?.location ?? null;

  const spawnAt = (at: BackendLocation, args: string[]) => {
    const spec = backendSpawnSpec(process.execPath, at, args, process.env);
    return spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  };
  // The desktop's backend-account command is shipped with this build. A newer
  // upstream npm core may not include the desktop fork's command yet.
  const spawnBackend = (args: string[]) => {
    const at = args[0] === 'add-backend' ? bundledLocation : location;
    return at ? spawnAt(at, args) : null;
  };

  const manager = new BackendManager({
    configPath: () => resolveConfigPath(),
    readSettings: path => readProxySettings(path),
    createClient: (host, port, apiKey) => new BackendClient({ host, port, apiKey }),
    spawnServer: () => spawnBackend(['server', '--headless']),
    serviceInstalled: () => process.platform === 'linux' && existsSync(serviceUnitPath()),
    killPid: (pid, signal) => process.kill(pid, signal),
    ownedPid: new OwnedPidFile(join(userData, 'runtime.json')),
    log: logs,
    minBackendVersion: MIN_BACKEND_VERSION,
    restartOnCrash: () => settings.get().restartOnCrash,
    t,
  });
  const jobs = new JobRunner(spawnBackend, t);

  const icon = loadIcon();
  const notifier = new Notifier(() => settings.get().notifications, t, () => showWindow());
  const appUpdater = createAppUpdater({
    auto: () => settings.get().autoUpdate,
    prefs: () => settings.get().notifications,
    t,
    log: text => logs.note(text),
    onState: state => send({ type: 'appUpdate', state }),
    onNotificationClick: () => showWindow('about'),
  });

  const coreUpdater = new CoreUpdater({
    store: coreStore,
    initial: initialCore,
    bundled: bundledCore,
    minVersion: MIN_BACKEND_VERSION,
    auto: () => settings.get().autoUpdateCore,
    log: text => logs.note(text),
    smokeTest: at => smokeTest(spawnAt(at, ['--version'])),
    activate: async at => {
      location = at;
      const state = manager.getState();
      if (state.ownership !== 'owned' || state.phase !== 'running') return { ok: true, message: '' };
      return manager.restart();
    },
  });
  coreUpdater.on('state', state => send({ type: 'coreUpdate', state }));
  coreUpdater.on('installed', (version: string) => {
    if (!settings.get().notifications.coreUpdated || !Notification.isSupported()) return;
    const n = new Notification({ title: t()('n.coreTitle'), body: t()('n.coreBody', { version }) });
    n.on('click', () => showWindow('about'));
    n.show();
  });

  const history = new ActivityLog();
  // Each forecast run-out is announced once (key: account, window, reset).
  const announced = new Set<string>();
  const announceRunouts = (state: BackendState) => {
    if (!state.status || !settings.get().notifications.quotaSoon) return;
    const now = Date.now();
    for (const alert of runoutAlerts(state.status.accounts, history.history().quota, now)) {
      if (announced.has(alert.key)) continue;
      announced.add(alert.key);
      const minutes = Math.max(1, Math.round((alert.runout.at - now) / 60_000));
      const window = alert.runout.window === 'fiveHour' ? t()('forecast.fiveHour') : alert.runout.family ?? t()('forecast.weekly');
      notify(t()('n.quotaSoonTitle', { name: alert.account.name }), t()('n.quotaSoonBody', { window, minutes }), () => showWindow('accounts'));
    }
  };
  manager.on('state', (state: BackendState) => {
    const delta = history.observe(state);
    send({ type: 'backend', state });
    if (!isEmptyDelta(delta)) send({ type: 'history', delta });
    tray?.update(state);
    notifier.handle(state);
    announceRunouts(state);
  });
  logs.onLines(lines => send({ type: 'log', lines }));
  jobs.on('job', job => send({ type: 'job', job }));
  // The CLI notifies a running server itself; refresh so the change shows now.
  jobs.on('done', () => { void manager.refresh(); });

  const indexHtml = join(app.getAppPath(), 'out', 'renderer', 'index.html');
  const preload = join(__dirname, '..', 'preload', 'index.js');

  const syncTray = () => tray?.setExtras({ profiles: settings.get().profiles, widget: !!widgetWindow });
  const applyWidget = (on: boolean) => {
    if (!on) {
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.destroy();
      widgetWindow = null;
      return;
    }
    if (widgetWindow && !widgetWindow.isDestroyed()) return;
    widgetWindow = createWidgetWindow({ preload, indexHtml, icon, devTools: !app.isPackaged });
    widgetWindow.on('closed', () => {
      widgetWindow = null;
      // On quit the tray is already gone and the setting must survive.
      if (quitting) return;
      // Closed from the widget itself: remember that.
      if (settings.get().widget) send({ type: 'settings', settings: settings.update({ widget: false }) });
      syncTray();
    });
  };

  const switchToNext = async () => {
    const state = manager.getState();
    const status = state.status;
    if (state.phase !== 'running' || !status) return;
    const [provider, current] = Object.entries(status.currentAccounts)[0] ?? ['anthropic', null];
    const next = nextAccount(status.accounts, provider, current);
    if (!next) {
      notify('TeamClaude', t()('n.hotkeyNone'));
      return;
    }
    const r = await manager.control('/teamclaude/switch', { account: next.name });
    notify('TeamClaude', r.ok ? t()('n.hotkeySwitched', { name: next.name }) : r.error ?? t()('h.switchFailed'));
  };
  const applyHotkey = (enabled: boolean, accelerator: string) => {
    globalShortcut.unregisterAll();
    if (!enabled) return;
    try {
      if (!globalShortcut.register(accelerator, () => { void switchToNext(); })) logs.note(t()('h.hotkeyTaken', { key: accelerator }));
    } catch (err) {
      logs.note(t()('h.hotkeyTaken', { key: `${accelerator} (${describeError(err)})` }));
    }
  };
  const ctx: HandlerContext = {
    manager,
    jobs,
    logs,
    history,
    appUpdater,
    coreUpdater,
    settings,
    window: () => mainWindow,
    t,
    desktopVersion: app.getVersion(),
    bundledBackendVersion,
    userDataDir: userData,
    applySettings: (next: DesktopSettings, previous: DesktopSettings) => {
      if (next.launchAtLogin !== previous.launchAtLogin) applyLoginItem(next.launchAtLogin);
      if (next.autoUpdate !== previous.autoUpdate) appUpdater.applyAuto(next.autoUpdate);
      if (next.autoUpdateCore !== previous.autoUpdateCore) coreUpdater.applyAuto(next.autoUpdateCore);
      if (next.language !== previous.language) tray?.update(manager.getState());
      if (next.widget !== previous.widget) applyWidget(next.widget);
      if (next.hotkeyEnabled !== previous.hotkeyEnabled || next.hotkey !== previous.hotkey) applyHotkey(next.hotkeyEnabled, next.hotkey);
      if (next.profiles !== previous.profiles || next.widget !== previous.widget) syncTray();
      send({ type: 'settings', settings: next });
    },
  };
  registerIpc(createHandlers(ctx), rendererUrl(indexHtml));

  const launchedAtLogin = process.argv.includes(AUTOSTART_ARG);
  const initial = settings.get();
  mainWindow = createMainWindow({
    preload,
    indexHtml,
    icon,
    show: !(initial.startMinimized || launchedAtLogin),
    devTools: !app.isPackaged,
  });

  if (icon) {
    const size = process.platform === 'win32' ? 16 : 22;
    tray = AppTray.create(icon.resize({ width: size, height: size }), {
      show: page => showWindow(page),
      start: () => { void manager.start(); },
      stop: () => { void manager.stop(); },
      openDashboard: () => { openDashboard(ctx); },
      quit: () => app.quit(),
      applyProfile: id => {
        void applyProfile(ctx, id).then(r => notify('TeamClaude', r.message));
      },
      toggleWidget: () => {
        const next = settings.update({ widget: !settings.get().widget });
        applyWidget(next.widget);
        send({ type: 'settings', settings: next });
        syncTray();
      },
    }, t);
    tray?.update(manager.getState());
    syncTray();
  }
  // Without a tray, a hidden window could not be brought back.
  if (!tray && !mainWindow.isVisible()) mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('minimize', () => {
    if (tray && settings.get().minimizeToTray) mainWindow?.hide();
  });
  mainWindow.on('close', event => {
    if (quitting) return;
    if (tray && settings.get().keepProxyOnWindowClose) {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }
    app.quit();
  });
  mainWindow.on('show', () => manager.startPolling(POLL_VISIBLE_MS));
  mainWindow.on('hide', () => manager.startPolling(POLL_HIDDEN_MS));

  await manager.refresh();
  if (initial.startProxyOnLaunch && manager.getState().phase !== 'running') void manager.start();
  manager.startPolling(mainWindow.isVisible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
  appUpdater.start();
  coreUpdater.start();
  applyWidget(initial.widget);
  applyHotkey(initial.hotkeyEnabled, initial.hotkey);

  app.on('before-quit', event => {
    quitting = true;
    if (shutdownDone) return;
    event.preventDefault();
    jobs.cancelAll();
    globalShortcut.unregisterAll();
    manager.shutdown({ stopOwned: true })
      .catch(err => console.error('Shutdown error:', describeError(err)))
      .finally(() => {
        shutdownDone = true;
        tray?.destroy();
        app.quit();
      });
  });
}

const SMOKE_TEST_TIMEOUT_MS = 20_000;

/** What `teamclaude --version` prints, or a rejection when it fails or hangs. */
function smokeTest(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('the test run did not finish')); }, SMOKE_TEST_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => { if (out.length < 4096) out += chunk.toString('utf8'); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`the test run exited with code ${code}`));
    });
  });
}

app.on('window-all-closed', () => {
  // The window is hidden, not closed, while the tray keeps the app alive.
  if (!tray) app.quit();
});
