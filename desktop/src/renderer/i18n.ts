// The renderer's translator. The store calls setLanguage() while rendering,
// before any page reads t(), so a language switch re-renders every string.

import { translator, type MessageKey, type Translate, type Vars } from '../shared/i18n';

export { LANGUAGES, type MessageKey } from '../shared/i18n';

let current: Translate = translator('en');
let currentCode = 'en';

export function setLanguage(code: string): void {
  if (code === currentCode) return;
  currentCode = code;
  current = translator(code);
  document.documentElement.lang = code;
}

export function t(key: MessageKey, vars?: Vars): string {
  return current(key, vars);
}
