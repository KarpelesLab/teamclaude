// Move TeamClaude to another machine: the config (accounts with their
// credentials, proxy and routing settings) and the persisted quota state,
// sealed with a passphrase. scrypt derives the key, AES-256-GCM encrypts and
// authenticates, so a wrong passphrase or a damaged file fails to open instead
// of yielding garbage. Restoring keeps the files it replaces next to them.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export const BACKUP_FORMAT = 'teamclaude-backup';
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;

export interface BackupPayload {
  createdAt: string;
  desktopVersion: string;
  /** File name (no directory) → content, for the config and its state file. */
  files: Record<string, string>;
}

interface Envelope {
  format: typeof BACKUP_FORMAT;
  version: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
  data: string;
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase.normalize('NFC'), salt, 32, { ...params, maxmem: SCRYPT_MAXMEM });
}

export function sealBackup(payload: BackupPayload, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, SCRYPT), iv);
  cipher.setAAD(Buffer.from(BACKUP_FORMAT));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const envelope: Envelope = {
    format: BACKUP_FORMAT,
    version: 1,
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    data: data.toString('base64'),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function openBackup(text: string, passphrase: string): BackupPayload {
  let env: Envelope;
  try {
    env = JSON.parse(text) as Envelope;
  } catch {
    throw new Error('this is not a TeamClaude backup');
  }
  if (env?.format !== BACKUP_FORMAT || env.version !== 1 || env.kdf?.name !== 'scrypt' || env.cipher?.name !== 'aes-256-gcm') {
    throw new Error('this is not a TeamClaude backup');
  }
  const { N, r, p } = env.kdf;
  // Bounded so a crafted file cannot make the key derivation eat the machine.
  if (![N, r, p].every(Number.isInteger) || N > 1 << 17 || N < 1 << 10 || r > 16 || p > 4) throw new Error('unsupported backup parameters');
  let plain: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(env.kdf.salt, 'base64'), { N, r, p }), Buffer.from(env.cipher.iv, 'base64'));
    decipher.setAAD(Buffer.from(BACKUP_FORMAT));
    decipher.setAuthTag(Buffer.from(env.cipher.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('wrong passphrase, or the file is damaged');
  }
  const payload = JSON.parse(plain) as BackupPayload;
  if (!payload || typeof payload.files !== 'object' || payload.files === null) throw new Error('the backup has no files');
  return payload;
}

/** The files a backup carries for this config path: the config and its `.state.json`. */
export function backupFiles(configPath: string): [string, string] {
  const state = configPath.endsWith('.json') ? configPath.replace(/\.json$/, '.state.json') : `${configPath}.state.json`;
  return [configPath, state];
}

export interface BackupIO {
  read(path: string): string | null;
  write(path: string, data: string): void;
  rename(from: string, to: string): void;
  exists(path: string): boolean;
}

export function collectBackup(configPath: string, desktopVersion: string, io: BackupIO, now = new Date()): BackupPayload {
  const files: Record<string, string> = {};
  for (const path of backupFiles(configPath)) {
    const text = io.read(path);
    if (text !== null) files[basename(path)] = text;
  }
  if (!files[basename(configPath)]) throw new Error('there is no TeamClaude config to back up yet');
  return { createdAt: now.toISOString(), desktopVersion, files };
}

/** Restore into this machine's config location. Returns where the replaced files were moved. */
export function restoreBackup(payload: BackupPayload, configPath: string, io: BackupIO, now = new Date()): string[] {
  const [config, state] = backupFiles(configPath);
  // The backup's own file names may differ (teamrouter.json, a custom path):
  // only the two roles are restored, under this machine's names.
  const names = Object.keys(payload.files);
  const configText = payload.files[names.find(n => !n.endsWith('.state.json')) ?? ''];
  const stateText = payload.files[names.find(n => n.endsWith('.state.json')) ?? ''];
  if (typeof configText !== 'string') throw new Error('the backup has no config');
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    throw new Error('the backup config is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { accounts?: unknown }).accounts)) {
    throw new Error('the backup config has no accounts list');
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const moved: string[] = [];
  for (const [path, text] of [[config, configText], [state, stateText]] as const) {
    if (typeof text !== 'string') continue;
    if (io.exists(path)) {
      const aside = join(dirname(path), `${basename(path)}.before-restore-${stamp}`);
      io.rename(path, aside);
      moved.push(aside);
    }
    io.write(path, text);
  }
  return moved;
}
