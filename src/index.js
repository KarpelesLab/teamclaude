#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createWriteStream, readFileSync } from 'node:fs';
import net from 'node:net';
import { loadOrCreateConfig, loadConfig, saveConfig, atomicConfigUpdate, getConfigPath, loadState, saveState } from './config.js';
import { AccountManager } from './account-manager.js';
import { createProxyServer, resolveAccountPin } from './server.js';
import { importCredentials, loginOAuth, fetchProfile, refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import { sameIdentity, orgKey, matchAccounts, stableAccountPin } from './identity.js';
import { resolveAccounts } from './resolve-accounts.js';
import * as alias from './alias.js';
import { ensureCerts } from './mitm.js';
import { Prober } from './prober.js';
import { Warmer } from './warmer.js';
import { TUI } from './tui.js';
import { SxManager } from './sx.js';
import { autoUpdate, checkForUpdate, currentVersion, runUpdate, installKind, PKG_NAME } from './updater.js';
import { renderStatus } from './status-renderer.js';
import { syncAccountsFromDisk, applyTopLevelReload } from './config-reload.js';
import { buildClaudeEnvLines, encodePinComponent, directLaunchEnvPlan, redactUrlUserinfo } from './claude-env.js';
import { deriveNamespace } from './model-namespace.js';
import { explainRouting, formatExplain, launchSummary } from './route-explain.js';
import {
  preflightModel, formatPreflight, splitRunArgs, lastValueFlag, readFlagSettingsModels, scanModelArgs,
  RUN_BOOLEAN_FLAGS,
} from './model-preflight.js';
import { readAvailableModels } from './claude-settings.js';
import { checkConfig, formatFindings, doctorExitCode } from './config-doctor.js';
import { replayRank, formatRankReplay } from './rank-replay.js';
import { formatTerminalTitle, titleSequence, TITLE_STACK_PUSH, TITLE_STACK_POP } from './terminal-title.js';
import { buildUsageDocument, formatUsageReport, createUsageServer } from './usage.js';

const args = process.argv.slice(2);
const command = args[0];

// Usage strings for the multi-form commands. They live ABOVE the dispatch switch
// rather than beside their handlers because the switch runs during module
// evaluation: a `const` declared further down is still in its temporal dead zone
// when a handler reaches it, so `teamclaude route bogus` threw a ReferenceError
// instead of printing usage. Hoisted function declarations are why the handlers
// themselves can stay below.

const ROUTE_USAGE = [
  'Usage: teamclaude route [list]',
  '       teamclaude route add <name> --match "<glob>[,<glob>]" [--accounts "<name-or-index>[,...]"] [--bucket <quota-bucket>] [--color <name>]',
  '       teamclaude route rm <name>',
  '',
  'A route pins model ids matching its globs to an exclusive set of accounts.',
  'Omit --accounts to route to all accounts (e.g. just to override --bucket).',
  '--color (red/green/yellow/blue/magenta/cyan) tints the route\'s inline marker in the TUI.',
  'First matching route wins. Changes apply to a running server immediately.',
].join('\n');

const ROUTE_COLORS = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];

const EXPLAIN_USAGE = [
  'Usage: teamclaude explain <model> [--account <name-or-index>] [--json]',
  '',
  'Print the routing decision a request for <model> would follow: blocklist, which',
  'route wins and which routes it shadows, which accounts are eligible and why the',
  'rest are not, the failover chain, and the config problems the trace proves.',
  '--account shows the same trace under a /tc-acct pin (what `run --account` sends).',
  'Quota-blind and read-only: it explains the config, not the live server.',
].join('\n');

const USAGE_CMD_USAGE = [
  'Usage: teamclaude usage [--json]',
  '       teamclaude usage serve [--port <port>] [--host <host>] [--token <token>]',
  '',
  'Aggregate quota, accounts, soak/burn history, and model routing telemetry.',
  '`--json` emits a versioned document ({schemaVersion, generatedAt, staleAfterSeconds, providers[]}).',
  '`serve` starts a loopback HTTP server exposing /usage and /health.',
].join('\n');


switch (command) {
  case 'usage':
    await usageCommand();
    process.exit(0);
    break;
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
  case 'warmup':
    await warmupCommand();
    process.exit(0);
    break;
  case 'route':
  case 'routes':
    await routeCommand();
    process.exit(0);
    break;
  case 'models':
    await modelsCommand();
    process.exit(0);
    break;
  case 'explain':
    await explainCommand();
    process.exit(0);
    break;
  case 'doctor':
    await doctorCommand();
    break;
  case 'rank':
    await rankCommand();
    process.exit(0);
    break;
  case 'update':
    await updateCommand();
    process.exit(0);
    break;
  case 'version':
  case '--version':
  case '-V':
    console.log(currentVersion() || 'unknown');
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

  // --activity-log <file>
  const activityLogPath = argValue('--activity-log') || null;

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

  // `accounts[].models` (#74) is superseded by the `routes` table (#86). Routes
  // do the same job with glob matching, several accounts per rule and a bucket
  // override — and, unlike `models`, they don't silently change eligibility
  // fleet-wide the moment one account declares a list (see _accountOwnsModel).
  // Behaviour is unchanged; this only tells pre-#86 configs what to migrate to
  // before the field goes away. Reported against config.accounts so the notice
  // names what is actually written on disk, whatever resolution does with it.
  for (const acct of config.accounts) {
    if (!acct.models?.length) continue;
    const route = { name: acct.name, match: acct.models, accounts: [acct.name] };
    console.error(`[TeamClaude] Deprecated: account "${acct.name}" uses "models" — replace it with a routes entry: ${JSON.stringify(route)}`);
  }

  const threshold = config.switchThreshold || 0.98;
  const accountManager = new AccountManager(accounts, threshold, {
    routes: config.routes,
    ramp: config.stormRamp,
    distributeSessions: config.distributeSessions,
    routingPolicy: config.routingPolicy,
    rotationGate: config.rotationGate,
  });

  // Restore quota observed in a previous run so a restart doesn't lose rotation
  // state (passive — we never call the API to re-learn it). Stale windows are
  // cleared automatically on first use by _clearExpiredQuotas.
  const savedState = await loadState().catch(err => {
    console.error(`[TeamClaude] Could not read saved state: ${err.message}`);
    return null;
  });
  if (savedState?.quota) accountManager.restoreQuotaState(savedState.quota);
  if (savedState?.shadowDecisions) accountManager.restoreShadowDecisions(savedState.shadowDecisions);
  if (savedState?.sessionFamilies) accountManager.restoreSessionFamilies(savedState.sessionFamilies);

  // With quota restored, pick the best account up front (highest priority /
  // soonest-resetting weekly window) instead of defaulting to the first one.
  accountManager.selectActiveAccount();

  // Periodically persist quota + shadow evidence + sessionFamilies (and once
  // more on shutdown). sessionFamilies rewrite every 60s even while the gate
  // is inert (always-on marking) — "zero config ⇒ zero change" scopes to
  // ROUTING only (T2 design amendment #7).
  const persistQuotaState = () =>
    saveState({
      quota: accountManager.exportQuotaState(),
      shadowDecisions: accountManager.exportShadowDecisions(),
      sessionFamilies: accountManager.exportSessionFamilies(),
    })
      .catch(err => console.error(`[TeamClaude] Failed to save quota state: ${err.message}`));
  let quotaSaveInterval = null;

  // Persist refreshed tokens back to config (re-read from disk to avoid clobbering
  // accounts added externally, e.g. by `teamclaude import` while server is running)
  accountManager.onTokenRefresh((idx, newTokens) => {
    const account = accountManager.accounts[idx];
    if (!account || account.retired) return;
    // Keep config.accounts in sync so TUI saveConfig doesn't clobber fresh tokens.
    // Match by identity: after D4c tombstone retires, memConfig is compacted and
    // no longer shares indices with accountManager.accounts.
    const memIdx = config.accounts.findIndex(a => sameIdentity(a, account));
    if (memIdx >= 0) {
      config.accounts[memIdx].accessToken = newTokens.accessToken;
      config.accounts[memIdx].refreshToken = newTokens.refreshToken;
      config.accounts[memIdx].expiresAt = newTokens.expiresAt;
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
  // Bind loopback by default so the proxy isn't reachable off-box (it injects
  // account tokens and — via CONNECT — can relay arbitrarily). Opt into a wider
  // bind explicitly with TEAMCLAUDE_HOST or config.proxy.host (e.g. '0.0.0.0'),
  // in which case set proxy.apiKey so the auth gate protects remote clients.
  const bindHost = process.env.TEAMCLAUDE_HOST || config.proxy.host || '127.0.0.1';
  const headless = args.includes('--headless') || args.includes('--no-tui');
  const useTUI = !headless && process.stdout.isTTY && process.stdin.isTTY;

  // Opt-in background quota probe (config.quotaProbeSeconds, default 0 = off).
  let prober = null;
  // Opt-in keep-warm scheduler (config.warmupSeconds, default 0 = off).
  let warmer = null;
  const serverStartedAt = Date.now();

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
    const added = await syncAccountsFromDisk(diskConfig, config, accountManager, { importCredentials });
    // Pick up route table + routing-policy edits atomically with account policy.
    // ABSENT keys preserve the running value (D4b); present keys apply as written.
    applyTopLevelReload(diskConfig, config, accountManager);
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
    if (warmer) {
      const ms = (diskConfig.warmupSeconds || 0) * 1000;
      if (ms !== warmer.intervalMs) {
        config.warmupSeconds = diskConfig.warmupSeconds || 0;
        warmer.reschedule(ms);
      }
    }
    return added;
  };

  let tui = null;
  let hooks = {};

  if (useTUI) {
    tui = new TUI({
      accountManager, config, sx, activityLogPath,
      saveConfig: () => atomicConfigUpdate(async diskConfig => {
        // Write in-memory accounts as the authoritative state, preserving
        // extra disk-only fields (e.g. importFrom) where the account still exists.
        // Use live tokens from AccountManager (not the stale config.accounts copy).
        // Identity-match live tokens: manager slots may hold D4c tombstones
        // whose indices no longer align with the compacted config.accounts list.
        diskConfig.accounts = config.accounts.map((a) => {
          const am = accountManager.accounts.find(x => !x.retired && sameIdentity(x, a));
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
        if (config.warmupSeconds != null) diskConfig.warmupSeconds = config.warmupSeconds;
        // Persist the route table (edited from the TUI routes screen).
        if (config.routes != null) diskConfig.routes = config.routes;
      }),
      syncAccounts: reloadAccounts,
      // `p` key: on-demand fleet-wide quota refresh. The prober is constructed
      // after the TUI, so this is a thunk over the closure variable.
      probeQuota: () => prober?.probeAll(),
      // ctrl-c / q from the TUI: funnel through the same idempotent shutdown as
      // POSIX signals (defined below). In raw mode ctrl-c never reaches the OS as
      // a signal, so without this the process would only tear down via keypress.
      onQuit: () => shutdown(),
    });
    hooks = {
      onRequestStart: (id, info) => tui.onRequestStart(id, info),
      onRequestModel: (id, info) => tui.onRequestModel(id, info),
      onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
      onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
    };
  }

  // In headless mode, wire activity-log writes directly via hooks + console.
  if (!tui && activityLogPath) {
    const aStream = createWriteStream(activityLogPath, { flags: 'a' });
    aStream.on('error', err => process.stderr.write(`[TeamClaude] activity log error: ${err.message}\n`));
    const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false });
    const writeActivity = msg => {
      // Strip [TeamClaude] prefix to match TUI behaviour
      aStream.write(`${ts()}  ${msg.replace(/^\[TeamClaude\]\s*/, '')}\n`);
    };
    // Capture request completions via the hook
    const inFlight = new Map();
    hooks.onRequestStart = (id, info) => inFlight.set(id, { ...info, started: Date.now() });
    hooks.onRequestModel = (id, info) => {
      const r = inFlight.get(id);
      if (r && info.model) r.model = info.model;
    };
    hooks.onRequestRouted = (id, info) => {
      const r = inFlight.get(id);
      if (r) r.account = info.account;
    };
    hooks.onRequestEnd = (id, info) => {
      const r = inFlight.get(id);
      inFlight.delete(id);
      const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
      const acct = info.account || r?.account || '?';
      const model = info.model ? ` (${info.model})` : '';
      const fleetAgent = info.fleetAgent || r?.fleetAgent || null;
      const sid = fleetAgent
        ? `${fleetAgent} `
        : (info.sessionId ? `${info.sessionId.slice(0, 6)} ` : '');
      const pin = (info.pinned || r?.pinned) ? ' [pin]' : '';
      writeActivity(`${sid}${info.method} ${info.path}${model} → ${acct}${pin} (${info.status}, ${dur}s)`);
    };
    // Tee console output to the activity log as well
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { const m = a.join(' '); origLog(m); writeActivity(m); };
    console.error = (...a) => { const m = a.join(' '); origErr(m); writeActivity(m); };
    process.on('exit', () => aStream.end());
  }

  // Expose reload to the proxy's control endpoint (works with or without TUI).
  hooks.reload = reloadAccounts;
  hooks.getStatusExtra = () => ({
    server: {
      startedAt: new Date(serverStartedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - serverStartedAt) / 1000),
      port,
      upstream: config.upstream || 'https://api.anthropic.com',
    },
    probe: prober?.getStatus() || {
      enabled: false,
      intervalSeconds: config.quotaProbeSeconds || 0,
      running: false,
      accounts: accountManager.accounts.map(account => ({
        name: account.name,
        status: account.type === 'oauth' ? 'never' : 'not-applicable',
        lastProbedAt: null,
        startedAt: null,
        durationMs: null,
        error: null,
      })),
    },
    warm: warmer?.getStatus() || {
      enabled: false,
      intervalSeconds: config.warmupSeconds || 0,
      running: false,
      accounts: accountManager.accounts.map(account => ({
        name: account.name,
        status: (account.type === 'oauth' && !account.upstream) ? 'never' : 'not-applicable',
        lastWarmedAt: null,
        startedAt: null,
        durationMs: null,
        error: null,
      })),
    },
  });

  const server = createProxyServer(accountManager, config, hooks, sx);
  // Catch bind-time errors (e.g. EADDRINUSE) only. Once the socket is bound we
  // remove this handler so a later runtime 'error' isn't misreported as a
  // listen failure and exit the whole proxy.
  const onListenError = err => handleServerListenError(err, port);
  server.once('error', onListenError);

  server.listen(port, bindHost, () => {
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
      console.log(`  Bind:       ${bindHost}:${port}${bindHost === '127.0.0.1' ? ' (localhost only)' : ' (reachable off-box — ensure proxy.apiKey is set)'}`);
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

  // Reflect the active account in the terminal title so a backgrounded/tabbed
  // server is glanceable. Works in both TUI and headless modes.
  const stopTitle = startTerminalTitleUpdater(accountManager);

  // Persist quota every minute; unref so it never keeps the process alive.
  quotaSaveInterval = setInterval(persistQuotaState, 60_000);
  quotaSaveInterval.unref?.();

  // Start the opt-in quota probe (no-op when quotaProbeSeconds is 0).
  prober = new Prober(accountManager, { intervalMs: (config.quotaProbeSeconds || 0) * 1000 });
  prober.start();

  // Start the opt-in keep-warm scheduler (no-op when warmupSeconds is 0). It
  // spawns a minimal `claude` per idle account through this proxy, pinned via
  // /tc-acct/<index>, so needs our own port and proxy key.
  warmer = new Warmer(accountManager, {
    intervalMs: (config.warmupSeconds || 0) * 1000,
    port,
    apiKey: config.proxy?.apiKey,
  });
  warmer.start();

  // Background self-update for a backgrounded (headless) server. Skipped under
  // the TUI, where npm's install output would corrupt the display — interactive
  // users update via `teamclaude run` (post-session) or `teamclaude update`.
  if (!tui) autoUpdate({ config }).catch(() => {});

  // One idempotent shutdown funnel for BOTH modes and BOTH triggers: POSIX
  // signals (SIGINT/SIGTERM) and the TUI's ctrl-c / q keypress (which in raw mode
  // never reaches the OS as a signal). Guards re-entry: a second ctrl-c — an
  // impatient user, or a signal racing the keypress — forces an immediate exit
  // instead of re-running teardown, which would re-arm server.close() and leak a
  // 'close' listener on the server each time (MaxListenersExceededWarning).
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) process.exit(0); // second ctrl-c: stop waiting, just go
    shuttingDown = true;
    try { tui?.stop(); } catch { /* terminal already restored */ }
    stopTitle();
    if (!tui) console.log('\n[TeamClaude] Shutting down...');
    prober?.stop();
    warmer?.stop();
    if (quotaSaveInterval) clearInterval(quotaSaveInterval);
    await persistQuotaState();
    // Don't linger waiting on keep-alive / streaming connections: actively
    // destroy them so server.close() can complete promptly, and hard-exit after a
    // short grace period in case anything still hangs.
    setTimeout(() => process.exit(0), 2000).unref?.();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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

// `teamclaude env [--no-mitm]` — print the export lines that point Claude Code
// at the proxy, for `eval "$(teamclaude env)"`. Mirrors `teamclaude run`'s
// environment (MITM forward-proxy by default; --no-mitm for base-URL only) so a
// tool that spawns claude itself — an agent multiplexer, a CI job, a manual
// shell — gets the same routing without going through `run`. Only the export
// lines go to stdout; all guidance goes to stderr so the output stays eval-safe.
async function envCommand() {
  // Use loadConfig (not loadOrCreateConfig): a query command must never write to
  // stdout — creating a config prints "Created config at …", which would poison
  // `eval "$(teamclaude env)"` — nor silently create config as a side effect.
  const config = await loadConfig();
  if (!config) {
    process.stderr.write(`No config found at ${getConfigPath()}. Add an account first: teamclaude login\n`);
    process.exit(1);
  }
  const port = config.proxy.port;
  const useMitm = !args.slice(1).includes('--no-mitm');

  // Same --account pin as `run`, validated the same way, so a tool that spawns
  // claude itself can pin a session too. Validation is not optional here either:
  // an unresolved pin would 404 on every request of a session that already looks
  // launched. Both spellings are recognized — an `--account=name` that parsed as
  // "no pin requested" would print an UNPINNED export line with no warning, and
  // the caller would eval it believing the shell was pinned.
  const envAccount = lastValueFlag(args.slice(1), '--account');
  const accountPin = envAccount.present ? resolveRunAccountPin(config, envAccount.value) : null;

  let caPath = null;
  if (useMitm) ({ caPath } = await ensureCerts(upstreamHost(config)));

  // TC_ACCT is the sole pin mechanism; --account is sugar that sets it.
  // Emit the STABLE pin form (uuid), not the mutable display name: a later
  // rename must not silently repoint an already-eval'd shell at a different
  // account. Bare TC_ACCT (no --account) is passed through unchanged.
  const account = (accountPin ? accountPin.pin : (process.env.TC_ACCT || '')).trim();
  const lines = buildClaudeEnvLines({
    port, useMitm, caPath, holdSeconds: config.holdSeconds,
    account, proxyApiKey: config.proxy?.apiKey || '',
  });
  process.stdout.write(`${lines.join('\n')}\n`);

  const mode = useMitm ? 'MITM forward-proxy' : 'base-URL';
  process.stderr.write(`# TeamClaude env: ${mode} mode, localhost:${port}\n`);
  if (account) {
    if (accountPin) {
      process.stderr.write(`# pinned to account "${accountPin.name}" (#${accountPin.index}) via TC_ACCT — no rotation, no failover\n`);
    } else {
      process.stderr.write(`# pinned to account "${account}" (TC_ACCT)\n`);
      // Warn, don't fail: the account list can change before the shell is used,
      // and this command must stay eval-safe. Use the SAME resolver as TC_ACCT's
      // server path; a valid UUID/qualified pin is not necessarily a name.
      if (resolveConfigAccountPin(config, account) == null) {
        process.stderr.write(`# warning: unknown account pin "${account}" — the proxy will refuse this pin\n`);
      }
    }
  }
  // Shell-quote the pin: display names (and even uuid forms pasted into odd
  // shells) can carry spaces/metacharacters; an unquoted --account would break
  // or inject into the suggested eval line.
  const accountArg = accountPin ? ` --account ${shellSingleQuote(accountPin.pin)}` : '';
  process.stderr.write(`# apply to this shell:  eval "$(teamclaude env${useMitm ? '' : ' --no-mitm'}${accountArg})"\n`);
  if (!(await isProxyUp(port))) {
    process.stderr.write(`# note: proxy not running on port ${port} — start it with: teamclaude server\n`);
  }
  if (config.proxy?.apiKey) {
    process.stderr.write(`# remote (non-loopback) clients must also present the proxy key: ANTHROPIC_API_KEY=<proxy.apiKey> (base-URL), or http://<key>@host:${port} (MITM)\n`);
  }
}

// ── run ─────────────────────────────────────────────────────

async function runCommand() {
  const config = await loadOrCreateConfig();

  // Args after 'run'. teamclaude flags (e.g. --no-mitm, --account) are recognized
  // only before an optional `--` separator; everything after `--` goes verbatim to
  // claude. MITM forward-proxy mode is the default so hardcoded api.anthropic.com
  // endpoints are intercepted too; --no-mitm opts back into base-URL-only routing.
  // --mitm is still accepted (now a no-op) for backward compatibility.
  const run = splitRunArgs(args.slice(1));
  const useMitm = run.useMitm;
  const autoFallback = run.autoFallback;
  const claudeArgs = run.claudeArgs;

  // An unrecognized flag BEFORE the `--` is provably a mistake: in the separated
  // form that slice is exclusively teamclaude's, and until now anything we did
  // not know was dropped without a word — which is how `--account=work` launched
  // an unpinned session that the operator believed was pinned. (In the
  // unseparated form an unknown flag is claude's by construction, so this only
  // ever fires on the separated one, where the fleet aliases pass nothing at all.)
  if (run.unknownFlags.length) {
    console.error(`[TeamClaude] Unknown flag(s) for 'teamclaude run': ${run.unknownFlags.join(', ')}`);
    console.error(`Valid flags before the --: ${[...RUN_BOOLEAN_FLAGS, '--account <name>'].join(', ')}`);
    console.error('Everything after the -- is passed to claude verbatim.');
    process.exit(1);
  }

  // Route through the proxy when it's up. When it's down we refuse by default —
  // silently launching claude directly hides that requests are bypassing the
  // proxy (no rotation, spending the user's own quota). Pass --auto-fallback to
  // opt back into the transparent direct launch (e.g. for a dumb shell alias).
  const port = config.proxy.port;
  const env = { ...process.env };

  // Probed BEFORE pin resolution and preflight: with the proxy down
  // --auto-fallback launches claude straight at the upstream, where the pin is a
  // proxy routing knob that governs nothing — failing loud on a stale pin there
  // refuses a session that works, on a rule it will never consult. Same doctrine
  // as routingApplies for preflight. When the proxy IS up (or proxy-down without
  // --auto-fallback), keep fail-loud — D12 parity must not regress.
  const proxyUp = await isProxyUp(port);
  // Routing governs this launch unless it is the direct one. Note the second
  // clause: with the proxy down and NO --auto-fallback the run is about to
  // refuse anyway, and reporting both problems at once beats sending the
  // operator round the loop twice — start the server, get refused again.
  const routingApplies = proxyUp || !autoFallback;

  // --account <name> is sugar for TC_ACCT. Resolve the effective pin when
  // routing applies so a typo costs nothing: an unknown pin would otherwise
  // reach the server as a 404 on the FIRST request. Bare TC_ACCT (no --account)
  // uses the same resolveAccountPin contract — UUID form, mutation-validated,
  // numeric index rejected — and fails loud on an unresolvable token. NEVER
  // silently preflight-as-unpinned when routing applies. On the direct-fallback
  // path soft-resolve only (for the "pin IGNORED" narration) — never exit.
  let accountPinFromFlag = null;
  let accountPin = null;
  if (routingApplies) {
    accountPinFromFlag = run.accountRequested
      ? resolveRunAccountPin(config, run.account)
      : null;
    const bareTcAcct = accountPinFromFlag ? '' : (process.env.TC_ACCT || '').trim();
    accountPin = accountPinFromFlag
      || (bareTcAcct ? resolveRunAccountPin(config, bareTcAcct) : null);
  } else {
    const token = run.accountRequested
      ? (run.account || '')
      : (process.env.TC_ACCT || '').trim();
    if (token) {
      accountPin = tryResolveRunAccountPin(config, token);
      if (accountPin && run.accountRequested) accountPinFromFlag = accountPin;
    }
  }

  // TC_ACCT is the sole pin mechanism. --account is sugar: it sets the pin
  // identity. Emit the STABLE form (uuid), not the mutable display name — same
  // doctrine as envCommand / stableAccountPin — so a later rename cannot
  // silently repoint a session. Deleted from the child env so it never leaks
  // into tools/MCP servers claude spawns. Resolved pins (flag or bare TC_ACCT)
  // always emit accountPin.pin; there is no unresolved pass-through left.
  const tcAcct = accountPin ? accountPin.pin : '';
  delete env.TC_ACCT;
  // Legacy: a caller-supplied ANTHROPIC_BASE_URL of http://<this proxy>/tc-acct/…
  // also pins (shipped in 1.1.10). TC_ACCT is the supported way now — it works in
  // MITM mode too, and keeps the pin out of the API path.
  const pinnedBase = isLocalAccountPin(process.env.ANTHROPIC_BASE_URL, port);
  // Proxy vars a direct launch inherited and deliberately did NOT clear, so the
  // launch line can qualify its "bypassing the proxy" claim rather than assert
  // something the environment contradicts.
  let directLaunchVia = [];

  // Fail loud on a model that cannot work. Claude Code will not do this: at
  // launch a refused --model is advisory there — warned in-band, never on
  // stderr, never fatal — so the only place a bad model can still be made
  // visible is here, before the process is replaced. --no-preflight skips it.
  if (run.preflight) runPreflight({ config, run, accountPin, routingApplies });

  if (proxyUp) {
    if (useMitm) {
      // Route ALL of claude's traffic through us as an HTTPS forward proxy, so
      // even hardcoded api.anthropic.com endpoints (e.g. the design MCP) get the
      // real token injected. claude trusts our MITM leaf via NODE_EXTRA_CA_CERTS.
      const host = upstreamHost(config);
      const { caPath } = await ensureCerts(host);
      // The pin rides in the proxy URL's userinfo, which the client forwards as
      // `Proxy-Authorization: Basic <acct>:<key>` on each CONNECT — the only pin
      // channel an HTTPS_PROXY env var can express. The password slot keeps the
      // proxy apiKey, matching the existing `--proxy http://<key>@host:port`
      // form, so auth and pinning coexist in one URL.
      const userinfo = tcAcct
        ? `${encodePinComponent(tcAcct)}:${encodePinComponent(config.proxy?.apiKey || '')}@`
        : '';
      const proxyUrl = `http://${userinfo}127.0.0.1:${port}`;
      env.HTTPS_PROXY = env.HTTP_PROXY = env.https_proxy = env.http_proxy = proxyUrl;
      env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
      env.NODE_EXTRA_CA_CERTS = caPath;
      if (tcAcct) {
        const via = accountPinFromFlag ? `--account ${accountPinFromFlag.name} → TC_ACCT` : 'TC_ACCT';
        console.error(`[TeamClaude] Pinned to account "${tcAcct}" (${via}) — this session will not rotate and will not fail over; an exhausted pin returns 429 rather than borrowing another account.`);
      } else if (pinnedBase) {
        console.error('[TeamClaude] Account pin in ANTHROPIC_BASE_URL ignored: MITM mode does not use a base URL.');
        console.error('[TeamClaude] Use TC_ACCT=<account> (or --account <name>) instead — it pins in both modes.');
      }
      delete env.ANTHROPIC_BASE_URL;
    } else {
      // Only set ANTHROPIC_BASE_URL — Claude Code keeps its own OAuth token
      // which the proxy accepts from localhost. Not setting ANTHROPIC_API_KEY
      // lets Claude Code stay in subscription mode (full model access).
      // TC_ACCT wins; teamclaude builds the pinned URL itself rather than making
      // the caller hand-write one. Otherwise an existing /tc-acct/ base URL
      // pointing at this proxy is preserved for configs written against 1.1.10.
      if (tcAcct) {
        env.ANTHROPIC_BASE_URL = `http://localhost:${port}/tc-acct/${encodePinComponent(tcAcct)}`;
        const via = accountPinFromFlag ? `--account ${accountPinFromFlag.name} → TC_ACCT` : 'TC_ACCT';
        console.error(`[TeamClaude] Pinned to account "${tcAcct}" (${via}) — this session will not rotate and will not fail over; an exhausted pin returns 429 rather than borrowing another account.`);
      } else if (!pinnedBase) {
        env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
      }
    }
  } else if (autoFallback) {
    console.error(`[TeamClaude] Proxy not running on port ${port} — launching claude directly (--auto-fallback; start it with: teamclaude server)`);
    // "Directly" has to be true. The child inherits this shell's environment,
    // and a teamclaude session's shell is usually one teamclaude set up, so
    // without this the traffic goes straight back into a proxy — the dead one we
    // just probed, or worse, a different live one. See directLaunchEnvPlan.
    const plan = directLaunchEnvPlan(env, port);
    for (const name of plan.clear) delete env[name];
    if (plan.clear.length) {
      console.error(`[TeamClaude] Cleared ${plan.clear.join(', ')} — they pointed at the proxy on port ${port}, which is down; a direct launch must not route through it.`);
    }
    for (const { names, value } of plan.remaining) {
      // Redact userinfo: proxy URLs carry credentials (teamclaude embeds its API
      // key there). Logging the raw value is SECRET_IN_PANE (B62).
      console.error(`[TeamClaude] NOTE: ${names.join(', ')} = ${redactUrlUserinfo(value)} — set to something that is NOT this proxy, so it is left alone (it may be a corporate egress proxy or another teamclaude). This launch is "direct" only with respect to port ${port}; claude's traffic still traverses that proxy.`);
    }
    directLaunchVia = plan.remaining;
    if (accountPin) {
      console.error(`[TeamClaude] account pin (${accountPinFromFlag ? `--account ${accountPinFromFlag.name}` : `TC_ACCT=${tcAcct}`}) is IGNORED in a direct launch: the pin is a proxy routing knob, and the proxy is down.`);
    }
  } else {
    console.error(`[TeamClaude] Proxy not running on port ${port}.`);
    console.error('Start it with: teamclaude server');
    console.error('Or pass --auto-fallback to launch claude directly (bypassing the proxy) when it is down.');
    process.exit(1);
  }

  // If holdSeconds is set, ensure API_TIMEOUT_MS on the Claude Code side is
  // large enough for the hold to complete. Add 60s padding (one extra poll
  // cycle) so the client doesn't time out while we're still waiting.
  // Claude Code defaults API_TIMEOUT_MS to 600000ms (10 min) when unset, so
  // use that as the baseline to avoid accidentally lowering the timeout.
  const holdMs = (config.holdSeconds || 0) * 1000;
  if (holdMs > 0) {
    const needed = holdMs + 60_000;
    const API_TIMEOUT_DEFAULT_MS = 600_000;
    const current = parseInt(env.API_TIMEOUT_MS || '0', 10) || API_TIMEOUT_DEFAULT_MS;
    if (current < needed) env.API_TIMEOUT_MS = String(needed);
  }

  // State where this session's traffic is going, on EVERY launch — the guard
  // that would have caught the incident this whole path exists for. The
  // preflight only speaks when it can prove something is broken; it is silent
  // when routing merely differs from what the operator assumed, which is the
  // case that actually cost six minutes of wrong-model compute. Printed last so
  // it reflects the env as finally assembled (pin applied, transport chosen,
  // direct-launch fallback taken) rather than the intent going in.
  //
  // stderr, so a `--print` session's stdout stays pipeable. Wrapped, because a
  // launch must never fail because its narration did: this line is worth
  // printing on every launch precisely because it is never load-bearing.
  if (run.launchLine) {
    try {
      const model = scanModelArgs(claudeArgs).effective || process.env.ANTHROPIC_MODEL || null;
      // Prefer the RESOLVED name (same as preflightModel): a UUID-form
      // `--account` pin's raw token does not match normalizeAccounts()'s
      // name/index lookup, which falsely printed "matches NO account".
      const line = launchSummary(config, {
        model,
        accountPin: accountPin?.name || accountPin?.token || null,
        routingApplies: proxyUp,
        via: directLaunchVia,
      });
      if (line) console.error(`[TeamClaude] ${line}`);
    } catch { /* narration is never load-bearing */ }
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

  // Session over — check for a newer teamclaude and (for a global npm install)
  // self-update. Throttled to once/day, so this is a no-op on almost every run;
  // it applies to the NEXT launch, never the session that just ran.
  await autoUpdate({ config }).catch(() => {});

  process.exit(result.status ?? 1);
}

// Resolve `run --account <token>` the same way the server resolves a /tc-acct
// path segment (resolveAccountPin, server.js:148-156): exact name first, then
// numeric index. Exits non-zero with the valid NAMES on no match — names only,
// never a token, key, or email-derived credential.
// Config-file adapter for the LIVE server's resolveAccountPin (server.js):
// accepts a plain config object, not a running AccountManager, so the CLI can
// share the exact same pin-matching contract (accountUuid/orgUuid, accountUuid,
// orgUuid, display name, display name minus " (Org)") without a socket, a
// server instance, or a second implementation to keep in sync. Deliberately
// does NOT accept a numeric rotation index — TC_ACCT never has, because array
// position is unstable identity (test/account-pin.test.js documents why).
function resolveConfigAccountPin(config, token) {
  return resolveAccountPin({ accounts: config.accounts || [] }, token);
}

// Non-fatal pin lookup for the direct-fallback path (proxy down +
// --auto-fallback), where the pin is ignored and must not exit(1).
function tryResolveRunAccountPin(config, token) {
  if (!token) return null;
  const accounts = config.accounts || [];
  const index = resolveConfigAccountPin(config, token);
  if (index == null) return null;
  const acct = accounts[index];
  // `pin` is the stable form to EMIT (env / suggested --account); `name` stays
  // the human-readable label for stderr. See stableAccountPin.
  return { token, index, name: acct.name, pin: stableAccountPin(acct) };
}

function resolveRunAccountPin(config, token) {
  const accounts = config.accounts || [];
  const names = accounts.map(a => a.name);
  const bail = (msg) => {
    console.error(msg);
    console.error(names.length
      ? `Valid accounts: ${names.join(', ')}`
      : 'No accounts are configured. Add one with: teamclaude login');
    console.error('Accepted pin forms: accountUuid/orgUuid, accountUuid, orgUuid, or display name/email.');
    process.exit(1);
  };

  if (!token) bail('--account needs an account pin, e.g. --account work');

  const resolved = tryResolveRunAccountPin(config, token);
  if (!resolved) bail(`Unknown account pin "${token}".`);
  return resolved;
}

/** POSIX single-quote wrap so an interpolated value cannot break shell text. */
function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The fail-loud launch check. Reads Claude Code's settings tiers READ-ONLY and
// takes nothing from them but the availableModels array; the decision itself is
// pure and lives in model-preflight.js. Prints to stderr so a `--print` session's
// stdout stays clean, and exits 1 rather than spawning when a model provably
// cannot route (the asymmetry between that and the advisory client-gate warning
// is argued in model-preflight.js's header).
//
// `accountPin` and `routingApplies` are what keep the check honest about WHICH
// rules govern the launch it is judging. A pinned session bypasses selection
// entirely, and a proxy-down --auto-fallback launch bypasses teamclaude
// entirely; in neither case may the unpinned routing table refuse anything.
//
// The `--settings` scan is the same read-only discipline one level further out:
// that flag is a settings tier too, and its availableModels union in, so a
// client-allowlist veto computed without it can assert a fallback that provably
// will not happen — and then recommend, as the fix, the flag already present in
// the command line it just judged.
function runPreflight({ config, run, accountPin = null, routingApplies = true }) {
  const settings = readAvailableModels();
  for (const e of settings.errors) {
    console.error(`[TeamClaude] WARNING: could not parse ${e.path} (${e.message}) — its availableModels entries were skipped.`);
  }
  const decision = preflightModel({
    config,
    claudeArgs: run.claudeArgs,
    envModel: process.env.ANTHROPIC_MODEL || null,
    availableModels: settings.availableModels,
    flagSettings: readFlagSettingsModels(run.claudeArgs, p => readFileSync(p, 'utf8')),
    policyOverride: settings.policyOverride,
    accountPin,
    routingApplies,
    misplacedFlags: run.misplacedFlags,
    force: run.force,
    strict: run.strict,
  });
  for (const line of formatPreflight(decision)) console.error(`[TeamClaude] ${line}`);
  if (decision.blocked) process.exit(1);
}

// ── models ──────────────────────────────────────────────────

// `teamclaude models [--json]` — the model ids this proxy can actually route.
// A query command: loadConfig (never loadOrCreateConfig, which would print and
// write), payload on stdout, every caveat on stderr so the list stays pipeable.
// The list is deliberately NOT presented as complete — that framing is what
// produced the incident this branch exists for — so the un-enumerable half
// (route globs, passthrough accounts) is printed beside it, not instead of it.
async function modelsCommand() {
  const config = await loadConfig();
  if (!config) {
    process.stderr.write(`No config found at ${getConfigPath()}. Add an account first: teamclaude login\n`);
    process.exit(1);
  }
  const ns = deriveNamespace(config);

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(ns, null, 2)}\n`);
    return;
  }

  if (ns.concrete.length) {
    process.stdout.write(`${ns.concrete.join('\n')}\n`);
  } else {
    process.stderr.write('# no model id is named anywhere in this config (no modelMap keys, no models[] claims)\n');
  }
  if (ns.patterns.length) {
    process.stderr.write(`# ${ns.patterns.length} glob pattern(s) also match, and cannot be enumerated: ${ns.patterns.join(', ')}\n`);
  }
  for (const note of ns.notes) {
    for (const line of wrapForStderr(note, 96)) process.stderr.write(`# ${line}\n`);
  }
  process.stderr.write('# check any single id, listed or not:  teamclaude explain <model>\n');
}

// ── explain ─────────────────────────────────────────────────

async function explainCommand() {
  const model = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!model) {
    console.error(EXPLAIN_USAGE);
    process.exit(1);
  }
  const config = await loadConfig();
  if (!config) {
    console.error(`No config found at ${getConfigPath()}. Add an account first: teamclaude login`);
    process.exit(1);
  }
  const trace = explainRouting(config, model, { account: lastValueFlag(args.slice(1), '--account').value });
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
    return;
  }
  console.log(formatExplain(trace));
}

// ── doctor ──────────────────────────────────────────────────

// `teamclaude doctor` — a read-only consistency check over the config, plus an
// optional cross-check against Claude Code's own availableModels allowlist. It
// exists to be run unattended, so it exits with a code that distinguishes
// outcomes instead of the repo's usual 0/1: 0 clean, 2 warnings, 3 errors, and
// 1 for "could not run at all". That deviation is deliberate and documented in
// showHelp — automation must be able to tell a bad config from a bad invocation.
// Never writes anything: not the teamclaude config, and certainly not Claude
// Code's settings, which are opened read-only and yield nothing but the
// availableModels array.
async function doctorCommand() {
  const json = args.includes('--json');
  const strict = args.includes('--strict');
  const config = await loadConfig();
  if (!config) {
    console.error(`No config found at ${getConfigPath()}. Add an account first: teamclaude login`);
    process.exit(1);
  }

  const settingsPath = argValue('--claude-settings');
  let settings;
  try {
    settings = settingsPath
      ? readAvailableModelsFromFile(settingsPath)
      : readAvailableModels();
  } catch (err) {
    console.error(`Cannot read ${settingsPath}: ${err?.message || err}`);
    process.exit(1);
  }

  const findings = checkConfig(config, {
    availableModels: settings.availableModels,
    settingsSources: settings.sources,
  });
  const code = doctorExitCode(findings, { strict });

  if (json) {
    process.stdout.write(`${JSON.stringify({
      exitCode: code,
      findings,
      clientAllowlist: {
        entries: settings.availableModels ? settings.availableModels.length : null,
        sources: settings.sources.map(s => ({ tier: s.tier, path: s.path, count: s.count })),
        policyOverride: settings.policyOverride,
        errors: settings.errors,
      },
    }, null, 2)}\n`);
    process.exit(code);
  }

  for (const e of settings.errors) console.error(`Warning: could not parse ${e.path} (${e.message})`);
  console.log(`Config: ${getConfigPath()}`);
  console.log(settings.sources.length
    ? `Claude Code allowlist: ${settings.availableModels.length} entry(ies) from ${settings.sources.map(s => s.path).join(', ')}${settings.policyOverride ? ' (managed policy replaced the union)' : ''}`
    : 'Claude Code allowlist: not configured in any settings tier (the client admits any model id)');
  console.log('');
  console.log(formatFindings(findings, { strict }).join('\n'));
  process.exit(code);
}

// `teamclaude rank <model>` — offline evidence for a shadow→dynamic promotion
// decision. Loads config + the persisted quota snapshot (config.js state file,
// the same one restored on server start) and computes what legacy AND dynamic
// mode would choose right now, without making any request or mutating state.
// This is the safe way to validate dynamic ranking: it replays real, already-
// collected quota evidence rather than sending duplicate authenticated OAuth
// traffic through a second process, which can trip the same per-minute
// rate-limit a live session is using.
async function rankCommand() {
  const model = args[1];
  const json = args.includes('--json');
  if (!model || model.startsWith('--')) {
    console.error('Usage: teamclaude rank <model> [--json]');
    process.exit(1);
  }
  const config = await loadConfig();
  if (!config) {
    console.error(`No config found at ${getConfigPath()}. Add an account first: teamclaude login`);
    process.exit(1);
  }
  const saved = await loadState().catch(() => null);
  const result = replayRank(config, saved?.quota || null, model);
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(formatRankReplay(result));
}

// A single settings file named explicitly, for checking a config that is not
// this host's. Same contract as readAvailableModels: availableModels only.
function readAvailableModelsFromFile(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const list = parsed && Array.isArray(parsed.availableModels)
    ? parsed.availableModels.filter(m => typeof m === 'string')
    : null;
  return {
    availableModels: list,
    sources: list ? [{ tier: 'explicit', path, count: list.length }] : [],
    errors: [],
    policyOverride: false,
  };
}

// Greedy wrap for the `#`-prefixed stderr commentary; never splits a token.
function wrapForStderr(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let line = words.shift() || '';
  for (const w of words) {
    if (line.length + 1 + w.length > width) { out.push(line); line = w; }
    else line += ` ${w}`;
  }
  out.push(line);
  return out;
}

// ── usage ───────────────────────────────────────────────────

async function usageCommand() {
  const sub = args[1];
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE_CMD_USAGE);
    return;
  }

  if (sub === 'serve') {
    const portArg = argValue('--port') || argValue('-p') || args.find(a => a.startsWith('--port='))?.slice('--port='.length);
    const hostArg = argValue('--host') || args.find(a => a.startsWith('--host='))?.slice('--host='.length);
    const tokenArg = argValue('--token') || args.find(a => a.startsWith('--token='))?.slice('--token='.length);

    const resolvedHost = hostArg || process.env.TEAMCLAUDE_USAGE_HOST || '127.0.0.1';
    const resolvedToken = tokenArg || process.env.TEAMCLAUDE_USAGE_TOKEN || process.env.USAGE_TOKEN || null;
    const isLoopback = resolvedHost === '127.0.0.1' || resolvedHost === 'localhost' || resolvedHost === '::1';

    if (!isLoopback && !resolvedToken) {
      console.error('Error: Non-loopback usage serve requires --token <token> or TEAMCLAUDE_USAGE_TOKEN in environment.');
      process.exit(1);
    }

    const config = await loadOrCreateConfig();
    const serverInstance = createUsageServer({
      port: portArg ? Number(portArg) : undefined,
      host: hostArg,
      token: tokenArg,
      usageOptions: { config },
    });

    try {
      const bound = await serverInstance.listen();
      console.log(`TeamClaude usage server listening on http://${bound.host}:${bound.port}`);
      console.log('Endpoints:');
      console.log(`  http://${bound.host}:${bound.port}/usage  (JSON usage document)`);
      console.log(`  http://${bound.host}:${bound.port}/health (health probe)`);

      const shutdown = async () => {
        await serverInstance.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Keep event loop alive while server is listening
      await new Promise(() => {});
    } catch (err) {
      console.error(`Failed to start usage server: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  const json = args.includes('--json');
  const colorArg = argValue('--color') || args.find(arg => arg.startsWith('--color='))?.slice('--color='.length);
  const color = colorArg === 'always'
    || (colorArg !== 'never' && process.stdout.isTTY);

  try {
    const config = await loadOrCreateConfig();
    const doc = await buildUsageDocument({ config });
    if (json) {
      console.log(JSON.stringify(doc, null, 2));
      return;
    }
    console.log(formatUsageReport(doc, { color }));
  } catch (err) {
    console.error(`Failed to generate usage report: ${err.message}`);
    process.exit(1);
  }
}

// ── status ──────────────────────────────────────────────────

async function statusCommand() {
  const config = await loadOrCreateConfig();
  const url = `http://localhost:${config.proxy.port}/teamclaude/status`;
  const json = args.includes('--json');
  const colorArg = argValue('--color') || args.find(arg => arg.startsWith('--color='))?.slice('--color='.length);
  const color = colorArg === 'always'
    || (colorArg !== 'never' && process.stdout.isTTY);

  try {
    const res = await fetch(url, { headers: { 'x-api-key': config.proxy.apiKey } });
    const data = await res.json();
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(renderStatus(data, { color }));
  } catch (err) {
    console.error('Cannot connect to proxy at localhost:' + config.proxy.port);
    console.error('Is the server running? Start with: teamclaude server');
    if (err?.message) console.error(`Details: ${err.message}`);
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
    } catch {
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
    // The stable pin identity (TC_ACCT), unlike the display name above.
    if (a.accountUuid) console.log(`       ID:    ${a.accountUuid}`);
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

// ── warmup ──────────────────────────────────────────────────

async function warmupCommand() {
  const config = await loadOrCreateConfig();
  const arg = args[1];

  if (arg === undefined) {
    const cur = config.warmupSeconds || 0;
    console.log(cur > 0 ? `Keep-warm: every ${cur}s` : 'Keep-warm: off');
    console.log('Set with: teamclaude warmup <off|seconds>   e.g. teamclaude warmup 600');
    console.log('Note: warming spawns a minimal `claude` per idle account and DOES spend a little quota');
    console.log('(unlike the passive quota probe). It only warms accounts whose 5h window is idle.');
    return;
  }

  let seconds;
  if (arg === 'off' || arg === '0') {
    seconds = 0;
  } else {
    seconds = parseInt(arg, 10);
    if (Number.isNaN(seconds) || seconds < 0) {
      console.error('Usage: teamclaude warmup <off|seconds>');
      process.exit(1);
    }
    if (seconds > 0 && seconds < 60) {
      console.error('Minimum keep-warm interval is 60s.');
      process.exit(1);
    }
  }

  config.warmupSeconds = seconds;
  await saveConfig(config);
  console.log(seconds > 0
    ? `Keep-warm set to every ${seconds}s (spawns a minimal \`claude\` per idle account; spends a little quota).`
    : 'Keep-warm disabled.');
  await notifyRunningServer(config);
}

// ── update ──────────────────────────────────────────────────

async function updateCommand() {
  const cur = currentVersion();
  console.log(`Current version: ${cur || 'unknown'}`);

  const kind = installKind();
  if (kind === 'git') {
    console.log('This is a git checkout — update it with `git pull`, not npm.');
    return;
  }

  const info = await checkForUpdate({ force: true });
  if (!info) {
    console.error('Could not reach the npm registry to check for updates.');
    process.exitCode = 1;
    return;
  }
  if (!info.updateAvailable) {
    console.log(`Already up to date (latest is ${info.latest}).`);
    return;
  }

  console.log(`Updating ${info.current} → ${info.latest} …`);
  const ok = runUpdate(info.latest);
  if (ok) {
    console.log(`Updated to ${info.latest}. Restart teamclaude to use the new version.`);
  } else {
    console.error(`Update failed. Try manually: npm install -g ${PKG_NAME}@latest`);
    process.exitCode = 1;
  }
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

// ── route ───────────────────────────────────────────────────

function splitList(value) {
  return (value || '').split(',').map(s => s.trim()).filter(Boolean);
}

async function routeCommand() {
  const sub = args[1] || 'list';
  const config = await loadOrCreateConfig();
  config.routes = Array.isArray(config.routes) ? config.routes : [];

  if (sub === 'list') {
    if (!config.routes.length) { console.log('No routes configured.'); return; }
    for (const r of config.routes) {
      const match = (Array.isArray(r.match) ? r.match : [r.match]).join(', ');
      const accts = (r.accounts && r.accounts.length) ? r.accounts.join(', ') : '(all accounts)';
      const bucket = r.bucket ? `  bucket=${r.bucket}` : '';
      const color = r.color ? `  color=${r.color}` : '';
      console.log(`${r.name || '(unnamed)'}: ${match} → ${accts}${bucket}${color}`);
    }
    return;
  }

  if (sub === 'add') {
    const name = args[2] && !args[2].startsWith('--') ? args[2] : null;
    const match = splitList(argValue('--match'));
    const accounts = splitList(argValue('--accounts'));
    const bucket = argValue('--bucket');
    const color = argValue('--color');
    if (!name || !match.length) {
      console.error(ROUTE_USAGE);
      process.exit(1);
    }
    if (color && !ROUTE_COLORS.includes(color.toLowerCase())) {
      console.error(`Unknown color "${color}" — expected one of: ${ROUTE_COLORS.join(', ')}`);
      process.exit(1);
    }
    const known = new Set(config.accounts.map(a => a.name));
    for (const a of accounts) {
      if (!known.has(a) && !/^\d+$/.test(a)) console.error(`Warning: no account named "${a}" (yet)`);
    }
    const route = { name, match };
    if (accounts.length) route.accounts = accounts;
    if (bucket) route.bucket = bucket;
    if (color) route.color = color.toLowerCase();
    const at = config.routes.findIndex(r => r.name === name);
    if (at >= 0) { config.routes[at] = route; console.log(`Updated route "${name}"`); }
    else { config.routes.push(route); console.log(`Added route "${name}"`); }
    await saveConfig(config);
    await notifyRunningServer(config);
    return;
  }

  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const name = args[2];
    const before = config.routes.length;
    config.routes = config.routes.filter(r => r.name !== name);
    if (config.routes.length === before) { console.error(`Route "${name}" not found`); process.exit(1); }
    await saveConfig(config);
    await notifyRunningServer(config);
    console.log(`Removed route "${name}"`);
    return;
  }

  console.error(ROUTE_USAGE);
  process.exit(1);
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
  env [--no-mitm]     Print export lines to point Claude Code at the proxy, for
                      'eval "$(teamclaude env)"' (MITM forward-proxy by default;
                      --no-mitm for base-URL only; --account <name> to pin).
                      Handy for agent multiplexers that spawn claude themselves
                      instead of via 'teamclaude run'
  run [--account <name>] [--no-mitm] [--auto-fallback] [-- args...]
                      Run Claude Code through the proxy (errors if it's down,
                      unless --auto-fallback launches claude directly instead).
                      Routes via an HTTPS forward proxy + local CA by default, so
                      even hardcoded api.anthropic.com endpoints are intercepted;
                      --no-mitm uses base-URL routing only. Set TC_ACCT (or
                      --account <name>, which sets it) to pin the session to one
                      account; the model in '-- --model <id>' is checked before
                      claude starts (see Environment below)
  alias               Print a shell alias so plain 'claude' routes via the proxy
                      (--install to write it to your shell rc; --uninstall to remove)
  status [--json]     Show rich proxy/account/probe status (live)
                      Use --color=always|never to control ANSI colors
  usage [--json]      Aggregate quota, state files, soak/burn history & model routing
  usage serve         Start loopback HTTP server exposing /usage & /health
                      (--port <port>, --host <host>)
  accounts            List configured accounts
  remove <name>       Remove an account (by name or email; --org to disambiguate)
  disable <name>      Temporarily exclude an account from rotation
  enable <name>       Re-enable a disabled account (also clears a stuck error)
  priority <name> <n> Set rotation priority (lower = preferred; --first/--last)
  route [list|add|rm] Per-model routing: pin model globs to specific accounts
                      (add <name> --match "<glob>" [--accounts "<name>"] [--bucket <b>])
  models [--json]     List the model ids this proxy can actually route, derived
                      from routes, per-account 'models' claims, and modelMap keys
                      (never a complete list — globs and passthrough accounts
                      serve ids that appear nowhere in the config)
  explain <model>     Show how a request for <model> would route: which route
                      wins, which routes it shadows, which accounts are eligible
                      and why the rest are not, and the failover chain
                      (--account <name> traces it under a pin; --json)
  doctor [--json]     Check routes, modelMap keys, models[] claims and Claude
                      Code's availableModels for dead or conflicting config
                      (--strict, --claude-settings <file>; exit codes below)
  rank <model>        Offline legacy-vs-dynamic routing decision, replayed from
                      the persisted quota snapshot (no request, no mutation;
                      --json). Evidence for a shadow -> dynamic promotion.
  probe [off|secs]    Opt-in background quota refresh for idle accounts
                      (off by default; reads usage endpoint, spends no quota)
  warmup [off|secs]   Opt-in: keep idle accounts' 5h timers running by sending
                      a minimal claude request to each (off by default; spends
                      a little quota, unlike probe)
  api <path>          Call an API endpoint with account credentials
  update              Check npm for a newer teamclaude and install it
  version             Print the installed version
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --org NAME|UUID     Disambiguate when an email spans multiple orgs (remove/priority/api)
  --from PATH         Credentials path (import, default: ~/.claude/.credentials.json)
  --json JSON         Import from inline JSON (import), e.g.:
                      --json '{"accessToken":"...","refreshToken":"...","expiresAt":1234}'
  --log-to DIR        Log full requests/responses to DIR (server, one file per request)
  --activity-log FILE Append TUI activity lines to FILE (server; works in headless mode too)
  --headless          Run the server without the interactive TUI (for backgrounding)
  --no-mitm           (run) skip the forward proxy; route via ANTHROPIC_BASE_URL only
  --auto-fallback     (run) if the proxy is down, launch claude directly instead
                      of erroring out (bypasses the proxy: no rotation)
  --account NAME      (run/env) sugar for TC_ACCT: pin the session to one
                      account — no rotation, no failover (account name or index;
                      --account=N works too; index is resolved to the account
                      name before setting TC_ACCT). A pinned launch is checked
                      against THAT account, not the routing rules the pin bypasses
  --force             (run) launch anyway despite the one blocking preflight
                      finding (a model that provably cannot route). teamclaude's
                      own flag, so it must come BEFORE the '--' separator
  --strict            (run) also block when Claude Code's own availableModels
                      would veto the model; (doctor) exit 3 on warnings too
  --no-preflight      (run) skip the model check before launching claude
  --no-launch-line    (run) suppress the one-line summary of where this session's
                      traffic will go, printed on stderr before claude starts
  --claude-settings FILE
                      (doctor) cross-check against this settings file instead of
                      the ones Claude Code would load (read-only, either way)

Environment:
  TC_ACCT             Pin a session to ONE account, bypassing rotation. Works in
                      both modes. Accepts accountUuid, orgUuid,
                      accountUuid/orgUuid, or a display name/email:
                        TC_ACCT=me@example.com teamclaude run
                      Prefer a UUID for anything scripted: display names are
                      rewritten when an email gains a second org. Read by 'run'
                      and 'env', then removed from the environment so it never
                      reaches claude or the tools it spawns. An unknown account
                      is refused rather than silently rotated. '--account <name>'
                      is sugar for the same pin (resolves index→name, then sets
                      TC_ACCT for the launch).
  TEAMCLAUDE_CONFIG   Path to the config file (default below)
  TEAMCLAUDE_DISABLE_AUTOUPDATE=1
                      Skip the background self-update check

The server always accepts both base-URL and proxy/CONNECT clients, so instances
launched with and without --no-mitm can share one server.

'run' checks the model before it starts claude, because Claude Code will not: a
--model it refuses is advisory at launch — warned in-band, never on stderr,
never fatal — so a session silently runs on the default model instead. Exactly
ONE thing blocks a launch: a model this proxy provably cannot serve (--force
overrides, before the '--'). A repeated --model warns and names the winner but
never blocks — a wrapper appending a second one is how an override is expressed.
A model only Claude Code's own allowlist would veto warns in one line, since
that mirrors one client build (--strict promotes it). An account name is not a
model id — use --account, which is also what the preflight then checks against.

'doctor' exits 0 clean, 2 warnings, 3 errors, and 1 when it could not run at all
(no config, unreadable file, bad usage), so a cron job can tell a bad config
from a bad invocation. teamclaude never writes ~/.claude/settings.json; doctor
opens it read-only and reads nothing from it but availableModels.

A running server re-syncs accounts from config on POST /teamclaude/reload
(local only). add/login/enable/disable/priority trigger it automatically.

A global npm install self-updates in the background (checked once/day, applied
on the next launch). Disable with TEAMCLAUDE_DISABLE_AUTOUPDATE=1 or
"autoUpdate": false in the config.

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

// ── helpers ─────────────────────────────────────────────────

// Is `url` a /tc-acct/<name> account pin aimed at OUR proxy? Parsed rather than
// prefix-matched so every local spelling counts (localhost, 127.0.0.1, [::1]),
// while a pin URL for a different host/port is not ours to honour.
function isLocalAccountPin(url, port) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  // An omitted port means the scheme default, which still matches a proxy that
  // happens to run on 80/443.
  const urlPort = u.port || (u.protocol === 'https:' ? '443' : '80');
  return isLocal && urlPort === String(port) && u.pathname.startsWith('/tc-acct/');
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
}

// Hostname of the configured upstream (the host MITM-intercepts under `run`).
function upstreamHost(config) {
  try { return new URL(config.upstream || 'https://api.anthropic.com').hostname; }
  catch { return 'api.anthropic.com'; }
}

// Keep the terminal title in sync with the active account (e.g. "teamclaude 2/4
// work") so a backgrounded or tabbed `teamclaude server` is glanceable. TTY-only
// — never emit escapes into a pipe, a `--log-to` redirect, or a systemd journal;
// opt out entirely with TEAMCLAUDE_NO_TITLE. Polls (rather than hooking every
// currentIndex mutation) and writes only when the title actually changes.
// Returns an idempotent stop() that restores the shell's previous title.
function startTerminalTitleUpdater(accountManager) {
  const out = process.stdout;
  if (!out.isTTY || process.env.TEAMCLAUDE_NO_TITLE) return () => {};

  let last = null;
  const render = () => {
    const total = accountManager.accounts.length;
    const index = Math.min(accountManager.currentIndex || 0, Math.max(0, total - 1));
    const name = accountManager.accounts[index]?.name || null;
    const title = formatTerminalTitle({ index, total, name });
    if (title !== last) { last = title; out.write(titleSequence(title)); }
  };

  out.write(TITLE_STACK_PUSH); // save whatever title the shell had
  render();
  const timer = setInterval(render, 2000);
  timer.unref?.();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try { out.write(TITLE_STACK_POP); } catch { /* terminal gone */ }
  };
  process.on('exit', stop); // backstop for exits that bypass shutdown()
  return stop;
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
