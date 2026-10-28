# OTLP trace export

TeamClaude can send one trace per model request to an OpenTelemetry collector over OTLP/HTTP
(JSON). It is off by default. When it is on, each request is one span, each upstream attempt is a
child span, and the request's final token usage is a single record on the request span. The export
is built on Node's built-in `fetch`, with no runtime dependencies.

Use it to correlate what the proxy did with what a downstream system saw: which account served a
request, how many attempts a failover took, and what the final outcome was.

## Turning it on

Set the endpoint of a collector's OTLP/HTTP receiver, typically `http://127.0.0.1:4318`:

```json
"telemetry": {
  "otlp": {
    "endpoint": "http://127.0.0.1:4318",
    "headers": { "authorization": "Bearer <collector token>" }
  }
}
```

or in the environment, which takes precedence over the config value:

```sh
TEAMCLAUDE_OTLP_ENDPOINT=http://127.0.0.1:4318 teamclaude server
```

(`TEAMROUTER_OTLP_ENDPOINT` is accepted too, as for every proxy variable.)

The endpoint is the collector's base URL. Traces go to `<endpoint>/v1/traces`. An endpoint that
already ends in `/v1/traces` is used as it is. Only `http://` and `https://` URLs are accepted, and
a URL with a username or password is refused, with a one-line message that does not print the URL.
`telemetry.otlp.headers` is sent with every export and is never logged or shown in status.

## What the proxy reports

Only data-plane model routes are traced:

| Route | Telemetry route |
| --- | --- |
| `/v1/messages` | `anthropic.messages` |
| `/v1/responses` | `openai.responses` |
| `/backend-api/codex/responses` | `codex.responses` |

Other paths, including the control routes and the dashboard, produce no spans.

Resource attribute `service.name` is `teamclaude`. The instrumentation scope is `teamclaude.proxy`.

### Request span `teamclaude.request` (server span)

| Attribute | Meaning |
| --- | --- |
| `teamclaude.request.internal_id` | The proxy's request number. It is unique within one process run, not across restarts. |
| `teamclaude.request.caller_id` | The `x-request-id` value echoed to the client: the inbound value if it was valid, otherwise a generated one. It is exported as the caller sent it, so callers should send opaque ids. |
| `teamclaude.route`, `teamclaude.provider`, `teamclaude.model` | The API shape, the provider, and the model name. The model is exported only when it is a plain identifier. |
| `teamclaude.client` | The name of the `proxy.clientKeys` entry that authenticated the request, or `none`. |
| `http.request.method`, `http.response.status_code` | The request method and the final status the client received. |
| `teamclaude.outcome` | `completed` (answered), `failed` (no answer was delivered) or `abandoned` (the client left). |
| `teamclaude.attempts` | The number of upstream attempts, including failovers and retries. |
| `teamclaude.usage.input_tokens`, `.output_tokens`, `.cache_read_input_tokens`, `.cache_creation_input_tokens` | The usage record. Present only when upstream reported usage. |
| `teamclaude.usage.source` | `anthropic.messages.original` or `openai.responses.normalized`. |
| `teamclaude.usage.input_tokens_basis` | Always `uncached_input_excluding_cache_read_and_creation`. The categories do not overlap. |

The span's status is `ERROR` when the outcome is `failed`.

### Attempt span `teamclaude.attempt` (client span, child of the request)

| Attribute | Meaning |
| --- | --- |
| `teamclaude.attempt.number` | 1 for the first upstream send, then 2, 3 and so on. |
| `teamclaude.account` | The account's name. An account whose name contains `@` is exported as `sha256:` followed by 24 hex characters instead. |
| `http.response.status_code` | The upstream status, when upstream answered. |
| `teamclaude.attempt.error` | A short error code such as `ECONNREFUSED` or `timeout`, when no response arrived. |

The span covers the upstream request up to the response head. It is `ERROR` on a transport error or a
5xx status.

## At most one usage record per request

A request can make several upstream sends: a failover after a 429 or 5xx, a hop after a refusal
inside a 200 stream, or a retry. The proxy records usage in two places, and both of them run only
once a response is being delivered to the client:

- a buffered JSON answer, when it is relayed; and
- a streamed answer, when the relay finishes, including one that the client abandons.

An upstream stream that is refused inside its 200 is hopped before any of that runs, so it reports
no usage, and its sibling's stream is the one that reaches the client. The request keeps a single
usage slot, and each report replaces what is in it. The span is written once, when the request
finishes, and it carries the slot's contents. So a request has no usage record unless upstream
reported usage, and never more than one. A late or repeated `finish` is ignored.

## What is never exported

- Prompts, message content, request and response bodies, and SSE payloads.
- Request and response headers, except the status code.
- Authentication: the presented client key, the upstream credentials, `proxy.apiKey`, and the
  `telemetry.otlp.headers` values.
- Account emails. An account or client name containing `@` is hashed. The hash is a pseudonym,
  not a secret: anyone who can guess an address can confirm it.
- The `x-teamclaude-workload` header, and any other caller-supplied header.
- Span events, links, and free text.

The hash is a SHA-256 over a fixed domain prefix, truncated to 24 hex characters, so it is stable
across restarts but carries no key.

## Queueing, timeouts and drops

- At most 512 spans wait in memory. A span that arrives when the queue is full is dropped, and
  counted. Dropping the newest keeps the queue bounded without evicting anything already waiting.
- Spans go out in batches of up to 64, from a one-second timer that does not keep the process
  alive. A batch that reaches 64 spans is sent at once.
- Each export has a 1.2-second timeout. A batch that the collector refuses or does not answer in
  time is dropped and counted. The rest of that flush is dropped too, not retried, so a collector
  that is down costs one timeout per flush.
- Export never delays a request and never throws into the request path.
- On shutdown the queue gets at most 1.5 seconds to drain. Anything left is counted as dropped.

The queue lives in memory. Spans that have not been accepted by the collector are lost if the proxy
exits, so this is an observability channel, not a durable ledger.

## Status

The proxy status (`GET /teamclaude/status`) carries a `telemetry` object:

```json
"telemetry": { "enabled": true, "queued": 0, "exported": 412, "dropped": 0, "failures": 0, "lastError": null }
```

`lastError` is a short reason such as `HTTP 503`, `timeout` or `ECONNREFUSED`. It never carries
the endpoint, a header or a token. With export off, the object is `{ "enabled": false, ... }` with
zeros.

## Checking it against a local collector

To see exactly what leaves the proxy, run a receiver on your own machine that prints what it gets.
This one needs nothing but Node:

```sh
node -e "require('node:http').createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { console.log(q.url, b); s.end('{}'); }); }).listen(4318, '127.0.0.1')"
```

Then start the proxy with `TEAMCLAUDE_OTLP_ENDPOINT=http://127.0.0.1:4318`, send it one request,
and read the payload the receiver printed. An OpenTelemetry Collector with an OTLP/HTTP receiver on
port 4318 works the same way. Check `telemetry` in status to see whether the export was accepted.

The acceptance tests in `test/telemetry.test.js` run the same path against a local collector on an
ephemeral port, with no external network.

## Limits of what this shows

- Traces only. Token metrics and logs are not exported.
- Usage is what upstream reported. A stream that ends before upstream reports usage has none.
- Codex usage is normalized to the same uncached-input basis as Anthropic before it is exported,
  so the categories can be added across providers.
- The route names the API shape, not where the request came from.
