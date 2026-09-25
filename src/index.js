#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { loadOrCreateConfig, loadConfig, saveConfig, atomicConfigUpdate, getConfigPath, getCrashLogPath, loadState, saveState } from './config.js';
import { installCrashHandlers } from './crash-log.js';
import { AccountManager, distributionMode, accountRouting } from './account-manager.js';
import { validateAdaptiveConfig } from './adaptive-distribution.js';
import { createProxyServer } from './server.js';
import { importCredentials, loginOAuth, loginOAuthWithPastedCode, fetchProfile, profileForCredentials, refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import {
  sameIdentity,
  orgKey,
  matchAccounts,
  findUpsertTarget,
  updateAccountEntry,
  canUpsertOAuthAccount,
  isTokenRejection,
  oauthIdentityFields,
} from './identity.js';
import { resolveAccounts } from './resolve-accounts.js';
import { loginCodex } from './codex-auth.js';
import { providerOf } from './provider.js';
import { syncAccountsFromDisk } from './sync-accounts.js';
import { mergeAccountsForSave, syncRefreshedTokens, removedAccountIds, clearRemovedAccountIds } from './account-pairing.js';
import { ensureAccountIds } from './account-id.js';
import * as alias from './alias.js';
import { ensureCerts, mitmHosts } from './mitm.js';
import { Prober } from './prober.js';
import { ResetCreditRedeemer } from './codex-reset-credits.js';
import { Warmer } from './warmer.js';
import { formatWarmupScheduleConfirmation, resolveWarmupConfig } from './warmup-schedule.js';
import { TUI } from './tui.js';
import { SessionTitles } from './session-titles.js';
import { captureEarlyConsole } from './early-log.js';
import { RemoteControl, createAttachSession } from './tui-remote.js';
import { SxManager } from './sx.js';
import { autoUpdate, checkForUpdate, currentVersion, resolveVersionLabel, runUpdate, installKind, updateAvailableFromCache, PKG_NAME } from './updater.js';
import { renderStatus, formatPercent } from './status-renderer.js';
import { sanitizeText } from './safe-text.js';
import { ClientUsageTracker, UsageDimensionTracker } from './client-usage.js';
import { buildClaudeEnvLines, bypassesAllHosts, clearSelfProxyEnvLines, encodePinComponent, mergeNoProxy, resolveClientMode } from './claude-env.js';
import { serviceKind, installService, uninstallService, serviceStatus, renderService, logPath } from './service.js';
import { formatTerminalTitle, titleSequence, TITLE_STACK_PUSH, TITLE_STACK_POP } from './terminal-title.js';
import { getUpstreamProxy, describeProxy, describeSelfProxy, localListener, isSelfProxy } from './upstream-proxy.js';
import { parseRoutingUrl, routingToUrl, describeRouting, checkRouting } from './account-routing.js';
import { proxyFetch } from './upstream-fetch.js';
import { upstreamFor } from './provider.js';
import { startEventLoopMonitor } from './event-loop-monitor.js';
import {
  ConfigOpError,
  DISTRIBUTE_MODES,
  removeRoute,
  setBucketThresholds,
  setDistribution,
  setProbeSeconds,
  setThreshold,
  setWarmupSchedule,
  setWarmupSeconds,
  thresholdRatio,
  thresholdTable,
  upsertRoute,
} from './config-ops.js';
/** @typedef {import('./types.js').CodedError} CodedError */

// These constants are referenced by routeCommand, which the dispatch below
// reaches through a top-level `await`. The await suspends module evaluation at
// the switch, so a const declared under the switch is still in the temporal
// dead zone when the command body runs — keep them above the dispatch.
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

const THRESHOLD_USAGE = [
  'Usage: teamclaude threshold                 (show the current thresholds)',
  '       teamclaude threshold <1-100>         (one number for every bucket)',
  '       teamclaude threshold <bucket>=<1-100> [...]',
  '       teamclaude threshold <bucket>=default (drop that bucket)',
  '',
  'The utilization at which rotation stops sending work to an account. Tenths of',
  'a percent are kept, as on the TUI settings screen. Changes apply to a running',
  'server immediately.',
].join('\n');

const DISTRIBUTE_USAGE = 'Usage: teamclaude distribute <on|off|adaptive>';

const ROUTING_USAGE = [
  'Usage: teamclaude routing <account-name|email> [--check]      (show the account\'s routing; --check tests it)',
  '       teamclaude routing <account-name|email> <url>          (set it; --no-check skips the proxy test)',
  '       teamclaude routing <account-name|email> none           (clear it)',
  '',
  'One account\'s own egress proxy: EVERY connection made for that account —',
  'completions, token refresh, profile and quota — tunnels through it, and no',
  'other account is touched. Schemes: http (CONNECT), socks4, socks4a, socks5,',
  'socks5h; the a/h forms resolve hostnames at the proxy. Optional user:pass@',
  'auth, e.g. socks5h://alice:s3cret@proxy.example.com:1080. A bare host:port',
  'is http. A new URL is tested first (a tunnel to the account\'s upstream; no',
  'request is sent) and refused if the proxy does not answer. Changes apply to a',
  'running server immediately.',
].join('\n');

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
  case 'attach':
    await attachCommand();
    process.exit(0);
    break;
  case 'dashboard':
    await dashboardCommand();
    process.exit(0);
    break;
  case 'accounts':
    await accountsCommand();
    process.exit(0);
    break;
  case 'switch':
    await switchCommand();
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
  case 'service':
    await serviceCommand();
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
  case 'threshold':
    await thresholdCommand();
    process.exit(0);
    break;
  case 'distribute':
    await distributeCommand();
    process.exit(0);
    break;
  case 'route':
  case 'routes':
    await routeCommand();
    process.exit(0);
    break;
  case 'routing':
    await routingCommand();
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
  // Installed first: the server is the long-lived process, it runs under a TUI
  // that repaints over anything Node prints on the way out, and a crash here
  // takes every routed session with it. Without this, a proxy that vanished
  // overnight leaves nothing behind to explain why.
  const crashLog = getCrashLogPath();
  installCrashHandlers(crashLog);
  // Same motive as the crash log: when the process is wedged, the status
  // endpoint cannot say so. The monitor leaves the evidence (one bounded warning
  // per stall in the service log, lag figures under `server.eventLoop`).
  const eventLoopMonitor = startEventLoopMonitor();

  // With a TUI coming, hold what startup prints until the TUI owns the console,
  // then replay it into the activity pane (and its log file) — see early-log.js.
  // The same test `useTUI` applies below, taken here because the first lines are
  // printed long before that one is reached.
  const tuiExpected = !(args.includes('--headless') || args.includes('--no-tui'))
    && process.stdout.isTTY && process.stdin.isTTY;
  const earlyConsole = tuiExpected ? captureEarlyConsole() : null;

  const config = await loadOrCreateConfig();
  // Token writes below pair rows by entry id against a re-read of the file, so
  // the ids have to be on disk before the first refresh, not just in memory.
  await persistMintedAccountIds(config);

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
  // Fatal on purpose, like a bad `upstreamProxy`: a NaN or out-of-range value
  // in this block would not crash the router, it would make every adaptive
  // score NaN and silently fall through to even distribution, with nothing
  // pointing at the field that caused it. Checked whether or not the mode is
  // on, so `teamclaude distribute adaptive` later cannot activate a bad block.
  let adaptive;
  try {
    adaptive = validateAdaptiveConfig(config.adaptiveDistribution);
  } catch (err) {
    console.error(`[TeamClaude] Bad adaptiveDistribution setting in ${getConfigPath()}: ${err.message}`);
    process.exit(1);
  }
  const accountManager = new AccountManager(accounts, threshold, { routes: config.routes, ramp: config.stormRamp, distributeSessions: config.distributeSessions, expiryRouting: config.expiryRouting, adaptive, listener: localListener(config) });
  // Names the activity log's session column from Claude Code's own on-disk
  // session titles. Built whether or not the TUI runs, so a reload has one
  // object to reconfigure.
  const sessionTitles = new SessionTitles(config.sessionTitles);

  // Restore quota observed in a previous run so a restart doesn't lose rotation
  // state (passive — we never call the API to re-learn it). Stale windows are
  // cleared automatically on first use by _clearExpiredQuotas.
  const savedState = await loadState().catch(err => {
    console.error(`[TeamClaude] Could not read saved state: ${err.message}`);
    return null;
  });
  if (savedState?.quota) accountManager.restoreQuotaState(savedState.quota);

  // Per-client usage (proxy.clientKeys). Restored alongside quota so the
  // per-client counters survive a restart the same way rotation state does.
  const clientUsage = new ClientUsageTracker();
  if (savedState?.clients) clientUsage.restore(savedState.clients);
  const dimensionUsage = new UsageDimensionTracker();
  if (savedState?.usageDimensions) dimensionUsage.restore(savedState.usageDimensions);

  // With quota restored, pick the best account up front (highest priority /
  // soonest-resetting weekly window) instead of defaulting to the first one.
  accountManager.selectActiveAccount();

  // Periodically persist quota (and once more on shutdown) to the state file.
  const persistQuotaState = () =>
    saveState({ quota: accountManager.exportQuotaState(), clients: clientUsage.export(), usageDimensions: dimensionUsage.export() })
      .catch(err => console.error(`[TeamClaude] Failed to save quota state: ${err.message}`));
  let quotaSaveInterval = null;

  // Persist refreshed tokens back to config (re-read from disk to avoid clobbering
  // accounts added externally, e.g. by `teamclaude import` while server is running)
  accountManager.onTokenRefresh((idx, newTokens) => {
    const account = accountManager.accounts[idx];
    if (!account) return;
    // Keep config.accounts in sync so the TUI save does not clobber fresh tokens.
    // A -1 means no config entry pairs with this account and the in-memory copy
    // keeps what it had; the disk write below is unaffected either way, since it
    // resolves its own row through findConfigAccount rather than this pairing.
    syncRefreshedTokens(config.accounts, accountManager.accounts, idx, newTokens);
    atomicConfigUpdate(diskConfig => {
      // Pick up any new accounts from disk so the running fleet serves them
      // (only add, don't refresh credentials — we're about to write the authoritative tokens)
      const removed = removedAccountIds(config);
      for (const diskAcct of diskConfig.accounts) {
        // A row the TUI is in the middle of removing is not a new account (#422).
        if (diskAcct?.id && removed.has(diskAcct.id)) continue;
        const known = config.accounts.some(a => sameIdentity(a, diskAcct));
        if (!known) {
          // Same object into both lists, so the account carries its entry's id;
          // ensureAccountIds first, in case the entry brought in one this list
          // already uses. See the matching add in sync-accounts.js.
          config.accounts.push(diskAcct);
          ensureAccountIds(config.accounts);
          accountManager.addAccount(diskAcct);
        }
      }
      // By entry id only — the index may have shifted, and identity is not
      // one-to-one (see findConfigAccount). No row: nothing is written.
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
  // Opt-in keep-warm scheduler (interval or persisted reset-target schedule).
  let warmer = null;
  const serverStartedAt = Date.now();
  // Read once here, not per request: `teamclaude update` swaps package.json on
  // disk while this process keeps running the old code, and status must report
  // what is running, not what is installed.
  const serverVersion = currentVersion();
  // What the header names this build, and whether the last recorded check saw
  // something newer. A checkout gets no update marker: autoUpdate refuses to
  // npm-install over one, so offering it would advertise a declined action.
  const { label: versionLabel, git: fromGit } = await resolveVersionLabel();
  const updateAvailable = !fromGit && await updateAvailableFromCache({ current: serverVersion });

  // sx.org proxy (IP-based-429 workaround). Dormant unless an API key is set in
  // config.sx.apiKey; when set we provision a proxy and route upstream through it.
  // Resolved per call, not captured. This manager speaks when it provisions,
  // and the provisioning just below is the only one that happens here — at
  // startup, with no TUI yet to paint over the answer. Every later one is
  // triggered from inside a running TUI: the settings screen's `sx.configure`
  // and `sx.setMode`, and the key/mode change picked up by `reloadAccounts`.
  // By then `tui.start()` has swapped `console.error` for the activity log, so
  // handing over the function object here would bind the pre-TUI console and
  // put "sx.org proxy ready" / "provisioning failed" on a terminal the
  // alternate screen has already covered.
  const sx = new SxManager({ log: line => console.error(line) });
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
    // Pick up client-key edits (proxy.clientKeys is read live by both auth
    // gates through the shared config object, so refreshing it here is all a
    // key add/rotate/revoke needs — no restart).
    if (config.proxy && diskConfig.proxy) {
      config.proxy.clientKeys = diskConfig.proxy.clientKeys;
      // Dimensions are resolved per request from this same object, so a
      // reload adds or drops one without a restart.
      config.proxy.usageDimensions = diskConfig.proxy.usageDimensions;
      config.proxy.sessionDetail = diskConfig.proxy.sessionDetail;
      // The shared key is read per request too, so a rotated key on disk
      // takes effect on reload the same way.
      config.proxy.apiKey = diskConfig.proxy.apiKey;
    }
    // The MCP endpoint's mode: read per request, so this is what opens,
    // narrows or closes it without a restart. Outside the guard above on
    // purpose: an operator who deletes the whole `proxy` section has asked for
    // the endpoint to be off as surely as one who deletes the key, and leaving
    // the old mode in memory would keep it served.
    if (config.proxy) config.proxy.mcp = diskConfig.proxy?.mcp;
    // Pick up route table edits (teamclaude route …, TUI editor, or a hand edit).
    config.routes = diskConfig.routes || [];
    accountManager.setRoutes(config.routes);
    // Pick up a distributeSessions change (hand edit or another writer) the same
    // way routes, sx, probe and warmup are picked up below.
    // Not coerced to a boolean: 'adaptive' is a third mode, and !! would flatten
    // it to plain even distribution on every config reload.
    config.distributeSessions = diskConfig.distributeSessions ?? false;
    accountManager.setDistributeSessions(config.distributeSessions);
    // Pick up a switchThreshold change the same way (teamclaude threshold, the
    // TUI settings screen, or a hand edit). thresholdFor() reads it off the
    // manager on every decision, so assigning it is the whole application —
    // and without this a change from outside the TUI waited for a restart.
    if (diskConfig.switchThreshold != null) {
      config.switchThreshold = diskConfig.switchThreshold;
      accountManager.switchThreshold = diskConfig.switchThreshold;
    }
    // Pick up expiry-routing edits the same way, so the knob hot-applies.
    config.expiryRouting = diskConfig.expiryRouting;
    accountManager.setExpiryRouting(config.expiryRouting);
    config.sessionTitles = diskConfig.sessionTitles;
    sessionTitles.configure(config.sessionTitles);
    // Both are read per request off this object (server.js) and the TUI already
    // persists them; without this a hand edit or another writer waited for a restart.
    config.eventLogging = diskConfig.eventLogging || 'hide';
    // Read by the TUI on every frame, so a hand edit lands on the next reload.
    config.quotaBarPercent = diskConfig.quotaBarPercent !== false;
    // Read by `run`/`env` from disk, but the TUI settings screen shows it live.
    config.defaultClientMode = diskConfig.defaultClientMode === 'base-url' ? 'base-url' : 'mitm';
    // The fleet switch for spending Codex reset credits. The redeemer reads it
    // off this object per refusal, so the assignment is the whole application —
    // and this one has to hot-apply in particular: "stop spending credits" must
    // not wait for a restart.
    config.autoRedeemResets = diskConfig.autoRedeemResets === true;
    config.blockedModels = Array.isArray(diskConfig.blockedModels) ? diskConfig.blockedModels : [];
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
      const diskSchedule = diskConfig.warmupSchedule || null;
      const ms = (diskConfig.warmupSeconds || 0) * 1000;
      if (diskSchedule) {
        // Validate and arm before publishing the disk value to live readers. A
        // bad hand edit leaves the prior schedule intact and makes reload fail.
        warmer.rescheduleSchedule(diskSchedule);
        config.warmupSchedule = diskSchedule;
        config.warmupSeconds = 0;
      } else if (config.warmupSchedule || ms !== warmer.intervalMs) {
        warmer.reschedule(ms);
        delete config.warmupSchedule;
        config.warmupSeconds = diskConfig.warmupSeconds || 0;
      }
    }
    return added;
  };

  // The account half of a save. The TUI's save below starts with it, and the
  // MCP endpoint uses it alone: an account changed there is changed in-process,
  // on a server that may have no TUI to save for it, and writing the settings
  // too would pin this server's resolved defaults into a file that never
  // spelled them out.
  const mergeAccountsOnto = (/** @type {Record<string, any>} */ diskConfig) => {
    diskConfig.accounts = mergeAccountsForSave(
      config.accounts, accountManager.accounts, diskConfig.accounts, removedAccountIds(config),
    );
    // The written list omits them, so they are gone from disk too and there
    // is nothing left to re-adopt. Holding the ids any longer would only
    // refuse an account the operator re-adds later.
    clearRemovedAccountIds(config);
  };

  let tui = null;
  /** @type {Record<string, any>} */
  let hooks = {};

  if (useTUI) {
    tui = new TUI({
      accountManager, config, sx, activityLogPath, sessionTitles, versionLabel, updateAvailable,
      saveConfig: () => atomicConfigUpdate(async diskConfig => {
        mergeAccountsOnto(diskConfig);
        // Persist sx.org settings (set/cleared from the TUI settings screen).
        if (config.sx) diskConfig.sx = config.sx; else delete diskConfig.sx;
        // Persist other runtime-tunable settings edited from the TUI.
        if (config.switchThreshold != null) diskConfig.switchThreshold = config.switchThreshold;
        if (config.quotaProbeSeconds != null) diskConfig.quotaProbeSeconds = config.quotaProbeSeconds;
        if (config.warmupSeconds != null) diskConfig.warmupSeconds = config.warmupSeconds;
        // The telemetry mode and the model blocklist are edited from the settings
        // screen too; the server reads them live from `config`, but without this
        // the edit never reached disk and was silently undone by the next start.
        if (config.eventLogging != null) diskConfig.eventLogging = config.eventLogging;
        if (config.quotaBarPercent != null) diskConfig.quotaBarPercent = config.quotaBarPercent;
        if (config.defaultClientMode != null) diskConfig.defaultClientMode = config.defaultClientMode;
        if (config.autoRedeemResets != null) diskConfig.autoRedeemResets = config.autoRedeemResets;
        if (config.blockedModels != null) diskConfig.blockedModels = config.blockedModels;
        if (config.sessionTitles != null) diskConfig.sessionTitles = config.sessionTitles;
        // Persist the route table (edited from the TUI routes screen).
        if (config.routes != null) diskConfig.routes = config.routes;
      }),
      syncAccounts: reloadAccounts,
      // `l` key: browser login for the chosen account's provider, from inside
      // the running server. Same upsert the CLI uses — the account the BROWSER
      // signed in as is the one that gets the tokens, whichever row was picked —
      // then an in-process reload instead of the CLI's HTTP notify. Never exits:
      // a failed login is a line in the activity pane, not the end of the proxy.
      loginAccount: async (/** @type {Record<string, any>} */ account) => {
        const outcome = account && providerOf(account) === 'codex'
          ? await upsertCodexAccount(undefined, await loginCodex({ showUrl: false }), null, false)
          : await upsertOAuthAccount(undefined, await loginOAuth({ interactive: false }), 'login', null, false, { fatal: false, notify: false });
        await reloadAccounts();
        return outcome;
      },
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
    // 0600, matching the request log and the config (see tui.js for why).
    const aStream = createWriteStream(activityLogPath, { flags: 'a', mode: 0o600 });
    aStream.on('error', err => process.stderr.write(`[TeamClaude] activity log error: ${err.message}\n`));
    const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false });
    const writeActivity = msg => {
      // Strip [TeamClaude] prefix to match TUI behaviour. Sanitized because a
      // log line is one line: a value carrying a newline would otherwise write
      // a second entry that reads as genuine, and this file is what deployments
      // join against to attribute traffic to a person.
      aStream.write(`${ts()}  ${sanitizeText(msg.replace(/^\[TeamClaude\]\s*/, ''))}\n`);
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
      const sid = info.sessionId ? `${info.sessionId.slice(0, 6)} ` : '';
      const client = (info.client || r?.client) ? `[${info.client || r.client}] ` : '';
      const pin = (info.pinned || r?.pinned) ? ' [pin]' : '';
      writeActivity(`${client}${sid}${info.method} ${info.path}${model} → ${acct}${pin} (${info.status}, ${dur}s)`);
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
  hooks.persistAccounts = () => atomicConfigUpdate(mergeAccountsOnto);
  // Whether one of a Codex account's free rate-limit reset credits should be
  // spent to undo a spent weekly window. Wired as a hook rather than reached
  // from the request path directly: the forwarding path stays ignorant of a
  // provider's billing features, and a server built without it (every test that
  // is not about redemption) simply refuses as before. The shared config, so the
  // fleet switch (`autoRedeemResets`) is read live — a TUI toggle or a reload
  // binds on the next refusal, not the next restart.
  const redeemer = new ResetCreditRedeemer(accountManager, { config });
  hooks.redeemCodexResetForPool = (/** @type {Record<string, any>[]} */ accounts) => redeemer.maybeRedeemForPool(accounts);
  hooks.getStatusExtra = () => ({
    // Read live from the shared config (not a startup snapshot) so the TUI's
    // blocklist editor shows up in `status` immediately, the same way the
    // per-request gate in server.js picks it up.
    blockedModels: [...(config.blockedModels || [])],
    // Per-client usage (proxy.clientKeys) — empty object when unconfigured.
    clients: clientUsage.export(),
    // Per-dimension usage (proxy.usageDimensions) — empty when unconfigured.
    usageDimensions: dimensionUsage.export(),
    server: {
      version: serverVersion,
      versionLabel,
      updateAvailable,
      startedAt: new Date(serverStartedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - serverStartedAt) / 1000),
      port,
      upstream: config.upstream || 'https://api.anthropic.com',
      eventLoop: eventLoopMonitor.status(),
    },
    probe: prober?.getStatus() || {
      enabled: false,
      intervalSeconds: config.quotaProbeSeconds || 0,
      running: false,
      accounts: accountManager.accounts.map(account => ({
        name: account.name,
        // Same rule as Prober._isProbeTarget: a third-party backend has no
        // Anthropic usage to read, so it is not-applicable rather than pending.
        status: (account.type === 'oauth' && !account.upstream) ? 'never' : 'not-applicable',
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
  hooks.getQuotaExtra = () => ({ warmup: resolveWarmupConfig(config) });

  const server = createProxyServer(accountManager, config, hooks, sx, clientUsage, dimensionUsage, { bindHost });
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
    // Announce an egress proxy, especially one inherited from the environment:
    // it changes where every upstream byte goes, and a value nobody typed here
    // should never be in force silently.
    const egressProxy = getUpstreamProxy();
    if (egressProxy.proxy) {
      const via = egressProxy.source.startsWith('env:') ? ` (from ${egressProxy.source.slice(4)})` : '';
      console.log(`[TeamClaude] Upstream proxy: ${describeProxy(egressProxy.proxy)}${via}`);
    } else if (egressProxy.source === 'self') {
      // Almost always a shell that ran `eval "$(teamclaude env)"` before starting
      // the server. Silently going direct is right; saying nothing is not.
      console.log(`[TeamClaude] Upstream proxy: direct — ${describeSelfProxy(egressProxy)}`);
    }
    if (tui) {
      const held = earlyConsole?.release() ?? [];
      tui.start();
      // In the order they were said, ahead of the line that follows them.
      for (const line of held) console.log(line);
      console.log(`Listening on port ${port} with ${accounts.length} account(s)`);
    } else {
      // Same test as `tuiExpected`, so this holds nothing; released all the same
      // so a line can never stay held if the two ever come to disagree.
      for (const line of earlyConsole?.release() ?? []) console.log(line);
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
  prober = new Prober(accountManager, {
    intervalMs: (config.quotaProbeSeconds || 0) * 1000,
    profileFn: fetchProfile,
  });
  // The web dashboard's one-shot probe button uses the same zero-spend action
  // as the TUI's `p` key. Assigned after construction because the hook object
  // is already shared with the server created above.
  hooks.probeQuota = () => prober?.probeAll();
  prober.start();
  // A money cap (accounts[].maxSpend) is judged against the month-to-date
  // figure only the probe refreshes — a response carries none — so with the
  // probe off it binds only after a manual `p` refresh. Said once at start,
  // like the config warnings in config-ops.js, rather than silently leaving a
  // budget unenforced.
  if (!(config.quotaProbeSeconds > 0) && accountManager.accounts.some(a => a.maxSpend != null)) {
    console.error('[TeamClaude] accounts[].maxSpend is set but the quota probe is off (quotaProbeSeconds = 0) — the spend figure it is judged against is only refreshed by the probe, so the cap only binds after a manual `p` refresh; run `teamclaude probe <seconds>`');
  }

  // Start the opt-in keep-warm scheduler. Interval mode runs relative to server
  // startup; reset-target modes restore their next occurrence from config.
  warmer = new Warmer(accountManager, {
    intervalMs: (config.warmupSeconds || 0) * 1000,
    schedule: config.warmupSchedule || null,
    port,
    apiKey: config.proxy?.apiKey,
  });
  warmer.start();

  // Background self-update for a backgrounded (headless) server. Skipped under
  // the TUI, where npm's install output would corrupt the display — interactive
  // users update via `teamclaude run` (post-session) or `teamclaude update`.
  // Not awaited, and nothing inside it is synchronous: the npm probe and the
  // install are child processes the loop runs beside (#353), so this never
  // holds up a request.
  if (!tui) autoUpdate({ config }).catch(() => {});

  // One idempotent shutdown funnel for BOTH modes and BOTH triggers: POSIX
  // signals (SIGINT/SIGTERM/SIGHUP) and the TUI's ctrl-c / q keypress (which in
  // raw mode never reaches the OS as a signal). Guards re-entry: a second ctrl-c — an
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
    eventLoopMonitor.stop();
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
  // A closed pane or a dropped SSH session hangs up the controlling terminal.
  // SIGHUP's default action kills the process where it stands, skipping stop()
  // and the quota-state save; routed through the same funnel, a vanished
  // terminal is an orderly exit like any other.
  process.on('SIGHUP', shutdown);
}

// ── import ──────────────────────────────────────────────────

async function importCommand() {
  // First-run entry point: the file has to exist (and the egress proxy be
  // applied) before anything reaches the network. The list is not written back
  // from this copy — upsertOAuthAccount re-reads the file when it saves.
  const config = await loadOrCreateConfig();

  let name = argValue('--name');
  const jsonStr = argValue('--json');
  // The profile lookup below is already the account's traffic.
  const { routing, store } = loginRouting(config);
  await requireWorkingRouting(routing, upstreamFor({ type: 'oauth' }, config.upstream));

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

  await upsertOAuthAccount(name, creds, 'import', routing, store);
}

// ── login ───────────────────────────────────────────────────

/**
 * The --routing flag: the account's own egress proxy URL
 * (http/socks4/socks4a/socks5/socks5h with optional user:pass auth, see
 * account-routing.js), or `none` for "no proxy", spelled as `teamclaude
 * routing <name> none` spells it. An invalid value is a hard CLI error: a typo
 * must not quietly add an account that goes direct.
 * @returns {{ given: boolean, routing: import('./account-routing.js').RoutingProxy|null }}
 * `given` is false when the flag is absent; given with a null routing is `none`.
 */
function routingFlag() {
  // Both spellings, and a flag with nothing after it is an error rather than
  // an absent flag. Every other option here can afford to be ignored when it
  // is mistyped; this one cannot, because what happens instead is the sign-in
  // leaving from this machine's own address.
  const inline = args.find(a => a.startsWith('--routing='));
  if (inline == null && !args.includes('--routing')) return { given: false, routing: null };
  const raw = inline != null ? inline.slice('--routing='.length) : argValue('--routing');
  if (!raw || raw.startsWith('--')) {
    console.error('--routing needs a proxy URL, e.g. --routing "socks5h://alice:s3cret@proxy.example.com:1080" (or none)');
    process.exit(1);
  }
  // Before the parse, which would read a bare word as a proxy HOST named "none".
  if (/^(none|off|-)$/i.test(raw)) return { given: true, routing: null };
  try {
    return { given: true, routing: parseRoutingUrl(raw) };
  } catch (/** @type {any} */ err) {
    console.error(`Invalid --routing value: ${err.message}`);
    process.exit(1);
  }
}

/**
 * The routing a login or import leaves by, and whether to store it.
 *
 * `--routing` wins and is written onto the entry, `none` included: that signs
 * in without a proxy and clears the one the entry had, which is the way out
 * when a stored proxy is dead and the account needs a new sign-in. Without the
 * flag, an account that `--name` identifies and that already has a routing
 * lends its own: signing that account in again is that account's traffic. A
 * borrowed routing is used for the network calls only and never written back:
 * the sign-in may turn out to be a different identity, and a new entry must
 * not inherit a proxy by sharing a name.
 * @param {Record<string, any>} config
 * @returns {{ routing: import('./account-routing.js').RoutingProxy|null, store: boolean }}
 * `store` with a null routing means "clear it".
 */
function loginRouting(config) {
  const flag = routingFlag();
  if (flag.given) {
    refuseSelfRouting(flag.routing, config);
    return { routing: flag.routing, store: true };
  }
  const name = argValue('--name');
  const named = name ? matchAccounts(config.accounts || [], name, argValue('--org')) : [];
  const stored = named.length === 1 ? accountRouting(named[0], localListener(config)) : null;
  if (stored) console.log(`Using the routing stored on "${named[0].name}": ${describeRouting(stored)}`);
  return { routing: stored, store: false };
}

/**
 * Exit when `routing` names this server's own listener. The MITM listener
 * intercepts api.anthropic.com, so a request tunnelled through it would come
 * straight back into forwardRequest and go around again; the fleet
 * upstreamProxy setting refuses the same address (resolveUpstreamProxy), and
 * the server drops such a routing on load (accountRouting), so writing it
 * would only store a value the server then ignores. Before the proxy test:
 * that test would pass, because this server does answer a CONNECT.
 * @param {import('./account-routing.js').RoutingProxy|null} routing
 * @param {Record<string, any>} config
 */
function refuseSelfRouting(routing, config) {
  if (!routing || !isSelfProxy(routing, localListener(config))) return;
  console.error(`${describeRouting(routing)} is this server's own address; routing an account through it would loop back into this proxy.`);
  process.exit(1);
}

/**
 * Exit unless `routing` can reach `upstreamUrl`'s host, before anything is
 * changed or a browser is opened: an OAuth code is single-use, and finding
 * out at the token exchange that the proxy password was wrong costs the whole
 * sign-in. `--no-check` skips it, for a proxy that is not up yet.
 * @param {import('./account-routing.js').RoutingProxy|null} routing
 * @param {string} upstreamUrl
 */
async function requireWorkingRouting(routing, upstreamUrl) {
  if (!routing || args.includes('--no-check')) return;
  const check = await checkRouting(routing, upstreamUrl);
  if (check.ok) {
    console.log(`Routing proxy OK: reached ${check.host} through ${describeRouting(routing)} in ${check.ms}ms`);
    return;
  }
  console.error(`Routing proxy check failed: ${check.error}`);
  console.error('Nothing was changed. Fix the proxy or the URL, or pass --no-check to skip this test.');
  process.exit(1);
}

/**
 * Say so when a sign-in turned out to belong to an account with its own
 * routing and did not go through it. Which account a sign-in is for is only
 * known once it has happened, so without --name or --routing this cannot be
 * prevented, only reported. The operator who routes an account to keep its
 * traffic off this machine's address needs to know that it was not.
 * @param {Record<string, any>} entry  the existing entry the sign-in matched
 * @param {import('./account-routing.js').RoutingProxy|null} used
 */
function noteUnusedRouting(entry, used) {
  const own = accountRouting(entry);
  if (!own || used) return;
  console.log(`Note: "${entry.name}" has its own routing (${describeRouting(own)}), and this sign-in did not use it:`);
  console.log('      the account was only identified after signing in. Its requests are still routed.');
  console.log(`      To route the sign-in too, pass: --name "${entry.name}"`);
}

/**
 * `teamclaude login --codex` — browser OAuth against OpenAI, then store the
 * account.
 *
 * Deliberately simpler than the Anthropic path: that one calls the profile
 * endpoint to discover identity, whereas a Codex id_token already carries the
 * email and the ChatGPT account id, so there is nothing further to fetch.
 */
async function loginCodexCommand() {
  // loadOrCreateConfig, not loadConfig: `login` is a first-run entry point and
  // must work before any config file exists. This copy is not what gets
  // written — see the atomicConfigUpdate below.
  const loaded = await loadOrCreateConfig();
  const { routing, store } = loginRouting(loaded);
  await requireWorkingRouting(routing, upstreamFor({ type: 'oauth', provider: 'codex' }, loaded.upstream));
  let creds;
  try {
    creds = await loginCodex({ noBrowser: args.includes('--no-browser'), routing });
  } catch (err) {
    console.error(`Codex login failed: ${err.message}`);
    console.error('');
    console.error('Alternative: sign in with the Codex CLI and import that login instead —');
    console.error('  CODEX_HOME=~/.codex-second codex login');
    console.error('  then add: { "name": "...", "type": "oauth", "provider": "codex", "importFrom": "~/.codex-second/auth.json" }');
    process.exit(1);
  }

  await upsertCodexAccount(argValue('--name'), creds, routing, store);
}

/**
 * Store a Codex login: refresh the row for the same ChatGPT account, or add one.
 *
 * The browser flow that produced `creds` can take minutes, and a running server
 * may have rotated another account's refresh token on disk in the meantime.
 * Writing a copy loaded before the flow would put the dead token back, and that
 * account would fail on its next restart. So the upsert runs against a fresh
 * read of the file, and only this account's row is touched.
 *
 * @param {string | null | undefined} requestedName
 * @param {any} creds
 * @param {import('./account-routing.js').RoutingProxy|null} [routing] - the
 * account's own egress proxy (see loginRouting); null leaves it on the fleet path.
 * @param {boolean} [storeRouting] - false when `routing` was borrowed from the
 * existing entry rather than given with --routing: used, never written. True
 * with a null `routing` is `--routing none`: the entry's routing is cleared.
 * @returns {Promise<{ action: 'updated' | 'added', name: string }>}
 */
async function upsertCodexAccount(requestedName, creds, routing = null, storeRouting = false) {
  /** @type {{ action: 'updated' | 'added', name: string }} */
  let outcome = { action: 'added', name: requestedName || '' };
  await atomicConfigUpdate(config => {
    const name = requestedName || creds.email
      || `codex-${config.accounts.filter(a => a.provider === 'codex').length + 1}`;

    const account = {
      name,
      type: 'oauth',
      provider: 'codex',
      source: 'login',
      accountId: creds.accountId,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      // Key absent rather than null when --routing was not passed: on a
      // re-login the spread below then keeps the routing the entry already
      // had, instead of silently clearing it.
      ...(routing && storeRouting ? { routing: routingToUrl(routing) } : {}),
    };

    // Identity for a Codex account is its ChatGPT account id; fall back to the
    // display name when upstream did not supply one.
    const idx = config.accounts.findIndex(a => (
      a.provider === 'codex' && (
        (account.accountId && a.accountId === account.accountId) || a.name === account.name
      )
    ));
    if (idx >= 0) {
      const prev = config.accounts[idx];
      config.accounts[idx] = { ...prev, ...account, name: prev.name };
      outcome = { action: 'updated', name: prev.name };
      if (storeRouting && !routing) delete config.accounts[idx].routing; // --routing none
      console.log(`Updated account "${prev.name}"`);
      if (!storeRouting) noteUnusedRouting(prev, routing);
    } else {
      config.accounts.push(account);
      outcome = { action: 'added', name: account.name };
      console.log(`Added account "${account.name}"${creds.planType ? ` (${creds.planType})` : ''}`);
    }
  });
  console.log(`Saved to ${getConfigPath()}`);
  return outcome;
}

async function loginCommand() {
  if (args.includes('--api')) {
    await loginApiCommand();
    return;
  }
  if (args.includes('--token')) {
    await loginOAuthCommand({ pasteOnly: true });
    return;
  }
  if (args.includes('--oauth')) {
    await loginOAuthCommand();
    return;
  }
  if (args.includes('--codex')) {
    await loginCodexCommand();
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
  console.log('  3. Codex subscription   (ChatGPT Plus, Pro, Team)');
  console.log('');
  const choice = await new Promise(resolve => rl.question('Choice [1]: ', resolve));
  rl.close();

  switch (choice.trim() || '1') {
    case '3': await loginCodexCommand(); break;
    case '1': await loginOAuthCommand(); break;
    case '2': await loginApiCommand(); break;
    default:
      console.error(`Invalid choice: ${choice.trim()}`);
      process.exit(1);
  }
}

async function loginApiCommand() {
  const loaded = await loadOrCreateConfig(); // first run: create the file; the save re-reads it
  let name = argValue('--name');
  // The flag alone: an API key is always a NEW entry, so there is no stored
  // routing for it to borrow (and `none` is what it gets without the flag).
  const { routing } = routingFlag();
  refuseSelfRouting(routing, loaded);
  await requireWorkingRouting(routing, upstreamFor({ type: 'apikey' }, loaded.upstream));

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const apiKey = await new Promise(resolve => rl.question('Anthropic API key: ', resolve));
  rl.close();

  if (!apiKey.trim()) {
    console.error('No API key provided');
    process.exit(1);
  }

  // The prompt above waits on the user for as long as they take, and a running
  // server may have rotated an OAuth account's refresh token on disk meanwhile.
  // Saving the copy loaded before the prompt would put the dead token back and
  // lose that account on its next restart, so the row is added to a fresh read.
  const config = await atomicConfigUpdate(disk => {
    if (!name) {
      const n = disk.accounts.filter(a => a.name.startsWith('api-')).length + 1;
      name = `api-${n}`;
    }
    disk.accounts.push({
      name, type: 'apikey', apiKey: apiKey.trim(),
      ...(routing ? { routing: routingToUrl(routing) } : {}),
    });
  });
  console.log(`Added API key account "${name}"${routing ? ` (routed via ${describeRouting(routing)})` : ''}`);
  console.log(`Saved to ${getConfigPath()}`);
  await notifyRunningServer(config);
}

async function loginOAuthCommand({ pasteOnly = false } = {}) {
  const loaded = await loadOrCreateConfig(); // first run: create the file; the save re-reads it
  let name = argValue('--name');
  const { routing, store } = loginRouting(loaded);
  await requireWorkingRouting(routing, upstreamFor({ type: 'oauth' }, loaded.upstream));

  console.log('Starting OAuth login...');
  let creds;
  try {
    creds = pasteOnly ? await loginOAuthWithPastedCode({ routing }) : await loginOAuth({ routing });
  } catch (err) {
    console.error(`OAuth login failed: ${err.message}`);
    console.error('');
    console.error('Alternatives:');
    console.error('  teamclaude import        Import from existing Claude Code credentials');
    console.error('  teamclaude login --api   Add an API key instead');
    process.exit(1);
  }

  await upsertOAuthAccount(name, creds, 'login', routing, store);
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
  let useMitm;
  try {
    useMitm = resolveClientMode(config, args.slice(1)) === 'mitm';
  } catch (/** @type {any} */ err) {
    process.stderr.write(`teamclaude env: ${err.message}\n`);
    process.exit(1);
  }

  let caPath = null;
  // The leaf has to name every host MITM will intercept, or the CONNECT for
  // a second provider fails the handshake instead of being served.
  if (useMitm) ({ caPath } = await ensureCerts(mitmHosts(config)));

  // Same pin as `teamclaude run`, so `eval "$(teamclaude env)"` and `run` agree.
  const account = (process.env.TC_ACCT || '').trim();
  let lines;
  try {
    lines = buildClaudeEnvLines({
      port, useMitm, caPath, holdSeconds: config.holdSeconds,
      account, proxyApiKey: config.proxy?.apiKey || '',
      // The shell doing the eval keeps its own NO_PROXY entries; re-running is
      // idempotent, since the merged value is what it will have next time.
      inheritedNoProxy: [process.env.NO_PROXY, process.env.no_proxy].filter(Boolean).join(','),
    });
    // Base-URL mode takes the proxy back OUT of a shell an earlier MITM eval
    // put it into; only this proxy's own loopback address is unset.
    if (!useMitm) lines.push(...clearSelfProxyEnvLines(port));
  } catch (err) {
    // A bad proxy.port. Nothing reaches stdout: the shell is eval'ing it.
    process.stderr.write(`teamclaude env: ${err.message} (in ${getConfigPath()})\n`);
    process.exit(1);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  const mode = useMitm ? 'MITM forward-proxy' : 'base-URL';
  process.stderr.write(`# TeamClaude env: ${mode} mode, localhost:${port}\n`);
  if (account) {
    process.stderr.write(`# pinned to account "${account}" (TC_ACCT)\n`);
    // Warn, don't fail: the account list can change before the shell is used,
    // and this command must stay eval-safe.
    if (!(config.accounts || []).some((a, i) => a.name === account || String(i) === account)) {
      process.stderr.write(`# warning: no account named "${account}" in the config — the proxy will refuse this pin\n`);
    }
  }
  // The flag that reproduces this mode whatever the config's default says.
  process.stderr.write(`# apply to this shell:  eval "$(teamclaude env${useMitm ? ' --mitm' : ' --no-mitm'})"\n`);
  process.stderr.write(`# default mode is ${config.defaultClientMode === 'base-url' ? 'base-URL' : 'MITM'} (config defaultClientMode; the TUI settings screen toggles it)\n`);
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

  // Args after 'run'. teamclaude flags (e.g. --no-mitm) are recognized only
  // before an optional `--` separator; everything after `--` goes verbatim to
  // claude. MITM forward-proxy mode is the default so hardcoded api.anthropic.com
  // endpoints are intercepted too; the config's `defaultClientMode` can make
  // base-URL the default instead, and --mitm / --no-mitm decide per launch.
  const rest = args.slice(1);
  const sep = rest.indexOf('--');
  const tcFlags = sep >= 0 ? rest.slice(0, sep) : rest;
  let useMitm;
  try {
    useMitm = resolveClientMode(config, tcFlags) === 'mitm';
  } catch (/** @type {any} */ err) {
    console.error(`[TeamClaude] ${err.message}`);
    process.exit(1);
  }
  const autoFallback = tcFlags.includes('--auto-fallback');
  const claudeArgs = sep >= 0
    ? rest.slice(sep + 1)
    : rest.filter(a => a !== '--mitm' && a !== '--no-mitm' && a !== '--auto-fallback');

  // Route through the proxy when it's up. When it's down we refuse by default —
  // silently launching claude directly hides that requests are bypassing the
  // proxy (no rotation, spending the user's own quota). Pass --auto-fallback to
  // opt back into the transparent direct launch (e.g. for a dumb shell alias).
  const port = config.proxy.port;
  const env = { ...process.env };
  // TC_ACCT pins this session to one account, in either mode. It is teamclaude's
  // own knob, so it never reaches the child: claude has no use for it, and an
  // account name is not something to leak into a subprocess environment that
  // gets inherited by every tool and MCP server claude spawns.
  const tcAcct = (process.env.TC_ACCT || '').trim();
  delete env.TC_ACCT;
  // Legacy: a caller-supplied ANTHROPIC_BASE_URL of http://<this proxy>/tc-acct/…
  // also pins (shipped in 1.1.10). TC_ACCT is the supported way now — it works in
  // MITM mode too, and keeps the pin out of the API path.
  const pinnedBase = isLocalAccountPin(process.env.ANTHROPIC_BASE_URL, port);
  if (await isProxyUp(port)) {
    if (useMitm) {
      // Route ALL of claude's traffic through us as an HTTPS forward proxy, so
      // even hardcoded api.anthropic.com endpoints (e.g. the design MCP) get the
      // real token injected. claude trusts our MITM leaf via NODE_EXTRA_CA_CERTS.
      const { caPath } = await ensureCerts(mitmHosts(config));
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
      // Keep the operator's own NO_PROXY and add ours — see mergeNoProxy. Both
      // spellings are read: a tool that set only one still meant it.
      const inheritedNoProxy = [process.env.NO_PROXY, process.env.no_proxy];
      env.NO_PROXY = env.no_proxy = mergeNoProxy(...inheritedNoProxy);
      if (inheritedNoProxy.some(bypassesAllHosts)) {
        console.error('[TeamClaude] NO_PROXY=* ignored: it would send api.anthropic.com around the proxy (no rotation). Use --no-mitm for a direct launch.');
      }
      env.NODE_EXTRA_CA_CERTS = caPath;
      if (tcAcct) console.error(`[TeamClaude] Pinned to account "${tcAcct}" (TC_ACCT)`);
      else if (pinnedBase) {
        console.error('[TeamClaude] Account pin in ANTHROPIC_BASE_URL ignored: MITM mode does not use a base URL.');
        console.error('[TeamClaude] Use TC_ACCT=<account> instead — it pins in both modes.');
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
        console.error(`[TeamClaude] Pinned to account "${tcAcct}" (TC_ACCT)`);
      } else if (!pinnedBase) {
        env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
      }
    }
  } else if (autoFallback) {
    console.error(`[TeamClaude] Proxy not running on port ${port} — launching claude directly (--auto-fallback; start it with: teamclaude server)`);
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

  // Use spawnSync so the Node process blocks entirely — behaves like execvp.
  const result = spawnSync('claude', claudeArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });

  if (result.error) {
    if (/** @type {CodedError} */ (result.error).code === 'ENOENT') {
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

// ── status ──────────────────────────────────────────────────

// process.stdout.write is asynchronous when stdout is a pipe, so a write that
// is followed by process.exit loses whatever has not reached the pipe yet: on
// macOS a 15 KB status came out as its first 512 bytes through `| jq`. This
// resolves once the bytes are handed off. A reader that quits early (`| head`)
// raises EPIPE, which console.log swallows; the listener keeps that behaviour.
function writeStdout(text) {
  return new Promise(resolve => {
    process.stdout.write(text, err => {
      if (err) process.stdout.once('error', () => {});
      resolve();
    });
  });
}

async function statusCommand() {
  const config = await loadOrCreateConfig();
  const url = `http://localhost:${config.proxy.port}/teamclaude/status`;
  const json = args.includes('--json');
  const colorArg = argValue('--color') || args.find(arg => arg.startsWith('--color='))?.slice('--color='.length);
  const color = colorArg === 'always'
    || (colorArg !== 'never' && process.stdout.isTTY);

  // A connection that is accepted and then never answered is a different
  // failure from a refused one — a stalled or overloaded server rather than a
  // stopped one — and without a deadline this command would just hang on it.
  const configuredTimeout = Number(process.env.TEAMCLAUDE_STATUS_TIMEOUT_MS);
  const timeoutMs = configuredTimeout > 0 ? configuredTimeout : 5_000;

  try {
    const res = await fetch(url, {
      headers: { 'x-api-key': config.proxy.apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    if (json) {
      await writeStdout(`${JSON.stringify(data, null, 2)}\n`);
      return;
    }
    await writeStdout(`${renderStatus(data, { color })}\n`);
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      console.error(`Proxy at localhost:${config.proxy.port} did not answer status within ${timeoutMs}ms.`);
      console.error('The process may be overloaded or its event loop may be stalled.');
      console.error(`Check the service log: ${logPath()}`);
      process.exit(1);
    }
    console.error('Cannot connect to proxy at localhost:' + config.proxy.port);
    console.error('Is the server running? Start with: teamclaude server');
    if (err?.message) console.error(`Details: ${err.message}`);
    process.exit(1);
  }
}

// ── attach ──────────────────────────────────────────────────

// The interactive dashboard against a server that is ALREADY running. A proxy
// installed as a background service has no foreground TUI, so this is the only
// way to watch and steer it live; it renders from polled status and can only do
// what the control plane exposes (switch, reload).
async function attachCommand() {
  const config = await loadOrCreateConfig();
  const port = config.proxy.port;
  // Reach the server where it actually binds (see serverCommand): a host set in
  // the config or the environment is not reachable as localhost, and reporting
  // "not running" for a server that is plainly up is the worst of the answers.
  // A wildcard bind is not an address to dial, so dial this machine instead.
  const bound = process.env.TEAMCLAUDE_HOST || config.proxy.host || '127.0.0.1';
  const host = (bound === '0.0.0.0' || bound === '::') ? '127.0.0.1' : bound;

  // Checked before connecting: the dashboard needs raw-mode input, and failing
  // on that after a successful poll would be a confusing order to report it in.
  if (!process.stdin.isTTY) {
    console.error('teamclaude attach needs a terminal. For a one-shot readout use: teamclaude status');
    process.exit(1);
  }

  const control = new RemoteControl({ port, host, apiKey: config.proxy.apiKey });
  let first;
  try {
    first = await control.status(); // fail here, with a usable message, not inside the TUI
  } catch (err) {
    console.error(`Cannot connect to proxy at ${host}:${port}`);
    console.error('Is the server running? Start with: teamclaude server');
    if (err?.message) console.error(`Details: ${err.message}`);
    process.exit(1);
  }

  await new Promise(resolve => {
    const session = createAttachSession({ control, config, onQuit: resolve });
    // The status just fetched is the first frame: without it the alt-screen opens
    // on a disconnected, empty dashboard until the first poll lands.
    session.am.applyStatus(first);
    session.start();
  });
}

// Open the browser dashboard against a running server. The page is served by
// the proxy itself, so this is `attach` for the browser: it does not start a
// server. A background daemon started from here would run with no log and no
// supervisor, which is what `teamclaude service install` exists to avoid.
async function dashboardCommand() {
  const config = await loadOrCreateConfig();
  const port = config.proxy.port;
  const bound = process.env.TEAMCLAUDE_HOST || config.proxy.host || '127.0.0.1';
  const host = (bound === '0.0.0.0' || bound === '::') ? '127.0.0.1' : bound;
  const dashboardUrl = `http://${host}:${port}/teamclaude/dashboard`;
  if (!(await isProxyUp(port))) {
    console.error(`[TeamClaude] Proxy not running on port ${port}.`);
    console.error('Start it with: teamclaude server   (or: teamclaude service install)');
    process.exit(1);
  }

  console.log(`Dashboard: ${dashboardUrl}`);
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  const opened = spawnSync(opener, process.platform === 'win32' ? ['', dashboardUrl] : [dashboardUrl], { stdio: 'ignore', shell: process.platform === 'win32' });
  if (opened.error || opened.status !== 0) console.error('Could not open a browser; open the URL above by hand.');
}

// ── switch ──────────────────────────────────────────────────

// Manual account switch against a RUNNING server — the headless equivalent of
// pressing 's' in the TUI, which is unreachable when the proxy runs as a
// background service. Nothing is written to the config: like the TUI's switch
// this is a runtime preference that dies with the process, so the server is the
// only place that can answer or apply it.
async function switchCommand() {
  const config = await loadOrCreateConfig();
  const port = config.proxy.port;
  const headers = { 'x-api-key': config.proxy.apiKey };
  const name = args[1] && !args[1].startsWith('-') ? args[1] : null;

  try {
    if (!name) {
      const res = await fetch(`http://localhost:${port}/teamclaude/status`, { headers });
      // Something answered on the port. Whether it is our proxy is a separate
      // question, and getting it wrong would blame a down server for a reply we
      // simply could not read — or report an unreadable reply as an empty fleet.
      const data = res.ok ? await res.json().catch(() => null) : null;
      if (!data || !Array.isArray(data.accounts)) {
        console.error(`Unexpected reply from localhost:${port} (HTTP ${res.status}) — no account list in it.`);
        console.error('Something is listening there, but it does not answer like this teamclaude version.');
        process.exit(1);
      }
      if (!data.accounts.length) {
        console.log('No accounts configured.');
        return;
      }
      for (const a of data.accounts) {
        // Flag what would stop traffic reaching an account. The TUI shows this in
        // its table, so leaving it out here would make the headless half of the
        // feature the only place a disabled account looks switchable.
        const state = a.disabled ? 'disabled' : (a.status && a.status !== 'active' ? a.status : null);
        console.log(`${a.name === data.currentAccount ? '*' : ' '} ${a.name}${state ? `  (${state})` : ''}`);
      }
      console.log('\nSwitch with: teamclaude switch <name>');
      return;
    }

    const res = await fetch(`http://localhost:${port}/teamclaude/switch`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Our own errors are strings. A server too old to know this endpoint
      // forwards the request upstream instead, and Anthropic's error is an
      // object — printing that raw gives the user "[object Object]".
      const detail = typeof data.error === 'string' ? data.error : null;
      console.error(detail || `Switch failed: unexpected reply from localhost:${port} (HTTP ${res.status}).`);
      if (!detail) console.error('An older server without this endpoint answers this way; restart it to pick up the new version.');
      if (data.accounts?.length) {
        console.error('Known accounts:');
        for (const n of data.accounts) console.error(`  ${n}`);
      }
      process.exit(1);
    }
    console.log(`Switched to "${data.account}"`);
    // Recorded is not the same as in effect: rotation skips an account it cannot
    // use on the very next request, so saying nothing here would be a quiet lie.
    if (data.eligible === false) {
      console.error(`Warning: "${data.account}" is ${data.reason || 'not currently eligible'}, so requests will not route to it until that changes.`);
    }
  } catch (err) {
    console.error('Cannot connect to proxy at localhost:' + port);
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

  // Both writes below pair rows by entry id against a fresh read of the file,
  // so a file written before ids existed needs its ids on disk first.
  await persistMintedAccountIds(config);

  // Refresh expired tokens before fetching profiles. Each call goes by the
  // account's own routing when it has one — this is that account's traffic.
  const refreshed = [];
  await Promise.all(config.accounts.map(async (a) => {
    if (a.type !== 'oauth' || !a.refreshToken) return;
    if (!isTokenExpiringSoon(a.expiresAt)) return;
    try {
      const newTokens = await refreshAccessToken(a.refreshToken, undefined, accountRouting(a, localListener(config)));
      a.accessToken = newTokens.accessToken;
      a.refreshToken = newTokens.refreshToken;
      a.expiresAt = newTokens.expiresAt;
      refreshed.push(a);
    } catch {
      // refresh failed — fetchProfile will report the specific error
    }
  }));
  // Only the refreshed rows are written, each onto the on-disk row with its id.
  // Saving the whole in-memory list here would put back whatever a running
  // server rotated on disk since the load — a refresh token that is now dead,
  // and an account lost on its next restart.
  if (refreshed.length > 0) {
    await atomicConfigUpdate(disk => {
      for (const a of refreshed) {
        const i = findConfigAccount(disk, a);
        if (i < 0) continue; // no row of its own; any other row would be another account's
        disk.accounts[i].accessToken = a.accessToken;
        disk.accounts[i].refreshToken = a.refreshToken;
        disk.accounts[i].expiresAt = a.expiresAt;
      }
    });
  }

  // Fetch profiles in parallel for all OAuth accounts
  const profiles = await Promise.all(
    config.accounts.map(a =>
      a.type === 'oauth' && a.accessToken ? fetchProfile(a.accessToken, accountRouting(a, localListener(config))) : null
    )
  );

  // Backfill account+org identity from profiles, then deduplicate by
  // (accountUuid, org): the same person in a different org is a distinct
  // account, not a duplicate. Keep the last (most recently added) entry.
  const seen = new Map();
  let removed = 0;
  // Which entries changed, by id, so the write below touches only those rows.
  const touchedIds = new Set();
  const removedIds = new Set();
  for (let i = config.accounts.length - 1; i >= 0; i--) {
    const a = config.accounts[i];
    const p = profiles[i];
    if (p && !p.error) {
      if (p.accountUuid && a.accountUuid !== p.accountUuid) { a.accountUuid = p.accountUuid; touchedIds.add(a.id); }
      if (p.orgUuid && a.orgUuid !== p.orgUuid) { a.orgUuid = p.orgUuid; touchedIds.add(a.id); }
      if (p.orgName && a.orgName !== p.orgName) { a.orgName = p.orgName; touchedIds.add(a.id); }
      for (const field of ['organizationType', 'rateLimitTier', 'seatTier', 'hasClaudeMax', 'hasClaudePro']) {
        if (p[field] != null && a[field] !== p[field]) { a[field] = p[field]; touchedIds.add(a.id); }
      }
    }
    const uuid = a.accountUuid;
    if (!uuid) continue;
    const key = `${uuid}::${orgKey(a) || ''}`;
    if (seen.has(key)) {
      config.accounts.splice(i, 1);
      profiles.splice(i, 1);
      removed++;
      removedIds.add(a.id);
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
    if (a.name !== newName) { a.name = newName; touchedIds.add(a.id); }
  }

  // Same discipline as the token write: drop the duplicates by id and copy the
  // profile fields onto the touched rows only, leaving every other row — and
  // every other field of these rows — as it is on disk.
  if (touchedIds.size > 0 || removedIds.size > 0) {
    const fields = ['name', 'accountUuid', 'orgUuid', 'orgName', 'organizationType', 'rateLimitTier', 'seatTier', 'hasClaudeMax', 'hasClaudePro'];
    await atomicConfigUpdate(disk => {
      disk.accounts = disk.accounts.filter(d => !removedIds.has(d?.id));
      for (const a of config.accounts) {
        if (!touchedIds.has(a.id)) continue;
        const i = findConfigAccount(disk, a);
        if (i < 0) continue;
        for (const f of fields) if (a[f] !== undefined) disk.accounts[i][f] = a[f];
      }
    });
  }
  if (removed > 0) console.log(`Removed ${removed} duplicate account(s)\n`);

  for (const [i, a] of config.accounts.entries()) {
    const p = profiles[i];
    // The account's own egress proxy, password masked; absent = fleet path.
    const routeTag = describeRouting(accountRouting(a, localListener(config)));

    if (a.type === 'apikey') {
      console.log(`  [${i + 1}] ${a.name} (apikey)  ${a.apiKey?.slice(0, 15)}...`);
      if (routeTag) console.log(`       Route: ${routeTag}`);
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
    if (routeTag) console.log(`       Route: ${routeTag}`);
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

  // This call carries the account's credential, so it is that account's
  // traffic: it leaves by the account's own routing when it has one, and by
  // the fleet path (the upstream proxy when configured) otherwise.
  const routing = accountRouting(account, localListener(config));
  if (routing) console.error(`(via ${describeRouting(routing)})`);
  const res = await proxyFetch(url, { ...fetchOpts, routing });

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

// ── service ─────────────────────────────────────────────────

async function serviceCommand() {
  const sub = args[1] || 'status';
  const kind = serviceKind();
  if (!kind) {
    console.error(`teamclaude service: no service integration for ${process.platform}`);
    console.error('Run the proxy yourself with: teamclaude server --headless');
    process.exit(1);
  }
  // Carry an explicit config path into the unit: a service started by launchd or
  // systemd does not inherit the shell's TEAMCLAUDE_CONFIG, so a non-default
  // config would silently be ignored and the service would serve a different
  // (or empty) account list than the CLI does.
  const configPath = process.env.TEAMCLAUDE_CONFIG || null;

  switch (sub) {
    case 'install': {
      const res = await installService({ configPath });
      if (!res.ok) { console.error(`teamclaude service install failed: ${res.error}`); process.exit(1); }
      break;
    }
    case 'uninstall': {
      const res = await uninstallService();
      if (!res.ok) { console.error(`teamclaude service uninstall failed: ${res.error}`); process.exit(1); }
      break;
    }
    case 'print':
      process.stdout.write(renderService({ configPath }));
      break;
    case 'status': {
      const s = await serviceStatus();
      console.log(`Service:   ${s.installed ? s.file : 'not installed'}`);
      console.log(`State:     ${s.running ? `running${s.pid ? ` (pid ${s.pid})` : ''}` : s.detail}`);
      if (kind === 'launchd') console.log(`Logs:      ${logPath()}`);
      else console.log('Logs:      journalctl --user --unit teamclaude.service');
      break;
    }
    default:
      console.error('Usage: teamclaude service <install|uninstall|status|print>');
      process.exit(1);
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
  }

  applyOrExit(() => setProbeSeconds(config, seconds));
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
    if (config.warmupSchedule) {
      console.log(formatWarmupScheduleConfirmation(config.warmupSchedule));
      return;
    }
    const cur = config.warmupSeconds || 0;
    console.log(cur > 0 ? `Keep-warm: every ${cur}s` : 'Keep-warm: off');
    console.log('Set with: teamclaude warmup <off|seconds>');
    console.log('          teamclaude warmup reset HH:MM --timezone Area/City');
    console.log('          teamclaude warmup rolling HH:MM --timezone Area/City');
    console.log('Note: warming spawns a minimal `claude` per idle account and DOES spend a little quota');
    console.log('(unlike the passive quota probe). It only warms accounts whose 5h window is idle.');
    return;
  }

  if (arg === 'reset' || arg === 'rolling') {
    const resetTime = args[2];
    const timezoneFlag = args.indexOf('--timezone', 3);
    const timezone = timezoneFlag >= 0 ? args[timezoneFlag + 1] : null;
    if (!resetTime || !timezone || args.length !== 5 || timezoneFlag !== 3) {
      console.error(`Usage: teamclaude warmup ${arg} HH:MM --timezone Area/City`);
      process.exit(1);
    }
    applyOrExit(() => setWarmupSchedule(config, arg, { resetTime, timezone }));
    await saveConfig(config);
    console.log(formatWarmupScheduleConfirmation(config.warmupSchedule));
    await notifyRunningServer(config);
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
  }

  applyOrExit(() => setWarmupSeconds(config, seconds));
  await saveConfig(config);
  console.log(seconds > 0
    ? `Keep-warm set to every ${seconds}s (spawns a minimal \`claude\` per idle account; spends a little quota).`
    : 'Keep-warm disabled.');
  await notifyRunningServer(config);
}

// ── threshold ───────────────────────────────────────────────

function printThresholds(value) {
  const table = thresholdTable(value);
  console.log(`Switch threshold: ${formatPercent(table.default)}`);
  for (const [bucket, ratio] of Object.entries(table)) {
    if (bucket !== 'default' && typeof ratio === 'number') {
      console.log(`  ${bucket}: ${formatPercent(ratio)}`);
    }
  }
}

async function thresholdCommand() {
  const config = await loadOrCreateConfig();
  const rest = args.slice(1);

  if (!rest.length) {
    printThresholds(config.switchThreshold);
    console.log('Set with: teamclaude threshold <1-100>   e.g. teamclaude threshold 90');
    console.log('Per bucket: teamclaude threshold unified7d=90   (=default drops it again)');
    return;
  }

  const keyed = rest.filter(arg => arg.includes('='));
  if (keyed.length && keyed.length !== rest.length) {
    console.error(THRESHOLD_USAGE);
    process.exit(1);
  }

  // One number: the plain form the setting has always had, and it replaces any
  // per-bucket table rather than hiding one behind the number now in effect.
  if (!keyed.length) {
    if (rest.length > 1) {
      console.error(THRESHOLD_USAGE);
      process.exit(1);
    }
    if (thresholdRatio(rest[0]) === null) {
      console.error(THRESHOLD_USAGE);
      process.exit(1);
    }
    const { dropped } = applyOrExit(() => setThreshold(config, rest[0]));
    await saveConfig(config);
    if (dropped.length) {
      console.log(`Dropped the per-bucket thresholds (${dropped.join(', ')}) — one number governs every bucket.`);
    }
    console.log(`Switch threshold set to ${formatPercent(config.switchThreshold)}.`);
    await notifyRunningServer(config);
    return;
  }

  // `bucket=default` is the command's spelling of "drop this override".
  const pairs = keyed.map(pair => {
    const at = pair.indexOf('=');
    const value = pair.slice(at + 1);
    return /** @type {[string, unknown]} */ ([pair.slice(0, at), value === 'default' ? null : value]);
  });
  // A value that is not a percentage gets the usage text, as it always has;
  // what a bucket may be called is the shared rule's to say.
  if (pairs.some(([, value]) => value !== null && thresholdRatio(value) === null)) {
    console.error(THRESHOLD_USAGE);
    process.exit(1);
  }
  applyOrExit(() => setBucketThresholds(config, pairs));
  await saveConfig(config);
  printThresholds(config.switchThreshold);
  await notifyRunningServer(config);
}

// ── distribute ──────────────────────────────────────────────


async function distributeCommand() {
  const config = await loadOrCreateConfig();
  const arg = args[1];
  // The mode, not a boolean: `!!` would report "adaptive" as a plain "on" and,
  // worse, write `true` back over it on the next set.
  const current = distributionMode(config.distributeSessions);

  if (arg === undefined) {
    console.log(`Session distribution: ${current}`);
    console.log('Set with: teamclaude distribute <on|off|adaptive>');
    console.log('On: each session stays on its account for cache reuse, and new sessions spread');
    console.log('across equal-priority accounts by load. Off: quota-driven rotation only.');
    console.log('Adaptive: spread by remaining weekly credit and load rather than evenly, so the');
    console.log('most-spent account is finished off first without being run into its threshold.');
    return;
  }

  let next = null;
  if (['on', 'true', 'yes', '1'].includes(arg)) next = 'even';
  else if (['off', 'false', 'no', '0'].includes(arg)) next = 'off';
  else if (arg === 'adaptive') next = 'adaptive';
  if (!next) {
    console.error(DISTRIBUTE_USAGE);
    process.exit(1);
  }

  // An unchanged setting is not rewritten — the config file is a
  // read-modify-write shared with the running server — but the server is still
  // notified, so a config that already says `on` can be made to take effect.
  if (setDistribution(config, next)) await saveConfig(config);
  console.log(DISTRIBUTE_MODES[next].said);
  await notifyRunningServer(config);
}

// ── update ──────────────────────────────────────────────────

async function updateCommand() {
  const cur = currentVersion();
  console.log(`Current version: ${cur || 'unknown'}`);

  const kind = await installKind();
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
  const ok = await runUpdate(info.latest);
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
    const { route, updated, unknownAccounts } = applyOrExit(() => upsertRoute(config, { name, match, accounts, bucket, color }));
    for (const a of unknownAccounts) console.error(`Warning: no account named "${a}" (yet)`);
    console.log(`${updated ? 'Updated' : 'Added'} route "${route.name}"`);
    await saveConfig(config);
    await notifyRunningServer(config);
    return;
  }

  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const name = args[2];
    applyOrExit(() => removeRoute(config, name));
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

// ── routing ─────────────────────────────────────────────────

async function routingCommand() {
  const config = await loadOrCreateConfig();
  const name = args[1];

  if (!name) {
    console.error(ROUTING_USAGE);
    process.exit(1);
  }

  const account = resolveAccount(config.accounts, name, argValue('--org'));
  if (!account) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }

  // The URL is positional, like priority's number; a flag here would only
  // collide with --org.
  const value = args[2] && !args[2].startsWith('--') ? args[2] : null;

  const upstreamUrl = upstreamFor(account, config.upstream);

  if (!value) {
    const current = accountRouting(account, localListener(config));
    console.log(current
      ? `${account.name}: ${describeRouting(current)}`
      : `${account.name}: no routing — the account uses the fleet egress (the upstream proxy when configured, direct otherwise)`);
    // On request only: showing a setting should not need the network.
    if (current && args.includes('--check')) {
      const check = await checkRouting(current, upstreamUrl);
      if (check.ok) {
        console.log(`Routing proxy OK: reached ${check.host} in ${check.ms}ms`);
      } else {
        console.error(`Routing proxy check failed: ${check.error}`);
        process.exit(1);
      }
    }
    return;
  }

  if (/^(none|off|-)$/i.test(value)) {
    delete account.routing;
    await saveConfig(config);
    console.log(`Cleared routing for "${account.name}" — it now uses the fleet egress`);
    await notifyRunningServer(config);
    return;
  }

  /** @type {import('./account-routing.js').RoutingProxy|null} */
  let routing = null;
  try {
    routing = parseRoutingUrl(value);
  } catch (/** @type {any} */ err) {
    console.error(err.message);
    console.error('');
    console.error(ROUTING_USAGE);
    process.exit(1);
  }
  refuseSelfRouting(routing, config);
  // Before the save, not after: on a running server the change is live at
  // once, and a mistyped password would take a working account out of rotation.
  await requireWorkingRouting(routing, upstreamUrl);
  // Canonical form on disk: defaults spelled out, credentials percent-encoded.
  account.routing = routingToUrl(routing);
  await saveConfig(config);
  console.log(`Routing "${account.name}" via ${describeRouting(routing)} — all of its traffic now tunnels through this proxy`);
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
  login --token       OAuth login via copy/paste (no local callback; for headless/remote)
  login --api         Add an API key account
  env [--mitm|--no-mitm]
                      Print export lines to point Claude Code at the proxy, for
                      'eval "$(teamclaude env)"'. MITM forward-proxy unless the
                      config's defaultClientMode is "base-url"; a flag decides
                      per call. Handy for agent multiplexers that spawn claude
                      themselves instead of via 'teamclaude run'
  run [--no-mitm] [--auto-fallback] [-- args...]
                      Run Claude Code through the proxy (errors if it's down,
                      unless --auto-fallback launches claude directly instead).
                      Routes via an HTTPS forward proxy + local CA by default, so
                      even hardcoded api.anthropic.com endpoints are intercepted;
                      --no-mitm uses base-URL routing only. Set TC_ACCT to pin
                      the session to one account (see Environment below)
  alias               Print a shell alias so plain 'claude' routes via the proxy
                      (--install to write it to your shell rc; --uninstall to remove)
  service <sub>       Run the proxy as a user service that starts at login and
                      restarts on its own: install | uninstall | status | print
                      (LaunchAgent on macOS, systemd --user unit on Linux;
                      'print' writes the unit to stdout without touching anything)
  status [--json]     Show rich proxy/account/probe status (live)
                      Use --color=always|never to control ANSI colors
  attach              Open the live dashboard against a running server; s
                      switches account, R reloads config, q leaves it running
  dashboard           Open the web dashboard of a running server in the browser
  accounts            List configured accounts
  switch [NAME]       Make the running server prefer one account (as 's' in the
                      TUI does); with no NAME, list accounts and mark the current
  remove <name>       Remove an account (by name or email; --org to disambiguate)
  disable <name>      Temporarily exclude an account from rotation
  enable <name>       Re-enable a disabled account (also clears a stuck error)
  priority <name> <n> Set rotation priority (lower = preferred; --first/--last)
  route [list|add|rm] Per-model routing: pin model globs to specific accounts
                      (add <name> --match "<glob>" [--accounts "<name>"] [--bucket <b>])
  routing <name> [url|none]
                      Per-account egress proxy: send ALL of one account's
                      traffic (completions, token refresh, quota) through its
                      own proxy — http/socks4/socks4a/socks5/socks5h, optional
                      user:pass@ auth; 'none' clears it (also: login --routing)
  threshold [pct]     Utilization at which rotation leaves an account (1-100);
                      per bucket with 'unified7d=90', and '=default' drops one
  distribute [on|off|adaptive]
                      Spread new sessions across equal-priority accounts, each
                      pinned to its own for cache reuse (off by default);
                      'adaptive' spreads by remaining weekly credit and load
  probe [off|secs]    Opt-in background quota refresh for idle accounts
                      (off by default; reads usage endpoint, spends no quota)
  warmup [off|secs]   Opt-in: keep idle accounts' 5h timers running by sending
                      a minimal claude request to each (spends a little quota)
  warmup reset HH:MM --timezone Area/City
                      Schedule daily warm-up for a target reset in an IANA zone
  warmup rolling HH:MM --timezone Area/City
                      Anchor a continuous five-hour reset cadence in an IANA zone
  api <path>          Call an API endpoint with account credentials
  update              Check npm for a newer teamclaude and install it
  version             Print the installed version
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --routing URL       Per-account egress proxy for the account being added
                      (import/login), e.g. socks5h://alice:s3cret@host:1080 —
                      every connection for it tunnels through this proxy, the
                      sign-in included. Signing in again with --name reuses the
                      routing the account already has; --routing none signs in
                      without a proxy and clears it
  --no-check          Skip the proxy test that --routing and 'routing <url>' run
                      first (for a proxy that is not up yet)
  --org NAME|UUID     Disambiguate when an email spans multiple orgs (remove/priority/api)
  --from PATH         Credentials path (import, default: ~/.claude/.credentials.json;
                      on macOS the default falls back to the Keychain)
  --json JSON         Import from inline JSON (import), e.g.:
                      --json '{"accessToken":"...","refreshToken":"...","expiresAt":1234}'
  --log-to DIR        Log requests/responses to DIR (server, one file per request)
  --activity-log FILE Append TUI activity lines to FILE (server; works in headless mode too)
  --headless          Run the server without the interactive TUI (for backgrounding)
  --no-mitm           (run) skip the forward proxy; route via ANTHROPIC_BASE_URL only
  --auto-fallback     (run) if the proxy is down, launch claude directly instead
                      of erroring out (bypasses the proxy: no rotation)

Environment:
  TC_ACCT             Pin a session to ONE account, bypassing rotation. Works in
                      both modes. Accepts accountUuid, orgUuid,
                      accountUuid/orgUuid, or a display name/email:
                        TC_ACCT=me@example.com teamclaude run
                      Prefer a UUID for anything scripted: display names are
                      rewritten when an email gains a second org. Read by 'run'
                      and 'env', then removed from the environment so it never
                      reaches claude or the tools it spawns. An unknown account
                      is refused rather than silently rotated.
  TEAMCLAUDE_CONFIG   Path to the config file (default below)
  TEAMCLAUDE_DISABLE_AUTOUPDATE=1
                      Skip the background self-update check

The server always accepts both base-URL and proxy/CONNECT clients, so instances
launched with and without --no-mitm can share one server.

A running server re-syncs accounts from config on POST /teamclaude/reload
(local only). add/login/enable/disable/priority trigger it automatically.
POST /teamclaude/switch {"account": "<name>"} makes one account the preferred
one, which is what 'teamclaude switch' calls.

MCP endpoint (off by default). With "proxy": { "mcp": "read" } the server
serves its status, quota and settings as MCP tools at /teamclaude/mcp; "full"
adds the tools that change them (switch, enable/disable, priority, remove,
threshold, distribute, probe, warmup, routes, routing, blocked models, client
mode).
Connect Claude Code with:
  claude mcp add --transport http teamclaude http://localhost:3456/teamclaude/mcp
Same gates as the other /teamclaude/ routes. A named client key is served
read-only even in "full" mode: the write tools answer to the shared proxy key
and to local callers. With no proxy key configured, only local callers are served.

Upstream proxy. On a host with no direct route to the internet, set
"upstreamProxy": "http://user:pass@host:3128" (or just "host:3128") and every
outbound connection — request forwarding, OAuth login, token refresh, profile
and usage — is CONNECT-tunneled through it, TLS end to end. HTTPS_PROXY /
ALL_PROXY are honored when the config says nothing, NO_PROXY exempts hosts, and
"upstreamProxy": false ignores the environment entirely. Settable live in the
TUI settings screen. Distinct from "proxy" (the local port Claude Code talks to)
and from sx.org (a specific residential-egress provider with its own policy).

Per-account routing. One account can have its own egress proxy instead: set
"routing": "socks5h://user:pass@host:1080" on the account, or run
'teamclaude routing <name> <url>', or pass --routing to login/import. Every
connection for that account — forwarding, token refresh, profile, usage and
quota — tunnels through that proxy with TLS end to end; no other account is
affected, and the account bypasses both the fleet upstream proxy and sx (its
contract is that its traffic never leaves by another path). Schemes: http
(CONNECT), socks4, socks4a, socks5, socks5h — the a/h forms resolve hostnames
at the proxy; optional user:pass@ auth (SOCKS4 takes a username only). A bare
host:port is http. Shown masked in 'accounts', status, and the TUI.
A new URL is tested before it is saved (a tunnel to the account's upstream, no
request sent); --no-check skips that, and 'routing <name> --check' tests the
one an account already has. 'login --name <account>' signs a routed account in
again through the routing it already has. If the proxy goes down, the request
fails over to the next account and the routed one sits out for 30 seconds.

Egress pin (opt-in, off unless configured). Set "egress": { "pin": "auto" } to
hold requests whenever the exit IP is not the pinned one — a VPN that dropped
mid-session otherwise sends the request from an unexpected region, and upstream
answers 403, which Claude Code reports as a dead session and demands a re-login.
"auto" pins whatever address the server sees first; an explicit IP (or a list of
them) pins those. Held requests wait up to holdSeconds (default 120), then get a
503. See config.example.json.

A global npm install self-updates in the background (checked once/day, applied
on the next launch). Disable with TEAMCLAUDE_DISABLE_AUTOUPDATE=1 or
"autoUpdate": false in the config.

Config: ${getConfigPath()}
Crash log: ${getCrashLogPath()} (server; written when the process dies unexpectedly)
`);
}

// ── shared account upsert ────────────────────────────────────

/** Short human label for an account's organization, for disambiguating names. */
function orgLabel(a) {
  return a.orgName || (a.orgUuid ? a.orgUuid.slice(0, 8) : 'org');
}

/**
 * @param {string | null | undefined} name
 * @param {Record<string, any>} creds
 * @param {string} [source]
 * @param {import('./account-routing.js').RoutingProxy|null} [routing] - the
 * account's own egress proxy (see loginRouting). The profile lookup below (and
 * the token refresh it may need first) is already that account's traffic, so
 * it goes the same way; null leaves every call on the fleet path.
 * @param {boolean} [storeRouting] - false when `routing` was borrowed from the
 * existing entry rather than given with --routing: used, never written. True
 * with a null `routing` is `--routing none`: the entry's routing is cleared.
 * @param {{ fatal?: boolean, notify?: boolean }} [opts] The CLI exits on an
 *   unidentifiable account and pokes a running server afterwards. The TUI's
 *   login runs INSIDE that server: it must survive a failed login (`fatal:
 *   false` throws instead) and reloads itself rather than over HTTP.
 * @returns {Promise<{ action: 'updated' | 'added', name: string }>}
 */
async function upsertOAuthAccount(name, creds, source = 'unknown', routing = null, storeRouting = false, { fatal = true, notify = true } = {}) {
  // Fetch profile to auto-name and deduplicate by account+org identity. A
  // credentials file is routinely past its access token's hour while its
  // refresh token is still good, so a stale token is renewed first and the
  // renewed pair is what gets saved below — `creds` is the set to write.
  const userNamed = !!name;
  const identified = await profileForCredentials(creds, routing);
  creds = identified.creds;
  const profile = identified.profile;
  const profileOk = profile && !profile.error;

  if (!canUpsertOAuthAccount(profile, userNamed)) {
    const why = `Could not identify OAuth account — ${profile?.error || 'profile unavailable'}`;
    // --name is the documented way past a profile the proxy could not read, but
    // it is not a way past a token the upstream refused: suggesting it there
    // would be pointing at the one door this no longer opens.
    const advice = isTokenRejection(profile)
      ? 'The upstream rejected this token and it could not be refreshed. Run `teamclaude login` to get a fresh one.'
      : 'Retry with valid credentials, or pass --name to add the account without profile detection.';
    // The TUI shows one line per event, so the advice rides along in the message.
    if (!fatal) throw new Error(`${why}. ${advice}`);
    console.error(why);
    console.error(advice);
    process.exit(1);
  }

  if (!profileOk) {
    console.error(`Warning: importing named account without profile detection — ${profile?.error || 'profile unavailable'}`);
  }
  if (!name && profile?.email) {
    name = profile.email;
    const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
    if (tier) console.log(`Detected Claude ${tier} account: ${profile.email}`);
  }
  // The login or import that produced `creds` ran between the caller's config
  // load and this save — a browser flow can take minutes — and a running server
  // may have rotated another account's refresh token on disk meanwhile. Saving
  // a copy loaded before that would put the dead token back, and the account
  // would fail on its next restart. So the whole upsert runs against a fresh
  // read of the file: only this account's row (and, in the multi-org case, the
  // display name of its namesakes) changes; every other row stays as it is on
  // disk.
  /** @type {{ action: 'updated' | 'added', name: string }} */
  let outcome = { action: 'added', name: name || '' };
  const config = await atomicConfigUpdate(config => {
    if (!name) {
      const n = config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
      name = `account-${n}`;
    }

    const account = {
      name,
      type: 'oauth',
      source,
      ...oauthIdentityFields(profile),
      organizationType: profile?.organizationType || null,
      rateLimitTier: profile?.rateLimitTier || creds.rateLimitTier || null,
      seatTier: profile?.seatTier || null,
      hasClaudeMax: profile?.hasClaudeMax ?? null,
      hasClaudePro: profile?.hasClaudePro ?? null,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      // Key absent rather than null when --routing was not passed: on a
      // re-login updateAccountEntry spreads incoming over prev, so the routing
      // the entry already had survives instead of being silently cleared.
      ...(routing && storeRouting ? { routing: routingToUrl(routing) } : {}),
    };

    // Deduplicate by account+org identity (same email in a different org is a
    // distinct account), then by name — but only where the name is not standing in
    // for a different account+org, which is exactly the multi-org case below.
    const idx = findUpsertTarget(config.accounts, account);

    if (idx >= 0) {
      // Same account+org: refresh credentials and org info, but keep the existing
      // display name, entry id, and any disk-only fields (e.g. importFrom).
      const prev = config.accounts[idx];
      config.accounts[idx] = updateAccountEntry(prev, account);
      outcome = { action: 'updated', name: prev.name };
      if (storeRouting && !routing) delete config.accounts[idx].routing; // --routing none
      console.log(`Updated account "${prev.name}"`);
      if (!storeRouting) noteUnusedRouting(prev, routing);
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
      outcome = { action: 'added', name: account.name };
      console.log(`Added account "${account.name}"`);
    }
  });
  console.log(`Saved to ${getConfigPath()}`);
  if (notify) await notifyRunningServer(config);
  return outcome;
}

// ── config sync helpers ─────────────────────────────────────

/**
 * Find the config entry a running account came from, by entry id only; -1 when
 * no row carries its id.
 *
 * There is deliberately no identity fallback (mirroring syncRefreshedTokens).
 * sameIdentity is not one-to-one: it compares organization only when BOTH
 * records carry one and falls back to the name otherwise, so for one person
 * holding accounts in two organizations — the case the identity module exists
 * for — both rows match and the first one wins. Resolving a token write that way
 * records one account's refresh-token family against another account's row
 * (#203), and on a fleet holding other people's accounts that is a credential
 * crossing. A -1 means the write is skipped: an account the file no longer
 * describes has no row of its own, and any row picked for it would be another
 * account's.
 *
 * The id is exact and survives the refresh that rewrites the credential. A file
 * written before the field existed gets its ids persisted at startup
 * (persistMintedAccountIds), so the in-memory ids are the on-disk ids.
 */
function findConfigAccount(diskConfig, account) {
  if (!account?.id) return -1;
  return diskConfig.accounts.findIndex(a => a?.id === account.id);
}

/**
 * Persist the entry ids loadConfig just minted, if the file did not carry them.
 *
 * Every later token write pairs its row by id and re-reads the file to do it. A
 * config written before the field existed has ids in memory only, and the
 * re-read would mint a second, different set — nothing would pair until the
 * next start, and refreshed tokens would never reach disk. One save up front
 * makes the in-memory ids the on-disk ids. A file that already carries a
 * complete, unique set is left alone.
 */
async function persistMintedAccountIds(config) {
  let raw;
  try {
    raw = JSON.parse(await readFile(getConfigPath(), 'utf-8'));
  } catch {
    return; // nothing on disk to reconcile with (or unreadable — the next save will tell)
  }
  const ids = (Array.isArray(raw?.accounts) ? raw.accounts : []).map(a => a?.id);
  const complete = ids.every(id => typeof id === 'string' && id !== '') && new Set(ids).size === ids.length;
  if (!complete) await saveConfig(config);
}

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

/**
 * Apply a settings change, exiting with its message when the change is refused.
 * @template T
 * @param {() => T} change
 * @returns {T}
 */
function applyOrExit(change) {
  try {
    return change();
  } catch (err) {
    if (!(err instanceof ConfigOpError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
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
// changes, plus eventLogging and blockedModels edits; account removals still
// need a restart.
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
