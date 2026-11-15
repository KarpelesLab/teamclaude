// The TUI status cell read a bare `error` whatever put the account there (#611).
// It now names the reason by its code, and the row is followed by the line
// `teamclaude status` prints for it, live and attached alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const h = 3600_000;

const claude = (name, over = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + h, ...over });
const codex = (name) => ({ name, type: 'oauth', provider: 'codex', accountId: `acct-${name}`, accessToken: `c-${name}`, refreshToken: 'r', expiresAt: Date.now() + h });

function rejected(status) {
  const e = /** @type {Error & { status?: number }} */ (new Error(`Token refresh failed (${status})`));
  e.status = status;
  return e;
}

/** The frame's account list, one string per drawn line, at `width` columns. */
function listed(am, width = 140) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
    remote: am instanceof RemoteAccountManager,
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  let buf = '';
  try {
    tui._paint = (b) => { buf = b; };
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    else delete process.stdout.columns;
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
    else delete process.stdout.rows;
  }
  const lines = strip(buf).replace(/^\x1b\[H/, '').split('\r\n');
  return lines.slice(3, lines.findIndex(l => /^ (Activity|Messages)/.test(l))).filter(l => l.trim());
}

const rowOf = (lines, name) => lines.findIndex(l => l.includes(name));

async function refusedRefresh() {
  const am = new AccountManager([claude('dead@x.com', { expiresAt: Date.now() - 1000 }), claude('fine@x.com')], 0.98,
    { refreshFn: async () => { throw rejected(400); } });
  await am.ensureTokenFresh(0);
  return am;
}

test('a rejected refresh reads re-login, with the reason and the command under the row', async () => {
  const lines = listed(await refusedRefresh());
  const at = rowOf(lines, 'dead@x.com');
  assert.match(lines[at], /re-login/);
  assert.doesNotMatch(lines[at], /\berror\b/);
  assert.match(lines[at + 1], /needs a re-login: upstream rejected its refresh token \(400\) — run: teamclaude login/);
  assert.match(lines[at + 2], /fine@x\.com/, 'a healthy account gets no reason line');
});

test('a token refused with nothing to refresh reads re-login', () => {
  const am = new AccountManager([claude('k@x.com', { refreshToken: undefined })], 0.98);
  am.markCredentialRejected(0, 'upstream rejected its token (401) and it has no refresh token');
  const lines = listed(am);
  assert.match(lines[0], /re-login/);
  assert.match(lines[1], /upstream rejected its token \(401\) and it has no refresh token — run: teamclaude login/);
});

test('attach mode reads the code off the status payload: on hold, and an unknown code stays error', async () => {
  const status = (await refusedRefresh()).getStatus();
  const remote = new RemoteAccountManager();

  status.accounts[0].errorReason.code = 'account_on_hold';
  remote.applyStatus(status);
  let lines = listed(remote);
  assert.match(lines[0], /on hold/);
  assert.match(lines[1], /refused by upstream: upstream rejected its refresh token \(400\) — once resolved, run: teamclaude login/);

  status.accounts[0].errorReason.code = 'verification_required';
  remote.applyStatus(status);
  lines = listed(remote);
  assert.match(lines[0], /refused/);
  assert.match(lines[1], /refused by upstream/);

  status.accounts[0].errorReason.code = 'toString';
  remote.applyStatus(status);
  lines = listed(remote);
  assert.match(lines[0], /\berror\b/);
  assert.doesNotMatch(lines[0], /re-login|on hold|function/);
});

test('a malformed reason off the wire neither throws nor reaches the terminal raw', async () => {
  const status = (await refusedRefresh()).getStatus();
  const remote = new RemoteAccountManager();
  status.accounts[0].errorReason = { code: 'refresh_rejected', detail: { toString: null }, remedy: 'teamclaude login\x1b[2J' };
  remote.applyStatus(status);
  const tui = new TUI({ accountManager: remote, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, remote: true });
  const L = tui._listLayout([0, 1], 140);
  const [, why] = tui._rowLines(0, L, new Set());
  assert.doesNotMatch(why, /\x1b\[2J/);
  assert.match(strip(why), /run: teamclaude login/);
});

test('attach mode keeps a refusal\'s whole appeal link', async () => {
  const status = (await refusedRefresh()).getStatus();
  const link = `https://claude.ai/restricted?case=${'c'.repeat(300)}`;
  Object.assign(status.accounts[0].errorReason, { code: 'account_on_hold', detail: `On hold. Appeal: ${link}`, link });
  const remote = new RemoteAccountManager();
  remote.applyStatus(status);
  assert.equal(remote.accounts[0].errorReason.link, link);
  assert.equal(remote.accounts[0].errorReason.detail, `On hold. Appeal: ${link}`);
});

test('an error with no reason on it keeps the bare cell and the line status prints for it', () => {
  const am = new AccountManager([claude('old@x.com'), claude('fine@x.com')], 0.98);
  am.accounts[0].status = 'error';
  const lines = listed(am);
  assert.match(lines[0], /\berror\b/);
  assert.match(lines[1], /account error \(see logs\)/);
  assert.match(lines[2], /fine@x\.com/);
});

test('a cap that bars the account first is what both the cell and status say', async () => {
  const am = await refusedRefresh();
  am.accounts[0].maxUsage = 0.5;
  Object.assign(am.accounts[0].quota, { unified7d: 0.6, unified7dReset: Date.now() + h });
  const lines = listed(am);
  assert.match(lines[0], /capped/);
  assert.match(lines[1], /fine@x\.com/, 'no error line under a capped row');
});

test('in split panes the reason line stays in its own pane', async () => {
  const am = new AccountManager([claude('dead@x.com', { expiresAt: Date.now() - 1000 }), claude('b@x.com'), codex('k@x.com')], 0.98,
    { refreshFn: async () => { throw rejected(400); } });
  await am.ensureTokenFresh(0);
  const lines = listed(am, 220);
  assert.ok(lines[0].includes('│'), 'drawn as two panes');
  const left = (l) => l.slice(0, l.indexOf(' │ '));
  const at = lines.findIndex(l => left(l).includes('dead@x.com'));
  const next = lines.findIndex(l => left(l).includes('b@x.com'));
  assert.match(left(lines[at]), /re-login/);
  const why = lines.slice(at + 1, next).map(l => left(l).trim()).join(' ');
  assert.match(why, /needs a re-login: upstream rejected its refresh token \(400\) — run: teamclaude login/, 'wrapped, not cut');
});

test('live, the line asks the manager whether the account bills on extra usage, as attach reads it off the payload', async () => {
  const am = await refusedRefresh();
  am.onExtraUsage = (i) => i === 0;
  assert.match(listed(am).slice(1, 4).join(' ').replace(/\s+/g, ' '), /serving on extra usage \(paid overage\), billing/);
});
