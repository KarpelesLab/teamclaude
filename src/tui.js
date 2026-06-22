import { importCredentials, fetchProfile } from './oauth.js';
import { sameIdentity } from './identity.js';

// ── ANSI helpers ─────────────────────────────────────────────

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('');
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

const bold = s => `${BOLD}${s}${RESET}`;
const dim = s => `${DIM}${s}${RESET}`;
const fg = (c, s) => `${ESC}${c}m${s}${RESET}`;
const green = s => fg(32, s);
const yellow = s => fg(33, s);
const red = s => fg(31, s);
const cyan = s => fg(36, s);
const gray = s => fg(90, s);

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = s => s.replace(ANSI_RE, '');
const vw = s => strip(s).length;

function rpad(s, w) {
  const gap = w - vw(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/** Truncate a string with ANSI codes to exactly w visible characters, then reset. */
function truncate(s, w) {
  let visible = 0;
  let out = '';
  let i = 0;
  while (i < s.length && visible < w) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end >= 0) { out += s.slice(i, end + 1); i = end + 1; continue; }
    }
    out += s[i];
    visible++;
    i++;
  }
  return out + RESET;
}

/** Fit a line to exactly w columns: truncate if too long, pad if too short. */
function fitLine(s, w) {
  const v = vw(s);
  if (v > w) return truncate(s, w);
  if (v < w) return s + ' '.repeat(w - v);
  return s;
}

function formatReset(resetTs) {
  if (!resetTs) return '';
  const ms = resetTs - Date.now();
  if (ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d${rh}h` : `${days}d`;
}

/**
 * Render a progress bar using background colors with text overlaid.
 * The label (e.g. "Ses 2h30m" or "45%") is drawn on top of the bar.
 */
function bar(ratio, w = 10, resetTs) {
  const rst = formatReset(resetTs);

  if (ratio == null || isNaN(ratio)) {
    // No data — dim background, show label or dash
    const label = rst || '-';
    const text = label.slice(0, w);
    const pad = w - text.length;
    const lp = Math.floor(pad / 2);
    const rp = pad - lp;
    return `${ESC}100m${' '.repeat(lp)}${text}${' '.repeat(rp)}${RESET}`;
  }

  ratio = Math.max(0, Math.min(1, ratio));
  const f = Math.round(ratio * w);
  // Background colors: 42=green, 43=yellow, 41=red; 100=bright black (gray) for empty
  const bg = ratio < 0.7 ? 42 : ratio < 0.9 ? 43 : 41;

  // Build the label to overlay: show reset time if available, else percentage
  const pct = (ratio * 100).toFixed(0) + '%';
  const label = rst || pct;
  const text = label.slice(0, w);
  const pad = w - text.length;
  const lp = Math.floor(pad / 2);
  const rp = pad - lp;
  const chars = (' '.repeat(lp) + text + ' '.repeat(rp));

  // Split chars into filled (colored bg) and empty (gray bg) portions
  const filled = chars.slice(0, f);
  const empty = chars.slice(f);

  let out = '';
  if (filled) out += `${ESC}${bg};97m${filled}`;
  if (empty) out += `${ESC}100;37m${empty}`;
  out += RESET;
  return out;
}

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ── TUI class ────────────────────────────────────────────────

export class TUI {
  constructor({ accountManager, config, saveConfig, syncAccounts, onQuit, sx = null }) {
    this.am = accountManager;
    this.config = config;
    this.saveConfig = saveConfig;
    this.syncAccounts = syncAccounts;
    this.onQuit = onQuit;
    this.sx = sx;            // sx.org proxy manager (may be null)
    this.sxBalance = null;   // last fetched sx.org balance, for the settings screen

    this.log = [];           // completed activity entries
    this.active = new Map(); // in-flight requests
    this.mode = 'normal';    // normal | select | add | input | settings
    this.selAction = null;   // switch | remove
    this.selIdx = 0;
    this.inputPrompt = '';
    this.inputBuf = '';
    this.inputCb = null;
    this.frame = 0;
    this.running = false;
    this.timer = null;
    this._origLog = null;
    this._origErr = null;
  }

  // ── lifecycle ──────────────────────────────────────

  start() {
    this.running = true;
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    this._dataHandler = d => this._onData(d);
    this._resizeHandler = () => this.render();
    process.stdin.on('data', this._dataHandler);
    process.stdout.on('resize', this._resizeHandler);

    // Redirect console to activity log
    this._origLog = console.log;
    this._origErr = console.error;
    console.log = (...a) => this._addLog(a.join(' '));
    console.error = (...a) => this._addLog(a.join(' '));

    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.render();
    }, 500);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._origLog) { console.log = this._origLog; console.error = this._origErr; }
    process.stdin.removeListener('data', this._dataHandler);
    process.stdout.removeListener('resize', this._resizeHandler);
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
  }

  // ── server hooks ───────────────────────────────────

  onRequestStart(id, info) {
    this.active.set(id, { ...info, t: timestamp(), started: Date.now(), account: null });
    this.render();
  }

  onRequestRouted(id, info) {
    const r = this.active.get(id);
    if (r) r.account = info.account;
  }

  onRequestEnd(id, info) {
    const r = this.active.get(id);
    this.active.delete(id);
    const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
    const acct = info.account || r?.account || '?';
    this._addLog(`${info.method} ${info.path} → ${acct} (${info.status}, ${dur}s)`);
  }

  _addLog(msg) {
    msg = msg.replace(/^\[TeamClaude\]\s*/, '');
    this.log.unshift({ t: timestamp(), msg });
    if (this.log.length > 200) this.log.length = 200;
    if (this.running) this.render();
  }

  // ── input handling ─────────────────────────────────

  _onData(d) {
    if (d === '\x1b[A') return this._key('up');
    if (d === '\x1b[B') return this._key('down');
    if (d === '\x1b') return this._key('esc');
    if (d === '\r' || d === '\n') return this._key('enter');
    if (d === '\x03') return this._key('ctrl-c');
    if (d === '\x7f' || d === '\x08') return this._key('bs');
    if (d.length === 1 && d >= ' ') return this._key(d);
  }

  _key(k) {
    if (k === 'ctrl-c') { this.stop(); this.onQuit?.(); return; }

    switch (this.mode) {
      case 'normal': this._keyNormal(k); break;
      case 'select': this._keySelect(k); break;
      case 'add':    this._keyAdd(k); break;
      case 'input':  this._keyInput(k); break;
      case 'settings': this._keySettings(k); break;
    }
    this.render();
  }

  _keyNormal(k) {
    if (k === 'q') { this.stop(); this.onQuit?.(); }
    else if (k === 's' && this.am.accounts.length > 0) {
      this.mode = 'select'; this.selAction = 'switch'; this.selIdx = this.am.currentIndex;
    }
    else if (k === 'r' && this.am.accounts.length > 0) {
      this.mode = 'select'; this.selAction = 'remove'; this.selIdx = 0;
    }
    else if (k === 'd' && this.am.accounts.length > 0) {
      this.mode = 'select'; this.selAction = 'toggle'; this.selIdx = this.am.currentIndex;
    }
    else if (k === 'a') { this.mode = 'add'; }
    else if (k === 'R') { this._doSync(); }
    else if (k === 'g' && this.sx) { this.mode = 'settings'; this._loadSxBalance(); }
  }

  _keySettings(k) {
    if (k === 't') {
      this.mode = 'input';
      this.inputPrompt = 'Switch threshold % (1-100)';
      this.inputBuf = '';
      this.inputCb = v => { if (v) this._doSetThreshold(v.trim()); };
    }
    else if (k === 'p') {
      this.mode = 'input';
      this.inputPrompt = 'Quota probe seconds (0=off, min 30)';
      this.inputBuf = '';
      this.inputCb = v => { if (v) this._doSetProbe(v.trim()); };
    }
    else if (k === 'k') {
      this.mode = 'input';
      this.inputPrompt = 'sx.org API key';
      this.inputBuf = '';
      this.inputCb = v => { if (v) this._doSetSxKey(v.trim()); };
    }
    else if (k === 'm') { this._doCycleSxMode(); }
    else if (k === 'x') { this._doClearSxKey(); }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  async _doSetThreshold(input) {
    const pct = Number(input);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
      this._addLog('Invalid threshold — enter 1–100'); this.mode = 'settings'; if (this.running) this.render(); return;
    }
    const v = Math.round(pct) / 100;
    this.config.switchThreshold = v;
    this.am.switchThreshold = v; // apply to the running rotation immediately
    try { await this.saveConfig(this.config); }
    catch (e) { this._addLog(`Failed to save: ${e.message}`); }
    this._addLog(`Switch threshold set to ${Math.round(v * 100)}%`);
    this.mode = 'settings';
    if (this.running) this.render();
  }

  async _doSetProbe(input) {
    let secs = parseInt(input, 10);
    if (Number.isNaN(secs) || secs < 0) {
      this._addLog('Invalid interval — enter 0 (off) or seconds'); this.mode = 'settings'; if (this.running) this.render(); return;
    }
    if (secs > 0 && secs < 30) secs = 30; // match the CLI minimum (don't hammer the usage endpoint)
    this.config.quotaProbeSeconds = secs;
    try { await this.saveConfig(this.config); }
    catch (e) { this._addLog(`Failed to save: ${e.message}`); }
    // syncAccounts re-reads disk config and reschedules the running prober live.
    try { await this.syncAccounts(); }
    catch (e) { this._addLog(`Reload failed: ${e.message}`); }
    this._addLog(secs > 0 ? `Quota probe every ${secs}s` : 'Quota probe disabled');
    this.mode = 'settings';
    if (this.running) this.render();
  }

  _keySelect(k) {
    const len = this.am.accounts.length;
    if (k === 'up' || k === 'k') this.selIdx = Math.max(0, this.selIdx - 1);
    else if (k === 'down' || k === 'j') this.selIdx = Math.min(len - 1, this.selIdx + 1);
    else if (k === 'enter') {
      if (this.selAction === 'switch') {
        this.am.currentIndex = this.selIdx;
        this._addLog(`Switched to "${this.am.accounts[this.selIdx].name}"`);
      } else if (this.selAction === 'toggle') {
        this._doToggleDisabled(this.selIdx);
      } else {
        this._doRemove(this.selIdx);
      }
      this.mode = 'normal';
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyAdd(k) {
    if (k === 'i') { this._doImport(); this.mode = 'normal'; }
    else if (k === 'k') {
      this.mode = 'input';
      this.inputPrompt = 'API key';
      this.inputBuf = '';
      this.inputCb = v => { if (v) this._doAddKey(v); };
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyInput(k) {
    if (k === 'enter') {
      const cb = this.inputCb;
      const v = this.inputBuf;
      this.mode = 'normal'; this.inputCb = null; this.inputBuf = '';
      cb?.(v);
    }
    else if (k === 'esc') { this.mode = 'normal'; this.inputCb = null; this.inputBuf = ''; }
    else if (k === 'bs') { this.inputBuf = this.inputBuf.slice(0, -1); }
    else if (k.length === 1) { this.inputBuf += k; }
  }

  // ── account operations ─────────────────────────────

  async _doSync() {
    try {
      const count = await this.syncAccounts();
      if (count > 0) {
        this._addLog(`Synced ${count} new account(s) from config`);
      } else {
        this._addLog('Config reloaded, credentials refreshed');
      }
    } catch (e) {
      this._addLog(`Sync failed: ${e.message}`);
    }
  }

  // ── sx.org settings ────────────────────────────────

  _loadSxBalance() {
    this.sxBalance = null;
    if (!this.sx?.apiKey) return;
    this.sx.getBalance()
      .then(b => { this.sxBalance = b; if (this.running) this.render(); })
      .catch(() => {});
  }

  _sxModeLabel(m) { return m === 'always' ? 'always' : m === '429' ? 'on 429 only' : 'off'; }

  async _doSetSxKey(key) {
    const mode = this.config.sx?.mode || 'always';
    this.config.sx = { apiKey: key, mode };
    try { await this.saveConfig(this.config); }
    catch (e) { this._addLog(`Failed to save sx.org key: ${e.message}`); }
    this._addLog('sx.org: configuring...');
    const r = await this.sx.configure(key, mode);
    if (r.ok && r.proxy) this._addLog(`sx.org key saved — proxy ${r.proxy.host}:${r.proxy.port} (mode: ${this._sxModeLabel(mode)})`);
    else if (r.ok) this._addLog(`sx.org key saved (mode: ${this._sxModeLabel(mode)})`);
    else this._addLog(`sx.org error: ${r.error}`);
    this._loadSxBalance();
    this.mode = 'settings';
    if (this.running) this.render();
  }

  // Cycle off → on-429 → always. Keeps the API key, so the user can disable
  // sx.org without deconfiguring it.
  async _doCycleSxMode() {
    const order = ['off', '429', 'always'];
    const next = order[(order.indexOf(this.sx.getMode()) + 1) % order.length];
    this.config.sx = { ...(this.config.sx || {}), mode: next };
    try { await this.saveConfig(this.config); }
    catch (e) { this._addLog(`Failed to save: ${e.message}`); }
    const r = await this.sx.setMode(next);
    this._addLog(`sx.org mode: ${this._sxModeLabel(next)}${r.ok ? '' : ` — ${r.error}`}`);
    if (next !== 'off') this._loadSxBalance();
    if (this.running) this.render();
  }

  async _doClearSxKey() {
    this.config.sx = null;
    try { await this.saveConfig(this.config); }
    catch (e) { this._addLog(`Failed to save: ${e.message}`); }
    this.sx.disable();
    this.sxBalance = null;
    this._addLog('sx.org key cleared');
    if (this.running) this.render();
  }

  async _doImport() {
    try {
      this._addLog('Importing credentials...');
      const creds = await importCredentials('~/.claude/.credentials.json');
      const profile = await fetchProfile(creds.accessToken);
      const profileOk = profile && !profile.error;

      if (!profileOk) {
        this._addLog(`Warning: could not fetch profile — ${profile?.error || 'no token'}`);
      }

      let name;
      if (profile?.email) {
        name = profile.email;
        const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
        if (tier) this._addLog(`Detected Claude ${tier}: ${name}`);
      } else {
        const n = this.config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
        name = `account-${n}`;
      }

      const entry = {
        name, type: 'oauth', source: 'import',
        accountUuid: profile?.accountUuid || null,
        orgUuid: profile?.orgUuid || null,
        orgName: profile?.orgName || null,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
      };

      // Deduplicate by account+org identity (same email in a different org is a
      // distinct account), then by name.
      let idx = this.config.accounts.findIndex(a => sameIdentity(a, entry));
      if (idx < 0) idx = this.config.accounts.findIndex(a => a.name === name);

      if (idx >= 0) {
        const prev = this.config.accounts[idx];
        this.config.accounts[idx] = { ...prev, ...entry, name: prev.name };
        // Update the running account manager entry
        const amAcct = this.am.accounts.find(a => sameIdentity(a, entry)) || this.am.accounts[idx];
        if (amAcct) {
          amAcct.credential = creds.accessToken;
          amAcct.refreshToken = creds.refreshToken;
          amAcct.expiresAt = creds.expiresAt;
          amAcct.accountUuid = entry.accountUuid;
          amAcct.orgUuid = entry.orgUuid;
          amAcct.orgName = entry.orgName;
          if (amAcct.status === 'error') amAcct.status = 'active';
        }
        this._addLog(`Updated account "${prev.name}"`);
      } else {
        // New org for this person: disambiguate colliding email names with " (org)".
        if (profile?.accountUuid) {
          const orgLbl = a => a.orgName || (a.orgUuid ? a.orgUuid.slice(0, 8) : 'org');
          const collisions = this.config.accounts.filter(
            a => a.accountUuid === entry.accountUuid && !sameIdentity(a, entry)
          );
          if (collisions.length > 0) {
            for (const c of collisions) {
              if (!c.name.includes(' (')) c.name = `${c.name} (${orgLbl(c)})`;
            }
            entry.name = `${name} (${orgLbl(entry)})`;
          }
        }
        this.config.accounts.push(entry);
        this.am.addAccount(entry);
        this._addLog(`Imported account "${entry.name}"`);
      }

      await this.saveConfig(this.config);
    } catch (e) {
      this._addLog(`Import failed: ${e.message}`);
    }
  }

  async _doAddKey(apiKey) {
    const n = this.config.accounts.filter(a => a.name.startsWith('api-')).length + 1;
    const name = `api-${n}`;
    this.config.accounts.push({ name, type: 'apikey', apiKey });
    this.am.addAccount({ name, type: 'apikey', apiKey });
    await this.saveConfig(this.config);
    this._addLog(`Added API key account "${name}"`);
  }

  async _doRemove(idx) {
    if (idx < 0 || idx >= this.am.accounts.length) return;
    const name = this.am.accounts[idx].name;
    this.am.removeAccount(idx);
    this.config.accounts.splice(idx, 1);
    if (this.selIdx >= this.am.accounts.length) this.selIdx = Math.max(0, this.am.accounts.length - 1);
    await this.saveConfig(this.config);
    this._addLog(`Removed account "${name}"`);
  }

  async _doToggleDisabled(idx) {
    if (idx < 0 || idx >= this.am.accounts.length) return;
    const acct = this.am.accounts[idx];
    const next = !acct.disabled;
    this.am.setDisabled(idx, next); // re-enabling also clears a stuck error state
    // Write an explicit boolean (not delete): saveConfig merges over the on-disk
    // entry, so a `delete` would leave a stale `disabled: true` from disk intact.
    if (this.config.accounts[idx]) this.config.accounts[idx].disabled = next;
    await this.saveConfig(this.config);
    this._addLog(`${next ? 'Disabled' : 'Enabled'} account "${acct.name}"`);
  }

  // ── rendering ──────────────────────────────────────

  render() {
    if (!this.running) return;
    // Guard against re-entry: clearing an expired quota logs, and _addLog calls
    // render() again — without this the nested call would render twice.
    if (this._rendering) return;
    this._rendering = true;
    try {
      this._render();
    } finally {
      this._rendering = false;
    }
  }

  _render() {
    // Reset the display the instant a quota window (e.g. 5-hour session) expires,
    // instead of waiting for the next request to clear it.
    this.am.refreshExpiredQuotas();
    const W = process.stdout.columns || 80;
    const H = process.stdout.rows || 24;

    if (W < 40 || H < 8) {
      process.stdout.write(`${ESC}H${ESC}2JTerminal too small (need 40x8+)\r\n`);
      return;
    }

    const lines = [];

    // ── Header
    const left = bold(' TeamClaude');
    const port = this.config.proxy?.port || 3456;
    const right = `Port ${port} ${green('▲')} `;
    lines.push(left + ' '.repeat(Math.max(1, W - vw(left) - vw(right))) + right);
    lines.push(' ' + dim('─'.repeat(W - 2)));

    const footerH = 2;
    if (this.mode === 'settings') {
      this._renderSettings(lines);
    } else {
    // ── Accounts
    if (this.am.accounts.length === 0) {
      lines.push('');
      lines.push(yellow('  No accounts configured. Press [a] to add one.'));
    } else {
      lines.push('');
      const showBoth = W >= 70;
      const bw = showBoth
        ? Math.max(5, Math.min(20, Math.floor((W - 56) / 2)))
        : Math.max(5, Math.min(20, W - 45));

      for (let i = 0; i < this.am.accounts.length; i++) {
        lines.push(this._renderAcct(i, bw, showBoth));
      }
    }

    // ── Activity header
    lines.push('');
    const ac = this.active.size;
    const acTag = ac > 0 ? `  ${cyan(ac + ' active')}` : '';
    const aHdr = ` Activity${acTag} `;
    lines.push(aHdr + dim('─'.repeat(Math.max(1, W - vw(aHdr)))));

    // Active requests
    const now = Date.now();
    for (const [, r] of this.active) {
      const el = ((now - r.started) / 1000).toFixed(1);
      const sp = cyan(SPINNER[this.frame]);
      const a = r.account ? ` → ${r.account}` : '';
      lines.push(` ${sp} ${gray(r.t)}  ${r.method} ${r.path}${a} ${dim(`(${el}s...)`)}`);
    }

    // Completed log
    const space = Math.max(0, H - lines.length - footerH);
    for (let i = 0; i < space && i < this.log.length; i++) {
      lines.push(`   ${gray(this.log[i].t)}  ${this.log[i].msg}`);
    }
    } // end non-settings body

    // Pad to fill
    while (lines.length < H - footerH) lines.push('');

    // ── Footer
    lines.push(' ' + dim('─'.repeat(W - 2)));
    lines.push(this._renderFooter());

    // Write buffer
    let buf = `${ESC}H`;
    for (let i = 0; i < H; i++) {
      buf += fitLine(lines[i] || '', W);
      if (i < H - 1) buf += '\r\n';
    }
    // Show cursor only in input mode
    buf += this.mode === 'input' ? `${ESC}?25h` : `${ESC}?25l`;
    process.stdout.write(buf);
  }

  _renderAcct(idx, bw, showBoth) {
    const a = this.am.accounts[idx];
    const isCur = idx === this.am.currentIndex;
    const isSel = this.mode === 'select' && idx === this.selIdx;

    // Prefix: selection marker + current marker
    const sel = isSel ? cyan('>') : ' ';
    const cur = isCur ? green('►') : ' ';

    // Name (bold if selected)
    const rawName = a.name.slice(0, 12).padEnd(12);
    const name = isSel ? bold(rawName) : rawName;

    // Type
    const type = gray(a.type.padEnd(7));

    // Status — a disabled account is shown as such regardless of its quota state.
    let status;
    if (a.disabled) {
      status = gray('disabled');
    } else switch (a.status) {
      case 'active':    status = isCur ? green('active') : 'active'; break;
      case 'throttled': status = yellow('throttled'); break;
      case 'exhausted': status = red('exhausted'); break;
      case 'error':     status = red('error'); break;
      default:          status = a.status || 'ready';
    }
    status = rpad(status, 10);

    // Quota ratios — prefer unified (Claude Max), fall back to standard (API key)
    const q = a.quota;
    let r1 = null, r2 = null, l1 = 'Ses', l2 = 'Wk ', t1 = null, t2 = null;

    if (q.unified5h != null || q.unified7d != null || q.unified7dSonnet != null) {
      r1 = q.unified5h;
      r2 = q.unified7d;
      t1 = q.unified5hReset;
      t2 = q.unified7dReset;
    } else {
      l1 = 'Tok';
      l2 = 'Req';
      r1 = (q.tokensLimit != null && q.tokensRemaining != null)
        ? 1 - q.tokensRemaining / q.tokensLimit : null;
      r2 = (q.requestsLimit != null && q.requestsRemaining != null)
        ? 1 - q.requestsRemaining / q.requestsLimit : null;
      t1 = q.resetsAt ? new Date(q.resetsAt).getTime() : null;
      t2 = t1;
    }

    let line = ` ${sel}${cur} ${name} ${type} ${status} ${l1} ${bar(r1, bw, t1)}`;
    if (showBoth) {
      line += `  ${l2} ${bar(r2, bw, t2)}`;
      // Sonnet weekly bar — only shown when the usage probe has populated it.
      if (q.unified7dSonnet != null) {
        line += `  S7  ${bar(q.unified7dSonnet, bw, q.unified7dSonnetReset)}`;
      }
    }
    return line;
  }

  _renderSettings(lines) {
    lines.push('');
    // ── Rotation
    const thr = this.am.switchThreshold ?? this.config.switchThreshold ?? 0.98;
    lines.push(bold('  Rotation') + dim('  — switch accounts when quota crosses the threshold'));
    lines.push(`  Switch at:  ${green(`${Math.round(thr * 100)}%`)}  ${dim('utilization')}`);
    lines.push('');
    // ── Quota probe
    const probe = this.config.quotaProbeSeconds || 0;
    lines.push(bold('  Quota probe') + dim('  — refresh idle accounts from the usage endpoint'));
    lines.push(`  Interval:   ${probe > 0 ? green(`${probe}s`) : gray('off (passive)')}`);
    lines.push('');
    // ── sx.org
    lines.push(bold('  sx.org proxy') + dim('  — route upstream via a residential IP (429 workaround)'));
    lines.push('');
    if (!this.sx) { lines.push(yellow('  Unavailable in this build.')); return; }
    const key = this.config.sx?.apiKey;
    const masked = key ? key.slice(0, 4) + '…' + key.slice(-4) : dim('(not set)');
    const mode = this.sx.getMode();
    const modeStr = mode === 'always' ? green('always')
      : mode === '429' ? cyan('on 429 only')
      : gray('off');
    const p = this.sx.getProxy?.();
    const proxyStr = mode === 'off' ? gray('—')
      : this.sx.isProvisioned() ? green(`${p.host}:${p.port}`)
      : key ? yellow('not provisioned')
      : gray('no key');
    const b = this.sxBalance;
    lines.push(`  Mode:     ${modeStr}`);
    lines.push(`  API key:  ${masked}`);
    lines.push(`  Proxy:    ${proxyStr}`);
    lines.push(`  Balance:  ${b ? green('$' + Number(b.balance).toFixed(4)) : dim('…')}`);
    lines.push('');
    lines.push(dim('  always    tunnel ALL upstream traffic through sx.org'));
    lines.push(dim('  on 429    only retry through sx.org after a 429 (fresh IP)'));
    lines.push(dim('  off       never use sx.org (API key is kept)'));
    lines.push('');
    lines.push(dim('  TLS stays end-to-end; residential traffic is metered by sx.org.'));
  }

  _renderFooter() {
    switch (this.mode) {
      case 'normal':
        return ` ${bold('s')}witch  ${bold('a')}dd  ${bold('r')}emove  ${bold('d')}isable  ${bold('R')}eload  ${bold('g')} settings  ${bold('q')}uit`;
      case 'settings':
        return ` ${bold('t')} threshold  ${bold('p')} probe  ${bold('m')} sx-mode  ${bold('k')} sx-key  ${bold('x')} clear-key  ${bold('Esc')} back`;
      case 'select': {
        const act = this.selAction === 'switch' ? 'switch'
          : this.selAction === 'toggle' ? 'enable/disable'
          : 'remove';
        return ` ${dim('↑↓')} select  ${bold('Enter')} ${act}  ${bold('Esc')} cancel`;
      }
      case 'add':
        return ` ${bold('i')}mport Claude Code  ${bold('k')} API key  ${bold('Esc')} cancel`;
      case 'input':
        return ` ${this.inputPrompt}: ${this.inputBuf}█`;
      default:
        return '';
    }
  }
}
