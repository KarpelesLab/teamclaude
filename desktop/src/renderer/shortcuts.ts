// Keyboard shortcuts. Ctrl+1…9 opens the page at that place in the sidebar
// (the first nine);
// F5 or Ctrl+R reads the proxy status again. The window has no menu, so
// neither key reloads the page.

import type { PageId } from '../shared/ipc';

/** Sidebar order, which is also the Ctrl+number order. */
export const PAGE_ORDER: readonly PageId[] = [
  'overview', 'accounts', 'sessions', 'activity', 'usage', 'health', 'routing', 'integrations', 'settings', 'logs', 'about',
];

export type Shortcut = { type: 'page'; page: PageId } | { type: 'refresh' };

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function shortcutFor(e: KeyLike): Shortcut | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'F5') return mod || e.altKey ? null : { type: 'refresh' };
  if (!mod || e.altKey || e.shiftKey) return null;
  if (e.key.toLowerCase() === 'r') return { type: 'refresh' };
  if (!/^[1-9]$/.test(e.key)) return null;
  const page = PAGE_ORDER[Number(e.key) - 1];
  return page ? { type: 'page', page } : null;
}
