// Aggregate machine-readable quota and usage across teamclaude proxy state,
// per-tier quota state files (~/.local/state/quota/<tier>.json), soak/burn
// history (*.burn.jsonl, soak.jsonl), and model_route_runs/latest.json.
//
// One producer, two transports:
//   - `teamclaude usage [--json]` (stdout)
//   - `teamclaude usage serve` (loopback HTTP /usage and /health)
//
// Adopts the generic usage.details contract (title, rows[label,value,secondaryValue],
// optional bars) modeled after CodexBar's dashboard-v1 schema so external tools
// (statusline, tmux, sketchybar, orchestrators) can consume any tier uniformly.

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { registerBuildFeature, BUILD_VERSION } from './build-identity.js';
import { loadOrCreateConfig, loadState } from './config.js';

registerBuildFeature('usage-serve');

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

function resolvePath(p) {
  if (!p) return null;
  return String(p).replace(/^~/, homedir());
}

function parseTs(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    // If given seconds epoch (10 digits), convert to ms epoch
    return value < 1e11 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatIso(value) {
  const ts = parseTs(value);
  return ts != null ? new Date(ts).toISOString() : null;
}

function computeCountdownSeconds(resetTime, now) {
  const resetTs = parseTs(resetTime);
  if (resetTs == null) return null;
  const diffMs = resetTs - now;
  return diffMs > 0 ? Math.round(diffMs / 1000) : 0;
}

function safeRatioToPercent(ratio) {
  if (ratio == null || Number.isNaN(Number(ratio))) return null;
  const num = Number(ratio);
  return Math.round(Math.max(0, Math.min(1, num)) * 1000) / 10;
}

function safeNumber(val) {
  if (val == null || Number.isNaN(Number(val))) return null;
  return Number(val);
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Read all `*.json` quota-state files in the given directory (default ~/.local/state/quota).
 */
export async function readQuotaStateFiles(quotaDir) {
  const resolvedDir = resolvePath(quotaDir || process.env.TEAMCLAUDE_QUOTA_STATE_DIR || join(homedir(), '.local/state/quota'));
  const result = {};
  if (!resolvedDir || !existsSync(resolvedDir)) return result;

  try {
    const entries = await readdir(resolvedDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      if (ent.name.startsWith('.') || ent.name.includes('.seen.') || ent.name === 'latest.json') continue;

      const tier = ent.name.slice(0, -'.json'.length);
      const filePath = join(resolvedDir, ent.name);
      try {
        const raw = await readFile(filePath, 'utf8');
        const data = JSON.parse(raw);
        result[tier] = {
          tier,
          filePath,
          data,
          unified5h: data.unified_5h_utilization,
          unified5hReset: data.unified_5h_reset,
          unified7d: data.unified_7d_utilization,
          unified7dReset: data.unified_7d_reset,
          updatedAt: data.updated_at,
          planType: data.plan_type || null,
          resetCredits: data.reset_credits ?? null,
          additional: Array.isArray(data.additional) ? data.additional : [],
          source: data.source || 'quota-state-file',
          sesIsBurnRateProxy: Boolean(data.ses_is_burn_rate_proxy),
        };
      } catch {
        // Skip unparseable JSON files gracefully
      }
    }
  } catch {
    // Directory unreadable or error
  }

  return result;
}

/**
 * Read burn history (*.burn.jsonl) and soak log (soak.jsonl) from quotaDir.
 */
export async function readBurnAndSoakHistory(quotaDir) {
  const resolvedDir = resolvePath(quotaDir || process.env.TEAMCLAUDE_QUOTA_STATE_DIR || join(homedir(), '.local/state/quota'));
  const result = { tiers: {}, soak: [] };
  if (!resolvedDir || !existsSync(resolvedDir)) return result;

  try {
    const entries = await readdir(resolvedDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;

      // Handle <tier>.burn.jsonl
      if (ent.name.endsWith('.burn.jsonl')) {
        const tier = ent.name.slice(0, -'.burn.jsonl'.length);
        const filePath = join(resolvedDir, ent.name);
        try {
          const raw = await readFile(filePath, 'utf8');
          const lines = raw.trim().split('\n').filter(Boolean);
          const points = [];
          for (const line of lines.slice(-100)) {
            try {
              const obj = JSON.parse(line);
              if (obj.t != null && obj.u != null) {
                const ts = parseTs(obj.t);
                points.push({ timestamp: ts, utilization: Number(obj.u) });
              }
            } catch { /* skip corrupted line */ }
          }

          if (points.length > 0) {
            let burnRatePerHour = null;
            if (points.length >= 2) {
              const first = points[0];
              const last = points[points.length - 1];
              const deltaHours = (last.timestamp - first.timestamp) / 3600000;
              if (deltaHours > 0.001) {
                const deltaU = last.utilization - first.utilization;
                burnRatePerHour = Math.round((deltaU / deltaHours) * 10000) / 10000;
              }
            }

            result.tiers[tier] = {
              dataPoints: points.length,
              lastRecordedAt: formatIso(points[points.length - 1].timestamp),
              lastUtilization: points[points.length - 1].utilization,
              burnRatePerHour,
              recentPoints: points.slice(-10),
            };
          }
        } catch { /* skip unreadable burn file */ }
      }

      // Handle soak.jsonl
      if (ent.name === 'soak.jsonl') {
        const filePath = join(resolvedDir, ent.name);
        try {
          const raw = await readFile(filePath, 'utf8');
          const lines = raw.trim().split('\n').filter(Boolean);
          const lastLines = lines.slice(-20);
          for (const line of lastLines) {
            try {
              const obj = JSON.parse(line);
              if (obj.t) result.soak.push(obj);
            } catch { /* skip */ }
          }
        } catch { /* skip unreadable soak file */ }
      }
    }
  } catch {
    // Directory unreadable
  }

  return result;
}

/**
 * Locate and read latest.json from model_route_runs.
 */
export async function readLatestModelRouteRun(options = {}) {
  const candidates = [];
  if (options.modelRouteFile) candidates.push(resolvePath(options.modelRouteFile));
  if (options.modelRouteDir) candidates.push(join(resolvePath(options.modelRouteDir), 'latest.json'));
  if (process.env.MODEL_ROUTE_LATEST_FILE) candidates.push(resolvePath(process.env.MODEL_ROUTE_LATEST_FILE));
  if (process.env.MODEL_ROUTE_STATUS_DIR) candidates.push(join(resolvePath(process.env.MODEL_ROUTE_STATUS_DIR), 'latest.json'));
  candidates.push(join(process.cwd(), 'data/_meta/state/model_route_runs/latest.json'));
  candidates.push(join(homedir(), '.local/state/model_route_runs/latest.json'));
  candidates.push(join(homedir(), 'gh/harness-engineering/data/_meta/state/model_route_runs/latest.json'));

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      const raw = await readFile(candidate, 'utf8');
      const data = JSON.parse(raw);
      if (data && (data.tier || data.run_id || data.state)) {
        return {
          runId: data.run_id || null,
          state: data.state || 'unknown',
          tier: data.tier || null,
          class: data.class || null,
          rc: data.rc != null ? String(data.rc) : null,
          reason: data.reason || null,
          updatedAt: formatIso(data.updated_at) || null,
          chain: Array.isArray(data.chain) ? data.chain : [],
          pid: data.pid || null,
          filePath: candidate,
        };
      }
    } catch {
      // Continue to next candidate
    }
  }

  return null;
}

/**
 * Fetch live status from running proxy server, falling back to offline config/state.
 */
async function getStatusOrOffline(options = {}) {
  if (options.status) return { ...options.status, serverRunning: true };

  const config = options.config || await loadOrCreateConfig();
  const port = config?.proxy?.port || 3456;
  const apiKey = config?.proxy?.apiKey;

  if (!options.offline) {
    try {
      const url = `http://127.0.0.1:${port}/teamclaude/status`;
      const res = await fetch(url, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
        signal: AbortSignal.timeout(600),
      });
      if (res.ok) {
        const data = await res.json();
        return { ...data, serverRunning: true };
      }
    } catch {
      // Fall through to offline fallback
    }
  }

  // Construct offline status base from config & state file
  const state = await loadState();
  return {
    currentAccount: state?.currentAccount || config?.accounts?.[0]?.name || null,
    switchThreshold: config?.switchThreshold ?? 0.98,
    routes: config?.routes || [],
    sessions: null,
    probe: { enabled: Boolean(config?.probe?.enabled), intervalSeconds: config?.probe?.intervalSeconds || 0 },
    accounts: (config?.accounts || []).map(a => ({
      name: a.name,
      type: a.type || 'oauth',
      orgName: a.orgName || null,
      priority: a.priority ?? 0,
      disabled: Boolean(a.disabled),
      status: a.disabled ? 'disabled' : 'active',
      quota: a.quota || {},
      usage: a.usage || {},
      health: a.health || {},
    })),
    serverRunning: false,
  };
}

function barColor(usedPercent) {
  if (usedPercent == null) return 'gray';
  if (usedPercent >= 90) return 'red';
  if (usedPercent >= 70) return 'yellow';
  return 'green';
}

/**
 * Build the unified versioned Usage document.
 */
export async function buildUsageDocument(options = {}) {
  const now = options.now ? parseTs(options.now) : Date.now();
  const staleAfterSeconds = options.staleAfterSeconds ?? 300;

  const [status, tierFiles, burnHistory, lastServedRun] = await Promise.all([
    getStatusOrOffline(options),
    readQuotaStateFiles(options.quotaDir),
    readBurnAndSoakHistory(options.quotaDir),
    readLatestModelRouteRun(options),
  ]);

  const providers = [];
  const processedTiers = new Set();

  // 1. Process all accounts from proxy status/config
  const accounts = status.accounts || [];
  for (const account of accounts) {
    const name = account.name;
    processedTiers.add(name);

    const tierFile = tierFiles[name];
    const burn = burnHistory.tiers[name] || null;
    const isCurrent = name === status.currentAccount;
    const isLastServed = lastServedRun?.tier === name;

    // Collect quota windows
    const windows = [];
    const quota = account.quota || {};

    // 5-Hour / Session quota
    const u5h = quota.unified5h != null ? quota.unified5h : tierFile?.unified5h;
    const reset5h = quota.unified5hReset != null ? quota.unified5hReset : tierFile?.unified5hReset;
    if (u5h != null || reset5h != null) {
      const usedPercent = safeRatioToPercent(u5h);
      windows.push({
        kind: '5h',
        name: '5-Hour Quota',
        usedPercent,
        remainingPercent: usedPercent != null ? Math.max(0, Math.round((100 - usedPercent) * 10) / 10) : null,
        resetsAt: formatIso(reset5h),
        resetCountdownSeconds: computeCountdownSeconds(reset5h, now),
      });
    }

    // 7-Day / Weekly quota
    const u7d = quota.unified7d != null ? quota.unified7d : tierFile?.unified7d;
    const reset7d = quota.unified7dReset != null ? quota.unified7dReset : tierFile?.unified7dReset;
    if (u7d != null || reset7d != null) {
      const usedPercent = safeRatioToPercent(u7d);
      windows.push({
        kind: '7d',
        name: 'Weekly Quota',
        usedPercent,
        remainingPercent: usedPercent != null ? Math.max(0, Math.round((100 - usedPercent) * 10) / 10) : null,
        resetsAt: formatIso(reset7d),
        resetCountdownSeconds: computeCountdownSeconds(reset7d, now),
      });
    }

    // Model specific windows (Fable, Sonnet)
    if (quota.unified7dFable != null || quota.unified7dFableReset != null) {
      const usedPercent = safeRatioToPercent(quota.unified7dFable);
      windows.push({
        kind: '7d-fable',
        name: 'Fable Weekly Quota',
        usedPercent,
        remainingPercent: usedPercent != null ? Math.max(0, Math.round((100 - usedPercent) * 10) / 10) : null,
        resetsAt: formatIso(quota.unified7dFableReset),
        resetCountdownSeconds: computeCountdownSeconds(quota.unified7dFableReset, now),
      });
    }
    if (quota.unified7dSonnet != null || quota.unified7dSonnetReset != null) {
      const usedPercent = safeRatioToPercent(quota.unified7dSonnet);
      windows.push({
        kind: '7d-sonnet',
        name: 'Sonnet Weekly Quota',
        usedPercent,
        remainingPercent: usedPercent != null ? Math.max(0, Math.round((100 - usedPercent) * 10) / 10) : null,
        resetsAt: formatIso(quota.unified7dSonnetReset),
        resetCountdownSeconds: computeCountdownSeconds(quota.unified7dSonnetReset, now),
      });
    }

    // Tokens/requests budget window if available
    if (quota.tokensLimit != null && quota.tokensRemaining != null) {
      const usedTokens = Math.max(0, quota.tokensLimit - quota.tokensRemaining);
      const usedPercent = Math.round((usedTokens / quota.tokensLimit) * 1000) / 10;
      windows.push({
        kind: 'tokens',
        name: 'Token Budget',
        usedPercent,
        remainingPercent: Math.max(0, Math.round((100 - usedPercent) * 10) / 10),
        resetsAt: formatIso(quota.resetsAt),
        resetCountdownSeconds: computeCountdownSeconds(quota.resetsAt, now),
      });
    }

    // Credits / Plan info
    let credits = null;
    if (tierFile?.planType || tierFile?.resetCredits != null) {
      credits = {
        planType: tierFile.planType || null,
        resetCredits: tierFile.resetCredits ?? null,
      };
    }

    // Usage statistics
    const usage = account.usage || {};
    const inputTokens = safeNumber(usage.totalInputTokens) || 0;
    const outputTokens = safeNumber(usage.totalOutputTokens) || 0;
    const requests = safeNumber(usage.totalRequests) || 0;
    const lastUsed = formatIso(usage.lastUsed);

    // Health / Diagnostics
    const health = account.health || {};
    const latencyEwmaMs = safeNumber(health.latencyEwmaMs);
    const consecutiveFailures = safeNumber(health.consecutiveFailures) || 0;
    const circuitOpenUntil = formatIso(health.circuitOpenUntil);
    const lastSuccessAt = formatIso(health.lastSuccessAt);
    const lastFailure = health.lastFailure ? {
      at: formatIso(health.lastFailure.at),
      status: health.lastFailure.status ?? null,
      error: health.lastFailure.error ?? null,
    } : null;

    // Generic details contract
    const detailRows = [
      { label: 'Status', value: account.status || 'unknown', secondaryValue: account.disabled ? 'disabled' : undefined },
      { label: 'Type', value: account.type || 'oauth', secondaryValue: account.orgName || undefined },
      { label: 'Priority', value: String(account.priority ?? 0) },
    ];

    for (const w of windows) {
      const resetText = w.resetCountdownSeconds != null ? `reset in ${formatDurationSimple(w.resetCountdownSeconds * 1000)}` : undefined;
      detailRows.push({
        label: w.name,
        value: w.usedPercent != null ? `${w.usedPercent}% used` : 'n/a',
        secondaryValue: resetText,
      });
    }

    if (requests > 0 || (inputTokens + outputTokens) > 0) {
      detailRows.push({
        label: 'Requests',
        value: requests.toLocaleString(),
        secondaryValue: `${formatTokensSimple(inputTokens + outputTokens)} tok`,
      });
    }

    if (latencyEwmaMs != null) {
      detailRows.push({
        label: 'Latency EWMA',
        value: `${Math.round(latencyEwmaMs)}ms`,
      });
    }

    if (burn?.burnRatePerHour != null) {
      detailRows.push({
        label: 'Burn Rate',
        value: `${(burn.burnRatePerHour * 100).toFixed(1)}%/hr`,
      });
    }

    const detailBars = windows.filter(w => w.usedPercent != null).map(w => ({
      label: w.kind,
      usedPercent: w.usedPercent,
      remainingPercent: w.remainingPercent,
      resetsAt: w.resetsAt,
      color: barColor(w.usedPercent),
    }));

    providers.push({
      id: name,
      name,
      type: account.type || 'oauth',
      orgName: account.orgName || null,
      priority: account.priority ?? 0,
      disabled: Boolean(account.disabled),
      status: account.status || 'unknown',
      source: tierFile?.source || (account.type === 'oauth' ? 'anthropic-oauth' : 'teamclaude-proxy'),
      current: isCurrent,
      isLastServed,
      windows,
      credits,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        requests,
        lastUsed,
      },
      health: {
        latencyEwmaMs,
        consecutiveFailures,
        circuitOpenUntil,
        lastSuccessAt,
        lastFailure,
      },
      burn: burn ? {
        burnRatePerHour: burn.burnRatePerHour,
        dataPoints: burn.dataPoints,
        lastRecordedAt: burn.lastRecordedAt,
      } : null,
      details: {
        title: name,
        rows: detailRows,
        bars: detailBars,
      },
    });
  }

  // 2. Process standalone quota state files that weren't in accounts[]
  for (const [tier, tierFile] of Object.entries(tierFiles)) {
    if (processedTiers.has(tier)) continue;
    processedTiers.add(tier);

    const burn = burnHistory.tiers[tier] || null;
    const isLastServed = lastServedRun?.tier === tier;

    const windows = [];
    if (tierFile.unified5h != null || tierFile.unified5hReset != null) {
      const usedPercent = safeRatioToPercent(tierFile.unified5h);
      windows.push({
        kind: '5h',
        name: '5-Hour Quota',
        usedPercent,
        remainingPercent: usedPercent != null ? Math.max(0, Math.round((100 - usedPercent) * 10) / 10) : null,
        resetsAt: formatIso(tierFile.unified5hReset),
        resetCountdownSeconds: computeCountdownSeconds(tierFile.unified5hReset, now),
      });
    }
    if (tierFile.unified7d != null || tierFile.unified7dReset != null) {
      const usedPercent = safeRatioToPercent(tierFile.unified7d);
      windows.push({
        kind: '7d',
        name: 'Weekly Quota',
        usedPercent,
        remainingPercent: usedPercent != null ? Math.max(0, Math.round((100 - usedPercent) * 10) / 10) : null,
        resetsAt: formatIso(tierFile.unified7dReset),
        resetCountdownSeconds: computeCountdownSeconds(tierFile.unified7dReset, now),
      });
    }

    for (const item of tierFile.additional) {
      if (item && item.name) {
        const usedPercent = safeNumber(item.used_percent);
        windows.push({
          kind: 'model-item',
          name: item.name,
          usedPercent,
          remainingPercent: usedPercent != null ? Math.max(0, 100 - usedPercent) : null,
          resetsAt: null,
          resetCountdownSeconds: null,
        });
      }
    }

    const isExhausted = (tierFile.unified7d != null && tierFile.unified7d >= 1) ||
      (tierFile.unified5h != null && tierFile.unified5h >= 1);
    const statusStr = isExhausted ? 'exhausted' : 'active';

    const detailRows = [
      { label: 'Status', value: statusStr },
      { label: 'Source', value: tierFile.source },
    ];
    if (tierFile.planType) detailRows.push({ label: 'Plan', value: tierFile.planType });
    if (tierFile.resetCredits != null) detailRows.push({ label: 'Reset Credits', value: String(tierFile.resetCredits) });

    for (const w of windows) {
      detailRows.push({
        label: w.name,
        value: w.usedPercent != null ? `${w.usedPercent}% used` : 'n/a',
        secondaryValue: w.resetCountdownSeconds != null ? `reset in ${formatDurationSimple(w.resetCountdownSeconds * 1000)}` : undefined,
      });
    }

    if (burn?.burnRatePerHour != null) {
      detailRows.push({
        label: 'Burn Rate',
        value: `${(burn.burnRatePerHour * 100).toFixed(1)}%/hr`,
      });
    }

    const detailBars = windows.filter(w => w.usedPercent != null).map(w => ({
      label: w.kind,
      usedPercent: w.usedPercent,
      remainingPercent: w.remainingPercent,
      resetsAt: w.resetsAt,
      color: barColor(w.usedPercent),
    }));

    providers.push({
      id: tier,
      name: tier,
      type: 'tier-quota',
      orgName: null,
      priority: null,
      disabled: false,
      status: statusStr,
      source: tierFile.source,
      current: false,
      isLastServed,
      windows,
      credits: (tierFile.planType || tierFile.resetCredits != null) ? {
        planType: tierFile.planType,
        resetCredits: tierFile.resetCredits,
      } : null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requests: 0,
        lastUsed: null,
      },
      health: {
        latencyEwmaMs: null,
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        lastSuccessAt: null,
        lastFailure: null,
      },
      burn: burn ? {
        burnRatePerHour: burn.burnRatePerHour,
        dataPoints: burn.dataPoints,
        lastRecordedAt: burn.lastRecordedAt,
      } : null,
      details: {
        title: tier,
        rows: detailRows,
        bars: detailBars,
      },
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    staleAfterSeconds,
    summary: {
      activeAccount: status.currentAccount || null,
      totalAccounts: providers.length,
      activeAccounts: providers.filter(p => p.status === 'active' && !p.disabled).length,
      lastServedTier: lastServedRun?.tier || null,
      lastServedAt: lastServedRun?.updatedAt || null,
      serverRunning: status.serverRunning ?? true,
    },
    lastServedRun: lastServedRun || null,
    providers,
  };
}

function formatTokensSimple(num) {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function formatDurationSimple(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.ceil(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d${remHours}h` : `${days}d`;
}

function renderBar(usedPercent, width = 16) {
  if (usedPercent == null) return `[${'░'.repeat(width)}]`;
  const safe = Math.max(0, Math.min(100, usedPercent));
  const full = Math.round((safe / 100) * width);
  return `[${'█'.repeat(full)}${'░'.repeat(width - full)}]`;
}

/**
 * Format the usage document for terminal stdout.
 */
export function formatUsageReport(doc, { color = process.stdout.isTTY } = {}) {
  const lines = [];
  const cBold = color ? `${ESC}1m` : '';
  const cDim = color ? `${ESC}2m` : '';
  const cGreen = color ? `${ESC}32m` : '';
  const cYellow = color ? `${ESC}33m` : '';
  const cRed = color ? `${ESC}31m` : '';
  const cCyan = color ? `${ESC}36m` : '';
  const cReset = color ? RESET : '';

  lines.push(`${cBold}TeamClaude Usage${cReset}`);
  lines.push(`${cDim}Generated:${cReset} ${doc.generatedAt} ${cDim}(stale after ${doc.staleAfterSeconds}s)${cReset}`);
  lines.push(
    `${cDim}Active:${cReset} ${cCyan}${doc.summary?.activeAccount || 'none'}${cReset}  ${cDim}·  Last served:${cReset} ${doc.summary?.lastServedTier || 'none'} ${doc.lastServedRun?.state ? `(${doc.lastServedRun.state})` : ''}`
  );
  lines.push(
    `${cDim}Accounts:${cReset} ${doc.summary?.totalAccounts || 0} configured (${doc.summary?.activeAccounts || 0} active)  ${cDim}·  Server:${cReset} ${doc.summary?.serverRunning ? `${cGreen}running${cReset}` : `${cYellow}offline${cReset}`}`
  );
  lines.push('');

  for (const p of doc.providers || []) {
    const isCurrent = p.current;
    const prefix = isCurrent ? `${cCyan}>${cReset} ` : '  ';
    const nameStr = isCurrent ? `${cBold}${p.name}${cReset}` : p.name;
    const statusColor = p.status === 'active' ? cGreen : (p.status === 'throttled' ? cYellow : cRed);
    const statusStr = `[${statusColor}${p.status}${cReset}]`;
    const typeStr = `${cDim}(${p.type}${p.priority != null ? `, prio ${p.priority}` : ''})${cReset}`;
    const lastServedBadge = p.isLastServed ? ` ${cYellow}[last-served]${cReset}` : '';

    lines.push(`${prefix}${nameStr} ${typeStr} ${statusStr}${lastServedBadge}`);

    for (const w of p.windows || []) {
      const bar = renderBar(w.usedPercent, 16);
      const used = w.usedPercent != null ? `${String(w.usedPercent).padStart(5)}% used` : '    -% used';
      const rem = w.remainingPercent != null ? `${String(w.remainingPercent).padStart(5)}% left` : '';
      const reset = w.resetCountdownSeconds != null ? ` · reset ${formatDurationSimple(w.resetCountdownSeconds * 1000)}` : '';
      lines.push(`    ${cDim}${w.name.padEnd(16)}${cReset} ${bar} ${used} · ${rem}${reset}`);
    }

    if (p.usage && (p.usage.requests > 0 || p.usage.totalTokens > 0)) {
      const reqStr = `${p.usage.requests.toLocaleString()} req`;
      const tokStr = `${formatTokensSimple(p.usage.totalTokens)} tok`;
      const lastStr = p.usage.lastUsed ? ` · last ${p.usage.lastUsed}` : '';
      lines.push(`    ${cDim}${'Usage'.padEnd(16)}${cReset} ${reqStr} · ${tokStr}${lastStr}`);
    }

    if (p.health?.latencyEwmaMs != null) {
      lines.push(`    ${cDim}${'Latency EWMA'.padEnd(16)}${cReset} ${Math.round(p.health.latencyEwmaMs)}ms`);
    }

    if (p.burn?.burnRatePerHour != null) {
      lines.push(`    ${cDim}${'Burn Rate'.padEnd(16)}${cReset} ${(p.burn.burnRatePerHour * 100).toFixed(1)}%/hr (${p.burn.dataPoints} pts)`);
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Loopback HTTP server serving /usage and /health endpoints.
 */
export function createUsageServer(options = {}) {
  const host = options.host || process.env.TEAMCLAUDE_USAGE_HOST || '127.0.0.1';
  const envPort = process.env.TEAMCLAUDE_USAGE_PORT || process.env.PORT;
  const port = Number(options.port ?? (envPort != null && envPort !== '' ? envPort : 3457));
  const token = options.token || process.env.TEAMCLAUDE_USAGE_TOKEN || process.env.USAGE_TOKEN || null;
  const ttlMs = options.ttlMs ?? 2000;
  const usageOptions = options.usageOptions || {};
  const allowOrigin = options.allowOrigin || process.env.TEAMCLAUDE_USAGE_ALLOW_ORIGIN || null;

  let cache = null;
  let inFlight = null;

  async function getOrBuildDocument() {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      return cache.document;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const doc = await buildUsageDocument(usageOptions);
        cache = { document: doc, expiresAt: Date.now() + ttlMs };
        return doc;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const server = createServer(async (req, res) => {
    // Non-loopback authentication gate (fails closed)
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!isLoopback) {
      if (!token) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'Unauthorized: bearer token required for non-loopback bind' }));
        return;
      }
      const authHeader = req.headers['authorization'] || '';
      const apiKeyHeader = req.headers['x-api-key'] || '';
      const matchBearer = authHeader.startsWith('Bearer ') && safeCompare(authHeader.slice(7), token);
      const matchKey = apiKeyHeader && safeCompare(apiKeyHeader, token);
      if (!matchBearer && !matchKey) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid bearer token' }));
        return;
      }
    }

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Bad Request' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: BUILD_VERSION,
      }, null, 2));
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/usage' || url.pathname === '/')) {
      try {
        const doc = await getOrBuildDocument();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
        });
        res.end(JSON.stringify(doc, null, 2));
      } catch (err) {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'Failed to build usage document', details: err?.message }));
      }
      return;
    }

    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return {
    server,
    port,
    host,
    listen: () => new Promise((resolve, reject) => {
      server.listen(port, host, () => {
        const addr = server.address();
        resolve({ port: typeof addr === 'object' && addr ? addr.port : port, host });
      });
      server.on('error', reject);
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
