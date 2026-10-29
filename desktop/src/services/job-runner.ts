// Account and settings operations that the control API does not offer
// (sign-in, import, remove, rename, distribution, probe, warm-up) run through
// the backend's own CLI, exactly as a user would type them. The CLI owns the
// OAuth flow, the config lock and the reload of a running server; the desktop
// only launches it with a fixed argument array (never a shell) and shows its
// sanitized output. An API key travels on the child's stdin, never in argv.

import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { translator, type Translate } from '../shared/i18n';
import type { DistributionMode, JobView } from '../shared/types';
import { describeError, sanitizeText } from './sanitize';

export interface CliChild {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnCli = (args: string[]) => CliChild | null;

// ── argument builders ──────────────────────────────────────────────────

export function loginArgs(provider: 'claude' | 'codex', name?: string): string[] {
  return ['login', provider === 'codex' ? '--codex' : '--oauth', ...(name ? ['--name', name] : [])];
}

export function apiKeyArgs(name?: string, priority?: number): string[] {
  return ['login', '--api', ...(name ? ['--name', name] : []), ...(priority !== undefined ? ['--priority', String(priority)] : [])];
}

export function importArgs(name?: string): string[] {
  return ['import', ...(name ? ['--name', name] : [])];
}

export function removeArgs(account: string): string[] {
  return ['remove', account];
}

export function renameArgs(account: string, newName: string): string[] {
  return ['rename', account, newName];
}

export function distributeArgs(mode: DistributionMode): string[] {
  return ['distribute', mode];
}

/** `probe off` / `probe 300` — 0 seconds switches the background job off. */
export function intervalArgs(command: 'probe' | 'warmup', seconds: number): string[] {
  return [command, seconds === 0 ? 'off' : String(seconds)];
}

// ── runner ─────────────────────────────────────────────────────────────

const MAX_OUTPUT_LINES = 400;
const MAX_JOBS = 30;

interface RunningJob {
  view: JobView;
  child: CliChild | null;
}

export class JobRunner extends EventEmitter {
  private jobs: RunningJob[] = [];
  private nextId = 1;

  constructor(private readonly spawnCli: SpawnCli, private readonly t: () => Translate = () => translator('en')) {
    super();
  }

  list(): JobView[] {
    return this.jobs.map(j => j.view);
  }

  private publish(job: RunningJob, patch: Partial<JobView>): void {
    job.view = { ...job.view, ...patch };
    this.emit('job', job.view);
    if (patch.state && patch.state !== 'running') this.emit('done', job.view);
  }

  private append(job: RunningJob, chunk: string): void {
    const lines = sanitizeText(chunk).split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length === 0) return;
    const output = [...job.view.output, ...lines].slice(-MAX_OUTPUT_LINES);
    this.publish(job, { output });
  }

  /**
   * Start a CLI job. `stdin`, when given, is written once and closed — the
   * CLI reads a single line (the API-key prompt). Otherwise stdin is closed at
   * once, so a CLI that unexpectedly prompts gets EOF instead of hanging.
   */
  run(kind: string, label: string, args: string[], stdin?: string): JobView {
    const job: RunningJob = {
      view: { id: this.nextId++, kind, label, state: 'running', output: [], exitCode: null },
      child: null,
    };
    this.jobs = [...this.jobs, job].slice(-MAX_JOBS);
    let child: CliChild | null;
    try {
      child = this.spawnCli(args);
    } catch (err) {
      child = null;
      this.publish(job, { state: 'failed', output: [this.t()('j.spawnFailed', { error: describeError(err) })] });
      return job.view;
    }
    if (!child) {
      this.publish(job, { state: 'failed', output: [this.t()('j.noBackend')] });
      return job.view;
    }
    job.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => this.append(job, c));
    child.stderr?.on('data', (c: string) => this.append(job, c));
    child.on('error', err => {
      if (job.view.state === 'running') this.publish(job, { state: 'failed', output: [...job.view.output, describeError(err)] });
    });
    child.on('exit', code => {
      job.child = null;
      if (job.view.state !== 'running') return;
      this.publish(job, { state: code === 0 ? 'succeeded' : 'failed', exitCode: code });
    });
    if (child.stdin) {
      child.stdin.on('error', () => { /* the CLI exited before reading; its exit code tells the story */ });
      if (stdin !== undefined) child.stdin.write(`${stdin}\n`);
      child.stdin.end();
    }
    this.emit('job', job.view);
    return job.view;
  }

  cancel(id: number): boolean {
    const job = this.jobs.find(j => j.view.id === id);
    if (!job?.child || job.view.state !== 'running') return false;
    job.child.kill();
    this.publish(job, { state: 'failed', output: [...job.view.output, this.t()('h.cancelled')] });
    return true;
  }

  cancelAll(): void {
    for (const job of this.jobs) if (job.child && job.view.state === 'running') job.child.kill();
  }
}
