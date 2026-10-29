// Lifecycle of the proxy as seen from the desktop: attach to a server that is
// already running, or start one and own it; stop only what we own; notice a
// crash and restart with a bounded backoff. Readiness is always a real
// /teamclaude/status answer, never a timer.
//
// Everything that touches the OS is injected (spawn, the HTTP client, the
// config reader, timers), so the state machine is unit-tested without
// Electron and integration-tested against the real backend.

import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { translator, type Translate } from '../shared/i18n';
import type { ActionResult, BackendState, ProxyPhase } from '../shared/types';
import type { ControlPath, ControlResult, ProbeResult } from './backend-client';
import type { ProxySettingsResult } from './backend-config';
import type { LogBuffer } from './log-buffer';
import { normalizeStatus } from './normalize';
import { describeError, sanitizeText } from './sanitize';
import { checkCompatibility } from './version';

export interface ChildLike {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export interface ClientLike {
  readonly baseUrl: string;
  probe(): Promise<ProbeResult>;
  post(path: ControlPath, body?: Record<string, unknown>): Promise<ControlResult>;
}

export interface OwnedPidStore {
  read(): number | null;
  write(pid: number | null): void;
}

export interface BackendManagerDeps {
  configPath: () => string;
  readSettings: (configPath: string) => ProxySettingsResult;
  createClient: (host: string, port: number, apiKey: string | null) => ClientLike;
  /** Spawn `teamclaude server --headless`; null when no backend is available. */
  spawnServer: () => ChildLike | null;
  serviceInstalled: () => boolean;
  /** Kill a process by pid (an adopted backend from an earlier desktop run). */
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  ownedPid: OwnedPidStore;
  log: LogBuffer;
  minBackendVersion: string;
  restartOnCrash: () => boolean;
  /** The current UI language's translator; English when omitted. */
  t?: () => Translate;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  stopTimeoutMs?: number;
}

/** Crash policy: at most MAX_RESTARTS automatic restarts within RESTART_WINDOW_MS. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 5 * 60_000;
const RESTART_BASE_DELAY_MS = 2000;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const english = translator('en');

export class BackendManager extends EventEmitter {
  private state: BackendState;
  private client: ClientLike | null = null;
  private accountCount = 0;
  private child: ChildLike | null = null;
  /** pid of a backend we started in an earlier run and found still serving. */
  private adoptedPid: number | null = null;
  private stopping = false;
  private crashTimes: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<BackendState> | null = null;
  private starting: Promise<ActionResult> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly deps: BackendManagerDeps) {
    super();
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.platform = deps.platform ?? process.platform;
    const configPath = deps.configPath();
    const { settings, exists } = deps.readSettings(configPath);
    this.state = {
      phase: 'stopped',
      ownership: 'none',
      host: settings.connectHost,
      port: settings.port,
      endpoint: `http://${settings.connectHost}:${settings.port}`,
      childPid: null,
      lastError: null,
      restartCount: 0,
      serviceInstalled: deps.serviceInstalled(),
      compatibility: { ok: true, message: null },
      status: null,
      statusAt: null,
      configPath,
      configExists: exists,
    };
  }

  private get t(): Translate {
    return this.deps.t?.() ?? english;
  }

  getState(): BackendState {
    return this.state;
  }

  private update(patch: Partial<BackendState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  private setPhase(phase: ProxyPhase, patch: Partial<BackendState> = {}): void {
    this.update({ ...patch, phase });
  }

  /** Re-read the config's proxy fields and build a client for them. */
  private connect(): ClientLike {
    const configPath = this.deps.configPath();
    const { settings, exists, error } = this.deps.readSettings(configPath);
    if (error) this.deps.log.note(this.t('b.configNote', { error }));
    this.accountCount = settings.accountCount;
    this.client = this.deps.createClient(settings.connectHost, settings.port, settings.apiKey);
    this.update({
      host: settings.connectHost,
      port: settings.port,
      endpoint: this.client.baseUrl,
      configPath,
      configExists: exists,
      serviceInstalled: this.deps.serviceInstalled(),
    });
    return this.client;
  }

  private ownsPid(pid: number | null): boolean {
    if (pid === null) return false;
    return (this.child?.pid !== undefined && pid === this.child.pid) || pid === this.adoptedPid;
  }

  /** Apply a successful status read. */
  private applyStatus(raw: Record<string, unknown>): void {
    const status = normalizeStatus(raw);
    const serverPid = status.server.pid;
    let ownership = this.state.ownership;
    if (this.child && this.ownsPid(serverPid)) ownership = 'owned';
    else if (!this.child && serverPid !== null && serverPid === this.deps.ownedPid.read()) {
      // Started by this app in an earlier run and still serving — e.g. the
      // window was closed with "keep proxy running", or the app crashed.
      this.adoptedPid = serverPid;
      ownership = 'owned';
    } else if (!this.ownsPid(serverPid)) ownership = 'external';
    this.update({
      phase: 'running',
      ownership,
      status,
      statusAt: this.now(),
      lastError: null,
      compatibility: checkCompatibility(status.server.version, this.deps.minBackendVersion, this.t),
    });
  }

  /** Poll once. Safe to call concurrently; overlapping calls share one probe. */
  refresh(): Promise<BackendState> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<BackendState> {
    if (this.state.phase === 'starting' || this.state.phase === 'stopping') return this.state;
    // Re-read the config while nothing is attached, so a port changed on disk
    // (or a config created by a first login) is picked up.
    const client = this.client && this.state.phase === 'running' ? this.client : this.connect();
    const started = this.now();
    const result = await client.probe();
    if (result.kind === 'teamclaude') this.state = { ...this.state, statusLatencyMs: this.now() - started };
    this.applyProbe(result);
    return this.state;
  }

  private applyProbe(result: ProbeResult): void {
    switch (result.kind) {
      case 'teamclaude':
        this.applyStatus(result.raw);
        return;
      case 'auth-required':
        this.setPhase('error', { ownership: 'external', lastError: this.t('b.authRequired') });
        return;
      case 'foreign':
        this.setPhase('port-conflict', {
          ownership: 'none',
          status: null,
          lastError: this.t('b.portConflict', { port: this.state.port, detail: result.detail }),
        });
        return;
      case 'down': {
        if (this.child) {
          // Our process is alive but does not answer: report it, do not kill it.
          this.setPhase('unreachable', { lastError: this.t('b.notAnswering', { detail: result.detail }) });
          return;
        }
        const refused = result.detail === 'ECONNREFUSED';
        const wasRunning = this.state.phase === 'running' || this.state.phase === 'unreachable';
        if (refused || !wasRunning) {
          if (this.adoptedPid !== null) this.clearAdopted();
          this.setPhase(this.state.phase === 'crash-loop' || this.state.phase === 'error' ? this.state.phase : 'stopped', {
            ownership: 'none',
            status: null,
          });
        } else {
          this.setPhase('unreachable', { lastError: this.t('b.stoppedAnswering', { detail: result.detail }) });
        }
      }
    }
  }

  private clearAdopted(): void {
    this.adoptedPid = null;
    this.deps.ownedPid.write(null);
  }

  /** Start the proxy, or attach to the one already serving. */
  start(): Promise<ActionResult> {
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async doStart(): Promise<ActionResult> {
    this.cancelRestart();
    if (this.child) return { ok: true, message: this.t('b.alreadyRunning') };
    const client = this.connect();
    const probe = await client.probe();
    if (probe.kind === 'teamclaude') {
      this.applyStatus(probe.raw);
      const who = this.t(this.state.ownership === 'owned' ? 'b.whoOwned' : 'b.whoExternal');
      this.deps.log.note(this.t('b.attached', { url: client.baseUrl, who }));
      return { ok: true, message: this.t('b.connected', { who }) };
    }
    if (probe.kind !== 'down') {
      this.applyProbe(probe);
      return { ok: false, message: this.state.lastError ?? this.t('b.portUnavailable') };
    }
    // The server refuses to start with an empty pool; say so before trying.
    if (this.accountCount === 0) return { ok: false, message: this.t('b.noAccounts') };
    return this.spawnAndWait(client);
  }

  private async spawnAndWait(client: ClientLike): Promise<ActionResult> {
    let child: ChildLike | null;
    try {
      child = this.deps.spawnServer();
    } catch (err) {
      const message = this.t('b.spawnFailed', { error: describeError(err) });
      this.setPhase('error', { lastError: message });
      return { ok: false, message };
    }
    if (!child) {
      const message = this.t('b.notBundled');
      this.setPhase('error', { lastError: message });
      return { ok: false, message };
    }
    this.child = child;
    this.stopping = false;
    this.attachChild(child);
    this.setPhase('starting', { ownership: 'owned', childPid: child.pid ?? null, lastError: null, status: null });
    this.deps.log.note(this.t('b.starting', { pid: child.pid ?? '?', url: client.baseUrl }));

    const deadline = this.now() + (this.deps.readyTimeoutMs ?? 45_000);
    const pollMs = this.deps.readyPollMs ?? 300;
    while (this.now() < deadline) {
      if (this.child !== child) {
        // It exited while we waited; the exit handler has set the error.
        return { ok: false, message: this.state.lastError ?? this.t('b.exitedStartup') };
      }
      const result = await client.probe();
      if (result.kind === 'teamclaude') {
        const pid = typeof (result.raw.server as { pid?: unknown } | undefined)?.pid === 'number'
          ? (result.raw.server as { pid: number }).pid : null;
        if (pid === null || pid === child.pid) {
          if (child.pid !== undefined) this.deps.ownedPid.write(child.pid);
          this.applyStatus(result.raw);
          this.update({ ownership: 'owned' });
          this.deps.log.note(this.t('b.ready'));
          return { ok: true, message: this.t('b.running') };
        }
        // Another TeamClaude took the port first; ours will exit with EADDRINUSE.
      }
      await this.sleep(pollMs);
    }
    const message = this.t('b.notReady');
    this.deps.log.note(message);
    await this.killChild(child);
    this.setPhase('error', { lastError: message, ownership: 'none' });
    return { ok: false, message };
  }

  private attachChild(child: ChildLike): void {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.deps.log.write('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => this.deps.log.write('stderr', chunk));
    child.on('error', err => {
      this.deps.log.note(this.t('b.processError', { error: describeError(err) }));
      if (this.child === child && child.pid === undefined) this.onChildExit(child, null, null, describeError(err));
    });
    child.on('exit', (code, signal) => this.onChildExit(child, code, signal));
  }

  private onChildExit(child: ChildLike, code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void {
    if (this.child !== child) return;
    this.deps.log.flush('stdout');
    this.deps.log.flush('stderr');
    this.child = null;
    this.deps.ownedPid.write(null);
    const how = spawnError ?? (signal ? this.t('b.signal', { signal }) : this.t('b.exitCode', { code: code ?? '?' }));
    if (this.stopping) {
      this.stopping = false;
      this.deps.log.note(this.t('b.stoppedHow', { how }));
      this.setPhase('stopped', { ownership: 'none', childPid: null, status: null });
      return;
    }
    const tail = this.deps.log.tail(8).join('\n');
    const summary = this.t('b.exitedUnexpectedly', { how });
    const lastError = sanitizeText(tail ? `${summary}\n${this.t('b.lastOutput')}\n${tail}` : summary);
    this.deps.log.note(summary);
    const wasStarting = this.state.phase === 'starting';
    this.setPhase('error', { ownership: 'none', childPid: null, status: null, lastError });
    this.emit('crashed', { during: wasStarting ? 'startup' : 'run', how });
    if (!wasStarting) this.maybeRestart();
  }

  private maybeRestart(): void {
    if (!this.deps.restartOnCrash()) return;
    const now = this.now();
    this.crashTimes = [...this.crashTimes.filter(t => now - t < RESTART_WINDOW_MS), now];
    if (this.crashTimes.length > MAX_RESTARTS) {
      const message = this.t('b.crashLoop', { n: this.crashTimes.length, minutes: RESTART_WINDOW_MS / 60_000 });
      this.deps.log.note(message);
      this.setPhase('crash-loop', { lastError: message });
      return;
    }
    const delay = RESTART_BASE_DELAY_MS * 2 ** (this.crashTimes.length - 1);
    this.deps.log.note(this.t('b.restarting', { s: Math.round(delay / 1000), n: this.crashTimes.length, max: MAX_RESTARTS }));
    this.update({ restartCount: this.state.restartCount + 1 });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, delay);
  }

  private cancelRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** Stop the proxy if this app owns it. A server started elsewhere is left alone. */
  async stop(): Promise<ActionResult> {
    this.cancelRestart();
    this.crashTimes = [];
    if (this.child) {
      this.setPhase('stopping');
      await this.killChild(this.child);
      return { ok: true, message: this.t('b.stopped') };
    }
    if (this.adoptedPid !== null) {
      const pid = this.adoptedPid;
      this.setPhase('stopping');
      try {
        this.deps.killPid(pid, 'SIGTERM');
      } catch (err) {
        this.clearAdopted();
        this.setPhase('stopped', { ownership: 'none', status: null });
        return { ok: true, message: this.t('b.alreadyExited', { error: describeError(err) }) };
      }
      this.clearAdopted();
      this.deps.log.note(this.t('b.stoppedAdopted', { pid }));
      this.setPhase('stopped', { ownership: 'none', status: null });
      return { ok: true, message: this.t('b.stopped') };
    }
    if (this.state.phase === 'running' && this.state.ownership === 'external') {
      return { ok: false, message: this.t(this.state.serviceInstalled ? 'b.serviceStop' : 'b.externalStop') };
    }
    if (this.state.phase === 'crash-loop' || this.state.phase === 'error') this.setPhase('stopped', { lastError: null });
    return { ok: true, message: this.t('b.notRunning') };
  }

  /**
   * End our child. POSIX gets SIGTERM, which the backend handles by saving
   * its quota state; after the grace period, SIGKILL. Windows has no signals:
   * kill() terminates the process at once. The backend writes its config
   * atomically, so that cannot corrupt it; quota readings since the last
   * minute's save are re-learned from traffic.
   */
  private async killChild(child: ChildLike): Promise<void> {
    if (child.exitCode !== null) return;
    this.stopping = true;
    const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
    child.kill(this.platform === 'win32' ? undefined : 'SIGTERM');
    const timeout = this.sleep(this.deps.stopTimeoutMs ?? 6000).then(() => 'timeout' as const);
    if (await Promise.race([exited.then(() => 'exited' as const), timeout]) === 'timeout') {
      this.deps.log.note(this.t('b.forcing'));
      child.kill('SIGKILL');
      await Promise.race([exited, this.sleep(2000)]);
    }
  }

  async restart(): Promise<ActionResult> {
    if (this.state.ownership === 'external') return { ok: false, message: this.t('b.externalRestart') };
    const stopped = await this.stop();
    if (!stopped.ok) return stopped;
    return this.start();
  }

  /** Run a control action against the attached server, then refresh. */
  async control(path: ControlPath, body?: Record<string, unknown>): Promise<ControlResult> {
    if (!this.client || this.state.phase !== 'running') {
      return { ok: false, status: 0, body: null, error: this.t('b.notRunning') };
    }
    const result = await this.client.post(path, body);
    await this.refresh();
    return result.error ? { ...result, error: sanitizeText(result.error) } : result;
  }

  startPolling(intervalMs: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => { void this.refresh(); }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** On quit: stop timers and end the process we own. */
  async shutdown({ stopOwned }: { stopOwned: boolean }): Promise<void> {
    this.stopPolling();
    this.cancelRestart();
    if (stopOwned) await this.stop();
  }
}
