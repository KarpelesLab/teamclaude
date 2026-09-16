import { appendFileSync } from 'node:fs';

/** Did a write fail because whatever was reading has gone?
 *
 *  Node reports this asynchronously when the stream is non-blocking, so it
 *  arrives as an event rather than at the call site and no `try` around the
 *  write can catch it.
 *  @param {any} err */
function isBrokenPipe(err) {
  return err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED';
}

/**
 * Write a fatal error to `path` before the process dies.
 *
 * Node prints an uncaught exception to stderr and exits, which is invisible in
 * practice: the server runs under a full-screen TUI that repaints over the
 * stack, and stderr usually goes nowhere anyone kept. The one artifact that
 * explains a sudden exit has to outlive the process, so write it to a file.
 *
 * Handling these events replaces Node's own behaviour, so this must do what
 * Node would: report and exit non-zero. Continuing after an uncaught exception
 * would leave the proxy running on unknown state.
 *
 * A broken pipe is the one exception, and it is deliberate. The terminal going
 * away says nothing about the proxy's state — every account, route and inflight
 * request is exactly as it was — so ending the process punishes every routed
 * session for a closed pane. It happened three times in two days here: the TUI
 * writes to a non-blocking stdout, so the failure could not be caught where it
 * was written, and each death also orphaned a sidecar on its port. Recorded
 * once, because a stream dying is worth knowing, then survived. Once is enough:
 * the stream stays dead, and a storm of them would say nothing new.
 * @param {string} path
 * @param {{ exit?: (code: number) => void, log?: { write: (s: string) => void } }} [opts]
 */
export function installCrashHandlers(path, { exit = process.exit, log = process.stderr } = {}) {
  let brokenPipeRecorded = false;
  // 0600: a stack can carry request context. A write failure (read-only home,
  // full disk) must not mask the crash itself — stderr still gets the entry.
  const record = (/** @type {string} */ entry) => {
    try { appendFileSync(path, entry, { mode: 0o600 }); } catch { /* report to stderr regardless */ }
  };
  const report = (/** @type {string} */ kind) => (/** @type {any} */ err) => {
    const stack = err?.stack || String(err);
    // A bare "Error: write EPIPE" names neither the stream nor the call. The
    // code and syscall are what turn the next one of these into a diagnosis
    // rather than an afternoon of inference.
    const detail = [err?.code, err?.syscall].filter(Boolean).join(' ');
    const entry = `\n=== ${new Date().toISOString()} ${kind}${detail ? ` (${detail})` : ''} ===\n${stack}\n`;
    if (isBrokenPipe(err)) {
      if (!brokenPipeRecorded) { brokenPipeRecorded = true; record(entry); }
      // Deliberately not written to `log`: that is very likely the stream that
      // just failed, and would fail again.
      return;
    }
    record(entry);
    log.write(entry);
    exit(1);
  };
  process.on('uncaughtException', report('uncaughtException'));
  process.on('unhandledRejection', report('unhandledRejection'));
}
