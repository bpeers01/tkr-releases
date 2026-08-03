#!/usr/bin/env node
// PlaybookV2 L5 — cache-bust warn (proposal 2026-05-10).
//
// PreToolUse(Edit|Write) hook. Fires when the about-to-edit file is
// in the prefix-cache critical set (CLAUDE.md, AGENTS.md, MEMORY.md,
// settings.json, settings.local.json, plugin.json, .claude/rules/*).
// Editing any of these mid-session busts the prefix cache — the next
// turn pays the rebuild at ~5x the cache-read rate.
//
// Action: emit additionalContext warning with $ rebuild estimate +
// emit L5 fired event to playbook ledger. Advisory only — never
// blocks the edit.
//
// Survey data: $346 / 30% of total bust spend lives in this class
// (docs/audits/2026-05-10-cache-bust-survey.md §prefix-drift).
// L0 covers static-prefix bloat at session start; L5 covers the
// mid-session edit case L0 misses.
//
// Hot path: <5ms — read cached pinned-budget.json (already populated
// by L0) for size estimate, plus per-session state file.
//
// Skip when ≤5 turns into session — proposal §risk #3: build-pattern
// sessions (us, right now) edit cache-critical files repeatedly and
// would spam the warning.
//
// Per-file fire cap = 1 per session.
//
// Kill switches:
//   TKR_PLAYBOOK_L5_DISABLED=1
//   TKR_PLAYBOOK_EXTENSIONS_DISABLED=1
//   TKR_PLAYBOOK_DISABLED=1

const fs = require("fs");
const os = require("os");
const path = require("path");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { getTelemetryPath } = require("./lib/statusline-path");
const { stateDir } = require("./lib/state-dir");
const { readJSONSync, writeJSONAtomic } = require("./lib/safe-json");
const { getSessionID } = require("./lib/session-id");

const TKR_STATE_DIR = stateDir();

// Anthropic Opus 4.x cache_creation rates, $/1M tokens.
// Source: docs/audits/2026-05-10-cache-bust-survey.md §pricing.
// Note: despite the lower write rate, 1h cache still saves money overall
// because the read rate is cheaper — net savings come from read amortization.
// PLAN-1 T4 — Anthropic pricing 2026-05.
const OPUS_CW_5M_RATE_PER_M = 18.75;
const OPUS_CW_1H_RATE_PER_M = 1.50; // PLAN-1 T4 — Anthropic pricing 2026-05

// Pinned-budget cache fallback when ~/.tkr/pinned-budget.json is
// missing/stale. Matches the default in cmd_signals_pinned_budget.go.
const FALLBACK_PINNED_TOK = 12000;

// Build-pattern protection: skip the warning when the session is in
// its first N turns (we, right now, editing a cache-critical file
// during the playbook build itself — proposal §risk #3).
const BUILD_PATTERN_TURNS = 5;

// Per-session telemetry path resolved lazily. shouldFire receives sid
// from its caller (cache-bust-detector); we set TKR_SESSION_ID there so
// readTurnCount() reads this session's payload.

// Files whose edit busts the prefix cache. Slash-normalized — match
// against the file_path with backslashes folded to forward.
const PREFIX_CRITICAL_BASENAMES = new Set([
  "CLAUDE.md",
  "AGENTS.md",
  "MEMORY.md",
  "settings.json",
  "settings.local.json",
  "plugin.json",
]);

const RULES_DIR_RE = /(^|\/)\.claude\/rules\//;

// safeReadJSON / safeWriteJSON — local aliases for back-compat with the
// rest of this file. Real impl lives in ./lib/safe-json (writes via
// tmp+rename, swallows errors).
const safeReadJSON = readJSONSync;
const safeWriteJSON = writeJSONAtomic;

// classifyPath returns a short string identifying which prefix-critical
// bucket the path is in, or "" when not a match.
function classifyPath(filePath) {
  if (!filePath || typeof filePath !== "string") return "";
  const norm = filePath.replace(/\\/g, "/");
  const base = norm.split("/").pop() || "";
  if (PREFIX_CRITICAL_BASENAMES.has(base)) return base;
  if (RULES_DIR_RE.test(norm)) return ".claude/rules/*";
  return "";
}

function l5StatePath(sid) {
  return path.join(TKR_STATE_DIR, `l5-state-${sid || "default"}.json`);
}

function readL5State(sid) {
  return safeReadJSON(l5StatePath(sid)) || { fired_files: {}, fires: 0 };
}

function writeL5State(sid, state) {
  safeWriteJSON(l5StatePath(sid), state);
}

// pinnedSizeTok returns the prefix-size estimate. Prefers the cached
// pinned-budget.actual_tok (populated by L0 / `tkr signals pinned-
// budget`). Falls back to FALLBACK_PINNED_TOK when missing.
function pinnedSizeTok() {
  const c = safeReadJSON(path.join(TKR_STATE_DIR, "pinned-budget.json"));
  if (c && Number(c.actual_tok) > 0) return Number(c.actual_tok);
  return FALLBACK_PINNED_TOK;
}

// turnCount returns the session's current turn count from the
// statusline JSON, or -1 when unavailable.
function readTurnCount() {
  const tel = safeReadJSON(getTelemetryPath());
  if (!tel) return -1;
  if (typeof tel.turn_count === "number") return tel.turn_count;
  return -1;
}

// estimateRebuildCostUSD returns the projected cost of rebuilding
// prefix_size_tok at the Opus cache_write rate appropriate for the
// active TTL tier (5min vs 1h). PLAN-1 T4.
function estimateRebuildCostUSD(prefixSizeTok, ttlSeconds) {
  const rate = ttlSeconds >= 3600 ? OPUS_CW_1H_RATE_PER_M : OPUS_CW_5M_RATE_PER_M;
  return (prefixSizeTok / 1_000_000) * rate;
}

function formatHint(bucket, prefixSizeTok, costUSD, ttlSeconds) {
  const tierLabel = ttlSeconds >= 3600 ? "1h" : "5min";
  return (
    `[L5 cache-bust: editing ${bucket} busts the prefix cache; ` +
    `next turn pays ~$${costUSD.toFixed(2)} to rebuild ${prefixSizeTok}tok ` +
    `at the Opus ${tierLabel} cw rate. Defer to session end if not urgent ` +
    `(see .claude/rules/cache-awareness.md).]`
  );
}

// shouldFire applies kill switches + per-file dedup + build-pattern
// protection. Returns {ok, state, bucket, costUSD, prefixSizeTok}.
function shouldFire(sid, filePath) {
  if (
    process.env.TKR_PLAYBOOK_DISABLED === "1" ||
    process.env.TKR_PLAYBOOK_EXTENSIONS_DISABLED === "1" ||
    process.env.TKR_PLAYBOOK_L5_DISABLED === "1"
  ) {
    return { ok: false, reason: "disabled" };
  }
  // Per-session telemetry scope for readTurnCount() below. INV-039:
  // payload sid wins over inherited env (stale launch-time pin).
  if (sid) {
    process.env.TKR_SESSION_ID = sid;
  }
  const bucket = classifyPath(filePath);
  if (!bucket) return { ok: false, reason: "not_prefix_critical" };

  const turns = readTurnCount();
  if (turns >= 0 && turns <= BUILD_PATTERN_TURNS) {
    return { ok: false, reason: "build_pattern_turns", turns };
  }

  const state = readL5State(sid);
  const fileKey = filePath.replace(/\\/g, "/");
  if (state.fired_files && state.fired_files[fileKey]) {
    return { ok: false, reason: "file_already_warned" };
  }

  const prefixSizeTok = pinnedSizeTok();
  // PLAN-1 T4: use TTL-aware rate for cost estimate.
  const { ttl_seconds: ttlSeconds } = require("./lib/cache-ttl").detectTTL(sid);
  const costUSD = estimateRebuildCostUSD(prefixSizeTok, ttlSeconds);
  return { ok: true, state, bucket, costUSD, prefixSizeTok, fileKey, ttlSeconds };
}

function recordFire(sid, state, fileKey) {
  state.fired_files = state.fired_files || {};
  state.fired_files[fileKey] = Date.now();
  state.fires = (state.fires || 0) + 1;
  state.last_fire_at = Date.now();
  writeL5State(sid, state);
}

function emitTelemetry(sid, fileKey, bucket, prefixSizeTok, costUSD, ttlSeconds) {
  try {
    const emit = require("./lib/playbook-emit");
    emit.emitEvent(
      "L5",
      "fired",
      {
        file_path: fileKey,
        bucket,
        prefix_size_tok: prefixSizeTok,
        est_rebuild_cost_usd: Number(costUSD.toFixed(4)),
        ttl_seconds: ttlSeconds,
      },
      null,
      sid,
    );
  } catch {
    // best-effort
  }
}

if (require.main === module) {
  if (hooksDisabled()) {
    process.stdout.write("{}");
  } else {
    readStdinWithTimeout(2000)
      .then((buf) => {
        let event;
        try {
          event = JSON.parse(buf || "{}");
        } catch {
          process.stdout.write("{}");
          return;
        }
        if (event.tool_name !== "Edit" && event.tool_name !== "Write") {
          process.stdout.write("{}");
          return;
        }
        const filePath = (event.tool_input && event.tool_input.file_path) || "";
        // M-15: getSessionID uses the canonical chain (transcript_path UUID →
        // session_id → env → pid). The old `event.session_id || env || "default"`
        // wrote state to a different file than other hooks read from — issue #15.
        const sid = getSessionID(event);
        const guard = shouldFire(sid, filePath);
        if (!guard.ok) {
          process.stdout.write("{}");
          return;
        }
        recordFire(sid, guard.state, guard.fileKey);
        emitTelemetry(sid, guard.fileKey, guard.bucket, guard.prefixSizeTok, guard.costUSD, guard.ttlSeconds);
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              additionalContext: formatHint(guard.bucket, guard.prefixSizeTok, guard.costUSD, guard.ttlSeconds),
            },
          }),
        );
      })
      .catch(() => process.stdout.write("{}"));
  }
}

module.exports = {
  PREFIX_CRITICAL_BASENAMES,
  RULES_DIR_RE,
  OPUS_CW_5M_RATE_PER_M,
  OPUS_CW_1H_RATE_PER_M,
  FALLBACK_PINNED_TOK,
  BUILD_PATTERN_TURNS,
  classifyPath,
  pinnedSizeTok,
  readTurnCount,
  estimateRebuildCostUSD,
  formatHint,
  shouldFire,
  recordFire,
  l5StatePath,
};
