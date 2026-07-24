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
export function buildClaudeEnvLines({ port, useMitm = true, caPath = null, holdSeconds = 0 }) {
  const lines = [];

  if (useMitm) {
    const proxyUrl = `http://127.0.0.1:${port}`;
    lines.push(
      `export HTTPS_PROXY=${proxyUrl}`,
      `export HTTP_PROXY=${proxyUrl}`,
      `export https_proxy=${proxyUrl}`,
      `export http_proxy=${proxyUrl}`,
      'export NO_PROXY=localhost,127.0.0.1,::1',
      'export no_proxy=localhost,127.0.0.1,::1',
    );
    if (caPath) lines.push(`export NODE_EXTRA_CA_CERTS=${caPath}`);
    // Clear any stale base-URL so the two modes don't stack in one shell.
    lines.push('unset ANTHROPIC_BASE_URL');
  } else {
    lines.push(`export ANTHROPIC_BASE_URL=http://localhost:${port}`);
  }

  // Parity with `run`: if the proxy may hold the connection on exhaustion, raise
  // the client-side timeout so it doesn't give up mid-hold.
  const holdMs = (holdSeconds || 0) * 1000;
  if (holdMs > 0) lines.push(`export API_TIMEOUT_MS=${holdMs + 60_000}`);

  return lines;
}

// OpenSSH client-config equivalent of MITM mode for SSH launchers that preserve
// forwarded environment values. These lines belong inside the relevant `Host`
// block in ~/.ssh/config. The remote sshd must accept the listed variables (see
// `teamclaude env --ssh` guidance). Claude Desktop should prefer settings mode.
export function buildClaudeSshSetEnvLines({ port, caPath = null, holdSeconds = 0 }) {
  const values = buildClaudeProxyEnvEntries({ port, caPath, holdSeconds });
  // ssh_config uses the first value obtained for a keyword. Put every
  // assignment on one SetEnv directive; repeated SetEnv lines would leave only
  // the first variable in the effective configuration.
  return [`  SetEnv ${values.map(([name, value]) => `${name}=${value}`).join(' ')}`];
}

// Claude Desktop's SSH daemon rebuilds the environment before it spawns
// `ccd-cli`, so arbitrary OpenSSH SetEnv values may not survive even when sshd
// accepts them. Claude Code's supported settings.json `env` block is loaded by
// the CLI itself and therefore works for app-managed SSH sessions.
export function buildClaudeSettingsEnv({ port, caPath = null, holdSeconds = 0 }) {
  return Object.fromEntries(buildClaudeProxyEnvEntries({ port, caPath, holdSeconds }));
}

function buildClaudeProxyEnvEntries({ port, caPath = null, holdSeconds = 0 }) {
  const proxyUrl = `http://127.0.0.1:${port}`;
  const values = [
    ['HTTPS_PROXY', proxyUrl],
    ['HTTP_PROXY', proxyUrl],
    ['https_proxy', proxyUrl],
    ['http_proxy', proxyUrl],
    ['NO_PROXY', 'localhost,127.0.0.1,::1'],
    ['no_proxy', 'localhost,127.0.0.1,::1'],
  ];
  if (caPath) values.push(['NODE_EXTRA_CA_CERTS', caPath]);
  const holdMs = (holdSeconds || 0) * 1000;
  if (holdMs > 0) values.push(['API_TIMEOUT_MS', String(holdMs + 60_000)]);
  return values;
}

export const CLAUDE_SSH_ACCEPT_ENV = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'API_TIMEOUT_MS',
];
