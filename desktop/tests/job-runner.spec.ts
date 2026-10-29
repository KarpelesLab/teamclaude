import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  apiKeyArgs, distributeArgs, importArgs, intervalArgs, JobRunner, loginArgs, removeArgs, renameArgs, type CliChild,
} from '../src/services/job-runner';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  finish(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('argument builders', () => {
  it('build fixed argv arrays', () => {
    expect(loginArgs('claude')).toEqual(['login', '--oauth']);
    expect(loginArgs('codex', 'work')).toEqual(['login', '--codex', '--name', 'work']);
    expect(apiKeyArgs('k', 3)).toEqual(['login', '--api', '--name', 'k', '--priority', '3']);
    expect(importArgs()).toEqual(['import']);
    expect(removeArgs('a b')).toEqual(['remove', 'a b']);
    expect(renameArgs('a', 'b')).toEqual(['rename', 'a', 'b']);
    expect(distributeArgs('adaptive')).toEqual(['distribute', 'adaptive']);
    expect(distributeArgs('load')).toEqual(['distribute', 'load']);
    expect(intervalArgs('probe', 0)).toEqual(['probe', 'off']);
    expect(intervalArgs('warmup', 300)).toEqual(['warmup', '300']);
  });

  it('never put an API key in argv', () => {
    expect(apiKeyArgs('name').join(' ')).not.toMatch(/sk-/);
  });
});

describe('JobRunner', () => {
  it('runs a job, collects sanitized output and reports success', async () => {
    const child = new FakeChild();
    const runner = new JobRunner(() => child as unknown as CliChild);
    const done: string[] = [];
    runner.on('done', v => done.push(v.state));
    const job = runner.run('login', 'Sign in', ['login', '--oauth']);
    expect(job.state).toBe('running');
    child.stdout.write('Open https://x/?code=abc123 in your browser\n');
    await tick();
    child.finish(0);
    const view = runner.list()[0]!;
    expect(view.state).toBe('succeeded');
    expect(view.output.join('\n')).not.toContain('abc123');
    expect(done).toEqual(['succeeded']);
  });

  it('writes stdin once and closes it', async () => {
    const child = new FakeChild();
    const runner = new JobRunner(() => child as unknown as CliChild);
    let written = '';
    child.stdin.on('data', (c: Buffer) => { written += c.toString(); });
    runner.run('apikey', 'Add key', ['login', '--api'], 'sk-ant-api03-secretsecret');
    await tick();
    expect(written).toBe('sk-ant-api03-secretsecret\n');
    expect(child.stdin.writableEnded).toBe(true);
  });

  it('fails cleanly when no backend is available or spawn throws', () => {
    expect(new JobRunner(() => null).run('x', 'x', []).state).toBe('failed');
    const thrown = new JobRunner(() => { throw new Error('EACCES'); }).run('x', 'x', []);
    expect(thrown.state).toBe('failed');
    expect(thrown.output[0]).toContain('EACCES');
  });

  it('marks a non-zero exit as failed with its code', () => {
    const child = new FakeChild();
    const runner = new JobRunner(() => child as unknown as CliChild);
    runner.run('remove', 'Remove', ['remove', 'a']);
    child.finish(2);
    expect(runner.list()[0]).toMatchObject({ state: 'failed', exitCode: 2 });
  });

  it('cancels a running job and ignores its later exit', () => {
    const child = new FakeChild();
    const runner = new JobRunner(() => child as unknown as CliChild);
    const job = runner.run('login', 'Sign in', []);
    expect(runner.cancel(job.id)).toBe(true);
    expect(child.killed).toBe(true);
    child.finish(0);
    expect(runner.list()[0]?.state).toBe('failed');
    expect(runner.cancel(job.id)).toBe(false);
    expect(runner.cancel(999)).toBe(false);
  });

  it('keeps a bounded job history', () => {
    const runner = new JobRunner(() => null);
    for (let i = 0; i < 40; i++) runner.run('x', `j${i}`, []);
    expect(runner.list()).toHaveLength(30);
    expect(runner.list()[0]?.label).toBe('j10');
  });
});
