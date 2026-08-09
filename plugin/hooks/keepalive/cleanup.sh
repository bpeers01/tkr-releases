#!/usr/bin/env bash
# SessionEnd sync hook — keepalive v2 state cleanup.
#
# Removes ~/.tkr/keepalive/<sid>/ to prevent state accumulation across
# sessions. Best-effort; failures are silent (state will be reaped
# eventually by `tkr keepalive prune-state`).

set -u

# A native caller (node spawnSync, Claude Code on Windows) invokes this as
# `bash C:\...\cleanup.sh` with no MSYS arg conversion, so $0 arrives
# backslashed and dirname yields "." — sourcing would then resolve against the
# caller's CWD and set -u would abort the hook.
SELF="${0//\\//}"
case "$SELF" in
  */*) SELF_DIR="${SELF%/*}" ;;
  *)   SELF_DIR="." ;;
esac

# shellcheck source=./resolve-sid.sh
. "$SELF_DIR/resolve-sid.sh"
SID="$KEEPALIVE_SID"

# The shared resolver returns "default" as a last-resort sentinel when
# env, stdin, and lockfile all fail. Don't blow away the shared default
# bucket on SessionEnd — other active sessions may be keying state
# there under the same fallback. A real SID is required to clean up.
[ "$SID" = "default" ] && exit 0

DIR="${TKR_STATE_DIR:-$HOME/.tkr}/keepalive/$SID"
if [ -d "$DIR" ]; then
  rm -rf "$DIR" 2>/dev/null || true
fi
exit 0
