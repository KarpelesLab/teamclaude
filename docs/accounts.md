# Accounts

Adding, naming, and managing the accounts TeamClaude rotates between.

## OAuth login (recommended)

```bash
teamclaude login
```

Opens your browser and uses the same OAuth flow as Claude Code. Auto-detects the account email and subscription tier. Logging in with the same account again updates its credentials.

Run it once per account. You can add accounts while the server is running — press **R** in the TUI to reload.

If the profile cannot be identified, login stops without adding a placeholder
account. Retry after confirming the credential is valid, or pass
`teamclaude login --name <name>` to add it without profile detection. A
credential the upstream rejects with 401 (and that cannot be refreshed) is
refused regardless of `--name` — log in again to get a fresh one.

## Import from Claude Code

If you already have Claude Code set up, import its credentials directly:

```bash
claude /login           # log into an account in Claude Code
teamclaude import       # import its credentials
```

Re-importing the same account updates its credentials. You can also import from a custom path:

```bash
teamclaude import --from /path/to/credentials.json
```

Automatic naming requires a successful profile lookup. If credentials are
invalid or the profile cannot be identified, the import stops without adding a
placeholder account. Pass `--name <name>` to explicitly import without profile
detection. An expired access token is refreshed on import when the file carries
a refresh token; a credential the upstream rejects with 401 (and that cannot be
refreshed) is refused regardless of `--name` — run `claude /login` and import
again, or `teamclaude login`.

## Delegating credentials to a file (`importFrom`)

Instead of storing an OAuth account's tokens in `teamclaude.json`, an account entry can name the file to read them from:

```json
{ "name": "me@example.com", "type": "oauth", "importFrom": "~/.claude/.credentials.json" }
```

The tokens (`accessToken`, `refreshToken`, `expiresAt`) are read from that file at startup and again on every config reload, so a login refreshed by Claude Code itself is picked up without re-running `teamclaude import`. Every other field on the entry (`priority`, `disabled`, `upstream`, `modelMap`, …) is kept as written. A file with no token skips the account with a message rather than sending an empty credential upstream. `teamclaude import` is the alternative: it copies the tokens into the config once.

## API key

For Anthropic API key accounts (billed via Console):

```bash
teamclaude login --api
```

A key is **metered** — every token it serves is billed — while a subscription's quota is paid for whether it is spent or not. So a key is added at `priority: 100`, the fallback tier: rotation reaches it only when every account ahead of it is spent, and leaves it the moment one of them has quota again (a higher-priority account preempts on the next selection, so a reset elsewhere moves traffic back off the key). Pass `--priority <n>` to place it yourself; `--priority 0` puts it level with the subscriptions, which is where an added key sat before 1.1.23. A key already in the config keeps whatever priority it has: `teamclaude priority <name> 100` (or `--last`) moves it to the back.

### When the key is rejected (401)

A 401 on an API-key account never reaches the client. The request fails over to the next account, and the account that answered it is held out of rotation for a cooldown, then tried again. It is not benched for good, because a 401 does not always mean the key is bad: a gateway such as LiteLLM, set as the account's `upstream`, can answer one while its own upstream is unreachable.

The hold lengthens while the key keeps being rejected: 1 minute after the first 401, then 5 minutes, 15 minutes, and 1 hour for every one after that. Any successful response from the account starts the sequence over. A key that really is revoked therefore costs one failed-over request per hour, and an account whose gateway recovers comes back by itself.

While the hold lasts, `status`, the TUI and the dashboard show the account as blocked with "upstream rejected its API key with a 401", and the server log says how long the hold is. Reloading a config that carries a different key for the account, or disabling and re-enabling it, lifts the hold at once.

An OAuth account is different. A 401 there triggers a token refresh, and an account that has no refresh token to try is taken out of rotation until it is logged in again.

## Multiple organizations

One email can hold multiple accounts across different organizations (e.g. corp + personal). Dedup is keyed on account + org, and names disambiguate as `email (Org)`.

Pass `--org <name|uuid>` to resolve a bare email when it is ambiguous:

```bash
teamclaude remove user@example.com --org Acme
```

## Managing accounts

```bash
teamclaude accounts             # list accounts with tier and token status
teamclaude accounts -v          # also show token expiry times
teamclaude remove <name>        # remove an account (by name or email)
teamclaude disable <name>       # temporarily exclude it from rotation
teamclaude enable <name>        # re-enable it (also clears a stuck error state)
teamclaude priority <name> 1    # rotation preference, lower = preferred
teamclaude priority <name> --first
teamclaude priority <name> --last
teamclaude routing <name> <url> # route ALL of the account's traffic via its own proxy
teamclaude routing <name> none  # clear it
teamclaude routing <name> --check  # test the proxy the account already has
```

`login`, `import`, `enable`, `disable`, `priority` and `routing` notify a running server to reload, so credential, priority, enable/disable and routing changes are picked up live; the same reload (POST `/teamclaude/reload`, or **R** in the TUI) also applies hand edits to an account's `upstream`/`modelMap`. Account **removals** made on disk (`teamclaude remove` from another shell, or a hand edit) are applied by the same reload: a running account whose entry is gone from the file is dropped from the fleet, and the reload reports how many it added and how many it removed. An account added in the TUI is safe during the moment between its addition and its save — a reload that reads the file first leaves it alone rather than treating the missing row as a removal. Removing one from the TUI or through the [MCP endpoint](usage.md#mcp-endpoint)'s `remove_account` takes effect at once.

## Syncing accounts across machines (callback.net)

A pooled OAuth token lives a few days, and then has to be signed in again — on every machine that holds a copy. Sign each install in to [callback.net](https://www.callback.net/) instead, and they keep each other's tokens:

```bash
teamclaude callback login      # prints a URL to approve in any browser (--no-browser to not open one)
teamclaude callback status     # who this install is signed in as
teamclaude callback sync       # reconcile the running server with the store now
teamclaude callback logout     # revoke the session and stop syncing
```

The sign-in is a poll-token OAuth2 flow: the URL can be opened on any machine, so it works over SSH and in a container, and no local port is listened on. The session token is this install's own and lives beside the config (`<config>.callback.json`, mode `0600`), never in the config itself. Being signed in is the whole opt-in; there is no config key. `logout` turns it off.

**What callback.net does with the data.** It stores your tokens and nothing else: the rows are the account's identity and its access and refresh tokens, encrypted in transit (TLS) and at rest, readable only with your callback.net login, and never used by the service itself — it holds them so your other installs can read them. The service is provided free of charge, as a convenience for exactly this: syncing your own tokens between your own computers. Use it for that and nothing else; in particular, it is not a place to share accounts with other people, and the pool's per-client keys and routing are the tools for sharing a proxy.

While signed in, every **OAuth** account (Claude and Codex) is kept as one row of your `User/Credential` store on callback.net, encrypted at rest and keyed by the account's identity (provider, account, organization), so each of your installs names the same account the same way. What travels is the identity and the tokens: `priority`, `disabled`, `routing` and the display order stay on each install. API-key accounts and [third-party backends](#third-party-backend-accounts) are not synced — a key does not expire, and a backend credential is not ours to renew.

- **A pass** runs when the server starts, on every reload (`callback login`, `login`, `import` and `callback sync` all trigger one) and once a day. A row with no local account becomes one, so signing in on a new machine brings every account over. A row whose token is newer than the local one — the later `expiresAt`, which a renewal always pushes forward — replaces it. A local account newer than its row updates the row, and one with no row creates it.
- **A token refresh** goes through the row's advisory lock, so one install renews and the rest adopt. A refresh rotates the token family, and two installs renewing one account at once would each invalidate the other's copy — which is exactly the "sign in again everywhere" this exists to end. With the lock taken, the row is read first: if another install has already renewed, that token is adopted and the provider is not called. Refused, another install is renewing: a token that is still good (the refresh runs five minutes ahead of expiry) is simply kept, the renewal arrives through the store, and the next request asks again. A token that has already expired, or that upstream just rejected, waits instead, re-reading every 5 seconds for 30 seconds, adopts what the holder stores, and otherwise tries the lock again; a lock that nobody releases times out after 30 seconds. A store that cannot be reached never stops a refresh: the account is renewed without it and stored on the next pass.
- **Every other token change** on an install — a `login`, an `import`, a refresh Claude Code made itself that the proxy relayed — is stored the same way.
- **An account in error never writes.** Once upstream has rejected an account's token (status `error`, "needs re-login"), what this install holds is dead, so it is never stored — not by a pass, not as a token change — however late its `expiresAt`. It only reads: the moment it goes into error, and at every pass after, a row holding a different token (another install renewed it, or you signed in there) is adopted whatever its expiry, and the account is back in rotation.
- **Removal travels.** `teamclaude remove` (or the TUI, or the MCP endpoint) writes a tombstone into the account's row — `{"_deleted": "<time>"}` — and every other install removes the account at its next pass. A token refresh on an install that has not yet seen the tombstone still goes through, but never writes over it; only an explicit sign-in (`login`, `import`) does, which is how a removed account comes back everywhere. A tombstone older than a week is deleted by whichever pass sees it.

`teamclaude status --json` carries the sync's state under `callbackSync`: the last pass, its error if it failed, how many accounts the store holds and how many tombstones.

## Per-account routing (`routing`)

One account can leave through its own proxy while the rest of the fleet goes direct (or through the fleet [upstream proxy](proxy-modes.md#upstream-proxy)):

```bash
teamclaude login --name "waffles@waffle.com" --routing "socks5h://alice:s3cret@proxy.example.com:1080"
teamclaude routing waffles@waffle.com socks5h://alice:s3cret@proxy.example.com:1080
teamclaude routing waffles@waffle.com        # show it (password masked)
teamclaude routing waffles@waffle.com --check  # show it, and test the proxy
teamclaude routing waffles@waffle.com none   # clear it
```

Or in the config:

```json
{ "name": "waffles@waffle.com", "type": "oauth", "routing": "socks5h://alice:s3cret@proxy.example.com:1080" }
```

**Every** connection made for that account (request forwarding, OAuth login and token refresh, profile, usage and quota probes) tunnels through the proxy with TLS end to end, and no other account is touched. A routed account bypasses both the fleet upstream proxy and sx.org: the contract is that its traffic never leaves by another path, so even a post-429 sx retry goes through the account's own proxy.

Schemes:

| Scheme | Protocol | Hostname resolution |
| --- | --- | --- |
| `http` | HTTP `CONNECT` | at the proxy |
| `socks5` | SOCKS5 | locally |
| `socks5h` | SOCKS5 | at the proxy |
| `socks4` | SOCKS4 | locally (IPv4 only) |
| `socks4a` | SOCKS4 | at the proxy |

Optional `user:pass@` auth works for `http` and `socks5`/`socks5h` (SOCKS4 carries a username only, so a password there is refused with a message). A bare `host:port` is read as `http`. The `h`/`a` forms are usually what you want for a remote exit: the proxy resolves the hostname, so the exit's DNS view matches its geography.

The value is validated when the account is read: a bad URL is reported once and ignored, never fatal, and so is a URL that names this server's own address, which would send the account's requests straight back into the proxy (the CLI, the TUI and the MCP tool refuse to store one). It shows masked in `teamclaude accounts`, `status`, the TUI and the web dashboard, and the reload note above applies to disk edits and `routing` changes alike. The proxy password is masked everywhere it is printed, error messages and the MCP write log included. `teamclaude api --account <name>` sends the account's credential, so it leaves through the account's proxy as well. Changed alongside: `teamclaude api` used to bypass the fleet [upstream proxy](proxy-modes.md#upstream-proxy) too, and now goes through it when one is configured, like every other call TeamClaude makes with an account's credential.

Besides the CLI there are two more places to set it. In the TUI, **`g`** then **Account proxy** picks an account and asks for the URL (`none` clears it). Over the [MCP endpoint](usage.md#mcp-endpoint) the tool is `set_account_routing`.

### What is not routed

Routing covers what TeamClaude does with the account's own credential. Two kinds of traffic are outside that, and both keep the fleet path:

- Claude Code's own identity calls (`/api/oauth/*`, `/v1/code/*`, the Remote Control bridge's `/v1/environments/*`, `/v1/sessions/*`, `/v2/session_ingress/*` and `/v2/ccr-sessions/*`, and its token refresh) are relayed with the credential of the Claude Code login, never with a pooled account's, so they belong to no account here. That holds even when the login is the same person as a routed account.
- A sign-in or import that names no account. Which account it belongs to is only known once the profile has been read, so that lookup cannot use a proxy it has not found yet. Pass `--name` (or `--routing`) and it can.

### The proxy is tested before anything depends on it

`login --routing`, `import --routing`, `routing <name> <url>` and the TUI row all open a tunnel through the proxy to the account's upstream and finish the TLS handshake before they change anything. No request is sent, so the only credential that leaves the machine is the proxy's own. If the test fails the command stops and nothing is saved:

```
$ teamclaude routing waffles@waffle.com socks5h://alice:wrong@proxy.example.com:1080
Routing proxy check failed: account routing proxy socks5h://alice:***@proxy.example.com:1080: SOCKS5 authentication failed
Nothing was changed. Fix the proxy or the URL, or pass --no-check to skip this test.
```

For an OAuth login this is what saves the sign-in. The authorisation code works once, so a wrong proxy password found at the token exchange would cost you the whole browser flow. Pass `--no-check` when the proxy is not up yet.

`--routing URL` and `--routing=URL` both work. A `--routing` with nothing after it is an error and is never ignored: the account would otherwise be added from this machine's own address, and that is the one outcome the flag exists to prevent.

### Signing a routed account in again

`teamclaude login --name "waffles@waffle.com"` reuses the routing that account already has, so a re-login leaves through the same proxy without the URL being typed again. The stored value is only borrowed for the sign-in and is left as it was.

If that proxy is dead and the account needs a new sign-in now, add `--routing none`. That signs in without a proxy and clears the stored routing, the same way `teamclaude routing <name> none` does.

Without `--name`, TeamClaude cannot know which account a sign-in belongs to until it is over. If it turns out to be a routed account, the command says that the sign-in went out unrouted and how to route the next one.

### When the proxy is down

A proxy that refuses connections, times out or rejects its credentials takes only its own account with it. The request that found out fails over to the next account. The routed account is then held out of rotation for 30 seconds, so the requests behind it do not each wait on a dead proxy, and the first request after the hold tries the proxy again.

While the hold lasts, `status`, the TUI and the dashboard show the account as blocked with "the account's routing proxy is unreachable", and the server log names the account and its masked proxy. When every eligible account is in that state the client gets a `429` whose message says so and whose `retry-after` is the rest of the hold, not a quota reset. A request pinned to the account (`TC_ACCT`) still goes to it. Changing the account's routing lifts the hold at once.

Two fleet features reason about this machine's own exit address, which a routed account no longer uses. A `429` on a routed account does not trigger the [sx.org](proxy-modes.md#sxorg-proxy-mode) retry or its sticky window. The `egress.pin` check runs before an account is chosen, so while the machine's own exit IP is wrong it holds every request, including ones a routed account could have served.


Accounts can also be added, removed and reordered from the TUI settings screen: **`g`** → **Add account** / **Remove account** / **Reorder accounts**.

### Signing in again from the TUI

An OAuth account whose refresh token upstream has rejected — typically because the same account was signed in somewhere else, which rotates the token and kills the copy TeamClaude holds — shows as `error` and stays that way until someone signs in again. Press **`l`** on the dashboard: the picker opens on the first account in `error`, and **Enter** opens the provider's sign-in page in your browser (Claude or Codex, by the account's provider). The dashboard stays live while it waits, up to two minutes.

The tokens go to the account the browser actually signed in as, matched by identity exactly as `teamclaude login` does — not to whichever row was highlighted. Sign in as a different account and that account is updated (or added) instead, the activity pane says so, and the row you picked still needs its login.

The key needs a browser on the machine running the server, so it is not offered in `teamclaude attach`, and on a headless host `teamclaude login --token` remains the way.

**Reorder accounts** sets the order the account list is drawn in — `↑`/`↓` pick an account, `←`/`→` move it up and down, each move saved as you make it. It writes a `displayOrder` on the entry and touches nothing else: an account keeps its place in the `accounts` array, so route pins, session pins and `TC_ACCT` all go on naming the same accounts, and rotation order stays `priority`'s business alone. An account with no `displayOrder` — every account, until the first time you arrange them, and every one added afterwards — lists after the ones that have one, which is where a newly added account appeared anyway. A [third-party backend](#third-party-backend-accounts) served by a local process is infrastructure rather than a seat to rotate between: the TUI keeps those at the end of the list, and the screen leaves them there.

## The `id` field

Every account entry carries an `id`, added the first time the config is read and written back on the next save. It is what ties an entry to the running account built from it: entries without a usable credential are skipped at startup, so an entry's place in the file is not the account's place in the fleet, and a token refreshed for one account would otherwise be recorded against another.

Hand edits are fine. Leave the `id` alone and it keeps working; delete it and a new one is issued on the next read. If you copy an account block to make a second entry, the duplicated `id` is spotted on the next read and the later of the two gets a fresh one.

## Codex accounts (experimental)

An OpenAI Codex subscription can be pooled alongside your Claude accounts.

```bash
teamclaude login --codex     # browser sign-in, repeat per account
```

Add `--no-browser` to print the URL instead of opening one, and `--name` to
label the account yourself (it defaults to the email on the login).

To pool a login you already have, or to add one without a browser, point an
account at the Codex CLI's own credentials file instead — it defaults to
`~/.codex/auth.json`:

```json
{ "name": "me@example.com", "type": "oauth", "provider": "codex" }
```

The Codex CLI honours `CODEX_HOME`, so several logins can be kept side by side
and pooled with `importFrom`:

```bash
CODEX_HOME=~/.codex-second codex login
```

```json
{ "name": "second", "type": "oauth", "provider": "codex",
  "importFrom": "~/.codex-second/auth.json" }
```

Then tell Codex to reach TeamClaude instead of OpenAI, in `~/.codex/config.toml`:

```toml
model_provider = "teamclaude"

[model_providers.teamclaude]
name = "teamclaude"
base_url = "http://127.0.0.1:3456/backend-api/codex"
wire_api = "responses"
```

### Through the MITM proxy (no Codex config needed)

MITM mode intercepts `chatgpt.com` as well as `api.anthropic.com`, so a Codex CLI
launched behind the proxy is pooled with no `~/.codex/config.toml` change at all:

```bash
eval "$(teamclaude env)"   # HTTPS_PROXY + NODE_EXTRA_CA_CERTS
codex
```

Two boundaries worth knowing:

- `chatgpt.com` is intercepted **only when a Codex account is configured**. An
  Anthropic-only fleet tunnels it untouched — intercepting a host nobody asked
  the proxy to read is not a neutral default.
- `ab.chatgpt.com` is never intercepted. It is OpenAI's telemetry endpoint,
  carries no inference, and there is nothing there to rewrite.
- On the intercepted `chatgpt.com`, only `/backend-api/codex/*` is pooled.
  Everything else the CLI sends there — the workspace discovery codex-cli
  0.156 makes before every turn (`/backend-api/wham/accounts/check`), its
  plugin, MCP and settings calls — goes through to `chatgpt.com` with the
  client's own login, untouched. Those calls are not inference and belong to
  that login; they used to be classified as Anthropic traffic and answered 404
  by `api.anthropic.com` ([#492](https://github.com/KarpelesLab/teamclaude/issues/492)).
- The Codex **Responses WebSocket** is refused (`501`). A WebSocket is relayed
  with the client's own headers, so a turn over it would run on the client's
  login and book nothing against the pool. Refused, the CLI falls back to
  HTTPS, where the pool serves it — the cost is its reconnect attempts before
  it does.

The base-URL route below still works and is the way to pool Codex without MITM.

`OPENAI_BASE_URL` does **not** work for this — a ChatGPT-authenticated Codex
ignores it. `model_providers` is the supported redirect.

The `/backend-api/codex` suffix matters. A Codex subscription authenticates
against the ChatGPT backend, not the OpenAI API platform — pointed at
`api.openai.com` the same token is refused with `Missing scopes:
api.responses.write`. Codex appends `/responses` and `/models` to `base_url`,
so this suffix makes it emit exactly the paths the ChatGPT backend expects and
TeamClaude forwards them verbatim.

### How it shares the port with Claude

One listener serves both CLIs, because the request path says which pool of
accounts is eligible: Claude Code posts to `/v1/messages`, Codex posts to
`/backend-api/codex/responses`. An Anthropic account is never offered a Codex
request and vice versa, so the two rotate independently on one port, one config
and one TUI.

### What differs from a Claude account

- The credential is injected as `Authorization: Bearer`, plus a
  `ChatGPT-Account-Id` header. That header is OpenAI's counterpart to the
  `account_uuid` TeamClaude patches into an Anthropic request body — so the
  Codex path performs no body rewrite at all.
- Tokens refresh against `auth.openai.com` using the Codex CLI's own client id.
- The proxy waits **5 minutes** for the response head instead of the fleet's 2,
  because the ChatGPT backend sends nothing until the model has finished
  reasoning — on a large-context turn that is minutes of silence on a perfectly
  healthy socket. The wait covers the head only: once it arrives the deadline is
  dropped and the body streams for as long as it needs.
  `TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS` overrides both figures.
- The request body is forwarded untouched. This is a passthrough, not a
  translation layer: TeamClaude never converts between the Anthropic and OpenAI
  protocols.

### Quota

Codex reports its limits on every response, and TeamClaude normalises them into
the same fields the Anthropic path fills — so the switch threshold, reset
countdowns and the TUI's quota bars work for Codex accounts too, and rotation
happens *before* upstream refuses rather than after a 429.

Two details are worth knowing if you read the raw headers:

- Limits arrive in families. The unnamed one is the account-wide limit; a family
  carrying `-limit-name` is model-scoped, the counterpart of Anthropic's Fable
  weekly bucket.
- `primary` and `secondary` are positions, not durations — the account-wide
  family can put its 7-day window in `primary` while a model-scoped family puts
  a 5-hour window there. Windows are classified by their stated
  `window-minutes`, never by position.

### Free rate-limit reset credits

OpenAI occasionally grants a ChatGPT account a free **rate-limit reset credit**:
redeeming one clears the account's spent windows ahead of their own reset. The
Codex CLI offers it as a manual action only, so a pooled account that runs dry
would otherwise sit out the rest of its week holding one.

The count an account holds comes free with the quota probe — it rides on the
same `/wham/usage` payload the quota reading does — and shows up as `RC1` on the
TUI row, a `Reset` line in `teamclaude status`, and a badge on the dashboard
card. It survives a restart, which matters because the probe is off by default.

Only the probe refreshes the count, so a reading can outlive the credit it
describes — redeemed in the Codex CLI, or expired. The `status` line therefore
says how old the reading is (`as of 3h ago`), and every surface drops it once it
is more than 7 days old.

The count is what the account **holds**. Whether a particular credit can be
spent is a separate question — the payload's `applicable_available_count` is
upstream's own view of how many would reset a window right now, and is named on
the `status` line when it is zero — and spending one is a manual action in the
Codex CLI unless you arm the switch below.

Spending one is **opt-in**, and the switch is fleet-wide: set
[`autoRedeemResets`](configuration.md) to `true`, or toggle it from the TUI
settings screen (**g** → **Auto-redeem**). It is `false` by default, and stays
that way until you say otherwise: a redemption cannot be undone and the credits
are scarce, so a fleet nobody has armed holds its credits for manual use however
dry it runs. The switch is fleet-scoped because the policy below is — "only when
the whole pool is dry" is a statement about the fleet, not about one account —
and it applies live, so it can be armed or killed without a restart.

One account can be exempted with `accounts[].autoRedeemReset: false`, and that
is **all** that key can do. A per-account `true` arms nothing on its own: with
`autoRedeemResets` off, no account spends anything.

A redemption is considered at the moment a spent weekly window turns a request
away with nothing chosen to serve it: every Codex account the request is
eligible for is out of quota, so selection refuses it before picking one and
nothing is ever sent upstream. On a pool of two this is what almost every
request gets. Only the accounts a reset would actually return to service are
considered — an account you disabled or capped stays out whatever its windows
say — and when several qualify, the one whose credit expires soonest is asked
first.

While it is on, a credit is spent only when **all** of this holds:

1. The account's **weekly** window is exhausted. A spent 5-hour window never
   triggers it — that one comes back on its own within hours, while the weekly
   one is what walls an account off for days, and a full reset is too scarce to
   burn on the short window.
2. The account holds a credit that is `available` **and** supported by its plan.
3. Either every other Codex account is unavailable too — so the credit actually
   unblocks work rather than topping up an account rotation would have stepped
   past — or the credit expires within three days.

At most one credit is spent, per dry pool rather than per account. Refusals
arriving together join a single attempt rather than each starting one, and an
attempt that has spent a credit — or that failed in a way that cannot rule out
having spent one — holds **every** account off for hours afterwards, not just
the one it touched. That hold is deliberately not left to the account a
redemption returned to service making condition 3 answer "no" for the others:
that depends on a quota re-read, and a re-read can fail.

The request is then re-selected and served on the account whose windows were
just reset. The whole decision — token refresh, credit read and redemption — is
held to a 10-second budget, because the waiting client's patience for the
response head is finite and the retry needs the rest of it. Every attempt and outcome is
logged.

## Claude banked usage-limit resets

Claude sometimes grants an account a **banked usage-limit reset**, shown under
**Resets** on the claude.ai usage page (for example "Full reset — Expires
Oct 23"). Spending one clears the account's 5-hour and 7-day windows ahead of
their own reset, whenever you choose.

The [quota probe](quota.md#quota-probe) reads the count from the same
zero-spend `/api/oauth/usage` call it already makes. It asks with
`?cedar_ember=1` and a Claude Code `User-Agent`, because the endpoint only
includes the reset block for a recent Claude Code client. The count shows up on
the same surfaces as the
[Codex reset credits](#free-rate-limit-reset-credits): `RC1` on the TUI row, a
`Reset` line in `teamclaude status` with when the reset lapses
(`expires 18d 23h`), and a badge with the date on the dashboard card. A reset
past its expiry date is dropped from every surface, as is a reading more than
7 days old.

The probe is off by default, so the count is only as fresh as the last probe:
`p` in the TUI, or `curl -X POST localhost:3456/teamclaude/probe`, refreshes
it once.

TeamClaude only **reports** a banked reset; it never spends one.
`autoRedeemResets` applies to Codex accounts only. Spend a Claude reset
yourself, on the claude.ai usage page or with `/limit-reset` in Claude Code.

## Third-party backend accounts

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
  }
}
```

- **`upstream`** — base URL of the target API. Requests are sent to `upstream + /v1/messages` (etc.) for this account only. One class of request is answered by the proxy instead of being forwarded — see [message threads](#message-threads) below.
- **`modelMap`** — when a Claude model name arrives in the request body, it is rewritten to the mapped name before forwarding.
- **`messageThreads`** — set to `true` when the backend keeps Anthropic message-thread state (a relay that reaches Anthropic does). Off by default for a third-party backend — see below.

Where the provider publishes one, its own balance or quota is shown in `teamclaude status` — see [third-party backend quota](quota.md#third-party-backend-quota).

A [NanoGPT](https://docs.nano-gpt.com/integrations/claude-code) account is the same shape. Its Anthropic-compatible endpoint is `/api/v1/messages`, so the `upstream` is `https://api.nano-gpt.com/api` — Claude Code's SDK appends `/v1/messages` itself, and the `/api/v1` base in NanoGPT's integration page would double it. Claude model names are accepted as they are, so no `modelMap` is needed for Claude; a non-Claude model is named `provider/model`, for example `z-ai/glm-5.3`:

```json
{
  "name": "nano-gpt",
  "type": "oauth",
  "accessToken": "your-nanogpt-api-key",
  "upstream": "https://api.nano-gpt.com/api",
  "priority": 100
}
```

`priority: 100` makes it a fallback for **every** model once the Claude accounts are spent — Claude names included, which NanoGPT passes through to Anthropic and bills by its own rules. A [route](routing.md#model-routes) is what sends a session to it on purpose, but a route only restricts who serves the models it matches; it does not keep the account out of ordinary rotation for the rest, so leave the priority high whichever you choose:

```json
{ "name": "nano", "match": ["z-ai/*", "moonshotai/*", "deepseek/*"], "accounts": ["nano-gpt"] }
```

Which models a NanoGPT subscription covers, and which are billed from the balance on top, is set by NanoGPT and not published per model; its `Plan` line in `teamclaude status` (see [third-party backend quota](quota.md#third-party-backend-quota)) shows when a request has started to bill the balance.

A [Z.ai GLM Coding Plan](https://docs.z.ai/devpack/tool/claude) is the same shape. Its endpoint serves only its own model names, so map the Claude names your sessions send onto them, and it takes the key as a bearer exactly as Claude Code's `ANTHROPIC_AUTH_TOKEN` would send it:

```json
{
  "name": "z.ai",
  "type": "oauth",
  "accessToken": "your-z.ai-api-key",
  "upstream": "https://api.z.ai/api/anthropic",
  "priority": 100,
  "modelMap": {
    "claude-haiku-4-5-20251001": "glm-5.3-flash",
    "claude-sonnet-5": "glm-5.3",
    "claude-opus-5": "glm-5.3",
    "claude-fable-5-1": "glm-5.3"
  }
}
```

Its 5-hour and weekly windows show up in `teamclaude status` (see [third-party backend quota](quota.md#third-party-backend-quota)). `priority: 100` makes it a fallback once the Claude accounts are spent — and then the `modelMap` above rewrites the Claude names onto GLM. A [route](routing.md#model-routes) matching `glm-*` sends a session to it on purpose, but a route only restricts who serves the models it matches; it does not keep the account out of ordinary rotation for the rest, so keep the priority high either way.

Reserve the backend for sessions that explicitly ask for its models with a [route](routing.md#model-routes):

```json
{ "name": "deepseek", "match": ["deepseek-*"], "accounts": ["deepseek"] }
```

Then pick the model at launch, or with `/model` inside a session:

```bash
# This session routes to DeepSeek; all other sessions still use Claude accounts.
claude --model 'deepseek-v4-pro[1m]'
```

Model names with brackets (e.g. `deepseek-v4-pro[1m]`) must be quoted in the shell.

### Message threads

Claude Code keeps the conversation on the server once a thread exists: the first `/v1/messages` body carries `thread: {"type": "create"}` with the whole messages array, and every later one carries `thread: {"type": "continue"}` with only the new delta. A backend that keeps no thread state ignores the unknown field and answers the delta on its own, so from the second turn onward the model no longer sees the conversation — and nothing anywhere reports an error.

When a thread cannot be continued Anthropic answers `400`, and Claude Code resends the whole conversation rather than giving up (observed on 2.1.269). So the proxy answers a `continue` bound for an account with a per-account `upstream` with that same `400` rather than forwarding it. The body carries `details.error_code: "thread_unsupported_request"`, which the client reads as "this model keeps no thread state": it resends the turn in full and then drops the `thread` field entirely for the rest of the session, so the refusals are counted per agent and model rather than per turn, and cost no tokens. A session running subagents pays one refusal for the main agent and one for each subagent on that model. `count_tokens` is never refused: there is no conversation to resend for a token count.

The flag the client sets is keyed on the model, not on the account serving it. If the same model name is served both by a third-party backend and by Anthropic accounts, a refusal turns threads off for that model everywhere until the session ends — the conversation still works, it just travels in full each turn.

An `upstream` whose host is Anthropic's own is left alone without any flag — a region pin or a mirror reaches the real thread store, so there is nothing to repair. The host is what decides it: a third-party API serving the Anthropic shape does that under its own host.

The effective upstream is what counts. A fleet pointed at a third-party host through the global `upstream` is covered the same way: every account without an `upstream` of its own is refused continues there. (Before 1.1.22 only a per-account `upstream` armed this; a fleet on a third-party global upstream now gets the repair without a setting.)

A relay that forwards to Anthropic does keep thread state, and for it the refusal is pure overhead — the client would re-send a full history each turn for nothing. Declare it with `"messageThreads": true` on the account, or at the top level of the config for the global `upstream`, and continues are forwarded untouched.

### `accounts[].models` is deprecated

The older per-account `models` list still works, but use a [route](routing.md#model-routes) instead. Routes are more flexible (glob matching, multiple accounts, bucket override) and less surprising: a `models` list changes eligibility across the *whole fleet* — once any account claims a model, every account that doesn't claim it is skipped for that model. The server prints a deprecation notice at startup naming the route to replace it with, and the field may be removed in a future version.
