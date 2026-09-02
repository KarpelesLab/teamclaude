import { TUI } from './tui.js';
import { SessionTitles } from './session-titles.js';
import { modelGlobMatches } from './model.js';

// Attach mode — the dashboard against a server running somewhere else (a
// background service, another terminal). The renderer is the same one the
// in-process TUI uses; only its data source changes, from a live AccountManager
// to a status snapshot polled over the localhost control plane.

const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5000;

// Addresses that reach this machine. A server bound to one of these exempts
// loopback clients from the proxy-key gate, which changes what a 401 can mean.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Client for the server's control endpoints. */
export class RemoteControl {
  constructor({ port, apiKey = null, host = '127.0.0.1', fetchImpl = fetch, timeoutMs = null }) {
    this.port = port;
    this.apiKey = apiKey;
    this.host = host;
    // null = unset, so a caller that knows its own cadence (the attach poller)
    // can derive one; DEFAULT_TIMEOUT_MS covers the one-shot callers.
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl;
  }

  /** The current status payload (the same one `teamclaude status` renders). */
  async status() {
    const payload = await this._call('GET', '/teamclaude/status');
    // A status reply always carries an accounts array, even when it is empty.
    // Anything else answered on this port is not this control plane, and calling
    // that "connected with no accounts" would diagnose the wrong problem.
    if (!Array.isArray(payload?.accounts)) {
      throw new Error('unexpected reply — this is not a teamclaude status endpoint');
    }
    return payload;
  }

  /** Re-read config and refresh credentials on the running server. */
  reload() {
    return this._action('POST', '/teamclaude/reload');
  }

  /**
   * Make the running server prefer `name`.
   *
   * The endpoint answers 404 for an account it cannot resolve, and a server
   * predating the endpoint has no handler for the path at all — two different
   * failures behind one status code. The control endpoints always answer with
   * `ok: false` plus a reason, so a 404 without that came from somewhere else
   * and means the feature is missing. Either way it is reported, never swallowed:
   * the dashboard must not show a switch that did not happen.
   */
  async switchAccount(name) {
    try {
      return await this._action('POST', '/teamclaude/switch', { account: name });
    } catch (err) {
      if (!err.answered && (err.status === 404 || err.status === 501)) {
        throw new Error('this server does not support switching accounts');
      }
      throw err;
    }
  }

  /**
   * A call that changes something on the server.
   *
   * The control plane confirms an applied action with `ok: true`. A 200 carrying
   * anything else did not perform it — the configured port may well be answering
   * from some other service, which will happily 200 an unknown POST — and
   * reporting success from a bare status code would invent a switch that never
   * happened.
   */
  async _action(method, path, body) {
    const payload = await this._call(method, path, body);
    if (payload?.ok !== true) throw new Error('unexpected reply — this is not a teamclaude control endpoint');
    return payload;
  }

  async _call(method, path, body) {
    const deadline = this.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers = {};
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res;
    try {
      res = await this._fetch(`http://${this.host}:${this.port}${path}`, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // A socket that is open but silent — the server stopped, the laptop
        // suspended mid-request — would otherwise hold this call for minutes
        // while the dashboard showed a live marker over a frozen snapshot.
        signal: AbortSignal.timeout(deadline),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error(`no reply within ${deadline}ms`);
      }
      throw err;
    }
    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* not JSON — the status carries the meaning */ }

    if (!res.ok) {
      // `ok: false` + a string reason is this control plane's own error shape;
      // anything else reached a handler that is not ours (an old server forwards
      // unknown paths upstream, and Anthropic's error body looks nothing like it).
      const answered = payload?.ok === false && typeof payload.error === 'string';
      // 401/403 needs a different fix from an unreachable server — but which fix
      // depends on where we are pointed. A teamclaude server exempts loopback
      // clients from the key gate, so a 401 from there cannot be about the key
      // and blaming it would send the operator to edit a config that is fine.
      const auth = !answered && (res.status === 401 || res.status === 403);
      const err = new Error(auth
        ? (LOOPBACK_HOSTS.has(this.host)
          ? `something other than teamclaude is answering on port ${this.port} (HTTP ${res.status})`
          : `the server rejected the proxy API key (HTTP ${res.status})`)
        : answered ? payload.error : `HTTP ${res.status}`);
      err.status = res.status;
      err.answered = answered;
      throw err;
    }
    // A 200 body can still report failure (the reload endpoint does this).
    if (payload && payload.ok === false) throw new Error(payload.error || 'request rejected');
    return payload;
  }
}

/**
 * The read surface the dashboard renders from, filled from a status payload.
 *
 * Deliberately not an AccountManager: attach mode has no rotation state of its
 * own, and anything the payload does not carry stays absent rather than being
 * guessed at.
 */
export class RemoteAccountManager {
  constructor() {
    this.accounts = [];
    this.currentIndex = -1;
    this.switchThreshold = 0.98;
    this.distributeSessions = false;
    this.routes = [];
    this.sessions = { active: 0, known: 0, perAccount: {} };
    this.connected = false;   // false ⇒ the view is a stale snapshot
    this.lastError = null;
    this.status = null;
  }

  applyStatus(status) {
    const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
    // The payload crosses a process boundary, and the renderer calls string
    // methods on name/type unguarded: a malformed reply (wrong port, older or
    // newer server) should read as unknown, not take the dashboard down.
    this.accounts = accounts.map((a, index) => ({
      ...a,
      index,
      name: a.name || '(unnamed)',
      type: a.type || '?',
      quota: { ...(a.quota || {}) },
    }));
    // -1 when the payload names an account that is no longer listed: nothing is
    // marked current, which is the truth, rather than defaulting to the first row.
    this.currentIndex = this.accounts.findIndex(a => a.name === status?.currentAccount);
    if (status?.switchThreshold != null) this.switchThreshold = status.switchThreshold;

    const sessions = status?.sessions || {};
    this.sessions = {
      active: sessions.active || 0,
      known: sessions.known || 0,
      perAccount: sessions.perAccount || {},
    };
    this.distributeSessions = !!sessions.distribute;
    // Same rule as the accounts above, and for the same reason: the renderer
    // walks route.accounts and route.match directly, so a route the payload
    // leaves half-specified would take the whole dashboard down mid-frame.
    this.routes = (Array.isArray(status?.routes) ? status.routes : []).map(r => ({
      ...r,
      match: Array.isArray(r?.match) ? r.match : [],
      accounts: Array.isArray(r?.accounts) ? r.accounts : [],
    }));
    this.status = status;
    this.connected = true;
    this.lastError = null;
  }

  markDisconnected(err) {
    this.connected = false;
    this.lastError = err?.message || String(err);
  }

  sessionStats() {
    return { ...this.sessions };
  }

  getRoutes() {
    return this.routes;
  }

  /** The account index a request for `model` would land on, from the route
   * target the server published, or null when no route matches or none can
   * serve it. */
  previewRouteIndex(model) {
    const route = this.routes.find(r => (r.match || []).some(g => modelGlobMatches(g, model)));
    if (!route?.target) return null;
    const idx = this.accounts.findIndex(a => a.name === route.target);
    return idx >= 0 ? idx : null;
  }

  /** Quota windows expire on the server, which re-reports them; nothing to do. */
  refreshExpiredQuotas() {}
}

/**
 * Wire a dashboard to a remote server: polling, control actions and quit.
 * Returns the pieces so a caller (or a test) can drive the poll itself.
 */
export function createAttachSession({ control, config, onQuit, pollMs = DEFAULT_POLL_MS }) {
  const am = new RemoteAccountManager();
  let timer = null;
  let polling = false;
  // A poll still outstanding after a few intervals is not going to arrive, and
  // holding it hides an outage behind the last good frame. An explicitly
  // configured deadline wins.
  control.timeoutMs ??= Math.max(2000, pollMs * 3);

  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };

  const tui = new TUI({
    accountManager: am,
    config,
    remote: true,
    // Titles come from this machine's Claude Code sessions. Attaching to a
    // server on another host leaves the ids unresolved, which shows the short
    // id rather than a wrong name.
    sessionTitles: new SessionTitles(config?.sessionTitles),
    // Every screen that writes config is unreachable in attach mode; if one ever
    // becomes reachable, this fails loudly instead of silently dropping a save.
    saveConfig: async () => { throw new Error('attach mode cannot write config'); },
    syncAccounts: async () => (await control.reload())?.added || 0,
    applySwitch: name => control.switchAccount(name),
    onQuit: () => { stop(); onQuit?.(); },
  });

  const poll = async () => {
    // A server that accepts the connection and then never answers would other-
    // wise collect one pending request per tick, for as long as it stays wedged.
    if (polling) return;
    polling = true;
    try {
      const status = await control.status();
      const recovered = !am.connected && am.lastError != null;
      am.applyStatus(status);
      if (recovered) tui._addLog('Reconnected to the server');
    } catch (err) {
      // One line per outage, not one per second.
      if (am.connected || am.lastError == null) {
        tui._addLog(`Lost contact with the server: ${err.message}`);
      }
      am.markDisconnected(err);
    } finally {
      polling = false;
    }
    tui.render();
  };

  const start = () => {
    tui.start();
    poll();
    timer = setInterval(poll, pollMs);
  };

  return { tui, am, poll, start, stop };
}
