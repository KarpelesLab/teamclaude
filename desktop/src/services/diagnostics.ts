// A diagnostic report a user can attach to an issue. Built only from data the
// app already holds in sanitized form (normalized status, sanitized log lines)
// and passed through the redactor once more as a whole. It never includes the
// config file, request bodies or account credentials, and it names no
// account: log lines that do are rewritten to the report's account numbers.

import type { BackendState, LogLine, SystemInfo } from '../shared/types';
import { sanitizeText } from './sanitize';

function pct(value: number | null): string {
  return value === null ? 'unknown' : `${Math.round(value * 100)}%`;
}

/** A window the plan does not meter is not an unknown reading. */
function windowText(utilization: number | null, stated: boolean | null): string {
  return utilization === null && stated === false ? 'not metered' : pct(utilization);
}

const EMAIL =/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Account names can be email addresses, and the backend's own log lines name
 * the account they are about. Known names become the report's `#N`; any other
 * email address becomes `[email]`.
 */
export function anonymizeAccounts(text: string, names: string[]): string {
  let out = text;
  const numbered = names.map((name, i) => ({ name, label: `#${i + 1}` })).filter(n => n.name);
  // Longest first, so one name that contains another is replaced whole.
  for (const { name, label } of numbered.toSorted((a, b) => b.name.length - a.name.length)) {
    out = out.replace(new RegExp(`(?<![\\w.@-])${escapeRegExp(name)}(?![\\w.@-])`, 'g'), label);
  }
  return out.replace(EMAIL, '[email]');
}

export function buildDiagnosticReport(system: SystemInfo, state: BackendState, logs: LogLine[], now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push('# TeamClaude Desktop diagnostic report', '');
  lines.push(`Generated: ${now.toISOString()}`, '');
  lines.push('## System');
  lines.push(`- OS: ${system.os} (${system.arch})`);
  lines.push(`- Desktop: ${system.desktopVersion} (Electron ${system.electronVersion}, Node ${system.nodeVersion})`);
  lines.push(`- Bundled backend: ${system.bundledBackendVersion ?? 'not found'}`);
  lines.push(`- Running backend: ${system.backendVersion ?? 'not running'}`, '');
  lines.push('## Proxy');
  lines.push(`- Phase: ${state.phase}`);
  lines.push(`- Ownership: ${state.ownership}`);
  lines.push(`- Endpoint: ${state.endpoint}`);
  lines.push(`- Config file present: ${state.configExists ? 'yes' : 'no'}`);
  lines.push(`- systemd --user unit installed: ${state.serviceInstalled ? 'yes' : 'no'}`);
  lines.push(`- Automatic restarts: ${state.restartCount}`);
  if (state.compatibility.message) lines.push(`- Compatibility: ${state.compatibility.message}`);
  if (state.lastError) lines.push(`- Last error: ${state.lastError.split('\n')[0]}`);
  lines.push('');
  const status = state.status;
  if (status) {
    lines.push('## Accounts');
    // Account names can be email addresses; the report numbers them instead.
    status.accounts.forEach((a, i) => {
      lines.push(`- #${i + 1} ${a.provider}/${a.type}: status=${a.status}, unavailable=${a.unavailable ?? 'no'}, disabled=${a.disabled}, 5h=${windowText(a.fiveHour.utilization, a.sessionWindowStated)}, weekly=${windowText(a.weekly.utilization, a.weeklyWindowStated)}, recent=${a.recentRequests ?? 'unknown'}${a.error ? `, error=${a.error.code}` : ''}`);
    });
    lines.push('');
    lines.push(`Sessions: ${status.sessions.active} active / ${status.sessions.known} known; distribution: ${status.sessions.distribution ?? 'unknown'}`);
    lines.push(`Switch threshold: ${pct(status.switchThreshold)}; probe: ${status.probe.enabled ? `${status.probe.intervalSeconds}s` : 'off'}; warm-up: ${status.warm.enabled ? `${status.warm.intervalSeconds}s` : 'off'}`);
    lines.push('');
  }
  lines.push('## Recent log (last 200 lines)', '```');
  for (const line of logs.slice(-200)) lines.push(`${new Date(line.at).toISOString()} [${line.stream}] ${line.text}`);
  lines.push('```', '');
  return anonymizeAccounts(sanitizeText(lines.join('\n')), status?.accounts.map(a => a.name) ?? []);
}
