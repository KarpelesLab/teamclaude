// A bounded, sanitized log of the managed backend's output plus the desktop's
// own messages. Lines are redacted on the way in, so nothing unredacted is
// ever held in memory longer than one chunk, let alone sent to the renderer.

import type { LogLine, LogStream } from '../shared/types';
import { sanitizeText } from './sanitize';

export class LogBuffer {
  private lines: LogLine[] = [];
  private seq = 0;
  private partial: Record<LogStream, string> = { stdout: '', stderr: '', desktop: '' };
  private readonly listeners = new Set<(lines: LogLine[]) => void>();

  constructor(private readonly capacity = 5000, private readonly now: () => number = Date.now) {}

  /** Feed a raw chunk from a stream; complete lines are stored. */
  write(stream: LogStream, chunk: string): void {
    const text = this.partial[stream] + chunk;
    const parts = text.split(/\r?\n/);
    this.partial[stream] = parts.pop() ?? '';
    // A single line without a newline that grows without bound is cut, not kept.
    if (this.partial[stream].length > 16_384) {
      parts.push(this.partial[stream]);
      this.partial[stream] = '';
    }
    this.push(stream, parts);
  }

  /** Add one complete message (the desktop's own notes). */
  note(text: string): void {
    this.push('desktop', [text]);
  }

  /** Flush a stream's unterminated tail, e.g. when the process exits. */
  flush(stream: LogStream): void {
    const rest = this.partial[stream];
    this.partial[stream] = '';
    if (rest) this.push(stream, [rest]);
  }

  private push(stream: LogStream, texts: string[]): void {
    const added: LogLine[] = [];
    for (const raw of texts) {
      if (raw.trim() === '') continue;
      added.push({ seq: ++this.seq, at: this.now(), stream, text: sanitizeText(raw) });
    }
    if (added.length === 0) return;
    this.lines.push(...added);
    if (this.lines.length > this.capacity) this.lines = this.lines.slice(this.lines.length - this.capacity);
    for (const listener of this.listeners) listener(added);
  }

  all(): LogLine[] {
    return [...this.lines];
  }

  /** The last `n` lines of the process streams, for an error message. */
  tail(n: number): string[] {
    return this.lines.filter(l => l.stream !== 'desktop').slice(-n).map(l => l.text);
  }

  clear(): void {
    this.lines = [];
  }

  onLines(listener: (lines: LogLine[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
