import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatus } from '../src/status-renderer.js';

const now = Date.parse('2026-07-03T12:00:00Z');

function sampleStatus() {
  return {
    currentAccount: 'a',
    switchThreshold: 0.98,
    probe: {
      enabled: true,
      intervalSeconds: 300,
      lastRunFinishedAt: '2026-07-03T11:58:00Z',
      nextRunAt: '2026-07-03T12:03:00Z',
      accounts: [{ name: 'a', status: 'ok', lastProbedAt: '2026-07-03T11:58:00Z', durationMs: 42 }],
    },
    accounts: [{
      name: 'a',
      type: 'oauth',
      priority: 0,
      status: 'active',
      quota: { unified5h: 0.95, unified5hReset: now + 60_000 },
      usage: { totalInputTokens: 1000, totalOutputTokens: 500, totalRequests: 2, lastUsed: '2026-07-03T11:59:00Z' },
    }],
  };
}

test('renderStatus prints core status', () => {
  const output = renderStatus(sampleStatus(), { color: false, now });

  assert.match(output, /Active\s+a/);
  assert.match(output, /Session\s+\[█████████████████░\] 95% reset 1m/);
  assert.match(output, /Probe\s+ok 2m ago/);
  assert.match(output, /2 req, 1.5k tok/);
});

test('renderStatus colors active accounts and bars', () => {
  const output = renderStatus(sampleStatus(), { color: true, now });

  assert.match(output, /\x1b\[32mactive/);
  const cells = [...output.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m█/g)]
    .map(match => match.slice(1).map(Number));
  assert.ok(cells.length > 2);
  assert.ok(cells[0][1] > cells[0][0], 'bar should start green');
  assert.ok(cells.at(-1)[0] > cells.at(-1)[1], 'bar should end red');
});

test('renderStatus shows per-model eligibility when a family is metered separately', () => {
  const status = sampleStatus();
  // Shared 5h has headroom, general/Opus weekly is fine, but the Fable weekly is
  // spent: Fable should read ✗ (with its reset) while Opus stays ✓ — the
  // "some accounts are disabled for specific models" view of issue #85.
  status.accounts[0].quota = {
    unified5h: 0.2, unified5hReset: now + 60_000,
    unified7d: 0.3, unified7dReset: now + 600_000,
    unified7dFable: 1.0, unified7dFableReset: now + 86_400_000,
  };
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /Models\s+Opus ✓/);
  assert.match(output, /Fable ✗ 1d/);
});

test('renderStatus omits the Models line for accounts with no family-specific bucket', () => {
  const output = renderStatus(sampleStatus(), { color: false, now });
  assert.doesNotMatch(output, /Models/);
});

test('renderStatus prints the routing table with configured and auto routes', () => {
  const status = sampleStatus();
  status.routes = [
    { name: 'fable', match: ['*fable*'], autocreated: false, bucket: null,
      accounts: [{ name: 'personal', eligible: true }, { name: 'a', eligible: false }] },
    { name: 'sonnet', match: ['*sonnet*'], autocreated: true, bucket: null,
      accounts: [{ name: 'a', eligible: true }] },
  ];
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /Routing/);
  assert.match(output, /\*fable\*\s+→ personal a/);
  assert.match(output, /\*sonnet\*\s+→ a \(auto\)/);
});

test('renderStatus shows a route color and pinned account', () => {
  const status = sampleStatus();
  status.routes = [
    { name: 'fable', match: ['*fable*'], autocreated: false, bucket: null, color: 'magenta', pinned: 'personal',
      accounts: [{ name: 'personal', eligible: true }, { name: 'a', eligible: true }] },
  ];
  // Plain text: the pin annotation is visible.
  const plain = renderStatus(status, { color: false, now });
  assert.match(plain, /\*fable\*\s+→ personal a \[pinned: personal\]/);
  // Colored: the magenta SGR code (35) wraps the route label.
  const colored = renderStatus(status, { color: true, now });
  assert.match(colored, /\x1b\[35m\*fable\*/);
});

test('renderStatus omits the routing table when there are no routes', () => {
  const output = renderStatus(sampleStatus(), { color: false, now });
  assert.doesNotMatch(output, /Routing/);
});

test('renderStatus sanitizes probe errors', () => {
  const status = sampleStatus();
  status.probe.accounts[0] = {
    name: 'a',
    status: 'error',
    lastProbedAt: '2026-07-03T11:58:00Z',
    error: 'bad\n\x1b[31mred',
  };

  const output = renderStatus(status, { color: false, now });
  assert.match(output, /bad red/);
  assert.doesNotMatch(output, /\x1b\[31m/);
});
