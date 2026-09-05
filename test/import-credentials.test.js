import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCredentials, readKeychainCredentials } from '../src/oauth.js';

const CREDS = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1754500000000 };

async function tmpHome() {
  return mkdtemp(join(tmpdir(), 'tc-import-'));
}

test('reads nested claudeAiOauth credentials from file', async () => {
  const home = await tmpHome();
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: CREDS }));
  const readKeychain = async () => { throw new Error('no keychain here'); };

  const creds = await importCredentials('~/.claude/.credentials.json', { home, platform: 'darwin', readKeychain });
  assert.equal(creds.accessToken, 'at');
  assert.equal(creds.refreshToken, 'rt');
  assert.equal('refreshTokenExpiresAt' in creds, false, 'absent in the source, absent in the result');
});

test('passes refreshTokenExpiresAt through when the source carries it', async () => {
  const home = await tmpHome();
  await writeFile(join(home, 'creds.json'), JSON.stringify({ ...CREDS, refreshTokenExpiresAt: 1760000000000 }));

  const creds = await importCredentials(join(home, 'creds.json'), { home, platform: 'linux' });
  assert.equal(creds.refreshTokenExpiresAt, 1760000000000);
});

test('reads flat credentials from file', async () => {
  const home = await tmpHome();
  await writeFile(join(home, 'creds.json'), JSON.stringify(CREDS));

  const creds = await importCredentials(join(home, 'creds.json'), { home, platform: 'linux' });
  assert.equal(creds.accessToken, 'at');
});

test('falls back to Keychain on macOS when default file is missing', async () => {
  const home = await tmpHome();
  let called = 0;
  const readKeychain = async () => { called++; return { claudeAiOauth: CREDS }; };

  const creds = await importCredentials('~/.claude/.credentials.json', { home, platform: 'darwin', readKeychain });
  assert.equal(called, 1);
  assert.equal(creds.accessToken, 'at');
  assert.equal(creds.expiresAt, CREDS.expiresAt);
});

// On macOS the Keychain is Claude Code's live store; the default file, when it
// exists, is a snapshot from an earlier login that nothing keeps fresh.

test('prefers the Keychain over a stale default file on macOS', async () => {
  const home = await tmpHome();
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'stale', refreshToken: 'stale-rt', expiresAt: 1 },
  }));
  const readKeychain = async () => ({ claudeAiOauth: { ...CREDS, accessToken: 'fresh' } });

  const creds = await importCredentials('~/.claude/.credentials.json', { home, platform: 'darwin', readKeychain });
  assert.equal(creds.accessToken, 'fresh');
  assert.equal(creds.expiresAt, CREDS.expiresAt);
});

test('uses the default file on macOS when the Keychain carries no token', async () => {
  const home = await tmpHome();
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: CREDS }));
  const readKeychain = async () => ({ claudeAiOauth: { accessToken: '', refreshToken: '' } });

  const creds = await importCredentials('~/.claude/.credentials.json', { home, platform: 'darwin', readKeychain });
  assert.equal(creds.accessToken, 'at');
});

test('uses the default file on macOS when the Keychain lookup throws', async () => {
  const home = await tmpHome();
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: CREDS }));
  const readKeychain = async () => { throw new Error('item not found in keychain'); };

  const creds = await importCredentials('~/.claude/.credentials.json', { home, platform: 'darwin', readKeychain });
  assert.equal(creds.accessToken, 'at');
});

test('hands back a token-less Keychain payload when the default file is missing too', async () => {
  const home = await tmpHome();
  const readKeychain = async () => ({ claudeAiOauth: { accessToken: '', refreshToken: '' } });

  const creds = await importCredentials('~/.claude/.credentials.json', { home, platform: 'darwin', readKeychain });
  assert.equal(creds.accessToken, '');
});

test('a non-ENOENT file error on macOS is reported as-is', async () => {
  const home = await tmpHome();
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), '{not json');
  const readKeychain = async () => { throw new Error('item not found in keychain'); };

  await assert.rejects(
    importCredentials('~/.claude/.credentials.json', { home, platform: 'darwin', readKeychain }),
    SyntaxError,
  );
});

test('does not touch Keychain on non-macOS platforms', async () => {
  const home = await tmpHome();
  let called = 0;
  const readKeychain = async () => { called++; return { claudeAiOauth: CREDS }; };

  await assert.rejects(
    importCredentials('~/.claude/.credentials.json', { home, platform: 'linux', readKeychain }),
    (err) => err.code === 'ENOENT',
  );
  assert.equal(called, 0);
});

test('does not touch Keychain for a non-default path on macOS', async () => {
  const home = await tmpHome();
  let called = 0;
  const readKeychain = async () => { called++; return { claudeAiOauth: CREDS }; };

  await assert.rejects(
    importCredentials(join(home, 'other.json'), { home, platform: 'darwin', readKeychain }),
    (err) => err.code === 'ENOENT',
  );
  assert.equal(called, 0);
});

test('reports both file and Keychain failure when fallback fails', async () => {
  const home = await tmpHome();
  const readKeychain = async () => { throw new Error('item not found in keychain'); };

  await assert.rejects(
    importCredentials('~/.claude/.credentials.json', { home, platform: 'darwin', readKeychain }),
    /Keychain.*item not found in keychain/,
  );
});

// The Keychain service name is not unique — a stray acct="unknown" item can sit
// alongside the real one, and a service-only lookup may return either.

test('keychain lookup asks for the current user\'s item first', async () => {
  const calls = [];
  const exec = async (_bin, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ claudeAiOauth: CREDS }) };
  };

  const raw = await readKeychainCredentials({ exec, username: 'ada' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'ada', '-w']);
  assert.equal(raw.claudeAiOauth.accessToken, 'at');
});

test('skips an item that carries no credentials', async () => {
  const exec = async (_bin, args) => ({
    stdout: JSON.stringify(args.includes('-a') ? { claudeAiOauth: CREDS } : { mcpOAuth: {} }),
  });

  const raw = await readKeychainCredentials({ exec, username: 'ada' });
  assert.equal(raw.claudeAiOauth.accessToken, 'at');
});

test('skips an item whose credentials are blank', async () => {
  const exec = async (_bin, args) => ({
    stdout: JSON.stringify(args.includes('-a')
      ? { claudeAiOauth: { accessToken: '', refreshToken: '' } }
      : { claudeAiOauth: CREDS }),
  });

  const raw = await readKeychainCredentials({ exec, username: 'ada' });
  assert.equal(raw.claudeAiOauth.accessToken, 'at');
});

test('falls back to the service-only lookup when the account-scoped one misses', async () => {
  const tried = [];
  const exec = async (_bin, args) => {
    const scoped = args.includes('-a');
    tried.push(scoped ? 'scoped' : 'service');
    if (scoped) throw new Error('SecKeychainSearchCopyNext: The specified item could not be found');
    return { stdout: JSON.stringify({ claudeAiOauth: CREDS }) };
  };

  const raw = await readKeychainCredentials({ exec, username: 'ada' });
  assert.deepEqual(tried, ['scoped', 'service']);
  assert.equal(raw.claudeAiOauth.accessToken, 'at');
});

test('uses the service-only lookup when there is no username to scope to', async () => {
  const calls = [];
  const exec = async (_bin, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ claudeAiOauth: CREDS }) };
  };

  await readKeychainCredentials({ exec, username: null });
  assert.deepEqual(calls, [['find-generic-password', '-s', 'Claude Code-credentials', '-w']]);
});

test('surfaces the Keychain error when every lookup fails', async () => {
  const exec = async () => { throw new Error('item not found in keychain'); };

  await assert.rejects(
    readKeychainCredentials({ exec, username: 'ada' }),
    /item not found in keychain/,
  );
});
