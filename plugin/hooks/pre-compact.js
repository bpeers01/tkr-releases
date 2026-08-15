#!/usr/bin/env node
// tkr PreCompact hook — snapshot + compaction-vs-clear nudge (Feature 3).
//
// Two responsibilities:
//  1. Build session snapshot before compaction (PLAN-4 — preserves context).
//  2. Nudge /clear when session is long or cap pressure is high (REPORT-002
//     Feature 3). Soft-blocks first attempt; re-running /compact bypasses.
//
// Output contract:
//   {} — proceed normally
//   {"decision":"block","reason":"..."} — block and show reason to user
//
// Bypass: writes ~/.tkr/compact-bypass-<sid> on first block. Re-running
// /compact within 60s sees the flag and proceeds (then deletes flag).

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readStdinWithTimeout, hooksDisabled } = require("./lib/stdin-with-timeout");
const { getTelemetryPath } = require("./lib/statusline-path");
const { stateDir } = require("./lib/state-dir");
const { getSessionID } = require("./lib/session-id");
const { tkrSpawnArgv } = require("./lib/tkr-bin");

// M-01: spawnSync wrapper with SIGKILL on timeout (vs execFileSync's SIGTERM
// which is a no-op on Windows) + 10MB maxBuffer.
function tkrSpawnSync(args, opts) {
  const o = opts || {};
  const { cmd, argv } = tkrSpawnArgv(args);
  const res = spawnSync(cmd, argv, {
    encoding: "utf8",
    timeout: o.timeout || 5000,
    killSignal: "SIGKILL",
    maxBuffer: 10 * 1024 * 1024,
    stdio: o.stdio || ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (res.error) throw res.error;
  if (res.signal) {
    const err = new Error("tkr-spawn-killed");
    err.signal = res.signal;
    throw err;
  }
  if (typeof res.status === "number" && res.status !== 0) {
    const err = new Error(`tkr-spawn-exit-${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.stdout;
}

const TKR_STATE_DIR = stateDir();

const DEBUG_LOG = path.join(TKR_STATE_DIR, "pre-compact-debug.log");

// Per-session telemetry path resolved lazily — readTelemetry() picks up
// process.env.TKR_SESSION_ID set at runMain entry, matching the v2 scoping
// in hooks/lib/statusline-path.js.

// Thresholds that trigger the clear-nudge. Recalibrated 2026-08-14 against
// a real 30-day session-turns population (p75/p97) — mirrors signals.go
// SessionWarnTurns/SessionHeaviestTurns. Deliberately skips the new middle
// "heavy" tier (SessionHeavyTurns=100): this hook is a binary nudge, not a
// 3-rung color ramp, so it keeps the same two checkpoints it always had.
const TURNS_WARN  = 75;  // mirrors signals.go SessionWarnTurns
const TURNS_HARD  = 150; // mirrors signals.go SessionHeaviestTurns
const CAP_WARN_PCT = 70; // mirrors PRD §18 Feature 4 threshold
const BYPASS_TTL_MS = 60_000; // 60s bypass window

function debugLog(msg) {
  if (process.env.TKR_SESSION_DEBUG !== "1") return;
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // best-effort
  }
}

const extractSessionID = getSessionID;

function bypassPath(sid) {
  return path.join(TKR_STATE_DIR, `compact-bypass-${sid}`);
}

// Returns true if a fresh bypass flag exists for this session (and deletes it).
function consumeBypass(sid) {
  const p = bypassPath(sid);
  try {
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs < BYPASS_TTL_MS) {
      fs.unlinkSync(p);
      return true;
    }
    fs.unlinkSync(p); // stale — delete but don't bypass
  } catch {
    // no flag
  }
  return false;
}

function writeBypass(sid) {
  try {
    fs.mkdirSync(TKR_STATE_DIR, { recursive: true });
    fs.writeFileSync(bypassPath(sid), String(Date.now()), "utf8");
  } catch {
    // best-effort
  }
}

// Read telemetry file. Returns {} on any error (graceful degradation).
function readTelemetry() {
  try {
    return JSON.parse(fs.readFileSync(getTelemetryPath(), "utf8"));
  } catch {
    return {};
  }
}

// Determine if this compaction should be intercepted. Returns null to proceed
// or a reason string to block (first attempt). On second attempt (bypass
// present) returns null unconditionally so compaction proceeds.
function compactionNudge(sid) {
  const tel = readTelemetry();
  const turnCount = typeof tel.turn_count === "number" ? tel.turn_count : 0;
  const sevenDayPct = typeof tel.seven_day_pct === "number" ? tel.seven_day_pct : 0;

  // PLAN-1 T6: with 1h cache active, sessions stay warm longer — raise the
  // long-session turn threshold so we don't nudge /clear prematurely.
  // Double TURNS_WARN only; TURNS_HARD (extendedSession) stays fixed.
  const { detectTTL } = require("./lib/cache-ttl");
  const ttl = detectTTL(sid);
  const ttlActive1h = ttl.ttl_seconds >= 3600 && ttl.source !== "default";
  const turnsWarn = ttlActive1h ? TURNS_WARN * 2 : TURNS_WARN;

  const longSession = turnCount >= turnsWarn;
  const underPressure = sevenDayPct >= CAP_WARN_PCT;
  const extendedSession = turnCount >= TURNS_HARD;

  if (!longSession && !underPressure) {
    return null; // no nudge needed
  }

  // Check for bypass (user already saw the nudge and re-ran /compact).
  if (consumeBypass(sid)) {
    debugLog(`compact bypass consumed for sid=${sid}`);
    return null;
  }

  // Write bypass so next /compact within 60s proceeds.
  writeBypass(sid);

  // Build the nudge reason.
  const parts = [];
  if (extendedSession) {
    parts.push(`${turnCount}-turn session (extended)`);
  } else if (longSession) {
    parts.push(`${turnCount}-turn session (long)`);
  }
  if (underPressure) {
    parts.push(`7d cap at ${sevenDayPct}%`);
  }

  const context = parts.join(", ");
  return (
    `tkr: /clear may be cheaper than /compact here (${context}). ` +
    `/clear discards context without rebuild cost. ` +
    `Run /compact again to proceed with compaction anyway.`
  );
}

// CR-06 + M-12: stdin-timeout + master kill switch. M-01: spawnSync replaces
// execFileSync so timeout actually kills hung children on Windows.
function runMain(inputRaw) {
  let input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch {
    debugLog("bad JSON on stdin");
  }

  const sid = extractSessionID(input);
  // INV-039: payload sid wins over inherited env (stale launch-time pin).
  if (sid) {
    process.env.TKR_SESSION_ID = sid;
  }
  debugLog(`pre-compact for sid=${sid}`);

  // Step 1: build snapshot (PLAN-4) — always, regardless of nudge decision.
  if (sid) {
    try {
      tkrSpawnSync(["session", "build-snapshot", sid], { timeout: 5000 });
      debugLog(`build-snapshot complete for sid=${sid}`);
    } catch (err) {
      debugLog(`build-snapshot failed: ${err.message}`);
    }
  }

  // Step 2: compaction-vs-clear nudge (Feature 3).
  const nudge = compactionNudge(sid);
  if (nudge) {
    debugLog(`compact nudge fired for sid=${sid}: ${nudge}`);
    process.stdout.write(JSON.stringify({ decision: "block", reason: nudge }));
  } else {
    process.stdout.write(JSON.stringify({}));
  }
}

if (require.main === module) {
  if (hooksDisabled()) {
    process.stdout.write("{}");
  } else {
    readStdinWithTimeout(3000)
      .then(runMain)
      .catch(() => {
        debugLog("stdin timeout/error");
        process.stdout.write("{}");
      });
  }
}

module.exports = {
  TURNS_WARN,
  TURNS_HARD,
  CAP_WARN_PCT,
  compactionNudge,
  readTelemetry,
  bypassPath,
  consumeBypass,
  writeBypass,
};
