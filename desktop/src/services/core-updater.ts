// Keeps the proxy core (the TeamClaude backend) current with upstream's npm
// releases, independently of this app's own updates. A release is fetched from
// the registry, checked against the registry's sha512, unpacked into userData,
// test-run, and only then made the core new proxy starts use. A proxy this app
// owns is restarted on it; if it does not come up, the previous core goes back
// and that version is not installed automatically again.
//
// The bundled copy is never touched, so there is always a known-good core to
// fall back to, and an app update that ships a newer bundled core wins over
// an older download.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActionResult, CoreSource, CoreUpdateState } from '../shared/types';
import type { Timers } from './app-updater';
import type { BackendLocation } from './backend-runtime';
import { describeError } from './sanitize';
import { readTarGz } from './tar';
import { httpsJson, REGISTRY_URL, type JsonGetter } from './update-check';
import { compareVersions, parseVersion } from './version';

export const PACKAGE_NAME = '@karpeleslab/teamclaude';
export const FIRST_CHECK_DELAY_MS = 2 * 60_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
export const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
/** The registry's signing keys, the ones `npm audit signatures` checks against. */
export const REGISTRY_KEYS_URL = 'https://registry.npmjs.org/-/npm/v1/keys';
/** The full packument; only read for publish times. */
export const PACKUMENT_URL = 'https://registry.npmjs.org/@karpeleslab%2fteamclaude';
const SIGNING_ALGORITHM = 'ecdsa-sha2-nistp256';
const STATE_FILE = 'state.json';

export interface RegistrySignature {
  keyid: string;
  sig: string;
}

export interface CoreManifest {
  version: string;
  tarball: string;
  integrity: string;
  signatures: RegistrySignature[];
}

export interface RegistryKey {
  keyid: string;
  keytype: string;
  scheme: string;
  key: string;
  expires: string | null;
}

function parseSignatures(raw: unknown): RegistrySignature[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .filter(s => typeof s.keyid === 'string' && s.keyid !== '' && typeof s.sig === 'string' && s.sig !== '')
    .map(s => ({ keyid: s.keyid as string, sig: s.sig as string }));
}

/** The registry's answer for `latest`, accepted only in the exact shape npm publishes. */
export function parseManifest(body: unknown): CoreManifest {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const dist = b.dist && typeof b.dist === 'object' ? b.dist as Record<string, unknown> : {};
  const { version } = b;
  if (b.name !== PACKAGE_NAME || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('the registry did not describe a TeamClaude release');
  }
  // Only the registry's own tarball URL for this exact version is fetched.
  const expected = `https://registry.npmjs.org/${PACKAGE_NAME}/-/teamclaude-${version}.tgz`;
  if (dist.tarball !== expected) throw new Error(`unexpected tarball location: ${String(dist.tarball)}`);
  if (typeof dist.integrity !== 'string' || !dist.integrity.startsWith('sha512-')) throw new Error('the release has no sha512 checksum');
  const signatures = parseSignatures(dist.signatures);
  if (signatures.length === 0) throw new Error('the release carries no npm registry signature');
  return { version, tarball: expected, integrity: dist.integrity, signatures };
}

/** The registry's `/-/npm/v1/keys` answer; malformed entries are dropped. */
export function parseRegistryKeys(body: unknown): RegistryKey[] {
  const keys = body && typeof body === 'object' ? (body as { keys?: unknown }).keys : null;
  if (!Array.isArray(keys)) throw new Error('the registry did not list its signing keys');
  return keys
    .filter((k): k is Record<string, unknown> => !!k && typeof k === 'object')
    .filter(k => typeof k.keyid === 'string' && typeof k.keytype === 'string' && typeof k.scheme === 'string'
      && typeof k.key === 'string' && (k.expires === null || typeof k.expires === 'string'))
    .map(k => ({ keyid: k.keyid as string, keytype: k.keytype as string, scheme: k.scheme as string, key: k.key as string, expires: k.expires as string | null }));
}

/** Keys of the right algorithm that could have signed this manifest. */
function candidateKeys(manifest: CoreManifest, keys: RegistryKey[]): RegistryKey[] {
  const ids = new Set(manifest.signatures.map(s => s.keyid));
  return keys.filter(k => ids.has(k.keyid) && k.keytype === SIGNING_ALGORITHM && k.scheme === SIGNING_ALGORITHM);
}

/** Whether verifying needs the publish time (a signing key has an expiry). */
export function needsPublishTime(manifest: CoreManifest, keys: RegistryKey[]): boolean {
  return candidateKeys(manifest, keys).some(k => k.expires !== null);
}

/** The publish time of `version` from a full packument, or null. */
export function publishTime(packument: unknown, version: string): number | null {
  const time = packument && typeof packument === 'object' ? (packument as { time?: unknown }).time : null;
  const raw = time && typeof time === 'object' ? (time as Record<string, unknown>)[version] : null;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function keyValidAt(key: RegistryKey, publishedAt: number | null): boolean {
  if (key.expires === null) return true;
  const expires = Date.parse(key.expires);
  return publishedAt !== null && Number.isFinite(expires) && publishedAt < expires;
}

/**
 * The check `npm audit signatures` makes: an ECDSA P-256/SHA-256 signature by a
 * current registry key over `${name}@${version}:${integrity}`.
 */
export function verifyRegistrySignature(manifest: CoreManifest, name: string, keys: RegistryKey[], publishedAt: number | null): boolean {
  const message = Buffer.from(`${name}@${manifest.version}:${manifest.integrity}`, 'utf8');
  const usable = candidateKeys(manifest, keys).filter(k => keyValidAt(k, publishedAt));
  return manifest.signatures.some(({ keyid, sig }) => usable.some(k => {
    if (k.keyid !== keyid) return false;
    try {
      const publicKey = createPublicKey({ key: Buffer.from(k.key, 'base64'), format: 'der', type: 'spki' });
      return verify('sha256', message, publicKey, Buffer.from(sig, 'base64'));
    } catch {
      return false;
    }
  }));
}

export function matchesIntegrity(data: Buffer, integrity: string): boolean {
  return `sha512-${createHash('sha512').update(data).digest('base64')}` === integrity;
}

export const httpsBuffer = (url: string, maxBytes: number, timeoutMs = 60_000): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download answered HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new Error('download is larger than any TeamClaude release'));
        else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });

interface StoreState {
  active: string | null;
  rejected: string[];
}

/** userData/core: one directory per downloaded version plus state.json. */
export class CoreStore {
  constructor(readonly dir: string) {}

  read(): StoreState {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.dir, STATE_FILE), 'utf8'));
      const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const active = typeof r.active === 'string' && parseVersion(r.active) ? r.active : null;
      const rejected = Array.isArray(r.rejected) ? r.rejected.filter((v): v is string => typeof v === 'string') : [];
      return { active, rejected };
    } catch {
      return { active: null, rejected: [] };
    }
  }

  write(state: StoreState): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, STATE_FILE);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  location(version: string): BackendLocation {
    const root = join(this.dir, version);
    return { root, entry: join(root, 'src', 'index.js'), source: 'bundled' };
  }

  /** The downloaded core to use, when it is valid and newer than the bundled one. */
  usable(bundledVersion: string | null): { version: string; location: BackendLocation } | null {
    const { active } = this.read();
    if (!active) return null;
    const location = this.location(active);
    if (!existsSync(location.entry)) return null;
    if (bundledVersion && compareVersions(active, bundledVersion) !== 1) return null;
    return { version: active, location };
  }

  /** Unpack an npm tarball's package/ into <dir>/<version>, replacing any earlier attempt. */
  unpack(version: string, tarball: Buffer): BackendLocation {
    const files = readTarGz(tarball);
    const target = join(this.dir, version);
    const partial = `${target}.partial`;
    rmSync(partial, { recursive: true, force: true });
    for (const file of files) {
      if (!file.path.startsWith('package/')) continue;
      const rel = file.path.slice('package/'.length);
      if (!(rel.startsWith('src/') || rel === 'package.json' || rel === 'LICENSE')) continue;
      const out = join(partial, rel);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, file.data);
    }
    const pkg = readPackage(partial);
    if (pkg.name !== PACKAGE_NAME || pkg.version !== version) throw new Error('the downloaded package is not the expected release');
    if (!existsSync(join(partial, 'src', 'index.js'))) throw new Error('the downloaded package has no src/index.js');
    rmSync(target, { recursive: true, force: true });
    renameSync(partial, target);
    return this.location(version);
  }

  /** Remove every downloaded version except those listed. */
  prune(keep: Array<string | null>): void {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === STATE_FILE || keep.includes(name)) continue;
      rmSync(join(this.dir, name), { recursive: true, force: true });
    }
  }
}

function readPackage(root: string): { name?: unknown; version?: unknown } {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return pkg && typeof pkg === 'object' ? pkg : {};
  } catch {
    return {};
  }
}

export interface CoreChoice {
  location: BackendLocation;
  version: string | null;
  source: CoreSource;
}

export interface CoreUpdaterOptions {
  store: CoreStore;
  /** What the app started with (see main/index.ts); null when no backend was found. */
  initial: CoreChoice | null;
  bundled: CoreChoice | null;
  minVersion: string;
  auto: () => boolean;
  /** Point new proxy starts at this core and restart a proxy the app owns; ok=false when it did not come up. */
  activate: (location: BackendLocation) => Promise<ActionResult>;
  /** Run `teamclaude --version` from this core; resolves with what it printed. */
  smokeTest: (location: BackendLocation) => Promise<string>;
  getJson?: JsonGetter;
  download?: (url: string, maxBytes: number) => Promise<Buffer>;
  log?: (text: string) => void;
  clock?: () => number;
  timers?: Timers;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clear: handle => { clearTimeout(handle as NodeJS.Timeout); clearInterval(handle as NodeJS.Timeout); },
};

export type RevertResult = ActionResult & { version: string | null };

export class CoreUpdater extends EventEmitter {
  private state: CoreUpdateState;
  private current: CoreChoice | null;
  private manifest: CoreManifest | null = null;
  private busy: Promise<unknown> | null = null;
  private handles: unknown[] = [];
  private readonly getJson: JsonGetter;
  private readonly download: (url: string, maxBytes: number) => Promise<Buffer>;
  private readonly log: (text: string) => void;
  private readonly clock: () => number;
  private readonly timers: Timers;

  constructor(private readonly opts: CoreUpdaterOptions) {
    super();
    this.current = opts.initial;
    this.getJson = opts.getJson ?? httpsJson;
    this.download = opts.download ?? httpsBuffer;
    this.log = opts.log ?? (() => {});
    this.clock = opts.clock ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    const unsupported = !opts.initial ? 'no-backend' : opts.initial.source === 'checkout' ? 'development' : null;
    this.state = {
      unsupported,
      phase: 'idle',
      active: opts.initial?.version ?? null,
      source: opts.initial?.source ?? null,
      bundled: opts.bundled?.version ?? null,
      latest: null,
      error: null,
      rolledBack: null,
      checkedAt: null,
    };
  }

  getState(): CoreUpdateState {
    return this.state;
  }

  start(): void {
    this.applyAuto(this.opts.auto());
  }

  applyAuto(on: boolean): void {
    for (const h of this.handles) this.timers.clear(h);
    this.handles = [];
    if (!on || this.state.unsupported) return;
    this.handles.push(
      this.timers.setTimeout(() => { void this.check(); }, FIRST_CHECK_DELAY_MS),
      this.timers.setInterval(() => { void this.check(); }, CHECK_INTERVAL_MS),
    );
  }

  /** Look for a newer release; in automatic mode, install it straight away. */
  check(): Promise<CoreUpdateState> {
    return this.exclusive(async () => {
      this.set({ phase: 'checking', error: null });
      let manifest: CoreManifest;
      try {
        manifest = parseManifest(await this.getJson(REGISTRY_URL, 10_000));
      } catch (err) {
        return this.fail(err);
      }
      this.manifest = manifest;
      this.set({ latest: manifest.version, checkedAt: this.clock() });
      if (compareVersions(manifest.version, this.state.active) !== 1) return this.set({ phase: 'up-to-date' });
      const rejected = this.opts.store.read().rejected.includes(manifest.version);
      if (!this.opts.auto() || rejected) return this.set({ phase: 'available' });
      return this.installManifest(manifest);
    }, () => this.state);
  }

  /** Install the release the last check found (also one that was rolled back before). */
  install(): Promise<CoreUpdateState> {
    return this.exclusive(async () => {
      if (!this.manifest || this.state.phase !== 'available') return this.state;
      return this.installManifest(this.manifest);
    }, () => this.state);
  }

  /** Go back to the core shipped inside the app. */
  revert(): Promise<RevertResult> {
    const bundledVersion = this.opts.bundled?.version ?? null;
    return this.exclusive<RevertResult>(async () => {
      const bundled = this.opts.bundled;
      if (!bundled || this.current?.source === 'bundled') return { ok: false, message: '', version: bundledVersion };
      const result = await this.opts.activate(bundled.location);
      this.current = bundled;
      this.opts.store.write({ ...this.opts.store.read(), active: null });
      this.opts.store.prune([]);
      this.set({ active: bundled.version, source: 'bundled', phase: 'idle', rolledBack: null });
      return { ...result, version: bundled.version };
    }, () => ({ ok: false, message: '', version: bundledVersion }));
  }

  private async installManifest(manifest: CoreManifest): Promise<CoreUpdateState> {
    const { version } = manifest;
    if (compareVersions(version, this.opts.minVersion) === -1) return this.fail(new Error(`${version} is older than this app supports`));
    this.set({ phase: 'installing', latest: version, error: null });
    this.log(`Installing TeamClaude ${version} from npm.`);
    const store = this.opts.store;
    let location: BackendLocation;
    try {
      await this.verifySignature(manifest);
      const tarball = await this.download(manifest.tarball, MAX_TARBALL_BYTES);
      if (!matchesIntegrity(tarball, manifest.integrity)) throw new Error('the download does not match the registry checksum');
      location = store.unpack(version, tarball);
      const printed = (await this.opts.smokeTest(location)).trim();
      if (printed !== version) throw new Error(`test run printed "${printed.slice(0, 80)}" instead of ${version}`);
    } catch (err) {
      store.prune([store.read().active]);
      return this.fail(err);
    }

    const previous = this.current;
    const result = await this.opts.activate(location);
    if (!result.ok && previous) {
      this.log(`TeamClaude ${version} did not start (${result.message}); going back to ${previous.version ?? 'the previous core'}.`);
      await this.opts.activate(previous.location);
      const stored = store.read();
      store.write({ ...stored, rejected: [...new Set([...stored.rejected, version])] });
      store.prune([stored.active]);
      return this.set({ phase: 'error', error: result.message, rolledBack: { version, previous: previous.version ?? '' } });
    }
    this.current = { location, version, source: 'downloaded' };
    store.write({ ...store.read(), active: version });
    store.prune([version]);
    this.log(`The proxy core is now TeamClaude ${version}.`);
    this.set({ phase: 'up-to-date', active: version, source: 'downloaded', rolledBack: null });
    this.emit('installed', version);
    return this.state;
  }

  private async verifySignature(manifest: CoreManifest): Promise<void> {
    const keys = parseRegistryKeys(await this.getJson(REGISTRY_KEYS_URL, 10_000));
    const publishedAt = needsPublishTime(manifest, keys)
      ? publishTime(await this.getJson(PACKUMENT_URL, 30_000), manifest.version)
      : null;
    if (!verifyRegistrySignature(manifest, PACKAGE_NAME, keys, publishedAt)) throw new Error('the release is not signed by the npm registry');
  }

  /** One operation at a time; a call made while another runs gets `whenBusy()`. */
  private exclusive<T>(task: () => Promise<T>, whenBusy: () => T): Promise<T> {
    if (this.state.unsupported || this.busy) return Promise.resolve(whenBusy());
    const job = task().finally(() => { this.busy = null; });
    this.busy = job;
    return job;
  }

  private fail(err: unknown): CoreUpdateState {
    const message = describeError(err).split('\n')[0] ?? 'update failed';
    this.log(`Core update failed: ${message}`);
    return this.set({ phase: 'error', error: message, checkedAt: this.clock() });
  }

  private set(patch: Partial<CoreUpdateState>): CoreUpdateState {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
    return this.state;
  }
}
