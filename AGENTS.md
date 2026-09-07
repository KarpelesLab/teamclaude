# Agent guidance

## Proxy reliability: preserve these findings

TeamClaude is operational infrastructure. Diagnose with live evidence before
changing scheduling, routing, timeouts, or concurrency. Preserve unrelated work
and do not restart the live service just to experiment without authorization.

### macOS service scheduling

- Keep the user-facing HTTP LaunchAgent's `ProcessType` set to `Interactive`
  in `src/service.js`. Do not change it to `Background` as a daemon convention.
  Background scheduling was demonstrated to starve this proxy under host
  resource pressure, causing local status timeouts and large event-loop lag.
- `Adaptive` launchd scheduling relies on XPC activity for promotion; ordinary
  HTTP clients do not provide that signal. This is unrelated to TeamClaude's
  adaptive account-routing mode.
- Preserve the service-rendering regression assertion in `test/service.test.js`.
  A source change alone does not update an installed LaunchAgent: deployment
  must regenerate its plist and reload the service, then verify the effective
  policy with `launchctl print gui/$(id -u)/com.karpeleslab.teamclaude`.

### Probe the correct layer

- Use `teamclaude status` or `GET /teamclaude/status` for local proxy status.
  **Do not use `/status`: it is forwarded upstream, not a local health check.**
  Respect configured authentication; never expose credentials in diagnostics.
- Separate connection refusal, local status timeout/event-loop lag, and upstream
  first-byte latency. They are different failure modes, not interchangeable
  evidence of an Anthropic outage.
- Upstream 429s and quota retry holds can delay API responses while local status
  remains healthy. An account's `active` credential state does not necessarily
  mean it is eligible for routing below the configured quota threshold.
- Before attributing a stall to JavaScript hot loops, inspect process CPU time
  alongside wall time, host memory pressure, effective service scheduling,
  event-loop metrics, and time-correlated logs. A sampled busy stack alone does
  not prove that the process is receiving enough CPU time.

### Verification and change discipline

- Capture evidence before a restart when possible. Restarts destroy the stalled
  state and transient recovery is not proof of a fix.
- Verify under concurrent traffic with repeated bounded status probes; report
  sample count, observation duration, latency distribution, failures, and
  event-loop stalls. Check API first-byte/streaming behavior separately.
- The scheduling fix passed a 60-probe live window with zero failures and zero
  event-loop stalls, but that is historical evidence, not an indefinite health
  guarantee. Do not claim all streaming failures are fixed from status alone.
- Do not treat longer timeouts, more memory, a runtime switch, or smaller socket
  pools as proven fixes without a controlled comparison. Socket limits can add
  queue latency to long-lived streams.
- The experimental ingress gate is disabled by default and explicitly enabled
  only by a positive `TEAMCLAUDE_INGRESS_CONCURRENCY`. Do not enable it by default
  until cancellation, queue-wait deadlines, body size/time bounds, permit
  cleanup, and overload/recovery behavior are covered by tests.
- For code changes, run targeted regression tests, `npm test`, `npm run lint`,
  and `git diff --check`. Distinguish tested source, committed/pushed code, and
  the version/configuration actually running in the installed service.

### Follow-up hardening

- Read `docs/reliability.md` for limit scope, defaults, diagnostics and rollout.
- Acquire bounded, cancellable upstream admission before constructing a Node
  ClientRequest. Destroying a request already waiting in the Agent queue can
  defer its error until socket assignment; a headers timer alone is insufficient.
- Keep upstream slots for the response-body lifetime; separate the queue wait
  deadline from the headers deadline. Never retry local saturation on another
  account. Disconnects must cancel queued work, silent reads and quota timers.
- Do not locate request metadata using an unscoped substring search. Nested
  metadata and differently escaped duplicate strings can fool a unique-match
  check. Preserve the regression cases in `test/account-uuid-rewrite.test.js`.
- Do not immediately destroy an h1 request with unread upload bytes after
  writing a rejection: the reset can hide the 413/503 from its caller. Teardown
  must be bounded, while h2 rejection must close only the affected stream.

### Privacy before publishing or merging

- Audit the final diff, every new commit's content, and the PR description for
  personal data and secrets before publishing or marking a PR ready. Removing
  data only from the final tree does not remove it from earlier commits.
- Keep real account emails/IDs, credentials, session identifiers, private local
  paths, request payloads and raw operational logs out of source, fixtures and
  PR text. Use clearly synthetic accounts and sanitized aggregate measurements.
- If sensitive data was already published, stop and report it without repeating
  the value. Coordinate credential revocation and history cleanup as appropriate;
  do not silently force-push or rewrite contributor attribution.
