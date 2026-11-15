import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The tests set the legacy variable names (TEAMCLAUDE_CONFIG, ...) and envVar
// prefers the renamed ones, so a developer's exported TEAMROUTER_CONFIG used to
// send `npm test`'s writes into their real config. test-helpers/isolate-env.js
// drops every TEAMROUTER_* variable before any test file runs.

const root = fileURLToPath(new URL('..', import.meta.url));
const helper = fileURLToPath(new URL('../test-helpers/isolate-env.js', import.meta.url));

test('npm test loads the environment isolation before every test file', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(scripts.test, /--import \.\/test-helpers\/isolate-env\.js(\s|$)/);
});

test('the isolation drops every TEAMROUTER_* variable and leaves the legacy ones', () => {
  const r = spawnSync(process.execPath, ['--import', helper, '-e',
    'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k => /^TEAM(ROUTER|CLAUDE)_/.test(k)).sort()))'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TEAMROUTER_CONFIG: '/nonexistent/real.json', TEAMROUTER_HOST: 'h', TEAMCLAUDE_CONFIG: '/tmp/test.json' },
  });
  assert.equal(r.status, 0, r.stderr);
  const left = JSON.parse(r.stdout);
  assert.ok(!left.some((/** @type {string} */ k) => k.startsWith('TEAMROUTER_')), `no renamed variable survives: ${r.stdout}`);
  assert.ok(left.includes('TEAMCLAUDE_CONFIG'), "the test's own legacy setting is kept");
});
