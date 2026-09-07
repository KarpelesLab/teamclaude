# Proxy reliability and incident checks

## Check the correct layer

Use `teamclaude status --json` or authenticated `GET /teamclaude/status`.
`/status` is an upstream request, not a health endpoint. A quick local status
response does not establish upstream API health. Separate connection refusal,
event-loop stalls, upstream headers waits, body stalls, and quota retry holds.

On macOS, keep the LaunchAgent `ProcessType` set to `Interactive`. Verify the
effective policy with `launchctl print gui/$(id -u)/com.karpeleslab.teamclaude`.
Changing source does not update an installed plist. Use `teamclaude service
install` during an approved restart window and verify the running service.

Before restarting a stalled service, capture status timings, process CPU time
and uptime, host memory pressure, effective launchd policy, and the service log
(`~/Library/Logs/teamclaude.log`). Avoid recording request bodies or credentials.
The event-loop watchdog can report a stall only after the event loop resumes;
external status checks remain necessary to detect a continuously wedged process.

## Limits

All values below are environment variables read by the service process. Exporting
them in a separate shell does not reconfigure an already-running LaunchAgent.
Changing limits requires an intentional restart and verification. Use positive
integers for these settings, except queue length may be zero.

| Variable | Default | Scope |
| --- | --- | --- |
| `TEAMCLAUDE_INGRESS_CONCURRENCY` | off | Opt-in shared HTTP/MITM request-body ingestion slots. A positive value enables admission. |
| `TEAMCLAUDE_INGRESS_QUEUE` | 64 | Maximum waiting ingestion requests; zero rejects instead of queuing. |
| `TEAMCLAUDE_INGRESS_QUEUE_TIMEOUT_MS` | 5000 | Absolute maximum ingestion-queue wait. |
| `TEAMCLAUDE_REQUEST_BODY_MAX_BYTES` | 33554432 | Maximum buffered request body, also when ingestion admission is off. |
| `TEAMCLAUDE_REQUEST_BODY_TIMEOUT_MS` | 120000 | Absolute upload deadline after admission; trickled bytes do not renew it. |
| `TEAMCLAUDE_UPSTREAM_MAX_SOCKETS` | 256 | Per-origin upstream concurrency. Long-lived response bodies retain their slots. |
| `TEAMCLAUDE_UPSTREAM_MAX_QUEUE` | 64 | Maximum waiting upstream requests per origin; zero rejects instead of queuing. |
| `TEAMCLAUDE_UPSTREAM_QUEUE_TIMEOUT_MS` | 5000 | Upstream admission deadline, separate from the headers deadline. |
| `TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS` | 120000 | Deadline after upstream admission until response headers. |
| `TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS` | 120000 | Inactivity deadline for SSE reads and buffered response reads. |
| `TEAMCLAUDE_RESPONSE_BODY_MAX_BYTES` | 33554432 | Maximum buffered non-streaming response. |

Queue overflow/expiry returns 503 with `Retry-After: 1`; oversized request bodies
return 413; upload expiry returns 408. These local failures do not establish bad
account credentials. Local upstream saturation must not cause account rotation.
An incomplete response is terminated, not reported as a successful complete body.

`status --json` includes `ingress` occupancy (or `enabled: false`), `upstreamPool`
aggregate occupancy, and `server.eventLoop` when the headless service installs
its watchdog. Upstream queue slots are acquired before creating Node requests;
cancelled/expired waiters are removed instead of waiting in Node's agent queue.
Disconnects also cancel upstream work and quota-hold timers.

The upstream cap covers the Node HTTP transport, including tunneled requests.
The legacy `TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH` escape hatch bypasses that cap.
OAuth/Remote Control, attachments, forward-proxy traffic and WebSockets have
separate relay paths; the buffered ingestion limits are not universal limits
for every endpoint. The ingestion gate does not cap total retained retry bodies
or total concurrent sessions. These are not a global process-memory guarantee.

## Regression and rollout checks

Run `npm test` and `npm run lint`. Targeted reliability tests:

```sh
node --test test/admission-gate.test.js test/ingress-safety.test.js \
  test/upstream-pool.test.js test/upstream-timeout.test.js \
  test/account-uuid-rewrite.test.js
```

Coverage includes FIFO/overflow, queue expiry/cancellation, slow and oversized
uploads, exactly-once activity cleanup, HTTP/2 stream isolation, repeated 1 MiB
bursts with concurrent status calls, cancellation before headers/during silent
streams/during quota holds, bounded buffered responses, and metadata rewrite
scope. The long-stream regression verifies twelve streams can start without
waiting for another to end; eight sockets is not a suitable default for that
workload. Existing fairness yields remain, but their optimal batch size is not
established by these tests.

Before deploying: record the current executable, commit, service configuration
and rollback target; run an isolated load test, then schedule an approved service
restart. Verify correct status, effective scheduling, queue recovery and actual
API first-byte/streaming behavior with representative concurrent sessions. Keep
the ingestion gate opt-in pending sustained production-like testing. Do not
infer permanent health from a restart, passing unit tests, or a short live check.

The pre-merge isolated soak ran for 60 seconds with 12 concurrent clients,
one-MiB requests and three pinned synthetic accounts. One account began returning
429s after 20 seconds. All 1,608 activity entries closed, both unaffected accounts
completed 536 requests, and all 585 status probes succeeded (p95 5.92 ms); the
event-loop monitor recorded zero stalls. The throttled account returned four
429s and had 204 requests cancelled during its existing per-account pause.
Post-GC heap was approximately 11–12 MiB; sampled RSS peaked near 311 MiB for the
combined proxy, fake upstream and load generator. This is a short synthetic
memory sample, not a process-memory limit or proof against long-term leaks.

For broader rollout, continue multi-hour real-workload observation and establish
operational alert thresholds. Pinned synthetic-account progress does not validate
adaptive routing fairness, which belongs to the separate adaptive-routing work.
A generic circuit breaker must not classify local overload or an account-specific
quota failure as a fleet-wide outage.
