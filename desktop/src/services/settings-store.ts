// Desktop-only preferences, kept in Electron's userData directory and never in
// the TeamClaude config: the backend stays the single source of truth for
// accounts, routing and the proxy. Written atomically with owner-only mode.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DesktopSettings } from '../shared/types';
import type { OwnedPidStore } from './backend-manager';
import { validateSettingsPatch } from './validate';

export const DEFAULT_SETTINGS: DesktopSettings = {
  theme: 'dark',
  language: 'en',
  // Everything that runs on its own is off until the user turns it on.
  launchAtLogin: false,
  startProxyOnLaunch: false,
  startMinimized: false,
  minimizeToTray: true,
  keepProxyOnWindowClose: true,
  restartOnCrash: false,
  // Updates can contact external release/registry services only after opt-in.
  autoUpdate: false,
  autoUpdateCore: false,
  profiles: [],
  widget: false,
  hotkeyEnabled: false,
  hotkey: 'CommandOrControl+Alt+Shift+N',
  notifications: {
    proxyCrashed: true,
    authExpired: true,
    allUnavailable: true,
    quotaExhausted: true,
    backendRecovered: true,
    updateAvailable: true,
    appUpdateReady: true,
    coreUpdated: true,
    quotaSoon: true,
  },
};

export function mergeSettings(base: DesktopSettings, patch: Partial<DesktopSettings>): DesktopSettings {
  return {
    ...base,
    ...patch,
    notifications: { ...base.notifications, ...(patch.notifications ?? {}) },
  };
}

export interface FileIO {
  read(path: string): string;
  write(path: string, data: string): void;
}

export const nodeFileIO: FileIO = {
  read: path => readFileSync(path, 'utf8'),
  write: (path, data) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  },
};

export class SettingsStore {
  private current: DesktopSettings;

  /** `firstRun` overrides defaults when no settings file exists yet (e.g. the system language). */
  constructor(private readonly file: string, private readonly io: FileIO = nodeFileIO, firstRun: Partial<DesktopSettings> = {}) {
    this.current = this.load(mergeSettings(DEFAULT_SETTINGS, firstRun));
  }

  /** Load from disk, keeping only fields that validate; anything else falls back to the default. */
  private load(defaults: DesktopSettings): DesktopSettings {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.io.read(this.file));
    } catch {
      return defaults;
    }
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS;
    let settings = DEFAULT_SETTINGS;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const single = { [key]: value };
      if (validateSettingsPatch(single).ok) settings = mergeSettings(settings, single as Partial<DesktopSettings>);
    }
    return settings;
  }

  get(): DesktopSettings {
    return this.current;
  }

  update(patch: Partial<DesktopSettings>): DesktopSettings {
    this.current = mergeSettings(this.current, patch);
    this.io.write(this.file, `${JSON.stringify(this.current, null, 2)}\n`);
    return this.current;
  }
}

/** Remembers the pid of the backend this app started, across app restarts. */
export class OwnedPidFile implements OwnedPidStore {
  constructor(private readonly file: string, private readonly io: FileIO = nodeFileIO) {}

  read(): number | null {
    try {
      const value: unknown = JSON.parse(this.io.read(this.file));
      const pid = value && typeof value === 'object' ? (value as { ownedPid?: unknown }).ownedPid : null;
      return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  write(pid: number | null): void {
    try {
      this.io.write(this.file, `${JSON.stringify({ ownedPid: pid })}\n`);
    } catch {
      // Losing this only means a later run treats the server as external.
    }
  }
}
