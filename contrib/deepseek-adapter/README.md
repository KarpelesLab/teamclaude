# deepseek-adapter (optional)

A loopback Anthropic-to-Anthropic shim for DeepSeek, used as a custom
`upstream` for a TeamClaude `apikey` account. It holds the real DeepSeek key
(read once from a 0600 file, never logged) and injects it at egress, so
`teamclaude.json` only carries a non-secret local placeholder.

Not part of the npm package; copy it where you run services, e.g.
`~/.local/bin/deepseek-adapter`, and start it with `--port 8085`.

## Thread requests are refused on purpose

DeepSeek ignores the Anthropic `thread` field. A thread continuation from
Claude Code can omit `tools`, `system` and earlier messages, so DeepSeek then
answers tool calls as plain text (DSML) instead of `tool_use` blocks. Removing
`thread` cannot bring back the omitted fields, so the adapter rejects any
request that carries `thread` with:

    HTTP 400  invalid_request_error
    details.error_code = "thread_unsupported_request"

The client then resends the complete stateless request. The check runs after
model validation and before any change to the request or any upstream call.
Native Anthropic accounts are untouched; thread support there is unchanged.

## Tests

No network or real credentials are used:

    python3 -I contrib/deepseek-adapter/tests/test_threads.py -v
