#!/usr/bin/env bash
# hooks/keepalive/resolve-sid.sh — shared SID resolver for keepalive
# bash hooks (activity-touch, watcher, cleanup).
#
# Source this file from a keepalive hook to populate KEEPALIVE_SID and
# KEEPALIVE_PAYLOAD_CWD (the CC payload's `cwd`, "" when unavailable —
# callers fall back to $PWD for the KEEP-006 project key).
# Resolution chain mirrors hooks/lib/session-id.js so bash hooks key
# state under the same id JS hooks do:
#
#   1. TKR_SESSION_ID env var — set by `tkr claude` launcher or test
#      harnesses. Cheap to check; honored first.
#   2. CC stdin JSON `session_id` / `sessionId` field — every real CC
#      hook payload carries this. We read stdin ONCE here, so callers
#      MUST NOT need stdin after sourcing this file.
#   3. CC stdin JSON `transcript_path` UUID — fallback when session_id
#      field is missing but transcript_path is present (older payload
#      shapes).
#   4. `.claude/scheduled_tasks.lock` `sessionId` — legacy fallback
#      that only works when the hook runs with cwd inside the project
#      that owns the lock. asyncRewake watchers spawned from other cwds
#      hit this case; stdin (step 2) covers it.
#   5. "default" — last-resort sentinel; all keepalive state collapses
#      under ~/.tkr/keepalive/default/. Single-account single-session
#      works fine on this; multi-session loses per-session granularity.
#
# Closes CARRYOVER 2 from .tkr/handoffs/publish-gap-and-sid-prop:
# asyncRewake watcher.sh used to receive TKR_SESSION_ID-empty env from
# CC and a missing/wrong-cwd scheduled_tasks.lock, so it always landed
# at SID="default". Stdin JSON is the env-independent path.

# shellcheck source=./resolve-python.sh
. "$(dirname "${BASH_SOURCE[0]}")/resolve-python.sh"

_keepalive_resolve_sid() {
  local sid=""
  local py
  py="$(tkr_resolve_python)"

  sid="${TKR_SESSION_ID:-}"
  KEEPALIVE_PAYLOAD_CWD=""

  # Step 2 + 3: parse stdin JSON. Only attempted when stdin is a pipe
  # (CC always pipes JSON; interactive `bash watcher.sh` won't false-fire).
  # The same single read also extracts the payload `cwd` (KEEP-006 project
  # key input) — stdin is consumed here, so it cannot be parsed again
  # later. When this branch is skipped (env sid present / no pipe),
  # KEEPALIVE_PAYLOAD_CWD stays empty and callers fall back to $PWD.
  if [ -z "$sid" ] && [ ! -t 0 ] && command -v "$py" >/dev/null 2>&1; then
    local parsed=""
    parsed="$("$py" -c '
import json, re, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
if not isinstance(data, dict):
    print("")
    sys.exit(0)
out = data.get("session_id") or data.get("sessionId") or ""
if not out:
    tp = data.get("transcript_path") or ""
    m = re.search(r"([a-f0-9-]{36})\.jsonl$", tp, re.IGNORECASE)
    if m:
        out = m.group(1)
print(out or "")
cwd = data.get("cwd") or ""
if isinstance(cwd, str) and "\n" not in cwd:
    print(cwd)
' 2>/dev/null || echo "")"
    sid="$(printf '%s\n' "$parsed" | sed -n '1p')"
    KEEPALIVE_PAYLOAD_CWD="$(printf '%s\n' "$parsed" | sed -n '2p')"
  fi

  # Step 4: lockfile fallback (legacy; kept for parity with prior behavior).
  if [ -z "$sid" ] && [ -f ".claude/scheduled_tasks.lock" ] && command -v "$py" >/dev/null 2>&1; then
    sid="$("$py" -c '
import json
try:
    print(json.load(open(".claude/scheduled_tasks.lock")).get("sessionId", "") or "")
except Exception:
    print("")
' 2>/dev/null || echo "")"
  fi

  [ -z "$sid" ] && sid="default"
  KEEPALIVE_SID="$sid"
}

_keepalive_resolve_sid
