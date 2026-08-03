#!/usr/bin/env bash
# SessionEnd sync hook — keepalive v2 state cleanup.
#
# Removes ~/.tkr/keepalive/<sid>/ to prevent state accumulation across
# sessions. Best-effort; failures are silent (state will be reaped
# eventually by `tkr keepalive prune-state`).

set -u

# shellcheck source=./resolve-sid.sh
. "$(dirname "$0")/resolve-sid.sh"
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
