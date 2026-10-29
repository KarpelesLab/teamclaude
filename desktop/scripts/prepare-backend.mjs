// Copy the backend (the repository's src/, which has no runtime
// dependencies) into build/backend so electron-builder can ship it as an
// extra resource next to the app. package.json is reduced to the fields the
// backend reads at runtime: "type" (ESM) and "version" (status reports it).

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(desktop, '..');
const target = join(desktop, 'build', 'backend');

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
if (!existsSync(join(repo, 'src', 'index.js'))) {
  console.error('prepare-backend: ../src/index.js not found; run this from desktop/ inside the repository.');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(repo, 'src'), join(target, 'src'), { recursive: true });
cpSync(join(repo, 'LICENSE'), join(target, 'LICENSE'));
writeFileSync(join(target, 'package.json'), `${JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: pkg.type,
  license: pkg.license,
  repository: pkg.repository,
}, null, 2)}\n`);
process.stdout.write(`prepare-backend: bundled ${pkg.name}@${pkg.version} into build/backend\n`);
