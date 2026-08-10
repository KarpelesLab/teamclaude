import { TUI } from './tui.js';
import { modelGlobMatches } from './model.js';

// Attach mode — the dashboard against a server running somewhere else (a
// background service, another terminal). The renderer is the same one the
// in-process TUI uses; only its data source changes, from a live AccountManager
// to a status snapshot polled over the localhost control plane.

const DEFAULT_POLL_MS = 1000;

/** Client for the server's control endpoints. */
export class RemoteControl {
  constructor({ port, apiKey = null, host = '127.0.0.1', fetchImpl = fetch }) {
    this.port = port;
    this.apiKey = apiKey;
    this.host = host;
    this._fetch = fetchImpl;
  }

  /** The current status payload (the same one `teamclaude status` renders). */
  status() {
    return this._call('GET', '/teamclaude/status');
  }

  /** Re-read config and refresh credentials on the running server. */
  reload() {
    return this._call('POST', '/teamclaude/reload');
  }

  /**
   * Point the running server's default route at `name`.
   *
   * A server predating the endpoint answers 404 — reported as such rather than
   * swallowed, so the dashboard never shows a switch that did not happen.
   */
  async switchAccount(name) {
    try {
      return await this._call('POST', '/teamclaude/switch', { account: name });
    } catch (err) {
      if (err.status === 404 || err.status === 501) {
        throw new Error('this server does not support switching accounts');
      }
      throw err;
    }
  }

  async _call(method, path, body) {
    const headers = {};
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await this._fetch(`http://${this.host}:${this.port}${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* not JSON — the status carries the meaning */ }

    if (!res.ok) {
      const err = new Error(payload?.error ? `HTTP ${res.status}: ${payload.error}` : `HTTP ${res.status}`);
      err.status = res.status;
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
    this.accounts = accounts.map((a, index) => ({ ...a, index, quota: { ...(a.quota || {}) } }));
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
    this.routes = Array.isArray(status?.routes) ? status.routes : [];
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

  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };

  const tui = new TUI({
    accountManager: am,
    config,
    remote: true,
    // Every screen that writes config is unreachable in attach mode; if one ever
    // becomes reachable, this fails loudly instead of silently dropping a save.
    saveConfig: async () => { throw new Error('attach mode cannot write config'); },
    syncAccounts: async () => (await control.reload())?.added || 0,
    applySwitch: name => control.switchAccount(name),
    onQuit: () => { stop(); onQuit?.(); },
  });

  const poll = async () => {
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
