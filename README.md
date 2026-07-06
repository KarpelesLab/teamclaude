# TeamClaude

[![CI](https://github.com/KarpelesLab/teamclaude/actions/workflows/ci.yml/badge.svg)](https://github.com/KarpelesLab/teamclaude/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@karpeleslab/teamclaude.svg)](https://www.npmjs.com/package/@karpeleslab/teamclaude)
[![node](https://img.shields.io/node/v/@karpeleslab/teamclaude.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Multi-account Claude proxy with automatic quota-based rotation for [Claude Code](https://claude.ai/claude-code).

Sits transparently between Claude Code and the Anthropic API, managing multiple Claude Max (or API key) accounts and automatically switching when one approaches its session or weekly quota limit.

![TeamClaude TUI](screenshots/teamclaude.png)

## Features

- **Automatic account rotation** — switches to the next account when session (5h) or weekly (7d) quota reaches the configured threshold (default 98%)
- **Model-aware routing** — the per-model weekly cap (e.g. Fable) is tracked separately, so an account whose Fable quota is spent is skipped **only** for Fable requests and still serves Opus/Sonnet. Requests are routed by their `model` (read exactly from the request body, in both base-URL and MITM modes)
- **Auto-retry on 429** — waits the `retry-after` duration and retries the same account; a quota rejection (a spent weekly bucket) switches accounts immediately instead of waiting, and switches to the next on persistent errors
- **Interactive TUI** — real-time dashboard with color-coded quota bars, reset countdowns, activity log, and keyboard controls; a settings screen (`g`) edits the rotation threshold, quota-probe interval, and sx.org proxy live
- **OAuth token management** — automatically refreshes tokens nearing expiry and persists them to config; client token refreshes pass through untouched
- **Hot-reload accounts** — add or change accounts while the server is running; press **R** in the TUI, or run headless and CLI changes auto-reload via a local control endpoint
- **Headless mode** — run the proxy without the TUI (`--headless`) for backgrounding/services
- **Org-aware accounts** — one email can hold multiple accounts across different organizations (e.g. corp + personal); dedup is keyed on account + org, and names disambiguate as `email (Org)`
- **Third-party backend accounts** — route requests to any Anthropic-compatible API (e.g. DeepSeek, GLM) as a fallback when Claude accounts are exhausted; a per-account `upstream` URL and `modelMap` translate model names transparently. Accounts with a `models` list are reserved for requests that explicitly name those models, enabling per-session backend selection without touching other sessions
- **Rotation priority** — pin a preferred account order with `teamclaude priority`
- **Enable/disable accounts** — temporarily pause an account without removing it (`teamclaude disable`/`enable`, or `d` in the TUI); re-enabling also clears a stuck error state
- **Quota persistence** — observed quota survives restarts (saved to a sibling state file), so rotation state isn't lost on restart; stale windows are discarded automatically
- **Optional quota probe** — off by default; when enabled, periodically refreshes idle accounts' quota from the usage endpoint (no message spend), and surfaces the Sonnet and Fable weekly buckets
- **MITM proxy mode (default)** — `teamclaude run` routes claude via an HTTPS forward proxy with a local CA so even hardcoded `api.anthropic.com` endpoints (e.g. the Claude Design MCP) get the real token injected; pass `--no-mitm` for base-URL routing only
- **Optional sx.org proxy mode** — off by default; set an [sx.org](https://sx.org) API key in the TUI settings screen (`g`) and TeamClaude auto-provisions a residential proxy to change the egress IP and work around IP-based `429`s. Three modes (`m` to cycle): **always** (route all upstream traffic), **on 429 only** (stay direct, fail over to the proxy after a 429), or **off** (keep the key but don't use it). TLS stays end-to-end with Anthropic (the proxy only relays ciphertext)
- **Request logging** — optional full request/response logging for debugging
- **Zero dependencies** — uses only Node.js built-in modules

## Quick Start

Requires Node.js 18+.

```bash
# Install
npm install -g @karpeleslab/teamclaude

# Add your first account (opens browser for OAuth)
teamclaude login

# Add a second account
teamclaude login

# Start the proxy
teamclaude server

# In another terminal, run Claude Code through the proxy
teamclaude run
```

You can also import existing Claude Code credentials instead of logging in:

```bash
claude /login           # Log into an account in Claude Code
teamclaude import       # Import its credentials
```

## Adding Accounts

### OAuth Login (recommended)

The easiest way to add accounts — opens your browser for authentication:

```bash
teamclaude login
```

Uses the same OAuth flow as Claude Code. Auto-detects the account email and subscription tier. Logging in with the same account again updates its credentials.

You can add accounts while the server is running — press **R** in the TUI to reload.

### Import from Claude Code

If you already have Claude Code set up, you can import its credentials directly:

```bash
claude /login           # Log into an account in Claude Code
teamclaude import       # Import its credentials
```

Re-importing the same account updates its credentials. You can also import from a custom path:

```bash
teamclaude import --from /path/to/credentials.json
```

### API Key

For Anthropic API key accounts (billed via Console):

```bash
teamclaude login --api
```

## Usage

### Start the proxy server

```bash
teamclaude server
```

When running from a TTY, shows an interactive TUI with:
- Account table with session/weekly quota progress bars and reset countdowns
- Real-time activity log with request tracking
- Keyboard shortcuts (see below)

Falls back to plain log output when not a TTY (e.g. running as a service). Pass `--headless` (or `--no-tui`) to force the plain-log mode even from a terminal — useful for backgrounding the proxy.

When running headless, you can re-sync accounts from the config without a restart by POSTing to the local control endpoint (the equivalent of pressing **R** in the TUI):

```bash
curl -X POST http://localhost:3456/teamclaude/reload
```

You usually don't need to call it directly: `teamclaude login`, `import`, `enable`, `disable`, and `priority` automatically notify a running server to reload. (New accounts and credential/priority/enable-disable changes are picked up live; account *removals* still require a restart.)

#### TUI Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `s` | Switch active account |
| `a` | Add account (import or API key) |
| `r` | Remove an account |
| `d` | Enable/disable an account |
| `R` | Reload accounts from config |
| `q` | Quit |

In selection mode, use `j`/`k` or arrow keys to navigate, `Enter` to confirm, `Esc` to cancel.

### Run Claude Code through the proxy

```bash
teamclaude run
```

`run` probes the proxy first: if it's up, Claude Code is routed through it; if it's **not** running, `claude` is launched directly so nothing breaks.

Since **1.1.0**, `run` defaults to [MITM forward-proxy mode](#mitm-proxy-mode-default) so even hardcoded `api.anthropic.com` endpoints (e.g. the Claude Design MCP) are intercepted. To keep the previous base-URL-only behavior, pass `--no-mitm`:

```bash
teamclaude run --no-mitm
```

Or manually set the environment:

```bash
eval $(teamclaude env)
claude
```

### Routing plain `claude` automatically (alias)

So you don't have to type `teamclaude run` every time, add a shell alias that makes plain `claude` go through the proxy (and fall back to direct when it's down):

```bash
teamclaude alias              # print the alias for your shell
teamclaude alias --install    # or write it to your shell rc (--uninstall to remove)
```

This is an interactive-shell alias — it affects `claude` typed at a prompt, not `claude` spawned by editors or scripts. It's a thin passthrough to `teamclaude run`, which holds the proxy-up/down logic.

### Other commands

```bash
teamclaude accounts          # List accounts with subscription tier and token status
teamclaude accounts -v       # Also show token expiry times
teamclaude status            # Show live proxy status (requires running server)
teamclaude remove <name>     # Remove an account (by name or email)
teamclaude disable <name>    # Temporarily exclude an account from rotation
teamclaude enable <name>     # Re-enable it (also clears a stuck error state)
teamclaude priority <name> 1 # Set rotation priority (lower = preferred)
teamclaude probe 300         # Enable background quota refresh (off by default)
teamclaude alias             # Print/install a `claude` alias that routes via the proxy
teamclaude api <path>        # Call an API endpoint with account credentials
teamclaude update            # Check npm for a newer teamclaude and install it
teamclaude version           # Print the installed version
teamclaude help              # Show all commands
```

### Auto-update

When teamclaude is installed globally via npm, it self-updates in the
background: it checks the npm registry at most once a day, and when a newer
version is published it runs `npm install -g @karpeleslab/teamclaude@latest` and
applies it on the next launch. The check runs after a `teamclaude run` session
ends and when a headless server starts; a git checkout is never touched (update
it with `git pull`). Run `teamclaude update` to update on demand.

Disable auto-update with `TEAMCLAUDE_DISABLE_AUTOUPDATE=1` or `"autoUpdate": false`
in the config.

When the same email belongs to multiple organizations, accounts are named
`email (Org)` to keep them distinct. Pass `--org <name|uuid>` to disambiguate a
bare email, e.g. `teamclaude remove user@example.com --org Acme`. Use
`teamclaude priority <name> --first` / `--last` to move an account to the front
or back of the rotation order.

### Request logging

Log full request/response details to a directory (one file per request):

```bash
teamclaude server --log-to /tmp/requests
```

## Configuration

Config is stored at `~/.config/teamclaude.json` (or `$XDG_CONFIG_HOME/teamclaude.json`). A random proxy API key is generated on first use.

Volatile runtime state (observed quota) is written separately to `teamclaude.state.json` alongside the config, so the config file stays clean and hand-editable. The state file is safe to delete — quota is simply re-learned from traffic.

Override the config path with `TEAMCLAUDE_CONFIG`:

```bash
TEAMCLAUDE_CONFIG=./my-config.json teamclaude server
```

### Network resilience

After a host network drop and reconnect, Node's shared connection pool can hold dead keep-alive sockets. Because a request has no default time limit, a retry can land on a dead socket and hang forever — every account and every retry keeps hitting the same poison, so the proxy appears wedged until you restart it. teamclaude bounds each stage so a stuck request fails fast instead: the failure lets Node evict the dead socket, the client retries, and the next request connects fresh — no restart needed. Recovery is per-socket, so after a flap it can take a few failed-then-retried requests to fully drain, but it always converges.

| Variable | Default | Description |
|---|---|---|
| `TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS` | `120000` | Max wait for upstream **response headers** (time-to-first-byte). Cleared the instant headers arrive, so a long streaming body is never cut. Streamed completions deliver first byte in seconds; a non-streaming (`stream:false`) request that legitimately generates for longer than this could trip it — raise it for such callers. |
| `TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS` | `120000` | Max **idle** gap between response-body chunks. Resets on every chunk, so a slow-but-healthy stream is fine; it fires only when the socket goes silent mid-stream (a drop after headers), turning a hang into a fast, retryable failure. |
| `TEAMCLAUDE_REFRESH_TIMEOUT_MS` | `30000` | Max wait for an OAuth token refresh. A hung refresh is coalesced across all callers, so it would otherwise wedge every request for that account. |

### Config format

```json
{
  "proxy": {
    "port": 3456,
    "apiKey": "tc-auto-generated-key"
  },
  "upstream": "https://api.anthropic.com",
  "switchThreshold": 0.98,
  "sx": { "apiKey": "your-sx-org-api-key", "mode": "always" },
  "accounts": [
    {
      "name": "user@example.com (Acme)",
      "type": "oauth",
      "accountUuid": "...",
      "orgUuid": "...",
      "orgName": "Acme",
      "priority": 0,
      "accessToken": "sk-ant-oat01-...",
      "refreshToken": "sk-ant-ort01-...",
      "expiresAt": 1774384968427
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `proxy.port` | Local port the proxy listens on |
| `proxy.apiKey` | API key clients use to authenticate with the proxy |
| `upstream` | Upstream API base URL |
| `switchThreshold` | Quota utilization (0–1) at which to switch accounts (TUI: `g` → `t`) |
| `quotaProbeSeconds` | Background quota-probe interval in seconds (`0` = off, the default; CLI `probe` or TUI `g` → `p`) |
| `sx.apiKey` | [sx.org](https://sx.org) API key. When set, TeamClaude auto-provisions a residential proxy (egress-IP 429 workaround). Absent/empty = off |
| `sx.mode` | `always` (route all upstream traffic), `429` (direct, fail over to the proxy after a 429), or `off` (keep the key but don't use it). Defaults to `always` when a key is set |
| `accounts[].accountUuid` | Anthropic account (person) id; set automatically from the OAuth profile |
| `accounts[].orgUuid` / `orgName` | Organization the account is scoped to — lets one email hold multiple org accounts |
| `accounts[].priority` | Rotation preference, lower = preferred (default 0) |
| `accounts[].disabled` | If `true`, the account is excluded from rotation until re-enabled |
| `accounts[].upstream` | Alternative upstream base URL for this account (e.g. `https://api.deepseek.com/anthropic`). Overrides the global `upstream` for this account only |
| `accounts[].modelMap` | Object mapping Anthropic model names to this backend's model names (e.g. `{"claude-sonnet-4-6": "deepseek-v4-pro[1m]"}`). Applied automatically when requests are routed to this account |
| `accounts[].models` | Array of model names this account exclusively handles. When any account declares a `models` list, requests for those models are routed only to accounts that list them — use this to reserve a third-party account for sessions that pass `--model <name>` explicitly |

### Quota probe (optional, off by default)

By default TeamClaude is **passive** — it learns each account's quota only from the responses that flow through it, so an account that hasn't been used yet shows unknown quota until it's first rotated to.

If you'd rather keep idle accounts' quota fresh, enable the background probe:

```bash
teamclaude probe 300    # refresh every 300s
teamclaude probe off    # back to passive (default)
teamclaude probe        # show current setting
```

You can also set the interval live from the TUI settings screen (`g` → `p`), alongside the rotation threshold (`t`).

It reads each OAuth account's utilization from Anthropic's usage endpoint (`/api/oauth/usage`), which reports quota **without consuming any message quota**. Minimum interval is 30s. Changing it takes effect on a running server immediately (no restart). When enabled, it also surfaces the **Sonnet 7-day** and **Fable 7-day** buckets as extra bars in the TUI / `status` (when your plan exposes them).

### Third-party backend accounts

Any Anthropic-compatible API can be added as an account alongside your Claude accounts. Give it a higher `priority` value (lower = preferred, so use e.g. `100`) and it will be used as a fallback when all Claude accounts are exhausted.

```json
{
  "name": "deepseek",
  "type": "oauth",
  "accessToken": "sk-your-deepseek-api-key",
  "upstream": "https://api.deepseek.com/anthropic",
  "priority": 100,
  "modelMap": {
    "claude-haiku-4-5-20251001": "deepseek-v4-flash",
    "claude-sonnet-4-6": "deepseek-v4-pro[1m]"
  },
  "models": ["deepseek-v4-pro[1m]", "deepseek-v4-pro", "deepseek-v4-flash"]
}
```

- **`upstream`** — base URL of the target API. Requests are sent to `upstream + /v1/messages` (etc.) for this account only.
- **`modelMap`** — when a Claude model name arrives in the request body, it is rewritten to the mapped name before forwarding.
- **`models`** — model names this account exclusively handles. Once any account declares a `models` list, requests for those model names are locked to matching accounts. This lets you send a specific session to a third-party backend without touching others — use `--model` on launch or `/model` inside a session:

```bash
# This session routes to DeepSeek; all other sessions still use Claude accounts.
claude --model 'deepseek-v4-pro[1m]'
```

Note: model names with brackets (e.g. `deepseek-v4-pro[1m]`) must be quoted in the shell.

### MITM proxy mode (default)

The plain reverse-proxy only intercepts what `ANTHROPIC_BASE_URL` covers. Some Claude Code features (e.g. the **Claude Design MCP**) use a **hardcoded** `https://api.anthropic.com` URL that ignores that variable, so they bypass the proxy. MITM proxy mode captures those too, which is why it's the default for `teamclaude run` (and the shell alias):

```bash
teamclaude run -- <claude args...>
```

To opt out and route via `ANTHROPIC_BASE_URL` only, pass `--no-mitm`:

```bash
teamclaude run --no-mitm -- <claude args...>
```

That launches claude pointed at teamclaude as an **HTTPS forward proxy** (`HTTPS_PROXY`) and trusts a locally-generated CA (`NODE_EXTRA_CA_CERTS`). For an intercepted host, teamclaude **terminates** the tunnel with a real HTTP/2 server (HTTP/1.1 clients are handled too) presenting its local leaf, then **forwards each request with a buffering, retrying client** — the same path the base URL mode uses. On each request it:

- injects the active account's real token as **`authorization`** (dropping any client `x-api-key`);
- rewrites the **`account_uuid`** inside `metadata.user_id` to the active account's UUID (so the body agrees with the injected token);
- routes by the request's **`model`** (a Fable-exhausted account is skipped for Fable but still serves other models);
- reads `anthropic-ratelimit-*` from responses for quota; and
- **resends the request on a different account** if one returns a quota `429`, so a "you've reached your limit" is never surfaced while another account has headroom.

Because the request is buffered, the retry is transparent to claude. Remote Control (`/v1/code/*`) and client token refreshes (`/v1/oauth/token`) are passed through with the client's own credential. Any host other than the upstream is blind-tunnelled. The server accepts *both* base-URL and proxy clients at once, so instances launched with and without `--no-mitm` can share one server.

Trust model:
- The CA is generated locally, stored in the config dir, and trusted **only** by the claude process you launch via `teamclaude run` (through `NODE_EXTRA_CA_CERTS`) — it is **never** added to your system trust store. The leaf private key is `0600`; the CA private key is never written to disk.
- teamclaude still verifies the **real** Anthropic certificate on the upstream leg.

Verify the proxy + CA without any credentials — the proxy always answers a built-in test host:

```bash
# (with the server running and certs generated, e.g. after one `teamclaude run`)
curl --proxy http://localhost:3456 --cacert ~/.config/teamclaude-ca.pem https://www.example.org/
# → {"teamclaude":"mitm-proxy-ok","host":"www.example.org",...}
```

### sx.org proxy mode (optional, off by default)

Some transient `429`s key on the proxy's **outbound IP**, not the account — so rotating accounts doesn't help. To work around them, TeamClaude can route upstream requests through a residential proxy from [sx.org](https://sx.org), giving a different egress IP.

Open the TUI and press **`g`** for the settings screen, then **`k`** to paste your sx.org API key (stored in `config.sx.apiKey`). TeamClaude reuses an existing active proxy port on your sx.org account, or auto-creates a residential US one, and dials the upstream through it via HTTP `CONNECT` on **both** the reverse-proxy and `--mitm` paths.

Press **`m`** to cycle the **mode**:

| Mode | Behavior |
|------|----------|
| **always** | Tunnel **every** upstream request through sx.org. |
| **on 429 only** | Connect directly; on a `429` (which is IP-based), immediately retry that request through sx.org's fresh egress IP — no wait. On the `--mitm` path, a recent `429` routes new tunnels through sx.org for a short window. |
| **off** | Never use sx.org, but **keep the API key** so you can re-enable it instantly. |

TLS is established **end-to-end with `api.anthropic.com` over the tunnel**, so the sx.org proxy only ever relays ciphertext and the real Anthropic certificate is still verified. Mode and key changes apply live (no restart). Press **`x`** to forget the key entirely.

> **Cost:** in **always** mode *all* Claude traffic flows through the residential proxy, which sx.org meters by bandwidth — expect real per-GB cost. **on 429 only** uses the proxy just when you're actually being throttled, so it's the cheaper way to ride out rate limits.

## How It Works

1. Claude Code connects to the local proxy instead of `api.anthropic.com`
2. The proxy selects the active account and forwards requests with that account's credentials
3. OAuth tokens expiring within 5 minutes are automatically refreshed and persisted to config
4. Rate limit headers from the API (`anthropic-ratelimit-unified-*`) track session (5h) and weekly (7d) quota utilization
5. When usage reaches the threshold, the proxy switches to the next available account via round-robin
6. On 429 responses, the proxy waits the `retry-after` duration and retries; on persistent errors, it switches accounts
7. Transient network errors (connection reset, timeout) drop the connection so the client can retry
8. If all accounts are exhausted, returns 429 with the soonest reset time
9. Client token refresh requests (`/v1/oauth/token`) are relayed to upstream untouched — the proxy and client manage their own token lifecycles independently

## Security

The only canonical sources for TeamClaude are this repository
(https://github.com/KarpelesLab/teamclaude) and the
[`@karpeleslab/teamclaude`](https://www.npmjs.com/package/@karpeleslab/teamclaude)
npm package. TeamClaude is **never** distributed as a downloadable binary
archive — be wary of soft-forks that bundle a `.zip` and tell you to extract and
run it. See [SECURITY.md](SECURITY.md) for details and how to report issues.

## Star History

<a href="https://www.star-history.com/?repos=KarpelesLab%2Fteamclaude&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=KarpelesLab/teamclaude&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=KarpelesLab/teamclaude&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=KarpelesLab/teamclaude&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT — see [LICENSE](LICENSE).
