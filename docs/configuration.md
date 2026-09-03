# Configuration

## Where it lives

Config is stored at `~/.config/teamclaude.json` (or `$XDG_CONFIG_HOME/teamclaude.json`). A random proxy API key is generated on first use.

Volatile runtime state (observed quota) is written separately to `teamclaude.state.json` alongside the config, so the config file stays clean and hand-editable. The state file is safe to delete — quota is simply re-learned from traffic.

## Format

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

## Fields

| Field | Description |
| --- | --- |
| `proxy.port` | Local port the proxy listens on |
| `proxy.host` | Interface to bind. Defaults to `127.0.0.1` (localhost only). Set to `0.0.0.0` (or override with env `TEAMCLAUDE_HOST`) to accept off-box clients — in which case **set `proxy.apiKey`**, since remote clients must present it (via `x-api-key`, or `Proxy-Authorization` for CONNECT/HTTPS-proxy usage); loopback is always exempt |
| `proxy.apiKey` | API key clients use to authenticate with the proxy (required for any non-loopback client; the proxy injects real account tokens, so an unauthenticated open port would leak them) |
| `proxy.clientKeys` | Optional per-client keys: `[{ "name": "alice", "key": "tc-…" }, …]`. Each entry authenticates exactly like `proxy.apiKey`, and the tokens its responses report are booked against `name` — per-client usage shows up under `clients` in `/teamclaude/status`, in `teamclaude status`, and (with `--activity-log`) as a `[name]` prefix on each request line. Counters persist in the state file. Traffic on the shared `proxy.apiKey` or the loopback exemption stays unattributed, so give every consumer their own entry when you want complete stats. Edits apply live via `POST /teamclaude/reload` |
| `proxy.usageDimensions` | Optional request-header usage dimensions: `[{ "name": "project", "header": "x-teamclaude-project" }, …]`. For each request the proxy reads the configured headers and books the response tokens against their sanitized values, shown under `usageDimensions` in `/teamclaude/status`, `teamclaude status`, and the dashboard. A request that omits a header is simply unattributed for that dimension. Counters persist in the state file, and each dimension is capped at 500 distinct values — further values are summed into `(other)` rather than evicting existing rows. Edits apply live via `POST /teamclaude/reload` |
| `proxy.sessionDetail` | Adds a per-session breakdown (`sessions.items`) to `/teamclaude/status` and the dashboard: one row per session with its id, client, dimension values, pinned accounts, and the tokens it spent per weekly bucket. **Off by default** — any holder of any proxy key can read status, so on a shared proxy this shows every consumer what every other consumer is working on. The aggregate `sessions` counts are unaffected and always present |
| `upstream` | Upstream API base URL |
| `switchThreshold` | Quota utilization (0–1) at which to switch accounts (TUI settings screen: **Switch threshold**). The screen accepts tenths of a percent, e.g. `99.5`, which is stored as `0.995`. Reported OAuth utilization arrives on a whole-percent grid, so a fraction only changes the outcome for an API-key account, whose used share is continuous |
| `quotaProbeSeconds` | Background [quota-probe](quota.md#quota-probe) interval in seconds (`0` = off, the default; CLI `probe`, or the **Quota probe** row on the TUI settings screen) |
| `warmupSeconds` | [Keep-warm](quota.md#keep-warm) interval in seconds (`0` = off, the default; CLI `warmup`). Spawns a minimal `claude` per idle account to start its 5h timer — **spends a little quota**, unlike the probe |
| `holdSeconds` | Maximum seconds to [hold the connection](quota.md#hold-on-exhaustion) when all accounts are exhausted, polling silently until one recovers (`0` = return 429 immediately, the default). `teamclaude run` raises `API_TIMEOUT_MS` automatically to match |
| `distributeSessions` | Spread concurrent Claude Code sessions across equal-priority accounts, each session pinned for cache reuse — one pin per weekly quota bucket, so a diversion in one model family leaves the others where they are (`false` = quota-driven rotation only, the default). Applied live on config reload; turning it **off** drains — sessions already running keep their accounts and only new ones stop being distributed, so nobody loses a prompt cache mid-session. Session tracking and readout is always on regardless — see [Session-aware routing](routing.md#session-aware-routing) |
| `eventLogging` | How to handle Claude Code's telemetry (`/api/event_logging/*`), which is high-volume activity-log noise: `hide` (default) forwards it but keeps it out of the activity log; `block` answers `200` locally without forwarding (no upstream round-trip); `show` forwards and displays it |
| `logDir` | Directory for request/response logs, one file per logged request (CLI: `--log-to DIR`). Unset (the default) writes nothing. The directory is created `0700` and each file `0600` (an existing directory or file keeps its mode); a directory that cannot be created is reported once at startup and logging is switched off for that run. The logged request body is the one sent upstream, so a rewrite by the proxy (tool-pair sanitising, `modelMap`) is visible. A 429 leaves no file at all, whether it rotates to another account, waits inline, or is returned to the client; an auth failure leaves none for the attempts it retries. Left unbounded it grows fast — a week of a few concurrent sessions measured 13 GB across 24,516 files, because a logged request records both bodies in full. Of the three keys below, `logMaxBodyBytes` and `logRetentionHours` are the bounds and are on by default; `logLevel` trades detail for size |
| `logLevel` | How much of each request `logDir` records: `body` (default) writes the headers and both bodies; `headers` writes only the request and response heads, roughly a kilobyte per request instead of megabytes; `off` records nothing while leaving `logDir` set |
| `logMaxBodyBytes` | Largest body `logDir` keeps per direction, default `262144`. JSON is pretty-printed on the way out, so what lands on disk is larger than the cap. Anything longer is truncated and marked with the number of bytes dropped: a complete body keeps its head and its tail, a streamed one keeps its head alone. `0` records every body in full. What the client receives is never affected |
| `logRetentionHours` | Age at which `logDir` files are deleted, default `72`. Swept once at startup and every ten minutes after, and only names the logger wrote itself are considered. `0` keeps everything forever |
| `blockedModels` | Array of model glob patterns (e.g. `["*fable*"]`) whose requests are rejected with a fast, non-retryable `400` instead of being forwarded — avoids a model no account can serve getting rate-limited upstream and hanging the pipeline. Empty (the default) blocks nothing |
| `sessionTitles` | [Session titles in the activity log](usage.md#session-titles-in-the-activity-log) (off by default). Object: `{ enabled, width, projectsDir }` — name each activity row after the Claude Code session that sent it, instead of showing six hex characters of its id. `width` is the columns the label gets (default 18; while enabled every row pays it, so the columns after it stay aligned). `projectsDir` overrides `~/.claude/projects`. Display only: no selection code reads it. Toggled from the settings screen (**g** → Session titles); every field is applied live on config reload |
| `stormRamp` | Optional [storm-control](routing.md#storm-control) tuning (on by default). Object: `{ enabled, startConc, stepConc, stepMs, windowMs }` |
| `routes` | Optional list of [routing rules](routing.md#model-routes) that pin model patterns to specific accounts |
| `autoUpdate` | Set to `false` to disable the background [self-update](usage.md#auto-update) check |
| `upstreamProxy` | Outbound HTTP proxy for **everything TeamClaude sends to Anthropic** — request forwarding, OAuth login, token refresh, profile and usage. `"http://user:pass@host:3128"`, or just `"host:3128"`. `false` disables it *and* ignores the environment. Unset = use `HTTPS_PROXY`/`ALL_PROXY` if present. A value addressing TeamClaude's own listener is ignored (it would proxy the server through itself). TUI settings screen: **Upstream proxy**. See [Upstream proxy](proxy-modes.md#upstream-proxy) |
| `noProxy` | Comma-separated hosts that bypass `upstreamProxy` (suffix match, `*` = all). Defaults to `NO_PROXY` from the environment |
| `sx.apiKey` | [sx.org](https://sx.org) API key. When set, TeamClaude auto-provisions a residential proxy (egress-IP 429 workaround). Absent/empty = off — see [sx.org proxy mode](proxy-modes.md#sxorg-proxy-mode) |
| `sx.mode` | `always` (route all upstream traffic), `429` (direct, fail over to the proxy after a 429), or `off` (keep the key but don't use it). Defaults to `always` when a key is set |
| `accounts[].accountUuid` | Anthropic account (person) id; set automatically from the OAuth profile |
| `accounts[].orgUuid` / `orgName` | Organization the account is scoped to — lets one email hold multiple org accounts |
| `accounts[].priority` | Rotation preference, lower = preferred (default 0) |
| `accounts[].disabled` | If `true`, the account is excluded from rotation until re-enabled |
| `accounts[].upstream` | Alternative upstream base URL for this account (e.g. `https://api.deepseek.com/anthropic`). Overrides the global `upstream` for this account only — see [third-party backends](accounts.md#third-party-backend-accounts) |
| `accounts[].modelMap` | Object mapping Anthropic model names to this backend's model names (e.g. `{"claude-sonnet-4-6": "deepseek-v4-pro[1m]"}`). Applied automatically when requests are routed to this account |
| `accounts[].models` | **Deprecated** — use a [`routes`](routing.md#model-routes) entry with `match` and `accounts` instead. Array of model names this account exclusively handles; kept for backward compatibility with pre-routes configs |

## Environment variables

| Variable | Effect |
| --- | --- |
| `TC_ACCT` | [Pin a session](routing.md#pin-a-session-to-one-account) to **one** account, bypassing rotation. Accepts `accountUuid`, `orgUuid`, `accountUuid/orgUuid`, or a display name/email. Read by `teamclaude run` and `teamclaude env`, then removed from the environment so it never reaches claude |
| `TEAMCLAUDE_CONFIG` | Path to the config file (default `~/.config/teamclaude.json`) |
| `TEAMCLAUDE_HOST` | Override `proxy.host` |
| `TEAMCLAUDE_DISABLE_AUTOUPDATE` | Set to `1` to skip the background self-update check |
| `HTTPS_PROXY` / `ALL_PROXY` | Outbound proxy used when the config sets no `upstreamProxy` (lowercase forms honoured too) |
| `NO_PROXY` | Hosts that bypass the outbound proxy, when the config sets no `noProxy` |

```bash
TEAMCLAUDE_CONFIG=./my-config.json teamclaude server
```

## Usage Dimensions

Usage dimensions answer which project, branch, pull request, or CI job spent the tokens, without a TeamClaude change for every new grouping. `proxy.clientKeys` names WHO spent them; a dimension names what they were spent ON, which one shared CI key cannot express on its own.

Configure the dimensions once on the proxy:

```json
{
  "proxy": {
    "usageDimensions": [
      { "name": "project", "header": "x-teamclaude-project" },
      { "name": "ref", "header": "x-teamclaude-ref" }
    ]
  }
}
```

Developers set a project identity per repository in `.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_CUSTOM_HEADERS": "X-Teamclaude-Project: KarpelesLab/teamclaude"
  }
}
```

CI can set several dimensions with newline-separated custom headers:

```bash
export ANTHROPIC_CUSTOM_HEADERS=$'X-Teamclaude-Project: KarpelesLab/teamclaude\nX-Teamclaude-Ref: pull/123'
```

Use stable, low-cardinality values such as `org/repo`, `pull/123`, or a branch name — a dimension is capped at 500 distinct values, and everything past the cap is summed into an `(other)` row. Header values are client-supplied: they are sanitized on ingest and length-capped before they reach any status output.

A configured dimension header is **consumed by the proxy and not forwarded upstream** — it labels traffic for this proxy, so your internal project and branch names stay on your own infrastructure. It is still not a place for secrets: the values are persisted to the state file and readable by any proxy-key holder.

Header names the proxy refuses to use as a dimension, because it or the client already relies on them: `authorization`, `proxy-authorization`, `cookie`, `x-api-key`, `x-app`, `x-claude-code-session-id`, `x-claude-code-agent-id`, `x-claude-code-parent-agent-id`, `x-anthropic-additional-protection`.

### Per-session cost

Per-session token cost is **not** a usage dimension. The session tracker already meters what each session's responses reported — cache reads and cache creation included — per weekly bucket, and that is the number that matters: a sum of `input_tokens` and `output_tokens` understates a cached Claude Code session by orders of magnitude. Set `proxy.sessionDetail` to surface it per session.

## Network resilience

After a host network drop and reconnect, Node's shared connection pool can hold dead keep-alive sockets. Because a request has no default time limit, a retry can land on a dead socket and hang forever — every account and every retry keeps hitting the same poison, so the proxy appears wedged until you restart it. TeamClaude bounds each stage so a stuck request fails fast instead: the failure lets Node evict the dead socket, the client retries, and the next request connects fresh — no restart needed. Recovery is per-socket, so after a flap it can take a few failed-then-retried requests to fully drain, but it always converges.

**Connection pooling under concurrency.** Upstream requests go over a pooled **HTTP/1.1** transport (`node:https`), so each concurrent request gets its own connection. Node's global `fetch` instead multiplexes every request to `api.anthropic.com` over a **single HTTP/2 connection**; under many concurrent large uploads (Claude Code POSTs ~1&nbsp;MB of context per turn) that one connection serializes on HTTP/2's shared flow-control windows, and a trivial request can wait minutes for headers ([#106](https://github.com/KarpelesLab/teamclaude/issues/106)). Independent H1 connections have no such contention — each upload fills its own socket at TCP speed, matching what N direct Claude Code processes do.

The defaults are meant to be left alone; these exist for the rare case where they aren't right for you.

| Variable | Default | Description |
| --- | --- | --- |
| `TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS` | `120000` | Max wait for upstream **response headers** (time-to-first-byte). Cleared the instant headers arrive, so a long streaming body is never cut. Streamed completions deliver first byte in seconds; a non-streaming (`stream:false`) request that legitimately generates for longer than this could trip it — raise it for such callers |
| `TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS` | `120000` | Max **idle** gap between response-body chunks. Resets on every chunk, so a slow-but-healthy stream is fine; it fires only when the socket goes silent mid-stream (a drop after headers), turning a hang into a fast, retryable failure |
| `TEAMCLAUDE_UPSTREAM_MAX_SOCKETS` | `256` | Max concurrent upstream connections **per origin** in the pooled path. Requests beyond this queue (raise it if you run more concurrent sessions than this against one host) |
| `TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH` | _(off)_ | Set to `1` to route upstream requests through Node's global `fetch` (single HTTP/2 connection) instead of the pooled H1 transport — an escape hatch, not recommended under concurrency |
| `TEAMCLAUDE_REFRESH_TIMEOUT_MS` | `30000` | Max wait for an OAuth token refresh. A hung refresh is coalesced across all callers, so it would otherwise wedge every request for that account |
| `TEAMCLAUDE_RATE_LIMIT_ABSORB_MAX_SECONDS` | `60` | Longest `retry-after` absorbed inline on the same account before a rate-limit 429 is surfaced to the client — see [the two kinds of 429](routing.md#the-two-kinds-of-429) |
