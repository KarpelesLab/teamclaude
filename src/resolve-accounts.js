import { setRefreshTokenExpiry } from './refresh-token-expiry.js';
import { importCredentials } from './oauth.js';
import { importCodexCredentials, DEFAULT_CODEX_CREDENTIALS_PATH } from './codex-auth.js';
import { importGrokCredentials, DEFAULT_GROK_CREDENTIALS_PATH } from './grok-auth.js';
import { providerOf } from './provider.js';

// How each provider's own CLI stores its login, for `importFrom`. A provider
// with a default path is pooled from its CLI's file when the entry carries no
// token of its own; Claude Code's file has no single home, so it needs the path.
const CREDENTIAL_FILES = {
  anthropic: { read: importCredentials, defaultPath: null },
  codex: { read: importCodexCredentials, defaultPath: DEFAULT_CODEX_CREDENTIALS_PATH },
  grok: { read: importGrokCredentials, defaultPath: DEFAULT_GROK_CREDENTIALS_PATH },
};

/**
 * The reader for an account's credentials file, and the file its provider's
 * CLI keeps when the entry names none.
 * @param {Record<string, any>} acct
 * @returns {{ read: (path: string) => Promise<Record<string, any>>, defaultPath: string|null }}
 */
export function credentialFileFor(acct) {
  return CREDENTIAL_FILES[providerOf(acct)];
}

/**
 * Turn configured accounts into the objects the AccountManager is built from:
 * `importFrom` entries have their credentials read from disk, and entries with
 * no usable credential are dropped with a message.
 *
 * Config fields are carried through verbatim — the import supplies ONLY the
 * credential fields. Rebuilding an imported account as `{ name, type, ...creds }`
 * used to discard everything else on it (`disabled`, `priority`, `upstream`,
 * `modelMap`, `models`), so an account disabled on disk silently rejoined
 * rotation on every restart and a third-party backend lost its upstream.
 * @param {{ accounts: Array<Record<string, any>> }} config
 */
export async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      // A Codex or Grok account defaults to its CLI's own credentials file,
      // so `{ "name": "...", "type": "oauth", "provider": "codex" }` is enough
      // to pool an already-signed-in login. A default, not an override: that
      // file holds ONE login, and importing it over an account that has its
      // own credential collapsed every Codex row onto that login, discarding
      // what `teamclaude login --codex` had stored.
      const file = credentialFileFor(acct);
      if (acct.importFrom || (file.defaultPath && !acct.accessToken)) {
        const from = acct.importFrom || file.defaultPath;
        try {
          const creds = await file.read(from);
          // A readable file with no token is as unusable as a missing one; the
          // non-import branch below already refuses that case, and pushing it
          // anyway would send `Bearer undefined` upstream on every request.
          if (!creds.accessToken) {
            console.error(`No token in ${from} for "${acct.name}", skipping`);
            continue;
          }
          // The file's tokens win, so the date is the file's too: one the
          // entry kept from an earlier token says nothing about these.
          /** @type {any} */
          const row = { ...acct, ...creds };
          setRefreshTokenExpiry(row, /** @type {Record<string, any>} */ (creds).refreshTokenExpiresAt);
          accounts.push(row);
          console.log(`Imported "${acct.name}" from ${from}`);
        } catch (/** @type {any} */ err) {
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
