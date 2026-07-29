import { appendFileSync } from 'node:fs';

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
 */
export function installCrashHandlers(path, { exit = process.exit, log = process.stderr } = {}) {
  const report = (kind) => (err) => {
    const stack = err?.stack || String(err);
    const entry = `\n=== ${new Date().toISOString()} ${kind} ===\n${stack}\n`;
    // 0600: a stack can carry request context. A write failure (read-only home,
    // full disk) must not mask the crash itself — stderr still gets the entry.
    try { appendFileSync(path, entry, { mode: 0o600 }); } catch { /* report to stderr regardless */ }
    log.write(entry);
    exit(1);
  };
  process.on('uncaughtException', report('uncaughtException'));
  process.on('unhandledRejection', report('unhandledRejection'));
}
