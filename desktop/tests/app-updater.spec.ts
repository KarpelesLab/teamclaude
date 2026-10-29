import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  AppUpdater, CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, updateSupport, type Timers, type UpdaterLike,
} from '../src/services/app-updater';

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checks = 0;
  installed: Array<[boolean | undefined, boolean | undefined]> = [];
  next: (u: FakeUpdater) => void = u => u.emit('update-not-available', {});
  async checkForUpdates() { this.checks++; this.emit('checking-for-update'); this.next(this); return null; }
  async downloadUpdate() { this.emit('download-progress', { percent: 50 }); this.emit('update-downloaded', { version: '0.3.0' }); return []; }
  quitAndInstall(silent?: boolean, run?: boolean) { this.installed.push([silent, run]); }
}

function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; repeat: boolean; id: number }> = [];
  let seq = 0;
  const timers: Timers = {
    setTimeout: (fn, ms) => { pending.push({ fn, ms, repeat: false, id: ++seq }); return seq; },
    setInterval: (fn, ms) => { pending.push({ fn, ms, repeat: true, id: ++seq }); return seq; },
    clear: h => { const i = pending.findIndex(p => p.id === h); if (i >= 0) pending.splice(i, 1); },
  };
  return { timers, pending };
}

const make = (auto = true) => {
  const fake = new FakeUpdater();
  const { timers, pending } = fakeTimers();
  const updater = new AppUpdater({ updater: fake, unsupported: null, currentVersion: '0.2.0', auto: () => auto, timers, clock: () => 42 });
  return { fake, updater, pending };
};

describe('updateSupport', () => {
  const base = { packaged: true, platform: 'win32' as const, env: {}, feedExists: true };
  it('allows the installed Windows app and the AppImage', () => {
    expect(updateSupport(base)).toBeNull();
    expect(updateSupport({ ...base, platform: 'linux', env: { APPIMAGE: '/x/TeamClaude.AppImage' } })).toBeNull();
  });
  it('says why any other copy cannot update itself', () => {
    expect(updateSupport({ ...base, packaged: false })).toBe('development');
    expect(updateSupport({ ...base, env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x.exe' } })).toBe('portable');
    expect(updateSupport({ ...base, platform: 'linux' })).toBe('package-manager');
    expect(updateSupport({ ...base, feedExists: false })).toBe('no-feed');
  });
});

describe('AppUpdater', () => {
  it('does nothing at all without an updater', async () => {
    const updater = new AppUpdater({ updater: new FakeUpdater(), unsupported: 'portable', currentVersion: '0.2.0', auto: () => true });
    updater.start();
    expect((await updater.check()).unsupported).toBe('portable');
    expect(updater.install()).toBe(false);
  });

  it('schedules a delayed first check and a periodic one when automatic, and none when not', () => {
    const on = make(true);
    on.updater.start();
    expect(on.pending.map(p => [p.ms, p.repeat])).toEqual([[FIRST_CHECK_DELAY_MS, false], [CHECK_INTERVAL_MS, true]]);
    expect(on.fake.autoDownload).toBe(true);
    expect(on.fake.autoInstallOnAppQuit).toBe(true);
    on.updater.applyAuto(false);
    expect(on.pending).toHaveLength(0);
    expect(on.fake.autoDownload).toBe(false);
  });

  it('reports up to date', async () => {
    const { updater } = make();
    expect(await updater.check()).toMatchObject({ phase: 'up-to-date', checkedAt: 42 });
  });

  it('downloads automatically and becomes ready to install', async () => {
    const { fake, updater } = make();
    const phases: string[] = [];
    updater.on('state', s => phases.push(s.phase));
    fake.next = u => {
      u.emit('update-available', { version: '0.3.0' });
      u.emit('download-progress', { percent: 41.6 });
      u.emit('update-downloaded', { version: '0.3.0' });
    };
    await updater.check();
    expect(phases).toEqual(['checking', 'checking', 'downloading', 'downloading', 'ready']);
    expect(updater.getState()).toMatchObject({ phase: 'ready', latest: '0.3.0', progress: 100 });
    // A ready update is not fetched again.
    await updater.check();
    expect(fake.checks).toBe(1);
    expect(updater.install()).toBe(true);
    // Silent and relaunching: a visible assisted installer would wait for a click.
    expect(fake.installed).toEqual([[true, true]]);
  });

  it('waits for a download request when automatic download is off', async () => {
    const { fake, updater } = make(false);
    updater.start();
    fake.next = u => u.emit('update-available', { version: '0.3.0' });
    await updater.check();
    expect(updater.getState()).toMatchObject({ phase: 'available', latest: '0.3.0' });
    await updater.download();
    expect(updater.getState().phase).toBe('ready');
  });

  it('shows an error without a credential and can check again', async () => {
    const { fake, updater } = make();
    fake.checkForUpdates = vi.fn(async () => { throw new Error('HttpError: 404 Authorization: Bearer abcdefghijklmnop\nstack'); });
    const state = await updater.check();
    expect(state.phase).toBe('error');
    expect(state.error).not.toContain('abcdefghijklmnop');
    expect(state.error).not.toContain('stack');
    fake.checkForUpdates = vi.fn(async () => { fake.emit('update-not-available', {}); return null; });
    expect((await updater.check()).phase).toBe('up-to-date');
  });
});
