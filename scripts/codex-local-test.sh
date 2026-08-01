#!/usr/bin/env bash
# Set up an isolated local test of the codex-protocol fork.
#
# Everything lives in its own config on its own port, so an already-installed
# teamclaude and your real ~/.config/teamclaude.json are left alone.
#
#   ./scripts/codex-local-test.sh setup    # import codex account + write config
#   ./scripts/codex-local-test.sh server   # run the proxy (foreground)
#   ./scripts/codex-local-test.sh ask      # one-shot curl through the proxy
#   ./scripts/codex-local-test.sh claude   # run Claude Code through the proxy
#   ./scripts/codex-local-test.sh status   # accounts + quota
#   ./scripts/codex-local-test.sh model    # show model ids seen in the logs
#   ./scripts/codex-local-test.sh clean    # remove the test config + logs
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TEAMCLAUDE_CONFIG="${TEAMCLAUDE_CONFIG:-$HOME/.config/teamclaude-codex-test.json}"
LOG_DIR="${TC_TEST_LOGS:-/tmp/teamclaude-codex-logs}"
PORT="${TC_TEST_PORT:-3499}"
TC="node $REPO/src/index.js"

case "${1:-}" in
setup)
  $TC import --codex
  # modelMap is EXACT-match on the model string in the request body, and Claude
  # Code may append a [1m] context suffix, so both spellings are mapped. Add any
  # id you see via the `model` subcommand.
  python3 - "$TEAMCLAUDE_CONFIG" "$PORT" <<'PY'
import json, sys
path, port = sys.argv[1], int(sys.argv[2])
cfg = json.load(open(path))
cfg['proxy']['port'] = port
base = {
    'claude-fable-5':  'gpt-5.6-sol',
    'claude-opus-5':   'gpt-5.6-sol',
    'claude-sonnet-5': 'gpt-5.6-sol',
}
model_map = {}
for k, v in base.items():
    model_map[k] = v
    model_map[f'{k}[1m]'] = v
for a in cfg['accounts']:
    if a.get('protocol') == 'codex':
        a['modelMap'] = model_map
json.dump(cfg, open(path, 'w'), indent=2)
print(f"\nconfig : {path}")
print(f"port   : {port}")
print("mapped : " + ", ".join(sorted(model_map)))
PY
  echo
  echo "Everything maps to gpt-5.6-sol — the only codex model id confirmed to exist."
  echo "Next: $0 server   (then, in another shell, $0 ask)"
  ;;

server)
  mkdir -p "$LOG_DIR"
  echo "config $TEAMCLAUDE_CONFIG"
  echo "logs   $LOG_DIR"
  exec $TC server --log-to "$LOG_DIR"
  ;;

ask)
  shift || true
  PROMPT="${*:-What is 17 times 23? Just the number.}"
  curl -sS -N --max-time 90 "http://127.0.0.1:$PORT/v1/messages" \
    -H 'content-type: application/json' \
    -d "$(python3 -c '
import json,sys
print(json.dumps({
  "model": "claude-fable-5", "max_tokens": 400, "stream": True,
  "messages": [{"role": "user", "content": sys.argv[1]}],
}))' "$PROMPT")" |
    grep -oE '"text":"[^"]*"' | sed 's/^"text":"//; s/"$//' | tr -d '\n'
  echo
  ;;

claude)
  shift || true
  # Requires the server to be running (see `server`). Routes via the MITM
  # forward proxy so even hardcoded api.anthropic.com endpoints are intercepted.
  exec $TC run "$@"
  ;;

status)
  $TC accounts
  echo
  $TC status --json 2>/dev/null |
    python3 -c '
import json,sys,datetime
d=json.load(sys.stdin)
for a in d.get("accounts", []):
    q=a.get("quota",{})
    r=q.get("unified7dReset")
    when=datetime.datetime.fromtimestamp(r/1000, datetime.UTC).isoformat() if r else "unknown"
    u=q.get("unified7d")
    print(f'\''{a["name"]}: weekly {"unknown" if u is None else f"{u*100:.1f}% used"}, resets {when}'\'')
'
  ;;

model)
  # The exact model string Claude Code sent, which is what modelMap must key on.
  if ! ls "$LOG_DIR"/*.log >/dev/null 2>&1; then
    echo "No request logs yet in $LOG_DIR — run the server with '$0 server' and send a request."
    exit 1
  fi
  grep -ho '"model": *"[^"]*"' "$LOG_DIR"/*.log | sort -u
  ;;

clean)
  rm -f "$TEAMCLAUDE_CONFIG"
  rm -rf "$LOG_DIR"
  echo "removed $TEAMCLAUDE_CONFIG and $LOG_DIR"
  ;;

*)
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
