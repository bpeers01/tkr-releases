#!/usr/bin/env bash
# /handoff prune — clean stale .tkr/handoffs/*.md files.
#
# Usage:
#   prune.sh                       # JSON list of >7d files (no deletion)
#   prune.sh --all                 # delete all >7d files
#   prune.sh --dry-run             # synonym for default (list only)
#   prune.sh --older-than <days>   # override 7d threshold
#   prune.sh --delete <path>...    # delete specific paths (skill-driven
#                                    after per-file prompts)
#   prune.sh --project-dir <dir>   # anchor the handoffs dir explicitly
#                                    (HAND-007; defaults to
#                                    CLAUDE_PROJECT_DIR, then $PWD)
#
# The skill body invokes this script twice for the interactive path:
#   1. with no flags → get the list
#   2. with --delete <path>... → delete user-selected ones

set -euo pipefail

ACTION="list"
THRESHOLD_DAYS=7
DELETE_PATHS=()
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

while [ $# -gt 0 ]; do
  case "$1" in
    --all) ACTION="delete-all" ;;
    --dry-run) ACTION="list" ;;
    --project-dir) PROJECT_DIR="$2"; shift ;;
    --older-than) THRESHOLD_DAYS="$2"; shift ;;
    --delete) ACTION="delete-list"; shift; while [ $# -gt 0 ]; do DELETE_PATHS+=("$1"); shift; done; break ;;
    -h|--help)
      sed -n '/^# Usage/,/^$/p' "$0" >&2
      exit 0
      ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# Same resolver as the writer and the same anchor rules — see
# handoffs-dir.sh (HAND-007). A prune that resolves differently from the
# writer reports "nothing stale" over a directory the writer never used.
# shellcheck source=/dev/null
. "$(dirname "$0")/handoffs-dir.sh"
DIR="$(tkr_handoffs_dir "$PROJECT_DIR")"

# HAND-007 recovery sweep: handoffs written before the anchor fix landed
# inside the skill's own install tree, where nothing project-anchored can
# reach them — not this prune, not /continue, not the SessionStart count.
# They are otherwise unreachable, so report them on every run. Reporting
# only: deleting files the user has never been shown is the wrong
# direction for a bug whose whole character was silence.
STRAY_DIR="$(tkr_handoffs_skill_root)/.tkr/handoffs"
if [ -n "$STRAY_DIR" ] && [ -d "$STRAY_DIR" ] && [ "$STRAY_DIR" != "$DIR" ]; then
  for _stray in "$STRAY_DIR"/*.md; do
    [ -f "$_stray" ] || continue
    echo "stray handoff (written before the HAND-007 anchor fix): $_stray" >&2
  done
fi

if [ ! -d "$DIR" ]; then
  echo '{"files":[],"action":"'"$ACTION"'","threshold_days":'"$THRESHOLD_DAYS"'}'
  exit 0
fi

PYTHON_BIN="${TKR_PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cat > "$WORKDIR/prune.py" <<'PYPRUNE'
import json, os, sys, time

dir_path = sys.argv[1]
threshold_days = int(sys.argv[2])
action = sys.argv[3]
delete_paths = sys.argv[4:] if len(sys.argv) > 4 else []

now = time.time()
threshold_sec = threshold_days * 86400
files = []
for name in sorted(os.listdir(dir_path)):
    if not name.endswith(".md"):
        continue
    p = os.path.join(dir_path, name)
    try:
        st = os.stat(p)
    except OSError:
        continue
    age = now - st.st_mtime
    files.append({
        "path": p,
        "name": name,
        "mtime": st.st_mtime,
        "age_days": round(age / 86400, 2),
        "size_bytes": st.st_size,
        "stale": age >= threshold_sec,
    })

# First-line "Next Action" preview for stale files (best-effort).
def next_action_preview(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
        in_na = False
        for ln in lines:
            if in_na and ln.startswith("-"):
                return ln.lstrip("- ").strip()[:120]
            if ln.startswith("## Next Action"):
                in_na = True
    except Exception:
        pass
    return ""

if action == "list":
    stale = [f for f in files if f["stale"]]
    for f in stale:
        f["next_action"] = next_action_preview(f["path"])
    out = {
        "action": "list",
        "threshold_days": threshold_days,
        "total": len(files),
        "stale_count": len(stale),
        "files": stale,
    }
    print(json.dumps(out, separators=(",", ":")))
elif action == "delete-all":
    deleted = []
    for f in files:
        if not f["stale"]:
            continue
        try:
            os.remove(f["path"])
            deleted.append(f["path"])
        except OSError as e:
            print(json.dumps({"error": str(e), "path": f["path"]}), file=sys.stderr)
    print(json.dumps({"action": "delete-all", "deleted": deleted, "count": len(deleted)}, separators=(",", ":")))
elif action == "delete-list":
    deleted = []
    for p in delete_paths:
        try:
            os.remove(p)
            deleted.append(p)
        except OSError as e:
            print(json.dumps({"error": str(e), "path": p}), file=sys.stderr)
    print(json.dumps({"action": "delete-list", "deleted": deleted, "count": len(deleted)}, separators=(",", ":")))
PYPRUNE

"$PYTHON_BIN" "$WORKDIR/prune.py" "$DIR" "$THRESHOLD_DAYS" "$ACTION" "${DELETE_PATHS[@]:-}"
