import { createHmac, timingSafeEqual } from 'node:crypto';
import { mergeNoProxy } from './claude-env.js';

const PREFIX = 'tc-managed-v1.';
// Normal account reload is deliberately additive. Managed identity revocation
// needs the latest disk membership without changing that inference contract.
// Keep only eligibility metadata, never access tokens, refresh tokens or URLs.
const reloadedIdentities = new WeakMap();

export function syncManagedClientAuth(diskConfig, liveConfig) {
  liveConfig.proxy ||= {};
  liveConfig.proxy.managedClientAuth = diskConfig.proxy?.managedClientAuth === true;
  reloadedIdentities.set(liveConfig, (diskConfig.accounts || []).map(account => ({
    id: account.id,
    type: account.type,
    provider: account.provider,
    disabled: !!account.disabled,
    upstream: !!account.upstream,
    status: account.status,
  })));
}

function identityAccounts(config) {
  return reloadedIdentities.get(config) || config.accounts || [];
}

function enabled(config) {
  return config?.proxy?.managedClientAuth === true
    && typeof config.proxy.apiKey === 'string' && config.proxy.apiKey.length > 0;
}

function eligible(account) {
  return account?.type === 'oauth'
    && (!account.provider || account.provider === 'anthropic')
    && !account.disabled && !account.upstream && account.status !== 'error'
    && typeof account.id === 'string' && account.id.length > 0;
}

function signature(config, payload) {
  return createHmac('sha256', config.proxy.apiKey).update(payload).digest('base64url');
}

/** A local launch credential: binds identity, never contains provider tokens. */
export function issueManagedCredential(config, accountId = null) {
  if (!enabled(config)) throw new Error('Managed client authentication requires an enabled mode and proxy key');
  const accounts = identityAccounts(config);
  const account = accountId == null
    ? accounts.find(eligible)
    : accounts.find(a => a.id === accountId);
  if (!eligible(account) || accounts.filter(a => a.id === account.id).length !== 1) {
    throw new Error('Managed client identity account is missing, disabled or unavailable');
  }
  const payload = `${PREFIX}${Buffer.from(account.id, 'utf8').toString('base64url')}`;
  return `${payload}.${signature(config, payload)}`;
}

/** null means an ordinary provider credential, whose existing relay is intact. */
export function resolveManagedCredential(config, authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const token = authorizationHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token.startsWith('tc-managed-v1')) return null;
  if (!enabled(config)) return { ok: false, reason: 'Managed client authentication is disabled or has no proxy key' };
  const match = /^tc-managed-v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || !/^Bearer\s+/i.test(authorizationHeader)) {
    return { ok: false, reason: 'Malformed managed client credential' };
  }
  const expected = signature(config, `${PREFIX}${match[1]}`);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]))) {
    return { ok: false, reason: 'Invalid or revoked managed client credential' };
  }
  // Require canonical UTF-8/base64url encoding, preventing ambiguous identities.
  const accountId = Buffer.from(match[1], 'base64url').toString('utf8');
  if (Buffer.from(accountId, 'utf8').toString('base64url') !== match[1]) {
    return { ok: false, reason: 'Malformed managed account identity' };
  }
  const accounts = identityAccounts(config).filter(a => a.id === accountId);
  if (accounts.length !== 1 || !eligible(accounts[0])) {
    return { ok: false, reason: 'Managed identity account is missing, disabled or unavailable' };
  }
  return { ok: true, accountId };
}

// Values read by the installed Claude CLI that can select a personal token,
// alternate provider or alternate OAuth origin instead of the managed bearer.
const CLEAR_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_OAUTH_CLIENT_ID', 'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
];

function bypassesHost(entry, host) {
  // Be conservative across proxy implementations: a bare domain can also match
  // subdomains, a leading dot is a suffix, and wildcards vary by runtime.
  const pattern = entry.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '').replace(/^\./, '');
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');
  if (pattern.includes('*')) {
    const escaped = pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^(?:.*\\.)?${escaped}$`).test(normalizedHost);
  }
  return normalizedHost === pattern || normalizedHost.endsWith(`.${pattern}`);
}

/** Copy only: never mutate the parent environment or the user's saved login. */
export function buildManagedEnv(env, token, interceptedHosts = ['api.anthropic.com']) {
  const result = { ...env };
  for (const key of CLEAR_ENV) delete result[key];
  result.CLAUDE_CODE_OAUTH_TOKEN = token;
  const noProxy = mergeNoProxy(env.NO_PROXY, env.no_proxy).split(',')
    .filter(entry => !interceptedHosts.some(host => bypassesHost(entry, host))).join(',');
  result.NO_PROXY = result.no_proxy = noProxy;
  return result;
}
