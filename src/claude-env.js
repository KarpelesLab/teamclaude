// Percent-encode an account name (or key) for a URL, leaving ONLY the unreserved
// set. encodeURIComponent alone is not enough here: it passes `( ) ' ! *`
// through untouched, and these lines are emitted as unquoted shell `export`
// statements for `eval "$(teamclaude env)"` — a name like "work (Acme)" would be
// a shell syntax error. Clients percent-decode userinfo before using it
// (verified against Claude Code 2.1.220), so the extra escaping is transparent.
/**
 * @param {string} s
 */
export function encodePinComponent(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * @param {unknown} value
 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

/**
 * `port` as a number in 1..65535, or a throw. Strict on purpose: parseInt alone
 * would turn "3456; touch /tmp/x" into 3456 and hide the bad config value that
 * would otherwise have been eval'd.
 * @param {unknown} port
 */
export function validPort(port) {
  const text = String(port ?? '').trim();
  const n = /^\d{1,5}$/.test(text) ? Number.parseInt(text, 10) : NaN;
  if (!(n >= 1 && n <= 65535)) {
    throw new Error(`proxy.port must be an integer between 1 and 65535, got ${JSON.stringify(port)}`);
  }
  return n;
}

// The loopback entries every launched client gets. They keep the client's own
// localhost traffic out of the proxy: a forward to loopback is refused
// (forward-target.js), so a client that proxied it would get a 403 instead of
// its own dev server.
export const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1'];

/**
 * True if `value` names `*` — "proxy nothing" — among its entries.
 *
 * @param {unknown} value
 */
export function bypassesAllHosts(value) {
  return String(value ?? '').split(',').some((entry) => entry.trim() === '*');
}

/**
 * The NO_PROXY a launched client gets: ours, plus whatever the operator had.
 *
 * Replacing theirs broke the case the list exists for. A local dev host is
 * rarely spelled `localhost` — `*.test` and friends resolve to 127.0.0.1
 * through a local resolver — so with only our three entries the client proxies
 * it, the proxy refuses the loopback forward, and the client retries the 403 on
 * a loop. Their entries are kept verbatim (a leading dot or a `host:port` is
 * theirs to mean), deduped case-insensitively, ours first.
 *
 * `*` is the one entry dropped: it routes every host around the proxy,
 * api.anthropic.com included, which silently turns the launch into a direct run
 * — no rotation, the operator's own quota. `--no-mitm` is how that is asked for.
 * @param {...(string|null|undefined)} inherited
 */
export function mergeNoProxy(...inherited) {
  const seen = new Set();
  const out = [];
  const entries = inherited.flatMap((value) => String(value ?? '').split(','));
  for (const entry of [...LOOPBACK_NO_PROXY, ...entries]) {
    const host = entry.trim();
    if (!host || host === '*' || seen.has(host.toLowerCase())) continue;
    seen.add(host.toLowerCase());
    out.push(host);
  }
  return out.join(',');
}

/** The two ways a launched client can reach the proxy. */
export const CLIENT_MODES = ['mitm', 'base-url'];

/**
 * Which mode `run` and `env` use: a `--mitm` or `--no-mitm` flag decides, else
 * the config's `defaultClientMode`, else MITM.
 *
 * MITM routes every request of the launched client through the proxy, so the
 * hard-coded api.anthropic.com endpoints and the Codex CLI (which honours only
 * proxy variables) are covered. It is also the whole point of the setting: with
 * `eval "$(teamclaude env)"` the proxy variables are shell-wide, and every other
 * tool in that shell — gh, git, a package manager — follows them to a listener
 * that only speaks to two hosts (#382). An operator who lives in such a shell
 * sets `defaultClientMode: "base-url"` once and opts back in per launch.
 *
 * @param {{ defaultClientMode?: string }|null|undefined} config
 * @param {string[]} flags  the invocation's own arguments
 * @returns {'mitm'|'base-url'}
 */
export function resolveClientMode(config, flags) {
  const mitm = flags.includes('--mitm');
  const noMitm = flags.includes('--no-mitm');
  if (mitm && noMitm) throw new Error('choose either --mitm or --no-mitm');
  if (mitm) return 'mitm';
  if (noMitm) return 'base-url';
  return config?.defaultClientMode === 'base-url' ? 'base-url' : 'mitm';
}

const SHELL_PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

/**
 * @param {unknown} value
 * @param {number} port
 */
function pointsAtLoopback(value, port) {
  if (!value) return false;
  try {
    const url = new URL(String(value));
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return ['127.0.0.1', 'localhost', '::1'].includes(host) && Number(url.port || 80) === port;
  } catch {
    return false;
  }
}

/**
 * `unset` lines for proxy variables a previous MITM-mode eval left in the
 * shell, so re-evaluating in base-URL mode takes the proxy back out of it. Only
 * a value naming THIS proxy's loopback port is touched: a real corporate proxy
 * in the same variables is the operator's and stays.
 *
 * @param {unknown} port
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function clearSelfProxyEnvLines(port, env = process.env) {
  const checkedPort = validPort(port);
  return SHELL_PROXY_VARS.filter(name => pointsAtLoopback(env[name], checkedPort)).map(name => `unset ${name}`);
}

// Build the shell `export` lines that point Claude Code — or any tool that
// spawns it, e.g. an agent multiplexer — at the proxy. This is the same
// environment `teamclaude run` sets up, but emitted for `eval "$(teamclaude
// env)"` instead of launching claude directly. Pure and side-effect free so it
// can be unit-tested; the caller resolves the port, cert path, holdSeconds and
// the NO_PROXY the invoking shell already had.
//
// MITM (forward-proxy) mode is the default, matching `teamclaude run`: it routes
// ALL of claude's traffic through the proxy — even hardcoded api.anthropic.com
// endpoints (e.g. the design MCP) — with claude trusting our leaf via
// NODE_EXTRA_CA_CERTS. base-URL mode only redirects the Anthropic base URL and
// leaves other hosts alone.
//
// No ANTHROPIC_API_KEY is emitted: loopback clients are exempt from the proxy's
// key gate, and setting it would drop Claude Code out of subscription mode (and
// its full model access). Remote clients that aren't on loopback must add the
// proxy key themselves.
// `account` pins the session to one account (TC_ACCT), exactly as `teamclaude
// run` does: in MITM mode it rides in the proxy URL's userinfo and reaches the
// proxy as the CONNECT's Basic username; in base-URL mode it becomes a
// `/tc-acct/` prefix. TC_ACCT itself is then unset, so the pin does not leak
// into claude or anything it spawns — same reasoning as `run` deleting it from
// the child environment.
/**
 * @param {Object} opts
 * @param {unknown} opts.port
 * @param {boolean} [opts.useMitm]
 * @param {string|null} [opts.caPath]
 * @param {number} [opts.holdSeconds]
 * @param {string|null} [opts.account]
 * @param {string} [opts.proxyApiKey]
 * @param {string|null} [opts.inheritedNoProxy]
 */
export function buildClaudeEnvLines({ port, useMitm = true, caPath = null, holdSeconds = 0, account = null, proxyApiKey = '', inheritedNoProxy = null }) {
  const lines = [];
  const pin = (account || '').trim();
  // The port is interpolated unquoted into URLs the shell evals, so it has to
  // BE a port: a config value of "3456; rm -rf ~" was emitted verbatim.
  port = validPort(port);

  if (useMitm) {
    const userinfo = pin ? `${encodePinComponent(pin)}:${encodePinComponent(proxyApiKey || '')}@` : '';
    const proxyUrl = `http://${userinfo}127.0.0.1:${port}`;
    const noProxy = mergeNoProxy(inheritedNoProxy);
    lines.push(
      `export HTTPS_PROXY=${proxyUrl}`,
      `export HTTP_PROXY=${proxyUrl}`,
      `export https_proxy=${proxyUrl}`,
      `export http_proxy=${proxyUrl}`,
      // Quoted like the CA path below: the value now carries whatever the
      // operator's own NO_PROXY held, and this line is eval'd.
      `export NO_PROXY=${shellQuote(noProxy)}`,
      `export no_proxy=${shellQuote(noProxy)}`,
    );
    // Quoted: the path is under $HOME (or XDG_CONFIG_HOME), which can carry a
    // space or a quote, and this line is eval'd.
    if (caPath) lines.push(`export NODE_EXTRA_CA_CERTS=${shellQuote(caPath)}`);
    // Clear any stale base-URL so the two modes don't stack in one shell.
    lines.push('unset ANTHROPIC_BASE_URL');
  } else {
    const prefix = pin ? `/tc-acct/${encodePinComponent(pin)}` : '';
    lines.push(`export ANTHROPIC_BASE_URL=http://localhost:${port}${prefix}`);
  }

  // The pin is now carried by the routing itself; keep it out of the child.
  if (pin) lines.push('unset TC_ACCT');

  // Parity with `run`: if the proxy may hold the connection on exhaustion, raise
  // the client-side timeout so it doesn't give up mid-hold.
  const holdMs = (holdSeconds || 0) * 1000;
  if (holdMs > 0) lines.push(`export API_TIMEOUT_MS=${holdMs + 60_000}`);

  return lines;
}

// A claude that died within this long of launch did not get to a prompt.
export const LOCAL_LOGIN_HINT_WINDOW_MS = 20_000;

const NO_LOGIN = 'Claude Code has no login of its own on this machine, and it needs one before it will talk to the proxy (the pool\'s accounts are separate). Run `claude auth login`, then try again.';
const STALE_LOGIN = 'If claude reported an expired OAuth session: that is Claude Code\'s own login (~/.claude/.credentials.json), which it checks before it sends anything, not the proxy\'s accounts. Run `claude auth login`, then try again.';

/**
 * One line naming Claude Code's own login as the likely cause of a launch that
 * failed straight away, or null when that login looks fine. Claude Code checks
 * its local login before it sends anything, in either client mode: with that
 * login expired and unrefreshable it exits at once with "OAuth session expired
 * and could not be refreshed", and nothing reaches the proxy (#395). That reads
 * like the pool being broken, so `run` says which login it was when the session
 * ended that quickly and that badly. Only a hint: a fast non-zero exit with a
 * stale local login is the shape of that failure, not proof of it. The pool's
 * accounts are the proxy's; the client's own login expires independently.
 * @param {{ read: (path: string) => Promise<Record<string, any>>, expired: (expiresAt: unknown) => boolean }} deps
 *   the credentials reader (oauth.js importCredentials) and the expiry test
 * @returns {Promise<string|null>}
 */
export async function localLoginHint({ read, expired }) {
  let creds;
  try { creds = await read('~/.claude/.credentials.json'); }
  catch { return NO_LOGIN; }
  if (!creds?.accessToken && !creds?.refreshToken) return NO_LOGIN;
  if (expired(creds.expiresAt)) return STALE_LOGIN;
  return null;
}
