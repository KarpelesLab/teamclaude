// The desktop's lifecycle code against the real backend in this checkout,
// run with the Node that runs the tests (the packaged app uses Electron's own
// Node the same way). No real credentials: placeholder API-key accounts and
// an upstream on port 1, which never listens, so nothing leaves the machine.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BackendClient } from '../../src/services/backend-client';
import { readProxySettings } from '../../src/services/backend-config';
import { BackendManager, type BackendManagerDeps } from '../../src/services/backend-manager';
import { backendSpawnSpec, resolveBackendLocation, type BackendLocation } from '../../src/services/backend-runtime';
import { LogBuffer } from '../../src/services/log-buffer';

const location = resolveBackendLocation({ packaged: false, resourcesPath: '', appPath: resolve(__dirname, '..', '..') }) as BackendLocation;

let dir: string;
let configPath: string;
let port: number;
const managers: BackendManager[] = [];

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = http.createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port: p } = server.address() as AddressInfo;
      server.close(() => done(p));
    });
  });
}

function manager(overrides: Partial<BackendManagerDeps> = {}): BackendManager {
  let ownedPid: number | null = null;
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMROUTER_CONFIG: configPath };
  const m = new BackendManager({
    configPath: () => configPath,
    readSettings: path => readProxySettings(path, {}),
    createClient: (host, p, apiKey) => new BackendClient({ host, port: p, apiKey, timeoutMs: 3000 }),
    spawnServer: () => {
      const spec = backendSpawnSpec(process.execPath, location, ['server', '--headless'], env);
      return spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    },
    serviceInstalled: () => false,
    killPid: (pid, signal) => process.kill(pid, signal),
    ownedPid: { read: () => ownedPid, write: pid => { ownedPid = pid; } },
    log: new LogBuffer(),
    minBackendVersion: '1.0.0',
    restartOnCrash: () => false,
    ...overrides,
  });
  managers.push(m);
  return m;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-desktop-it-'));
  configPath = join(dir, 'teamclaude.json');
  port = await freePort();
  writeFileSync(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port },
    upstream: 'http://127.0.0.1:1',
    accounts: [
      { name: 'placeholder-a', type: 'apikey', apiKey: 'test-key-not-real-aaaa' },
      { name: 'placeholder-b', type: 'apikey', apiKey: 'test-key-not-real-bbbb', priority: 1 },
    ],
  }, null, 2));
});

afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown({ stopOwned: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('desktop ↔ real backend', () => {
  it('starts a backend, reads real status, controls it, and stops it', async () => {
    expect(location).toBeTruthy();
    const m = manager();
    const started = await m.start();
    expect(started, m.getState().lastError ?? '').toMatchObject({ ok: true });
    const state = m.getState();
    expect(state).toMatchObject({ phase: 'running', ownership: 'owned' });
    expect(state.status?.accounts.map(a => a.name).sort()).toEqual(['placeholder-a', 'placeholder-b']);
    expect(state.status?.server.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(state.compatibility.ok).toBe(true);

    // Nothing the renderer receives carries the configured keys.
    expect(JSON.stringify(state)).not.toContain('test-key-not-real');

    const disabled = await m.control('/teamclaude/disable', { account: 'placeholder-b', disabled: true });
    expect(disabled.ok, disabled.error ?? '').toBe(true);
    expect(m.getState().status?.accounts.find(a => a.name === 'placeholder-b')?.disabled).toBe(true);

    const stopped = await m.stop();
    expect(stopped.ok).toBe(true);
    expect(m.getState().phase).toBe('stopped');
    const after = await m.refresh();
    expect(after.phase).toBe('stopped');
  });

  it('a second desktop attaches to the running backend as external and will not stop it', async () => {
    const owner = manager();
    expect((await owner.start()).ok).toBe(true);
    const other = manager({ spawnServer: () => { throw new Error('must not spawn'); } });
    expect((await other.start()).ok).toBe(true);
    expect(other.getState()).toMatchObject({ phase: 'running', ownership: 'external' });
    expect((await other.stop()).ok).toBe(false);
    expect((await owner.refresh()).phase).toBe('running');
  });

  it('reports a foreign server on the port instead of starting over it', async () => {
    const foreign = http.createServer((_req, res) => { res.writeHead(404); res.end('not here'); });
    await new Promise<void>(done => foreign.listen(port, '127.0.0.1', done));
    try {
      const m = manager({ spawnServer: () => { throw new Error('must not spawn'); } });
      const result = await m.start();
      expect(result.ok).toBe(false);
      expect(m.getState().phase).toBe('port-conflict');
    } finally {
      await new Promise(done => foreign.close(done));
    }
  });
});
