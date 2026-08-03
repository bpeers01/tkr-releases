#!/usr/bin/env bash
# hooks/keepalive/resolve-python.sh — shared Python interpreter resolver for
# keepalive bash hooks (watcher.sh, resolve-sid.sh).
#
# Source this file, then call `tkr_resolve_python` to echo a usable
# interpreter name (the candidate, e.g. python3 | python — NOT a full path,
# so callers keep invoking it by name).
#
# Why this exists (INV-029): on Windows, `python3` is typically an "App
# Execution Alias" stub under %LOCALAPPDATA%/Microsoft/WindowsApps. A naive
# `command -v python3 >/dev/null || python` probe SUCCEEDS on the stub (it is
# on PATH), so the `|| python` fallback never fires — but executing the stub,
# especially with piped stdin, BLOCKS until killed (it tries to launch the
# Store). A keepalive watcher hitting that could stall up to the 3600s
# asyncRewake timeout. We detect the stub by its WindowsApps path and skip to
# the next candidate. Path detection (vs. an exec-with-timeout probe) is
# deterministic, spawns nothing, and needs no portable `timeout` binary.

# tkr_resolve_python — echo the first usable interpreter name.
# Order: $TKR_PYTHON (if set) → python3 → python. Skips any candidate whose
# resolved path is a Windows Store alias stub. Falls back to "python3" so the
# caller fails visibly on exec rather than silently selecting nothing.
tkr_resolve_python() {
  local candidate path
  for candidate in "${TKR_PYTHON:-}" python3 python; do
    [ -n "$candidate" ] || continue
    path="$(command -v "$candidate" 2>/dev/null)" || continue
    [ -n "$path" ] || continue
    # Skip the Windows Store App Execution Alias stub (INV-029).
    case "$path" in
      *[Ww]indows[Aa]pps*) continue ;;
    esac
    printf '%s\n' "$candidate"
    return 0
  done
  printf '%s\n' "python3"
}
