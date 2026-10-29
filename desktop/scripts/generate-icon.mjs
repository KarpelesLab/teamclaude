// Draw the app icon (512×512 PNG) from code at build time, so the repository
// carries no binary files. A rounded square with a stylised "T" and a ring.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');

const BG = [0xd9, 0x77, 0x57];
const FG = [0x16, 0x0b, 0x06];

function insideRoundedSquare(x, y, inset, radius) {
  const min = inset;
  const max = SIZE - inset;
  if (x < min || x >= max || y < min || y >= max) return false;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function mark(x, y) {
  // "T": a bar across the top and a stem.
  if (y >= 140 && y < 190 && x >= 120 && x < 392) return true;
  if (x >= 231 && x < 281 && y >= 140 && y < 300) return true;
  // A ring below it, open on the right — the pool the accounts rotate in.
  const d = Math.hypot(x - 256, y - 330);
  const angle = Math.atan2(y - 330, x - 256);
  return d >= 52 && d < 92 && y > 300 && Math.abs(angle) > 0.6;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = row + 1 + x * 4;
    if (!insideRoundedSquare(x, y, 24, 96)) continue; // transparent
    const [r, g, b] = mark(x, y) ? FG : BG;
    raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
process.stdout.write(`generate-icon: wrote build/icon.png (${png.length} bytes)\n`);
