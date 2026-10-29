// Where the backend keeps its config and how to reach it. This mirrors the
// backend's own rules (src/config.js getConfigPath, src/brand.js envVar,
// src/index.js bindHost) rather than importing them: the desktop must not
// depend on backend internals, and the rules are small and stable. Only the
// main process reads the config file, and only the four proxy fields below are
// taken from it — account credentials are never read.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const NAME = 'teamrouter';
export const LEGACY_NAME = 'teamclaude';
export const DEFAULT_PORT = 3456;
export const DEFAULT_HOST = '127.0.0.1';

/** `envVar('CONFIG')` → TEAMROUTER_CONFIG, else TEAMCLAUDE_CONFIG (brand.js). */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const renamed = env[`TEAMROUTER_${name}`];
  return renamed !== undefined ? renamed : env[`TEAMCLAUDE_${name}`];
}

function configDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.XDG_CONFIG_HOME || join(home, '.config');
}

/** Same resolution as the backend's getConfigPath(). */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  const fromEnv = envVar('CONFIG', env);
  if (fromEnv) return fromEnv;
  const dir = configDir(env, home);
  const renamed = join(dir, `${NAME}.json`);
  if (exists(renamed)) return renamed;
  return join(dir, `${LEGACY_NAME}.json`);
}

/** Sibling crash log, as getCrashLogPath() names it. */
export function crashLogPath(configPath: string): string {
  return configPath.endsWith('.json') ? configPath.replace(/\.json$/, '-crash.log') : `${configPath}-crash.log`;
}

/** The `systemd --user` unit `teamclaude service install` writes (service.js). */
export function serviceUnitPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(configDir(env, home), 'systemd', 'user', 'teamclaude.service');
}

export function configDirectory(configPath: string): string {
  return dirname(configPath);
}

export interface ProxySettings {
  /** The address the server binds. */
  bindHost: string;
  /** The address this app connects to (a wildcard bind is reached on loopback). */
  connectHost: string;
  port: number;
  /** proxy.apiKey — stays in the main process, used only as x-api-key. */
  apiKey: string | null;
  trustLoopback: boolean;
  /** How many accounts the config lists — a count only; their fields are not read. */
  accountCount: number;
}

export interface ProxySettingsResult {
  settings: ProxySettings;
  exists: boolean;
  /** Set when the file exists but cannot be read as JSON. */
  error: string | null;
}

const WILDCARDS = new Set(['0.0.0.0', '::', '']);

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;
}

/** Pick the proxy fields out of a parsed config object. */
export function proxySettingsFrom(config: unknown, env: NodeJS.ProcessEnv = process.env): ProxySettings {
  const proxy = (config && typeof config === 'object' && 'proxy' in config)
    ? (config as { proxy?: Record<string, unknown> }).proxy ?? {}
    : {};
  const configuredHost = typeof proxy.host === 'string' ? proxy.host : null;
  const bindHost = envVar('HOST', env) || configuredHost || DEFAULT_HOST;
  const accounts = config && typeof config === 'object' ? (config as { accounts?: unknown }).accounts : undefined;
  return {
    bindHost,
    connectHost: WILDCARDS.has(bindHost) ? DEFAULT_HOST : bindHost,
    port: validPort(proxy.port) ? proxy.port : DEFAULT_PORT,
    apiKey: typeof proxy.apiKey === 'string' && proxy.apiKey ? proxy.apiKey : null,
    trustLoopback: proxy.trustLoopback !== false,
    accountCount: Array.isArray(accounts) ? accounts.length : 0,
  };
}

export function readProxySettings(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = p => readFileSync(p, 'utf8'),
): ProxySettingsResult {
  let text: string;
  try {
    text = read(configPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { settings: proxySettingsFrom({}, env), exists: false, error: null };
    return { settings: proxySettingsFrom({}, env), exists: true, error: `cannot read the config file (${code ?? 'error'})` };
  }
  try {
    return { settings: proxySettingsFrom(JSON.parse(text), env), exists: true, error: null };
  } catch {
    // The parser's message can quote file content; say only what failed.
    return { settings: proxySettingsFrom({}, env), exists: true, error: 'the config file is not valid JSON' };
  }
}
