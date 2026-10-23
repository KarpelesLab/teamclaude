// Hosts that must never ride the MITM CONNECT path. `teamclaude run` points
// HTTPS_PROXY at the local gateway so Claude Code's hardcoded api.anthropic.com
// calls get token injection — but with proxy.noForwarding the gateway 403s
// CONNECT to every other host. gh/git/curl inherit that proxy and fail with
// "403" / "bad credentials" even when `gh auth` is valid. Loopback stays here
// so the client can still reach the gateway itself; api.anthropic.com must NOT,
// or MITM stops intercepting. Shared by `teamclaude env` and `teamclaude run`.
export const MITM_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  '::1',
  'github.com',
  '.github.com',
  'githubusercontent.com',
  '.githubusercontent.com',
  'ghcr.io',
  '.ghcr.io',
  'downloads.claude.ai',
].join(',');

// Percent-encode an account name (or key) for a URL, leaving ONLY the unreserved
// set. encodeURIComponent alone is not enough here: it passes `( ) ' ! *`
// through untouched, and these lines are emitted as unquoted shell `export`
// statements for `eval "$(teamclaude env)"` — a name like "work (Acme)" would be
// a shell syntax error. Clients percent-decode userinfo before using it
// (verified against Claude Code 2.1.220), so the extra escaping is transparent.
export function encodePinComponent(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Build the shell `export` lines that point Claude Code — or any tool that
// spawns it, e.g. an agent multiplexer — at the proxy. This is the same
// environment `teamclaude run` sets up, but emitted for `eval "$(teamclaude
// env)"` instead of launching claude directly. Pure and side-effect free so it
// can be unit-tested; the caller resolves the port, cert path, and holdSeconds.
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
export function buildClaudeEnvLines({ port, useMitm = true, caPath = null, holdSeconds = 0, account = null, proxyApiKey = '' }) {
  const lines = [];
  const pin = (account || '').trim();

  if (useMitm) {
    const userinfo = pin ? `${encodePinComponent(pin)}:${encodePinComponent(proxyApiKey || '')}@` : '';
    const proxyUrl = `http://${userinfo}127.0.0.1:${port}`;
    lines.push(
      `export HTTPS_PROXY=${proxyUrl}`,
      `export HTTP_PROXY=${proxyUrl}`,
      `export https_proxy=${proxyUrl}`,
      `export http_proxy=${proxyUrl}`,
      `export NO_PROXY=${MITM_NO_PROXY}`,
      `export no_proxy=${MITM_NO_PROXY}`,
    );
    if (caPath) lines.push(`export NODE_EXTRA_CA_CERTS=${caPath}`);
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

// ── direct-launch environment hygiene ───────────────────────

// Proxy variables a parent shell may already carry. Set as a group by `run`'s
// MITM branch and by `teamclaude env`, so they are also inherited as a group.
const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];

/**
 * Strip URL userinfo before logging. Proxy URLs — including teamclaude's own
 * MITM pin form `http://<pin>:<apiKey>@host:port` — carry credentials in the
 * userinfo segment; stderr and captured session logs must not echo them
 * (B62 SECRET_IN_PANE). Preserves scheme + host + port + path. Non-http(s)
 * strings pass through unchanged.
 */
export function redactUrlUserinfo(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^(https?:\/\/)([^\/@]+@)?/i, '$1');
}

/**
 * What a DIRECT launch must do about proxy variables it inherited.
 *
 * `--auto-fallback` promises to launch claude "directly, bypassing the proxy"
 * when the proxy is down — but the child inherits the parent's environment, and
 * the parent shell of a teamclaude session is usually one teamclaude itself set
 * up. So the traffic goes right back through a proxy, and the promise is broken
 * in one of two ways: the variable points at the port we JUST found dead, and
 * every request fails; or it points at some OTHER live proxy, and the session
 * silently runs somewhere the operator was told it would not. The second is the
 * worse one — a wrong destination reported as no destination.
 *
 * The rule is deliberately narrow. Clear only what is provably ours and provably
 * dead: a proxy variable pointing at loopback on the very port whose liveness we
 * just probed and lost. Anything else — a corporate egress proxy, a different
 * live teamclaude — is someone's deliberate configuration and is NOT deleted
 * behind their back; it is returned in `remaining` so the caller can qualify its
 * "direct launch" claim instead of lying about it. Reporting what we will not
 * touch is the same discipline splitRunArgs applies to misplaced flags.
 *
 * ANTHROPIC_BASE_URL is cleared unconditionally when it points at that dead
 * port: unlike the proxy vars it has exactly one meaning here, and leaving it
 * would send every request to a closed socket.
 *
 * Pure: takes an env object, returns a plan, mutates nothing.
 */
export function directLaunchEnvPlan(env, port) {
  const source = env && typeof env === 'object' ? env : {};
  // Tolerate userinfo (`pin:key@host`) — teamclaude's own MITM pin URL is
  // `http://<pin>:<key>@127.0.0.1:<port>`, and a regex that demands host
  // immediately after `://` would leave our own pinned proxy var uncleared.
  const ours = new RegExp(
    `^https?://(?:[^/@]+@)?(127\\.0\\.0\\.1|localhost|\\[::1\\]):${Number(port)}(/|$)`,
    'i',
  );

  // `remaining` is grouped BY VALUE, not listed per variable. The four proxy
  // vars are conventionally set as one group to one URL — teamclaude's own MITM
  // branch does exactly that — so reporting them individually turns a single
  // fact into four near-identical lines and buries it. One destination, one row.
  const clear = [];
  const byValue = new Map();
  for (const name of PROXY_VARS) {
    const value = source[name];
    if (typeof value !== 'string' || !value) continue;
    if (ours.test(value)) { clear.push(name); continue; }
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(name);
  }
  const remaining = [...byValue.entries()].map(([value, names]) => ({ names, value }));

  const base = source.ANTHROPIC_BASE_URL;
  if (typeof base === 'string' && ours.test(base)) clear.push('ANTHROPIC_BASE_URL');

  // Our MITM leaf is worthless to a direct launch and only matters alongside a
  // proxy we are clearing; drop it with them rather than leaving a dangling
  // trust anchor. Gate on PROXY_VARS specifically — a BASE_URL-only match must
  // not discard a corporate NODE_EXTRA_CA_CERTS trust bundle that has nothing
  // to do with the dead teamclaude instance.
  const clearedProxy = clear.some((name) => PROXY_VARS.includes(name));
  if (clearedProxy && typeof source.NODE_EXTRA_CA_CERTS === 'string' && source.NODE_EXTRA_CA_CERTS) {
    clear.push('NODE_EXTRA_CA_CERTS');
  }

  return { clear, remaining };
}
