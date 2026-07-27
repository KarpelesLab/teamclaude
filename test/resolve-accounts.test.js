import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAccounts } from '../src/resolve-accounts.js';

const HOUR = 3600_000;

// Write a Claude Code credentials file and return its path.
async function credsFile(dir, name, data) {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify({ claudeAiOauth: data }));
  return path;
}

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-resolve-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The regression. An importFrom account used to be rebuilt from scratch as
// { name, type, ...creds }, so every other field configured on it was dropped
// on the floor at startup — most damagingly `disabled`, which meant an account
// switched off on disk quietly rejoined rotation on the next restart.
test('importFrom preserves the account fields that are not credentials', async () => {
  await withTmp(async dir => {
    const path = await credsFile(dir, 'creds.json', {
      accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + HOUR,
    });

    const [acct] = await resolveAccounts({
      accounts: [{
        name: 'work',
        type: 'oauth',
        importFrom: path,
        disabled: true,
        priority: 3,
        upstream: 'https://api.deepseek.com/anthropic',
        modelMap: { 'claude-sonnet-4-6': 'deepseek-v4-pro' },
        models: ['deepseek-v4-pro'],
        orgUuid: 'org-1',
      }],
    });

    // Credentials come from the file...
    assert.equal(acct.accessToken, 'tok');
    assert.equal(acct.refreshToken, 'ref');
    // ...everything else comes from the config and must survive.
    assert.equal(acct.name, 'work');
    assert.equal(acct.type, 'oauth');
    assert.equal(acct.disabled, true);
    assert.equal(acct.priority, 3);
    assert.equal(acct.upstream, 'https://api.deepseek.com/anthropic');
    assert.deepEqual(acct.modelMap, { 'claude-sonnet-4-6': 'deepseek-v4-pro' });
    assert.deepEqual(acct.models, ['deepseek-v4-pro']);
    assert.equal(acct.orgUuid, 'org-1');
  });
});

// The file is the source of truth for credentials: a stale accessToken left in
// the config must not win over the freshly imported one.
test('imported credentials override stale ones in the config', async () => {
  await withTmp(async dir => {
    const path = await credsFile(dir, 'creds.json', {
      accessToken: 'new', refreshToken: 'new-ref', expiresAt: 2,
    });

    const [acct] = await resolveAccounts({
      accounts: [{ name: 'a', type: 'oauth', importFrom: path, accessToken: 'old', refreshToken: 'old-ref', expiresAt: 1 }],
    });

    assert.equal(acct.accessToken, 'new');
    assert.equal(acct.refreshToken, 'new-ref');
    assert.equal(acct.expiresAt, 2);
  });
});

// A readable file with no token is as unusable as a missing one — pushing it
// would send `Bearer undefined` upstream on every request.
test('a credentials file with no token is skipped', async () => {
  await withTmp(async dir => {
    const path = await credsFile(dir, 'empty.json', { refreshToken: 'r' });

    const accounts = await resolveAccounts({
      accounts: [
        { name: 'broken', type: 'oauth', importFrom: path },
        { name: 'fine', type: 'apikey', apiKey: 'sk-1' },
      ],
    });

    assert.deepEqual(accounts.map(a => a.name), ['fine']);
  });
});

// An unreadable importFrom must drop that account only, not abort the rest.
test('a failed import skips the account and keeps the others', async () => {
  const accounts = await resolveAccounts({
    accounts: [
      { name: 'gone', type: 'oauth', importFrom: '/nonexistent/creds.json' },
      { name: 'direct', type: 'oauth', accessToken: 'tok' },
    ],
  });

  assert.deepEqual(accounts.map(a => a.name), ['direct']);
});

// Non-import accounts were always passed through untouched; keep it that way.
test('non-import accounts pass through with every field intact', async () => {
  const accounts = await resolveAccounts({
    accounts: [
      { name: 'oauth', type: 'oauth', accessToken: 'tok', disabled: true, priority: 2 },
      { name: 'key', type: 'apikey', apiKey: 'sk-1', models: ['glm-4'] },
      { name: 'no-token', type: 'oauth' },
      { name: 'no-key', type: 'apikey' },
    ],
  });

  assert.deepEqual(accounts.map(a => a.name), ['oauth', 'key']);
  assert.equal(accounts[0].disabled, true);
  assert.equal(accounts[0].priority, 2);
  assert.deepEqual(accounts[1].models, ['glm-4']);
});
