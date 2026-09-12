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
