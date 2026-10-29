// When does an account run out? Two sources, both read-only:
// - the weekly windows: the server's own burn-rate forecast (quota.forecast),
//   which says when the account reaches its switch threshold;
// - the 5-hour window: the trend of the utilization readings the desktop has
//   recorded in the last hour (ActivityLog quota points), extrapolated to 100%.
// A run-out that falls after the window's reset is no run-out and is dropped.

import { accountKey, type QuotaPoint } from './activity';
import type { AccountView } from './types';

export interface Runout {
  window: 'fiveHour' | 'weekly';
  /** Model family of a model-scoped weekly window; null for the shared one. */
  family: string | null;
  at: number;
  resetAt: number | null;
  /** 0–1: the level the forecast runs to (the switch threshold, or 100%). */
  level: number;
}

const TREND_WINDOW_MS = 60 * 60_000;
const MIN_TREND_SPAN_MS = 10 * 60_000;
const MIN_TREND_RISE = 0.01;
const HORIZON_MS = 24 * 60 * 60_000;

/** Utilization per ms over the recent rising stretch of 5-hour readings, or null. */
export function fiveHourRate(points: QuotaPoint[], key: string, now: number): number | null {
  const recent: Array<{ at: number; u: number }> = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i] as QuotaPoint;
    if (now - p.at > TREND_WINDOW_MS) break;
    const u = p.accounts[key]?.fiveHour;
    if (u === null || u === undefined) break;
    // A reading higher than the one after it means a reset lay in between.
    if (recent.length && u > (recent[recent.length - 1] as { u: number }).u) break;
    recent.push({ at: p.at, u });
  }
  if (recent.length < 2) return null;
  const last = recent[0] as { at: number; u: number };
  const first = recent[recent.length - 1] as { at: number; u: number };
  const span = last.at - first.at;
  const rise = last.u - first.u;
  if (span < MIN_TREND_SPAN_MS || rise < MIN_TREND_RISE) return null;
  return rise / span;
}

export function runouts(account: AccountView, points: QuotaPoint[], now: number): Runout[] {
  const out: Runout[] = [];
  const u = account.fiveHour.utilization;
  const rate = fiveHourRate(points, accountKey(account.provider, account.name), now);
  if (u !== null && u < 1 && rate) {
    const at = Math.round(now + (1 - u) / rate);
    const resetAt = account.fiveHour.resetAt;
    if (at - now <= HORIZON_MS && (resetAt === null || at < resetAt)) out.push({ window: 'fiveHour', family: null, at, resetAt, level: 1 });
  }
  for (const f of account.forecast) {
    const at = f.reachesThresholdAt;
    if (at === null || at <= now || at - now > HORIZON_MS * 14) continue;
    if (f.resetAt !== null && at >= f.resetAt) continue;
    out.push({ window: 'weekly', family: f.family, at, resetAt: f.resetAt, level: f.threshold });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The account that runs out first among those still serving, or null. */
export function soonestRunout(accounts: AccountView[], points: QuotaPoint[], now: number): { account: AccountView; runout: Runout } | null {
  let best: { account: AccountView; runout: Runout } | null = null;
  for (const account of accounts) {
    if (account.disabled || account.unavailable) continue;
    const first = runouts(account, points, now)[0];
    if (first && (!best || first.at < best.runout.at)) best = { account, runout: first };
  }
  return best;
}

/** How far ahead a run-out is worth a notification. */
export const ALERT_LEAD_MS = 60 * 60_000;

export interface RunoutAlert {
  /** Stable for one window of one account, so each run-out is announced once. */
  key: string;
  account: AccountView;
  runout: Runout;
}

export function runoutAlerts(accounts: AccountView[], points: QuotaPoint[], now: number): RunoutAlert[] {
  const alerts: RunoutAlert[] = [];
  for (const account of accounts) {
    if (account.disabled || account.unavailable) continue;
    for (const runout of runouts(account, points, now)) {
      if (runout.at - now > ALERT_LEAD_MS) continue;
      const windowId = runout.resetAt ?? Math.floor(runout.at / ALERT_LEAD_MS);
      alerts.push({ key: `${accountKey(account.provider, account.name)}/${runout.window}/${runout.family ?? ''}/${windowId}`, account, runout });
    }
  }
  return alerts;
}
