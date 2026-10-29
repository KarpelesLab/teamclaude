// Token counts per account, as the server has counted them since it started.
// Pure, so the Usage page and the CSV export read the same numbers.

import type { AccountView } from './types';

export interface UsageRow {
  provider: string;
  account: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Everything the account processed: input (uncached + cached) and output. */
  total: number;
}

export function usageRows(accounts: AccountView[]): UsageRow[] {
  return accounts.map(a => {
    const u = a.usage;
    const input = u?.inputTokens ?? 0;
    const output = u?.outputTokens ?? 0;
    const cacheRead = u?.cacheReadTokens ?? 0;
    const cacheWrite = u?.cacheCreationTokens ?? 0;
    return {
      provider: a.provider,
      account: a.name,
      requests: a.totalRequests ?? 0,
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    };
  });
}

export function usageTotals(rows: UsageRow[]): Omit<UsageRow, 'provider' | 'account'> {
  const sum = (pick: (r: UsageRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
  return {
    requests: sum(r => r.requests),
    input: sum(r => r.input),
    output: sum(r => r.output),
    cacheRead: sum(r => r.cacheRead),
    cacheWrite: sum(r => r.cacheWrite),
    total: sum(r => r.total),
  };
}

/** Share of all input tokens served from the prompt cache, 0–1, or null with no input. */
export function cacheHitRate(row: Pick<UsageRow, 'input' | 'cacheRead' | 'cacheWrite'>): number | null {
  const all = row.input + row.cacheRead + row.cacheWrite;
  return all ? row.cacheRead / all : null;
}

function csvCell(value: string | number): string {
  const text = String(value);
  // Formula-looking cells are prefixed so a spreadsheet never evaluates them.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function usageCsv(rows: UsageRow[]): string {
  const header = ['provider', 'account', 'requests', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_tokens'];
  const lines = rows.map(r => [r.provider, r.account, r.requests, r.input, r.output, r.cacheRead, r.cacheWrite, r.total].map(csvCell).join(','));
  return `${[header.join(','), ...lines].join('\r\n')}\r\n`;
}

/** Where the "next account" shortcut moves: the next account after the current one that can serve, in status order. */
export function nextAccount(accounts: AccountView[], provider: string, current: string | null): AccountView | null {
  const pool = accounts.filter(a => a.provider === provider);
  const start = pool.findIndex(a => a.name === current);
  for (let step = 1; step <= pool.length; step++) {
    const candidate = pool[(start + step + pool.length) % pool.length] as AccountView;
    if (candidate.name !== current && !candidate.disabled && !candidate.unavailable) return candidate;
  }
  return null;
}
