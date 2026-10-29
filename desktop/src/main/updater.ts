// Wires services/app-updater.ts to electron-updater and to a notification
// when an update is ready. electron-updater's own autoUpdater is created only
// when this copy can update itself, so a development run or a portable build
// never touches it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, Notification } from 'electron';
import type { Translate } from '../shared/i18n';
import type { AppUpdateState, NotificationPrefs } from '../shared/types';
import { AppUpdater, updateSupport, type UpdaterLike } from '../services/app-updater';

export interface UpdaterWiring {
  auto: () => boolean;
  prefs: () => NotificationPrefs;
  t: () => Translate;
  log: (text: string) => void;
  onState: (state: AppUpdateState) => void;
  onNotificationClick: () => void;
}

export function createAppUpdater(w: UpdaterWiring): AppUpdater {
  const unsupported = updateSupport({
    packaged: app.isPackaged,
    platform: process.platform,
    env: process.env,
    feedExists: existsSync(join(process.resourcesPath, 'app-update.yml')),
  });
  let updater: UpdaterLike | null = null;
  if (!unsupported) {
    // Loaded here, not at the top: the module's autoUpdater reads the feed
    // file as soon as it is created.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    // Its own logger writes to a file in userData; the app keeps one log.
    autoUpdater.logger = null;
    autoUpdater.allowPrerelease = false;
    updater = autoUpdater as unknown as UpdaterLike;
  }
  const appUpdater = new AppUpdater({ updater, unsupported, currentVersion: app.getVersion(), auto: w.auto, log: w.log });
  appUpdater.on('state', (state: AppUpdateState, previous: AppUpdateState) => {
    w.onState(state);
    if (state.phase !== 'ready' || previous.phase === 'ready') return;
    if (!w.prefs().appUpdateReady || !Notification.isSupported()) return;
    const t = w.t();
    const n = new Notification({ title: t('n.appUpdateTitle'), body: t('n.appUpdateBody', { version: state.latest ?? '' }) });
    n.on('click', w.onNotificationClick);
    n.show();
  });
  return appUpdater;
}
