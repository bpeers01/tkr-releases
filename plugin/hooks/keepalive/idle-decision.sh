#!/usr/bin/env bash
# hooks/keepalive/idle-decision.sh — pure per-tick decision for the keepalive
# watcher, factored out so it is unit-testable without spawning the polling
# loop (which carries an eligibility shell-out, a parent-alive watchdog, and
# an infinite sleep — none of which survive a clean cross-platform test).
#
# Source this file, then call keepalive_idle_decision.

# keepalive_idle_decision <activity_raw> <now_epoch> <threshold_sec>
# Echoes exactly one of:
#   RESEED — activity timestamp is missing / empty / non-numeric. We have no
#            basis to call the session idle; treating it as 0 would make
#            idle = now - 0 (~1.78e9s) and fire on every tick (the resume
#            bug). Caller should re-seed activity to now and wait.
#   FIRE   — idle (now - activity) >= threshold. Genuinely idle.
#   WAIT   — recently active; keep polling.
keepalive_idle_decision() {
  local activity="$1" now="$2" threshold="$3"
  case "$activity" in ''|*[!0-9]*) activity=0 ;; esac
  if [ "$activity" -le 0 ]; then
    echo "RESEED"
    return 0
  fi
  if [ $((now - activity)) -ge "$threshold" ]; then
    echo "FIRE"
  else
    echo "WAIT"
  fi
}

# keepalive_effective_activity <marker_raw> <transcript_mtime_raw>
# Echoes the later of the two timestamps (non-numeric/empty → 0).
#
# Why this exists: `activity` is written ONLY by the activity touch
# (hooks/lib/keepalive-activity.js, run by user-prompt-submit.js) on
# UserPromptSubmit, so idle was really "seconds since the last user
# prompt". An agentic turn — subagents, long tool chains, a workflow —
# runs for an hour without a single UserPromptSubmit, so a session that
# is flat-out working looked identical to one that was abandoned, and the
# watcher fired mid-task. Observed 2026-08-02T00:41:04Z: fired at
# idle_seconds=3343 while the transcript had 231 rows in that same hour
# and the last append was 0.0 min before the fire.
#
# The session transcript is appended on every turn and tool result, so it
# is the honest "is anything happening" signal. Since KEEP-005 the caller
# passes the last REAL turn row's timestamp (transcript-activity.py), not
# the file mtime — CC appends bookkeeping rows (away_summary et al.)
# minutes after idle, which must not count as activity.
#
# CALLERS: use this for the IDLE decision only, never for the fire gate.
# The wake's own continuation turn appends to the transcript, so feeding
# this into keepalive_fire_gate would make activity > fired_at on every
# cycle and re-arm the watcher forever — the 18-21 fires per overnight
# session bug described in hooks/lib/keepalive-activity.js (INV-024).
# The gate must keep using the
# raw UserPromptSubmit marker, which only a human can advance.
keepalive_effective_activity() {
  local marker="$1" mtime="$2"
  case "$marker" in ''|*[!0-9]*) marker=0 ;; esac
  case "$mtime" in ''|*[!0-9]*) mtime=0 ;; esac
  if [ "$mtime" -gt "$marker" ]; then
    echo "$mtime"
  else
    echo "$marker"
  fi
}

# keepalive_fire_gate <activity_raw> <fired_at_raw>
# Backtested guard (478 historical fires, INV-063): once a fire goes
# unmatched (no real user turn followed it), the next fire in that same
# session matches only 2.5% of the time — dead sessions otherwise
# accumulate wasted fires forever. Suppressing on this rule backtests at
# net +$10.79, losing only 1 of 171 matched fires.
#
# Echoes exactly one of:
#   PROCEED  — no prior fire this session (fired_at unset/zero), so there
#              is nothing to compare against — never suppress a session's
#              first fire. Or: real activity has been recorded strictly
#              after the last fire — proceed toward a normal fire decision.
#   SUPPRESS — no evidence of activity since the last fire (activity <=
#              fired_at, including the exact-equal clock-skew case).
keepalive_fire_gate() {
  local activity="$1" fired_at="$2"
  case "$activity" in ''|*[!0-9]*) activity=0 ;; esac
  case "$fired_at" in ''|*[!0-9]*) fired_at=0 ;; esac
  if [ "$fired_at" -le 0 ]; then
    echo "PROCEED"
    return 0
  fi
  if [ "$activity" -le "$fired_at" ]; then
    echo "SUPPRESS"
  else
    echo "PROCEED"
  fi
}

# keepalive_pending_prompt_gate <pending_flag>
# Issue #152 item 1: a pending AskUserQuestion/ExitPlanMode appends no
# transcript rows while the human is deciding, so idle time alone reads it
# as abandoned. `pending_flag` is transcript-activity.py's `pending` mode
# output ("1"/"0"; anything else treated as "0" — see caller for why a
# detection failure defaults to "not pending" rather than "pending").
#
# Echoes exactly one of:
#   WAIT     — an interactive prompt is outstanding; override any FIRE.
#   PROCEED  — no pending prompt (or unknown); normal decision stands.
keepalive_pending_prompt_gate() {
  local pending="$1"
  if [ "$pending" = "1" ]; then
    echo "WAIT"
  else
    echo "PROCEED"
  fi
}
