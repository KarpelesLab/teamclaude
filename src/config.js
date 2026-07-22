import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export function getConfigPath() {
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG;
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configDir, 'teamclaude.json');
}

/**
 * Path to the runtime state file (a sibling of the config). This holds volatile
 * data learned at runtime — e.g. quota utilization observed passively from
 * traffic — kept out of the hand-editable config so config stays clean and
 * isn't rewritten on every state save.
 */
export function getStatePath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '.state.json') : cfg + '.state';
}

export async function loadState() {
  try {
    return JSON.parse(await readFile(getStatePath(), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveState(state) {
  const path = getStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  // `mode` only applies when the file is CREATED; enforce 0600 on every save so
  // a pre-existing state file (holding quota + tokens) can't linger world-readable.
  await chmod(path, 0o600).catch(() => {});
}

export function createDefaultConfig() {
  return {
    proxy: {
      port: 3456,
      apiKey: 'tc-' + randomBytes(24).toString('base64url'),
    },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.98,
    holdSeconds: 0,
    distributeSessions: false,
    eventLogging: 'hide',
    blockedModels: [],
    accounts: [],
  };
}

export async function loadConfig() {
  const path = getConfigPath();
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadOrCreateConfig() {
  let config = await loadConfig();
  if (!config) {
    config = createDefaultConfig();
    await saveConfig(config);
    console.log(`Created config at ${getConfigPath()}`);
  }
  return config;
}

export async function saveConfig(config) {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  // Enforce 0600 even if the file already existed (the proxy apiKey + account
  // tokens live here); `mode` above is honored only on creation.
  await chmod(path, 0o600).catch(() => {});
}

// Serialize config updates. atomicConfigUpdate is a read-modify-write, so two
// concurrent callers can both read the same config and then save in turn, and
// the later save silently drops the earlier caller's change. This bites hardest
// on startup, when several OAuth accounts refresh their tokens at once: only the
// last writer's rotated refresh token persists, and the other accounts keep a
// token that was just rotated away, so they fail on the next restart with
// invalid_grant and need a re-login. Chaining the updates keeps every write.
let configUpdateChain = Promise.resolve();

/**
 * Atomically update the config: re-reads from disk, calls updater(config),
 * then saves. Returns the updated config. This prevents overwriting changes
 * made by other processes (e.g. `teamclaude import` while the server runs), and
 * serializes concurrent callers so simultaneous updates queue instead of
 * clobbering one another.
 */
export function atomicConfigUpdate(updater) {
  const run = async () => {
    const config = await loadConfig() || createDefaultConfig();
    await updater(config);
    await saveConfig(config);
    return config;
  };
  const result = configUpdateChain.then(run, run);
  configUpdateChain = result.then(() => {}, () => {});
  return result;
}
