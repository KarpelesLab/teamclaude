import { usageSummary, WINDOW_KEYS } from './query.js';

/**
 * Answer GET /teamclaude/usage?window=… . Returns true when it handled the
 * request, so the caller can fall through to its other routes.
 *
 * The prefix test runs before `new URL()` so every other request — the entire
 * forwarded inference path — pays nothing for this route's existence.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./db.js').Store|null} [store]
 */
export function handleUsageRoute(req, res, store) {
  if (req.method !== 'GET' || !(req.url || '').startsWith('/teamclaude/usage')) return false;
  const url = new URL(req.url || '', 'http://localhost');
  if (url.pathname !== '/teamclaude/usage') return false;
  const window = url.searchParams.get('window') || '';
  const summary = store ? usageSummary(store, window) : null;
  if (!summary) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown window', windows: WINDOW_KEYS }));
    return true;
  }
  // A polling dashboard must see the memo's own freshness, not a browser's cache heuristics.
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(summary));
  return true;
}
