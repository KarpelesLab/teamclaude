// /teamclaude/status → StatusView. Every field is read defensively: an older
// or newer backend may omit or add fields, and a missing reading must surface
// as `null` ("Unknown" in the UI), never as a made-up number.

import type {
  AccountView, BackgroundJobView, ForecastView, TokenUsage, NamedQuotaWindow, QuotaWindow, RouteView, SessionView, StatusView,
} from '../shared/types';

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
}
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function int(value: unknown, fallback = 0): number {
  const n = num(value);
  return n === null ? fallback : Math.trunc(n);
}
function bool(value: unknown): boolean {
  return value === true;
}
function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function window(quota: Obj, key: string): QuotaWindow {
  return {
    utilization: num(quota[key]),
    resetAt: num(quota[`${key}Reset`]),
    seenAt: num(quota[`${key}SeenAt`]),
  };
}

/** A third-party backend's own window (backend-quota.js), used when no unified reading exists. */
function backendWindow(quota: Obj, key: string): QuotaWindow | null {
  const windows = obj(obj(quota.backend).windows);
  const w = obj(windows[key]);
  const utilization = num(w.utilization);
  if (utilization === null) return null;
  return { utilization, resetAt: num(w.resetAt), seenAt: num(obj(quota.backend).at) };
}

const MODEL_WINDOWS: Array<{ key: string; label: string }> = [
  { key: 'unified7dSonnet', label: 'Sonnet' },
  { key: 'unified7dFable', label: 'Fable' },
];

function usageOf(raw: unknown): TokenUsage | null {
  const u = obj(raw);
  const input = num(u.totalInputTokens);
  const output = num(u.totalOutputTokens);
  if (input === null && output === null) return null;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: num(u.totalCacheReadTokens) ?? 0,
    cacheCreationTokens: num(u.totalCacheCreationTokens) ?? 0,
  };
}

function forecastOf(raw: unknown): ForecastView[] {
  return Object.entries(obj(raw)).flatMap(([bucket, value]) => {
    const f = obj(value);
    const threshold = num(f.threshold);
    if (threshold === null) return [];
    const family = bucket === 'unified7d' ? null : bucket.replace(/^unified7d/, '') || bucket;
    return [{ bucket, family, ratePerHour: num(f.ratePerHour), threshold, reachesThresholdAt: num(f.reachesThresholdAt), resetAt: num(f.resetAt) }];
  });
}

function normalizeAccount(raw: unknown, index: number, current: Set<string>): AccountView {
  const a = obj(raw);
  const quota = obj(a.quota);
  const err = obj(a.errorReason);
  const fiveHour = window(quota, 'unified5h');
  const weekly = window(quota, 'unified7d');
  const name = str(a.name) ?? `account-${index + 1}`;
  const provider = str(a.provider) ?? 'anthropic';
  const modelWindows: NamedQuotaWindow[] = MODEL_WINDOWS
    .map(({ key, label }) => ({ label, ...window(quota, key) }))
    .filter(w => w.utilization !== null);
  return {
    index,
    name,
    type: str(a.type) ?? 'unknown',
    provider,
    orgName: str(a.orgName),
    priority: int(a.priority),
    disabled: bool(a.disabled),
    status: str(a.status) ?? 'unknown',
    unavailable: str(a.unavailable),
    error: str(err.code) ? { code: str(err.code) ?? '', detail: str(err.detail) ?? '', remedy: str(err.remedy) } : null,
    isCurrent: current.has(`${provider}\u0000${name}`),
    sessions: int(a.sessions),
    knownSessions: int(a.knownSessions),
    fiveHour: fiveHour.utilization === null ? backendWindow(quota, 'fiveHour') ?? fiveHour : fiveHour,
    sessionWindowStated: typeof quota.sessionWindowStated === 'boolean' ? quota.sessionWindowStated : null,
    weekly: weekly.utilization === null ? backendWindow(quota, 'weekly') ?? weekly : weekly,
    weeklyWindowStated: typeof quota.weeklyWindowStated === 'boolean' ? quota.weeklyWindowStated : null,
    modelWindows,
    onExtraUsage: bool(a.onExtraUsage),
    allowExtraUsage: bool(a.allowExtraUsage),
    rateLimitedUntil: str(a.rateLimitedUntil),
    pausedUntil: str(a.pausedUntil),
    credentialRejectedUntil: str(a.credentialRejectedUntil),
    totalRequests: num(obj(a.usage).totalRequests),
    recentRequests: num(a.recentRequests),
    usage: usageOf(a.usage),
    forecast: forecastOf(quota.forecast),
  };
}

function normalizeSession(raw: unknown, accounts: AccountView[]): SessionView {
  const s = obj(raw);
  const pins = obj(s.pins);
  const resolved: Record<string, string> = {};
  for (const [bucket, idx] of Object.entries(pins)) {
    const i = num(idx);
    const account = i === null ? undefined : accounts[i];
    if (account) resolved[bucket] = account.name;
  }
  return {
    id: str(s.id) ?? '',
    active: bool(s.active),
    inFlight: int(s.inFlight),
    requests: int(s.requests),
    lastSeen: num(s.lastSeen),
    client: str(s.client),
    conversation: str(s.conversation),
    accounts: resolved,
  };
}

function normalizeRoute(raw: unknown): RouteView {
  const r = obj(raw);
  return {
    name: str(r.name) ?? '',
    match: strList(r.match),
    provider: str(r.provider) ?? 'anthropic',
    autocreated: bool(r.autocreated),
    pinned: str(r.pinned),
    target: str(r.target),
  };
}

function job(raw: unknown): BackgroundJobView {
  const j = obj(raw);
  return { enabled: bool(j.enabled), intervalSeconds: int(j.intervalSeconds) };
}

function updateLabel(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value === true) return 'available';
  const o = obj(value);
  return str(o.latest);
}

export function normalizeStatus(raw: Obj): StatusView {
  const server = obj(raw.server);
  const currentRaw = obj(raw.currentAccounts);
  const currentAccounts: Record<string, string | null> = {};
  const current = new Set<string>();
  for (const [provider, name] of Object.entries(currentRaw)) {
    currentAccounts[provider] = str(name);
    if (typeof name === 'string') current.add(`${provider}\u0000${name}`);
  }
  // A backend older than per-provider cursors names one current account.
  if (Object.keys(currentRaw).length === 0 && typeof raw.currentAccount === 'string') {
    currentAccounts.anthropic = raw.currentAccount;
    current.add(`anthropic\u0000${raw.currentAccount}`);
  }
  const accounts = Array.isArray(raw.accounts) ? raw.accounts.map((a, i) => normalizeAccount(a, i, current)) : [];
  const sessions = obj(raw.sessions);
  const distribution = str(sessions.mode) ?? (typeof sessions.distribute === 'boolean' ? (sessions.distribute ? 'even' : 'off') : null);
  return {
    server: {
      version: str(server.version),
      pid: num(server.pid),
      port: num(server.port),
      uptimeSeconds: num(server.uptimeSeconds),
      startedAt: str(server.startedAt),
      updateAvailable: updateLabel(server.updateAvailable),
      upstream: str(server.upstream),
    },
    accounts,
    currentAccounts,
    switchThreshold: num(raw.switchThreshold),
    perBucketThresholds: !!raw.switchThresholds && typeof raw.switchThresholds === 'object',
    sessions: {
      active: int(sessions.active),
      known: int(sessions.known),
      distribution,
      draining: int(sessions.draining),
      starvedMax: int(sessions.starvedMax),
      items: Array.isArray(sessions.items) ? sessions.items.map(s => normalizeSession(s, accounts)) : null,
    },
    routes: Array.isArray(raw.routes) ? raw.routes.map(normalizeRoute) : [],
    probe: job(raw.probe),
    warm: job(raw.warm),
    blockedModels: strList(raw.blockedModels),
    readOnly: obj(raw.caller).kind === 'client',
  };
}
