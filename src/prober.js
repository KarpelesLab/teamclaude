// Background quota prober.
//
// Quota utilization and reset times are only reported by Anthropic in the
// `anthropic-ratelimit-*` headers of /v1/messages responses — there is no
// free "usage" endpoint. So an account that isn't currently serving traffic
// has stale/unknown quota until it's rotated to. The prober periodically sends
// a minimal 1-token request to each idle account to harvest those headers.
//
// Claude Max (OAuth) tokens are only accepted on requests that look like Claude
// Code (specific anthropic-beta header + a system prompt whose first block is
// the Claude Code identity). Rather than hardcode that shape, we learn it from
// real traffic flowing through the proxy (recordTemplate) and replay a minimal
// version. API-key accounts need no template.

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
// Headers worth replaying from real Claude Code traffic (account-independent).
const TEMPLATE_HEADERS = ['anthropic-version', 'anthropic-beta', 'user-agent'];

export class Prober {
  constructor({ accountManager, upstream, intervalMs }) {
    this.accountManager = accountManager;
    this.upstream = upstream || 'https://api.anthropic.com';
    this.intervalMs = intervalMs;
    this.template = null;   // { headers, model, system } learned from live traffic
    this._timer = null;
    this._running = false;
    this._warnedNoTemplate = false;
  }

  /** Learn the OAuth-acceptable request shape from a real /v1/messages request. */
  recordTemplate(headers, bodyBuf) {
    try {
      const tplHeaders = {};
      for (const name of TEMPLATE_HEADERS) {
        const v = headers[name];
        if (v) tplHeaders[name] = v;
      }
      let model = null;
      let system = null;
      if (bodyBuf && bodyBuf.length) {
        const body = JSON.parse(bodyBuf.toString());
        if (body.model) model = body.model;
        system = this._firstSystemBlock(body.system);
      }
      this.template = { headers: tplHeaders, model, system };
    } catch {
      // Not JSON or unexpected shape — keep any previous template.
    }
  }

  _firstSystemBlock(system) {
    if (Array.isArray(system) && system[0]) {
      const b = system[0];
      const text = typeof b === 'string' ? b : b?.text;
      if (text) return [{ type: 'text', text }];
    } else if (typeof system === 'string' && system.trim()) {
      return [{ type: 'text', text: system.split('\n')[0] }];
    }
    return null;
  }

  start() {
    if (!this.intervalMs || this.intervalMs <= 0) return; // disabled
    this._timer = setInterval(() => this.pokeStale(), this.intervalMs);
    this._timer.unref?.(); // don't keep the process alive on our account
    // First pass shortly after boot: API-key accounts can be probed right away;
    // OAuth accounts wait until a real request has taught us the template.
    setTimeout(() => this.pokeStale(), 3000).unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** Probe every account whose quota is stale and that isn't throttled/errored. */
  async pokeStale() {
    if (this._running) return; // never overlap passes
    this._running = true;
    try {
      const now = Date.now();
      for (const account of this.accountManager.accounts) {
        // Auto-heal errored OAuth accounts: a stale/rotated token leaves an
        // account stuck in 'error' with nothing to retry it. Force a refresh;
        // ensureTokenFresh clears 'error'→'active' on success. If it stays
        // errored (refresh token truly dead), skip until the next tick.
        if (account.status === 'error') {
          if (account.type !== 'oauth' || !account.refreshToken) continue;
          await this.accountManager.ensureTokenFresh(account.index, true).catch(() => {});
          if (account.status === 'error') continue;
        }
        if (account.status === 'exhausted') continue;
        if (account.rateLimitedUntil && now < account.rateLimitedUntil) continue;
        const fresh = account.lastQuotaAt && (now - account.lastQuotaAt) < this.intervalMs;
        if (fresh) continue;
        await this._poke(account).catch(() => {});
      }
    } finally {
      this._running = false;
    }
  }

  async _poke(account) {
    const isOAuth = account.type === 'oauth';
    if (isOAuth && !this.template) {
      if (!this._warnedNoTemplate) {
        console.log('[TeamClaude] Quota probe deferred for OAuth accounts until the first request establishes a template');
        this._warnedNoTemplate = true;
      }
      return;
    }

    await this.accountManager.ensureTokenFresh(account.index);

    const headers = { ...(this.template?.headers || {}), 'content-type': 'application/json' };
    if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
    if (isOAuth) headers['authorization'] = `Bearer ${account.credential}`;
    else headers['x-api-key'] = account.credential;

    const body = {
      model: this.template?.model || FALLBACK_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    };
    if (isOAuth) {
      body.system = this.template?.system || [{ type: 'text', text: CLAUDE_CODE_IDENTITY }];
    }

    // Bound each probe so a hung upstream can't stall the whole prober
    // (pokeStale is guarded by _running and awaits probes sequentially).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
      res = await fetch(`${this.upstream}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      return; // transient network error or timeout — leave the account untouched
    } finally {
      clearTimeout(timer);
    }

    const rateLimitHeaders = {};
    for (const [k, v] of res.headers.entries()) {
      if (k.startsWith('anthropic-ratelimit-')) rateLimitHeaders[k] = v;
    }
    // Harvest quota without counting the probe as real client usage.
    this.accountManager.updateQuota(account.index, rateLimitHeaders, { countRequest: false });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after'), 10) || 60;
      this.accountManager.markRateLimited(account.index, retryAfter);
    } else if (res.status === 401 || res.status === 403) {
      console.log(`[TeamClaude] Quota probe rejected for "${account.name}" (${res.status}) — template may be stale`);
    }

    await res.body?.cancel();
  }
}
