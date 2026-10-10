// Signing in from a terminal that may not be on the machine with the browser.
//
// Both OAuth logins (Claude's and Codex's) normally end the same way: the
// browser is sent back to a loopback listener with an authorization code. That
// only works when the browser runs on the machine the listener does. Over SSH
// it does not: xdg-open fails or opens a window nobody can see, and the
// laptop's browser cannot reach the remote 127.0.0.1. So a login here can also
// be finished by pasting what the browser was left holding, and the two ways
// race. The pieces both providers share live here: telling a remote terminal
// from a local one, opening a browser, the race itself, and the CLI's paste
// prompt.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { envVar } from './brand.js';
import { sanitizeText } from './safe-text.js';

/** How long a CLI login waits for the browser or a paste before it gives up. */
export const LOGIN_TIMEOUT_MS = 120_000;

/** The TUI login panel's wait. Longer than the CLI's because the panel's usual
 *  case is the slow one: a link opened on another device, a sign-in there, and
 *  a code carried back by hand. Esc ends it sooner, and nothing but port 1455
 *  (Codex) is held meanwhile. */
export const PANEL_LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * What a started sign-in needs from whoever shows it to a person: the TUI's
 * login panel, which owns the screen and the keyboard while it is open.
 *
 * @typedef {object} LoginPrompt
 * @property {'claude' | 'codex'} provider
 * @property {string} url  the link to show and copy; it works from any device
 * @property {boolean} remote  the terminal looks remote, so no browser was opened here
 * @property {boolean} listening  a loopback listener is waiting for the browser to come back by itself
 * @property {string | null} note  why that listener is not running, when it matters
 * @property {(text: string) => boolean} submit  a pasted answer: true when it settled the
 *   login, false when there was nothing to use; throws, with a message for the person,
 *   when the paste cannot be used
 */

/**
 * Whether this terminal looks like it is somewhere other than the user's
 * browser.
 *
 * An SSH session says so in its environment. A Linux box with no display
 * server has no browser to open even when nobody came in over SSH (a
 * container, a console login on a server). Neither test can see everything: a
 * server started by a service inside tmux and attached over SSH later carries
 * the environment it started with, not the attaching client's. That case is
 * what `TEAMCLAUDE_REMOTE` is for: `1` says remote whatever the environment
 * shows, `0` says local. Nothing relies on the answer alone. It decides
 * whether a browser is worth opening here (and, for Claude, the loopback
 * listener only that browser could reach); the TUI panel and a CLI login on a
 * terminal take a paste either way.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 */
export function isRemoteSession(env = process.env, platform = process.platform) {
  const forced = envVar('REMOTE', env);
  if (forced === '1') return true;
  if (forced === '0') return false;
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/**
 * Open `url` in the default browser, without waiting for it.
 *
 * Best effort and never in the way. Every caller also puts the URL in front of
 * the person, so a failure costs one console line (the TUI's activity pane, or
 * stderr) and never an exception. Detached with no stdio, so an opener that
 * falls back to a text browser cannot take the terminal, and one that hangs
 * cannot hold the sign-in up. No shell outside Windows, so nothing in the URL
 * can be read as shell syntax.
 *
 * @param {string} url
 */
export function openBrowser(url) {
  const win = process.platform === 'win32';
  const opener = process.platform === 'darwin' ? 'open' : win ? 'start' : 'xdg-open';
  const report = (/** @type {string} */ why) => console.error(`Could not open a browser (${opener}): ${why}. Open the link by hand instead.`);
  try {
    // `start` reads its first quoted argument as a window title, and cmd would
    // split an unquoted URL at `&`.
    const child = spawn(opener, win ? ['""', `"${url}"`] : [url], { stdio: 'ignore', shell: win, detached: !win });
    child.on('error', err => report(err.message));
    child.on('exit', code => { if (code) report(`exit code ${code}`); });
    child.unref();
  } catch (err) {
    report(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The two ways an authorization code comes back, raced: the loopback listener
 * the browser is redirected to, and a paste.
 *
 * The first to produce a usable value wins and `onSettle` runs once (it closes
 * the listener). A paste that cannot be used throws from `submit` and leaves
 * the race running, so a wrong paste costs a retry rather than the whole
 * sign-in. Cancelling through `signal` and the timeout both reject `result`.
 *
 * @template T
 * @param {object} opts
 * @param {Promise<T> | null} [opts.listener]  the browser's redirect; null when nothing is listening
 * @param {(text: string) => T | null} opts.parse  a paste as the same value: null when nothing
 *   was pasted, an exception when the paste cannot be used
 * @param {AbortSignal | null} [opts.signal]
 * @param {number} [opts.timeoutMs]  0 waits for ever
 * @param {() => void} [opts.onSettle]
 * @returns {{ result: Promise<T>, settled: Promise<void>, submit: (text: string) => boolean }}
 */
export function codeRace({ listener = null, parse, signal = null, timeoutMs = LOGIN_TIMEOUT_MS, onSettle = () => {} }) {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  /** @type {(err: unknown) => void} */
  let reject = () => {};
  /** @type {Promise<T>} */
  const result = new Promise((res, rej) => { resolve = res; reject = rej; });
  let done = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  /** @param {() => void} settle */
  const finish = settle => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    try { onSettle(); } finally { settle(); }
  };
  const onAbort = () => finish(() => reject(cancelReason(signal)));

  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => finish(() => reject(new Error(`Login timed out after ${formatMinutes(timeoutMs)}`))), timeoutMs);
    // A CLI login is kept alive by its listener or its prompt, not by this.
    timer.unref?.();
  }
  listener?.then(value => finish(() => resolve(value)), err => finish(() => reject(err)));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  /** @param {string} text */
  const submit = text => {
    if (done) return false;
    const value = parse(String(text ?? ''));
    if (value == null) return false;
    finish(() => resolve(value));
    return true;
  };
  // `settled` handles `result` itself, so a race nobody awaited cannot end the
  // process with an unhandled rejection when it later times out.
  const settled = result.then(() => {}, () => {});
  return { result, settled, submit };
}

/** An explicit abort reason is the message; a bare abort() is a cancel, named
 *  AbortError so a caller can tell the operator's own Esc from a failure.
 *  @param {AbortSignal | null} signal */
function cancelReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name !== 'AbortError') return reason;
  const err = new Error('Login cancelled');
  err.name = 'AbortError';
  return err;
}

/** @param {number} ms */
function formatMinutes(ms) {
  const mins = ms / 60_000;
  if (mins < 1) return `${Math.round(ms / 1000)} seconds`;
  const n = Number.isInteger(mins) ? String(mins) : mins.toFixed(1);
  return `${n} minute${mins === 1 ? '' : 's'}`;
}

/**
 * Ask the terminal for a paste until one is taken or the race ends another way.
 *
 * A paste the flow cannot use is reported and asked for again. Ctrl-C, or the
 * end of input, calls `onEnd`: the caller turns that into a cancel, since a
 * login nobody can paste into and nobody is waiting on would otherwise sit out
 * its whole timeout.
 *
 * @param {object} opts
 * @param {(text: string) => boolean} opts.submit
 * @param {Promise<unknown>} opts.settled  the race is over (the prompt closes)
 * @param {string} opts.prompt
 * @param {() => void} opts.onEnd
 * @param {NodeJS.ReadableStream} [opts.input]
 * @param {NodeJS.WritableStream} [opts.output]
 */
export function pasteFromTerminal({ submit, settled, prompt, onEnd, input = process.stdin, output = process.stderr }) {
  const rl = createInterface({ input, output });
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    rl.close();
  };
  rl.on('close', () => {
    if (!open) return;
    open = false;
    onEnd();
  });
  rl.on('SIGINT', () => { close(); onEnd(); });
  settled.then(close);
  const ask = () => {
    if (!open) return;
    rl.question(prompt, answer => {
      try {
        if (submit(answer)) { close(); return; }
      } catch (err) {
        // The reason can quote what the provider put in the redirect, and
        // that must not reach the terminal as escape sequences.
        output.write(`${sanitizeText(err instanceof Error ? err.message : err)}\n`);
      }
      ask();
    });
  };
  ask();
}
