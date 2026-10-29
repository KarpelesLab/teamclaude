// The main window, locked down: sandboxed renderer, context isolation, no Node
// integration, no navigation away from the bundled page, no new windows, no
// permissions (camera, notifications from the page, …). Links that must open
// go through the main process to the system browser, by a fixed list.

import { BrowserWindow, screen, type BrowserWindowConstructorOptions, type NativeImage } from 'electron';
import { pathToFileURL } from 'node:url';

export interface WindowOptions {
  preload: string;
  indexHtml: string;
  icon: NativeImage | undefined;
  show: boolean;
  devTools: boolean;
}

/** The page URL the renderer must be on; anything else is refused by IPC. */
export function rendererUrl(indexHtml: string): string {
  return pathToFileURL(indexHtml).href;
}

export function isTrustedUrl(url: string, expected: string): boolean {
  const strip = (u: string) => u.split('#')[0]?.split('?')[0] ?? '';
  return strip(url) === strip(expected);
}

const lockedPreferences = (preload: string, devTools: boolean): BrowserWindowConstructorOptions['webPreferences'] => ({
  preload,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
  devTools,
});

/** No navigation away from the bundled page, no new windows, no webviews, no permissions. */
function lockDown(win: BrowserWindow, expected: string): void {
  win.setMenu(null);
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url, expected)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedUrl(url, expected)) event.preventDefault();
  });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}

export const WIDGET_WIDTH = 280;
const WIDGET_HEIGHT = 220;
const WIDGET_MARGIN = 16;

/** The small always-on-top quota window: the same page, opened at #mini. */
export function createWidgetWindow(opts: Omit<WindowOptions, 'show'>): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    x: area.x + area.width - WIDGET_WIDTH - WIDGET_MARGIN,
    y: area.y + area.height - WIDGET_HEIGHT - WIDGET_MARGIN,
    frame: false,
    resizable: true,
    minWidth: 220,
    minHeight: 90,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'TeamClaude',
    ...(opts.icon ? { icon: opts.icon } : {}),
    webPreferences: lockedPreferences(opts.preload, opts.devTools),
  });
  lockDown(win, rendererUrl(opts.indexHtml));
  win.once('ready-to-show', () => win.showInactive());
  void win.loadFile(opts.indexHtml, { hash: 'mini' });
  return win;
}

export function createMainWindow(opts: WindowOptions): BrowserWindow {
  const expected = rendererUrl(opts.indexHtml);
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    title: 'TeamClaude Desktop',
    ...(opts.icon ? { icon: opts.icon } : {}),
    webPreferences: lockedPreferences(opts.preload, opts.devTools),
  });
  lockDown(win, expected);

  win.once('ready-to-show', () => {
    if (opts.show) win.show();
  });
  void win.loadFile(opts.indexHtml);
  return win;
}
