# Configuration

## Where it lives

Config is stored at `~/.config/teamclaude.json` (or `$XDG_CONFIG_HOME/teamclaude.json`). A random proxy API key is generated on first use.

Volatile runtime state (observed quota) is written separately to `teamclaude.state.json` alongside the config, so the config file stays clean and hand-editable. The state file is safe to delete — quota is simply re-learned from traffic.

While the config is being rewritten — by the server rotating a refresh token, by a CLI command that saves, or by any other client — the writer holds `teamclaude.json.lock` next to it: a file containing `{"pid":<pid>,"at":<ms epoch>}`. It is an advisory lock so that separate writers wait for one another instead of overwriting each other's edit (a lost write here was typically a freshly rotated refresh token, which cost a re-login). It exists for milliseconds; a lock older than 10 s or whose pid is gone is treated as stale and removed by the next writer, and a writer that cannot get it within 2 s proceeds anyway, with one warning in the log, rather than hang. It is safe to delete by hand if one is left behind.

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
| `proxy.host` | Interface to bind. Defaults to `127.0.0.1` (localhost only). Set to `0.0.0.0` (or override with env `TEAMCLAUDE_HOST`) to accept off-box clients — in which case **set `proxy.apiKey`**, since remote clients must present it (via `x-api-key`, or `Proxy-Authorization` for CONNECT/HTTPS-proxy usage); loopback is exempt unless `proxy.trustLoopback` is `false` |
| `proxy.apiKey` | API key clients use to authenticate with the proxy (required for any non-loopback client; the proxy injects real account tokens, so an unauthenticated open port would leak them) |
| `proxy.trustLoopback` | Whether a connection from `127.0.0.1` / `::1` may skip the proxy key (default `true`). **Set it to `false` behind a reverse proxy on the same host** — nginx or Caddy terminating TLS in front of a listener bound to `127.0.0.1` makes every caller on the internet loopback-sourced, so without this the key gate never runs and an anonymous request spends the fleet's quota. Independently of the setting, a loopback request carrying `X-Forwarded-For`, `X-Real-IP` or `Forwarded` is never exempt, which closes the common deployments by default; the setting covers a reverse proxy configured to send none of them. TeamClaude's own commands present `proxy.apiKey` on every call, so a local install keeps working either way |
| `proxy.clientKeys` | Optional per-client keys: `[{ "name": "alice", "key": "tc-…" }, …]`. Each entry authenticates exactly like `proxy.apiKey`, and the tokens its responses report are booked against `name` — per-client usage shows up under `clients` in `/teamclaude/status`, in `teamclaude status`, and (with `--activity-log`) as a `[name]` prefix on each request line. A WebSocket channel (Remote Control) opened with the key is counted under `connections` for that client, apart from its requests, and its open/close lines carry the same prefix. Counters persist in the state file. Traffic on the shared `proxy.apiKey` or the loopback exemption stays unattributed, so give every consumer their own entry when you want complete stats. Edits apply live via `POST /teamclaude/reload` |
| `proxy.usageDimensions` | Optional request-header usage dimensions: `[{ "name": "project", "header": "x-teamclaude-project" }, …]`. For each request the proxy reads the configured headers and books the response tokens against their sanitized values, shown under `usageDimensions` in `/teamclaude/status`, `teamclaude status`, and the dashboard. A request that omits a header is simply unattributed for that dimension. Counters persist in the state file, and each dimension is capped at 500 distinct values — further values are summed into `(other)` rather than evicting existing rows. Edits apply live via `POST /teamclaude/reload` |
| `proxy.sessionDetail` | Adds a per-session breakdown (`sessions.items`) to `/teamclaude/status` and the dashboard: one row per session with its id, client, dimension values, pinned accounts, and the tokens it spent per weekly bucket. **Off by default** — any holder of any proxy key can read status, so on a shared proxy this shows every consumer what every other consumer is working on. The aggregate `sessions` counts are unaffected and always present |
| `upstream` | Upstream API base URL |
| `switchThreshold` | Quota utilization (0–1) at which to switch accounts (`teamclaude threshold <1-100>`, or the TUI settings screen: **Switch threshold**). The screen accepts tenths of a percent, e.g. `99.5`, which is stored as `0.995`. Reported OAuth utilization arrives on a whole-percent grid, so a fraction only changes the outcome for an API-key account, whose used share is continuous |
| `quotaProbeSeconds` | Background [quota-probe](quota.md#quota-probe) interval in seconds (`0` = off, the default; CLI `probe`, or the **Quota probe** row on the TUI settings screen) |
| `warmupSeconds` | [Keep-warm](quota.md#keep-warm) interval in seconds (`0` = off, the default; CLI `warmup`). Spawns a minimal `claude` per idle account to start its 5h timer — **spends a little quota**, unlike the probe |
| `warmupSchedule` | Optional reset-target keep-warm schedule. Daily mode stores `{ "resetTime": "15:30", "timezone": "Europe/Moscow" }`; rolling mode also stores `"mode": "rolling"` and an absolute `"anchorResetAt"`. The timezone must be an IANA name. Mutually exclusive with `warmupSeconds`; set with `teamclaude warmup reset HH:MM --timezone Area/City` or `teamclaude warmup rolling HH:MM --timezone Area/City` |
| `holdSeconds` | Maximum seconds to [hold the connection](quota.md#hold-on-exhaustion) when all accounts are exhausted, polling silently until one recovers (`0` = return 429 immediately, the default). `teamclaude run` raises `API_TIMEOUT_MS` automatically to match. Read at startup — a change needs a restart |
| `distributeSessions` | Spread concurrent Claude Code sessions across equal-priority accounts, each session pinned for cache reuse (`teamclaude distribute <on\|off\|adaptive>`) — one pin per weekly quota bucket, so a diversion in one model family leaves the others where they are (`false` = quota-driven rotation only, the default). Set to `"adaptive"` for a third mode that concentrates new sessions on the account with the least remaining weekly credit — tapering off as it nears its `switchThreshold` and backing off when it is congested. Subscription capacity comes from the OAuth profile tier; current utilization/reset comes from quota headers; burn rate and tolerated concurrency adapt to live traffic. See [Adaptive distribution](routing.md#adaptive-distribution). Applied live on config reload; turning it **off** drains — sessions already running keep their accounts and only new ones stop being distributed, so nobody loses a prompt cache mid-session. Session tracking and readout is always on regardless — see [Session-aware routing](routing.md#session-aware-routing) |
| `adaptiveDistribution` | Optional tuning for [adaptive distribution](routing.md#adaptive-distribution). Object of numbers, every field optional; an unknown field, a non-numeric or non-finite value, or a value out of range is a **startup error** naming the field (a bad number would otherwise turn every adaptive score into `NaN` and silently route as even mode). The learners run and persist in every mode, so the block is checked whether or not the mode is on. Fields, with defaults: `maxSampleAgeMs` (`900000`, > 0) — a burn sample older than this spans an idle gap and is discarded; `lookaheadMs` (`1800000`, > 0) — how far ahead the reserve projects the account's burn rate; `burnWindowMs` (`300000`, > 0) — the wall-clock interval one burn-rate sample is measured over; `burnAlpha` (`0.3`, in (0, 1]) — EWMA weight of a new burn sample; `minReserve` / `maxReserve` (`0.01` / `0.2`, fractions in [0, 1], min ≤ max) — bounds on the reserve the taper works across; `initialBurnRate` (`0.05/3600000` utilization per ms ≈ 5% of a window per hour, ≥ 0) — assumed until something is observed; `initialConcCap` / `minConcCap` / `maxConcCap` (`6` / `1` / `64`, > 0, min ≤ initial ≤ max) — where the tolerated-concurrency estimate starts and the range it may learn within; `concBackoff` (`0.5`, in (0, 1]) — EWMA weight applied on a throttle; `concBackoffTo` (`0.75`, in (0, 1]) — the fraction of the throttling load retreated to; `concGrowth` (`0.05`, in (0, 1]) — EWMA weight of the +1 probe while running at the cap; `maxBurnBoost` (`4`, ≥ 1) — ceiling on the burn-down preference, which is what lets the taper win at the threshold. Read at startup only |
| `eventLogging` | How to handle Claude Code's telemetry (`/api/event_logging/*`), which is high-volume activity-log noise: `hide` (default) forwards it but keeps it out of the activity log; `block` answers `200` locally without forwarding (no upstream round-trip); `show` forwards and displays it. Edits apply live via `POST /teamclaude/reload` |
| `logDir` | Directory for request/response logs, one file per logged request (CLI: `--log-to DIR`). Unset (the default) writes nothing. The directory is created `0700` and each file `0600` (an existing directory or file keeps its mode); a directory that cannot be created is reported once at startup and logging is switched off for that run. The logged request body is the one sent upstream, so a rewrite by the proxy (tool-pair sanitising, `modelMap`) is visible. A 429 leaves no file at all, whether it rotates to another account, waits inline, or is returned to the client; an auth failure leaves none for the attempts it retries. Left unbounded it grows fast — a week of a few concurrent sessions measured 13 GB across 24,516 files, because a logged request records both bodies in full. Of the three keys below, `logMaxBodyBytes` and `logRetentionHours` are the bounds and are on by default; `logLevel` trades detail for size |
| `logLevel` | How much of each request `logDir` records: `body` (default) writes the headers and both bodies; `headers` writes only the request and response heads, roughly a kilobyte per request instead of megabytes; `off` records nothing while leaving `logDir` set |
| `logMaxBodyBytes` | Largest body `logDir` keeps per direction, default `262144`. JSON is pretty-printed on the way out, so what lands on disk is larger than the cap. Anything longer is truncated and marked with the number of bytes dropped: a complete body keeps its head and its tail, a streamed one keeps its head alone. `0` records every body in full. What the client receives is never affected |
| `logRetentionHours` | Age at which `logDir` files are deleted, default `72`. Swept once at startup and every ten minutes after, and only names the logger wrote itself are considered. `0` keeps everything forever |
| `blockedModels` | Array of model glob patterns (e.g. `["*fable*"]`) whose requests are rejected with a fast, non-retryable `400` instead of being forwarded — avoids a model no account can serve getting rate-limited upstream and hanging the pipeline. Empty (the default) blocks nothing. Edits apply live via `POST /teamclaude/reload` |
| `sessionTitles` | [Session titles in the activity log](usage.md#session-titles-in-the-activity-log) (off by default). Object: `{ enabled, width, projectsDir }` — name each activity row after the Claude Code session that sent it, instead of showing six hex characters of its id. `width` is the columns the label gets (default 18; while enabled every row pays it, so the columns after it stay aligned). `projectsDir` overrides `~/.claude/projects`. Display only: no selection code reads it. Toggled from the settings screen (**g** → Session titles); every field is applied live on config reload |
| `stormRamp` | Optional [storm-control](routing.md#storm-control) tuning (on by default). Object: `{ enabled, startConc, stepConc, stepMs, windowMs }` |
| `expiryRouting` | Optional [expiry-pressure routing](routing.md#expiry-pressure-routing) (off by default). Object: `{ enabled, tolerance, preempt }` — prefer accounts whose governing weekly quota is ample and resets soonest. **The key name is provisional** — see [#176](https://github.com/KarpelesLab/teamclaude/issues/176) |
| `routes` | Optional list of [routing rules](routing.md#model-routes) that pin model patterns to specific accounts |
| `autoUpdate` | Set to `false` to disable the background [self-update](usage.md#auto-update) check |
| `upstreamProxy` | Outbound HTTP proxy for **everything TeamClaude sends to Anthropic** — request forwarding, OAuth login, token refresh, profile and usage. `"http://user:pass@host:3128"`, or just `"host:3128"`. `false` disables it *and* ignores the environment. Unset = use `HTTPS_PROXY`/`ALL_PROXY` if present. A value addressing TeamClaude's own listener is ignored (it would proxy the server through itself). TUI settings screen: **Upstream proxy**. See [Upstream proxy](proxy-modes.md#upstream-proxy) |
| `noProxy` | Comma-separated hosts that bypass `upstreamProxy` (suffix match, `*` = all). Defaults to `NO_PROXY` from the environment |
| `mitm.http1Only` | Offer only HTTP/1.1 on the intercepted MITM connection (default `false`). Needed for **Remote Control from the Claude Code Desktop app**: a WebSocket over HTTP/2 requires RFC 8441 extended CONNECT, which is not relayed, so a client negotiating h2 has its handshake dropped with no error — the session syncs one way and messages from the phone are never delivered ([#164](https://github.com/KarpelesLab/teamclaude/issues/164)). Costs client→proxy multiplexing on a loopback hop; upstream is already pooled HTTP/1.1 |
| `sx.apiKey` | [sx.org](https://sx.org) API key. When set, TeamClaude auto-provisions a residential proxy (egress-IP 429 workaround). Absent/empty = off — see [sx.org proxy mode](proxy-modes.md#sxorg-proxy-mode). New to sx.org? Signing up via <https://sx.org/c/ufVrLW> supports TeamClaude development |
| `sx.mode` | `always` (route all upstream traffic), `429` (direct, fail over to the proxy after a 429), or `off` (keep the key but don't use it). Defaults to `always` when a key is set |
| `accounts[].accountUuid` | Anthropic account (person) id; set automatically from the OAuth profile |
| `accounts[].orgUuid` / `orgName` | Organization the account is scoped to — lets one email hold multiple org accounts |
| `accounts[].priority` | Rotation preference, lower = preferred (default 0) |
| `accounts[].maxUsage` | Hard per-account usage cap: a number, or a per-bucket table like `{ "unified7d": 0.6, "unified7dFable": 0.8 }` (same keys as `switchThreshold`; `default` covers unlisted buckets, anything else is uncapped). At the cap the account receives **no** requests — rotation skips it, the all-exhausted revalidation probe skips it, and a pin gets the exhausted answer. Model-scoped like the thresholds, applied live on reload. See [Per-account usage caps](quota.md#per-account-usage-caps) |
| `accounts[].disabled` | If `true`, the account is excluded from rotation until re-enabled |
| `accounts[].upstream` | Alternative upstream base URL for this account (e.g. `https://api.deepseek.com/anthropic`). Overrides the global `upstream` for this account only — see [third-party backends](accounts.md#third-party-backend-accounts) |
| `accounts[].modelMap` | Object mapping Anthropic model names to this backend's model names (e.g. `{"claude-sonnet-4-6": "deepseek-v4-pro[1m]"}`). Applied automatically when requests are routed to this account |
| `accounts[].stripRequestFields` | Array of **top-level** request-body fields to drop before forwarding to this account. For third-party upstreams that implement the Anthropic message API but reject fields Claude Code sends (e.g. `["context_management"]`, which some return a `400 Extra inputs are not permitted` for — breaking every request once that account is selected). Applies to this account only; Anthropic accounts are untouched. One nested form is accepted: `"cache_control.<subfield>"` (e.g. `["cache_control.scope"]`) drops that subfield from every documented prompt-cache breakpoint (root, `system[]`, `messages[].content[]`, `tools[]`) for backends that reject it with `400 unknown parameter`; `type` and `ttl` are forwarded unless listed. Nothing is dropped without an entry |
| `accounts[].models` | **Deprecated** — use a [`routes`](routing.md#model-routes) entry with `match` and `accounts` instead. Array of model names this account exclusively handles; kept for backward compatibility with pre-routes configs |

## Environment variables

| Variable | Effect |
| --- | --- |
| `TC_ACCT` | [Pin a session](routing.md#pin-a-session-to-one-account) to **one** account, bypassing rotation. Accepts `accountUuid`, `orgUuid`, `accountUuid/orgUuid`, or a display name/email. Read by `teamclaude run` and `teamclaude env`, then removed from the environment so it never reaches claude |
| `TEAMCLAUDE_CONFIG` | Path to the config file (default `~/.config/teamclaude.json`) |
| `TEAMCLAUDE_HOST` | Override `proxy.host` |
| `TEAMCLAUDE_DISABLE_AUTOUPDATE` | Set to `1` to skip the background self-update check |
| `TEAMCLAUDE_STATUS_TIMEOUT_MS` | How long `teamclaude status` waits for the server's answer before giving up (default `5000`). A connection that is accepted but never answered is reported as a stalled or overloaded server, distinct from a refused one ("Is the server running?") |
| `HTTPS_PROXY` / `ALL_PROXY` | Outbound proxy used when the config sets no `upstreamProxy` (lowercase forms honoured too) |
| `NO_PROXY` | Hosts that bypass the outbound proxy, when the config sets no `noProxy`. Also inherited by clients that `teamclaude run`/`env` launch — their loopback entries are added to yours, and `*` is ignored |

```bash
TEAMCLAUDE_CONFIG=./my-config.json teamclaude server
```

### Event-loop diagnostics

A wedged event loop is the one failure the status endpoint cannot report, because the endpoint itself cannot run. The server therefore keeps a small watchdog: a 1 s timer measures how late each tick fires, and a tick more than 500 ms late counts as a stall and writes one line to the service log (at most one every 30 s):

```
[TeamClaude] Event loop stalled: lag=1840ms (threshold=500ms, stalls=3)
```

The figures are reported under `server.eventLoop` in `GET /teamclaude/status` and `teamclaude status --json` — numbers only, never request content:

| Field | Meaning |
| --- | --- |
| `lastLagMs` | How late the most recent tick fired |
| `maxLagMs` | The worst lag seen since the server started |
| `stallCount` | Ticks that exceeded the threshold since start |
| `lastStallAt` | ISO timestamp of the most recent stall, or `null` |
| `warnLagMs` | The threshold in effect (`500`) |

A `teamclaude status` that times out (see `TEAMCLAUDE_STATUS_TIMEOUT_MS`) while the log shows stalls is the signature of a starved or blocked process — on macOS, check that the LaunchAgent is not running under a `Background` QoS clamp — rather than of an upstream problem.

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
| `TEAMCLAUDE_UPSTREAM_MAX_SOCKETS` | `256` | Max concurrent upstream connections **per origin** in the pooled path, and the width of the admission gate in front of it. A long stream holds its slot until its body ends; requests beyond this wait in the bounded queue below (raise it if you run more concurrent sessions than this against one host) |
| `TEAMCLAUDE_UPSTREAM_MAX_QUEUE` | `64` | How many requests may wait **per origin** for a free slot once all `MAX_SOCKETS` are busy. A request arriving at a full queue is refused immediately (`0` disables queueing) |
| `TEAMCLAUDE_UPSTREAM_QUEUE_TIMEOUT_MS` | `5000` | Longest a queued request waits for a slot before it is refused. Separate from the headers timeout, which is armed only once the request is admitted |
| `TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH` | _(off)_ | Set to `1` to route upstream requests through Node's global `fetch` (single HTTP/2 connection) instead of the pooled H1 transport — an escape hatch, not recommended under concurrency |
| `TEAMCLAUDE_REFRESH_TIMEOUT_MS` | `30000` | Max wait for an OAuth token refresh. A hung refresh is coalesced across all callers, so it would otherwise wedge every request for that account |
| `TEAMCLAUDE_RATE_LIMIT_ABSORB_MAX_SECONDS` | `60` | Longest `retry-after` absorbed inline on the same account before a rate-limit 429 is surfaced to the client — see [the two kinds of 429](routing.md#the-two-kinds-of-429) |

**Upstream admission.** Node's connection pool queues requests past `MAX_SOCKETS` internally, without bound and without a deadline — a client that had already gone away kept its request (and its buffered body) parked there until a long-lived stream ahead of it ended. Requests are now admitted per origin *before* the upstream connection is built: the queue is bounded by `TEAMCLAUDE_UPSTREAM_MAX_QUEUE`, the wait by `TEAMCLAUDE_UPSTREAM_QUEUE_TIMEOUT_MS`, and a client that disconnects while queued leaves the queue at once. A request the gate refuses gets a **`503` with `Retry-After: 1`** and an `overloaded_error` body. That is the proxy saying it is saturated, not the account: it is never retried on another account (every account shares the same origin gate, and another attempt would only add load), no account is paused or sidelined over it, and in the activity log the row is attributed to `(upstream queue full)` rather than to an account. `GET /teamclaude/status` reports the gate under `upstreamPool` — `active`, `queued`, `origins`, `perOriginLimit`, `maxQueue`, `queueTimeoutMs` — counters only.

If you **lowered** `TEAMCLAUDE_UPSTREAM_MAX_SOCKETS`, note the change in behaviour: requests past the limit used to queue indefinitely inside Node's pool; they now wait at most `TEAMCLAUDE_UPSTREAM_QUEUE_TIMEOUT_MS` (5 s) and then fail with the 503 above. Long streaming completions hold their slot for their whole duration, so a small pool with many concurrent sessions will see these 503s; raise the pool width (or the queue and its deadline) to match your concurrency. The global-`fetch` escape hatch (`TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH=1`) has no pool and is not gated.

A client that disconnects mid-request no longer keeps its upstream work alive either: the upstream request is cancelled (queued or in flight), a quota-hold or rate-limit sleep ends immediately, and a silent SSE stream is cancelled rather than held until the body-idle watchdog. The activity row for such a request closes as `499`.
