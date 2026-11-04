# Client routes (fixed seats)

*IPM fork only (`meupatrocinio/teamclaude`). Upstream teamclaude does not have this feature.*

A client route gives a set of client keys (`proxy.clientKeys`) their own account, called a seat. A key
on a route is served by its seat's accounts only. Neither rotation nor a failover hop moves it to
another account. With `proxy.requireClientRoute` on, a key on no route gets no Anthropic inference.

Only Anthropic requests are routed this way. Codex and other providers keep their normal rotation.

## Config

```json
"clientRoutes": [
  { "name": "seat-7", "clients": ["pedro"], "accounts": ["seat-7@example.com"] },
  { "name": "seat-3", "clients": ["ana", "ana-ci"], "accounts": ["seat-3@example.com"] }
],
"proxy": { "requireClientRoute": true }
```

- `clients`: client key names, matched trimmed and case-insensitive.
- `accounts`: account names, resolved against the live account list on every request. Any form
  `/tc-acct/` accepts works. The name must match exactly one account. A name no account has, a
  name two accounts share, or a Codex subscription makes the route **unresolved**.
- A client listed on two routes is **ambiguous**. Neither route applies, and the key gets
  "seat unavailable".
- A route with several accounts is allowed. Its requests stay inside those accounts, and failover
  hops move only between them. The account list is a **drain queue in config order**: a
  conversation pins to the first account it starts on. Each account has a per-request quota policy,
  selected by the caller (`recommend` by default, or `force`). The source account's policy governs
  each move. Fresh conversations take the first servable account immediately, so the seat's quota
  drains one account at a time instead of spreading across all of them at once.

  - `recommend`: the first quota failure recommends `/ipm:handoff` and a fresh session, and warns
    that continuing the same conversation will reprocess its full context with a cold prompt cache.
    A later prompt in that same conversation confirms the switch once and re-pins there.
  - `force`: the first real quota failure immediately retries the identical request body on the
    first assigned account that can serve, preserving the conversation, and re-pins there. Every
    force hop is independently authorized by the account that just failed.

  If the destination also spends out, its own policy applies: a recommend destination offers and
  requires confirmation before moving again, while a force destination retries immediately. A
  single-account route has nowhere to move, so both modes retain the hard stop.

  `cg` sends the choices as `x-teamclaude-seat-policy: *=recommend,s1=recommend,s2=force`. The
  renderer emits route slugs and accounts in the same order, so `s1+s2` maps those slugs to the two
  resolved accounts by position. Missing entries mean recommend. Malformed entries, duplicates,
  foreign slugs, or slug/account-length mismatches disable force for the whole request. The header
  is a preference, never routing authority, and is stripped before the request reaches Anthropic.

`POST /teamclaude/reload` applies both keys with no restart, in the same step as `proxy.clientKeys`.
A request keeps the binding it read at admission for all its retries.

Client routes are separate from the model routes (`routes`). `teamclaude route`, the TUI, the MCP
tools and `getRoutes()` never see them.

## End-user identity upstream

Every Anthropic-path request that carries a client key is stamped with a stable per-user tag in
`metadata.user_id` (`gateway_user: "u_<sha256 of the key name, 16 hex>"`), on any pool — routes or
not. The key name is hashed because user_id must not carry PII, and the name — not the key — is
what survives a re-mint. Claude Code's own `device_id`, session id and `account_uuid` pass through
untouched, so upstream attributes per person and per machine rather than per seat; Anthropic's
abuse-detection guidance asks multi-user services for exactly this. Requests with no client key
(the shared admin key, key-less loopback) go unstamped, and Codex bodies carry no
`metadata.user_id` and are not stamped.

The stamp edits the body in place with a single-pass span finder and then **validates the result**:
the stamped document must parse as JSON and show the tag at the top level, or the original body is
sent untouched. A wrong span therefore skips the stamp; it can never corrupt a request. (The first
version of this feature shipped without the net and miscounted depth on multi-element arrays,
inserting `metadata` inside `system`/`messages` blocks — Anthropic's `messages.N.metadata: Extra
inputs are not permitted` of 2026-10-23. The regression fixtures live in `test/user-identity.test.js`.)

## What a request gets

The gate runs for every Anthropic request once any route exists or the switch is on. The same rules
apply to direct HTTP (`x-api-key`) and to MITM (`Proxy-Authorization` on the CONNECT).

| Caller | Answer |
|---|---|
| Key on a route | Served by its seat. The switch threshold does not apply: a seat is used until upstream says it is spent. |
| Key on a route, `/tc-acct/` or `TC_ACCT` pin to another account | 403 `permission_error` |
| Key on no route, switch on | 403 `permission_error` |
| Key on no route, switch off | Normal rotation over every account |
| Shared `proxy.apiKey` or key-less loopback, switch on, no pin | 403 `permission_error` |
| Shared `proxy.apiKey` or key-less loopback, with a `/tc-acct/`, `TC_ACCT` or session pin | Served by the pinned account, and logged with an unverified `x-tc-caller` hint (`console-probe`, `warmer`, else `operator`). The header is not forwarded upstream. |
| `GET /v1/models` | Never refused. A key on a route gets its seat; any other caller gets normal selection, and no session affinity is recorded. |

When the seat cannot serve, the answer always comes from the seat itself:

| Seat state | Answer |
|---|---|
| Spent: upstream sent a 429 rejecting a quota window, and that window's reset is still ahead | 429 with upstream's own `anthropic-ratelimit-unified-*` headers and `x-should-retry: false`. The 429 that reports the spend gets this answer at once. Later requests get it with nothing sent upstream. A `7d_oi` rejection covers Fable requests only. |
| Spent pinned account in a multi-account route, with a servable sibling | `recommend`: the first response is an actionable 429 handoff offer with `x-should-retry: false` and no unified headers, so Claude Code shows the handoff and cold-cache choices instead of its generic plan-limit banner. The next prompt confirms and switches once. `force`: the same request retries immediately on the sibling with its body unchanged. |
| Throttled (rate-limit hold) | 429 with `retry-after`. It stays retryable. |
| Operator budget cap (`maxUsage`, `maxSpend`) | 429 with `x-should-retry: false`. No unified headers are made up. |
| Disabled, in error, credential or routing failure, route unresolved or ambiguous | 503 with `x-should-retry: false` |

If the state is unknown (no reading yet, or a reset time already past), the request goes to the
seat, and upstream's answer is recorded for the next request. teamclaude never makes up a reset time.

A successful confirmed continuation adds `x-teamclaude-seat-failover` with the source, destination
and `cold-cache=true`. It does not alter the assistant's response body or SSE events. Upstream-supplied
copies of the internal policy/failover headers are discarded.

Force applies only to genuine quota rejection. Throttling, credential/entitlement failures, 5xx,
third-party 400s, stream failures, transport errors, operator caps, and token/routing failures never
move a pinned conversation to a sibling. Fresh, unpinned conversations keep their ordinary queue
advance behavior.

## Operator overrides

`POST /teamclaude/session-pin` (operator only, like `/teamclaude/switch`) moves one session onto a
named account. With client routes in force, the pin is **bound to a client key** and applies only to
requests from that key:

- `"client": "<key name>"` in the body names the key;
- with no `client`, the pin binds to the key the session was seen with. If the session id was seen
  with more than one key, the endpoint answers 409.

An override for a key is checked before that key's own pins. It can also serve a key that has no
seat. Another key sending the same session id goes through its own gate.

A client key cannot POST `/teamclaude/switch` (or `/teamclaude/session-pin`). Both are refused with
403.

## Status

`GET /teamclaude/status` always carries:

- `clientRoutes`: `[{ name, clients, accounts, resolved, problem? }]`, an empty list when none are
  configured;
- `requireClientRoute`: `true` or `false`;
- `caller.seat` for a client-key caller: `{ name, accounts, resolved, state, windows, resetsAt }`, or
  `null` when the key has no seat. The admin-key poll never carries it.

## Activity log

Every refusal and hard stop writes two lines:

```
Seat gate: client "uma" seat (none) → no-seat (403)
[uma] POST /v1/messages → (no seat) [no-seat] (403, 0.0s)
```

The reasons are `no-seat`, `foreign-pin`, `spent`, `throttled`, `capped`, `unavailable`,
`operator-unpinned`, `admin-pin` (an override that served) and `operator-pin` (a pinned operator
request). Each reason goes in the request line's single tag slot. A request served on its seat
keeps the `[pin]` tag.

## Turning it off

Set `proxy.requireClientRoute` to `false` and reload: keys with no seat rotate again. Set
`clientRoutes` to `[]` and reload: every key rotates. With neither key set, the build behaves like
upstream teamclaude.
