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
`teamclaude login --name <name>` to add it without profile detection.

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
detection.

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
```

`login`, `import`, `enable`, `disable` and `priority` notify a running server to reload, so credential, priority and enable/disable changes are picked up live; the same reload (POST `/teamclaude/reload`, or **R** in the TUI) also applies hand edits to an account's `upstream`/`modelMap`. Account **removals** still need a restart.

Accounts can also be added and removed from the TUI settings screen: **`g`** → **Add account** / **Remove account**.

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

- **`upstream`** — base URL of the target API. Requests are sent to `upstream + /v1/messages` (etc.) for this account only.
- **`modelMap`** — when a Claude model name arrives in the request body, it is rewritten to the mapped name before forwarding.

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

### `accounts[].models` is deprecated

The older per-account `models` list still works, but use a [route](routing.md#model-routes) instead. Routes are more flexible (glob matching, multiple accounts, bucket override) and less surprising: a `models` list changes eligibility across the *whole fleet* — once any account claims a model, every account that doesn't claim it is skipped for that model. The server prints a deprecation notice at startup naming the route to replace it with, and the field may be removed in a future version.
