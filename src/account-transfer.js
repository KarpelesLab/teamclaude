// Moving your own accounts from one of your machines to another.
//
// Setting up a new machine meant signing in to every pooled account again.
// `teamclaude accounts export <file>` writes the accounts — identity, tokens and
// the per-account settings that mean the same thing anywhere — to one file, and
// `teamclaude accounts import <file>` on the new machine merges them into its
// config without a single sign-in.
//
// The file holds live refresh tokens, so it is encrypted by default: scrypt
// derives an AES-256-GCM key from a passphrase, and the readable header is the
// cipher's associated data, so editing it fails the decrypt instead of being
// believed. Only `node:crypto`: no dependencies.
//
// Only the fields listed in PORTABLE travel, each checked against the shape
// its readers assume. What belongs to the machine stays: the entry id (the
// running server pairs accounts by it), `source`, an `importFrom` path (its
// tokens are read from the file and inlined instead) and per-account `routing`,
// which names a proxy, often with its credentials, that the other machine may
// not reach. Quota state is re-learned from traffic.
//
// A refresh rotates the token family on both providers, so two machines
// renewing one copied token sign each other out of that account. The CLI says
// so on export and offers --disable-source; the import side never refreshes,
// fetches a profile or touches callback.net, so importing spends nothing and
// rotates nothing. A token this machine already holds is replaced only by a
// newer one (later `expiresAt`, the rule credential-sync.js uses too). The
// refresh token's own expiry goes wherever that token goes, and is dropped
// when a token that states none replaces it.

import { scrypt, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { findUpsertTarget, updateAccountEntry } from './identity.js';
import { importCredentials } from './oauth.js';
import { importCodexCredentials, DEFAULT_CODEX_CREDENTIALS_PATH } from './codex-auth.js';
import { providerOf } from './provider.js';
import { accountLimitReached } from './account-limit.js';
import { setRefreshTokenExpiry } from './refresh-token-expiry.js';

export const BUNDLE_FORMAT = 'teamrouter-accounts';
export const BUNDLE_VERSION = 1;

// scrypt cost. N = 2^17 takes about half a second and 128 MiB, which is what
// one export or import can afford and a guesser cannot; maxmem has to be raised
// past Node's 32 MiB default to allow it.
const KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 };
const KDF_MAXMEM = 256 * 1024 * 1024;
// The most a file may ask for. The parameters are read from the file, and an
// unbounded N would let a crafted one hold the CPU and memory hostage.
const MAX_LOG2_N = 20;

/** @param {any} v */
const isString = (v) => typeof v === 'string';
/** @param {any} v */
const isBool = (v) => typeof v === 'boolean';
/** @param {any} v */
const isNumber = (v) => Number.isFinite(v);
/** @param {any} v */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** A number, or a per-bucket table of numbers (`switchThreshold`, `maxUsage`). @param {any} v */
const isNumberOrTable = (v) => isNumber(v) || (isPlainObject(v) && Object.values(v).every(isNumber));
/** @param {any} v */
const isStringList = (v) => Array.isArray(v) && v.every(isString);
/** An epoch time or a date string (`endsAt`, read by parseEndsAt). @param {any} v */
const isTime = (v) => isNumber(v) || isString(v);
/** @param {any} v */
const isStringMap = (v) => isPlainObject(v) && Object.values(v).every(isString);

/**
 * The fields that travel, each with the shape its readers rely on. Anything
 * else on an entry stays on the machine it is on: the machine's own fields
 * (id, source, importFrom, routing) by omission, and fields this version does
 * not know because it cannot vouch for them. A listed field with the wrong
 * shape refuses the file (see invalidAccount): `models: {}` read as an array,
 * for one, throws in the routing pass that scans every account.
 * @type {Record<string, (v: any) => boolean>}
 */
const PORTABLE = {
  name: isString, type: isString, provider: isString, upstream: isString,
  accessToken: isString, refreshToken: isString, expiresAt: isNumber, refreshTokenExpiresAt: isNumber, apiKey: isString,
  accountUuid: isString, orgUuid: isString, orgName: isString, email: isString,
  accountId: isString, userId: isString, organizationType: isString,
  rateLimitTier: isString, seatTier: isString, hasClaudeMax: isBool, hasClaudePro: isBool,
  priority: isNumber, disabled: isBool, cordoned: isBool, displayOrder: isNumber, endsAt: isTime,
  switchThreshold: isNumberOrTable, maxUsage: isNumberOrTable, maxSpend: isNumber,
  credit: isPlainObject, allowExtraUsage: isBool, autoRedeemReset: isBool, messageThreads: isBool,
  modelMap: isStringMap, models: isStringList, stripRequestFields: isStringList,
};

/**
 * The portable fields of an entry: those in PORTABLE, with null and undefined
 * values left out (an absent field and a null one read the same everywhere).
 * @param {Record<string, any>} acct
 * @returns {Record<string, any>}
 */
function portableFields(acct) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of Object.keys(PORTABLE)) if (acct[k] != null) out[k] = acct[k];
  return out;
}

/** The credential fields: what an import replaces on an account already here. */
const CREDENTIAL_FIELDS = ['accessToken', 'refreshToken', 'expiresAt', 'apiKey'];

/**
 * Identity fields an import refreshes alongside the credential: the newer
 * login is the better witness to who the account is.
 */
const IDENTITY_FIELDS = [
  'accountUuid', 'orgUuid', 'orgName', 'email', 'accountId', 'userId',
  'organizationType', 'rateLimitTier', 'seatTier', 'hasClaudeMax', 'hasClaudePro',
];

/** A refused export or import, with a message meant for the terminal. */
export class TransferError extends Error {}

/**
 * The accounts to export, with their credentials inlined and the machine's own
 * fields removed.
 *
 * An `importFrom` account, and a Codex account that reads the Codex CLI's own
 * file, have their tokens read from that file now: the path means nothing on
 * the other machine. One whose file cannot be read is left out and reported.
 * @param {Array<Record<string, any>>} accounts
 * @param {{ readClaude?: typeof importCredentials, readCodex?: typeof importCodexCredentials }} [readers] - test seams
 * @returns {Promise<{ accounts: Array<Record<string, any>>, ids: string[], fileBacked: string[], skipped: Array<{ name: string, reason: string }> }>}
 *   `ids[i]` is the entry id of `accounts[i]` on this machine, for --disable-source.
 */
export async function collectExportAccounts(accounts, { readClaude = importCredentials, readCodex = importCodexCredentials } = {}) {
  /** @type {Array<Record<string, any>>} */
  const out = [];
  /** @type {string[]} */
  const ids = [];
  /** @type {string[]} */
  const fileBacked = [];
  /** @type {Array<{ name: string, reason: string }>} */
  const skipped = [];
  for (const acct of accounts || []) {
    if (!acct || typeof acct !== 'object') continue;
    const entry = portableFields(acct);
    const isCodex = providerOf(acct) === 'codex';
    const from = acct.importFrom || (isCodex && acct.type === 'oauth' && !acct.accessToken ? DEFAULT_CODEX_CREDENTIALS_PATH : null);
    if (from) {
      try {
        const creds = isCodex ? await readCodex(from) : await readClaude(from);
        if (!creds?.accessToken) throw new Error(`no token in ${from}`);
        for (const [k, v] of Object.entries(portableFields(creds))) entry[k] = v;
        setRefreshTokenExpiry(entry, /** @type {Record<string, any>} */ (creds).refreshTokenExpiresAt);
        fileBacked.push(acct.name);
      } catch (/** @type {any} */ err) {
        skipped.push({ name: acct.name, reason: `could not read ${from}: ${err?.message || err}` });
        continue;
      }
    }
    // The importing side refuses a file holding one record it cannot use, so
    // such a record is left out here, where the operator can see why.
    const why = invalidAccount(entry);
    if (why) {
      skipped.push({ name: acct.name, reason: why });
      continue;
    }
    out.push(entry);
    ids.push(acct.id);
  }
  return { accounts: out, ids, fileBacked, skipped };
}

/**
 * Derive the AES key for `passphrase` with the given scrypt parameters.
 * @param {string} passphrase
 * @param {Buffer} salt
 * @param {{ N: number, r: number, p: number }} params
 * @returns {Promise<Buffer>}
 */
function deriveKey(passphrase, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFC'), salt, 32, { N, r, p, maxmem: KDF_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * The header fields bound to the ciphertext as associated data, in a fixed
 * order so the encoding is the same on both machines.
 * @param {Record<string, any>} bundle
 */
function associatedData(bundle) {
  const e = bundle.encryption;
  return Buffer.from(JSON.stringify([bundle.format, bundle.v, bundle.exportedAt, bundle.count, e.kdf, e.N, e.r, e.p, e.salt, e.cipher, e.iv]));
}

/**
 * Build the file contents for `accounts`: encrypted under `passphrase`, or
 * plain JSON when it is null.
 * @param {Array<Record<string, any>>} accounts
 * @param {string|null} passphrase
 * @param {{ now?: Date, kdf?: { N: number, r: number, p: number } }} [opts] - test seams; a test may lower the cost
 * @returns {Promise<Record<string, any>>}
 */
export async function createBundle(accounts, passphrase, { now = new Date(), kdf = KDF } = {}) {
  const header = { format: BUNDLE_FORMAT, v: BUNDLE_VERSION, exportedAt: now.toISOString(), count: accounts.length };
  const payload = Buffer.from(JSON.stringify({ accounts }));
  if (passphrase == null) return { ...header, encryption: null, accounts };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const bundle = {
    ...header,
    encryption: {
      kdf: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p,
      salt: salt.toString('base64'),
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: '',
    },
    data: '',
  };
  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(bundle));
  bundle.data = Buffer.concat([cipher.update(payload), cipher.final()]).toString('base64');
  bundle.encryption.tag = cipher.getAuthTag().toString('base64');
  return bundle;
}

/**
 * Whether a parsed file is an encrypted bundle (so a passphrase is needed).
 * @param {any} bundle
 */
export function isEncryptedBundle(bundle) {
  return !!bundle?.encryption;
}

/**
 * Check a parsed file is a bundle this version can read, throwing a
 * TransferError saying why not.
 * @param {any} bundle
 */
export function checkBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || bundle.format !== BUNDLE_FORMAT) {
    throw new TransferError('Not a TeamClaude account export.');
  }
  if (bundle.v !== BUNDLE_VERSION) {
    throw new TransferError(`This export is format version ${bundle.v}; this TeamClaude reads version ${BUNDLE_VERSION}. Update TeamClaude on this machine and try again.`);
  }
}

/**
 * The accounts in a bundle, decrypting it with `passphrase` when it is
 * encrypted. A wrong passphrase and a tampered file look the same to GCM, and
 * the message says so.
 * @param {any} bundle
 * @param {string|null} passphrase
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function openBundle(bundle, passphrase) {
  checkBundle(bundle);
  let accounts;
  if (!isEncryptedBundle(bundle)) {
    accounts = bundle.accounts;
  } else {
    const e = bundle.encryption;
    if (e.kdf !== 'scrypt' || e.cipher !== 'aes-256-gcm') throw new TransferError(`Unsupported encryption (${e.kdf}/${e.cipher}).`);
    const log2N = Math.log2(e.N);
    if (!Number.isInteger(log2N) || log2N < 1 || log2N > MAX_LOG2_N || !(e.r >= 1 && e.r <= 32) || !(e.p >= 1 && e.p <= 16)) {
      throw new TransferError('The export\'s key-derivation settings are out of range.');
    }
    if (passphrase == null || passphrase === '') throw new TransferError('This export is encrypted: a passphrase is needed.');
    // GCM in Node accepts a tag as short as 4 bytes unless told otherwise, and
    // a 4-byte tag is 32 bits of authentication: the length is pinned, here and
    // on the decipher.
    const iv = Buffer.from(String(e.iv), 'base64');
    const tag = Buffer.from(String(e.tag), 'base64');
    if (iv.length !== 12 || tag.length !== 16 || typeof bundle.data !== 'string') {
      throw new TransferError('Wrong passphrase, or the file was changed after it was exported.');
    }
    const key = await deriveKey(passphrase, Buffer.from(String(e.salt), 'base64'), e);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAAD(associatedData(bundle));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(Buffer.from(bundle.data, 'base64')), decipher.final()]);
      accounts = JSON.parse(plain.toString('utf8')).accounts;
    } catch {
      throw new TransferError('Wrong passphrase, or the file was changed after it was exported.');
    }
  }
  if (!Array.isArray(accounts)) throw new TransferError('The export holds no account list.');
  // All or nothing: one bad record refuses the file, so an import never leaves
  // half of it applied or an entry the rest of the program trips over later.
  const problems = accounts.map((a, i) => {
    const why = invalidAccount(a);
    return why && `  #${i + 1}${typeof a?.name === 'string' ? ` "${a.name}"` : ''}: ${why}`;
  }).filter(Boolean);
  if (problems.length) throw new TransferError(`The export holds account records this TeamClaude cannot use:\n${problems.join('\n')}`);
  return accounts;
}

/**
 * Why an imported record cannot become a config entry, or null when it can.
 * Checks what the rest of the program relies on: a known type, the credential
 * that type needs, and the shape of every field that travels (PORTABLE).
 * @param {any} a
 * @returns {string|null}
 */
export function invalidAccount(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'not an account record';
  if (typeof a.name !== 'string' || a.name.trim() === '') return 'no name';
  if (a.type === 'oauth') {
    if (typeof a.accessToken !== 'string' || a.accessToken === '') return 'no access token';
  } else if (a.type === 'apikey') {
    if (typeof a.apiKey !== 'string' || a.apiKey === '') return 'no API key';
  } else {
    return `unknown account type ${JSON.stringify(a.type)}`;
  }
  for (const [k, ok] of Object.entries(PORTABLE)) {
    if (a[k] != null && !ok(a[k])) return `${k} has the wrong shape (${JSON.stringify(a[k])})`;
  }
  return null;
}

/**
 * What kind of account a record is: its type, provider, and whether it is a
 * third-party backend. Records of different kinds are never one account, even
 * under one name: an OAuth token stored on an API-key entry would be sent as
 * an `x-api-key`, and the other way round the old credential would linger.
 * @param {Record<string, any>} a
 */
function accountKind(a) {
  return `${a?.type}|${providerOf(a)}|${backendKey(a?.upstream)}`;
}

/**
 * A third-party backend's upstream, normalized: the same service whatever the
 * case of its host or a trailing slash, and two services never one. Two
 * backends sharing a name are different accounts when they point at different
 * services, and a DeepSeek key sent to z.ai is a key handed to the wrong party.
 * @param {any} upstream
 */
function backendKey(upstream) {
  if (!upstream) return '';
  try {
    const u = new URL(String(upstream));
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(upstream);
  }
}

/**
 * Whether two records hold the very same credential.
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 */
function sameCredential(a, b) {
  if (a.apiKey || b.apiKey) return a.apiKey === b.apiKey;
  return !!a.accessToken && a.accessToken === b.accessToken && (a.refreshToken || null) === (b.refreshToken || null);
}

/**
 * A display name no entry in `accounts` holds yet, starting from `name`.
 * @param {Array<Record<string, any>>} accounts
 * @param {Record<string, any>} incoming
 */
function freeName(accounts, incoming) {
  const taken = new Set(accounts.map(a => a?.name));
  if (!taken.has(incoming.name)) return incoming.name;
  if (incoming.orgName && !incoming.name.includes(' (')) {
    const withOrg = `${incoming.name} (${incoming.orgName})`;
    if (!taken.has(withOrg)) return withOrg;
  }
  for (let n = 2; ; n++) {
    const candidate = `${incoming.name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Merge imported accounts into `config.accounts`, in place.
 *
 * - A new account is added as exported, minus the machine's own fields.
 * - An account already here (findUpsertTarget: identity first, the name only
 *   when nothing contradicts it) has its credential and identity replaced, and
 *   only when the imported token is newer, unless `force`. Its name, id,
 *   priority, routing and other settings stay this machine's own.
 * - An account here that reads its tokens from a file (`importFrom`) is left
 *   alone: the next reload reads that file again, over anything written here.
 * @param {{ accounts: Array<Record<string, any>> }} config
 * @param {Array<Record<string, any>>} incoming
 * @param {{ force?: boolean }} [opts]
 * @returns {{ added: string[], updated: string[], skipped: Array<{ name: string, reason: string }> }}
 */
export function mergeImportedAccounts(config, incoming, { force = false } = {}) {
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const updated = [];
  /** @type {Array<{ name: string, reason: string }>} */
  const skipped = [];
  for (const raw of incoming) {
    const acct = portableFields(raw);
    // Matched among entries of the same kind only (see accountKind).
    const kind = accountKind(acct);
    const sameKind = config.accounts.map((a, i) => ({ a, i })).filter(({ a }) => accountKind(a) === kind);
    const hit = findUpsertTarget(sameKind.map(({ a }) => a), acct);
    const idx = hit < 0 ? -1 : sameKind[hit].i;
    if (idx < 0) {
      // Past the per-kind cap the bundle's account stays out, said per account.
      const reached = accountLimitReached(config.accounts, acct);
      if (reached) {
        skipped.push({ name: acct.name, reason: reached.message });
        continue;
      }
      acct.name = freeName(config.accounts, acct);
      acct.source = 'transfer';
      config.accounts.push(acct);
      added.push(acct.name);
      continue;
    }
    const prev = config.accounts[idx];
    if (prev.importFrom) {
      skipped.push({ name: prev.name, reason: `reads its login from ${prev.importFrom} on this machine` });
      continue;
    }
    if (sameCredential(prev, acct)) {
      skipped.push({ name: prev.name, reason: 'already up to date' });
      continue;
    }
    if (!force) {
      const comparable = Number.isFinite(acct.expiresAt) && Number.isFinite(prev.expiresAt);
      if (comparable && acct.expiresAt <= prev.expiresAt) {
        skipped.push({ name: prev.name, reason: 'this machine has a newer login (--force to replace it)' });
        continue;
      }
      // A Codex entry that reads the Codex CLI's file has no token of its own,
      // so any imported one is an improvement. Anything else with nothing to
      // compare is the operator's call.
      const hasOwn = !!(prev.accessToken || prev.apiKey);
      if (!comparable && hasOwn) {
        skipped.push({ name: prev.name, reason: 'a different login is already here (--force to replace it)' });
        continue;
      }
    }
    /** @type {Record<string, any>} */
    const fields = {};
    for (const k of [...CREDENTIAL_FIELDS, ...IDENTITY_FIELDS]) if (acct[k] !== undefined) fields[k] = acct[k];
    config.accounts[idx] = setRefreshTokenExpiry(updateAccountEntry(prev, fields), acct.refreshTokenExpiresAt);
    updated.push(prev.name);
  }
  return { added, updated, skipped };
}

/**
 * Names of exported accounts whose login on disk is no longer the one in the
 * export (or whose row is gone): something renewed it after the snapshot, and
 * the copy in the file is dead.
 * @param {Array<Record<string, any>>} exported
 * @param {string[]} ids - parallel to `exported`
 * @param {Array<Record<string, any>>} diskAccounts
 * @returns {string[]}
 */
export function changedSinceExport(exported, ids, diskAccounts) {
  /** @type {string[]} */
  const changed = [];
  exported.forEach((acct, i) => {
    const row = diskAccounts.find(a => a?.id === ids[i]);
    // A file-backed row stores no token of its own to compare.
    if (row?.importFrom || (row && !row.accessToken && !row.apiKey && providerOf(row) === 'codex')) return;
    if (!row || !sameCredential(row, acct)) changed.push(acct.name);
  });
  return changed;
}

/**
 * Write `text` to `path`, readable by the owner only from its first byte.
 *
 * A new file is created exclusively at 0600. With `force`, an existing file
 * is replaced through a private temporary file and a rename, not opened for
 * writing: opening it keeps the mode it had, so a world-readable file would
 * be readable while the tokens went in.
 * @param {string} path
 * @param {string} text
 * @param {{ force?: boolean }} [opts]
 */
export async function writePrivateFile(path, text, { force = false } = {}) {
  const target = force ? `${path}.${randomBytes(6).toString('hex')}.tmp` : path;
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(target).catch(() => {});
    throw err;
  }
  await handle.close();
  if (!force) return;
  try {
    await rename(target, path);
  } catch (err) {
    await unlink(target).catch(() => {});
    throw err;
  }
}
