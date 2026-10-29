// Optional self-update from a release feed configured by the packager,
// through electron-updater. These are unofficial, unsigned builds; the
// upstream project publishes none. The updater object is injected, so the
// policy here is tested without Electron. A copy that cannot update itself (a
// development run, the portable .exe, a .deb, a build without a feed) says
// why and never contacts anything.

import { EventEmitter } from 'node:events';
import type { AppUpdateState, AppUpdateUnsupported } from '../shared/types';
import { describeError } from './sanitize';

export const RELEASES_URL = 'https://github.com/KarpelesLab/teamclaude/releases';
/** Leave the first minute of a launch to the proxy. */
export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

type UpdaterEvent = 'checking-for-update' | 'update-not-available' | 'update-available' | 'download-progress' | 'update-downloaded' | 'error';

/** The part of electron-updater's AppUpdater this uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: UpdaterEvent, listener: (arg: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateEnvironment {
  packaged: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** resources/app-update.yml, written by electron-builder when a feed is configured. */
  feedExists: boolean;
}

/** null when this copy can update itself. */
export function updateSupport(e: UpdateEnvironment): AppUpdateUnsupported | null {
  if (!e.packaged) return 'development';
  // electron-builder's portable launcher sets these; it unpacks to a temp dir on each run.
  if (e.platform === 'win32' && (e.env.PORTABLE_EXECUTABLE_FILE || e.env.PORTABLE_EXECUTABLE_DIR)) return 'portable';
  // Only the AppImage can replace itself on Linux; a .deb belongs to the package manager.
  if (e.platform === 'linux' && !e.env.APPIMAGE) return 'package-manager';
  if (!e.feedExists) return 'no-feed';
  return null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  setInterval(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clear: handle => { clearTimeout(handle as NodeJS.Timeout); clearInterval(handle as NodeJS.Timeout); },
};

const versionOf = (info: unknown): string | null => {
  const v = info && typeof info === 'object' ? (info as { version?: unknown }).version : null;
  return typeof v === 'string' ? v : null;
};

export interface AppUpdaterOptions {
  updater: UpdaterLike | null;
  unsupported: AppUpdateUnsupported | null;
  currentVersion: string;
  auto: () => boolean;
  log?: (text: string) => void;
  clock?: () => number;
  timers?: Timers;
}

export class AppUpdater extends EventEmitter {
  private state: AppUpdateState;
  private readonly updater: UpdaterLike | null;
  private readonly timers: Timers;
  private readonly clock: () => number;
  private readonly log: (text: string) => void;
  private handles: unknown[] = [];

  constructor(private readonly opts: AppUpdaterOptions) {
    super();
    this.updater = opts.unsupported ? null : opts.updater;
    this.timers = opts.timers ?? realTimers;
    this.clock = opts.clock ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.state = {
      unsupported: this.updater ? null : opts.unsupported ?? 'no-feed',
      phase: 'idle',
      current: opts.currentVersion,
      latest: null,
      progress: null,
      error: null,
      checkedAt: null,
      releasesUrl: RELEASES_URL,
    };
    if (this.updater) this.wire(this.updater);
  }

  getState(): AppUpdateState {
    return this.state;
  }

  /** Starts the periodic check when automatic updates are on. */
  start(): void {
    this.applyAuto(this.opts.auto());
  }

  /** Called when the setting changes. */
  applyAuto(on: boolean): void {
    if (!this.updater) return;
    this.updater.autoDownload = on;
    this.updater.autoInstallOnAppQuit = true;
    for (const h of this.handles) this.timers.clear(h);
    this.handles = [];
    if (!on) return;
    this.handles.push(
      this.timers.setTimeout(() => { void this.check(); }, FIRST_CHECK_DELAY_MS),
      this.timers.setInterval(() => { void this.check(); }, CHECK_INTERVAL_MS),
    );
  }

  async check(): Promise<AppUpdateState> {
    if (!this.updater) return this.state;
    // A downloaded update stays ready; checking again would only redo it.
    if (this.state.phase === 'checking' || this.state.phase === 'downloading' || this.state.phase === 'ready') return this.state;
    this.set({ phase: 'checking', error: null });
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      this.fail(err);
    }
    return this.state;
  }

  async download(): Promise<AppUpdateState> {
    if (!this.updater || this.state.phase !== 'available') return this.state;
    this.set({ phase: 'downloading', progress: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (err) {
      this.fail(err);
    }
    return this.state;
  }

  /**
   * Quits and installs a downloaded update, then starts the new version. Silent:
   * the installer is the assisted (non one-click) NSIS one, and run visibly it
   * would stop at its first page and wait for a click the user never meant to
   * give, leaving the app closed and not updated.
   */
  install(): boolean {
    if (!this.updater || this.state.phase !== 'ready') return false;
    this.updater.quitAndInstall(true, true);
    return true;
  }

  private wire(u: UpdaterLike): void {
    u.on('checking-for-update', () => this.set({ phase: 'checking' }));
    u.on('update-not-available', () => this.set({ phase: 'up-to-date', checkedAt: this.clock() }));
    u.on('update-available', info => {
      const latest = versionOf(info);
      this.log(`A new version of TeamClaude Desktop is available: ${latest ?? 'unknown'}.`);
      this.set({ phase: u.autoDownload ? 'downloading' : 'available', latest, progress: u.autoDownload ? 0 : null, checkedAt: this.clock() });
    });
    u.on('download-progress', p => {
      const percent = p && typeof p === 'object' ? (p as { percent?: unknown }).percent : null;
      this.set({ phase: 'downloading', progress: typeof percent === 'number' ? Math.round(percent) : this.state.progress });
    });
    u.on('update-downloaded', info => {
      const latest = versionOf(info) ?? this.state.latest;
      this.log(`TeamClaude Desktop ${latest ?? ''} is downloaded and installs on restart.`);
      this.set({ phase: 'ready', latest, progress: 100 });
    });
    u.on('error', err => this.fail(err));
  }

  private fail(err: unknown): void {
    const message = describeError(err).split('\n')[0] ?? 'update failed';
    this.log(`Update check failed: ${message}`);
    this.set({ phase: 'error', error: message, progress: null, checkedAt: this.clock() });
  }

  private set(patch: Partial<AppUpdateState>): void {
    const previous = this.state;
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state, previous);
  }
}
