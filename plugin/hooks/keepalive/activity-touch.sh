#!/usr/bin/env bash
# UserPromptSubmit sync hook — keepalive v2 activity signal.
#
# Writes current epoch to ~/.tkr/keepalive/<sid>/activity and clears any
# existing fired-at marker so the watcher can fire fresh next idle
# window.
#
# Single-fire correctness (INV-024): the keepalive wake itself produces a
# continuation turn that re-enters UserPromptSubmit. If we treated that as
# genuine user activity we would reset the idle clock AND delete fired-at
# every cycle — re-arming the watcher forever (observed: 18–21 fires per
# overnight session instead of 1). So this hook must IGNORE the wake's own
# follow-up turn. Two independent guards, OR'd:
#   1. Content — the wake sentinel text ("INTENTIONAL keepalive wake")
#      appears in the UserPromptSubmit payload.
#   2. Recency — fired-at is present and younger than the re-arm grace
#      window (the wake continuation lands ~60s after the fire; a human
#      returning that soon after an auto-fire is vanishingly rare). This
#      is the payload-shape-independent backstop.
# Either guard → no-op: leave activity and fired-at untouched so the
# single-fire gate holds until a real prompt arrives.
#
# Must be cheap (< 50ms): runs synchronously on every user prompt.

set -u

# Buffer stdin ONCE — resolve-sid.sh also needs it, and we need it again
# for the content guard. After this, feed it to resolve-sid via herestring.
#
# Bounded read (CR-06 parity with the JS hooks' stdin-with-timeout): this
# is a sync UserPromptSubmit hook, so an unguarded `cat` on a stalled
# writer would wedge the user's prompt until the hook timeout. EOF, ~2s
# elapsed, or 64KB — whichever comes first; on the cut-offs we proceed
# with whatever arrived (the guards below tolerate partial/empty input).
INPUT=""
_chunk=""
_deadline=$((SECONDS + 2))
while :; do
  if IFS= read -r -t 1 _chunk; then
    INPUT="${INPUT}${_chunk}
"
  else
    _rc=$?
    # EOF's final unterminated line, or (bash >= 4) a timeout's partial.
    INPUT="${INPUT}${_chunk}"
    [ "$_rc" -le 128 ] && break                # EOF / read error
    [ "$SECONDS" -ge "$_deadline" ] && break   # stalled writer
  fi
  [ "${#INPUT}" -ge 65536 ] && break
done

# shellcheck source=./resolve-sid.sh
. "$(dirname "$0")/resolve-sid.sh" <<< "$INPUT"
SID="$KEEPALIVE_SID"

STATE_DIR="${TKR_STATE_DIR:-$HOME/.tkr}"
DIR="$STATE_DIR/keepalive/$SID"
mkdir -p "$DIR" 2>/dev/null || exit 0

# Project-scoped state (KEEP-006): watchers of OTHER sessions in this
# project key their cross-session idle/single-fire decisions on these
# files. Empty key → per-sid behavior only (safe fallback).
# shellcheck source=./resolve-project.sh
. "$(dirname "$0")/resolve-project.sh"
PROJ_KEY="$(tkr_keepalive_project_key "${KEEPALIVE_PAYLOAD_CWD:-$PWD}")"
PROJ_DIR=""
[ -n "$PROJ_KEY" ] && PROJ_DIR="$STATE_DIR/keepalive-projects/$PROJ_KEY"

# Guard 1 — content: this is the keepalive wake's own continuation turn.
case "$INPUT" in
  *"INTENTIONAL keepalive wake"*) exit 0 ;;
esac

# Guard 2 — recency: a fire happened moments ago, so this UserPromptSubmit
# is almost certainly that wake's follow-up, not a human.
REARM_GRACE_SEC="${TKR_KEEPALIVE_REARM_GRACE_SEC:-180}"
if [ -f "$DIR/fired-at" ]; then
  FIRED_AT="$(cat "$DIR/fired-at" 2>/dev/null || echo 0)"
  case "$FIRED_AT" in *[!0-9]*) FIRED_AT=0 ;; esac
  if [ "$FIRED_AT" -gt 0 ]; then
    NOW="$(date +%s)"
    if [ $((NOW - FIRED_AT)) -lt "$REARM_GRACE_SEC" ]; then
      exit 0
    fi
  fi
fi

# Guard 2b — cross-session recency (KEEP-006/HAND-004): a wake can land in
# a DIFFERENT session than the watcher that fired (observed 2026-08-02:
# fire under sid 5b545fe3, continuation in 137f11f6), so guard 2's per-sid
# fired-at never sees it. The project-level last-fired is the
# payload-shape-independent backstop for that cross-session continuation.
if [ -n "$PROJ_DIR" ] && [ -f "$PROJ_DIR/last-fired" ]; then
  PROJ_FIRED_AT="$(cat "$PROJ_DIR/last-fired" 2>/dev/null || echo 0)"
  case "$PROJ_FIRED_AT" in *[!0-9]*) PROJ_FIRED_AT=0 ;; esac
  if [ "$PROJ_FIRED_AT" -gt 0 ]; then
    NOW="$(date +%s)"
    if [ $((NOW - PROJ_FIRED_AT)) -lt "$REARM_GRACE_SEC" ]; then
      exit 0
    fi
  fi
fi

# Genuine user activity — record it and re-arm the watcher. The project
# copy resets the cross-session idle clock for every watcher in this
# project (KEEP-006); no fired-at-style deletion for the project file —
# readers compare timestamps (last-fired vs last-activity), never
# existence.
date +%s > "$DIR/activity" 2>/dev/null || true
rm -f "$DIR/fired-at" 2>/dev/null || true
if [ -n "$PROJ_DIR" ]; then
  mkdir -p "$PROJ_DIR" 2>/dev/null &&
    date +%s > "$PROJ_DIR/last-activity" 2>/dev/null || true
fi
exit 0
