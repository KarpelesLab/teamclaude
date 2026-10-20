# Cursor subscription integration

## Ownership

CLIProxyAPI owns provider credentials, upstream transports and sessions, tool protocol translation, and provider quota parsing. TeamClaude owns downstream routing and fallback, client session records, and dashboard presentation. Do not create a second upstream session manager in TeamClaude.


## Per-account quota display

`usageDisplay` selects the dashboard presentation:

| Value | Display |
| --- | --- |
| `cursor` | Returned Cursor pools and billing periods |
| `antigravity` | Each returned model group and bucket, keeping families separate |
| `codex` | Actual returned windows only; no synthesized five-hour window |
| `session` | Legacy Claude session/weekly presentation |
| `balance` | API credit balance |
| `auto` | Use the declared quota source, otherwise existing balance/legacy behavior |

The display switch does not alter provider limits or grant routing admission. A missing or mismatched source displays unknown. Provider identifiers and reset times come from observations, not account names.

Example account fragments (credentials and upstream connection settings omitted):

```json
[
  { "name": "cursor-pro", "usageDisplay": "cursor" },
  { "name": "antigravity", "usageDisplay": "antigravity" },
  { "name": "codex-gpt56", "usageDisplay": "codex" }
]
```

Antigravity can return independent Gemini and Claude/GPT groups. Preserve `gemini-5h`, `gemini-weekly`, `3p-5h`, and `3p-weekly` independently when present. Absence of a group does not mean unused quota. A credits probe cannot substitute for this model-family quota summary. The canonical `antigravity-subscription` source gates each request by its mapped upstream model family. Migration from old probes and live pool verification remain release requirements.

## Release gate

The primary live target is Cursor Grok 4.7. The required order is real-machine acceptance, commit, push, PR, merge, then deployment. Cursor is selectively ported into the existing CLIProxyAPI fork; no standalone Plus deployment.


## Subscription quota source

Cursor sources consume the authenticated CLIProxyAPI management endpoint. TeamClaude does not read their provider credentials.

```json
{
  "usageDisplay": "cursor",
  "quotaSource": {
    "type": "cursor-subscription",
    "baseUrl": "http://127.0.0.1:8320",
    "apiKeyFile": "/absolute/private/management-key",
    "authIndex": "index-from-proxy-auth-list",
    "maxAgeMs": 90000
  }
}
```


## Antigravity model families

Use `type: antigravity-subscription` with the same proxy management connection
fields shown above. Each `authIndex` selects one credential; an observation for
one credential is not an aggregate of all pooled Gemini Pro subscriptions.
CLIProxyAPI reports `gemini` and `3p` (the provider's Claude/GPT group), each with
independent `5h` and `weekly` windows. TeamClaude displays all returned windows.

Admission uses `modelMap` first, then recognizes `gemini-` and `claude-` model
names, optionally prefixed with `antigravity/`. Custom aliases can declare
`quotaSource.modelFamilies`, for example `{ "custom-model": "3p" }`. An account
reserved for one family can set `quotaSource.family` to `gemini` or `3p`.
These are routing selectors; they do not alter provider limits.

Each concrete request needs both current windows for its family. Missing,
stale, duplicate, malformed or elapsed windows do not grant admission. A valid
partial observation remains visible. An exhausted Claude family does not block
Gemini when Gemini has independently verified available quota. Credential
selection in the upstream pool must match the observed credential before rollout.

## Client session ownership

Claude Code's stable session ID is the primary conversation identity. TeamClaude
records client sessions and request usage in its existing dashboard. CLIProxyAPI
owns Cursor transport and tool translation. Cursor continuation uses the client
transcript; it does not require a separate gateway transcript database.

## Codex canonical windows

Use `type: codex-subscription` with the same authenticated proxy connection
fields. The proxy reads its own Codex credential and preserves actual window
durations and provider admission flags. A weekly-only response produces one
weekly window. Missing utilization or invalid reset data stays unknown; no
five-hour window or burn-rate cap is synthesized. Applying a canonical snapshot
clears obsolete Claude-shaped probe windows so they cannot gate the account.

Antigravity quota observations use the selected credential's project. Preserve
provider `disabled` flags: when weekly quota is exhausted the provider may mark
the five-hour window inactive. That is not an independently available pool.
Per-model catalog quotaInfo cannot replace missing five-hour/weekly group data.


## Verification limits

The installed Claude Code client has passed Cursor text, tool and resume checks.
Imported access-token-only credentials do not demonstrate live token refresh;
authentication expiry and refresh failures are covered by deterministic tests.
Quota counters are provider aggregates and may include concurrent use. Dashboard
request tokens are observed response usage, not an independent billing ledger.
Keep management authentication local and its key file private.
