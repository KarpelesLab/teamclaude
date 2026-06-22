#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import net from 'node:net';
import { loadOrCreateConfig, loadConfig, saveConfig, atomicConfigUpdate, getConfigPath, loadState, saveState } from './config.js';
import { AccountManager } from './account-manager.js';
import { createProxyServer } from './server.js';
import { importCredentials, loginOAuth, fetchProfile, refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import { sameIdentity, orgKey, matchAccounts } from './identity.js';
import * as alias from './alias.js';
import { ensureCerts } from './mitm.js';
import { Prober } from './prober.js';
import { TUI } from './tui.js';
import { SxManager } from './sx.js';

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'server':
    await serverCommand();
    break;
  case 'run':
    await runCommand();
    break;
  case 'import':
    await importCommand();
    process.exit(0);
    break;
  case 'login':
    await loginCommand();
    process.exit(0);
    break;
  case 'env':
    await envCommand();
    process.exit(0);
    break;
  case 'status':
    await statusCommand();
    process.exit(0);
    break;
  case 'accounts':
    await accountsCommand();
    process.exit(0);
    break;
  case 'remove':
    await removeCommand();
    process.exit(0);
    break;
  case 'priority':
    await priorityCommand();
    process.exit(0);
    break;
  case 'disable':
    await setDisabledCommand(true);
    process.exit(0);
    break;
  case 'enable':
    await setDisabledCommand(false);
    process.exit(0);
    break;
  case 'api':
    await apiCommand();
    process.exit(0);
    break;
  case 'alias':
    aliasCommand();
    process.exit(0);
    break;
  case 'probe':
    await probeCommand();
    process.exit(0);
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    // No command or unknown command → start server
    if (command && !command.startsWith('-')) {
      console.error(`Unknown command: ${command}\n`);
      showHelp();
      process.exit(1);
    }
    await serverCommand();
    break;
}

// ── server ──────────────────────────────────────────────────

async function serverCommand() {
  const config = await loadOrCreateConfig();

  // --log-to <dir>
  const logTo = argValue('--log-to');
  if (logTo) config.logDir = logTo;

  if (config.accounts.length === 0) {
    console.error('No accounts configured.\n');
    console.error('Add an account first:');
    console.error('  teamclaude import           Import from Claude Code');
    console.error('  teamclaude login            OAuth login via browser');
    console.error('  teamclaude login --api      Add an API key');
    process.exit(1);
  }

  const accounts = await resolveAccounts(config);
  if (accounts.length === 0) {
    console.error('No valid accounts after initialization');
    process.exit(1);
  }

  const threshold = config.switchThreshold || 0.98;
  const accountManager = new AccountManager(accounts, threshold);

  // Restore quota observed in a previous run so a restart doesn't lose rotation
  // state (passive — we never call the API to re-learn it). Stale windows are
  // cleared automatically on first use by _clearExpiredQuotas.
  const savedState = await loadState().catch(err => {
    console.error(`[TeamClaude] Could not read saved state: ${err.message}`);
    return null;
  });
  if (savedState?.quota) accountManager.restoreQuotaState(savedState.quota);

  // With quota restored, pick the best account up front (highest priority /
  // soonest-resetting weekly window) instead of defaulting to the first one.
  accountManager.selectActiveAccount();

  // Periodically persist quota (and once more on shutdown) to the state file.
  const persistQuotaState = () =>
    saveState({ quota: accountManager.exportQuotaState() })
      .catch(err => console.error(`[TeamClaude] Failed to save quota state: ${err.message}`));
  let quotaSaveInterval = null;

  // Persist refreshed tokens back to config (re-read from disk to avoid clobbering
  // accounts added externally, e.g. by `teamclaude import` while server is running)
  accountManager.onTokenRefresh((idx, newTokens) => {
    const account = accountManager.accounts[idx];
    if (!account) return;
    // Keep config.accounts in sync so TUI saveConfig doesn't clobber fresh tokens
    if (config.accounts[idx]) {
      config.accounts[idx].accessToken = newTokens.accessToken;
      config.accounts[idx].refreshToken = newTokens.refreshToken;
      config.accounts[idx].expiresAt = newTokens.expiresAt;
    }
    atomicConfigUpdate(diskConfig => {
      // Pick up any new accounts from disk so index matching stays correct
      // (only add, don't refresh credentials — we're about to write the authoritative tokens)
      for (const diskAcct of diskConfig.accounts) {
        const known = config.accounts.some(a => sameIdentity(a, diskAcct));
        if (!known) {
          config.accounts.push(diskAcct);
          accountManager.addAccount(diskAcct);
        }
      }
      // Match by UUID first, then by name — index may have shifted
      const cfgIdx = findConfigAccount(diskConfig, account);
      if (cfgIdx >= 0) {
        diskConfig.accounts[cfgIdx].accessToken = newTokens.accessToken;
        diskConfig.accounts[cfgIdx].refreshToken = newTokens.refreshToken;
        diskConfig.accounts[cfgIdx].expiresAt = newTokens.expiresAt;
      }
    }).catch(err => console.error(`[TeamClaude] Failed to save refreshed token: ${err.message}`));
  });
  const port = config.proxy.port;
  const headless = args.includes('--headless') || args.includes('--no-tui');
  const useTUI = !headless && process.stdout.isTTY && process.stdin.isTTY;

  // Opt-in background quota probe (config.quotaProbeSeconds, default 0 = off).
  let prober = null;

  // sx.org proxy (IP-based-429 workaround). Dormant unless an API key is set in
  // config.sx.apiKey; when set we provision a proxy and route upstream through it.
  const sx = new SxManager({ log: console.error });
  if (config.sx?.apiKey) {
    const r = await sx.configure(config.sx.apiKey, config.sx.mode);
    if (!r.ok) console.error(`[TeamClaude] sx.org disabled: ${r.error}`);
  } else if (config.sx?.mode) {
    await sx.setMode(config.sx.mode);
  }

  // Re-sync accounts from disk without a restart. The TUI's 'R' key, the
  // POST /teamclaude/reload endpoint, and the CLI notify after add/change all
  // funnel through here. Returns the number of newly added accounts. Also picks
  // up a changed probe interval so `teamclaude probe` applies live.
  const reloadAccounts = async () => {
    const diskConfig = await loadConfig();
    if (!diskConfig) return 0;
    const added = await syncAccountsFromDisk(diskConfig, config, accountManager);
    // Apply an sx.org key/mode change made on disk (e.g. via POST /teamclaude/reload).
    const diskSxKey = diskConfig.sx?.apiKey || null;
    const diskSxMode = diskConfig.sx?.mode || 'always';
    if (diskSxKey !== sx.apiKey || diskSxMode !== sx.mode) {
      config.sx = diskConfig.sx;
      if (diskSxKey) await sx.configure(diskSxKey, diskSxMode);
      else { sx.disable(); await sx.setMode(diskSxMode); }
    }
    if (prober) {
      const ms = (diskConfig.quotaProbeSeconds || 0) * 1000;
      if (ms !== prober.intervalMs) {
        config.quotaProbeSeconds = diskConfig.quotaProbeSeconds || 0;
        prober.reschedule(ms);
      }
    }
    return added;
  };

  let tui = null;
  let hooks = {};

  if (useTUI) {
    tui = new TUI({
      accountManager, config, sx,
      saveConfig: () => atomicConfigUpdate(async diskConfig => {
        // Write in-memory accounts as the authoritative state, preserving
        // extra disk-only fields (e.g. importFrom) where the account still exists.
        // Use live tokens from AccountManager (not the stale config.accounts copy).
        diskConfig.accounts = config.accounts.map((a, i) => {
          const am = accountManager.accounts[i];
          const live = am ? {
            ...a,
            accessToken: am.credential,
            refreshToken: am.refreshToken,
            expiresAt: am.expiresAt,
          } : a;
          const diskAcct = diskConfig.accounts.find(d => sameIdentity(d, a));
          return diskAcct ? { ...diskAcct, ...live } : live;
        });
        // Persist sx.org settings (set/cleared from the TUI settings screen).
        if (config.sx) diskConfig.sx = config.sx; else delete diskConfig.sx;
        // Persist other runtime-tunable settings edited from the TUI.
        if (config.switchThreshold != null) diskConfig.switchThreshold = config.switchThreshold;
        if (config.quotaProbeSeconds != null) diskConfig.quotaProbeSeconds = config.quotaProbeSeconds;
      }),
      syncAccounts: reloadAccounts,
      onQuit: async () => {
        prober?.stop();
        if (quotaSaveInterval) clearInterval(quotaSaveInterval);
        await persistQuotaState();
        server.close(() => process.exit(0));
      },
    });
    hooks = {
      onRequestStart: (id, info) => tui.onRequestStart(id, info),
      onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
      onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
    };
  }

  // Expose reload to the proxy's control endpoint (works with or without TUI).
  hooks.reload = reloadAccounts;

  const server = createProxyServer(accountManager, config, hooks, sx);
  // Catch bind-time errors (e.g. EADDRINUSE) only. Once the socket is bound we
  // remove this handler so a later runtime 'error' isn't misreported as a
  // listen failure and exit the whole proxy.
  const onListenError = err => handleServerListenError(err, port);
  server.once('error', onListenError);

  server.listen(port, () => {
    // Bind succeeded: stop treating errors as listen failures, but keep a
    // benign runtime handler so a later 'error' is logged rather than thrown.
    server.removeListener('error', onListenError);
    server.on('error', err => console.error(`[TeamClaude] Server error: ${err.message}`));
    if (tui) {
      tui.start();
      console.log(`Listening on port ${port} with ${accounts.length} account(s)`);
    } else {
      const sep = '='.repeat(60);
      console.log('');
      console.log(sep);
      console.log('  TeamClaude Proxy');
      console.log(sep);
      console.log(`  Port:       ${port}`);
      console.log(`  Accounts:   ${accounts.length}`);
      console.log(`  Threshold:  ${(threshold * 100).toFixed(0)}%`);
      console.log(`  Upstream:   ${config.upstream || 'https://api.anthropic.com'}`);
      console.log('');
      accounts.forEach((a, i) => {
        console.log(`  [${i + 1}] ${a.name} (${a.type})`);
      });
      console.log('');
      console.log('  Run Claude through proxy:  teamclaude run');
      console.log('  Show env vars:             teamclaude env');
      console.log(sep);
      console.log('');
    }
  });

  // Persist quota every minute; unref so it never keeps the process alive.
  quotaSaveInterval = setInterval(persistQuotaState, 60_000);
  quotaSaveInterval.unref?.();

  // Start the opt-in quota probe (no-op when quotaProbeSeconds is 0).
  prober = new Prober(accountManager, { intervalMs: (config.quotaProbeSeconds || 0) * 1000 });
  prober.start();

  if (!tui) {
    const shutdown = async () => {
      console.log('\n[TeamClaude] Shutting down...');
      prober?.stop();
      clearInterval(quotaSaveInterval);
      await persistQuotaState();
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

// ── import ──────────────────────────────────────────────────

async function importCommand() {
  const config = await loadOrCreateConfig();

  let name = argValue('--name');
  const jsonStr = argValue('--json');

  let creds;
  if (jsonStr) {
    // Accept raw JSON: --json '{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}'
    // or flat: --json '{"accessToken":"...","refreshToken":"...","expiresAt":...}'
    try {
      const raw = JSON.parse(jsonStr);
      const data = raw.claudeAiOauth || raw;
      if (!data.accessToken) {
        console.error('JSON must contain "accessToken" (directly or under "claudeAiOauth")');
        process.exit(1);
      }
      creds = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt,
      };
    } catch (err) {
      console.error(`Failed to parse --json: ${err.message}`);
      process.exit(1);
    }
  } else {
    const fromPath = argValue('--from') || '~/.claude/.credentials.json';
    try {
      creds = await importCredentials(fromPath);
    } catch (err) {
      console.error(`Failed to import from ${fromPath}: ${err.message}`);
      process.exit(1);
    }
  }

  await upsertOAuthAccount(config, name, creds, 'import');
}

// ── login ───────────────────────────────────────────────────

async function loginCommand() {
  if (args.includes('--api')) {
    await loginApiCommand();
    return;
  }
  if (args.includes('--oauth')) {
    await loginOAuthCommand();
    return;
  }

  // Default to OAuth if not a TTY
  if (!process.stdout.isTTY) {
    await loginOAuthCommand();
    return;
  }

  // Interactive menu
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  console.log('Select login method:\n');
  console.log('  1. Claude subscription  (Pro, Max, Team, Enterprise)');
  console.log('  2. Anthropic API key    (Console API billing)');
  console.log('');
  const choice = await new Promise(resolve => rl.question('Choice [1]: ', resolve));
  rl.close();

  switch (choice.trim() || '1') {
    case '1': await loginOAuthCommand(); break;
    case '2': await loginApiCommand(); break;
    default:
      console.error(`Invalid choice: ${choice.trim()}`);
      process.exit(1);
  }
}

async function loginApiCommand() {
  const config = await loadOrCreateConfig();
  let name = argValue('--name');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const apiKey = await new Promise(resolve => rl.question('Anthropic API key: ', resolve));
  rl.close();

  if (!apiKey.trim()) {
    console.error('No API key provided');
    process.exit(1);
  }

  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('api-')).length + 1;
    name = `api-${n}`;
  }

  config.accounts.push({ name, type: 'apikey', apiKey: apiKey.trim() });
  await saveConfig(config);
  console.log(`Added API key account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
}

async function loginOAuthCommand() {
  const config = await loadOrCreateConfig();
  let name = argValue('--name');

  console.log('Starting OAuth login...');
  let creds;
  try {
    creds = await loginOAuth();
  } catch (err) {
    console.error(`OAuth login failed: ${err.message}`);
    console.error('');
    console.error('Alternatives:');
    console.error('  teamclaude import        Import from existing Claude Code credentials');
    console.error('  teamclaude login --api   Add an API key instead');
    process.exit(1);
  }

  await upsertOAuthAccount(config, name, creds, 'login');
}

// ── env ─────────────────────────────────────────────────────

async function envCommand() {
  const config = await loadOrCreateConfig();
  console.log(`export ANTHROPIC_BASE_URL=http://localhost:${config.proxy.port}`);
  console.log(`export ANTHROPIC_API_KEY=${config.proxy.apiKey}`);
}

// ── run ─────────────────────────────────────────────────────

async function runCommand() {
  const config = await loadOrCreateConfig();

  // Args after 'run'. teamclaude flags (e.g. --mitm) are recognized only before
  // an optional `--` separator; everything after `--` goes verbatim to claude.
  const rest = args.slice(1);
  const sep = rest.indexOf('--');
  const tcFlags = sep >= 0 ? rest.slice(0, sep) : rest;
  const useMitm = tcFlags.includes('--mitm');
  const claudeArgs = sep >= 0 ? rest.slice(sep + 1) : rest.filter(a => a !== '--mitm');

  // Route through the proxy only when it's actually up; otherwise launch claude
  // directly so a stopped proxy doesn't break `claude`. This is what lets the
  // shell alias (`claude='teamclaude run --'`) be a dumb passthrough.
  const port = config.proxy.port;
  const env = { ...process.env };
  if (await isProxyUp(port)) {
    if (useMitm) {
      // Route ALL of claude's traffic through us as an HTTPS forward proxy, so
      // even hardcoded api.anthropic.com endpoints (e.g. the design MCP) get the
      // real token injected. claude trusts our MITM leaf via NODE_EXTRA_CA_CERTS.
      const host = upstreamHost(config);
      const { caPath } = await ensureCerts(host);
      const proxyUrl = `http://127.0.0.1:${port}`;
      env.HTTPS_PROXY = env.HTTP_PROXY = env.https_proxy = env.http_proxy = proxyUrl;
      env.NO_PROXY = env.no_proxy = ''; // ensure nothing (esp. the upstream host) bypasses us
      env.NODE_EXTRA_CA_CERTS = caPath;
      delete env.ANTHROPIC_BASE_URL;
    } else {
      // Only set ANTHROPIC_BASE_URL — Claude Code keeps its own OAuth token
      // which the proxy accepts from localhost. Not setting ANTHROPIC_API_KEY
      // lets Claude Code stay in subscription mode (full model access).
      env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
    }
  } else {
    console.error(`[TeamClaude] Proxy not running on port ${port} — launching claude directly (start it with: teamclaude server)`);
  }

  // Use spawnSync so the Node process blocks entirely — behaves like execvp.
  const result = spawnSync('claude', claudeArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('Claude Code not found in PATH. Install it first.');
    } else {
      console.error(`Failed to start claude: ${result.error.message}`);
    }
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

// ── status ──────────────────────────────────────────────────

async function statusCommand() {
  const config = await loadOrCreateConfig();
  const url = `http://localhost:${config.proxy.port}/teamclaude/status`;

  try {
    const res = await fetch(url, { headers: { 'x-api-key': config.proxy.apiKey } });
    const data = await res.json();

    console.log(`Active account: ${data.currentAccount}`);
    console.log(`Switch at:      ${(data.switchThreshold * 100).toFixed(0)}% usage\n`);

    for (const acct of data.accounts) {
      const q = acct.quota;
      const current = acct.name === data.currentAccount ? ' *' : '';

      console.log(`  ${acct.name} (${acct.type})${current}`);
      console.log(`    Status:   ${acct.status}${acct.disabled ? ' (disabled)' : ''}`);

      if (q.unified5h != null || q.unified7d != null || q.unified7dSonnet != null) {
        const ses = q.unified5h != null ? (q.unified5h * 100).toFixed(1) + '%' : '-';
        const wk = q.unified7d != null ? (q.unified7d * 100).toFixed(1) + '%' : '-';
        let line = `    Session:  ${ses} used    Weekly: ${wk} used`;
        if (q.unified7dSonnet != null) line += `    Sonnet7d: ${(q.unified7dSonnet * 100).toFixed(1)}% used`;
        console.log(line);
      } else {
        const tok = q.tokensLimit ? ((1 - q.tokensRemaining / q.tokensLimit) * 100).toFixed(1) + '%' : '-';
        const req = q.requestsLimit ? ((1 - q.requestsRemaining / q.requestsLimit) * 100).toFixed(1) + '%' : '-';
        console.log(`    Tokens:   ${tok} used    Requests: ${req} used`);
      }

      console.log(`    Total:    ${acct.usage.totalInputTokens + acct.usage.totalOutputTokens} tokens, ${acct.usage.totalRequests} requests`);
      if (acct.rateLimitedUntil) console.log(`    Throttled until: ${acct.rateLimitedUntil}`);
      console.log('');
    }
  } catch {
    console.error(`Cannot connect to proxy at localhost:${config.proxy.port}`);
    console.error('Is the server running? Start with: teamclaude server');
    process.exit(1);
  }
}

// ── accounts ────────────────────────────────────────────────

async function accountsCommand() {
  const config = await loadOrCreateConfig();
  const verbose = args.includes('-v') || args.includes('--verbose');

  if (config.accounts.length === 0) {
    console.log('No accounts configured.');
    console.log('Add one with: teamclaude import, teamclaude login, or teamclaude login --api');
    return;
  }

  // Refresh expired tokens before fetching profiles
  let configDirty = false;
  await Promise.all(config.accounts.map(async (a) => {
    if (a.type !== 'oauth' || !a.refreshToken) return;
    if (!isTokenExpiringSoon(a.expiresAt)) return;
    try {
      const newTokens = await refreshAccessToken(a.refreshToken);
      a.accessToken = newTokens.accessToken;
      a.refreshToken = newTokens.refreshToken;
      a.expiresAt = newTokens.expiresAt;
      configDirty = true;
    } catch (err) {
      // refresh failed — fetchProfile will report the specific error
    }
  }));
  if (configDirty) await saveConfig(config);

  // Fetch profiles in parallel for all OAuth accounts
  const profiles = await Promise.all(
    config.accounts.map(a =>
      a.type === 'oauth' && a.accessToken ? fetchProfile(a.accessToken) : null
    )
  );

  // Backfill account+org identity from profiles, then deduplicate by
  // (accountUuid, org): the same person in a different org is a distinct
  // account, not a duplicate. Keep the last (most recently added) entry.
  const seen = new Map();
  let removed = 0;
  let touched = false;
  for (let i = config.accounts.length - 1; i >= 0; i--) {
    const a = config.accounts[i];
    const p = profiles[i];
    if (p && !p.error) {
      if (p.accountUuid && a.accountUuid !== p.accountUuid) { a.accountUuid = p.accountUuid; touched = true; }
      if (p.orgUuid && a.orgUuid !== p.orgUuid) { a.orgUuid = p.orgUuid; touched = true; }
      if (p.orgName && a.orgName !== p.orgName) { a.orgName = p.orgName; touched = true; }
    }
    const uuid = a.accountUuid;
    if (!uuid) continue;
    const key = `${uuid}::${orgKey(a) || ''}`;
    if (seen.has(key)) {
      config.accounts.splice(i, 1);
      profiles.splice(i, 1);
      removed++;
      touched = true;
    } else {
      seen.set(key, i);
    }
  }

  // Name accounts from their email: plain when the person has a single org,
  // "email (Org)" when the same person spans multiple orgs. Names must stay
  // unique — they are the user-facing key for remove/api/selection.
  const orgCount = new Map();
  for (const a of config.accounts) {
    if (a.accountUuid) orgCount.set(a.accountUuid, (orgCount.get(a.accountUuid) || 0) + 1);
  }
  for (const [i, a] of config.accounts.entries()) {
    const p = profiles[i];
    const email = (p && !p.error && p.email) ? p.email : null;
    if (!email) continue;
    const newName = orgCount.get(a.accountUuid) > 1 ? `${email} (${orgLabel(a)})` : email;
    if (a.name !== newName) { a.name = newName; touched = true; }
  }

  if (touched) await saveConfig(config);
  if (removed > 0) console.log(`Removed ${removed} duplicate account(s)\n`);

  for (const [i, a] of config.accounts.entries()) {
    const p = profiles[i];

    if (a.type === 'apikey') {
      console.log(`  [${i + 1}] ${a.name} (apikey)  ${a.apiKey?.slice(0, 15)}...`);
      continue;
    }

    // OAuth account
    const hasProfile = p && !p.error;
    const tier = hasProfile ? (p.hasClaudeMax ? 'Max' : p.hasClaudePro ? 'Pro' : 'subscription') : null;
    const status = hasProfile ? `Claude ${tier}` : `unknown (${p?.error || 'no token'})`;
    const src = a.source ? `, ${a.source}` : '';
    console.log(`  [${i + 1}] ${a.name} (${status}${src})`);
    if (hasProfile && p.email && p.email !== a.name) console.log(`       Email: ${p.email}`);
    if (hasProfile && p.orgName) console.log(`       Org:   ${p.orgName}`);
    if (verbose && a.expiresAt) {
      const remaining = a.expiresAt - Date.now();
      if (remaining <= 0) {
        console.log(`       Token: expired`);
      } else {
        const mins = Math.floor(remaining / 60000);
        const hrs = Math.floor(mins / 60);
        const expiry = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
        console.log(`       Token: expires in ${expiry}`);
      }
    }
  }
}

// ── api ─────────────────────────────────────────────────────

async function apiCommand() {
  const config = await loadOrCreateConfig();
  const path = args[1];

  if (!path) {
    console.error('Usage: teamclaude api <path> [--account NAME] [--method POST] [--data JSON]');
    console.error('Example: teamclaude api /api/oauth/claude_cli/roles');
    process.exit(1);
  }

  // Find account to use
  const accountName = argValue('--account');
  const method = (argValue('--method') || 'GET').toUpperCase();
  const data = argValue('--data');

  const accounts = await resolveAccounts(config);
  let account;
  if (accountName) {
    account = resolveAccount(accounts, accountName, argValue('--org'));
    if (!account) { console.error(`Account "${accountName}" not found`); process.exit(1); }
  } else {
    account = accounts.find(a => a.type === 'oauth') || accounts[0];
    if (!account) { console.error('No accounts configured'); process.exit(1); }
  }

  const credential = account.accessToken || account.apiKey;
  const isOAuth = account.type === 'oauth';
  const upstream = config.upstream || 'https://api.anthropic.com';
  const url = path.startsWith('http') ? path : `${upstream}${path}`;

  const headers = isOAuth
    ? { 'Authorization': `Bearer ${credential}` }
    : { 'x-api-key': credential };

  const fetchOpts = { method, headers };
  if (data) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = data;
  }

  const res = await fetch(url, fetchOpts);

  // Print response headers to stderr
  console.error(`${res.status} ${res.statusText}`);
  for (const [k, v] of res.headers.entries()) {
    console.error(`  ${k}: ${v}`);
  }
  console.error('');

  // Print body to stdout
  const body = await res.text();
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body);
  }
}

// ── alias ───────────────────────────────────────────────────

function aliasCommand() {
  const shell = argValue('--shell') || undefined;
  if (args.includes('--uninstall')) {
    alias.uninstallAlias({ shell });
  } else if (args.includes('--install')) {
    alias.installAlias({ shell });
  } else {
    alias.printAlias({ shell });
  }
}

// ── probe ───────────────────────────────────────────────────

async function probeCommand() {
  const config = await loadOrCreateConfig();
  const arg = args[1];

  if (arg === undefined) {
    const cur = config.quotaProbeSeconds || 0;
    console.log(cur > 0 ? `Quota probe: every ${cur}s` : 'Quota probe: off (passive only)');
    console.log('Set with: teamclaude probe <off|seconds>   e.g. teamclaude probe 300');
    return;
  }

  let seconds;
  if (arg === 'off' || arg === '0') {
    seconds = 0;
  } else {
    seconds = parseInt(arg, 10);
    if (Number.isNaN(seconds) || seconds < 0) {
      console.error('Usage: teamclaude probe <off|seconds>');
      process.exit(1);
    }
    if (seconds > 0 && seconds < 30) {
      console.error('Minimum probe interval is 30s (to avoid hammering the usage endpoint).');
      process.exit(1);
    }
  }

  config.quotaProbeSeconds = seconds;
  await saveConfig(config);
  console.log(seconds > 0
    ? `Quota probe set to every ${seconds}s (reads /api/oauth/usage; does not spend quota).`
    : 'Quota probe disabled (passive only).');
  await notifyRunningServer(config);
}

// ── remove ──────────────────────────────────────────────────

/**
 * Resolve a single account from a name-or-email query.
 *
 * An exact display-name match wins. Otherwise match by email (the part before a
 * " (org)" suffix), optionally narrowed by --org. If still ambiguous across
 * orgs, print the candidates and exit so the caller can disambiguate with --org.
 * Returns the matched account, or null if nothing matched.
 */
function resolveAccount(accounts, query, orgFilter) {
  const matches = matchAccounts(accounts, query, orgFilter);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return null;
  console.error(`"${query}" matches ${matches.length} accounts — disambiguate with --org <name|uuid>:`);
  for (const a of matches) {
    console.error(`  - ${a.name}${a.orgName ? `  (org: ${a.orgName})` : ''}`);
  }
  process.exit(1);
}

async function removeCommand() {
  const config = await loadOrCreateConfig();
  const name = args[1];

  if (!name) {
    console.error('Usage: teamclaude remove <account-name|email> [--org <name|uuid>]');
    process.exit(1);
  }

  const account = resolveAccount(config.accounts, name, argValue('--org'));
  if (!account) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }

  config.accounts.splice(config.accounts.indexOf(account), 1);
  await saveConfig(config);
  console.log(`Removed account "${account.name}"`);
}

// ── priority ────────────────────────────────────────────────

async function priorityCommand() {
  const config = await loadOrCreateConfig();
  const name = args[1];

  if (!name) {
    console.error('Usage: teamclaude priority <account-name|email> <n> [--org <name|uuid>]');
    console.error('       teamclaude priority <account-name|email> --first | --last');
    console.error('Lower priority is preferred for rotation (default 0).');
    process.exit(1);
  }

  const account = resolveAccount(config.accounts, name, argValue('--org'));
  if (!account) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }

  const priorities = config.accounts.map(a => a.priority || 0);
  let priority;
  if (args.includes('--first')) {
    priority = Math.min(0, ...priorities) - 1;
  } else if (args.includes('--last')) {
    priority = Math.max(0, ...priorities) + 1;
  } else {
    // Accept the integer in any position (e.g. after --org) — first int-looking token.
    const numTok = args.slice(2).find(t => /^-?\d+$/.test(t));
    priority = numTok != null ? parseInt(numTok, 10) : NaN;
    if (Number.isNaN(priority)) {
      console.error('Provide an integer priority, or --first / --last.');
      process.exit(1);
    }
  }

  account.priority = priority;
  await saveConfig(config);
  console.log(`Set priority of "${account.name}" to ${priority} (lower = preferred)`);
  await notifyRunningServer(config);
}

// ── enable / disable ────────────────────────────────────────

async function setDisabledCommand(disabled) {
  const config = await loadOrCreateConfig();
  const name = args[1];
  const verb = disabled ? 'disable' : 'enable';

  if (!name) {
    console.error(`Usage: teamclaude ${verb} <account-name|email> [--org <name|uuid>]`);
    process.exit(1);
  }

  const account = resolveAccount(config.accounts, name, argValue('--org'));
  if (!account) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }

  if (disabled) {
    account.disabled = true;
  } else {
    delete account.disabled;
  }
  await saveConfig(config);
  console.log(`${disabled ? 'Disabled' : 'Enabled'} account "${account.name}"`);
  await notifyRunningServer(config);
}

// ── help ────────────────────────────────────────────────────

function showHelp() {
  console.log(`TeamClaude - Multi-account Claude proxy

Usage: teamclaude [command] [options]

Commands:
  server              Start the proxy server (default; --headless to skip the TUI)
  import              Import credentials from Claude Code
  login               OAuth login via browser
  login --api         Add an API key account
  env                 Print env vars to use with Claude
  run [--mitm] [-- args...]
                      Run Claude Code through the proxy (direct if it's down);
                      --mitm routes via an HTTPS forward proxy + local CA so even
                      hardcoded api.anthropic.com endpoints are intercepted
  alias               Print a shell alias so plain 'claude' routes via the proxy
                      (--install to write it to your shell rc; --uninstall to remove)
  status              Show proxy & account status (live)
  accounts            List configured accounts
  remove <name>       Remove an account (by name or email; --org to disambiguate)
  disable <name>      Temporarily exclude an account from rotation
  enable <name>       Re-enable a disabled account (also clears a stuck error)
  priority <name> <n> Set rotation priority (lower = preferred; --first/--last)
  probe [off|secs]    Opt-in background quota refresh for idle accounts
                      (off by default; reads usage endpoint, spends no quota)
  api <path>          Call an API endpoint with account credentials
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --org NAME|UUID     Disambiguate when an email spans multiple orgs (remove/priority/api)
  --from PATH         Credentials path (import, default: ~/.claude/.credentials.json)
  --json JSON         Import from inline JSON (import), e.g.:
                      --json '{"accessToken":"...","refreshToken":"...","expiresAt":1234}'
  --log-to DIR        Log full requests/responses to DIR (server, one file per request)
  --headless          Run the server without the interactive TUI (for backgrounding)
  --mitm              (run) route claude via the HTTPS forward proxy + local CA

The server always accepts both base-URL and proxy/CONNECT clients, so instances
launched with and without --mitm can share one server.

A running server re-syncs accounts from config on POST /teamclaude/reload
(local only). add/login/enable/disable/priority trigger it automatically.

Config: ${getConfigPath()}
`);
}

// ── shared account upsert ────────────────────────────────────

/** Short human label for an account's organization, for disambiguating names. */
function orgLabel(a) {
  return a.orgName || (a.orgUuid ? a.orgUuid.slice(0, 8) : 'org');
}

async function upsertOAuthAccount(config, name, creds, source = 'unknown') {
  // Fetch profile to auto-name and deduplicate by account+org identity.
  const userNamed = !!name;
  const profile = await fetchProfile(creds.accessToken);
  const profileOk = profile && !profile.error;

  if (!profileOk) {
    console.error(`Warning: could not fetch account profile — ${profile?.error || 'no token'}`);
  }
  if (!name && profile?.email) {
    name = profile.email;
    const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
    if (tier) console.log(`Detected Claude ${tier} account: ${profile.email}`);
  }
  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
    name = `account-${n}`;
  }

  const account = {
    name,
    type: 'oauth',
    source,
    accountUuid: profile?.accountUuid || null,
    orgUuid: profile?.orgUuid || null,
    orgName: profile?.orgName || null,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };

  // Deduplicate by account+org identity (same email in a different org is a
  // distinct account), then by name.
  let idx = config.accounts.findIndex(a => sameIdentity(a, account));
  if (idx < 0) idx = config.accounts.findIndex(a => a.name === name);

  if (idx >= 0) {
    // Same account+org: refresh credentials and org info, but keep the existing
    // display name and any disk-only fields (e.g. importFrom).
    const prev = config.accounts[idx];
    config.accounts[idx] = { ...prev, ...account, name: prev.name };
    console.log(`Updated account "${prev.name}"`);
  } else {
    // New org for this person: if another entry shares the accountUuid, the bare
    // email name would collide — disambiguate both with " (org)".
    if (!userNamed && account.accountUuid) {
      const collisions = config.accounts.filter(
        a => a.accountUuid === account.accountUuid && !sameIdentity(a, account)
      );
      if (collisions.length > 0) {
        for (const c of collisions) {
          if (!c.name.includes(' (')) c.name = `${c.name} (${orgLabel(c)})`;
        }
        account.name = `${name} (${orgLabel(account)})`;
      }
    }
    config.accounts.push(account);
    console.log(`Added account "${account.name}"`);
  }

  await saveConfig(config);
  console.log(`Saved to ${getConfigPath()}`);
  await notifyRunningServer(config);
}

// ── config sync helpers ─────────────────────────────────────

/**
 * Find a config account entry matching an in-memory account by account+org identity.
 */
function findConfigAccount(diskConfig, account) {
  return diskConfig.accounts.findIndex(a => sameIdentity(a, account));
}

/**
 * Sync accounts from disk config: add new accounts and refresh credentials
 * for existing ones (handles re-imported OAuth tokens, rotated API keys, etc.).
 * Returns the number of new accounts added.
 */
async function syncAccountsFromDisk(diskConfig, memConfig, accountManager) {
  let added = 0;
  // Greedy 1:1 pairing of disk entries to in-memory accounts, account+org aware.
  // Each disk entry claims at most one unclaimed manager account, so multiple
  // same-person/different-org entries pair correctly instead of all matching the
  // first one with that accountUuid.
  const claimed = new Set();
  const claim = (diskAcct) => {
    for (let i = 0; i < accountManager.accounts.length; i++) {
      if (!claimed.has(i) && sameIdentity(accountManager.accounts[i], diskAcct)) {
        claimed.add(i);
        return i;
      }
    }
    return -1;
  };

  for (const diskAcct of diskConfig.accounts) {
    const mgrIdx = claim(diskAcct);

    if (mgrIdx < 0) {
      // New account discovered on disk — add to running server
      memConfig.accounts.push(diskAcct);
      accountManager.addAccount(diskAcct);
      claimed.add(accountManager.accounts.length - 1);
      added++;
      console.log(`[TeamClaude] Picked up new account "${diskAcct.name}" from config`);
      continue;
    }

    const mgr = accountManager.accounts[mgrIdx];

    // Backfill org identity and pick up renames/priority onto the running
    // account (e.g. after disk-side org disambiguation or a `priority` change).
    if (diskAcct.orgUuid && !mgr.orgUuid) mgr.orgUuid = diskAcct.orgUuid;
    if (diskAcct.orgName && !mgr.orgName) mgr.orgName = diskAcct.orgName;
    if (diskAcct.name && mgr.name !== diskAcct.name) mgr.name = diskAcct.name;
    if (diskAcct.priority != null && mgr.priority !== diskAcct.priority) mgr.priority = diskAcct.priority;
    // Pick up enable/disable toggles; re-enabling clears a stuck error state.
    const wantDisabled = !!diskAcct.disabled;
    if (mgr.disabled !== wantDisabled) accountManager.setDisabled(mgr.index, wantDisabled);

    // Existing account — resolve fresh credentials from disk
    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.importFrom) {
      try {
        const creds = await importCredentials(diskAcct.importFrom);
        freshCred = { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt };
      } catch (err) {
        console.error(`[TeamClaude] Re-import failed for "${diskAcct.name}": ${err.message}`);
      }
    } else if (diskAcct.type === 'oauth' && diskAcct.accessToken) {
      freshCred = { accessToken: diskAcct.accessToken, refreshToken: diskAcct.refreshToken, expiresAt: diskAcct.expiresAt };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    }

    if (!freshCred) continue;

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken ||
        mgr.refreshToken !== freshCred.refreshToken;
      // Don't overwrite in-memory credentials with staler ones from disk
      // (e.g. after a TUI import updated the AM before saveConfig wrote to disk)
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt &&
        freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        console.log(`[TeamClaude] Refreshed credentials for "${mgr.name}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      console.log(`[TeamClaude] Updated API key for "${mgr.name}"`);
    }
  }
  return added;
}

// ── helpers ─────────────────────────────────────────────────

async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      if (acct.importFrom) {
        try {
          const creds = await importCredentials(acct.importFrom);
          accounts.push({ name: acct.name, type: 'oauth', ...creds });
          console.log(`Imported "${acct.name}" from ${acct.importFrom}`);
        } catch (err) {
          console.error(`Failed to import "${acct.name}": ${err.message}`);
        }
      } else if (acct.accessToken) {
        accounts.push(acct);
      } else {
        console.error(`No token for "${acct.name}", skipping`);
      }
    } else if (acct.type === 'apikey' && acct.apiKey) {
      accounts.push(acct);
    }
  }
  return accounts;
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
}

// Hostname of the configured upstream (the host MITM-intercepts under `run --mitm`).
function upstreamHost(config) {
  try { return new URL(config.upstream || 'https://api.anthropic.com').hostname; }
  catch { return 'api.anthropic.com'; }
}

// Best-effort: tell a running server (if any) to re-sync accounts from config so
// CLI changes take effect without a restart. A closed local port refuses the
// connection immediately, so this is a no-op (and near-instant) when nothing is
// running. Reload picks up new accounts, credential, priority, and enable/disable
// changes; account removals still need a restart.
async function notifyRunningServer(config) {
  const port = config?.proxy?.port;
  if (!port) return;
  try {
    const res = await fetch(`http://localhost:${port}/teamclaude/reload`, {
      method: 'POST',
      headers: { 'x-api-key': config.proxy?.apiKey || '' },
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      console.log(`Reloaded running server${data.added ? ` (+${data.added} new account)` : ''}.`);
    }
  } catch { /* no server running — nothing to notify */ }
}

// Quick liveness probe: is something listening on the local proxy port?
// A successful TCP connect is enough (the proxy is local). Times out fast so a
// down proxy doesn't add noticeable latency to `claude` launches via the alias.
function isProxyUp(port, timeout = 600) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = up => { socket.destroy(); resolve(up); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => resolve(false));
  });
}

function handleServerListenError(err, port) {
  if (err.code === 'EADDRINUSE') {
    console.error(`[TeamClaude] Port ${port} is already in use.`);
    console.error('Another TeamClaude proxy may already be running.');
    console.error('Check the existing server with: teamclaude status');
    console.error(`Find the listener with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  } else if (err.code === 'EACCES') {
    console.error(`[TeamClaude] Permission denied while listening on port ${port}.`);
    console.error('Choose a non-privileged port in the TeamClaude config.');
  } else {
    console.error(`[TeamClaude] Failed to listen on port ${port}: ${err.message}`);
  }
  process.exit(1);
}
