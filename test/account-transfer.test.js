import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectExportAccounts, createBundle, openBundle, mergeImportedAccounts, checkBundle, isEncryptedBundle, TransferError,
  invalidAccount, changedSinceExport, writePrivateFile, BUNDLE_FORMAT, BUNDLE_VERSION,
} from '../src/account-transfer.js';

// A cheap scrypt cost so the suite does not pay for the real one per test.
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

const claude = (over = {}) => ({
  id: 'id-claude', name: 'demo-a@example.com', type: 'oauth', source: 'login',
  accountUuid: 'uuid-a', orgUuid: 'org-a', orgName: 'Demo Org', email: 'demo-a@example.com',
  accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: 2000, priority: 1,
  routing: 'socks5h://user:pass@proxy.example:1080',
  ...over,
});
const codex = (over = {}) => ({
  id: 'id-codex', name: 'demo-b@example.com', type: 'oauth', provider: 'codex',
  accountId: 'acct-b', userId: 'user-b', accessToken: 'cx-at', refreshToken: 'cx-rt', expiresAt: 3000,
  ...over,
});
const apikey = (over = {}) => ({ id: 'id-key', name: 'key-demo', type: 'apikey', apiKey: 'sk-demo-1', priority: 100, ...over });

test('export drops the machine-local fields and keeps credentials and settings', async () => {
  const { accounts, ids, skipped } = await collectExportAccounts([claude(), codex(), apikey()]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(ids, ['id-claude', 'id-codex', 'id-key']);
  assert.equal(accounts.length, 3);
  for (const a of accounts) {
    for (const k of ['id', 'source', 'importFrom', 'routing']) assert.equal(k in a, false, `${a.name} kept ${k}`);
  }
  assert.equal(accounts[0].refreshToken, 'rt-a');
  assert.equal(accounts[0].priority, 1);
  assert.equal(accounts[2].apiKey, 'sk-demo-1');
});

test('export inlines a file-backed login and skips one whose file cannot be read', async () => {
  const readClaude = async (/** @type {string} */ path) => {
    if (path === '/missing') throw new Error('ENOENT');
    return { accessToken: 'file-at', refreshToken: 'file-rt', expiresAt: 5000 };
  };
  const readCodex = async () => ({ accessToken: 'cli-at', refreshToken: 'cli-rt', accountId: 'acct-c', email: undefined });
  const { accounts, fileBacked, skipped } = await collectExportAccounts([
    { name: 'from-file', type: 'oauth', importFrom: '~/.claude/.credentials.json' },
    { name: 'broken', type: 'oauth', importFrom: '/missing' },
    { name: 'codex-default', type: 'oauth', provider: 'codex' },
  ], { readClaude, readCodex });
  assert.deepEqual(fileBacked, ['from-file', 'codex-default']);
  assert.deepEqual(skipped.map(s => s.name), ['broken']);
  assert.equal(accounts[0].accessToken, 'file-at');
  assert.equal('importFrom' in accounts[0], false);
  assert.equal(accounts[1].accountId, 'acct-c');
  assert.equal('email' in accounts[1], false, 'an absent claim is not written as undefined');
});

test('an encrypted bundle round-trips with the passphrase and hides the tokens', async () => {
  const { accounts } = await collectExportAccounts([claude(), codex()]);
  const bundle = await createBundle(accounts, 'correct horse', { kdf: FAST_KDF });
  assert.equal(bundle.format, BUNDLE_FORMAT);
  assert.equal(bundle.v, BUNDLE_VERSION);
  assert.equal(isEncryptedBundle(bundle), true);
  const text = JSON.stringify(bundle);
  for (const secret of ['at-a', 'rt-a', 'cx-rt', 'demo-a@example.com']) assert.equal(text.includes(secret), false, `${secret} is readable`);
  assert.deepEqual(await openBundle(bundle, 'correct horse'), accounts);
});

test('a wrong passphrase or an edited header is refused', async () => {
  const bundle = await createBundle([claude()], 'correct horse', { kdf: FAST_KDF });
  await assert.rejects(openBundle(bundle, 'wrong horse'), TransferError);
  await assert.rejects(openBundle({ ...bundle, count: 99 }, 'correct horse'), /Wrong passphrase, or the file was changed/);
  await assert.rejects(openBundle(bundle, null), /passphrase is needed/);
});

test('a file asking for an absurd scrypt cost is refused before deriving', async () => {
  const bundle = await createBundle([claude()], 'correct horse', { kdf: FAST_KDF });
  const hostile = { ...bundle, encryption: { ...bundle.encryption, N: 2 ** 30 } };
  await assert.rejects(openBundle(hostile, 'correct horse'), /out of range/);
});

test('a plain bundle opens without a passphrase; other files are refused', async () => {
  const bundle = await createBundle([apikey()], null);
  assert.equal(isEncryptedBundle(bundle), false);
  assert.equal((await openBundle(bundle, null))[0].apiKey, 'sk-demo-1');
  assert.throws(() => checkBundle({ accounts: [] }), /Not a TeamClaude account export/);
  assert.throws(() => checkBundle({ format: BUNDLE_FORMAT, v: 99 }), /format version 99/);
});

test('import adds new accounts without their machine-local fields', () => {
  const config = { accounts: [] };
  const res = mergeImportedAccounts(config, [claude(), codex()]);
  assert.deepEqual(res.added, ['demo-a@example.com', 'demo-b@example.com']);
  assert.equal(config.accounts[0].source, 'transfer');
  assert.equal('routing' in config.accounts[0], false);
  assert.equal('id' in config.accounts[0], false, 'loadConfig mints the id, as for any other new entry');
});

test('import replaces a login only with a newer one, keeping this machine\'s settings', () => {
  const config = { accounts: [claude({ id: 'local', name: 'renamed here', priority: 7, expiresAt: 2000, accessToken: 'old', refreshToken: 'old-rt' })] };
  const older = mergeImportedAccounts(config, [claude({ expiresAt: 1000, accessToken: 'older' })]);
  assert.equal(older.skipped[0].name, 'renamed here');
  assert.match(older.skipped[0].reason, /newer login/);
  assert.equal(config.accounts[0].accessToken, 'old');

  const newer = mergeImportedAccounts(config, [claude({ expiresAt: 9000, accessToken: 'new', refreshToken: 'new-rt', priority: 1 })]);
  assert.deepEqual(newer.updated, ['renamed here']);
  const a = config.accounts[0];
  assert.equal(a.accessToken, 'new');
  assert.equal(a.refreshToken, 'new-rt');
  assert.equal(a.expiresAt, 9000);
  assert.equal(a.id, 'local');
  assert.equal(a.name, 'renamed here');
  assert.equal(a.priority, 7);
  assert.equal(a.routing, 'socks5h://user:pass@proxy.example:1080');
});

test('--force replaces an older login; the same login is up to date', () => {
  const config = { accounts: [claude({ expiresAt: 5000, accessToken: 'mine' })] };
  assert.equal(mergeImportedAccounts(config, [claude({ expiresAt: 5000, accessToken: 'mine' })]).skipped[0].reason, 'already up to date');
  assert.deepEqual(mergeImportedAccounts(config, [claude({ expiresAt: 1000, accessToken: 'theirs' })], { force: true }).updated, ['demo-a@example.com']);
  assert.equal(config.accounts[0].accessToken, 'theirs');
});

test('import leaves a file-backed entry alone, and fills a Codex entry that reads the CLI file', () => {
  const config = { accounts: [
    claude({ importFrom: '~/.claude/.credentials.json', accessToken: undefined, refreshToken: undefined, expiresAt: undefined }),
    { name: 'codex-here', type: 'oauth', provider: 'codex', accountId: 'acct-b', userId: 'user-b' },
  ] };
  const res = mergeImportedAccounts(config, [claude(), codex()]);
  assert.match(res.skipped[0].reason, /reads its login from/);
  assert.deepEqual(res.updated, ['codex-here']);
  assert.equal(config.accounts[1].accessToken, 'cx-at');
});

test('an API key that differs is not replaced without --force', () => {
  const config = { accounts: [apikey({ apiKey: 'sk-demo-2' })] };
  const res = mergeImportedAccounts(config, [apikey()]);
  assert.match(res.skipped[0].reason, /different login/);
  assert.equal(config.accounts[0].apiKey, 'sk-demo-2');
});

test('a different account with a taken name gets a free one', () => {
  const config = { accounts: [claude({ orgUuid: 'org-other', orgName: 'Other Org' })] };
  const res = mergeImportedAccounts(config, [claude()]);
  assert.deepEqual(res.added, ['demo-a@example.com (Demo Org)']);
  assert.equal(config.accounts.length, 2);
});

test('a truncated GCM tag is refused, not accepted as a shorter one', async () => {
  const bundle = await createBundle([claude()], 'correct horse', { kdf: FAST_KDF });
  const short = Buffer.from(bundle.encryption.tag, 'base64').subarray(0, 4).toString('base64');
  await assert.rejects(openBundle({ ...bundle, encryption: { ...bundle.encryption, tag: short } }, 'correct horse'), TransferError);
});

test('a record that is not a usable account refuses the whole file', async () => {
  assert.equal(invalidAccount(claude()), null);
  assert.equal(invalidAccount(apikey()), null);
  assert.match(String(invalidAccount(apikey({ apiKey: { nested: true } }))), /API key/);
  assert.match(String(invalidAccount({ name: 'x', type: 'weird', accessToken: 't' })), /unknown account type/);
  assert.match(String(invalidAccount(claude({ accessToken: undefined }))), /access token/);
  assert.match(String(invalidAccount(claude({ expiresAt: 'soon' }))), /expiresAt/);
  assert.match(String(invalidAccount(claude({ orgUuid: 42 }))), /orgUuid/);
  const bundle = await createBundle([claude(), apikey({ apiKey: { nested: true } })], null);
  await assert.rejects(openBundle(bundle, null), /#2 "key-demo": no API key/);
});

test('export leaves out a record the import side would refuse', async () => {
  const { accounts, skipped } = await collectExportAccounts([claude(), { name: 'odd', type: 'weird', accessToken: 't' }]);
  assert.deepEqual(accounts.map(a => a.name), ['demo-a@example.com']);
  assert.match(skipped[0].reason, /unknown account type/);
});

test('an OAuth login and an API key under one name stay two accounts, both ways', () => {
  const keyHere = { accounts: [apikey({ name: 'shared' })] };
  const r1 = mergeImportedAccounts(keyHere, [claude({ name: 'shared', accountUuid: undefined, orgUuid: undefined })], { force: true });
  assert.deepEqual(r1.added, ['shared (Demo Org)']);
  assert.equal(keyHere.accounts[0].apiKey, 'sk-demo-1');
  assert.equal('accessToken' in keyHere.accounts[0], false);

  const oauthHere = { accounts: [claude({ name: 'shared' })] };
  const r2 = mergeImportedAccounts(oauthHere, [apikey({ name: 'shared' })], { force: true });
  assert.deepEqual(r2.added, ['shared (2)']);
  assert.equal(oauthHere.accounts[0].type, 'oauth');
  assert.equal('apiKey' in oauthHere.accounts[0], false);
  assert.equal(oauthHere.accounts[1].type, 'apikey');
});

test('changedSinceExport names a login renewed after the snapshot', async () => {
  const { accounts, ids } = await collectExportAccounts([claude(), codex()]);
  assert.deepEqual(changedSinceExport(accounts, ids, [claude(), codex()]), []);
  assert.deepEqual(changedSinceExport(accounts, ids, [claude({ refreshToken: 'rotated' }), codex()]), ['demo-a@example.com']);
  assert.deepEqual(changedSinceExport(accounts, ids, [codex()]), ['demo-a@example.com'], 'a row gone since is changed too');
});

test('writePrivateFile never replaces a file without force, and with it replaces a 0644 one at 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-private-'));
  const path = join(dir, 'export.json');
  await writeFile(path, 'old', { mode: 0o644 });
  await assert.rejects(writePrivateFile(path, 'new'), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), 'old');
  await writePrivateFile(path, 'new', { force: true });
  assert.equal(await readFile(path, 'utf8'), 'new');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ['export.json'], 'no temporary file is left behind');
});

test('two backends sharing a name stay apart unless they are the same service', () => {
  const deepseek = { name: 'fallback', type: 'oauth', upstream: 'https://api.deepseek.com/anthropic', accessToken: 'ds-key' };
  const zai = { name: 'fallback', type: 'oauth', upstream: 'https://api.z.ai/api/anthropic', accessToken: 'zai-key' };
  const config = { accounts: [{ ...deepseek }] };
  const res = mergeImportedAccounts(config, [zai], { force: true });
  assert.deepEqual(res.added, ['fallback (2)']);
  assert.equal(config.accounts[0].accessToken, 'ds-key', 'the DeepSeek key is not replaced by the z.ai one');
  assert.equal(config.accounts[1].upstream, zai.upstream);

  const same = mergeImportedAccounts(config, [{ ...deepseek, upstream: 'https://API.DeepSeek.com/anthropic/', accessToken: 'ds-key-2' }], { force: true });
  assert.deepEqual(same.updated, ['fallback'], 'host case and a trailing slash are the same service');
  assert.equal(config.accounts[0].accessToken, 'ds-key-2');
});

test('a setting with the wrong shape refuses the file; fields this version does not know stay behind', async () => {
  assert.match(String(invalidAccount(claude({ models: { bad: true } }))), /models has the wrong shape/);
  assert.match(String(invalidAccount(claude({ modelMap: { a: 1 } }))), /modelMap/);
  assert.match(String(invalidAccount(claude({ switchThreshold: 'high' }))), /switchThreshold/);
  assert.match(String(invalidAccount(claude({ stripRequestFields: 'context_management' }))), /stripRequestFields/);
  assert.equal(invalidAccount(claude({ switchThreshold: { default: 0.9, unified7d: 0.8 }, models: ['claude-x'], modelMap: { a: 'b' } })), null);
  await assert.rejects(openBundle(await createBundle([claude({ models: { bad: true } })], null), null), /models has the wrong shape/);

  const { accounts } = await collectExportAccounts([claude({ someFutureField: { x: 1 } })]);
  assert.equal('someFutureField' in accounts[0], false);
  const config = { accounts: [] };
  mergeImportedAccounts(config, [{ ...claude(), someFutureField: 1 }]);
  assert.equal('someFutureField' in config.accounts[0], false);
});

const DAY = 24 * 3600_000;
const credit = { amount: 200, currency: 'USD', cycleStart: '2026-11-02' };

test('an end time, a cordon, a credit and the refresh-token expiry travel to a new machine', async () => {
  const lapses = Date.now() + 20 * DAY;
  const { accounts, skipped } = await collectExportAccounts([
    claude({ endsAt: '2026-12-01', cordoned: true, refreshTokenExpiresAt: lapses }),
    apikey({ endsAt: Date.now() + 9 * DAY, credit }),
  ]);
  assert.deepEqual(skipped, []);
  const config = { accounts: [] };
  mergeImportedAccounts(config, accounts);
  const [a, k] = config.accounts;
  assert.equal(a.endsAt, '2026-12-01');
  assert.equal(a.cordoned, true);
  assert.equal(a.refreshTokenExpiresAt, lapses);
  assert.equal(typeof k.endsAt, 'number');
  assert.deepEqual(k.credit, credit);
});

test('a replacement login takes its own refresh-token expiry, or none, and leaves this machine\'s settings', () => {
  const held = Date.now() + 2 * DAY;
  const here = () => claude({ id: 'local', expiresAt: 2000, refreshTokenExpiresAt: held, endsAt: '2027-01-01', cordoned: true });
  const config = { accounts: [here()] };
  mergeImportedAccounts(config, [claude({ expiresAt: 9000, accessToken: 'new', refreshToken: 'new-rt', endsAt: '2026-12-01', cordoned: false })]);
  const a = config.accounts[0];
  assert.equal(a.refreshToken, 'new-rt');
  assert.equal('refreshTokenExpiresAt' in a, false, 'the old token\'s expiry is not carried onto the new one');
  assert.equal(a.endsAt, '2027-01-01');
  assert.equal(a.cordoned, true);

  const stated = Date.now() + 28 * DAY;
  const again = { accounts: [here()] };
  mergeImportedAccounts(again, [claude({ expiresAt: 9000, accessToken: 'new', refreshToken: 'new-rt', refreshTokenExpiresAt: stated })]);
  assert.equal(again.accounts[0].refreshTokenExpiresAt, stated);
});

test('a file-backed export takes the refresh-token expiry from the file, not the entry', async () => {
  const stale = Date.now() + 1 * DAY;
  const fromFile = Date.now() + 25 * DAY;
  const row = { name: 'from-file', type: 'oauth', importFrom: '~/.claude/.credentials.json', refreshTokenExpiresAt: stale };
  const without = await collectExportAccounts([row], { readClaude: async () => ({ accessToken: 'file-at', refreshToken: 'file-rt', expiresAt: 5000 }) });
  assert.equal('refreshTokenExpiresAt' in without.accounts[0], false);
  const withDate = await collectExportAccounts([row], { readClaude: async () => ({ accessToken: 'file-at', refreshToken: 'file-rt', expiresAt: 5000, refreshTokenExpiresAt: fromFile }) });
  assert.equal(withDate.accounts[0].refreshTokenExpiresAt, fromFile);
});

test('the new fields are shape-checked like the others', () => {
  assert.match(String(invalidAccount(claude({ endsAt: { at: 1 } }))), /endsAt/);
  assert.match(String(invalidAccount(claude({ cordoned: 'yes' }))), /cordoned/);
  assert.match(String(invalidAccount(apikey({ credit: 200 }))), /credit/);
  assert.match(String(invalidAccount(claude({ refreshTokenExpiresAt: 'soon' }))), /refreshTokenExpiresAt/);
});

test('a newer access token on the same refresh token keeps the earlier known expiry', () => {
  const held = Date.now() + 2 * DAY;
  const here = () => claude({ id: 'local', expiresAt: 2000, refreshTokenExpiresAt: held });
  const omitted = { accounts: [here()] };
  mergeImportedAccounts(omitted, [claude({ expiresAt: 9000, accessToken: 'new' })]);
  assert.equal(omitted.accounts[0].refreshTokenExpiresAt, held, 'a bundle that states no date does not clear it');
  const later = { accounts: [here()] };
  mergeImportedAccounts(later, [claude({ expiresAt: 9000, accessToken: 'new', refreshTokenExpiresAt: held + 20 * DAY })]);
  assert.equal(later.accounts[0].refreshTokenExpiresAt, held, 'a later date for the same token does not extend it');
});
