#!/usr/bin/env bash
# tkr unified statusline badge.
#
# Claude Code pipes session JSON to stdin with model, context, cost, rate limits.
# Falls back to $TMPDIR/claude-statusline.json for pressure if stdin unavailable.
#
# Output examples:
#   [TKR:ULTRA] Opus 4.6 | ctx:6% | $1.60 | use:56%
#   [TKR:ULTRA|CRIT] Haiku 4.5 | ctx:78% | $2.10 | use:91%

TKR_STATE_DIR="${TKR_STATE_DIR:-${HOME}/.tkr}"
BREVITY_FLAG="${TKR_STATE_DIR}/brevity-mode"

# Per-session telemetry path. tkr owns slug + sid normalization so the Go
# writer, JS hooks, and this shell agree on a single filename even on
# Windows where MSYS $PWD (POSIX-style) differs from Go's os.Getwd
# (Windows-style). Session id is extracted from stdin below and exported as
# TKR_SESSION_ID so `tkr` subprocesses inherit the same scoping.
# Fallback to the legacy unnamespaced name if the binary is missing.

# Colors (ANSI)
ORANGE='\033[38;5;208m'
RED='\033[38;5;196m'
YELLOW='\033[38;5;220m'
GREEN='\033[38;5;82m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Read stdin (Claude Code pipes session JSON) ──────────────────────
# Use read with timeout — more reliable than `timeout cat` on Windows/MSYS
STDIN_DATA=""
while IFS= read -r -t 1 LINE; do
  STDIN_DATA="${STDIN_DATA}${LINE}"
done

# L-06: debug write is gated. Hot-path I/O has no business firing on every
# prompt; opt in with TKR_STATUSLINE_DEBUG=1 when diagnosing stdin shape.
if [ "$TKR_STATUSLINE_DEBUG" = "1" ] && [ -n "$STDIN_DATA" ]; then
  echo "$STDIN_DATA" > "${TKR_STATE_DIR}/statusline-debug.json" 2>/dev/null
fi

# ── Extract session data from stdin (M-13: batched jq) ────────────────
# Single jq invocation extracts all seven fields in one pass — previous
# code spawned 5 subshells with 5 jq processes per statusline render.
# On Windows where process spawn dominates, this is a measurable win.
#
# SID resolution (v5.2.2): prefer transcript_path UUID over session_id
# field. Mirrors hooks/lib/session-id.js order. Rationale: Claude Code's
# `/reload-plugins` (and possibly other reload paths) emits a fresh
# session_id field to hooks while the JSONL transcript continues writing
# to the original session id. Hooks that key state off session_id then
# diverge from the actual conversation file. transcript_path's basename
# is the id that owns the actual data — most stable.
MODEL=""
CTX_PCT=""
COST=""
STDIN_5H=""
STDIN_7D=""
STDIN_5H_RESETS=""
STDIN_7D_RESETS=""
SESSION_ID=""
SESSION_ID_FIELD=""
TRANSCRIPT_PATH=""
if [ -n "$STDIN_DATA" ] && command -v jq &>/dev/null; then
  # One field per line (INV-032): @tsv + `IFS=$'\t' read` collapsed
  # consecutive tabs (tab is IFS whitespace), so any empty middle field
  # shifted every later field left. mapfile preserves empty lines.
  #
  # INV-048: resets_at fields (2 extra) are appended after the pct fields
  # so existing SF indices for session_id/transcript_path shift by +2
  # below. CC may emit resets_at as epoch seconds (number) or an ISO8601
  # string — jq -r passes either through as text; normalize_resets_at()
  # (below) does the type sniffing.
  STDIN_FIELDS=$(echo "$STDIN_DATA" | jq -r '
    (.model.display_name // ""),
    (.context_window.used_percentage // ""),
    (.cost.total_cost_usd // ""),
    (.rate_limits.five_hour.used_percentage // ""),
    (.rate_limits.seven_day.used_percentage // ""),
    (.rate_limits.five_hour.resets_at // ""),
    (.rate_limits.seven_day.resets_at // ""),
    (.session_id // ""),
    (.transcript_path // "")
  ' 2>/dev/null)
  if [ -n "$STDIN_FIELDS" ]; then
    mapfile -t SF <<< "$STDIN_FIELDS"
    # Windows jq emits CRLF; strip trailing \r or numeric validation rejects
    # every field. NOTE: $'\r' as the pattern inside the double-quoted ARRAY
    # expansion is not expanded by Git Bash 5.2 (scalar form works) — use a
    # pre-computed variable.
    CR=$(printf '\r')
    SF=("${SF[@]%$CR}")
    MODEL="${SF[0]}" CTX_PCT="${SF[1]}" COST="${SF[2]}"
    STDIN_5H="${SF[3]}" STDIN_7D="${SF[4]}"
    STDIN_5H_RESETS="${SF[5]}" STDIN_7D_RESETS="${SF[6]}"
    SESSION_ID_FIELD="${SF[7]}" TRANSCRIPT_PATH="${SF[8]}"
  fi

  # SID resolver: transcript_path UUID first (most stable; matches the
  # JSONL file owning the conversation), then session_id field as fallback.
  # The transcript filename pattern is <uuid>.jsonl.
  if [ -n "$TRANSCRIPT_PATH" ]; then
    SID_FROM_TRANSCRIPT=$(echo "$TRANSCRIPT_PATH" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | tail -n1)
    if [ -n "$SID_FROM_TRANSCRIPT" ]; then
      SESSION_ID="$SID_FROM_TRANSCRIPT"
    fi
  fi
  if [ -z "$SESSION_ID" ] && [ -n "$SESSION_ID_FIELD" ] && [ "$SESSION_ID_FIELD" != "null" ]; then
    SESSION_ID="$SESSION_ID_FIELD"
  fi

  # Truncate context to integer. Validate numeric BEFORE printf (INV-032):
  # `$(printf ... || echo ...)` captured printf's partial output PLUS the
  # fallback, concatenating garbage like "374.00<sid>".
  if [[ "$CTX_PCT" =~ ^[0-9]+\.?[0-9]*$ ]]; then
    CTX_PCT=$(printf "%.0f" "$CTX_PCT")
  else
    CTX_PCT=""
  fi
  # Truncate cost to 2 decimals
  if [[ "$COST" =~ ^[0-9]+\.?[0-9]*$ ]] && [ "$COST" != "0" ]; then
    COST=$(printf "%.2f" "$COST")
  else
    COST=""
  fi
  # Strip verbose suffixes from model name: "(1M context)", "Claude " prefix
  MODEL="${MODEL% (*}"
  MODEL="${MODEL#Claude }"
fi

# Export sid for all `tkr` subprocesses launched below (signals, etc.) so
# they resolve the same per-session statusline file we're about to read.
if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
  export TKR_SESSION_ID="$SESSION_ID"
fi

# Resolve telemetry path AFTER SID is in env — `tkr statusline-path`
# honors TKR_SESSION_ID and emits the per-session path. Manual fallback
# to per-session basename when `tkr` is missing.
TELEMETRY_FILE="${TKR_STATUSLINE_PATH:-}"
if [ -z "$TELEMETRY_FILE" ] && command -v tkr &>/dev/null; then
  TELEMETRY_FILE=$(tkr statusline-path 2>/dev/null)
fi
if [ -z "$TELEMETRY_FILE" ]; then
  if [ -n "$TKR_SESSION_ID" ]; then
    TELEMETRY_FILE="${TMPDIR:-/tmp}/claude-statusline-${TKR_SESSION_ID}.json"
  else
    TELEMETRY_FILE="${TMPDIR:-/tmp}/claude-statusline.json"
  fi
fi

# ── resets_at helpers (INV-048) ──────────────────────────────────────
# normalize_resets_at: CC has been observed sending rate_limits.*.resets_at
# as either epoch seconds (number) or an ISO8601 timestamp (string, with or
# without a trailing Z). Store epoch secs either way so downstream Go/JS
# consumers do one comparison, not per-language date parsing. Prints the
# epoch on stdout and returns 0, or prints nothing and returns 1 when the
# value is empty/unparseable.
normalize_resets_at() {
  local val="$1"
  [ -z "$val" ] && return 1
  if [[ "$val" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    printf "%.0f" "$val" 2>/dev/null
    return 0
  fi
  # ISO8601 path: strip a trailing Z (if present) and force UTC — CC's
  # rate-limit windows are always UTC-anchored, and `date -d "... UTC"`
  # gives a stable result regardless of whether CC included the Z suffix.
  local stripped="${val%Z}"
  local epoch
  epoch=$(date -d "${stripped} UTC" +%s 2>/dev/null)
  if [ -n "$epoch" ] && [[ "$epoch" =~ ^[0-9]+$ ]]; then
    printf "%s" "$epoch"
    return 0
  fi
  return 1
}

# sanity_check_epoch: reject negative or absurdly-far-future values (>60
# days out) rather than writing garbage a badge would render as nonsense.
sanity_check_epoch() {
  local epoch="$1"
  [[ "$epoch" =~ ^[0-9]+$ ]] || return 1
  local now
  now=$(date +%s 2>/dev/null || echo 0)
  local max=$((now + 60 * 24 * 3600))
  [ "$epoch" -gt "$max" ] 2>/dev/null && return 1
  return 0
}

# ── Persist CC's authoritative rate-limit pct (CC-RATELIMIT-001) ────
# Without this, $TMPDIR/claude-statusline.json's seven_day_pct stays
# whatever tkr's statusline-update last wrote (savings ratio, not real
# rate-limit). Downstream consumers (user-prompt-submit stateLineContext,
# mode-auto, signals package) read that file expecting authoritative
# pressure. Merge-safe: preserves any other keys.
#
# INV-048: seven_day_resets_at / five_hour_resets_at ride along in the same
# merge, each independently guarded — absent/null/malformed input for either
# means that key is left untouched (existing value, if any, survives).
if [ -n "$STDIN_7D" ] && [ "$STDIN_7D" != "null" ] && command -v jq &>/dev/null; then
  SD7=$(printf "%.0f" "$STDIN_7D" 2>/dev/null || echo 0)
  SD5=$(printf "%.0f" "${STDIN_5H:-0}" 2>/dev/null || echo 0)

  SD7_RESETS=""
  if [ -n "$STDIN_7D_RESETS" ] && [ "$STDIN_7D_RESETS" != "null" ]; then
    EPOCH=$(normalize_resets_at "$STDIN_7D_RESETS")
    if [ -n "$EPOCH" ] && sanity_check_epoch "$EPOCH"; then
      SD7_RESETS="$EPOCH"
    fi
  fi
  SD5_RESETS=""
  if [ -n "$STDIN_5H_RESETS" ] && [ "$STDIN_5H_RESETS" != "null" ]; then
    EPOCH=$(normalize_resets_at "$STDIN_5H_RESETS")
    if [ -n "$EPOCH" ] && sanity_check_epoch "$EPOCH"; then
      SD5_RESETS="$EPOCH"
    fi
  fi

  EXISTING='{}'
  if [ -f "$TELEMETRY_FILE" ]; then
    CUR=$(cat "$TELEMETRY_FILE" 2>/dev/null)
    if [ -n "$CUR" ] && echo "$CUR" | jq -e . >/dev/null 2>&1; then
      EXISTING="$CUR"
    fi
  fi
  echo "$EXISTING" | jq -c \
    --argjson sd "$SD7" \
    --argjson fh "$SD5" \
    --arg sdr "$SD7_RESETS" \
    --arg fhr "$SD5_RESETS" \
    '. + {seven_day_pct: $sd, five_hour_pct: $fh}
     + (if $sdr != "" then {seven_day_resets_at: ($sdr | tonumber)} else {} end)
     + (if $fhr != "" then {five_hour_resets_at: ($fhr | tonumber)} else {} end)' \
    > "${TELEMETRY_FILE}.tmp" 2>/dev/null \
    && mv "${TELEMETRY_FILE}.tmp" "$TELEMETRY_FILE" 2>/dev/null
fi

# ── Persist CC's live model (MODEL-LAG-001) ──────────────────────────
# The payload's `model_id` is the model of the transcript's most-recent
# ASSISTANT turn (cmd_statusline_update's JSONL scan). At UserPromptSubmit
# time for turn N that is turn N-1's model, so the first prompt of a
# session has no model at all — ADR-0010's shape matrix falls back to its
# default column — and the prompt right after a `/model` switch routes
# against the model the user just left.
#
# The transcript cannot fix this: turn N's assistant entry does not exist
# yet. Nor can the hook ask, because UserPromptSubmit stdin carries no
# model field (only SessionStart can, and not guaranteed). But CC hands
# the STATUSLINE the live model on every render, including the render
# triggered by `/model` itself — and this script already parsed it into
# $MODEL above, then used it for display only.
#
# So persist it, under its own key. model_display answers "what is this
# session running now"; model_id answers "what did the last turn cost"
# (projectedMissCost). Different questions, so they stay different fields.
#
# Deliberately NOT folded into the rate-limit merge above: that block is
# gated on rate_limits being present, which API-key accounts never emit.
#
# >>> MODEL_PERSIST
if [ -n "${MODEL:-}" ] && [ "$MODEL" != "null" ] && command -v jq &>/dev/null; then
  MD_EXISTING='{}'
  if [ -f "$TELEMETRY_FILE" ]; then
    MD_CUR=$(cat "$TELEMETRY_FILE" 2>/dev/null)
    if [ -n "$MD_CUR" ] && echo "$MD_CUR" | jq -e . >/dev/null 2>&1; then
      MD_EXISTING="$MD_CUR"
    fi
  fi
  # Distinct temp suffix: the rate-limit merge above uses .tmp, and two
  # statusline renders can overlap on a fast typist.
  echo "$MD_EXISTING" | jq -c --arg md "$MODEL" '. + {model_display: $md}' \
    > "${TELEMETRY_FILE}.mdl.tmp" 2>/dev/null \
    && mv "${TELEMETRY_FILE}.mdl.tmp" "$TELEMETRY_FILE" 2>/dev/null
fi
# <<< MODEL_PERSIST

# ── Durable rate-limit snapshot (INV-050) ────────────────────────────
# Mirrors the current turn's seven_day_pct/five_hour_pct + resets_at to
# ~/.tkr/rate-limits.json (survives $TMPDIR sweep, unlike TELEMETRY_FILE
# above) so `tkr usage`/trajectory can compare Anthropic's authoritative
# numbers against the JSONL cap-units scan estimate. Fire-and-forget:
# backgrounded and silenced (the `{ ... & } 2>/dev/null` wrapper swallows
# bash's job-control notice) so a slow or failing write never blocks or
# breaks the statusline render. `tkr signals rl-snapshot` self-throttles
# to one disk write per 30s.
if command -v tkr &>/dev/null; then
  { tkr signals rl-snapshot >/dev/null 2>&1 & } 2>/dev/null
fi

# ── Read brevity mode ────────────────────────────────────────────────
BREVITY=""
if [ -f "$BREVITY_FLAG" ]; then
  BREVITY=$(cat "$BREVITY_FLAG" 2>/dev/null)
fi

# ── Resolve pressure (stdin > telemetry file) ────────────────────────
# M-13: batched jq. Previous code spawned up to 7 jq processes here; now
# at most 2 (one for telemetry rate-limits, one for telemetry tail).
WEEKLY=0
SESSION_PCT=0
IDLE_SECS=-1
CACHE_HIT=""
MISS_CENTS=""
LAST_CTX_K=""
SAVED_K=""
if [ -n "$STDIN_7D" ] && [ "$STDIN_7D" != "null" ]; then
  # Numeric-validate before printf (INV-032 — no partial+fallback concat).
  if [[ "$STDIN_7D" =~ ^[0-9]+\.?[0-9]*$ ]]; then WEEKLY=$(printf "%.0f" "$STDIN_7D"); else WEEKLY=0; fi
  if [[ "$STDIN_5H" =~ ^[0-9]+\.?[0-9]*$ ]]; then SESSION_PCT=$(printf "%.0f" "$STDIN_5H"); else SESSION_PCT=0; fi
  # Defend against malformed payloads (observed: CC occasionally emits
  # rate_limits.*.used_percentage in scientific notation like 1.1e+19,
  # which printf "%.0f" faithfully expands into a 20-digit "percent").
  # These fields are percentages — clamp to [0,100], treat anything else
  # as unknown (0) so the statusline never renders digit-soup.
  case "$WEEKLY" in ''|*[!0-9]*) WEEKLY=0 ;; esac
  case "$SESSION_PCT" in ''|*[!0-9]*) SESSION_PCT=0 ;; esac
  if [ "$WEEKLY" -gt 100 ] 2>/dev/null; then WEEKLY=0; fi
  if [ "$SESSION_PCT" -gt 100 ] 2>/dev/null; then SESSION_PCT=0; fi
fi
RESETS_7D_AT=0
RESETS_5H_AT=0
if [ -f "$TELEMETRY_FILE" ] && command -v jq &>/dev/null; then
  # Single jq pass extracts all telemetry fields as TSV. Format:
  # seven_day_pct<TAB>five_hour_pct<TAB>idle_secs<TAB>cache_hit_pct<TAB>miss_cents<TAB>last_ctx_k<TAB>saved_k<TAB>seven_day_resets_at<TAB>five_hour_resets_at
  TEL_FIELDS=$(jq -r '
    (.seven_day_pct // 0),
    (.five_hour_pct // 0),
    (.idle_secs // -1),
    (.cache_hit_pct // ""),
    (.projected_miss_cents // ""),
    (.last_ctx_k // ""),
    (.tkr_saved_session_k // ""),
    (.seven_day_resets_at // 0),
    (.five_hour_resets_at // 0)
  ' "$TELEMETRY_FILE" 2>/dev/null)
  if [ -n "$TEL_FIELDS" ]; then
    mapfile -t TF <<< "$TEL_FIELDS"
    # Windows jq CRLF strip — see SF strip above for the $'\r' array quirk.
    CR=$(printf '\r')
    TF=("${TF[@]%$CR}")
    TEL_7D="${TF[0]}" TEL_5H="${TF[1]}" IDLE_SECS="${TF[2]}" CACHE_HIT="${TF[3]}"
    MISS_CENTS="${TF[4]}" LAST_CTX_K="${TF[5]}" SAVED_K="${TF[6]}"
    # INV-048a: resets_at fields feed the countdown badge further below.
    RESETS_7D_AT="${TF[7]:-0}" RESETS_5H_AT="${TF[8]:-0}"
    # Only fall back to telemetry rate-limits if stdin didn't supply them.
    if [ -z "$STDIN_7D" ] || [ "$STDIN_7D" = "null" ]; then
      WEEKLY="${TEL_7D:-0}"
      SESSION_PCT="${TEL_5H:-0}"
    fi
  fi
fi

# ── Unified signals classifier (single source of truth) ─────────────
# Source the Go classifier's tier output so cache/idle/size badges and
# the new delegate-recommendation badge stay consistent with what
# scripts/delegate.sh sees. Falls through silently if `tkr` is missing.
TKR_RATE_CLASS=""
TKR_MISS_TIER=""
TKR_SIZE_TIER=""
TKR_IDLE_TIER=""
TKR_SESSION_TIER=""
TKR_TURN_COUNT=0
TKR_RECOMMEND=""
TKR_REASON=""
TKR_DAYS_TO_CAP=-1
TKR_TRAJ_WARN=""
TKR_SCAN_CAP_PCT=0
TKR_BURN_ANOMALY=0
TKR_CACHE_BUSTS=0
TKR_CACHE_BUST_LAST=""
TKR_DAILY_UTIL_PCT=""
TKR_DAILY_CLASS=""
TKR_DELEGATE_VIA=""
TKR_ROUTE_CLASS=""
TKR_ROUTE_EFFORT=""
TKR_WORK_BADGE=""
TKR_CACHE_TTL=""
TKR_TOKENS_IN=0
TKR_TOKENS_OUT=0
TKR_HOOK_BAD=0
TKR_STALLED_SUBAGENTS=0
TKR_OTHER_LIVE_SESSIONS=0
TKR_OTHER_BUSY_SESSIONS=0
if command -v tkr &>/dev/null; then
  # M-13: cache `tkr signals --statusline-fields` for 30s. Statusline can
  # render at >1Hz on rapid prompts; the underlying signals derivation
  # spawns the Go binary and walks SQLite — ~100ms cold on Windows, which
  # frequently exceeds Claude Code's statusline render budget. Caching
  # for 30s keeps cumulative counters (in/out tokens, turn_count) within
  # acceptable staleness while ensuring most renders hit warm cache and
  # don't spawn a subprocess at all. Bumped from 1s in v5.2.1 after
  # diagnosing intermittent in:/out: field drop on Windows.
  # SEC: cache the signals fields in the user-owned state dir (NOT the
  # world-writable /tmp) and PARSE it — never `eval` it. eval of a shared-tmp
  # file let any local user pre-plant arbitrary shell that ran on every
  # statusline render.
  TKR_STATE_DIR_RESOLVED="${TKR_STATE_DIR:-$HOME/.tkr}"
  TKR_SIG_CACHE="$TKR_STATE_DIR_RESOLVED/statusline-signals.cache"
  TKR_SIG_FRESH=0
  if [ -f "$TKR_SIG_CACHE" ]; then
    NOW=$(date +%s 2>/dev/null || echo 0)
    MTIME=$(stat -c %Y "$TKR_SIG_CACHE" 2>/dev/null || stat -f %m "$TKR_SIG_CACHE" 2>/dev/null || echo 0)
    AGE=$((NOW - MTIME))
    if [ "$AGE" -ge 0 ] 2>/dev/null && [ "$AGE" -le 30 ] 2>/dev/null; then
      TKR_SIG_FRESH=1
    fi
  fi
  if [ "$TKR_SIG_FRESH" != "1" ]; then
    mkdir -p "$TKR_STATE_DIR_RESOLVED" 2>/dev/null
    TKR_SIG_TMP="${TKR_SIG_CACHE}.tmp.$$"
    if tkr signals --statusline-fields > "$TKR_SIG_TMP" 2>/dev/null; then
      mv "$TKR_SIG_TMP" "$TKR_SIG_CACHE" 2>/dev/null
    else
      rm -f "$TKR_SIG_TMP" 2>/dev/null
    fi
  fi
  # Parse KEY=VALUE lines: assign only allowlisted TKR_* names via `declare`,
  # which (unlike eval) treats the VALUE as a literal and never executes
  # command substitutions embedded in it. The NAME needs its own validation —
  # see the SEC note below; a glob that ends in `*` is not one.
  #
  # `tkr signals --statusline-fields` single-quotes every string value
  # (cmd_signals.shellQuote). `declare "$word"` does NOT perform quote
  # removal — that is a parser step, and the word here comes from an
  # expansion — so the quotes must be stripped explicitly. Without this,
  # an empty field arrives as the 2-character value `''` (truthy to
  # `[ -n ... ]`) and every equality test against an unquoted literal
  # fails: `TKR_RECOMMEND='delegate'` never equals `delegate`.
  # >>> SIGFIELDS_PARSE (extracted verbatim by statusline-sigfields.test.js)
  # SEC: the exact set of names `tkr signals --statusline-fields` emits.
  # An exact list, not a prefix glob, for two independent reasons:
  #
  #   1. A trailing `*` does not validate a NAME. The pattern
  #      `TKR_[A-Z0-9_]*=*` accepts `TKR_X[$(cmd)]=v`, and bash evaluates an
  #      array subscript — command substitutions inside it included — while
  #      processing the assignment, so `declare` RAN the command. Redirecting
  #      declare's stderr does not help: the subscript is evaluated before
  #      declare can reject anything. Verified executing on bash 5.2.21.
  #   2. Several TKR_* names are script INPUTS read after this loop —
  #      TKR_STATE_DIR and TKR_SESSION_ID resolve MODE_FILE below. The cache
  #      is this script's output; it has no business setting its inputs.
  #
  # Bound to the emitter by TestStatuslineFields_EmittedNamesAreAllowlisted:
  # add a field to printStatuslineFields without adding it here and Go CI
  # fails, so a new badge can never go silently missing.
  TKR_SIG_ALLOW=" TKR_ACTIVE_SUBAGENTS TKR_BURN_ANOMALY TKR_CACHE_BUSTS"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_CACHE_BUST_LAST TKR_CACHE_HIT_PCT"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_CACHE_TTL TKR_DAILY_CLASS TKR_DAILY_UTIL_PCT"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_DAYS_TO_CAP TKR_DELEGATE_VIA"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_FIVE_HOUR_PCT TKR_HOOK_BAD TKR_IDLE_SECS"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_IDLE_TIER TKR_LAST_CTX_K TKR_MISS_CENTS"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_MISS_TIER TKR_OTHER_BUSY_SESSIONS"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_OTHER_LIVE_SESSIONS TKR_PRESSURE_PCT"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_RATE_CLASS TKR_REASON TKR_RECOMMEND"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_ROUTE_CLASS TKR_ROUTE_EFFORT"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_SCAN_CAP_PCT TKR_SESSION_TIER"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_SEVEN_DAY_PCT TKR_SIZE_TIER"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_STALLED_SUBAGENTS TKR_TOKENS_IN"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_TOKENS_OUT TKR_TRAJ_WARN TKR_TURN_COUNT"
  TKR_SIG_ALLOW="$TKR_SIG_ALLOW TKR_WORK_BADGE "
  if [ -f "$TKR_SIG_CACHE" ]; then
    while IFS= read -r _tkr_line || [ -n "$_tkr_line" ]; do
      _tkr_line="${_tkr_line%$'\r'}"
      case "$_tkr_line" in
        *=*) ;;
        *) continue ;;
      esac
      _tkr_name="${_tkr_line%%=*}"
      _tkr_val="${_tkr_line#*=}"
      # Validate the name COMPLETELY before it is used anywhere. The
      # identifier check is redundant with the allowlist today and stays
      # deliberately: it is what keeps execution closed if someone later
      # loosens the list back into a pattern, which is the exact mistake
      # this block is fixing.
      case "$_tkr_name" in
        TKR_*) ;;
        *) continue ;;
      esac
      case "${_tkr_name#TKR_}" in
        ""|*[!A-Z0-9_]*) continue ;;
      esac
      # Membership. Order matters: this expands _tkr_name into a glob
      # PATTERN, so it must already be known free of metacharacters.
      case "$TKR_SIG_ALLOW" in
        *" $_tkr_name "*) ;;
        *) continue ;;
      esac
      case "$_tkr_val" in
        \'*\')
          _tkr_val="${_tkr_val#\'}"
          _tkr_val="${_tkr_val%\'}"
          # Undo shellQuote's '\'' dance for embedded single quotes.
          # The pattern is DOUBLE-QUOTED deliberately. The backslash-escaped
          # form — ${_tkr_val//\'\\\'\'/\'} — matches on bash 5.2.21 (Linux,
          # where this was written and where CI runs) but silently fails to
          # substitute on bash 5.2.15 under Git for Windows, leaving the
          # literal '\'' in the rendered value. Quoting the pattern makes it
          # an unambiguous literal on both.
          _tkr_val="${_tkr_val//"'\\''"/"'"}"
          ;;
      esac
      declare "$_tkr_name=$_tkr_val" 2>/dev/null
    done < "$TKR_SIG_CACHE"
  fi
  # <<< SIGFIELDS_PARSE
fi

# Pressure = higher of weekly vs session
PRESSURE_PCT=$WEEKLY
if [ "$SESSION_PCT" -gt "$PRESSURE_PCT" ] 2>/dev/null; then
  PRESSURE_PCT=$SESSION_PCT
fi

# ── Classify pressure ────────────────────────────────────────────────
# FROZEN LEGACY (PACE-001). These raw-percentage bands do NOT apply the
# pace/runway adjustment that `tkr statusline render` does — 85% with hours
# to reset still renders CRIT here. That is deliberate, not an oversight:
# this renderer only runs as the installer's fallback for a binary too old
# to serve `statusline render` (install.sh:380, install.ps1), and such a
# binary has no pace-aware classifier either. Raw bands here therefore MATCH
# the classifier that install is actually running.
#
# Do not port the runway math into bash — that would be a third copy
# (internal/signals/pace.go, hooks/user-prompt-submit.js) serving installs
# that cannot benefit from it. This block retires with the renderer, when
# the minimum supported binary gains `statusline render`.
PRESSURE_LABEL=""
PRESSURE_COLOR="$GREEN"
if [ "$PRESSURE_PCT" -ge 85 ] 2>/dev/null; then
  PRESSURE_LABEL="CRIT"
  PRESSURE_COLOR="$RED"
elif [ "$PRESSURE_PCT" -ge 70 ] 2>/dev/null; then
  PRESSURE_LABEL="HIGH"
  PRESSURE_COLOR="$YELLOW"
elif [ "$PRESSURE_PCT" -ge 50 ] 2>/dev/null; then
  PRESSURE_LABEL="ELEV"
  PRESSURE_COLOR="$YELLOW"
fi

# ── Context color ────────────────────────────────────────────────────
CTX_COLOR="$DIM"
if [ -n "$CTX_PCT" ]; then
  if [ "$CTX_PCT" -ge 85 ] 2>/dev/null; then
    CTX_COLOR="$RED"
  elif [ "$CTX_PCT" -ge 70 ] 2>/dev/null; then
    CTX_COLOR="$YELLOW"
  fi
fi

# ── Idle / cache-cliff ───────────────────────────────────────────────
# Badge label/color derive from TKR_IDLE_TIER (cold|cool|cooling|warm) so
# the visual matches the Go classifier's idle bucket exactly. The numeric
# IDLE_LABEL still uses IDLE_SECS for human-readable formatting.
IDLE_LABEL=""
IDLE_COLOR="$DIM"
CACHE_BADGE=""
if [ "$IDLE_SECS" -ge 0 ] 2>/dev/null; then
  if [ "$IDLE_SECS" -ge 3600 ] 2>/dev/null; then
    IDLE_H=$((IDLE_SECS / 3600))
    IDLE_M=$(( (IDLE_SECS % 3600) / 60 ))
    IDLE_LABEL="${IDLE_H}h${IDLE_M}m"
  elif [ "$IDLE_SECS" -ge 60 ] 2>/dev/null; then
    IDLE_LABEL="$((IDLE_SECS / 60))m"
  fi

  case "${TKR_IDLE_TIER:-}" in
    cold)    IDLE_COLOR="$RED";    CACHE_BADGE="CLIFF" ;;
    cool)    IDLE_COLOR="$ORANGE"; CACHE_BADGE="COOL"  ;;
    cooling) IDLE_COLOR="$YELLOW" ;;
    *)       IDLE_COLOR="$DIM"    ;;
  esac
fi

# ── Resets countdown badge (INV-048a) ───────────────────────────────
# Humanizes seven_day_resets_at / five_hour_resets_at (epoch secs,
# INV-048, extracted into RESETS_7D_AT/RESETS_5H_AT above) into a
# "2d9h" / "9h" / "45m" countdown. Gated on the window still being in
# the future — 0/absent/already-passed all render nothing.
humanize_countdown() {
  local secs=$1
  if [ "$secs" -ge 86400 ] 2>/dev/null; then
    printf "%dd%dh" "$((secs / 86400))" "$(( (secs % 86400) / 3600 ))"
  elif [ "$secs" -ge 3600 ] 2>/dev/null; then
    printf "%dh" "$((secs / 3600))"
  elif [ "$secs" -ge 60 ] 2>/dev/null; then
    printf "%dm" "$((secs / 60))"
  else
    printf "%ds" "$secs"
  fi
}
NOW_EPOCH=$(date +%s 2>/dev/null || echo 0)
SEVEN_DAY_RESETS_LABEL=""
if [ "${RESETS_7D_AT:-0}" -gt 0 ] 2>/dev/null; then
  REMAIN=$((RESETS_7D_AT - NOW_EPOCH))
  if [ "$REMAIN" -gt 0 ] 2>/dev/null; then
    SEVEN_DAY_RESETS_LABEL=$(humanize_countdown "$REMAIN")
  fi
fi
FIVE_HOUR_RESETS_LABEL=""
if [ "${RESETS_5H_AT:-0}" -gt 0 ] 2>/dev/null; then
  REMAIN=$((RESETS_5H_AT - NOW_EPOCH))
  if [ "$REMAIN" -gt 0 ] 2>/dev/null; then
    FIVE_HOUR_RESETS_LABEL=$(humanize_countdown "$REMAIN")
  fi
fi

# ── Stalled-subagent badge (INV-049a) ───────────────────────────────
# TKR_STALLED_SUBAGENTS (INV-049 detection, emitted by `tkr signals
# --statusline-fields`) counts subagent transcripts idle >180s with no
# completion marker. Display-only warning — never feeds Classify().
STALL_BADGE=""
if [ "${TKR_STALLED_SUBAGENTS:-0}" -ge 1 ] 2>/dev/null; then
  STALL_BADGE="STALL:${TKR_STALLED_SUBAGENTS}"
fi

# ── Live-session badge (INV-053) ────────────────────────────────────
# TKR_OTHER_LIVE_SESSIONS / TKR_OTHER_BUSY_SESSIONS (emitted by `tkr
# signals --statusline-fields`) count OTHER concurrent Claude Code
# sessions on this machine, sourced from the CC registry
# (~/.claude/sessions/<pid>.json, PID-reuse guarded). Display-only —
# never feeds Classify(). S:N(Mbusy) when any other session is busy,
# S:N otherwise; no badge when no other sessions are live.
SESS_BADGE=""
if [ "${TKR_OTHER_LIVE_SESSIONS:-0}" -ge 1 ] 2>/dev/null; then
  if [ "${TKR_OTHER_BUSY_SESSIONS:-0}" -ge 1 ] 2>/dev/null; then
    SESS_BADGE="S:${TKR_OTHER_LIVE_SESSIONS}(${TKR_OTHER_BUSY_SESSIONS}busy)"
  else
    SESS_BADGE="S:${TKR_OTHER_LIVE_SESSIONS}"
  fi
fi

# ── Session-size warning ─────────────────────────────────────────────
# Sourced from TKR_SIZE_TIER (huge|big|normal). Thresholds (250k/500k)
# live in internal/signals so delegate.sh sees the same bucketing.
SIZE_BADGE=""
case "${TKR_SIZE_TIER:-}" in
  huge) SIZE_BADGE="HUGE" ;;
  big)  SIZE_BADGE="BIG"  ;;
esac

# ── Session-length warning ───────────────────────────────────────────
# Turn-count backstop — long sessions accumulate cache_create cost even
# when compaction keeps ctx% low. Thresholds (50/80 turns) live in
# internal/signals so mode.AutoSelectFull sees the same bucketing.
SESSION_BADGE=""
SESSION_COLOR="$DIM"
case "${TKR_SESSION_TIER:-}" in
  extended) SESSION_BADGE="LONG!"; SESSION_COLOR="$RED"    ;;
  long)     SESSION_BADGE="LONG";  SESSION_COLOR="$YELLOW" ;;
esac

# ── Burn anomaly badge (Feature 5) ──────────────────────────────────
# Shows ANO:2.3x when today's burn rate is ≥2× the baseline daily average.
# Cache written by `tkr signals anomaly`; absent = no badge.
ANO_BADGE=""
ANO_COLOR="$DIM"
if [ "$(echo "${TKR_BURN_ANOMALY:-0} >= 2.0" | awk '{print ($1 >= $3)}')" = "1" ] 2>/dev/null; then
  ANO_RATIO=$(printf "%.1f" "${TKR_BURN_ANOMALY:-0}" 2>/dev/null || echo "${TKR_BURN_ANOMALY:-0}")
  ANO_BADGE="ANO:${ANO_RATIO}x"
  if [ "$(echo "${TKR_BURN_ANOMALY:-0} >= 5.0" | awk '{print ($1 >= $3)}')" = "1" ] 2>/dev/null; then
    ANO_COLOR="$RED"
  elif [ "$(echo "${TKR_BURN_ANOMALY:-0} >= 3.0" | awk '{print ($1 >= $3)}')" = "1" ] 2>/dev/null; then
    ANO_COLOR="$ORANGE"
  else
    ANO_COLOR="$YELLOW"
  fi
fi

# ── Trajectory cap badge (REPORT-002) ───────────────────────────────
# Shows CAP:Nd when a cached trajectory report projects cap hit within 7 days.
# Cache written by `tkr signals trajectory`; absent = no badge (no scan here).
CAP_BADGE=""
CAP_COLOR="$DIM"
if [ "${TKR_DAYS_TO_CAP:-1}" -ge 0 ] 2>/dev/null && [ "${TKR_DAYS_TO_CAP:-1}" -le 7 ] 2>/dev/null; then
  CAP_BADGE="CAP:${TKR_DAYS_TO_CAP}d"
  case "${TKR_TRAJ_WARN:-}" in
    alert) CAP_COLOR="$RED"    ;;
    warn)  CAP_COLOR="$YELLOW" ;;
    *)     CAP_COLOR="$ORANGE" ;;
  esac
fi

# ── Mode badge (PLAN-23, per-session via PLAN-33) ────────────────────
# Read ~/.tkr/mode-<sid>.json; emit a short badge when mode != normal.
# Conserve -> MODE:CONS (yellow), Critical -> MODE:CRIT (orange),
# Recovery -> MODE:REC! (red). Missing file = no badge (graceful).
#
# Resolution order matches internal/mode.StatePath:
#   1. Per-session file under TKR_STATE_DIR when TKR_SESSION_ID set.
#   2. Legacy ~/.tkr/mode.json fallback (writes from older tkr versions
#      or sid-less manual `tkr mode` CLI invocations).
MODE_BADGE=""
MODE_COLOR=""
MODE_FILE=""
if [ -n "${TKR_SESSION_ID:-}" ]; then
  CANDIDATE="${TKR_STATE_DIR}/mode-${TKR_SESSION_ID}.json"
  if [ -f "$CANDIDATE" ]; then MODE_FILE="$CANDIDATE"; fi
fi
if [ -z "$MODE_FILE" ] && [ -f "${TKR_STATE_DIR}/mode.json" ]; then
  MODE_FILE="${TKR_STATE_DIR}/mode.json"
fi
if [ -n "$MODE_FILE" ] && command -v jq &>/dev/null; then
  CUR_MODE=$(jq -r '.mode // "normal"' "$MODE_FILE" 2>/dev/null)
  case "$CUR_MODE" in
    conserve) MODE_BADGE="MODE:CONS"; MODE_COLOR="$YELLOW" ;;
    critical) MODE_BADGE="MODE:CRIT"; MODE_COLOR="$ORANGE" ;;
    recovery) MODE_BADGE="MODE:REC!"; MODE_COLOR="$RED" ;;
  esac
fi

# ── Cache-bust badge (CACHE-003) ────────────────────────────────────
# Per-session edits to cache-critical files (CLAUDE.md, MEMORY.md,
# .claude/rules/*, settings*.json, plugin.json). Each bust invalidates
# the prefix cache; ESCALATION at >=3 in cache-bust-detector.js. Mirror
# that threshold visually so the badge color matches the inline warning.
BUST_BADGE=""
BUST_COLOR="$DIM"
if [ "${TKR_CACHE_BUSTS:-0}" -ge 1 ] 2>/dev/null; then
  BUST_BADGE="BUST:${TKR_CACHE_BUSTS}"
  if [ "${TKR_CACHE_BUSTS:-0}" -ge 3 ] 2>/dev/null; then
    BUST_COLOR="$RED"
  else
    BUST_COLOR="$YELLOW"
  fi
fi

# ── Hook integrity badge (RTK-004) ──────────────────────────────────
# TKR_HOOK_BAD=1 when the hook integrity check detected a broken or stale
# install (hook files missing or version behind CurrentHookVersion).
# Check is gated by a 15-min sentinel in runStatuslineUpdate so per-turn
# cost is ~zero. Warn, never block.
HOOK_BADGE=""
if [ "${TKR_HOOK_BAD:-0}" = "1" ] 2>/dev/null; then
  HOOK_BADGE="HOOK!"
fi

# ── Delegate recommendation ──────────────────────────────────────────
# When the unified classifier says "delegate", surface a REC badge so the
# user can see why before scrolling. Headroom-aware variant (proposal
# 2026-05-09) suffixes the via mechanism so subscription-internal vs PAYG
# routing is visible at a glance: HAIKU/SONNET = subagent, PAYG = real $.
REC_BADGE=""
if [ "${TKR_RECOMMEND:-}" = "delegate" ]; then
  case "${TKR_DELEGATE_VIA:-}" in
    subagent_haiku)  REC_BADGE="DELEG:HAIKU" ;;
    subagent_sonnet) REC_BADGE="DELEG:SONN"  ;;
    payg_delegate)   REC_BADGE="DELEG:PAYG"  ;;
    *)               REC_BADGE="DELEG"       ;;
  esac
fi

# ── Route verdict (ADR-0010 statusline channel) ──────────────────────
# Always-on display of the effort-routing recommendation. Context
# injection is reserved for sustained mismatches, so the statusline is
# where the per-turn verdict lives.
#
# INV-106: RT_CLASS_MAX is the longest class route.ReachableProfiles()
# can actually produce today (status_classification, 21 runes —
# internal/route/classify.go) so real class names never get cut. A
# future longer class still falls through to the boundary-safe branch
# below instead of the old blind `:0:12` slice, which cut
# `localized_edit` into `localized_ed` — a truncated string with no
# marker, indistinguishable from a real (invented) class name.
RT_CLASS_MAX=21
RT_BADGE=""
if [ -n "${TKR_ROUTE_EFFORT:-}" ]; then
  RT_CLASS_SHORT="$TKR_ROUTE_CLASS"
  if [ "${#RT_CLASS_SHORT}" -gt "$RT_CLASS_MAX" ]; then
    RT_TRUNC="${RT_CLASS_SHORT:0:$RT_CLASS_MAX}"
    RT_BOUNDARY="${RT_TRUNC%_*}"
    if [ -n "$RT_BOUNDARY" ] && [ "$RT_BOUNDARY" != "$RT_TRUNC" ]; then
      # Cut back to the last complete snake_case segment within budget.
      RT_CLASS_SHORT="${RT_BOUNDARY}..."
    else
      # No underscore within budget (or the whole trunc IS one segment) —
      # still mark the cut so it never reads as a real class name.
      RT_CLASS_SHORT="${RT_TRUNC}..."
    fi
  fi
  if [ -n "$RT_CLASS_SHORT" ]; then
    RT_BADGE="RT:${RT_CLASS_SHORT}→${TKR_ROUTE_EFFORT}"
  else
    RT_BADGE="RT:${TKR_ROUTE_EFFORT}"
  fi
fi

# ── Work route (native-work-routing PR 2) ────────────────────────────
# WRK names where the task-economy policy would run the bounded portion
# of this prompt's work. Kept distinct from DELEG on purpose: DELEG is
# capacity/overflow ("the subscription is under pressure"), WRK is task
# shape ("this work fits a cheaper worker"). Observational only — nothing
# asks Claude to act on it.
#
# The body is composed by the Go side (route.WorkPlan.Badge) so this
# renderer and statusline.ps1 cannot drift on the model/effort spelling.
# Empty for every stay_main verdict, which is what retires the badge on
# the next prompt.
WRK_BADGE=""
if [ -n "${TKR_WORK_BADGE:-}" ]; then
  WRK_BADGE="WRK:${TKR_WORK_BADGE}"
fi

# ── Build badge ──────────────────────────────────────────────────────
BADGE="TKR"
if [ -n "$BREVITY" ] && [ "$BREVITY" != "full" ]; then
  BADGE="${BADGE}:${BREVITY^^}"
fi
if [ -n "$PRESSURE_LABEL" ]; then
  BADGE="${BADGE}|${PRESSURE_LABEL}"
fi
if [ -n "$CACHE_BADGE" ]; then
  BADGE="${BADGE}|${CACHE_BADGE}"
fi
if [ -n "$SIZE_BADGE" ]; then
  BADGE="${BADGE}|${SIZE_BADGE}"
fi
if [ -n "$SESSION_BADGE" ]; then
  BADGE="${BADGE}|${SESSION_BADGE}"
fi
if [ -n "$REC_BADGE" ]; then
  BADGE="${BADGE}|${REC_BADGE}"
fi
if [ -n "$WRK_BADGE" ]; then
  BADGE="${BADGE}|${WRK_BADGE}"
fi
if [ -n "$RT_BADGE" ]; then
  BADGE="${BADGE}|${RT_BADGE}"
fi
if [ -n "$BUST_BADGE" ]; then
  BADGE="${BADGE}|${BUST_BADGE}"
fi
if [ -n "$ANO_BADGE" ]; then
  BADGE="${BADGE}|${ANO_BADGE}"
fi
if [ -n "$CAP_BADGE" ]; then
  BADGE="${BADGE}|${CAP_BADGE}"
fi
if [ -n "$MODE_BADGE" ]; then
  BADGE="${BADGE}|${MODE_BADGE}"
fi
if [ -n "$SESS_BADGE" ]; then
  BADGE="${BADGE}|${SESS_BADGE}"
fi
if [ -n "$STALL_BADGE" ]; then
  BADGE="${BADGE}|${STALL_BADGE}"
fi
if [ -n "$HOOK_BADGE" ]; then
  BADGE="${BADGE}|${HOOK_BADGE}"
fi

# Badge color = worst signal
BADGE_COLOR="$ORANGE"
if [ -n "$PRESSURE_LABEL" ]; then
  BADGE_COLOR="$PRESSURE_COLOR"
fi
if [ "$CACHE_BADGE" = "CLIFF" ] || [ "$SIZE_BADGE" = "HUGE" ] || [ "$SESSION_BADGE" = "LONG!" ]; then
  BADGE_COLOR="$RED"
elif [ "$CACHE_BADGE" = "COOL" ] || [ "$SIZE_BADGE" = "BIG" ] || [ "$SESSION_BADGE" = "LONG" ]; then
  if [ "$BADGE_COLOR" != "$RED" ]; then
    BADGE_COLOR="$ORANGE"
  fi
fi
if [ -n "$ANO_BADGE" ] && [ "$BADGE_COLOR" != "$RED" ]; then
  BADGE_COLOR="$ANO_COLOR"
fi
if [ -n "$BUST_BADGE" ] && [ "$BUST_COLOR" = "$RED" ]; then
  BADGE_COLOR="$RED"
elif [ -n "$BUST_BADGE" ] && [ "$BADGE_COLOR" != "$RED" ]; then
  BADGE_COLOR="$BUST_COLOR"
fi
if [ -n "$CAP_BADGE" ] && [ "$BADGE_COLOR" != "$RED" ]; then
  BADGE_COLOR="$CAP_COLOR"
fi
if [ -n "$STALL_BADGE" ]; then
  BADGE_COLOR="$RED"
fi
if [ -n "$HOOK_BADGE" ]; then
  BADGE_COLOR="$RED"
fi

# ── Pressure colors (individual) ─────────────────────────────────────
color_for_pct() {
  local pct=$1
  if [ "$pct" -ge 85 ] 2>/dev/null; then printf "$RED"
  elif [ "$pct" -ge 70 ] 2>/dev/null; then printf "$YELLOW"
  elif [ "$pct" -ge 50 ] 2>/dev/null; then printf "$YELLOW"
  else printf "$DIM"
  fi
}
COLOR_5H=$(color_for_pct "${SESSION_PCT:-0}")
COLOR_7D=$(color_for_pct "${WEEKLY:-0}")

# ── Output ───────────────────────────────────────────────────────────
printf "${BADGE_COLOR}${BOLD}[${BADGE}]${RESET}"

if [ -n "$MODEL" ]; then
  printf " ${DIM}%s${RESET}" "$MODEL"
fi

if [ -n "$CTX_PCT" ]; then
  printf " ${CTX_COLOR}ctx:%s%%${RESET}" "$CTX_PCT"
fi

# Turn counter — session length backstop visualization. Color matches
# session tier so users see the escalation coming before it fires.
if [ "${TKR_TURN_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  printf " ${SESSION_COLOR}t:%d${RESET}" "$TKR_TURN_COUNT"
fi

if [ -n "$COST" ]; then
  printf " ${DIM}\$%s${RESET}" "$COST"
fi

printf " ${COLOR_5H}5h:%s%%${RESET}" "${SESSION_PCT:-0}"
if [ -n "$FIVE_HOUR_RESETS_LABEL" ]; then
  printf " ${DIM}rst5h:%s${RESET}" "$FIVE_HOUR_RESETS_LABEL"
fi
printf " ${COLOR_7D}7d:%s%%${RESET}" "${WEEKLY:-0}"
if [ -n "$SEVEN_DAY_RESETS_LABEL" ]; then
  printf " ${DIM}rst7d:%s${RESET}" "$SEVEN_DAY_RESETS_LABEL"
fi

# Daily utilization — today's burn / weekly cap. 14.3%/day is the even-burn
# target; ≥15% elevated, ≥25% high, ≥50% critical. Color matches DailyClass.
if [ -n "${TKR_DAILY_UTIL_PCT:-}" ]; then
  DAILY_COLOR="$DIM"
  case "${TKR_DAILY_CLASS:-}" in
    critical) DAILY_COLOR="$RED"    ;;
    high)     DAILY_COLOR="$ORANGE" ;;
    elevated) DAILY_COLOR="$YELLOW" ;;
  esac
  printf " ${DAILY_COLOR}daily:%s%%${RESET}" "${TKR_DAILY_UTIL_PCT}"
fi

if [ -n "$IDLE_LABEL" ]; then
  printf " ${IDLE_COLOR}idle:%s${RESET}" "$IDLE_LABEL"
fi

if [ -n "$CACHE_HIT" ]; then
  CACHE_HIT_COLOR="$DIM"
  if [ "$CACHE_HIT" -lt 70 ] 2>/dev/null; then
    CACHE_HIT_COLOR="$RED"
  elif [ "$CACHE_HIT" -lt 90 ] 2>/dev/null; then
    CACHE_HIT_COLOR="$YELLOW"
  fi
  printf " ${CACHE_HIT_COLOR}hit:%s%%${RESET}" "$CACHE_HIT"
fi

# ── Cache TTL (PLAN-1 / ADR-0009) ────────────────────────────────────
# Per-session detected prompt-cache TTL: 5m (Pro/Free default), 1h (Max
# extended), or <user> (operator override). Emitted by
# `tkr signals --statusline-fields` only after detection has run; absent
# means cold session or kill switch — render nothing then.
if [ -n "$TKR_CACHE_TTL" ]; then
  printf " ${DIM}ttl:%s${RESET}" "$TKR_CACHE_TTL"
fi

# ── Session token counters (v5.1.1) ──────────────────────────────────
# Cumulative session-to-date tokens read by the model (input + cache
# create + cache read) vs generated. Both sentinel 0 = no usage data
# yet (fresh session or scan skipped) — omit field. K/M humanize keeps
# the line short even on long sessions (≥1M reads).
humanize_tokens() {
  local n=$1
  if [ "$n" -ge 1000000 ] 2>/dev/null; then
    awk -v n="$n" 'BEGIN { printf "%.1fM", n/1000000 }'
  elif [ "$n" -ge 1000 ] 2>/dev/null; then
    awk -v n="$n" 'BEGIN { printf "%dK", int(n/1000) }'
  else
    printf "%d" "$n"
  fi
}
if [ "${TKR_TOKENS_IN:-0}" -gt 0 ] 2>/dev/null; then
  printf " ${DIM}in:%s${RESET}" "$(humanize_tokens "$TKR_TOKENS_IN")"
fi
if [ "${TKR_TOKENS_OUT:-0}" -gt 0 ] 2>/dev/null; then
  printf " ${DIM}out:%s${RESET}" "$(humanize_tokens "$TKR_TOKENS_OUT")"
fi

# ── Projected miss cost ──────────────────────────────────────────────
# Cache TTL is ~5min (per cache-audit data). Past TTL, the next turn
# likely rebuilds the whole context at cache-creation rates. Show the
# projected rebuild cost so the user can decide: continue and pay, or
# reset the session.
#
# Thresholds: show when idle >= 5min AND cost >= $0.10. Color tiers
# match audit's idle-bucket $/turn analysis: baseline=$0.08, 15-60m=$0.14,
# 1h+=$0.71.
if [ -n "$MISS_CENTS" ] && [ "$IDLE_SECS" -ge 300 ] 2>/dev/null && [ "$MISS_CENTS" -ge 10 ] 2>/dev/null; then
  MISS_COLOR="$DIM"
  if [ "$MISS_CENTS" -ge 50 ] 2>/dev/null; then
    MISS_COLOR="$RED"
  elif [ "$MISS_CENTS" -ge 25 ] 2>/dev/null; then
    MISS_COLOR="$YELLOW"
  fi
  MISS_DOLLARS=$((MISS_CENTS / 100))
  MISS_REMAIN=$((MISS_CENTS % 100))
  printf " ${MISS_COLOR}miss:~\$%d.%02d${RESET}" "$MISS_DOLLARS" "$MISS_REMAIN"
fi

# ── LCTX-001 saved tokens (Phase 4) ─────────────────────────────────
# Motivational field — drives sustained tkr_read adoption by surfacing
# per-session savings. Hidden when <1k tokens (set to empty by writer).
# Color tiers track adoption depth: 5k+ green, 25k+ bold green.
if [ -n "$SAVED_K" ] && [ "$SAVED_K" -gt 0 ] 2>/dev/null; then
  SAVED_COLOR="$DIM"
  if [ "$SAVED_K" -ge 25 ] 2>/dev/null; then
    SAVED_COLOR="${BOLD}${GREEN}"
  elif [ "$SAVED_K" -ge 5 ] 2>/dev/null; then
    SAVED_COLOR="$GREEN"
  fi
  printf " ${SAVED_COLOR}SAVED:%sk${RESET}" "$SAVED_K"
fi
