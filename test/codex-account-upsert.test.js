import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end through the CLI, because the bug this covers lived in how the
// upsert reconciled a new codex account against the accounts already on disk.
//
// Regression: the codex upsert's name fallback was unscoped, copied from the
// Anthropic upsert where every account shares a protocol. A codex credential
// whose email matched an existing Claude account's NAME therefore merged codex
// fields over that account and destroyed its credential. One person's Claude
// and ChatGPT accounts routinely share an email, so this was the common case.

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function jwt(payload) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

function codexAuthFile(dir, { email, accountId }) {
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'rt.codex.1',
      id_token: jwt({
        email,
        'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' },
      }),
      account_id: accountId,
    },
  }));
  return path;
}

function setup(accounts) {
  const dir = mkdtempSync(join(tmpdir(), 'tc-upsert-'));
  const configPath = join(dir, 'teamclaude.json');
  writeFileSync(configPath, JSON.stringify({
    proxy: { port: 39999, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    accounts,
  }, null, 2));
  return { dir, configPath };
}

function importCodex(configPath, authPath) {
  execFileSync('node', [CLI, 'import', '--codex', '--from', authPath], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

const claudeAccount = {
  name: 'person@example.com',
  type: 'oauth',
  accountUuid: 'anthropic-uuid',
  orgUuid: 'org-uuid',
  accessToken: 'claude-access',
  refreshToken: 'claude-refresh',
  expiresAt: Date.now() + 3600_000,
};

test('a codex credential sharing a Claude account name does not overwrite it', () => {
  const { dir, configPath } = setup([claudeAccount]);
  const authPath = codexAuthFile(dir, { email: 'person@example.com', accountId: 'chatgpt-1' });

  const cfg = importCodex(configPath, authPath);

  assert.equal(cfg.accounts.length, 2);
  const claude = cfg.accounts.find(a => a.accountUuid === 'anthropic-uuid');
  assert.ok(claude, 'the Claude account must still exist');
  assert.equal(claude.accessToken, 'claude-access', 'its credential must be untouched');
  assert.equal(claude.refreshToken, 'claude-refresh');
  assert.equal(claude.protocol, undefined, 'it must not have been converted to codex');
});

test('the colliding codex account is added under a disambiguated name', () => {
  const { dir, configPath } = setup([claudeAccount]);
  const authPath = codexAuthFile(dir, { email: 'person@example.com', accountId: 'chatgpt-1' });

  const cfg = importCodex(configPath, authPath);

  const codex = cfg.accounts.find(a => a.protocol === 'codex');
  assert.ok(codex);
  assert.equal(codex.accountId, 'chatgpt-1');
  // Names are the user-facing key for remove/priority/TC_ACCT, so they must
  // stay unique across protocols.
  assert.notEqual(codex.name, claudeAccount.name);
  assert.equal(new Set(cfg.accounts.map(a => a.name)).size, cfg.accounts.length);
});

test('re-importing the same codex account updates it in place', () => {
  const { dir, configPath } = setup([claudeAccount]);
  const authPath = codexAuthFile(dir, { email: 'person@example.com', accountId: 'chatgpt-1' });

  importCodex(configPath, authPath);
  const cfg = importCodex(configPath, authPath);

  assert.equal(cfg.accounts.length, 2, 'must not accumulate duplicates');
  assert.equal(cfg.accounts.filter(a => a.protocol === 'codex').length, 1);
});

test('two distinct ChatGPT accounts both land as separate entries', () => {
  const { dir, configPath } = setup([]);
  const first = codexAuthFile(mkdtempSync(join(tmpdir(), 'a-')), { email: 'a@example.com', accountId: 'chatgpt-1' });
  const second = codexAuthFile(mkdtempSync(join(tmpdir(), 'b-')), { email: 'b@example.com', accountId: 'chatgpt-2' });

  importCodex(configPath, first);
  const cfg = importCodex(configPath, second);

  assert.equal(cfg.accounts.length, 2);
  assert.deepEqual(
    cfg.accounts.map(a => a.accountId).sort(),
    ['chatgpt-1', 'chatgpt-2'],
  );
  void dir;
});

test('a codex account with no name collision keeps its plain email name', () => {
  const { dir, configPath } = setup([claudeAccount]);
  const authPath = codexAuthFile(dir, { email: 'other@example.com', accountId: 'chatgpt-9' });

  const cfg = importCodex(configPath, authPath);

  const codex = cfg.accounts.find(a => a.protocol === 'codex');
  assert.equal(codex.name, 'other@example.com');
});
