// Synthetic /teamclaude/status payloads. Shapes follow the backend's
// src/server.js status handler; no value here comes from a real account.

export function rawAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'alice@example.com',
    type: 'oauth',
    provider: 'anthropic',
    priority: 0,
    disabled: false,
    status: 'active',
    unavailable: null,
    sessions: 1,
    knownSessions: 2,
    quota: {
      unified5h: 0.42,
      unified5hReset: 1_800_000_000_000,
      unified5hSeenAt: 1_799_990_000_000,
      unified7d: 0.1,
      unified7dReset: 1_800_500_000_000,
    },
    usage: { totalRequests: 12 },
    ...overrides,
  };
}

export function rawStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: { version: '1.1.25', pid: 4242, port: 3456, uptimeSeconds: 60 },
    accounts: [rawAccount()],
    currentAccounts: { anthropic: 'alice@example.com' },
    switchThreshold: 0.95,
    sessions: { active: 1, known: 2, mode: 'even', draining: 0, starvedMax: 0 },
    routes: [],
    probe: { enabled: false, intervalSeconds: 0 },
    warm: { enabled: false, intervalSeconds: 0 },
    blockedModels: [],
    ...overrides,
  };
}
