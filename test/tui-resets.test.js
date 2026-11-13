import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, displayWidth } from '../src/tui.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY = 86400_000;
const originalTZ = process.env.TZ;
process.env.TZ = 'Europe/London';
after(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const logged = tui => tui.log.map(entry => stripAnsi(entry.msg));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function details(overrides = {}) {
  const now = NOW;
  const grant = {
    id: 'weekly-1', kind: 'weekly', label: 'Full reset', resetsLeft: 1, resetsTotal: 2,
    clears: ['five_hour', 'seven_day'], endsAt: now + 10 * DAY,
    next: true, blocked: null, warnings: [],
  };
  return {
    provider: 'claude', error: null, ineligibleReason: null,
    atLimit: true, exhausted: ['seven_day', 'seven_day_overage_included'],
    cooldownUntil: now + 3600_000, weeklyResetsAt: Date.parse('2026-11-14T21:00:00Z'),
    fleetHoldUntil: now + 7200_000,
    grants: [
      { ...grant, id: 'weekly-spent', label: 'Spent weekly gift', resetsLeft: 0, blocked: 'no resets left' },
      grant,
      { ...grant, id: 'fable-spent-1', kind: 'fable', label: 'Spent Fable gift 1', resetsLeft: 0, blocked: 'no resets left' },
      { ...grant, id: 'fable-spent-2', kind: 'fable', label: 'Spent Fable gift 2', resetsLeft: 0, blocked: 'no resets left' },
      { ...grant, id: 'fable-1', kind: 'fable', label: 'Launch gift', resetsLeft: 3, resetsTotal: 3,
        clears: ['seven_day_overage_included'], next: false, warnings: ['does not clear seven_day', 'a reset recently landed'] },
      { ...grant, id: 'session-1', kind: 'session', label: 'Paused gift', resetsLeft: 1, resetsTotal: 1,
        clears: ['five_hour'], next: false, blocked: 'reset is paused' },
    ],
    ...overrides,
  };
}

function makeTUI({ resetActions, remote = false, accounts, resetNow = () => NOW } = {}) {
  const now = Date.now();
  const am = {
    accounts: accounts ?? [
      { name: 'plain', index: 0, type: 'oauth', status: 'active', quota: {} },
      { name: 'banked', index: 1, type: 'oauth', status: 'active', quota: { resetCredits: { available: 4, seenAt: now } } },
      { name: 'key', index: 2, type: 'apikey', status: 'active', quota: {} },
    ],
    currentIndex: 0, switchThreshold: 0.98,
    getRoutes() { return []; },
    sessionStats() { return { active: 0, known: 0 }; },
    refreshExpiredQuotas() {},
    thresholdFor() { return 0.98; },
  };
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, resetActions, remote, resetNow,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  return tui;
}

function openPanel(tui) {
  tui._key('r');
  tui._key('enter');
}

function frame(tui, { columns = 120, rows = 28 } = {}) {
  const real = Object.getOwnPropertyDescriptor(process, 'stdout');
  let painted = '';
  Object.defineProperty(process, 'stdout', {
    value: { columns, rows }, configurable: true,
  });
  tui._paint = buf => { painted = buf; };
  try { tui._render(true); } finally { Object.defineProperty(process, 'stdout', real); }
  return painted.replace(/^\x1b\[H/, '').replace(/\x1b\[\?25[hl]$/, '').split('\r\n');
}

const actions = (read = async () => details(), redeem = async () => ({ redeemed: true, uncertain: false, message: 'Reset spent on "banked"' })) => ({ read, redeem });

test('resets: r selects the first holding account in display order, Enter reads it', async () => {
  const seen = [];
  const tui = makeTUI({ resetActions: actions(async account => { seen.push(account); return details(); }) });
  tui.am.accounts[0].quota.resetCredits = { available: 1, seenAt: Date.now() };
  tui.am.accounts[1].displayOrder = 0;
  tui.am.accounts[0].displayOrder = 1;
  tui._key('r');
  assert.equal(tui.mode, 'select');
  assert.equal(tui.selAction, 'resets');
  assert.equal(tui.selReturn, 'normal');
  assert.equal(tui.selIdx, 1);
  assert.match(stripAnsi(tui._renderFooter()), /Enter.*resets/);
  tui._key('enter');
  assert.equal(tui.mode, 'resets');
  assert.equal(tui.resetsPanel.loading, true);
  assert.deepEqual(seen, [tui.am.accounts[1]]);
  await flush();
  assert.equal(tui.resetsPanel.loading, false);
  assert.equal(tui.resetsPanel.details.grants[0].id, 'weekly-1');
});

test('resets: with no held resets the picker starts at the first displayed account; Esc and q leave', () => {
  const tui = makeTUI({ resetActions: actions() });
  tui.am.accounts[1].quota = {};
  tui.am.accounts[1].displayOrder = 0;
  tui.am.accounts[0].displayOrder = 1;
  for (const key of ['esc', 'q']) {
    tui._key('r');
    assert.equal(tui.selIdx, 1);
    tui._key(key);
    assert.equal(tui.mode, 'normal');
  }
});

test('resets: unsupported accounts stay in the picker with a reason; Codex opens', async () => {
  const seen = [];
  const tui = makeTUI({ resetActions: actions(async account => { seen.push(account.name); return details({ provider: 'codex' }); }) });
  tui._key('r');
  tui.selIdx = 2;
  tui._key('enter');
  assert.equal(tui.mode, 'select');
  assert.match(logged(tui)[0], /not an OAuth Claude or Codex account/);
  tui.am.accounts[0].upstream = 'https://backend.invalid';
  tui.selIdx = 0;
  tui._key('enter');
  assert.equal(tui.mode, 'select');
  assert.deepEqual(seen, []);
  tui.am.accounts[1].provider = 'codex';
  tui.selIdx = 1;
  tui._key('enter');
  await flush();
  assert.deepEqual(seen, ['banked']);
  assert.match(frame(tui).map(stripAnsi).join('\n'), /Codex/);
});

test('resets: the panel shows held grants with bold kinds, local wall state and inline blocks within the frame width', async () => {
  const tui = makeTUI({ resetActions: actions() });
  openPanel(tui);
  await flush();
  const rows = frame(tui);
  const text = rows.map(stripAnsi).join('\n');
  assert.match(text, /Resets — banked.*Claude/);
  assert.match(text, /at a limit: week \+ Fable week · week resets Sat 14 Nov 21:00/);
  assert.match(text, /upstream cooldown until 13:00/);
  assert.match(text, /fleet hold until 14:00/);
  assert.match(text, /Weekly reset +1 left  clears 5h \+ week  expires 23 Nov  \(next\)/);
  assert.match(text, /Fable reset +3 left  clears Fable week  expires 23 Nov/);
  assert.match(text, /Session reset +1 left  clears 5h  expires 23 Nov · reset is paused/);
  assert.match(rows.find(row => stripAnsi(row).includes('Full reset')), /\x1b\[2mFull reset/);
  assert.doesNotMatch(text, /Spent weekly gift|Spent Fable gift|no resets left/);
  assert.doesNotMatch(text, /Launch gift|does not clear seven_day|a reset recently landed/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/);
  for (const kind of ['Weekly reset', 'Fable reset', 'Session reset']) {
    assert.ok(rows.some(row => row.includes(`\x1b[1m${kind}\x1b[0m`)), `${kind} is bold`);
  }
  assert.match(text, /↑↓ move.*Enter spend.*r re-read.*Esc close/);
  for (const width of [40, 60, 80, 120]) {
    for (const row of frame(tui, { columns: width })) assert.equal(displayWidth(row), width);
    for (const row of tui._resetsLines(width)) assert.ok(displayWidth(row) < width);
  }
});

test('resets: the agreed mixed-grant panel shows details only for the selected held grant', async () => {
  const read = details({ atLimit: false, exhausted: [], cooldownUntil: null, fleetHoldUntil: null });
  read.grants[1].label = 'One full limit reset (November 2026)';
  read.grants[1].clears = ['seven_day', 'seven_day_overage_included'];
  read.grants[1].warnings = ['no weekly limit is exhausted'];
  const tui = makeTUI({ resetActions: actions(async () => read) });
  openPanel(tui);
  await flush();
  const panel = tui._resetsLines(120).map(stripAnsi);
  assert.deepEqual(panel, [
    '', ' Resets — banked · Claude', '',
    '   not at a limit · week resets Sat 14 Nov 21:00', '',
    ' ▸ Weekly reset   1 left  clears week + Fable week  expires 23 Nov  (next)',
    '   One full limit reset (November 2026)',
    '   no weekly limit is exhausted',
    '   Fable reset    3 left  clears Fable week  expires 23 Nov',
    '   Session reset  1 left  clears 5h  expires 23 Nov · reset is paused',
  ]);
  const warning = tui._resetsLines(120).find(row => stripAnsi(row).includes('no weekly limit is exhausted'));
  assert.match(warning, /\x1b\[33m/);
  tui._key('down');
  const selected = tui._resetsLines(120);
  const text = selected.map(stripAnsi).join('\n');
  assert.match(text, /▸ Fable reset/);
  assert.match(text, /Launch gift\n.*does not clear seven_day · a reset recently landed/);
  assert.doesNotMatch(text, /One full limit reset|no weekly limit is exhausted/);
  assert.match(selected.find(row => stripAnsi(row).includes('does not clear')), /\x1b\[33m/);
});

test('resets: Enter after down spends the second held id, skipping interleaved spent grants', async () => {
  const calls = [];
  const tui = makeTUI({ resetActions: actions(undefined, async (_account, id) => {
    calls.push(id);
    return { redeemed: false, uncertain: false, message: 'test spend' };
  }) });
  openPanel(tui);
  await flush();
  assert.deepEqual(tui.resetsPanel.details.grants.map(grant => grant.id), ['weekly-1', 'fable-1', 'session-1']);
  tui._key('down');
  assert.match(tui._resetsLines(120).map(stripAnsi).join('\n'), /▸ Fable reset/);
  tui._key('enter');
  assert.match(stripAnsi(tui._renderFooter()), /Spend 1 fable reset/);
  tui._key('y');
  await flush();
  assert.deepEqual(calls, ['fable-1']);
});

test('resets: arrow and vi keys move, but a dimmed blocked held grant cannot reach confirmation', async () => {
  let spends = 0;
  const tui = makeTUI({ resetActions: actions(undefined, async () => { spends++; return {}; }) });
  openPanel(tui);
  await flush();
  tui._key('down');
  tui._key('j');
  assert.equal(tui.resetsPanel.idx, 2);
  const blocked = tui._resetsLines(120).find(row => stripAnsi(row).includes('▸ Session reset'));
  assert.match(blocked, /\x1b\[2m\x1b\[1mSession reset/);
  assert.match(blocked, /\x1b\[2m[^\x1b]+ · reset is paused/);
  tui._key('enter');
  assert.equal(tui.resetsPanel.confirming, false);
  tui._key('y');
  assert.equal(spends, 0);
  tui._key('up');
  tui._key('k');
  assert.equal(tui.resetsPanel.idx, 0);
});

test('resets: expiry dates use the local year and switch to a countdown within one day', async () => {
  let now = NOW;
  const read = details();
  read.grants[4].endsAt = NOW + 5 * 3600_000;
  read.grants[5].endsAt = Date.parse('2027-03-08T12:00:00Z');
  const tui = makeTUI({ resetActions: actions(async () => read), resetNow: () => now });
  openPanel(tui);
  await flush();
  const text = frame(tui).map(stripAnsi).join('\n');
  assert.match(text, /Weekly reset[^\n]*expires 23 Nov  \(next\)/);
  assert.match(text, /Fable reset[^\n]*expires in 5h/);
  assert.match(text, /Session reset[^\n]*expires 8 Mar 2027/);
  assert.doesNotMatch(text, /expires 23 Nov 2026|\d{4}-\d{2}-\d{2}T/);
  now += 3600_000;
  assert.match(tui._resetsLines(120).map(stripAnsi).join('\n'), /Fable reset[^\n]*expires in 4h/);
});

test('resets: local dates and cooldown times include the day only when needed', async t => {
  process.env.TZ = 'America/New_York';
  t.after(() => { process.env.TZ = 'Europe/London'; });
  const now = Date.parse('2026-07-01T23:00:00Z'); // 19:00 local, during daylight saving time.
  const read = details({
    cooldownUntil: Date.parse('2026-07-02T01:45:00Z'), // Still today locally.
    fleetHoldUntil: Date.parse('2026-07-02T14:45:00Z'),
    weeklyResetsAt: Date.parse('2026-07-03T01:00:00Z'),
  });
  read.grants[1].endsAt = Date.parse('2026-07-12T01:00:00Z');
  const tui = makeTUI({ resetActions: actions(async () => read), resetNow: () => now });
  openPanel(tui);
  await flush();
  const text = frame(tui).map(stripAnsi).join('\n');
  assert.match(text, /week resets Thu 2 Jul 21:00/);
  assert.match(text, /upstream cooldown until 21:45/);
  assert.match(text, /fleet hold until Thu 2 Jul 10:45/);
  assert.match(text, /Weekly reset[^\n]*expires 11 Jul/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/);
});

test('resets: a spent-only read is empty and cannot confirm or spend', async () => {
  const read = details();
  read.grants = read.grants.filter(grant => grant.resetsLeft < 1);
  const calls = [];
  const tui = makeTUI({ resetActions: actions(async () => read, async (_account, id) => { calls.push(id); }) });
  openPanel(tui);
  await flush();
  assert.match(frame(tui).map(stripAnsi).join('\n'), /no banked resets/);
  assert.equal(tui.resetsPanel.details.grants.length, 0);
  tui._key('down');
  tui._key('enter');
  tui._key('y');
  assert.equal(tui.resetsPanel.idx, 0);
  assert.equal(tui.resetsPanel.confirming, false);
  assert.deepEqual(calls, []);
});

test('resets: re-reading clamps the cursor to the remaining held grants', async () => {
  let read = details();
  const tui = makeTUI({ resetActions: actions(async () => read) });
  openPanel(tui);
  await flush();
  tui._key('down');
  tui._key('down');
  assert.equal(tui.resetsPanel.idx, 2);
  read = details();
  read.grants[4].resetsLeft = 0;
  read.grants[5].resetsLeft = 0;
  tui._key('r');
  await flush();
  assert.equal(tui.resetsPanel.idx, 0);
  assert.match(tui._resetsLines(120).map(stripAnsi).join('\n'), /▸ Weekly reset/);
  tui._key('enter');
  assert.match(stripAnsi(tui._renderFooter()), /Spend 1 weekly reset/);
});

test('resets: selected labels and warnings stay on single truncated lines', async () => {
  const read = details();
  read.grants[1].label = 'Long upstream title '.repeat(15);
  read.grants[1].warnings = ['First warning '.repeat(15), 'Second warning'];
  const tui = makeTUI({ resetActions: actions(async () => read) });
  openPanel(tui);
  await flush();
  for (const width of [40, 60, 80]) {
    const panel = tui._resetsLines(width);
    const text = panel.map(stripAnsi);
    assert.equal(text.filter(row => row.includes('Long upstream title')).length, 1);
    assert.equal(text.filter(row => row.includes('First warning')).length, 1);
    for (const row of panel) assert.ok(displayWidth(row) < width);
  }
});

test('resets: confirmation shows warnings; y spends the chosen id only once and logs the exact result', async () => {
  const spend = deferred();
  const calls = [];
  let reads = 0;
  const message = 'Manually redeemed a claude reset on "banked" (success)';
  const tui = makeTUI({ resetActions: actions(async () => { reads++; return details(); }, (account, id) => {
    calls.push([account, id]);
    return spend.promise;
  }) });
  openPanel(tui);
  await flush();
  tui._key('j');
  tui._key('enter');
  assert.equal(tui.resetsPanel.confirming, true);
  const footer = frame(tui).at(-1);
  assert.match(stripAnsi(footer), /Spend 1 fable reset on "banked"\? y\/N.*does not clear seven_day.*a reset recently landed/);
  assert.match(footer, /\x1b\[1m/);
  assert.match(footer, /\x1b\[33m/);
  tui._key('y');
  tui._key('enter');
  tui._key('y');
  tui._key('Y');
  assert.equal(tui.resetsPanel.busy, true);
  assert.match(stripAnsi(tui._renderFooter()), /spending/);
  assert.deepEqual(calls, [[tui.am.accounts[1], 'fable-1']]);
  spend.resolve({ redeemed: true, uncertain: false, message });
  await flush();
  assert.deepEqual(logged(tui), [message]);
  assert.equal(reads, 2);
  assert.equal(tui.resetsPanel.busy, false);
});

test('resets: any key except y or Y cancels confirmation without spending', async () => {
  let spends = 0;
  const tui = makeTUI({ resetActions: actions(undefined, async () => { spends++; return {}; }) });
  openPanel(tui);
  await flush();
  for (const key of ['n', 'enter', 'j', 'r', 'esc', 'q', 'x']) {
    tui._key('enter');
    assert.equal(tui.resetsPanel.confirming, true);
    tui._key(key);
    assert.equal(tui.resetsPanel.confirming, false);
    assert.equal(tui.mode, 'resets');
  }
  assert.equal(spends, 0);
});

test('resets: uppercase Y spends; a refusal stays visible without re-reading, an uncertain result re-reads', async () => {
  for (const uncertain of [false, true]) {
    let reads = 0;
    const message = uncertain ? 'Manual reset on "banked": verdict unread' : 'Manual reset on "banked": upstream declined';
    const tui = makeTUI({ resetActions: actions(async () => { reads++; return details(); }, async () => ({ redeemed: false, uncertain, message })) });
    openPanel(tui);
    await flush();
    tui._key('enter');
    tui._key('Y');
    await flush();
    assert.equal(tui.mode, 'resets');
    assert.deepEqual(logged(tui), [message]);
    assert.equal(reads, uncertain ? 2 : 1);
    if (!uncertain) assert.match(frame(tui).map(stripAnsi).join('\n'), /upstream declined/);
  }
});

test('resets: a thrown spend failure is logged and leaves the panel usable', async () => {
  const tui = makeTUI({ resetActions: actions(undefined, async () => { throw new Error('network down'); }) });
  openPanel(tui);
  await flush();
  tui._key('enter');
  tui._key('y');
  await flush();
  assert.equal(tui.resetsPanel.busy, false);
  assert.match(logged(tui)[0], /failed.*banked.*network down/i);
  assert.match(frame(tui).map(stripAnsi).join('\n'), /network down/);
  tui._key('enter');
  assert.equal(tui.resetsPanel.confirming, true);
});

test('resets: re-read and close invalidate old reads, including a late failure', async () => {
  const pending = [];
  const tui = makeTUI({ resetActions: actions(() => {
    const read = deferred();
    pending.push(read);
    return read.promise;
  }) });
  openPanel(tui);
  const first = tui.resetsPanel;
  tui._key('r');
  pending[1].resolve(details({ atLimit: false }));
  await flush();
  pending[0].resolve(details({ atLimit: true }));
  await flush();
  assert.equal(tui.resetsPanel.details.atLimit, false);
  assert.match(frame(tui).map(stripAnsi).join('\n'), /not at a limit/);
  tui._key('r');
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
  assert.equal(tui.resetsPanel, null);
  openPanel(tui);
  pending[3].resolve(details({ grants: [] }));
  await flush();
  pending[2].reject(new Error('late failure'));
  await flush();
  assert.notEqual(tui.resetsPanel, first);
  assert.equal(tui.resetsPanel.error, null);
  assert.match(frame(tui).map(stripAnsi).join('\n'), /no banked resets/);
  tui._key('q');
  assert.equal(tui.mode, 'normal');
});

test('resets: closing during a spend does not reopen the panel when it finishes', async () => {
  const spend = deferred();
  let reads = 0;
  const tui = makeTUI({ resetActions: actions(async () => { reads++; return details(); }, () => spend.promise) });
  openPanel(tui);
  await flush();
  tui._key('enter');
  tui._key('y');
  tui._key('esc');
  spend.resolve({ redeemed: true, uncertain: false, message: 'Reset spent on "banked"' });
  await flush();
  assert.equal(tui.mode, 'normal');
  assert.equal(tui.resetsPanel, null);
  assert.equal(reads, 1);
  assert.deepEqual(logged(tui), ['Reset spent on "banked"']);
});

test('resets: read errors, ineligible status and empty grants are visible without allowing a spend', async () => {
  for (const read of [
    async () => details({ error: 'upstream unavailable', grants: [] }),
    async () => { throw new Error('upstream unavailable'); },
    async () => details({ ineligibleReason: 'plan excluded', grants: [] }),
  ]) {
    const tui = makeTUI({ resetActions: actions(read) });
    openPanel(tui);
    await flush();
    assert.match(frame(tui).map(stripAnsi).join('\n'), /upstream unavailable|ineligible: plan excluded/);
    tui._key('enter');
    assert.equal(tui.resetsPanel.confirming, false);
  }
});

test('resets: a read resolved after close cannot update or reopen its old panel', async () => {
  const read = deferred();
  const tui = makeTUI({ resetActions: actions(() => read.promise) });
  openPanel(tui);
  const closed = tui.resetsPanel;
  tui._key('esc');
  read.resolve(details());
  await flush();
  assert.equal(tui.mode, 'normal');
  assert.equal(tui.resetsPanel, null);
  assert.equal(closed.details, null);
});

test('resets: narrow confirmation keeps y/N and its emphasis with a long, wide account name', async () => {
  const tui = makeTUI({ resetActions: actions() });
  tui.am.accounts[1].name = '銀行'.repeat(30);
  openPanel(tui);
  await flush();
  tui._key('enter');
  const footer = frame(tui, { columns: 40 }).at(-1);
  assert.match(stripAnsi(footer), /Spend 1 weekly reset on ".*"\? y\/N/);
  assert.match(footer, /\x1b\[33m\x1b\[1m[^\x1b]+y\/N/);
  assert.equal(displayWidth(footer), 40);
});

test('resets: a Codex credit with no total or expiry is selectable on a short screen', async () => {
  const credit = {
    id: 'codex-1', kind: 'codex', label: 'Plan credit', resetsLeft: 1, resetsTotal: null,
    clears: [], endsAt: null, next: false, blocked: null, warnings: [],
  };
  const tui = makeTUI({ resetActions: actions(async () => details({
    provider: 'codex', atLimit: false, exhausted: [], cooldownUntil: null,
    fleetHoldUntil: null, weeklyResetsAt: null, grants: [credit],
  })) });
  openPanel(tui);
  await flush();
  const full = frame(tui).map(stripAnsi).join('\n');
  assert.match(full, /Codex reset credit +1 left  clears -/);
  assert.match(full, /\n +Plan credit/);
  assert.ok(frame(tui).some(row => row.includes('\x1b[1mCodex reset credit\x1b[0m')));
  tui._key('enter');
  const rows = frame(tui, { columns: 80, rows: 8 }).map(stripAnsi);
  assert.ok(rows.some(row => row.includes('▸ Codex reset credit')));
  assert.match(rows.at(-1), /Spend 1 codex reset credit on "banked"\? y\/N/);
});

test('resets: r and its footer hint are available only locally with actions and accounts', () => {
  const local = makeTUI({ resetActions: actions() });
  local.loginAccount = async () => ({});
  assert.match(stripAnsi(local._renderFooter()), /r resets/);
  assert.match(stripAnsi(frame(local, { columns: 80 }).at(-1)), /r resets.*quit/);
  for (const options of [{}, { resetActions: actions(), remote: true }, { resetActions: actions(), accounts: [] }]) {
    const tui = makeTUI(options);
    tui._key('r');
    assert.equal(tui.mode, 'normal');
    assert.doesNotMatch(stripAnsi(tui._renderFooter()), /r resets/);
  }
});
