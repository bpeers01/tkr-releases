#!/usr/bin/env bash
# skills/handoff/scripts/handoffs-dir.sh — the ONE handoffs-directory
# resolver for the shell side (HAND-007).
#
# Three parties have to agree on where `.tkr/handoffs/` is, or a handoff
# is written somewhere nothing reads and every surface still reports
# success:
#
#   write side  skills/handoff/scripts/write-continue-here.sh
#   prune side  skills/handoff/scripts/prune.sh
#   read side   hooks/lib/sessionstart/continue.js `handoffsDir()`
#
# The read side is anchored to the PROJECT — it is handed `projectPath`
# from the SessionStart payload. Before this file existed, both shell
# sides inferred an anchor from the shell's cwd instead, so they agreed
# with the reader only by coincidence. When the coincidence broke, the
# handoff landed under the tkr install directory, `/continue` found
# nothing, `prune` never saw the strays, and the `resume:` line printed a
# relative path that resolved against the project — pointing at a file
# that was not there. #262 closed the git-worktree half of this drift and
# left the not-a-git-repo half open.
#
# So: the anchor is an INPUT, never an inference from cwd. Callers pass
# the project dir explicitly (`--project-dir`); cwd is the last resort,
# not the first.
#
# tkr_handoffs_dir <base-dir> — echoes the absolute handoffs dir.
# Resolution order (must mirror continue.js `handoffsDir`):
#   1. TKR_HANDOFFS_DIR   — override, wins outright
#   2. main-checkout root — `git rev-parse --git-common-dir` run against
#                           BASE (not cwd); its parent is the main
#                           worktree root, so a worktree session and the
#                           main checkout resolve to one directory
#                           (#262). `--show-toplevel` is wrong here.
#   3. BASE itself        — when git resolution is unavailable or fails.
#
# The result is always ABSOLUTE. The old fallback printed the literal
# relative string `.tkr/handoffs`, which is what let the anchor float: a
# relative path has no anchor, it inherits whatever the caller's cwd
# happens to be at the moment it is used.
#
# tkr_handoffs_dir_is_stray <dir> — true when DIR sits inside this
# script's own install tree. That is never a project location; it is the
# signature of the miswrite above. Callers fail loudly on it rather than
# writing somewhere nothing reads.

# Absolute root of the deployed skill (…/skills/handoff), resolved from
# this file rather than $0 so it stays correct when sourced.
tkr_handoffs_skill_root() {
  local self="${BASH_SOURCE[0]}"
  ( cd "$(dirname "$self")/.." 2>/dev/null && pwd ) || printf '%s' ""
}

tkr_handoffs_dir() {
  local base="${1:-$PWD}"
  if [ -n "${TKR_HANDOFFS_DIR:-}" ]; then
    printf '%s\n' "$TKR_HANDOFFS_DIR"
    return 0
  fi

  local abs_base
  abs_base="$( cd "$base" 2>/dev/null && pwd )" || abs_base=""
  [ -n "$abs_base" ] || abs_base="$PWD"

  # Scrub ambient GIT_* before asking git anything: this runs inside
  # hooks, and git exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE into
  # every hook it runs. Git prefers those over the directory the caller
  # named, so an un-scrubbed call resolves against whatever repo the
  # environment points at rather than this one.
  local common_dir
  common_dir="$( cd "$abs_base" 2>/dev/null && \
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
        -u GIT_COMMON_DIR -u GIT_OBJECT_DIRECTORY GIT_TERMINAL_PROMPT=0 \
        git rev-parse --git-common-dir 2>/dev/null || true )"
  if [ -n "$common_dir" ]; then
    # --git-common-dir may come back relative to the directory it was
    # resolved in, so re-anchor there before making it absolute.
    common_dir="$( cd "$abs_base" 2>/dev/null && cd "$common_dir" 2>/dev/null && pwd || true )"
  fi
  if [ -n "$common_dir" ]; then
    printf '%s\n' "$(dirname "$common_dir")/.tkr/handoffs"
    return 0
  fi

  printf '%s\n' "$abs_base/.tkr/handoffs"
}

tkr_handoffs_dir_is_stray() {
  local dir="${1:-}"
  local root
  root="$(tkr_handoffs_skill_root)"
  [ -n "$dir" ] && [ -n "$root" ] || return 1
  case "$dir" in
    "$root"/*|"$root") return 0 ;;
    *) return 1 ;;
  esac
}
