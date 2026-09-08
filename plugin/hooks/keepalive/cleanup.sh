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

# Observability for Claude Code's SessionEnd cancellation budget (docs:
# SessionEnd hooks of any type share a 1.5s budget, raised only up to a
# configured `timeout`, capped at 60s). A marker is written the moment
# real work starts and removed right after; one left behind means this
# invocation was killed mid-flight. Mirrors hookutil.MarkHookStart/
# MarkHookDone (internal/hooks/hookutil/hookhealth.go) — same directory,
# same {"name":...} shape, no session id (keeps this best-effort and
# avoids a second stdin read).
#
# Builtins only for the marker itself ($$, $RANDOM, printf — no date, no
# mkdir): hooks/bench/fork-budget.test.js caps this hook at 5 external
# commands (INV-085 — each spawn costs 4-6s under loaded-Windows spawn
# degradation), and this hook is already close to that ceiling from
# resolve-sid.sh's python resolution. No mkdir means a hookhealth/ dir
# that doesn't exist yet silently drops the marker — acceptable for a
# best-effort signal, and team-push/session-summary (the Go SessionEnd
# hooks, same SessionEnd batch) already create it via os.MkdirAll in the
# overwhelmingly common case.
STATE_DIR="${TKR_STATE_DIR:-$HOME/.tkr}"
HEALTH_DIR="$STATE_DIR/hookhealth"
MARKER="$HEALTH_DIR/cleanup-$$-$RANDOM.json"
# `[ -d ]` is a builtin test (no fork) — guards the write so a missing
# hookhealth/ dir degrades silently instead of a redirection error on
# stderr (a failed `>` target aborts the command before its own
# `2>/dev/null` redirection is even established).
[ -d "$HEALTH_DIR" ] && printf '{"name":"cleanup"}' > "$MARKER" 2>/dev/null

DIR="$STATE_DIR/keepalive/$SID"
# One rm covering both paths — rm -rf tolerates a nonexistent MARKER or
# DIR silently, so this is the same single spawn whether or not either
# exists, rather than a second conditional rm.
rm -rf "$DIR" "$MARKER" 2>/dev/null || true
exit 0
