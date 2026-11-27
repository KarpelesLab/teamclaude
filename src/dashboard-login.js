// A Claude sign-in driven over the control plane, for the browser dashboard of
// a server that runs with no terminal: POST /teamclaude/login/{start,finish,
// cancel} in server.js are thin HTTP over this.
//
// It is the TUI login panel's flow with the panel replaced by a page. The
// sign-in is started with no loopback listener, since the browser is on
// another machine and could not reach one: the code page's paste is the whole
// flow. The PKCE verifier and the state never leave the flow object, which
// lives in this process's memory and nowhere else, so a restart ends a pending
// sign-in and nothing about one is ever written to disk.
//
// The dependencies are injected so that the account is written by the one
// path every other sign-in uses (index.js passes its own upsert and reload),
// and so that a test can hand in a sign-in whose token exchange is a stub.

import { randomBytes } from 'node:crypto';
import { PANEL_LOGIN_TIMEOUT_MS } from './login-flow.js';
import { safeLine } from './safe-text.js';

/**
 * @typedef {object} DashboardLoginFlow  What `startLogin` hands back: the part of startOAuthLogin's answer used here.
 * @property {string} url  the sign-in link, for any device
 * @property {(text: string) => boolean} submit  false for an empty paste, throws for one that cannot be used
 * @property {Promise<void>} settled  resolves once the wait for a code has ended, whichever way
 * @property {Promise<Record<string, any>>} tokens
 */

/**
 * @typedef {object} PendingLogin
 * @property {string} id
 * @property {AbortController} controller
 * @property {number} expiresAt
 * @property {DashboardLoginFlow|null} flow  null until the sign-in has started
 * @property {boolean} finishing  a code was taken and the exchange or the save is running
 */

/**
 * @typedef {{ ok: true, id: string, url: string, expiresAt: number }
 *   | { ok: false, code: 'replaced'|'failed', error: string }} LoginStartResult
 * @typedef {{ ok: true, account: string, action: 'added'|'updated' }
 *   | { ok: false, code: 'unknown'|'unusable'|'busy'|'failed', error: string }} LoginFinishResult
 */

const EXPIRED = 'that sign-in has expired or was replaced; start again';

/**
 * @param {object} deps
 * @param {(opts: { loopback: false, signal: AbortSignal, timeoutMs: number }) => Promise<DashboardLoginFlow>} deps.startLogin
 * @param {(tokens: Record<string, any>) => Promise<{ action: 'added'|'updated', name: string }>} deps.upsert
 *   writes the account to the config; must throw, not exit, when it cannot
 * @param {() => unknown} deps.reload  brings the saved account into the running fleet
 * @param {number} [deps.timeoutMs]  how long a started sign-in waits for its code
 * @param {() => number} [deps.now]
 */
export function createDashboardLogin({ startLogin, upsert, reload, timeoutMs = PANEL_LOGIN_TIMEOUT_MS, now = Date.now }) {
  // One at a time: the page has one Add account control, and each pending
  // sign-in is a verifier held in memory for a caller that may never return.
  /** @type {PendingLogin|null} */
  let pending = null;

  /** @param {PendingLogin} entry */
  const forget = entry => { if (pending === entry) pending = null; };

  /** @param {unknown} err */
  const messageOf = err => safeLine(err instanceof Error ? err.message : String(err), 300);

  /**
   * Start a sign-in, ending the one before it.
   * @returns {Promise<LoginStartResult>}
   */
  async function start() {
    // Aborting is what ends the earlier wait; its own settle handler below
    // would forget it too, but only on a later turn, and the slot is needed now.
    pending?.controller.abort();
    /** @type {PendingLogin} */
    const entry = {
      id: randomBytes(16).toString('base64url'),
      controller: new AbortController(),
      expiresAt: now() + timeoutMs,
      flow: null,
      finishing: false,
    };
    // Taken before the await, so a second start arriving meanwhile finds this
    // one to abort instead of leaving two sign-ins waiting.
    pending = entry;
    /** @type {DashboardLoginFlow} */
    let flow;
    try {
      flow = await startLogin({ loopback: false, signal: entry.controller.signal, timeoutMs });
    } catch (err) {
      forget(entry);
      return { ok: false, code: 'failed', error: `could not start the sign-in: ${messageOf(err)}` };
    }
    // However the wait ends (its timeout, a cancel, a newer start, a code),
    // the entry goes with it, unless a finish holds it: that one forgets the
    // entry itself once the exchange and the save are over. `settled` never
    // rejects, and `tokens` is handled here, so a sign-in nobody finishes
    // cannot end the process with an unhandled rejection.
    flow.tokens.catch(() => {});
    void flow.settled.then(() => { if (!entry.finishing) forget(entry); });
    if (pending !== entry) return { ok: false, code: 'replaced', error: 'a newer sign-in replaced this one' };
    entry.flow = flow;
    return { ok: true, id: entry.id, url: flow.url, expiresAt: entry.expiresAt };
  }

  /**
   * Take the pasted code, exchange it, save the account and reload.
   * @param {unknown} id
   * @param {unknown} code
   * @returns {Promise<LoginFinishResult>}
   */
  async function finish(id, code) {
    const entry = pending;
    if (!entry || !entry.flow || typeof id !== 'string' || id !== entry.id) return { ok: false, code: 'unknown', error: EXPIRED };
    if (entry.finishing) return { ok: false, code: 'busy', error: 'that sign-in is already being finished' };
    // Set before the submit: a code that is taken settles the wait, and the
    // settle handler must find the entry held.
    entry.finishing = true;
    let taken;
    try {
      taken = entry.flow.submit(typeof code === 'string' ? code : '');
    } catch (err) {
      // The paste cannot be used and the flow says why, in words meant for
      // the person. The sign-in is still waiting, so another paste may follow.
      entry.finishing = false;
      return { ok: false, code: 'unusable', error: messageOf(err) };
    }
    if (!taken) {
      entry.finishing = false;
      return { ok: false, code: 'unusable', error: 'paste the code the page shows after you sign in' };
    }
    // From here the code is spent, so any failure ends this sign-in.
    try {
      const outcome = await upsert(await entry.flow.tokens);
      await reload();
      return { ok: true, account: outcome.name, action: outcome.action };
    } catch (err) {
      return { ok: false, code: 'failed', error: messageOf(err) };
    } finally {
      forget(entry);
    }
  }

  /**
   * End a pending sign-in. An id that names nothing pending is not an error:
   * the caller wanted it gone, and it is.
   * @param {unknown} id
   * @returns {{ ok: true, cancelled: boolean }}
   */
  function cancel(id) {
    const entry = pending;
    // A sign-in whose code was taken is past cancelling: the exchange is
    // already at the token endpoint, and its finish reports how it ends.
    if (!entry || typeof id !== 'string' || id !== entry.id || entry.finishing) return { ok: true, cancelled: false };
    entry.controller.abort();
    forget(entry);
    return { ok: true, cancelled: true };
  }

  return { start, finish, cancel };
}
