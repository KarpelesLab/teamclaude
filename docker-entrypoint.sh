#!/bin/sh
set -e

if [ -z "$TEAMCLAUDE_SPLIT_STDERR" ]; then
    exec 2>&1
fi

log() {
    echo "[teamclaude] $*"
}

DEFAULT_UID=1000
DEFAULT_GID=1000
CONFIG="${TEAMCLAUDE_CONFIG:-/data/teamclaude.json}"

if [ "$(id -u)" != "0" ]; then
    exec "$@"
fi

if [ -n "$TEAMCLAUDE_UID" ]; then
    TARGET_UID="$TEAMCLAUDE_UID"
    TARGET_GID="${TEAMCLAUDE_GID:-$TEAMCLAUDE_UID}"
elif [ -e "$CONFIG" ]; then
    TARGET_UID="$(stat -c %u "$CONFIG")"
    TARGET_GID="$(stat -c %g "$CONFIG")"
elif [ -d /data ] && [ "$(stat -c %u /data)" != "0" ]; then
    TARGET_UID="$(stat -c %u /data)"
    TARGET_GID="$(stat -c %g /data)"
else
    TARGET_UID="$DEFAULT_UID"
    TARGET_GID="$DEFAULT_GID"
fi

if [ "$TARGET_UID" = "0" ]; then
    log "warning: running as root"
    exec /sbin/tini -- "$@"
fi

if [ ! -d /data ]; then
    mkdir -p /data
fi
if [ "$(stat -c %u /data)" != "$TARGET_UID" ]; then
    chown "$TARGET_UID:$TARGET_GID" /data 2>/dev/null \
        || log "warning: could not chown /data; relying on mount ownership"
fi

if [ "$TARGET_UID" = "$DEFAULT_UID" ]; then
    RUN_AS="node"
else
    RUN_AS="$TARGET_UID:$TARGET_GID"
fi

export HOME=/data

log "starting as uid=$TARGET_UID gid=$TARGET_GID home=$HOME config=$CONFIG"

exec su-exec "$RUN_AS" /sbin/tini -- "$@"
