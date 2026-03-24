#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadOrCreateConfig, saveConfig, getConfigPath } from './config.js';
import { AccountManager } from './account-manager.js';
import { createProxyServer } from './server.js';
import { importCredentials, loginOAuth } from './oauth.js';
import { TUI } from './tui.js';

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'server':
    await serverCommand();
    break;
  case 'import':
    await importCommand();
    break;
  case 'login':
    await loginCommand();
    break;
  case 'env':
    await envCommand();
    break;
  case 'run':
    await runCommand();
    break;
  case 'status':
    await statusCommand();
    break;
  case 'accounts':
    await accountsCommand();
    break;
  case 'remove':
    await removeCommand();
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
  const port = config.proxy.port;
  const useTUI = process.stdout.isTTY && process.stdin.isTTY;

  let tui = null;
  let hooks = {};

  if (useTUI) {
    tui = new TUI({
      accountManager, config, saveConfig,
      onQuit: () => { server.close(() => process.exit(0)); },
    });
    hooks = {
      onRequestStart: (id, info) => tui.onRequestStart(id, info),
      onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
      onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
    };
  }

  const server = createProxyServer(accountManager, config, hooks);

  server.listen(port, () => {
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

  if (!tui) {
    process.on('SIGINT', () => {
      console.log('\n[TeamClaude] Shutting down...');
      server.close(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      console.log('\n[TeamClaude] Shutting down...');
      server.close(() => process.exit(0));
    });
  }
}

// ── import ──────────────────────────────────────────────────

async function importCommand() {
  const config = await loadOrCreateConfig();

  let name = argValue('--name');
  const fromPath = argValue('--from') || '~/.claude/.credentials.json';

  let creds;
  try {
    creds = await importCredentials(fromPath);
  } catch (err) {
    console.error(`Failed to import from ${fromPath}: ${err.message}`);
    process.exit(1);
  }

  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('max-')).length + 1;
    name = `max-${n}`;
  }

  const account = {
    name,
    type: 'oauth',
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };

  const idx = config.accounts.findIndex(a => a.name === name);
  if (idx >= 0) {
    config.accounts[idx] = account;
    console.log(`Updated account "${name}"`);
  } else {
    config.accounts.push(account);
    console.log(`Added account "${name}"`);
  }

  await saveConfig(config);
  console.log(`Saved to ${getConfigPath()}`);
}

// ── login ───────────────────────────────────────────────────

async function loginCommand() {
  if (args.includes('--api')) {
    await loginApiCommand();
  } else {
    await loginOAuthCommand();
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

  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('max-')).length + 1;
    name = `max-${n}`;
  }

  const account = {
    name,
    type: 'oauth',
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };

  config.accounts.push(account);
  await saveConfig(config);
  console.log(`Added OAuth account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
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

  // Everything after 'run' (skip -- separator if present)
  const claudeArgs = args.slice(1);
  if (claudeArgs[0] === '--') claudeArgs.shift();

  // Only set ANTHROPIC_BASE_URL — Claude Code will use its own OAuth token
  // which the proxy accepts as a known credential. Setting ANTHROPIC_API_KEY
  // would cause an "auth conflict" warning in Claude Code.
  const child = spawn('claude', claudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${config.proxy.port}`,
    },
  });

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('Claude Code not found in PATH. Install it first.');
    } else {
      console.error(`Failed to start claude: ${err.message}`);
    }
    process.exit(1);
  });

  child.on('exit', (code) => process.exit(code ?? 1));
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
      const tokenPct = acct.quota.tokensLimit
        ? ((1 - acct.quota.tokensRemaining / acct.quota.tokensLimit) * 100).toFixed(1) + '%'
        : '-';
      const reqPct = acct.quota.requestsLimit
        ? ((1 - acct.quota.requestsRemaining / acct.quota.requestsLimit) * 100).toFixed(1) + '%'
        : '-';
      const current = acct.name === data.currentAccount ? ' *' : '';

      console.log(`  ${acct.name} (${acct.type})${current}`);
      console.log(`    Status:   ${acct.status}`);
      console.log(`    Tokens:   ${tokenPct} used    Requests: ${reqPct} used`);
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

  if (config.accounts.length === 0) {
    console.log('No accounts configured.');
    console.log('Add one with: teamclaude import, teamclaude login, or teamclaude login --api');
    return;
  }

  for (const [i, a] of config.accounts.entries()) {
    const hint = a.type === 'apikey'
      ? a.apiKey?.slice(0, 15) + '...'
      : a.importFrom || (a.accessToken?.slice(0, 15) + '...');
    console.log(`  [${i + 1}] ${a.name} (${a.type})  ${hint}`);
  }
}

// ── remove ──────────────────────────────────────────────────

async function removeCommand() {
  const config = await loadOrCreateConfig();
  const name = args[1];

  if (!name) {
    console.error('Usage: teamclaude remove <account-name>');
    process.exit(1);
  }

  const idx = config.accounts.findIndex(a => a.name === name);
  if (idx < 0) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }

  config.accounts.splice(idx, 1);
  await saveConfig(config);
  console.log(`Removed account "${name}"`);
}

// ── help ────────────────────────────────────────────────────

function showHelp() {
  console.log(`TeamClaude - Multi-account Claude proxy

Usage: teamclaude [command] [options]

Commands:
  server              Start the proxy server (default)
  import              Import credentials from Claude Code
  login               OAuth login via browser
  login --api         Add an API key account
  env                 Print env vars to use with Claude
  run [-- args...]    Run Claude Code through the proxy
  status              Show proxy & account status (live)
  accounts            List configured accounts
  remove <name>       Remove an account
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --from PATH         Credentials path (import, default: ~/.claude/.credentials.json)

Config: ${getConfigPath()}
`);
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
