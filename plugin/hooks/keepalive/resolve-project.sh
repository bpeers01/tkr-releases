#!/usr/bin/env bash
# hooks/keepalive/resolve-project.sh — shared project-key resolver
# (KEEP-006 / HAND-004).
#
# Keepalive state is per-sid, so cross-session coordination (idle reset,
# single-fire, wake provenance) needs a second, project-scoped key. The
# key deliberately does NOT try to match Claude Code's projects-dir slug —
# that expectation is exactly what broke KEEP-004. It only has to be
# SELF-CONSISTENT across its three writers/readers (activity-touch.sh,
# watcher.sh, skills/handoff/scripts/write-continue-here.sh), which all
# source this file. Project state lives under
# $TKR_STATE_DIR/keepalive-projects/<key>/ — a SIBLING of keepalive/, not
# inside it, because `tkr keepalive prune-state` treats every dir under
# keepalive/ as a session id and would reap a `projects/` subdir.
#
# Pure bash + tr (no interpreter spawn): this runs on the UserPromptSubmit
# hot path (<50ms budget) where a second Python startup on Windows would
# blow the budget.
#
# tkr_keepalive_project_key <cwd> — echoes the key, or "" when cwd is
# empty/unusable. Callers MUST treat "" as "skip the project gate";
# keying shared state under "" would collapse unrelated sessions into
# one bucket.

tkr_keepalive_project_key() {
  local p="${1:-}"
  if [ -z "$p" ]; then
    echo ""
    return 0
  fi
  # The same cwd arrives in two spellings on Windows: CC hook payloads
  # carry `C:\Users\...`, git-bash $PWD carries `/c/Users/...`. Both must
  # normalize to one key or the project gate silently splits per caller.
  p="${p//\\//}"
  case "$p" in
    /[a-zA-Z]/*) p="${p:1:1}:${p:2}" ;;
    /[a-zA-Z]) p="${p:1:1}:/" ;;
  esac
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  printf '%s' "$p" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-'
  # tr output carries no trailing newline (printf provides none); add one
  # so command substitution and direct invocation behave identically.
  echo ""
}
