# Proxy modes

Two independent things, both about how the traffic physically travels: how `claude` reaches TeamClaude, and how TeamClaude reaches Anthropic.

## MITM proxy mode (default)

The plain reverse-proxy only intercepts what `ANTHROPIC_BASE_URL` covers. Some Claude Code features (e.g. the **Claude Design MCP**) use a **hardcoded** `https://api.anthropic.com` URL that ignores that variable, so they bypass the proxy. MITM proxy mode captures those too, which is why it's the default for `teamclaude run` (and the shell alias):

```bash
teamclaude run -- <claude args...>
```

To opt out and route via `ANTHROPIC_BASE_URL` only, pass `--no-mitm`:

```bash
teamclaude run --no-mitm -- <claude args...>
```

MITM mode launches claude pointed at TeamClaude as an **HTTPS forward proxy** (`HTTPS_PROXY`) and trusts a locally-generated CA (`NODE_EXTRA_CA_CERTS`). For an intercepted host, TeamClaude **terminates** the tunnel with a real HTTP/2 server (HTTP/1.1 clients are handled too) presenting its local leaf, then **forwards each request with a buffering, retrying client** — the same path the base URL mode uses. On each request it:

- injects the active account's real credential, dropping any client `x-api-key`: OAuth accounts get `authorization: Bearer …`, API-key accounts get `x-api-key`;
- rewrites the **`account_uuid`** inside `metadata.user_id` to the active account's UUID (so the body agrees with the injected token);
- routes by the request's **`model`** (a Fable-exhausted account is skipped for Fable but still serves other models);
- reads `anthropic-ratelimit-*` from responses for quota; and
- **resends the request on a different account** if one returns a quota `429`, so a "you've reached your limit" is never surfaced while another account has headroom.

Because the request is buffered, the retry is transparent to claude. Client token refreshes (`/v1/oauth/token`), Remote Control (`/v1/code/*`) and claude.ai attachment transfers (`/api/oauth/files/*`, `/api/oauth/file_upload`) are passed through with the client's own credential, since they are bound to the paired identity and would 403 under a rotated token. Any host other than the upstream is blind-tunnelled. The server accepts *both* base-URL and proxy clients at once, so instances launched with and without `--no-mitm` can share one server.

### Trust model

- The CA is generated locally, stored in the config dir, and trusted **only** by the claude process you launch via `teamclaude run` (through `NODE_EXTRA_CA_CERTS`) — it is **never** added to your system trust store. The leaf private key is `0600`; the CA private key is never written to disk.
- TeamClaude still verifies the **real** Anthropic certificate on the upstream leg.

Verify the proxy and CA without any credentials — the proxy always answers a built-in test host:

```bash
# (with the server running and certs generated, e.g. after one `teamclaude run`)
curl --proxy http://localhost:3456 --cacert ~/.config/teamclaude-ca.pem https://www.example.org/
# → {"teamclaude":"mitm-proxy-ok","host":"www.example.org",...}
```

## Upstream proxy

For a host that has **no direct route to the internet** — the corporate case, where
every outbound connection must go through an HTTP proxy. Without it TeamClaude
fails with `connect ETIMEDOUT` on the first upstream request, even though Claude
Code itself works ([#155](https://github.com/KarpelesLab/teamclaude/issues/155)).

```json
{ "upstreamProxy": "http://user:pass@proxy.corp.example:3128" }
```

A bare `"proxy.corp.example:3128"` works too. Set it live from the TUI settings
screen (**Network → Upstream proxy**) — it applies to the next request, without a
restart.

- Covers **all** Anthropic-bound traffic: request forwarding, OAuth login, token
  refresh, profile and usage lookups. A proxy that covered only some of them
  would leave you able to refresh an account but not add one, or the reverse.
- `HTTPS_PROXY` / `ALL_PROXY` are picked up automatically when the config sets
  nothing, so a machine already configured for other tools needs no extra setup.
  When that happens the server says so on startup, and the TUI marks the row with
  where the value came from — a proxy nobody typed into the config should never be
  silently in force.
- `NO_PROXY` (or `noProxy`) exempts hosts by suffix; `"upstreamProxy": false`
  ignores the environment entirely.
- **A proxy that is this server is refused.** `teamclaude env` exports
  `HTTPS_PROXY` pointing at TeamClaude, so a server or CLI started from that
  shell would inherit itself as its egress proxy — every upstream call would
  re-enter the proxy and be answered for whichever account it selected, silently
  (a usage probe would then store that one account's quota under all of them).
  A value whose address is our own listener is dropped, whether it came from the
  environment or the config, and the startup line and the TUI row say so.
- **TLS stays end-to-end.** The tunnel is a plain `CONNECT`; the proxy sees
  ciphertext only, and certificate verification is unchanged. A proxy that
  intercepts TLS needs its CA in `NODE_EXTRA_CA_CERTS`.
- SOCKS proxies are not supported — only HTTP `CONNECT`. A `socks5://` value is
  rejected at startup rather than failing later at connect time.

This is a property of the **network**, not a routing policy: when set, it is
simply how this machine reaches Anthropic. That is what separates it from sx.org
below, which is a specific egress *provider* chosen per request. If both are
configured, a request routed via sx.org uses sx.org; everything else uses the
upstream proxy. Neither is related to `proxy.port`, which is the local port
Claude Code connects **to**.

## sx.org proxy mode

Off by default. Some transient `429`s key on the proxy's **outbound IP**, not the account, so rotating accounts doesn't help. To work around them, TeamClaude can route upstream requests through a residential proxy from [sx.org](https://sx.org), giving a different egress IP.

Open the TUI, press **`g`** for the settings screen, and put your sx.org API key in the **sx.org API key** row (stored in `config.sx.apiKey`). TeamClaude reuses an existing active proxy port on your sx.org account, or auto-creates a residential US one, and dials the upstream through it via HTTP `CONNECT` on **both** the reverse-proxy and MITM paths.

The **sx.org mode** row cycles with `←`/`→`:

| Mode | Behavior |
| --- | --- |
| always | Tunnel **every** upstream request through sx.org. |
| on 429 only | Connect directly; on a `429` (which is IP-based), immediately retry that request through sx.org's fresh egress IP, no wait. On the MITM path, a recent `429` routes new tunnels through sx.org for a short window. |
| off | Never use sx.org, but **keep the API key** so you can re-enable it instantly. |

TLS is established **end-to-end with `api.anthropic.com` over the tunnel**, so the sx.org proxy only ever relays ciphertext and the real Anthropic certificate is still verified. Mode and key changes apply live (no restart). A **Clear sx.org key** row appears once a key is set, to forget it entirely.

> **Cost:** in **always** mode *all* Claude traffic flows through the residential proxy, which sx.org meters by bandwidth — expect real per-GB cost. **on 429 only** uses the proxy just when you're actually being throttled, so it's the cheaper way to ride out rate limits.
