import { importCredentials } from './oauth.js';
import { importCodexCredentials, DEFAULT_CODEX_CREDENTIALS_PATH } from './codex-auth.js';
import { providerOf } from './provider.js';

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
 */
export async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      if (acct.importFrom || providerOf(acct) === 'codex') {
        // A Codex account defaults to the Codex CLI's own credentials file, so
        // `{ "name": "...", "type": "oauth", "provider": "codex" }` is enough
        // to pool an already-signed-in Codex login.
        const isCodex = providerOf(acct) === 'codex';
        const from = acct.importFrom || (isCodex ? DEFAULT_CODEX_CREDENTIALS_PATH : null);
        if (!from) { console.error(`No token for "${acct.name}", skipping`); continue; }
        try {
          const creds = isCodex ? await importCodexCredentials(from) : await importCredentials(from);
          // A readable file with no token is as unusable as a missing one; the
          // non-import branch below already refuses that case, and pushing it
          // anyway would send `Bearer undefined` upstream on every request.
          if (!creds.accessToken) {
            console.error(`No token in ${from} for "${acct.name}", skipping`);
            continue;
          }
          accounts.push({ ...acct, ...creds });
          console.log(`Imported "${acct.name}" from ${from}`);
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
