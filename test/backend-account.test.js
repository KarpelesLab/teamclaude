import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { backendAccount } from '../src/backend-account.js';

const input = { name: 'demo', upstream: 'https://example.com/anthropic', apiKey: 'demo-placeholder-key', auth: 'bearer', modelMap: { sonnet: 'vendor/sonnet' } };

test('backend keys use the chosen auth format and default fallback priority', () => {
  assert.equal(backendAccount(input).accessToken, input.apiKey);
  assert.equal(backendAccount(input).type, 'oauth');
  assert.equal(backendAccount({ ...input, upstream: 'https://example.com/anthropic/v1/' }).upstream, 'https://example.com/anthropic');
  assert.equal(backendAccount(input).priority, 100);
  assert.equal(backendAccount({ ...input, auth: 'x-api-key' }).apiKey, input.apiKey);
  for (const patch of [{ upstream: 'file:///x' }, { upstream: 'https://user:key@example.com' }, { auth: 'none' }, { modelMap: {} }, { priority: NaN }]) assert.throws(() => backendAccount({ ...input, ...patch }));
});

test('CLI saves through the config lock, preserves existing accounts and refuses duplicate names without exposing the key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-backend-'));
  const path = join(dir, 'config.json');
  const run = data => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.js', 'add-backend'], { env: { ...process.env, TEAMROUTER_CONFIG: path, TEAMCLAUDE_CONFIG: path, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
    child.stdin.end(JSON.stringify(data));
  });
  try {
    const first = await run(input);
    assert.equal(first.code, 0, first.output);
    const second = await run({ ...input, name: 'other', auth: 'x-api-key' });
    assert.equal(second.code, 0, second.output);
    const duplicate = await run(input);
    assert.notEqual(duplicate.code, 0);
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(config.accounts.map(a => a.name), ['demo', 'other']);
    assert.equal(config.accounts[0].upstream, input.upstream);
    assert.deepEqual(config.accounts[0].modelMap, input.modelMap);
    assert.ok(![first, second, duplicate].some(r => r.output.includes(input.apiKey)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
