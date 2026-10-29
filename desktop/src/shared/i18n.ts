// Translation for both processes. The renderer and the main process (tray,
// notifications, action results) read the same catalogues, so a language
// switch changes every string the user sees.

import { de } from './locales/de';
import { en, type MessageKey } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { ja } from './locales/ja';
import { pt } from './locales/pt';
import { ru } from './locales/ru';
import { uk } from './locales/uk';
import { zh } from './locales/zh';

export type { MessageKey };
export type Language = 'en' | 'ru' | 'uk' | 'de' | 'fr' | 'es' | 'pt' | 'zh' | 'ja';
export type Vars = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: Vars) => string;

export const LANGUAGES: Array<{ code: Language; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português (Brasil)' },
  { code: 'zh', label: '简体中文' },
  { code: 'ja', label: '日本語' },
];

const CATALOGUES: Record<Language, Record<MessageKey, string>> = { en, ru, uk, de, fr, es, pt, zh, ja };

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATALOGUES, value);
}

/** The supported language closest to a system locale ("ru-RU" → "ru"), English otherwise. */
export function languageForLocale(locale: string | null | undefined): Language {
  const base = (locale ?? '').toLowerCase().split(/[-_]/)[0];
  return isLanguage(base) ? base : 'en';
}

export function format(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function translator(language: string): Translate {
  const catalogue = CATALOGUES[isLanguage(language) ? language : 'en'];
  return (key, vars) => format(catalogue[key] ?? en[key], vars);
}
