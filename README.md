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
- **Model-aware routing** — the per-model weekly cap (e.g. Fable) is tracked separately, so an account whose Fable quota is spent is skipped **only** for Fable requests and still serves Opus/Sonnet. Requests are routed by their `model` (read exactly from the request body, in both base-URL and MITM modes). Optional **[model routes](#model-routes)** pin model patterns to a specific set of accounts (config, `teamclaude route`, or the TUI settings screen → Manage routing). Advisor requests (Claude Code's `/advisor`) carry a **second** model nested in the tools array; routing sees it too, so the request lands on an account eligible for both the main model and the advisor (falling back to main-model-only routing when no account can serve both)
- **Auto-retry on 429** — distinguishes the two kinds of 429: a **quota rejection** (a spent 5h/weekly bucket, `unified-…-status: rejected`) switches accounts immediately; a **rate-limit 429** (the per-minute throttle) does **not** switch — it [pauses the account](#storm-control-switchover-ramp-up) so concurrent requests wait instead of flooding, retries the same account (absorbing short `retry-after`s inline), and only surfaces a 429 to the client for longer waits. Rotating on a rate-limit 429 would just move the burst to the next account and throw away the first account's cache
- **Storm control** — when many agents fail over to a fresh account at once, requests are [paced onto it](#storm-control-switchover-ramp-up) with a short ramp-up so the herd doesn't instantly throttle it and cascade down the fleet
- **Interactive TUI** — real-time dashboard with color-coded quota bars, reset countdowns, activity log, and keyboard controls; a settings screen (`g`) edits the rotation threshold, quota-probe interval, routing, accounts (add/remove), and sx.org proxy live, and `p` refreshes every account's quota on demand
- **OAuth token management** — automatically refreshes tokens nearing expiry and persists them to config; client token refreshes pass through untouched
- **Hot-reload accounts** — add or change accounts while the server is running; press **R** in the TUI, or run headless and CLI changes auto-reload via a local control endpoint
- **Headless mode** — run the proxy without the TUI (`--headless`) for backgrounding/services
- **Org-aware accounts** — one email can hold multiple accounts across different organizations (e.g. corp + personal); dedup is keyed on account + org, and names disambiguate as `email (Org)`
- **Third-party backend accounts** — route requests to any Anthropic-compatible API (e.g. DeepSeek, GLM) as a fallback when Claude accounts are exhausted; a per-account `upstream` URL and `modelMap` translate model names transparently. Accounts with a `models` list are reserved for requests that explicitly name those models, enabling per-session backend selection without touching other sessions
- **Rotation priority** — pin a preferred account order with `teamclaude priority`
- **Enable/disable accounts** — temporarily pause an account without removing it (`teamclaude disable`/`enable`, or `d` in the TUI); re-enabling also clears a stuck error state
- **Quota persistence** — observed quota survives restarts (saved to a sibling state file), so rotation state isn't lost on restart; stale windows are discarded automatically
- **Hold on exhaustion** — when all accounts are spent, `holdSeconds` keeps the HTTP connection open and polls silently until quota resets, so long-running Claude Code tasks continue automatically instead of aborting with a 429
- **Session awareness** — tracks running Claude Code sessions (by their session id) and shows how many are active; opt into `distributeSessions` to spread concurrent sessions across accounts while keeping each one pinned for cache reuse
- **Optional quota probe** — off by default; when enabled, periodically refreshes idle accounts' quota from the usage endpoint (no message spend), and surfaces the Sonnet and Fable weekly buckets
- **Optional keep-warm** — off by default; when enabled, periodically starts idle accounts' 5h session timers with a minimal request (`teamclaude warmup`) so the next account isn't cold when rotation reaches it (spends a little quota, unlike the probe)
- **Account pinning** — force a request onto one account via an `ANTHROPIC_BASE_URL=.../tc-acct/<name>` prefix, bypassing rotation
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
| `d` | Enable/disable an account |
| `p` | Refresh quota on all accounts (one-shot probe of the zero-spend usage endpoint) |
| `R` | Reload accounts from config |
| `g` | Settings (threshold, quota probe, routing, **add/remove accounts**, sx.org) |
| `q` | Quit |

In selection mode, use `j`/`k` or arrow keys to navigate, `Enter` to confirm, `Esc` to cancel. Adding and removing accounts lives on the settings screen: `g` → **Add account** (import from Claude Code or paste an API key) / **Remove account**.

### Run Claude Code through the proxy

```bash
teamclaude run
```

`run` probes the proxy first: if it's up, Claude Code is routed through it; if it's **not** running, `run` errors out rather than silently bypassing the proxy (which would spend your own quota with no rotation). Pass `--auto-fallback` to launch `claude` directly when the proxy is down instead:

```bash
teamclaude run --auto-fallback
```

Since **1.1.0**, `run` defaults to [MITM forward-proxy mode](#mitm-proxy-mode-default) so even hardcoded `api.anthropic.com` endpoints (e.g. the Claude Design MCP) are intercepted. To keep the previous base-URL-only behavior, pass `--no-mitm`:

```bash
teamclaude run --no-mitm
```

Or set the environment yourself with `teamclaude env`, which prints the same
export lines `run` uses — MITM forward-proxy by default (`--no-mitm` for
base-URL only):

```bash
eval "$(teamclaude env)"           # MITM: HTTPS_PROXY + NODE_EXTRA_CA_CERTS
eval "$(teamclaude env --no-mitm)" # base-URL: ANTHROPIC_BASE_URL only
claude
```

Only the export lines go to stdout (so `eval` is safe); a short summary and any
hints go to stderr. No `ANTHROPIC_API_KEY` is emitted — loopback clients are
exempt from the proxy key gate, and setting it would drop Claude Code out of
subscription mode. A remote (non-loopback) client must add the proxy key itself.

**Using an agent multiplexer or a tool that spawns `claude` itself?** Point it at
the proxy by exporting this env in the process that launches those `claude`
instances — e.g. `eval "$(teamclaude env)"` in the shell you start the
multiplexer from. That gives every spawned `claude` the same routing (and MITM
interception of hardcoded endpoints like the Claude Design MCP) without going
through `teamclaude run`. The trade-off: `run`'s proxy-up/down guard only applies
when you launch via `run`, so start the server (`teamclaude server`) before the
multiplexer.

### Routing plain `claude` automatically (alias)

So you don't have to type `teamclaude run` every time, add a shell alias that makes plain `claude` go through the proxy (it errors if the proxy is down rather than silently bypassing it — add `--auto-fallback` to launch claude directly instead):

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
teamclaude route list        # Manage per-model routes (add/rm); see Model routes
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

**Connection pooling under concurrency.** Upstream requests go over a pooled **HTTP/1.1** transport (`node:https`), so each concurrent request gets its own connection. Node's global `fetch` instead multiplexes every request to `api.anthropic.com` over a **single HTTP/2 connection**; under many concurrent large uploads (Claude Code POSTs ~1&nbsp;MB of context per turn) that one connection serializes on HTTP/2's shared flow-control windows, and a trivial request can wait minutes for headers ([#106](https://github.com/KarpelesLab/teamclaude/issues/106)). Independent H1 connections have no such contention — each upload fills its own socket at TCP speed, matching what N direct Claude Code processes do. `TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH=1` reverts to the old single-connection global-fetch path if ever needed.

| Variable | Default | Description |
|---|---|---|
| `TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS` | `120000` | Max wait for upstream **response headers** (time-to-first-byte). Cleared the instant headers arrive, so a long streaming body is never cut. Streamed completions deliver first byte in seconds; a non-streaming (`stream:false`) request that legitimately generates for longer than this could trip it — raise it for such callers. |
| `TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS` | `120000` | Max **idle** gap between response-body chunks. Resets on every chunk, so a slow-but-healthy stream is fine; it fires only when the socket goes silent mid-stream (a drop after headers), turning a hang into a fast, retryable failure. |
| `TEAMCLAUDE_UPSTREAM_MAX_SOCKETS` | `256` | Max concurrent upstream connections **per origin** in the pooled path. Requests beyond this queue (raise it if you run more concurrent sessions than this against one host). |
| `TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH` | _(off)_ | Set to `1` to route upstream requests through Node's global `fetch` (single HTTP/2 connection) instead of the pooled H1 transport — an escape hatch, not recommended under concurrency. |
| `TEAMCLAUDE_REFRESH_TIMEOUT_MS` | `30000` | Max wait for an OAuth token refresh. A hung refresh is coalesced across all callers, so it would otherwise wedge every request for that account. |

### Storm control (switchover ramp-up)

When you run many agents at once and the active account runs out, every in-flight request fails over to the next account **at the same instant** — a thundering herd that can spend a big chunk of the fresh account's quota (large contexts) and instantly throttle it, cascading down the fleet ([#84](https://github.com/KarpelesLab/teamclaude/issues/84)).

To prevent this, requests onto a **just-switched-to account** are paced: concurrency starts at 1 and the cap ramps up over a few seconds, then lifts. The first request or two reveal whether the new account is also near-exhausted **before** the whole herd commits to it, so a cascade is broken up hop by hop. The gate is **fail-open** — a request never blocks longer than the ramp window, and a client that disconnects while waiting just drops out — and the slot is held only until response headers arrive, so streaming replies don't tie up concurrency.

On by default. Tune or disable via `stormRamp` in the config:

```json
"stormRamp": { "enabled": true, "startConc": 1, "stepConc": 1, "stepMs": 250, "windowMs": 30000 }
```

- **`startConc`** — concurrent requests allowed the instant a switch happens (default 1).
- **`stepConc` / `stepMs`** — the cap grows by `stepConc` every `stepMs` (default +1 every 250ms ≈ 4 req/s).
- **`windowMs`** — after this long, pacing stops entirely (default 30s).
- **`enabled: false`** — turn storm control off (send the full burst immediately, pre-#84 behavior).

The same gate handles **rate-limit 429s** (the per-minute throttle, not quota exhaustion): teamclaude pauses the account for the `retry-after` window so new queries wait instead of piling on, then releases the held queries through a fresh ramp (staggered, not all at once). It **never rotates** on a rate-limit 429 — that would just move the burst to the next account and drop the first account's cache. Short waits are absorbed inline on the same account (default ≤ 60s, `TEAMCLAUDE_RATE_LIMIT_ABSORB_MAX_SECONDS`); longer ones return a 429 + `retry-after` so the client backs off. Only a **quota rejection** (`unified-…-status: rejected`) rotates.

### Hold on quota exhaustion (holdSeconds, off by default)

By default, when all accounts are exhausted teamclaude returns a `429` immediately, which causes Claude Code to abort the current task. With `holdSeconds` set, the proxy **holds the HTTP connection open** instead and polls silently every ~60 seconds; the instant any account's quota resets, the request is forwarded and Claude Code resumes — the interruption never happens.

Set it in the config file (`~/.config/teamclaude.json`):

```json
"holdSeconds": 3600
```

`teamclaude run` automatically raises `API_TIMEOUT_MS` on the spawned Claude Code process to `holdSeconds + 60` seconds so the client-side timeout covers the full hold window — no manual configuration of Claude Code is needed.

Useful for overnight or unattended runs: rather than waking up to a stopped task, the session resumes silently once a quota window opens.

### Session-aware routing (distributeSessions, off by default)

teamclaude always tracks running Claude Code sessions by their `x-claude-code-session-id` header — the TUI header and `teamclaude status` show how many are **active** (a request in flight right now, or seen in the last ~2 min) and **known** (seen in the last hour; sessions are forgotten after an hour idle, the maximum prompt-cache extension window). A long streaming request keeps its session active and non-expirable for its whole duration, so a multi-minute completion still counts as load. This is passive: it observes, it doesn't change routing.

Default rotation is purely quota-driven, so many parallel sessions all pile onto the *current* account while equal-priority siblings sit idle — one account queues behind its upstream concurrency ceiling while others do nothing ([#109](https://github.com/KarpelesLab/teamclaude/issues/109)). Enable `distributeSessions` to fix that:

```json
"distributeSessions": true
```

When on, teamclaude routes each **new** session to the least-loaded eligible account (fewest active sessions, then fewest in-flight) and **pins** it there, so a session keeps hitting the same account and preserves its prompt cache — while different sessions spread across accounts instead of funnelling onto one. Account **priority still wins** (a higher-priority account is never skipped to balance load), and a session whose account becomes exhausted re-routes automatically. Off by default; single-session use is unaffected either way.

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
| `proxy.host` | Interface to bind. Defaults to `127.0.0.1` (localhost only). Set to `0.0.0.0` (or override with env `TEAMCLAUDE_HOST`) to accept off-box clients — in which case **set `proxy.apiKey`**, since remote clients must present it (via `x-api-key`, or `Proxy-Authorization` for CONNECT/HTTPS-proxy usage); loopback is always exempt |
| `proxy.apiKey` | API key clients use to authenticate with the proxy (required for any non-loopback client; the proxy injects real account tokens, so an unauthenticated open port would leak them) |
| `upstream` | Upstream API base URL |
| `switchThreshold` | Quota utilization (0–1) at which to switch accounts (TUI: `g` → `t`) |
| `quotaProbeSeconds` | Background quota-probe interval in seconds (`0` = off, the default; CLI `probe` or TUI `g` → `p`) |
| `warmupSeconds` | Keep-warm interval in seconds (`0` = off, the default; CLI `warmup`). Spawns a minimal `claude` per idle account to start its 5h timer — **spends a little quota**, unlike the probe |
| `holdSeconds` | Maximum seconds to hold the connection when all accounts are exhausted, polling silently until one recovers (`0` = return 429 immediately, the default). `teamclaude run` raises `API_TIMEOUT_MS` automatically to match |
| `distributeSessions` | Spread concurrent Claude Code sessions across equal-priority accounts, each session pinned to one account for cache reuse (`false` = quota-driven rotation only, the default). Session tracking/readout is always on regardless — see [Session-aware routing](#session-aware-routing-distributesessions-off-by-default) |
| `stormRamp` | Optional storm-control tuning (on by default) — see [Storm control](#storm-control-switchover-ramp-up). Object: `{ enabled, startConc, stepConc, stepMs, windowMs }` |
| `sx.apiKey` | [sx.org](https://sx.org) API key. When set, TeamClaude auto-provisions a residential proxy (egress-IP 429 workaround). Absent/empty = off |
| `sx.mode` | `always` (route all upstream traffic), `429` (direct, fail over to the proxy after a 429), or `off` (keep the key but don't use it). Defaults to `always` when a key is set |
| `accounts[].accountUuid` | Anthropic account (person) id; set automatically from the OAuth profile |
| `accounts[].orgUuid` / `orgName` | Organization the account is scoped to — lets one email hold multiple org accounts |
| `accounts[].priority` | Rotation preference, lower = preferred (default 0) |
| `accounts[].disabled` | If `true`, the account is excluded from rotation until re-enabled |
| `accounts[].upstream` | Alternative upstream base URL for this account (e.g. `https://api.deepseek.com/anthropic`). Overrides the global `upstream` for this account only |
| `accounts[].modelMap` | Object mapping Anthropic model names to this backend's model names (e.g. `{"claude-sonnet-4-6": "deepseek-v4-pro[1m]"}`). Applied automatically when requests are routed to this account |
| `accounts[].models` | Array of model names this account exclusively handles. When any account declares a `models` list, requests for those models are routed only to accounts that list them — use this to reserve a third-party account for sessions that pass `--model <name>` explicitly |
| `routes` | Optional list of routing rules that pin model patterns to specific accounts — see [Model routes](#model-routes) |

### Model routes

By default every request routes through the same pool, and per-model quota is respected automatically: a family with its own weekly bucket (Fable, Sonnet) only blocks that family, so an account whose Fable quota is spent still serves Opus/Sonnet. `teamclaude status` shows this per account (a `Models` line) and any families it detects appear as **auto** routes.

To go further you can pin model patterns to an **exclusive** set of accounts with a `routes` table. Each route matches the request's `model` id against shell-style globs (`*` is the only wildcard) and, on the **first matching** route, restricts the request to the listed accounts:

```json
"routes": [
  { "name": "fable", "match": ["*fable*"], "accounts": ["personal-max"], "color": "magenta" },
  { "name": "bulk",  "match": ["*opus*", "*sonnet*"], "accounts": ["corp-1", "corp-2"], "color": "blue" }
]
```

- **`match`** — one or more model globs; the first route whose globs match wins.
- **`accounts`** — account names (or indices) that may serve matching models. **Exclusive**: only these are used (and they 429/rotate among themselves when spent). Omit to route to all accounts — e.g. to only set a `bucket` override.
- **`bucket`** — optional: force which quota bucket governs eligibility (`unified7dFable`, `unified7dSonnet`, `unified7d`), for the rare case the family can't be inferred from the model id.
- **`color`** — optional: `red`/`green`/`yellow`/`blue`/`magenta`/`cyan`, tinting this route's inline marker in the TUI (see below). Display only.

Manage routes from the shell (changes apply to a running server immediately):

```bash
teamclaude route list
teamclaude route add fable --match '*fable*' --accounts personal-max --color magenta
teamclaude route add bulk  --match '*opus*,*sonnet*' --accounts corp-1,corp-2
teamclaude route rm fable
```

…or interactively in the TUI: open settings (**`g`**) → **Manage routing**, then `a` add / `e` edit / `d` delete (the editor prompts for a marker color too).

**Inline markers (TUI).** Instead of a separate list, each route surfaces on the account rows as a colored `►`: next to the **`F7`/`S7`** bar for a Fable/Sonnet route, or at the **start of the row** for a general route (one fixed column per route so its position is stable). The marker is bold on the account a route is pinned to, dim when that account is currently ineligible. `teamclaude status` (the CLI text dump) still prints the routes as a list, now colored and annotated with any pin.

**Manual per-route switching (TUI).** Press **`s`** to switch accounts, then **`Tab`** to choose *what* you're switching: the global **default** account, or a specific **route**. Pick an account with `↑/↓` and **`Enter`** to pin that route to it; `Enter` again on the current pin clears it. Pins are a **runtime preference** — not saved to config — and routing **falls back** to normal best-available selection whenever the pinned account is throttled or over quota, so a pin never stalls requests.

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

### Keep-warm: start idle accounts' 5h timers (optional, off by default)

The rolling **5-hour session window** only starts once an account sends a real message. So when your active account runs out and rotation moves to a cold account, that account's 5h window starts *then* — right when you need its full headroom. Keep-warm ([#76](https://github.com/KarpelesLab/teamclaude/issues/76)) starts the timer on idle accounts ahead of time, so the next account is already partway (or fully) through a fresh window when it's needed.

```bash
teamclaude warmup 600    # warm idle accounts every 600s
teamclaude warmup off    # disabled (default)
teamclaude warmup        # show current setting
```

> ⚠️ **This spends a little quota — unlike the passive quota probe.** The 5h timer can't be started by a read-only call, so keep-warm sends a real (minimal) message: for each eligible idle account it spawns a one-shot `claude -p --bare --model haiku "hi"` pointed at this proxy, pinned to that account (see below). It only warms accounts whose 5h window is **not already running**, skips disabled/throttled/errored and third-party-backend accounts, and uses the cheapest model — but it does consume a few tokens and a slice of the 5h/weekly buckets per account per window. Requires the `claude` CLI on `PATH`. Minimum interval 60s; changes apply live (no restart). Status shows under `warm` in `teamclaude status --json`.

### Prompt caching across rotation

Rotation is transparent to your Claude Code session, but it's worth knowing how it interacts with Anthropic's [prompt cache](https://docs.claude.com/en/docs/build-with-claude/prompt-caching).

- **Your context is never lost.** Claude Code resends the full transcript every turn, and TeamClaude rewrites the request's `account_uuid` to match the injected token, so whichever account serves a turn sees the complete history — a mid-session switch is invisible to the client.
- **The cache doesn't carry across accounts.** The prompt cache is scoped to the account/organization that created it and expires after a few minutes, so the first turn after a switch is a cache **miss** — that turn is processed without the cache discount, after which the new account warms its own cache. No proxy can share a cache across organizations.

In practice this rarely bites, because **TeamClaude prefers to keep you on one account**: it stays on the current account and only rotates when that account nears the switch threshold (default `98%`); when it does pick, it prefers the account whose weekly quota resets soonest — so a single account tends to serve a whole session and switches are infrequent. Pin an explicit order with `teamclaude priority` to lean on one account even harder.

> Keep-warm (above) is unrelated to this — it starts an idle account's **5h session timer**, not its prompt cache. A freshly-rotated account still takes a one-turn cache miss regardless.

### Pin a request to a specific account

`ANTHROPIC_BASE_URL` with a `/tc-acct/<name-or-index>` prefix forces every request onto **one** account, bypassing rotation (and never failing over to another). This is what keep-warm uses internally, and it doubles as a manual way to exercise a specific account:

```bash
# Route this whole claude session to the account named "work (Acme)" (index also works)
ANTHROPIC_BASE_URL='http://127.0.0.1:3456/tc-acct/1' \
ANTHROPIC_API_KEY='<your teamclaude proxy key>' \
  claude -p --bare 'say hi'
```

The `<name>` matches an account's display name exactly (URL-encode spaces/parens), or a numeric rotation index. An unknown pin returns `404`. The prefix is stripped before the request is forwarded upstream.

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
8. If all accounts are exhausted, returns 429 with the soonest reset time — or, with `holdSeconds` set, holds the connection open and retries silently until an account recovers
9. Client token refresh requests (`/v1/oauth/token`) are relayed to upstream untouched — the proxy and client manage their own token lifecycles independently

## Security

The only canonical sources for TeamClaude are this repository
(https://github.com/KarpelesLab/teamclaude) and the
[`@karpeleslab/teamclaude`](https://www.npmjs.com/package/@karpeleslab/teamclaude)
npm package. TeamClaude is **never** distributed as a downloadable binary
archive — be wary of soft-forks that bundle a `.zip` and tell you to extract and
run it. See [SECURITY.md](SECURITY.md) for details and how to report issues.

## Compliance & Terms of Service

> This is the maintainer's good-faith understanding, **not legal advice.** Anthropic's Terms are theirs to interpret and to change; read the current [Claude Code legal terms](https://code.claude.com/docs/en/legal-and-compliance) and decide for yourself.

TeamClaude is a **self-hosted local proxy**. You run it on your own machine, it holds *your own* credentials, and it forwards the requests that *your own* Claude Code CLI makes to Anthropic. It is **not** a hosted service, it does not offer "Claude.ai login" to anyone, and it never routes requests on behalf of third parties — it only moves your own traffic through accounts you control.

How you use it is your responsibility. In particular:

- **Use the genuine Claude Code CLI.** Pointing a third-party frontend (opencode and similar) at Pro/Max OAuth credentials is the pattern Anthropic explicitly restricts.
- **Keep a human in the loop.** The terms expect interactive, human-present use rather than fully unattended automation. The two features that make background calls on their own — [keep-warm](#keep-warm-start-idle-accounts-5h-timers-optional-off-by-default) and the [quota probe](#quota-probe-optional-off-by-default) — are **off by default**.
- **Only use subscriptions you legitimately purchased.**

On **rotating across multiple subscriptions** — the question people ask most — note that Claude Code's own `/extra-usage` flow already offers signing into a *different* account when you hit a limit. "Switch to another account you own to get more usage" is a move the native client itself surfaces; TeamClaude automates that same switch. Anthropic hasn't explicitly blessed *automated* pooling, so weigh it against the current terms — but the idea that using more than one of your own subscriptions is inherently off-limits is hard to square with the first-party client offering to do the same thing by hand.

To the best of the maintainer's knowledge, using TeamClaude as intended — the real Claude Code CLI, your own subscriptions, a human present — is consistent with Claude Code's Terms. See [#107](https://github.com/KarpelesLab/teamclaude/issues/107) for the full write-up.

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
