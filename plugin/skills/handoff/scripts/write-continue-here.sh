#!/usr/bin/env bash
# Playbook v2 L2 handoff writer (INV-024 P1).
#
# Reads JSON on stdin describing the five required sections, renders a
# `.continue-here.md`-style markdown file under `.tkr/handoffs/`, and
# emits a `taken` event to the playbook ledger. Always writes (no
# confirm gate). Never clobbers an existing file at the resolved
# target — on collision it disambiguates with a numeric `-N` suffix
# (see "Collision disambiguation" below). Atomic via tmp + mv. Honors
# --dry-run.
#
# stdin shape:
#   {"truths": [...], "artifacts": [...], "key_links": [...],
#    "open_threads": [...], "next_action": "..."}
#
# Optional env:
#   TKR_STATE_DIR        — override ~/.tkr (also where ledger lives)
#   TKR_HANDOFF_TARGET   — override `.continue-here.md` write path
#   TKR_HANDOFF_NO_EMIT  — if "1", skip ledger emit (used by tests
#                          and unattended fires from /tkr:keepalive)
#   TKR_SESSION_ID       — session ID baked into the file header
#
# Session-id resolution (HAND-001), in priority order:
#   1. --session-id flag      — explicit; the keepalive watcher passes
#                               the sid it resolved via resolve-sid.sh
#   2. TKR_SESSION_ID env     — `tkr claude` launcher / test harnesses
#   3. CLAUDE_CODE_SESSION_ID — set by Claude Code in the Bash tool env.
#                               This is the ONLY resolver that works for a
#                               manual `/handoff`: that path runs as a Bash
#                               tool call, which carries no TKR_SESSION_ID
#                               and no CC stdin payload (stdin here is the
#                               section JSON), so resolve-sid.sh's chain
#                               cannot apply.
#   4. unresolved             — recorded as such; NOT guessed.
#
# Deliberately NOT a fallback: "newest transcript by mtime". Concurrent
# sessions in sibling worktrees produce same-second mtimes, so that
# heuristic silently attributes a handoff to the wrong session. An
# unresolved sid is honest; a wrong one corrupts every downstream join.
#
# Provenance resolution (HAND-002), in priority order:
#   1. --source keepalive|manual — explicit override (tests, future
#                                  direct-invocation callers).
#   2. fired-at state gate       — $STATE_DIR/keepalive/<sid>/fired-at
#                                  present ⇒ keepalive; absent ⇒ manual.
#                                  Mechanical: activity-touch.sh deletes
#                                  the marker on every genuine user
#                                  prompt (the wake's own continuation is
#                                  guarded out), so at write time the
#                                  marker exists iff a keepalive fire
#                                  happened with no real prompt since —
#                                  i.e. this write is wake-commanded.
#   2b. project state gate       — HAND-004: when the per-sid gate reads
#                                  manual, keepalive-projects/<key>/
#                                  last-fired >= last-activity ⇒ a wake
#                                  landed in a different session than the
#                                  firing watcher; method
#                                  `state_gate_project`.
#   3. unknown                   — sid unresolved; the gate is keyed by
#                                  sid, so provenance cannot be read.
#
# Deliberately NOT model-passed from the skill: a measurement that only
# exists if a model remembers to emit it does not exist (HAND-003).
# Recorded as `handoff_source` (+ `handoff_source_method`:
# flag|state_gate|no_sid) on the ledger row and as an HTML comment on
# line 2 of the file. Absent field/marker == pre-HAND-002, legacy.

set -euo pipefail

DRY_RUN=0
NO_EMIT=0
SESSION_ID="${TKR_SESSION_ID:-}"
SESSION_ID_SOURCE="tkr_env"
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"
  SESSION_ID_SOURCE="cc_env"
fi
STATE_DIR="${TKR_STATE_DIR:-$HOME/.tkr}"
LEDGER="$STATE_DIR/playbook-events.jsonl"
NAME_OVERRIDE="${TKR_HANDOFF_NAME:-}"
SOURCE=""
SOURCE_METHOD=""

# Default target: .tkr/handoffs/<identifier>-YYYYMMDD-HHMM.md (UTC).
#   Identifier order: --name / TKR_HANDOFF_NAME → first-8 of SID → "unknown-sid"
#   Override:         TKR_HANDOFF_TARGET or --target sets explicit path
TARGET="${TKR_HANDOFF_TARGET:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-emit) NO_EMIT=1 ;;
    --session-id) SESSION_ID="$2"; SESSION_ID_SOURCE="flag"; shift ;;
    --target) TARGET="$2"; shift ;;
    --name) NAME_OVERRIDE="$2"; shift ;;
    --source)
      case "$2" in
        keepalive|manual) SOURCE="$2"; SOURCE_METHOD="flag" ;;
        *) echo "invalid --source: $2 (keepalive|manual)" >&2; exit 2 ;;
      esac
      shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -z "$SESSION_ID" ] && SESSION_ID_SOURCE="unresolved"

# Provenance (HAND-002): explicit flag wins; else the fired-at state gate.
if [ -z "$SOURCE" ]; then
  if [ -z "$SESSION_ID" ]; then
    SOURCE="unknown"; SOURCE_METHOD="no_sid"
  elif [ -f "$STATE_DIR/keepalive/$SESSION_ID/fired-at" ]; then
    SOURCE="keepalive"; SOURCE_METHOD="state_gate"
  else
    SOURCE="manual"; SOURCE_METHOD="state_gate"
  fi
fi

# HAND-004: a wake can land in a DIFFERENT session than the watcher that
# fired (observed 2026-08-02: fire under sid 5b545fe3, wake-commanded
# write under sid 137f11f6), so the per-sid fired-at gate above reads
# `manual` for a genuinely wake-commanded handoff. Project-scoped
# backstop, same mechanical rule at project level: the watcher stamps
# keepalive-projects/<key>/last-fired on every fire; activity-touch.sh
# stamps last-activity on every genuine prompt. last-fired >=
# last-activity at write time ⇒ a fire happened in this project and no
# real prompt followed ⇒ this write is wake-commanded. Recorded as
# `state_gate_project` so measurement can separate the two gate paths.
# The key resolver is shared with the hooks (source at the same relative
# depth in both the repo and the deployed plugin layout); when it is
# missing or the key is empty, the gate silently stays per-sid — today's
# behavior, the safe direction.
if [ "$SOURCE" = "manual" ] && [ "$SOURCE_METHOD" = "state_gate" ]; then
  RESOLVE_PROJECT="$(dirname "$0")/../../../hooks/keepalive/resolve-project.sh"
  if [ -f "$RESOLVE_PROJECT" ]; then
    # shellcheck source=/dev/null
    . "$RESOLVE_PROJECT"
    PROJ_KEY="$(tkr_keepalive_project_key "$PWD")"
    if [ -n "$PROJ_KEY" ]; then
      PROJ_DIR="$STATE_DIR/keepalive-projects/$PROJ_KEY"
      PROJ_FIRED="$(cat "$PROJ_DIR/last-fired" 2>/dev/null || echo 0)"
      PROJ_ACTIVITY="$(cat "$PROJ_DIR/last-activity" 2>/dev/null || echo 0)"
      case "$PROJ_FIRED" in ''|*[!0-9]*) PROJ_FIRED=0 ;; esac
      case "$PROJ_ACTIVITY" in ''|*[!0-9]*) PROJ_ACTIVITY=0 ;; esac
      if [ "$PROJ_FIRED" -gt 0 ] && [ "$PROJ_ACTIVITY" -le "$PROJ_FIRED" ]; then
        SOURCE="keepalive"; SOURCE_METHOD="state_gate_project"
      fi
    fi
  fi
fi

# Resolve default target when unset.
if [ -z "$TARGET" ]; then
  IDENT="$NAME_OVERRIDE"
  if [ -z "$IDENT" ] && [ -n "$SESSION_ID" ]; then
    IDENT="$(printf '%s' "$SESSION_ID" | cut -c1-8)"
  fi
  [ -z "$IDENT" ] && IDENT="unknown-sid"
  STAMP="$(date -u +"%Y%m%d-%H%M")"
  TARGET=".tkr/handoffs/${IDENT}-${STAMP}.md"
fi

if [ -n "${TKR_HANDOFF_NO_EMIT:-}" ] && [ "${TKR_HANDOFF_NO_EMIT}" = "1" ]; then
  NO_EMIT=1
fi

PYTHON_BIN="${TKR_PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

# Heredoc-to-tmpfile pattern: writing the python helpers to tmp files keeps
# stdin available to the python process. Inline `python - <<EOF` consumes
# the heredoc as stdin, swallowing any pipe input. We want stdin from the
# pipeline.

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cat > "$WORKDIR/render.py" <<'PYRENDER'
import json, sys, datetime
# Pin stdout to UTF-8 + LF regardless of platform default. Windows
# Python 3 otherwise opens stdout as cp1252 with \n -> \r\n
# translation, producing 0x97 bytes and CRLF in .continue-here.md.
# stdin too, so non-ASCII chars in incoming JSON round-trip cleanly.
sys.stdout.reconfigure(encoding="utf-8", newline="\n")
sys.stdin.reconfigure(encoding="utf-8", newline="\n")
raw = sys.stdin.read()
sid = sys.argv[1] if len(sys.argv) > 1 else ""
source = sys.argv[2] if len(sys.argv) > 2 else "unknown"
try:
    d = json.loads(raw)
except Exception as e:
    sys.stderr.write(f"handoff writer: bad JSON on stdin: {e}\n")
    sys.exit(2)

required = ("truths", "artifacts", "key_links", "open_threads", "next_action")
for k in required:
    if k not in d:
        sys.stderr.write(f"handoff writer: missing required key '{k}'\n")
        sys.exit(2)

non_empty_required = ("truths", "artifacts", "key_links", "next_action")
for k in non_empty_required:
    v = d[k]
    if isinstance(v, list) and len(v) == 0:
        sys.stderr.write(f"handoff writer: '{k}' must not be empty\n")
        sys.exit(2)
    if isinstance(v, str) and not v.strip():
        sys.stderr.write(f"handoff writer: '{k}' must not be blank\n")
        sys.exit(2)

today = datetime.date.today().isoformat()
sid_disp = sid or "unknown-sid"

def render_list(name, items):
    out = [f"## {name}", ""]
    if not items:
        out.append("- none")
    else:
        for it in items:
            out.append(f"- {it}")
    out.append("")
    return "\n".join(out)

next_act = d["next_action"]
if isinstance(next_act, list):
    next_act = next_act[0] if next_act else ""

# Line 2 provenance marker (HAND-002). HTML comment: invisible in
# rendered markdown; parsers (cache_channels.py) read it instead of
# inferring provenance from the filename shape. handoff_consumption.py
# only parses line 1, so the H1 must stay first.
parts = [
    f"# Continue-Here — {sid_disp} — {today}",
    f"<!-- tkr-handoff-source: {source} -->",
    "",
    render_list("Truths", d["truths"]),
    render_list("Artifacts", d["artifacts"]),
    render_list("Key Links", d["key_links"]),
    render_list("Open Threads", d["open_threads"]),
    "## Next Action",
    "",
    f"- {next_act}",
    "",
]
sys.stdout.write("\n".join(parts))
PYRENDER

cat > "$WORKDIR/emit.py" <<'PYEMIT'
import json, os, sys
ledger, sid, now = sys.argv[1], sys.argv[2] or "default", sys.argv[3]
sid_source = sys.argv[4] if len(sys.argv) > 4 else "unresolved"
source = sys.argv[5] if len(sys.argv) > 5 else "unknown"
source_method = sys.argv[6] if len(sys.argv) > 6 else "no_sid"
# `session_id` keeps the "default" sentinel for reader back-compat, but it is
# ambiguous: keepalive's resolve-sid.sh emits a real "default" sentinel too,
# and rows written before HAND-001 carry no source at all. `session_id_source`
# is the disambiguator — a row is joinable iff source is flag/tkr_env/cc_env.
# Absent field == pre-HAND-001 row, join status unknown.
# `handoff_source` (HAND-002): keepalive|manual|unknown, decided
# mechanically (see header). Absent field == pre-HAND-002 row, legacy.
evt = {
    "at": now,
    "session_id": sid,
    "session_id_source": sid_source,
    "handoff_source": source,
    "handoff_source_method": source_method,
    "layer": "L2",
    "event": "taken",
    "trigger_state": {},
    "outcome": {
        "action": "handoff_skill_invoked",
        "savings_estimate_cu": 0,
        "latency_turns": 0,
    },
    "schema_version": 1,
}
os.makedirs(os.path.dirname(ledger), exist_ok=True)
with open(ledger, "a", encoding="utf-8") as f:
    f.write(json.dumps(evt, separators=(",", ":")) + "\n")
PYEMIT

PREVIEW="$("$PYTHON_BIN" "$WORKDIR/render.py" "$SESSION_ID" "$SOURCE")"

if [ -z "$PREVIEW" ]; then
  echo "handoff writer: empty preview (input rejected)" >&2
  exit 2
fi

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "$PREVIEW"
  exit 0
fi

# Atomic write — tmp file in same dir for cross-fs renames.
TARGET_DIR="$(dirname "$TARGET")"
mkdir -p "$TARGET_DIR"

# Collision disambiguation — session-keyed filenames carry minute-
# granularity timestamps, so they don't collide across sessions, but
# repeated manual /handoff invocations inside the same session AND the
# same UTC minute (e.g. the INV-024 P1 gate: 3 consecutive /handoff
# runs) would otherwise resolve to the same TARGET and silently
# destroy the earlier write on `mv -f`. If TARGET already exists,
# append a numeric -2, -3, ... suffix instead of overwriting — nothing
# written by a prior invocation is ever lost. The keepalive watcher's
# single-fire gate means its own automatic writes never hit this path
# in practice (at most one per idle window), so this only engages for
# rapid manual re-invocation or explicit --target reuse.
if [ -e "$TARGET" ]; then
  TARGET_BASE="$(basename "$TARGET")"
  TARGET_EXT=""
  TARGET_STEM="$TARGET_BASE"
  case "$TARGET_BASE" in
    *.*) TARGET_EXT=".${TARGET_BASE##*.}"; TARGET_STEM="${TARGET_BASE%.*}" ;;
  esac
  N=2
  while [ -e "$TARGET_DIR/${TARGET_STEM}-${N}${TARGET_EXT}" ]; do
    N=$((N + 1))
  done
  TARGET="$TARGET_DIR/${TARGET_STEM}-${N}${TARGET_EXT}"
fi

TMP="$(mktemp "${TARGET}.XXXXXX")"
printf '%s\n' "$PREVIEW" > "$TMP"
mv -f "$TMP" "$TARGET"

if [ "$NO_EMIT" = "1" ]; then
  echo "wrote $TARGET"
  exit 0
fi

# Emit `taken` event to playbook ledger.
mkdir -p "$STATE_DIR"
NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
"$PYTHON_BIN" "$WORKDIR/emit.py" "$LEDGER" "$SESSION_ID" "$NOW" "$SESSION_ID_SOURCE" "$SOURCE" "$SOURCE_METHOD"

echo "wrote $TARGET"
