import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '../src/shared/types';
import type { BackendLocation } from '../src/services/backend-runtime';
import {
  CoreStore, CoreUpdater, matchesIntegrity, PACKUMENT_URL, parseManifest, REGISTRY_KEYS_URL, verifyRegistrySignature,
  type CoreChoice, type CoreManifest, type RegistryKey,
} from '../src/services/core-updater';
import { readTarGz, safeTarPath } from '../src/services/tar';
import { REGISTRY_URL } from '../src/services/update-check';

/** A ustar archive from [path, content, type] entries, gzipped. */
function tarGz(entries: Array<[string, string, string?]>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content, type = '0'] of entries) {
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${Buffer.byteLength(content).toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write(type, 156);
    header.write('ustar\0', 257);
    header.write('        ', 148);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header);
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
    body.write(content);
    blocks.push(body);
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const integrity = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;
const TARBALL = (v: string) => `https://registry.npmjs.org/@karpeleslab/teamclaude/-/teamclaude-${v}.tgz`;

const NAME = '@karpeleslab/teamclaude';
const KEYID = 'SHA256:test-key';
const EXPIRES = '2025-01-29T00:00:00.000Z';
const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = (key: typeof signer.publicKey) => key.export({ format: 'der', type: 'spki' }).toString('base64');
const registryKey = (over: Partial<RegistryKey> = {}): RegistryKey =>
  ({ keyid: KEYID, keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', key: spki(signer.publicKey), expires: null, ...over });
const signText = (text: string) => sign('sha256', Buffer.from(text), signer.privateKey).toString('base64');
const signFor = (version: string, integ: string) => signText(`${NAME}@${version}:${integ}`);

function release(version: string): Buffer {
  return tarGz([
    ['package/package.json', JSON.stringify({ name: '@karpeleslab/teamclaude', version, type: 'module' })],
    ['package/src/index.js', 'console.log("hi")'],
    ['package/LICENSE', 'MIT'],
    ['package/README.md', 'not copied'],
  ]);
}

describe('tar reader', () => {
  it('reads regular files and refuses links and escaping paths', () => {
    expect(readTarGz(tarGz([['package/a.txt', 'A']]))).toEqual([{ path: 'package/a.txt', data: Buffer.from('A') }]);
    expect(() => readTarGz(tarGz([['package/../../evil', 'x']]))).toThrow(/unsafe path/);
    expect(() => readTarGz(tarGz([['package/link', '', '2']]))).toThrow(/entry type/);
    expect(safeTarPath('/etc/passwd')).toBeNull();
    expect(safeTarPath('C:/x')).toBeNull();
    expect(safeTarPath('a/./b')).toBe('a/b');
  });
});

describe('parseManifest', () => {
  const signatures = [{ keyid: KEYID, sig: 'MEUC' }];
  const good = { name: '@karpeleslab/teamclaude', version: '1.2.3', dist: { tarball: TARBALL('1.2.3'), integrity: 'sha512-abc', signatures } };

  it('accepts the registry shape', () => {
    expect(parseManifest(good)).toEqual({ version: '1.2.3', tarball: TARBALL('1.2.3'), integrity: 'sha512-abc', signatures });
  });

  it('refuses another package, another host, or a missing checksum', () => {
    expect(() => parseManifest({ ...good, name: 'evil' })).toThrow();
    expect(() => parseManifest({ ...good, dist: { ...good.dist, tarball: 'https://evil.example/x.tgz' } })).toThrow(/tarball/);
    expect(() => parseManifest({ ...good, dist: { ...good.dist, integrity: 'sha1-x' } })).toThrow(/sha512/);
    expect(() => parseManifest({ ...good, version: '1.2.3-beta' })).toThrow();
  });

  it('refuses a release without a well-formed signature', () => {
    expect(() => parseManifest({ ...good, dist: { ...good.dist, signatures: undefined } })).toThrow(/signature/);
    expect(() => parseManifest({ ...good, dist: { ...good.dist, signatures: [] } })).toThrow(/signature/);
    expect(() => parseManifest({ ...good, dist: { ...good.dist, signatures: [{ keyid: KEYID }, 'x', null] } })).toThrow(/signature/);
  });

  it('checks integrity', () => {
    const data = Buffer.from('payload');
    expect(matchesIntegrity(data, integrity(data))).toBe(true);
    expect(matchesIntegrity(Buffer.from('other'), integrity(data))).toBe(false);
  });
});

describe('verifyRegistrySignature', () => {
  const integ = integrity(Buffer.from('payload'));
  const manifest = (over: Partial<CoreManifest> = {}): CoreManifest =>
    ({ version: '1.2.3', tarball: TARBALL('1.2.3'), integrity: integ, signatures: [{ keyid: KEYID, sig: signFor('1.2.3', integ) }], ...over });

  it('accepts a signature by a current registry key', () => {
    expect(verifyRegistrySignature(manifest(), NAME, [registryKey()], null)).toBe(true);
  });

  it('refuses a tampered integrity, version, name or signature', () => {
    expect(verifyRegistrySignature(manifest({ integrity: integrity(Buffer.from('other')) }), NAME, [registryKey()], null)).toBe(false);
    expect(verifyRegistrySignature(manifest({ version: '1.2.4' }), NAME, [registryKey()], null)).toBe(false);
    expect(verifyRegistrySignature(manifest(), 'evil', [registryKey()], null)).toBe(false);
    expect(verifyRegistrySignature(manifest({ signatures: [{ keyid: KEYID, sig: signText('other') }] }), NAME, [registryKey()], null)).toBe(false);
    expect(verifyRegistrySignature(manifest({ signatures: [{ keyid: KEYID, sig: 'bm90LWRlcg==' }] }), NAME, [registryKey()], null)).toBe(false);
  });

  it('refuses an unknown key, another algorithm, or a key from another pair', () => {
    expect(verifyRegistrySignature(manifest(), NAME, [registryKey({ keyid: 'SHA256:other' })], null)).toBe(false);
    expect(verifyRegistrySignature(manifest(), NAME, [registryKey({ keytype: 'ed25519' })], null)).toBe(false);
    expect(verifyRegistrySignature(manifest(), NAME, [registryKey({ scheme: 'rsa' })], null)).toBe(false);
    const stranger = spki(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey);
    expect(verifyRegistrySignature(manifest(), NAME, [registryKey({ key: stranger })], null)).toBe(false);
  });

  it('honours key expiry against the publish time', () => {
    const expiring = [registryKey({ expires: EXPIRES })];
    expect(verifyRegistrySignature(manifest(), NAME, expiring, Date.parse('2024-06-01T00:00:00Z'))).toBe(true);
    expect(verifyRegistrySignature(manifest(), NAME, expiring, Date.parse('2025-06-01T00:00:00Z'))).toBe(false);
    expect(verifyRegistrySignature(manifest(), NAME, expiring, null)).toBe(false);
  });
});

describe('CoreUpdater', () => {
  let dir: string;
  const bundled: CoreChoice = { location: { root: '/app/backend', entry: '/app/backend/src/index.js', source: 'bundled' }, version: '1.1.25', source: 'bundled' };
  const noTimers = { setTimeout: () => 0, setInterval: () => 0, clear: () => {} };

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-core-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  interface Registry {
    keys?: RegistryKey[];
    /** Overrides; by default the release is correctly signed by the test key. */
    sig?: string;
    keyid?: string;
    published?: string;
  }

  /** A fake registry answering the manifest, keys and packument URLs. */
  function registry(latest: string, reg: Registry = {}) {
    const integ = integrity(release(latest));
    return vi.fn(async (url: string) => {
      if (url === REGISTRY_URL) {
        const signatures = [{ keyid: reg.keyid ?? KEYID, sig: reg.sig ?? signFor(latest, integ) }];
        return { name: NAME, version: latest, dist: { tarball: TARBALL(latest), integrity: integ, signatures } };
      }
      if (url === REGISTRY_KEYS_URL) return { keys: reg.keys ?? [registryKey()] };
      if (url === PACKUMENT_URL) return { name: NAME, time: { [latest]: reg.published ?? '2024-06-01T00:00:00.000Z' } };
      throw new Error(`unexpected request ${url}`);
    });
  }

  function make(opts: { latest: string; auto?: boolean; activate?: (l: BackendLocation) => Promise<ActionResult>; tarball?: Buffer; printed?: string; registry?: Registry }) {
    const tarball = opts.tarball ?? release(opts.latest);
    const store = new CoreStore(join(dir, 'core'));
    const activate = vi.fn(opts.activate ?? (async () => ({ ok: true, message: '' })));
    const getJson = registry(opts.latest, opts.registry);
    const download = vi.fn(async () => tarball);
    const updater = new CoreUpdater({
      store,
      initial: bundled,
      bundled,
      minVersion: '1.1.0',
      auto: () => opts.auto ?? true,
      activate,
      smokeTest: async () => `${opts.printed ?? opts.latest}\n`,
      getJson,
      download,
      timers: noTimers,
    });
    return { updater, store, activate, getJson, download };
  }

  it('installs a newer release automatically and switches to it', async () => {
    const { updater, store, activate } = make({ latest: '1.1.26' });
    const installed = vi.fn();
    updater.on('installed', installed);
    const state = await updater.check();
    expect(state).toMatchObject({ phase: 'up-to-date', active: '1.1.26', source: 'downloaded' });
    expect(installed).toHaveBeenCalledWith('1.1.26');
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ root: join(dir, 'core', '1.1.26') }));
    expect(readFileSync(join(dir, 'core', '1.1.26', 'src', 'index.js'), 'utf8')).toContain('hi');
    expect(existsSync(join(dir, 'core', '1.1.26', 'README.md'))).toBe(false);
    expect(store.read().active).toBe('1.1.26');
    expect(store.usable('1.1.25')?.version).toBe('1.1.26');
    // An app update that bundles the same or a newer core wins.
    expect(store.usable('1.1.26')).toBeNull();
  });

  it('checks the registry signature without fetching the packument for a key that never expires', async () => {
    const { updater, getJson } = make({ latest: '1.1.26' });
    expect((await updater.check()).active).toBe('1.1.26');
    expect(getJson.mock.calls.map(c => c[0])).toEqual([REGISTRY_URL, REGISTRY_KEYS_URL]);
  });

  it('accepts a key that expired after the release was published, reading the publish time', async () => {
    const { updater, getJson } = make({ latest: '1.1.26', registry: { keys: [registryKey({ expires: EXPIRES })], published: '2024-06-01T00:00:00.000Z' } });
    expect((await updater.check()).active).toBe('1.1.26');
    expect(getJson.mock.calls.map(c => c[0])).toContain(PACKUMENT_URL);
  });

  it.each<[string, Registry]>([
    ['a forged signature', { sig: signText('forged') }],
    ['a signature over another integrity', { sig: signFor('1.1.26', integrity(Buffer.from('other'))) }],
    ['an unknown key', { keyid: 'SHA256:unknown' }],
    ['a key that expired before publishing', { keys: [registryKey({ expires: EXPIRES })], published: '2025-06-01T00:00:00.000Z' }],
  ])('refuses a release with %s before downloading it', async (_label, reg) => {
    const { updater, activate, download, store } = make({ latest: '1.1.26', registry: reg });
    const state = await updater.check();
    expect(state.phase).toBe('error');
    expect(state.error).toBe('the release is not signed by the npm registry');
    expect(download).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(store.read().active).toBeNull();
  });

  it('only reports a release when automatic updates are off, and installs on request', async () => {
    const { updater, activate } = make({ latest: '1.1.26', auto: false });
    expect((await updater.check()).phase).toBe('available');
    expect(activate).not.toHaveBeenCalled();
    expect((await updater.install()).active).toBe('1.1.26');
  });

  it('says up to date when nothing newer is out', async () => {
    const { updater, activate } = make({ latest: '1.1.25' });
    expect((await updater.check()).phase).toBe('up-to-date');
    expect(activate).not.toHaveBeenCalled();
  });

  it('refuses a download that does not match the checksum', async () => {
    const { updater, activate, store } = make({ latest: '1.1.26', tarball: release('9.9.9') });
    const state = await updater.check();
    expect(state.phase).toBe('error');
    expect(state.error).toMatch(/checksum/);
    expect(activate).not.toHaveBeenCalled();
    expect(store.read().active).toBeNull();
  });

  it('refuses a core whose test run prints something else', async () => {
    const { updater, activate } = make({ latest: '1.1.26', printed: 'Error: boom' });
    expect((await updater.check()).error).toMatch(/test run/);
    expect(activate).not.toHaveBeenCalled();
  });

  it('rolls back when the new core does not come up, and does not retry it automatically', async () => {
    const activate = vi.fn(async (l: BackendLocation) => (l.root.endsWith('1.1.26') ? { ok: false, message: 'did not answer' } : { ok: true, message: '' }));
    const { updater, store } = make({ latest: '1.1.26', activate });
    const state = await updater.check();
    expect(state).toMatchObject({ phase: 'error', active: '1.1.25', rolledBack: { version: '1.1.26', previous: '1.1.25' } });
    expect(activate).toHaveBeenLastCalledWith(bundled.location);
    expect(store.read()).toEqual({ active: null, rejected: ['1.1.26'] });
    activate.mockClear();
    expect((await updater.check()).phase).toBe('available');
    expect(activate).not.toHaveBeenCalled();
  });

  it('reverts to the bundled core', async () => {
    const { updater, store, activate } = make({ latest: '1.1.26' });
    await updater.check();
    const result = await updater.revert();
    expect(result).toMatchObject({ ok: true, version: '1.1.25' });
    expect(activate).toHaveBeenLastCalledWith(bundled.location);
    expect(updater.getState()).toMatchObject({ active: '1.1.25', source: 'bundled' });
    expect(store.read().active).toBeNull();
    expect(existsSync(join(dir, 'core', '1.1.26'))).toBe(false);
  });

  it('does nothing in a development run', async () => {
    const getJson = vi.fn();
    const updater = new CoreUpdater({
      store: new CoreStore(join(dir, 'core')),
      initial: { ...bundled, source: 'checkout' },
      bundled: { ...bundled, source: 'checkout' },
      minVersion: '1.1.0',
      auto: () => true,
      activate: async () => ({ ok: true, message: '' }),
      smokeTest: async () => '',
      getJson,
      timers: noTimers,
    });
    expect((await updater.check()).unsupported).toBe('development');
    expect(getJson).not.toHaveBeenCalled();
  });
});
