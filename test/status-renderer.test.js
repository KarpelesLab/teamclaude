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
