import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const name = 'same@example.com';
const pair = [
  { name, type: 'apikey', apiKey: 'placeholder-claude-key', orgName: 'Example Org' },
  { name, type: 'apikey', provider: 'codex', apiKey: 'placeholder-codex-key' },
];

function fixture(accounts = pair) {
  const dir = mkdtempSync(join(tmpdir(), 'tc-remove-provider-'));
  const path = join(dir, 'teamclaude.json');
  writeFileSync(path, JSON.stringify({ accounts, proxy: { port: 1 } }));
  return {
    run: (...args) => spawnSync(process.execPath, ['src/index.js', 'remove', name, ...args], {
      encoding: 'utf8', env: { ...process.env, TEAMROUTER_CONFIG: path, TEAMCLAUDE_CONFIG: path, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' },
    }),
    accounts: () => JSON.parse(readFileSync(path, 'utf8')).accounts,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

for (const provider of ['codex', 'anthropic']) {
  test(`remove --provider ${provider} preserves the other provider with the same email`, () => {
    const f = fixture();
    try {
      const result = f.run('--provider', provider);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(f.accounts().map(a => a.apiKey), [provider === 'codex' ? pair[0].apiKey : pair[1].apiKey]);
    } finally { f.close(); }
  });
}

test('provider and organization filters combine, without choosing another org or provider', () => {
  const other = { ...pair[0], apiKey: 'other-org-placeholder', orgName: 'Other Org' };
  const f = fixture([...pair, other]);
  try {
    const ambiguous = f.run('--provider', 'anthropic');
    assert.notEqual(ambiguous.status, 0);
    assert.equal(f.accounts().length, 3);
    const result = f.run('--provider', 'anthropic', '--org', 'Example Org');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.accounts().map(a => a.apiKey), [pair[1].apiKey, other.apiKey]);
  } finally { f.close(); }
});

test('ambiguous, invalid, missing and mismatched provider selections never remove an account', () => {
  const f = fixture();
  try {
    for (const args of [[], ['--provider', 'unknown'], ['--provider'], ['--provider', 'codex', '--org', 'Example Org']]) {
      const result = f.run(...args);
      assert.notEqual(result.status, 0);
      assert.equal(f.accounts().length, 2);
    }
  } finally { f.close(); }
});
