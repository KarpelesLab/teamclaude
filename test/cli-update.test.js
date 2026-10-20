import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `teamclaude update` as a subprocess, run from a copy of the package laid out
// where an installer puts it: the command reads the install kind off the
// package root it runs from. Two stubs keep the run off the network and make an
// npm install visible. A preload answers the registry with a newer release, and
// PATH holds nothing but an `npm` script that records each call and installs
// nothing. A copy that fell through to the npm path would print "Updating" and
// leave an `install -g` line in that record.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const REGISTRY_STUB = "globalThis.fetch = async () => new Response(JSON.stringify({ 'dist-tags': { latest: '999.0.0' } }), { status: 200 });\n";

// `npm root -g` answers NPM_ROOT; every call is recorded in NPM_LOG.
const NPM_STUB = [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$NPM_LOG"',
  'if [ "$1" = root ]; then printf \'%s\\n\' "$NPM_ROOT"; fi',
  '',
].join('\n');

/**
 * Copy the package to `<tmp>/<pkgDir>` and run `teamclaude update` from it,
 * with `npm root -g` answering `<tmp>/<npmRoot>`.
 * @param {{ pkgDir: string, npmRoot: string }} layout
 */
async function runUpdate({ pkgDir, npmRoot }) {
  // The real path: the CLI derives its package root from its own resolved URL.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'teamclaude-update-')));
  try {
    const root = join(dir, pkgDir);
    await mkdir(root, { recursive: true });
    await cp(join(repoRoot, 'src'), join(root, 'src'), { recursive: true });
    await cp(join(repoRoot, 'package.json'), join(root, 'package.json'));
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'npm'), NPM_STUB);
    await chmod(join(bin, 'npm'), 0o755);
    const stub = join(dir, 'registry-stub.mjs');
    await writeFile(stub, REGISTRY_STUB);
    const npmLog = join(dir, 'npm.log');
    const child = spawn(process.execPath, ['--import', pathToFileURL(stub).href, join(root, 'src', 'index.js'), 'update'], {
      env: {
        ...process.env,
        PATH: bin,
        NPM_LOG: npmLog,
        NPM_ROOT: join(dir, npmRoot),
        TEAMCLAUDE_CONFIG: join(dir, 'config.json'),
        TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('update command did not exit')); }, 60_000);
      child.on('error', reject);
      child.on('exit', c => { clearTimeout(timer); resolve(c); });
    });
    const npmCalls = await readFile(npmLog, 'utf8').catch(() => '');
    return { code, stdout, stderr, npmCalls };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// `npm install -g` would put a second copy in npm's global directory, report
// "Updated", and leave the pnpm copy, the one on PATH, on the old version.
test('update from a pnpm copy names the pnpm command and never runs npm', { skip: process.platform === 'win32' }, async () => {
  const result = await runUpdate({
    pkgDir: 'pnpm/global/v11/node_modules/.pnpm/@karpeleslab+teamclaude@1.1.25/node_modules/@karpeleslab/teamclaude',
    npmRoot: 'lib/node_modules',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^This copy was installed with pnpm, which npm cannot update\. Run: pnpm add -g @karpeleslab\/teamclaude@latest$/m);
  assert.doesNotMatch(result.stdout, /Updat(?:ing|ed) /);
  assert.equal(result.npmCalls, '');
});

// The same harness on a copy npm installed globally: the stubs do see an npm
// install, so the empty record above is the command's doing.
test('update from an npm global copy still installs with npm', { skip: process.platform === 'win32' }, async () => {
  const result = await runUpdate({
    pkgDir: 'lib/node_modules/@karpeleslab/teamclaude',
    npmRoot: 'lib/node_modules',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Updated to 999\.0\.0\./m);
  assert.match(result.npmCalls, /^install -g @karpeleslab\/teamclaude@999\.0\.0$/m);
});
