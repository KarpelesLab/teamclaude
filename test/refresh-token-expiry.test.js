// A refresh token seems to live a fixed time from the sign-in that issued it
// (#674), and the account then needs a new login with no warning. The date is
// kept and shown where it was stated: by the token endpoint, or by the
// credential file an account was imported from. The one date that is assumed
// is a Claude sign-in's, 30 days out, as Claude Code records it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenPairFromResponse } from '../src/oauth.js';
import { credentialsFromTokenResponse } from '../src/codex-auth.js';
import { AccountManager } from '../src/account-manager.js';
import { syncRefreshedTokens, mergeAccountsForSave } from '../src/account-pairing.js';
import { ensureAccountIds } from '../src/account-id.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { encodeBlob, decodeBlob, entryFromBlob, refreshOutsideProxy } from '../src/credential-sync.js';
import { renderStatus } from '../src/status-renderer.js';
import { TUI } from '../src/tui.js';
import {
  REFRESH_TOKEN_WARN_DAYS, refreshTokenExpiryFromResponse, earlierRefreshTokenExpiry, withFamilyExpiry,
  expiryAfterReplacement, setRefreshTokenExpiry, refreshTokenExpiryView, accountRefreshTokenExpiry,
  refreshTokenExpiryWarning, createRefreshTokenExpiryWarner, localDate, knownRefreshTokenExpiry,
  signInRefreshTokenExpiry, ASSUMED_SIGN_IN_LIFETIME_MS,
} from '../src/refresh-token-expiry.js';

const NOW = 1_700_000_000_000;
const H = 3_600_000;
const DAY = 24 * H;

// ── what a token response states ────────────────────────────────────────────

test('refresh_token_expires_in is seconds from now', () => {
  assert.equal(refreshTokenExpiryFromResponse({ refresh_token_expires_in: 30 * 86400 }, NOW), NOW + 30 * DAY);
  assert.equal(refreshTokenExpiryFromResponse({ refresh_token_expires_in: '86400' }, NOW), NOW + DAY);
});

test('refresh_token_expires_at is epoch seconds, epoch milliseconds, or an ISO date', () => {
  const at = NOW + 12 * DAY;
  assert.equal(refreshTokenExpiryFromResponse({ refresh_token_expires_at: at / 1000 }, NOW), at);
  assert.equal(refreshTokenExpiryFromResponse({ refresh_token_expires_at: at }, NOW), at);
  assert.equal(refreshTokenExpiryFromResponse({ refresh_token_expires_at: String(at / 1000) }, NOW), at);
  assert.equal(refreshTokenExpiryFromResponse({ refresh_token_expires_at: new Date(at).toISOString() }, NOW), at);
});

test('both spellings in one response: the sooner date', () => {
  const body = { refresh_token_expires_in: 10 * 86400, refresh_token_expires_at: (NOW + 3 * DAY) / 1000 };
  assert.equal(refreshTokenExpiryFromResponse(body, NOW), NOW + 3 * DAY);
});

test('a Claude sign-in that states no lifetime is dated 30 days out, and a stated one stands', () => {
  assert.equal(ASSUMED_SIGN_IN_LIFETIME_MS, 30 * DAY);
  const silent = tokenPairFromResponse({ access_token: 'a', refresh_token: 'r', expires_in: 28800 }, { now: NOW });
  assert.equal('refreshTokenExpiresAt' in silent, false, 'the response itself stated nothing');
  assert.deepEqual(signInRefreshTokenExpiry(silent, NOW), { ...silent, refreshTokenExpiresAt: NOW + 30 * DAY });
  assert.equal('refreshTokenExpiresAt' in silent, false, 'the input is not written to');

  const stated = tokenPairFromResponse({ access_token: 'a', refresh_token: 'r', refresh_token_expires_in: 7 * 86400 }, { now: NOW });
  assert.equal(signInRefreshTokenExpiry(stated, NOW).refreshTokenExpiresAt, NOW + 7 * DAY);

  // No refresh token, nothing to lapse: such a sign-in is given no date.
  const bare = { accessToken: 'a', refreshToken: undefined, expiresAt: NOW + H };
  assert.equal('refreshTokenExpiresAt' in signInRefreshTokenExpiry(bare, NOW), false);
});

test('an assumed sign-in date is dropped by a refresh that succeeds after it', () => {
  const signedIn = signInRefreshTokenExpiry({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + H }, NOW);
  const refreshed = { accessToken: 'b', refreshToken: 'r2', expiresAt: NOW + 31 * DAY + H };
  // Inside the 30 days a refresh that states nothing keeps the date.
  assert.equal(withFamilyExpiry(signedIn, refreshed, NOW + 29 * DAY).refreshTokenExpiresAt, NOW + 30 * DAY);
  // Past them, the refresh that just worked disproved it.
  assert.equal('refreshTokenExpiresAt' in withFamilyExpiry(signedIn, refreshed, NOW + 31 * DAY), false);
});

test('a response that states nothing believable yields no date: a refresh never assumes one', () => {
  const nonsense = [
    null, undefined, 'text', {},
    { expires_in: 28800 },                                      // the access token's, not the refresh token's
    { refresh_token_expires_in: 0 },
    { refresh_token_expires_in: -5 },
    { refresh_token_expires_in: NaN },
    { refresh_token_expires_in: Infinity },
    { refresh_token_expires_in: 'soon' },
    { refresh_token_expires_in: '' },
    { refresh_token_expires_in: true },
    { refresh_token_expires_in: {} },
    { refresh_token_expires_in: 11 * 365 * 86400 },             // further out than any token lives
    { refresh_token_expires_at: 0 },
    { refresh_token_expires_at: -1 },
    { refresh_token_expires_at: 'not a date' },
    { refresh_token_expires_at: null },
    { refresh_token_expires_at: [] },
    { refresh_token_expires_at: (NOW - 2 * DAY) / 1000 },       // long past
    { refresh_token_expires_at: NOW + 11 * 365 * DAY },
    { refresh_token_expires_at: new Date(NOW - 40 * DAY).toISOString() },
  ];
  for (const body of nonsense) {
    assert.equal(refreshTokenExpiryFromResponse(body, NOW), null, JSON.stringify(body));
  }
  // Just past is still a date: a clock a few minutes off must not erase it.
  assert.equal(refreshTokenExpiryFromResponse({ refresh_token_expires_at: NOW - H }, NOW), NOW - H);
});

test('tokenPairFromResponse carries the date only when the response states one', () => {
  const none = tokenPairFromResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 600 }, { now: NOW });
  assert.deepEqual(none, { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 600_000 });
  const stated = tokenPairFromResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 600, refresh_token_expires_in: 86400 }, { now: NOW });
  assert.equal(stated.refreshTokenExpiresAt, NOW + DAY);
  const junk = tokenPairFromResponse({ access_token: 'at', refresh_token_expires_at: 'never' }, { now: NOW });
  assert.equal('refreshTokenExpiresAt' in junk, false);
});

test('a Codex response is read the same way, and has no date unless it states one', () => {
  assert.equal('refreshTokenExpiresAt' in credentialsFromTokenResponse({ access_token: 'at', refresh_token: 'rt' }), false);
  const stated = credentialsFromTokenResponse({ access_token: 'at', refresh_token: 'rt', refresh_token_expires_in: 86400 });
  assert.equal(typeof stated.refreshTokenExpiresAt, 'number');
});

// ── which date a token goes by ──────────────────────────────────────────────

test('a refresh keeps the earlier of the held date and the stated one', () => {
  assert.equal(earlierRefreshTokenExpiry(NOW + 5 * DAY, NOW + 30 * DAY), NOW + 5 * DAY);
  assert.equal(earlierRefreshTokenExpiry(NOW + 30 * DAY, NOW + 5 * DAY), NOW + 5 * DAY);
  assert.equal(earlierRefreshTokenExpiry(NOW + 5 * DAY, undefined), NOW + 5 * DAY);
  assert.equal(earlierRefreshTokenExpiry(null, NOW + 5 * DAY), NOW + 5 * DAY);
  assert.equal(earlierRefreshTokenExpiry(null, 'soon'), null);

  const tokens = { accessToken: 'at', refreshToken: 'rt-2', expiresAt: NOW + H };
  assert.deepEqual(withFamilyExpiry({ refreshTokenExpiresAt: NOW + 5 * DAY }, tokens, NOW), { ...tokens, refreshTokenExpiresAt: NOW + 5 * DAY });
  assert.deepEqual(withFamilyExpiry({}, tokens), tokens, 'no date anywhere: no key');
  assert.equal('refreshTokenExpiresAt' in tokens, false, 'the response object is not written to');
});

test('a different refresh token brings its own date or none; the same one keeps the earlier', () => {
  const held = { refreshToken: 'rt-old', refreshTokenExpiresAt: NOW + 5 * DAY };
  assert.equal(expiryAfterReplacement(held, { refreshToken: 'rt-new', refreshTokenExpiresAt: NOW + 30 * DAY }), NOW + 30 * DAY);
  assert.equal(expiryAfterReplacement(held, { refreshToken: 'rt-new' }), null);
  assert.equal(expiryAfterReplacement(held, { refreshToken: 'rt-old', refreshTokenExpiresAt: NOW + 30 * DAY }), NOW + 5 * DAY);
  assert.equal(expiryAfterReplacement(held, {}), NOW + 5 * DAY, 'an access token alone changes nothing');
});

test('setRefreshTokenExpiry writes a date, and removes the key for anything else', () => {
  assert.deepEqual(setRefreshTokenExpiry({ a: 1 }, NOW), { a: 1, refreshTokenExpiresAt: NOW });
  for (const v of [null, undefined, 'soon', NaN, 0, -1]) {
    assert.deepEqual(setRefreshTokenExpiry({ a: 1, refreshTokenExpiresAt: NOW }, v), { a: 1 });
  }
});

// ── the running account ─────────────────────────────────────────────────────

const due = (over = {}) => ({ name: 'a@example.com', type: 'oauth', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() - 1000, ...over });

/** A manager whose one account is due a refresh, answered by `response`; `handed` is what the listener got. */
function refreshing(entry, response) {
  const am = new AccountManager([entry], 0.98, { refreshFn: async () => response });
  /** @type {Record<string, any>[]} */
  const handed = [];
  am.onTokenRefresh((_idx, tokens) => handed.push(tokens));
  return { am, handed };
}

test('a refresh never pushes the date out, takes an earlier one, and keeps it when none is stated', async () => {
  const held = Date.now() + 6 * DAY;
  const fresh = { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() + 8 * H };

  const later = refreshing(due({ refreshTokenExpiresAt: held }), { ...fresh, refreshTokenExpiresAt: held + 30 * DAY });
  await later.am.ensureTokenFresh(0);
  assert.equal(later.am.accounts[0].refreshToken, 'rt-2');
  assert.equal(later.am.accounts[0].refreshTokenExpiresAt, held);
  assert.equal(later.handed[0].refreshTokenExpiresAt, held, 'what is persisted is the date kept, not the one stated');

  const sooner = refreshing(due({ refreshTokenExpiresAt: held }), { ...fresh, refreshTokenExpiresAt: held - DAY });
  await sooner.am.ensureTokenFresh(0);
  assert.equal(sooner.am.accounts[0].refreshTokenExpiresAt, held - DAY);

  const silent = refreshing(due({ refreshTokenExpiresAt: held }), fresh);
  await silent.am.ensureTokenFresh(0);
  assert.equal(silent.am.accounts[0].refreshTokenExpiresAt, held);
  assert.equal(silent.handed[0].refreshTokenExpiresAt, held);
});

test('an account nobody stated a date for has none, before and after a refresh', async () => {
  const { am, handed } = refreshing(due(), { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() + 8 * H });
  assert.equal(am.accounts[0].refreshTokenExpiresAt, null);
  await am.ensureTokenFresh(0);
  assert.equal(am.accounts[0].refreshTokenExpiresAt, null);
  assert.equal('refreshTokenExpiresAt' in handed[0], false);
  assert.equal('refreshTokenExpiresAt' in am.getStatus().accounts[0], false);
});

test('a token taken from another install is not a rotation: it brings its own date or none', async () => {
  const held = Date.now() + 6 * DAY;
  const theirs = { accessToken: 'at-theirs', refreshToken: 'rt-theirs', expiresAt: Date.now() + 8 * H };

  const dated = refreshing(due({ refreshTokenExpiresAt: held }), null);
  dated.am.setRefreshCoordinator(async () => ({ ...theirs, refreshTokenExpiresAt: held + 20 * DAY }));
  await dated.am.ensureTokenFresh(0);
  assert.equal(dated.am.accounts[0].refreshTokenExpiresAt, held + 20 * DAY);

  const undated = refreshing(due({ refreshTokenExpiresAt: held }), null);
  undated.am.setRefreshCoordinator(async () => theirs);
  await undated.am.ensureTokenFresh(0);
  assert.equal(undated.am.accounts[0].refreshToken, 'rt-theirs');
  assert.equal(undated.am.accounts[0].refreshTokenExpiresAt, null, 'the old token\'s date is not put on another token');
  assert.equal('refreshTokenExpiresAt' in undated.handed[0], false);
});

test('a new sign-in replaces the date, or clears it when it states none', () => {
  const held = Date.now() + 2 * DAY;
  const am = new AccountManager([due({ expiresAt: Date.now() + H, refreshTokenExpiresAt: held })], 0.98);
  /** @type {Record<string, any>[]} */
  const handed = [];
  am.onTokenRefresh((_idx, tokens) => handed.push(tokens));

  am.updateAccountTokens(0, { accessToken: 'at-login', refreshToken: 'rt-login', expiresAt: Date.now() + 8 * H, refreshTokenExpiresAt: held + 28 * DAY });
  assert.equal(am.accounts[0].refreshTokenExpiresAt, held + 28 * DAY);
  assert.equal(handed[0].refreshTokenExpiresAt, held + 28 * DAY);

  am.updateAccountTokens(0, { accessToken: 'at-login-2', refreshToken: 'rt-login-2', expiresAt: Date.now() + 8 * H });
  assert.equal(am.accounts[0].refreshTokenExpiresAt, null);
  assert.equal('refreshTokenExpiresAt' in handed[1], false);
});

// ── persisting it ───────────────────────────────────────────────────────────

test('the date survives a token refresh onto the config entry and the saved row', async () => {
  const held = Date.now() + 6 * DAY;
  const configAccounts = [due({ refreshTokenExpiresAt: held })];
  ensureAccountIds(configAccounts);
  const am = new AccountManager(configAccounts.map(a => ({ ...a })), 0.98, {
    refreshFn: async () => ({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() + 8 * H, refreshTokenExpiresAt: held + 30 * DAY }),
  });
  am.onTokenRefresh((idx, tokens) => syncRefreshedTokens(configAccounts, am.accounts, idx, tokens));
  await am.ensureTokenFresh(0);

  assert.equal(configAccounts[0].refreshToken, 'rt-2');
  assert.equal(configAccounts[0].refreshTokenExpiresAt, held);

  // The TUI save: the live token and its date, over whatever the disk row says.
  const disk = [{ ...configAccounts[0], refreshToken: 'rt-1', refreshTokenExpiresAt: held + 99 * DAY }];
  const [saved] = mergeAccountsForSave(configAccounts, am.accounts, disk);
  assert.equal(saved.refreshToken, 'rt-2');
  assert.equal(saved.refreshTokenExpiresAt, held);
});

test('a date about a token that was replaced is not saved with the new one', () => {
  const configAccounts = [due({ expiresAt: Date.now() + H, refreshTokenExpiresAt: Date.now() + 2 * DAY })];
  ensureAccountIds(configAccounts);
  const am = new AccountManager(configAccounts.map(a => ({ ...a })), 0.98);
  am.onTokenRefresh((idx, tokens) => syncRefreshedTokens(configAccounts, am.accounts, idx, tokens));
  am.updateAccountTokens(0, { accessToken: 'at-login', refreshToken: 'rt-login', expiresAt: Date.now() + 8 * H });

  assert.equal('refreshTokenExpiresAt' in configAccounts[0], false);
  const disk = [{ ...configAccounts[0], refreshTokenExpiresAt: Date.now() + 2 * DAY }];
  const [saved] = mergeAccountsForSave(configAccounts, am.accounts, disk);
  assert.equal(saved.refreshToken, 'rt-login');
  assert.equal('refreshTokenExpiresAt' in saved, false);
});

// ── a reload from disk ──────────────────────────────────────────────────────

/** One account running from `mem`, reloaded against its row with `diskRow` over it (`undefined` removes a key). */
async function reloaded(mem, diskRow) {
  const memAccounts = [mem];
  ensureAccountIds(memAccounts);
  const am = new AccountManager(memAccounts.map(a => ({ ...a })), 0.98);
  const row = JSON.parse(JSON.stringify({ ...memAccounts[0], ...diskRow }));
  await syncAccountsFromDisk({ accounts: [row] }, { accounts: memAccounts }, am);
  return am.accounts[0];
}

test('a reload takes a newer sign-in on disk with its own date, or with none', async () => {
  const at = Date.now();
  const mem = due({ expiresAt: at + H, refreshTokenExpiresAt: at + 2 * DAY });
  const login = { accessToken: 'at-login', refreshToken: 'rt-login', expiresAt: at + 8 * H };

  const dated = await reloaded(mem, { ...login, refreshTokenExpiresAt: at + 30 * DAY });
  assert.equal(dated.refreshToken, 'rt-login');
  assert.equal(dated.refreshTokenExpiresAt, at + 30 * DAY);

  const undated = await reloaded(mem, { ...login, refreshTokenExpiresAt: undefined });
  assert.equal(undated.refreshToken, 'rt-login');
  assert.equal(undated.refreshTokenExpiresAt, null, 'the old token\'s date does not stay on the new one');
});

test('a reload does not let an older copy on disk overwrite the token or its date', async () => {
  const at = Date.now();
  const mem = due({ expiresAt: at + 8 * H, refreshTokenExpiresAt: at + 2 * DAY });
  const kept = await reloaded(mem, { accessToken: 'at-stale', refreshToken: 'rt-stale', expiresAt: at + H, refreshTokenExpiresAt: at + 30 * DAY });
  assert.equal(kept.refreshToken, 'rt-1');
  assert.equal(kept.refreshTokenExpiresAt, at + 2 * DAY);
});

// ── the credential store ────────────────────────────────────────────────────

test('the date travels in the blob with the token it describes, and only as a date', () => {
  const account = { name: 'a@example.com', type: 'oauth', accountUuid: 'u-1', orgUuid: 'o-1', refreshTokenExpiresAt: NOW + 99 * DAY };
  const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 8 * H };

  const dated = encodeBlob(account, { ...tokens, refreshTokenExpiresAt: NOW + 6 * DAY }, { now: NOW, by: 'box' });
  assert.equal(dated.refreshTokenExpiresAt, NOW + 6 * DAY, 'from the tokens, not from the account');
  assert.equal(decodeBlob(JSON.stringify(dated))?.refreshTokenExpiresAt, NOW + 6 * DAY);
  assert.equal(entryFromBlob(dated).refreshTokenExpiresAt, NOW + 6 * DAY);

  const undated = encodeBlob(account, tokens, { now: NOW, by: 'box' });
  assert.equal('refreshTokenExpiresAt' in undated, false);
  assert.equal('refreshTokenExpiresAt' in entryFromBlob(undated), false);

  const junk = decodeBlob(JSON.stringify({ ...dated, refreshTokenExpiresAt: 'soon' }));
  assert.ok(junk);
  assert.equal('refreshTokenExpiresAt' in junk, false);
});

test('a renewal outside the proxy keeps the earlier date too', async () => {
  // This path reads the real clock, and a held date that has passed is dropped.
  const at = Date.now();
  const entry = { name: 'a', type: 'oauth', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: at - 1000, refreshTokenExpiresAt: at + 6 * DAY };
  const renewed = await refreshOutsideProxy(entry, async () => ({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: at + 8 * H, refreshTokenExpiresAt: at + 30 * DAY }), { isSignedIn: async () => false });
  assert.equal(renewed?.refreshTokenExpiresAt, at + 6 * DAY);
});

// ── showing it ──────────────────────────────────────────────────────────────

test('the view counts whole days down, warns inside the window, and says expired past the date', () => {
  assert.equal(refreshTokenExpiryView(undefined, NOW), null);
  assert.equal(refreshTokenExpiryView('soon', NOW), null);

  const far = refreshTokenExpiryView(NOW + 6 * DAY + H, NOW);
  assert.equal(far?.text, `refresh token expires in 6 days (${localDate(NOW + 6 * DAY + H)})`);
  assert.equal(far?.warn, false);

  const edge = refreshTokenExpiryView(NOW + REFRESH_TOKEN_WARN_DAYS * DAY, NOW);
  assert.equal(edge?.warn, true);
  assert.equal(edge?.phrase, `expires in ${REFRESH_TOKEN_WARN_DAYS} days`);
  assert.equal(refreshTokenExpiryView(NOW + REFRESH_TOKEN_WARN_DAYS * DAY + 1, NOW)?.warn, false);

  assert.equal(refreshTokenExpiryView(NOW + DAY + H, NOW)?.phrase, 'expires in 1 day');
  assert.equal(refreshTokenExpiryView(NOW + H, NOW)?.phrase, 'expires in less than a day');

  const past = refreshTokenExpiryView(NOW - 3 * DAY, NOW);
  assert.equal(past?.expired, true);
  assert.equal(past?.warn, true);
  assert.equal(past?.text, `refresh token expired (${localDate(NOW - 3 * DAY)})`);
  assert.doesNotMatch(String(past?.text), /-\d+ day/);
});

/** `teamclaude status` for one account. */
function statusText(account) {
  const status = {
    currentAccount: 'a', switchThreshold: 0.98,
    accounts: [{ name: 'a', type: 'oauth', priority: 0, status: 'active', quota: {}, usage: {}, ...account }],
  };
  return renderStatus(status, { color: false, now: NOW });
}

test('status shows a Login row only for an account with a known date', () => {
  assert.doesNotMatch(statusText({}), /Login|refresh token/);
  assert.doesNotMatch(statusText({ refreshTokenExpiresAt: 'soon' }), /Login|refresh token/);

  const far = statusText({ refreshTokenExpiresAt: NOW + 20 * DAY });
  assert.match(far, new RegExp(`Login\\s+refresh token expires in 20 days \\(${localDate(NOW + 20 * DAY)}\\)$`, 'm'));
  assert.doesNotMatch(far, /teamclaude login/, 'outside the window it is a fact, not a call to act');
});

test('status warns inside the window with the command for the provider, and says expired past the date', () => {
  const soon = statusText({ refreshTokenExpiresAt: NOW + 3 * DAY });
  assert.match(soon, /Login\s+refresh token expires in 3 days \(\d{4}-\d\d-\d\d\) — run: teamclaude login$/m);
  assert.match(statusText({ provider: 'codex', refreshTokenExpiresAt: NOW + 3 * DAY }), /— run: teamclaude login --codex$/m);

  const past = statusText({ refreshTokenExpiresAt: NOW - 2 * DAY });
  assert.match(past, /Login\s+refresh token expired \(\d{4}-\d\d-\d\d\) — run: teamclaude login$/m);

  // Colour is the warning idiom: yellow inside the window, none outside it.
  const paint = (account) => renderStatus({ accounts: [{ name: 'a', type: 'oauth', status: 'active', quota: {}, usage: {}, ...account }] }, { color: true, now: NOW })
    .split('\n').find(l => l.includes('refresh token')) ?? '';
  assert.match(paint({ refreshTokenExpiresAt: NOW + 3 * DAY }), /\x1b\[33mrefresh token/);
  assert.doesNotMatch(paint({ refreshTokenExpiresAt: NOW + 20 * DAY }), /\x1b\[33m/);
});

test('an account already out as error keeps to its own line', () => {
  const account = { status: 'error', refreshTokenExpiresAt: NOW - DAY };
  assert.equal(accountRefreshTokenExpiry(account, NOW), null);
  assert.doesNotMatch(statusText(account), /Login\s+refresh token/);
});

test('status --json carries the date as a plain number, and no key without one', () => {
  const at = Date.now() + 9 * DAY;
  const am = new AccountManager([
    due({ name: 'dated', expiresAt: Date.now() + H, refreshTokenExpiresAt: at }),
    due({ name: 'undated', accessToken: 'at-u', expiresAt: Date.now() + H }),
    due({ name: 'junk', accessToken: 'at-j', expiresAt: Date.now() + H, refreshTokenExpiresAt: 'soon' }),
  ], 0.98);
  const [dated, undated, junk] = JSON.parse(JSON.stringify(am.getStatus())).accounts;
  assert.equal(dated.refreshTokenExpiresAt, at);
  assert.equal('refreshTokenExpiresAt' in undated, false);
  assert.equal('refreshTokenExpiresAt' in junk, false);
});

// ── the TUI ─────────────────────────────────────────────────────────────────

const strip = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The frame's account list, one string per drawn line. */
function listed(am) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  let buf = '';
  try {
    tui._paint = (/** @type {string} */ b) => { buf = b; };
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

test('the TUI draws a line under the row once the date is close, and none before', () => {
  assert.equal(refreshTokenExpiryWarning({ refreshTokenExpiresAt: NOW + 20 * DAY }, NOW), null);
  assert.equal(refreshTokenExpiryWarning({}, NOW), null);
  assert.match(String(refreshTokenExpiryWarning({ provider: 'codex', refreshTokenExpiresAt: NOW + 2 * DAY + H }, NOW)),
    /^refresh token expires in 2 days \(\d{4}-\d\d-\d\d\) — run: teamclaude login --codex$/);

  // Hours of margin on each side of the window, so the wall clock cannot move a row across it.
  const at = Date.now();
  const am = new AccountManager([
    due({ name: 'soon@x.com', expiresAt: at + H, refreshTokenExpiresAt: at + 2 * DAY + 12 * H }),
    due({ name: 'later@x.com', accessToken: 'at-l', expiresAt: at + H, refreshTokenExpiresAt: at + 20 * DAY }),
    due({ name: 'unknown@x.com', accessToken: 'at-u', expiresAt: at + H }),
  ], 0.98);
  const lines = listed(am);
  const soon = lines.findIndex(l => l.includes('soon@x.com'));
  assert.match(lines[soon + 1], /refresh token expires in 2 days \(\d{4}-\d\d-\d\d\) — run: teamclaude login/);
  assert.equal(lines.filter(l => l.includes('refresh token')).length, 1, 'only the account inside the window gets a line');
});

// ── the log line ────────────────────────────────────────────────────────────

test('the server logs one line per account per day while a known date is close', () => {
  let clock = NOW;
  /** @type {string[]} */
  const logged = [];
  const warn = createRefreshTokenExpiryWarner({ log: (l) => logged.push(l), now: () => clock });
  const accounts = [
    { id: 'a', name: 'soon@x.com', type: 'oauth', status: 'active', refreshTokenExpiresAt: NOW + 3 * DAY + H },
    { id: 'b', name: 'later@x.com', type: 'oauth', status: 'active', refreshTokenExpiresAt: NOW + 20 * DAY },
    { id: 'c', name: 'unknown@x.com', type: 'oauth', status: 'active' },
    { id: 'd', name: 'codex@x.com', type: 'oauth', provider: 'codex', status: 'active', refreshTokenExpiresAt: NOW + DAY + H },
    { id: 'e', name: 'off@x.com', type: 'oauth', status: 'active', disabled: true, refreshTokenExpiresAt: NOW + DAY },
    { id: 'f', name: 'dead@x.com', type: 'oauth', status: 'error', refreshTokenExpiresAt: NOW + DAY },
    { id: 'g', name: 'key', type: 'apikey', status: 'active', refreshTokenExpiresAt: NOW + DAY },
  ];

  assert.deepEqual(warn(accounts), [
    '[TeamClaude] Account "soon@x.com": its refresh token expires in 3 days — run: teamclaude login',
    '[TeamClaude] Account "codex@x.com": its refresh token expires in 1 day — run: teamclaude login --codex',
  ]);
  assert.equal(logged.length, 2);

  // The tick runs every minute; the line does not.
  for (let i = 0; i < 60; i++) { clock += 60_000; warn(accounts); }
  clock = NOW + DAY - 1;
  warn(accounts);
  assert.equal(logged.length, 2);

  clock = NOW + DAY;
  assert.deepEqual(warn(accounts), [
    '[TeamClaude] Account "soon@x.com": its refresh token expires in 2 days — run: teamclaude login',
    '[TeamClaude] Account "codex@x.com": its refresh token expires in less than a day — run: teamclaude login --codex',
  ]);

  // Past the date and still in rotation: "expired", not a negative count.
  clock = NOW + 4 * DAY;
  assert.deepEqual(warn(accounts), [
    '[TeamClaude] Account "soon@x.com": its refresh token expired — run: teamclaude login',
    '[TeamClaude] Account "codex@x.com": its refresh token expired — run: teamclaude login --codex',
  ]);
});

test('the log line follows the account: a new sign-in ends it, a name cannot break it', () => {
  let clock = NOW;
  const warn = createRefreshTokenExpiryWarner({ log: () => {}, now: () => clock });
  const account = { id: 'a', name: 'evil\x1b[2J\nname', type: 'oauth', status: 'active', refreshTokenExpiresAt: NOW + DAY };
  const [line] = warn([account]);
  assert.doesNotMatch(line, /[\x1b\n]/);

  // Signed in again: the date moved out, or is no longer known.
  clock += DAY;
  assert.deepEqual(warn([{ ...account, refreshTokenExpiresAt: NOW + 30 * DAY }]), []);
  assert.deepEqual(warn([{ ...account, refreshTokenExpiresAt: null }]), []);
});

test('a refresh that succeeds after the held date drops that date', () => {
  const now = Date.UTC(2026, 10, 16);
  const day = 24 * 3600_000;
  const tokens = { accessToken: 'a', refreshToken: 'r2', expiresAt: now + 3600_000 };
  assert.equal(withFamilyExpiry({ refreshTokenExpiresAt: now - day }, tokens, now).refreshTokenExpiresAt, undefined);
  assert.equal(withFamilyExpiry({ refreshTokenExpiresAt: now - day }, { ...tokens, refreshTokenExpiresAt: now + 30 * day }, now).refreshTokenExpiresAt, now + 30 * day);
  // A date still ahead is kept against a later one, as before.
  assert.equal(withFamilyExpiry({ refreshTokenExpiresAt: now + day }, { ...tokens, refreshTokenExpiresAt: now + 30 * day }, now).refreshTokenExpiresAt, now + day);
});

test('a stored value that is not epoch milliseconds is not a date', () => {
  for (const bad of [1796083200, 1e300, 8.64e15 + 1, -1, NaN, '1796083200000']) assert.equal(knownRefreshTokenExpiry(bad), null, String(bad));
  assert.equal(knownRefreshTokenExpiry(1796083200000), 1796083200000);
});
