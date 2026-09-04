#!/usr/bin/env node
// tkr Stop + SessionEnd hook — passive value report (#19) and shard cleanup.
//
// On Stop (per turn): emits a short stderr block summarizing what tkr did
// this session — cap usage, savings, cache busts, brevity mode.
// On SessionEnd (once): deletes the per-session statusline shard and emits
// nothing. The two jobs are disjoint by event; deletion on Stop was INV-075.
//
// Suppressible via TKR_SESSION_SUMMARY=0. Best-effort throughout: missing or
// corrupt telemetry yields a shorter (or no) block, never an error.
//
// Why a separate file (not extending the memory-health hook):
//   - memory-health is single-responsibility (memory dir audit);
//     keep the value report independent so adding fields here doesn't
//     bloat the memory hook
//   - smaller blast radius: a bug in the summary can't break memory
//     health, and vice versa
//
// Hot-path budget: stderr emit only; no spawns, no network, single-file
// reads. Observed wall-clock <30ms on a warm fs.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { getTelemetryPath } = require("./lib/statusline-path");
const { stateDir } = require("./lib/state-dir");
const { getSessionID } = require("./lib/session-id");

const TKR_STATE_DIR = stateDir();

const STDIN_TIMEOUT_MS = 500;

// readJSON returns parsed JSON or null on any error. Best-effort.
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// extractSessionID delegates to hooks/lib/session-id so the Stop hook
// reads state files written by other hooks (cache-bust-<sid>.json,
// l5-state-<sid>.json, etc.). Before this, this file used a "default"
// fallback while peers used pid-ppid — same session ended up keying
// state to different files, and the "cache busts this session" line
// silently no-op'd. See issue #15 + carry-over note 2026-05-16.
const extractSessionID = getSessionID;

// readBrevity returns the current brevity-mode string, or null when the
// file is missing/empty.
function readBrevity() {
  try {
    const raw = fs.readFileSync(path.join(TKR_STATE_DIR, "brevity-mode"), "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

// readCacheBust returns the {count, paths} payload for this session, or
// null when the session never busted the prefix cache.
function readCacheBust(sid) {
  if (!sid) return null;
  return readJSON(path.join(TKR_STATE_DIR, `cache-bust-${sid}.json`));
}

// readStatusline returns the per-project statusline snapshot
// (cap %, ctx, turn, tkr_savings_*) or {} when unavailable.
function readStatusline() {
  return readJSON(getTelemetryPath()) || {};
}

// formatPct renders a 0-100 number as "N%" or "—" when missing/non-numeric.
function formatPct(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return Math.round(v) + "%";
}

// renderSummary composes the stderr block. Returns "" when nothing
// useful to report (every field empty), so the hook stays silent.
function renderSummary({ stats, brevity, busts }) {
  const lines = [];
  const has = (v) => v !== undefined && v !== null;

  const cap5h = formatPct(stats.five_hour_pct);
  const cap7d = formatPct(stats.seven_day_pct);
  const ctxK = has(stats.last_ctx_k) ? `${stats.last_ctx_k}K` : "—";
  const turns = has(stats.turn_count) ? stats.turn_count : "—";
  const savings7d = formatPct(stats.tkr_savings_7d_pct);

  const anyStats =
    has(stats.five_hour_pct) ||
    has(stats.seven_day_pct) ||
    has(stats.last_ctx_k) ||
    has(stats.turn_count);

  if (!anyStats && !brevity && !busts) return "";

  lines.push("[tkr] session summary");
  if (anyStats) {
    lines.push(`  cap:        5h ${cap5h}   7d ${cap7d}   (tkr 7d savings: ${savings7d})`);
    lines.push(`  ctx end:    ${ctxK}     turns: ${turns}`);
  }
  if (busts && typeof busts.count === "number" && busts.count > 0) {
    lines.push(`  cache busts: ${busts.count} this session`);
  }
  if (brevity) {
    lines.push(`  brevity:    ${brevity}`);
  }
  lines.push(`  details:    tkr gain --week  |  tkr usage`);
  return lines.join("\n");
}

async function runMain(input) {
  if (process.env.TKR_SESSION_SUMMARY === "0") return;

  let data = {};
  try {
    data = input ? JSON.parse(input) : {};
  } catch {
    data = {};
  }
  // This hook is registered on BOTH Stop and SessionEnd, with disjoint jobs:
  // Stop (per turn) renders the report, SessionEnd (once) deletes the shard.
  // The split is deliberate — see the cleanup block below (INV-075) for why
  // deletion cannot live on Stop, and note that Claude Code ignores a
  // SessionEnd hook's output, so the report would be invisible there.
  const isSessionEnd = data.hook_event_name === "SessionEnd";

  const sid = extractSessionID(data);
  // Set per-session telemetry scope before readStatusline() resolves the
  // path. Matches the v2 scoping in hooks/lib/statusline-path.js.
  // INV-039: payload sid wins over inherited env (stale launch-time pin).
  if (sid) {
    process.env.TKR_SESSION_ID = sid;
  }
  if (!isSessionEnd) {
    const stats = readStatusline();
    const brevity = readBrevity();
    const busts = readCacheBust(sid);

    const block = renderSummary({ stats, brevity, busts });
    if (block) {
      process.stderr.write(block + "\n");
    }
  }

  // Cleanup the per-session statusline payload — SessionEnd ONLY.
  //
  // INV-075: this used to run on every Stop, on the belief that "Stop fires
  // at session end". Stop is a PER-TURN event (SessionStart/SessionEnd are
  // the once-per-session pair), so the shard was deleted after every turn.
  // Only statusline.{sh,ps1} then recreated it, and those write just the
  // statusline-owned fields — the tkr-owned ones (last_ctx_k, turn_count,
  // cap_units_total, tkr_launch) came back only when the next PostToolUse
  // fired `tkr statusline-update`. A turn with no tool call therefore ran
  // start-to-finish against a shard missing every tkr-owned field, which
  // surfaced as blank CTX/CU/TURNS/FLAGS columns in `tkr top` and as a
  // UserPromptSubmit injection with no t= or ctx=.
  //
  // Do NOT re-add a Stop-time delete. The crash path (SessionEnd never
  // fires) is already covered by sweepStaleStatuslineFiles() on
  // SessionStart, which drops files older than 24h.
  //
  // Best-effort; never throw out of the hook. Skip when TKR_STATUSLINE_PATH
  // override is set (tests / integration manage their own lifecycle).
  if (isSessionEnd && sid && !process.env.TKR_STATUSLINE_PATH) {
    try {
      const fs = require("fs");
      const { getTelemetryPath } = require("./lib/statusline-path");
      fs.unlinkSync(getTelemetryPath());
    } catch {
      // file already gone or unwritable — ignore
    }
  }
}

if (require.main === module) {
  if (hooksDisabled()) {
    process.stdout.write("{}");
    process.exit(0);
  }
  readStdinWithTimeout(STDIN_TIMEOUT_MS)
    .then(runMain)
    .catch(() => runMain(""))
    .finally(() => {
      process.stdout.write("{}");
      process.exit(0);
    });
}

module.exports = {
  renderSummary,
  extractSessionID,
  readBrevity,
  readCacheBust,
  readStatusline,
  runMain,
};
