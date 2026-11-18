#!/usr/bin/env node
// Build the Windows files of a release, none of which needs Node, npm or
// Docker on the machine it runs on:
//
//   dist/TeamClaude-Setup-<version>.exe              the installer
//   dist/TeamClaude-<version>-portable.exe           one exe, no installer
//   dist/TeamClaude-<version>-portable.exe.sha256    its checksum, in
//                                                    `sha256sum -c` format
//
//   node scripts/build-windows-installer.mjs
//
// Needs makensis and unzip (Debian/Ubuntu: apt-get install nsis unzip). Runs
// on Linux; nothing here needs Windows. It downloads the pinned Node release
// for win-x64 into a cache, refuses it unless its SHA-256 matches the pin,
// stages node.exe as teamclaude-node.exe beside src/ and package.json, then
// compiles packaging/windows/launcher.nsi (twice: for the installer, and with
// -DPORTABLE for the portable exe) and installer.nsi. All three files come from
// the same staged tree.
//
// The Node pin comes from https://nodejs.org/dist/index.json (newest v24 LTS)
// and the hash from https://nodejs.org/dist/v<version>/SHASUMS256.txt. Bump
// both together.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = '24.22.2';
const NODE_SHA256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2';
const NODE_ZIP = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP}`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packaging = join(root, 'packaging', 'windows');
const dist = join(root, 'dist');
const stage = join(dist, 'windows-stage');
const cacheDir = process.env.TEAMCLAUDE_BUILD_CACHE || join(root, '.cache', 'windows-installer');

function fail(message) {
  console.error(`build-windows-installer: ${message}`);
  process.exit(1);
}

function requireTool(cmd, probeArgs, hint) {
  const r = spawnSync(cmd, probeArgs, { stdio: 'ignore' });
  if (r.error) fail(`${cmd} not found. ${hint}`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** The pinned Node zip, from the cache when it is there and intact. */
async function nodeZip() {
  const zip = join(cacheDir, NODE_ZIP);
  if (existsSync(zip)) {
    if (await sha256(zip) === NODE_SHA256) return zip;
    console.log(`Cached ${NODE_ZIP} does not match the pinned hash; downloading it again.`);
    await rm(zip);
  }
  await mkdir(cacheDir, { recursive: true });
  console.log(`Downloading ${NODE_URL}`);
  const res = await fetch(NODE_URL);
  if (!res.ok) fail(`download of ${NODE_URL} failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== NODE_SHA256) fail(`${NODE_ZIP} has SHA-256 ${actual}, expected ${NODE_SHA256}. Not using it.`);
  const partial = `${zip}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, zip);
  return zip;
}

requireTool('makensis', ['-VERSION'], 'Install NSIS (Debian/Ubuntu: apt-get install nsis).');
requireTool('unzip', ['-v'], 'Install unzip (Debian/Ubuntu: apt-get install unzip).');

const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version ${JSON.stringify(version)} is not x.y.z, which the installer's version resource needs.`);

const zip = await nodeZip();

await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, 'node'), { recursive: true });
run('unzip', ['-q', '-j', '-o', zip, `node-v${NODE_VERSION}-win-x64/node.exe`, '-d', join(stage, 'node')]);
await rename(join(stage, 'node', 'node.exe'), join(stage, 'node', 'teamclaude-node.exe'));

await cp(join(root, 'src'), join(stage, 'app', 'src'), { recursive: true });
await copyFile(join(root, 'package.json'), join(stage, 'app', 'package.json'));
// Read by src/updater.js: this copy updates through a new download, not npm.
await writeFile(join(stage, 'app', 'windows-bundle'), `Windows bundle of TeamClaude ${version} (installer or portable exe). Updates come from https://github.com/KarpelesLab/teamclaude/releases\r\n`);
// The licence page shows the file as is, and a bare LF is no line break there.
const license = await readFile(join(root, 'LICENSE'), 'utf8');
await writeFile(join(stage, 'LICENSE.txt'), license.replace(/\r?\n/g, '\r\n'));
await copyFile(join(packaging, 'teamclaude.ico'), join(stage, 'teamclaude.ico'));

const defines = [`-DVERSION=${version}`, `-DSTAGE=${stage}`];
run('makensis', ['-V2', ...defines, `-DOUTFILE=${join(stage, 'TeamClaude.exe')}`, join(packaging, 'launcher.nsi')]);
const setup = join(dist, `TeamClaude-Setup-${version}.exe`);
run('makensis', ['-V2', ...defines, `-DOUTFILE=${setup}`, join(packaging, 'installer.nsi')]);

const portable = join(dist, `TeamClaude-${version}-portable.exe`);
run('makensis', ['-V2', ...defines, '-DPORTABLE', `-DOUTFILE=${portable}`, join(packaging, 'launcher.nsi')]);
// Two spaces and no path: `sha256sum -c` run from dist/ finds the exe by name.
await writeFile(`${portable}.sha256`, `${await sha256(portable)}  ${basename(portable)}\n`);

for (const file of [setup, portable]) {
  const { size } = await stat(file);
  console.log(`Built ${file} (${(size / 1024 / 1024).toFixed(1)} MB) with Node ${NODE_VERSION}`);
}
