// Just enough of tar to read an npm package tarball: gzip, ustar headers with
// the prefix field, and pax `path` records. Only regular files come out;
// links, devices and anything whose path could leave the target are refused,
// so the archive can never write outside the directory it is unpacked into.

import { gunzipSync } from 'node:zlib';

export interface TarFile {
  /** Forward-slash path relative to the archive root, already checked. */
  path: string;
  data: Buffer;
}

const BLOCK = 512;
/** An npm tarball of a dependency-free CLI is well under this once unpacked. */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(header: Buffer, start: number, length: number): number {
  const text = field(header, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('corrupt tar header');
  return text ? parseInt(text, 8) : 0;
}

/** The `path` record of a pax extended header, if it has one. */
function paxPath(data: Buffer): string | null {
  const text = data.toString('utf8');
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number(text.slice(offset, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    offset += length;
  }
  return null;
}

/** null when the path is absolute, empty, or climbs out with `..`. */
export function safeTarPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter(part => part !== '' && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) return null;
  return parts.join('/');
}

export function readTarGz(gz: Buffer, maxBytes = MAX_UNPACKED_BYTES): TarFile[] {
  const tar = gunzipSync(gz, { maxOutputLength: maxBytes });
  const files: TarFile[] = [];
  let offset = 0;
  let nextPath: string | null = null;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const bodyStart = offset + BLOCK;
    const body = tar.subarray(bodyStart, bodyStart + size);
    if (body.length !== size) throw new Error('truncated tar archive');
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') { nextPath = paxPath(body); continue; }
    if (type === 'g') continue;
    const prefix = field(header, 345, 155);
    const name = nextPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    nextPath = null;
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') throw new Error(`unexpected tar entry type "${type}" for ${name}`);
    const path = safeTarPath(name);
    if (!path) throw new Error(`unsafe path in tar archive: ${name}`);
    files.push({ path, data: Buffer.from(body) });
  }
  return files;
}
