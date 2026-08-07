import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCredentials } from '../src/oauth.js';

const CREDS = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1754500000000 };

async function tmpHome() {
  return mkdtemp(join(tmpdir(), 'tc-import-'));
}

test('reads nested claudeAiOauth credentials from file', async () => {
  const home = await tmpHome();
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: CREDS }));

  const creds = await importCredentials('~/.claude/.credentials.json', { home, platform: 'darwin' });
  assert.equal(creds.accessToken, 'at');
  assert.equal(creds.refreshToken, 'rt');
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
