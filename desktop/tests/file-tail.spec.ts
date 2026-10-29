import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileTail } from '../src/services/file-tail';

function withFile(content: string | Buffer, check: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tc-tail-'));
  try {
    const path = join(dir, 'crash.log');
    writeFileSync(path, content);
    check(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('readFileTail', () => {
  it('returns null for a missing file', () => {
    expect(readFileTail(join(tmpdir(), 'tc-tail-missing', 'none.log'), 100)).toBeNull();
  });

  it('returns a small file whole', () => {
    withFile('a\nb\n', path => expect(readFileTail(path, 100)).toBe('a\nb\n'));
  });

  it('keeps only whole lines from the last bytes of a large file', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n';
    withFile(lines, path => {
      const tail = readFileTail(path, 64);
      expect(tail).not.toBeNull();
      expect(Buffer.byteLength(tail!)).toBeLessThanOrEqual(64);
      expect(tail!.endsWith('line 999\n')).toBe(true);
      expect(tail!.split('\n')[0]).toMatch(/^line \d+$/);
    });
  });

  it('does not start with a broken multi-byte character', () => {
    // 'ж' is two bytes in UTF-8; an odd byte count cuts one in half.
    withFile(`${'ж'.repeat(50)}\nконец\n`, path => {
      expect(readFileTail(path, 21)).toBe('конец\n');
    });
  });
});
