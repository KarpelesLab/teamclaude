import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditText } from '../src/status-renderer.js';
import { renderDashboardHtml, inlineScripts } from '../src/dashboard.js';

// The words `teamclaude status` and the dashboard card print for a credit
// view. One closure-free function serves both, so the page's copy is run here
// in the page's own scope, not only the module's.

const NOW = Date.parse('2026-11-06T12:00:00Z');
const base = {
  currency: 'USD', exponent: 2, amountMinor: 20000, spentMinor: 4567, remainingMinor: 15433, exceededMinor: 0, usedFraction: 0.22835,
  cycleStart: '2026-11-02T00:00:00.000Z', cycleEnd: '2026-12-02T00:00:00.000Z',
  trackedSince: null, lastReplyAt: null, replies: null, nextRefreshAt: null, incomplete: null, error: null,
};
const views = {
  admin: { ...base, source: 'admin', estimate: false, upperBound: false, asOf: '2026-11-06T11:56:00.000Z' },
  local: { ...base, source: 'local', estimate: true, upperBound: true, asOf: '2026-11-06T12:00:00.000Z', trackedSince: '2026-11-03T08:00:00.000Z', replies: 12,
    incomplete: { replies: 2, models: [{ model: 'claude-nonexistent-9', replies: 2, reason: 'no price for this model' }] } },
  exceeded: { ...base, source: 'admin', estimate: false, upperBound: false, asOf: '2026-11-06T11:00:00.000Z', spentMinor: 21230, remainingMinor: 0, exceededMinor: 1230, usedFraction: 1.0615 },
  unread: { ...base, source: 'admin', estimate: false, upperBound: false, asOf: null, spentMinor: null, remainingMinor: null, exceededMinor: null, usedFraction: null,
    error: { kind: 'credential', status: 401, message: 'Admin API key rejected (HTTP 401)', at: '2026-11-06T11:58:00.000Z' } },
};

test('creditText says how much is left, of what, when it renews, and from which source', () => {
  assert.equal(creditText(views.admin, NOW),
    '$154.33 of $200.00 left ($45.67 spent) · renews in 25d (2026-12-02) · Admin API cost report, read 4m ago');
  assert.equal(creditText(views.local, NOW),
    'at most $154.33 of $200.00 left ($45.67 spent) · renews in 25d (2026-12-02) · estimate: replies through this proxy only, since 2026-11-03'
    + ' · incomplete: 2 unpriced replies (claude-nonexistent-9)');
  assert.equal(creditText(views.exceeded, NOW),
    '$0.00 of $200.00 left, exceeded by $12.30 · renews in 25d (2026-12-02) · Admin API cost report, read 1h ago');
  assert.equal(creditText(views.unread, NOW),
    '$200.00 credit, spend not read yet · renews in 25d (2026-12-02) · Admin API cost report · cost report failed: Admin API key rejected (HTTP 401) (2m ago)');
  assert.equal(creditText(null, NOW), null);
});

test('the dashboard runs the same creditText in the page\'s own scope', () => {
  const script = inlineScripts(renderDashboardHtml()).at(-1);
  const bundle = script.slice(script.indexOf('var STARVED_MIN'), script.indexOf('function el('));
  const isolated = new Function(`${bundle}; return creditText;`)();
  for (const [name, view] of Object.entries(views)) {
    assert.equal(isolated(view, NOW), creditText(view, NOW), name);
  }
  // And the card draws it: the builder reads `a.credit` and calls it by name.
  assert.match(script, /if \(a\.credit\) \{[\s\S]*?quotaRow\('Credit'[\s\S]*?creditText\(a\.credit/);
});
