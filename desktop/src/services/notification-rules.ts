// Which desktop notifications a state change deserves. Pure: compares two
// BackendState snapshots the app already has from its normal status polling —
// no extra requests are made to produce a notification. Messages name accounts
// at most; never a credential.

import { translator, type Translate } from '../shared/i18n';
import type { AccountView, BackendState, NotificationPrefs } from '../shared/types';

export interface PendingNotification {
  kind: keyof NotificationPrefs;
  title: string;
  body: string;
}

const AUTH_CODES = new Set(['refresh_rejected', 'credential_rejected']);
const FAILED = new Set(['error', 'crash-loop', 'unreachable']);

function authExpired(a: AccountView): boolean {
  return !!a.error && AUTH_CODES.has(a.error.code);
}

/** Spent for the window — not a per-minute rate limit ('throttled'), which passes on its own. */
function exhausted(a: AccountView): boolean {
  return a.status === 'exhausted' || a.unavailable === 'exhausted';
}

function allUnavailable(state: BackendState): boolean {
  const enabled = state.status?.accounts.filter(a => !a.disabled) ?? [];
  return enabled.length > 0 && enabled.every(a => a.unavailable !== null);
}

export function notificationsFor(prev: BackendState | null, next: BackendState, t: Translate = translator('en')): PendingNotification[] {
  const out: PendingNotification[] = [];
  if (!prev) return out;

  if (prev.phase === 'running' && (next.phase === 'error' || next.phase === 'crash-loop') && prev.ownership === 'owned') {
    out.push({
      kind: 'proxyCrashed',
      title: t('n.crashedTitle'),
      body: t(next.phase === 'crash-loop' ? 'n.crashedLoop' : 'n.crashedBody'),
    });
  }
  if (FAILED.has(prev.phase) && next.phase === 'running') {
    out.push({ kind: 'backendRecovered', title: t('n.recoveredTitle'), body: t('n.recoveredBody', { endpoint: next.endpoint }) });
  }

  const before = prev.status;
  const after = next.status;
  // Account-level changes need two readings to compare; the first read after
  // attaching shows the state in the window instead of a burst of alerts.
  if (!before || !after) return out;
  const old = new Map(before.accounts.map(a => [`${a.provider}\u0000${a.name}`, a]));
  for (const account of after.accounts) {
    const was = old.get(`${account.provider}\u0000${account.name}`);
    if (!was) continue;
    if (authExpired(account) && !authExpired(was)) {
      out.push({ kind: 'authExpired', title: t('n.authTitle'), body: t('n.authBody', { name: account.name }) });
    }
    if (exhausted(account) && !exhausted(was) && !account.disabled) {
      out.push({ kind: 'quotaExhausted', title: t('n.quotaTitle'), body: t('n.quotaBody', { name: account.name }) });
    }
  }
  if (allUnavailable(next) && !allUnavailable(prev)) {
    out.push({ kind: 'allUnavailable', title: t('n.allTitle'), body: t('n.allBody') });
  }
  if (after.server.updateAvailable && !before.server.updateAvailable) {
    out.push({ kind: 'updateAvailable', title: t('n.updateTitle'), body: t('n.updateBody', { version: after.server.updateAvailable }) });
  }
  return out;
}
