// The end of a text file that may be large, such as the backend's crash log.
// Only the last maxBytes are read from disk.

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

/** The last `maxBytes` of the file as UTF-8, or null when it does not exist. */
export function readFileTail(path: string, maxBytes: number): string | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, size - length + read);
      if (n === 0) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString('utf8');
    if (length === size) return text;
    // The cut may land inside a line or a multi-byte character; start at the
    // first whole line.
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(newline + 1);
  } finally {
    closeSync(fd);
  }
}
