const ESC = '\x1b[';
const RESET = `${ESC}0m`;

export function renderStatus(status, { color = process.stdout.isTTY, now = Date.now() } = {}) {
  const paint = colors(color);
  const lines = [];
  const probe = status.probe || { enabled: false, intervalSeconds: 0, accounts: [] };
  const warm = status.warm || { enabled: false, intervalSeconds: 0, accounts: [] };
  const accounts = status.accounts || [];

  lines.push(paint.bold('TeamClaude status'));
  lines.push(`${paint.dim('Active'.padEnd(12))} ${paint.cyan(status.currentAccount || 'none')}`);
  lines.push(`${paint.dim('Switch at'.padEnd(12))} ${formatPercent(status.switchThreshold)}`);
  lines.push(`${paint.dim('Probe'.padEnd(12))} ${formatProbeSummary(probe, now, paint)}`);
  if (warm.enabled) {
    lines.push(`${paint.dim('Keep-warm'.padEnd(12))} ${formatProbeSummary(warm, now, paint)}`);
  }
  if (status.server?.startedAt || status.server?.uptimeSeconds != null) {
    lines.push(`${paint.dim('Server'.padEnd(12))} ${formatServerSummary(status.server, now)}`);
  }
  lines.push('');

  for (const account of accounts) {
    lines.push(renderAccountHeader(account, status.currentAccount, paint, now));
    for (const quotaLine of quotaLines(account, now, paint)) {
      lines.push(`  ${quotaLine}`);
    }
    lines.push(`  ${paint.dim('Usage'.padEnd(8))} ${formatUsage(account.usage, now)}`);
    lines.push(`  ${paint.dim('Probe'.padEnd(8))} ${formatAccountProbe(account.name, probe, now, paint)}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function colors(enabled) {
  const wrap = code => value => enabled ? `${ESC}${code}m${value}${RESET}` : String(value);
  return {
    rgb: (r, g, b, value) => enabled ? `${ESC}38;2;${r};${g};${b}m${value}${RESET}` : String(value),
    bold: wrap(1),
    dim: wrap(2),
    gray: wrap(90),
    green: wrap(32),
    yellow: wrap(33),
    red: wrap(31),
    cyan: wrap(36),
  };
}

function renderAccountHeader(account, currentAccount, paint, now) {
  const current = account.name === currentAccount;
  const marker = current ? paint.cyan('>') : ' ';
  const name = current ? paint.bold(account.name) : account.name;
  const status = formatAccountStatus(account, now, paint);
  const org = account.orgName ? ` ${paint.dim(account.orgName)}` : '';
  return `${marker} ${name} ${paint.dim(`(${account.type}, prio ${account.priority || 0})`)} ${status}${org}`;
}

function formatAccountStatus(account, now, paint) {
  const parts = [];
  if (account.disabled) parts.push(paint.gray('disabled'));

  const status = account.status || 'unknown';
  const colored = status === 'active'
    ? paint.green(status)
    : status === 'throttled'
      ? paint.yellow(status)
      : status === 'error' || status === 'exhausted'
        ? paint.red(status)
        : status;
  parts.push(colored);

  const throttleAt = parseTs(account.rateLimitedUntil);
  if (throttleAt && throttleAt > now) {
    parts.push(`throttle ${formatDuration(throttleAt - now)}`);
  }

  return parts.join(' / ');
}

function quotaLines(account, now, paint) {
  const quota = account.quota || {};
  const lines = [];

  if (quota.unified5h != null || quota.unified7d != null || quota.unified7dSonnet != null) {
    lines.push(formatQuotaLine('Session', quota.unified5h, quota.unified5hReset, now, paint));
    lines.push(formatQuotaLine('Weekly', quota.unified7d, quota.unified7dReset, now, paint));
    if (quota.unified7dSonnet != null) {
      lines.push(formatQuotaLine('Sonnet', quota.unified7dSonnet, quota.unified7dSonnetReset, now, paint));
    }
    return lines;
  }

  if (quota.tokensLimit != null && quota.tokensRemaining != null) {
    const ratio = 1 - quota.tokensRemaining / quota.tokensLimit;
    lines.push(formatQuotaLine('Tokens', ratio, quota.resetsAt, now, paint));
  }
  if (quota.requestsLimit != null && quota.requestsRemaining != null) {
    const ratio = 1 - quota.requestsRemaining / quota.requestsLimit;
    lines.push(formatQuotaLine('Requests', ratio, quota.resetsAt, now, paint));
  }
  if (lines.length === 0) lines.push(`${paint.dim('Quota'.padEnd(8))} ${paint.gray('unknown')}`);
  return lines;
}

function formatQuotaLine(label, ratio, resetAt, now, paint) {
  const resetTs = parseTs(resetAt);
  const reset = resetTs && resetTs > now ? ` reset ${formatDuration(resetTs - now)}` : '';
  return `${paint.dim(label.padEnd(8))} ${usageBar(ratio, paint)} ${formatPercent(ratio)}${reset}`;
}

function usageBar(ratio, paint) {
  if (ratio == null || Number.isNaN(Number(ratio))) return `[${paint.gray('??????????????????')}]`;
  const width = 18;
  const safeRatio = Math.max(0, Math.min(1, Number(ratio)));
  const full = Math.round(safeRatio * width);
  const fill = Array.from({ length: full }, (_, i) => {
    const [r, g, b] = gradientColor(i, width);
    return paint.rgb(r, g, b, '█');
  }).join('');
  return `[${fill}${paint.gray('░'.repeat(width - full))}]`;
}

function gradientColor(index, width) {
  const t = width <= 1 ? 1 : index / (width - 1);
  const from = t < 0.5 ? [35, 209, 96] : [245, 185, 40];
  const to = t < 0.5 ? [245, 185, 40] : [239, 68, 68];
  const p = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  return from.map((value, i) => Math.round(value + (to[i] - value) * p));
}

function formatProbeSummary(probe, now, paint) {
  if (!probe.enabled) return paint.gray('off (passive only)');
  const bits = [`on every ${formatDuration((probe.intervalSeconds || 0) * 1000)}`];
  if (probe.running) bits.push(paint.yellow('running'));
  const last = parseTs(probe.lastRunFinishedAt);
  if (last) bits.push(`last ${formatAgo(last, now)}`);
  const next = parseTs(probe.nextRunAt);
  if (next && next > now) bits.push(`next ${formatDuration(next - now)}`);
  return bits.join(', ');
}

function formatAccountProbe(accountName, probe, now, paint) {
  const row = (probe.accounts || []).find(account => account.name === accountName);
  if (!probe.enabled) return paint.gray('off');
  if (!row) return paint.gray('never');
  if (row.status === 'not-applicable') return paint.gray('not applicable');
  const status = row.status === 'ok'
    ? paint.green('ok')
    : row.status === 'running'
      ? paint.yellow('running')
      : row.status === 'never'
        ? paint.gray('never')
        : paint.red(row.status || 'error');
  const last = parseTs(row.lastProbedAt || row.startedAt);
  const when = last ? ` ${formatAgo(last, now)}` : '';
  const duration = typeof row.durationMs === 'number' ? `, ${Math.round(row.durationMs)}ms` : '';
  const error = row.error ? `, ${safeLine(row.error)}` : '';
  return `${status}${when}${duration}${error}`;
}

function safeLine(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]|\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function formatUsage(usage = {}, now) {
  const requests = usage.totalRequests || 0;
  const tokens = (usage.totalInputTokens || 0) + (usage.totalOutputTokens || 0);
  const last = parseTs(usage.lastUsed);
  const lastText = last ? `, last ${formatAgo(last, now)}` : '';
  return `${requests} req, ${formatNumber(tokens)} tok${lastText}`;
}

function formatServerSummary(server, now) {
  if (server.uptimeSeconds != null) return `up ${formatDuration(server.uptimeSeconds * 1000)}`;
  const started = parseTs(server.startedAt);
  return started ? `up ${formatDuration(now - started)}` : 'unknown';
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return `${Math.round(Number(value) * 100)}%`;
}

function formatNumber(value) {
  const num = Number(value) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}m`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function formatAgo(timestamp, now) {
  const delta = now - timestamp;
  if (delta < 0) return `in ${formatDuration(-delta)}`;
  return `${formatDuration(delta)} ago`;
}

function formatDuration(ms) {
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

function parseTs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
