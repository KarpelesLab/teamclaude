import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { ensureAccountIds } from '../src/account-id.js';
import { mergeAccountsForSave } from '../src/account-pairing.js';
import { Prober, probeApplicable } from '../src/prober.js';
import { renderStatus } from '../src/status-renderer.js';
import { isSyncable } from '../src/credential-sync.js';
import {
  accountRefreshTokenExpiry, refreshTokenExpiryWarning, createRefreshTokenExpiryWarner, loginCommandFor, localDate,
} from '../src/refresh-token-expiry.js';
import { LONG_LIVED_WARN_DAYS } from '../src/long-lived.js';

// A running account marked `longLived` holds no refresh token, whatever its
// entry carries: every gate that decides "can this account be refreshed" reads
// the refresh token, and a stray one sends a dead year-long token through a
// forced refresh that does nothing instead of out of rotation.

const YEAR_MS = 365 * 24 * 3600 * 1000;
const longLived = (fields = {}) => ({
  id: 'a', name: 'a@example.com', type: 'oauth', accountUuid: 'ua',
  accessToken: 'at-long', expiresAt: Date.now() + YEAR_MS, longLived: true, ...fields,
});

test('a long-lived entry that still carries a refresh token is built without it', () => {
  const am = new AccountManager([longLived({ refreshToken: 'rt-stray' })], 0.98);
  assert.equal(am.accounts[0].longLived, true);
  assert.equal(am.accounts[0].refreshToken, null);
});

// An importFrom file is a refreshing Claude Code login, so the marker cannot
// apply to the token read from it.
test('the marker is ignored on an entry that delegates to an importFrom file', () => {
  const am = new AccountManager([longLived({ importFrom: '~/.claude/.credentials.json', refreshToken: 'rt-file' })], 0.98);
  assert.equal(am.accounts[0].longLived, false);
  assert.equal(am.accounts[0].refreshToken, 'rt-file');
});

test('new tokens for a long-lived account do not bring a refresh token with them', () => {
  const am = new AccountManager([longLived()], 0.98);
  am.updateAccountTokens(0, { accessToken: 'at-long-2', refreshToken: 'rt-stray', expiresAt: Date.now() + YEAR_MS });
  assert.equal(am.accounts[0].credential, 'at-long-2');
  assert.equal(am.accounts[0].refreshToken, null);
});

// A plain `teamclaude login` would turn the account back into a refreshing one.
test('a rejected long-lived account names the long-lived login as the remedy', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));
  const am = new AccountManager([longLived(), { ...longLived({ id: 'b', name: 'b@example.com', accountUuid: 'ub' }), longLived: undefined, refreshToken: 'rt-b' }], 0.98);
  am.markCredentialRejected(0, 'upstream rejected its token (401)');
  am.markCredentialRejected(1, 'upstream rejected its token (401)');
  assert.match(lines[0], /run: teamclaude login --long-lived$/);
  assert.match(lines[1], /run: teamclaude login$/);
});

// The TUI's import writes the running account directly and does not reload its
// own save, so it has to clear the marker there too or the imported 8h token is
// never refreshed.
test('a TUI import over a running long-lived account makes it refreshable again', async () => {
  const configAccounts = [longLived()];
  ensureAccountIds(configAccounts);
  const am = new AccountManager(await resolveAccounts({ accounts: configAccounts }), 0.98);
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: configAccounts, routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {},
  });
  tui.render = () => {};
  tui._readCredentials = async () => ({ accessToken: 'at-imported', refreshToken: 'rt-imported', expiresAt: Date.now() + 8 * 3_600_000 });
  tui._readProfile = async () => ({ accountUuid: 'ua', email: 'a@example.com' });

  await tui._doImport();

  assert.equal(am.accounts[0].credential, 'at-imported');
  assert.equal(am.accounts[0].longLived, false);
  assert.equal(am.accounts[0].refreshToken, 'rt-imported');
  assert.equal('longLived' in configAccounts[0], false);

  // The save merges each row over the one on disk, which still carries the mark.
  const [saved] = mergeAccountsForSave(configAccounts, am.accounts, [longLived()]);
  assert.equal('longLived' in saved, false);
  assert.equal(saved.refreshToken, 'rt-imported');
});

// ── what an inference-only token cannot do ──────────────────────────────────
//
// The token carries `user:inference` alone, as `claude setup-token`'s does. The
// usage and profile reads answer it 403 `oauth_scope_insufficient`, so nothing
// here sends them, and nothing counts a refresh token it does not have.

const NOW = 1_700_000_000_000;
const H = 3_600_000;
const DAY = 24 * H;
const ordinary = (fields = {}) => ({
  id: 'b', name: 'b@example.com', type: 'oauth', accountUuid: 'ub',
  accessToken: 'at-b', expiresAt: Date.now() + H, ...fields,
});

test('the quota probe reads neither usage nor profile on a long-lived account', async () => {
  const am = new AccountManager([longLived(), ordinary()], 0.98);
  const usageRead = [];
  const profileRead = [];
  const prober = new Prober(am, {
    intervalMs: 0, log: () => {},
    probeFn: async (token) => { usageRead.push(token); return { sevenDay: { utilization: 0.2, resetAt: 2000 } }; },
    profileFn: async (token) => { profileRead.push(token); return { hasClaudeMax: true, hasClaudePro: false }; },
  });

  await prober.probeAll();

  assert.deepEqual(usageRead, ['at-b']);
  assert.deepEqual(profileRead, ['at-b']);
  assert.equal(probeApplicable(am.accounts[0]), false);
  assert.equal(probeApplicable(am.accounts[1]), true);
  assert.deepEqual(prober.getStatus().accounts.map(a => a.status), ['not-applicable', 'ok']);
  assert.equal(am.accounts[0].quota.unified7d, null, 'its quota waits for a response of its own');
});

test('a long-lived account keeps no refresh-token date, whatever its entry carries', () => {
  const am = new AccountManager([longLived({ refreshToken: 'rt-stray', refreshTokenExpiresAt: Date.now() + 2 * DAY })], 0.98);
  assert.equal(am.accounts[0].refreshTokenExpiresAt, null);

  am.updateAccountTokens(0, { accessToken: 'at-long-2', refreshToken: 'rt-stray', expiresAt: Date.now() + YEAR_MS, refreshTokenExpiresAt: Date.now() + 2 * DAY });
  assert.equal(am.accounts[0].refreshTokenExpiresAt, null);
  assert.equal('refreshTokenExpiresAt' in am.getStatus().accounts[0], false);
});

test('the status payload marks a long-lived account and carries its token expiry, and no other account', () => {
  const expiresAt = Date.now() + YEAR_MS;
  const am = new AccountManager([longLived({ expiresAt }), ordinary()], 0.98);
  const [marked, plain] = am.getStatus().accounts;
  assert.equal(marked.longLived, true);
  assert.equal(marked.expiresAt, expiresAt);
  assert.equal('longLived' in plain, false);
  assert.equal('expiresAt' in plain, false);
});

test('the expiry warning counts down to the long-lived token itself, from two weeks out', () => {
  const account = (left) => ({ name: 'year', type: 'oauth', status: 'active', longLived: true, expiresAt: NOW + left });

  const far = accountRefreshTokenExpiry(account(200 * DAY + H), NOW);
  assert.equal(far?.text, `long-lived token expires in 200 days (${localDate(NOW + 200 * DAY + H)})`);
  assert.equal(far?.warn, false);
  assert.equal(refreshTokenExpiryWarning(account(200 * DAY + H), NOW), null);

  assert.equal(accountRefreshTokenExpiry(account(LONG_LIVED_WARN_DAYS * DAY + 1), NOW)?.warn, false);
  assert.equal(accountRefreshTokenExpiry(account(LONG_LIVED_WARN_DAYS * DAY), NOW)?.warn, true);
  assert.match(String(refreshTokenExpiryWarning(account(9 * DAY + H), NOW)),
    /^long-lived token expires in 9 days \(\d{4}-\d\d-\d\d\) — run: teamclaude login --long-lived$/);
  assert.match(String(refreshTokenExpiryWarning(account(-DAY), NOW)), /^long-lived token expired \(/);

  // A refresh-token date on such a row is not what is counted, and an account
  // already out as `error` has said so in its own line.
  assert.equal(accountRefreshTokenExpiry({ ...account(200 * DAY), refreshTokenExpiresAt: NOW + DAY }, NOW)?.warn, false);
  assert.equal(accountRefreshTokenExpiry({ ...account(DAY), status: 'error' }, NOW), null);
  // No date on the entry (a token pasted in by hand): nothing to count down to.
  assert.equal(accountRefreshTokenExpiry({ ...account(0), expiresAt: null }, NOW), null);

  assert.equal(loginCommandFor(account(DAY)), 'teamclaude login --long-lived');
  assert.equal(loginCommandFor({ ...account(DAY), longLived: false }), 'teamclaude login');
});

test('the server logs the long-lived token\'s approach once a day, in its own words', () => {
  let clock = NOW;
  const logged = [];
  const warn = createRefreshTokenExpiryWarner({ log: (l) => logged.push(l), now: () => clock });
  const accounts = [
    { id: 'a', name: 'year', type: 'oauth', status: 'active', longLived: true, expiresAt: NOW + 9 * DAY + H },
    { id: 'b', name: 'far', type: 'oauth', status: 'active', longLived: true, expiresAt: NOW + 200 * DAY },
    // An ordinary account's access token expiring is not news: it is refreshed.
    { id: 'c', name: 'plain', type: 'oauth', status: 'active', expiresAt: NOW + H },
  ];
  assert.deepEqual(warn(accounts), ['[TeamClaude] Account "year": its long-lived token expires in 9 days — run: teamclaude login --long-lived']);
  clock += H;
  assert.deepEqual(warn(accounts), []);
  assert.equal(logged.length, 1);
});

test('status says why a long-lived account shows less, and when its token ends', () => {
  const text = (account) => renderStatus({
    currentAccount: 'year', switchThreshold: 0.98,
    accounts: [{ name: 'year', type: 'oauth', priority: 0, status: 'active', quota: {}, usage: {}, ...account }],
  }, { color: false, now: NOW });

  const far = text({ longLived: true, expiresAt: NOW + 200 * DAY + H });
  assert.match(far, /^\s+Token\s+long-lived, inference only: plan and usage are not read, quota is taken from response headers$/m);
  assert.match(far, new RegExp(`^\\s+Login\\s+long-lived token expires in 200 days \\(${localDate(NOW + 200 * DAY + H)}\\)$`, 'm'));
  assert.doesNotMatch(far, /teamclaude login/);

  assert.match(text({ longLived: true, expiresAt: NOW + 9 * DAY + H }),
    /Login\s+long-lived token expires in 9 days \(\d{4}-\d\d-\d\d\) — run: teamclaude login --long-lived$/m);

  // The control: an ordinary account gets neither row from its access token.
  assert.doesNotMatch(text({ expiresAt: NOW + H }), /^\s+(Token|Login)\s|long-lived/m);
});

test('an entry marked long-lived that names an importFrom file is synced like any refreshing login', () => {
  const entry = { name: 'a@example.com', type: 'oauth', accountUuid: 'ua', orgUuid: 'oa', accessToken: 'at', longLived: true };
  assert.equal(isSyncable(entry), false);
  assert.equal(isSyncable({ ...entry, importFrom: '~/.claude/.credentials.json' }), true);
  assert.equal(isSyncable({ ...entry, longLived: undefined }), true);
});
