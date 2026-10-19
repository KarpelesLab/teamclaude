#!/usr/bin/env bash
set -euo pipefail
export TEAMCLAUDE_CONFIG="${TEAMCLAUDE_CONFIG:-$HOME/.config/teamclaude.json}"
export TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS="${TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS:-600000}"
exec "${TEAMCLAUDE_NODE:-$HOME/.nvm/versions/node/v24.16.0/bin/node}" "$HOME/gh/teamclaude/src/index.js" server --auto-fallback --log-to "$HOME/.teamclaude"
