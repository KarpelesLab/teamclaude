// Release gate for a packaged build: the expected installers exist, and
// nothing that will be inside them carries a credential or a config file.
// Usage: node scripts/check-dist.mjs win|linux

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(desktop, 'dist');
const platform = process.argv[2];
const failures = [];

const EXPECTED = {
  win: [/Setup-.*\.exe$/, /Portable-.*\.exe$/],
  linux: [/\.AppImage$/, /\.deb$/],
};

if (!EXPECTED[platform]) {
  console.error('usage: node scripts/check-dist.mjs win|linux');
  process.exit(2);
}

const artifacts = existsSync(dist) ? readdirSync(dist) : [];
for (const pattern of EXPECTED[platform]) {
  const hit = artifacts.find(name => pattern.test(name));
  if (!hit) failures.push(`missing artifact matching ${pattern}`);
  else if (statSync(join(dist, hit)).size < 1024 * 1024) failures.push(`${hit} is suspiciously small`);
  else process.stdout.write(`found ${hit} (${(statSync(join(dist, hit)).size / 1048576).toFixed(1)} MB)\n`);
}

// What goes into the package: the compiled app and the bundled backend.
const roots = [join(desktop, 'out'), join(desktop, 'build', 'backend')];
const SECRET = [
  /sk-ant-(api|oat|ort)\d{2}-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"refreshToken"\s*:\s*"[^"]{20,}"/,
  /"accessToken"\s*:\s*"[^"]{20,}"/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
];
const FORBIDDEN_NAMES = [/^teamclaude(\.state)?\.json$/, /^teamrouter(\.state)?\.json$/, /\.pem$/, /\.key$/, /^\.env/];
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.map', '']);

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { walk(path); continue; }
    if (FORBIDDEN_NAMES.some(p => p.test(entry.name))) failures.push(`forbidden file in package: ${relative(desktop, path)}`);
    if (!TEXT.has(extname(entry.name))) continue;
    const text = readFileSync(path, 'utf8');
    for (const pattern of SECRET) {
      if (pattern.test(text)) failures.push(`possible secret (${pattern}) in ${relative(desktop, path)}`);
    }
  }
}
for (const root of roots) {
  if (existsSync(root)) walk(root);
  else failures.push(`${relative(desktop, root)} does not exist; run the build first`);
}

if (failures.length) {
  console.error(failures.map(f => `FAIL ${f}`).join('\n'));
  process.exit(1);
}
process.stdout.write('check-dist: artifacts present, no secrets or config files found\n');
