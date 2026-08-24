// The status dashboard: a single self-contained HTML page served at
// GET /teamclaude/dashboard, rendering /teamclaude/status for humans.
//
// The page itself contains NO data — it is a static asset whose script fetches
// /teamclaude/status (same origin) with the proxy key and re-renders every few
// seconds. That split is what lets the asset be served without the key (a
// browser address bar cannot send x-api-key) while every byte of actual status
// stays behind the existing gate. The key is asked for once and kept in
// localStorage; a 401 (wrong or rotated key) brings the prompt back.
//
// Self-contained on purpose: no external scripts, styles, or fonts, so the
// page works on air-gapped deployments and adds no third-party surface. All
// rendering uses textContent — status fields (account names, client names) are
// operator/OAuth-derived, but they still never reach innerHTML.

export function renderDashboardHtml() {
  return PAGE;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeamClaude</title>
<style>
  :root {
    --bg: #101418; --panel: #171d24; --line: #242c36;
    --text: #d7dde4; --dim: #8a949f; --accent: #53b1fd;
    --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; padding: 24px; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 13px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 24px 0 8px; }
  .sub { color: var(--dim); margin-bottom: 16px; }
  .sub b { color: var(--text); font-weight: 600; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
  .row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .tag { font-size: 12px; color: var(--dim); }
  .badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
  .badge.active { color: var(--ok); border-color: var(--ok); }
  .badge.throttled { color: var(--warn); border-color: var(--warn); }
  .badge.error, .badge.exhausted { color: var(--bad); border-color: var(--bad); }
  .badge.current { color: var(--accent); border-color: var(--accent); }
  .quota { display: grid; grid-template-columns: 64px 1fr 110px; gap: 8px; align-items: center; margin-top: 6px; }
  .quota .lbl { color: var(--dim); font-size: 12px; }
  .quota .val { color: var(--dim); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .bar { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 4px; background: var(--ok); }
  .bar i.warn { background: var(--warn); }
  .bar i.bad { background: var(--bad); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 10px; font-variant-numeric: tabular-nums; }
  th { color: var(--dim); font-size: 12px; font-weight: 500; border-bottom: 1px solid var(--line); }
  td { border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; }
  .usage { color: var(--dim); font-size: 12px; margin-top: 6px; }
  #err { color: var(--bad); margin: 12px 0; display: none; }
  #keybox { display: none; margin: 40px auto; max-width: 420px; text-align: center; }
  #keybox input { width: 100%; padding: 10px 12px; margin: 12px 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; }
  #keybox button { padding: 8px 20px; background: var(--accent); border: 0; border-radius: 6px; color: #06121f; font: inherit; font-weight: 600; cursor: pointer; }
  footer { color: var(--dim); font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
<main>
  <div id="keybox">
    <h1>TeamClaude</h1>
    <p class="sub">Enter your proxy key to view status.</p>
    <input id="key" type="password" placeholder="tc-..." autocomplete="off">
    <br><button id="go">Connect</button>
  </div>
  <div id="app" style="display:none">
    <h1>TeamClaude</h1>
    <p class="sub" id="summary"></p>
    <div id="err"></div>
    <h2>Accounts</h2>
    <div id="accounts"></div>
    <div id="clientsWrap" style="display:none">
      <h2>Clients</h2>
      <div class="card" style="padding:4px 6px"><table id="clients"></table></div>
    </div>
    <footer id="foot"></footer>
  </div>
</main>
<script>
(function () {
  'use strict';
  var KEY = 'teamclaude-dashboard-key';
  var POLL_MS = 5000;
  var timer = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function fmtAgo(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function fmtIn(sec) {
    if (sec == null) return '';
    var s = Math.max(0, Math.round(sec));
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return (s / 3600).toFixed(1) + 'h';
    return (s / 86400).toFixed(1) + 'd';
  }

  function quotaRow(label, ratio, resetIso) {
    var row = el('div', 'quota');
    row.appendChild(el('span', 'lbl', label));
    var bar = el('div', 'bar');
    var fill = el('i');
    var pct = ratio == null ? null : Math.max(0, Math.min(1, Number(ratio)));
    fill.style.width = (pct == null ? 0 : pct * 100) + '%';
    if (pct != null && pct >= 0.9) fill.className = 'bad';
    else if (pct != null && pct >= 0.7) fill.className = 'warn';
    bar.appendChild(fill);
    row.appendChild(bar);
    var resetTs = resetIso ? Date.parse(resetIso) : NaN;
    var reset = !isNaN(resetTs) && resetTs > Date.now() ? ' · ' + fmtIn((resetTs - Date.now()) / 1000) : '';
    row.appendChild(el('span', 'val', (pct == null ? '?' : Math.round(pct * 100) + '%') + reset));
    return row;
  }

  function renderAccount(a, current) {
    var card = el('div', 'card');
    var head = el('div', 'row');
    head.appendChild(el('span', 'name', a.name));
    head.appendChild(el('span', 'tag', a.type + ' · prio ' + (a.priority || 0)));
    if (a.name === current) head.appendChild(el('span', 'badge current', 'current'));
    head.appendChild(el('span', 'badge ' + (a.status || ''), a.disabled ? 'disabled' : (a.status || 'unknown')));
    if (a.sessions) head.appendChild(el('span', 'tag', a.sessions + ' active session' + (a.sessions > 1 ? 's' : '')));
    card.appendChild(head);
    var q = a.quota || {};
    if (q.unified5h != null || q.unified7d != null) {
      card.appendChild(quotaRow('Session', q.unified5h, q.unified5hReset));
      card.appendChild(quotaRow('Weekly', q.unified7d, q.unified7dReset));
      if (q.unified7dSonnet != null) card.appendChild(quotaRow('Sonnet', q.unified7dSonnet, q.unified7dSonnetReset));
      if (q.unified7dFable != null) card.appendChild(quotaRow('Fable', q.unified7dFable, q.unified7dFableReset));
    } else if (q.tokensLimit != null && q.tokensRemaining != null) {
      card.appendChild(quotaRow('Tokens', 1 - q.tokensRemaining / q.tokensLimit, q.resetsAt));
    } else {
      card.appendChild(el('div', 'usage', 'quota unknown (no traffic observed yet)'));
    }
    var u = a.usage || {};
    var tok = (u.totalInputTokens || 0) + (u.totalOutputTokens || 0);
    var last = u.lastUsed ? ' · last ' + fmtAgo(u.lastUsed) : '';
    card.appendChild(el('div', 'usage', (u.totalRequests || 0) + ' req · ' + fmtNum(tok) + ' tok' + last));
    return card;
  }

  function renderClients(clients) {
    var wrap = document.getElementById('clientsWrap');
    var names = Object.keys(clients || {});
    if (!names.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    names.sort(function (a, b) {
      var ca = clients[a], cb = clients[b];
      return ((cb.inputTokens || 0) + (cb.outputTokens || 0)) - ((ca.inputTokens || 0) + (ca.outputTokens || 0));
    });
    var table = document.getElementById('clients');
    table.textContent = '';
    var hr = el('tr');
    ['Client', 'Requests', 'Input tok', 'Output tok', 'Last used'].forEach(function (h, i) {
      hr.appendChild(el('th', i ? 'num' : '', h));
    });
    table.appendChild(hr);
    names.forEach(function (n) {
      var c = clients[n];
      var tr = el('tr');
      tr.appendChild(el('td', '', n));
      tr.appendChild(el('td', 'num', fmtNum(c.requests)));
      tr.appendChild(el('td', 'num', fmtNum(c.inputTokens)));
      tr.appendChild(el('td', 'num', fmtNum(c.outputTokens)));
      tr.appendChild(el('td', 'num', c.lastUsed ? fmtAgo(c.lastUsed) : '—'));
      table.appendChild(tr);
    });
  }

  function render(s) {
    var sess = s.sessions || {};
    var up = s.server && s.server.uptimeSeconds != null ? 'up ' + fmtIn(s.server.uptimeSeconds) : '';
    var sum = document.getElementById('summary');
    sum.textContent = '';
    sum.appendChild(el('span', '', 'active account '));
    sum.appendChild(el('b', '', s.currentAccount || 'none'));
    sum.appendChild(el('span', '', ' · ' + (sess.active || 0) + ' active / ' + (sess.known || 0) + ' known sessions' + (up ? ' · ' + up : '')));
    var acc = document.getElementById('accounts');
    acc.textContent = '';
    (s.accounts || []).forEach(function (a) { acc.appendChild(renderAccount(a, s.currentAccount)); });
    renderClients(s.clients);
    document.getElementById('foot').textContent = 'refreshes every ' + (POLL_MS / 1000) + 's · ' + new Date().toLocaleTimeString();
  }

  function showKeybox() {
    if (timer) { clearInterval(timer); timer = null; }
    document.getElementById('app').style.display = 'none';
    document.getElementById('keybox').style.display = 'block';
    document.getElementById('key').focus();
  }

  function poll() {
    fetch('/teamclaude/status', { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (s) {
        if (!s) return;
        document.getElementById('keybox').style.display = 'none';
        document.getElementById('app').style.display = '';
        document.getElementById('err').style.display = 'none';
        render(s);
      })
      .catch(function (e) {
        var err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = 'Cannot reach the proxy: ' + e.message;
      });
  }

  function start() {
    poll();
    if (!timer) timer = setInterval(poll, POLL_MS);
  }

  document.getElementById('go').addEventListener('click', function () {
    var v = document.getElementById('key').value.trim();
    if (!v) return;
    localStorage.setItem(KEY, v);
    start();
  });
  document.getElementById('key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('go').click();
  });

  if (localStorage.getItem(KEY)) start(); else showKeybox();
})();
</script>
</body>
</html>
`;
