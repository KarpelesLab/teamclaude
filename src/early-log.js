// Console output produced before the TUI exists.
//
// `tui.start()` swaps console.log/error for the activity pane and moves the
// terminal to the alternate screen, and it runs from the `server.listen()`
// callback. Everything the server says before that — which account it starts
// on, a token refresh, "Quota probe enabled", the upstream proxy line — went to
// the normal screen instead. It never reached the activity pane or the
// `--activity-log` file, stayed hidden for as long as the TUI ran, and came back
// after `q` looking like something that had just been logged (#413).
//
// So when a TUI is going to run, startup output is held here and replayed
// through the console once the TUI owns it. If the process exits first (port in
// use, a bad config) the held lines go to the real stderr, or those errors
// would be lost with the screen they were meant for.

/**
 * @param {Object} [opts]
 * @param {{ log: Function, error: Function, warn: Function }} [opts.target]  the console to hold
 * @param {{ write: (s: string) => unknown }} [opts.stderr]  where held lines go if the process exits first
 * @param {(fn: () => void) => void} [opts.onExit]
 * @param {(fn: () => void) => void} [opts.offExit]
 * @returns {{ release: () => string[] }}  `release()` restores the console and
 *   returns the held lines, oldest first, for the caller to replay
 */
export function captureEarlyConsole({
  target = console,
  stderr = process.stderr,
  onExit = (fn) => { process.once('exit', fn); },
  offExit = (fn) => { process.removeListener('exit', fn); },
} = {}) {
  /** @type {string[]} */
  const lines = [];
  const original = { log: target.log, error: target.error, warn: target.warn };
  let done = false;
  const hold = (/** @type {unknown[]} */ ...args) => { lines.push(args.join(' ')); };
  const restore = () => {
    target.log = original.log;
    target.error = original.error;
    target.warn = original.warn;
  };
  const flushOnExit = () => {
    if (done) return;
    done = true;
    restore();
    for (const line of lines) stderr.write(`${line}\n`);
  };
  target.log = hold;
  target.error = hold;
  target.warn = hold;
  onExit(flushOnExit);
  return {
    release() {
      if (done) return [];
      done = true;
      restore();
      offExit(flushOnExit);
      return lines.splice(0);
    },
  };
}
