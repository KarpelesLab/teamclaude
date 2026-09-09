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

test('renderStatus shows an OAuth entitlement cooldown separately from account status', () => {
  const status = sampleStatus();
  status.accounts[0].entitlementDeniedUntil = new Date(now + 4 * 60_000).toISOString();
  const output = renderStatus(status, { color: false, now });

  assert.match(output, /active \/ entitlement cooldown 4m/);
});

test('renderStatus describes a timezone-aware reset warm-up schedule', () => {
  const status = sampleStatus();
  status.warm = {
    enabled: true,
    mode: 'reset',
    timezone: 'Europe/Moscow',
    resetTime: '15:30',
    warmupTime: '10:30',
    nextWarmupAt: '2026-07-04T07:30:00Z',
    accounts: [],
  };

  const output = renderStatus(status, { color: false, now });

  assert.match(output, /Keep-warm\s+daily 10:30 Europe\/Moscow → reset 15:30, next/);
  assert.doesNotMatch(output, /on every 0s/);
});

test('renderStatus describes a rolling five-hour warm-up schedule', () => {
  const status = sampleStatus();
  status.warm = {
    enabled: true,
    mode: 'rolling',
    timezone: 'Europe/Moscow',
    resetTime: '15:30',
    anchorResetAt: '2026-07-03T12:30:00Z',
    cadenceSeconds: 18_000,
    nextWarmupAt: '2026-07-03T12:30:00Z',
    nextTargetResetAt: '2026-07-03T17:30:00Z',
    accounts: [],
  };

  const output = renderStatus(status, { color: false, now });

  assert.match(output, /Keep-warm\s+rolling every 5h, reset anchor 15:30 Europe\/Moscow, next/);
  assert.doesNotMatch(output, /on every 0s/);
});

test('renderStatus shows the sessions line and per-account session count when present', () => {
  const status = sampleStatus();
  status.sessions = { known: 3, active: 2, perAccount: { 0: 2 }, distribute: true };
  status.accounts[0].sessions = 2;
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /Sessions\s+2 active \/ 3 known · distributing/);
  assert.match(output, /a \(oauth, prio 0\).*2 sess/);
});

test('renderStatus reports a draining distribution toggle instead of single-account', () => {
  const status = sampleStatus();
  status.sessions = { known: 3, active: 2, perAccount: { 0: 2 }, distribute: false, draining: 2 };
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /Sessions\s+2 active \/ 3 known · draining 2/);
});

test('renderStatus says single-account once the drain has finished', () => {
  const status = sampleStatus();
  status.sessions = { known: 3, active: 2, perAccount: { 0: 2 }, distribute: false, draining: 0 };
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /Sessions\s+2 active \/ 3 known · single-account/);
});

test('renderStatus omits the sessions line when the status has no sessions field', () => {
  const output = renderStatus(sampleStatus(), { color: false, now });
  assert.doesNotMatch(output, /Sessions\s/);
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

test('renderStatus prints configured usage dimensions and sanitizes their labels', () => {
  const status = sampleStatus();
  status.usageDimensions = {
    project: {
      'KarpelesLab/teamclaude': { requests: 2, inputTokens: 1000, outputTokens: 250, lastUsed: '2026-07-03T11:59:00Z' },
    },
    'bad\x1b[31mname': {
      'value\nred': { requests: 1, inputTokens: 1, outputTokens: 1 },
    },
  };

  const output = renderStatus(status, { color: false, now });
  assert.match(output, /Project usage/);
  assert.match(output, /KarpelesLab\/teamclaude\s+2 req, 1.0k in \/ 250 out, last 1m ago/);
  assert.match(output, /Bad name usage/);
  assert.match(output, /value red/);
  assert.doesNotMatch(output, /\x1b\[31m/);
});

test('renderStatus shows a client\'s WebSocket connections apart from its requests', () => {
  const status = sampleStatus();
  status.clients = {
    alice: { requests: 2, connections: 1, inputTokens: 1000, outputTokens: 250, lastUsed: '2026-07-03T11:59:00Z' },
    bob: { requests: 1, connections: 0, inputTokens: 10, outputTokens: 5 },
  };
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /alice\s+2 req, 1 ws, 1.0k in \/ 250 out, last 1m ago/);
  assert.match(output, /bob\s+1 req, 10 in \/ 5 out/, 'no channel, no column');
});

test('renderStatus never grows a per-session section', () => {
  // Sessions are unbounded caller-supplied ids: a terminal renderer that
  // printed one line each would bury the whole status readout. The per-session
  // view is the dashboard's (behind proxy.sessionDetail), not the CLI's.
  const status = sampleStatus();
  status.sessions = {
    known: 3, active: 2, perAccount: {},
    items: Array.from({ length: 300 }, (_, i) => ({
      id: `session-${i}`, client: 'alice', dimensions: { project: 'p' },
      requests: 1, lastSeen: 0, firstSeen: 0, active: true, inFlight: 0, pins: {}, tokens: {},
    })),
  };
  const output = renderStatus(status, { color: false, now });
  assert.doesNotMatch(output, /Session usage|Sessions usage/);
  assert.doesNotMatch(output, /session-0/);
});

// --- blocklist visibility (issue: a blocked model read as available) ---------
// `Models` reports quota headroom, so a fully-blocked family used to render ✓
// while every request for it got a 400. Quota and the blocklist are separate
// gates; status has to surface both.

function blockedStatus(blockedModels) {
  const status = sampleStatus();
  status.blockedModels = blockedModels;
  status.accounts[0].quota = {
    unified5h: 0.02,
    unified5hReset: now + 3600_000,
    unified7d: 0.49,
    unified7dReset: now + 86_400_000,
    unified7dFable: 0.11,
    unified7dFableReset: now + 86_400_000,
  };
  return status;
}

test('renderStatus shows a Blocked row listing the configured patterns', () => {
  const output = renderStatus(blockedStatus(['*fable*']), { color: false, now });
  assert.match(output, /Blocked\s+\*fable\*/);
});

test('renderStatus omits the Blocked row when nothing is blocked', () => {
  assert.doesNotMatch(renderStatus(blockedStatus([]), { color: false, now }), /Blocked/);
  assert.doesNotMatch(renderStatus(sampleStatus(), { color: false, now }), /Blocked/);
});

test('renderStatus marks a blocked family blocked, not available, despite free quota', () => {
  const output = renderStatus(blockedStatus(['*fable*']), { color: false, now });
  // Fable has 89% headroom and the session bucket is nearly empty, so the
  // quota-only path would have rendered "Fable ✓".
  assert.match(output, /Fable ⊘ blocked/);
  assert.doesNotMatch(output, /Fable ✓/);
  assert.match(output, /Opus ✓/); // unrelated families keep reporting quota
});

test('renderStatus marks a family blocked by a concrete model id, not just a glob', () => {
  const output = renderStatus(blockedStatus(['claude-fable-5']), { color: false, now });
  assert.match(output, /Fable ⊘ blocked/);
});

test('renderStatus leaves families untouched by an unrelated block', () => {
  const output = renderStatus(blockedStatus(['*sonnet*']), { color: false, now });
  assert.match(output, /Fable ✓/);
  assert.match(output, /Opus ✓/);
});

test('renderStatus reports a fully-blocked route as blocked instead of listing accounts', () => {
  const status = blockedStatus(['*fable*']);
  status.routes = [{
    name: 'fable',
    match: ['*fable*'],
    autocreated: true,
    accounts: [{ name: 'a', eligible: true }],
  }];
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /\*fable\*\s+→ blocked \(auto\)/);
});

test('renderStatus still lists accounts for a route the blocklist does not cover', () => {
  const status = blockedStatus(['*fable*']);
  status.routes = [{
    name: 'sonnet',
    match: ['*sonnet*'],
    autocreated: true,
    accounts: [{ name: 'a', eligible: true }],
  }];
  const output = renderStatus(status, { color: false, now });
  assert.match(output, /\*sonnet\*\s+→ a \(auto\)/);
});

// ── per-account usage caps (accounts[].maxUsage) ──────────────

function cappedStatus(quota, maxUsage) {
  return {
    currentAccount: 'a',
    switchThreshold: 0.98,
    accounts: [{
      name: 'a', type: 'oauth', priority: 0, status: 'active',
      quota, maxUsage, usage: {},
    }],
  };
}

test('renderStatus marks the cap on the bar and names it', () => {
  const out = renderStatus(cappedStatus({ unified5h: 0.1, unified7d: 0.1 },
    { unified5h: 0.6, unified7d: 0.6 }), { color: false, now });
  // The mark sits where the bar may not pass, and the number says which percent
  // it is — one cell is ~6%, so the mark alone cannot tell 60% from 61%.
  assert.match(out, /Session\s+\[██░░░░░░░░░┃░░░░░░\] 10% cap 60%/);
});

test('a capped bar is the same width as an uncapped one', () => {
  const capped = renderStatus(cappedStatus({ unified7d: 0.1 }, { unified7d: 0.6 }), { color: false, now });
  const plain = renderStatus(cappedStatus({ unified7d: 0.1 }, null), { color: false, now });
  const width = out => out.match(/Weekly\s+\[([^\]]*)\]/)[1].length;
  assert.equal(width(capped), width(plain));   // rows still line up
  assert.doesNotMatch(plain, /cap /);          // and nothing is drawn without a cap
});

test('an uncapped bucket on a capped account is left alone', () => {
  const out = renderStatus(cappedStatus({ unified5h: 0.1, unified7d: 0.1 },
    { unified7d: 0.6 }), { color: false, now });
  assert.match(out, /Session\s+\[██░░░░░░░░░░░░░░░░\] 10%$/m);
  assert.match(out, /Weekly\s+.*cap 60%/);
});

test('a family over its cap reads ✗ while the others keep serving', () => {
  const out = renderStatus(cappedStatus(
    { unified5h: 0.1, unified7d: 0.1, unified7dFable: 0.85 },
    { unified7d: 0.6, unified7dFable: 0.8 }), { color: false, now });
  assert.match(out, /Models\s+Opus ✓\s+Fable ✗/);
});

// The shared weekly bucket meters family spend too, so a cap on it stops every
// family — the Models line must not advertise one as available.
test('a shared weekly cap marks every family unavailable', () => {
  const out = renderStatus(cappedStatus(
    { unified5h: 0.1, unified7d: 0.62, unified7dFable: 0.1 },
    { unified7d: 0.6, unified7dFable: 0.8 }), { color: false, now });
  assert.match(out, /Models\s+Opus ✗\s+Fable ✗/);
});

test('the blocked line names the cap as the reason', () => {
  const status = cappedStatus({ unified7d: 0.7 }, { unified7d: 0.6 });
  status.accounts[0].unavailable = 'capped';
  assert.match(renderStatus(status, { color: false, now }), /Blocked\s+account usage cap reached \(maxUsage\)/);
});

// ── The Active/Serving row under session distribution ───────────────────────
//
// `currentAccount` is the rotation cursor. Under ADAPTIVE distribution the
// picker never moves it, so it names where a SESSION-LESS request would go —
// not what is serving. Reporting it as "Active" pointed at one account while
// several were running. Even distribution still walks from the cursor, so it
// keeps the plain Active row.

function distributedStatus(mode) {
  return {
    currentAccount: 'a',
    switchThreshold: 0.98,
    sessions: { active: 12, known: 12, distribute: mode !== 'off', mode },
    accounts: [
      { name: 'a', type: 'oauth', priority: 0, status: 'active', sessions: 3, quota: {}, usage: {} },
      { name: 'b', type: 'oauth', priority: 0, status: 'active', sessions: 9, quota: {}, usage: {} },
      { name: 'c', type: 'oauth', priority: 0, status: 'active', sessions: 0, quota: {}, usage: {} },
    ],
  };
}

test('distribution off: the cursor is the active account, as before', () => {
  const s = distributedStatus('off');
  const out = renderStatus(s, { color: false, now });
  assert.match(out, /^Active {7}a$/m);
  assert.doesNotMatch(out, /^Serving/m);
  // Only the cursor is marked.
  assert.match(out, /^> a \(oauth/m);
  assert.match(out, /^ {2}b \(oauth/m);
});

test('distributing: the row names every account actually serving, plus the cursor', () => {
  const out = renderStatus(distributedStatus('adaptive'), { color: false, now });
  assert.doesNotMatch(out, /^Active/m);
  // Busiest first, each with its session count, and the cursor named as such.
  assert.match(out, /^Serving {6}b 9 · a 3 {2}cursor a$/m);
});

test('distributing: the marker follows the sessions, not the cursor', () => {
  const out = renderStatus(distributedStatus('adaptive'), { color: false, now });
  assert.match(out, /^> a \(oauth/m, 'a carries sessions');
  assert.match(out, /^> b \(oauth/m, 'b carries sessions and is NOT the cursor');
  assert.match(out, /^ {2}c \(oauth/m, 'c carries none');
});

test('distributing but idle: says so rather than implying the cursor is serving', () => {
  const s = distributedStatus('adaptive');
  for (const a of s.accounts) a.sessions = 0;
  const out = renderStatus(s, { color: false, now });
  assert.match(out, /^Serving {6}idle cursor a$/m);
});

test('even mode keeps the Active row and the cursor marker', () => {
  const out = renderStatus(distributedStatus('even'), { color: false, now });
  assert.match(out, /^Active {7}a$/m);
  assert.doesNotMatch(out, /^Serving/m);
  assert.match(out, /^> a \(oauth/m, 'the cursor is marked');
  assert.match(out, /^ {2}b \(oauth/m, 'b carries sessions but is not the cursor');
});

test('adaptive diagnostics name the next target, score weight, and family split', () => {
  const s = distributedStatus('adaptive');
  s.accounts[0].sessionsByBucket = { unified7d: 2, unified7dFable: 1 };
  s.adaptive = [{
    name: 'a', bucket: 'unified7d', window: 'unified7d', competing: true,
    next: true, weight: 0.6, sessions: 3, inFlight: 1,
    headroom: 0.28, threshold: 0.98, planWeight: 20, concCap: 6,
  }];
  const out = renderStatus(s, { color: false, now });
  assert.match(out, /^> a .*3 sess \(opus\+ 2, fable 1\)$/m);
  assert.match(out, /Adaptive\s+next · weight 60% of opus\+/);
  assert.match(out, /plan 20x/);
});

// The adaptive rows come off the wire like everything else. An older server
// omits fields and a hostile one sends strings where numbers belong; neither
// may throw inside `teamclaude status` or reach the terminal unstripped.
test('a hostile adaptive row renders as ? fields, not a throw or an escape', () => {
  const CLIP = '\x1b]52;c;aGVsbG8=\x07';
  const s = distributedStatus('adaptive');
  s.accounts[0].name = `a${CLIP}`;
  // A string count and a NaN are dropped; the escaped key is stripped.
  s.accounts[0].sessionsByBucket = { [`unified7d\x1b[2J`]: 2, unified7dFable: 1, other: '9', bad: NaN };
  s.adaptive = [
    null,
    'garbage',
    {
      name: `a${CLIP}`, bucket: `opus\x1b[2Jforged`, window: `w\r\n`, competing: true,
      next: 'yes', weight: 'lots', sessions: '3', inFlight: null,
      headroom: Infinity, threshold: undefined, planWeight: 'x', concCap: '6',
    },
  ];
  let out;
  assert.doesNotThrow(() => { out = renderStatus(s, { color: false, now }); });
  assert.doesNotMatch(out, /[\x1b\x07\x9b\r]/);
  assert.match(out, /Adaptive\s+next · weight \? of opus forged/);
  assert.match(out, /\? sess \/ \? inflight/);
  assert.match(out, /head \? of \?/);
  assert.match(out, /plan \?x/);
  assert.match(out, /conc \?/);
  assert.match(out, /^> a .*3 sess \(unified7d 2, fable 1\)$/m);
});

test('accounts are listed in priority order, not config order', () => {
  const acct = (name, priority) => ({ name, type: 'oauth', status: 'active', priority, quota: {}, usage: {} });
  const out = renderStatus({
    currentAccount: 'first',
    switchThreshold: 0.98,
    // Config order puts the last-resort account second, which is how it reached
    // the payload and how it used to render.
    accounts: [acct('first', -1), acct('last-resort', 300), acct('fallback', 100)],
  }, { color: false, now });

  const order = out.split('\n').filter(l => /\(oauth, prio/.test(l))
    .map(l => l.trim().replace(/^>\s*/, '').split(' ')[0]);
  assert.deepEqual(order, ['first', 'fallback', 'last-resort']);
});

// Every account and route string in the payload can have come off the wire
// (`teamclaude status` against a running server) or out of an OAuth reply, and
// the output is printed straight to the operator's terminal.
test('renderStatus strips control characters out of account and route strings', () => {
  const CLIP = '\x1b]52;c;aGVsbG8=\x07';
  const status = sampleStatus();
  status.currentAccount = `a${CLIP}`;
  status.accounts[0].name = `a${CLIP}`;
  status.accounts[0].orgName = `Org\x1b[2J\r\nforged`;
  status.accounts[0].type = `oauth\x9b2J`;
  status.accounts[0].status = `weird${CLIP}`;
  status.accounts[0].unavailable = `custom\x1b[2Jreason`;
  status.accounts[0].quota.spend = { enabled: false, usedMinor: 500, currency: 'USD', disabledReason: `out\x1b[2J` };
  status.probe.accounts[0].status = `boom${CLIP}`;
  status.routes = [{
    name: 'r', match: [`*fable*${CLIP}`], bucket: `b\x1b[2J`, pinned: `a${CLIP}`,
    accounts: [{ name: `a${CLIP}`, eligible: true }, { name: `b\x1b[2J`, eligible: false }],
  }];

  const output = renderStatus(status, { color: false, now });
  assert.doesNotMatch(output, /[\x1b\x07\x9b\r]/);
  assert.match(output, /^> a /m);           // still marked current after stripping
  assert.match(output, /Blocked\s+custom/);
  assert.match(output, /pinned: a/);
  assert.equal(output.split('\n').filter(l => /forged/.test(l)).length, 1);   // no forged line
});
