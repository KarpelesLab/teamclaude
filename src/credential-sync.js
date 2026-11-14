// Account credential sync through callback.net.
//
// A pooled OAuth token lives a few days and then has to be signed in again —
// on every machine that holds a copy. With this install signed in to
// callback.net (`teamclaude callback login`), each OAuth account's tokens are
// also kept in the user's credential store there (`User/Credential`, one row
// per account, encrypted at rest), and every signed-in install follows it:
//
// - A SYNC PASS (at start, on reload, and every 24h) lists the rows. A row with
//   no local account becomes one; a row whose token is newer than the local one
//   replaces it; a local account renewed here and newer than its row updates
//   the row; a local account renewed here with no row creates one.
// - A TOKEN REFRESH goes through the row's advisory lock, so only one install
//   renews a token the others then adopt — a refresh rotates the token family,
//   and two installs renewing one account at once would each kill the other's
//   copy. Lock taken: the lock answers with the row as it stands, and tokens
//   there other than ours are adopted (see heldElsewhere), else renew, PATCH,
//   unlock. Lock refused: another install is renewing. A token that is
//   still good (the refresh runs five minutes ahead of expiry) is simply kept,
//   and the next request asks again; one that has expired, or that upstream
//   just rejected, waits — re-reading every 5s for 30s and adopting what the
//   holder stored, then trying the lock again. Signed in, nothing renews a
//   token the store holds without the lock: not the store being unreachable,
//   not a lock that stays refused, not a CLI command (refreshOutsideProxy). It
//   keeps the token it has, or fails that refresh, and the next request asks.
//
// "Newer" is the later `expiresAt`: a renewal always pushes it forward, and it
// is the one field both the token endpoint and the store agree on.
//
// Only credentials and identity travel. Priority, disabled, routing and the
// display order are this install's own and never leave it. API-key and
// third-party backend accounts are not synced: a key does not expire, and a
// backend credential is not ours to renew.
//
// Removal travels too. An account removed on one install leaves a TOMBSTONE in
// its row (`{"_deleted": "<time>"}`), written under the row's lock so that a
// renewal another install is making under it stores its token first. Every
// other install's next pass removes the account. An explicit sign-in (`login`,
// `import`) replaces the tombstone and brings the account back everywhere; the
// other ways it can come back follow.
//
// A refresh does not write over a tombstone it reads. One made under the lock
// does not meet a removal in between, as long as its write lands within the
// lease (one that outlasts the lease reads the row again first, and can still
// meet one between that read and its write). A token written without the lock
// (a pass pushing a renewal, or one stored after a renewal made outside the
// lock) still can, in the moment between its read and its write. A removal of
// an account the store holds no row for records nothing, so an install that
// still holds it and stores it later brings it back. A removal the store does
// not take at once (out of reach, or the lock held throughout) stays pending on
// the install that made it, in memory: no pass there adds the account back from
// its row, and the tombstone is tried again a minute, five and fifteen minutes
// later, then at each pass, until it lands; a sign-out in between does not end
// it (made while signed out, a removal records nothing at all). Until then it
// also wins over a sign-in made on another install meanwhile. A pass deletes a
// tombstone older than a week. Nothing checks that every install has seen it by
// then: one that ran no pass in that week and still holds the account, with a
// refresh token that still renews, stores it again (at its first pass after
// signing back in to callback.net if it renewed the token while signed out, at
// its next renewal if it was switched off), and the others add it back.
//
// An account IN ERROR (upstream rejected its token; it needs a re-login) is
// never written to the store: what it holds is dead, and stored it would
// overwrite the good token another install holds, or plant a dead account on
// all of them. It only ever reads: a row holding a token different from the
// one it has is adopted whatever its expiry — a sign-in elsewhere mints a
// token the dead one could never be newer than — and the account is back in
// rotation. The pass looks, and so does the moment the account goes into error.
// When the row still holds the very refresh token the token endpoint rejected,
// the row is EMPTIED instead — its refresh token set to "", under the row's
// lock and only if the row is still unchanged once locked. An empty refresh
// token says "needs a sign-in": no install adopts it or adds an account from
// it, and the first install holding a working token overwrites it whatever its
// expiry, the way a renewal or a sign-in there does.
//
// Nor is a token written that was not MINTED here: only one the token endpoint
// just issued — a renewal on this install, or an explicit sign-in (`login`,
// `import`, see storeSignIn) — is known to be fresh. A token read from the
// config at launch or from disk on a reload may have died while the proxy was
// down, and one that served a request may still have been revoked since. An
// account holding such a token reads like any other (adopts, follows a
// tombstone) but neither creates nor updates its row; its next renewal does.
// That renewal still goes through a lock: with no row yet, it makes a
// PLACEHOLDER (the identity, no token) to lock, because the same copy may sit
// on another install — one config on two machines — and two renewals of it
// would kill one another.

import { hostname } from 'node:os';
import { callbackCall, loadCallbackToken } from './callback-auth.js';
import { isTokenExpired } from './oauth.js';
import { providerOf } from './provider.js';
import { sameIdentity } from './identity.js';
import { safeLine } from './safe-text.js';

/** Rows this proxy owns start with this; anything else in the store is left alone. */
export const KEY_PREFIX = 'teamrouter.';
const BLOB_VERSION = 1;
/**
 * How long a taken lock holds off the others before it can be taken over. The
 * TAKER's figure decides (the store hands the lock over once it is older than
 * the timeout the new :lock names), so every caller has to name the same one.
 */
const LOCK_TIMEOUT_S = 30;
/** Of the lease, kept back for the clocks: past this, the lock is treated as gone. */
const LEASE_SAFETY_MS = 2_000;
/** Of the lease, kept back to store the renewal before it runs out. */
const STORE_RESERVE_MS = 8_000;
/** Less than this left of the lease for the provider call, and it is not sent. */
const MIN_REFRESH_BUDGET_MS = 5_000;
/** Lock refused: re-read this often, for this long, before trying the lock again. */
const LOCKED_RECHECK_MS = 5_000;
const LOCKED_WAIT_MS = 30_000;
/** A removal waits this long for a held lock: one whole lease, and a re-check past it. */
const REMOVAL_LOCK_WAIT_MS = LOCK_TIMEOUT_S * 1000 + LOCKED_RECHECK_MS;
/** A removal the store did not take: tried again after each pause, then by each pass. */
const REMOVAL_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** Rounds of lock-or-wait before this refresh gives up (the next request asks again). */
const MAX_LOCK_ROUNDS = 3;
export const SYNC_INTERVAL_MS = 24 * 3600 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
/** A tombstone this old is deleted; an install that ran no pass in that time never saw it. */
export const TOMBSTONE_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * @typedef {{ accessToken: string, refreshToken: string, expiresAt: number }} Tokens
 * @typedef {{ v: number, provider: string, name: string, accountUuid?: string, orgUuid?: string, orgName?: string,
 *   accountId?: string, userId?: string, organizationType?: string, rateLimitTier?: string, seatTier?: string,
 *   hasClaudeMax?: boolean|null, hasClaudePro?: boolean|null, accessToken: string, refreshToken: string,
 *   expiresAt: number, updatedAt: number, by: string }} Blob
 * @typedef {{ id: string, key: string, blob: Blob|null, deletedAt: number|null, updated: number }} Row
 * @typedef {(method: string, path: string, params?: Record<string, any>|null, opts?: any) => Promise<any>} Api
 */

/** The identity fields that travel with a token, in the order they are copied. */
const IDENTITY_FIELDS = ['accountUuid', 'orgUuid', 'orgName', 'accountId', 'userId', 'organizationType', 'rateLimitTier', 'seatTier', 'hasClaudeMax', 'hasClaudePro'];

/** A key segment: the characters the store is happy with, and never a slash. */
function segment(/** @type {unknown} */ v) {
  return String(v ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 48) || 'none';
}

/**
 * Whether an account is one this sync carries: an OAuth login to a provider we
 * refresh ourselves, identified well enough to be matched on another install.
 * @param {Record<string, any>|null|undefined} a
 */
export function isSyncable(a) {
  if (!a || a.type !== 'oauth' || a.upstream) return false;
  return providerOf(a) === 'codex' ? !!a.accountId : !!a.accountUuid;
}

/**
 * The store key for an account, or null when it is not syncable. Built from the
 * identity, never the per-install config id, so every install of one person
 * names one account the same way.
 * @param {Record<string, any>|null|undefined} a
 * @returns {string|null}
 */
export function syncKeyFor(a) {
  if (!a || !isSyncable(a)) return null;
  const provider = providerOf(a);
  if (provider === 'codex') return `${KEY_PREFIX}codex.${segment(a.accountId)}`;
  return `${KEY_PREFIX}anthropic.${segment(a.accountUuid)}.${segment(a.orgUuid || a.orgName || 'org')}`;
}

/**
 * The row's contents for an account, with the tokens it should carry.
 * @param {Record<string, any>} a
 * @param {Tokens} tokens
 * @param {{ now?: number, by?: string }} [opts]
 * @returns {Blob}
 */
export function encodeBlob(a, tokens, { now = Date.now(), by = hostname() } = {}) {
  /** @type {any} */
  const blob = { v: BLOB_VERSION, provider: providerOf(a), name: a.name };
  for (const f of IDENTITY_FIELDS) if (a[f] != null) blob[f] = a[f];
  blob.accessToken = tokens.accessToken;
  blob.refreshToken = tokens.refreshToken;
  blob.expiresAt = tokens.expiresAt;
  blob.updatedAt = now;
  blob.by = by;
  return blob;
}

/**
 * The contents of a row made only to be locked: the identity, and no token. It
 * reads as no blob (decodeBlob), so nothing adopts it, adds an account from it
 * or counts it as needing a sign-in; a lock on it answers with nothing to take,
 * and the renewal under that lock writes the first token. An older install
 * reads it the same way, as a row of ours it does not understand.
 * @param {Record<string, any>} a
 * @param {{ now?: number, by?: string }} [opts]
 */
export function placeholderBlob(a, { now = Date.now(), by = hostname() } = {}) {
  /** @type {any} */
  const blob = { v: BLOB_VERSION, provider: providerOf(a), name: a.name };
  for (const f of IDENTITY_FIELDS) if (a[f] != null) blob[f] = a[f];
  blob.pending = true;
  blob.updatedAt = now;
  blob.by = by;
  return blob;
}

/**
 * A row's contents, or null when they are not a token blob this version
 * understands. Nothing is ever repaired or guessed: a row that does not parse
 * is simply not an account.
 * @param {unknown} text
 * @returns {Blob|null}
 */
export function decodeBlob(text) {
  if (typeof text !== 'string') return null;
  let b;
  try { b = JSON.parse(text); } catch { return null; }
  if (!b || typeof b !== 'object' || b.v !== BLOB_VERSION) return null;
  // An empty refresh token is the "needs a sign-in" marker (see needsSignIn).
  if (typeof b.accessToken !== 'string' || !b.accessToken || typeof b.refreshToken !== 'string') return null;
  if (!Number.isFinite(b.expiresAt) || typeof b.name !== 'string') return null;
  return b;
}

/**
 * When a row's contents are a tombstone, the time of the removal (epoch ms);
 * null for anything else, including a tombstone whose time does not parse.
 * @param {unknown} text
 */
export function tombstoneOf(text) {
  if (typeof text !== 'string') return null;
  let b;
  try { b = JSON.parse(text); } catch { return null; }
  if (!b || typeof b !== 'object' || b._deleted == null) return null;
  const at = typeof b._deleted === 'number' ? b._deleted : Date.parse(String(b._deleted));
  return Number.isFinite(at) ? at : null;
}

/** The row contents that say "removed", as of `now`. */
export function tombstone(now = Date.now()) {
  return { _deleted: new Date(now).toISOString() };
}

/** The account entry a row describes, for an install that does not have it. */
export function entryFromBlob(/** @type {Blob} */ blob) {
  /** @type {Record<string, any>} */
  const entry = { name: safeLine(blob.name, 128), type: 'oauth' };
  if (blob.provider && blob.provider !== 'anthropic') entry.provider = blob.provider;
  for (const f of IDENTITY_FIELDS) if (blob[/** @type {keyof Blob} */ (f)] != null) entry[f] = blob[/** @type {keyof Blob} */ (f)];
  entry.accessToken = blob.accessToken;
  entry.refreshToken = blob.refreshToken;
  entry.expiresAt = blob.expiresAt;
  return entry;
}

/**
 * Whether a row's blob is the "needs a sign-in" marker: emptied by an install
 * whose copy of that token upstream rejected. Nothing is taken from it.
 * @param {Blob|null|undefined} blob
 */
export function needsSignIn(blob) {
  return !!blob && blob.refreshToken === '';
}

/** @param {Blob} blob @returns {Tokens} */
const tokensOf = (blob) => ({ accessToken: blob.accessToken, refreshToken: blob.refreshToken, expiresAt: blob.expiresAt });

/** Whether a blob carries a token that supersedes what an account holds. */
function supersedes(/** @type {Blob|null} */ blob, /** @type {Record<string, any>} */ account) {
  if (!blob || needsSignIn(blob)) return false;
  if (blob.accessToken === account.credential && blob.refreshToken === account.refreshToken) return false;
  return blob.expiresAt > (Number(account.expiresAt) || 0);
}

/**
 * Whether a row read under the lock (or while another install holds it)
 * carries tokens this install should take instead of renewing its own. The
 * lock is what orders renewals, so a row holding tokens other than ours was
 * written by another install since we last took ours, and ours are the stale
 * copy — expiry does not enter into it: another install's clock, or a sign-in
 * there, can stamp a renewal with an earlier expiresAt than the token it
 * rotated away. The one exception is a row this install wrote itself with an
 * older token than it now holds: its own renewal whose PATCH did not land, and
 * taking that back would revive a refresh token it already rotated.
 * @param {Blob|null} blob
 * @param {Record<string, any>} account
 * @param {string} by  this install's name, as it signs the rows it writes
 */
function heldElsewhere(blob, account, by) {
  if (!blob || needsSignIn(blob)) return false;
  if (blob.accessToken === account.credential && blob.refreshToken === account.refreshToken) return false;
  return !(blob.by === by && blob.expiresAt < (Number(account.expiresAt) || 0));
}

/**
 * Whether an account holds a token upstream rejected: marked 'error', or still
 * carrying the refresh token the token endpoint turned down (the manager's
 * dead-token guard, which a re-import of the same refresh token does not lift).
 * @param {Record<string, any>} account
 */
export function isInError(account) {
  return account.status === 'error' || (!!account._deadRefreshToken && account._deadRefreshToken === account.refreshToken);
}

/** Whether the account's current token was minted by a renewal on this install, this launch. */
export function isMinted(/** @type {Record<string, any>} */ account) {
  return account._minted === true;
}

/**
 * Whether a row holds exactly the refresh token upstream rejected on this
 * install — the account's own, still held, and already dead.
 * @param {Blob|null} blob
 * @param {Record<string, any>} account
 */
function holdsRejectedToken(blob, account) {
  const dead = account._deadRefreshToken;
  return !!blob && !!dead && dead === account.refreshToken && blob.refreshToken === dead;
}

/**
 * Whether a blob can bring an account in error back: it carries tokens other
 * than the ones the account holds, and not the refresh token already rejected.
 * Expiry does not enter into it — the account's own token is dead either way.
 */
function revives(/** @type {Blob|null} */ blob, /** @type {Record<string, any>} */ account) {
  if (!blob || needsSignIn(blob)) return false;
  if (blob.accessToken === account.credential && blob.refreshToken === account.refreshToken) return false;
  return !account._deadRefreshToken || blob.refreshToken !== account._deadRefreshToken;
}

/** @param {any} r @returns {Row} */
function rowOf(r) {
  return { id: String(r.User_Credential__), key: String(r.Key), blob: decodeBlob(r.Data), deletedAt: tombstoneOf(r.Data), updated: Number(r?.Updated?.unixms) || 0 };
}

export class CredentialSync {
  /**
   * @param {Object} opts
   * @param {import('./account-manager.js').AccountManager} opts.accountManager
   * @param {(entry: Record<string, any>) => number|null} opts.addAccount  admit a new account (config, disk, manager); its manager index, or null when refused
   * @param {(account: Record<string, any>) => void} [opts.evictAccount]  remove an account the store says is gone (config, disk, manager)
   * @param {Api} [opts.api]
   * @param {() => Promise<boolean>} [opts.isSignedIn]
   * @param {(line: string) => void} [opts.log]
   * @param {() => number} [opts.now]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   * @param {string} [opts.by]
   */
  constructor({ accountManager, addAccount, evictAccount = () => {}, api = callbackCall, isSignedIn = async () => !!(await loadCallbackToken()), log = (l) => console.log(l), now = Date.now, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), by = hostname() }) {
    this.am = accountManager;
    this.addAccount = addAccount;
    this.evictAccount = evictAccount;
    this.api = api;
    this.isSignedIn = isSignedIn;
    this.log = log;
    this.now = now;
    this.sleep = sleep;
    this.by = by;
    /** What the store holds, as last seen: key → row. */
    this.rows = new Map();
    /**
     * Removals made here whose tombstone is not written yet: key → the account.
     * Marked before anything is awaited, so a pass running meanwhile does not
     * add the account back from its row, and each pass tries to write it
     * again. In memory only: a restart forgets it, and the next start's pass
     * adds the account back from its row.
     * @type {Map<string, Record<string, any>>}
     */
    this.pendingRemovals = new Map();
    /**
     * Accounts a pass is evicting for a tombstone (evictAccount): their removal
     * is in the store already, so it is neither written nor pending.
     * @type {WeakSet<Record<string, any>>}
     */
    this._evicting = new WeakSet();
    /** @type {Promise<any>|null} */
    this._syncing = null;
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    this.lastSyncAt = null;
    this.lastError = null;
  }

  /** What status reports. */
  summary() {
    let rows = 0;
    let tombstones = 0;
    let signInNeeded = 0;
    for (const r of this.rows.values()) {
      if (r.deletedAt != null) tombstones++;
      else rows++;
      if (needsSignIn(r.blob)) signInNeeded++;
    }
    return { lastSyncAt: this.lastSyncAt, lastError: this.lastError, rows, tombstones, signInNeeded };
  }

  /** Run a pass now and every SYNC_INTERVAL_MS from then on. */
  start(intervalMs = SYNC_INTERVAL_MS) {
    this.stop();
    this._timer = setInterval(() => { this.sync('daily').catch(() => {}); }, intervalMs);
    this._timer.unref?.();
    return this.sync('start');
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Every row of ours in the store, keyed. */
  async _list() {
    /** @type {Map<string, Row>} */
    const rows = new Map();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const envelope = await this.api('GET', 'User/Credential', { results_per_page: PAGE_SIZE, page_no: page }, { envelope: true });
      const data = Array.isArray(envelope?.data) ? envelope.data : [];
      for (const r of data) {
        if (typeof r?.Key !== 'string' || !r.Key.startsWith(KEY_PREFIX)) continue;
        rows.set(r.Key, rowOf(r));
      }
      const pages = Number(envelope?.paging?.page_max) || 1;
      if (page >= pages || data.length < PAGE_SIZE) break;
    }
    return rows;
  }

  /**
   * One pass: reconcile the store with the fleet. Concurrent calls share one
   * pass. Resolves with what changed; a pass that fails records the error and
   * rejects, and nothing it did before failing is undone.
   *
   * @param {string} [reason]
   * @returns {Promise<{ signedIn: boolean, adopted: number, pushed: number, created: number, added: number, evicted: number, expired: number, emptied: number, rows: number }>}
   */
  sync(reason = 'manual') {
    if (this._syncing) return this._syncing;
    this._syncing = this._sync(reason).finally(() => { this._syncing = null; });
    return this._syncing;
  }

  /** @param {string} reason */
  async _sync(reason) {
    const result = { signedIn: false, adopted: 0, pushed: 0, created: 0, added: 0, evicted: 0, expired: 0, emptied: 0, rows: 0 };
    if (!await this.isSignedIn()) { this.rows.clear(); return result; }
    result.signedIn = true;
    try {
      this.rows = await this._list();
      const matched = new Set();

      // A tombstone every install has had a week to see is done with.
      for (const row of [...this.rows.values()]) {
        if (row.deletedAt == null || this.now() - row.deletedAt < TOMBSTONE_TTL_MS) continue;
        await this.api('DELETE', `User/Credential/${row.id}`);
        this.rows.delete(row.key);
        result.expired++;
      }
      result.rows = this.rows.size;

      for (const account of [...this.am.accounts]) {
        const key = syncKeyFor(account);
        if (!key) continue;
        const row = this._rowFor(account);
        const broken = isInError(account);
        if (!row) {
          // Only a token renewed here is stored for the others to pick up.
          if (broken || !isMinted(account)) continue;
          await this._create(account, this._tokens(account));
          result.created++;
          continue;
        }
        matched.add(row.key);
        if (row.deletedAt != null) {
          // Removed on another install. A sign-in since would have replaced the
          // tombstone (storeSignIn), so the account here is a copy to drop.
          this.log(`[TeamClaude] Account "${safeLine(account.name, 64)}" was removed on another install (${new Date(row.deletedAt).toISOString()}); removing it here`);
          this._evicting.add(account);
          this.evictAccount(account);
          result.evicted++;
          continue;
        }
        if (broken) {
          // Never written over with what this install holds — but a row still
          // holding the rejected token is emptied, so no install takes it.
          if (revives(row.blob, account)) {
            this._adopt(account, /** @type {Blob} */ (row.blob), `sync (${reason}), replacing a rejected token`);
            result.adopted++;
          } else if (holdsRejectedToken(row.blob, account) && await this._markNeedsSignIn(account, row)) {
            result.emptied++;
          }
          continue;
        }
        if (supersedes(row.blob, account)) {
          this._adopt(account, /** @type {Blob} */ (row.blob), `sync (${reason})`);
          result.adopted++;
        } else if (isMinted(account) && this._isAhead(row, account)) {
          await this._patch(row, account, this._tokens(account));
          result.pushed++;
        }
      }

      for (const row of this.rows.values()) {
        // An emptied row names an account that needs a sign-in: nothing to add.
        if (matched.has(row.key) || !row.blob || needsSignIn(row.blob)) continue;
        // Matched above by identity, so a row left over names an account this
        // install does not have.
        if (this.am.accounts.some((a) => sameIdentity(a, row.blob))) continue;
        // Removed here, its tombstone not written yet: not an account to add.
        if (this._isPendingRemoval(row)) continue;
        const entry = entryFromBlob(row.blob);
        const idx = this.addAccount(entry);
        if (idx == null) continue;
        result.added++;
        this.log(`[TeamClaude] Account "${safeLine(entry.name, 64)}" added from callback.net (signed in on ${safeLine(row.blob.by, 48)})`);
      }
      // A removal made here that the store did not take: written now, once,
      // without waiting on a held lock (the next pass tries again).
      for (const account of [...this.pendingRemovals.values()]) {
        if (await this._recordRemoval(account, 0)) this.log(`[TeamClaude] Account "${safeLine(account.name, 64)}": its removal here is now recorded on callback.net`);
      }
      this.lastSyncAt = this.now();
      this.lastError = null;
      if (result.adopted || result.pushed || result.created || result.added || result.evicted || result.expired || result.emptied) {
        this.log(`[TeamClaude] callback.net sync (${reason}): ${result.adopted} adopted, ${result.pushed} updated, ${result.created} stored, ${result.added} added, ${result.evicted} removed, ${result.expired} tombstones expired, ${result.emptied} emptied`);
      }
      return result;
    } catch (/** @type {any} */ err) {
      this.lastError = safeLine(err?.message || String(err), 200);
      this.log(`[TeamClaude] callback.net sync (${reason}) failed: ${this.lastError}`);
      throw err;
    }
  }

  /**
   * Whether a row should take what an account holds: its token is newer, or
   * the row is ours by key but unreadable (an older or newer format), and this
   * install's copy is the one it can vouch for.
   * @param {Row} row
   * @param {Record<string, any>} account
   */
  _isAhead(row, account) {
    if (!row.blob) return true;
    return row.blob.expiresAt < (Number(account.expiresAt) || 0) || !row.blob.refreshToken;
  }

  /** @param {Record<string, any>} account @returns {Tokens} */
  _tokens(account) {
    return { accessToken: account.credential, refreshToken: account.refreshToken, expiresAt: Number(account.expiresAt) || 0 };
  }

  /**
   * The row for an account: by key, else by the identity its blob carries (a
   * row written from an entry that named the organization differently).
   * @param {Record<string, any>} account
   * @returns {Row|null}
   */
  _rowFor(account) {
    const key = syncKeyFor(account);
    const byKey = key ? this.rows.get(key) : null;
    if (byKey) return byKey;
    for (const row of this.rows.values()) if (row.blob && sameIdentity(row.blob, account)) return row;
    return null;
  }

  /**
   * The row for an account, as last seen, else from a fresh list: a row
   * another install created since the last pass is not in what was last
   * seen, and "no row" read from that alone would be wrong. Null when the
   * store has none. Throws when the store cannot be read.
   * @param {Record<string, any>} account
   * @returns {Promise<Row|null>}
   */
  async _findRow(account) {
    const seen = this._rowFor(account);
    if (seen) return seen;
    this.rows = await this._list();
    return this._rowFor(account);
  }

  /**
   * Whether a row names an account removed here whose tombstone is not
   * written yet (see pendingRemovals): by key, or by the identity it carries.
   * @param {Row} row
   */
  _isPendingRemoval(row) {
    if (this.pendingRemovals.has(row.key)) return true;
    for (const a of this.pendingRemovals.values()) if (row.blob && sameIdentity(a, row.blob)) return true;
    return false;
  }

  /** Install a row's tokens on an account. The echo guard keeps this from being pushed back. */
  _adopt(/** @type {Record<string, any>} */ account, /** @type {Blob} */ blob, /** @type {string} */ why) {
    this.log(`[TeamClaude] Account "${safeLine(account.name, 64)}": taking the token renewed on ${safeLine(blob.by, 48)} (${why})`);
    this.am.updateAccountTokens(account.index, tokensOf(blob));
  }

  /** `tokens` null: a placeholder holding none (see placeholderBlob). */
  async _create(/** @type {Record<string, any>} */ account, /** @type {Tokens|null} */ tokens) {
    const key = /** @type {string} */ (syncKeyFor(account));
    const blob = tokens ? encodeBlob(account, tokens, { now: this.now(), by: this.by }) : placeholderBlob(account, { now: this.now(), by: this.by });
    let r;
    try {
      r = await this.api('POST', 'User/Credential', { Key: key, Data: JSON.stringify(blob) });
    } catch (/** @type {any} */ err) {
      // Created by another install between our list and now: theirs stands,
      // and the next pass reads it.
      if (err?.token === 'error_key_exists') return null;
      throw err;
    }
    const row = rowOf({ ...r, Data: JSON.stringify(blob) });
    this.rows.set(row.key, row);
    return row;
  }

  async _patch(/** @type {Row} */ row, /** @type {Record<string, any>} */ account, /** @type {Tokens} */ tokens) {
    const blob = encodeBlob(account, tokens, { now: this.now(), by: this.by });
    const r = await this.api('PATCH', `User/Credential/${row.id}`, { Data: JSON.stringify(blob) });
    const fresh = rowOf({ ...r, Data: JSON.stringify(blob) });
    this.rows.set(fresh.key, fresh);
    return fresh;
  }

  /**
   * Tokens changed on this install. The row follows only when this install
   * minted them (a renewal); tokens from a reload or the store itself do not
   * travel, and a sign-in is stored by storeSignIn.
   * @param {number} index
   * @param {Tokens} tokens
   */
  async onLocalTokens(index, tokens) {
    const account = this.am.accounts[index];
    if (!account || !syncKeyFor(account) || !tokens?.accessToken || !tokens?.refreshToken) return;
    // A re-import of a rejected refresh token, say: nothing the others can use.
    // Nor are tokens this install did not mint (see isMinted).
    if (isInError(account) || !isMinted(account)) return;
    if (!await this.isSignedIn()) return;
    try {
      const row = this._rowFor(account);
      if (row?.deletedAt != null) return; // removed elsewhere; a refresh does not bring it back, a sign-in (storeSignIn) does
      if (row?.blob && row.blob.accessToken === tokens.accessToken) return;
      // The store is ahead; the next pass brings it here. An emptied row is
      // never ahead: any working token replaces it.
      if (row?.blob && !needsSignIn(row.blob) && row.blob.expiresAt > tokens.expiresAt) return;
      if (row) await this._patch(row, account, tokens);
      else await this._create(account, tokens);
    } catch (/** @type {any} */ err) {
      this.log(`[TeamClaude] callback.net: could not store the new token for "${safeLine(account.name, 64)}": ${safeLine(err?.message || String(err), 160)}`);
    }
  }

  /**
   * An account just went into error here. Before it waits for a re-login, look
   * at its row: another install may hold a token renewed or signed in since,
   * which is adopted and puts the account back in rotation. Never writes.
   * Resolves with whether a token was adopted.
   * @param {Record<string, any>} account
   * @returns {Promise<boolean>}
   */
  async onAccountError(account) {
    if (!syncKeyFor(account) || !await this.isSignedIn()) return false;
    try {
      let row = await this._findRow(account);
      if (!row) return false;
      row = rowOf(await this.api('GET', `User/Credential/${row.id}`));
      this.rows.set(row.key, row);
      // Removed elsewhere: the next pass takes it out. Recovered meanwhile (a
      // reload, an import): nothing to do.
      if (row.deletedAt != null || !isInError(account)) return false;
      if (!this.am.accounts.includes(/** @type {any} */ (account))) return false;
      if (revives(row.blob, account)) {
        this._adopt(account, /** @type {Blob} */ (row.blob), 'its own token was rejected');
        return true;
      }
      // The store holds the very token just rejected: empty it, so no other
      // install takes it, and wait for one with a working token to write.
      if (holdsRejectedToken(row.blob, account)) await this._markNeedsSignIn(account, row);
      return false;
    } catch (/** @type {any} */ err) {
      this.log(`[TeamClaude] callback.net: could not look for a newer token for "${safeLine(account.name, 64)}": ${safeLine(err?.message || String(err), 160)}`);
      return false;
    }
  }

  /**
   * Empty a row holding the refresh token upstream rejected here: its refresh
   * token becomes "" (see needsSignIn). Under the row's lock, and only if the
   * row as the lock returns it still holds that token — another install may be
   * renewing, or have stored a working token since, and that is never touched.
   * A token the locked row holds that is not the dead one is adopted. Resolves
   * with whether the row was emptied.
   * @param {Record<string, any>} account
   * @param {Row} row
   * @returns {Promise<boolean>}
   */
  async _markNeedsSignIn(account, row) {
    const name = safeLine(account.name, 64);
    const leaseStart = this.now();
    let locked;
    try {
      locked = await this.api('POST', `User/Credential/${row.id}:lock`, { timeout: LOCK_TIMEOUT_S });
    } catch (/** @type {any} */ err) {
      // Locked: another install is renewing, and what it stores settles it.
      // Anything else: the row is left as it is, and the next pass tries again.
      if (err?.token !== 'error_credential_locked') this.log(`[TeamClaude] callback.net: could not lock "${name}" to mark it as needing a sign-in: ${safeLine(err?.message || String(err), 120)}`);
      return false;
    }
    const leaseEnd = leaseStart + LOCK_TIMEOUT_S * 1000 - LEASE_SAFETY_MS;
    try {
      const current = rowOf({ ...locked, Data: locked?.Data ?? '' });
      this.rows.set(current.key, current);
      if (current.deletedAt != null || !holdsRejectedToken(current.blob, account)) {
        if (current.deletedAt == null && revives(current.blob, account) && this.am.accounts.includes(/** @type {any} */ (account))) {
          this._adopt(account, /** @type {Blob} */ (current.blob), 'stored while its own token was being rejected');
        }
        return false;
      }
      const blob = /** @type {Blob} */ (current.blob);
      await this._patch(current, account, { accessToken: blob.accessToken, refreshToken: '', expiresAt: blob.expiresAt });
      this.log(`[TeamClaude] Account "${name}": its token on callback.net was rejected; emptied it there, so it waits for a sign-in or an install with a working token`);
      return true;
    } catch (/** @type {any} */ err) {
      this.log(`[TeamClaude] callback.net: could not mark "${name}" as needing a sign-in: ${safeLine(err?.message || String(err), 120)}`);
      return false;
    } finally {
      await this._unlock(row, leaseEnd);
    }
  }

  /**
   * An account left this install: its row becomes a tombstone, which the other
   * installs act on at their next pass. Written under the row's lock: a
   * renewal another install is making under it stores its token when it is
   * done, and without the lock that write would land on the tombstone and
   * undo the removal everywhere. A held lock is waited for, at most one lease
   * and a re-check past it (REMOVAL_LOCK_WAIT_MS). Until the tombstone is
   * written the removal is pending (see pendingRemovals), and it is tried
   * again after each of REMOVAL_RETRY_MS, then by each pass. `wait: false`,
   * for a CLI command that must not hang, makes one attempt: no wait for the
   * lock and no retry here. Signed out of callback.net at the removal,
   * nothing is recorded; a sign-out after it does not end it. An account a
   * pass evicts for a
   * tombstone is removed in the store already, and nothing is written.
   * Resolves with whether a tombstone was written.
   * @param {Record<string, any>} account
   * @param {{ wait?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async onAccountRemoved(account, { wait = true } = {}) {
    const key = syncKeyFor(account);
    if (!key || this._evicting.delete(account)) return false;
    // Before anything is awaited: a pass running meanwhile must not add the
    // account back from its row.
    this.pendingRemovals.set(key, account);
    if (!await this.isSignedIn()) {
      this._settleRemoval(key, account);
      return false;
    }
    if (!wait) return this._recordRemoval(account, 0);
    for (const pause of [...REMOVAL_RETRY_MS, null]) {
      if (await this._recordRemoval(account, REMOVAL_LOCK_WAIT_MS)) return true;
      // Settled without a write, or out of retries: the passes take it on.
      if (pause == null || this.pendingRemovals.get(key) !== account) return false;
      await this.sleep(pause);
    }
    return false;
  }

  /**
   * Whether a removed account is back on this install: one the sync carries,
   * by key or by identity. A namesake it does not carry (an API-key account,
   * say) is not it, though sameIdentity falls back to the name.
   * @param {string} key
   * @param {Record<string, any>} account
   */
  _backHere(key, account) {
    return this.am.accounts.some((a) => {
      const k = syncKeyFor(a);
      return !!k && (k === key || sameIdentity(a, account));
    });
  }

  /** A pending removal is done with, unless a newer removal of the same account replaced it. */
  _settleRemoval(/** @type {string} */ key, /** @type {Record<string, any>} */ account) {
    if (this.pendingRemovals.get(key) === account) this.pendingRemovals.delete(key);
  }

  /**
   * Write a pending removal's tombstone. Settled once it is written, and when
   * there is nothing to write: no row (or the row gone since it was read), a
   * tombstone there already, a sign-in here since (storeSignIn), or the
   * account back on this install. Left pending, to be tried again, when
   * signed out of callback.net, when the store cannot be reached, or when the
   * lock is not had within `waitMs`.
   * @param {Record<string, any>} account
   * @param {number} waitMs  how long a held lock is waited for
   * @returns {Promise<boolean>} whether a tombstone was written
   */
  async _recordRemoval(account, waitMs) {
    const key = /** @type {string} */ (syncKeyFor(account));
    const name = safeLine(account.name, 64);
    const settle = () => { this._settleRemoval(key, account); return false; };
    // Settled meanwhile (written by a pass, dropped by a sign-in here): done.
    if (this.pendingRemovals.get(key) !== account) return false;
    try {
      // Signed out since the removal: kept, for the first pass after signing
      // back in. (Signed out at the removal, nothing is recorded at all.)
      if (!await this.isSignedIn()) return false;
      const row = await this._findRow(account);
      if (!row) return settle();
      const lease = await this._lockWaiting(row, waitMs, () => this.pendingRemovals.get(key) === account);
      if (!lease && this.pendingRemovals.get(key) !== account) return false; // settled while it waited
      if (!lease) {
        this.log(`[TeamClaude] callback.net: could not record the removal of "${name}" yet: its lock is held; it is tried again later`);
        return false;
      }
      try {
        const current = rowOf({ ...lease.locked, Data: lease.locked?.Data ?? '' });
        this.rows.set(current.key, current);
        if (current.deletedAt != null || this.pendingRemovals.get(key) !== account || this._backHere(key, account)) return settle();
        const stone = tombstone(this.now());
        const r = await this.api('PATCH', `User/Credential/${row.id}`, { Data: JSON.stringify(stone) });
        const fresh = rowOf({ ...r, Data: JSON.stringify(stone) });
        this.rows.set(fresh.key, fresh);
        settle();
        return true;
      } finally {
        await this._unlock(row, lease.leaseEnd);
      }
    } catch (/** @type {any} */ err) {
      // The row is gone (an expired tombstone, deleted, say): nothing to record.
      if (err?.token === 'error_not_found') return settle();
      this.log(`[TeamClaude] callback.net: could not record the removal of "${name}" yet; it is tried again later: ${safeLine(err?.message || String(err), 160)}`);
      return false;
    }
  }

  /**
   * An explicit sign-in (`login`, `import`): the row takes these tokens
   * whatever it held, a tombstone included — this is the one thing that brings
   * a removed account back.
   * @param {Record<string, any>} entry  the config entry, tokens included
   * @returns {Promise<boolean>} whether the store was written
   */
  async storeSignIn(entry) {
    const account = { ...entry, credential: entry.accessToken, index: -1 };
    const key = syncKeyFor(account);
    if (!key) return false;
    // Newer than a removal of the same account still pending here, which is
    // dropped: the next pass would write its tombstone over this sign-in.
    for (const [k, a] of this.pendingRemovals) if (k === key || sameIdentity(a, account)) this.pendingRemovals.delete(k);
    if (!await this.isSignedIn()) return false;
    const tokens = this._tokens(account);
    if (!tokens.accessToken || !tokens.refreshToken) return false;
    this.rows = await this._list();
    const row = this._rowFor(account);
    if (row) await this._patch(row, account, tokens);
    else await this._create(account, tokens);
    return true;
  }

  /**
   * Renew an account's token through the store's lock, so one install renews
   * and the rest adopt. `refresh` is the provider call; it runs at most once,
   * and only while this install holds the lock: signed in, NO renewal of a
   * token the store holds goes out without it. Resolves null to keep the
   * current token: the lock is not to be had and this one is still good.
   *
   * The lock is a lease: callback.net hands it to the next taker once it is
   * LOCK_TIMEOUT_S old, whoever held it. So the provider call is given what is
   * left of the lease, less the time to store its answer (`budgetMs`), and is
   * never sent once that is spent; and a lease that has run out is not
   * unlocked, the release being anyone's and possibly the next holder's.
   *
   * When the lock cannot be had — the store unreachable, our session there
   * refused, every round refused — nothing is renewed: a still-good token is
   * kept (null), a dead one fails this refresh as a transient error, and the
   * next request asks again. Renewing without the lock is what would kill the
   * other installs' copy. The one renewal without a lock is of a token the
   * store has no row for — an account it does not carry, or one in error —
   * which no other install can hold.
   *
   * @param {Record<string, any>} account
   * @param {(opts?: { budgetMs?: number }) => Promise<Tokens>} refresh
   * @param {{ force?: boolean }} [info]  force: the token was just rejected, so keeping it is not an option
   * @returns {Promise<Tokens|null>}
   */
  async coordinateRefresh(account, refresh, { force = false } = {}) {
    if (!await this.isSignedIn()) return refresh();
    const name = safeLine(account.name, 64);
    let row;
    try {
      row = await this._rowToLock(account);
    } catch (/** @type {any} */ err) {
      return this._standDown(account, force, `callback.net could not be read (${safeLine(err?.message || String(err), 120)})`);
    }
    // No copy of this token in the store, so none on any other install.
    if (!row) return refresh();
    for (let round = 1; round <= MAX_LOCK_ROUNDS; round++) {
      // Taken before the call goes out: the lease starts no earlier on the
      // store's side, so what is left of it is never overestimated.
      const leaseStart = this.now();
      let locked;
      try {
        locked = await this.api('POST', `User/Credential/${row.id}:lock`, { timeout: LOCK_TIMEOUT_S });
      } catch (/** @type {any} */ err) {
        if (err?.token === 'error_not_found') {
          // Deleted since it was read (a tombstone expired, say): find, or
          // make, the row it is now.
          this.rows.delete(row.key);
          try { row = await this._rowToLock(account); } catch { row = null; }
          if (!row) return this._standDown(account, force, 'its callback.net row went away');
          continue;
        }
        if (err?.token !== 'error_credential_locked') {
          // A lock call that failed in flight may still have taken it; either
          // way this install does not hold it, so it does not renew.
          return this._standDown(account, force, `the callback.net lock could not be taken (${safeLine(err?.message || String(err), 120)})`);
        }
        // Another install is renewing. A token that still works serves this
        // request as it is; the renewal arrives through the store, and the
        // next request asks again. Only a dead token has to wait.
        if (!force && !isTokenExpired(account.expiresAt)) {
          this.log(`[TeamClaude] Account "${name}": another install is renewing its token; keeping the current one until then`);
          return null;
        }
        // Wait for what it stores.
        const until = this.now() + LOCKED_WAIT_MS;
        while (this.now() < until) {
          await this.sleep(LOCKED_RECHECK_MS);
          let r;
          try { r = rowOf(await this.api('GET', `User/Credential/${row.id}`)); } catch { continue; }
          this.rows.set(r.key, r);
          if (heldElsewhere(r.blob, account, this.by)) {
            this.log(`[TeamClaude] Account "${name}": renewed on ${safeLine(/** @type {Blob} */ (r.blob).by, 48)} while this install waited`);
            return tokensOf(/** @type {Blob} */ (r.blob));
          }
        }
        this.log(`[TeamClaude] Account "${name}": the lock holder stored no renewal in ${LOCKED_WAIT_MS / 1000}s; trying the lock again`);
        continue;
      }
      const leaseEnd = leaseStart + LOCK_TIMEOUT_S * 1000 - LEASE_SAFETY_MS;
      const current = rowOf({ ...locked, Data: locked?.Data ?? '' });
      this.rows.set(current.key, current);
      if (current.deletedAt == null && heldElsewhere(current.blob, account, this.by)) {
        await this._unlock(row, leaseEnd);
        this.log(`[TeamClaude] Account "${name}": already renewed on ${safeLine(/** @type {Blob} */ (current.blob).by, 48)}; taking that token`);
        return tokensOf(/** @type {Blob} */ (current.blob));
      }
      const budgetMs = leaseEnd - STORE_RESERVE_MS - this.now();
      if (budgetMs < MIN_REFRESH_BUDGET_MS) {
        // The lock call itself ate the lease.
        await this._unlock(row, leaseEnd);
        this.log(`[TeamClaude] Account "${name}": the callback.net lock took too long to answer; trying it again`);
        continue;
      }
      try {
        const tokens = await refresh({ budgetMs });
        let stored = current;
        if (this.now() > leaseEnd) {
          this.log(`[TeamClaude] Account "${name}": the renewal outlasted the callback.net lock (${LOCK_TIMEOUT_S}s)`);
          // The lock may be another install's by now, and a removal takes it
          // to write its tombstone: read the row again, so this renewal does
          // not land on one. Unreadable, it is written as before.
          try {
            stored = rowOf(await this.api('GET', `User/Credential/${row.id}`));
            this.rows.set(stored.key, stored);
          } catch { /* written over the row the lock returned */ }
        }
        if (stored.deletedAt != null) {
          // Removed on another install, since the last pass or while this
          // renewal ran past its lease. This request still gets its token,
          // never written over the tombstone; the pass that follows takes the
          // account out.
          this.log(`[TeamClaude] Account "${name}" was removed on another install; renewed this once, removing it here`);
          this.sync('tombstone').catch(() => {});
          return tokens;
        }
        try {
          await this._patch(stored, account, tokens);
        } catch (/** @type {any} */ err) {
          this.log(`[TeamClaude] callback.net: could not store the renewed token for "${name}": ${safeLine(err?.message || String(err), 120)}`);
        }
        return tokens;
      } finally {
        await this._unlock(row, leaseEnd);
      }
    }
    return this._standDown(account, force, `the callback.net lock was not to be had in ${MAX_LOCK_ROUNDS} rounds`);
  }

  /**
   * The row whose lock orders this account's renewals: the account's own (made
   * now when the store does not have it yet, so there is one to lock), or, for
   * an account the store does not carry by identity, the row holding its
   * refresh token. Null when the store holds no copy of the token at all.
   * Throws when the store cannot be read.
   * @param {Record<string, any>} account
   * @returns {Promise<Row|null>}
   */
  async _rowToLock(account) {
    const keyed = !!syncKeyFor(account);
    const find = () => (keyed ? this._rowFor(account) : null) || this._rowHolding(account.refreshToken);
    let row = find();
    if (row) return row;
    this.rows = await this._list();
    row = find();
    // A dead token is renewed without a lock: no other install can need it.
    if (row || !keyed || isInError(account)) return row;
    // First here: a token minted here is stored as it stands, then locked like
    // any other. One not minted here (isMinted) is never stored, but another
    // install may hold the same copy (one config on two machines), so its row
    // starts as a placeholder holding no token: a lock to order the renewals,
    // which the fresh token then fills (see placeholderBlob). Created by
    // another install meanwhile, theirs is the row — which a create racing it
    // on the live API can also learn as a plain database error, not only as
    // error_key_exists: whatever the failure, look again before giving up.
    let created = null;
    try {
      created = isMinted(account)
        ? await this._create(account, this._tokens(account))
        : await this._create(account, null);
    } catch (err) {
      this.rows = await this._list();
      row = find();
      if (row) return row;
      throw err;
    }
    if (!created) this.rows = await this._list();
    return find();
  }

  /** The row holding this refresh token, whatever account it names. */
  _rowHolding(/** @type {unknown} */ refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) return null;
    for (const row of this.rows.values()) if (row.blob?.refreshToken === refreshToken) return row;
    return null;
  }

  /**
   * No lock, so no renewal: keep a token that still works (null), fail the
   * refresh — as a transient error, never as a rejection — for one that does not.
   * @param {Record<string, any>} account
   * @param {boolean} force
   * @param {string} why
   * @returns {null}
   */
  _standDown(account, force, why) {
    const name = safeLine(account.name, 64);
    if (!force && !isTokenExpired(account.expiresAt)) {
      this.log(`[TeamClaude] Account "${name}": not renewing, ${why}; keeping the current token`);
      return null;
    }
    this.log(`[TeamClaude] Account "${name}": not renewing, ${why}; it waits for the lock (\`teamclaude callback logout\` renews without one)`);
    throw Object.assign(new Error(`not renewed without the callback.net lock: ${why}`), { code: 'CALLBACK_LOCK_UNAVAILABLE' });
  }

  /**
   * Take a row's lock, trying again every LOCKED_RECHECK_MS while it is held
   * (by another install, or by this one), for up to `waitMs`, and only while
   * `wanted()` holds. Resolves with the row as the lock returned it and the
   * end of the lease, or null when the lock stayed held or is no longer
   * wanted. Any other failure throws.
   * @param {Row} row
   * @param {number} waitMs
   * @param {() => boolean} [wanted]
   * @returns {Promise<{ locked: any, leaseEnd: number }|null>}
   */
  async _lockWaiting(row, waitMs, wanted = () => true) {
    const until = this.now() + waitMs;
    for (;;) {
      if (!wanted()) return null;
      // Taken before the call goes out, as in coordinateRefresh.
      const leaseStart = this.now();
      try {
        const locked = await this.api('POST', `User/Credential/${row.id}:lock`, { timeout: LOCK_TIMEOUT_S });
        return { locked, leaseEnd: leaseStart + LOCK_TIMEOUT_S * 1000 - LEASE_SAFETY_MS };
      } catch (/** @type {any} */ err) {
        if (err?.token !== 'error_credential_locked') throw err;
        if (this.now() >= until) return null;
        await this.sleep(LOCKED_RECHECK_MS);
      }
    }
  }

  /** Release the lock, unless the lease has run out: then it may be someone else's. */
  async _unlock(/** @type {Row} */ row, /** @type {number} */ leaseEnd) {
    if (this.now() >= leaseEnd) return;
    try { await this.api('POST', `User/Credential/${row.id}:unlock`, {}); } catch { /* the lock times out on its own */ }
  }
}

/**
 * A renewal from outside the running proxy — a CLI command holding a copy of
 * an account's tokens — through the same lock the proxy's go through.
 * @param {Record<string, any>} entry  config-entry shaped: accessToken, refreshToken, expiresAt, and the identity when known
 * @param {(opts?: { budgetMs?: number }) => Promise<Tokens>} refresh
 * @param {{ force?: boolean, log?: (line: string) => void, api?: Api, isSignedIn?: () => Promise<boolean> }} [opts]
 * @returns {Promise<Tokens|null>}
 */
export function refreshOutsideProxy(entry, refresh, { force = false, ...opts } = {}) {
  const sync = new CredentialSync({ accountManager: /** @type {any} */ ({ accounts: [] }), addAccount: () => null, ...opts });
  return sync.coordinateRefresh({ ...entry, credential: entry.accessToken, index: -1 }, refresh, { force });
}
