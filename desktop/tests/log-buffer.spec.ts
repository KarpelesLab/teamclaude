import { describe, expect, it } from 'vitest';
import { LogBuffer } from '../src/services/log-buffer';

describe('LogBuffer', () => {
  it('joins chunks into lines and keeps the tail of an unterminated line', () => {
    const log = new LogBuffer(100, () => 1);
    log.write('stdout', 'hel');
    log.write('stdout', 'lo\nwor');
    expect(log.all().map(l => l.text)).toEqual(['hello']);
    log.flush('stdout');
    expect(log.all().map(l => l.text)).toEqual(['hello', 'wor']);
  });

  it('keeps streams apart and skips blank lines', () => {
    const log = new LogBuffer();
    log.write('stdout', 'a\n\n');
    log.write('stderr', 'b\r\n');
    expect(log.all().map(l => [l.stream, l.text])).toEqual([['stdout', 'a'], ['stderr', 'b']]);
  });

  it('redacts secrets before storing them', () => {
    const log = new LogBuffer();
    log.write('stderr', 'refresh failed for sk-ant-ort01-ABCDEFGHIJKLMNOP\n');
    expect(log.all()[0]?.text).not.toContain('ABCDEFGHIJ');
  });

  it('is bounded', () => {
    const log = new LogBuffer(3);
    for (let i = 0; i < 10; i++) log.note(`n${i}`);
    expect(log.all().map(l => l.text)).toEqual(['n7', 'n8', 'n9']);
    expect(log.all().map(l => l.seq)).toEqual([8, 9, 10]);
  });

  it('cuts a runaway line instead of buffering it forever', () => {
    const log = new LogBuffer();
    log.write('stdout', 'x'.repeat(20_000));
    expect(log.all()).toHaveLength(1);
  });

  it('tail() returns process output only; listeners receive new lines', () => {
    const log = new LogBuffer();
    const seen: string[] = [];
    const off = log.onLines(lines => seen.push(...lines.map(l => l.text)));
    log.note('desktop note');
    log.write('stderr', 'boom\n');
    off();
    log.write('stdout', 'after\n');
    expect(log.tail(5)).toEqual(['boom', 'after']);
    expect(seen).toEqual(['desktop note', 'boom']);
    log.clear();
    expect(log.all()).toEqual([]);
  });
});
