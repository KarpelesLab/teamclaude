import { describe, expect, it } from 'vitest';
import { buildDiagnosticReport } from '../src/services/diagnostics';
import { normalizeStatus } from '../src/services/normalize';
import { DEFAULT_SETTINGS, OwnedPidFile, SettingsStore, type FileIO } from '../src/services/settings-store';
import { format, LANGUAGES, languageForLocale, translator } from '../src/shared/i18n';
import { de } from '../src/shared/locales/de';
import { en } from '../src/shared/locales/en';
import { es } from '../src/shared/locales/es';
import { fr } from '../src/shared/locales/fr';
import { ja } from '../src/shared/locales/ja';
import { pt } from '../src/shared/locales/pt';
import { ru } from '../src/shared/locales/ru';
import { uk } from '../src/shared/locales/uk';
import { zh } from '../src/shared/locales/zh';
import type { BackendState, SystemInfo } from '../src/shared/types';
import { rawAccount, rawStatus } from './fixtures';

function memoryIO(initial: Record<string, string> = {}): FileIO & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    read: path => {
      if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[path] as string;
    },
    write: (path, data) => { files[path] = data; },
  };
}

describe('SettingsStore', () => {
  it('starts from safe defaults: nothing runs on its own', () => {
    const store = new SettingsStore('/s.json', memoryIO());
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({ launchAtLogin: false, startProxyOnLaunch: false, restartOnCrash: false, autoUpdate: false, autoUpdateCore: false });
  });

  it('applies first-run overrides only when no file exists', () => {
    expect(new SettingsStore('/s.json', memoryIO(), { language: 'ru' }).get().language).toBe('ru');
    const io = memoryIO({ '/s.json': JSON.stringify({ language: 'ja' }) });
    expect(new SettingsStore('/s.json', io, { language: 'ru' }).get().language).toBe('ja');
  });

  it('keeps valid fields from disk and drops invalid ones', () => {
    const io = memoryIO({ '/s.json': JSON.stringify({ theme: 'light', launchAtLogin: 'yes', backendPath: '/evil' }) });
    const s = new SettingsStore('/s.json', io).get();
    expect(s.theme).toBe('light');
    expect(s.launchAtLogin).toBe(false);
    expect(s).not.toHaveProperty('backendPath');
  });

  it('merges notification flags and persists updates', () => {
    const io = memoryIO();
    const store = new SettingsStore('/s.json', io);
    const next = store.update({ notifications: { ...DEFAULT_SETTINGS.notifications, quotaExhausted: false } });
    expect(next.notifications.proxyCrashed).toBe(true);
    expect(next.notifications.quotaExhausted).toBe(false);
    expect(JSON.parse(io.files['/s.json']!).notifications.quotaExhausted).toBe(false);
  });
});

describe('OwnedPidFile', () => {
  it('round-trips a pid and rejects garbage', () => {
    const io = memoryIO();
    const file = new OwnedPidFile('/p.json', io);
    expect(file.read()).toBeNull();
    file.write(123);
    expect(file.read()).toBe(123);
    file.write(null);
    expect(file.read()).toBeNull();
    io.files['/p.json'] = '{"ownedPid": -4}';
    expect(file.read()).toBeNull();
  });
});

describe('i18n', () => {
  const translations: Record<string, Record<string, string>> = { ru, uk, de, fr, es, pt, zh, ja };

  it('the language list and the catalogues match', () => {
    expect(LANGUAGES.map(l => l.code).sort()).toEqual(['en', ...Object.keys(translations)].sort());
  });

  it('every catalogue has exactly the English keys', () => {
    const keys = Object.keys(en).sort();
    for (const [code, catalogue] of Object.entries(translations)) expect(Object.keys(catalogue).sort(), code).toEqual(keys);
  });

  it('translations keep the same placeholders as English', () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, text] of Object.entries(en)) {
      for (const [code, catalogue] of Object.entries(translations)) expect(vars(catalogue[key]!), `${code} ${key}`).toEqual(vars(text));
    }
  });

  it('no translation is left empty', () => {
    for (const [code, catalogue] of Object.entries(translations)) {
      for (const [key, text] of Object.entries(catalogue)) expect(text.trim(), `${code} ${key}`).not.toBe('');
    }
  });

  it('formats, maps locales and falls back to English', () => {
    expect(format('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(languageForLocale('ru-RU')).toBe('ru');
    expect(languageForLocale('de-DE')).toBe('de');
    expect(languageForLocale('zh-CN')).toBe('zh');
    expect(languageForLocale('pt_BR')).toBe('pt');
    expect(languageForLocale('ko-KR')).toBe('en');
    expect(languageForLocale(undefined)).toBe('en');
    expect(translator('xx')('nav.overview')).toBe('Overview');
  });
});

describe('buildDiagnosticReport', () => {
  it('numbers accounts instead of naming them and redacts secrets in logs', () => {
    const system: SystemInfo = {
      os: 'linux', arch: 'x64', desktopVersion: '0.1.0', electronVersion: '44', nodeVersion: '24',
      backendVersion: '1.1.25', bundledBackendVersion: '1.1.25', proxyPhase: 'running', lastError: null,
      configDir: '/home/u/.config', userDataDir: '/home/u/.config/TeamClaude Desktop',
    };
    const state: BackendState = {
      phase: 'running', ownership: 'owned', host: '127.0.0.1', port: 3456, endpoint: 'http://127.0.0.1:3456',
      childPid: 1, lastError: null, restartCount: 0, serviceInstalled: false, compatibility: { ok: true, message: null },
      status: normalizeStatus(rawStatus({ accounts: [rawAccount({ name: 'secret.person@example.com' })] })),
      statusAt: 1, configPath: '/home/u/.config/teamclaude.json', configExists: true,
    };
    const report = buildDiagnosticReport(system, state, [
      { seq: 1, at: 0, stream: 'stderr', text: 'Authorization: Bearer abcdefghijklmnop' },
    ], new Date(0));
    expect(report).not.toContain('secret.person@example.com');
    expect(report).not.toContain('abcdefghijklmnop');
    expect(report).toContain('#1 anthropic/oauth');
    expect(report).toContain('5h=42%');
  });
});
