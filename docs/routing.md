# Routing and rotation

How TeamClaude decides which account serves a request, and what it does when that account runs out.

## Request lifecycle

1. Claude Code connects to the local proxy instead of `api.anthropic.com`.
2. The proxy selects the active account and forwards requests with that account's credentials.
3. OAuth tokens expiring within 5 minutes are automatically refreshed and persisted to config.
4. Rate limit headers from the API (`anthropic-ratelimit-unified-*`) track session (5h) and weekly (7d) quota utilization.
5. When usage reaches the threshold, the proxy switches to the best available account (see [Choosing an account](#choosing-an-account)).
6. On 429 responses, the proxy waits the `retry-after` duration and retries; on persistent errors, it switches accounts.
7. Transient network errors (connection reset, timeout) drop the connection so the client can retry.
8. If all accounts are exhausted, returns 429 with the soonest reset time — or, with [`holdSeconds`](quota.md#hold-on-exhaustion) set, holds the connection open and retries silently until an account recovers.
9. Client token refresh requests (`/v1/oauth/token`) are relayed to upstream untouched — the proxy and client manage their own token lifecycles independently.

## Choosing an account

TeamClaude prefers to keep you on one account. It stays on the current one and only rotates when that account nears `switchThreshold` (default `0.98`).

When it does have to pick, ranking is: lowest `priority` number first, then, among accounts of equal priority, the one whose governing weekly bucket resets soonest. Spending the account closest to its refresh preserves the ones whose window resets further out. A model with its own weekly bucket (Fable, Sonnet) is ranked by that bucket rather than the shared one. Set an explicit order with `teamclaude priority <name> <n>`, or `--first` / `--last`.

## The two kinds of 429

Reacting the wrong way to either one makes things worse, so they are handled separately.

- A **quota rejection** (a spent 5h or weekly bucket, `unified-…-status: rejected`) switches accounts immediately.
- A **rate-limit 429** (the per-minute throttle) does **not** switch. It pauses the account so concurrent requests wait instead of flooding, retries the same account (absorbing short `retry-after`s inline, default ≤ 60s via `TEAMCLAUDE_RATE_LIMIT_ABSORB_MAX_SECONDS`), and only surfaces a 429 to the client for longer waits.

Rotating on a rate-limit 429 would just move the burst to the next account and throw away the first account's prompt cache.

## OAuth entitlement denials

A `403` whose structured error code is `error.details.error_code: oauth_not_allowed_for_organization` means the selected account's organization does not permit OAuth authentication. TeamClaude fails the current request over to another account and keeps the denied account out of automatic rotation for five minutes. The cooldown is shared by later requests, is not persisted, and expires automatically so an organization policy change can recover without restarting the proxy. Other `403` responses still fail over for that request but do not quarantine the account.

If every configured account returns that exact denial, TeamClaude's terminal `502` says that no account served the request, names the denied accounts and error code, and recommends waiting for automatic re-admission or pinning a different eligible account. It does not recommend `teamclaude login`, which remains the diagnostic for a generic credential refusal.

An explicit [`TC_ACCT` pin](#pin-a-session-to-one-account) continues to target exactly the requested account and never fails over, even while that account is excluded from automatic rotation.

## Storm control

When you run many agents at once and the active account runs out, every in-flight request fails over to the next account **at the same instant** — a thundering herd that can spend a big chunk of the fresh account's quota (large contexts) and instantly throttle it, cascading down the fleet ([#84](https://github.com/KarpelesLab/teamclaude/issues/84)).

To prevent this, requests onto a **just-switched-to account** are paced: concurrency starts at 1 and the cap ramps up over a few seconds, then lifts. The first request or two reveal whether the new account is also near-exhausted **before** the whole herd commits to it, so a cascade is broken up hop by hop. The gate is **fail-open** — a request never blocks longer than the ramp window, and a client that disconnects while waiting just drops out — and the slot is held only until response headers arrive, so streaming replies don't tie up concurrency.

On by default. Tune or disable via `stormRamp` in the config:

```json
"stormRamp": { "enabled": true, "startConc": 1, "stepConc": 1, "stepMs": 250, "windowMs": 30000 }
```

- **`startConc`** — concurrent requests allowed the instant a switch happens (default 1).
- **`stepConc`** / **`stepMs`** — the cap grows by `stepConc` every `stepMs` (default +1 every 250ms ≈ 4 req/s).
- **`windowMs`** — after this long, pacing stops entirely (default 30s).
- **`enabled: false`** — turn storm control off (send the full burst immediately, pre-#84 behavior).

The same gate handles rate-limit 429s: TeamClaude pauses the account for the `retry-after` window so new queries wait instead of piling on, then releases the held queries through a fresh ramp (staggered, not all at once).

## Model-aware routing

The per-model weekly cap (e.g. Fable) is tracked separately, so an account whose Fable quota is spent is skipped **only** for Fable requests and still serves Opus/Sonnet. Requests are routed by their `model`, read exactly from the request body in both base-URL and MITM modes. `teamclaude status` shows this per account (a `Models` line) and any families it detects appear as **auto** routes.

Advisor requests (Claude Code's `/advisor`) carry a **second** model nested in the tools array. Routing sees it too, so the request lands on an account eligible for both the main model and the advisor, falling back to main-model-only routing when no account can serve both.

Unwanted models can be rejected outright with [`blockedModels`](configuration.md#fields) instead of being forwarded — a model no account can serve otherwise gets rate-limited upstream and hangs the pipeline.

## Model routes

Per-model quota is respected automatically, so most setups need nothing here. To go further you can pin model patterns to an **exclusive** set of accounts with a `routes` table. Each route matches the request's `model` id against shell-style globs (`*` is the only wildcard) and, on the **first matching** route, restricts the request to the listed accounts:

```json
"routes": [
  { "name": "fable", "match": ["*fable*"], "accounts": ["personal-max"], "color": "magenta" },
  { "name": "bulk",  "match": ["*opus*", "*sonnet*"], "accounts": ["corp-1", "corp-2"], "color": "blue" }
]
```

- **`match`** — one or more model globs; the first route whose globs match wins.
- **`accounts`** — account names (or indices) that may serve matching models. **Exclusive**: only these are used (and they 429/rotate among themselves when spent). Omit to route to all accounts — e.g. to only set a `bucket` override.
- **`bucket`** — optional: force which quota bucket governs eligibility (`unified7dFable`, `unified7dSonnet`, `unified7d`), for the rare case the family can't be inferred from the model id.
- **`color`** — optional: `red`/`green`/`yellow`/`blue`/`magenta`/`cyan`, tinting this route's inline marker in the TUI. Display only.

Manage routes from the shell (changes apply to a running server immediately):

```bash
teamclaude route list
teamclaude route add fable --match '*fable*' --accounts personal-max --color magenta
teamclaude route add bulk  --match '*opus*,*sonnet*' --accounts corp-1,corp-2
teamclaude route rm fable
```

…or interactively in the TUI: open settings (**`g`**) → **Manage routing**, then `a` add / `e` edit / `d` delete (the editor prompts for a marker color too).

**Inline markers (TUI).** Instead of a separate list, each route surfaces on the account rows as a colored `►`: next to the **`F7`**/**`S7`** bar for a Fable/Sonnet route, or at the **start of the row** for a general route (one fixed column per route so its position is stable). The marker is bold on the account a route is pinned to, dim when that account is currently ineligible. `teamclaude status` still prints the routes as a list, colored and annotated with any pin.

**Manual per-route switching (TUI).** Press **`s`** to switch accounts, then **`←`**/**`→`** (or **`Tab`**) to choose *what* you're switching: the global **default** account, or a specific **route**. Pick an account with `↑`/`↓` and **`Enter`** to pin that route to it; `Enter` again on the current pin clears it. Pins are a **runtime preference** — not saved to config — and routing **falls back** to normal best-available selection whenever the pinned account is throttled or over quota, so a pin never stalls requests.

## Session-aware routing

TeamClaude always tracks running Claude Code sessions by their `x-claude-code-session-id` header — the TUI header and `teamclaude status` show how many are **active** (a request in flight right now, or seen in the last ~2 min) and **known** (seen in the last hour; sessions are forgotten after an hour idle, the maximum prompt-cache extension window). A long streaming request keeps its session active and non-expirable for its whole duration, so a multi-minute completion still counts as load. This is passive: it observes, it doesn't change routing.

Default rotation is purely quota-driven, so many parallel sessions all pile onto the *current* account while equal-priority siblings sit idle — one account queues behind its upstream concurrency ceiling while others do nothing ([#109](https://github.com/KarpelesLab/teamclaude/issues/109)). Enable `distributeSessions` to fix that:

```json
"distributeSessions": true
```

When on, TeamClaude routes each **new** session to the least-loaded eligible account (fewest active sessions, then fewest in-flight) and **pins** it there, so a session keeps hitting the same account and preserves its prompt cache — while different sessions spread across accounts instead of funnelling onto one. Account **priority still wins** (a higher-priority account is never skipped to balance load), and a session whose account becomes exhausted re-routes automatically. Off by default; single-session use is unaffected either way.

## Pin a session to one account

`TC_ACCT` forces every request onto **one** account, bypassing rotation (and never failing over to another). It works in **both** modes — MITM (the default) and `--no-mitm`:

```bash
# By email — what you'll normally use
TC_ACCT=me@example.com teamclaude run

# By accountUuid — stable across renames; `teamclaude accounts` prints it
TC_ACCT=a1b2c3d4-… teamclaude run
```

`TC_ACCT` is read by `teamclaude run` and **removed from the environment before claude is launched** — it never reaches the client or anything it spawns. Under `--no-mitm` TeamClaude builds the pinned base URL itself; under MITM it travels as the proxy credential on each `CONNECT`, which is the only pin channel an `HTTPS_PROXY` URL can carry. Either way you don't hand-write a URL.

`teamclaude env` honours it identically, so a tool that spawns claude itself gets the same pin:

```bash
TC_ACCT=me@example.com eval "$(teamclaude env)"
```

The value matches an `accountUuid`, an `orgUuid`, or a display name/email, first match wins. No escaping needed; spaces, `@` and parens are handled for you. An unknown value is refused by the proxy with a `404` rather than quietly served by whichever account rotation picked. That refusal happens on the first request, not at launch, so a typo shows up as a failing claude rather than a wrong account.

Prefer the `accountUuid` (printed by `teamclaude accounts`) for anything scripted: display names are rewritten in place, since an account is named by its email and gains an ` (Org)` suffix the moment that email holds a second org.

The rotation index is **not** accepted — it is array position, so deleting an account would silently repoint every later pin at a *different* account.

> If you hold the *same* account in two orgs, a bare uuid or email matches the first one. `TC_ACCT=<accountUuid>/<orgUuid>` picks a specific one — rarely needed.

<details>
<summary>Pinning without <code>teamclaude run</code> (<code>/tc-acct/</code>, deprecated)</summary>

**Deprecated** — use `TC_ACCT` instead. The path-prefix form cannot work in MITM mode (inside a CONNECT tunnel the path is the real upstream one), so it only covers half the product. It still works for keep-warm's internal use and for calling the proxy directly:

```bash
curl -s http://127.0.0.1:3456/tc-acct/1/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: <your teamclaude proxy key>' \
  -d '{"model":"claude-sonnet-4-6","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

URL-encode spaces and parens in a name here. The fully-qualified `accountUuid/orgUuid` form is **not** expressible in a path (the `/` is the delimiter) — use `TC_ACCT` for that. An unknown pin returns `404`. The prefix is stripped before the request is forwarded upstream.

</details>

## Prompt caching across rotation

Rotation is transparent to your Claude Code session, but it's worth knowing how it interacts with Anthropic's [prompt cache](https://docs.claude.com/en/docs/build-with-claude/prompt-caching).

- **Your context is never lost.** Claude Code resends the full transcript every turn, and TeamClaude rewrites the request's `account_uuid` to match the injected token, so whichever account serves a turn sees the complete history — a mid-session switch is invisible to the client.
- **The cache doesn't carry across accounts.** The prompt cache is scoped to the account/organization that created it and expires after a few minutes, so the first turn after a switch is a cache **miss** — that turn is processed without the cache discount, after which the new account warms its own cache. No proxy can share a cache across organizations.

In practice this rarely bites, because TeamClaude prefers to keep you on one account (see [Choosing an account](#choosing-an-account)) — a single account tends to serve a whole session and switches are infrequent.

> [Keep-warm](quota.md#keep-warm) is unrelated to this — it starts an idle account's **5h session timer**, not its prompt cache. A freshly-rotated account still takes a one-turn cache miss regardless.
