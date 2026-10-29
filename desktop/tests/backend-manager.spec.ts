import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlResult, ProbeResult } from '../src/services/backend-client';
import { proxySettingsFrom } from '../src/services/backend-config';
import {
  BackendManager, MAX_RESTARTS, type BackendManagerDeps, type ChildLike, type ClientLike,
} from '../src/services/backend-manager';
import { LogBuffer } from '../src/services/log-buffer';
import { rawStatus } from './fixtures';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signals: Array<NodeJS.Signals | undefined> = [];
  constructor(readonly pid: number, private readonly exitOnKill = true) {
    super();
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.exitOnKill || signal === 'SIGKILL') queueMicrotask(() => this.exit(null, signal ?? 'SIGTERM'));
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    this.emit('exit', code, signal);
  }
}

class FakeClient implements ClientLike {
  readonly baseUrl = 'http://127.0.0.1:3456';
  probes: ProbeResult[] = [];
  fallback: ProbeResult = { kind: 'down', detail: 'ECONNREFUSED' };
  posts: Array<{ path: string; body?: Record<string, unknown> }> = [];
  async probe(): Promise<ProbeResult> {
    return this.probes.shift() ?? this.fallback;
  }
  async post(path: string, body?: Record<string, unknown>): Promise<ControlResult> {
    this.posts.push({ path, body });
    return { ok: true, status: 200, body: { ok: true }, error: null };
  }
}

const up = (pid: number | null = 4242): ProbeResult => ({
  kind: 'teamclaude',
  raw: rawStatus({ server: { version: '1.1.25', pid } }),
});

function setup(overrides: Partial<BackendManagerDeps> & { accounts?: number; storedPid?: number | null } = {}) {
  const client = new FakeClient();
  const children: FakeChild[] = [];
  let storedPid: number | null = overrides.storedPid ?? null;
  const killed: number[] = [];
  const log = new LogBuffer();
  const deps: BackendManagerDeps = {
    configPath: () => '/cfg/teamclaude.json',
    readSettings: () => ({
      settings: proxySettingsFrom({ accounts: Array.from({ length: overrides.accounts ?? 1 }, () => ({})) }, {}),
      exists: true,
      error: null,
    }),
    createClient: () => client,
    spawnServer: () => {
      const child = new FakeChild(4242);
      children.push(child);
      return child as unknown as ChildLike;
    },
    serviceInstalled: () => false,
    killPid: pid => { killed.push(pid); },
    ownedPid: { read: () => storedPid, write: pid => { storedPid = pid; } },
    log,
    minBackendVersion: '1.0.0',
    restartOnCrash: () => false,
    platform: 'linux',
    sleep: async () => {},
    readyTimeoutMs: 1000,
    readyPollMs: 1,
    stopTimeoutMs: 10,
    ...overrides,
  };
  const manager = new BackendManager(deps);
  return { manager, client, children, log, killed, storedPid: () => storedPid };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BackendManager start', () => {
  it('attaches to an external server without spawning', async () => {
    const { manager, client, children } = setup();
    client.probes.push(up(999));
    const result = await manager.start();
    expect(result.ok).toBe(true);
    expect(children).toHaveLength(0);
    expect(manager.getState()).toMatchObject({ phase: 'running', ownership: 'external' });
  });

  it('spawns, waits for a real status answer, and owns the server', async () => {
    const { manager, client, children, storedPid } = setup();
    client.probes.push({ kind: 'down', detail: 'ECONNREFUSED' }, { kind: 'down', detail: 'ECONNREFUSED' }, up(4242));
    const result = await manager.start();
    expect(result.ok).toBe(true);
    expect(children).toHaveLength(1);
    expect(manager.getState()).toMatchObject({ phase: 'running', ownership: 'owned', childPid: 4242 });
    expect(storedPid()).toBe(4242);
  });

  it('shares one start between concurrent callers', async () => {
    const { manager, client, children } = setup();
    client.probes.push({ kind: 'down', detail: 'ECONNREFUSED' }, up(4242));
    await Promise.all([manager.start(), manager.start()]);
    expect(children).toHaveLength(1);
  });

  it('refuses to start with an empty pool', async () => {
    const { manager, children } = setup({ accounts: 0 });
    const result = await manager.start();
    expect(result.ok).toBe(false);
    expect(children).toHaveLength(0);
  });

  it('never kills a foreign process holding the port', async () => {
    const { manager, client, children, killed } = setup();
    client.probes.push({ kind: 'foreign', detail: 'HTTP 404' });
    const result = await manager.start();
    expect(result.ok).toBe(false);
    expect(manager.getState().phase).toBe('port-conflict');
    expect(children).toHaveLength(0);
    expect(killed).toEqual([]);
  });

  it('reports a backend that is not bundled', async () => {
    const { manager } = setup({ spawnServer: () => null });
    const result = await manager.start();
    expect(result.ok).toBe(false);
    expect(manager.getState().phase).toBe('error');
  });

  it('reports a child that exits during startup, with its output', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { manager, children } = setup({ sleep: () => gate });
    const pending = manager.start();
    await new Promise(resolve => setImmediate(resolve));
    children[0]!.stderr.write('Error: listen EADDRINUSE 127.0.0.1:3456\n');
    await new Promise(resolve => setImmediate(resolve));
    children[0]!.exit(1);
    release();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(manager.getState().phase).toBe('error');
    expect(manager.getState().lastError).toContain('EADDRINUSE');
  });

  it('gives up and kills its child when it never becomes ready', async () => {
    let now = 0;
    const { manager, children } = setup({ now: () => now, sleep: async ms => { now += ms; } });
    const result = await manager.start();
    expect(result.ok).toBe(false);
    expect(children[0]!.signals).toContain('SIGTERM');
    expect(manager.getState()).toMatchObject({ phase: 'error', ownership: 'none' });
  });
});

describe('BackendManager ownership', () => {
  it('adopts a server this app started in an earlier run', async () => {
    const { manager, client } = setup({ storedPid: 777 });
    client.probes.push(up(777));
    await manager.refresh();
    expect(manager.getState().ownership).toBe('owned');
  });

  it('stops an adopted server by pid, and leaves an external one alone', async () => {
    const adopted = setup({ storedPid: 777 });
    adopted.client.probes.push(up(777));
    await adopted.manager.refresh();
    expect((await adopted.manager.stop()).ok).toBe(true);
    expect(adopted.killed).toEqual([777]);
    expect(adopted.storedPid()).toBeNull();

    const external = setup();
    external.client.probes.push(up(1234));
    await external.manager.refresh();
    const result = await external.manager.stop();
    expect(result.ok).toBe(false);
    expect(external.killed).toEqual([]);
    expect((await external.manager.restart()).ok).toBe(false);
  });
});

describe('BackendManager stop and crash', () => {
  it('stops its own child with SIGTERM', async () => {
    const { manager, client, children } = setup({ sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
    client.probes.push({ kind: 'down', detail: 'ECONNREFUSED' }, up(4242));
    await manager.start();
    const result = await manager.stop();
    expect(result.ok).toBe(true);
    expect(children[0]!.signals).toEqual(['SIGTERM']);
    expect(manager.getState()).toMatchObject({ phase: 'stopped', ownership: 'none' });
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const child = new FakeChild(4242, false);
    const { manager, client } = setup({ spawnServer: () => child as unknown as ChildLike });
    client.probes.push({ kind: 'down', detail: 'ECONNREFUSED' }, up(4242));
    await manager.start();
    await manager.stop();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('kills without a signal name on Windows', async () => {
    const { manager, client, children } = setup({ platform: 'win32' });
    client.probes.push({ kind: 'down', detail: 'ECONNREFUSED' }, up(4242));
    await manager.start();
    await manager.stop();
    expect(children[0]!.signals[0]).toBeUndefined();
  });

  it('does not restart after a crash unless the user opted in', async () => {
    const { manager, client, children } = setup();
    client.probes.push({ kind: 'down', detail: 'ECONNREFUSED' }, up(4242));
    const crashed = vi.fn();
    manager.on('crashed', crashed);
    await manager.start();
    children[0]!.exit(134);
    expect(manager.getState().phase).toBe('error');
    expect(crashed).toHaveBeenCalledWith({ during: 'run', how: expect.stringContaining('134') });
    expect(manager.getState().restartCount).toBe(0);
  });

  it('restarts with backoff and stops after repeated crashes', async () => {
    vi.useFakeTimers();
    const { manager, client, children } = setup({ restartOnCrash: () => true, now: () => 0 });
    client.fallback = up(4242);
    client.probes.push({ kind: 'down', detail: 'ECONNREFUSED' });
    await manager.start();
    for (let i = 0; i < MAX_RESTARTS; i++) {
      children[children.length - 1]!.exit(1);
      client.probes.push({ kind: 'down', detail: 'ECONNREFUSED' });
      await vi.runOnlyPendingTimersAsync();
    }
    expect(children).toHaveLength(MAX_RESTARTS + 1);
    children[children.length - 1]!.exit(1);
    expect(manager.getState().phase).toBe('crash-loop');
    await vi.runOnlyPendingTimersAsync();
    expect(children).toHaveLength(MAX_RESTARTS + 1);
  });
});

describe('BackendManager refresh', () => {
  it('moves from running to unreachable on a timeout, and to stopped on refusal', async () => {
    const { manager, client } = setup();
    client.probes.push(up(1));
    await manager.refresh();
    client.probes.push({ kind: 'down', detail: 'request timed out' });
    await manager.refresh();
    expect(manager.getState().phase).toBe('unreachable');
    client.probes.push({ kind: 'down', detail: 'ECONNREFUSED' });
    await manager.refresh();
    expect(manager.getState()).toMatchObject({ phase: 'stopped', status: null });
  });

  it('flags an incompatible backend version', async () => {
    const { manager, client } = setup({ minBackendVersion: '9.0.0' });
    client.probes.push(up(1));
    await manager.refresh();
    expect(manager.getState().compatibility.ok).toBe(false);
  });

  it('reports a proxy that requires a key it cannot read', async () => {
    const { manager, client } = setup();
    client.probes.push({ kind: 'auth-required', detail: 'x' });
    await manager.refresh();
    expect(manager.getState().phase).toBe('error');
  });

  it('runs control actions only against a running server', async () => {
    const { manager, client } = setup();
    expect((await manager.control('/teamclaude/reload')).ok).toBe(false);
    client.probes.push(up(1));
    await manager.refresh();
    expect((await manager.control('/teamclaude/switch', { account: 'a' })).ok).toBe(true);
    expect(client.posts).toEqual([{ path: '/teamclaude/switch', body: { account: 'a' } }]);
  });
});
