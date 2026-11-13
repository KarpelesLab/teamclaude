import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, displayWidth } from '../src/tui.js';

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
  const now = Date.now();
  const grant = {
    id: 'weekly-1', kind: 'weekly', label: 'Full reset', resetsLeft: 1, resetsTotal: 2,
    clears: ['five_hour', 'seven_day'], endsAt: now + 18 * 86400_000,
    next: true, blocked: null, warnings: [],
  };
  return {
    provider: 'claude', error: null, ineligibleReason: null,
    atLimit: true, exhausted: ['seven_day', 'seven_day_overage_included'],
    cooldownUntil: now + 3600_000, weeklyResetsAt: now + 2 * 86400_000,
    fleetHoldUntil: now + 7200_000,
    grants: [
      grant,
      { ...grant, id: 'fable-1', kind: 'fable', label: 'Launch gift', resetsLeft: 3, resetsTotal: 3,
        clears: ['seven_day_overage_included'], next: false, warnings: ['does not clear seven_day', 'a reset recently landed'] },
      { ...grant, id: 'session-1', kind: 'session', label: null, resetsLeft: 0, resetsTotal: 1,
        clears: ['five_hour'], next: false, blocked: 'no resets left' },
    ],
    ...overrides,
  };
}

function makeTUI({ resetActions, remote = false, accounts } = {}) {
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
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, resetActions, remote,
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

test('resets: the panel shows wall state, grants, warnings, blocks and its keys within the frame width', async () => {
  const tui = makeTUI({ resetActions: actions() });
  openPanel(tui);
  await flush();
  const rows = frame(tui);
  const text = rows.map(stripAnsi).join('\n');
  assert.match(text, /Resets — banked.*Claude/);
  assert.match(text, /at a limit: seven_day, seven_day_overage_included/);
  assert.match(text, /upstream cooldown until/);
  assert.match(text, /weekly window resets at/);
  assert.match(text, /fleet hold until/);
  assert.match(text, /Weekly reset.*Full reset.*1\/2.*clears: 5h, week.*expires.*next/);
  assert.match(text, /Fable reset.*Launch gift.*3\/3.*clears: Fable week/);
  assert.match(text, /Session reset.*0\/1.*clears: 5h/);
  assert.match(text, /blocked: no resets left/);
  assert.match(text, /does not clear seven_day/);
  assert.match(text, /↑↓ move.*Enter spend.*r re-read.*Esc close/);
  for (const width of [40, 60, 80, 120]) {
    for (const row of frame(tui, { columns: width })) assert.equal(displayWidth(row), width);
  }
});

test('resets: arrow and vi keys move, but a blocked grant cannot reach confirmation', async () => {
  let spends = 0;
  const tui = makeTUI({ resetActions: actions(undefined, async () => { spends++; return {}; }) });
  openPanel(tui);
  await flush();
  tui._key('down');
  tui._key('j');
  assert.equal(tui.resetsPanel.idx, 2);
  tui._key('enter');
  assert.equal(tui.resetsPanel.confirming, false);
  tui._key('y');
  assert.equal(spends, 0);
  tui._key('up');
  tui._key('k');
  assert.equal(tui.resetsPanel.idx, 0);
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
  assert.match(full, /Codex reset credit.*Plan credit.*1\/\?/);
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
