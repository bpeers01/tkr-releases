#!/usr/bin/env bash
# Stop async-rewake hook — keepalive v2 polling watcher.
#
# Runs via Claude Code's `asyncRewake: true, timeout: 3600` hook contract.
# Polls every 60s; if session idle ≥ TKR_KEEPALIVE_IDLE_MIN (default 55m),
# emits a fire event and exits 2, which causes Claude Code to deliver a
# system reminder to the model (refreshing prompt-cache TTL as a side
# effect).
#
# Single-fire-per-idle-window: a `fired-at` marker prevents respawned
# watchers from firing again until the next real UserPromptSubmit clears
# the marker (handled by the activity touch in user-prompt-submit.js —
# hooks/lib/keepalive-activity.js).
#
# INV-063 fire gate: a respawned watcher no longer just checks whether
# `fired-at` exists — it compares last-activity against last-fired
# (idle-decision.sh's keepalive_fire_gate). No real activity since the
# previous fire emits a `keepalive_suppressed` ledger event instead of
# silently exiting, so dead sessions don't accumulate unbounded wasted
# fires.
#
# No-op when `tkr keepalive check` says the account isn't eligible
# (not 1h-TTL).

set -u

# A native caller (node spawnSync, Claude Code on Windows) invokes this as
# `bash C:\...\watcher.sh` with no MSYS arg conversion, so $0 arrives
# backslashed and dirname yields "." — every source below would then resolve
# against the caller's CWD and set -u would abort the hook.
SELF="${0//\\//}"
case "$SELF" in
  */*) SELF_DIR="${SELF%/*}" ;;
  *)   SELF_DIR="." ;;
esac

# shellcheck source=./resolve-python.sh
. "$SELF_DIR/resolve-python.sh"
PYTHON_BIN="$(tkr_resolve_python)"

# Eligibility check — 1h-TTL accounts only. TKR_KEEPALIVE_SKIP_ELIGIBILITY=1
# bypasses the live `tkr keepalive check` shell-out — used by watcher.test.js
# to exercise the polling loop without a tkr binary or interpreter present.
if [ "${TKR_KEEPALIVE_SKIP_ELIGIBILITY:-}" != "1" ] && command -v tkr >/dev/null 2>&1; then
  ELIG_JSON="$(tkr keepalive check 2>/dev/null || echo '{}')"
  ELIG="$(printf '%s' "$ELIG_JSON" | "$PYTHON_BIN" -c '
import json, sys
try: print(json.load(sys.stdin).get("eligible", False))
except Exception: print("False")
' 2>/dev/null || echo "False")"
  if [ "$ELIG" != "True" ]; then
    exit 0
  fi
fi

# shellcheck source=./resolve-sid.sh
. "$SELF_DIR/resolve-sid.sh"
SID="$KEEPALIVE_SID"

# shellcheck source=./idle-decision.sh
. "$SELF_DIR/idle-decision.sh"

STATE_DIR="${TKR_STATE_DIR:-$HOME/.tkr}"
DIR="$STATE_DIR/keepalive/$SID"
mkdir -p "$DIR" 2>/dev/null || exit 0

# Project-scoped state (KEEP-006). Cross-session coordination: activity in
# ANY session of this project resets this watcher's idle clock, and a fire
# by ANY watcher in this project suppresses the others for that idle
# window. cwd comes from the CC Stop payload (resolve-sid's single stdin
# read), falling back to $PWD; empty key degrades to per-sid behavior.
# shellcheck source=./resolve-project.sh
. "$SELF_DIR/resolve-project.sh"
PROJ_KEY="$(tkr_keepalive_project_key "${KEEPALIVE_PAYLOAD_CWD:-$PWD}")"
PROJ_DIR=""
[ -n "$PROJ_KEY" ] && PROJ_DIR="$STATE_DIR/keepalive-projects/$PROJ_KEY"

# PID-lock, newest-watcher-wins (KEEP-005). Claude Code hard-kills an
# asyncRewake hook at spawn+3600s (TerminateProcess — the EXIT trap does
# not run), so the old yield-to-existing rule kept the OLDEST watcher —
# the one with the earliest kill clock — while idle restarts from the
# NEWEST activity. With a 55min threshold inside a 60min lifetime, any
# post-spawn activity (a late prompt, CC's away_summary bookkeeping)
# pushed fire-due past the kill and the session could never fire
# (observed 2026-08-02: kill 14:15:25, fire-due ~14:18). Take the lock
# unconditionally; the previous owner self-retires on its next tick.
# Multiple Stop events still converge to one watcher — just the newest.
LOCK="$DIR/watcher.pid"
echo $$ > "$LOCK"
trap '[ "$(cat "$LOCK" 2>/dev/null)" = "$$" ] && rm -f "$LOCK"' EXIT

LEDGER="$STATE_DIR/playbook-events.jsonl"

# Emit a keepalive_suppressed ledger row via heredoc-to-tmpfile (see the
# fire emit for why). Shared by the respawn gate (INV-063) and the
# project-level single-fire gate (KEEP-006).
emit_suppressed() {
  local idle="$1" reason="$2" nowz tmp
  mkdir -p "$STATE_DIR"
  nowz="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  tmp="$(mktemp)"
  cat > "$tmp" <<'PYSUPPRESS'
import json, os, sys
ledger, sid, nowz, idle, reason = sys.argv[1:6]
evt = {
    "at": nowz,
    "session_id": sid,
    "layer": "L2",
    "event": "keepalive_suppressed",
    "trigger_state": {
        "idle_seconds": int(idle),
        "trigger": "asyncRewake-watcher",
        "reason": reason,
    },
    "outcome": {"action": "async_rewake_suppressed"},
    "schema_version": 2,
}
os.makedirs(os.path.dirname(ledger), exist_ok=True)
with open(ledger, "a", encoding="utf-8") as f:
    f.write(json.dumps(evt, separators=(",", ":")) + "\n")
PYSUPPRESS
  "$PYTHON_BIN" "$tmp" "$LEDGER" "$SID" "$nowz" "$idle" "$reason" 2>/dev/null || true
  rm -f "$tmp"
}

# Fire gate (INV-063) — replaces the old blind "fired-at exists → exit"
# check. Compares last-activity against last-fired instead of merely
# checking marker existence, so a session with no real user activity since
# its previous fire is suppressed (with a ledger event) rather than left to
# silently accumulate more wasted fires. A session's first fire (no
# fired-at yet) is never suppressed. See idle-decision.sh's
# keepalive_fire_gate for the full rule.
# NOTE: the gate reads the raw UserPromptSubmit marker on purpose — see
# keepalive_effective_activity in idle-decision.sh for why transcript
# activity must NOT be mixed in here.
GATE_FIRED_AT="$(cat "$DIR/fired-at" 2>/dev/null || echo 0)"
GATE_ACTIVITY_AT="$(cat "$DIR/activity" 2>/dev/null || echo 0)"
GATE_DECISION="$(keepalive_fire_gate "$GATE_ACTIVITY_AT" "$GATE_FIRED_AT")"
if [ "$GATE_DECISION" = "SUPPRESS" ]; then
  GATE_NOW="$(date +%s)"
  case "$GATE_ACTIVITY_AT" in ''|*[!0-9]*) GATE_ACTIVITY_AT=0 ;; esac
  GATE_IDLE=0
  if [ "$GATE_ACTIVITY_AT" -gt 0 ]; then
    GATE_IDLE=$((GATE_NOW - GATE_ACTIVITY_AT))
  fi
  emit_suppressed "$GATE_IDLE" "no_activity_since_last_fire"
  exit 0
fi

# Polling loop.
IDLE_THRESHOLD_MIN="${TKR_KEEPALIVE_IDLE_MIN:-55}"
IDLE_THRESHOLD_SEC=$((IDLE_THRESHOLD_MIN * 60))
TICK_SEC="${TKR_KEEPALIVE_WATCHER_TICK:-60}"

# Session transcript — the honest activity signal (appended on every turn
# and tool result), used alongside the UserPromptSubmit marker so a long
# agentic turn is not mistaken for an idle session. Resolved once by SID;
# TKR_KEEPALIVE_TRANSCRIPT overrides for tests. Empty when not found, in
# which case behaviour falls back to the marker alone (pre-fix semantics).
TRANSCRIPT="${TKR_KEEPALIVE_TRANSCRIPT:-}"
if [ -z "$TRANSCRIPT" ] && [ -n "${SID:-}" ]; then
  for _cand in "$HOME/.claude/projects/"*/"$SID.jsonl"; do
    [ -f "$_cand" ] && TRANSCRIPT="$_cand" && break
  done
fi

# Portable mtime — GNU stat, then BSD stat, then Python. Echoes 0 on any
# failure so a missing transcript degrades to marker-only idle.
transcript_mtime() {
  [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || { echo 0; return 0; }
  stat -c %Y "$TRANSCRIPT" 2>/dev/null && return 0
  stat -f %m "$TRANSCRIPT" 2>/dev/null && return 0
  "$PYTHON_BIN" -c 'import os,sys; print(int(os.path.getmtime(sys.argv[1])))' \
    "$TRANSCRIPT" 2>/dev/null || echo 0
}

# Last REAL turn row (user/assistant) in the transcript tail — KEEP-005.
# File mtime over-counts: CC appends bookkeeping rows minutes after idle
# (away_summary at Stop+~3min observed), which pushed fire-due past the
# 3600s hook lifetime. Python failure falls back to mtime — over-counting
# activity WAITs, the safe direction (never fires mid-task).
transcript_activity() {
  [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || { echo 0; return 0; }
  local out
  out="$("$PYTHON_BIN" "$SELF_DIR/transcript-activity.py" "$TRANSCRIPT" 2>/dev/null || echo "")"
  case "$out" in
    ''|*[!0-9]*) transcript_mtime ;;
    *) echo "$out" ;;
  esac
}

# Issue #152 item 1: is an AskUserQuestion/ExitPlanMode outstanding with no
# answer yet? A pending interactive prompt appends no transcript rows, so
# it is otherwise indistinguishable from an abandoned session. Detection
# failure (no transcript, python error, garbage output) reads as "0" —
# not-pending, i.e. fall back to pre-#152 behavior — rather than "1", so a
# broken detector cannot permanently wedge the watcher into never firing.
transcript_pending() {
  [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || { echo 0; return 0; }
  local out
  out="$("$PYTHON_BIN" "$SELF_DIR/transcript-activity.py" "$TRANSCRIPT" pending 2>/dev/null || echo "")"
  case "$out" in
    1) echo 1 ;;
    *) echo 0 ;;
  esac
}

# Best-effort parent-alive watchdog: if the Claude Code parent process
# dies (crash / OS shutdown), don't keep polling indefinitely. Resolved
# lazily — we read $PPID at start and re-check each tick.
#
# PPID=1 means we were spawned detached and reparented to init (this is
# the normal asyncRewake path on Windows + Linux). Skip the watchdog in
# that case — there's no real parent to watch for, and `kill -0 1` would
# fail and falsely trip the "parent dead" exit on the first iteration.
PARENT_PID="${PPID:-0}"

while true; do
  if [ "$PARENT_PID" -gt 1 ] 2>/dev/null && ! kill -0 "$PARENT_PID" 2>/dev/null; then
    exit 0
  fi

  # KEEP-005: self-retire when a newer watcher took the lock (or the
  # session's state dir was cleaned up). The guarded EXIT trap leaves
  # the new owner's lock untouched.
  if [ "$(cat "$LOCK" 2>/dev/null)" != "$$" ]; then
    exit 0
  fi

  # Idle is measured against the LATER of the UserPromptSubmit marker and
  # the transcript's last REAL turn row (user/assistant — turns and tool
  # results), so an agentic turn with no user prompt is not mistaken for
  # an abandoned session, while CC's post-idle bookkeeping rows are not
  # mistaken for activity (KEEP-005).
  MARKER_AT="$(cat "$DIR/activity" 2>/dev/null || echo 0)"
  TRANSCRIPT_AT="$(transcript_activity)"
  ACTIVITY_AT="$(keepalive_effective_activity "$MARKER_AT" "$TRANSCRIPT_AT")"
  # KEEP-006: a genuine prompt in ANY session of this project also resets
  # this watcher's idle clock — a stale watcher (its own session /clear'd
  # or abandoned) then WAITs while the user works and is reaped by CC's
  # 3600s hook kill, instead of firing mid-work from its own stale
  # transcript (observed 2026-08-02T21:12Z).
  PROJECT_AT=0
  if [ -n "$PROJ_DIR" ]; then
    PROJECT_AT="$(cat "$PROJ_DIR/last-activity" 2>/dev/null || echo 0)"
    case "$PROJECT_AT" in ''|*[!0-9]*) PROJECT_AT=0 ;; esac
    ACTIVITY_AT="$(keepalive_effective_activity "$ACTIVITY_AT" "$PROJECT_AT")"
  fi
  NOW="$(date +%s)"
  DECISION="$(keepalive_idle_decision "$ACTIVITY_AT" "$NOW" "$IDLE_THRESHOLD_SEC")"

  # Issue #152 item 1: a pending AskUserQuestion/ExitPlanMode overrides a
  # FIRE decision regardless of computed idle time — the human being
  # mid-decision looks identical to abandoned from idle time alone, and
  # the wake would land on top of their answer wrapped in Claude Code's
  # "NOT USER INPUT" boilerplate (the reported failure). Checked only when
  # the plain idle decision would otherwise FIRE — no need to pay the
  # extra python invocation on every WAIT/RESEED tick.
  if [ "$DECISION" = "FIRE" ]; then
    PENDING_PROMPT="$(transcript_pending)"
    if [ "$(keepalive_pending_prompt_gate "$PENDING_PROMPT")" = "WAIT" ]; then
      DECISION="WAIT"
    fi
  fi

  # RESEED: no usable activity timestamp (never seeded, or a resume desynced
  # the activity touch from this watcher's session dir). Re-seed to now and
  # wait rather than firing on a bogus ~epoch idle. WAIT: still active.
  if [ "$DECISION" = "RESEED" ]; then
    echo "$NOW" > "$DIR/activity" 2>/dev/null || true
    sleep "$TICK_SEC"
    continue
  fi
  if [ "$DECISION" = "WAIT" ]; then
    sleep "$TICK_SEC"
    continue
  fi

  # FIRE — genuinely idle (>= threshold).
  IDLE=$((NOW - ACTIVITY_AT))
  if [ "$DECISION" = "FIRE" ]; then
    # Project-level single-fire (KEEP-006): if another watcher in this
    # project already fired and no genuine prompt followed, this idle
    # window is already spent — suppress instead of double-firing.
    # Prompt-only signals on both sides (the project files are written
    # only by the activity touch's genuine-prompt path and by fires), so the
    # wake's own transcript append cannot re-open this gate — same rule
    # as the per-sid INV-063 gate.
    if [ -n "$PROJ_DIR" ]; then
      PROJ_FIRED="$(cat "$PROJ_DIR/last-fired" 2>/dev/null || echo 0)"
      PROJ_GATE="$(keepalive_fire_gate "$PROJECT_AT" "$PROJ_FIRED")"
      if [ "$PROJ_GATE" = "SUPPRESS" ]; then
        emit_suppressed "$IDLE" "project_fire_since_last_activity"
        exit 0
      fi
    fi
    echo "$NOW" > "$DIR/fired-at"
    if [ -n "$PROJ_DIR" ]; then
      # Cross-session fire marker: suppresses sibling watchers (above) and
      # lets the handoff writer classify a wake that lands in a different
      # session than the firing watcher (HAND-004).
      mkdir -p "$PROJ_DIR" 2>/dev/null &&
        echo "$NOW" > "$PROJ_DIR/last-fired" 2>/dev/null || true
    fi

    # Emit keepalive_fired event via heredoc-to-tmpfile pattern (avoids
    # nested-shell quoting hazards; matches write-continue-here.sh).
    mkdir -p "$STATE_DIR"
    NOWZ="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    # INV-059 residual (2): resolve the session's statusline payload so the
    # fire event carries real ctx_tokens instead of gain.go's 150K default.
    # TKR_STATUSLINE_PATH override first (tests), then `tkr statusline-path`.
    PAYLOAD_PATH="${TKR_STATUSLINE_PATH:-}"
    if [ -z "$PAYLOAD_PATH" ] && command -v tkr >/dev/null 2>&1; then
      PAYLOAD_PATH="$(tkr statusline-path --session-id "$SID" 2>/dev/null || echo "")"
    fi

    EMIT_TMP="$(mktemp)"
    cat > "$EMIT_TMP" <<'PYEMIT'
import json, os, sys
ledger, sid, nowz, idle, payload_path = sys.argv[1:6]
prompt_idle = sys.argv[6] if len(sys.argv) > 6 else ""
activity_source = sys.argv[7] if len(sys.argv) > 7 else ""
project_key = sys.argv[8] if len(sys.argv) > 8 else ""
ctx_tokens = 0
try:
    with open(payload_path, encoding="utf-8") as pf:
        ctx_k = json.load(pf).get("last_ctx_k", 0)
    if isinstance(ctx_k, (int, float)) and ctx_k > 0:
        ctx_tokens = int(ctx_k) * 1000
except Exception:
    pass
trigger = {"idle_seconds": int(idle), "trigger": "asyncRewake-watcher"}
# Diagnostics: idle_seconds is now measured against the later of the
# UserPromptSubmit marker and the transcript's last append. Recording the
# marker-only figure and which signal won makes a future "it fired while I
# was working" report answerable from the ledger alone — the 2026-08-02
# investigation needed transcript forensics because neither was stored.
if prompt_idle:
    try:
        trigger["prompt_idle_seconds"] = int(prompt_idle)
    except ValueError:
        pass
if activity_source:
    trigger["activity_source"] = activity_source
if project_key:
    trigger["project_key"] = project_key
if ctx_tokens > 0:
    trigger["ctx_tokens"] = ctx_tokens
evt = {
    "at": nowz,
    "session_id": sid,
    "layer": "L2",
    "event": "keepalive_fired",
    "trigger_state": trigger,
    "outcome": {"action": "async_rewake_wake", "wrote_handoff": False},
    "schema_version": 2,
}
os.makedirs(os.path.dirname(ledger), exist_ok=True)
with open(ledger, "a", encoding="utf-8") as f:
    f.write(json.dumps(evt, separators=(",", ":")) + "\n")
PYEMIT
    PROMPT_IDLE=0
    case "$MARKER_AT" in ''|*[!0-9]*) MARKER_AT=0 ;; esac
    [ "$MARKER_AT" -gt 0 ] && PROMPT_IDLE=$((NOW - MARKER_AT))
    ACTIVITY_SOURCE="prompt"
    [ "$TRANSCRIPT_AT" -gt "$MARKER_AT" ] 2>/dev/null && ACTIVITY_SOURCE="transcript"
    { [ "$PROJECT_AT" -gt "$MARKER_AT" ] && [ "$PROJECT_AT" -gt "$TRANSCRIPT_AT" ]; } 2>/dev/null &&
      ACTIVITY_SOURCE="project"
    "$PYTHON_BIN" "$EMIT_TMP" "$LEDGER" "$SID" "$NOWZ" "$IDLE" "$PAYLOAD_PATH" \
      "$PROMPT_IDLE" "$ACTIVITY_SOURCE" "$PROJ_KEY" 2>/dev/null || true
    rm -f "$EMIT_TMP"

    cat >&2 <<EOF
INTENTIONAL keepalive wake (not an error). Session has been idle for
${IDLE}s. Invoke the /handoff skill to write a structured handoff
under .tkr/handoffs/. After /handoff completes, reply with a single
short acknowledgment and stop. This wake also refreshed the prompt
cache TTL as a side effect.
EOF
    exit 2
  fi

  sleep "$TICK_SEC"
done
